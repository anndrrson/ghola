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

// The MLC model registry id. Llama 3.2 1B at q4f16_1 is ~1GB and runs
// at usable token rates on M-series Macs and modern Windows laptops.
// Stays under the 2GB IndexedDB quota most browsers enforce out of the
// box, so first-load doesn't trip a prompt.
export const DEFAULT_WEBGPU_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

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

  const { CreateMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");

  // Compose an AppConfig that pins SRI hashes on the default model.
  // For any model id we haven't pinned, fall back to the upstream
  // prebuilt list (no integrity check yet — followed up per-model as
  // they're vetted). The model_list array shape matches WebLLM's
  // public type — overriding by id keeps upstream record fields
  // intact except for the integrity addition.
  const pinnedAppConfig =
    modelId === DEFAULT_WEBGPU_MODEL
      ? {
          ...prebuiltAppConfig,
          model_list: prebuiltAppConfig.model_list.map((m) =>
            m.model_id === DEFAULT_WEBGPU_MODEL
              ? { ...m, integrity: DEFAULT_WEBGPU_MODEL_INTEGRITY }
              : m,
          ),
        }
      : prebuiltAppConfig;

  inflight = CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
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
