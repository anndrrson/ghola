# Ghola Implementation Status

The verifiable mapping from every claim in [`ARCHITECTURE.md`](./ARCHITECTURE.md)
to file paths, commit hashes, deployed URLs, Solana program IDs, and
example transactions. A reviewer should be able to `gh repo view` this
repo and confirm every line below in under fifteen minutes.

Last updated: 2026-05-14.

---

## Live URLs

| Service | URL | Purpose |
|---|---|---|
| Web app | https://ghola.xyz | Next.js front-end, auto-deployed from `main` to Vercel |
| Relay | https://ghola-relay.onrender.com | `thumper-relay`: `/health`, `/providers/attested`, `/inference/sealed`, `/attestations/:hash` |
| Receipts anchor | https://ghola-receipts.onrender.com | `said-receipts-service`: Merkle batcher + Solana publisher (boot pending dashboard DB link) |

Each is reachable without auth for the public-shaped endpoints. Try:

```
curl https://ghola-relay.onrender.com/providers/attested
```

---

## Solana Programs

### `said-receipts` — On-chain Merkle anchor (Layer 5)
- **Cluster:** devnet
- **Program ID:** `EwPWEHv9KVGt9KAGGaqVm3B9c6dLGSGzKZwtc5vFVJja`
- **Anchor version:** 0.30.1
- **Source:** [`programs/said-receipts/src/lib.rs`](./programs/said-receipts/src/lib.rs)
- **First anchored batch tx (devnet):**
  `GAh4ojPuvMUNdCXLMC7cNLqKq72qtDMhNYBFVEQPmsqwAqN2cDPHxgaM28Gg4FsS5QAwfkX1FTkiSd49z62MpDc`
- **Mainnet status:** roadmap; promotion is a 3–5 SOL deploy + RPC swap.

### `said-registry` — Agent identity (out of scope for this doc)
- **Cluster:** mainnet
- **Program ID:** `3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR`
- **Source:** [`programs/said-registry/`](./programs/said-registry/)
- See `AGENT-COMMERCE.md` (forthcoming) for the agent-commerce thesis.

---

## Rust workspace — confidential-AI crates

| Crate | Purpose |
|---|---|
| [`crates/said-envelope/`](./crates/said-envelope/) | `said-envelope-v1` sealed wire format — X25519 + AES-256-GCM + HKDF-SHA256 + Ed25519. Vector tests live in this crate. |
| [`crates/said-attest/`](./crates/said-attest/) | AWS Nitro attestation verifier (`nitro.rs`), Ghola allowlist verifier (`allowlist.rs`), `verify_attestation` entry point in `lib.rs`. |
| [`crates/said-turnkey/`](./crates/said-turnkey/) | Turnkey HSM-backed key wrap — P-256 X-Stamp adapter for browser-side Ed25519 signing. |
| [`crates/thumper-relay/`](./crates/thumper-relay/) | Provider intake + sealed-inference forwarder + attested-providers state. Deployed at `ghola-relay.onrender.com`. |
| [`crates/thumper-gpu-provider/`](./crates/thumper-gpu-provider/) | In-enclave provider runtime — Ollama bridge, per-message receipt signer, WS reconnect loop. |
| [`crates/said-receipts-service/`](./crates/said-receipts-service/) | Off-chain Merkle batcher + Solana publisher. Deployed at `ghola-receipts.onrender.com`. |
| [`crates/ghola-home/`](./crates/ghola-home/) | Local-mode bridge — Ollama on `127.0.0.1:7878` for Layer 1 Local transport. |

Build the whole workspace:

```
cargo build --workspace
```

---

## Web modules (Next.js, `apps/web/`)

| Path | Layer | Role |
|---|---|---|
| [`apps/web/src/lib/sovereignty.ts`](./apps/web/src/lib/sovereignty.ts) | 1 | `useSovereigntyMode`, `selectRoute`, attested-enclave fetch. |
| [`apps/web/src/lib/envelope.ts`](./apps/web/src/lib/envelope.ts) | 2 | Web Crypto port of `said-envelope-v1`. Byte-identical to Rust. |
| [`apps/web/src/lib/sealed-stream.ts`](./apps/web/src/lib/sealed-stream.ts) | 2 | Single-round-trip sealed-inference client (`streamSealedChat`). |
| [`apps/web/src/lib/vault-x25519.ts`](./apps/web/src/lib/vault-x25519.ts) | 2 | Deterministic Turnkey-gated X25519 keypair derivation. |
| [`apps/web/src/lib/receipt.ts`](./apps/web/src/lib/receipt.ts) | 4 | `ReceiptV1` schema, `makeReceipt`, `verifyReceipt`, `verifyProviderSignature`, `fetchAttestation`. |
| [`apps/web/src/components/chat/ReceiptBadge.tsx`](./apps/web/src/components/chat/ReceiptBadge.tsx) | 4 | UI badge + Verify modal + "Check on-chain" handoff. |
| [`apps/web/src/app/security/page.tsx`](./apps/web/src/app/security/page.tsx) | — | Public-facing security/roadmap page; kept consistent with this doc. |
| [`apps/web/src/middleware.ts`](./apps/web/src/middleware.ts) | — | CSP `connect-src` allowlist; bots blocked from indexing. |

Build the web app:

```
cd apps/web && npm run build
```

---

## Wire formats (committed, stable)

### `said-envelope-v1`
- Magic: `"SEv1"` (`0x53 0x45 0x76 0x31`), version byte `0x01`.
- Ephemeral X25519 pub: 32 bytes.
- AES-256-GCM nonce: 12 bytes, tag: 16 bytes.
- Sender Ed25519 signature over `sha256(body)`: 64 bytes.
- HKDF info: `"said-envelope-v1/" ‖ recipient_id`.
- Recipient kinds: `0x00` self, `0x01` peer-DID, `0x02` model-bridge.
- Defined in [`crates/said-envelope/src/lib.rs`](./crates/said-envelope/src/lib.rs)
  and mirrored byte-for-byte in [`apps/web/src/lib/envelope.ts`](./apps/web/src/lib/envelope.ts).

### `ReceiptV1`
- Canonical JSON key order:
  `version, job_id, mode, provider_id, model_id, input_token_hash,
   output_token_hash, issued_at, enclave_key_id, attestation_hash,
   measurement`.
- Signed by user (`signer_did` + `signature`) and, in v2,
  countersigned by the enclave (`provider_signature`).
- Defined in [`apps/web/src/lib/receipt.ts`](./apps/web/src/lib/receipt.ts);
  matched on the producer side in
  [`crates/thumper-gpu-provider/src/receipt.rs`](./crates/thumper-gpu-provider/src/receipt.rs).

### `ProviderAttestPayload`
- Provider → relay handshake message containing the vendor quote +
  Ghola allowlist signature, consumed by `verify_attestation`.
- Defined in [`crates/thumper-types/src/command.rs`](./crates/thumper-types/src/command.rs).

---

## Pre-existing primitives (re-used, not invented)

| Primitive | Spec |
|---|---|
| X25519 ECDH | RFC 7748 |
| AES-256-GCM | NIST SP 800-38D |
| HKDF-SHA256 | RFC 5869 |
| Ed25519 | RFC 8032 |
| COSE_Sign1 | RFC 8152 |
| ECDSA P-384 | NIST FIPS 186 |
| AWS Nitro Enclaves attestation | AWS-published format |
| Binary Merkle (SHA-256) | `rs_merkle` |
| Anchor framework | 0.30.1 |

No new crypto. The novelty is the *composition*.

---

## Honest gaps (what is NOT yet built)

These are the items that would make the v3 promise true end-to-end.
None of them are research problems; all are bounded engineering.

| Gap | Layer | Estimated effort |
|---|---|---|
| vsock-to-TCP proxy inside the EIF so the in-enclave provider can reach the relay | 3 | ~3–4 hours |
| KMS-signed EIF + non-DEBUG_MODE enclave launch | 3 | ~1–2 hours of AWS console + signing flow |
| Reproducible enclave builds + published measurement allowlist signatures | 3 | ~1 day (Docker base pinning + CI signing) |
| Mainnet promotion of `said-receipts` | 5 | 3–5 SOL + RPC config swap |
| `ghola-receipts` Render DB link | ops | 2 dashboard clicks (user task) |

When all five land, the deployed provider stops being labeled
`tee_kind: "none"` and starts emitting `tee_kind: "nitro"` with a
verifiable attestation hash on every receipt.

---

## What recently shipped

| Date | Commit | What |
|---|---|---|
| 2026-05-14 | `d833a55` | Default sealed `model_id` to `llama3.2:3b` to match the deployed Ollama model |
| 2026-05-14 | `0c0488a` | WebSocket reconnect loop on `thumper-gpu-provider` (exponential backoff 1s → 60s) |
| 2026-05-14 | `cdb625b` | CSP `connect-src` allowlist for `ghola-relay` + `ghola-receipts` |
| 2026-05-13 | `a992606` | Bump Rust to 1.85.0 in EIF builder (edition2024 transitive dep) |
| 2026-05-13 | `257e90e` | `--allowerasing` on AL2023 runtime `dnf install` (curl-minimal conflict) |
| 2026-05-13 | `6daaf67` | Auto-submit receipts to `ghola-receipts` service on every chat |
| 2026-05-13 | `0ee4994` | `Dockerfile.receipts` multi-stage build for `said-receipts-service` |
| 2026-05-13 | `871caae` | Receipts batcher ensures `period_end > period_start` (avoids `InvalidPeriod`) |
| 2026-05-13 | `731df26` | `said-receipts` program deployed to Solana devnet at `EwPWEHv9KV…VJja` |
| 2026-05-13 | `f91754b` | v2 integration merged to `main` (Track G + H + I) |

---

## Red-team self-audit

Ten questions a serious reviewer will ask, answered up front.

1. **Show me the attestation chain in a real receipt.** Today, not
   possible end-to-end: deployed provider is `tee_kind: "none"`. The
   *verifier* is complete (`crates/said-attest/tests/integration.rs`).
   v3 closes this with the vsock proxy + KMS-signed EIF.
2. **Show me a `publish_root` tx on a public chain.** Devnet: yes,
   `GAh4ojPuvMUNdCXL…D49z62MpDc`. Mainnet: roadmap.
3. **Reproducible enclave builds?** v3 requirement. Until then the
   measurement allowlist is operator-controlled; the on-chain anchor
   means operator choices are append-only and publicly observable.
4. **What stops Ghola from logging plaintext?** v2 dev-mode:
   nothing structural; open code + honor system. v3: enclave isolation
   removes the option entirely.
5. **What stops AWS from logging plaintext?** v2 dev-mode: nothing
   (the binary runs on the host). v3: Nitro's hypervisor has no
   enclave-memory introspection.
6. **What if the Ghola allowlist key leaks?** Attestation falls back
   to vendor-cert-only verification. Receipts anchored before the leak
   remain verifiable. Layer 5 makes any post-leak forgery publicly
   detectable.
7. **Why Solana, not Ethereum?** Per-batch cost + ~13s finality + a
   one-instruction Anchor program. Chain-agnostic in principle — one
   config swap.
8. **Where's Local mode's TEE story?** The user's own device is the
   trust boundary. We do not claim a vendor TEE on the macOS path; the
   receipt is self-signed via Turnkey and the user is the root.
9. **Throughput / scale?** Out of scope for v2 architecture. The
   sealed-transport path is single-round-trip per message; the relay
   is stateless w.r.t. payload bodies; the receipts service batches
   hourly to bound on-chain cost.
10. **Are enclave images deterministic?** Not in v2. v3 requirement.
    Until then, each EIF build mints fresh keys.

---

## Reproducing the verification, end to end

Anyone with `cargo`, `npm`, `solana`, and a browser can do this:

```bash
# 1. Verify the envelope wire format (Rust & TS agree byte-for-byte)
cargo test -p said-envelope

# 2. Verify the Nitro attestation logic
cargo test -p said-attest --test integration

# 3. Verify a receipt's signatures in the browser
#    Open ghola.xyz/chat → send a message → click the receipt badge →
#    "Verify" (signature) → "Check on-chain" (Merkle inclusion).

# 4. Verify the on-chain root independently
solana confirm -v <tx-sig> --url https://api.devnet.solana.com
solana program show EwPWEHv9KVGt9KAGGaqVm3B9c6dLGSGzKZwtc5vFVJja --url devnet
```

No Ghola server is needed in the verification path beyond fetching the
attestation document — and even that can be cached locally.
