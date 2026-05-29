//! On-chain state for the Ghola SAID shielded pool.
//!
//! Wire-format note: the canonical Rust types live in
//! `crates/said-shielded-pool-types/src/lib.rs`. The program intentionally
//! does NOT depend on that crate (its `serde`/`sha2`/`thiserror` deps bloat
//! the BPF binary). The on-chain encodings below must stay byte-compatible
//! with the types crate: 32-byte Poseidon/BN254 field elements, big-endian.
//!
//! **V2 LAYOUT — Stream 4 (governance hardening).** The PoolConfig and
//! MerkleTree accounts grew incompatibly with the V1 devnet deployment.
//! Existing PDAs must be migrated via `instructions::migrate_config` after
//! the program is redeployed with a `realloc()` step in the migration ix.
//! See `docs/shielded-pool/GOVERNANCE.md` § 11 (Runbooks) for the procedure.

use anchor_lang::prelude::*;

/// Depth of every commitment Merkle tree. Matches `TREE_DEPTH` in the
/// types crate and the circom circuit.
pub const TREE_DEPTH: u8 = 26;

/// Number of historical roots kept on-chain. Spends may reference any root
/// inside this rolling window.
///
/// NOTE: deliberately reduced from 256 → 64 so the `MerkleTree` account
/// (now `#[account(zero_copy(unsafe))]`) stays small enough that
/// Anchor-generated `try_accounts` doesn't blow the 4 KiB BPF stack frame.
/// At 64 × 32 = 2 KiB the root_history array dominates struct size at
/// ~2.1 KiB total — comfortably under the frame ceiling.
/// Production deployments wanting a longer window can either bump this
/// constant (zero_copy will keep stack usage flat — only the on-chain
/// account grows), or split root-history into a dedicated
/// `RootHistory` account with its own AccountLoader.
pub const ROOT_HISTORY_SIZE: usize = 64;

/// Maximum length (in bytes) of a serialized verifying key we accept.
/// `groth16-solana` uses ~ (8 + 8 + 8 + (num_public_inputs+1) * 64) bytes;
/// 1 KiB comfortably covers nPub=8 (~700 bytes) and keeps the VerifierKey
/// account small. Bumping this is safe (just larger account rent) but
/// requires re-init of the PDA.
pub const VERIFIER_KEY_MAX_LEN: usize = 1024;

/// Number of public inputs to the transfer/withdraw/deposit circuits.
/// Order MUST match `groth16::PUBLIC_INPUT_LAYOUT`:
///   [root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount, asset_id, ext_data_hash]
pub const NUM_PUBLIC_INPUTS: usize = 8;

/// Default timelock for admin / vk rotation proposals. 48h.
pub const DEFAULT_TIMELOCK_SECS: u32 = 48 * 60 * 60;

/// Maximum fee in basis points. 10% cap.
pub const MAX_FEE_BPS: u16 = 1000;

/// Maximum number of authorized forester signers.
pub const FORESTER_SET_LEN: usize = 4;

/// Maximum number of committed orders an on-chain auction epoch can admit.
/// Larger batches should be split across epochs to keep account arithmetic
/// bounded and predictable.
pub const AUCTION_BATCH_SIZE: u16 = 64;

pub const AUCTION_STATUS_OPEN: u8 = 0;
pub const AUCTION_STATUS_CLOSED: u8 = 1;
pub const AUCTION_STATUS_CLEARED: u8 = 2;
pub const AUCTION_STATUS_SETTLED: u8 = 3;
pub const AUCTION_STATUS_EXPIRED: u8 = 4;
pub const AUCTION_STATUS_CANCELLED: u8 = 5;

/// Global pool configuration. PDA seeds: `[b"pool_config"]`.
///
/// **V2 layout** — V1 deployments must be migrated via
/// `instructions::migrate_config::migrate_config_handler`.
#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    /// Admin authority — can propose timelocked changes and execute
    /// non-sensitive immediate ops (fee, forester set).
    pub admin: Pubkey,
    /// SHA-256 of the verifier key bytes currently stored in the
    /// `VerifierKey` PDA. Lets light clients detect VK changes without
    /// downloading the full bytes.
    pub verifier_key_hash: [u8; 32],
    /// `VerifierKey` PDA holding the raw vk bytes.
    pub verifier_key: Pubkey,
    /// When `true`, deposit/transfer/withdraw all reject with `Paused`.
    pub paused: bool,
    /// Protocol fee in basis points (1 bp = 0.01%). Taken on withdrawal.
    pub fee_bps: u16,
    /// PDA bump for `PoolConfig`.
    pub bump: u8,

    // ---- V2 governance fields ----
    /// Pause-only authority that can flip `paused` immediately (no
    /// timelock). Separate key for incident response — kept hot, lower
    /// blast radius than the full admin.
    pub pause_authority: Pubkey,
    /// Pending admin pubkey from a `propose_admin_change`. `Pubkey::default()`
    /// (all zeros) == no pending proposal.
    pub pending_admin: Pubkey,
    /// Unix timestamp at/after which `accept_admin_change` is callable. 0
    /// when no proposal pending.
    pub admin_change_eta: i64,
    /// SHA-256 of the new vk bytes proposed via `propose_vk_rotation`.
    /// All zeros == no pending rotation.
    pub pending_vk_hash: [u8; 32],
    /// Unix timestamp at/after which `accept_vk_rotation` is callable. 0
    /// when no proposal pending.
    pub vk_change_eta: i64,
    /// Authorized forester signers for `update_root_via_proof`. Entries
    /// set to `Pubkey::default()` are treated as unset. If ALL entries
    /// are default (e.g. fresh-init), `update_root_via_proof` falls back
    /// to admin-signed (bootstrap mode).
    pub forester_set: [Pubkey; FORESTER_SET_LEN],
    /// Timelock duration applied to admin + vk rotation proposals, in
    /// seconds. Configurable at init; defaults to 48h.
    pub timelock_secs: u32,
    /// `true` once `migrate_config` has been applied (or on fresh
    /// `init_pool`). Idempotency guard: re-running `migrate_config`
    /// against an already-migrated PoolConfig is rejected.
    pub migrated: bool,
}

impl PoolConfig {
    pub fn migrated(&self) -> bool {
        self.migrated
    }

    pub fn mark_migrated(&mut self) {
        self.migrated = true;
    }

    /// Returns true iff `signer` is listed in `forester_set` (and is not
    /// the all-zero default slot).
    pub fn is_authorized_forester(&self, signer: &Pubkey) -> bool {
        let default = Pubkey::default();
        if signer == &default {
            return false;
        }
        self.forester_set.iter().any(|f| f == signer)
    }

    /// Returns true iff `forester_set` has no live entries (all slots
    /// are `Pubkey::default()`). Used as the bootstrap-mode flag for
    /// `update_root_via_proof` (falls back to admin-signed).
    pub fn forester_set_is_empty(&self) -> bool {
        let default = Pubkey::default();
        self.forester_set.iter().all(|f| f == &default)
    }
}

/// Verifier key for the Groth16 BN254 circuit. PDA seeds:
/// `[b"verifier_key", pool_config.key().as_ref()]`.
///
/// Stored separately from `PoolConfig` because the vk is several KiB.
///
/// `zero_copy(unsafe)` so Anchor uses `AccountLoader` and does not memcpy
/// the (potentially) KiB-sized `bytes` blob onto the BPF stack during
/// `try_accounts`.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct VerifierKey {
    /// PDA bump.
    pub bump: u8,
    /// Explicit padding to keep `len` (u16) naturally aligned.
    pub _pad: [u8; 1],
    /// Length in bytes of the encoded vk.
    pub len: u16,
    /// Raw encoded verifier key. Layout = `groth16-solana::Groth16Verifyingkey`.
    /// We store as a fixed-cap byte blob to avoid Anchor's Vec realloc churn.
    pub bytes: [u8; VERIFIER_KEY_MAX_LEN],
}

impl VerifierKey {
    /// 8-byte discriminator + bump (1) + pad (1) + len (2) + bytes
    pub const LEN: usize = 8 + 1 + 1 + 2 + VERIFIER_KEY_MAX_LEN;
}

/// Per-asset Merkle tree of commitments. PDA seeds:
/// `[b"merkle_tree", pool_config.key().as_ref(), mint.key().as_ref()]`.
///
/// **V2 layout** — added `queue_tail` so multiple deposits can sit in the
/// commitment queue simultaneously between forester runs. Existing V1
/// devnet accounts have `queue_tail == next_index` (the migration ix
/// initializes it to the live `next_index`).
///
/// `zero_copy(unsafe)` so Anchor uses `AccountLoader` rather than
/// `Account` — Anchor's generated `try_accounts` for `Account<T>` memcpys
/// the full deserialized struct onto the BPF stack (4 KiB ceiling).
///
/// Layout (bytes, after 8 disc):
///   root_history       64 * 32 = 2048
///   pool                       32
///   mint                       32
///   root                       32
///   next_index                  8   (forester write-pointer, advances on fold)
///   queue_tail                  8   (deposit write-pointer, advances on each deposit)
///   root_history_idx            4
///   depth                       1
///   bump                        1
///   _pad                        2
/// Total: 2168 bytes (+ 8 disc = 2176).
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct MerkleTree {
    /// Rolling window of recent roots (`ROOT_HISTORY_SIZE` deep). Any
    /// spend may reference a root in this window. Indexed by
    /// `root_history_idx`; wraps modulo `ROOT_HISTORY_SIZE`.
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    /// PoolConfig PDA this tree belongs to.
    pub pool: Pubkey,
    /// SPL mint this tree's commitments are denominated in.
    pub mint: Pubkey,
    /// The most-recently-finalized Merkle root.
    pub root: [u8; 32],
    /// Next free leaf index to be folded into the tree by the forester.
    /// Advances ONLY on successful `update_root_via_proof`. Must satisfy
    /// the invariant `next_index <= queue_tail`.
    pub next_index: u64,
    /// **V2 field.** Monotonic queue write-pointer. Advances by 1 on each
    /// deposit and by 2 on each transfer (2-in/2-out). Used as the PDA
    /// seed for `CommitmentRecord` so multiple in-flight deposits don't
    /// collide between forester batches.
    pub queue_tail: u64,
    /// Write pointer into `root_history` — the next slot to overwrite.
    pub root_history_idx: u32,
    /// Tree depth — fixed at `TREE_DEPTH` for now; field reserved for
    /// future depth upgrades / multi-tree forests.
    pub depth: u8,
    /// PDA bump.
    pub bump: u8,
    /// Explicit trailing padding so total size is a multiple of 4.
    pub _pad: [u8; 2],
}

/// Compile-time guard that the `#[repr(C)]` layout (and any padding the
/// compiler inserts) matches the hand-computed byte layout documented on
/// `MerkleTree`. `init_tree` allocates `8 + size_of::<MerkleTree>()`
/// bytes and `AccountLoader` reads/writes exactly `size_of::<MerkleTree>()`
/// from offset 8; if these ever diverge, zero-copy reads could run off the
/// end of the allocation. The assertion makes that a BUILD failure rather
/// than a runtime out-of-bounds.
///
/// Expected size derivation (align(MerkleTree) = 8, from the u64 fields):
///   root_history 64*32 = 2048
///   pool                 32
///   mint                 32
///   root                 32   (running offset 2144, divisible by 8)
///   next_index            8   (u64 — no pad needed, 2144 % 8 == 0)
///   queue_tail            8
///   root_history_idx      4
///   depth                 1
///   bump                  1
///   _pad                  2
///   ------------------------
///   total              2168   (already a multiple of 8 — no tail pad)
const MERKLE_TREE_EXPECTED_SIZE: usize =
    ROOT_HISTORY_SIZE * 32 // root_history
    + 32 // pool
    + 32 // mint
    + 32 // root
    + 8  // next_index
    + 8  // queue_tail
    + 4  // root_history_idx
    + 1  // depth
    + 1  // bump
    + 2; // _pad
const _: () = assert!(
    core::mem::size_of::<MerkleTree>() == MERKLE_TREE_EXPECTED_SIZE,
    "MerkleTree #[repr(C)] size drifted from the documented layout — \
     init_tree space + AccountLoader zero-copy reads would go out of bounds"
);
// Alignment must be 8 (the u64 fields) so the documented offsets — which
// assume no internal padding before `next_index` — hold.
const _: () = assert!(
    core::mem::align_of::<MerkleTree>() == 8,
    "MerkleTree alignment changed; documented field offsets may be wrong"
);

impl MerkleTree {
    /// Returns true iff `candidate` matches the latest root or any entry
    /// in the rolling history window.
    pub fn root_in_history(&self, candidate: &[u8; 32]) -> bool {
        if &self.root == candidate {
            return true;
        }
        self.root_history.iter().any(|r| r == candidate)
    }

    /// Append a new finalized root, shifting the previous root into history.
    pub fn push_root(&mut self, new_root: [u8; 32]) {
        let prev = self.root;
        self.root = new_root;
        let idx = (self.root_history_idx as usize) % ROOT_HISTORY_SIZE;
        self.root_history[idx] = prev;
        self.root_history_idx = self.root_history_idx.wrapping_add(1);
    }
}

#[cfg(test)]
mod merkle_tree_tests {
    use super::*;

    /// A zeroed `MerkleTree` for pure-logic tests of the root-history helper.
    /// `MerkleTree` is `#[repr(C)]` POD (all integer/array fields, no
    /// pointers), so an all-zero bit pattern is a valid, inert instance.
    fn empty_tree() -> MerkleTree {
        // SAFETY: every field is a plain-old-data integer or fixed-size byte
        // array; the all-zero bit pattern is a valid value for each.
        unsafe { std::mem::zeroed() }
    }

    /// **C-NEW-2 regression.** The deposit handler now gates `args.root`
    /// through `root_in_history` (mirroring withdraw/transfer). This proves
    /// the helper REJECTS a fabricated root (one never pushed into the tree)
    /// — which is exactly what blocks the fabricated-root inflation attack
    /// (real input proves membership against `root`; if `root` isn't a real
    /// tree root the deposit reverts with `RootNotInHistory`).
    #[test]
    fn fabricated_root_not_in_history() {
        let mut tree = empty_tree();
        // The attacker's fabricated root — a tree they built off-chain
        // containing notes that never existed.
        let fabricated = [0xABu8; 32];
        // It is NOT in the (empty) history.
        assert!(!tree.root_in_history(&fabricated));

        // Push some legitimate roots; the fabricated one still isn't there.
        tree.push_root([1u8; 32]);
        tree.push_root([2u8; 32]);
        tree.push_root([3u8; 32]);
        assert!(!tree.root_in_history(&fabricated));
    }

    /// A genuine recent root (the active root OR any windowed history entry)
    /// IS accepted — so an honest deposit (all-dummy inputs that skip
    /// membership in-circuit) just passes a recent real root and succeeds.
    #[test]
    fn recent_real_roots_in_history() {
        let mut tree = empty_tree();
        tree.push_root([1u8; 32]); // -> root, prev (0) into history
        tree.push_root([2u8; 32]); // -> root, prev (1) into history

        // Active root accepted.
        assert!(tree.root_in_history(&[2u8; 32]));
        // Prior root, now in the rolling window, accepted.
        assert!(tree.root_in_history(&[1u8; 32]));
        // The empty-tree root that was shifted into history is accepted too.
        assert!(tree.root_in_history(&[0u8; 32]));
    }
}

/// Marker PDA proving a nullifier has been spent. Existence == spent.
/// PDA seeds: `[b"nullifier", mint.key().as_ref(), &nullifier_bytes]`.
///
/// We bind the nullifier PDA to the mint so two different asset trees
/// can't collide on accidentally-equal nullifier field elements.
#[account]
#[derive(InitSpace)]
pub struct NullifierAccount {
    /// The 32-byte BN254 field-element nullifier (big-endian).
    pub nullifier: [u8; 32],
    /// Mint this nullifier was spent against.
    pub mint: Pubkey,
    /// Slot at which the nullifier was recorded — for audit / forester sync.
    pub spent_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

/// Pending-commitment queue entry. The forester batches these into the
/// tree off-chain and submits a proof of correct insertion via
/// `update_root_via_proof`.
///
/// PDA seeds: `[b"commitment", merkle_tree.key().as_ref(), &queue_index.to_le_bytes()]`.
///
/// **V2 semantics**: `queue_index` is now sourced from `tree.queue_tail`
/// (which deposit advances), not `tree.next_index` (which the forester
/// advances). This decouples deposit throughput from forester cadence.
#[account]
#[derive(InitSpace)]
pub struct CommitmentRecord {
    /// MerkleTree PDA this commitment belongs to.
    pub tree: Pubkey,
    /// Monotonic queue index assigned by the program at deposit time.
    pub queue_index: u64,
    /// The Poseidon commitment hash (BN254 field element, big-endian).
    pub commitment: [u8; 32],
    /// Slot the commitment was queued.
    pub queued_slot: u64,
    /// Whether this commitment has been folded into the tree yet.
    pub inserted: bool,
    /// PDA bump.
    pub bump: u8,
}

/// Shielded batch-auction market. PDA seeds:
/// `[b"auction_market", pool_config.key(), mint.key(), market_commitment]`.
#[account]
#[derive(InitSpace)]
pub struct AuctionMarket {
    pub pool_config: Pubkey,
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub market_commitment: [u8; 32],
    pub asset_id: [u8; 32],
    pub auction_verifier_key_hash: [u8; 32],
    pub batch_size: u16,
    pub status: u8,
    pub bump: u8,
}

/// One uniform-clearing auction window. PDA seeds:
/// `[b"auction_epoch", auction_market.key(), epoch_id.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct AuctionEpoch {
    pub auction_market: Pubkey,
    pub epoch_id: u64,
    pub order_root: [u8; 32],
    pub opened_slot: u64,
    pub closes_slot: u64,
    pub order_count: u16,
    pub matched_count: u16,
    pub rolled_count: u16,
    pub status: u8,
    pub clearing_commitment: [u8; 32],
    pub clearing_price_commitment: [u8; 32],
    pub proof_commitment: [u8; 32],
    pub settlement_commitment: [u8; 32],
    pub bump: u8,
}

/// Commitment-only order ticket for a shielded auction epoch. PDA seeds:
/// `[b"auction_order", auction_epoch.key(), order_commitment]`.
#[account]
#[derive(InitSpace)]
pub struct AuctionOrderCommitment {
    pub auction_epoch: Pubkey,
    pub owner: Pubkey,
    pub order_commitment: [u8; 32],
    pub order_nullifier: [u8; 32],
    pub price_bucket_commitment: [u8; 32],
    pub institution_policy_commitment: [u8; 32],
    pub side: u8,
    pub amount_bucket: u16,
    pub status: u8,
    pub created_slot: u64,
    pub bump: u8,
}

/// Per-market order nullifier. Existence prevents replaying one hidden order
/// across epochs. PDA seeds:
/// `[b"auction_order_nullifier", auction_market.key(), order_nullifier]`.
#[account]
#[derive(InitSpace)]
pub struct AuctionOrderNullifier {
    pub auction_market: Pubkey,
    pub order_nullifier: [u8; 32],
    pub consumed_slot: u64,
    pub bump: u8,
}

/// Commitment-only clearing record. PDA seeds:
/// `[b"auction_clearing", auction_epoch.key()]`.
#[account]
#[derive(InitSpace)]
pub struct AuctionClearing {
    pub auction_epoch: Pubkey,
    pub clearing_commitment: [u8; 32],
    pub clearing_price_commitment: [u8; 32],
    pub matched_root: [u8; 32],
    pub rolled_root: [u8; 32],
    pub proof_commitment: [u8; 32],
    pub settlement_commitment: [u8; 32],
    pub matched_count: u16,
    pub rolled_count: u16,
    pub status: u8,
    pub bump: u8,
}

/// Off-chain evidence attestation log. PDA seeds: `[b"evidence_log"]`.
///
/// Stream 4 + Stream 10 use this to commit hashes of off-chain audit
/// evidence (proof-bundles, indexer state, forester batch logs) on-chain
/// so external auditors can verify retroactively that the evidence at a
/// given slot matches what's claimed.
#[account]
#[derive(InitSpace)]
pub struct EvidenceLog {
    /// Latest attested evidence root.
    pub latest_root: [u8; 32],
    /// Slot at which `latest_root` was attested.
    pub latest_attest_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl EvidenceLog {
    pub fn push(&mut self, root: [u8; 32], slot: u64) {
        self.latest_root = root;
        self.latest_attest_slot = slot;
    }
}

/// Escrow token account holds all deposited liquidity for one mint.
/// Owned by the program. PDA seeds:
/// `[b"escrow", pool_config.key().as_ref(), mint.key().as_ref()]`.
/// (The token account itself is created via `anchor_spl::associated_token`
/// or directly initialized; we just need the PDA address to be derivable.)
pub fn escrow_seeds<'a>(pool: &'a Pubkey, mint: &'a Pubkey) -> [&'a [u8]; 3] {
    [b"escrow", pool.as_ref(), mint.as_ref()]
}

/// Discriminator-style enum used by `cancel_proposal` so admin can clear
/// either the admin-change or the vk-rotation slot without ambiguity.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ProposalKind {
    AdminChange = 0,
    VkRotation = 1,
}
