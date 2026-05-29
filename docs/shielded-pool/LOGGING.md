# Shielded-Pool Logging Policy (zero-leakage)

This document states the rules that keep secret and on-chain-linkable values out
of logs, panics, and error bodies across the off-chain crates (relayer, prover,
indexer, client). It is enforced by three independent layers; a leak requires
all three to fail.

## The three layers

1. **Type-level redaction (primary).** Secret- and linkable-bearing types do
   **not** derive `Debug`. They hand-write `Debug` to print either nothing
   (`Note(<redacted>)`, `TransferWitness(<redacted>)`, viewing keys, proofs) or
   a short non-reversible 3-byte tag (`Commitment(deadbe…)`). See the redacting
   `Debug` block at the bottom of `crates/said-shielded-pool-types/src/lib.rs`
   and `common-secrets::{SecretBytes, ScrubbedString}`. Consequence: even a
   stray `{:?}`, a `.expect(...)` payload, or a `#[derive(Debug)]` on an
   enclosing struct cannot dump key material or a full field element.
   `SpendingKey` has **no** `Debug` at all — formatting it is a compile error.

2. **Field-name redaction (defense-in-depth).** The `common-log` `RedactionLayer`
   replaces the *value* of any structured field whose key is on `DENY_LIST`
   (`crates/common-log/src/redact.rs`) with `<redacted>` at INFO/WARN/ERROR and a
   scrubbed 6-hex prefix at DEBUG/TRACE. Match is **exact, case-sensitive** — a
   field named `commitment_count` is not auto-redacted, so adding an alias to the
   list is a conscious act. Keep the list in lockstep with this file.

3. **Macro bans (defense-in-depth).** `clippy.toml` bans `dbg!`, `print!`,
   `println!`, `eprint!`, `eprintln!` — anything that writes to std streams
   unredacted. Use `tracing::{debug,info,warn,error}!` only.

## Rules for contributors

- **Never format a secret as a raw string in a message body.** The field-name
  redactor only touches structured fields, not the `"..."` message. Do NOT write
  `info!("sk={}", hex::encode(sk))`. Pass values as structured fields with a
  deny-listed key (`info!(sk = %x, "...")`) — or, better, log the redacting type
  directly (`debug!(?note)`), which self-redacts via layer 1.
- **Prefer structured fields over interpolation.** `warn!(error = %e, "…")`,
  not `warn!("failed: {e}")`.
- **Amounts are secret here.** `amount`, `public_amount`, `fee`, `relayer_fee`
  are on `DENY_LIST` because clear-text amounts are the dispositive
  deposit→withdrawal linkage (see the Part-2 denomination workstream). Do not
  log them, even at DEBUG, outside a deliberately-gated audit path.
- **New secret/linkable type?** Give it a hand-written redacting `Debug` (layer 1)
  AND add its field name(s) to `DENY_LIST` (layer 2). Add a `format!("{:?}", …)`
  regression test asserting the bytes don't appear (see
  `said-shielded-pool-types::tests::debug_impls_redact_secrets_and_tag_linkables`).

## What is intentionally NOT redacted

Public protocol state that is on-chain-derivable is logged in the clear for
operability and is deliberately kept OFF `DENY_LIST`: Merkle `root` head and
`root_history`, `asset_id`, `leaf_index`, `siblings`/`path_*`, `next_index` /
tree size, coarse `queue_depth`, the ephemeral PUBLIC key (`eph_pk`), and the
coarse-bucketed anonymity-set gauge. These are not secrets; see
`docs/shielded-pool/OPERATIONS.md`. (`commitment` and `nullifier`, though also
on-chain, ARE redacted — logging them next to a request/IP would create
off-chain linkage with no operational upside.)
