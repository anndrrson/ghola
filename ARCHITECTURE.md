# Ghola — Confidential AI as a Composable Trust Stack

> Privacy as an accountable property of each individual message, not a
> blanket policy promise.

## Thesis

Most "private AI" products ask you to trust an operator. Ghola replaces
that promise with a five-layer trust stack where every layer composes a
distinct cryptographic root, and the chain anchors the result onto a
public blockchain so that any third party — not just us — can verify
post-hoc what ran, where, over what data, and with what guarantees.

The user holds the receipt. The receipt is signed by an enclave whose
identity is bound to a hardware attestation. The hash of the receipt
appears in an hourly Merkle root committed to Solana. Three independent
signatures (vendor, operator, anchor) have to all collapse before a
single message's provenance is in doubt.

## Why now

Confidential inference is the killer application for hardware-attested
compute. Microsoft (Confidential Inferencing), Apple (Private Cloud
Compute), Google (Confidential Federated Analytics), and WhatsApp
(Private Processing) have all shipped the same architectural shape
internally — each a vertically integrated, single-operator instance of
the stack below.

Ghola is the open, user-sovereign version. Same cryptographic
primitives, no vendor lock-in, and a public on-chain audit trail.

---

## The Five Layers

For each: what we claim, the cryptographic root we lean on, the trust
assumption that makes the claim hold, how it fails, how it composes
with its neighbors, and where to verify it in the repo.

### Layer 1 — Sovereignty Mode (user-chosen, per message)

**Claim.** The user picks **Local**, **Private**, or **Open** per
conversation. The mode is bound into every receipt. The UI never
silently downgrades the trust label.

**Cryptographic root.** None. The user is the root of trust for their
own intent. Mode is a declarative input that all subsequent layers must
honor.

**Trust assumption.** The user trusts their own decision. The UI is not
allowed to override it.

**Failure mode.** The user picks Private but no attested enclave is
available. We refuse to lie. The system either fails closed, or the
receipt records `mode: "private"` *with a non-empty `caveat` field*
documenting the downgrade. This is enforced in
`apps/web/src/lib/sovereignty.ts::selectRoute` — see the explicit
`caveat:` branch on line 156.

**How it composes.** Mode determines the transport layer 2 selects,
which determines whether layer 3 attestation is required, which is
written into the layer 4 receipt body, which becomes a leaf of the
layer 5 Merkle commitment.

**Status.** ✅ shipped. `apps/web/src/lib/sovereignty.ts`.

**Verify it.** Open ghola.xyz/chat, switch the mode chip in the header,
inspect the receipt badge body for the matching `mode` field.

---

### Layer 2 — Sealed Transport

**Claim.** End-to-end encryption between the user's browser and the
inference enclave. The Ghola-operated relay is on the wire path but
forwards opaque bytes; it cannot read prompts or responses.

**Cryptographic root.**
- **X25519 ECDH** (RFC 7748) — per-message ephemeral key agreement.
- **HKDF-SHA256** (RFC 5869) — key derivation, salt = magic ‖ version,
  info = `"said-envelope-v1/" ‖ recipient_id`.
- **AES-256-GCM** (NIST SP 800-38D) — authenticated encryption.
- **Ed25519** (RFC 8032) — sender signature over `sha256(body)`.

The associated-data binding `ghola-inference-v1|<session_id>|<job_id>`
prevents cross-session replay even when an attacker controls the relay.

**Trust assumption.** Standard NIST and IETF primitives. No new crypto.
Sender's Ed25519 identity key lives inside the user's Turnkey vault and
is never extractable to JavaScript memory.

**Failure mode.** Browser malware that reads plaintext *before* sealing.
Mitigation: Local mode keeps inference on-device entirely and the
ciphertext never enters Ghola infrastructure. Sealed envelopes are also
forgery-resistant — the Ed25519 signature must validate before AEAD
decryption is attempted.

**How it composes.** Layer 3 attestation produces the X25519 public key
that layer 2 seals to. Without a valid attestation, the browser has no
target to seal to and the mode downgrades per layer 1.

**Status.** ✅ shipped. Wire format is `said-envelope-v1` and is
byte-identical between Rust (`crates/said-envelope`) and TypeScript
(`apps/web/src/lib/envelope.ts`).

**Verify it.** Replay the wire trace of a `POST /inference/sealed`
against `ghola-relay.onrender.com`; ciphertext is opaque on the relay's
side. Run `cargo test -p said-envelope` for the round-trip vector tests.

---

### Layer 3 — TEE Attestation

**Claim.** The provider proves to the relay that it is running a
specific binary (measured by PCR0 ‖ PCR1 ‖ PCR2) inside an AWS Nitro
Enclave, before the relay routes any sealed request to it. The user's
browser pulls the attested enclave's public key from the relay and
seals only to that key.

**Cryptographic root.**
- **AWS Nitro Enclaves attestation document** — COSE_Sign1 over CBOR.
- **ECDSA P-384** (NIST FIPS 186) — Nitro's signing curve.
- **AWS Nitro Root G1 certificate** — pinned in `crates/said-attest`
  source, not fetched at runtime.
- **Ghola allowlist signature** — Ed25519 over
  `sha256(PCR0 ‖ PCR1 ‖ PCR2)`, signed offline by a Ghola-controlled
  key whose public half is pinned in the verifier. This is
  defense-in-depth: a vendor cert chain compromise alone is not
  sufficient to inject a malicious enclave.

Two independent roots must both validate. See
`crates/said-attest/src/lib.rs::verify_attestation`.

**Trust assumption.** AWS hardware root + Ghola measurement allowlist.
Compromising one is insufficient.

**Failure mode.** Simultaneous compromise of the AWS Nitro Root G1 cert
*and* the offline Ghola allowlist key. Mitigation: layers 4 + 5 catch
the consequence post-hoc — any forged enclave-signed receipt that
appears in the on-chain Merkle root is a public, auditable artifact.

**How it composes.** Verification yields an `AttestedEnclave` record
containing `enclave_x25519_pub_hex` (consumed by layer 2's seal target)
and `enclave_ed25519_pub_hex` (consumed by layer 4 to verify
`provider_signature`). `attestation_hash` is written into the receipt
body so layer 4 binds the message to the specific quote.

**Status.** 🟡 **v2 dev-mode in production today; v3 in flight.**
The `said-attest` verifier is complete and tested
(`crates/said-attest/tests/integration.rs` walks the full Nitro chain
against mock fixtures). The deployed provider on AWS currently runs
*outside* the enclave on the host (`tee_kind: "none"`), because the
vsock-to-TCP proxy and KMS-signed EIF haven't shipped. The receipt's
`tee_kind` field is honest about this. v3 ETA: ~5-7 hours of focused
engineering, tracked in `STATUS.md`.

**Verify it.** `cargo test -p said-attest --test integration`.
`GET https://ghola-relay.onrender.com/attestations/:hash` returns the
cached quote bytes for any receipt anchored at layer 5.

---

### Layer 4 — Per-Message Receipt

**Claim.** Every assistant message ships a signed, machine-verifiable
record of where it ran, which model produced it, the hashes of input
and output, the issue time, and (for Private mode) the enclave's
attestation hash and measurement.

**Cryptographic root.**
- **Canonical JSON** with fixed key order (see
  `apps/web/src/lib/receipt.ts::RECEIPT_BODY_KEYS`) — eliminates
  serialization-malleability.
- **SHA-256** over the canonical body.
- **Ed25519** signatures, two of them:
  - `signature` — user countersignature via Turnkey, attests "this is
    what my client observed."
  - `provider_signature` — enclave-bound attestation key signature
    (v2), attests "this is what the cloud produced." Verified against
    the `enclave_ed25519_pub_hex` from layer 3.

**Trust assumption.** The holder of the enclave-bound Ed25519 secret is
the one that ran the inference. Layer 3 binds that holder to a specific
measured binary inside a hardware-isolated TEE.

**Failure mode.** Receipt forgery requires either the enclave Ed25519
secret (gated by layer 3) or a break of SHA-256 + canonical-JSON
(implausible). A forged receipt without a matching on-chain Merkle leaf
(layer 5) is publicly detectable.

**How it composes.** The receipt's canonical-body sha256 becomes a
Merkle leaf at layer 5. The user keeps the receipt + the Merkle path
locally and can re-verify against the on-chain root using only public
information (no Ghola server in the path).

**Status.** ✅ shipped. `apps/web/src/lib/receipt.ts` defines
`ReceiptV1` with both signatures. `crates/ghola-gpu-provider/src/
receipt.rs` mints `provider_signature` in-enclave (v2; falls back to
honest `tee_kind: "none"` while v3 lands).
`apps/web/src/components/chat/ReceiptBadge.tsx` exposes a Verify modal
that re-runs both signatures client-side.

**Verify it.** Click any assistant message badge in /chat → "Verify"
button → both signatures check against their respective public keys →
"Check on-chain" button → layer 5.

---

### Layer 5 — On-Chain Anchor

**Claim.** The SHA-256 hash of every receipt's canonical body becomes
a leaf of an hourly binary Merkle tree. The root is committed to Solana
via the `said-receipts` Anchor program, making the existence and
position of each receipt independently verifiable from a public RPC
without any Ghola server in the trust path.

**Cryptographic root.**
- **SHA-256 Merkle** (`rs_merkle`, binary tree).
- **Solana finality** — votes finalized in ~13 seconds on mainnet.
- **`publish_root` instruction** (`programs/said-receipts/src/lib.rs`)
  — accepts `root: [u8; 32]`, `count: u32`,
  `period_start_unix: i64`, `period_end_unix: i64`. PDA seeds
  `["root", period_start_unix.to_le_bytes()]` make every batch
  addressable by start timestamp.

**Trust assumption.** Solana liveness and finalization. The Ghola
receipts service has a funded keypair (an off-chain economic
guarantee) but the program rejects empty batches and invalid period
ranges on-chain — see `ReceiptsError::InvalidPeriod` and
`ReceiptsError::EmptyBatch` in `lib.rs`.

**Failure mode.** Solana reorg deeper than finalization (extremely rare
on mainnet; sub-minute even on devnet). Mitigation: receipts also live
in the user's encrypted local chat-vault, so re-anchoring is always
possible.

**How it composes.** Closes the loop on layers 1–4. A user can hold a
single receipt, derive the Merkle inclusion proof from their local
batch index, and check it against the on-chain root using only the
program ID and any public Solana RPC.

**Status.** 🟢 **devnet live**, mainnet promotion is a budget swap
(3-5 SOL deploy fee + RPC config change).

- **Devnet program:** `EwPWEHv9KVGt9KAGGaqVm3B9c6dLGSGzKZwtc5vFVJja`
- **First anchored batch tx (devnet):**
  `GAh4ojPuvMUNdCXLMC7cNLqKq72qtDMhNYBFVEQPmsqwAqN2cDPHxgaM28Gg4FsS5QAwfkX1FTkiSd49z62MpDc`

**Verify it.** Paste the program ID into
[solscan.io](https://solscan.io) with `?cluster=devnet`; paste the tx
signature into any Solana explorer.

---

## Composition Property

The five layers compose into a single verifiable claim that holds
without trusting Ghola:

> A user holding a chat receipt can prove cryptographically, using only
> public information — a Solana RPC, the AWS Nitro Root G1 cert, the
> Ghola allowlist public key — that the inference ran inside an
> attested enclave executing known code, that the relay never saw
> plaintext, and that no party (Ghola included) has reinterpreted the
> receipt after the fact.

A break in any single layer is detectable from the next:

- A forged enclave attestation (layer 3) cannot produce a valid
  `provider_signature` without also breaking Ed25519 (layer 4).
- A forged receipt cannot appear in the on-chain Merkle root (layer 5)
  unless the receipts service is colluding — and any divergence between
  the user's locally cached batch and the on-chain root is publicly
  observable.
- A swapped on-chain root is detectable by any user whose receipt was
  in the batch — they hold the leaf and can re-derive the tree.

The trust model degrades gracefully: even with `tee_kind: "none"` (v2
dev-mode) the layer 4 + 5 anchor still provides public, append-only
provenance for what the cloud emitted.

---

## Honest Limits

The section that the well-prepared GP reads first.

**TEE side-channels.** Spectre/Foreshadow-class attacks are a known
hazard of any TEE-based architecture. Our defense is layered: the
on-chain anchor at layer 5 makes a side-channel break *detectable*
even when it can't be *prevented*. For users with adversarial threat
models, Local mode (layer 1, `transport: "ghola-home"`) keeps inference
on the user's own device and bypasses the TEE entirely.

**Vendor certificate rotation.** AWS Nitro Root G1 is pinned in
`crates/said-attest` source. Root rotation requires a release build and
a config flag flip; we treat this as planned ops, not crypto.

**v2 dev-mode reality.** Today's production provider runs natively on
an EC2 m5.xlarge host with `tee_kind: "none"`. The relay and the
receipt badge both label this honestly. The full v3 path — Nitro
Enclave with vsock-to-TCP proxy, KMS-signed EIF, and a published
measurement allowlist signature — is engineered and partially wired;
remaining work is bounded and listed in `STATUS.md`.

**Reproducible enclave builds.** Not in v2. Reproducible builds with
published measurements are a v3 requirement; without them the
"measurement allowlist" is operator-controlled rather than community-
verifiable. Anchoring at layer 5 means the operator's choices are
public and append-only, which is a partial mitigation.

**Subpoena resistance.** Real Nitro's hypervisor has no enclave-memory
introspection — once v3 lands, AWS itself cannot peek at user prompts.
v2 dev-mode does not have this property. The receipt's `tee_kind: "none"`
is the honest disclosure.

**Side-channel of meta-data.** The relay sees ciphertext bodies but
also routing metadata (`enclave_key_id`, `mode_hint`, traffic timing).
Anonymity at the metadata layer is out of scope for v2.

---

## What This Composes With

Confidential AI is one half of the Ghola thesis. The other half —
agent identity, headless commerce, and the `said-registry` /
`said-x402` payment rail — is documented separately in
**`AGENT-COMMERCE.md`** (forthcoming). The two halves share
`said-envelope` (Layer 2) and `said-turnkey` (the wallet/HSM substrate)
as common infrastructure.

---

## Where to Look

Everything in this document is reproducible from the repo. The
mapping from each claim above to file paths, commits, deployed URLs,
program IDs, and example transactions lives in
[`STATUS.md`](./STATUS.md).
