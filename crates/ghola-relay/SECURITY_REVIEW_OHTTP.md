# SECURITY_REVIEW_OHTTP — `crates/ghola-relay/src/ohttp.rs`

Audit-style review of the hand-rolled HPKE (RFC 9180) + OHTTP capsule
framing (RFC 9458) + BHTTP (RFC 9292) implementation. Scope: read-only
review of the gateway-side decapsulation path that fronts user prompts.
Reviewer: property-test author (this commit). Date: 2026-05-14.

**No production code was changed.** One pre-existing test bug was
identified (see §6) and the equivalent pattern in a new test was
corrected before commit. The flagged production-side concerns below are
NOT bugs in the cryptographic sense, but each is worth a human
cryptographer's eyes before this fronts real user prompts.

---

## 1. HKDF labels and suite IDs (RFC 9180 §4 / §7.1.3)

Verified byte-for-byte:

| Construct       | Code | RFC 9180 |
|-----------------|------|----------|
| Version prefix  | `"HPKE-v1"` | §4 ✓ |
| KEM suite_id    | `"KEM" \|\| 0x0020` (5 bytes) | §7.1.3 ✓ |
| HPKE suite_id   | `"HPKE" \|\| 0x0020 \|\| 0x0001 \|\| 0x0002` (10 bytes) | §5.1 ✓ |
| ExtractAndExpand labels | `"eae_prk"`, `"shared_secret"` | §7.1.3 ✓ |
| KeySchedule labels | `"psk_id_hash"`, `"info_hash"`, `"secret"`, `"key"`, `"base_nonce"`, `"exp"` | §5.1 ✓ |

`mode_base = 0` is correctly used (no PSK). `info_hash` is computed over
the OHTTP request info (`"message/bhttp request" || 0x00 || hdr`), which
matches RFC 9458 §4.3. **All labels are correct.**

## 2. AEAD nonce derivation

OHTTP encrypts exactly one request and one response per HPKE context,
so seq always = 0 and `nonce = base_nonce XOR seq_be(0) = base_nonce`.
The code uses `base_nonce` directly. This is correct for capsule mode
(RFC 9458 §4.3). **Not a nonce reuse — different HPKE contexts have
different `base_nonce` because the KEM share is per-request.**

For the response, RFC 9458 §4.4's plain-HKDF (NOT LabeledExpand) is
correctly used: `prk = Extract(salt=enc||resp_nonce, secret)`, then
`Expand(prk, "key", Nk)` and `Expand(prk, "nonce", Nn)`. `resp_nonce` is
freshly drawn from `OsRng` per response. ✓

## 3. Ordering of cheap checks before AEAD

`decapsulate_request` performs: length check → header parse → key_id
match → KEM/KDF/AEAD id match → DH → key schedule → AEAD open. The
cheap rejects (wrong key id, unknown suite) happen before any DH work.
**Good for DoS.** No reordering needed.

## 4. Panic surface on attacker-controlled bytes

Audited every `unwrap`/`expect` path reachable from `decapsulate_request`:

- `Aes256Gcm::new_from_slice(&key)` — `key` is `[u8; 32]` from HKDF
  expand; can only fail on wrong length. Mapped to `OhttpError::AeadOpen`.
- `Nonce::from_slice(&base_nonce)` — `base_nonce` is `[u8; 12]`; safe.
- `PublicKey::from(enc)` (x25519-dalek) — accepts any 32 bytes,
  infallible by RFC 7748. Low-order points produce a predictable zero
  shared secret but the attacker still cannot forge a valid AEAD tag
  under the derived key, so this is informational only.
- `read_lenprefixed` in BHTTP — checked end bounds, returns `None` on
  overrun. Hand-fuzzed in `bhttp_malformed_input_rejected_without_panic`
  (32 random buffers + 6 structured malformed cases) — no panic seen.

**No panic-DoS vectors found in production code paths.**

## 5. Zeroize / key lifetime hygiene (FLAG)

`StaticSecret` (the gateway long-lived X25519 secret) implements
`Zeroize` and clears on drop — fine. **However**, the derived
per-request material is NOT zeroized:

- `key: [u8; 32]`, `base_nonce: [u8; 12]`, `exporter_secret: [u8; 32]`
  on the stack inside `decapsulate_request` and `encapsulate_response`.
- `secret`, `prk`, response `key`, `nonce_bytes` in
  `encapsulate_response`.
- `ResponseContext::export_secret` (lives through the handler).
- `Aes256Gcm` cipher's internal AES key schedule.

For a long-lived axum handler under SIGSEGV/coredump or a heap-disclosure
exploit, these stay in process memory until reused or overwritten. This
is **lower severity than a CLI tool** but worth flagging. Suggested fix
(future, not this PR): wrap these in a `Zeroizing<[u8; N]>` from the
`zeroize` crate (already in workspace deps via `ed25519-dalek`).

## 6. NIT — pre-existing test bug

`ohttp::tests::rejects_wrong_key_id` ends with `matches!(err,
OhttpError::UnknownKeyId(_));` — this is a free-standing bool expression
whose value is discarded. The test passes regardless of which error
variant `decapsulate_request` returned. The new
`proptest_ohttp::wrong_key_id_rejected` test uses an explicit `match`
and pins the variant.

This is a test-quality issue, not a production-code issue. Leaving the
original test in place per the "don't touch production code" rule, but
flagging.

## 7. Things this review did NOT cover

- **Side-channel timing**: `aes-gcm` (RustCrypto) is software AES.
  Without AES-NI it is potentially timing-variable. Out of scope.
- **`hpke-js` (TypeScript) constant-time properties.** Same caveat.
- **Cross-runtime test vectors**: TS uses `hpke-js`, Rust uses
  hand-rolled HPKE. Both pass their own self-tests, and the labels are
  verified to match byte-for-byte. A `cargo run --example
  generate_vectors` → vitest fixture would be the canonical
  cross-impl check; out of scope for this property-test pass.

## 8. Test coverage added by this PR

Rust (`mod proptest_ohttp` in `ohttp.rs`):

- `fuzz_request_round_trip` — 32 random plaintexts (incl. empty)
- `fuzz_response_round_trip` — 32 random response bodies
- `fuzz_aead_tamper_detection` — 32 bit-flips inside request capsule
- `fuzz_response_tamper_detection` — 32 bit-flips inside response
- `wrong_key_id_rejected` — explicit variant assertion
- `wrong_gateway_key_rejected` — different secret, same key_id → AeadOpen
- `truncation_rejected_without_panic` — `[..n-1]`, `[..n/2]`, `[]`
- `random_capsule_never_panics` — 32 random byte buffers
- BHTTP: empty body, empty headers, no path, CR/LF header value
- `bhttp_malformed_input_rejected_without_panic` — 32 garbage + 6 structured
- `bhttp_response_status_3byte_varint_round_trip` — varint boundaries

TypeScript (`apps/web/src/lib/ohttp.test.ts`):

- Empty body / empty headers / CR/LF in header value
- `decodeBhttpResponse` malformed input
- `decodeBhttpResponse` fuzz over 32 random buffers
- 8-iter encap → hpke-js-recipient decap round-trip (mirrors what the
  Rust gateway does at request time)
- 16-iter single-bit-flip tamper detection on the request capsule
- `decapsulateResponse` truncation rejection
