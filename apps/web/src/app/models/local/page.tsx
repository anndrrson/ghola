"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ModelLibraryCard } from "@/components/ModelLibraryCard";
import {
  DEFAULT_WEBGPU_MODEL,
  DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH,
  PHI3_MINI_WEBGPU_MODEL,
  PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH,
} from "@/lib/webgpu-inference";
import { getCacheInventory } from "@/lib/local-cache-inventory";

// Open-weight model library for Local mode. v1 ships with a single
// model — the one the WebGPU engine loads by default — but the page
// is structured as a list so we can add more entries without
// reshuffling the layout. "Cached" status comes from a CacheStorage
// walk via local-cache-inventory.ts (no body hashing, just URL
// enumeration). Pinned-hash badge surfaces the canonical
// DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH so a reviewer can compare against
// the on-chain record.

interface LocalModelDescriptor {
  name: string;
  size: string;
  license: string;
  modelId: string;
  /** Hex-encoded canonical weights hash (full string). */
  weightsHash: string;
  /**
   * A substring expected in WebLLM cache URLs for this model. Used to
   * decide whether at least one cached entry belongs to this model.
   * For the MLC ids the prefix `Llama-3.2-1B-Instruct-q4f16_1-MLC` is
   * distinctive enough.
   */
  cacheMarker: string;
}

const LOCAL_MODELS: LocalModelDescriptor[] = [
  {
    name: "Llama 3.2 1B Instruct (q4f16_1)",
    size: "~800 MB",
    license: "Llama 3.2 Community License",
    modelId: DEFAULT_WEBGPU_MODEL,
    weightsHash: DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH,
    cacheMarker: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  },
  {
    name: "Phi-3 mini 4k Instruct (q4f16_1)",
    size: "~2.3 GB",
    license: "MIT",
    modelId: PHI3_MINI_WEBGPU_MODEL,
    weightsHash: PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH,
    cacheMarker: "Phi-3-mini-4k-instruct-q4f16_1-MLC",
  },
];

export default function LocalModelsPage() {
  const [cachedMarkers, setCachedMarkers] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function scan() {
      const inv = await getCacheInventory();
      if (cancelled) return;
      const markers = new Set<string>();
      if (inv) {
        for (const report of inv) {
          for (const entry of report.entries) {
            for (const m of LOCAL_MODELS) {
              if (entry.url.includes(m.cacheMarker)) markers.add(m.cacheMarker);
            }
          }
        }
      }
      setCachedMarkers(markers);
      setScanned(true);
    }
    void scan();
    return () => {
      cancelled = true;
    };
  }, []);

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
          On-device model library
        </h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-[#8b95a8]">
          Open-weight models you can run entirely on your device. Once cached,
          inference happens locally over WebGPU — prompts and responses never
          leave the browser. Every model below pins an integrity hash that the{" "}
          <Link
            href="/chat"
            className="text-[#3da8ff] hover:underline"
          >
            chat
          </Link>{" "}
          page re-verifies live against the on-chain registry.
        </p>

        <div className="mt-10 space-y-4">
          {LOCAL_MODELS.map((m) => (
            <ModelLibraryCard
              key={m.modelId}
              name={m.name}
              size={m.size}
              license={m.license}
              modelId={m.modelId}
              cached={cachedMarkers.has(m.cacheMarker)}
              integrityHashShort={`${m.weightsHash.slice(0, 12)}…${m.weightsHash.slice(-6)}`}
              chatHref={
                m.modelId === DEFAULT_WEBGPU_MODEL
                  ? "/chat"
                  : `/chat?model=${encodeURIComponent(m.modelId)}`
              }
            />
          ))}
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link
            href="/settings/cache"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
          >
            Manage local cache →
          </Link>
          <Link
            href="/security/status"
            className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#6f798c] hover:text-[#eef1f8]"
          >
            Live security probes
          </Link>
        </div>

        <div className="mt-10 text-[11px] text-[#6f798c] font-mono">
          {scanned
            ? `${cachedMarkers.size}/${LOCAL_MODELS.length} model(s) detected in cache`
            : "scanning device cache…"}
        </div>
      </div>
    </div>
  );
}
