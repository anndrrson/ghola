//! SPL Token and Associated Token Account support for SAID Pay.
//! Builds raw instructions without any solana-sdk dependency.

use sha2::{Digest, Sha256};

use crate::instructions::{AccountMeta, RawInstruction};

/// SPL Token Program ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

/// Associated Token Account Program ID: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];

/// System Program ID: 11111111111111111111111111111111
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// USDC Mint (Mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
pub const USDC_MINT_MAINNET: [u8; 32] = [
    0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x39, 0x22, 0x22, 0x76, 0x5e, 0x44, 0x70, 0x04, 0x64,
    0xe3, 0xdf, 0x71, 0x23, 0xc0, 0x81, 0x5f, 0x84, 0xf4, 0x6f, 0xb3, 0x50, 0x8e, 0x97, 0xf8, 0xa7,
];

/// USDC Mint (Devnet): 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
pub const USDC_MINT_DEVNET: [u8; 32] = [
    0x3b, 0x44, 0x2c, 0xc7, 0x14, 0xf8, 0x4f, 0x7a, 0x4c, 0x3c, 0x09, 0x65, 0xf5, 0xc8, 0xac, 0x51,
    0xdb, 0x35, 0xd5, 0x73, 0x45, 0x6e, 0x6e, 0x52, 0xb7, 0x05, 0x2b, 0xe7, 0x57, 0x3b, 0x15, 0x7f,
];

/// USDC has 6 decimal places.
pub const USDC_DECIMALS: u8 = 6;

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
pub fn build_create_ata_ix(payer: &[u8; 32], wallet: &[u8; 32], mint: &[u8; 32]) -> RawInstruction {
    let ata = find_ata(wallet, mint);

    RawInstruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),            // funding account
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
            AccountMeta::new(*source_ata, false),    // source token account
            AccountMeta::new_readonly(*mint, false), // mint
            AccountMeta::new(*dest_ata, false),      // destination token account
            AccountMeta::new_readonly(*authority, true), // owner/authority
        ],
        data,
    }
}

/// Build a SOL transfer instruction (system program transfer).
pub fn build_sol_transfer_ix(from: &[u8; 32], to: &[u8; 32], lamports: u64) -> RawInstruction {
    // System program Transfer instruction: index 2 (u32 LE) + lamports (u64 LE)
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes()); // Transfer instruction index
    data.extend_from_slice(&lamports.to_le_bytes());

    RawInstruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from, true), // source (signer, writable)
            AccountMeta::new(*to, false),  // destination (writable)
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
}
