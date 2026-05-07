use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};

use crate::instructions::RawInstruction;

/// Compact-u16 encoding used by Solana wire format.
fn encode_compact_u16(val: u16) -> Vec<u8> {
    let mut out = Vec::new();
    let mut v = val;
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
    out
}

/// Build a legacy Solana transaction message.
/// Returns the serialized message bytes (to be signed).
pub fn build_message(
    instructions: &[RawInstruction],
    payer: &[u8; 32],
    recent_blockhash: &[u8; 32],
) -> Vec<u8> {
    // Collect all unique accounts with their properties.
    // Key: pubkey bytes, Value: (is_signer, is_writable)
    let mut account_map: BTreeMap<[u8; 32], (bool, bool)> = BTreeMap::new();

    // Payer is always writable + signer
    account_map.insert(*payer, (true, true));

    for ix in instructions {
        // Program ID is a non-signer, read-only account
        account_map
            .entry(ix.program_id)
            .or_insert((false, false));

        for meta in &ix.accounts {
            let entry = account_map.entry(meta.pubkey).or_insert((false, false));
            // OR the flags: if any instruction marks it as signer/writable, it is
            entry.0 |= meta.is_signer;
            entry.1 |= meta.is_writable;
        }
    }

    // Classify accounts into buckets
    let mut writable_signers: Vec<[u8; 32]> = Vec::new();
    let mut readonly_signers: Vec<[u8; 32]> = Vec::new();
    let mut writable_nonsigners: Vec<[u8; 32]> = Vec::new();
    let mut readonly_nonsigners: Vec<[u8; 32]> = Vec::new();

    for (&pubkey, &(is_signer, is_writable)) in &account_map {
        if pubkey == *payer {
            continue; // Payer goes first in writable_signers
        }
        match (is_signer, is_writable) {
            (true, true) => writable_signers.push(pubkey),
            (true, false) => readonly_signers.push(pubkey),
            (false, true) => writable_nonsigners.push(pubkey),
            (false, false) => readonly_nonsigners.push(pubkey),
        }
    }

    // Build final ordered account list: payer first, then buckets
    let mut accounts: Vec<[u8; 32]> = Vec::new();
    accounts.push(*payer);
    accounts.extend_from_slice(&writable_signers);
    accounts.extend_from_slice(&readonly_signers);
    accounts.extend_from_slice(&writable_nonsigners);
    accounts.extend_from_slice(&readonly_nonsigners);

    // Build account index lookup
    let account_index: BTreeMap<[u8; 32], u8> = accounts
        .iter()
        .enumerate()
        .map(|(i, &pk)| (pk, i as u8))
        .collect();

    // Header
    let num_required_signatures = (1 + writable_signers.len() + readonly_signers.len()) as u8;
    let num_readonly_signed = readonly_signers.len() as u8;
    let num_readonly_unsigned = readonly_nonsigners.len() as u8;

    let mut msg = Vec::new();

    // 3-byte header
    msg.push(num_required_signatures);
    msg.push(num_readonly_signed);
    msg.push(num_readonly_unsigned);

    // Compact-u16 account count + account keys
    msg.extend_from_slice(&encode_compact_u16(accounts.len() as u16));
    for account in &accounts {
        msg.extend_from_slice(account);
    }

    // Recent blockhash
    msg.extend_from_slice(recent_blockhash);

    // Compact-u16 instruction count
    msg.extend_from_slice(&encode_compact_u16(instructions.len() as u16));

    // Each instruction
    for ix in instructions {
        // Program ID index
        let prog_idx = account_index[&ix.program_id];
        msg.push(prog_idx);

        // Compact-u16 number of accounts
        msg.extend_from_slice(&encode_compact_u16(ix.accounts.len() as u16));

        // Account indices
        for meta in &ix.accounts {
            let idx = account_index[&meta.pubkey];
            msg.push(idx);
        }

        // Compact-u16 data length + data
        msg.extend_from_slice(&encode_compact_u16(ix.data.len() as u16));
        msg.extend_from_slice(&ix.data);
    }

    msg
}

/// Sign a message and produce a complete serialized transaction.
pub fn sign_and_serialize(message: &[u8], signer: &SigningKey) -> Vec<u8> {
    let signature = signer.sign(message);
    let mut tx = Vec::new();
    // Compact-u16 for number of signatures (always 1 for single-signer)
    tx.extend_from_slice(&encode_compact_u16(1));
    tx.extend_from_slice(&signature.to_bytes());
    tx.extend_from_slice(message);
    tx
}
