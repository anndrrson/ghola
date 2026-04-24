use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};

/// SAID registry program ID in base58.
pub const PROGRAM_ID_B58: &str = "3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR";

/// Pre-computed program ID bytes (decoded from PROGRAM_ID_B58).
pub const PROGRAM_ID: [u8; 32] = [
    0x21, 0x43, 0x2a, 0x2d, 0xa9, 0x43, 0x67, 0x13, 0x08, 0x73, 0xd2, 0xf9, 0xe8, 0xdb, 0x71, 0x01,
    0xb3, 0xfb, 0x15, 0x07, 0x3c, 0x81, 0x45, 0x2a, 0x0f, 0x5c, 0xe3, 0x68, 0xd8, 0x55, 0x38, 0xc4,
];

/// Return the program ID as `[u8; 32]`.
pub fn program_id() -> [u8; 32] {
    PROGRAM_ID
}

/// Find the PDA for an identity record given a master public key.
/// Returns (pda_address, bump).
pub fn find_identity_pda(master_pubkey: &[u8; 32]) -> ([u8; 32], u8) {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(b"identity");
        hasher.update(master_pubkey);
        hasher.update([bump]);
        hasher.update(&PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();

        if !is_on_curve(&candidate) {
            return (candidate, bump);
        }
    }
    panic!("could not find valid PDA bump");
}

/// Check if a 32-byte value represents a point on the ed25519 curve.
fn is_on_curve(bytes: &[u8; 32]) -> bool {
    let compressed = CompressedEdwardsY(*bytes);
    compressed.decompress().is_some()
}
