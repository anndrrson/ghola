/**
 * WebGPU inference transport — runs a small open-weight model entirely
 * in the browser via WebLLM (Apache 2, MLC). Used when Sovereignty mode
 * is "local" and no paired ghola-home is available, which is the
 * default for unauthenticated anonymous visitors.
 *
 * Threat model: prompts and responses never leave the device. Model
 * weights download once from the WebLLM CDN (or, post Tier 1A.5, from
 * IPFS with an on-chain commitment) and cache in the browser's IndexedDB.
 *
 * The engine is expensive to construct (model load + WebGPU shader
 * compilation), so we keep a module-level singleton keyed by model id.
 * Subsequent messages reuse the warm engine.
 */
import type {
  MLCEngine,
  InitProgressReport,
  ChatCompletionMessageParam,
} from "@mlc-ai/web-llm";

import {
  MARKS,
  hasMark,
  mark,
  markEngineProgress,
} from "./perf-marks";

// The MLC model registry id. Llama 3.2 1B at q4f16_1 is ~1GB and runs
// at usable token rates on M-series Macs and modern Windows laptops.
// Stays under the 2GB IndexedDB quota most browsers enforce out of the
// box, so first-load doesn't trip a prompt.
export const DEFAULT_WEBGPU_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

// Opt-in second Local model. Phi-3 mini 4k instruct (q4f16_1) is
// ~2.3GB on disk and meaningfully stronger than Llama-3.2-1B at chat
// tasks. Not the default because it crosses the 2GB IndexedDB quota
// some browsers enforce by default and roughly doubles the first-load
// download. Exposed on /models/local as a per-user toggle.
export const PHI3_MINI_WEBGPU_MODEL = "Phi-3-mini-4k-instruct-q4f16_1-MLC";

// Pinned SRI hashes for the default model's non-weight artifacts.
// WebLLM verifies these on download via its built-in ModelIntegrity
// path — a tampered model_lib (the WASM inference engine), config, or
// tokenizer triggers a load failure and the inference never runs.
//
// Weights (the multi-GB MLC param shards) are not covered by this map;
// upstream WebLLM does not expose SRI for them yet. The model_lib is
// the highest-value target — it's the code that executes inference, so
// pinning it kills the most-likely supply-chain attack vector.
//
// Recompute when bumping the default model:
//   curl ... | openssl dgst -sha256 -binary | base64
const DEFAULT_WEBGPU_MODEL_INTEGRITY = {
  config: "sha256-DsUTtUtBmtRxAGQwaGvc/6rnECtB97Akb7/N4lF6zH8=",
  model_lib: "sha256-posvg0hde0xvfRoAgAG8g81/Kw+u/osTgfwT1C+3jEo=",
  tokenizer: {
    "tokenizer.json":
      "sha256-eePlImNfMXEwCRO7QhRkqH3mIiGCoFcLmyzLoqlksrQ=",
  },
  onFailure: "error" as const,
};

/**
 * Canonical on-chain weights hash for the default model. SHA-256 over
 * the sorted manifest of every file in the model's HuggingFace repo:
 *
 *   sha256( join("\n", sorted( "<path>\t<lfs_oid>" for each file )) )
 *
 * `lfs_oid` is HF's SHA-256 for LFS files; non-LFS files (the JSON
 * configs) are fetched and hashed inline. The full algorithm lives in
 * `scripts/compute-weights-manifest.mjs` — anyone can recompute and
 * compare.
 *
 * This is the value the ghola-model-registry program SHOULD anchor as
 * the on-chain `weights_hash`. The currently-deployed record still
 * carries the all-zeros placeholder; the close + re-register flow
 * (programs/ghola-model-registry/src/lib.rs::close_model) shipped in
 * source but is awaiting a devnet redeploy.
 */
export const DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH =
  "8c3ae367d068c2b3a7d5b402a16395ab5089315e5256f609e54320d64d53c695";

/**
 * SRI hashes for the Phi-3 mini 4k instruct (q4f16_1) non-weight
 * artifacts. Mirrors the {@link DEFAULT_WEBGPU_MODEL_INTEGRITY} shape.
 *
 * The model_lib URL pinned below (and therefore the SRI hash of the
 * WASM payload) is version-stamped — `prebuiltAppConfig.model_lib_map`
 * upstream uses `modelVersion = "v0_2_83/base"`. If a future WebLLM
 * bump moves the URL prefix, the new wasm body will have a new hash
 * and this entry must be recomputed. Pinned URL (so a reviewer can
 * re-derive the hash):
 *
 *   https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/
 *     main/web-llm-models/v0_2_83/base/
 *     Phi-3-mini-4k-instruct-q4f16_1_cs1k-webgpu.wasm
 *
 * Recompute via:
 *   curl -L "<url>" | openssl dgst -sha256 -binary | base64
 */
const PHI3_MINI_WEBGPU_MODEL_INTEGRITY = {
  config: "sha256-+cPkVNE9Y+Lbk8twcN2IEsetj4TTrn5rLTmbm7XnpUI=",
  model_lib: "sha256-tey46y6P2Bs0JOQ68X3J0WNqbSBpsbtu6EBXlN+9AP4=",
  tokenizer: {
    "tokenizer.json":
      "sha256-C73dSzm1lAJ7AizyLEdmnc2eBf/DttSpcrOacTdQ+CM=",
  },
  onFailure: "error" as const,
};

/**
 * Canonical on-chain weights hash for Phi-3 mini 4k instruct (q4f16_1).
 * Computed via `scripts/compute-weights-manifest.mjs
 * mlc-ai/Phi-3-mini-4k-instruct-q4f16_1-MLC main` — same algorithm as
 * {@link DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH}. Documented in
 * `docs/perf/phase-e-phi3-mini-prep.md`.
 *
 * TODO(ghola-model-registry): Anchor this on devnet via
 * `scripts/register-default-model.mjs` adapted with MODEL_ID and this
 * hash — requires a funded devnet keypair the user must authorize.
 */
export const PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH =
  "438aeaa97d1b793a2e4374e36f51a22a906839775b1bb30fdfd5a5d3c65e3b1a";

// Per-model SRI integrity records. Used by `getEngine()` to inject the
// right pinned-hash block into WebLLM's AppConfig when the requested
// model_id is one we've vetted. Models not in this map fall through to
// the upstream prebuilt list (no SRI check — followed up per-model as
// they're vetted).
const WEBGPU_MODEL_INTEGRITY: Record<
  string,
  typeof DEFAULT_WEBGPU_MODEL_INTEGRITY
> = {
  [DEFAULT_WEBGPU_MODEL]: DEFAULT_WEBGPU_MODEL_INTEGRITY,
  [PHI3_MINI_WEBGPU_MODEL]: PHI3_MINI_WEBGPU_MODEL_INTEGRITY,
};

/** Exposed for tests; do not mutate. */
export function getWebGPUModelIntegrity(
  modelId: string,
): typeof DEFAULT_WEBGPU_MODEL_INTEGRITY | undefined {
  return WEBGPU_MODEL_INTEGRITY[modelId];
}

export interface WebGPUSupport {
  supported: boolean;
  reason?: string;
}

/**
 * Detect WebGPU capability before the chat client offers Local mode.
 * The MLC engine itself will throw on construct if WebGPU is missing,
 * but checking early lets the picker UI hide the option entirely on
 * unsupported browsers (mobile Safari < 18, older Firefox).
 */
export function detectWebGPU(): WebGPUSupport {
  if (typeof navigator === "undefined") {
    return { supported: false, reason: "Not running in a browser." };
  }
  // navigator.gpu is the modern Promise-returning API. Older
  // experimental builds exposed it but with a different shape; treat
  // the property's truthiness as the canonical test.
  // @ts-expect-error — `gpu` is in lib.dom of recent TS but not all.
  if (!navigator.gpu) {
    return {
      supported: false,
      reason: "This browser does not support WebGPU. Try the latest Chrome, Edge, or Safari 18+.",
    };
  }
  return { supported: true };
}

interface EngineSlot {
  engine: MLCEngine;
  modelId: string;
}

let engineSlot: EngineSlot | null = null;
let inflight: Promise<MLCEngine> | null = null;

/**
 * Get (or lazily create) the singleton MLCEngine for the requested
 * model. Reports load progress via the provided callback on the first
 * call; later calls return immediately once the engine is warm.
 */
async function getEngine(
  modelId: string,
  onProgress?: (report: InitProgressReport) => void,
): Promise<MLCEngine> {
  if (engineSlot && engineSlot.modelId === modelId) {
    return engineSlot.engine;
  }

  // If a load is already in flight for this model, await it rather than
  // starting a second concurrent download.
  if (inflight) {
    const engine = await inflight;
    if (engineSlot && engineSlot.modelId === modelId) return engine;
  }

  // Phase A instrumentation: drop the engine-fetch-start mark once
  // per engine load. Idempotent across StrictMode double-invoke +
  // concurrent callers (hasMark guards against re-dropping).
  if (!hasMark(MARKS.ENGINE_FETCH_START)) {
    mark(MARKS.ENGINE_FETCH_START);
  }

  const { CreateMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");

  // Compose an AppConfig that pins SRI hashes on every vetted model.
  // For any model id we haven't pinned, fall back to the upstream
  // prebuilt list (no integrity check yet — followed up per-model as
  // they're vetted). The model_list array shape matches WebLLM's
  // public type — overriding by id keeps upstream record fields
  // intact except for the integrity addition.
  const pinnedAppConfig = {
    ...prebuiltAppConfig,
    model_list: prebuiltAppConfig.model_list.map((m) => {
      const integrity = WEBGPU_MODEL_INTEGRITY[m.model_id];
      return integrity ? { ...m, integrity } : m;
    }),
  };

  inflight = CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      // Phase A: project WebLLM's free-text progress onto our typed
      // marks. dedup keeps a single mark per phase across the
      // multi-event progress stream WebLLM emits during init.
      markEngineProgress(report, { dedup: true });
      onProgress?.(report);
    },
    appConfig: pinnedAppConfig,
  });

  try {
    const engine = await inflight;
    engineSlot = { engine, modelId };
    return engine;
  } finally {
    inflight = null;
  }
}

export interface StreamWebGPUChatOptions {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** First-load progress; called repeatedly during initial model download. */
  onProgress?: (report: { progress: number; text: string }) => void;
  /** Optional system prompt prepended to history. */
  system?: string;
  /** Defaults to {@link DEFAULT_WEBGPU_MODEL}. */
  model?: string;
  /** Sampling temperature. Defaults to 0.7. */
  temperature?: number;
}

/**
 * Stream a chat completion from the local WebGPU engine. History is
 * passed in full (browser owns the conversation state) — the engine
 * itself is stateless across calls so the caller is the source of
 * truth for what's been said.
 */
export async function streamWebGPUChat(
  history: ReadonlyArray<{ role: "user" | "assistant" | "system"; content: string }>,
  options: StreamWebGPUChatOptions,
): Promise<void> {
  const support = detectWebGPU();
  if (!support.supported) {
    options.onError(
      support.reason ?? "WebGPU is not available in this browser.",
    );
    return;
  }

  const modelId = options.model ?? DEFAULT_WEBGPU_MODEL;
  let engine: MLCEngine;
  try {
    engine = await getEngine(modelId, (report) => {
      options.onProgress?.({ progress: report.progress, text: report.text });
    });
  } catch (err) {
    options.onError(
      err instanceof Error
        ? `Failed to load local model: ${err.message}`
        : "Failed to load local model.",
    );
    return;
  }

  // Compose messages. The system prompt slot lets the chat client name
  // the assistant ("you are ghola, a private AI…") if it wants — but
  // unauthenticated anonymous sessions use a minimal default so we
  // don't bake in product copy here.
  const messages: ChatCompletionMessageParam[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  try {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: options.temperature ?? 0.7,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        // Phase A: drop the first-token mark on the first non-empty
        // delta of the FIRST stream after a cold engine load. We let
        // hasMark gate the call so warm-engine subsequent sends don't
        // overwrite the measurement that anchors engineLoad → firstToken.
        if (!hasMark(MARKS.FIRST_TOKEN)) {
          mark(MARKS.FIRST_TOKEN);
        }
        options.onChunk(delta);
      }
    }
    options.onDone();
  } catch (err) {
    options.onError(
      err instanceof Error ? err.message : "Local inference failed.",
    );
  }
}

/**
 * Pre-warm the WebGPU engine for the given model without requesting a
 * completion. Safe to call on page mount — kicks off the model download
 * + WebGPU shader compilation in the background so the first user-sent
 * message can stream tokens immediately rather than blocking on a
 * multi-hundred-megabyte download.
 *
 * Idempotency:
 *   - If the engine is already warm for `modelId`, returns immediately.
 *   - If a warm-up is already in flight for `modelId`, returns the same
 *     promise rather than starting a second concurrent load.
 *   - Safe to call multiple times from React effects (StrictMode
 *     double-invoke, concurrent component mounts).
 *
 * The promise resolves once the engine is ready. Callers that want
 * fire-and-forget can ignore the returned promise; callers that want
 * to track progress in UI should pass `onProgress`.
 *
 * Errors thrown by the underlying load are propagated. Callers in a
 * non-blocking mount path should attach `.catch()` to swallow load
 * failures (the eventual user-initiated send through `streamWebGPUChat`
 * will surface its own error to the chat UI).
 */
export async function warmEngine(
  modelId: string = DEFAULT_WEBGPU_MODEL,
  onProgress?: (report: InitProgressReport) => void,
): Promise<void> {
  // Fast-path: already warm.
  if (engineSlot && engineSlot.modelId === modelId) return;
  // getEngine() itself handles the in-flight dedup and singleton update.
  await getEngine(modelId, onProgress);
}

/**
 * Force-unload the cached engine. Useful for tests and for "switch
 * model" UI that needs to free VRAM before loading something else.
 */
export async function unloadWebGPUEngine(): Promise<void> {
  if (!engineSlot) return;
  try {
    await engineSlot.engine.unload();
  } finally {
    engineSlot = null;
  }
}

// WebLLM stores model artifacts in three CacheStorage scopes. The first
// two are also covered by ModelIntegrity SRI, but the model-weights
// scope ("webllm/model") is not — that's where the multi-GB weight
// shards live and is the integrity gap the rest of the stack is
// rebuilding around (on-chain registry, IPFS content-addressing).
const WEBLLM_CACHE_SCOPES = ["webllm/config", "webllm/wasm", "webllm/model"];

/**
 * After a model is loaded, enumerate the CacheStorage entries WebLLM
 * stored to and compute a deterministic SHA-256 fingerprint over
 * every cached artifact body. The fingerprint is:
 *
 *   sha256( newline-join( sorted( "<url>\t<sha256(body)>" ) ) )
 *
 * Returns `{ fingerprint, files: [{url, hash, byteLength}] }` so the
 * integrity badge can render a single hex string in the tooltip and
 * (when the on-chain registry exists) compare against the published
 * `weights_hash`.
 *
 * Caveats:
 *   - Only runs in browser contexts (CacheStorage isn't in Node /
 *     test environments).
 *   - The fingerprint covers everything WebLLM cached, so re-loading
 *     a different model invalidates the prior fingerprint as expected.
 *   - Skips silently and returns null if CacheStorage is unavailable
 *     (private-mode Safari, some iframe contexts).
 */
export interface WeightFingerprint {
  fingerprint: string;
  files: Array<{ url: string; sha256: string; byteLength: number }>;
}

export async function computeLoadedWeightFingerprint(): Promise<WeightFingerprint | null> {
  if (typeof caches === "undefined" || typeof crypto?.subtle === "undefined") {
    return null;
  }
  const collected: Array<{ url: string; sha256: string; byteLength: number }> =
    [];
  for (const scope of WEBLLM_CACHE_SCOPES) {
    const has = await caches.has(scope);
    if (!has) continue;
    const cache = await caches.open(scope);
    const requests = await cache.keys();
    for (const req of requests) {
      const res = await cache.match(req);
      if (!res) continue;
      const buf = await res.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      collected.push({
        url: req.url,
        sha256: bytesToHex(new Uint8Array(digest)),
        byteLength: buf.byteLength,
      });
    }
  }
  if (collected.length === 0) return null;
  collected.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const manifest = collected.map((c) => `${c.url}\t${c.sha256}`).join("\n");
  const manifestBuf = new TextEncoder().encode(manifest);
  const fpDigest = await crypto.subtle.digest("SHA-256", manifestBuf);
  return {
    fingerprint: bytesToHex(new Uint8Array(fpDigest)),
    files: collected,
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
