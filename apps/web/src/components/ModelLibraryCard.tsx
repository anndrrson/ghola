"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import { Cpu, HardDrive, ScrollText, FileCheck2, Download } from "lucide-react";

/**
 * Presentational card for an open-weight model in the `/models/local`
 * library. Visual style mirrors the cards on `/security/status`:
 * border `#1e2a3a`, bg `#0a0b10`, text `#eef1f8`.
 *
 * Behavior is intentionally minimal — this component owns no fetch
 * state; the page passes everything in. The single piece of dynamism
 * is the optional `Pre-load` button which lazy-imports
 * `PreloadModelCta` (shipped by Agent 4) and gracefully degrades when
 * that component isn't on disk yet.
 */
export interface ModelLibraryCardProps {
  name: string;
  /** Short human-readable size, e.g. "~800 MB". */
  size: string;
  /** Human-readable license, e.g. "Llama 3.2 Community License". */
  license: string;
  /** WebLLM model id used by the engine. */
  modelId: string;
  /**
   * Whether at least one WebLLM cache scope contains an entry for
   * this model. The page computes this from `getCacheInventory()`.
   */
  cached: boolean;
  /**
   * Short prefix of the pinned weights hash from the SRI manifest
   * (e.g. first 12 hex chars of the canonical
   * `DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH`). Used as a badge so a
   * reviewer can eyeball that the on-disk pin matches the on-chain
   * record.
   */
  integrityHashShort: string;
}

// Lazy-import the preload CTA so we don't crash the build if Agent 4
// hasn't shipped it yet. Re-imports on every press are fine — module
// resolution is cached after the first hit.
type PreloadModelCtaModule = {
  default?: ComponentType<{ modelId?: string }>;
  PreloadModelCta?: ComponentType<{ modelId?: string }>;
};

export function ModelLibraryCard(props: ModelLibraryCardProps) {
  const { name, size, license, modelId, cached, integrityHashShort } = props;
  const [PreloadCta, setPreloadCta] = useState<ComponentType<{
    modelId?: string;
  }> | null>(null);
  const [preloadUnavailable, setPreloadUnavailable] = useState(false);
  const [preloadLoading, setPreloadLoading] = useState(false);

  async function tryLoadPreloadCta() {
    if (PreloadCta || preloadUnavailable || preloadLoading) return;
    setPreloadLoading(true);
    try {
      // Webpack/Turbopack will keep this dynamic — if the file is
      // missing at build time the import resolves to a rejection.
      const mod = (await import(
        "@/components/PreloadModelCta"
      )) as PreloadModelCtaModule;
      const Cmp = mod.default ?? mod.PreloadModelCta ?? null;
      if (Cmp) {
        setPreloadCta(() => Cmp);
      } else {
        setPreloadUnavailable(true);
      }
    } catch {
      setPreloadUnavailable(true);
    } finally {
      setPreloadLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0a0b10] p-5 text-[#eef1f8]">
      <div className="flex items-start gap-3">
        <Cpu className="h-4 w-4 mt-1 shrink-0 text-[#3da8ff]" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-display text-lg leading-tight">{name}</h2>
            <span
              className={
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em] " +
                (cached
                  ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-200"
                  : "border-[#1e2a3a] text-[#6f798c]")
              }
            >
              {cached ? "cached on device" : "not cached"}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-[#6f798c] break-all">
            {modelId}
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-y-2 text-[12px] sm:grid-cols-2 sm:gap-x-6">
            <div className="flex items-center gap-2">
              <HardDrive className="h-3.5 w-3.5 text-[#8b95a8]" />
              <dt className="text-[#8b95a8]">Size</dt>
              <dd className="ml-auto font-mono text-[#eef1f8]">{size}</dd>
            </div>
            <div className="flex items-center gap-2">
              <ScrollText className="h-3.5 w-3.5 text-[#8b95a8]" />
              <dt className="text-[#8b95a8]">License</dt>
              <dd className="ml-auto text-[#eef1f8] text-right">{license}</dd>
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <FileCheck2 className="h-3.5 w-3.5 text-[#8b95a8]" />
              <dt className="text-[#8b95a8]">Pinned hash</dt>
              <dd className="ml-auto font-mono text-[10px] text-[#3da8ff] break-all">
                {integrityHashShort}
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {PreloadCta ? (
              <PreloadCta modelId={modelId} />
            ) : (
              <button
                type="button"
                onClick={tryLoadPreloadCta}
                disabled={preloadLoading || preloadUnavailable}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="h-3 w-3" />
                {preloadUnavailable
                  ? "Pre-load (unavailable)"
                  : preloadLoading
                    ? "Loading…"
                    : "Pre-load"}
              </button>
            )}
            <Link
              href="/chat"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#3da8ff] hover:text-[#eef1f8] hover:border-[#2a3a50]"
            >
              Verify integrity now →
            </Link>
            <Link
              href="/settings/cache"
              className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#6f798c] hover:text-[#eef1f8]"
            >
              Manage cache
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ModelLibraryCard;
