//! Plain-data mirrors of the on-chain accounts in
//! `programs/said-shielded-pool/src/state.rs`. The on-chain types depend
//! on `anchor-lang` and live in a no-std-ish BPF target, so we cannot
//! re-use them directly off-chain — but every field is byte-stable, and
//! every field that participates in a safety invariant is mirrored here.
//!
//! The relationship is:
//!   * `programs/said-shielded-pool/src/state.rs::PoolConfig` <==> `PoolConfigSnap`
//!   * `programs/said-shielded-pool/src/state.rs::MerkleTree`  <==> `MerkleTreeSnap`
//!   * `programs/said-shielded-pool/src/state.rs::NullifierAccount` <==> entries in `Snapshot::nullifier_set`
//!   * `programs/said-shielded-pool/src/state.rs::CommitmentRecord`  <==> entries in `Snapshot::commitment_queue`
//!
//! Custody, revenue, and queue history are reconstructed off-chain by
//! replaying recorded program events; `Snapshot::custody_history`,
//! `Snapshot::revenue_events`, and `Snapshot::relay_queue` carry those.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use said_shielded_pool_types::{FORESTER_BATCH_SIZE, ROOT_HISTORY_SIZE as TYPES_ROOT_HISTORY_SIZE};

// On-chain `ROOT_HISTORY_SIZE` is 64 (reduced from the types-crate 256
// for BPF stack-size reasons). We track the on-chain value here.
pub const ONCHAIN_ROOT_HISTORY_SIZE: usize = 64;

/// The off-chain "types" crate carries a larger constant (256) used by
/// host code. Most invariants want the on-chain value; we re-export both
/// to make intent explicit at call sites.
pub const HOST_ROOT_HISTORY_SIZE: usize = TYPES_ROOT_HISTORY_SIZE;

/// 32-byte BN254 field element, big-endian (matches every on-chain type).
pub type FieldBytes = [u8; 32];

/// 32-byte SPL mint pubkey (used as asset binding seed).
pub type MintBytes = [u8; 32];

/// 32-byte program-address pubkey (admin, forester, etc.).
pub type AddrBytes = [u8; 32];

/// Off-chain mirror of `PoolConfig` (V2 layout — Stream 4).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct PoolConfigSnap {
    pub admin: AddrBytes,
    pub verifier_key_hash: [u8; 32],
    pub paused: bool,
    pub fee_bps: u16,

    // V2 governance fields
    pub pause_authority: AddrBytes,
    pub pending_admin: AddrBytes,
    pub admin_change_eta: i64,
    pub pending_vk_hash: [u8; 32],
    pub vk_change_eta: i64,
    /// Authorized forester signers. Default-pubkey ([0;32]) entries are
    /// considered unset.
    pub forester_set: [AddrBytes; 4],
    pub timelock_secs: u32,

    /// V2 migration flag. `true` iff the on-chain `_reserved[0]` byte is 1.
    pub migrated: bool,
}

impl PoolConfigSnap {
    pub fn is_authorized_forester(&self, signer: &AddrBytes) -> bool {
        let default = [0u8; 32];
        if signer == &default {
            return false;
        }
        self.forester_set.iter().any(|f| f == signer)
    }

    pub fn forester_set_is_empty(&self) -> bool {
        let default = [0u8; 32];
        self.forester_set.iter().all(|f| f == &default)
    }
}

/// Off-chain mirror of `MerkleTree` (V2 — has `queue_tail`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MerkleTreeSnap {
    pub pool: AddrBytes,
    pub mint: MintBytes,
    pub root: [u8; 32],
    pub next_index: u64,
    pub queue_tail: u64,
    /// Rolling window of historical roots. Length should equal
    /// `ONCHAIN_ROOT_HISTORY_SIZE` for a real on-chain account, but we
    /// accept any length here (tests use shorter windows).
    pub root_history: Vec<[u8; 32]>,
    pub root_history_idx: u32,
    pub depth: u8,
}

impl MerkleTreeSnap {
    pub fn root_in_history(&self, candidate: &[u8; 32]) -> bool {
        &self.root == candidate || self.root_history.iter().any(|r| r == candidate)
    }
}

/// Off-chain mirror of one entry in the deposit/commitment queue.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitmentQueueEntry {
    pub queue_index: u64,
    pub commitment: [u8; 32],
    pub inserted: bool,
}

/// Off-chain mirror of one entry in the relayer's pending-proof queue.
/// (Stream 3 owns the canonical hash scheme; this struct carries the
/// hash computed off-chain so invariants can dedupe without recomputing.)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RelayQueueEntry {
    /// Canonical proof hash. The hash function is owned by Stream 3
    /// (`crates/said-shielded-pool-relayer/src/dedup.rs`). See the
    /// TODO in `checks::inv_relay_dedupe` — this crate matches whatever
    /// scheme that source-of-truth picks (planned: `blake3(a || b || c)`).
    pub proof_hash: [u8; 32],
    /// Unix seconds when the entry was queued. Used by k-anonymity.
    pub queued_at: u64,
}

impl RelayQueueEntry {
    pub fn proof_hash(&self) -> [u8; 32] {
        self.proof_hash
    }
}

/// Pending forester proof (off-chain — used to verify queue-bounds
/// invariants before submission).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingForesterProof {
    pub start_index: u64,
    pub commitments: Vec<[u8; 32]>,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
}

impl PendingForesterProof {
    pub fn batch_size(&self) -> usize {
        self.commitments.len()
    }
}

/// One observation in the custody event log (replayed from on-chain
/// transaction history).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum CustodyEvent {
    /// Deposit moved `amount` from the depositor to the escrow ATA.
    Deposit { amount: u64 },
    /// Withdraw sent `recipient_amount` to the recipient and
    /// `relayer_amount` (fee + tip) to the relayer.
    Withdraw {
        recipient_amount: u64,
        relayer_amount: u64,
    },
    /// Protocol fee retained in the revenue vault.
    FeeRetained { amount: u64 },
    /// Admin drained `amount` out of the revenue vault.
    RevenueDrain { amount: u64, signer: AddrBytes },
}

/// One withdraw event for revenue-accumulator invariants.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawEvent {
    pub amount: u64,
    /// Fee-bps in effect at the time of withdraw. We record it on the
    /// event (rather than reading current `fee_bps`) so an admin
    /// changing fees doesn't retroactively shift the expected accumulator.
    pub fee_bps: u16,
}

/// A drain attempt against the revenue vault — signer + amount.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultEvent {
    pub signer: AddrBytes,
    pub amount: u64,
}

/// One forester-advancement observation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForesterEvent {
    /// Variant marker so `inv_next_index_only_advanced_by_forester` can
    /// reject non-forester paths to advancement.
    pub event: ForesterEventKind,
    /// Signer of the on-chain `update_root_via_proof` tx.
    pub signer: AddrBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForesterEventKind {
    ForesterUpdate,
    /// Anything else (deposit, transfer, withdraw, admin op). Should
    /// NEVER appear in a chain that advances `next_index`.
    Other,
}

/// Inputs to value-conservation checking, modelled from the
/// transfer/deposit/withdraw witness shape. Fields are public-input
/// projections — no secrets carried here.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferWitnessSummary {
    /// Per-asset input amounts (zero-amount entries are "dummy notes"
    /// that the circuit accepts as no-ops).
    pub input_amounts: Vec<u64>,
    pub output_amounts: Vec<u64>,
    /// Asset id (Poseidon(mint)). All input + output notes must share
    /// this id; mixed-asset transfers are forbidden.
    pub asset_id: [u8; 32],
    /// Whether any input or output note carries a different asset id.
    pub mixed_asset_present: bool,
}

/// A complete release-batch description for the k-anonymity checker.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Batch {
    /// Number of items in the batch.
    pub size: usize,
    /// Age (in seconds) of the OLDEST item in the batch — that item's
    /// `now - queued_at`.
    pub oldest_age_secs: u64,
}

/// Full snapshot of pool state at a given slot. Constructed off-chain
/// (`Snapshot::from_program_state` or `Snapshot::from_json`) and passed
/// to the predicate functions in `checks`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub pool_config: PoolConfigSnap,
    pub tree: MerkleTreeSnap,
    /// Set of nullifiers known spent (one entry per `NullifierAccount` PDA).
    pub nullifier_set: HashSet<[u8; 32]>,
    /// Pending commitment queue (entries with `inserted == false`).
    pub commitment_queue: Vec<CommitmentQueueEntry>,
    /// Live escrow ATA balance (one mint per snapshot in this model).
    pub escrow_balance: u64,
    /// Live revenue-vault balance.
    pub revenue_vault_balance: u64,
    /// Off-chain relayer queue (proof_hash + queued_at). Stream 3 owns
    /// the canonical hash; this is what the relayer is currently holding.
    pub relay_queue: Vec<RelayQueueEntry>,
    /// Off-chain pending forester proofs (built by the indexer's
    /// forester before submission).
    pub pending_forester_proofs: Vec<PendingForesterProof>,
}

impl Snapshot {
    /// Convenience constructor for the common case where the caller has
    /// flat field values (e.g. from a test fixture or JSON dump).
    #[allow(clippy::too_many_arguments)]
    pub fn from_program_state(
        pool_config: PoolConfigSnap,
        tree: MerkleTreeSnap,
        nullifier_set: HashSet<[u8; 32]>,
        commitment_queue: Vec<CommitmentQueueEntry>,
        escrow_balance: u64,
        revenue_vault_balance: u64,
        relay_queue: Vec<RelayQueueEntry>,
        pending_forester_proofs: Vec<PendingForesterProof>,
    ) -> Self {
        Self {
            pool_config,
            tree,
            nullifier_set,
            commitment_queue,
            escrow_balance,
            revenue_vault_balance,
            relay_queue,
            pending_forester_proofs,
        }
    }

    /// Parse a snapshot from a JSON blob — useful for auditor flows
    /// where the indexer dumps state to disk.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// An empty snapshot — handy for tests.
    pub fn empty() -> Self {
        Self {
            pool_config: PoolConfigSnap::default(),
            tree: MerkleTreeSnap {
                pool: [0u8; 32],
                mint: [0u8; 32],
                root: [0u8; 32],
                next_index: 0,
                queue_tail: 0,
                root_history: vec![[0u8; 32]; ONCHAIN_ROOT_HISTORY_SIZE],
                root_history_idx: 0,
                depth: 26,
            },
            nullifier_set: HashSet::new(),
            commitment_queue: vec![],
            escrow_balance: 0,
            revenue_vault_balance: 0,
            relay_queue: vec![],
            pending_forester_proofs: vec![],
        }
    }
}

/// Re-exported batch size — matches the on-chain forester circuit.
pub const FORESTER_BATCH: usize = FORESTER_BATCH_SIZE;
