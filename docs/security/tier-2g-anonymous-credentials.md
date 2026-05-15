# Tier 2G — Anonymous Credentials

Status: design, not yet implemented.
Owner: privacy + identity.
Targets the residual identity leak in the sealed-inference path: today
the relay sees `sender_did` on every request, which is per-DID-linkable
to the Turnkey wallet that signs it. Pairs with Tier 2K (shielded
payments for the on-chain leg) and Tier 1E (production attestation
enforcement). See the peak-security plan's Tier 2G entry for the
one-line scope this doc expands.

This is the deep doc; tone and depth match
[cryptographic-primitives.md](./cryptographic-primitives.md) and its
sibling [tier-2k-shielded-payments.md](./tier-2k-shielded-payments.md).
All section references are to source files in this repo.

## 1. Threat model

### 1.1 The leak

Today every sealed-inference request carries an Ed25519 DID in the
envelope header. From `apps/web/src/lib/envelope.ts` and the matching
parser in `crates/thumper-relay/src/auth.rs::parse_envelope_header`,
the relay-visible header is:

```
sender_did:    did:key:z… (Ed25519 multicodec, 32-byte pubkey)
recipient_id:  enclave model-bridge id
ephem_pub:     32-byte X25519
nonce:         12-byte AES-GCM nonce
[trailing 64-byte Ed25519 sig over the body]
```

The relay validates the request by (i) parsing the header, (ii)
verifying the Ed25519 signature against `sender_did`, (iii) confirming
`sender_did ∈ did_set`, (iv) replay-checking the nonce, and (v)
applying a **per-DID** rate limit
(`crates/thumper-relay/src/auth.rs::validate_sealed_envelope_bytes`).
Step (iii) is the whole leak: the relay must know which DID this is in
order to authorise the call, and the DID is stable across requests.

Even after Tier 2K hides the on-chain settlement edge, this in-band
identifier survives. A colluding provider operator who runs both the
relay and an enclave still sees:

| Channel | What it observes |
|---|---|
| Envelope header | `sender_did` (stable across sessions), per-envelope `nonce`, ephemeral X25519 pub |
| Transport | Source IP (mitigated by OHTTP, `apps/web/src/lib/ohttp.ts`), TLS fingerprint, timing |
| Payment retry | x402 `from` pubkey on the public chain (Tier 2K closes this) |
| Sealed body | Encrypted, but request *size* and response *size* are observable |
| Subscription state | Joins `sender_did` to "this DID is on Pro tier, billed via Turnkey customer C" inside `thumper-cloud` |

Crucially, today's `sender_did` is the **same** Ed25519 key that signs
x402 payments, signs the user's receipts (`signer_did` in
`apps/web/src/lib/receipt.ts`), and is published in the DID set the
relay caches. One linkable join — wallet ↔ DID — collapses every other
pseudonym in the stack.

### 1.2 Adversary capabilities

| Adversary | Capability | What they learn today |
|---|---|---|
| **Passive relay observer** | Reads request headers in front of `validate_sealed_envelope_bytes`. | Stable DID, request cadence, payload sizes. Sufficient to fingerprint a single user across weeks. |
| **Active provider operator** | Runs `thumper-relay`. | All of the above plus the join `sender_did → customer_id → email/phone` from the cloud control plane. |
| **Colluding chain analyst** | RPC indexer + Turnkey breach OR off-chain doxx. | Closes wallet → DID → enclave-traffic chain in one hop. |
| **Subpoenaed cloud operator** | Compelled to produce records keyed by user identity. | Hands over the full `sender_did` → person mapping; the privacy claim collapses to "trust us." |

### 1.3 What we want to protect

The minimum acceptable property is **per-request unlinkability among
subscribers of the same tier**: the relay can verify that the requester
is a current Pro subscriber (and is within their rate-limit envelope),
and learns nothing else — in particular, nothing that links two
requests from the same user to each other beyond an epoch-scoped
nullifier. The anonymity set is the set of all credentials the issuer
has signed in the current epoch.

A stronger property is **predicate-only disclosure**: the user proves
arbitrary attributes (`subscription_tier ≥ 1`, `age ≥ 18`,
`usage_this_period ≤ limit`) without revealing the underlying values.

## 2. Candidate primitives

### 2.1 BBS+ signatures (DIF BBS Cryptosuite 2023 / CFRG draft)

BBS+ is a multi-message pairing-based signature where an issuer signs
a vector `(m₁, …, mₙ)` and the holder can later prove possession of a
signature on a chosen subset while keeping the rest hidden — all in
zero-knowledge. The scheme is standardised in
`draft-irtf-cfrg-bbs-signatures` (CFRG track, currently at draft-07)
and concretised by the
[DIF BBS Cryptosuite 2023](https://www.w3.org/TR/vc-di-bbs/) for VC
data integrity.

Construction:

```
KeyGen:        (sk, pk) over BLS12-381 G2 ; pk ∈ G2
Sign(sk, m̄):   σ = (A, e) with A = (g₁ · Π Hᵢ^{mᵢ})^{1/(sk+e)}, e ∈ Zₚ
ProofGen:      π = ZK-PoK{ (σ, disclosed_m̄, hidden_m̄) :
                            Verify(pk, σ, m̄) = 1 }
ProofVerify:   pairing check on π, pk, disclosed_m̄, presentation_header
```

Concrete properties: ~112-byte signatures, ~250–600-byte presentation
proofs depending on disclosed-attribute count, sub-millisecond verify
on commodity hardware once the pairing-friendly curve arithmetic is in
WASM. ZK predicates (range proofs over a rate-limit counter,
set-membership over allowed tiers) plug in as auxiliary
Sigma-protocols sharing the same Fiat-Shamir transcript. Revocation is
handled out-of-band via VC-style status lists or, more cleanly, a
pairing-based dynamic accumulator (`ALLOSAUR`, `VB-Acc`) whose witness
the holder updates per epoch.

Implementations we'd lean on: `@digitalbazaar/bbs-signatures` (TS, used
by the DIF cryptosuite), the `bbs` Rust crate by Hyperledger Labs, and
`blstrs` for the pairing layer. Aggregate-verifier cost is dominated
by a single multi-pairing per presentation; the relay can batch-verify
N presentations in one multi-Miller-loop, which matters at sealed-
inference fan-in.

Subgroup security: BLS12-381 in cofactor-clearing mode is well-trodden
(Ethereum has been running on it since 2020); the BBS spec mandates
subgroup checks on every `pk` and `A` deserialisation, which the
libraries above already enforce.

### 2.2 AnonCreds 2.0 (Hyperledger)

AnonCreds is the Hyperledger Indy/Aries credential format. It uses
Camenisch-Lysyanskaya signatures (CL) over RSA groups rather than
pairing curves; the resulting credential supports selective disclosure
and the same ZK-predicate vocabulary BBS+ does. AnonCreds 2.0 is the
2024 rewrite that drops Indy ledger coupling and standardises the wire
format ([AnonCreds 2.0 specification](https://hyperledger.github.io/anoncreds-spec/)).

Trade-offs vs BBS+: AnonCreds is more mature operationally —
production deployments at scale in EU eID pilots — and interoperates
with a broader SSI ecosystem (Aries agents, OpenID4VC verifier
profiles). The cost is heavier protocol: CL signatures over 2048-bit
RSA are ~512 bytes; full presentations with predicates run multiple
kilobytes; verification involves multiple RSA exponentiations rather
than one multi-pairing. The library surface (`anoncreds-rs`) is large
and pulls in significant transitive deps. The schema model is more
opinionated — credential definitions, schemas, and revocation
registries live in a separate "ledger" abstraction that we'd have to
wedge into our existing Solana model-registry.

### 2.3 Linkable ring signatures / MAC-Wegman-Carter

The lightest option. A linkable ring signature
([LSAG / CryptoNote-style](https://eprint.iacr.org/2004/027)) lets a
signer prove membership in a set of N public keys without revealing
which key signed, and includes a "link tag" that's deterministic in
the signing key — so the verifier can detect a repeat without
identifying the signer. MAC-Wegman-Carter (the construction underneath
Cloudflare's Privacy Pass and Trust Tokens, RFC 9576) achieves a
similar property via blind-signed VOPRF tokens: the user redeems one
token per request, the issuer can't link the redemption to issuance.

These are attractive because they're cheap — Ed25519-class
arithmetic, no pairings — and the implementations are battle-tested.
The cost is expressiveness: there's no attribute model. "Prove the
holder is a Pro subscriber" works (issue Pro tokens from a separate
issuer key); "prove `usage_this_period ≤ limit` in zero knowledge with
the limit value itself hidden" does not — predicates aren't a native
primitive. Adding range proofs on top of VOPRF tokens lands us back at
a BBS+-shaped protocol but with bespoke glue.

## 3. Recommendation

**Ship BBS+ (§2.1).** Specifically: BBS Cryptosuite 2023 over
BLS12-381, issuer in a new `crates/said-bbs-issuer`, presentation
proofs in the sealed envelope header alongside (then replacing) the
trailing Ed25519 signature.

Justification:

1. **Threat fit.** The privacy thesis call-out is "prove a property,
   not an identity." BBS+ is the only one of the three that supports
   *both* membership ("is a registered subscriber") *and* arbitrary
   predicates ("rate-limit headroom remaining," "tier ≥ Pro," "age ≥
   18") in a single ZK proof. The rate-limit predicate matters because
   it's how we replace the per-DID rate limiter in
   `validate_sealed_envelope_bytes` without re-introducing a stable
   identifier.

2. **Spec maturity.** `draft-irtf-cfrg-bbs-signatures` is at draft-07
   on the CFRG track with a stable algorithm; the
   [DIF BBS Cryptosuite 2023](https://www.w3.org/TR/vc-di-bbs/) is a
   W3C VC Working Group note with reference TS implementations.
   AnonCreds 2.0 is mature but heavier; ring-signature/VOPRF
   constructions are lighter but lack predicate expressiveness.

3. **Stack fit.** ghola already runs Ed25519 + X25519 + HKDF-SHA256 +
   AES-GCM (see [cryptographic-primitives.md §"Why these
   choices"](./cryptographic-primitives.md#why-these-choices)). BBS+
   adds BLS12-381 G1/G2 + a pairing engine — that's the only net-new
   primitive. `@noble/curves` ships BLS12-381 and the existing
   sealed-envelope code already imports from `@noble/curves`. On the
   Rust side, `blstrs` and `pairing_ce` are well-maintained and
   compile cleanly inside the relay. No new audit surface for
   hash-to-curve (BBS uses `expand_message_xmd` / `hash_to_curve` from
   `draft-irtf-cfrg-hash-to-curve`, which `@noble/curves` already
   implements for BLS12-381).

4. **Proof size.** BBS+ presentation proofs are ~250–600 B; AnonCreds
   2.0 presentations are multi-KiB. The sealed envelope is already
   tens of KiB; adding 600 B for a proof is invisible. Adding 4 KiB
   per request is not.

The cost is the pairing-curve dependency. We accept it explicitly:
§4.4 specifies that the verifier path runs inside the relay's
existing constant-time validation hot loop, and §9 budgets for the
WASM perf tuning bigint arithmetic needs on the browser side.

## 4. Concrete integration sketch

### 4.1 New code locations

| Concern | Location |
|---|---|
| BBS+ issuer (in-enclave) | new crate `crates/said-bbs-issuer` |
| Shared types (credential, presentation, predicates) | new crate `crates/said-bbs-types` |
| Relay verifier | `crates/thumper-relay/src/auth.rs` — new function `verify_bbs_presentation` |
| TS client (presentation builder) | new module `apps/web/src/lib/anon-cred.ts` |
| Envelope wire format bump | `apps/web/src/lib/envelope.ts` + `crates/said-envelope` — add `presentation_proof` field |
| Revocation accumulator state | new endpoint `GET /v1/anon-cred/accumulator?epoch=N` in thumper-cloud |
| Receipt schema bump | `apps/web/src/lib/receipt.ts` — replace `signer_did + signature` with `presentation_proof + nullifier` |

### 4.2 Issuer location and key ceremony

The issuer lives **inside the cloud's Nitro enclave**, beside the
existing attestation-bound Ed25519 signer described in
[cryptographic-primitives.md §"Attestation"](./cryptographic-primitives.md#attestation-aws-nitro).
The BBS+ secret key `sk_bbs` is generated at enclave boot, never
leaves the enclave, and its corresponding `pk_bbs` is bound to the
attestation `user_data` field alongside the existing X25519/Ed25519
pubkeys. This means any client can verify that the credential they
hold was issued by a *measured* enclave; an attacker who somehow
exfiltrates `sk_bbs` can be detected because the next attestation
quote will pin a fresh `pk_bbs` and the old one stops being authoritative.

Key rotation cadence: 24 h epoch, aligned with the receipt-batcher
period in `crates/said-receipts-service`. At each epoch boundary the
enclave (a) generates a fresh `sk_bbs`, (b) publishes the new `pk_bbs`
+ attestation, (c) accepts a 1-hour overlap during which both epochs'
proofs verify.

### 4.3 Wallet UX and credential binding

The user does **not** see a new credential token in the UI. The flow
mirrors the deterministic vault-key derivation in
`apps/web/src/lib/vault-x25519.ts`:

```
// pseudocode for apps/web/src/lib/anon-cred.ts
challenge = sha512("ghola-bbs-blinding-v1" || user_did || epoch_id)
blinding  = sha512(Turnkey.sign_ed25519(user_id, challenge))
                  [first 32 bytes, reduced mod r of BLS12-381]
```

The user posts a blinded credential request to the issuer endpoint
(`POST /v1/anon-cred/issue`) authenticated by the **legacy**
DID-bearing envelope; the issuer enclave signs the blinded message
vector `(tier, period_start, period_quota, did_commitment)` with
`sk_bbs` and returns the signature. The user unblinds locally. The
credential is cached in IndexedDB keyed by `epoch_id`, encrypted under
the existing vault X25519 key; loss of the cache is recoverable by
re-running the issuance flow (one Turnkey signature, one round trip).

Critically: the issuer learns the user's DID at *issuance time* but
does **not** see which sealed-inference requests later use the
credential. The unlinkability boundary is between issuance and
presentation, not within either.

### 4.4 Relay verifier

`validate_sealed_envelope_bytes`
(`crates/thumper-relay/src/auth.rs:235`) is updated to dispatch on a
new envelope-header flag:

```rust
match header.auth_mode {
    AuthMode::DidSignature => verify_envelope_signature(wire, &header.sender_did),
    AuthMode::BbsPresentation => verify_bbs_presentation(
        wire,
        &header.presentation_proof,
        &state.bbs_issuer_pubkey(header.epoch_id),
        &state.accumulator_state(header.epoch_id),
        &predicate_policy_for_route("sealed_inference"),
    ),
}
```

`verify_bbs_presentation` executes:

1. Parse the proof + disclosed-attribute commitments.
2. Run the BBS-Verify pairing check against `pk_bbs` for the claimed
   epoch.
3. Re-derive the per-request nullifier
   `N = H(epoch_id ‖ sk_holder_commitment ‖ request_window_id)` and
   reject if seen (replaces today's per-DID nonce cache; the
   `request_window_id` floor-divides time by the rate-limit window
   width).
4. Verify the rate-limit range proof: `usage_counter ≤ tier_quota`
   with `usage_counter` and `tier_quota` both hidden, only the
   inequality disclosed.
5. Verify non-revocation: the credential's accumulator witness must
   open against the latest published accumulator state for `epoch_id`.

All five run in constant time relative to the credential's hidden
attributes — there is no branch on disclosed-attribute values.

### 4.5 Rate-limit predicate

Today's per-DID rate limit
(`state.check_sealed_did_rate_limit(&header.sender_did, rate)`)
collapses under anonymous credentials — there is no DID to key by.
Replacement: the credential's signed attribute vector includes
`(period_id, period_quota)`, and the holder maintains a local
`usage_counter` that increments per request. The presentation proves
`usage_counter < period_quota` in ZK using a Bulletproofs range proof
sharing the BBS+ transcript, then derives the nullifier from
`(period_id, usage_counter)` so a re-used counter is detected at the
relay as a duplicate nullifier. This gives us:

- per-period quota enforcement without a server-side counter,
- detection of credential cloning (two devices using the same
  credential will collide on the nullifier and one gets rejected),
- no leak of where in the period the user is.

### 4.6 Revocation

A pairing-based dynamic accumulator (`VB-Acc`) stores the set of
currently-valid credential commitments per epoch. The cloud publishes
`accumulator_state[epoch_id]` at every membership change; the holder
fetches it on each session start and updates a local witness
(`O(log Δ)` time for `Δ` changes since the last fetch). The
presentation proof includes a non-membership proof against
`accumulator_state[epoch_id]`. On subscription expiry / refund / abuse
ban, the cloud removes the credential commitment from the accumulator,
the witness fails to update, and the next presentation fails to
verify.

## 5. Receipt schema change

The receipt body today
(`apps/web/src/lib/receipt.ts`, `RECEIPT_BODY_KEYS`) carries
`signer_did` + `signature` for the user-side proof. Under anonymous
credentials those two fields are replaced by a BBS+ presentation:

```ts
// Replaces signer_did + signature on the user side. Provider side
// (provider_signature, attestation_hash, measurement) is unchanged.
interface ReceiptUserProofV3 {
  /** "bbs-2023" — DIF BBS Cryptosuite. Distinguishes from v2 receipts. */
  proof_suite: "bbs-2023";
  /** BBS+ presentation proof, base64. ~250-600 B. */
  presentation_proof: string;
  /** Disclosed attributes the verifier needs to render the receipt
   *  (e.g. tier label, never the underlying counter). */
  disclosed_attributes: Record<string, string | number>;
  /** Epoch-scoped nullifier H(epoch_id || sk_holder_commitment ||
   *  receipt_window_id). Prevents the user from minting two distinct
   *  receipts off a single credential inside one window. */
  nullifier: string;
  /** Epoch the issuer key + accumulator state belong to. */
  epoch_id: string;
}
```

Verifier rules: a verifier (`/r/[hash]`) fetches the issuer's
`pk_bbs[epoch_id]` from the published attestation chain, the
accumulator state, and the predicate policy in force at
`receipt.issued_at`; verifies the presentation; verifies the
nullifier has not been double-claimed (the receipts service maintains
a per-epoch nullifier set, anchored alongside the Merkle root in
`crates/said-receipts-service`). The receipt body's other fields
(`job_id`, `model_id`, hashes, attestation, provider signature) are
unchanged — the only change is the user-side proof field swap.

## 6. Anonymity-set math

The privacy benefit scales with the size of the anonymity set
`|A_e| = number of valid credentials in epoch e`. For a passive
observer who sees a presentation, the prior probability that any
specific candidate user produced it is `1/|A_e|` plus whatever side
information they can fold in.

| `|A_e|` | What the observer learns from a single presentation |
|---|---|
| 1 | The user. (Pathological case — single-subscriber tier.) |
| 100 | 6.6 bits of identifying info per presentation. |
| 10 000 | 13.3 bits. |
| 1 000 000 | 20 bits. |

Yahya's framing — "anonymity sets are the moat" — is real, with a
caveat we should be honest about: **`|A_e|` is the set of credentials
the issuer has signed in epoch `e`, not the set of users currently
online.** A 1M-credential anonymity set still degrades quickly if the
adversary cross-references the presentation timestamp with a session
fingerprint (IP after OHTTP fails, TLS JA3, payload-size pattern,
account-creation cohort). The credential gives us a strong floor; the
ceiling is set by side channels we close in Tier 2H (cover traffic)
and Tier 2I (padding).

Operational consequence: we want **wide** epochs, not narrow ones —
the longer the epoch, the more credentials accumulate, the bigger the
set. The competing pressure is revocation latency: a wider epoch is a
slower kill switch. 24 h is the chosen balance; expiry of a banned
credential within one calendar day is acceptable for the abuse model
we expect.

## 7. What this does NOT solve

- **Timing correlation between request and response.** Same caveat as
  Tier 2K: the relay sees `T₀` arrival and `T₀ + Δ` departure, which
  fingerprints concurrent requests by RTT envelope. Mitigation lives
  in Tier 2H (cover traffic) and Tier 2I (response-padding buckets).
- **Browser-extension threat.** The credential and its derived
  blinding secret live in browser memory during a session — a
  malicious extension with `activeTab` permission can exfiltrate
  both. Same threat as the existing vault X25519 key. Mitigation: the
  long-term recommendation remains "use the desktop client when
  privacy matters"; out of scope here.
- **Issuer-side compromise.** If `sk_bbs` is stolen, **all**
  credentials it signed can be forged in zero-knowledge — the
  cryptographic guarantee unwinds end-to-end for that epoch. The 24 h
  epoch rotation in §4.2 is the structural mitigation: damage is
  bounded to one epoch, and the rotation cadence is fast enough that
  an exfiltrated key has limited replay value. Enclave attestation on
  every `pk_bbs` publication detects key substitution.
- **Issuance-time linkage.** The issuer learns which DID requested a
  credential. Unlinkability is between issuance and *use*, not within
  issuance. A subpoena against the cloud at issuance time still
  produces a list of credential holders by identity. Mitigation: the
  issuer enclave logs nothing beyond aggregate counts, and the audit
  trail is the attestation chain, not a per-user record.
- **Sybil attacks on the anonymity set.** An adversary who creates N
  fake credentials shrinks the effective set to legitimate users.
  Mitigated by gating issuance on payment (Tier 2K) and Turnkey
  identity proof, neither of which is free to mint.

## 8. Migration path

Three phases, mirroring Tier 2K's rollout cadence:

1. **Phase 0 — optional anonymous credential alongside DID auth.**
   Ship the BBS+ issuer + verifier. Add the `AuthMode` flag to the
   envelope header; relay accepts either `DidSignature` (today's
   path) or `BbsPresentation`. Default in the client is unchanged.
   Goal: live testing on real traffic with no breakage. Verify
   `verify_bbs_presentation` performance under load before flipping
   any default.

2. **Phase 1 — BBS+ required for non-anonymous-by-design tiers (Pro,
   Plus).** The DID-signature path remains for Free tier (where the
   per-DID rate limiter is the rate limiter — Free traffic is
   subsidised and we want the visibility). Pro and Plus users
   transparently get BBS+. The client's tier label drives the path
   choice; users do not see a toggle. Receipt schema bumps to v3 for
   credentialled requests.

3. **Phase 2 — BBS+ everywhere.** Free tier joins. The per-DID rate
   limiter is removed from `validate_sealed_envelope_bytes`; the
   nullifier set + range-proof predicate replace it. The DID-signature
   code path is deleted, not just disabled. We do this **only after**
   we have telemetry showing the nullifier set's false-positive
   collision rate is zero across a full month of Pro traffic.

## 9. Engineering effort estimate

Honest, 1 engineer-week = ~40 focused hours; multiply by ~1.6 for
calendar weeks at 60% allocation.

| Layer | Effort |
|---|---|
| BBS+ library integration (Rust `bbs` + `blstrs`; TS `@digitalbazaar/bbs-signatures` + WASM perf tuning; vector tests vs the CFRG draft test vectors) | 2.5 wk |
| `crates/said-bbs-issuer` — enclave-side issuer, key ceremony, accumulator publication, attestation binding for `pk_bbs` | 2.0 wk |
| `crates/said-bbs-types` — shared credential / presentation / predicate types, canonical encoding | 0.5 wk |
| Relay verifier — `verify_bbs_presentation`, predicate policy, nullifier cache (per-epoch eviction) | 1.0 wk |
| Receipt schema v3 + verifier UI update at `/r/[hash]` to render disclosed attributes and re-run the proof | 1.0 wk |
| Wallet integration — `apps/web/src/lib/anon-cred.ts`, blinded issuance flow, credential storage in encrypted IndexedDB, Turnkey-derived blinding | 2.0 wk |
| Revocation accumulator — cloud endpoint, witness updater, integration with the subscription lifecycle hooks | 1.0 wk |
| Migration + parallel-path testing on Phase 0 | 0.5 wk |
| Internal threat-model review + external audit (BBS+ is in scope of the next planned crypto audit window) | 3.0 wk |
| **Total** | **13.5 engineer-weeks** |

That's the optimistic number. Realistic with WASM perf surprises,
accumulator-witness update bugs, and audit findings: **15–17 wk**. We
commit to the higher number for planning. Compare this honestly with
Tier 2K (~9 wk optimistic / 12–14 wk realistic): Tier 2G is more
expensive because the cryptography is denser and the migration
touches both the client envelope and the relay rate limiter.

## 10. References

- `draft-irtf-cfrg-bbs-signatures` (CFRG draft-07) — BBS+ signature scheme
- [DIF BBS Cryptosuite 2023](https://www.w3.org/TR/vc-di-bbs/) — W3C VC data-integrity binding
- [AnonCreds 2.0 specification](https://hyperledger.github.io/anoncreds-spec/) — alternative we rejected
- RFC 9576 — Privacy Pass redemption (MAC-Wegman-Carter family)
- `draft-irtf-cfrg-hash-to-curve` — hash-to-curve for BLS12-381
- `crates/thumper-relay/src/auth.rs` — current per-DID auth path
- `apps/web/src/lib/envelope.ts` — sealed envelope wire format
- `apps/web/src/lib/sealed-stream.ts` — sealed inference client
- `apps/web/src/lib/vault-x25519.ts` — pattern for Turnkey-derived deterministic key
- `apps/web/src/lib/receipt.ts` — receipt body + canonical signing
- `docs/security/cryptographic-primitives.md` — sibling deep doc
- `docs/security/tier-2k-shielded-payments.md` — payment-side companion

## Next concrete action

Open a PR that introduces `crates/said-bbs-types` with the credential,
presentation, predicate, and nullifier wire types (no crypto yet, just
serde + canonical encoding + golden-vector tests), so the issuer,
relay verifier, receipt schema, and TS client can all start typing
against the same shape while the BBS+ implementation lands behind it.
