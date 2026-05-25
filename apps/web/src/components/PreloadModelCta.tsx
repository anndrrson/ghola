"use client";

/**
 * PreloadModelCta — opt-in "warm the local model now" affordance.
 *
 * Why this exists: the default WebGPU model is ~210MB. First-time chat
 * users pay that download on first send, which shows up as a ~10-30s
 * "Loading model…" wait before tokens stream. This component lets a
 * user pre-fetch the model from outside the chat surface (e.g. from
 * `/models/local`) so the next time they open `/chat` it's instant.
 *
 * Self-contained:
 *   - No props required. Renders unobtrusively (small button), runs
 *     the warm-up flow on click, persists a `localStorage` flag once
 *     complete so the button hides on subsequent visits.
 *   - Safe to mount anywhere a client component is allowed.
 *   - No network calls until the user clicks: we never burn bandwidth
 *     without explicit consent.
 *
 * Integration: Agent 5 may import + render this on `/models/local`.
 * The user controls when the download starts; the component handles
 * progress + completion entirely on its own.
 */

import { useCallback, useEffect, useState } from "react";
import {
  warmEngine,
  detectWebGPU,
  DEFAULT_WEBGPU_MODEL,
} from "@/lib/webgpu-inference";

type Phase = "idle" | "confirming" | "loading" | "done" | "error" | "unsupported";

export interface PreloadModelCtaProps {
  /**
   * Override the model id to pre-load. Defaults to the platform's
   * canonical WebGPU model. Most callers should leave this alone — the
   * `localStorage` "already preloaded" flag is keyed off the default
   * model only, so passing a different id will not persist a hide-state
   * across visits.
   */
  modelId?: string;
  /** Optional className for the outermost wrapper. */
  className?: string;
  /** Human-readable download size shown before the user starts. */
  approxSize?: string;
}

export function PreloadModelCta({
  modelId = DEFAULT_WEBGPU_MODEL,
  className,
  approxSize = "model files",
}: PreloadModelCtaProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);

  // Read the persistence flag + WebGPU support on mount. We render
  // nothing while we don't know yet (avoids flashing a button that will
  // immediately hide on hydration).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const storageKey = `ghola:preloaded-model:${modelId}`;
    try {
      if (
        typeof window !== "undefined" &&
        window.localStorage.getItem(storageKey) === "1"
      ) {
        setAlreadyDone(true);
      }
    } catch {
      // private mode / disabled storage: just show the button.
    }
    const support = detectWebGPU();
    if (!support.supported) setPhase("unsupported");
  }, [modelId]);

  const startWarm = useCallback(async () => {
    setPhase("loading");
    setProgress(0);
    setErrorMsg(null);
    try {
      await warmEngine(modelId, (report) => {
        setProgress(report.progress);
      });
      setPhase("done");
      setProgress(1);
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(`ghola:preloaded-model:${modelId}`, "1");
        }
      } catch {
        // ignore — we'll just re-show next visit, but the in-memory
        // engine is still warm for this tab.
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Model pre-load failed. Please try again.",
      );
      setPhase("error");
    }
  }, [modelId]);

  if (!mounted) return null;
  if (alreadyDone) return null;
  if (phase === "unsupported") return null;

  const pct = Math.max(0, Math.min(100, Math.floor(progress * 100)));

  return (
    <div className={className}>
      {phase === "idle" && (
        <button
          type="button"
          onClick={() => setPhase("confirming")}
          className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#0a0b10] px-3 py-1.5 text-xs font-medium text-[#eef1f8] hover:border-[#3da8ff]/60 hover:text-[#3da8ff] transition-colors cursor-pointer"
        >
          Pre-load model ({approxSize}, stays on your device)
        </button>
      )}
      {phase === "confirming" && (
        <div className="rounded-lg border border-[#1e2a3a] bg-[#0a0b10] p-3 text-xs text-[#eef1f8] max-w-sm">
          <p className="mb-2">
            This downloads {approxSize} of model files to your browser&apos;s
            local cache. The download stays on your device — nothing is sent
            to a server. Once cached, future chats start instantly.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void startWarm()}
              className="rounded-md bg-[#3da8ff] px-3 py-1 text-xs font-semibold text-[#08090d] hover:bg-[#5bb8ff] cursor-pointer"
            >
              Download now
            </button>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              className="rounded-md border border-[#1e2a3a] px-3 py-1 text-xs font-semibold text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {phase === "loading" && (
        <div className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#0a0b10] px-3 py-1.5 text-xs text-[#8b95a8]">
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#3da8ff]"
            aria-hidden
          />
          <span aria-live="polite" className="tabular-nums">
            Pre-loading model… {pct}%
          </span>
        </div>
      )}
      {phase === "done" && (
        <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200">
          Model cached on this device. Next chat will start instantly.
        </div>
      )}
      {phase === "error" && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 max-w-sm">
          <p className="mb-2">{errorMsg ?? "Pre-load failed."}</p>
          <button
            type="button"
            onClick={() => void startWarm()}
            className="rounded-md border border-red-300/40 px-3 py-1 text-xs font-semibold text-red-100 hover:border-red-200 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export default PreloadModelCta;
