# Aleo program operational notes — `ghola_pay.aleo`

Operational handbook for whoever deploys and maintains the Aleo
shielded-payment program. Companion to
[`tier-2k-shielded-payments.md`](./tier-2k-shielded-payments.md); the
program itself lives at
[`programs/aleo/ghola_pay/`](../../programs/aleo/ghola_pay/).

## Environment-variable ↔ Aleo-concept map

`thumper-cloud` does not talk to the Aleo network directly. It talks
to the off-chain shielded adapter, which talks to Aleo. The mapping:

| env var (thumper-cloud) | Aleo concept | Used by |
|---|---|---|
| `SHIELDED_STABLECOIN_PROVIDER=aleo` | Discriminant for which rail to validate. | thumper-cloud verifier dispatch. |
| `SHIELDED_STABLECOIN_NETWORK=aleo:mainnet` | Target Aleo network (`aleo:mainnet` or `aleo:testnet3`). Must match `program.json` deploy target. | thumper-cloud + adapter; the adapter rejects transitions submitted against a different network. |
| `SHIELDED_STABLECOIN_ASSET=USDCx` | Logical asset name. Must match the record type declared in `src/main.leo` (or the imported bridge type once we import the canonical USDC.a). | adapter only. |
| `SHIELDED_STABLECOIN_RECIPIENT=aleo1…` | The provider's Aleo address. This is the value passed as the program-level `to` parameter when the client builds a `pay` transition. | client (to build transition) + adapter (to decrypt expected output record). |
| `SHIELDED_STABLECOIN_ADAPTER_URL` | Off-chain verifier endpoint. Not an Aleo concept; the adapter is the thing that knows how to talk to an Aleo node. | thumper-cloud. |
| `SHIELDED_STABLECOIN_ADAPTER_PUBKEY` | Ed25519 pubkey signing adapter receipts. Decoupled from any Aleo key. | thumper-cloud (signature verification). |
| `SHIELDED_STABLECOIN_VERIFIER_READY` | Gate flag: `true` only when a real on-chain verifier (this program live + adapter wired to it) exists. Until then thumper-cloud reports `configured=false`. | thumper-cloud health endpoint. |

The program id (`ghola_pay.aleo`) is itself not an env var today —
it's pinned in the adapter implementation. When/if we deploy multiple
program versions, lift it into a `SHIELDED_STABLECOIN_PROGRAM_ID` env
var so cutover is config-only.

The optional public `memo: u128` parameter has **no** runtime env
mapping. Clients pass `0u128` by default; if we ever need adapter ↔
transition correlation we'll wire a per-request random nonce, never
anything derived from user or recipient identity.

## Relationship: program vs adapter

The adapter is the **trusted verifier**. The program is **just the
shielded transition.** Concretely:

- The on-chain program proves: "someone who owned a USDC.a record
  produced an output record for `to` of `amount`." It does *not*
  prove anything about *which* request that pays for; Aleo has no
  notion of x402.
- The adapter proves to `thumper-cloud`: "I fetched transition `t`,
  decrypted the recipient record with the provider's view key,
  confirmed `record.owner == SHIELDED_STABLECOIN_RECIPIENT` and
  `record.amount >= required`, and I'm signing this attestation
  with the key under `SHIELDED_STABLECOIN_ADAPTER_PUBKEY`."
- `thumper-cloud` does **not** verify the Aleo proof itself. It
  trusts the adapter's Ed25519 signature, plus the program-id pin
  inside the adapter. This is the "false privacy claim" boundary in
  Tier 2K §0 — we are honest that the rail is "shielded transitions
  + a trusted attestor", not "natively verified in thumper-cloud."

The view key required to decrypt incoming records is the
**provider's** view key, held by the adapter. The provider's spend
key (which can move the received funds) is held separately and never
touches the adapter. If the adapter is compromised, the attacker can
forge fake receipts but cannot drain shielded balances.

## Migration path

We're walking three observable states. The transition between them is
gated by env-var flips on the `thumper-cloud` Render service plus
program-deploy actions on Aleo.

### State A — no real verifier (current as of writing)

- Program not deployed.
- `SHIELDED_STABLECOIN_VERIFIER_READY=false` (or unset).
- thumper-cloud `/health/payments` reports `aleo_usdcx_shielded.configured=false`.
- Any client sending `x-ghola-payment-rail: aleo_usdcx_shielded`
  receives a fail-closed 402 with `verifier_not_ready`. We do *not*
  silently fall back to public Solana — explicit user choice only.

### State B — program live, adapter wraps it (the launch state)

Transition:

1. Fund an Aleo mainnet account; deploy `ghola_pay.aleo` per the
   README's deployment section.
2. Stand up the adapter service. Configure it with the program id
   (`ghola_pay.aleo`), the network, and the provider's view key.
3. Generate an Ed25519 keypair for the adapter; set the pubkey in
   `SHIELDED_STABLECOIN_ADAPTER_PUBKEY`. Store the private key only
   on the adapter host.
4. Set `SHIELDED_STABLECOIN_ADAPTER_URL`, `SHIELDED_STABLECOIN_RECIPIENT`.
5. Flip `SHIELDED_STABLECOIN_VERIFIER_READY=true` and redeploy.
6. Verify `/health/payments` reports `configured=true,
   adapter_signature_required=true, adapter_signature_configured=true`.

Behaviour in State B: shielded mode is opt-in per Tier 2K §6 Phase 0.
Default rail remains Solana; users with the toggle set route through
Aleo.

### State C — on-chain verifier subsumes adapter

When (if) we either (a) port the Aleo transition verifier into a
thumper-cloud-native Rust check using `snarkVM` directly, or (b) lift
verification onto a Solana-native zk-verifier program that
thumper-cloud can call as part of its existing settlement path, the
adapter becomes redundant.

Migration:

1. Land the native verifier; gate behind a feature flag.
2. Run adapter + native verifier in parallel for ≥2 weeks. Cross-check
   that every transition the adapter signs is also verified natively;
   alert on divergence.
3. Flip thumper-cloud to native-only.
4. Remove `SHIELDED_STABLECOIN_ADAPTER_URL` and
   `SHIELDED_STABLECOIN_ADAPTER_PUBKEY` from env. Keep
   `SHIELDED_STABLECOIN_RECIPIENT` and the network/asset vars; they
   still parameterise the native verifier.
5. Decommission the adapter host.

The program itself does not change between State B and State C. Its
contract is stable: consume one record, emit two. What changes is who
verifies the resulting transition. That separation is intentional —
it means we don't have to redeploy the Aleo program (and rotate
program ids) to lift the verifier off the trusted adapter.

## Cross-references

- [`docs/security/tier-2k-shielded-payments.md`](./tier-2k-shielded-payments.md) — full design.
- [`programs/aleo/ghola_pay/README.md`](../../programs/aleo/ghola_pay/README.md) — build/deploy.
- [`programs/aleo/ghola_pay/src/main.leo`](../../programs/aleo/ghola_pay/src/main.leo) — the program.
