//! Lightweight Solana account lookup via JSON-RPC.
//! Avoids solana-sdk dependency by implementing PDA derivation and
//! account deserialization manually.

use base64::{engine::general_purpose::STANDARD, Engine};
use borsh::BorshDeserialize;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Compute the 8-byte Anchor account discriminator for a given account name.
/// Anchor uses sha256("account:<AccountName>")[..8].
fn anchor_account_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{}", name));
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// SAID registry program ID.
const PROGRAM_ID: [u8; 32] = {
    // 3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR in base58
    // Pre-computed bytes:
    let bytes = [
        0x22, 0xd5, 0x56, 0xfb, 0x05, 0x24, 0x66, 0x8e, 0x73, 0x38, 0x16, 0xa9, 0xe2, 0x02, 0xd8,
        0xb7, 0xcc, 0x4c, 0x7e, 0x4e, 0x53, 0x7d, 0x9e, 0x94, 0xf7, 0xce, 0x9d, 0x90, 0xd8, 0xa5,
        0x9a, 0x70,
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

    IdentityRecord::try_from_slice(&raw[8..]).map_err(|e| format!("Deserialization failed: {}", e))
}

// ── ServiceRecord ──────────────────────────────────────────────────────────────

/// On-chain service record (Borsh deserialized, after skipping 8-byte discriminator).
#[derive(Debug, Clone, Serialize, Deserialize, BorshDeserialize)]
pub struct ServiceRecord {
    pub authority: [u8; 32],
    pub identity_record: [u8; 32],
    pub slug: String,
    pub base_url: String,
    pub registry_url: String,
    pub price_micro_usdc: u64,
    pub registered_at: i64,
    pub updated_at: i64,
    pub active: bool,
    pub bump: u8,
}

impl ServiceRecord {
    pub fn authority_bs58(&self) -> String {
        bs58::encode(&self.authority).into_string()
    }
    pub fn identity_record_bs58(&self) -> String {
        bs58::encode(&self.identity_record).into_string()
    }
    /// Price as human-readable USDC string.
    pub fn price_usdc(&self) -> f64 {
        self.price_micro_usdc as f64 / 1_000_000.0
    }
}

/// Derive the PDA for a service record.
/// Seeds: ["service", identity_record_pubkey, slug]
#[allow(dead_code)]
fn find_service_pda(identity_record: &[u8; 32], slug: &str) -> Result<[u8; 32], String> {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(b"service");
        hasher.update(identity_record);
        hasher.update(slug.as_bytes());
        hasher.update([bump]);
        hasher.update(&PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return Ok(candidate);
        }
    }
    Err("could not find valid service PDA bump".into())
}

/// Look up a single service record by identity PDA + slug.
#[allow(dead_code)]
pub async fn lookup_service(
    rpc_url: &str,
    identity_record: &[u8; 32],
    slug: &str,
) -> Result<ServiceRecord, String> {
    let pda = find_service_pda(identity_record, slug)?;
    let pda_b58 = bs58::encode(&pda).into_string();

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [pda_b58, {"encoding": "base64", "commitment": "confirmed"}]
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
        .ok_or_else(|| "Service not found on-chain".to_string())?;

    if result.is_null() {
        return Err("Service not found on-chain".into());
    }

    decode_account::<ServiceRecord>(result)
}

/// List all active service records on-chain by scanning program accounts with
/// the ServiceRecord discriminator. Returns up to `limit` active services.
pub async fn list_services(
    rpc_url: &str,
    limit: usize,
) -> Result<Vec<(String, ServiceRecord)>, String> {
    let disc = anchor_account_discriminator("ServiceRecord");
    let disc_b58 = bs58::encode(disc).into_string();

    let client = reqwest::Client::new();
    let program_id_b58 = bs58::encode(&PROGRAM_ID).into_string();

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getProgramAccounts",
        "params": [
            program_id_b58,
            {
                "encoding": "base64",
                "commitment": "confirmed",
                "filters": [
                    {
                        "memcmp": {
                            "offset": 0,
                            "bytes": disc_b58
                        }
                    }
                ]
            }
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

    let accounts = resp
        .get("result")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "getProgramAccounts returned unexpected format".to_string())?;

    let mut services = Vec::new();
    for account in accounts {
        let pubkey = account
            .get("pubkey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let data = match account.get("account") {
            Some(a) => a,
            None => continue,
        };

        match decode_account::<ServiceRecord>(data) {
            Ok(record) if record.active => {
                services.push((pubkey, record));
                if services.len() >= limit {
                    break;
                }
            }
            _ => continue,
        }
    }

    Ok(services)
}

// ── ReputationAttestation ──────────────────────────────────────────────────────

/// On-chain reputation attestation (Borsh deserialized, after skipping 8-byte discriminator).
#[derive(Debug, Clone, Serialize, Deserialize, BorshDeserialize)]
pub struct ReputationAttestation {
    pub authority: [u8; 32],
    pub entity: [u8; 32],
    /// Overall trust score (0-10000 represents 0.0000–1.0000).
    pub overall_score: u16,
    /// Confidence level (0-10000).
    pub confidence: u16,
    pub total_transactions: u32,
    pub attested_at: i64,
    pub bump: u8,
}

impl ReputationAttestation {
    /// Score as a 0.0–1.0 float.
    pub fn score_f32(&self) -> f32 {
        self.overall_score as f32 / 10_000.0
    }
    /// Confidence as a 0.0–1.0 float.
    pub fn confidence_f32(&self) -> f32 {
        self.confidence as f32 / 10_000.0
    }
}

/// Derive the PDA for a reputation attestation.
/// Seeds: ["reputation", entity_identity_pda]
fn find_reputation_pda(entity_pda: &[u8; 32]) -> Result<[u8; 32], String> {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(b"reputation");
        hasher.update(entity_pda);
        hasher.update([bump]);
        hasher.update(&PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return Ok(candidate);
        }
    }
    Err("could not find valid reputation PDA bump".into())
}

/// Look up the reputation attestation for an identity PDA.
/// Returns None if no attestation exists.
pub async fn lookup_reputation_attestation(
    rpc_url: &str,
    identity_pda: &[u8; 32],
) -> Result<Option<ReputationAttestation>, String> {
    let pda = find_reputation_pda(identity_pda)?;
    let pda_b58 = bs58::encode(&pda).into_string();

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [pda_b58, {"encoding": "base64", "commitment": "confirmed"}]
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
        .ok_or_else(|| "Missing result".to_string())?;

    if result.is_null() {
        return Ok(None);
    }

    decode_account::<ReputationAttestation>(result).map(Some)
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/// Decode a Borsh account from a JSON account object (from getAccountInfo or getProgramAccounts).
/// Skips the 8-byte Anchor discriminator.
fn decode_account<T: BorshDeserialize>(account_data: &serde_json::Value) -> Result<T, String> {
    let data_arr = account_data
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

    if raw.len() < 8 {
        return Err("Account data too short".into());
    }

    T::try_from_slice(&raw[8..]).map_err(|e| format!("Deserialization failed: {}", e))
}
