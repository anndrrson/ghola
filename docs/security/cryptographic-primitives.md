# Cryptographic Primitives in ghola

This document covers the cryptographic constructions used in the
ghola sealed-envelope path. It is targeted at a technical reviewer
who wants to verify that the privacy claim is meaningful — not just
"we used X25519." Every primitive choice is justified against the
threat model in [SECURITY.md](../../SECURITY.md).

## Sealed envelope (Private mode)

The end-to-end protocol that carries a chat message from the user's
browser to the inference provider's enclave and back.

### Construction

```
sealed = ENC( recipient_x25519_pub, message || tag )

where ENC(P, m) =
  1. eph_priv, eph_pub = X25519_keypair()
  2. shared = X25519_ECDH(eph_priv, P)
  3. key = HKDF-SHA256(shared, "ghola-envelope-v1", info=session_id)
  4. nonce = 12 random bytes
  5. ciphertext, tag = AES-256-GCM(key, nonce, m, aad=session_id || sender_did)
  6. return SEv1_HEADER || eph_pub || nonce || ciphertext || tag
```

Header layout (`apps/web/src/lib/envelope.ts`):

```
0  3  | magic "SEv1" (0x53 0x45 0x76 0x31)
4  4  | version = 1
8  20 | sender DID (Ed25519 multicodec prefix + 32-byte key)
40 1  | recipient kind: 0x01 = relay, 0x02 = ModelBridge enclave
41 32 | ephemeral X25519 pub
73 12 | nonce
85 .. | AES-256-GCM ciphertext + 16-byte tag
```

### Why these choices

| Choice | Rationale |
|---|---|
| **X25519** for ECDH | Industry-standard curve, constant-time, no patent encumbrance, broad library support (`@noble/curves`). Considered: P-256 (rejected — slower, no obvious advantage), Curve448 (rejected — overkill for 128-bit security). |
| **AES-256-GCM** for AEAD | Hardware acceleration on every modern CPU including iPhone Secure Enclave. Considered: ChaCha20-Poly1305 (good fallback for non-AES-NI hardware; may add later for mobile battery). |
| **HKDF-SHA256** for key derivation | Standard, well-analyzed, separates ECDH shared secret from the AEAD key so a compromise of one doesn't leak the other. `info` parameter binds to `session_id` so keys from different sessions can't be confused. |
| **AAD = session_id ‖ sender_did** | Replay defense (same key + nonce + message in a different session fails). Sender binding prevents an attacker from re-encrypting an observed plaintext under their own DID. |
| **Ephemeral X25519 keypair per message** | Forward secrecy. Compromise of the user's long-term identity key does not retroactively decrypt past sessions. |
| **Random 96-bit nonce** | Standard NIST recommendation for GCM. Birthday-bound at ~2^32 messages per key; the recipient key is rotated per attestation expiry (~1 hour) so the bound is never approached in practice. |

### What the relay sees

A `sealed` blob is opaque to the relay. The relay reads:
- The `SEv1` magic to dispatch to the sealed handler.
- The `recipient kind` byte to know which enclave key id to address.
- The `sender DID` for rate limiting and auth.

It does **not** read the ephemeral pub, the ciphertext, or the
plaintext — even decryption of the ECDH shared secret is impossible
without the recipient's private key, which never leaves the enclave.

### What the enclave does

1. Verifies the `sender_did` is in the active DID set (`did_set`
   snapshot from ghola-cloud, refreshed periodically).
2. Recomputes `shared = X25519_ECDH(enclave_priv, eph_pub)`.
3. Derives `key = HKDF-SHA256(shared, "ghola-envelope-v1", info=session_id)`.
4. Decrypts with the AAD bound to `(session_id, sender_did)`.
5. Replay-checks the `(session_id, nonce)` pair against a recent-nonce
   cache (defaults to 1024 entries per session, ~hour TTL).
6. Runs inference.
7. Builds the response envelope sealed back to the user's vault key
   (a separate Turnkey-derived deterministic X25519 keypair —
   `apps/web/src/lib/vault-x25519.ts`).

### Vault key derivation

The user's X25519 vault key is derived deterministically from a
Turnkey-held Ed25519 identity key, so the same browser session can
reconstruct it across reloads without storing the secret anywhere:

```
challenge = sha512("ghola-vault-x25519-v1" || user_did)
signature = Turnkey.sign_ed25519(user_id, challenge)
vault_secret = sha512(signature) [first 32 bytes, clamped per RFC 7748]
vault_pub = X25519_pub(vault_secret)
```

Properties:
- The vault secret never appears in localStorage. It's reconstructed on demand from a Turnkey signature.
- A reader of the user's filesystem cannot recover the vault secret without also compromising Turnkey.
- A Turnkey compromise gives an attacker the *ability to sign* but not the past traffic — sealed envelopes used ephemeral pubs, so re-deriving the vault secret doesn't decrypt past ciphertexts.

## Receipt signing (post-message provenance)

Every assistant message ships with a `ReceiptV1` (see
`apps/web/src/lib/receipt.ts`):

```
ReceiptV1 {
  version: 1,
  job_id, mode, provider_id, model_id,
  input_token_hash, output_token_hash,   // sha256 hex of canonical text
  issued_at, enclave_key_id, attestation_hash, measurement,
  signer_did, signature,                  // user's Ed25519 sig over canonical body
  provider_signature                       // enclave's Ed25519 sig, v2 receipts
}
```

The canonical signing bytes are `JSON.stringify(body)` with a
fixed-order key list (`RECEIPT_BODY_KEYS`). Both the user and the
enclave sign the same bytes so the two signatures are independently
verifiable from one receipt body.

A third party verifies a receipt by:
1. Re-deriving the canonical body bytes from the receipt fields.
2. SHA-256 the body to get the digest.
3. `ed25519_verify(signer_pub, digest, signature)`.
4. For v2 receipts, also `ed25519_verify(enclave_pub, digest, provider_signature)` after fetching the attestation doc that binds `enclave_pub` to the enclave measurement.

The public verifier at `/r/[hash]` runs all four steps client-side.
No trust in the ghola backend is required to verify a receipt.

## On-chain anchoring (Merkle batches)

Receipts are Merkle-batched and the batch root is anchored on
Solana. The merkle tree uses sorted leaves and standard pair-hashing
(`crates/said-receipts-service/src/merkle.rs`).

| Property | Construction |
|---|---|
| Leaf | SHA-256 of canonical receipt body |
| Internal node | SHA-256(left ‖ right) where left ≤ right (sorted to avoid second-preimage on order) |
| Batch period | 1 hour (configurable via batcher_interval_secs) |
| On-chain ix | `said_receipts::publish_root(root, count, period_start_unix, period_end_unix)` |
| PDA | `[b"root", period_start_unix.to_le_bytes()]` so batches are addressable by timestamp |

A user with a receipt can fetch its Merkle inclusion proof from the
receipts service (`GET /v1/receipts/{hash}/proof`) and verify against
the on-chain batch root independently of the receipts service.

## Attestation (AWS Nitro)

The relay accepts a provider as "attested" only after verifying:

1. The provider sent a `ProviderAttestPayload` with a vendor quote
   from the NSM (`crates/ghola-relay/src/handlers.rs::handle_provider_attest`).
2. The quote's `user_data` field binds the provider's claimed
   X25519 + Ed25519 pubkeys + a freshness timestamp (so a recorded
   quote can't be replayed past expiry).
3. The PCRs in the quote match the expected enclave measurement
   (PCR0 || PCR1 || PCR2 concatenated).
4. The quote's signature chain links to the AWS Nitro root CA.

**Hardening (Tier 1E, shipped)**: in release builds the dev bypass
(`GHOLA_ALLOW_UNATTESTED=1`) compiles to `false` regardless of env
state. Production cannot be coerced into accepting a synthetic quote
by flipping an env var.

## Model integrity (loader-level SRI)

WebLLM downloads three artifacts to bootstrap inference:

| Artifact | Purpose | Size |
|---|---|---|
| `mlc-chat-config.json` | model config (context window, conv template) | 2 KB |
| `*.wasm` model_lib | WebGPU kernel + tokenizer fast-path | 5 MB |
| `tokenizer.json` | tokenizer vocab | 9 MB |

Each is SRI-pinned in `apps/web/src/lib/webgpu-inference.ts::DEFAULT_WEBGPU_MODEL_INTEGRITY`. WebLLM verifies on download with `onFailure: "error"` so a tampered artifact halts engine construction. The hashes were computed from the upstream HuggingFace + binary-mlc-llm-libs artifacts at the model_version pinned in WebLLM (`v0_2_83/base`).

The multi-GB weight shards are NOT covered by ModelIntegrity. They
are covered by `computeLoadedWeightFingerprint()` which hashes the
CacheStorage entries after load and produces a deterministic
manifest fingerprint. Once the on-chain `ghola-model-registry`
program is deployed, the fingerprint compares against the published
`weights_hash` for byte-level integrity.

## Replay protection

| Layer | Mechanism |
|---|---|
| Envelope | AAD bound to (session_id, sender_did); enclave keeps a per-session nonce cache. |
| Relay auth | Per-DID nonce + replay cache on `verify_auth`. Same nonce in the same time window is rejected. |
| Receipt anchoring | Receipts are unique by canonical body hash; double-submission collapses to a single Merkle leaf. |
| x402 payments | Each settlement carries a unique Solana tx signature; the merchant verifies on-chain finality. |

## What this stack does NOT protect against

Listed in [SECURITY.md](../../SECURITY.md), summarised here:

- **Compromised web client (no SRI manifest on the bundle).** Tier 1C
  follow-up: ship a reproducible build + published SRI manifest so a
  reviewer can verify the loader.
- **Coerced model behavior.** Attestation proves *which* model ran,
  not that the model itself is well-aligned. Backdoored training
  data is out of scope.
- **Hardware root of trust.** AWS Nitro and NVIDIA CC depend on the
  vendor's root key not being compromised. The decentralized
  provider network (Tier 2F) is the structural mitigation — multiple
  hardware roots, multiple jurisdictions.
- **Active surveillance of a single user.** Anonymity sets (Tier 2G
  + Tier 2K shielded payments) close the metadata leak. Until then,
  the user's wallet address is linkable to their inference calls.

## References

- RFC 7748 — X25519 / Curve25519
- RFC 5869 — HKDF
- RFC 5116 — AEAD interface (AES-GCM)
- AWS Nitro Enclaves whitepaper — attestation document format
- `apps/web/src/lib/envelope.ts` — wire format
- `apps/web/src/lib/sealed-stream.ts` — client streaming
- `apps/web/src/lib/vault-x25519.ts` — deterministic vault key derivation
- `crates/ghola-relay/src/handlers.rs` — server-side verification
- `crates/ghola-gpu-provider/src/enclave.rs` — enclave-side key gen + signing
- `programs/said-receipts/src/lib.rs` — on-chain batch anchor
- `programs/ghola-model-registry/src/lib.rs` — content-addressed model registry (scaffolded)
