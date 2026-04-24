"use client";

/**
 * /m/[slug]/dash — merchant dashboard.
 *
 * Four things:
 *   1. Wallet + earnings ticker (the ritual moment when the first USDC lands)
 *   2. "Fire a test call" button that exercises the whole gateway loop
 *   3. Live log tail — polled every 3s for now, upgradeable to SSE later
 *   4. Kill switch
 *
 * Round 1 auth model: read-only dashboard data stays slug-addressable, while
 * destructive actions (kill switch) require either a JWT owner session or
 * a signed manage token returned at `/m/new` and persisted in sessionStorage.
 */

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  getMerchantListing,
  getMerchantLogs,
  getMerchantEarnings,
  runMerchantTestCall,
  killMerchant,
  type MerchantPublicListing,
  type MerchantCallLog,
  type MerchantEarningsSummary,
} from "@/lib/api";

export default function MerchantDashboardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const searchParams = useSearchParams();

  const [listing, setListing] = useState<MerchantPublicListing | null>(null);
  const [logs, setLogs] = useState<MerchantCallLog[]>([]);
  const [earnings, setEarnings] = useState<MerchantEarningsSummary | null>(null);
  const [manageToken, setManageToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    status: number;
    latency_ms: number;
    error: string | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [killed, setKilled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [l, lg, e] = await Promise.all([
        getMerchantListing(slug),
        getMerchantLogs(slug, 50, manageToken ?? undefined),
        getMerchantEarnings(slug, manageToken ?? undefined),
      ]);
      setListing(l);
      setLogs(lg);
      setEarnings(e);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [slug, manageToken]);

  useEffect(() => {
    if (!authReady) return;
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh, authReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `ghola_manage_token:${slug}`;
    const fromQuery = searchParams.get("manage");
    if (fromQuery) {
      sessionStorage.setItem(key, fromQuery);
      setManageToken(fromQuery);
      setAuthReady(true);
      return;
    }
    setManageToken(sessionStorage.getItem(key));
    setAuthReady(true);
  }, [slug, searchParams]);

  async function fireTestCall() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await runMerchantTestCall(slug, manageToken ?? undefined);
      setTestResult({
        status: r.status,
        latency_ms: r.latency_ms,
        error: r.error,
      });
      // Refresh logs immediately so the caller sees their own test.
      setTimeout(refresh, 500);
    } catch (err: unknown) {
      setTestResult({
        status: 0,
        latency_ms: 0,
        error: err instanceof Error ? err.message : "Test call failed",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleKill() {
    if (!confirm("Kill this listing? Callers will start getting 404s immediately.")) {
      return;
    }
    try {
      await killMerchant(slug, manageToken ?? undefined);
      setKilled(true);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Kill failed");
    }
  }

  if (!listing && !error) {
    return (
      <div className="min-h-screen bg-black text-[#4a5568] font-mono text-sm flex items-center justify-center">
        loading…
      </div>
    );
  }

  const priceUsd = listing
    ? (listing.price_micro_usdc / 1_000_000).toFixed(
        listing.price_micro_usdc < 1_000 ? 6 : 4,
      )
    : "—";
  const totalUsd = earnings
    ? (earnings.total_micro_usdc / 1_000_000).toFixed(2)
    : "0.00";
  const last24Usd = earnings
    ? (earnings.last_24h_micro_usdc / 1_000_000).toFixed(2)
    : "0.00";

  return (
    <div className="min-h-screen bg-black text-[#eef1f8] font-[family-name:var(--font-geist-sans)]">
      <div className="mx-auto max-w-4xl px-6 pt-16 pb-24">
        {/* Crumb */}
        <nav className="mb-12 flex items-center gap-3 text-sm">
          <Link href="/" className="text-[#4a5568] hover:text-[#8b95a8]">
            ghola
          </Link>
          <span className="text-[#4a5568] font-mono">/</span>
          <Link href={`/m/${slug}`} className="text-[#4a5568] hover:text-[#8b95a8] font-mono">
            {slug}
          </Link>
          <span className="text-[#4a5568] font-mono">/</span>
          <span className="text-[#eef1f8] font-medium">dash</span>
        </nav>

        {error && (
          <div className="mb-8 border-l-2 border-red-500 bg-red-500/10 px-4 py-3 font-mono text-[13px] text-red-300">
            {error}
          </div>
        )}

        {killed ? (
          <div className="max-w-md">
            <div className="mb-2 text-[11px] tracking-[0.12em] text-[#ef4444]">
              › SUSPENDED
            </div>
            <h1 className="mb-4 text-5xl font-medium tracking-[-0.03em]">
              Listing killed.
            </h1>
            <p className="text-[15px] text-[#8b95a8] leading-relaxed">
              The gateway will return 404 for this slug within 30 seconds. Your
              wallet is untouched — existing USDC stays in it.
            </p>
          </div>
        ) : (
          <>
            {/* Earnings hero */}
            <div className="mb-16">
              <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
                › TOTAL EARNED
              </div>
              <div className="flex items-baseline gap-4">
                <span className="text-7xl font-medium tracking-[-0.03em]">
                  ${totalUsd}
                </span>
                <span className="text-sm font-mono text-[#4a5568]">USDC</span>
              </div>
              <div className="mt-3 h-[2px] w-16 bg-[#3da8ff]" />
              <p className="mt-4 text-[13px] text-[#8b95a8]">
                ${last24Usd} in the last 24 hours · {earnings?.total_calls ?? 0} total calls · ${priceUsd}/call
              </p>
            </div>

            {/* Gateway URL */}
            <div className="mb-12">
              <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
                › YOUR GATEWAY URL
              </div>
              <div className="flex items-center gap-3">
                <code className="flex-1 border-l-2 border-[#3da8ff] bg-[#0b0e14] px-4 py-3 font-mono text-[13px] text-[#eef1f8] break-all">
                  {listing?.gateway_url}
                </code>
                <button
                  onClick={() => {
                    if (listing) navigator.clipboard.writeText(listing.gateway_url);
                  }}
                  className="border border-[#1e2a3a] px-4 py-3 text-[11px] tracking-[0.12em] text-[#8b95a8] hover:border-[#3da8ff] hover:text-[#3da8ff] transition-colors"
                >
                  COPY
                </button>
              </div>
            </div>

            {/* Test-call ritual */}
            <div className="mb-16">
              <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
                › RITUAL — FIRE A TEST CALL
              </div>
              <p className="mb-4 text-[13px] text-[#8b95a8] max-w-xl leading-relaxed">
                Runs a treasury-funded agent call through the full loop: route
                cache, vault decrypt, auth injection, metering, settlement. If
                this works, everything works.
              </p>
              <button
                onClick={fireTestCall}
                disabled={testing}
                className="bg-[#3da8ff] px-6 py-3 text-[12px] font-medium tracking-[0.12em] text-black hover:bg-[#2d8fe0] disabled:bg-[#1e2a3a] disabled:text-[#4a5568] transition-colors"
              >
                {testing ? "FIRING…" : "FIRE TEST CALL  →"}
              </button>

              {testResult && (
                <div
                  className={`mt-6 border-l-2 px-4 py-3 font-mono text-[13px] ${
                    testResult.error
                      ? "border-red-500 text-red-300"
                      : testResult.status >= 200 && testResult.status < 400
                      ? "border-[#3da8ff] text-[#3da8ff]"
                      : "border-yellow-500 text-yellow-300"
                  }`}
                >
                  {testResult.error
                    ? `× ${testResult.error}`
                    : `✓ HTTP ${testResult.status} · ${testResult.latency_ms}ms`}
                </div>
              )}
            </div>

            {/* Live log tail */}
            <div className="mb-16">
              <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
                › LIVE LOG — LAST 50
              </div>
              <div className="border border-[#1e2a3a] bg-[#080a0f] max-h-[420px] overflow-auto">
                {logs.length === 0 ? (
                  <div className="px-5 py-8 text-center font-mono text-[12px] text-[#4a5568]">
                    no calls yet
                  </div>
                ) : (
                  <table className="w-full font-mono text-[12px]">
                    <thead>
                      <tr className="text-[10px] tracking-[0.12em] text-[#4a5568] border-b border-[#1e2a3a]">
                        <th className="text-left py-2 px-4">TIME</th>
                        <th className="text-left py-2 px-2">METHOD</th>
                        <th className="text-left py-2 px-2">PATH</th>
                        <th className="text-right py-2 px-2">STATUS</th>
                        <th className="text-right py-2 px-2">MS</th>
                        <th className="text-right py-2 px-4">EARNED</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log) => {
                        const t = new Date(log.created_at).toLocaleTimeString();
                        const earned = (log.amount_charged_micro_usdc / 1_000_000).toFixed(6);
                        const statusColor =
                          log.gateway_status >= 200 && log.gateway_status < 400
                            ? "text-[#3da8ff]"
                            : log.gateway_status >= 500
                            ? "text-red-400"
                            : "text-yellow-400";
                        return (
                          <tr
                            key={log.id}
                            className="border-b border-[#1e2a3a]/40 hover:bg-[#0f1117]"
                          >
                            <td className="py-2 px-4 text-[#4a5568]">{t}</td>
                            <td className="py-2 px-2 text-[#8b95a8]">{log.method}</td>
                            <td className="py-2 px-2 text-[#eef1f8] truncate max-w-[180px]">
                              {log.path || "/"}
                            </td>
                            <td className={`py-2 px-2 text-right ${statusColor}`}>
                              {log.gateway_status}
                            </td>
                            <td className="py-2 px-2 text-right text-[#8b95a8]">
                              {log.latency_ms}
                            </td>
                            <td className="py-2 px-4 text-right text-[#3da8ff]">
                              {log.payment_status === "paid" ? `$${earned}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Kill switch */}
            <div className="pt-8 border-t border-[#1e2a3a]">
              <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
                › DANGER
              </div>
              <button
                onClick={handleKill}
                className="border border-red-500/40 px-5 py-2 text-[11px] tracking-[0.12em] text-red-400 hover:bg-red-500/10 hover:border-red-500 transition-colors"
              >
                KILL LISTING
              </button>
              <p className="mt-2 text-xs text-[#4a5568]">
                Sets the listing to suspended. Callers get 404 within 30 seconds.
                Your wallet and funds are untouched.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
