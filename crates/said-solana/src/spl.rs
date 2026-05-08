//! SPL Token and Associated Token Account support for SAID Pay.
//! Builds raw instructions without any solana-sdk dependency.

use sha2::{Digest, Sha256};

use crate::instructions::{AccountMeta, RawInstruction};

/// SPL Token Program ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79,
    0xac, 0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff,
    0x00, 0xa9,
];

/// Associated Token Account Program ID: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d,
    0x83, 0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9,
    0xf8, 0x59,
];

/// System Program ID: 11111111111111111111111111111111
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

// ─── Stablecoin mint constants ───────────────────────────────────────────────
//
// All stablecoin mints supported by Ghola. The byte form is what `find_ata` and
// `build_transfer_checked_ix` consume; the base58 string form is what the
// deposit verifier matches against (since Solana RPC returns parsed instructions
// with mints as base58 strings).

/// USDC Mint (Mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
pub const USDC_MINT_MAINNET_B58: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDC_MINT_MAINNET: [u8; 32] = [
    0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x3a, 0x3d, 0x65, 0xf3, 0x6a, 0xab, 0xc9, 0x74,
    0x31, 0xb1, 0xbb, 0xe4, 0xc2, 0xd2, 0xf6, 0xe0, 0xe4, 0x7c, 0xa6, 0x02, 0x03, 0x45, 0x2f,
    0x5d, 0x61,
];

/// USDC Mint (Devnet): 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
pub const USDC_MINT_DEVNET_B58: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
pub const USDC_MINT_DEVNET: [u8; 32] = [
    0x3b, 0x44, 0x2c, 0xb3, 0x91, 0x21, 0x57, 0xf1, 0x3a, 0x93, 0x3d, 0x01, 0x34, 0x28, 0x2d,
    0x03, 0x2b, 0x5f, 0xfe, 0xcd, 0x01, 0xa2, 0xdb, 0xf1, 0xb7, 0x79, 0x06, 0x08, 0xdf, 0x00,
    0x2e, 0xa7,
];

/// USDT Mint (Mainnet): Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
pub const USDT_MINT_MAINNET_B58: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
pub const USDT_MINT_MAINNET: [u8; 32] = [
    0xce, 0x01, 0x0e, 0x60, 0xaf, 0xed, 0xb2, 0x27, 0x17, 0xbd, 0x63, 0x19, 0x2f, 0x54, 0x14,
    0x5a, 0x3f, 0x96, 0x5a, 0x33, 0xbb, 0x82, 0xd2, 0xc7, 0x02, 0x9e, 0xb2, 0xce, 0x1e, 0x20,
    0x82, 0x64,
];

/// USDT Mint (Devnet): no canonical Tether devnet mint exists. Operators must
/// deploy their own SPL test mint and configure it via env (USDT_MINT_DEVNET).
/// The byte constant here is unused at runtime — callers always read from config
/// on devnet.
pub const USDT_MINT_DEVNET_B58: &str = "";

/// All Solana SPL stablecoins on Ghola use 6 decimals.
pub const USDC_DECIMALS: u8 = 6;
pub const USDT_DECIMALS: u8 = 6;

// ─── Token registry ──────────────────────────────────────────────────────────

/// Metadata for a stablecoin Ghola accepts.
#[derive(Debug, Clone, Copy)]
pub struct SupportedToken {
    pub symbol: &'static str,
    pub mint_mainnet_b58: &'static str,
    pub mint_devnet_b58: &'static str,
    pub mint_mainnet_bytes: [u8; 32],
    pub mint_devnet_bytes: [u8; 32],
    pub decimals: u8,
}

impl SupportedToken {
    pub fn mint_b58(&self, devnet: bool) -> &'static str {
        if devnet {
            self.mint_devnet_b58
        } else {
            self.mint_mainnet_b58
        }
    }

    pub fn mint_bytes(&self, devnet: bool) -> [u8; 32] {
        if devnet {
            self.mint_devnet_bytes
        } else {
            self.mint_mainnet_bytes
        }
    }
}

pub const USDT: SupportedToken = SupportedToken {
    symbol: "USDT",
    mint_mainnet_b58: USDT_MINT_MAINNET_B58,
    mint_devnet_b58: USDT_MINT_DEVNET_B58,
    mint_mainnet_bytes: USDT_MINT_MAINNET,
    mint_devnet_bytes: [0u8; 32],
    decimals: USDT_DECIMALS,
};

pub const USDC: SupportedToken = SupportedToken {
    symbol: "USDC",
    mint_mainnet_b58: USDC_MINT_MAINNET_B58,
    mint_devnet_b58: USDC_MINT_DEVNET_B58,
    mint_mainnet_bytes: USDC_MINT_MAINNET,
    mint_devnet_bytes: USDC_MINT_DEVNET,
    decimals: USDC_DECIMALS,
};

/// Ordered list of supported stablecoins. USDT first = primary. The default tier
/// of Ghola users is in markets where USDT volume dominates 10:1; this order
/// drives UI defaults and challenge ordering.
pub const SUPPORTED_TOKENS: &[SupportedToken] = &[USDT, USDC];

/// Look up a token by its base58 mint address (mainnet or devnet form).
pub fn token_for_mint_b58(mint: &str) -> Option<&'static SupportedToken> {
    SUPPORTED_TOKENS
        .iter()
        .find(|t| t.mint_mainnet_b58 == mint || t.mint_devnet_b58 == mint)
}

/// Look up a token by its symbol (case-insensitive).
pub fn token_for_symbol(symbol: &str) -> Option<&'static SupportedToken> {
    SUPPORTED_TOKENS
        .iter()
        .find(|t| t.symbol.eq_ignore_ascii_case(symbol))
}

// ─── Mint authenticity verification ──────────────────────────────────────────

/// Outcome of a startup mint check. Failures should panic the process — the
/// platform should not boot pointing at a fake mint.
#[derive(Debug, Clone)]
pub struct MintVerification {
    pub mint_b58: String,
    pub owner_program: String,
    pub decimals: u8,
}

/// Errors from `verify_mint`.
#[derive(Debug, thiserror::Error)]
pub enum MintVerifyError {
    #[error("rpc error: {0}")]
    Rpc(String),
    #[error("mint account {mint} not found on-chain at {rpc}")]
    NotFound { mint: String, rpc: String },
    #[error("mint {mint} owned by wrong program: got {got}, expected {expected}")]
    WrongOwner {
        mint: String,
        got: String,
        expected: String,
    },
    #[error("mint {mint} decimals mismatch: on-chain {on_chain}, configured {configured}")]
    DecimalsMismatch {
        mint: String,
        on_chain: u8,
        configured: u8,
    },
    #[error("invalid mint account data")]
    InvalidAccountData,
}

/// Verify a mint is real, owned by the canonical SPL Token program (not
/// Token-2022), and has the expected number of decimals. Call this once at
/// startup — failures must abort the process.
///
/// This is the layer-1 defense from Phase 3.1 of the security plan: if a
/// misconfigured `*_MINT` env var ever points at a fake mint or a Token-2022
/// mimic, the platform refuses to start instead of accepting deposits to it.
pub async fn verify_mint(
    http: &reqwest::Client,
    rpc_url: &str,
    mint_b58: &str,
    expected_decimals: u8,
) -> std::result::Result<MintVerification, MintVerifyError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [
            mint_b58,
            { "encoding": "jsonParsed" }
        ]
    });

    let resp: serde_json::Value = http
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| MintVerifyError::Rpc(e.to_string()))?
        .json()
        .await
        .map_err(|e| MintVerifyError::Rpc(e.to_string()))?;

    if let Some(err) = resp.get("error") {
        return Err(MintVerifyError::Rpc(err.to_string()));
    }

    let value = resp
        .pointer("/result/value")
        .ok_or_else(|| MintVerifyError::Rpc("missing result.value".into()))?;
    if value.is_null() {
        return Err(MintVerifyError::NotFound {
            mint: mint_b58.to_string(),
            rpc: rpc_url.to_string(),
        });
    }

    // Reject Token-2022 (program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
    // Only the canonical SPL Token program is acceptable for stablecoin mints
    // we accept, so an unknown owner is fatal.
    let owner = value
        .pointer("/owner")
        .and_then(|v| v.as_str())
        .ok_or(MintVerifyError::InvalidAccountData)?;
    const SPL_TOKEN_B58: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    if owner != SPL_TOKEN_B58 {
        return Err(MintVerifyError::WrongOwner {
            mint: mint_b58.to_string(),
            got: owner.to_string(),
            expected: SPL_TOKEN_B58.to_string(),
        });
    }

    let on_chain_decimals = value
        .pointer("/data/parsed/info/decimals")
        .and_then(|v| v.as_u64())
        .ok_or(MintVerifyError::InvalidAccountData)? as u8;
    if on_chain_decimals != expected_decimals {
        return Err(MintVerifyError::DecimalsMismatch {
            mint: mint_b58.to_string(),
            on_chain: on_chain_decimals,
            configured: expected_decimals,
        });
    }

    Ok(MintVerification {
        mint_b58: mint_b58.to_string(),
        owner_program: owner.to_string(),
        decimals: on_chain_decimals,
    })
}

/// Find the Associated Token Account address for a wallet + mint pair.
/// This is a deterministic PDA: seeds = [wallet, TOKEN_PROGRAM_ID, mint], program = ATA_PROGRAM_ID.
pub fn find_ata(wallet: &[u8; 32], mint: &[u8; 32]) -> [u8; 32] {
    // ATA derivation: find_program_address([wallet, token_program, mint], ata_program)
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(wallet);
        hasher.update(&TOKEN_PROGRAM_ID);
        hasher.update(mint);
        hasher.update([bump]);
        hasher.update(&ATA_PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();

        // PDA must NOT be on the ed25519 curve
        if !is_on_curve(&candidate) {
            return candidate;
        }
    }
    panic!("could not find valid ATA bump");
}

/// Check if a 32-byte value represents a point on the ed25519 curve.
fn is_on_curve(bytes: &[u8; 32]) -> bool {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*bytes);
    compressed.decompress().is_some()
}

/// Build instruction to create an Associated Token Account (idempotent).
/// Uses the `CreateIdempotent` variant (instruction index 1) to avoid errors if it already exists.
pub fn build_create_ata_ix(
    payer: &[u8; 32],
    wallet: &[u8; 32],
    mint: &[u8; 32],
) -> RawInstruction {
    let ata = find_ata(wallet, mint);

    RawInstruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),           // funding account
            AccountMeta::new(ata, false),              // ATA to create
            AccountMeta::new_readonly(*wallet, false), // wallet owner
            AccountMeta::new_readonly(*mint, false),   // mint
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1], // CreateIdempotent instruction
    }
}

/// Build a TransferChecked instruction for SPL tokens.
/// `amount` is in the token's smallest unit (e.g., micro-USDC for USDC).
/// `decimals` is the number of decimal places for the token.
pub fn build_transfer_checked_ix(
    source_ata: &[u8; 32],
    mint: &[u8; 32],
    dest_ata: &[u8; 32],
    authority: &[u8; 32],
    amount: u64,
    decimals: u8,
) -> RawInstruction {
    // TransferChecked is instruction index 12 in the SPL Token program
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    RawInstruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source_ata, false),      // source token account
            AccountMeta::new_readonly(*mint, false),    // mint
            AccountMeta::new(*dest_ata, false),         // destination token account
            AccountMeta::new_readonly(*authority, true), // owner/authority
        ],
        data,
    }
}

/// Build a SOL transfer instruction (system program transfer).
pub fn build_sol_transfer_ix(
    from: &[u8; 32],
    to: &[u8; 32],
    lamports: u64,
) -> RawInstruction {
    // System program Transfer instruction: index 2 (u32 LE) + lamports (u64 LE)
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes()); // Transfer instruction index
    data.extend_from_slice(&lamports.to_le_bytes());

    RawInstruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from, true),  // source (signer, writable)
            AccountMeta::new(*to, false),   // destination (writable)
        ],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_ata_deterministic() {
        let wallet = [1u8; 32];
        let mint = [2u8; 32];
        let ata1 = find_ata(&wallet, &mint);
        let ata2 = find_ata(&wallet, &mint);
        assert_eq!(ata1, ata2);
    }

    #[test]
    fn find_ata_different_for_different_inputs() {
        let wallet1 = [1u8; 32];
        let wallet2 = [2u8; 32];
        let mint = [3u8; 32];
        let ata1 = find_ata(&wallet1, &mint);
        let ata2 = find_ata(&wallet2, &mint);
        assert_ne!(ata1, ata2);
    }

    #[test]
    fn sol_transfer_ix_format() {
        let from = [1u8; 32];
        let to = [2u8; 32];
        let ix = build_sol_transfer_ix(&from, &to, 1_000_000);
        assert_eq!(ix.program_id, SYSTEM_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 2);
        assert!(ix.accounts[0].is_signer);
        assert_eq!(ix.data.len(), 12); // 4 (instruction index) + 8 (lamports)
    }

    #[test]
    fn transfer_checked_ix_format() {
        let source = [1u8; 32];
        let mint = [2u8; 32];
        let dest = [3u8; 32];
        let authority = [4u8; 32];
        let ix = build_transfer_checked_ix(&source, &mint, &dest, &authority, 1_000_000, 6);
        assert_eq!(ix.program_id, TOKEN_PROGRAM_ID);
        assert_eq!(ix.accounts.len(), 4);
        assert_eq!(ix.data[0], 12); // TransferChecked instruction
        assert_eq!(ix.data.len(), 10); // 1 (instruction) + 8 (amount) + 1 (decimals)
    }

    #[test]
    fn mint_byte_constants_match_b58_strings() {
        // Round-trip every mainnet mint constant: bytes → base58 must equal the
        // declared b58 string. Catches typo'd byte arrays (which is how the
        // pre-registry USDC constant got committed wrong).
        let mainnet_pairs: &[(&[u8; 32], &str)] = &[
            (&USDC_MINT_MAINNET, USDC_MINT_MAINNET_B58),
            (&USDT_MINT_MAINNET, USDT_MINT_MAINNET_B58),
        ];
        for (bytes, b58) in mainnet_pairs {
            let encoded = bs58::encode(bytes.as_slice()).into_string();
            assert_eq!(&encoded, b58, "mint byte constant does not round-trip");
        }
        // Devnet — only USDC has a canonical mint; USDT devnet is operator-deployed.
        let usdc_devnet_encoded = bs58::encode(USDC_MINT_DEVNET.as_slice()).into_string();
        assert_eq!(usdc_devnet_encoded, USDC_MINT_DEVNET_B58);
    }

    #[test]
    fn registry_lookup_by_b58() {
        let usdt = token_for_mint_b58(USDT_MINT_MAINNET_B58).unwrap();
        assert_eq!(usdt.symbol, "USDT");
        let usdc = token_for_mint_b58(USDC_MINT_MAINNET_B58).unwrap();
        assert_eq!(usdc.symbol, "USDC");
        let usdc_devnet = token_for_mint_b58(USDC_MINT_DEVNET_B58).unwrap();
        assert_eq!(usdc_devnet.symbol, "USDC");
        assert!(token_for_mint_b58("not-a-mint").is_none());
    }

    #[test]
    fn registry_lookup_by_symbol() {
        assert_eq!(token_for_symbol("USDT").unwrap().symbol, "USDT");
        assert_eq!(token_for_symbol("usdt").unwrap().symbol, "USDT");
        assert_eq!(token_for_symbol("USDC").unwrap().symbol, "USDC");
        assert!(token_for_symbol("DOGE").is_none());
    }

    #[test]
    fn usdt_is_primary() {
        // USDT first in the registry = default in pickers and challenges.
        assert_eq!(SUPPORTED_TOKENS[0].symbol, "USDT");
    }
}
