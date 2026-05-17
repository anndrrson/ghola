"use client";

// Dev-only diagnostic surface — kept out of the sitemap allowlist
// (apps/web/src/app/sitemap.ts) and noindex'd at the route level via
// the layout below. Reachable by typing the URL; not linked from
// product nav.

import { useCallback, useState } from "react";
import Link from "next/link";

import {
  DEFAULT_WEBGPU_MODEL,
  streamWebGPUChat,
  warmEngine,
} from "@/lib/webgpu-inference";
import { clearAllWebLLMCaches } from "@/lib/local-cache-inventory";
import { clearMarks, snapshot } from "@/lib/perf-marks";
import {
  diffCacheSnapshots,
  snapshotCacheBytes,
} from "@/lib/sparsity-instrument";

/**
 * Phase-A measurement capture surface.
 *
 * One-click: clear caches → warm engine → stream a short prompt →
 * snapshot the perf marks + cache deltas → dump JSON the reviewer
 * pastes into `docs/perf/baseline-local-llama-3.2-1b-q4f16.json`.
 *
 * Not linked from the public nav. Discoverable via the plan doc
 * only — this is a developer tool, not a product surface.
 */

interface RunResult {
  startedAt: number;
  completedAt: number;
  perf: ReturnType<typeof snapshot>;
  cacheDelta: ReturnType<typeof diffCacheSnapshots> | null;
  firstChunk: string | null;
  totalChunks: number;
  totalChars: number;
  error: string | null;
  device: {
    userAgent: string;
    platform: string;
    deviceMemoryGb: number | null;
    webgpuAdapter: WebGpuAdapterInfo | null;
  };
}

interface WebGpuAdapterInfo {
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  features: string[];
  limits: Record<string, number>;
}

/**
 * Best-effort capture of WebGPU adapter info. Some fields are gated
 * behind `requestAdapterInfo()` which is itself behind a flag in some
 * browsers; we surface what we can without throwing on the rest.
 */
async function captureWebGpuAdapter(): Promise<WebGpuAdapterInfo | null> {
  if (typeof navigator === "undefined") return null;
  // @ts-expect-error — navigator.gpu not in all lib.dom variants
  const gpu = navigator.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    let info: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
    } = {};
    if (typeof adapter.requestAdapterInfo === "function") {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        // Some browsers gate this; non-fatal.
      }
    } else if (adapter.info) {
      // Newer Chromium exposes .info directly without the request method.
      info = adapter.info;
    }
    const features: string[] = [];
    if (adapter.features && typeof adapter.features.forEach === "function") {
      adapter.features.forEach((f: string) => features.push(f));
    }
    const limits: Record<string, number> = {};
    if (adapter.limits) {
      for (const key of Object.keys(adapter.limits)) {
        const v = (adapter.limits as Record<string, unknown>)[key];
        if (typeof v === "number") limits[key] = v;
      }
    }
    return {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      features,
      limits,
    };
  } catch {
    return null;
  }
}

/**
 * Project a RunResult onto the exact shape of
 * docs/perf/baseline-local-llama-3.2-1b-q4f16.json. Output is meant to
 * be pasted directly into the baseline file, replacing the `null`
 * fields. The sparsity section stays null — that's filled in by
 * `scripts/measure-sparsity.py` separately.
 */
function projectBaseline(r: RunResult): Record<string, unknown> {
  const cache = r.cacheDelta;
  return {
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    captured_at: new Date(r.completedAt).toISOString(),
    device: {
      user_agent: r.device.userAgent,
      platform: r.device.platform,
      ram_gb: r.device.deviceMemoryGb,
      webgpu_adapter: r.device.webgpuAdapter,
    },
    measurements: {
      engine_load_ms: r.perf.derived.engineLoadMs,
      first_token_from_fetch_start_ms:
        r.perf.derived.firstTokenFromFetchStartMs,
      first_token_from_compile_done_ms:
        r.perf.derived.firstTokenFromCompileDoneMs,
      cache_bytes_loaded: cache
        ? {
            "webllm/config": cache.perScope["webllm/config"]?.addedBytes ?? 0,
            "webllm/wasm": cache.perScope["webllm/wasm"]?.addedBytes ?? 0,
            "webllm/model": cache.perScope["webllm/model"]?.addedBytes ?? 0,
            total: cache.totalAddedBytes,
          }
        : {
            "webllm/config": null,
            "webllm/wasm": null,
            "webllm/model": null,
            total: null,
          },
      peak_vram_mb_estimate: null,
      tokens_per_second_warm: null,
    },
    sparsity: {
      source: "scripts/measure-sparsity.py",
      model_hf_id: "meta-llama/Llama-3.2-1B-Instruct",
      threshold: 0.001,
      n_prompts: null,
      n_layers: null,
      intermediate_size: null,
      overall_mean_active_fraction: null,
      overall_mean_sparsity: null,
      decision: null,
      per_layer: [],
    },
    decision_gate: {
      phase_c_worthwhile: null,
      next_action: null,
    },
  };
}

export default function ColdLoadPerfPage() {
  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);

  const runMeasurement = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setProgressText("clearing caches...");
    setProgressPct(0);

    // 1. Clear cache + previously-captured marks so the next run is a
    //    real cold load. Note: this does NOT clear WebGPU-side
    //    compilation caches (the browser holds those independently),
    //    so a true cold measurement requires a fresh incognito profile.
    await clearAllWebLLMCaches();
    clearMarks();

    // 2. Capture the cache state before warm-up.
    const before = await snapshotCacheBytes();

    // 3. Warm the engine. markEngineProgress drops engine-fetch-start +
    //    fetch-done + compile-done; we relay the progress text to the UI.
    let runError: string | null = null;
    try {
      await warmEngine(DEFAULT_WEBGPU_MODEL, (report) => {
        setProgressText(report.text ?? "");
        setProgressPct(Math.round((report.progress ?? 0) * 100));
      });
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e);
    }

    // 4. Stream a short prompt to anchor first-token.
    let firstChunk: string | null = null;
    let totalChunks = 0;
    let totalChars = 0;
    if (!runError) {
      setProgressText("streaming first response...");
      await new Promise<void>((resolve) => {
        streamWebGPUChat(
          [{ role: "user", content: "Say hello in one short sentence." }],
          {
            onChunk: (text) => {
              if (firstChunk === null) firstChunk = text;
              totalChunks += 1;
              totalChars += text.length;
            },
            onDone: () => resolve(),
            onError: (msg) => {
              runError = msg;
              resolve();
            },
          },
        );
      });
    }

    // 5. Capture cache delta + perf snapshot.
    const after = await snapshotCacheBytes();
    const cacheDelta = before && after ? diffCacheSnapshots(before, after) : null;
    const perf = snapshot();

    const ua =
      typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
    const platform =
      typeof navigator !== "undefined" ? navigator.platform ?? "unknown" : "unknown";
    const deviceMemoryGb =
      typeof navigator !== "undefined" &&
      // deviceMemory is non-standard but Chromium-supported
      // @ts-expect-error
      typeof navigator.deviceMemory === "number"
        ? // @ts-expect-error
          (navigator.deviceMemory as number)
        : null;
    const webgpuAdapter = await captureWebGpuAdapter();

    setResult({
      startedAt: 0,
      completedAt: Date.now(),
      perf,
      cacheDelta,
      firstChunk,
      totalChunks,
      totalChars,
      error: runError,
      device: { userAgent: ua, platform, deviceMemoryGb, webgpuAdapter },
    });
    setRunning(false);
    setProgressText("");
    setProgressPct(0);
  }, []);

  const downloadJson = useCallback(() => {
    if (!result) return;
    download(
      JSON.stringify(result, null, 2),
      `cold-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  }, [result]);

  const downloadBaseline = useCallback(() => {
    if (!result) return;
    download(
      JSON.stringify(projectBaseline(result), null, 2),
      "baseline-local-llama-3.2-1b-q4f16.json",
    );
  }, [result]);

  const copyBaseline = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(projectBaseline(result), null, 2),
      );
    } catch {
      // Clipboard write requires user gesture in some browsers — the
      // button click qualifies but the API can still reject in
      // sandboxed contexts. Fall through silently; the download
      // button is the reliable path.
    }
  }, [result]);

  return (
    <div className="min-h-screen bg-[#08090d] text-[#eef1f8]">
      <div className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8] hover:text-[#eef1f8]"
        >
          ← ghola
        </Link>
        <h1 className="mt-8 font-display text-4xl md:text-5xl leading-[1.0] font-medium">
          Cold-load capture
        </h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-[#8b95a8]">
          Phase-A measurement harness for the local-mode adoption of the
          Apple-flash-memory loading scheme. Clears caches, runs a fresh
          load, streams a short prompt, and produces a JSON dump you can
          paste into{" "}
          <code className="font-mono text-[#eef1f8]">
            docs/perf/baseline-local-llama-3.2-1b-q4f16.json
          </code>
          . For a true cold measurement, use an incognito window so WebGPU
          shader caches aren&rsquo;t pre-warmed.
        </p>

        <div className="mt-10 rounded-2xl border border-[#1e2a3a] bg-[#0c0f15] p-6">
          <button
            type="button"
            onClick={runMeasurement}
            disabled={running}
            className="rounded-full bg-[#eef1f8] px-5 py-2 font-mono text-[12px] uppercase tracking-[0.18em] text-[#08090d] disabled:opacity-50"
          >
            {running ? "running..." : "Run measurement"}
          </button>

          {running && (
            <div className="mt-6">
              <div className="text-[12px] text-[#8b95a8] font-mono">
                {progressText || "starting..."}{" "}
                <span className="text-[#eef1f8]">{progressPct}%</span>
              </div>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#1e2a3a]">
                <div
                  className="h-full bg-[#eef1f8] transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {result && (
          <div className="mt-8 rounded-2xl border border-[#1e2a3a] bg-[#0c0f15] p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-2xl">Result</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyBaseline}
                  className="rounded-full border border-[#1e2a3a] bg-[#1e2a3a] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#eef1f8] hover:bg-[#2a3a50]"
                >
                  Copy baseline JSON
                </button>
                <button
                  type="button"
                  onClick={downloadBaseline}
                  className="rounded-full border border-[#1e2a3a] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
                >
                  Download baseline
                </button>
                <button
                  type="button"
                  onClick={downloadJson}
                  className="rounded-full border border-[#1e2a3a] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
                >
                  Download raw
                </button>
              </div>
            </div>

            <dl className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 font-mono text-[12px]">
              <Stat
                label="engine load"
                value={ms(result.perf.derived.engineLoadMs)}
              />
              <Stat
                label="first token (from fetch start)"
                value={ms(result.perf.derived.firstTokenFromFetchStartMs)}
              />
              <Stat
                label="first token (after compile done)"
                value={ms(result.perf.derived.firstTokenFromCompileDoneMs)}
              />
              <Stat
                label="total bytes loaded"
                value={
                  result.cacheDelta
                    ? formatBytes(result.cacheDelta.totalAddedBytes)
                    : "—"
                }
              />
              <Stat label="chunks streamed" value={String(result.totalChunks)} />
              <Stat label="chars streamed" value={String(result.totalChars)} />
            </dl>

            {result.error && (
              <div className="mt-4 rounded-md border border-red-900 bg-red-950/40 p-3 font-mono text-[12px] text-red-200">
                {result.error}
              </div>
            )}

            {!result.error && (
              <div className="mt-6 rounded-md border border-[#1e2a3a] bg-[#0a0d12] p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-[#6f798c]">
                  Recommendation
                </div>
                {(() => {
                  const rec = recommendation(result);
                  return (
                    <>
                      <div className="mt-1 text-[13px] leading-relaxed">
                        {rec.headline}
                      </div>
                      <ul className="mt-3 space-y-1 text-[12px] text-[#8b95a8]">
                        {rec.followups.map((f, i) => (
                          <li key={i}>— {f}</li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </div>
            )}

            <pre className="mt-6 max-h-96 overflow-auto rounded-md border border-[#1e2a3a] bg-[#05070a] p-4 font-mono text-[11px] leading-relaxed text-[#a0aabd]">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#1e2a3a] bg-[#05070a] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-[#6f798c]">
        {label}
      </div>
      <div className="mt-1 text-[#eef1f8]">{value}</div>
    </div>
  );
}

function ms(v: number | null): string {
  return v === null ? "—" : `${Math.round(v).toLocaleString()} ms`;
}

/**
 * Interpret a captured RunResult against the Phase B/C/E thresholds
 * named in `.claude/plans/zesty-giggling-charm.md`. Returns a short
 * recommendation a reviewer can act on without re-reading the plan.
 *
 * Thresholds:
 *   - engineLoadMs > 20_000 → Phase B (bundling) likely worthwhile
 *   - totalBytes > 1_500_000_000 (~1.5 GB) → Phase E is the cheaper
 *     win because the device might not even support Phase B's
 *     bundled rewrite (storage quota)
 *   - sparsity decision needs the sidecar; this surface can't compute
 *     it from JS — but we tell the reviewer what to do next.
 */
function recommendation(r: RunResult): {
  headline: string;
  followups: string[];
} {
  const followups: string[] = [
    "Run scripts/measure-sparsity.py for the Phase C/B/E decision.",
  ];

  const loadMs = r.perf.derived.engineLoadMs;
  const totalBytes = r.cacheDelta?.totalAddedBytes ?? 0;

  if (loadMs === null) {
    return {
      headline: "Engine never fully loaded — capture failed.",
      followups: [
        "Check the Result error message.",
        "Retry in an incognito window.",
      ],
    };
  }

  if (loadMs > 30_000) {
    return {
      headline:
        "Cold start above 30s — Phase B (row-column bundling) is the highest-leverage next step.",
      followups: [
        ...followups,
        "Consider Phase E (smaller stronger model — Phi-3 mini) as a parallel track.",
      ],
    };
  }

  if (loadMs > 15_000) {
    return {
      headline:
        "Cold start in the 15-30s range — Phase B will help; Phase C only if sparsity is favorable.",
      followups,
    };
  }

  if (totalBytes > 1_500_000_000) {
    return {
      headline:
        "Cold start is acceptable but model is heavy — Phase E (smaller stronger model) is the bigger UX win.",
      followups,
    };
  }

  return {
    headline: "Cold start is already fast — focus on Phase E (model quality) over loader perf.",
    followups,
  };
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function download(content: string, filename: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
