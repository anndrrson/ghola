# Ghola Shielded Pool — External Auditor Handoff Package

**Version**: audit-v1
**Commit**: `0634707416c1ddb0e7aef771ef88256ba095eadf`
**Program ID** (devnet): `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A`
**Date frozen**: 2026-05-23

This is the **first document an external auditor should read**. It
indexes every artifact, document, and test that comprises the audit
deliverable, and surfaces the focus areas the protocol team flags for
auditor scrutiny.

If you only have time for one paragraph: the SAID shielded pool is a
Solana-program-plus-Groth16-circuits anonymous-agent pool, currently
deployed on devnet under `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A`.
The audit-v1 commit cuts every protocol surface against a frozen spec
(`SPEC.md`), 16 named invariants across 8 families (`INVARIANTS.md`),
9 hardening workstreams of evidence (§ 9 below), 7 attacker-profile
test suites plus replay taxonomy (`THREAT_SCENARIOS.md`), and a chain
of governance + operations docs (`GOVERNANCE.md` for authority +
timelocks + runbooks, `OPERATIONS.md` for keys + logging + supply
chain). The single non-obvious deferred item is the V2-program-binary
redeploy to devnet; everything else is in scope.

---

## 1. Scope & Boundaries

### 1.1 In scope (audit-v1)

**Source code**:

- `programs/said-shielded-pool/src/` — the entire Anchor program at
  commit `0634707416c1ddb0e7aef771ef88256ba095eadf`. Built binary
  hash (sha256): `0a80a0beb52922654811f0075cc788b15cb1bf3effb32306c6c3135f3a745b45`
  (455,000 bytes (445K)).
- `crates/said-shielded-pool-types/`         — shared types.
- `crates/said-shielded-pool-prover/`        — off-chain witness +
  proof generation (snarkjs subprocess).
- `crates/said-shielded-pool-client/`        — submitter / shielded
  wallet helpers.
- `crates/said-shielded-pool-relayer/`       — off-chain relayer
  with the replay/dedup layer (Stream 3).
- `crates/said-shielded-pool-indexer/`       — append-only indexer +
  commitment-set view.
- `crates/said-shielded-pool-circuits/`      — Circom sources (frozen)
  + ceremony zkeys + verification keys.
- `crates/common-secrets/`                   — `Zeroize`d keymaterial
  primitives (Stream 5).
- `crates/common-log/`                       — redaction layer for
  privacy-aware tracing (Stream 7).

**Documents** (frozen at this commit):

- `docs/shielded-pool/SPEC.md`             — protocol specification.
- `docs/shielded-pool/INVARIANTS.md`       — safety invariants (16 named).
- `docs/shielded-pool/GOVERNANCE.md`       — authority + timelock semantics,
                                              plus § 11 Runbooks (program
                                              redeploy, vk rotation, state
                                              migration, incident response).
- `docs/shielded-pool/OPERATIONS.md`       — keys, logging, supply chain.
- `docs/shielded-pool/THREAT_SCENARIOS.md` — adversary profiles + replay
                                              vector taxonomy (§ H).
- `docs/shielded-pool/AUDIT_PACKAGE.md`    — this document (evidence-gate
                                              semantics inlined in § 9).
- `SECURITY.md` (repo root)                — high-level security posture.

**Tests + harnesses**:

- `crates/said-shielded-pool-invariants/`   — 66 invariant tests
  across 8 families.
- `fuzz/`                                   — 6 cargo-fuzz targets +
  3 proptest harnesses.
- `crates/chaos-tests/`                     — 12 failure-mode scenarios.
- `crates/malicious-tests/`                 — 7 attacker-profile suites
  (16 offline passing + 8 devnet-gated ignored).
- `crates/said-shielded-pool-relayer/tests/replay_*` — 14 replay tests.

### 1.2 Out of scope (deferred past audit-v1)

The protocol team explicitly does **not** ask the auditor to opine on:

1. **Multi-party trusted-setup ceremony.** The current zkeys
   (`crates/said-shielded-pool-circuits/ceremony/{transaction,batchedUpdate}_final.zkey`)
   are a documented single-contributor PoC. The spec defines the
   ≥10-contributor target for mainnet. Ceremony operations are
   scheduled separately.
2. **TEE-resident prover (Phase 42).** Prover is treated as a trusted
   local process; this audit covers its off-chain interfaces only.
3. **Multi-relayer anonymity network (Phase 41).** Single-relayer
   attack scenarios are covered by Stream 9 / `THREAT_SCENARIOS.md`;
   multi-relayer coordination is deferred.
4. **Mainnet beta deploy (Phase 45 gate).** This audit is the
   prerequisite, not the deploy itself.
5. **Adjacent SAID / Thumper subsystems.** Specifically:
   `said-attest`, `said-receipts-service`, `said-cloud`,
   `thumper-*`, `ghola-gateway`, `ghola-home`,
   `orni-models-*`. One unrelated `cargo test` failure exists in
   the SAID nitro-attestation surface (`sealed_round_trip_mock_nitro`)
   — out of scope.

### 1.3 Trust boundary diagram

The shielded pool ends at:

- The Anchor program's instruction handlers (everything they accept
  in `process_instruction` is in scope).
- The relayer's HTTP / gRPC ingress (everything it accepts on the
  public submit endpoint is in scope).
- The indexer's view-only API (read-only; in scope for confidentiality
  but not state transitions).
- The prover's subprocess invocation contract with snarkjs (in scope
  for input/output validation only; snarkjs itself is out of scope —
  see §8 known limitations).

---

## 2. System Diagram

```
                                                 ┌─────────────────────┐
                                                 │  Solana validator   │
                                                 │  (devnet/mainnet)   │
                                                 └──────────▲──────────┘
                                                            │
                                                            │ Tx submit
              ┌───────────────┐    Groth16 proof + tx       │
              │  client       │─────────────────────────────┘
              │  (wallet)     │
              │               │            ┌───────────────────────┐
              │  spends note  │            │  said-shielded-pool   │
              └──┬────────────┘            │  Anchor program       │
                 │                          │                       │
                 │ shielded                 │  - initialize_pool    │
                 │ note inputs              │  - deposit            │
                 │                          │  - transfer (verify)  │
                 ▼                          │  - withdraw / decoy   │
        ┌────────────────────┐              │  - update_root_proof  │
        │  prover            │              │  - propose_*          │
        │  (off-chain)       │              │  - attest_evidence   ◀── Stream 10
        │                    │              │  PoolConfig (PDA)     │
        │  - witness gen     │              │  EvidenceLog (PDA)    │
        │  - snarkjs Groth16 │              └───────────▲───────────┘
        │  - vk pin check    │                          │
        └─────────┬──────────┘                          │
                  │ relay payload                       │
                  ▼                                     │
        ┌────────────────────┐    POST submit-tx        │
        │  relayer           │──────────────────────────┘
        │  (off-chain)       │
        │                    │
        │  - dedup (sled)    │
        │  - root staleness  │
        │  - queue cap       │
        │  - rate limit      │
        └─────────┬──────────┘
                  │  forwards Solana tx
                  ▼
        ┌────────────────────┐
        │  Solana RPC        │
        └─────────┬──────────┘
                  │ events
                  ▼
        ┌────────────────────┐
        │  indexer           │
        │  (off-chain)       │
        │  - commitment hex  │
        │  - replay protected│
        │  - merkle re-build │
        └────────────────────┘
```

The user-facing surface is `client → prover → relayer → program`.
The forester sub-flow (off-chain batch builder + `update_root_via_proof`)
runs from the program back through the relayer. The indexer is
purely read-side and never injects state.

---

## 3. Trust Model

Primary reference: `SPEC.md §1.3` (threat model). High-level recap:

**Trusted**:

- The Solana validator set (consensus). Pool security degrades to
  ≥ Solana's BFT bound.
- The 4-signer **forester multisig** (signers documented in
  `GOVERNANCE.md §1`). A ≥3-of-4 threshold authorizes
  `update_root_via_proof`. Collusion of all 4 would only enable
  withholding future updates; it cannot mint new notes or steal
  deposited funds (proof must still verify).
- The **admin multisig** (Squads, planned mainnet). Authorizes
  vk rotations + forester-set rotations, all timelocked 48h.
- The **PoolConfig PDA** integrity (only the program writes it).
- The Circom compiler + snarkjs at the pinned versions (out of scope
  per §8).

**Untrusted / adversarial**:

- The relayer. Single relayer in audit-v1 — it can censor or stall
  but cannot forge transactions. See Stream 9 / `malicious_relayer.rs`.
- The indexer. View-only; can present a stale view to a client but
  cannot influence on-chain state. See `malicious_indexer` not
  modeled — out of scope (indexer doesn't write).
- The prover. Off-chain. Can refuse to prove, or supply a malformed
  witness; cannot forge a proof (the program re-verifies). See
  `malicious_prover.rs`.
- The forester (individual member). A single forester signer cannot
  unilaterally authorize a root update — threshold blocks them. See
  `malicious_forester.rs`.
- The application layer (whatever business logic embeds Ghola
  shielded transfers). See `malicious_app.rs`.
- The pool worker process running locally. See `malicious_worker.rs`.
- Other governance signers. A single governance signer cannot bypass
  timelock. See `malicious_governance.rs`.
- Grief actors. See `malicious_griefing.rs`.

See `THREAT_SCENARIOS.md` for the per-actor capability inventory.

---

## 4. Protocol Invariants

Primary reference: `INVARIANTS.md`.

**8 families, 16 named invariants** (66 underlying off-chain unit
tests in `crates/said-shielded-pool-invariants/tests/`):

| Family | File | Named invariants |
|--------|------|------------------|
| Nullifiers   | `tests/nullifiers.rs` | NULL-1 (uniqueness), NULL-2 (derivation binding) |
| Notes        | `tests/notes.rs`      | NOTE-1 (commitment-amount binding), NOTE-2 (blinding entropy) |
| Roots        | `tests/roots.rs`      | ROOT-1 (history window), ROOT-2 (monotone insertion) |
| Custody      | `tests/custody.rs`    | CUST-1 (no-cross-asset), CUST-2 (pool-balance conservation) |
| Proofs       | `tests/proofs.rs`     | PROOF-1 (vk-binding), PROOF-2 (public-input ordering) |
| Relayers     | `tests/relayers.rs`   | REL-1 (no-forgery), REL-2 (no-amplification) |
| Metering     | `tests/metering.rs`   | METER-1 (gas-bound), METER-2 (deposit-cap) |
| Revenue      | `tests/revenue.rs`    | REV-1 (fee-routing), REV-2 (decoy-zero-cost) |

Each invariant statement, mathematical predicate, on-chain
enforcement point, and off-chain checker are itemized in
`INVARIANTS.md`. The off-chain test corpus (66 passing tests, 0
failing) re-derives every invariant from a Rust model independent
of the Anchor program — auditors who suspect a divergence between
spec and on-chain code can run the model and compare.

---

## 5. Specification

Primary reference: `SPEC.md`. **Frozen at audit-v1**; any change to
a circuit, encoding, or public-input ordering requires a new vk
ceremony and a governance proposal (`SPEC.md §9`).

`SPEC.md` table of contents:

1. Overview & Threat Model
2. Data Model (note, commitment, nullifier, ext_data_hash)
3. Key Hierarchy (`sk_root` → `sk_agent` → `nk` derivation)
4. Circuits (`transaction.circom`, `merkleProof.circom`, `keypair.circom`)
5. Proof Statements (the conjunction the verifier enforces)
6. Nullifier Derivation Rule (Poseidon3(`nk`, `commitment`, `leaf_index`))
7. Commitment Derivation Rule (Poseidon4(`amount`, `asset_id`, `owner`, `blinding`))
8. Root Update Rule (batched + in-tx insertion + root-history window)
9. Verifier-Key Commitment Scheme (PoolConfig vk_hash + rotation)
10. Anchor History & Replay Protection
11. Encoding (big-endian 32-byte field elements)
12. Multi-asset Support
13. Decoy Withdraw (Stream 9 addition)
14. EvidenceLog Anchor (Stream 10 addition)

The blake3 hash of `SPEC.md` at this commit is recorded as
`streams.invariants.spec_hash` in `.github/evidence-baseline.json`.
Any rewrite of `SPEC.md` invalidates the baseline and requires
CODEOWNERS approval.

---

## 6. Governance & Upgrade

Primary reference: `GOVERNANCE.md` (authority model in §§ 1–10,
runbooks in § 11).

### 6.1 Authorities

| Authority | Role | Mainnet plan |
|-----------|------|--------------|
| Program upgrade authority | BPF loader; controls the .so | Squads multisig |
| PoolConfig `admin`        | Initiates timelocked proposals | Squads multisig |
| PoolConfig `pause_authority` | Triggers incident-response pause | 1-of-N hot key |
| PoolConfig `forester_set[4]` | Co-signs `update_root_via_proof` | 4 independent operators |

### 6.2 Default timelock

48 hours (`172_800` seconds) for **every** admin-initiated change:

- vk rotation (`propose_vk_hash` → 48h → `accept_vk_hash`).
- forester-set rotation (`propose_forester_set` → 48h → `accept_forester_set`).
- admin change (`propose_admin` → 48h → `accept_admin`).

The pause flow is **not** timelocked — `pause_authority` can pause
the pool immediately (it cannot unpause; admin acceptance required).

### 6.3 Upgrade procedure

`GOVERNANCE.md` § 11.B documents the program-binary upgrade procedure.
Audit-v1 state: V2 binary is built locally (sha256 matches manifest)
but **not yet deployed on devnet** — see §8 known limitations.

---

## 7. Cryptographic Choices

| Choice | Value | Rationale |
|--------|-------|-----------|
| Curve  | BN254 (alt-bn128) | Solana's built-in `sol_alt_bn128_g1_*` syscalls; CIRCOM-native |
| Hash   | Poseidon-BN254, Circomlib parameter set | matches `sol_poseidon` syscall; t-arity = input count |
| Proof system | Groth16 | smallest verifier; Solana-native via Light Protocol's `groth16-solana` |
| Verifier key (transfer) | sha256 `cd5bb157fec0aae5c18f83a0803f5e1c85d8c7da697a176c193513f0992ec197` | `crates/said-shielded-pool-circuits/artifacts/verification_key.json` |
| Verifier key (forester) | sha256 `301c38e483805cde168baa7d8a48295b02c6753e4c816d966234d735da0b1a60` | `crates/said-shielded-pool-circuits/artifacts/forester_verification_key.json` |
| Ceremony PoT (transfer) | Hermez Powers of Tau 2^16 | matches transfer circuit ~50k constraints |
| Ceremony PoT (forester) | Hermez Powers of Tau 2^17 | matches batched-update ~100k constraints |
| Ceremony contributor count | **1** (PoC) | documented downgrade; see §8 |
| Field-element encoding | big-endian 32-byte (`FieldBytes`) | matches Solana sysvar conventions |

The vk hashes are pinned in `PoolConfig.vk_hash` (transfer) and
`PoolConfig.forester_vk_hash` (forester). Rotation is governed by
the timelock flow above.

---

## 8. Known Limitations

These are **documented gaps**, not findings. The auditor is welcome
to corroborate the documentation but the protocol team flags each
of these as known and accepted for audit-v1.

1. **Single-contributor ceremony.** The current zkeys are produced
   by a single contributor; production requires ≥10 contributors
   for the toxic-waste guarantee. Re-ceremony is scheduled
   pre-mainnet. The current state lets the audit cover everything
   *except* trusted-setup soundness.

2. **V2 program not yet on devnet at this commit.** The V2 binary
   — which contains the Stream 4 governance ix + Stream 9 decoy
   withdraw + Stream 10 attest_evidence ix — was built locally
   (`programs/said-shielded-pool/target/deploy/said_shielded_pool.so`,
   sha256 `0a80a0beb52922654811f0075cc788b15cb1bf3effb32306c6c3135f3a745b45`,
   455,000 bytes (445K)) but **not successfully redeployed**.
   - Deploy attempt failed mid-flight on insufficient devnet SOL;
     airdrops were rate-limited at the time.
   - The on-chain program data account was extended to 518,480
     bytes via `solana program extend`, but still hosts V1 bytes.
   - Devnet program `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A`
     currently runs V1.
   - **Dispatcher action**: re-fund the deploy keypair, run
     `solana program deploy programs/said-shielded-pool/target/deploy/said_shielded_pool.so`,
     verify on-chain hash matches the manifest's
     `program_bin_sha256`, then run the Stream 4 governance ts-node
     migration tests.
   - This is the only audit-v1 deferred dispatcher item that
     affects the audit surface.

3. **TEE prover deferred (Phase 42).** The prover currently runs as
   a trusted local process. The audit covers its off-chain interface
   contract; enclave-resident execution is a Phase 42 deliverable.

4. **Multi-relayer anonymity network deferred (Phase 41).** Stream 9
   covers single-relayer attack scenarios. Multi-relayer
   coordination (e.g. tor-like onion-route relay graphs) is Phase
   41 work.

5. **Unrelated test failure in adjacent SAID/Thumper subsystem.**
   `sealed_round_trip_mock_nitro` in the AWS Nitro attestation
   surface fails at this commit. Out of scope; tracked separately.

6. **`snarkjs` pinned to `^0.7.4` in `prover/package.json`.**
   Stream 8 flagged this; the caret allows in-range version drift
   on `npm install`. Pre-mainnet, pin to an exact `0.7.4` and
   commit `package-lock.json`. Audit-v1 accepts the caret with
   the documented mitigation.

7. **Transfer `try_accounts` BPF stack warning (+184 bytes).**
   `anchor build` emits a non-fatal stack-frame size warning for
   the deposit/transfer instruction's `try_accounts`. The
   instruction runs correctly on-chain (verified by the full-loop
   devnet test); the warning is from constraint inlining and does
   not indicate a fault. Tracked for refactor at a later phase.

8. **`light-poseidon` panics on inputs ≥ p.** Stream 2's fuzzing
   surfaced that `light_poseidon::hash` will panic if any input
   limb ≥ the BN254 scalar field modulus `p`. The shielded pool
   never directly passes such inputs (all inputs are derived from
   reductions or `FieldBytes` validation), but downstream
   integrators must call `FieldBytes::try_reduce` before forwarding
   user-supplied bytes. Documented in `SPEC.md §11`.

9. **`cargo deny` advisory on `serde_cbor`.** A transitive
   dependency of `aws-nitro-enclaves-nsm-api` (used only by
   `thumper-gpu-provider`, **out of scope**) pulls `serde_cbor`,
   which has an unmaintained advisory. The current
   `.github/evidence-baseline.json` records
   `streams.supply_chain.deny_pass: false` faithfully. To bypass,
   add `RUSTSEC-2021-0127` to `deny.toml`'s
   `advisories.ignore` array. Audit-v1 leaves this honest rather
   than papering over it.

10. **Local baseline is sha256-based + unsigned.** The
    `.github/evidence-baseline.json` checked in at this commit was
    produced locally on macOS without `b3sum` or cosign OIDC. CI
    regenerates the baseline as blake3 + cosign-signed on the
    first merge to `audit-v1`. See § 9.6 below.

---

## 9. Evidence Manifest

> Folded from `EVIDENCE.md` 2026-05-24; canonical home is this section.

The hardening evidence gate consolidates Streams 1–9 into a
single commitment-only manifest:

- **Pipeline**: `scripts/evidence/collect.sh` → `commit.sh` →
  `verify.sh`.
- **Baseline**: `.github/evidence-baseline.json` (frozen at this
  commit; CODEOWNERS approval required to update).
- **CI gate**: `.github/workflows/evidence-gate.yml` runs all
  three scripts on PR + push and diffs against the baseline.

The evidence gate is **commitment-only**. The public manifest contains
hashes; it never contains test output, log lines, or failure
signatures. Anyone re-running `collect.sh` against the recorded commit
can re-derive every hash from the source tree.

### 9.1 What the gate proves

For each of Streams 1–9 of the hardening pass, the gate proves
*at-a-commit*:

| Stream | Proof | Evidence field |
|--------|-------|----------------|
| 1. Invariants | Off-chain proptest + unit suites pass; spec frozen | `streams.invariants.{spec_hash, doc_hash, pass_count, result_hash}` |
| 2. Fuzz + props | 6 cargo-fuzz targets + 3 proptest harnesses exist; corpus hash recorded | `streams.fuzz.{targets, executed, corpus_hash, minutes, crashes}` |
| 3. Replay | Relayer dedup + cross-root + stale-root tests pass | `streams.replay.{pass_count, result_hash, doc_hash}` |
| 4. Governance | Program binary hash + governance docs frozen + timelock recorded | `program_bin_sha256`, `streams.governance.{config_doc_hash, upgrade_doc_hash, timelock_secs}` |
| 5. Secrets | `common-secrets` audit hash + zeroize sites + rotation doc | `streams.secrets.{audit_hash, pass_count, key_rotation_doc}` |
| 6. Chaos | 12 chaos scenarios pass (queue-cap + staleness gating) | `streams.chaos.{pass_count, result_hash}` |
| 7. Telemetry | Redaction layer leak-test passes; logging doc frozen | `streams.telemetry.{leak_test_hash, pass_count, doc_hash}` |
| 8. Supply chain | `cargo deny` + `cargo audit` outcomes recorded; deny.toml frozen | `streams.supply_chain.{deny_pass, audit_pass, deny_config_hash, doc_hash}` |
| 9. Malicious | 7 attacker-profile suites pass; threat doc frozen | `streams.malicious.{pass_count, ignored_count, result_hash, doc_hash}` |

It does **not** prove: deployment on devnet at this commit, completion
of the multi-party trusted-setup ceremony, or TEE prover residency
(Phase 42).

### 9.2 At-a-glance commitments (audit-v1 baseline)

```jsonc
{
  "program_bin_sha256":  "0a80a0beb52922654811f0075cc788b15cb1bf3effb32306c6c3135f3a745b45",
  "vk_transfer_hash":    "cd5bb157fec0aae5c18f83a0803f5e1c85d8c7da697a176c193513f0992ec197",
  "vk_forester_hash":    "301c38e483805cde168baa7d8a48295b02c6753e4c816d966234d735da0b1a60",
  "streams.invariants.pass_count": 66,
  "streams.replay.pass_count":     34,
  "streams.secrets.pass_count":    13,
  "streams.chaos.pass_count":      10,
  "streams.telemetry.pass_count":  16,
  "streams.malicious.pass_count":  16,   // + 8 ignored devnet-gated
  "streams.fuzz.targets":           6     // 3 proptest harnesses additional
}
```

### 9.3 Verifying the baseline

```bash
git checkout 0634707416c1ddb0e7aef771ef88256ba095eadf
./scripts/evidence/verify.sh .github/evidence-baseline.json
```

The verifier re-derives every doc / artifact / config hash from the
current working tree and prints one line per commitment (e.g.
`spec_hash: OK`). **Exit codes**: `0` if everything matches; `1` on
any mismatch; `2` on invocation error.

The verifier is intentionally **commitment-only** — mismatches print
only `COMMITMENT MISMATCH`. To investigate, the auditor must re-run
`collect.sh` + `commit.sh` locally and compare manifest fields:

```bash
./scripts/evidence/collect.sh           # ~5 min without fuzz, ~17 min with
./scripts/evidence/commit.sh
jq -S 'del(.commit, .generated_at, .signed_by)' \
  artifacts/hardening-evidence/$(git rev-parse HEAD)/evidence.json > /tmp/cur.json
jq -S 'del(.commit, .generated_at, .signed_by)' \
  .github/evidence-baseline.json > /tmp/base.json
diff /tmp/cur.json /tmp/base.json
```

A clean diff means all 9 streams pass identically. CI runs exactly
this diff on every PR; non-empty diff blocks merge.

### 9.4 On-chain anchor (`attest_evidence` ix)

Stream 4 added an Anchor instruction:

```rust
pub fn attest_evidence(
    ctx: Context<AttestEvidence>,
    evidence_root: [u8; 32],
    commit_slot: u64,
) -> Result<()>
```

It writes `blake3(canonical evidence.json)` to the `EvidenceLog` PDA
(seeds `[b"evidence_log"]`) under program
`5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A`. The PDA stores a ring
buffer of the last 16 roots, so auditors can pin which hardening pass
was active at any slot in the past 16 attestations. This makes "the
program at slot N was governed by hardening manifest X" externally
verifiable without trusting any off-chain copy of `evidence.json`.

To produce the anchor:

1. Compute `evidence_root = blake3(canonical evidence.json)`
   (`b3sum artifacts/.../evidence.json | awk '{print $1}'`).
2. The current authority signs and submits `attest_evidence(root, slot)`
   via the governance multisig.
3. Auditors look up the PDA and confirm `latest_root` matches their
   local `blake3(.github/evidence-baseline.json)`.

**On-chain anchor slot at audit-v1**: TBD. The `attest_evidence` ix
will land in the V2 redeploy; once V2 is deployed, the dispatcher
runs `npx ts-node tests/attest_evidence_devnet.ts` and the recorded
slot is appended here.

### 9.5 Updating the baseline

`.github/evidence-baseline.json` is the source of truth that the CI
gate diffs against. Any time an in-scope file's hash changes, the
baseline must be updated **in the same PR**: make the substantive
change, re-run `collect.sh` + `commit.sh`, copy the resulting
`evidence.json` to `.github/evidence-baseline.json`, and commit both
together. `.github/CODEOWNERS` SHOULD require an explicit approver for
baseline updates (tracked as a dispatcher follow-up).

### 9.6 Limitations of this baseline

The audit-v1 baseline in this repo was generated locally on macOS, and
inherits these caveats:

- **`hash_algo: sha256`** — no `b3sum` binary was available locally.
  Production CI uses blake3. The two manifests are not directly
  comparable; each is internally consistent.
- **`signed_by: unsigned-local-stream10-generation`** — no cosign-keyless
  OIDC was available offline. CI signs in-place via `cosign sign-blob`
  with GitHub OIDC.
- **`program_idl_sha256: absent`** — Anchor was not run during
  `collect.sh`, so no IDL JSON exists. Once the dispatcher runs
  `anchor build` (a prerequisite of redeploy), the IDL hash becomes
  present in subsequent manifests.
- **`streams.fuzz.executed: false`** — the local baseline run set
  `EVIDENCE_SKIP_FUZZ=1`. CI sets `EVIDENCE_FUZZ_SECS=120` per target
  and records `executed: true` with a non-skipped `corpus_hash`.
- **`streams.supply_chain.deny_pass: false`** — `cargo deny` reports
  an advisory on `serde_cbor` (transitively pulled by
  `aws-nitro-enclaves-nsm-api` in the unrelated `thumper-gpu-provider`
  crate). Documented in § 8 (Known Limitations) and tracked as a
  follow-up; does not affect the shielded-pool surface.

These are not "audit blockers" — they are dispatcher follow-ups that
the CI baseline overwrites once executed in production.

---

## 10. Reproduction Steps

All commands run from repo root unless noted.

### 10.1 Toolchain versions (pinned)

| Tool | Version |
|------|---------|
| `rustc`              | 1.93.1 (stable) |
| `rustc` (nightly)    | 2026-04-01 (fuzz only) |
| `cargo`              | 1.93.1 |
| `anchor-cli`         | 0.32.1 |
| `cargo-build-sbf`    | 4.1.0 |
| `solana`             | 1.18.20 (target: 2.x post-audit) |
| `cargo-fuzz`         | 0.12.x (latest) |
| `cargo-deny`         | 0.16.x (latest) |
| `cargo-audit`        | 0.21.x (latest) |
| `node`               | 20.x LTS |
| `snarkjs`            | 0.7.4 (caret-pinned; see §8.6) |
| `circom`             | 2.1.9 |

### 10.2 Rebuild the .so byte-for-byte

```bash
cd /Users/andersonobrien/Downloads/ghola
git checkout 0634707416c1ddb0e7aef771ef88256ba095eadf
anchor build -p said_shielded_pool
shasum -a 256 programs/said-shielded-pool/target/deploy/said_shielded_pool.so
# expect: 0a80a0beb52922654811f0075cc788b15cb1bf3effb32306c6c3135f3a745b45
```

If the hash differs, Anchor's deterministic-build env is not
configured — `anchor build --verifiable` is the deterministic path.
See `scripts/build-attestation.sh` for the production attestation flow.

### 10.3 Re-run each stream's gate

```bash
# Stream 1
cargo test -p said-shielded-pool-invariants --tests
# Stream 2
cd fuzz && for t in prover_witness_parse relayer_relay_payload \
    indexer_commitment_hex program_args_decode vk_parse merkle_insert; do
  cargo +nightly fuzz run $t -- -max_total_time=120
done
cd ..
cargo test --workspace --tests -- prop_ property_
# Stream 3
cargo test -p said-shielded-pool-relayer --tests
# Stream 5
cargo test -p common-secrets
# Stream 6
cargo test -p chaos-tests
# Stream 7
cargo test -p common-log
# Stream 8
cargo audit
cargo deny --all-features check
# Stream 9
cargo test -p malicious-tests
```

### 10.4 Re-derive the evidence manifest

```bash
EVIDENCE_FUZZ_SECS=120 ./scripts/evidence/collect.sh
./scripts/evidence/commit.sh
./scripts/evidence/verify.sh artifacts/hardening-evidence/$(git rev-parse HEAD)/evidence.json
diff <(jq -S 'del(.commit, .generated_at, .signed_by)' \
        artifacts/hardening-evidence/$(git rev-parse HEAD)/evidence.json) \
     <(jq -S 'del(.commit, .generated_at, .signed_by)' \
        .github/evidence-baseline.json)
```

A clean diff means every stream's commitment is byte-for-byte
identical to the audit-v1 baseline.

---

## 11. Open Questions for Auditor

The protocol team flags these as high-priority focus areas. Each is
already exercised by the test corpus; the auditor is asked to
opine on adequacy.

### 11.1 Nullifier derivation

**Question**: is `Poseidon3(sk, commitment, leaf_index)` strong
against malleability + collision in the BN254 field?

**Spec ref**: `SPEC.md §6`.
**Test ref**: `INVARIANTS.md NULL-1, NULL-2`;
`crates/said-shielded-pool-invariants/tests/nullifiers.rs`.

Specifically: does inclusion of `leaf_index` (rather than just
`(sk, commitment)`) prevent any cross-tree replay if the same note
is somehow committed to two trees? The current rationale is that
`leaf_index` differs per-tree, so the nullifier differs — but the
auditor is asked to confirm no algebraic path exists where two
distinct `(sk, commitment, leaf_index)` triples Poseidon-collide.

### 11.2 `ext_data_hash` binding

**Question**: the public-input slot 7 (`ext_data_hash`) binds
extension data (recipient address for unshields, fee, memo) into
the proof. Is the binding strong enough to prevent a relayer from
mutating any of those fields post-proof?

**Spec ref**: `SPEC.md §5` (proof statements).
**Test ref**: `INVARIANTS.md REL-1`;
`crates/said-shielded-pool-relayer/tests/replay_*.rs`;
`malicious_relayer.rs`.

The current design hashes `(recipient, fee, memo)` into one
Poseidon output, then commits to that as a public input. Auditor
is asked to confirm the hash domain separation prevents
length-extension or field-aliasing attacks.

### 11.3 Decoy withdraw indistinguishability — RESOLVED

**Original question** (Stream 4 era): does any sub-account state
differ between a `decoy_withdraw` and a real `withdraw` that an
observer could correlate?

**Resolution** (cleanup pass, post-Stream-10): the dedicated
`decoy_withdraw` ix has been **deleted**. Decoys now go through
the regular `withdraw` handler with `amount = 0, relayer_fee = 0`;
because `withdraw`'s `transfer_checked` calls are `if x > 0` gated,
amount=0 skips them entirely. Both decoy and real share the *same*
Anchor discriminator (`sha256("global:withdraw")[..8]`) AND the
same on-chain state delta — there is no remaining byte that
distinguishes them at the tx-data layer.

Auditor is still asked to look for higher-order side channels
(compute-units variance per `amount` magnitude, log-byte length
variance, account-write ordering under different fee splits) —
the indistinguishability claim covers tx-data bytes only.

**Test refs**: `INVARIANTS.md REV-2`;
`crates/said-shielded-pool-relayer/src/decoy.rs` shows the on-chain
ix construction (uses `withdraw` discriminator with zero amounts).

### 11.4 Forester batch size 4 — k-anonymity adequate?

**Question**: the forester batches 4 commitments per
`update_root_via_proof` call. Is `k=4` adequate for anonymity, or
should we raise to 8 or 16?

**Spec ref**: `SPEC.md §8.1`.
**Test ref**: indirectly covered by `THREAT_SCENARIOS.md §3`.

Trade-off: larger batch = stronger anonymity but longer settlement
latency. The audit-v1 choice of 4 reflects current devnet
throughput; the auditor is asked to opine on the lower bound for
mainnet.

### 11.5 `ROOT_HISTORY_SIZE = 64` (reduced from 256)

**Question**: the BPF stack ceiling forced reducing
`ROOT_HISTORY_SIZE` from 256 to 64. Is the resulting spend-window
(~64 batched-insert intervals) acceptable?

**Spec ref**: `SPEC.md §8.3`.
**Test ref**: `INVARIANTS.md ROOT-1`;
`crates/said-shielded-pool-invariants/tests/roots.rs`.

Concretely: a client whose proof references a root that has aged
out of the 64-deep history will get a `StaleRoot` rejection and
must re-prove. The auditor is asked to opine on whether 64 is
sufficient given expected forester cadence (~1 batch per 30s on
devnet under load).

### 11.6 vk-rotation flow soundness

**Question**: `propose_vk_hash(new_hash)` → 48h timelock →
`accept_vk_hash(new_vk_bytes)` requires
`blake3(new_vk_bytes) == proposed_hash`. Is the hash-commit /
reveal-with-preimage flow sound against any front-running or
substitution?

**Spec ref**: `SPEC.md §9.2`.
**Test ref**: `crates/malicious-tests/tests/malicious_governance.rs`.

Specifically: the `accept_vk_hash` ix accepts `new_vk_bytes` and
hashes them; if the preimage check passes the vk is installed. The
auditor is asked to confirm:
- No race where `propose_vk_hash` is replayed against a different
  accept call.
- No state where the timelock can be bypassed by a second propose.
- No way for a non-admin to submit `accept_vk_hash` with arbitrary
  bytes (the constraint `has_one = admin` is in place).

---

## 12. Appendices

### 12.1 File index

**Documents** (all under `docs/shielded-pool/` unless noted):

```
SPEC.md                Protocol specification (frozen)
INVARIANTS.md          16 named invariants, 8 families
GOVERNANCE.md          Authority hierarchy + timelock + Runbooks (§ 11)
OPERATIONS.md          Keys (§ 1) + Logging (§ 2) + Supply chain (§ 3)
THREAT_SCENARIOS.md    7 adversary profiles + replay taxonomy (§ H)
AUDIT_PACKAGE.md       This document; evidence-gate inlined in § 9
../../SECURITY.md      Repo-root security posture
```

**Test crates**:

```
crates/said-shielded-pool-invariants/   66 tests, 8 families
crates/said-shielded-pool-relayer/      14 replay tests (+ unit tests)
crates/common-secrets/                  13 tests
crates/common-log/                      16 tests (redaction leak)
crates/chaos-tests/                     10 chaos scenario tests
crates/malicious-tests/                 16 passing + 8 devnet-gated
fuzz/fuzz_targets/                       6 cargo-fuzz targets
```

**Programs**:

```
programs/said-shielded-pool/src/
├── lib.rs                          program entry
├── state.rs                        PoolConfig + EvidenceLog
├── instructions/
│   ├── initialize_pool.rs
│   ├── deposit.rs
│   ├── transfer.rs
│   ├── withdraw.rs
│   ├── decoy_withdraw.rs           (Stream 9)
│   ├── update_root_via_proof.rs
│   ├── propose_admin.rs
│   ├── accept_admin.rs
│   ├── propose_vk_hash.rs
│   ├── accept_vk_hash.rs
│   ├── propose_forester_set.rs
│   ├── accept_forester_set.rs
│   ├── pause.rs
│   ├── unpause.rs
│   └── attest_evidence.rs          (Stream 10)
└── errors.rs
```

**Circuits**:

```
crates/said-shielded-pool-circuits/circuits/
├── transaction.circom              main transfer circuit
├── merkleProof.circom              depth-26 inclusion proof
├── keypair.circom                  sk/pk derivation
└── batchedUpdate.circom            forester batch insertion
```

**Ceremony artifacts**:

```
crates/said-shielded-pool-circuits/ceremony/
├── transaction_0000.zkey           PoT 2^16 base
├── transaction_0001.zkey           single contributor
├── transaction_final.zkey          beacon-finalized
├── batchedUpdate_0000.zkey         PoT 2^17 base
├── batchedUpdate_0001.zkey         single contributor
└── batchedUpdate_final.zkey        beacon-finalized
```

### 12.2 Glossary

- **Note**: a UTXO with hidden `(amount, asset_id, owner, blinding)`,
  represented on-chain as a Poseidon commitment.
- **Commitment**: `Poseidon4(amount, asset_id, owner, blinding)`.
- **Nullifier**: `Poseidon3(nk, commitment, leaf_index)`. Public
  on-chain post-spend; prevents double-spend.
- **`nk`**: nullifier key. Principal-held; never given to the agent.
- **`sk_agent`**: agent-held spending key. Can sign transactions but
  not derive nullifiers — see `SPEC.md §3.2`.
- **`ext_data_hash`**: Poseidon hash of `(recipient, fee, memo)`;
  bound into the proof as public-input slot 7.
- **Forester**: the off-chain operator that batches commitments
  and submits `update_root_via_proof`.
- **PoolConfig PDA**: the program's settings account, seeds
  `[b"pool_config"]`.
- **EvidenceLog PDA**: the on-chain anchor for hardening manifests,
  seeds `[b"evidence_log"]`.
- **vk**: Groth16 verification key. Pinned in PoolConfig as
  `vk_hash` (transfer) and `forester_vk_hash`.
- **Decoy withdraw**: a withdraw call that emits no value transfer,
  used to mask traffic patterns. Stream 9 addition.
- **Timelock**: the 48h delay between `propose_*` and `accept_*`
  for governance changes.

### 12.3 Version pinning table

**Cargo workspace** (`Cargo.lock` sha256):
`b634817818e74f0fa38297af9ea79edb7f800a8d382c506811a9ef4eadf463a5`

**Program crate** (`programs/said-shielded-pool/Cargo.lock` sha256):
`8a30da56d658d07840d954c6078bd6ca85bf4b2fb8cdfe9de9cc79bb8c643585`

**Solana / Anchor**:

```
solana-program     = "1.18.20"
anchor-lang        = "0.32.1"
anchor-spl         = "0.32.1"
light-poseidon     = "0.2.0"
groth16-solana     = "0.0.3"     (vendored via Lightprotocol fork)
```

**Off-chain stack**:

```
tokio              = "1.x"       (workspace)
axum               = "0.7.x"     (relayer + indexer)
sled               = "0.34.x"    (relayer dedup)
sqlx               = "0.7.x"     (indexer)
prost              = "0.13.x"    (gRPC types)
tracing            = "0.1.x"     (with common-log redaction)
zeroize            = "1.x"       (common-secrets)
```

**Node** (`prover/package-lock.json`):

```
snarkjs            ^0.7.4        (caret — see §8.6)
ffjavascript       ^0.3.x
circomlibjs        ^0.1.x
```

**Ceremony zkey hashes**: see `crates/said-shielded-pool-circuits/ceremony/`
SHA256SUMS (committed alongside zkeys).

### 12.4 Contact points

- **Protocol engineering lead**: Anderson O'Brien
  (`anderson.a.obrien@gmail.com`).
- **Evidence-gate questions**: this document § 9.
- **Spec questions**: `SPEC.md` + git blame.
- **CI status**: `.github/workflows/evidence-gate.yml` runs on every
  PR; `hardening-evidence-<sha>` artifact has the raw logs.
