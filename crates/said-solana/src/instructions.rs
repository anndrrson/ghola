use sha2::{Digest, Sha256};

use crate::pda::{find_identity_pda, PROGRAM_ID};

/// Well-known Solana program IDs (pre-computed bytes).

/// Ed25519SigVerify111111111111111111111111111
const ED25519_PROGRAM_ID: [u8; 32] = [
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe, 0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64, 0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
];

/// 11111111111111111111111111111111
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// Sysvar1nstructions1111111111111111111111111
const SYSVAR_INSTRUCTIONS_ID: [u8; 32] = [
    0x06, 0xa7, 0xd5, 0x17, 0x18, 0x7b, 0xd1, 0x66, 0x35, 0xda, 0xd4, 0x04, 0x55, 0xfd, 0xc2, 0xc0,
    0xc1, 0x24, 0xc6, 0x8f, 0x21, 0x56, 0x75, 0xa5, 0xdb, 0xba, 0xcb, 0x5f, 0x08, 0x00, 0x00, 0x00,
];

/// A raw Solana instruction (no solana-sdk dependency).
#[derive(Debug, Clone)]
pub struct RawInstruction {
    pub program_id: [u8; 32],
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

/// Account metadata for an instruction.
#[derive(Debug, Clone)]
pub struct AccountMeta {
    pub pubkey: [u8; 32],
    pub is_signer: bool,
    pub is_writable: bool,
}

impl AccountMeta {
    pub fn new(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: true,
        }
    }

    pub fn new_readonly(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: false,
        }
    }
}

/// Compute the 8-byte Anchor instruction discriminator.
fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{}", name).as_bytes());
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Build the Ed25519 signature verify instruction from raw components.
fn build_ed25519_verify_ix(
    pubkey: &[u8; 32],
    signature: &[u8; 64],
    message: &[u8],
) -> RawInstruction {
    // Ed25519 instruction data layout:
    //   [0]:     num_signatures (u8)
    //   [1]:     padding (u8)
    //   [2..4]:  signature_offset (u16 LE)
    //   [4..6]:  signature_instruction_index (u16 LE, 0xFFFF = current ix)
    //   [6..8]:  public_key_offset (u16 LE)
    //   [8..10]: public_key_instruction_index (u16 LE)
    //   [10..12]: message_data_offset (u16 LE)
    //   [12..14]: message_data_size (u16 LE)
    //   [14..16]: message_instruction_index (u16 LE)
    //   Then: signature (64 bytes), pubkey (32 bytes), message (variable)
    let header_size: u16 = 16;
    let sig_offset = header_size;
    let pubkey_offset = sig_offset + 64;
    let message_offset = pubkey_offset + 32;
    let message_size = message.len() as u16;

    let mut data = Vec::with_capacity(header_size as usize + 64 + 32 + message.len());

    // Header
    data.push(1u8); // num_signatures
    data.push(0u8); // padding
    data.extend_from_slice(&sig_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // signature_instruction_index (current)
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // pubkey_instruction_index (current)
    data.extend_from_slice(&message_offset.to_le_bytes());
    data.extend_from_slice(&message_size.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // message_instruction_index (current)

    // Payload
    data.extend_from_slice(signature);
    data.extend_from_slice(pubkey);
    data.extend_from_slice(message);

    RawInstruction {
        program_id: ED25519_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

/// Build the deterministic message for registration.
pub fn build_register_message(master_pubkey: &[u8; 32], did_key: &str) -> String {
    let b58_pubkey = bs58::encode(master_pubkey).into_string();
    format!("said:register:{}:{}", b58_pubkey, did_key)
}

/// Build the register instructions (Ed25519 verify + register).
///
/// Returns a Vec of two instructions:
/// 1. Ed25519 native program signature verification
/// 2. The program's register instruction
pub fn build_register_ix(
    payer: &[u8; 32],
    master_pubkey: &[u8; 32],
    did_key: &str,
    signature: &[u8; 64],
) -> Vec<RawInstruction> {
    let message = build_register_message(master_pubkey, did_key);

    let ed25519_ix = build_ed25519_verify_ix(master_pubkey, signature, message.as_bytes());

    let (identity_pda, _bump) = find_identity_pda(master_pubkey);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("register"));
    // master_pubkey: [u8; 32]
    data.extend_from_slice(master_pubkey);
    // did_key: String -- Borsh: 4-byte LE length + bytes
    let did_bytes = did_key.as_bytes();
    data.extend_from_slice(&(did_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(did_bytes);

    let register_ix = RawInstruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(identity_pda, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(SYSVAR_INSTRUCTIONS_ID, false),
        ],
        data,
    };

    vec![ed25519_ix, register_ix]
}

/// Build the deactivate instruction.
pub fn build_deactivate_ix(authority: &[u8; 32], master_pubkey: &[u8; 32]) -> RawInstruction {
    let (identity_pda, _bump) = find_identity_pda(master_pubkey);

    RawInstruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(identity_pda, false),
        ],
        data: discriminator("deactivate").to_vec(),
    }
}

/// Build the reactivate instruction.
pub fn build_reactivate_ix(authority: &[u8; 32], master_pubkey: &[u8; 32]) -> RawInstruction {
    let (identity_pda, _bump) = find_identity_pda(master_pubkey);

    RawInstruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(identity_pda, false),
        ],
        data: discriminator("reactivate").to_vec(),
    }
}

/// Build the update_profile_uri instruction.
pub fn build_update_profile_uri_ix(
    authority: &[u8; 32],
    master_pubkey: &[u8; 32],
    profile_uri: &str,
) -> RawInstruction {
    let (identity_pda, _bump) = find_identity_pda(master_pubkey);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("update_profile_uri"));
    // profile_uri: String -- Borsh: 4-byte LE length + bytes
    let uri_bytes = profile_uri.as_bytes();
    data.extend_from_slice(&(uri_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(uri_bytes);

    RawInstruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(identity_pda, false),
        ],
        data,
    }
}

/// Build the update_authority instruction.
pub fn build_update_authority_ix(
    authority: &[u8; 32],
    master_pubkey: &[u8; 32],
    new_authority: &[u8; 32],
) -> RawInstruction {
    let (identity_pda, _bump) = find_identity_pda(master_pubkey);

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("update_authority"));
    data.extend_from_slice(new_authority);

    RawInstruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(identity_pda, false),
            AccountMeta::new_readonly(*new_authority, false),
        ],
        data,
    }
}
