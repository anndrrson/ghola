# Shielded Agent Finance — Build State Inventory

A concrete component-by-component inventory of what is shipped, what is
partial, what is stubbed, and what is missing across the **shielded
payment + agent finance** stack. Companion to
[shielded-agent-finance.md](./shielded-agent-finance.md) (the unifying
architecture doc) and [tier-2k-shielded-payments.md](./tier-2k-shielded-payments.md)
(the payment-leg deep doc).

Status tags:

- **shipped** — code exists, compiles, is wired into the request path,
  and has tests or runtime exercise.
- **partial** — code exists but only some of the surface is functional;
  callers still see TODOs, stubs, or missing companion pieces.
- **stubbed** — the type or function exists, but its body is a stub
  (`todo!()`, hard-coded `false`, or returns "not implemented").
- **missing** — referenced by the design but not present in the tree.

All paths are repository-relative. Line numbers are best-effort
snapshots at the time of writing; chase the symbol if drift suspected.

---

## Layer 1 — Settlement-proof wire schema

### `X402SettlementProof` enum + variants

**Status: partial.**

- Location: `crates/said-x402/src/settlement.rs:30-52`.
- Tagged enum with `Solana { signature, payer_pubkey, network }` and
  `AleoShielded { proof_b64, nullifier_hex, epoch }` variants.
- Wire format pinned by golden tests (`settlement.rs:101-167`).
- `kind_tag()` helper returns stable strings (`"solana"`,
  `"aleo_shielded"`).
- `re-export` lives at `crates/said-x402/src/lib.rs:28-29`.

**Gap.** `verify()` is a placeholder that returns
`SettlementVerifyError::SolanaNotRouted` or `AleoNotImplemented` for
both arms (`settlement.rs:72-79`). No caller in the tree routes through
this enum yet — the live shielded validator path is the parallel
`PaymentPayload` flow in `thumper-cloud` (see Layer 4). The enum is
schema-only, exactly as the Tier 2K doc described it would be on its
first PR.

### `X402PaymentPayload` — production-Solana proof

**Status: shipped (Solana arm only).**

- `crates/said-x402/src/lib.rs:36-76`.
- The `from_solana_tx` constructor and `encode()` base64-JSON helper
  are wired into the agent x402 client.
- No `X402AleoPayload` companion variant has been added to this struct;
  callers wanting shielded settlement must use the parallel
  `PaymentPayload` shape in `thumper-cloud` (Layer 4).

**Gap.** The Tier 2K doc proposed extending `X402PaymentPayload` itself
into a tagged enum (§4.2). Instead, the project shipped the standalone
`X402SettlementProof` enum (above) as a side-by-side schema. The two
have not been reconciled — `X402PaymentPayload.payload` is still hard-
typed to `X402SolanaPayload`. A future PR must either fold the new
enum into the payment payload, or formally deprecate one path.

---

## Layer 2 — Adapter HTTP boundary + signed-receipt verification

### Shielded verifier adapter contract

**Status: shipped.**

- Caller side (Rust): `crates/thumper-cloud/src/services/x402_service.rs:1399-1515`
  (`verify_shielded_stablecoin_settlement`).
- Adapter side (TS, Next.js route): `apps/web/src/app/api/aleo-shielded/verify/route.ts:449-701`.
- Health check: `apps/web/src/app/api/aleo-shielded/health/route.ts:54-94`.
- Header binding: `x-ghola-payment-rail: aleo_usdcx_shielded`.
- Adapter request body (`ShieldedVerifyRequest`) defined at
  `x402_service.rs:1172-1184`, with provider/network/asset/destination
  echoed back so the caller can detect tampering.

### Signed-receipt envelope

**Status: shipped.**

- Canonical signed-receipt payload constructor:
  `x402_service.rs:1262-1301` (Rust, expected) and
  `apps/web/src/app/api/aleo-shielded/verify/route.ts:376-404` (TS,
  emitted).
- Ed25519 signature verification: `x402_service.rs:1372-1394`.
- `SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT=true` is the production
  gate (`x402_service.rs:384-388`).
- Adapter response replay defense: receipt+digest+expiry+confirmations
  are signed together so a tampered or stale receipt fails.

### Recipient-supplied receipt mode (`ALEO_RECIPIENT_RECEIPTS_ENABLED`)

**Status: shipped.**

- `apps/web/src/app/api/aleo-shielded/verify/route.ts:245-328`
  (`validateRecipientReceipt`).
- Lets the adapter verify payments to recipients whose private key
  the adapter does **not** hold, by accepting a recipient-signed
  receipt and verifying with `@provablehq/sdk`
  `Address.verify(...)` (`route.ts:594-606`).
- Required because the v1 adapter only knows the configured recipient
  key; arbitrary-recipient sends were originally out of scope.

**Gap.** Recipient-receipt mode is fail-closed by default
(`recipientReceiptsEnabled()` checks both env flags). The receipt
schema (`RECIPIENT_RECEIPT_VERSION = "ghola-aleo-usdcx-recipient-receipt-v1"`)
is undocumented outside the route handler. No companion client tooling
exists to *produce* these receipts on the recipient side.

### Adapter authentication

**Status: shipped.**

- Bearer-token auth: `route.ts:106-128` (`authorizeVerifierRequest`),
  paired with `verifierAuthRequired()` (`route.ts:79-88`).
- Authenticated callers can also resolve their own wallet recipient
  via `/api/wallet/private/recipient` against thumper-cloud
  (`route.ts:111-125`).
- Caller-side bearer injection: `x402_service.rs:1456-1458`.

---

## Layer 3 — Private settlement service (user-held shielded transfers)

### Intent → proof → verified-receipt flow

**Status: shipped.**

- `crates/thumper-cloud/src/services/private_settlement_service.rs:609-706`
  (`create_private_transfer_intent`).
- `crates/thumper-cloud/src/services/private_settlement_service.rs:736-945`
  (`submit_signed_private_transfer`).
- DB tables (referenced in queries): `private_wallet_transfers`,
  `private_wallet_transfer_audit_events`, `private_wallet_receipt_exports`.
- Intent TTL is 10 minutes (`private_settlement_service.rs:16`).
- Policy hash binds amount, recipient hash, network, asset, signing
  mode, signer key, and approval nonce
  (`private_settlement_service.rs:379-393`).
- Signing modes: `turnkey_user`, `aleo_device`,
  `manual_proof` (debug only) (`private_settlement_service.rs:21-23`).
- Signer attestation Ed25519 verification: `private_settlement_service.rs:467-534`.

### Selective disclosure export

**Status: shipped (metadata-only).**

- `crates/thumper-cloud/src/services/private_settlement_service.rs:1039-1108`
  (`export_private_transfer_receipt`).
- Export record persisted to `private_wallet_receipt_exports`.
- Export disclosure text:
  `SELECTIVE_DISCLOSURE_TEXT = "Selective disclosure export includes
  redacted receipt metadata, amount, policy hash, verification time,
  and approval summary. Raw shielded recipient and proof payload are
  not exported by default."`
  (`private_settlement_service.rs:24`).

**Gap.** The "selective disclosure" today is just redacted-metadata
export. There are no **ZK proofs** that "agent spent ≤ X on category Y
in window Z" — only hashed receipt metadata. The naming gets ahead of
the underlying cryptography. See Layer 9.

### Institutional readiness gate

**Status: shipped.**

- `crates/thumper-cloud/src/services/private_settlement_service.rs:1188-1253`
  (`institutional_readiness`).
- Blocks rollout until verifier ready, signer ready, funded smoke test
  passed, server-held signing disabled, audit export enabled, zero
  open High/Critical findings.

---

## Layer 4 — Registry shielded fields

### `aleo_address` + `price_micro_usdc_shielded` on `ModelRecord`

**Status: partial — handlers reference them, storage does not.**

- Doc comments declare the fields:
  `programs/ghola-model-registry/src/lib.rs:27-36`.
- `register_model` instruction accepts both new fields
  (`programs/ghola-model-registry/src/lib.rs:75-76`).
- Pairing invariant enforced in `register_model` and `update_model`
  (`programs/ghola-model-registry/src/lib.rs:93-96`,
  `programs/ghola-model-registry/src/lib.rs:172-175`).
- Handlers assign `model.price_micro_usdc_shielded = ...` and
  `model.aleo_address = ...`
  (`programs/ghola-model-registry/src/lib.rs:117-118`, `:180-181`).
- Events claim a `shielded_available` field
  (`programs/ghola-model-registry/src/lib.rs:129`, `:189`).

**Gap (blocking).** The `ModelRecord` struct definition
(`programs/ghola-model-registry/src/lib.rs:262-277`) **does not**
contain `price_micro_usdc_shielded` or `aleo_address`. `MAX_SIZE`
(`:279-295`) does not budget for them. The `ModelRegistered` and
`ModelUpdated` event structs (`:301-315`) lack `shielded_available`.
The `ModelRegistryError` enum (`:321-333`) does not define
`MissingShieldedPrice`. As written, this file **does not compile** —
the `#[program]` mod refers to symbols the rest of the file does not
declare. Treat the shielded-registry change as an unfinished WIP:
schema half-done in the handler, undeclared in the account/event/error
definitions, no realloc directive on `UpdateModel.model`.

### Realloc plan for existing accounts

**Status: missing.**

- Tier 2K §6 calls for `#[account(mut, realloc = ...)]` on the next
  update of every existing `ModelRecord`. No realloc clause exists in
  `UpdateModel` (`programs/ghola-model-registry/src/lib.rs:241-256`).
- No migration tool / one-shot script in `programs/` or `crates/cli`.

---

## Layer 5 — `said-shielded` crate (Aleo account derivation, transition builder, broadcaster)

**Status: missing.**

- Tier 2K §4.1 names this crate: "Aleo payment library (Rust)".
- `ls crates/` shows no `said-shielded` directory.
- Aleo account derivation from a Turnkey-held Ed25519 identity (Tier
  2K §4.3) lives nowhere in the Rust tree. The only place Aleo keys
  are touched is the verifier adapter (`apps/web/src/app/api/aleo-shielded/verify/route.ts:513-528`)
  which loads a pre-existing private key from env (`ALEO_RECIPIENT_PRIVATE_KEY`).
- Transition build, signing, and broadcast happen **outside Ghola** in
  the current architecture: the user (or a future client) is expected
  to produce the proof and submit it; Ghola only verifies.

**Implication.** Today there is no end-to-end "client → Ghola →
shielded settlement" pipeline. There is only "client → Ghola verifies a
proof you brought yourself." That is deliberate — institutional pilots
require user-held signing — but it leaves the consumer-facing top-up +
auto-pay UX unbuilt.

---

## Layer 6 — Aleo Leo program (`ghola_pay.aleo`)

**Status: missing in-repo.**

- Tier 2K §4.1 lists "minimal `pay` function consuming a record,
  producing a record" as 0.5 wk of work.
- The adapter reads `ALEO_PAYMENT_PROGRAM` from env
  (`apps/web/src/app/api/aleo-shielded/verify/route.ts:482`) and filters
  transitions whose `program` field matches (`route.ts:548`).
- The Leo source for `ghola_pay.aleo` is not in
  `programs/`, not in `crates/`, and not in `apps/`.
- Whether a program is deployed on Aleo mainnet is unverifiable from
  this repo; only the env-var dependency exists.

**Gap.** Without source in-tree, the program's auditability and
content-addressing claims are weaker than `programs/ghola-model-registry`
or `programs/said-receipts`. At minimum: pin the program hash, vendor
the Leo source, document the upgrade authority.

---

## Layer 7 — Web client integration

### `apps/web/src/app/api/aleo-shielded/{verify,health}`

**Status: shipped.** See Layer 2.

### `apps/web/src/lib/payment-rails.ts`

**Status: shipped.**

- Discriminated union for public vs shielded rails
  (`apps/web/src/lib/payment-rails.ts:17-36`).
- Validation, disclosure text, and the
  `x-ghola-payment-rail` header helper (`payment-rails.ts:72-132`).
- Test file present: `apps/web/src/lib/payment-rails.test.ts`.

### `apps/web/src/lib/shielded-payment.ts`

**Status: missing.**

- Tier 2K §4.1 names this file as "Aleo client (TS): bridge top-up
  modal, settings toggle, transition build, broadcast."
- No file at that path. The only TS Aleo code lives inside the verify
  route (server-side, not a reusable client lib).
- No top-up modal, no settings toggle, no client-side transition
  builder, no `@provablehq/sdk` use outside the verifier.

---

## Layer 8 — Bridge integration (USDC → USDC.a)

**Status: missing.**

- Tier 2K §3 commits to a single bridge (Wormhole NTT or equivalent at
  ship time) with a "shielded mode degraded" SLO.
- No bridge client in `crates/`, no bridge UI in `apps/web/src/app/`.
- The `private_wallet_transfers` table tracks shielded transfers but
  has no concept of pending bridge inflows.
- The configured-recipient mode in
  `apps/web/src/app/api/aleo-shielded/verify/route.ts:516-525` assumes
  funds are already on Aleo as USDCx — the bridging step is left to
  the user out-of-band.

**Gap.** The "bridge operator deanonymisation" mitigation in Tier 2K
§5 ("pre-funding, batched top-ups, cover-traffic policy that decouples
top-up timing from call timing") cannot be built without a bridge
client. This is one of the largest unbuilt pieces in the stack.

---

## Layer 9 — Receipt anchoring with `settlement_rail`

### `settlement_rail` field on the verified-payment response

**Status: shipped (in-memory).**

- Struct field:
  `crates/thumper-cloud/src/services/x402_service.rs:208`
  (`VerifiedPayment.settlement_rail`).
- Populated to `solana_public_stablecoin`
  (`x402_service.rs:1162`) or `shielded_stablecoin`
  (`x402_service.rs:1593`).
- Propagated into the OpenAI-compat completion response
  (`crates/thumper-cloud/src/routes/openai_compat.rs:555`).

### `settlement_rail` on the canonical receipt body anchored on-chain

**Status: missing.**

- Tier 2K §4.4 specifies a `receipt.settlement_rail` field on the
  canonical signing body so verifiers render the right explorer link.
- A repo-wide grep for `settlement_rail` returns the two `x402_service.rs`
  hits and the `openai_compat.rs` hit — **no** references in
  `crates/said-receipts-service/` or `programs/said-receipts/`.
- `apps/web/src/lib/receipt.ts` (and the `/r/[hash]` verifier) has no
  awareness of the field. Receipt canonicalisation
  (`RECEIPT_BODY_KEYS`, per `cryptographic-primitives.md`) has not
  been bumped.

**Gap.** The `settlement_rail` value is computed and returned to the
caller, but does not survive into the anchored Merkle tree. A third
party verifying a receipt cannot tell which rail settled it. For a
post-hoc audit this is a privacy *win* (no rail leak) but it also
means the "shielded badge" on the public verifier UI cannot be backed
by anything on-chain.

---

## Layer 10 — Agent-as-payer (Turnkey sub-org per agent + delegated shielded signing)

### Agent-as-cryptographic-identity

**Status: shipped (identity only, not custody).**

- `crates/said-cloud/src/routes/agents.rs` — 10 JWT-authed endpoints
  under `/v1/agents`.
- `agent_wallets` table — `(user_id, label, hd_index, solana_address,
  spending_policy, agent_id)` rows
  (`said-cloud/src/routes/agents.rs:266-267`).
- Per-agent service listings, reputation, earnings.

**Gap.** Per the headless-merchant memory: each agent has an Ed25519
keypair → DID + Solana address from creation, but **the private key
is not stored**. v1 agents are receive-only on the public rail; they
cannot sign their own outbound payment.

### Turnkey sub-org per agent

**Status: missing in this repo.**

- Per the Turnkey-integration memory, the canonical Turnkey deep
  integration (pre-gen wallets, policy engine, sessions, delegated
  agents, export, multi-sig escrow, audit trail) lives in
  `crates/said-cloud/src/routes/turnkey.rs` in the **old** said repo,
  not in this consolidated ghola monorepo. A `grep -rln "turnkey"` in
  the current monorepo's `crates/said-cloud/src/routes/` only matches
  `merchants.rs` (Layer 2 vault usage), not a dedicated turnkey route
  module.
- The in-repo Turnkey surface is the credential-vault adapter
  (`crates/said-turnkey/src/turnkey.rs:1-80+`), which wraps DEKs for
  encrypted merchant credentials. **It does not provision sub-orgs
  for agents, attach policies, or sign Aleo transitions.**
- `mint_suborg` is explicitly stubbed in `TurnkeyVault`
  (`said-turnkey/src/turnkey.rs:7-9`: "`mint_suborg` is still
  stubbed — out of scope for v2").

### Per-agent Turnkey policy engine (max-per-call, daily cap, merchant allowlist, kill switch)

**Status: missing.**

- The agents.rs route has a `spending_policy` JSON column on
  `agent_wallets`, but it is a free-form record, not enforced at the
  Turnkey enclave.
- Daily-cap enforcement, allowlist, and kill switch are all
  server-side TODOs.

### Aleo signing key derived per-agent

**Status: missing.**

- The recommended derivation (Tier 2K §4.3) is
  `HKDF-SHA256(turnkey_signature, "ghola-aleo-account-v1")` — but
  there is no Turnkey signing for the agent, no HKDF binding, and no
  Aleo account derivation code anywhere in the tree.

### Delegated shielded signing

**Status: missing.**

- No delegated-signing surface in the shielded path. The
  `private_settlement_service` requires a `signer_key_id` and an
  Ed25519 signer attestation from the **user**, not from an agent
  delegated by the user.

---

## Layer 11 — Selective disclosure / ZK audit proofs

**Status: missing (cryptographic primitive).**

- Today's "selective disclosure" is hashed-metadata export (Layer 3).
- There is no Plonky2 / Halo2 circuit for "agent spent ≤ X on
  category Y in window Z."
- `crates/ghola-zkml-types` exists but, per its name and the existence
  of `tier-2h-zkml.md`, is for ZK-ML inference attestation — not
  payment proofs.

---

## Layer 12 — Aleo node / indexer operational layer

### Indexer client (consumer)

**Status: shipped.**

- `apps/web/src/app/api/aleo-shielded/verify/route.ts:481-490` reads
  `ALEO_INDEXER_URL` and fails closed when unset.
- `AleoNetworkClient` usage at `route.ts:531-547` (transaction fetch,
  block height, confirmation count).
- `route.ts:425-447` resolves a transaction id to a block height by
  reading `${indexerUrl}/mainnet/find/blockHash/{txId}`.

### Indexer / node hosting

**Status: missing (operational, not code).**

- The repo treats the indexer as an external dependency configured by
  env var. There is no run-book in `docs/`, no Render service
  declared in `render.yaml` for an Aleo node, and no fallback indexer
  list.
- Per the Render-deployment memory (April 2026 snapshot), Ghola
  operates three Render services (said-cloud, thumper-cloud,
  thumper-relay) — none of them host or proxy Aleo state.

---

## Summary table

| Component | Status |
|---|---|
| `X402SettlementProof` enum (schema-only) | partial |
| `X402PaymentPayload` Solana arm | shipped |
| Shielded verifier adapter (HTTP boundary) | shipped |
| Signed-receipt envelope (Ed25519, replay-bound) | shipped |
| Recipient-supplied receipt mode | shipped |
| Adapter bearer auth | shipped |
| Private-settlement service (intent/proof/export) | shipped |
| Selective disclosure (metadata-only) | shipped |
| Institutional readiness gate | shipped |
| Registry `aleo_address` / `price_micro_usdc_shielded` | partial (handlers reference fields the struct does not declare) |
| Registry realloc / migration tool | missing |
| `said-shielded` crate (account derivation, builder, broadcaster) | missing |
| `ghola_pay.aleo` Leo program (in-tree source) | missing |
| `payment-rails.ts` rail union + helpers | shipped |
| `shielded-payment.ts` client lib | missing |
| Bridge integration (USDC → USDC.a) | missing |
| `VerifiedPayment.settlement_rail` (in-memory) | shipped |
| `receipt.settlement_rail` (anchored body) | missing |
| Per-agent identity + `agent_wallets` row | shipped |
| Per-agent Turnkey sub-org | missing (vault adapter exists; sub-org provisioning stubbed) |
| Turnkey policy engine (max-per-call, daily cap, allowlist, kill switch) | missing |
| Aleo signing key derived per agent | missing |
| Delegated shielded signing (agent-as-payer) | missing |
| ZK audit proofs ("spent ≤ X on Y in Z") | missing |
| Aleo indexer client (consumer side) | shipped |
| Aleo node / indexer hosting (operational) | missing |

The pattern: **the verification half of the system is real, the
generation half is not.** Ghola can today verify a third party's
shielded settlement on Aleo (with a recipient receipt or a configured
recipient key); it cannot itself, programmatically or per-agent,
*produce* one.
