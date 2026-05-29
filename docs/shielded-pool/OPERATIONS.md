# SAID Shielded Pool — Operations

Operator-facing reference for the off-chain stack. Three sections:

1. **Keys** — every secret material the pool depends on, where it
   loads from, and how to rotate it (planned + emergency).
2. **Logging** — privacy policy for tracing, metrics, and any other
   observable side-channel emitted from the off-chain crates.
3. **Supply chain** — `cargo deny` policy, SBOM publishing, cosign
   signing, toolchain pinning, and documented advisory ignores.

> Folded from `KEY_ROTATION.md`, `LOGGING.md`, and `SUPPLY_CHAIN.md`
> on 2026-05-24; canonical home is this document.

---

# Part 1 — Keys

> Folded from `KEY_ROTATION.md` 2026-05-24; canonical home is this section.

Operational runbook for every secret material the Ghola Solana-native
shielded pool depends on. Each subsection names the key class, lists
where it is loaded from and stored at rest, gives the rotation procedure
(both planned and emergency), and documents the on-disk / in-memory
hygiene guarantees the codebase enforces. This is the authoritative
source for incident response. It must be readable end-to-end by an
on-call operator with no prior context.

## 1.1 Inventory

| Key class                  | Holder                          | Where loaded                       | Rotation cadence           | Owner crate                                       |
| -------------------------- | ------------------------------- | ---------------------------------- | -------------------------- | ------------------------------------------------- |
| Relayer signer (Ed25519)   | Relayer process                 | `RELAYER_KEYPAIR_PATH` env         | 90 days (planned)          | `crates/said-shielded-pool-relayer`               |
| Forester signer (Ed25519)  | Indexer / forester process      | `FORESTER_KEYPAIR_PATH` env        | 90 days (planned)          | `crates/said-shielded-pool-indexer/src/forester`  |
| Prover proving key (zkey)  | Prover service                  | `ARTIFACTS_DIR/circuit_final.zkey` | Per circuit revision only  | `crates/said-shielded-pool-circuits/ceremony/`    |
| Forester proving key       | Prover service                  | `ARTIFACTS_DIR/batchedUpdate_final.zkey` | Per circuit revision | `crates/said-shielded-pool-circuits/ceremony/`    |
| Verifier key (on-chain)    | `PoolConfig` PDA                | `programs/said-shielded-pool` state | Per circuit revision only | `programs/said-shielded-pool`                     |
| Admin key (Solana keypair) | Operator (offline)              | Squads multisig / cold storage     | On compromise              | governance (see Part 1.7)                         |
| Pause authority key        | Operator (warm)                 | warm-wallet                        | On compromise              | governance (see Part 1.8)                         |
| Client spending keys       | End user                        | client-side keystore               | User-driven                | `crates/said-shielded-pool-client`                |
| API tokens                 | (none today)                    | —                                  | —                          | placeholder for future bearer auth                |
| Ceremony beacon entropy    | Multi-party contribution chain  | sealed bin (offline)               | Per ceremony only          | `crates/said-shielded-pool-circuits/ceremony/`    |

## 1.2 In-process secret hygiene (enforced in code)

The shielded-pool stack treats every fixed-size secret as a
`SecretBytes<N>` or `Zeroizing<_>` value:

- `crates/common-secrets` — internal crate providing:
  - `SecretBytes<N>` (zeroize-on-drop, constant-time eq, redacted `Debug`)
  - `ScrubbedString` (short hex prefix for log fields)
  - Re-exports `zeroize::Zeroize` / `Zeroizing`
- `crates/said-shielded-pool-types::TransferWitness` — manual
  `Zeroize` + `Drop` impl scrubs `spending_key`, every `Note.blinding`,
  every `MerklePath.siblings`, and `input_indices`.
- `crates/said-shielded-pool-prover/src/backend/snarkjs.rs`:
  - `TempArtifacts` RAII guard deletes the snarkjs scratch dir (which
    contains the witness JSON in clear) on success, error, and panic.
  - `run_snarkjs` wraps each subprocess in `tokio::time::timeout` with
    the configurable `PROVER_SUBPROCESS_TIMEOUT_MS` (default 30 s) and
    sends SIGKILL to the child on timeout via `Child::kill().await`.
    `kill_on_drop(true)` is set as a belt-and-suspenders fallback.
- `crates/said-shielded-pool-relayer/src/submit.rs` — `RpcSubmitter`
  caches the signer as `OnceLock<Mutex<Zeroizing<[u8; 64]>>>`. The
  binary installs a `tokio::signal::ctrl_c` + Unix `SIGTERM` handler
  in `main.rs` that calls `RpcSubmitter::zeroize_signer` and runs
  axum's graceful-shutdown path.
- `crates/said-shielded-pool-indexer/src/forester/mod.rs` —
  `ForesterKeypair.bytes` wrapped in `Zeroizing<Vec<u8>>`; never
  cloned; `signing_key()` takes `&self` and the reconstructed
  `SigningKey` is dropped per-signature.
- `crates/said-shielded-pool-client/src/encryption.rs` — ephemeral
  X25519 secret + shared secret + HKDF output + derived AEAD key
  all wrapped in `Zeroizing`.

If you are adding a new code path that handles any of these secrets,
the rule is: **fixed-size → `SecretBytes<N>` or `Zeroizing<[u8; N]>`,
dynamic-size → `Zeroizing<Vec<u8>>`. Never `String`, never `Vec<u8>`
bare, never `[u8; N]` bare. No exceptions.**

The `Debug` impl on `SecretBytes` prints `<redacted N bytes>` and
`Display` is intentionally not implemented, so `format!("{}", k)`
fails to compile.

## 1.3 Relayer signer (Ed25519)

### Where loaded

- Env var: `RELAYER_KEYPAIR_PATH` (path to `solana-keygen` JSON file).
- File format: 64-byte JSON array `[seed (32) || pub (32)]`.
- In memory: `Zeroizing<[u8; 64]>` inside a `Mutex` behind a
  `OnceLock` on `RpcSubmitter`.
- Reconstructed per-signature into `ed25519_dalek::SigningKey` (the
  reconstructed key lives only on the signing stack frame).
- Zeroized on `SIGTERM` / `Ctrl-C` via the graceful-shutdown hook in
  `crates/said-shielded-pool-relayer/src/main.rs`.

### Planned rotation procedure (90-day cadence)

```bash
# 1. Generate new keypair on an air-gapped machine.
solana-keygen new --no-bip39-passphrase \
  --outfile /secure/relayer-keypair-$(date +%Y%m%d).json

# 2. Fund the new key with the relayer's expected float (rent +
#    transaction fees, ~0.1 SOL of headroom).
spl-token transfer ...   # operator's standard funding script

# 3. Update the deployment env var on the new pod / VM.
#    Example: fly.io secrets, k8s Secret, systemd EnvironmentFile.
#    DO NOT update the running process — we want a fresh start.

# 4. Drain the old relayer:
#      kill -TERM <pid>      # triggers `zeroize_signer` in main.rs
#    The relayer flushes its sled queue and zeroes the cached signer
#    before axum's graceful_shutdown returns.

# 5. Start the new relayer with the new env. Verify it picks up the
#    new keypair:
#      curl -fsS http://<host>/healthz  # ensures /metrics is live
#      jq '.signer_pubkey_tag' <log>    # ScrubbedString form

# 6. Witness queue resumption in metrics:
#      relayer_submit_success_total{}        # incrementing
#      relayer_submit_failure_total{}        # not incrementing
#      relayer_queue_depth{}                 # draining within RTO

# 7. Drain residual SOL from the OLD keypair to the treasury.
#      solana transfer ... --keypair <old>
#    Then SECURE-DELETE the old keyfile (shred -uvz or equivalent).
```

### Emergency rotation (compromise)

1. **Immediately** pause withdrawal submission. Either:
   - Stop the relayer process (`systemctl stop ghola-relayer`) AND
     update the deployed env so a restart won't pick up the bad key, or
   - Use the on-chain pause-authority (see GOVERNANCE.md) to halt the pool.
2. Drain any remaining SOL float from the compromised key to a
   treasury address that the attacker does NOT control.
3. Follow the planned-rotation steps from step 1 onward, with no
   waiting period for queue drain.
4. Audit logs for the time window between key compromise and
   rotation. The relayer NEVER logs proof contents, recipient
   addresses, amounts, or tx signatures at INFO/WARN level — but it
   does log queue depth and submission counts. Cross-reference with
   on-chain settled withdrawals to detect any txs the attacker may
   have pushed using the compromised key.
5. Publish the incident report. See `SECURITY.md` for the disclosure
   policy.

### Forensic notes

- The relayer's signer is the **fee payer** for every withdrawal.
  Loss of this key allows an attacker to drain the relayer's SOL
  balance but does **not** compromise pool funds (the proof's
  `ext_data_hash` binds the recipient — re-signing with the
  attacker's key does not let them redirect funds).
- The on-chain `withdraw` instruction does not require the relayer
  to be a designated authority. Any signer with sufficient SOL can
  submit a valid proof, so emergency rotation can use a fresh
  keypair without on-chain governance approval.

## 1.4 Forester signer (Ed25519)

### Where loaded

- Env var: `FORESTER_KEYPAIR_PATH`.
- File format: same as relayer (`solana-keygen` JSON, 64 bytes).
- In memory: `ForesterKeypair { bytes: Zeroizing<Vec<u8>> }` field on
  the `Forester` struct in
  `crates/said-shielded-pool-indexer/src/forester/mod.rs`.
- Reconstructed per-signature; never moved out of the struct.

### Planned rotation (90-day cadence)

The forester is permissioned **on-chain** by the
`forester_set: [Pubkey; 4]` field in `PoolConfig` (added by Stream 4
governance). Rotation is therefore a two-step:

```bash
# Phase 1 — propose & accept the new forester on-chain.
# Default timelock is 48h; see docs/shielded-pool/GOVERNANCE.md.

# 1a. Generate new keypair (same procedure as relayer).
solana-keygen new --outfile /secure/forester-keypair-$(date +%Y%m%d).json

# 1b. Propose the swap via the governance ix.
ghola admin set_forester_set \
  --slot <0..3> \
  --pubkey <new-forester-pubkey>
# This writes to pending state with `forester_change_eta = now + 48h`.

# 1c. Wait for the timelock to elapse.

# 1d. Accept:
ghola admin accept_forester_set
# Now the new pubkey is in the live forester_set.

# Phase 2 — swap the running process.
# 2a. Stop the indexer:
#      kill -TERM <pid>       # forester Drop zeroes the cached bytes
# 2b. Update env, restart with the new keypair.

# Phase 3 — drain the old pubkey from the forester_set (next governance
# cycle, after the new forester is verified to be running).
ghola admin set_forester_set --slot <0..3> --pubkey 11111111...11111
ghola admin accept_forester_set  # after timelock
```

### Emergency rotation (compromise)

The forester key compromise is **higher severity** than relayer
compromise: an attacker holding the forester key can produce a valid
`update_root_via_proof` tx, which advances the on-chain Merkle root
to an attacker-chosen value. Combined with a valid prover this lets
the attacker insert arbitrary commitments into the tree.

**Mitigations layered above the key**:
- The forester ix is `has_one`-gated to `pool_config.forester_set`.
- The forester proof binds `old_root == tree.root` and
  `start_index == tree.next_index`, so an attacker cannot publish a
  proof against a stale state.
- The `forester_set` is timelocked. An attacker compromising the
  forester key cannot also rotate themselves in / out on demand.

Emergency procedure:

1. Use the pause-authority (see GOVERNANCE.md) to halt the on-chain pool.
   This blocks ALL state-advancing ixs including `update_root_via_proof`.
2. Use the on-chain governance `cancel_proposal` ix if a malicious
   `set_forester_set` proposal is in flight. (If the attacker holds
   the admin key too, this is a much larger incident — see the admin
   key section.)
3. Generate a new forester keypair on an air-gapped machine.
4. Propose `set_forester_set` to swap the compromised slot to the
   new pubkey. Wait the 48h timelock.
5. Accept. Restart the indexer with the new keypair.
6. Resume pool operation.

### Forensic notes

- The forester signer never holds spending power over user funds.
- The forester signer cannot replay an old proof (the proof binds
  `old_root` which is checked against current chain state).
- All compromise scenarios reduce to "attacker can rebuild the tree
  state at-will", which is mitigated by:
  - On-chain root validation against `tree.root_history` on every
    spend (see SPEC.md §3).
  - The pause-authority's ability to halt before drain.

## 1.5 Prover proving key (transfer + forester zkey)

The proving key (`circuit_final.zkey` / `batchedUpdate_final.zkey`) is
**not a secret** in the traditional sense — it is published and signed
as part of the ceremony output. The threat model concerns:

1. **Integrity**: a malicious provider swapping the zkey for a backdoored
   one. Defense: the on-chain `verifier_key_hash` is the canonical
   commitment; any zkey whose derived verification key doesn't match
   on-chain `verifier_key_hash` will produce proofs that fail on-chain
   verification.
2. **Availability**: the zkey is large (~50 MB for depth-26). Mirror
   it across multiple regions. Pinned in the repo at
   `crates/said-shielded-pool-circuits/ceremony/`.
3. **Forward-compatibility**: a circuit change rotates the zkey, which
   in turn rotates the on-chain verifier key. This is the heaviest
   rotation in the system.

### Rotation procedure (per circuit revision)

This is the cross-stream-coordinated procedure. **Read the entire
section before starting.**

```text
Phase 0 — Preparation
  - Decide on the circuit change. Discuss in the spec channel.
  - Update `crates/said-shielded-pool-circuits/*.circom`.
  - Recompile: `circom transaction.circom --r1cs --wasm --sym`.
  - Verify the new R1CS constraint count is within the on-chain
    syscall budget for `alt_bn128_pairing`.

Phase 1 — Phase-2 ceremony
  - Phase-1 ptau is reused (Aztec ignition / Hermez ceremony output).
  - Phase-2 contributions: at minimum 3 independent participants,
    each contributing entropy from a sealed envelope.
  - Use `snarkjs zkey contribute <prev.zkey> <next.zkey> -e <entropy>`
    for each round.
  - Final `beacon` step: deterministic public randomness (e.g.
    a future Bitcoin block hash + height committed in advance).
    See https://github.com/iden3/snarkjs#groth16
  - Burn contributor laptops (or use ephemeral cloud VMs that are
    destroyed after the contribution).
  - Output: new `circuit_final.zkey` + `verification_key.json`.
  - Publish SHA-256 of both alongside the ceremony transcript.

Phase 2 — On-chain proposal (timelocked)
  - Compute the new `verifier_key_hash`:
      sha256(verification_key.json)
  - Submit `propose_vk_rotation` ix with the new hash. Sets
    `pending_vk_hash = Some(<hash>)` and `vk_change_eta = now + 48h`.
  - During the timelock window, third parties verify:
      1. The ceremony transcript reproduces.
      2. The new zkey + vk derive the same hash.
      3. Test proofs (a public test vector) verify on-chain via a
         dry-run on a localnet fork.

Phase 3 — Accept on-chain
  - After 48h: `accept_vk_rotation`. Writes the new hash to live
    `pool_config.verifier_key_hash`.
  - Also rewrites the on-chain `VerifierKey` PDA with the new bytes
    (this is a separate, larger ix; consult GOVERNANCE.md).

Phase 4 — Prover deployment
  - Deploy the new zkey + wasm + vk to all prover instances.
  - Old prover instances continue to produce proofs that the on-chain
    program will REJECT (since `verifier_key_hash` no longer matches).
  - Update relayers / clients to point at new prover URLs (if you
    are rolling out a versioned API surface).

Phase 5 — Burn the old artifacts
  - Old `circuit_final.zkey` is published (not secret) but the
    ceremony participants' contribution-side state MUST be destroyed.
  - Sealed-envelope entropy: shred the physical sources, verify by
    cross-quorum sign-off.
```

### Emergency rotation (suspected ceremony compromise)

If you suspect the trusted setup was compromised — e.g. all
contributors colluded — the only honest mitigation is to redo the
ceremony from scratch with a different participant set. There is no
"hot-swap" path for a backdoored zkey.

Until the new ceremony is published, pause the pool via the
pause-authority.

## 1.6 On-chain verifier key

Stored at: `programs/said-shielded-pool` `VerifierKey` PDA.

Rotation is bundled with the proving-key rotation (Phase 2-3 above).
The on-chain ix is **timelocked** per Stream 4 governance:

- `propose_vk_rotation(new_hash)` — writes to pending state with eta.
- `accept_vk_rotation()` — only callable after `vk_change_eta`.
- `cancel_proposal()` — admin-callable, idempotent.

The handoff with governance: this runbook trusts that the governance
program correctly enforces the timelock and admin gating. See
`docs/shielded-pool/GOVERNANCE.md` for the authoritative description.

## 1.7 Admin key (Solana keypair, off-chain custody)

The `PoolConfig.admin` is the most powerful key in the system:

- Can propose verifier-key rotation.
- Can propose admin rotation (timelocked self-replacement).
- Can update fee parameters.
- Can sweep accumulated protocol fees.

Custody recommendation: **Squads multisig** with a 3-of-5 threshold.
The Squads PDA is the admin; rotating any single signer is a Squads
internal operation that does NOT require pool-level state changes.

Emergency: if a Squads signer key is compromised, the remaining 4
signers can rotate via Squads. No pool-level rotation needed unless
all 5 keys are compromised — in which case use the pause-authority
to halt and then deploy a new program (treats as a re-launch).

## 1.8 Pause-authority key

A separate, **warm-wallet** Solana key with the single privilege of
calling `set_paused(true)`. Held by the on-call rotation. Not
timelocked (incident response must be fast).

Rotation: any time a person leaves on-call rotation. Use the admin
key to call `set_pause_authority(new_pubkey)`.

## 1.9 Client spending keys

End-user keys live entirely on the client side. The reference client
(`crates/said-shielded-pool-client`) stores keys in:

- `SpendingKey` (32 bytes, `#[zeroize(drop)]`)
- `FullViewingKey { ak, nk }` (64 bytes total, derivable from
  spending key)
- `IncomingViewingKey` (32 bytes, derivable from FVK)

The user-facing keystore implementation is downstream of this crate
(e.g. ghola-mobile uses the Android KeyStore + Turnkey HSM stack;
see `MEMORY.md`). Rotation is user-driven; the protocol does not
enforce one.

If a spending key is compromised: the user MUST drain all notes
owned by that key into a fresh key before the attacker does. This is
a wallet-level operation, not a pool-level one.

## 1.10 API tokens

**None today.** Future placeholder: if we add bearer-auth to the
prover or relayer HTTP endpoints (e.g. for rate-limiting partner
integrations), tokens will be:

- Generated via `rand::thread_rng().fill_bytes(&mut [u8; 32])`
- Hashed with Argon2id at rest.
- Tagged in logs via `common_secrets::ScrubbedString` (first 6 hex
  characters of the SHA-256, followed by `…`).
- Rotated on a 30-day cadence; revocation via deletion from the
  hashed-token table.

## 1.11 Ceremony beacon entropy

The Phase-2 ceremony uses three sources:

1. **Participant entropy** (sealed envelope per participant, shredded
   after contribution).
2. **Public beacon** (deterministic, committed-in-advance — e.g. a
   future Bitcoin block hash at a specific height).
3. **Hash composition** via snarkjs's `zkey beacon` step.

The participants' entropy is held by the participants until shredded;
the beacon entropy is public after the fact. Neither is stored in
this repo.

For the production ceremony, contribution receipts (the public
transcript) are stored in
`crates/said-shielded-pool-circuits/ceremony/transcript/`. The
sealed contributions themselves are NEVER committed.

## 1.12 Quick reference — what to do RIGHT NOW

| Incident                              | First action                                       | Then                          |
| ------------------------------------- | -------------------------------------------------- | ----------------------------- |
| Relayer key suspected compromised     | `systemctl stop ghola-relayer` + drain SOL         | Plan-step §1.3 "emergency"    |
| Forester key suspected compromised    | Pause pool (warm-wallet key)                       | Plan-step §1.4 "emergency"    |
| Admin key (single Squads signer) lost | Rotate via Squads UI (3-of-5 majority still works) | No pool action needed         |
| All admin keys (5-of-5) compromised   | Pause pool, halt deployment                        | Re-launch                     |
| Pause-authority key lost              | Use admin to set new pause-authority               | No pool action otherwise      |
| Verifier-key rotation needed          | Phase-0 of ceremony procedure                      | See §1.5                      |
| Ceremony participant compromised      | Halt rollout, redo ceremony                        | See §1.5 "Emergency rotation" |

## 1.13 Cross-stream dependencies

- Verifier-key rotation requires the governance ixs from
  `GOVERNANCE.md` (`propose_vk_rotation`, `accept_vk_rotation`, timelock).
- Forester-set rotation requires `set_forester_set` from `GOVERNANCE.md`.
- Pause-authority delegation requires `set_pause_authority` from
  `GOVERNANCE.md`.
- The Hardening Evidence Gate (Stream 10) consumes the SHA-256 of
  this document as part of the rotated-keys attestation bundle.

---

# Part 2 — Logging

> Folded from `LOGGING.md` 2026-05-24; canonical home is this section.

Pairs with `crates/common-log/`, `clippy.toml`, and the leak test in
`crates/common-log/tests/leak_test.rs`.

The shielded pool's whole reason for existing is to make the link
between a depositor and a recipient computationally hard to recover.
**Logging is the most common way that property gets undermined in
practice.** A single `tracing::info!("transfer {amount} → {recipient}")`
that an operator forgot to redact can compromise an entire fleet's
privacy posture for as long as that log line sits in a shipper's S3
bucket. This document is the contract every off-chain crate is expected
to honor.

## 2.1 Levels and what each one MAY emit

| Level   | When it runs in prod              | What's allowed                                                                                            |
|---------|-----------------------------------|-----------------------------------------------------------------------------------------------------------|
| `ERROR` | always                            | error category only (the `thiserror` Display, never the wrapped value of a deny-listed field)             |
| `WARN`  | always                            | same as ERROR plus aggregate counters (`attempts`, `max_retries`)                                         |
| `INFO`  | default `RUST_LOG=info`           | structural integers (`queue_depth`, `batch_size`), abstract enums (`reason`), latencies, network addresses |
| `DEBUG` | only for focused investigation    | INFO + `ScrubbedString` prefixes of deny-listed values (6 hex chars + `…`)                                |
| `TRACE` | dev environments ONLY             | DEBUG + circuit-internal state; MUST NOT be enabled on a relayer that talks to a real network             |

The default-on-startup is INFO. The `tracing-subscriber` env filter
reads `RUST_LOG`; operators who need DEBUG for an incident set
`RUST_LOG=said_shielded_pool_relayer=debug` and revert as soon as the
investigation is over.

## 2.2 Deny-list of field names

These field names — anywhere in the off-chain stack — are presumed to
carry secret or linkable values. The `common_log::redact::RedactionLayer`
substitutes:

- `<redacted>` at `INFO` and stricter (more severe) levels,
- a `ScrubbedString` (first 6 hex chars of the value's UTF-8 bytes,
  followed by U+2026 `…`) at `DEBUG` / `TRACE`.

```
recipient            recipient_pubkey     amount
commitment           nullifier            proof
proof_a              proof_b              proof_c
spending_key         sk                   viewing_key
ivk                  fvk                  nk
witness              signature            tx_signature
signing_key
```

Match is **exact**. `recipient_b58` is **not** auto-redacted — every
emit site is catalogued explicitly in the audit (§ 2.4 below). Adding an
alias to the list is a conscious act because the layer's redaction has
side effects (e.g. `amount` being structurally an integer is rewritten
even though integers aren't secret on their own — the deny-list is
keyed by NAME, not type).

## 2.3 Recipe for new code

```rust
use common_log::{tracing, scrub_pubkey, scrub_hex};

// Initialize once in main():
common_log::init()?;

// Emit structurally:
tracing::info!(queue_depth = depth, "withdrawal accepted");

// When a value is sensitive, redact at the call site too:
tracing::debug!(
    signature = %common_log::scrub_str(&sig_b58),
    "tx submitted (debug-only sig prefix)"
);
```

Forbidden patterns (`clippy.toml`):

- `println!` / `print!` — use `tracing::info!`
- `eprintln!` / `eprint!` — use `tracing::error!`
- `dbg!` — use `tracing::debug!`

The bans apply workspace-wide. The escape hatch is
`#[allow(clippy::disallowed_macros)]` with a one-line justification —
e.g. the `gen-vectors` CLI binary uses `eprintln!` because it's a
build-time developer tool that runs on the operator's laptop, never on
a production host.

## 2.4 Audit findings (2026-05-23)

This audit walks every `tracing::*`, `msg!`, `println!`, `eprintln!`,
and `dbg!` site in the six off-chain crates that touch shielded-pool
state. Sites NOT listed below were inspected and left unchanged
because they are structurally safe (counts, addresses, error
categories, queue ids that the audit document explicitly permits at
DEBUG).

### said-shielded-pool-types

No live `tracing` sites. No `println!` / `dbg!` outside `#[cfg(test)]`.

### said-shielded-pool-client

No live `tracing` sites (the client is consumed as an SDK; callers
provide their own subscriber).

### said-shielded-pool-prover

- `src/main.rs` — boot logs (`port`, `artifacts_dir`, `backend`,
  `addr`). All structural; left at INFO.
- `src/backend/snarkjs.rs:439` — `tracing::warn!(args, timeout_ms, ...)`
  on subprocess timeout. `args` is the snarkjs CLI argv (paths to
  artifacts on disk, never input.json contents). Left at WARN.
- `src/backend/snarkjs.rs:428` — **CHANGED.** The subprocess error
  arm previously embedded the child's raw stderr in the
  `BackendSpawnFailed` error message. Snarkjs is known to echo
  `input.json` contents on validator failure, and `input.json`
  contains the spending key in the clear. Wrapped the stderr in a new
  `redact_stderr` helper (also added unit tests) that truncates to
  1024 chars and rewrites any run of ≥16 hex digits or ≥32 decimal
  digits to `<hex-redacted N>` / `<dec-redacted N>`. False positives
  are diagnostic noise; false negatives would be key leaks.

### said-shielded-pool-relayer

- `src/error.rs:50` — DEBUG-only Display of the error type. The
  `Submit(String)` and `Rpc(String)` variants are constructed by the
  submitter from RPC responses; reviewed and confirmed they never
  embed recipient/amount/proof. Left as-is.
- `src/routes.rs:109` — `"relay rejected: queue_full"` at DEBUG.
  INFO would create a (weak) timing side-channel on the rejection
  rate. Left at DEBUG.
- `src/routes.rs:156` — `tracing::info!(queue_depth = …, "withdrawal accepted")`.
  No recipient, no amount, no id at INFO. Confirmed clean.
- `src/routes.rs:157` — id at DEBUG only. The id is what the client
  sees in the response, so cross-correlation between an INFO log and
  the client response requires DEBUG to be on. Confirmed.
- `src/batcher.rs:88` — INFO log of `size` and `reason` only.
  Confirmed no per-item fields.
- `src/batcher.rs:61, 137` — WARN with `error = %e`. Tickled by the
  redaction layer because `error` is not on the deny-list and the
  Display of the relayer's `Error` is a category string — confirmed
  by re-reading `src/error.rs`.
- `src/submit.rs:320, 443, 474` — DEBUG/WARN with `error = %e` and
  `attempts`/`max`. No fields on the deny-list. Confirmed.
- `src/decoy.rs:49, 53, 67, 70` — startup banner + DEBUG ack + WARN
  error. No sensitive fields.
- `src/main.rs:25-32` — boot banner; `port`, thresholds, batch size,
  delays, decoy rate. All operator-supplied policy, no secrets.
- `src/main.rs:75` — `"shutdown signal received; zeroizing signer"`.
  No fields. Confirmed.

No relayer site was modified. Audit conclusion matches Stream 7's
recon ("relayer's INFO logs were already clean").

### said-shielded-pool-indexer

- `src/main.rs:32` — boot banner with `rpc`, `ws`, `db`, `port`,
  `program`, `forester` enabled flag. Operator-supplied, no secrets.
- `src/main.rs:61, 65, 90, 94, 101-106` — backfill counts, listener
  bind address, task-exit warnings. Confirmed clean.
- `src/listener.rs:49, 52, 131` — backoff + insert error category
  messages. No deny-listed fields.
- `src/listener.rs:130` — `debug!(idx, "inserted commitment")`. The
  message string mentions "commitment" but the FIELD is `idx` (the
  position in the Merkle tree, public state). False-positive grep hit
  for the deny-list. Confirmed clean.
- `src/backfill.rs:49, 53, 122` — pagination + total counts. Clean.
- `src/forester/mod.rs:103` — **ANNOTATED.** Added a `// SAFE:` comment
  documenting that the `keypair` field is the on-disk FILE PATH
  (operator-supplied config), not the key bytes.
- `src/forester/mod.rs:138, 311` — **ANNOTATED.** Added a `// SAFE:`
  comment documenting that `old_root` / `new_root` are public Merkle
  roots, not commitments or nullifiers.
- `src/forester/mod.rs:355` — **CHANGED.** Demoted the INFO log
  carrying the tx `signature` to DEBUG and wrapped the value in
  `common_log::scrub_str(&signature)`. Operators correlate root-update
  txs by `new_root` (which is logged at INFO from the build-tx site,
  i.e. line 311); the full signature is only required at DEBUG for
  focused investigation.
- `src/forester/mod.rs:368-373` — **CHANGED.** Split the confirmation
  INFO into two events: a DEBUG carrying the scrubbed signature, and
  an INFO carrying a renamed `confirmation_status` field (the
  previous name `commitment` was overloaded with the cryptographic
  term and would have tripped the redaction layer).

### said-shielded-pool-testvectors

- `src/main.rs:27, 43, 68` — `eprintln!` from the dev CLI. This is
  a developer-machine tool that writes test vectors to disk; output
  goes to the terminal, not to a structured log pipeline. Marked
  with `#[allow(clippy::disallowed_macros)]` exemption is **not yet
  applied** — see § 2.5 below.

## 2.5 clippy.toml impact

`clippy.toml` at workspace root bans `std::dbg`, `std::print`,
`std::println`, `std::eprint`, `std::eprintln`. The bans apply
workspace-wide.

The shielded-pool stack uses `eprintln!` legitimately in
`crates/said-shielded-pool-testvectors/src/main.rs` (a developer CLI
binary, not a production service) and in
`crates/said-shielded-pool-indexer/src/events.rs:345` (inside a
`#[test]` for an IDL consistency check that prints a skip notice).
These will trip `cargo clippy --workspace -- -D warnings`. The
remediation, scoped beyond this stream's window, is to either:

1. Add `#[allow(clippy::disallowed_macros)] // dev CLI tool, not prod`
   above each affected call site, OR
2. Migrate the test-vectors CLI to `tracing::info!` (overkill for a
   one-shot writer, but it would let the workspace pass clippy
   strictly).

Recommended path: option (1), single-line allow comments.

## 2.6 Metrics label allowlist

Prometheus labels are the second-largest source of accidental privacy
leaks (after free-form log strings). The relayer's metric surface
uses **zero labels** — every exposed series is a pre-bucketed gauge or
counter. The structural allowlist is:

| Abstract key         | Concrete metric(s)                                            |
|----------------------|--------------------------------------------------------------|
| `queue_depth`        | `relayer_queue_depth`                                        |
| `anonymity_set_size` | `relayer_anonymity_set_size_last`                            |
| `latency_bucket`     | `relayer_submit_latency_ms_p50`, `relayer_submit_latency_ms_p99` |
| `decoy_count`        | `relayer_decoy_tx_count_total`                               |

Plus structurally-safe counters:
`relayer_submit_success_total`,
`relayer_submit_failure_total`,
`relayer_submit_success_rate`.

Enforced by
`crates/said-shielded-pool-relayer/tests/metric_labels.rs`, which
parses the rendered exposition and asserts:

- no metric line contains a `{...}` label suffix
- every metric name is on the allowlist
- no rendered output contains any deny-listed field name as a substring

## 2.7 Cross-references

- `SECURITY.md` § "Information leakage" — threat model for log-channel
  side-channels.
- `docs/shielded-pool/SPEC.md` § "Privacy properties" — formal
  statement of the unlinkability invariant this policy protects.
- `crates/common-secrets/src/scrubbed.rs` — `ScrubbedString` format
  and entropy budget.
- `crates/chaos-tests/` (Stream 6) — failure-mode harness that
  produces stderr from misbehaving mock backends; relies on the
  `redact_stderr` helper introduced here.
- `crates/said-shielded-pool-relayer/src/dedup.rs` (Stream 3) —
  any new `debug!` emits from dedup wrap proof-bundle hashes in
  `scrub_hex`.

---

# Part 3 — Supply chain

> Folded from `SUPPLY_CHAIN.md` 2026-05-24; canonical home is this section.

**Scope:** the Ghola Solana-native shielded pool (program
`5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A` on devnet) and every
workspace crate, web app, and circom artifact that feeds into its
deployment. This section is normative for auditors. If a step here
disagrees with code, the audit lead is the tiebreaker; raise an issue
and update both.

## 3.1 Charter

Three goals, in priority order:

1. **No known-vulnerable dep ships.** Every advisory in the RustSec
   database is either patched, ignored with a documented rationale, or
   blocks merges. The `npm` and `cargo` ecosystems are both gated.
2. **Provenance is auditable.** Every release tag publishes a signed
   SBOM, a SLSA Provenance v0.2 attestation for each Anchor program
   build, and an on-chain match check that proves the deployed `.so`
   matches the attested artifact.
3. **No surprise sources.** Crates and npm packages come only from the
   canonical registries; git deps are rejected unless individually
   allow-listed in `deny.toml` with a paragraph here.

## 3.2 Tooling matrix

| Concern             | Tool                                                   | Location                                          | CI gate                                |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------- | -------------------------------------- |
| Cargo advisories    | `cargo audit`                                          | `.cargo/audit.toml`                               | `.github/workflows/supply-chain.yml`   |
| Cargo policy        | `cargo deny check`                                     | `deny.toml`                                       | `.github/workflows/supply-chain.yml`   |
| Node advisories     | `npm audit --audit-level=high`                         | every tracked `package-lock.json`                 | `.github/workflows/supply-chain.yml`   |
| snarkjs pinning     | `jq` assert exact version                              | `crates/said-shielded-pool-circuits/circuits/package.json` | `.github/workflows/supply-chain.yml` |
| Rust SBOM           | `cargo cyclonedx`                                      | per-crate output                                  | `.github/workflows/sbom.yml`           |
| Full-tree SBOM      | `syft -o cyclonedx-json`                               | `artifacts/sbom/full-<commit>.json`               | `.github/workflows/sbom.yml`           |
| SBOM signing        | `cosign sign-blob` (keyless OIDC)                      | `artifacts/sbom/full-<commit>.json.sig`           | `.github/workflows/sbom.yml`           |
| Build provenance    | `scripts/build-attestation.sh`                         | manual (CI integration in Phase-46)               | manual                                 |
| Deploy verification | `scripts/verify-deploy.sh`                             | manual (CD integration in Phase-46)               | manual                                 |

Install everything with `make -f Makefile.hardening tools-install`.

## 3.3 Dependency-addition policy

A new workspace dep is added in three steps:

1. **Propose** the dep on the PR. The PR description must include:
   - the crate's MSRV (compatible with our toolchain pin),
   - its license SPDX (must intersect with the allow-list in `deny.toml`),
   - any `unsafe` blocks in the crate (cargo-geiger output, when applicable),
   - the immediate maintainer activity (last release date, open
     advisories, archived flag).
2. **Validate** locally:
   ```bash
   cargo update -p <crate>
   cargo deny check
   cargo audit
   ```
   Both commands must exit 0. If they don't, fix the cause (preferred)
   or document an ignore with a one-paragraph rationale in `deny.toml`
   AND this document (Section 3.10).
3. **Land** with the supply-chain CI green. Once merged, the new dep is
   included in the next nightly SBOM.

The same flow applies to `npm` packages, with `npm audit --audit-level=high`
in place of `cargo audit`.

## 3.4 Audit cadence

| Cadence  | Action                                                                                       |
| -------- | -------------------------------------------------------------------------------------------- |
| Per-PR   | `cargo deny check`, `cargo audit`, `npm audit`, snarkjs pin check — `.github/workflows/supply-chain.yml`. |
| Nightly  | Same suite, on schedule cron (`0 6 * * *` UTC). Picks up fresh RustSec advisories.           |
| Monthly  | Manual review of `[bans].multiple-versions = "warn"` output. Squash duplicates where a clean upgrade exists. |
| Per-tag  | Full SBOM regeneration (`.github/workflows/sbom.yml`) plus cosign signing.                   |
| Per-deploy | `scripts/verify-deploy.sh <program_id> <cluster> <local_so>` before flipping any production traffic. |

## 3.5 SBOM publish + retention

- **What:** one CycloneDX 1.x JSON per workspace member (cargo-cyclonedx),
  one combined CycloneDX JSON for the whole repository (syft), and a
  cosign signature blob (`.sig`) + certificate (`.pem`) of the combined
  SBOM.
- **When:** every push to a tag matching `v*` or `audit-*`, and on
  `workflow_dispatch`.
- **Where:** uploaded as a GitHub Actions artifact named
  `sbom-<short_sha>`, retained 90 days. The signed combined SBOM is also
  hashed into `MANIFEST.sha256` for Stream 10 (Evidence Gate) ingestion.
- **Verification:** `cosign verify-blob --certificate-identity-regexp
  "^https://github.com/<owner>/<repo>/.+" --certificate-oidc-issuer
  "https://token.actions.githubusercontent.com" --signature <sig>
  <sbom.json>`. The `cosign-verify` job in supply-chain.yml runs this
  automatically on tag push.

## 3.6 Cosign signing + key rotation

We use **cosign keyless** signing with the GitHub OIDC identity issuer.
There is no long-lived signing key on disk; each signature embeds a
short-lived Fulcio certificate bound to the workflow run's OIDC token.

Implications:

- **No key rotation procedure needed** in the conventional sense — the
  signing identity is `https://github.com/<owner>/<repo>/.github/workflows/sbom.yml@<ref>`,
  which rotates implicitly on every push.
- **Identity validation** is done at verify time with
  `--certificate-identity-regexp` and `--certificate-oidc-issuer`. The
  regex in `supply-chain.yml` accepts any workflow run from this repo.
- **Compromise response:** if the GitHub Actions identity is compromised,
  revoke the OIDC token at the GitHub org level and re-sign all tagged
  SBOMs from a clean runner.

If we ever need to switch to **key-based** signing (e.g. for an offline
release artifact), the procedure is:

1. Generate a Sigstore key pair on a hardware token (YubiKey 5) via
   `cosign generate-key-pair --hardware`.
2. Publish the public half to `docs/shielded-pool/SIGNING_KEYS.md`
   alongside its fingerprint.
3. Rotate annually OR on suspicion of compromise, whichever is first.
4. Treat the private half as a Class-A secret (see Part 1 above).

## 3.7 Toolchain pinning

### 3.7.1 Solana / cargo-build-sbf

The repo supports **two** cargo-build-sbf installations:

| Path                                                              | Version          | Rust          | Used for                                       |
| ----------------------------------------------------------------- | ---------------- | ------------- | ---------------------------------------------- |
| `~/.cargo/bin/cargo-build-sbf`                                    | 4.1.0 (Anza)     | 1.89 / 1.93   | All Phase-44+ builds (edition 2024 capable)    |
| `~/.local/share/solana/install/active_release/bin/cargo-build-sbf`| 1.18.x (legacy)  | 1.75 / 1.79   | Orni programs (historical compat only)         |

The shielded-pool program **must** build with the modern Anza toolchain.
The legacy Solana 1.18 toolchain is rustc 1.79 and rejects edition 2024
crates that the shielded-pool pulls in (notably `constant_time_eq 0.4.2`).
Override `PATH` explicitly in CI:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo build-sbf --manifest-path programs/said-shielded-pool/Cargo.toml
```

If a future build needs the legacy toolchain (e.g. to reproduce an old
artifact), `verify-deploy.sh` will surface the resulting hash mismatch.
See `scripts/build-attestation.sh` which records the active toolchain
version in the SLSA provenance.

### 3.7.2 Node / snarkjs

The trusted-setup tool snarkjs MUST be pinned to an exact version in
`crates/said-shielded-pool-circuits/circuits/package.json`. A `^` or `~`
range allows a non-reproducible setup-tool upgrade to slip in via a
fresh `npm install`, which would change witness generation behavior
without a corresponding circuit re-audit.

The `snarkjs-pin-check` job in `supply-chain.yml` enforces this with a
`jq` script. Any change to the snarkjs version requires:

1. Re-running the trusted-setup ceremony against the new tool version.
2. Re-publishing the `verification_key.json` and updating
   `programs/said-shielded-pool/src/verifier/key.rs`.
3. A note in `GOVERNANCE.md` (Runbooks) covering the rotation.

## 3.8 License allow-list rationale

Every license in `deny.toml`'s `[licenses].allow` list:

- **MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD** — standard
  permissive licenses. No copyleft, compatible with the workspace's
  `MIT OR Apache-2.0` dual-license declaration.
- **MIT-0** — public-domain-equivalent variant of MIT used by a handful
  of small utility crates.
- **Unicode-DFS-2016 / Unicode-3.0** — required by `unicode-ident` (used
  by `syn`/`quote`) and ICU 73+. Permissive with a non-onerous data
  attribution clause.
- **MPL-2.0** — file-scope copyleft. Acceptable because the workspace
  does not modify MPL-2.0 files (webpki / encoding-rs are used unchanged).
- **OpenSSL** — historical license text for `ring`'s vendored BoringSSL
  fork. Permissive in practice; modern rustls is the consumer.
- **CC0-1.0** — public-domain dedication. Used by `tiny-keccak`.
- **Zlib** — used by `adler` / `miniz_oxide`. Trivially permissive.
- **CDLA-Permissive-2.0** — used by some data-only crates. Permissive
  per the SPDX classification.
- **BSL-1.0** — Boost Software License, used by `xxhash-rust`.
  Permissive, no attribution requirement.
- **WTFPL** — appears in a single transitive dev-dep. Permissive to the
  point of triviality.

Explicit per-crate exceptions are documented inline in `deny.toml`.

## 3.9 Banned-crate rationale

The `[bans].deny` block in `deny.toml`:

- **`curve25519-dalek < 4.1.3`** — fixes the
  [Scalar::invert timing attack][curve25519-cve]. The shielded-pool's
  prover, indexer, and client all rely on constant-time scalar ops; an
  older version would introduce a side-channel via the BN254/curve25519
  bridging code.
- **`ed25519-dalek < 2.0.0`** — 1.x predates the explicit
  context-string break that mitigates the Chalkias double-sig attack.
  All on-chain signatures are validated by Solana with 2.x semantics; a
  client signing with 1.x would produce signatures that fail verification
  in a subtle, ambiguous way.
- **`chrono < 0.4.31`** — fixes the
  [localtime_r unsoundness on Linux][chrono-cve]. Affects every host
  service.
- **`time < 0.2.0`** — `time 0.1.x` is unmaintained and depends on the
  same unsound localtime path that `chrono` ships its own fix for.

Notably absent: a ban on the Rust `openssl` crate. The Ghola workspace
prefers `rustls + ring`, but `openssl 0.10.x` is pulled in transitively
via `native-tls -> reqwest` and is itself actively maintained. A
version-range ban on the Rust `openssl` crate would also be misleading —
the Rust crate version is unrelated to the OpenSSL C library version.
We rely on RustSec advisories to surface concrete CVEs against either
the crate or the underlying C library.

[curve25519-cve]: https://rustsec.org/advisories/RUSTSEC-2024-0344
[chrono-cve]: https://rustsec.org/advisories/RUSTSEC-2020-0159

## 3.10 Documented advisory ignores

Each ignored advisory in `.cargo/audit.toml` and `deny.toml`:

### RUSTSEC-2023-0071 — sqlx-mysql RSA timing

The `rsa` crate has a known timing side-channel in CRT modular
exponentiation. `sqlx-mysql` invokes it during MySQL's TLS auth
handshake. Ghola services compile sqlx with only the `postgres` and
`sqlite` features; the MySQL TLS-auth path is unreachable. The current
resolved graph may not contain `sqlx-mysql` at all (in which case
cargo-deny reports `advisory-not-detected` — kept as documented intent).
No upstream `rsa`-crate fix has been released; the fix requires
constant-time CRT exponent reconstruction.

### RUSTSEC-2026-0009 — time 0.3.x localtime_r soundness

The fix in time-macros 0.2.27 transitively requires edition 2024 via
`constant_time_eq 0.4.2`. The Ghola workspace is pinned to edition 2021
(`workspace.package.edition`) because bumping to 2024 surfaces
pattern-binding-modifier changes across many existing crates
(ghola-cloud, etc.). Migration is tracked as a focused pass.

### RUSTSEC-2024-0388 — `derivative` unmaintained

Compile-time `Derive` macro with no runtime surface. Pulled in via
`solana-program` / `borsh-derive` forks. No exploitable behavior.

### RUSTSEC-2024-0384 — `instant` unmaintained

Replaced by `std::time` on host targets. Appears only in the old
`parking_lot 0.11` transitive dep from Solana BPF tooling.

### RUSTSEC-2024-0436 and RUSTSEC-2025-0057 — `paste` / `fxhash` unmaintained

`paste` is a macro-only crate (no runtime surface). `fxhash` is a
non-cryptographic in-memory hash, pulled in by `solana-program`.

### RUSTSEC-2025-0134 — `rustls-pemfile` unmaintained

Functionality has moved into `rustls-pki-types 1.9+`. Used by
`axum-server 0.7` transitively; safe to use as a thin wrapper.
Migration tracked in axum-server upstream.

### RUSTSEC-2026-0097 — `rand 0.8.5` soundness

Only triggered by a specific custom-logger pattern (`rand::rng()` with
a user-defined `Allocator` capturing the same thread-local state); not
present anywhere in the Ghola workspace. Migration to `rand 0.9`
tracked separately.

## 3.11 Operator runbooks

### 3.11.1 Verify a deployed program matches a local build

```bash
scripts/verify-deploy.sh \
  5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A \
  https://api.devnet.solana.com \
  programs/said-shielded-pool/target/deploy/said_shielded_pool.so
```

Exit code:

- `0` — sha256 of on-chain bytes matches the local `.so`. Safe to flip traffic.
- `1` — mismatch. Do NOT deploy or flip traffic. Run
  `solana program show --output json` and compare commits; if the
  on-chain program is at an older revision, that is the expected state
  before a deploy. If it is at an unknown revision, escalate.
- `2` — toolchain/RPC error. Retry on a different RPC endpoint.

### 3.11.2 Emit a build attestation

```bash
anchor build  # produce target/deploy/said_shielded_pool.so
scripts/build-attestation.sh said-shielded-pool > attestation.json
cosign attest-blob --predicate attestation.json --type slsaprovenance \
       --output-signature attestation.sig target/deploy/said_shielded_pool.so
```

Store the resulting `attestation.json` and `attestation.sig` alongside
the SBOM bundle under `artifacts/sbom/`.

### 3.11.3 Respond to a new advisory

1. `cargo audit` (or wait for nightly CI) reports a new advisory.
2. Triage:
   - **Patchable** (upstream has a fixed version): bump the dep and
     submit a PR. CI must go green.
   - **Not exploitable in our context**: document an ignore in
     `.cargo/audit.toml` AND `deny.toml` AND this file (Section 3.10).
   - **Exploitable**: file an incident ticket, kick off an emergency
     deploy (see `GOVERNANCE.md` Runbooks).
3. Update this section with the resolution before closing the ticket.

## 3.12 Cross-stream dependencies

This section references:

- `GOVERNANCE.md` (timelocked upgrades, multisig stub, and Runbooks
  covering vk rotation flow).
- Part 1 above (Class-A secret handling for cosign hardware-token keys,
  if ever adopted).
- Stream 10 — Evidence Gate ingestion of `MANIFEST.sha256`.

No code in `programs/`, `crates/`, or other CI workflows is owned by
this section.
