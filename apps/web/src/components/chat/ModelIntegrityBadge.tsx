"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import {
  lookupModel,
  type ModelRegistryResult,
} from "@/lib/model-registry";

interface Props {
  /** The MLC model id currently loaded in the browser (or null when idle). */
  modelId: string | null;
}

// Small, low-key chip rendered in the chat header. The point isn't to
// flex a feature — it's to surface the protocol read happening on every
// session. A cold visitor in Local mode sees this update from "checking"
// → "verified | pending | mismatch" without ever signing in.
export function ModelIntegrityBadge({ modelId }: Props) {
  const [result, setResult] = useState<ModelRegistryResult | null>(null);

  useEffect(() => {
    if (!modelId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setResult(null);
    void lookupModel(modelId).then((r) => {
      if (!cancelled) setResult(r);
    });
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
    case "unregistered":
      return (
        <span
          title="Read the chain at the model's deterministic PDA; no registry record yet (Tier 1A.5 deliverable)"
          className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8b95a8]"
        >
          <ShieldQuestion className="h-3 w-3" />
          Registry pending
        </span>
      );
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
