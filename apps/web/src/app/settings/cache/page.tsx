"use client";

import Link from "next/link";
import { CacheManager } from "@/components/CacheManager";

// Cache management surface for Local-mode artifacts. Lists the three
// WebLLM cache scopes (config/wasm/model) with per-scope size +
// entries, surfaces navigator.storage.estimate() for the global
// quota picture, and offers per-scope remove + re-verify actions plus
// a confirmed "Clear all local AI data" button.
//
// All the heavy lifting (CacheStorage walk, fingerprint hash) lives in
// CacheManager. This page just hosts it with consistent chrome.

export default function CacheSettingsPage() {
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
          Local cache
        </h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-[#8b95a8]">
          Everything Local mode keeps on this device. The WebLLM engine
          stores model artifacts across three CacheStorage scopes —
          inspect them, free up space, or re-verify the on-disk weights
          against the canonical fingerprint. Nothing here is uploaded;
          all actions run in your browser.
        </p>

        <div className="mt-10">
          <CacheManager />
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link
            href="/models/local"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
          >
            ← On-device model library
          </Link>
          <Link
            href="/security/status"
            className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#6f798c] hover:text-[#eef1f8]"
          >
            Live security probes
          </Link>
        </div>
      </div>
    </div>
  );
}
