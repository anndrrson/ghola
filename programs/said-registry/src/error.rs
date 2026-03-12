use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Invalid Ed25519 instruction: missing or malformed")]
    InvalidEd25519Instruction,
    #[msg("Public key in Ed25519 instruction does not match master_pubkey")]
    PubkeyMismatch,
    #[msg("Message in Ed25519 instruction does not match expected message")]
    MessageMismatch,
    #[msg("Identity is already active")]
    AlreadyActive,
    #[msg("Identity is already inactive")]
    AlreadyInactive,
    #[msg("DID key exceeds maximum length of 64 characters")]
    DidKeyTooLong,
}
