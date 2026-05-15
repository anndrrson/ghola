# Phase E prep — Phi-3 mini as the second Local model

Per `.claude/plans/zesty-giggling-charm.md`'s Phase E, the strongest
shippable second Local model is **Phi-3-mini-4k-instruct (q4f16_1)** —
~2.3 GB on disk, materially stronger than Llama-3.2-1B at chat tasks,
runnable on the same M-series Macs that already run the 1B model
today. WebLLM ships it in `prebuiltAppConfig` as
`Phi-3-mini-4k-instruct-q4f16_1-MLC`.

## What's already verified

| Field | Value |
|---|---|
| MLC model id | `Phi-3-mini-4k-instruct-q4f16_1-MLC` |
| HF repo | `mlc-ai/Phi-3-mini-4k-instruct-q4f16_1-MLC` |
| Approx size | 2.3 GB across 83 LFS shards + tokenizer/config |
| Activation | SiLU (SwiGLU MLP) — same family as Llama 3.2 |
| **Canonical weights_hash** | `438aeaa97d1b793a2e4374e36f51a22a906839775b1bb30fdfd5a5d3c65e3b1a` |

Recompute locally to verify:

```bash
node scripts/compute-weights-manifest.mjs \
  mlc-ai/Phi-3-mini-4k-instruct-q4f16_1-MLC main \
  | tail -1
# → weights_hash: 438aeaa97d1b793a2e4374e36f51a22a906839775b1bb30fdfd5a5d3c65e3b1a
```

## What's still needed before this can ship

1. **SRI hashes for the non-weight artifacts.** Phi-3 needs the same
   `{ config, model_lib, tokenizer.json }` SRI set that
   `DEFAULT_WEBGPU_MODEL_INTEGRITY` carries for Llama-3.2-1B. WebLLM
   serves these from its CDN; compute via:
   ```bash
   # config (mlc-chat-config.json)
   curl -L "https://huggingface.co/mlc-ai/Phi-3-mini-4k-instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json" \
       | openssl dgst -sha256 -binary | base64
   # model_lib (WASM) — URL in WebLLM's prebuiltAppConfig
   curl -L "<webllm-cdn-url>/Phi-3-mini-4k-instruct-q4f16_1_cs1k-webgpu.wasm" \
       | openssl dgst -sha256 -binary | base64
   # tokenizer.json
   curl -L "https://huggingface.co/mlc-ai/Phi-3-mini-4k-instruct-q4f16_1-MLC/resolve/main/tokenizer.json" \
       | openssl dgst -sha256 -binary | base64
   ```
   Wrap each result as `"sha256-<base64>"` and slot into a new
   `PHI3_MINI_WEBGPU_MODEL_INTEGRITY` block alongside
   `DEFAULT_WEBGPU_MODEL_INTEGRITY` in `webgpu-inference.ts`.

2. **On-chain registry entry.** Run
   `node scripts/register-default-model.mjs` adapted with:
   - `MODEL_ID = "Phi-3-mini-4k-instruct-q4f16_1-MLC"`
   - `WEIGHTS_HASH = "438aeaa97d1b793a2e4374e36f51a22a906839775b1bb30fdfd5a5d3c65e3b1a"`
   Requires a funded devnet keypair. Anchors the canonical hash so the
   client's runtime fingerprint walk can compare against it.

3. **UI wiring in `/models/local`.** Add a second entry to
   `LOCAL_MODELS` with `weightsHash` = the value above and
   `cacheMarker = "Phi-3-mini-4k-instruct-q4f16_1-MLC"`.

4. **Chat picker.** `streamWebGPUChat` already accepts
   `options.model`, so no transport-layer changes needed. The chat
   page just needs a model-switcher UI element.

## Why Phi-3 over Qwen2.5-1.5B

| Candidate | Size | Tradeoff |
|---|---|---|
| Phi-3-mini-4k-instruct-q4f16_1 | 2.3 GB | Strongest chat quality for size; Apache 2 license; 4k context; SiLU/SwiGLU activations same family as Llama |
| Qwen2.5-1.5B-Instruct-q4f16_1 | 1.2 GB | Smaller — faster cold-load — but noticeably weaker at chat tasks |
| Llama-3.2-3B-Instruct-q4f16_1 | 2.5 GB | Closer to Phi-3 quality but heavier and less consistent at instruction-following |

Phi-3 is the right first second model. Qwen 2.5 1.5B is the right
*third* model (a "smaller-faster" lane for mobile-class devices) once
Phase B's bundling reduces the load-time penalty.

## When to ship this

After the Phase A measurements come back. The decision tree:

- If sparsity `> 0.60` → skip Phase C, ship Phase B + Phase E in
  parallel. Phi-3 becomes the recommended Local model.
- If sparsity `0.51–0.60` → Phase E first, then revisit Phase B.
- If sparsity `<= 0.50` → defer Phase E until Phase C+D land and the
  same hardware can run Phi-3 with the bundled+sliding-window loader.
  At that point Phi-3 is *also* a sparsity-prediction beneficiary.
