use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

use crate::error::RegistryError;

/// Verify that an Ed25519 signature verification instruction exists at index 0
/// in the transaction, and that it verifies the given `master_pubkey` signed the
/// given `message`.
pub fn verify_ed25519_signature(
    instructions_sysvar: &AccountInfo,
    master_pubkey: &[u8; 32],
    message: &[u8],
) -> Result<()> {
    // Load the instruction at index 0
    let ix = load_instruction_at_checked(0, instructions_sysvar)
        .map_err(|_| error!(RegistryError::InvalidEd25519Instruction))?;

    // Must be the Ed25519 native program
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        RegistryError::InvalidEd25519Instruction
    );

    // The instruction data must have at least 16 bytes of header
    require!(ix.data.len() >= 16, RegistryError::InvalidEd25519Instruction);

    let num_signatures = ix.data[0];
    require!(
        num_signatures >= 1,
        RegistryError::InvalidEd25519Instruction
    );

    // Parse offsets from header (little-endian u16 values)
    let signature_offset = u16::from_le_bytes([ix.data[2], ix.data[3]]) as usize;
    let public_key_offset = u16::from_le_bytes([ix.data[6], ix.data[7]]) as usize;
    let message_data_offset = u16::from_le_bytes([ix.data[10], ix.data[11]]) as usize;
    let message_data_size = u16::from_le_bytes([ix.data[12], ix.data[13]]) as usize;

    // Validate bounds
    require!(
        signature_offset.checked_add(64).map_or(false, |end| end <= ix.data.len()),
        RegistryError::InvalidEd25519Instruction
    );
    require!(
        public_key_offset.checked_add(32).map_or(false, |end| end <= ix.data.len()),
        RegistryError::InvalidEd25519Instruction
    );
    require!(
        message_data_offset
            .checked_add(message_data_size)
            .map_or(false, |end| end <= ix.data.len()),
        RegistryError::InvalidEd25519Instruction
    );

    // Extract and verify public key
    let ix_pubkey = &ix.data[public_key_offset..public_key_offset + 32];
    require!(
        ix_pubkey == master_pubkey.as_ref(),
        RegistryError::PubkeyMismatch
    );

    // Extract and verify message
    let ix_message = &ix.data[message_data_offset..message_data_offset + message_data_size];
    require!(ix_message == message, RegistryError::MessageMismatch);

    Ok(())
}
