//! Decoders for the on-chain shielded-pool program's Anchor events.
//!
//! The on-chain program (see `programs/said-shielded-pool/src/events.rs`)
//! emits nine `#[event]` types via Anchor's `emit!` macro. Each produces
//! a log line of the form
//!
//! ```text
//! Program data: <base64(8-byte-discriminator || borsh(event-struct))>
//! ```
//!
//! in the transaction's `meta.logMessages`. The 8-byte discriminator is
//! `sha256("event:<EventName>")[..8]`.
//!
//! ## Indexer scope
//!
//! The indexer only *acts on* the three events that affect the off-chain
//! Merkle mirror:
//!
//! - [`CommitmentQueued`] — a new commitment was enqueued (deposit, or the
//!   output side of a shielded transfer). The indexer inserts it into the
//!   local tree mirror immediately so that `/witness` queries can serve
//!   a Merkle path even before the on-chain root catches up.
//! - [`Transferred`] — a shielded-transfer ix was accepted. Mostly used
//!   for telemetry; commitments arrive via `CommitmentQueued`. We decode
//!   it so we can emit clean structured logs and so the smoke test exercises
//!   the borsh shape end-to-end.
//! - [`RootUpdated`] — the forester (or admin) rolled the queue into a new
//!   on-chain root. The indexer flushes its tree mirror to match.
//!
//! The other six events (`PoolInitialized`, `TreeInitialized`, `Withdrawn`,
//! `PausedToggled`, `VerifierKeyRotated`, `FeeUpdated`) are decoded into
//! their own typed [`DecodedEvent`] variants so that a misbehaving program
//! upgrade (e.g. a renamed field) surfaces as a decode error rather than
//! silently passing through, but they do not mutate the local tree.
//!
//! ## Discriminator source-of-truth
//!
//! The constants below are reproduced verbatim from the Anchor IDL at
//! `target/idl/said_shielded_pool.json`. A `#[test]` in this file
//! re-derives them with `sha256("event:<EventName>")[..8]` and asserts
//! equality, so any drift between the IDL and the indexer is caught
//! at `cargo test` time.

use borsh::{BorshDeserialize, BorshSerialize};
use said_shielded_pool_types::{Commitment, FieldBytes, MerkleRoot, COMMITMENT_BYTES};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

// =============================================================================
// Discriminators — sha256("event:<EventName>")[..8].
// Cross-checked against target/idl/said_shielded_pool.json in `tests::discriminators_match_anchor_sha256`.
// =============================================================================

pub const POOL_INITIALIZED_DISC: [u8; 8] =
    [100, 118, 173, 87, 12, 198, 254, 229];
pub const TREE_INITIALIZED_DISC: [u8; 8] =
    [142, 88, 245, 170, 133, 42, 218, 233];
pub const COMMITMENT_QUEUED_DISC: [u8; 8] =
    [145, 49, 63, 227, 178, 71, 188, 136];
pub const TRANSFERRED_DISC: [u8; 8] =
    [21, 132, 239, 64, 146, 239, 166, 68];
pub const WITHDRAWN_DISC: [u8; 8] =
    [20, 89, 223, 198, 194, 124, 219, 13];
pub const ROOT_UPDATED_DISC: [u8; 8] =
    [94, 53, 22, 128, 141, 113, 98, 231];
pub const PAUSED_TOGGLED_DISC: [u8; 8] =
    [77, 42, 45, 184, 47, 55, 187, 17];
pub const VERIFIER_KEY_ROTATED_DISC: [u8; 8] =
    [240, 43, 216, 166, 85, 53, 54, 86];
pub const FEE_UPDATED_DISC: [u8; 8] =
    [228, 75, 43, 103, 9, 196, 182, 4];

// =============================================================================
// Event payload schemas — field order MUST match programs/said-shielded-pool/src/events.rs.
// Anchor serializes `Pubkey` as the raw 32-byte array; we use [u8; 32] here to
// avoid pulling in solana-program.
// =============================================================================

/// `CommitmentQueued` — one commitment was appended to the on-chain insertion
/// queue. The indexer treats this as the "new leaf available" signal and
/// inserts `commitment` into the local mirror tree.
///
/// On-chain definition (programs/said-shielded-pool/src/events.rs):
/// ```ignore
/// #[event] pub struct CommitmentQueued {
///     pub tree: Pubkey,
///     pub queue_index: u64,
///     pub commitment: [u8; 32],
///     pub amount: u64,
/// }
/// ```
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct CommitmentQueued {
    pub tree: [u8; 32],
    pub queue_index: u64,
    pub commitment: [u8; COMMITMENT_BYTES],
    pub amount: u64,
}

/// `Transferred` — a 2-in/2-out shielded transfer was accepted on-chain.
/// The two output commitments will also surface as separate
/// `CommitmentQueued` events; we decode this purely for telemetry.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Transferred {
    pub tree: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; COMMITMENT_BYTES]; 2],
    pub ext_data_hash: [u8; 32],
}

/// `RootUpdated` — the forester rolled the queue into a new on-chain root.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct RootUpdated {
    pub tree: [u8; 32],
    pub new_root: [u8; 32],
    pub batch_size: u32,
}

/// `Withdrawn` — a shielded withdraw was accepted. Decoded for telemetry; the
/// indexer does not mutate the tree on withdrawals (nullifier tracking is a
/// follow-up).
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Withdrawn {
    pub tree: [u8; 32],
    pub nullifier: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u64,
    pub relayer_fee: u64,
}

/// `PoolInitialized` — emitted exactly once at program bootstrap.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct PoolInitialized {
    pub admin: [u8; 32],
    pub verifier_key_hash: [u8; 32],
    pub fee_bps: u16,
}

/// `TreeInitialized` — emitted once per (pool, mint) pair.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct TreeInitialized {
    pub pool: [u8; 32],
    pub mint: [u8; 32],
    pub depth: u8,
    pub initial_root: [u8; 32],
}

/// `PausedToggled` — admin paused/unpaused the pool.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct PausedToggled {
    pub paused: bool,
}

/// `VerifierKeyRotated` — admin swapped the on-chain Groth16 verifying key.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct VerifierKeyRotated {
    pub new_hash: [u8; 32],
}

/// `FeeUpdated` — admin changed the protocol fee (bps).
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct FeeUpdated {
    pub fee_bps: u16,
}

/// A decoded program event.
///
/// Variants the indexer doesn't act on are still surfaced (as the matching
/// `*` variant) so that callers can log them or write them to a richer
/// audit sink. Variants whose discriminator we do not recognize are
/// silently dropped by [`decode_program_data_line`] (returns `Ok(None)`)
/// to keep the listener robust against new event types added by a future
/// on-chain program upgrade.
#[derive(Clone, Debug)]
pub enum DecodedEvent {
    CommitmentQueued(CommitmentQueued),
    Transferred(Transferred),
    RootUpdated(RootUpdated),
    Withdrawn(Withdrawn),
    PoolInitialized(PoolInitialized),
    TreeInitialized(TreeInitialized),
    PausedToggled(PausedToggled),
    VerifierKeyRotated(VerifierKeyRotated),
    FeeUpdated(FeeUpdated),
}

impl DecodedEvent {
    /// New output commitments contributed to the tree by this event.
    /// Only `CommitmentQueued` returns a non-empty vec; `Transferred`
    /// commitments are intentionally *not* re-applied here because they
    /// arrive separately as `CommitmentQueued` events (each output commitment
    /// in a transfer is enqueued individually by the on-chain ix). Returning
    /// them here too would double-insert.
    pub fn commitments(&self) -> Vec<Commitment> {
        match self {
            Self::CommitmentQueued(c) => vec![Commitment(c.commitment)],
            _ => vec![],
        }
    }

    /// If this event carries a new authoritative root, return it.
    pub fn root(&self) -> Option<MerkleRoot> {
        match self {
            Self::RootUpdated(r) => Some(MerkleRoot(fb_from_arr(r.new_root))),
            Self::TreeInitialized(t) => Some(MerkleRoot(fb_from_arr(t.initial_root))),
            _ => None,
        }
    }

    /// Short human-readable tag, for log lines.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::CommitmentQueued(_) => "CommitmentQueued",
            Self::Transferred(_) => "Transferred",
            Self::RootUpdated(_) => "RootUpdated",
            Self::Withdrawn(_) => "Withdrawn",
            Self::PoolInitialized(_) => "PoolInitialized",
            Self::TreeInitialized(_) => "TreeInitialized",
            Self::PausedToggled(_) => "PausedToggled",
            Self::VerifierKeyRotated(_) => "VerifierKeyRotated",
            Self::FeeUpdated(_) => "FeeUpdated",
        }
    }
}

fn fb_from_arr(a: [u8; 32]) -> FieldBytes {
    a
}

/// Parse a `"Program data: <base64>"` log line into a [`DecodedEvent`],
/// or `None` if the line is not a recognized event.
///
/// Solana log messages also include other lines (`Program <pid> invoke`,
/// `Program log: …`); only `Program data: …` carries event payloads.
pub fn decode_program_data_line(line: &str) -> Result<Option<DecodedEvent>> {
    let payload_b64 = match line.strip_prefix("Program data: ") {
        Some(s) => s,
        None => return Ok(None),
    };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.trim())
        .map_err(|e| Error::EventDecode(format!("base64: {e}")))?;
    if bytes.len() < 8 {
        return Ok(None);
    }
    let (disc, rest) = bytes.split_at(8);
    let disc: [u8; 8] = disc.try_into().expect("8-byte split");
    let decoded = match disc {
        d if d == COMMITMENT_QUEUED_DISC => DecodedEvent::CommitmentQueued(
            CommitmentQueued::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("CommitmentQueued borsh: {e}")))?,
        ),
        d if d == TRANSFERRED_DISC => DecodedEvent::Transferred(
            Transferred::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("Transferred borsh: {e}")))?,
        ),
        d if d == ROOT_UPDATED_DISC => DecodedEvent::RootUpdated(
            RootUpdated::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("RootUpdated borsh: {e}")))?,
        ),
        d if d == WITHDRAWN_DISC => DecodedEvent::Withdrawn(
            Withdrawn::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("Withdrawn borsh: {e}")))?,
        ),
        d if d == POOL_INITIALIZED_DISC => DecodedEvent::PoolInitialized(
            PoolInitialized::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("PoolInitialized borsh: {e}")))?,
        ),
        d if d == TREE_INITIALIZED_DISC => DecodedEvent::TreeInitialized(
            TreeInitialized::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("TreeInitialized borsh: {e}")))?,
        ),
        d if d == PAUSED_TOGGLED_DISC => DecodedEvent::PausedToggled(
            PausedToggled::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("PausedToggled borsh: {e}")))?,
        ),
        d if d == VERIFIER_KEY_ROTATED_DISC => DecodedEvent::VerifierKeyRotated(
            VerifierKeyRotated::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("VerifierKeyRotated borsh: {e}")))?,
        ),
        d if d == FEE_UPDATED_DISC => DecodedEvent::FeeUpdated(
            FeeUpdated::try_from_slice(rest)
                .map_err(|e| Error::EventDecode(format!("FeeUpdated borsh: {e}")))?,
        ),
        _ => return Ok(None),
    };
    Ok(Some(decoded))
}

/// Extract all decoded events from a transaction's `logMessages`.
pub fn decode_tx_logs(logs: &[String]) -> Vec<DecodedEvent> {
    logs.iter()
        .filter_map(|l| decode_program_data_line(l).ok().flatten())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn anchor_disc(name: &str) -> [u8; 8] {
        let mut h = Sha256::new();
        h.update(format!("event:{name}").as_bytes());
        let out = h.finalize();
        let mut d = [0u8; 8];
        d.copy_from_slice(&out[..8]);
        d
    }

    #[test]
    fn discriminators_match_anchor_sha256() {
        assert_eq!(POOL_INITIALIZED_DISC, anchor_disc("PoolInitialized"));
        assert_eq!(TREE_INITIALIZED_DISC, anchor_disc("TreeInitialized"));
        assert_eq!(COMMITMENT_QUEUED_DISC, anchor_disc("CommitmentQueued"));
        assert_eq!(TRANSFERRED_DISC, anchor_disc("Transferred"));
        assert_eq!(WITHDRAWN_DISC, anchor_disc("Withdrawn"));
        assert_eq!(ROOT_UPDATED_DISC, anchor_disc("RootUpdated"));
        assert_eq!(PAUSED_TOGGLED_DISC, anchor_disc("PausedToggled"));
        assert_eq!(VERIFIER_KEY_ROTATED_DISC, anchor_disc("VerifierKeyRotated"));
        assert_eq!(FEE_UPDATED_DISC, anchor_disc("FeeUpdated"));
    }

    /// Cross-check against the Anchor-generated IDL at
    /// `target/idl/said_shielded_pool.json`. Skipped if the IDL hasn't been
    /// built yet (e.g. CI without `anchor build`).
    #[test]
    fn discriminators_match_idl() {
        // Repo-relative path. Skip the test if the IDL hasn't been generated.
        let candidates = [
            "../../target/idl/said_shielded_pool.json",
            "../../../target/idl/said_shielded_pool.json",
            "target/idl/said_shielded_pool.json",
        ];
        let mut idl_text = None;
        for p in &candidates {
            if let Ok(s) = std::fs::read_to_string(p) {
                idl_text = Some(s);
                break;
            }
        }
        let Some(idl_text) = idl_text else {
            eprintln!("IDL not found; run `anchor build` to enable this assertion");
            return;
        };
        let v: serde_json::Value =
            serde_json::from_str(&idl_text).expect("IDL must be valid JSON");
        let events = v["events"].as_array().expect("events array");
        let lookup = |name: &str| -> [u8; 8] {
            let ev = events
                .iter()
                .find(|e| e["name"] == name)
                .unwrap_or_else(|| panic!("event {name} missing from IDL"));
            let bytes: Vec<u8> = ev["discriminator"]
                .as_array()
                .expect("discriminator array")
                .iter()
                .map(|b| b.as_u64().expect("u8") as u8)
                .collect();
            assert_eq!(bytes.len(), 8, "discriminator must be 8 bytes");
            let mut out = [0u8; 8];
            out.copy_from_slice(&bytes);
            out
        };
        assert_eq!(POOL_INITIALIZED_DISC, lookup("PoolInitialized"));
        assert_eq!(TREE_INITIALIZED_DISC, lookup("TreeInitialized"));
        assert_eq!(COMMITMENT_QUEUED_DISC, lookup("CommitmentQueued"));
        assert_eq!(TRANSFERRED_DISC, lookup("Transferred"));
        assert_eq!(WITHDRAWN_DISC, lookup("Withdrawn"));
        assert_eq!(ROOT_UPDATED_DISC, lookup("RootUpdated"));
        assert_eq!(PAUSED_TOGGLED_DISC, lookup("PausedToggled"));
        assert_eq!(VERIFIER_KEY_ROTATED_DISC, lookup("VerifierKeyRotated"));
        assert_eq!(FEE_UPDATED_DISC, lookup("FeeUpdated"));
    }

    #[test]
    fn non_program_data_line_returns_none() {
        let line = "Program log: hello";
        assert!(decode_program_data_line(line).unwrap().is_none());
    }

    #[test]
    fn empty_program_data_returns_none() {
        let line = "Program data: ";
        assert!(decode_program_data_line(line).unwrap().is_none());
    }

    #[test]
    fn unknown_discriminator_returns_none() {
        // 8-byte disc that does not match any of our known events, +
        // arbitrary tail. Should be filtered out, not error.
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&[0xFFu8; 8]);
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let line = format!("Program data: {b64}");
        assert!(decode_program_data_line(&line).unwrap().is_none());
    }

    #[test]
    fn roundtrip_commitment_queued() {
        let ev = CommitmentQueued {
            tree: [7u8; 32],
            queue_index: 42,
            commitment: [9u8; COMMITMENT_BYTES],
            amount: 1_000_000,
        };
        let mut buf = Vec::new();
        buf.extend_from_slice(&COMMITMENT_QUEUED_DISC);
        borsh::BorshSerialize::serialize(&ev, &mut buf).unwrap();
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        let line = format!("Program data: {b64}");
        let decoded = decode_program_data_line(&line).unwrap().expect("decoded");
        match decoded {
            DecodedEvent::CommitmentQueued(c) => {
                assert_eq!(c.tree, [7u8; 32]);
                assert_eq!(c.queue_index, 42);
                assert_eq!(c.commitment, [9u8; COMMITMENT_BYTES]);
                assert_eq!(c.amount, 1_000_000);
            }
            other => panic!("wrong variant: {:?}", other.kind()),
        }
    }

    #[test]
    fn roundtrip_root_updated() {
        let ev = RootUpdated {
            tree: [3u8; 32],
            new_root: [4u8; 32],
            batch_size: 16,
        };
        let mut buf = Vec::new();
        buf.extend_from_slice(&ROOT_UPDATED_DISC);
        borsh::BorshSerialize::serialize(&ev, &mut buf).unwrap();
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        let line = format!("Program data: {b64}");
        let decoded = decode_program_data_line(&line).unwrap().expect("decoded");
        match decoded {
            DecodedEvent::RootUpdated(r) => {
                assert_eq!(r.tree, [3u8; 32]);
                assert_eq!(r.new_root, [4u8; 32]);
                assert_eq!(r.batch_size, 16);
                assert_eq!(decoded_root_bytes(&DecodedEvent::RootUpdated(r)), [4u8; 32]);
            }
            other => panic!("wrong variant: {:?}", other.kind()),
        }
    }

    fn decoded_root_bytes(ev: &DecodedEvent) -> [u8; 32] {
        ev.root().expect("root present").0
    }
}
