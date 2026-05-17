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
import { IntegrityVerifyModal } from "./IntegrityVerifyModal";

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
  // The modal renders live verification on click. Kept inside the
  // badge so the chat surface above doesn't need new wiring — the
  // badge is a self-contained "click me to prove it" affordance.
  const [modalOpen, setModalOpen] = useState(false);

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

  // Shared interactive base class: lifts the static `<span>` styling to
  // a `<button>` so the entire chip is the click target. Cursor +
  // subtle ring on hover signal the affordance without screaming.
  const interactiveBase =
    "cursor-pointer transition hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3da8ff]/60";

  if (!result) {
    return (
      <span className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#3da8ff] animate-pulse" />
        Checking chain
      </span>
    );
  }

  // Single shared modal — rendered once below the switch so every
  // badge state shares the same overlay element.
  const modal = (
    <IntegrityVerifyModal
      modelId={modelId}
      open={modalOpen}
      onClose={() => setModalOpen(false)}
    />
  );

  switch (result.status) {
    case "verified": {
      const lines = [
        `Verified against on-chain registry${result.slot ? ` (slot ${result.slot})` : ""}.`,
        result.creator ? `Creator: ${result.creator}` : null,
        result.version ? `Record version: ${result.version}` : null,
        result.modelLibHash
          ? `Model_lib hash (on-chain): ${result.modelLibHash}`
          : null,
        result.configHash
          ? `Config hash (on-chain):    ${result.configHash}`
          : null,
        result.tokenizerHash
          ? `Tokenizer hash (on-chain): ${result.tokenizerHash}`
          : null,
        weights
          ? `Local runtime fingerprint: ${weights.fingerprint}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return (
        <>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            title={`${lines}\n\nClick to run live verification.`}
            aria-label="Open live integrity verification"
            className={`hidden md:inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-300 ${interactiveBase}`}
          >
            <ShieldCheck className="h-3 w-3" />
            Verified
          </button>
          {modal}
        </>
      );
    }
    case "mismatch":
      return (
        <>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            title="Loaded weights hash does not match the on-chain registry entry. Click to inspect."
            aria-label="Open live integrity verification"
            className={`hidden md:inline-flex items-center gap-1.5 rounded-full border border-red-400/40 bg-red-400/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-red-300 ${interactiveBase}`}
          >
            <ShieldAlert className="h-3 w-3" />
            Mismatch
          </button>
          {modal}
        </>
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
        <>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            title={
              (pinned
                ? "Model loader (config + WASM + tokenizer) verified against pinned SRI hashes. On-chain registry record pending."
                : "Read the chain at the model's deterministic PDA; no registry record yet (Tier 1A.5 deliverable)") +
              weightLine +
              "\n\nClick to run live verification."
            }
            aria-label="Open live integrity verification"
            className={
              (pinned
                ? "hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#3da8ff]/30 bg-[#3da8ff]/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#3da8ff]"
                : "hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8b95a8]") +
              " " +
              interactiveBase
            }
          >
            <ShieldCheck className="h-3 w-3" />
            {pinned ? "SRI pinned" : "Registry pending"}
            {weights && (
              <span className="opacity-70 normal-case tracking-normal">
                · {weights.fingerprint.slice(0, 8)}
              </span>
            )}
          </button>
          {modal}
        </>
      );
    }
    case "unreachable":
      return (
        <>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            title={`${result.error ?? "Solana RPC unreachable"}\n\nClick to retry / inspect.`}
            aria-label="Open live integrity verification"
            className={`hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c] ${interactiveBase}`}
          >
            <ShieldQuestion className="h-3 w-3" />
            Chain unreachable
          </button>
          {modal}
        </>
      );
  }
}
