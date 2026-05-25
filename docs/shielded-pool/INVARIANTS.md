# Ghola Shielded Pool — Formal Safety Invariants

> **Status**: Production-hardening pass, Wave 2 (Stream 1).
> **Audience**: External auditors, indexer operators, relayer operators,
> the `crates/said-shielded-pool-invariants` test corpus.

These invariants are **machine-checkable predicates**. Each cites the
program code that ENFORCES it on-chain and the off-chain checker that
VERIFIES it post-hoc. Both must agree: any divergence is a bug.

The corresponding Rust predicates live in
`crates/said-shielded-pool-invariants/src/checks.rs`; per-family tests
live under `crates/said-shielded-pool-invariants/tests/`. See the
crate-level docstring (`src/lib.rs`) for the rationale of an off-chain
mirror.

## How to read this document

For each invariant we give:

| Field | Meaning |
|-------|---------|
| **Statement** | Formal English. |
| **Predicate** | Mathematical / pseudocode form. |
| **Enforcement** | On-chain code that establishes the invariant. |
| **Checker** | Off-chain predicate function. |
| **Test** | Test file + function. |
| **Residual risk** | What can still go wrong if the invariant holds but a related assumption is violated. |

The eight families track the eight major safety domains of the pool.
SPEC.md §s referenced are in `docs/shielded-pool/SPEC.md`.

---

## Family 1 — Notes (Value Conservation)

The Groth16 circuit `circuits/transaction.circom` constrains a single
per-asset accounting equation across every transfer / deposit /
withdraw. The on-chain program submits the proof to `groth16-solana`,
which rejects any witness that violates the equation.

### INV-NOTES-1.1 — Per-asset value conservation

* **Statement**: For every successful `transfer`, `deposit`, or
  `withdraw` instruction, the sum of input note amounts plus the public
  amount equals the sum of output note amounts; all input and output
  notes share a single `asset_id`.
* **Predicate**:
  ```
  ∀ tx: Σ_i input_amounts[i] + public_amount == Σ_j output_amounts[j]
        ∧ ∀ i,j: input_notes[i].asset_id == output_notes[j].asset_id
  ```
  Sign convention (arithmetic frame, see SPEC §4.1 item 7):
  `public_amount > 0` = shield-in (deposit), `< 0` = unshield-out
  (withdraw), `== 0` = internal transfer.
* **Enforcement**: `circuits/transaction.circom`, item 7 of SPEC §4.1.
  On-chain: `programs/said-shielded-pool/src/instructions/transfer.rs`,
  `instructions/deposit.rs`, `instructions/withdraw.rs` — each calls
  the verifier with the public-input vector, which carries the
  `public_amount` field element.
* **Checker**: `inv_note_conservation` in `checks.rs`.
* **Test**: `tests/notes.rs::transfer_value_conservation_ok` and
  siblings.
* **Residual risk**: A buggy off-chain witness builder could mint a
  `TransferWitness` with mismatched amounts AND a corresponding
  `public_amount` that closes the equation — the circuit accepts it.
  Mitigation: the on-chain ix re-checks the SPL token CPI amount
  against the public-input `public_amount` value (see
  `withdraw.rs`/`deposit.rs`). Off-chain reconciliation by the indexer
  catches divergence between the SPL CPI value and the public input.

### INV-NOTES-1.2 — Amount range bound

* **Statement**: every `input_amounts[i]` and `output_amounts[j]` lies
  in `[0, 2^64)`.
* **Predicate**: `∀ a ∈ inputs ∪ outputs: 0 ≤ a < 2^64`.
* **Enforcement**: `Num2Bits(64)` gates in
  `circuits/transaction.circom` (SPEC §4.1 item 6).
* **Checker**: Implicit — `inv_note_conservation` operates on `u64`
  fields so out-of-range values cannot be passed in.
* **Test**: `tests/notes.rs::overflow_rejected`.
* **Residual risk**: A future circuit edit that drops the `Num2Bits`
  gate would let amounts wrap modulo p, breaking the equation. Audit
  rule: the circuit hash committed to `pool_config.verifier_key_hash`
  pins the circuit version.

---

## Family 2 — Nullifiers (Uniqueness + Binding)

Nullifiers prevent double-spends. The on-chain program treats the mere
EXISTENCE of a `NullifierAccount` PDA as proof of spent status, so the
critical invariants are uniqueness (no double-init) and derivation
binding (no malleability).

### INV-NULL-2.1 — Nullifier uniqueness

* **Statement**: A nullifier can be inserted into the spent set at
  most once.
* **Predicate**: `∀ n ∈ candidate_nullifiers: n ∉ spent_set` at the
  moment of insertion.
* **Enforcement**: `programs/said-shielded-pool/src/instructions/transfer.rs`
  and `instructions/withdraw.rs` mark `NullifierAccount` PDAs as
  `#[account(init, payer=..., space=..., seeds=[b"nullifier", mint, &n])]`.
  The Anchor `init` constraint fails the tx if the PDA already exists.
* **Checker**: `inv_nullifier_uniqueness`.
* **Test**: `tests/nullifiers.rs::double_spend_caught`.
* **Residual risk**: A program upgrade that switched to
  `init_if_needed` would silently allow double-spends. The supply
  chain process in `docs/shielded-pool/OPERATIONS.md` § 3 requires diff
  review of every program upgrade.

### INV-NULL-2.2 — Nullifier PDA existence

* **Statement**: An entry in the off-chain spent set must correspond
  to a real on-chain PDA, and vice versa.
* **Predicate**: `n ∈ snapshot.nullifier_set ⟺ ∃ PDA "nullifier‖mint‖n"`.
* **Enforcement**: same `init` constraints as above — the PDA is
  written atomically with the spent-set update.
* **Checker**: `inv_nullifier_pda_existence`.
* **Test**: `tests/nullifiers.rs::pda_existence_present` and
  `pda_existence_missing_flagged`.
* **Residual risk**: Indexer lag between block finalization and local
  cache. The indexer must use `commitment=finalized` for nullifier
  reads.

### INV-NULL-2.3 — Nullifier derivation binding

* **Statement**: `nullifier = Poseidon3(spending_key, commitment,
  leaf_index)`. Identical triples must yield identical outputs across
  all hosts.
* **Predicate**: `n == Poseidon3(sk, cm, idx)`.
* **Enforcement**: enforced inside `transaction.circom` — the circuit
  constrains the nullifier output. The on-chain program does not
  re-derive (it has no `sk`); it relies on the proof.
* **Checker**: `inv_nullifier_derivation` (uses `light-poseidon` with
  the same `Poseidon::<Fr>::new_circom(3)` parameters as the circuit).
* **Test**: `tests/nullifiers.rs::derivation_is_deterministic_and_self_consistent`
  and `derivation_mismatch_caught`.
* **Residual risk**: `light-poseidon` and the `circomlib` Poseidon
  parameters must agree forever. A bump of either dependency that
  silently changes round constants would break this. Cargo workspace
  pins `light-poseidon = "0.2"`; the circuits dir snapshots circomlib.

### INV-NULL-2.4 — Cross-asset isolation

* **Statement**: Nullifiers belonging to different mints cannot
  collide on-chain even if their field-element bytes are equal.
* **Predicate**: PDA address = `find_program_address([b"nullifier",
  mint, &n], program_id)`; the mint seed disambiguates.
* **Enforcement**: PDA seed derivation in `state.rs::NullifierAccount`
  documentation and the matching `seeds` constraint in transfer /
  withdraw.
* **Checker**: `inv_nullifier_uniqueness` is per-snapshot (per-mint);
  the test models the cross-asset case explicitly.
* **Test**: `tests/nullifiers.rs::cross_asset_isolation_modeled_via_pda_seeds`.
* **Residual risk**: Future addition of fungibility-swap features
  would need a new seed scheme (e.g. an asset-group ID).

---

## Family 3 — Roots (Windowed + Monotone)

The Merkle root rolls forward as commitments are folded into the tree
by the forester. Spends reference a root inside a rolling window so the
on-chain state can accept "slightly stale" proofs and clients don't
have to re-prove on every new block.

### INV-ROOT-3.1 — Root in history window

* **Statement**: A submitted proof's claimed root equals the current
  on-chain root or appears in `tree.root_history`.
* **Predicate**: `proof.root == tree.root ∨ proof.root ∈ tree.root_history`.
* **Enforcement**: `MerkleTree::root_in_history` in
  `programs/said-shielded-pool/src/state.rs`, called by
  `instructions::transfer::transfer_handler`.
* **Checker**: `inv_root_in_history_window`.
* **Test**: `tests/roots.rs::current_root_accepted`,
  `historical_root_in_window_accepted`,
  `out_of_window_root_rejected`.
* **Residual risk**: `ROOT_HISTORY_SIZE = 64` on-chain (down from the
  256 in the types crate, due to BPF stack constraints; documented in
  `state.rs`). Bursty forester windows could occasionally evict a
  root before a slow prover catches up.

### INV-ROOT-3.2 — Monotone forester advancement

* **Statement**: `tree.next_index` only advances inside
  `update_root_via_proof`, and only by exactly `FORESTER_BATCH_SIZE`
  per call.
* **Predicate**: `Δnext_index ∈ {0, FORESTER_BATCH_SIZE}` after a
  successful tx; `Δ > 0` ⟹ ix was `update_root_via_proof` signed by
  an authorized forester.
* **Enforcement**:
  `programs/said-shielded-pool/src/instructions/update_root.rs` is the
  only place `tree.next_index` is mutated; signer set is checked via
  `pool_config.is_authorized_forester(&signer)` (with bootstrap
  fallback to `admin` if `forester_set` is empty).
* **Checker**: `inv_next_index_only_advanced_by_forester`.
* **Test**: `tests/roots.rs::forester_advances_by_exact_batch_size`,
  `non_forester_advancement_rejected`, `wrong_batch_size_rejected`,
  `backward_movement_rejected`.
* **Residual risk**: If `forester_set` is left empty in production
  (bootstrap fallback to admin), the admin key becomes a forester
  authority too. Operational guidance in
  `docs/shielded-pool/GOVERNANCE.md` requires populating `forester_set`
  immediately after `init_pool`.

---

## Family 4 — Custody (Escrow Accounting)

The escrow PDA holds the SPL liquidity backing every outstanding note.
Custody invariants close the loop between off-chain note arithmetic
and on-chain SPL balances.

### INV-CUST-4.1 — Escrow balance closes against event history

* **Statement**: Replaying every deposit/withdraw against an initial
  zero balance reproduces the live escrow ATA balance.
* **Predicate**:
  ```
  escrow_balance ==  Σ Deposit.amount
                    − Σ (Withdraw.recipient_amount + Withdraw.relayer_amount)
  ```
* **Enforcement**: every deposit/withdraw issues SPL CPIs against
  the escrow ATA; the program never bypasses the standard token
  transfer paths.
* **Checker**: `inv_escrow_balance`.
* **Test**: `tests/custody.rs` (eight assertions).
* **Residual risk**: An out-of-band transfer to the escrow ATA (e.g.
  someone sends tokens directly) would inflate the balance. The
  invariant is one-sided: `escrow_balance ≥ Σ deposits − Σ withdraws`
  is the safe variant. Auditor flow: also check that no non-program
  signer can authorize debits from the escrow ATA (it is owned by
  the program PDA).

### INV-CUST-4.2 — Escrow non-negativity

* **Statement**: Cumulative withdrawals cannot exceed cumulative
  deposits at any point in the replay.
* **Predicate**: `∀ prefix of history: Σ deposits ≥ Σ withdraw_outflows`.
* **Enforcement**: SPL itself rejects negative-balance transfers; the
  program does not maintain a balance field, it relies on the SPL ATA.
* **Checker**: `inv_escrow_balance` returns
  `InvariantViolation::Custody` if the running balance ever goes
  negative.
* **Test**: `tests/custody.rs::overdraw_caught`.
* **Residual risk**: None at the SPL layer — the SPL token program
  enforces this. If a future custom token implementation is added,
  this property must be re-verified.

---

## Family 5 — Proofs (VK hash + Public Input Layout)

The verifying key is the trust anchor of the entire proof system; if
an attacker can swap it, they can forge any spend. The vk-hash
commitment and the canonical public-input layout together pin the
proof system.

### INV-PROOF-5.1 — VK hash commitment

* **Statement**: `pool_config.verifier_key_hash == sha256(verifier_key.bytes[..len])`.
* **Predicate**: `sha256(vk_bytes) == pool_config.verifier_key_hash`.
* **Enforcement**:
  `programs/said-shielded-pool/src/instructions/init_pool.rs` computes
  the hash on init;
  `programs/said-shielded-pool/src/instructions/governance.rs::accept_vk_rotation_handler`
  recomputes it after the timelocked rotation.
* **Checker**: `inv_vk_hash_commitment`.
* **Test**: `tests/proofs.rs::vk_hash_matches`,
  `vk_hash_mismatch_caught`, `changing_one_byte_breaks_vk_match`,
  `empty_vk_bytes_hash_consistent`.
* **Residual risk**: A direct write to the `VerifierKey` PDA by an
  attacker who compromised the upgrade authority would not be caught
  by this invariant alone — the rotation flow exists precisely to
  prevent that path; `pool_config.vk_change_eta + timelock_secs` is
  the temporal defense.

### INV-PROOF-5.2 — Canonical public-input layout

* **Statement**: Public inputs are an 8-element vector in the order
  `[root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount,
  asset_id, ext_data_hash]`.
* **Predicate**: `len(public_inputs) == 8`, with positional binding
  documented in `state.rs::NUM_PUBLIC_INPUTS`.
* **Enforcement**: `NUM_PUBLIC_INPUTS = 8` in `state.rs`; the
  `groth16-solana` verifier rejects any length mismatch.
* **Checker**: `inv_public_input_layout`.
* **Test**: `tests/proofs.rs::public_inputs_correct_length`,
  `public_inputs_short_rejected`, `public_inputs_long_rejected`,
  `empty_public_inputs_rejected`.
* **Residual risk**: Position-binding is implicit (a swap of two
  inputs would still pass the length check). The verifier is built
  against the exact vk that committed to the field order; vk-rotation
  is the only legitimate way to change the layout.

---

## Family 6 — Relayers (Dedup + k-Anonymity)

The relayer is a privacy multiplier: bundling user submissions into
size-k batches with bounded delay yields k-anonymity against
on-chain timing attacks. The off-chain queue must dedupe to avoid
broadcasting the same proof twice (which would surface a self-double-
spend attempt).

### INV-RELAY-6.1 — Queue dedupe

* **Statement**: No two queued proofs share a canonical hash.
* **Predicate**: `∀ q1, q2 ∈ queue: q1 ≠ q2 ⟹ hash(q1) ≠ hash(q2)`.
* **Enforcement**: Stream 3 (parallel)
  `crates/said-shielded-pool-relayer/src/dedup.rs` — planned hash:
  `blake3(proof.a || proof.b || proof.c)` over the 256-byte
  uncompressed BN254 affine encoding.
* **Checker**: `inv_relay_dedupe`.
* **Test**: `tests/relayers.rs::duplicate_in_queue_caught`,
  `unique_proof_passes`.
* **TODO(stream-3)**: when Stream 3 ships `dedup.rs`, import its
  canonical hash function here and assert byte-for-byte agreement.
  Until then this invariant operates on whatever `proof_hash` the
  relayer has already canonicalized into `RelayQueueEntry`.
* **Residual risk**: Hash collisions are 2^-128 with blake3 — non-
  issue. Implementation drift between the relayer's hash and the
  invariant checker IS a risk; the TODO above tracks closure.

### INV-RELAY-6.2 — k-anonymity release predicate

* **Statement**: A batch is released to chain iff it has reached
  size `k` OR its oldest item has waited at least `max_delay_secs`
  (liveness escape hatch). Items must wait at least `min_delay_secs`
  before they are eligible at all.
* **Predicate**:
  ```
  release(batch) ⟺   batch.size ≥ k
                  ∧  batch.oldest_age_secs ≥ min_delay_secs
                  ∧  (batch.size ≥ k ∨ batch.oldest_age_secs ≥ max_delay_secs)
  ```
* **Enforcement**: Stream 3 release scheduler (TBD); see SPEC §
  "Relayer privacy" for the design rationale.
* **Checker**: `inv_k_anonymity_release`.
* **Test**: `tests/relayers.rs::k_release_size_threshold`,
  `k_release_timeout_path`,
  `k_release_too_small_too_young_rejected`,
  `k_release_below_min_delay_rejected`,
  `k_release_empty_batch_rejected`,
  `k_release_misconfigured_delays_caught`.
* **Residual risk**: A degraded k (e.g. via long timeouts) reduces
  anonymity quality. Operators should monitor batch sizes; alerts
  if the moving average drops below 0.75·k.

---

## Family 7 — Metering (Queue Depth)

`tree.queue_tail` and `tree.next_index` together implement a producer/
consumer queue: deposits/transfers produce (advance `queue_tail`), the
forester consumes (advances `next_index` after folding into the tree).

### INV-METER-7.1 — Queue tail dominates next index

* **Statement**: `tree.queue_tail ≥ tree.next_index` at all times.
* **Predicate**: `queue_tail ≥ next_index`.
* **Enforcement**: only deposit/transfer mutate `queue_tail` (always
  monotone up); only `update_root_via_proof` mutates `next_index`
  with the bound check `start_index + FORESTER_BATCH_SIZE ≤ queue_tail`.
* **Checker**: `inv_queue_tail_geq_next_index`.
* **Test**: `tests/metering.rs::queue_tail_equals_next_index_ok`,
  `queue_tail_greater_ok`, `queue_tail_less_caught`.
* **Residual risk**: If a future ix were added that mutated either
  pointer without enforcing the bound, this could be violated. Code
  review must flag any new mutation of `tree.next_index` or
  `tree.queue_tail`.

### INV-METER-7.2 — Forester proof bounds

* **Statement**: A forester proof's `start_index` equals
  `tree.next_index` and covers exactly `FORESTER_BATCH_SIZE`
  commitments that are already queued.
* **Predicate**:
  `start_index == next_index ∧ start_index + FORESTER_BATCH_SIZE ≤ queue_tail`.
* **Enforcement**:
  `programs/said-shielded-pool/src/instructions/update_root.rs::update_root_handler`.
* **Checker**: `inv_forester_proof_bounds`, plus
  `inv_pending_forester_well_formed` for the size check.
* **Test**: `tests/metering.rs::forester_bounds_aligned_ok`,
  `forester_start_misaligned_rejected`,
  `forester_batch_overshoots_queue_tail_rejected`,
  `pending_forester_well_formed_ok`,
  `pending_forester_wrong_batch_size_rejected`.
* **Residual risk**: A forester that proves over commitments not yet
  in the on-chain queue would have its proof rejected by the
  verifier (different leaves would yield a different new_root).
  Belt-and-suspenders.

---

## Family 8 — Revenue (Fee Accumulator + Drain Authority)

The protocol levies a fee on every withdraw, retained in a separate
revenue PDA. The admin can sweep the vault. Revenue invariants close
the loop between per-tx fee splits and the vault's running balance.

### INV-REV-8.1 — Revenue accumulator closes

* **Statement**: `revenue_vault_balance == Σ withdraw.amount ·
  withdraw.fee_bps / 10000 − Σ admin_drain.amount`.
* **Predicate**: identical to the statement; integer-division round-
  down is the canonical form (matches the program's `checked_mul/
  checked_div`).
* **Enforcement**:
  `programs/said-shielded-pool/src/instructions/withdraw.rs` splits
  fee at CPI time; `instructions/admin.rs::admin_sweep_fees_handler`
  drains.
* **Checker**: `inv_revenue_accumulator`.
* **Test**: `tests/revenue.rs::fee_accumulator_correct`,
  `fee_with_partial_drain`, `missing_fee_caught`, `excess_drain_caught`,
  `empty_history_zero_revenue_ok`.
* **Residual risk**: Admin changing `pool_config.fee_bps` between
  withdraws shifts the per-event fee. The invariant records the
  in-effect bps with each event (so historical replay stays
  consistent). If the indexer drops the bps field, replay diverges.

### INV-REV-8.2 — Drain authority

* **Statement**: Every drain of the revenue vault is signed by the
  current `pool_config.admin`.
* **Predicate**: `∀ drain ∈ history: drain.signer == pool_config.admin`.
* **Enforcement**: `instructions/admin.rs::admin_sweep_fees`'s
  `#[account(constraint = signer.key() == pool_config.admin)]`.
* **Checker**: `inv_revenue_drain_only_by_admin`.
* **Test**: `tests/revenue.rs::drain_by_admin_ok`,
  `drain_by_non_admin_caught`, `partial_unauthorized_drain_caught`.
* **Residual risk**: Admin-key compromise drains the vault. Mitigation
  outside the program: multi-sig admin key + monitoring on
  `pool_config.admin` rotation (see `GOVERNANCE.md`).

---

## Coverage Matrix

Each on-chain instruction is annotated with the invariants it
preserves. "P" = preserves directly; "I" = invariant whose precondition
the instruction may depend on but does not enforce.

| Instruction                       | NOTES 1.1 | NULL 2.1 | NULL 2.3 | ROOT 3.1 | ROOT 3.2 | CUST 4.1 | PROOF 5.1 | PROOF 5.2 | METER 7.1 | METER 7.2 | REV 8.1 | REV 8.2 |
|-----------------------------------|-----------|----------|----------|----------|----------|----------|-----------|-----------|-----------|-----------|---------|---------|
| `init_pool`                       |           |          |          |          |          |          | P         | P         |           |           |         |         |
| `init_tree`                       |           |          |          | P        |          |          |           |           | P         |           |         |         |
| `deposit`                         | P         |          |          | I        |          | P        |           | P         | P         |           |         |         |
| `transfer`                        | P         | P        | P        | P        |          |          | I         | P         | P         |           |         |         |
| `withdraw`                        | P         | P        | P        | P        |          | P        | I         | P         | P         |           | P       |         |
| `decoy_withdraw`                  | P         |          |          | P        |          |          | I         | P         |           |           |         |         |
| `update_root_via_proof`           |           |          |          | P        | P        |          | I         |           | P         | P         |         |         |
| `admin_sweep_fees`                |           |          |          |          |          |          |           |           |           |           | P       | P       |
| `set_paused`                      |           |          |          |          |          |          |           |           |           |           |         |         |
| `set_fee_bps`                     |           |          |          |          |          |          |           |           |           |           |         |         |
| `propose_admin_change`            |           |          |          |          |          |          |           |           |           |           |         |         |
| `accept_admin_change`             |           |          |          |          |          |          |           |           |           |           |         |         |
| `propose_vk_rotation`             |           |          |          |          |          |          |           |           |           |           |         |         |
| `accept_vk_rotation`              |           |          |          |          |          |          | P         |           |           |           |         |         |
| `cancel_proposal`                 |           |          |          |          |          |          |           |           |           |           |         |         |
| `set_forester_set`                |           |          |          |          | I        |          |           |           |           |           |         |         |
| `set_pause_authority`             |           |          |          |          |          |          |           |           |           |           |         |         |
| `migrate_config`                  |           |          |          |          |          |          |           |           |           |           |         |         |
| `attest_evidence`                 |           |          |          |          |          |          |           |           |           |           |         |         |

(Empty rows are administrative ixs whose safety properties live in
`GOVERNANCE.md` rather than the cryptographic invariant set above.)

---

## Cross-References

* **Threat model**: `docs/shielded-pool/SPEC.md` § 7 covers adversary
  models; this doc covers the structural defenses.
* **Governance**: `docs/shielded-pool/GOVERNANCE.md` covers the
  admin / forester / pause-authority key model that gates several
  enforcement sites cited above.
* **Key rotation**: `docs/shielded-pool/OPERATIONS.md` § 1 for the
  timelocked rotation flows that preserve INV-PROOF-5.1 across
  upgrades.
* **Upgrade runbook**: `docs/shielded-pool/GOVERNANCE.md` § 11 for the
  V1→V2 migration and the BPF-stack reasoning behind
  `ROOT_HISTORY_SIZE = 64`.
* **Supply chain**: `docs/shielded-pool/OPERATIONS.md` § 3 covers the
  build-reproducibility and dependency-pinning controls that protect
  INV-NULL-2.3 (Poseidon stability) and INV-PROOF-5.1 (vk integrity).

---

## Auditor checklist

Recommended invocation:

```bash
cargo test -p said-shielded-pool-invariants
```

For end-to-end audit replay, the indexer can dump a JSON snapshot via
`said-shielded-pool-indexer::state::Snapshot` (planned). Until that
ships, snapshots can be hand-rolled for unit testing — see
`Snapshot::empty()` and `Snapshot::from_program_state()` constructors.
