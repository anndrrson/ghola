# Tier 2K — Shielded Payment Rail

Status: design, not yet implemented.
Owner: payments + privacy.
Targets the residual metadata leak from x402 USDC settlements on Solana.
Pairs with Tier 2G (anonymity sets for the inference path) and Tier 1E
(production-only attestation enforcement). See the peak-security plan's
Tier 2K entry for the one-line scope this doc expands.

This is the deep doc; tone and depth match
[cryptographic-primitives.md](./cryptographic-primitives.md). All
section references are to source files in this repo.

## 1. Threat model

### 1.1 The leak

The current payment path (`crates/said-x402/src/lib.rs`) settles every
paid inference call by emitting an `X402PaymentPayload` whose Solana
payload is, structurally:

```
X402SolanaPayload {
  signature: <base58 tx sig>,
  from:      <base58 user pubkey>,
}
```

The merchant verifies the payment by fetching that transaction from a
Solana RPC and checking that it transferred `>= max_amount_required`
USDC to `payTo` (the provider's wallet). The transaction is a plain
SPL Token-2022 (or legacy SPL) transfer with three publicly visible
fields: `from`, `to`, `amount`. Anyone running an RPC index can build
the graph

```
edges = { (user_pubkey, provider_pubkey, amount, slot) : ∀ x402 tx }
```

and from it, for every user wallet:

- which providers they queried,
- approximately how often,
- approximately at what cost (hence model class — a 12 µUSDC tx is
  Llama 3 8B, a 4000 µUSDC tx is a long Claude Opus call),
- correlated time series across providers, which leaks topic shifts.

The sealed envelope (`apps/web/src/lib/sealed-stream.ts`) hides the
*content* of every call. It does not hide the *fact* of the call,
because the payment that authorises the call is on a public ledger
keyed by the user's address.

### 1.2 Adversary capabilities

| Adversary | Capability | What they learn today |
|---|---|---|
| **Passive chain observer** | Runs an RPC node, reads all SPL Token transfers. | Full payer→provider graph; can deanonymise a user by a single off-chain linkage (Twitter, ENS, KYC venue). |
| **Active provider operator** | Operates a registered provider; sees `pay_to` hits in real time and can correlate with their own attested enclave traffic. | Even if their relay sees the request as a `said-envelope` blob (no sender DID linkable to chain), a settlement tx with `from = X` reaching their `pay_to` at slot `s` lets them tie chain identity to enclave traffic at slot `s ± Δ`. |
| **Active correlator** | Observes user's network position (ISP, OHTTP relay operator) and chain in parallel. | Even with OHTTP hiding the source IP, a settlement tx at `T₀` plus a Tor/OHTTP burst from candidate IP set `S` at `T₀ + Δ` reduces the anonymity set quickly. |
| **Cluster analyst (heuristic)** | Standard chain-analytics shop. | Wallet clustering on common-input + funding-source heuristics deanonymises the user wallet to one or two human identities. |

### 1.3 What we want to protect

The minimum acceptable property is **provider-set unlinkability for the
payer**: given the public chain alone, an observer cannot determine
which of the N registered providers a given user paid in any given
epoch, beyond the prior. A stronger property is **payment-graph
unlinkability**: no observer (other than payer and payee) learns the
edge at all.

## 2. Candidate constructions

### 2.1 Confidential transfers on Solana (Token-2022 CTokens)

Token-2022's confidential transfer extension
([SPL docs](https://spl.solana.com/token-2022/extensions#confidential-transfers))
encrypts the *amount* of a transfer using a twisted ElGamal commitment
plus a bulletproof range proof. Construction sketch:

1. Mint a confidential-transfer-enabled USDC wrapper, `cUSDC`, or wait
   for Circle's native cUSDC mint (announced but not GA at the time of
   writing — confirm before committing).
2. User deposits public USDC → `cUSDC` via the `Deposit` extension
   instruction. Their confidential balance is an ElGamal ciphertext
   under their auditor-disabled key.
3. Per payment, the client emits a `ConfidentialTransfer` instruction
   to the provider's confidential account. The amount is hidden behind
   a Pedersen commitment with a bulletproof range proof; sender and
   receiver pubkeys remain in plaintext as `source` and `destination`
   accounts on the instruction.
4. Provider sweeps `cUSDC` → public USDC at their own cadence via
   `Withdraw`.

**Pros**: native to Solana, no bridge, settlement latency identical to
SPL (≈400 ms), tooling exists (`spl-token-2022` JS + Rust), audit-key
trapdoor available for compliance opt-in.

**Cons (this is the honest part)**: confidential transfers **hide the
amount, not the parties**. The `source` and `destination` accounts are
still public instruction accounts. The payer→provider edge is
unchanged; only the weight (`amount`) is hidden. For the threat in §1.1
this is a **partial** mitigation: an analyst still sees that user `U`
paid provider `P` at slot `s`, which is most of the leak. They lose
the ability to bucket users by model class, but not the ability to
build the bipartite graph. We do not consider this sufficient on its
own; it could be a stepping-stone or layered with mixing on the
deposit/withdraw legs.

### 2.2 Aleo-based payment routing

Aleo is a zk-SNARK-based L1 with shielded "records" as the native
account model
([Aleo docs](https://developer.aleo.org/concepts/network/records)).
Construction sketch:

1. Bridge: user moves USDC → Aleo `credits.aleo` (or a bridged
   USDC.a) via a Wormhole-class bridge.
2. Provider registers a public Aleo address `aleo1…` in the
   `ghola-model-registry` alongside (or instead of) `pay_to`.
3. Payment: client builds an Aleo transition that consumes a record
   owned by the user and produces a record owned by the provider for
   `amount`. The transition is a zk-SNARK; the public transaction
   contains only the program id, the input nullifier (a hash that
   reveals nothing about the consumed record), and the output record
   commitment.
4. The provider scans their owned records (decrypted with their view
   key) and treats a matching record as a payment. They produce an
   x402 receipt referencing the Aleo transition id instead of a
   Solana tx sig.

**Pros**: full unlinkability — sender, receiver, and amount are all
shielded. Aleo's record model is purpose-built for this; it does not
require us to design a mixer. Compliance-friendly via view-key
disclosure if ever needed.

**Cons**: bridge dependency (a bridge hack is now in our threat
surface, and bridges historically dominate crypto exploit volume).
Aleo finality is ~10 s plus probabilistic confirmation; settlement
latency goes from ~400 ms to multi-second, which materially hurts
sub-cent-per-call inference UX. Token-1 ecosystem; liquidity to
bridge USDC in is thin. The provider must run an Aleo node or trust a
public Aleo indexer to detect incoming payments — adds a sync layer
the relay currently does not have.

### 2.3 Zcash with optional viewing keys

Zcash sapling/orchard pool, shielded `z` addresses
([ZIP 32 / ZIP 244](https://zips.z.cash/)).

1. User moves USDC → Zcash via a bridge or a centralised on-ramp
   that delivers ZEC to a `zs1…` address.
2. Provider publishes a `zs1…` in the registry.
3. Payment is a sapling/orchard spend → output to the provider's
   shielded address. Public chain reveals nothing beyond the existence
   of a shielded transaction.

**Pros**: most battle-tested shielded chain in production. Sapling /
Orchard have years of analysis. Viewing keys give clean selective
disclosure.

**Cons**: lowest fiat liquidity of the three; we'd be paying in ZEC,
not USDC, so every call eats spot risk against ZEC/USD volatility.
Block time is 75 s, settlement finality is multi-minute. Bridge
surface again. Ecosystem is the smallest of the three for the
tooling we need (programmatic provider registration, watchers, etc.).

## 3. Recommendation

**Ship Aleo (§2.2).** Specifically: a thin bridge of USDC → Aleo
USDC.a + shielded routing on Aleo, with the existing x402 receipt
schema extended to carry an Aleo transition id in place of a Solana
tx sig.

Justification:

1. **Threat fit.** The user we are protecting (per the privacy thesis)
   cares about the payer→provider edge, not just the amount. Token-2022
   confidential transfers (§2.1) leave that edge intact and so don't
   actually close the leak — they make the headline metric (amounts)
   look better while the bipartite graph stays public. That's a
   marketing fix dressed as a privacy fix; we should not ship it
   under a "shielded" banner.
2. **Integration friction vs Zcash.** Both Aleo and Zcash require a
   bridge and a non-Solana watcher in the relay. Aleo settles in ~10 s
   vs Zcash's ~150 s+; for paid-inference UX this matters. Aleo also
   supports stablecoin-bridged records (USDC.a) so we avoid the spot
   risk that Zcash inflicts.
3. **Timeline.** Aleo SDKs (`@provablehq/sdk`, `snarkos`, `snarkVM`)
   are stable enough to be wrapped without us writing zk primitives.
   We are not on the critical path for any cryptographic engineering;
   this is plumbing.

The cost is the bridge dependency. We accept it explicitly: §6 below
specifies a v1 launch with a single supported bridge (Wormhole NTT or
its closest equivalent at ship time) and a stated SLO for "shielded
mode degraded — falling back to public USDC with a user-visible
warning."

## 4. Concrete integration sketch

### 4.1 New code locations

| Concern | Location |
|---|---|
| Aleo payment library (Rust) | new crate `crates/said-shielded` |
| Aleo client (TS) | `apps/web/src/lib/shielded-payment.ts` |
| x402 schema bump | `crates/said-x402/src/lib.rs` — add `X402AleoPayload` variant |
| Decision point: when to attach which payment header | `apps/web/src/lib/sealed-stream.ts` (or its sibling `paid-inference.ts`) |
| Registry schema bump | `programs/ghola-model-registry/src/lib.rs` — add optional `aleo_address` and `price_micro_usdc_shielded` |
| Receipt-batcher consumption | `crates/said-receipts-service` (anchoring path) |

### 4.2 x402 payload extension

Today `X402SolanaPayload` is the only variant inside `X402PaymentPayload`
(see `crates/said-x402/src/lib.rs:43`). We extend the schema with a
tagged variant:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "rail", rename_all = "snake_case")]
pub enum X402SettlementProof {
    Solana(X402SolanaPayload),
    AleoShielded(X402AleoPayload),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402AleoPayload {
    /// Aleo transition id (base58 / bech32m, per Aleo canonical form).
    pub transition_id: String,
    /// Bech32m output record commitment the provider should scan for.
    pub output_commitment: String,
    /// Program + function the transition called, e.g. "ghola_pay.aleo/pay".
    pub program: String,
    /// Network: "aleo:mainnet" | "aleo:testnet3".
    pub network: String,
}
```

The provider validates a shielded settlement by:

1. Fetching the Aleo transition by id from a configured Aleo node /
   indexer.
2. Decrypting the output record with their view key.
3. Checking the decrypted `amount` field of the record is
   `>= max_amount_required` and the record's owner field matches the
   provider's address.
4. Replay-checking the transition id against a small recent-id cache
   keyed by `(provider_id, transition_id)`.

The `from` field is **dropped** in `X402AleoPayload`. There is no
sender identity to populate — that's the point. Receipts continue to
sign over the same canonical body, but the `payment_proof` field now
carries the rail tag instead of a Solana sig.

### 4.3 Wallet UX

The user does **not** get a new chain wallet exposed in the UI. The
shielded-payment flow is hidden behind the existing Turnkey-backed
identity:

- Aleo account key is derived deterministically from the user's
  Turnkey Ed25519 identity, the same way the X25519 vault key is
  derived in `apps/web/src/lib/vault-x25519.ts` (Aleo's account key is
  a 32-byte seed → BLS12-377 keypair; the seed comes from
  `HKDF-SHA256(turnkey_signature, "ghola-aleo-account-v1")`).
- "Top up" UX: user converts USDC → Aleo USDC.a via an in-app bridge
  modal that submits to the chosen bridge contract on Solana and waits
  for the corresponding Aleo deposit. This is a one-time per balance
  refill, not a per-call action. Default top-up size matches ~100
  inference calls so the bridge round-trip amortises.
- Per-call: no user prompt. The client builds the Aleo transition,
  signs it locally, submits to a configured Aleo broadcaster (we run
  our own; users can override), and includes the `X402AleoPayload`
  in the x402 retry request. Same UX as today.

### 4.4 Receipt anchoring

The on-chain receipt batcher (`said_receipts::publish_root`, see
[cryptographic-primitives.md §"On-chain anchoring"](./cryptographic-primitives.md#on-chain-anchoring-merkle-batches))
consumes receipt bodies, not payment proofs. The receipt body never
included the payer wallet — it includes `signer_did`, which is a
`did:key:` value not directly tied to a Solana address. **The receipt
anchoring path is unchanged**; we add a single optional field
`receipt.settlement_rail = "aleo"` to the canonical body so verifiers
can render the right explorer link, but it carries no identifying
information.

The leak we are closing is upstream of the batcher (in the SPL
transfer the batcher never sees). No new privacy surface is opened by
anchoring.

### 4.5 Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Insufficient shielded balance | Local: signing fails before broadcast. | UI prompts top-up modal. No call leaves the device. |
| Aleo broadcaster offline | Submit timeout. | Retry with backoff; after 3 attempts, surface "shielded mode degraded." User opt-in fallback to public Solana x402 with explicit modal: "this call will reveal payer→provider on Solana — continue?" Default = decline. |
| Bridge offline (top-up path) | Bridge tx pending > T. | Refund-on-source guarantee from bridge; UI surfaces a "funds in flight" state and disables new top-ups. |
| Provider lacks Aleo address | Discovered at registry read. | Provider is hidden from the shielded-mode provider list. In shielded-only mode the user never sees them as an option. |
| Aleo reorg / unfinalised transition | Provider sees transition then it disappears. | Receipt verification fails; the receipts service marks the receipt unanchored and a watchdog refunds the user's call credit if the inference already shipped. |

## 5. What this does NOT solve

Shielded payments are necessary but not sufficient. The following
leaks remain after Tier 2K ships:

- **Timing correlation.** A request arriving at the relay at `T₀` and
  a response leaving at `T₀ + Δ` is observable by anyone who can see
  the relay's traffic at the network layer. Aleo does not address
  this. Mitigation lives in Tier 2G (request-mixing batches) and Tier
  2H (cover traffic).
- **Side-channel traffic analysis.** Even with OHTTP, the size + cadence
  of sealed-envelope payloads leak coarse information about the
  underlying request (long context, long response). Padding to fixed
  buckets is out of scope for this tier.
- **Colluding provider operator.** A provider operator who logs the
  enclave's *internal* state (assuming they could break the
  attestation chain, or chose to log pre-encryption) sees the
  plaintext request regardless of payment rail. Tier 1E + decentralised
  provider diversity (Tier 2F) are the mitigations.
- **Bridge operator deanonymisation.** A user who only ever bridges
  *immediately before paying provider P* leaks a coarse signal to the
  bridge operator (chain analytics can correlate the bridge inflow's
  source Solana wallet with the shortly-after Aleo activity).
  Mitigation: pre-funding, batched top-ups, and a cover-traffic policy
  that decouples top-up timing from call timing.

## 6. Migration path

We do **not** flip a default. Rollout is three phases:

1. **Phase 0 — opt-in shielded, public default.** Ship Aleo support
   behind a per-user toggle (`settings.private_payments`). x402
   default rail remains Solana. New registry field `aleo_address` is
   optional. Receipts carry `settlement_rail` so verifiers handle
   both. Goal: live testing without breaking existing providers.

2. **Phase 1 — opt-in shielded, registry coverage push.** Onboard
   every registered provider to publish an `aleo_address`. Update the
   model-registry program to require at least one of
   `{solana_pay_to, aleo_address}`. Surface a "shielded available"
   badge in the provider picker.

3. **Phase 2 — shielded default, public fallback.** Flip the client
   default so shielded mode is on for users with a non-zero Aleo
   balance. Users with zero balance see a top-up modal once. Public
   USDC remains available as an explicit override for users who don't
   care about the leak.

### Registry program change

The `Model` account in
`programs/ghola-model-registry/src/lib.rs` currently carries

```rust
pub price_micro_usdc: u64,
```

It becomes:

```rust
pub price_micro_usdc: u64,                // public-rail price
pub price_micro_usdc_shielded: Option<u64>, // shielded-rail price (often the same)
pub aleo_address: Option<[u8; 63]>,        // bech32m raw bytes
```

`pay_to` stays. Bumping account size requires either a reallocation
(`#[account(mut, realloc = …)]`) on next update, or a new account
version — we'll choose `realloc` since the model registry is small.

## 7. Engineering effort estimate

Honest, 1 engineer week = ~40 focused hours. Calendar weeks assume
~60% allocation, so multiply by ~1.6 for wall-clock.

| Layer | Effort |
|---|---|
| `crates/said-shielded` — Aleo account derivation from Turnkey signature, transition build, broadcast client | 2.0 wk |
| `apps/web/src/lib/shielded-payment.ts` — TS mirror, bridge top-up modal, settings toggle | 1.5 wk |
| x402 schema bump + provider-side validator (`X402SettlementProof` enum, Aleo transition fetcher, replay cache) | 1.0 wk |
| Aleo program (`ghola_pay.aleo`) — minimal `pay` function consuming a record, producing a record, no fancy logic | 0.5 wk |
| `ghola-model-registry` realloc + new fields + migration tool for existing accounts | 0.5 wk |
| Receipts: `settlement_rail` field added to canonical body, verifier UI updated to render Aleo explorer link | 0.5 wk |
| Bridge integration (Wormhole NTT or equiv): on-ramp, watcher, retry, refund-on-source | 1.5 wk |
| End-to-end tests (devnet Solana + Aleo testnet3): top-up → inference → receipt → withdrawal | 1.0 wk |
| Operational: Aleo node / indexer on the provider side, monitoring, runbook | 0.5 wk |
| **Total** | **9.0 engineer-weeks** |

That is the optimistic number assuming Aleo SDKs behave and no
zk-prover regression bites us. Realistic with bridge bugs and Aleo
node ops: **12–14 wk**. We commit to the higher number for planning.

## 8. References

- `crates/said-x402/src/lib.rs` — current x402 payment proof shape
- `apps/web/src/lib/sealed-stream.ts` — sealed-envelope client (no
  payment logic today; payment attachment happens in the x402 retry
  layer)
- `programs/ghola-model-registry/src/lib.rs:131` — current
  `price_micro_usdc` field
- `programs/said-registry/src/lib.rs:46` — service-registration entry
- `docs/security/cryptographic-primitives.md` — sibling deep doc
- SPL Token-2022 confidential transfer extension — Solana docs
- Aleo developer docs — record model + transition semantics
- ZIP 32 / ZIP 244 — Zcash sapling/orchard key derivation

## Next concrete action

Open a PR that introduces the `X402SettlementProof` enum (tagged
union of `Solana` and `AleoShielded` variants) in
`crates/said-x402/src/lib.rs`, leaves the existing `Solana` variant
wire-compatible with today's `X402PaymentPayload`, and stubs the
`AleoShielded` variant with `todo!()` validators — call it the
"schema-only" PR so every downstream layer can start typing against
the new shape while the Aleo plumbing lands behind it.
