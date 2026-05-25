"use client";

/**
 * Live integrity verification modal.
 *
 * Triggered by clicking the chat-header integrity badge. Re-runs the
 * full local + on-chain verification on every open (no caching — the
 * point is to *demonstrate* the live check, not optimize it). Renders
 * each check as a row whose styling matches the public verifier at
 * /r/[hash] so a returning user instantly recognizes the visual
 * grammar of "ghola is showing me primary-source math right now."
 */
import { useEffect, useState } from "react";
import { X, Loader2, Download, ShieldCheck } from "lucide-react";
import {
  verifyLocalIntegrity,
  type IntegrityVerificationResult,
} from "@/lib/integrity-verification";
import { buildPortableExport } from "@/lib/portable-export";

interface Props {
  modelId: string;
  open: boolean;
  onClose: () => void;
}

export function IntegrityVerifyModal({ modelId, open, onClose }: Props) {
  const [result, setResult] = useState<IntegrityVerificationResult | null>(
    null,
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset on close so the next open is a fresh live check.
      setResult(null);
      setDownloadError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await verifyLocalIntegrity(modelId);
      if (!cancelled) setResult(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, modelId]);

  // Escape-to-close — basic keyboard a11y, no focus-trap library
  // because the modal is small and tab-navigation within is short.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function downloadBundle() {
    if (!result) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      // Fetch the SRI manifest at click time so the bundle reflects the
      // build version of ghola the user is currently looking at, not
      // some snapshot from when the modal mounted.
      let sriManifest: unknown = undefined;
      try {
        const res = await fetch("/.well-known/sri-manifest.json", {
          cache: "no-store",
        });
        if (res.ok) sriManifest = await res.json();
      } catch {
        // non-fatal; bundle falls back to a stub
      }
      const blob = await buildPortableExport({
        modelId,
        result,
        sriManifest,
        // Receipts intentionally omitted from the chat-side bundle —
        // the modal doesn't know about the chat vault. The server
        // route at /r/[hash]/verify-bundle is the right place to bake
        // receipts in. The "Download verification bundle" button here
        // is the no-account, no-history snapshot.
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ghola-integrity-${modelId}-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "Bundle build failed.",
      );
    } finally {
      setDownloading(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="integrity-modal-title"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-[#1e2a3a] bg-[#08090d] text-[#eef1f8] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#1e2a3a] px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              <h2
                id="integrity-modal-title"
                className="font-display text-xl font-medium"
              >
                Live integrity verification
              </h2>
            </div>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f798c]">
              model · {modelId}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-[#8b95a8] hover:bg-[#1e2a3a] hover:text-[#eef1f8]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-[#8b95a8] leading-relaxed">
            Re-hashes the cached weights, fetches the live Solana
            registry record, and compares per-check.
            {result?.registryLookupSource === "server_rpc"
              ? " Your cached model bytes stay local; the registry read used Ghola's read-only RPC fallback because browser RPC was blocked."
              : " Nothing leaves your device except the on-chain RPC read."}
          </p>

          {!result ? (
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-[#1e2a3a] bg-[#0a0b10] px-4 py-6 text-sm text-[#8b95a8]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Running checks…
            </div>
          ) : (
            <>
              <OverallPill overall={result.overall} />
              <div className="mt-4 space-y-3">
                {result.checks.map((c, i) => (
                  <CheckRow
                    key={`${i}-${c.label}`}
                    label={c.label}
                    detail={c.detail}
                    pass={c.pass}
                    skipped={c.skipped ?? false}
                  />
                ))}
              </div>
              <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f798c]">
                ran at {new Date(result.verifiedAt).toISOString()}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#1e2a3a] px-6 py-4">
          <button
            onClick={() => void downloadBundle()}
            disabled={!result || downloading}
            className="inline-flex items-center gap-2 rounded-xl border border-[#3da8ff]/40 bg-[#3da8ff]/10 px-4 py-2 text-sm text-[#3da8ff] transition hover:bg-[#3da8ff]/15 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Download verification bundle
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-[#1e2a3a] px-4 py-2 text-sm text-[#8b95a8] transition hover:border-[#3a4558] hover:text-[#eef1f8]"
          >
            Close
          </button>
        </div>
        {downloadError && (
          <div className="border-t border-red-400/30 bg-red-400/5 px-6 py-3 text-xs text-red-300">
            {downloadError}
          </div>
        )}
      </div>
    </div>
  );
}

function OverallPill({
  overall,
}: {
  overall: IntegrityVerificationResult["overall"];
}) {
  const map = {
    verified: {
      cls: "border-emerald-400/30 bg-emerald-400/5 text-emerald-200",
      label: "All checks passed",
    },
    partial: {
      cls: "border-amber-400/30 bg-amber-400/5 text-amber-200",
      label: "Partial — some checks were skipped",
    },
    failed: {
      cls: "border-red-400/40 bg-red-400/5 text-red-200",
      label: "One or more checks failed",
    },
    unavailable: {
      cls: "border-[#1e2a3a] bg-[#0a0b10] text-[#8b95a8]",
      label: "Unavailable — WebGPU not detected",
    },
  } as const;
  const m = map[overall];
  return (
    <div
      className={`mt-6 inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${m.cls}`}
    >
      {m.label}
    </div>
  );
}

function CheckRow({
  label,
  detail,
  pass,
  skipped,
}: {
  label: string;
  detail: string;
  pass: boolean;
  skipped: boolean;
}) {
  const color = skipped
    ? "border-amber-400/30 bg-amber-400/5 text-amber-100"
    : pass
      ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-100"
      : "border-red-400/40 bg-red-400/5 text-red-100";
  const symbol = skipped ? "–" : pass ? "✓" : "✗";
  return (
    <div
      className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${color}`}
    >
      <span className="font-mono text-sm leading-snug w-4">{symbol}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="mt-1 font-mono text-[10px] break-all opacity-80">
          {detail}
        </div>
      </div>
    </div>
  );
}
