"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database,
  RefreshCw,
  Trash2,
  HardDrive,
  Fingerprint,
  AlertTriangle,
} from "lucide-react";
import {
  WEBLLM_CACHE_SCOPES,
  clearAllWebLLMCaches,
  clearCacheScope,
  formatBytes,
  getCacheInventory,
  getStorageEstimate,
  type CacheScopeReport,
  type StorageEstimate,
} from "@/lib/local-cache-inventory";
import { computeLoadedWeightFingerprint } from "@/lib/webgpu-inference";

/**
 * Client-side cache-management UI for the WebLLM caches.
 *
 * - Enumerates each of the three WebLLM cache scopes.
 * - For each, lists every URL + byte size, plus a per-scope total.
 * - Shows total OPFS / Cache API usage via navigator.storage.estimate().
 * - Per-scope "Remove" → caches.delete(scope).
 * - Per-scope "Re-verify" → re-runs the canonical fingerprint walk
 *   from webgpu-inference.ts and prints the result.
 * - Global "Clear all local AI data" → wipes every WebLLM scope with
 *   a one-tap confirm.
 *
 * The fingerprint walk hashes the full cache body (multi-hundred-MB
 * for the weights scope) so it's strictly user-initiated, never
 * fired on mount.
 */
export function CacheManager() {
  const [reports, setReports] = useState<CacheScopeReport[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, est] = await Promise.all([
        getCacheInventory(),
        getStorageEstimate(),
      ]);
      if (inv === null) {
        setUnsupported(true);
        setReports(null);
      } else {
        setUnsupported(false);
        setReports(inv);
      }
      setEstimate(est);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeScope = useCallback(
    async (scope: string) => {
      setStatusLine(null);
      const ok = await clearCacheScope(scope);
      setStatusLine(
        ok
          ? `Removed ${scope}.`
          : `${scope} was not present (or could not be deleted).`,
      );
      await refresh();
    },
    [refresh],
  );

  const reverify = useCallback(async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const fp = await computeLoadedWeightFingerprint();
      if (!fp) {
        setVerifyResult(
          "No WebLLM artifacts cached in this browser yet. Send a Local-mode message in /chat to populate the caches, then return.",
        );
      } else {
        setVerifyResult(
          `Hashed ${fp.files.length} cached artifacts.\nFingerprint: ${fp.fingerprint}`,
        );
      }
    } catch (err) {
      setVerifyResult(
        err instanceof Error
          ? `Verification failed: ${err.message}`
          : "Verification failed.",
      );
    } finally {
      setVerifying(false);
    }
  }, []);

  const clearAll = useCallback(async () => {
    setStatusLine(null);
    const cleared = await clearAllWebLLMCaches();
    setStatusLine(
      cleared.length
        ? `Cleared ${cleared.length} scope(s): ${cleared.join(", ")}.`
        : "Nothing to clear — no WebLLM caches present.",
    );
    setConfirmingClearAll(false);
    await refresh();
  }, [refresh]);

  if (unsupported) {
    return (
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-5 text-amber-200">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm">CacheStorage is not available.</div>
            <div className="mt-1 text-[11px] opacity-80">
              This browser does not expose the Cache API (private-mode
              Safari, sandboxed iframes, or non-browser runtimes). Local
              caching is unavailable here.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const grandTotalBytes = (reports ?? []).reduce(
    (acc, r) => acc + r.totalBytes,
    0,
  );

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0a0b10] p-5 text-[#eef1f8]">
        <div className="flex items-start gap-3">
          <HardDrive className="h-4 w-4 mt-1 shrink-0 text-[#3da8ff]" />
          <div className="flex-1">
            <div className="text-sm">Storage estimate</div>
            <div className="mt-1 text-[11px] text-[#8b95a8]">
              Aggregate usage across CacheStorage, IndexedDB, OPFS, etc., as
              reported by the browser. WebLLM caches contribute to this
              figure but are not the only source.
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
              <dt className="text-[#8b95a8]">Used</dt>
              <dd className="font-mono text-right text-[#eef1f8]">
                {estimate ? formatBytes(estimate.usage) : "—"}
              </dd>
              <dt className="text-[#8b95a8]">Quota</dt>
              <dd className="font-mono text-right text-[#eef1f8]">
                {estimate ? formatBytes(estimate.quota) : "—"}
              </dd>
              <dt className="text-[#8b95a8]">WebLLM scopes total</dt>
              <dd className="font-mono text-right text-[#eef1f8]">
                {formatBytes(grandTotalBytes)}
              </dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
          />
          {loading ? "Scanning…" : "Re-scan caches"}
        </button>
        <button
          type="button"
          onClick={() => void reverify()}
          disabled={verifying}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#3da8ff] hover:text-[#eef1f8] hover:border-[#2a3a50] disabled:opacity-50"
        >
          <Fingerprint className="h-3 w-3" />
          {verifying ? "Hashing…" : "Re-verify weight fingerprint"}
        </button>
        {confirmingClearAll ? (
          <>
            <button
              type="button"
              onClick={() => void clearAll()}
              className="inline-flex items-center gap-1.5 rounded-full border border-red-400/40 bg-red-400/5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-red-200 hover:bg-red-400/10"
            >
              <Trash2 className="h-3 w-3" />
              Confirm clear all
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClearAll(false)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClearAll(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-red-200 hover:border-red-400/60 hover:bg-red-400/5"
          >
            <Trash2 className="h-3 w-3" />
            Clear all local AI data
          </button>
        )}
      </div>

      {statusLine && (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0a0b10] p-3 text-[11px] font-mono text-[#8b95a8]">
          {statusLine}
        </div>
      )}

      {verifyResult && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4 text-[11px] font-mono text-emerald-100 whitespace-pre-wrap break-all">
          {verifyResult}
        </div>
      )}

      <div className="space-y-3">
        {(reports ?? WEBLLM_CACHE_SCOPES.map((scope) => ({
          scope,
          present: false,
          entries: [],
          totalBytes: 0,
        }))).map((report) => (
          <ScopeCard
            key={report.scope}
            report={report}
            onRemove={() => void removeScope(report.scope)}
          />
        ))}
      </div>
    </div>
  );
}

function ScopeCard({
  report,
  onRemove,
}: {
  report: CacheScopeReport;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0a0b10] p-5 text-[#eef1f8]">
      <div className="flex items-start gap-3">
        <Database
          className={`h-4 w-4 mt-1 shrink-0 ${report.present ? "text-[#3da8ff]" : "text-[#6f798c]"}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-mono text-sm">{report.scope}</h3>
            <span
              className={
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em] " +
                (report.present
                  ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-200"
                  : "border-[#1e2a3a] text-[#6f798c]")
              }
            >
              {report.present ? "present" : "absent"}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
            <dt className="text-[#8b95a8]">Entries</dt>
            <dd className="font-mono text-right text-[#eef1f8]">
              {report.entries.length}
            </dd>
            <dt className="text-[#8b95a8]">Total size</dt>
            <dd className="font-mono text-right text-[#eef1f8]">
              {formatBytes(report.totalBytes)}
            </dd>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              disabled={report.entries.length === 0}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {expanded ? "Hide entries" : "Show entries"}
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={!report.present}
              className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-red-200 hover:border-red-400/60 hover:bg-red-400/5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-3 w-3" />
              Remove
            </button>
          </div>

          {expanded && report.entries.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-[#1e2a3a] pt-3">
              {report.entries.map((e) => (
                <li
                  key={e.url}
                  className="flex items-baseline gap-3 font-mono text-[10px]"
                >
                  <span className="truncate text-[#8b95a8] flex-1 min-w-0">
                    {e.url}
                  </span>
                  <span className="text-right text-[#eef1f8] shrink-0">
                    {formatBytes(e.byteLength)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default CacheManager;
