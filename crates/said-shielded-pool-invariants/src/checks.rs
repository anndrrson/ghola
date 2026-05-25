//! Predicate functions — one per invariant. Each returns
//! `Result<(), InvariantViolation>` so callers can fail-fast on the
//! first violation they care about, or fold a `Vec<InvariantViolation>`
//! across the whole snapshot in an audit pass.
//!
//! See `docs/shielded-pool/INVARIANTS.md` for the formal statement and
//! the on-chain enforcement site of each predicate.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::model::{
    Batch, CustodyEvent, FORESTER_BATCH, ForesterEvent, ForesterEventKind, PendingForesterProof,
    RelayQueueEntry, Snapshot, TransferWitnessSummary, VaultEvent, WithdrawEvent,
};

/// One typed enum per invariant family — keeps error messages precise
/// while letting auditors collect violations across families.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum InvariantViolation {
    #[error("notes: value conservation violated: {0}")]
    Notes(String),
    #[error("nullifiers: {0}")]
    Nullifiers(String),
    #[error("roots: {0}")]
    Roots(String),
    #[error("custody: {0}")]
    Custody(String),
    #[error("proofs: {0}")]
    Proofs(String),
    #[error("relayers: {0}")]
    Relayers(String),
    #[error("metering: {0}")]
    Metering(String),
    #[error("revenue: {0}")]
    Revenue(String),
}

pub type Result<T> = std::result::Result<T, InvariantViolation>;

// =============================================================================
// FAMILY 1 — NOTES (value conservation)
// =============================================================================

/// `Σ(input_amounts) + public_amount == Σ(output_amounts)`, per-asset.
///
/// This is the arithmetic equation enforced by the circuit
/// (`circuits/transaction.circom`) — see SPEC.md §4.1, item 7.
///
/// Sign convention (arithmetic, off-chain frame):
///   * `public_amount > 0` ==> deposit / shield-in (new outputs minted
///     to back an SPL transfer INTO the escrow ATA).
///   * `public_amount < 0` ==> withdraw / unshield-out (inputs spent
///     to back an SPL transfer OUT of escrow).
///   * `public_amount == 0` ==> internal transfer (no net flow).
///
/// (SPEC.md uses "negative = shield-in" descriptively to mean the
/// pool's net-flow perspective. The arithmetic equation is the same.)
///
/// **Enforcement**: the Groth16 circuit (`circuits/transaction.circom`)
/// constrains `sumIn + publicAmount = sumOut`. As of H1 (2026-05-25) the
/// circuit ALSO range-bounds `publicAmount` to the signed-64-bit envelope
/// (`SignedAmount64`) and both sums to 65 bits (`Num2Bits(sumBits)`), so
/// the equality holds over the integers — it can no longer be satisfied by
/// a mod-r wrap. This off-chain checker already modelled the sound
/// behaviour (it works in checked `i128`/`u128`, never in the field), so
/// it needs no change; it is the cross-check that the recovered witness
/// satisfies the same relation the circuit now enforces.
/// **Off-chain checker**: this function, called by the indexer + chaos
/// harness against the recovered witness.
pub fn inv_note_conservation(
    witness: &TransferWitnessSummary,
    public_amount: i128,
) -> Result<()> {
    if witness.mixed_asset_present {
        return Err(InvariantViolation::Notes(
            "mixed asset_id detected across input/output notes".into(),
        ));
    }
    let sum_in: u128 = witness
        .input_amounts
        .iter()
        .try_fold(0u128, |acc, x| acc.checked_add(*x as u128))
        .ok_or_else(|| InvariantViolation::Notes("input sum overflow".into()))?;
    let sum_out: u128 = witness
        .output_amounts
        .iter()
        .try_fold(0u128, |acc, x| acc.checked_add(*x as u128))
        .ok_or_else(|| InvariantViolation::Notes("output sum overflow".into()))?;

    // sumIn + publicAmount == sumOut.
    let lhs = (sum_in as i128)
        .checked_add(public_amount)
        .ok_or_else(|| InvariantViolation::Notes("lhs overflow".into()))?;
    let rhs = sum_out as i128;
    if lhs != rhs {
        return Err(InvariantViolation::Notes(format!(
            "sumIn + publicAmount ({lhs}) != sumOut ({rhs})"
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 2 — NULLIFIERS (uniqueness + binding)
// =============================================================================

/// A candidate nullifier must NOT already exist in the spent set.
///
/// **Enforcement**: on-chain, `NullifierAccount` PDA is `init` (not
/// `init_if_needed`); a second submit fails account-already-exists.
/// **Off-chain checker**: this function.
pub fn inv_nullifier_uniqueness(
    snapshot: &Snapshot,
    candidate: [u8; 32],
) -> Result<()> {
    if snapshot.nullifier_set.contains(&candidate) {
        return Err(InvariantViolation::Nullifiers(format!(
            "double-spend: candidate nullifier {} already in spent set",
            hex::encode(candidate)
        )));
    }
    Ok(())
}

/// If the spent set contains `nullifier`, the corresponding PDA must
/// exist on-chain. (Modeled here as "the snapshot reflects ground truth.")
pub fn inv_nullifier_pda_existence(
    snapshot: &Snapshot,
    nullifier: [u8; 32],
) -> Result<()> {
    if !snapshot.nullifier_set.contains(&nullifier) {
        return Err(InvariantViolation::Nullifiers(format!(
            "expected PDA-backed nullifier {} not in spent set",
            hex::encode(nullifier)
        )));
    }
    Ok(())
}

/// Recompute the nullifier `Poseidon(sk, commitment, leaf_index)` and
/// confirm it matches the claimed value. Determinism of the derivation
/// is itself an invariant — the same `(sk, commitment, leaf_index)`
/// triple must always yield the same nullifier across hosts.
///
/// `leaf_index` is encoded as big-endian 32-byte field element (top
/// 24 bytes zero); this matches the circuit's encoding convention.
pub fn inv_nullifier_derivation(
    spending_key: &[u8; 32],
    commitment: &[u8; 32],
    leaf_index: u64,
    claimed: &[u8; 32],
) -> Result<()> {
    let mut idx_be = [0u8; 32];
    idx_be[24..32].copy_from_slice(&leaf_index.to_be_bytes());
    let computed = poseidon3(spending_key, commitment, &idx_be).map_err(|e| {
        InvariantViolation::Nullifiers(format!("poseidon3 failed: {e}"))
    })?;
    if &computed != claimed {
        return Err(InvariantViolation::Nullifiers(format!(
            "nullifier mismatch: computed {} != claimed {}",
            hex::encode(computed),
            hex::encode(claimed)
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 3 — ROOTS (windowed + monotone)
// =============================================================================

/// The proof's claimed merkle root must equal the current root OR
/// appear in the rolling history window.
///
/// **Enforcement**: `instructions::transfer::transfer_handler` calls
/// `tree.root_in_history(&args.root)`.
pub fn inv_root_in_history_window(
    snapshot: &Snapshot,
    proof_root: [u8; 32],
) -> Result<()> {
    if !snapshot.tree.root_in_history(&proof_root) {
        return Err(InvariantViolation::Roots(format!(
            "proof root {} not in tree.root or rolling history (window={})",
            hex::encode(proof_root),
            snapshot.tree.root_history.len()
        )));
    }
    Ok(())
}

/// `next_index` may only advance via `update_root_via_proof` (forester
/// path), and it advances by exactly `FORESTER_BATCH_SIZE`.
///
/// **Enforcement**: `instructions::update_root::update_root_handler`
/// is the sole place `tree.next_index` is mutated.
pub fn inv_next_index_only_advanced_by_forester(
    prev: &Snapshot,
    next: &Snapshot,
    by: &ForesterEvent,
) -> Result<()> {
    let delta = next
        .tree
        .next_index
        .checked_sub(prev.tree.next_index)
        .ok_or_else(|| {
            InvariantViolation::Roots(
                "next_index moved backward (must be monotone non-decreasing)".into(),
            )
        })?;

    if delta == 0 {
        // No advancement — caller is welcome.
        return Ok(());
    }

    if by.event != ForesterEventKind::ForesterUpdate {
        return Err(InvariantViolation::Roots(format!(
            "next_index advanced by {delta} via non-forester event"
        )));
    }
    if delta != FORESTER_BATCH as u64 {
        return Err(InvariantViolation::Roots(format!(
            "next_index advanced by {delta}, expected exactly {FORESTER_BATCH}"
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 4 — CUSTODY (escrow accounting)
// =============================================================================

/// Replay the custody event history and confirm the resulting balance
/// matches `snapshot.escrow_balance`.
///
/// **Enforcement**: every deposit/withdraw mutates the escrow ATA via
/// `anchor_spl::token` CPIs; off-chain we replay the recorded events.
pub fn inv_escrow_balance(
    snapshot: &Snapshot,
    history: &[CustodyEvent],
) -> Result<()> {
    let mut bal: i128 = 0;
    for ev in history {
        match ev {
            CustodyEvent::Deposit { amount } => bal += *amount as i128,
            CustodyEvent::Withdraw {
                recipient_amount,
                relayer_amount,
            } => {
                bal -= *recipient_amount as i128;
                bal -= *relayer_amount as i128;
            }
            // Fees are split out into the revenue vault; they exit the
            // escrow at withdraw time and are tracked separately.
            CustodyEvent::FeeRetained { .. } => {}
            CustodyEvent::RevenueDrain { .. } => {}
        }
    }
    if bal < 0 {
        return Err(InvariantViolation::Custody(format!(
            "escrow went negative during replay: {bal}"
        )));
    }
    if bal as u64 != snapshot.escrow_balance {
        return Err(InvariantViolation::Custody(format!(
            "escrow replay {bal} != live balance {}",
            snapshot.escrow_balance
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 5 — PROOFS (vk hash commitment + public-input layout)
// =============================================================================

/// `pool_config.verifier_key_hash == sha256(vk_bytes)`.
///
/// **Enforcement**: `instructions::governance::accept_vk_rotation_handler`
/// recomputes the hash before committing; `init_pool` does the same.
pub fn inv_vk_hash_commitment(
    snapshot: &Snapshot,
    vk_bytes: &[u8],
) -> Result<()> {
    let mut hasher = Sha256::new();
    hasher.update(vk_bytes);
    let computed: [u8; 32] = hasher.finalize().into();
    if computed != snapshot.pool_config.verifier_key_hash {
        return Err(InvariantViolation::Proofs(format!(
            "vk hash mismatch: computed sha256(vk) = {}, on-chain = {}",
            hex::encode(computed),
            hex::encode(snapshot.pool_config.verifier_key_hash)
        )));
    }
    Ok(())
}

/// The public input vector must be exactly 8 elements in the canonical
/// order:
///   `[root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount, asset_id, ext_data_hash]`
///
/// **Enforcement**: `NUM_PUBLIC_INPUTS = 8` in `state.rs`; the verifier
/// rejects any length mismatch.
pub fn inv_public_input_layout(public_inputs: &[[u8; 32]]) -> Result<()> {
    if public_inputs.len() != 8 {
        return Err(InvariantViolation::Proofs(format!(
            "expected 8 public inputs, got {}",
            public_inputs.len()
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 6 — RELAYERS (queue dedup + k-anonymity)
// =============================================================================

/// A new proof must NOT collide with anything currently queued.
///
/// **Enforcement**: Stream 3 will land
/// `crates/said-shielded-pool-relayer/src/dedup.rs`. The canonical hash
/// scheme is intended to be `blake3(proof.a || proof.b || proof.c)`
/// (3 * 32 = 96 bytes for compressed BN254 affine encoding, or 256 bytes
/// uncompressed). This predicate just checks set membership against
/// whatever hash the relayer has already canonicalized into
/// `RelayQueueEntry::proof_hash`.
///
/// TODO(stream-3): when `said-shielded-pool-relayer::dedup` lands,
/// import the hash function here and assert it matches.
pub fn inv_relay_dedupe(
    queue: &[RelayQueueEntry],
    new_proof_hash: [u8; 32],
) -> Result<()> {
    if queue.iter().any(|q| q.proof_hash() == new_proof_hash) {
        return Err(InvariantViolation::Relayers(format!(
            "duplicate proof_hash {} already in relayer queue",
            hex::encode(new_proof_hash)
        )));
    }
    Ok(())
}

/// A release batch is allowed to fire iff the batch is at least `k`
/// items OR the oldest item has waited past the `max_delay_secs`
/// timeout (degraded path — keeps liveness if traffic is too low to
/// reach `k`). Items must also have waited at least `min_delay_secs`
/// before they can be batched at all.
///
/// **Enforcement**: Stream 3 release scheduler. This predicate matches
/// the documented release rule in `docs/shielded-pool/SPEC.md` §
/// "Relayer privacy".
pub fn inv_k_anonymity_release(
    batch: &Batch,
    k: usize,
    min_delay_secs: u64,
    max_delay_secs: u64,
) -> Result<()> {
    if max_delay_secs < min_delay_secs {
        return Err(InvariantViolation::Relayers(
            "max_delay < min_delay — caller misconfigured release predicate".into(),
        ));
    }
    if batch.size == 0 {
        return Err(InvariantViolation::Relayers(
            "empty batch cannot be released".into(),
        ));
    }
    let size_ok = batch.size >= k;
    let timeout_ok = batch.oldest_age_secs >= max_delay_secs;
    let min_ok = batch.oldest_age_secs >= min_delay_secs;

    if !min_ok {
        return Err(InvariantViolation::Relayers(format!(
            "oldest item age {} < min_delay {}",
            batch.oldest_age_secs, min_delay_secs
        )));
    }
    if !(size_ok || timeout_ok) {
        return Err(InvariantViolation::Relayers(format!(
            "batch size {} < k={} AND oldest_age {} < max_delay {}",
            batch.size, k, batch.oldest_age_secs, max_delay_secs
        )));
    }
    Ok(())
}

// =============================================================================
// FAMILY 7 — METERING (queue_tail vs next_index)
// =============================================================================

/// `queue_tail >= next_index` always. Deposits + transfers advance
/// `queue_tail`; only the forester advances `next_index`.
///
/// **Enforcement**: `instructions::deposit::deposit_handler` and
/// `instructions::transfer::transfer_handler` only bump `queue_tail`;
/// `update_root_handler` enforces `start_index == next_index` and
/// `start_index + FORESTER_BATCH_SIZE <= queue_tail`.
pub fn inv_queue_tail_geq_next_index(snapshot: &Snapshot) -> Result<()> {
    if snapshot.tree.queue_tail < snapshot.tree.next_index {
        return Err(InvariantViolation::Metering(format!(
            "queue_tail {} < next_index {} — impossible without state corruption",
            snapshot.tree.queue_tail, snapshot.tree.next_index
        )));
    }
    Ok(())
}

/// Forester proofs must align with the live tree state:
/// `start_index == tree.next_index` AND
/// `start_index + FORESTER_BATCH_SIZE <= tree.queue_tail`.
pub fn inv_forester_proof_bounds(
    snapshot: &Snapshot,
    start_index: u64,
) -> Result<()> {
    if start_index != snapshot.tree.next_index {
        return Err(InvariantViolation::Metering(format!(
            "forester start_index {} != tree.next_index {}",
            start_index, snapshot.tree.next_index
        )));
    }
    let end = start_index
        .checked_add(FORESTER_BATCH as u64)
        .ok_or_else(|| InvariantViolation::Metering("start_index + batch overflows u64".into()))?;
    if end > snapshot.tree.queue_tail {
        return Err(InvariantViolation::Metering(format!(
            "forester batch end {} > tree.queue_tail {} (not enough queued commits)",
            end, snapshot.tree.queue_tail
        )));
    }
    Ok(())
}

/// Convenience — check both metering invariants over a pending proof.
pub fn inv_pending_forester_well_formed(
    snapshot: &Snapshot,
    pending: &PendingForesterProof,
) -> Result<()> {
    inv_queue_tail_geq_next_index(snapshot)?;
    if pending.batch_size() != FORESTER_BATCH {
        return Err(InvariantViolation::Metering(format!(
            "forester batch size {} != FORESTER_BATCH_SIZE {}",
            pending.batch_size(),
            FORESTER_BATCH
        )));
    }
    inv_forester_proof_bounds(snapshot, pending.start_index)
}

// =============================================================================
// FAMILY 8 — REVENUE (fee accumulator + drain authority)
// =============================================================================

/// `revenue_vault_balance == Σ_over_history(amount * fee_bps / 10000) -
/// Σ_admin_drains(amount)`. Per-event `fee_bps` is recorded so admin
/// fee changes don't retroactively rewrite the expected accumulator.
///
/// **Enforcement**: `instructions::withdraw::withdraw_handler` splits
/// fee at CPI time; `instructions::admin::admin_sweep_fees` (admin-only)
/// drains.
pub fn inv_revenue_accumulator(
    snapshot: &Snapshot,
    history: &[WithdrawEvent],
    drains: &[VaultEvent],
) -> Result<()> {
    let mut acc: u128 = 0;
    for ev in history {
        let fee = (ev.amount as u128).saturating_mul(ev.fee_bps as u128) / 10_000u128;
        acc = acc
            .checked_add(fee)
            .ok_or_else(|| InvariantViolation::Revenue("fee accumulator overflow".into()))?;
    }
    let mut drained: u128 = 0;
    for d in drains {
        drained = drained
            .checked_add(d.amount as u128)
            .ok_or_else(|| InvariantViolation::Revenue("drain sum overflow".into()))?;
    }
    let expected: i128 = (acc as i128) - (drained as i128);
    if expected < 0 {
        return Err(InvariantViolation::Revenue(format!(
            "drains ({drained}) exceeded accumulated fees ({acc})"
        )));
    }
    if expected as u128 != snapshot.revenue_vault_balance as u128 {
        return Err(InvariantViolation::Revenue(format!(
            "revenue vault {} != expected {} (fees={acc} drains={drained})",
            snapshot.revenue_vault_balance, expected
        )));
    }
    Ok(())
}

/// Every drain event must be signed by the current admin.
///
/// **Enforcement**: `instructions::admin::admin_sweep_fees` has
/// `#[account(constraint = signer.key() == pool_config.admin)]`.
pub fn inv_revenue_drain_only_by_admin(
    events: &[VaultEvent],
    admin: [u8; 32],
) -> Result<()> {
    for (i, ev) in events.iter().enumerate() {
        if ev.signer != admin {
            return Err(InvariantViolation::Revenue(format!(
                "drain event[{i}] signed by {} but admin is {}",
                hex::encode(ev.signer),
                hex::encode(admin)
            )));
        }
    }
    Ok(())
}

// =============================================================================
// Internal — Poseidon3 over BN254.
// =============================================================================

/// Poseidon(a, b, c) on BN254 Fr. Matches Solana's `sol_poseidon`
/// (light-protocol/light-poseidon) and the circom Poseidon3 used in
/// `circuits/`. Inputs are 32-byte big-endian field elements; output
/// is the 32-byte BE encoding of the resulting Fr element.
fn poseidon3(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> std::result::Result<[u8; 32], String> {
    // Reduce each input mod p — the circuit accepts any 256-bit input
    // but Fr requires canonical representation.
    let af = Fr::from_be_bytes_mod_order(a);
    let bf = Fr::from_be_bytes_mod_order(b);
    let cf = Fr::from_be_bytes_mod_order(c);

    let mut hasher = Poseidon::<Fr>::new_circom(3).map_err(|e| format!("{e:?}"))?;
    // light-poseidon hash_bytes_be wants raw BE byte slices.
    let ab = af.into_bigint().to_bytes_be();
    let bb = bf.into_bigint().to_bytes_be();
    let cb = cf.into_bigint().to_bytes_be();
    let pad = |v: Vec<u8>| -> [u8; 32] {
        let mut out = [0u8; 32];
        let start = 32 - v.len();
        out[start..].copy_from_slice(&v);
        out
    };
    let abp = pad(ab);
    let bbp = pad(bb);
    let cbp = pad(cb);
    let out = hasher
        .hash_bytes_be(&[&abp[..], &bbp[..], &cbp[..]])
        .map_err(|e| format!("{e:?}"))?;
    Ok(out)
}

// =============================================================================
// Tests for internals
// =============================================================================

#[cfg(test)]
mod internal_tests {
    use super::*;

    #[test]
    fn poseidon3_is_deterministic() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let r1 = poseidon3(&a, &b, &c).expect("poseidon");
        let r2 = poseidon3(&a, &b, &c).expect("poseidon");
        assert_eq!(r1, r2);
        // Sanity: result is non-zero for non-zero inputs.
        assert_ne!(r1, [0u8; 32]);
    }
}
