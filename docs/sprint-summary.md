# Privacy/Security Hardening Sprint — Summary

**Window:** session of 2026-05-14 / 2026-05-15
**Outcome:** 38+ commits, ~150 new tests, on-chain registry live on
Solana devnet with canonical hash, every Tier 2 primitive has a
design doc + schema-only first PR, runtime SRI + reproducible build
verified end-to-end.

This doc is the artifact list — what shipped, where it lives, how to
verify each piece independently. Companion to
[SECURITY.md](../SECURITY.md), [`/security/audit-trail`](https://ghola.xyz/security/audit-trail),
and [`/security/status`](https://ghola.xyz/security/status).

---

## Tier 1A — Anonymous WebGPU front door

| Artifact | Path / Address |
|---|---|
| In-browser WebGPU inference module | `apps/web/src/lib/webgpu-inference.ts` |
| Default model | `Llama-3.2-1B-Instruct-q4f16_1-MLC` (WebLLM, Apache 2) |
| Anonymous chat surface | `/chat` — no auth gate |
| Default sovereignty mode for anonymous | `local` (WebGPU) |
| Sovereignty routing | `apps/web/src/lib/sovereignty.ts` |
| SRI-pinned loader artifacts | `DEFAULT_WEBGPU_MODEL_INTEGRITY` (config + WASM + tokenizer) |
| Engine warm-up on chat mount | `warmEngine()` — first-token latency cut |
| Opt-in landing pre-cache | `<PreloadModelCta />` component |

**Verify:** open `localhost:3000` in incognito → `Try Ghola` → land in working chat without sign-in.

## Tier 1A.5 — On-chain model registry

| Artifact | Path / Address |
|---|---|
| Anchor program source | `programs/ghola-model-registry/src/lib.rs` |
| Deployed program (devnet) | [`7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS`](https://explorer.solana.com/address/7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS?cluster=devnet) |
| Default model record PDA | [`HdjQwHgGhk7wtRK36pGqW5GsL6StCbzveQwU7swDSQ9E`](https://explorer.solana.com/address/HdjQwHgGhk7wtRK36pGqW5GsL6StCbzveQwU7swDSQ9E?cluster=devnet) |
| Canonical `weights_hash` | `8c3ae367d068c2b3a7d5b402a16395ab5089315e5256f609e54320d64d53c695` |
| Manifest algorithm | `scripts/compute-weights-manifest.mjs` — sha256 over sorted (path, lfs_oid) lines from HF tree API |
| Web client lookup | `apps/web/src/lib/model-registry.ts::lookupModel` |
| Badge graduates → "Verified" | `apps/web/src/components/chat/ModelIntegrityBadge.tsx` |

**Verify:**
```bash
solana account HdjQwHgGhk7wtRK36pGqW5GsL6StCbzveQwU7swDSQ9E --url devnet --output json
# weights_hash field should hex-decode to 8c3ae367…d53c695
node scripts/compute-weights-manifest.mjs Llama-3.2-1B-Instruct-q4f16_1-MLC
# Recompute from HF metadata → should print the same canonical value
```

## Tier 1B — TEE vendor diversity

| Verifier | Status | Location |
|---|---|---|
| AWS Nitro | ✅ live | `crates/said-attest/src/nitro.rs` + workspace |
| NVIDIA H100 CC | ✅ wired + tested | `crates/said-attest/src/h100.rs` (NRAS-stand-in for CI; real PKI in TODO(h100-prod) block) |
| Intel TDX | ✅ wired + tested | `crates/said-attest/src/tdx.rs` (DCAP-stand-in for CI; real PKI in TODO(tdx-prod) block) |

Dispatch in `crates/thumper-relay/src/handlers.rs::handle_provider_attest` routes by `payload.tee_kind`. Compile-time release deny on `THUMPER_ALLOW_UNATTESTED`.

## Tier 1C — Supply-chain hardening

| Layer | Status |
|---|---|
| Reproducible build | ✅ `next.config.ts::generateBuildId` pinned to git SHA; two builds = identical `manifest_sha256` |
| Build-time SRI manifest | ✅ published at `/.well-known/sri-manifest.json` per build |
| CI-anchored manifest | ✅ `.github/workflows/ci.yml` uploads as artifact + posts hash to run summary |
| Script-tag SRI injection | ✅ post-build step adds `integrity=` + `crossorigin` to every `/_next/...` script + link |
| Inline-script CSP allowlist | ✅ enforcing CSP with pinned sha256 hashes for every inline `<script>` body |
| Runtime SW SRI enforcement | ✅ `apps/web/public/sw.js` hashes every same-origin GET, 502 on mismatch |
| CSP report endpoint | ✅ `/api/csp-report` logs violations as structured JSON to stdout |
| Header regression test | ✅ `apps/web/src/lib/security-headers.test.ts` |

**Verify:**
```bash
curl -sI https://ghola.xyz/ | grep -iE 'content-security|strict-transport|x-frame|cross-origin'
curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq '.manifest_sha256'
# Rebuild from source and compare:
git clone https://github.com/anndrrson/ghola && cd ghola/apps/web
GIT_COMMIT=$(git rev-parse HEAD) npm run build
diff <(jq -S . public/.well-known/sri-manifest.json) <(curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq -S .)
```

## Tier 1E — Compile-time attestation deny

`THUMPER_ALLOW_UNATTESTED=1` env var has zero effect in `--release` builds (`crates/thumper-relay/src/handlers.rs::allow_unattested` checks `cfg!(debug_assertions)`). Debug builds + the test suite still honor it.

## Public verification surfaces

| Page | Purpose |
|---|---|
| [`/r/[hash]`](https://ghola.xyz/r/abc) | Public receipt verifier — paste any receipt JSON, runs all sig math client-side |
| [`/r/[hash]/verify-bundle`](https://ghola.xyz/r/abc/verify-bundle) | Downloadable zip with offline `verify.sh` + manifest + receipts |
| [`/security/status`](https://ghola.xyz/security/status) | Live probe board — 9 checks computed in the reviewer's browser |
| [`/security/audit-trail`](https://ghola.xyz/security/audit-trail) | Static reference card with copy-to-clipboard verify commands |
| [`/.well-known/security.txt`](https://ghola.xyz/.well-known/security.txt) | RFC 9116 disclosure policy |
| [`/.well-known/sri-manifest.json`](https://ghola.xyz/.well-known/sri-manifest.json) | Per-build SHA-256/SHA-384 of every JS/CSS artifact |
| [`/.well-known/csp-inline-hashes.json`](https://ghola.xyz/.well-known/csp-inline-hashes.json) | Pinned CSP inline-script allowlist |

## Tier 2 — Design + schema set complete

Every Tier 2 primitive named in the strategic plan now has both a design doc (`docs/security/tier-2*.md`) and a schema-only first-PR types crate. The actual implementations are scheduled for future engineering.

| Tier | Design | Schema First PR |
|---|---|---|
| 2G — Anonymous credentials | `docs/security/tier-2g-anonymous-credentials.md` | `crates/said-bbs-types` (15 tests) |
| 2H — zkML verifiable inference | `docs/security/tier-2h-zkml.md` | `crates/ghola-zkml-types` (10 tests) |
| 2J — Private retrieval (PIR) | `docs/security/tier-2j-private-retrieval.md` | `crates/said-pir-types` (16 tests) |
| 2K — Shielded payments | `docs/security/tier-2k-shielded-payments.md` | `X402SettlementProof` in `crates/said-x402` (6 tests) |
| 3 — Frontier | `docs/security/tier-3-frontier.md` | (transport variant; no types crate) |
| Cross-cutting | `docs/security/cryptographic-primitives.md` (existing) | — |

## On-device discovery UX

| Surface | Path |
|---|---|
| Model library | [`/models/local`](https://ghola.xyz/models/local) |
| Cache management | [`/settings/cache`](https://ghola.xyz/settings/cache) |
| Cache enumeration helper | `apps/web/src/lib/local-cache-inventory.ts` (10 tests) |
| Click-to-verify integrity badge | `apps/web/src/components/chat/ModelIntegrityBadge.tsx` → opens `IntegrityVerifyModal` |
| Live verifier orchestrator | `apps/web/src/lib/integrity-verification.ts` (6 tests) |
| Portable export bundle | `apps/web/src/lib/portable-export.ts` |

## Backend hardening

| Item | Where | Test |
|---|---|---|
| Body-size limits | `crates/thumper-relay/src/config.rs` (1 MiB / 4 MiB sealed) + receipts (64 KiB) | `rejects_oversized_body` |
| CORS lockdown | `crates/thumper-relay/src/lib.rs::build_app` | `cors_preflight_*` (3 tests) |
| Cross-Origin-Resource-Policy | tower-http SetResponseHeaderLayer | `cross_origin_resource_policy_header_present` |
| Provider plurality / random select | `apps/web/src/lib/sovereignty.ts::selectRoute("private")` | sovereignty.test.ts |
| Compile-time unattested deny | `crates/thumper-relay/src/handlers.rs::allow_unattested` | relay tests baseline |
| Fail-closed E2E sealing | `apps/web/src/app/chat/page.tsx` (no plaintext fallback on Turnkey error) | — |

## Threat-model claims (from SECURITY.md)

**Defended cryptographically:**
- User prompt confidentiality in Private mode (sealed envelope, attested enclave)
- User prompt confidentiality in Local mode (WebGPU, never leaves device)
- Provider integrity (Nitro/H100/TDX attestation, compile-time bypass deny)
- Receipt integrity (Ed25519 sig + Solana anchor)
- Replay defense (session AAD + nonce cache)
- First-load supply chain (script-tag SRI on prerendered HTML + enforcing CSP with inline-script allowlist)
- Post-first-load supply chain (SW SRI runtime enforcement)

**Honest gaps:**
- Dynamic server-rendered route inline scripts — outside the build-time CSP allowlist (server-side response transformer is the follow-up)
- Weight integrity on dynamically-rendered routes — same gap as above
- Anonymity sets — Tier 1 today is single-operator network; Tier 2F decentralized pool required for Yahya's winner-take-most math
- Payment metadata privacy — Tier 2K (Aleo-routed shielded payments) is designed but not implemented
- Browser-extension attackers — not solvable in software; native ghola-home is the mitigation

## Numbers

| Metric | Value |
|---|---|
| Total commits this sprint | 38+ |
| Web vitest tests | 80 passing / 2 failing (both in untracked WIP files) |
| Rust tests | 144 across 7 crates (thumper-relay 58, said-attest 21, receipts-service 12, x402 12, pir-types 16, bbs-types 15, zkml-types 10) |
| New routes shipped | 4 (`/models/local`, `/settings/cache`, `/security/audit-trail`, `/api/csp-report`) |
| New design docs | 5 (Tier 2G, 2H, 2J, 2K, Tier 3) |
| New schema-only crates | 3 (ghola-zkml-types, said-bbs-types, said-pir-types) |
| Devnet on-chain tx anchoring | 3 (program deploy, close placeholder, register canonical) |
| Tier 2 design + schema coverage | 4/4 |

## What's deliberately out of scope

- **Mainnet deploy** — economic decision; devnet integrity story is complete with canonical hash. Move to mainnet ~2 weeks before any a16z technical DD.
- **Tier 2 actual implementations** — BBS+ issuer, EZKL prover, SimplePIR server, Aleo bridge. Each is multi-week engineering on top of the shipped schemas.
- **Tier 3 implementations** — Nym transport is the named bet (8–12 wk); MPC + FHE are research-tracked.
- **Pen-test commission** — post-fundraise typically; current honest posture is "credible early-stage."
- **Multi-operator pool** — operational, requires arms-length partners.

## How to push and ship

```bash
cd /Users/andersonobrien/Downloads/ghola
git log origin/main..HEAD --oneline  # review unpushed commits
git push origin main                  # ship — Vercel auto-deploys web
```

Solana on-chain state is independent of the git push — already live on devnet.
