//! Lightweight Solana account lookup via JSON-RPC.
//! Avoids solana-sdk dependency by implementing PDA derivation and
//! account deserialization manually.

use base64::{engine::general_purpose::STANDARD, Engine};
use borsh::BorshDeserialize;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// SAID registry program ID.
const PROGRAM_ID: [u8; 32] = {
    // 3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR in base58
    // Pre-computed bytes:
    let bytes = [
        0x22, 0xd5, 0x56, 0xfb, 0x05, 0x24, 0x66, 0x8e, 0x73, 0x38, 0x16, 0xa9, 0xe2, 0x02,
        0xd8, 0xb7, 0xcc, 0x4c, 0x7e, 0x4e, 0x53, 0x7d, 0x9e, 0x94, 0xf7, 0xce, 0x9d, 0x90,
        0xd8, 0xa5, 0x9a, 0x70,
    ];
    bytes
};

/// On-chain identity record (Borsh deserialized, after skipping 8-byte Anchor discriminator).
#[derive(Debug, Clone, Serialize, Deserialize, BorshDeserialize)]
pub struct IdentityRecord {
    pub authority: [u8; 32],
    pub master_pubkey: [u8; 32],
    pub did_key: String,
    pub profile_uri: String,
    pub registered_at: i64,
    pub updated_at: i64,
    pub active: bool,
    pub bump: u8,
}

/// Derive the PDA address for an identity record.
/// PDA: sha256("identity" || master_pubkey || program_id || 0xFF) with bump search.
fn find_identity_pda(master_pubkey: &[u8; 32]) -> Result<[u8; 32], String> {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(b"identity");
        hasher.update(master_pubkey);
        hasher.update([bump]);
        hasher.update(&PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();

        // Check the candidate is NOT on the ed25519 curve.
        // A point is on the curve if it can be decompressed. We use a simple
        // heuristic: try to decompress as a compressed Edwards point. If it
        // fails, the PDA is valid.
        if !is_on_curve(&candidate) {
            return Ok(candidate);
        }
    }
    Err("could not find valid PDA bump".into())
}

/// Check if a 32-byte value represents a point on the ed25519 curve.
/// Uses curve25519-dalek's CompressedEdwardsY decompression.
fn is_on_curve(bytes: &[u8; 32]) -> bool {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*bytes);
    compressed.decompress().is_some()
}

/// Look up an identity record via Solana JSON-RPC.
pub async fn lookup_identity(
    rpc_url: &str,
    master_pubkey: &[u8; 32],
) -> Result<IdentityRecord, String> {
    let pda = find_identity_pda(master_pubkey)?;
    let pda_b58 = bs58::encode(&pda).into_string();

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [
            pda_b58,
            { "encoding": "base64", "commitment": "confirmed" }
        ]
    });

    let resp: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("RPC request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("RPC response parse failed: {}", e))?;

    let result = resp
        .get("result")
        .and_then(|r| r.get("value"))
        .ok_or_else(|| "Identity not found on-chain".to_string())?;

    if result.is_null() {
        return Err("Identity not found on-chain".into());
    }

    let data_arr = result
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("Unexpected account data format")?;

    let b64_data = data_arr
        .first()
        .and_then(|v| v.as_str())
        .ok_or("Missing base64 data")?;

    let raw = STANDARD
        .decode(b64_data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    // Skip 8-byte Anchor discriminator
    if raw.len() < 8 {
        return Err("Account data too short".into());
    }

    IdentityRecord::try_from_slice(&raw[8..])
        .map_err(|e| format!("Deserialization failed: {}", e))
}
