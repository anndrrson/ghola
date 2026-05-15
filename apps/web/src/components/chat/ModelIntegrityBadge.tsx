"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import {
  lookupModel,
  type ModelRegistryResult,
} from "@/lib/model-registry";
import {
  DEFAULT_WEBGPU_MODEL,
  computeLoadedWeightFingerprint,
  type WeightFingerprint,
} from "@/lib/webgpu-inference";

interface Props {
  /** The MLC model id currently loaded in the browser (or null when idle). */
  modelId: string | null;
}

/**
 * Whether ghola ships pinned SRI hashes for the model's loader artifacts.
 * When true, WebLLM verifies model_lib + config + tokenizer on download
 * (see webgpu-inference.ts::DEFAULT_WEBGPU_MODEL_INTEGRITY). The on-chain
 * registry is the broader claim for weight + creator provenance; SRI
 * is the narrower one that already runs.
 */
function isSriPinned(modelId: string): boolean {
  return modelId === DEFAULT_WEBGPU_MODEL;
}

// Small, low-key chip rendered in the chat header. The point isn't to
// flex a feature — it's to surface the protocol read happening on every
// session. A cold visitor in Local mode sees this update from "checking"
// → "verified | pending | mismatch" without ever signing in.
export function ModelIntegrityBadge({ modelId }: Props) {
  const [result, setResult] = useState<ModelRegistryResult | null>(null);
  const [weights, setWeights] = useState<WeightFingerprint | null>(null);

  useEffect(() => {
    if (!modelId) {
      setResult(null);
      setWeights(null);
      return;
    }
    let cancelled = false;
    setResult(null);
    setWeights(null);
    void lookupModel(modelId).then((r) => {
      if (!cancelled) setResult(r);
    });
    // Weight fingerprint isn't ready until WebLLM finishes its cache
    // writes. Poll lightly for ~30s after the badge mounts — almost
    // every first-load completes inside that window on broadband. After
    // 30s we stop because either the model never loaded (browser
    // unsupported, no first message yet) or the cache is empty.
    let attempt = 0;
    const tick = async () => {
      if (cancelled) return;
      const fp = await computeLoadedWeightFingerprint();
      if (cancelled) return;
      if (fp) {
        setWeights(fp);
        return;
      }
      attempt += 1;
      if (attempt > 15) return;
      setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  if (!modelId) return null;

  if (!result) {
    return (
      <span className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#3da8ff] animate-pulse" />
        Checking chain
      </span>
    );
  }

  switch (result.status) {
    case "verified":
      return (
        <span
          title={`Verified against on-chain registry${result.slot ? ` (slot ${result.slot})` : ""}`}
          className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-300"
        >
          <ShieldCheck className="h-3 w-3" />
          Verified
        </span>
      );
    case "mismatch":
      return (
        <span
          title="Loaded weights hash does not match the on-chain registry entry"
          className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-red-400/40 bg-red-400/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-red-300"
        >
          <ShieldAlert className="h-3 w-3" />
          Mismatch
        </span>
      );
    case "unregistered": {
      // If we ship SRI hashes for this model, the loader is already
      // verified at download time even though the on-chain registry
      // record doesn't exist yet. Surface that distinction, and if a
      // runtime weight fingerprint is available, include the hash
      // so the user can independently compare across machines or
      // sessions.
      const pinned = isSriPinned(modelId);
      const weightLine = weights
        ? `\n\nWeight fingerprint (sha256 over ${weights.files.length} cached artifacts):\n${weights.fingerprint}`
        : "";
      return (
        <span
          title={
            (pinned
              ? "Model loader (config + WASM + tokenizer) verified against pinned SRI hashes. On-chain registry record pending."
              : "Read the chain at the model's deterministic PDA; no registry record yet (Tier 1A.5 deliverable)") + weightLine
          }
          className={
            pinned
              ? "hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#3da8ff]/30 bg-[#3da8ff]/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#3da8ff]"
              : "hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8b95a8]"
          }
        >
          <ShieldCheck className="h-3 w-3" />
          {pinned ? "SRI pinned" : "Registry pending"}
          {weights && (
            <span className="opacity-70 normal-case tracking-normal">
              · {weights.fingerprint.slice(0, 8)}
            </span>
          )}
        </span>
      );
    }
    case "unreachable":
      return (
        <span
          title={result.error ?? "Solana RPC unreachable"}
          className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c]"
        >
          <ShieldQuestion className="h-3 w-3" />
          Chain unreachable
        </span>
      );
  }
}
