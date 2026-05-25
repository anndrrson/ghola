# THREAT_SCENARIOS.md — Malicious-Actor Runbook

> Companion to the test suite at `crates/malicious-tests/`. Each
> attacker profile in this document maps 1:1 to an integration-test
> file under `crates/malicious-tests/tests/`. Read this before
> editing the suite, the relayer, or the on-chain program: the
> design intent for every defense lives here.

## Scope

This document enumerates **off-chain** and **on-chain** adversaries
against the Ghola Solana shielded pool, what they can do, and what
stops them. It is *not* a complete cryptographic analysis (see
`SPEC.md` for the Groth16 / Poseidon argument) and it is *not* a
deployment checklist (see `GOVERNANCE.md` § 11 Runbooks). It is the missing
middle layer: who can attack the live system, by what mechanism, and
what the test suite asserts about each mitigation.

## Conventions

- **Actor capabilities** — what the attacker controls. Always
  presented as "this party is hostile, the others are honest" (we do
  not analyse collusion exhaustively).
- **Attack steps** — the sequence of observable actions.
- **Defense** — file:line references into the codebase + the higher-
  level invariant being preserved.
- **Residual risk** — what the defense does NOT cover (always
  non-empty; the document is honest about gaps).
- **Test coverage** — pointer into `crates/malicious-tests/tests/`.
- **Detect-and-respond** — what an operator should do if the attack
  fires in production.

---

## §A — Malicious Relayer

### A.1 Capabilities

The relayer's fee-paying keypair belongs to a hostile operator. The
relayer can drop, reorder, delay, or correlate the txs it brokers.
It **cannot** steal user funds: the on-chain `withdraw` ix binds the
recipient via `ext_data_hash` inside the Groth16 proof, and the
on-chain `pool_config` checks that the proof's public inputs match.
The relayer also cannot spend nullifiers it does not have a proof
for. The harm is **liveness** and **privacy**, never **safety**.

### A.2 Sub-scenarios

#### A.2.1 Drop-specific-recipient

- **Attack** — `submit_one` matches on `w.recipient` and silently
  returns an opaque error for blacklisted recipients.
- **Defense** — `submit::submit_with_retry` exhausts
  `Config::max_retries` and marks the row `Failed`
  (`crates/said-shielded-pool-relayer/src/submit.rs:452-486`). The
  client polls `/status/:id`, sees `Failed`, and is expected to fall
  back to a different relayer or direct submission.
- **Residual risk** — between `Pending` and the eventual `Failed`,
  the client's UX is degraded (long latency). A network of N
  independent relayers reduces the probability of being routed to a
  hostile one to `1/N` per submission, but does not eliminate it.
- **Test** — `tests/malicious_relayer.rs::drop_specific_recipient`.
- **Detect-and-respond** — operator's monitoring should alert when
  the per-relayer `Failed` rate exceeds the fleet baseline. Rotate
  the suspect relayer out of DNS / load-balancer pool, then drain
  its queue by hand (`/admin/drain`).

#### A.2.2 Reorder-batches

- **Attack** — relayer releases batches in strict FIFO so an
  external observer learns the insertion order.
- **Defense** — `submit::submit_batch` shuffles the batch via
  `rand::seq::SliceRandom::shuffle`
  (`crates/said-shielded-pool-relayer/src/submit.rs:418-450`).
- **Residual risk** — across N batches the long-tail distribution
  is not perfectly uniform; an observer who watches many batches
  can still correlate when k-anonymity is small.
- **Test** —
  `tests/malicious_relayer.rs::reorder_batches_decorrelates_from_insertion_order`.

#### A.2.3 Delay-indefinitely

- **Attack** — relayer holds tx forever (no submit).
- **Defense** — the client's `/status/:id` returns `Pending` or
  `Submitted`; the QueuedWithdrawal struct intentionally has no
  signature field, so the relayer cannot accidentally leak one
  even if the operator changes the log level
  (`crates/said-shielded-pool-relayer/src/queue.rs:78`).
- **Residual risk** — no on-chain liveness for that specific
  request; user must re-submit elsewhere.
- **Test** —
  `tests/malicious_relayer.rs::delay_indefinitely_does_not_leak_signature`.

#### A.2.4 Censor-via-metrics (timing inference)

- **Attack** — relayer's operator infers per-request identity from
  queue order + submission timing.
- **Defense** — k-anonymity (`Config::anonymity_threshold`,
  default 8) + Poisson jitter inside a batch
  (`submit::poisson_delay`).
- **Residual risk** — k-anonymity only beats the timing channel for
  the FIRST tx in a batch; long-running correlation across many
  batches still leaks (Phase 42 onion-routing reduces this).
- **Test** —
  `tests/malicious_relayer.rs::censor_via_timing_inference_is_broken_by_shuffle`.

### A.3 Detect-and-respond

- Per-relayer `Failed` rate > 10% baseline for 1h → page on-call.
- Per-relayer median `submitted_at - accepted_at` > 2× fleet
  median for 30m → page on-call.
- Disagreement on `pool_config.forester_set` between two indexers
  → escalate to "compromised admin?" runbook (§F).

---

## §B — Malicious Forester

### B.1 Capabilities

A signer in `pool_config.forester_set` is hostile (or an attacker
who momentarily holds the key). Can call
`update_root_via_proof(start_index, new_root, proof)`.

### B.2 Sub-scenarios

#### B.2.1 Stale-root replay

- **Attack** — replay an old `(start_index, new_root, proof)`
  triple that was valid N batches ago.
- **Defense** — `update_root_handler` requires
  `start_index == tree.next_index`
  (`programs/said-shielded-pool/src/instructions/update_root.rs`).
  An old start_index has been advanced past by an honest forester,
  so the replay produces `InvalidTreeConfig`.
- **Residual risk** — none (defense is total).
- **Test** —
  `tests/malicious_forester.rs::stale_root_replay_rejected_onchain`
  (`#[ignore]` until devnet redeploy).

#### B.2.2 Invalid-proof bytes

- **Attack** — call with garbage groth16 proof.
- **Defense** — `groth16::verify` returns `InvalidProof`
  (`programs/said-shielded-pool/src/groth16.rs`).
- **Test** —
  `tests/malicious_forester.rs::invalid_proof_bytes_rejected_onchain`
  (`#[ignore]`).

#### B.2.3 Censor-specific-commitments

- **Attack** — forester batches commits 0..3 then 5..8 (skipping
  4). The owner of commit 4's note cannot withdraw it because the
  Merkle inclusion proof for commit 4 never lands.
- **Defense** — `pool_config.forester_set` supports a *plurality*
  of foresters; clients can rotate. The on-chain program has no
  bias toward any specific forester within the set.
- **Residual risk** — a single hostile forester in an otherwise
  empty set DOES cause liveness loss; production deployments must
  bootstrap with ≥3 independent foresters.
- **Test** — `tests/malicious_forester.rs::forester_set_supports_plurality`
  (offline spec check).

#### B.2.4 Out-of-order batch

- **Attack** — submit batch with `start_index != tree.next_index`.
- **Defense** — same as B.2.1: `InvalidTreeConfig`.
- **Test** —
  `tests/malicious_forester.rs::out_of_order_batch_rejected_onchain`
  (`#[ignore]`).

#### B.2.5 Forester-not-in-set

- **Attack** — an attacker keypair NOT in `pool_config.forester_set`
  calls `update_root_via_proof`.
- **Defense** — `ForesterNotAuthorized` error
  (Stream 4 added this; check
  `programs/said-shielded-pool/src/error.rs`).
- **Test** —
  `tests/malicious_forester.rs::unauthorized_forester_rejected_onchain`
  (`#[ignore]`).

#### B.2.6 Advance-next-index-past-queue-tail (off-chain invariant)

- **Attack** — corrupt the indexer's local model so it submits a
  batch advancing `next_index` past `queue_tail` (would require a
  commit no relayer ever queued).
- **Defense** — `inv_queue_tail_geq_next_index` from Stream 1's
  invariants crate
  (`crates/said-shielded-pool-invariants/src/checks.rs:383`).
- **Test** —
  `tests/malicious_forester.rs::forester_cannot_advance_past_queue_tail`
  (gated behind `--features invariants`).

### B.3 Detect-and-respond

- On-chain `update_root_via_proof` failures > 5/min → page.
- Indexer's local forester crashing repeatedly → suspect compromise
  → rotate forester keypair (see OPERATIONS.md § 1.4).
- Decoy-pool refresh on root rotation (see decoy.rs `DecoyPool::prune_stale`).

---

## §C — Malicious TEE Worker

### C.1 Capabilities

A worker process running inside the TEE — or impersonating one
before Phase 42 TEE attestation is enforced — tries to exfiltrate
queue order, timing, or decrypted payloads.

### C.2 Sub-scenarios

#### C.2.1 Timing side-channel

- **Attack** — leak per-tx submission timestamps to an external
  collector.
- **Defense** — k-anonymity + Poisson jitter (same as §A.2.4).
- **Residual risk** — see §A.2.4.
- **Test** —
  `tests/malicious_worker.rs::timing_side_channel_defeated_by_k_anonymity`.

#### C.2.2 Decryption oracle

- **Attack** — worker decrypts payloads via the TEE's sealing key
  and lies about queue position.
- **Defense** — out of scope without TEE attestation. Phase 42
  introduces remote-attested workers; until then this attack is
  fully feasible against a hostile co-tenant.
- **Test** — `tests/malicious_worker.rs::decryption_oracle_out_of_scope`
  (`#[ignore]`; sentinel only).

### C.3 Detect-and-respond

- TEE attestation document mismatch between successive heartbeats →
  evict worker, drain queue, escalate.

---

## §D — Malicious Prover

### D.1 Capabilities

A compromised prover subprocess (own-binary or supply-chain attack)
tries to leak witness data (spending keys, nullifier preimages,
amounts).

### D.2 Sub-scenarios

#### D.2.1 Leak-to-logs

- **Attack** — `tracing::info!("witness: {sk}")` inside the prover.
- **Defense** — Stream 7's `common-log` redaction layer rewrites
  any deny-listed field name to `<redacted>` at INFO and above;
  scrubs to `<6hex>…` at DEBUG. Call-sites use `scrub_hex` /
  `scrub_pubkey` helpers.
- **Residual risk** — an attacker who controls the call-site field
  names (writes a NEW unredacted field) bypasses the deny-list;
  the redaction layer is defense-in-depth, not a substitute for
  code review.
- **Test** —
  `tests/malicious_prover.rs::leak_to_logs_is_blocked_by_call_site_scrubbing`.

#### D.2.2 Leak-to-disk

- **Attack** — prover writes witness.json to its temp dir and
  leaves it there after success.
- **Defense** — Stream 5's `TempArtifacts` RAII guard wraps
  `tempfile::TempDir`; on drop the directory and all its contents
  are removed.
- **Residual risk** — if the prover SIGKILLs before the drop runs,
  files leak. Mitigation: the process supervisor's tmpfs is
  ephemeral; on host restart the dir is gone regardless.
- **Test** —
  `tests/malicious_prover.rs::leak_to_disk_is_blocked_by_temp_artifacts_drop`.

#### D.2.3 Detect-and-rotate runbook

- **Detect** — anomaly in prover CPU pattern (excessive disk
  writes), or output of the dispatcher's CI scan for raw hex in
  log shipping.
- **Respond**:
  1. Quarantine the prover host; route prove calls to the
     standby.
  2. Rotate the spending-key derivation seed via the procedure in
     `OPERATIONS.md` § 1.9.
  3. Reissue notes for affected users; they re-prove with the new
     seed.

---

## §E — Malicious App

### E.1 Capabilities

A hostile client (browser extension, mobile app, MCP tool) builds
malformed requests to `POST /relay`. Cannot forge proofs (Groth16
sound) but can spam garbage or stale-root proofs.

### E.2 Sub-scenarios

#### E.2.1 Garbage-proof flood

- **Attack** — POST 100 garbage proofs to `/relay`.
- **Defense** — `routes::validate_proof_shape` rejects shape-broken
  payloads BEFORE the queue insert
  (`crates/said-shielded-pool-relayer/src/routes.rs:236`).
- **Residual risk** — the HTTP parse itself consumes CPU; a high-
  RPS attacker can DoS the relayer's parse layer. Stream 6's
  `max_queue_depth` is the secondary cap.
- **Test** —
  `tests/malicious_app.rs::garbage_proof_flood_is_rejected_before_queue`.

#### E.2.2 Valid-proof-against-stale-root

- **Attack** — real proof bound to a root that's rotated out.
- **Defense** — passes the shape check; the on-chain
  `RootNotInHistory` error fires
  (`programs/said-shielded-pool/src/state.rs::root_in_history`).
  The init-payer pays gas for the failed tx.
- **Residual risk** — the failed-tx slot is itself a side-channel.
  Mitigation: client should query `/root` (Stream 6's indexer
  endpoint) just before proving.
- **Test** —
  `tests/malicious_app.rs::stale_root_proof_passes_shape_check_then_gated_onchain`.

---

## §F — Malicious Governance

### F.1 Capabilities

Attacker holds the current `admin` keypair (compromised hardware,
leaked CI secret, social-engineered signer).

### F.2 Sub-scenarios

#### F.2.1 VK-rotation instant push

- **Attack** — `propose_vk_rotation` → `accept_vk_rotation` in the
  same tx batch.
- **Defense** — `accept_vk_rotation` requires
  `now >= proposal.eta`, and `eta = propose_time +
  PROPOSAL_TIMELOCK_SECS` (Stream 4; default 48h). Returns
  `TimelockNotElapsed`.
- **Test** —
  `tests/malicious_governance.rs::vk_rotation_blocked_by_timelock_onchain`
  (`#[ignore]`).

#### F.2.2 Admin-change instant push

- **Attack** — `propose_admin_change(attacker_pk)` → immediate
  accept by the attacker.
- **Defense** — same two-step + timelock as F.2.1, plus the accept
  must be signed by the NEW admin (two-party handshake).
- **Test** —
  `tests/malicious_governance.rs::admin_change_requires_acceptance_window_onchain`
  (`#[ignore]`).

#### F.2.3 Cancel-on-detect

- **Defense** — the legitimate admin (or a noticing-it-early
  observer with the appropriate auth) calls `cancel_proposal`
  before ETA; pending state clears.
- **Test** — `tests/malicious_governance.rs::cancel_proposal_recovers_onchain`
  (`#[ignore]`).

#### F.2.4 Squads multisig as admin

- **Production posture** — `pool_config.admin` SHOULD be a Squads
  PDA in mainnet deployment, not a single keypair. This means even
  a fully compromised individual signer cannot push a proposal
  without M-of-N approval inside Squads.
- **Procedure** — see GOVERNANCE.md §6 for the Squads bootstrap
  flow. No on-chain test in this suite (Squads program lives
  outside this repo); the dispatcher's deploy-time check verifies
  `admin == <Squads PDA>` before any mainnet release.

### F.3 Detect-and-respond

- Page on-call within 1 minute of any `ProposalCreated` event
  emission. The 48h timelock is the window in which a compromised-
  admin alarm must be triaged and cancelled.

---

## §G — Griefing

### G.1 Capabilities

User (or coalition) sends valid requests at a rate or shape that
strains the relayer/program without violating safety.

### G.2 Sub-scenarios

#### G.2.1 Queue flood

- **Attack** — submit MAX_QUEUE_DEPTH + 1 valid requests.
- **Defense** — relayer returns HTTP 429 with `Retry-After` once
  depth ≥ `Config::max_queue_depth`
  (`crates/said-shielded-pool-relayer/src/routes.rs:107`).
- **Residual risk** — legitimate users hit the same 429 during a
  spam wave. Mitigation: per-IP rate limit (Stream 6 TODO).
- **Test** — `tests/malicious_griefing.rs::queue_flood_returns_429`.

#### G.2.2 Dust deposits

- **Attack** — spam 1-token deposits to fill the commit queue.
- **Defense** — each deposit pays a Solana network fee and an SPL
  transfer fee; the cost is real. The forester drains in batches
  regardless of size.
- **Test** —
  `tests/malicious_griefing.rs::dust_deposits_are_accepted_but_costly`.

---

## Threat Matrix

| Actor | Drop tx | Reorder | Delay | Censor | Forge | Steal | Timelock-bypass | Note |
|---|---|---|---|---|---|---|---|---|
| Malicious relayer | yes (mitigated by retry+fallback) | yes (mitigated by shuffle) | yes (mitigated by client timeout) | yes (mitigated by N relayers) | no | no | no | §A |
| Malicious forester | n/a | n/a | n/a | yes (mitigated by plurality) | no | no | no | §B |
| Malicious worker | n/a | n/a | n/a | n/a | no | leak only | no | TEE Phase 42 gap; §C |
| Malicious prover | n/a | n/a | n/a | n/a | no | leak only | no | redaction+TempArtifacts; §D |
| Malicious app | n/a | n/a | n/a | n/a | no (Groth16) | no | no | shape check + on-chain root window; §E |
| Malicious governance | n/a | n/a | n/a | n/a | no | no | mitigated by 48h timelock + Squads | §F |
| Griefing | n/a | n/a | n/a | n/a | no | no | no | costly per-msg; §G |

---

## §H — Replay vectors

> Folded from `REPLAY.md` 2026-05-24; canonical home is this section.

This section enumerates every replay vector that touches the Ghola
Solana shielded pool, the defense layer that closes it, the file:line
where that defense lives, and the residual risk that remains after the
defense triggers. It is the authoritative cross-reference between the
test suite
(`crates/said-shielded-pool-relayer/tests/replay_*.rs`,
`programs/said-shielded-pool/tests/double_spend_devnet.ts`) and the
on-chain program.

### H.1 Threat model

We assume:

- An adversary can observe **every** byte sent to `POST /relay` (TLS
  terminates at the relayer; an intermediary CDN, log-aggregator, or
  compromised relayer operator sees plaintext).
- The adversary can re-send any captured request body verbatim.
- The adversary can also submit *original* on-chain `withdraw`
  transactions with arbitrary `proof_a/b/c` bytes (bounded only by
  fee-payer SOL).
- The adversary cannot forge a valid Groth16 proof against a target
  public-input vector (cryptographic assumption).

Our goal: every replay attempt is rejected by *some* layer, and the
rejection mode does NOT itself leak which user / which spend is being
replayed.

### H.2 Vector taxonomy

#### V1 — Duplicate `/relay` POST

**Vector.** Attacker (or an honest client retrying after timeout)
re-submits an identical `POST /relay` body.

**Defense.** Content-addressed dedup index in the relayer's sled DB.
Key: `blake3(proof.a || proof.b || proof.c)`, computed via
`serde_json::Value::to_string` on each component for deterministic
byte serialization.

- File: `crates/said-shielded-pool-relayer/src/dedup.rs`
- Atomic check-then-insert via `sled::Tree::compare_and_swap`
- Wired into the `/relay` handler BEFORE the queue-depth backpressure
  check so that retries of already-accepted proofs always succeed
  (returning the original `request_id`) regardless of queue pressure:
  `crates/said-shielded-pool-relayer/src/routes.rs`, the `relay()` fn.

**Response.** `200 OK` with `{"id": <existing>, "status": "duplicate"}`.
We return the original id so future `/status/:id` queries work. We do
NOT return 4xx because from the client's perspective the request was
accepted — the retry IS idempotent.

**Residual risk.**
- A relayer crash between dedup insert and queue insert leaves a
  "phantom" dedup entry pointing at a uuid that never made it to the
  queue. The client's retry hits Duplicate, gets the original id back,
  polls `/status/:id`, sees `unknown` (because GC-or-never-existed
  return the same shape), and must re-submit with fresh proof bytes.
  Mitigation: the relayer is the trusted-for-liveness component;
  multi-relayer deployments (Phase 41+ anonymity-network) make this
  recoverable.
- The dedup tree currently has no TTL. A long-running relayer
  accumulates entries indefinitely. Mitigation deferred to a future
  GC sweeper that prunes entries whose corresponding queue row was
  confirmed-and-deleted at least N hours ago.

**Test.** `replay_relay_dedupe.rs::identical_relay_posts_share_a_single_queue_slot`.

#### V2 — Same-nullifier on-chain double-spend

**Vector.** Two distinct `withdraw` transactions whose proofs both
commit to the same `input_nullifiers[0]`. Could be:

- (a) Replay of the exact same proof (same `ext_data_hash`).
- (b) Two genuinely-distinct proofs over the same UTXO, e.g. one against
  root A and one against root B in the history window.

**Defense.** The Anchor `#[account(init, ...)]` constraint on the
`nullifier_pda` for each input nullifier. `init` atomically creates the
PDA; the second `init` against the same seeds fails before any state
change.

- File: `programs/said-shielded-pool/src/lib.rs`, around the `withdraw`
  ix's `WithdrawAccounts` struct (`nullifier_pda_0`, `nullifier_pda_1`).

**Response.** Transaction failure, error category surfaced as
`NullifierAlreadyUsed`. No state change, no SOL drained from the
recipient — only the fee-payer's tx-base lamports are consumed.

**Residual risk.**
- The fee-payer (the relayer) pays for the failed simulation. Stream
  6's queue cap + Stream 3's dedup cap that loss by rejecting most
  replays before they reach the chain.
- The failed-tx itself is observable on-chain. An attacker who
  replays a specific user's withdraw can confirm the nullifier was
  already spent (because the failure mode is distinguishable from
  `InvalidProof`). This is INTENDED: the nullifier is publicly
  spent-or-unspent regardless. The defense is correctness, not
  obscurity.

**Test.** `replay_relayer_batch.rs::second_submit_of_same_nullifier_is_rejected` (model)
and `double_spend_devnet.ts` step (1) (live).

#### V3 — Same proof bytes, different recipient

**Vector.** Attacker captures a successful `withdraw` tx, extracts
`proof_a/b/c`, and constructs a new tx with the SAME proof bytes but a
different recipient pubkey, hoping to redirect funds.

**Defense.** The proof's public-input vector commits to
`ext_data_hash`, which is `H(recipient || fee || relayer_fee || ...)`.
On-chain, the verifier recomputes `ext_data_hash` from the transaction
data and feeds it into the verifier's public-input computation. If the
hash doesn't match what the proof committed to, Groth16 verification
fails.

- File: `programs/said-shielded-pool/src/lib.rs`, the `withdraw` handler
  where `ext_data_hash` is computed and passed to the verifier.
- The relayer-side dedup (V1) also catches this for free because the
  proof bytes are identical; defense in depth.

**Response.** Verifier returns `InvalidProof`. Critically, this is a
DIFFERENT error category from `NullifierAlreadyUsed` (V2). The
distinction matters: an adversary who probes nullifier-spent status
gets V2, while an adversary who probes recipient-substitution gets V3,
and the two probes are not interchangeable.

**Residual risk.**
- Hash collision in `ext_data_hash` (currently `keccak256`-derived):
  cryptographic, effectively zero.
- A bug in the on-chain public-input recomputation that decouples it
  from `ext_data_hash`. Mitigation: Stream 1 invariant
  `inv_ext_data_binding` (formal predicate) and `double_spend_devnet.ts`
  step (2) (live drill).

**Test.** `replay_proof_reuse_diff_recipient.rs` (Rust stub) +
`double_spend_devnet.ts` step (2) (live).

#### V4 — Stale (rotated-out) root

**Vector.** Attacker archives a valid proof for months. The pool
batched-update loop eventually rotates the proof's root out of the
64-deep `root_history` ring. The attacker submits anyway.

**Defense.** Program-level `root_history` membership check before the
verifier is invoked.

- File: `programs/said-shielded-pool/src/lib.rs`, the `withdraw` handler;
  searches `root_history` for the claimed `root` and rejects with
  `RootNotInHistory` if absent.

**Response.** Transaction failure with `RootNotInHistory`.

**Residual risk.**
- An honest client whose proof sits in the relayer queue past 64
  fold-batches becomes "stale" without being malicious. The relayer
  should fail-fast on this and return Failed status; clients re-prove
  against a current root. Currently the failure surfaces only after
  the on-chain submission, costing the fee-payer one tx-base.
- The 64-deep window is a compile-time constant. Increasing it
  trades chain state for longer-lived proofs; decreasing it
  tightens this vector at the cost of more honest stale-proof
  failures.

**Test.** `replay_stale_root.rs` (Rust stub) + `double_spend_devnet.ts`
step (3) (live, currently skipped — needs ≥64 fresh fold batches).

#### V5 — Replayed forester batch

**Vector.** The forester (off-chain merkle-batch builder) submits a
batched-update tx. An attacker captures and replays it.

**Defense.** The on-chain `batched_update` ix checks
`start_index == merkle_tree.next_leaf_index` and atomically advances
`next_leaf_index` on success. A replay finds `next_leaf_index` already
past `start_index` and is rejected.

- File: `programs/said-shielded-pool/src/lib.rs`, the `batched_update`
  handler. Owned by Stream 4.

**Response.** Transaction failure (`InvalidBatchStart` or similar
program-level error).

**Residual risk.** Same as V2 — fee-payer eats a failed tx. The
forester is normally a trusted role with rate-limited submission, so
volumes are low.

**Test.** Out of Stream 3 scope; Stream 4 (programs/src) owns the
unit test for this path.

#### V6 — Old proof, new circuit

**Vector.** After a verifier-key rotation (Phase 42), an attacker
submits a proof generated under the OLD circuit (and OLD `vk_hash`),
hoping the verifier accepts cross-version.

**Defense.** The on-chain verifier loads `verifier_key` from a PDA
whose hash is constrained to the current `vk_hash`. Stream 4 added the
explicit `vk_hash` constraint check.

- File: `programs/said-shielded-pool/src/lib.rs`, the verifier-key
  fetch path. Owned by Stream 4.

**Response.** `InvalidProof` (the old proof won't verify against the
new VK).

**Residual risk.** During a rotation window, both VKs may be valid
(forward-compat). Phase 42's rotation runbook specifies an explicit
cut-over signature; we DO NOT support overlapping VKs in the same
program version.

**Test.** Out of Stream 3 scope; Stream 4 owns.

### H.3 Vector × defense layer × residual risk

| Vector | Defense layer | File | Failure mode | Residual risk |
| ------ | ------------- | ---- | ------------ | ------------- |
| V1 — duplicate `/relay` | sled CAS dedup tree | `relayer/src/dedup.rs` | 200 + `status:"duplicate"` | Phantom dedup row on crash; dedup tree GC pending |
| V2 — same-nullifier on-chain | `init nullifier_pda` | `programs/src/lib.rs::WithdrawAccounts` | `NullifierAlreadyUsed` | Failed-tx fee-payer cost |
| V3 — proof+new recipient | `ext_data_hash` ↔ public inputs | `programs/src/lib.rs::withdraw` | `InvalidProof` | Hash collision (cryptographic) |
| V4 — stale root | `root_history` ring | `programs/src/lib.rs::withdraw` | `RootNotInHistory` | 64-deep window; honest stale proofs |
| V5 — forester batch | `start_index == next_leaf_index` | `programs/src/lib.rs::batched_update` | Program error | Failed-tx cost (low volume) |
| V6 — old proof, new VK | `vk_hash` constraint | `programs/src/lib.rs::verifier_key` | `InvalidProof` | None during single-active-VK windows |

### H.4 Cross-stream notes

- **Stream 1** (`said-shielded-pool-invariants`) holds the formal
  predicate `inv_relay_dedupe`. It is defined against the hash
  `blake3(proof_a || proof_b || proof_c)`. If this scheme ever changes,
  Stream 1's predicate must change in lock-step.
- **Stream 4** (`programs/src`) owns V2, V5, V6. This section
  references those layers for completeness but doesn't modify them.
- **Stream 6** (`routes.rs` queue-depth cap) sits AFTER Stream 3's
  dedup check in the `/relay` handler ordering. The reordering is
  deliberate and called out in `routes.rs` inline comments.
- **Stream 7** (logging) injects scrubbed-logging primitives. The
  dedup module keeps everything at DEBUG and never names the dedup
  key, the proof bytes, or the matching uuid in any tracing call.
- **Stream 9** (malicious-client tests) drives `/relay` with replayed
  payloads; relies on V1 catching them.

### H.5 How to extend this taxonomy

When you add a new replay vector:

1. Append it as `V<N>` with the same five-section format
   (Vector / Defense / Response / Residual risk / Test).
2. Add a row to the vector-table.
3. Cross-link the new test file(s) under `crates/.../tests/replay_*.rs`
   or `programs/.../tests/*.ts`.
4. Note the cross-stream owner if the defense lives outside Stream 3.

---

## Cross-references

- `INVARIANTS.md` — formal safety properties.
- `OPERATIONS.md` § 1 (Keys) — runbook for the §D detect-and-rotate path.
- `GOVERNANCE.md` — Squads bootstrap for §F production posture.
- `OPERATIONS.md` § 2 (Logging) — privacy policy + redaction layer
  (§D.2.1 defense).
- `crates/malicious-tests/tests/` — code companions for every
  scenario above.
