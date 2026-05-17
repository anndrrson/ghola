# Hosting plan — `Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm`

Deploy plan for the ~1 GB MT6878 `.litertlm` bundle. Three tiers,
each independently verifiable against the same on-chain SHA-256 pin
so a compromise of any one tier degrades to "slow alternate path" not
"poisoned weights". Cost model lines up with the cost matrix in
[`docs/perf/aot-compile-mt6878.md` §6](../../docs/perf/aot-compile-mt6878.md#6-hosting-strategy--cost-model).

## Topology

```text
Android client (LiteRtModelManager)
    │
    ├─ try 1: HuggingFace mirror   (primary — free egress)
    │         huggingface.co/ghola/Gemma3-1B-IT-mt6878
    │
    ├─ try 2: Cloudflare R2        (failover — ghola-controlled)
    │         models.ghola.xyz/Gemma3-1B-IT-mt6878.litertlm
    │
    └─ try 3: IPFS gateway         (content-addressed anchor)
              ipfs.io/ipfs/<cid>

  …all three checked against the same SHA-256 pinned in
   PinnedModelHashes.GEMMA_3_1B_LITERTLM_MT6878_SHA256
   and anchored on-chain via ghola-model-registry.
```

## Tier 1 — HuggingFace mirror (primary)

| Field | Value |
|---|---|
| Repo | `huggingface.co/ghola/Gemma3-1B-IT-mt6878` |
| Gating | **Public** (the upstream `litert-community` repo is gated; our compiled bundle is ghola's derivative work and ships open) |
| CDN | HF's built-in (Cloudflare-fronted, global PoPs) |
| Egress cost | **$0** (HF eats it) |
| Storage cost | **$0** (HF free tier covers up to several GB per repo) |
| Auth shape | None required — `LiteRtModelManager` makes anonymous GETs |
| One-time setup | Create the `ghola` HF org (already required for `ghola/Gemma3-1B-IT-mt6878` path), upload via `huggingface-cli upload ghola/Gemma3-1B-IT-mt6878 ./Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm` |

**Audit posture: high.** Public URL, hashable, mirrors how Google
itself ships `litert-community` bundles. Account compromise risk is
the main downside; mitigated by tier 2.

## Tier 2 — Cloudflare R2 (failover)

| Field | Value |
|---|---|
| Bucket | `r2://ghola-models/Gemma3-1B-IT-mt6878.litertlm` |
| Public URL | `models.ghola.xyz/Gemma3-1B-IT-mt6878.litertlm` (custom domain via R2 + Cloudflare DNS) |
| Storage cost | ~$0.015 / GB / month → **~$0.02/mo** for 1 GB |
| Egress cost | **$0** (R2 has no egress fees — a key reason it's the failover tier) |
| Auth shape | None — bucket policy is public-read |
| One-time setup | Create R2 bucket, set public access, point `models.ghola.xyz` CNAME at the R2 public hostname, upload via `wrangler r2 object put` |

**Audit posture: high.** ghola controls the keys, bucket policy is
auditable, and the custom domain is on-chain anchored alongside the
hash.

## Tier 3 — IPFS / Filecoin (content-addressed anchor)

| Field | Value |
|---|---|
| CID | `bafy…` (computed at pin time, anchored on-chain) |
| Pin provider | Filecoin (web3.storage / Pinata / similar) |
| Storage cost | ~$2/mo for a Filecoin pin of a ~1 GB blob |
| Egress cost | $0 (public IPFS gateway) |
| Gateway latency | Variable — first-load can be painful on LTE; tier 1 + 2 should serve the hot path |
| One-time setup | Run `ipfs add` on the bundle, get CID, anchor on-chain via `ghola-model-registry`, pin via Filecoin provider |

**Audit posture: highest.** The CID *is* the integrity claim — if the
bytes change, the CID changes. This is the "we don't host it, the
network does" story for the a16z thesis without forcing IPFS onto the
hot path.

## Combined monthly cost

| Tier | Monthly |
|---|---|
| HF mirror | $0 |
| R2 failover | ~$0.02 |
| Filecoin pin | ~$2 |
| **Total** | **~$2.02/mo** |

Well inside the `<$5/mo` budget targeted in
[`docs/perf/aot-compile-mt6878.md` §6](../../docs/perf/aot-compile-mt6878.md#6-hosting-strategy--cost-model).

## Android client wiring

`LiteRtModelManager.GEMMA_3_1B_BASE_URL` currently points at
`https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main`
(the upstream gated repo). When the MT6878 bundle ships, we either:

- **Option A** (preferred): keep `GEMMA_3_1B_BASE_URL` pointed at
  upstream for the existing SoC variants and add a per-variant URL
  override on `LiteRtVariant.Mt6878` that resolves to
  `huggingface.co/ghola/Gemma3-1B-IT-mt6878/resolve/main`. Cleanest
  separation between Google-shipped bundles and ghola-compiled ones.
- **Option B**: re-host *all* variants under `ghola/…` and flip the
  constant. Lets us drop the HF token prompt from first-run (the
  Phase v0.4 plan). More work, but removes the gated-repo UX gap.

Option B is the long-term right answer; Option A is the one-day
unblock when the MT6878 bundle is ready and the other variants aren't
yet re-hosted.

## DNS + CDN considerations

- **HF**: nothing to do. HF's CDN is fast and well-peered globally.
- **R2 custom domain**: `models.ghola.xyz` CNAME → R2 public hostname.
  Cloudflare proxies (orange-cloud) by default — keep it that way for
  caching + DDoS posture.
- **IPFS**: use a known-stable public gateway (`ipfs.io`,
  `cf-ipfs.com`, `dweb.link`); avoid pinning the URL to one gateway
  in the Android client. The variant URL list should include 2–3
  gateways as ordered fallbacks.

## What needs to happen before we can run any of this

1. Create the `ghola` HF org (one-time).
2. Provision a Cloudflare R2 bucket + custom domain
   (`models.ghola.xyz`).
3. Pick a Filecoin pinning provider; create + fund the account.
4. Compile the bundle (`tools/litertlm-compile/`).
5. Upload to all three tiers; record CID + HF URL + R2 URL.
6. Run `scripts/register-litertlm-mt6878.mjs` to anchor the
   compiled-bundle SHA-256 + IPFS CID + HF URL + R2 URL on-chain.
7. Flip `PinnedModelHashes.GEMMA_3_1B_LITERTLM_MT6878_SHA256` from
   `null` to the real hex.
8. Update `LiteRtVariant.Mt6878` per Option A above (if not already
   present).
9. Ship.

Steps 1–3 are one-time platform setup and unblock all future ghola
model hosting; steps 4–9 are per-bundle and the recurring path for
every future SoC variant.
