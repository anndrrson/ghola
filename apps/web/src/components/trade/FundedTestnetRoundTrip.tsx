"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Loader2, ShieldAlert, TestTube2, TriangleAlert } from "lucide-react";

type RoundTripState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "running" }
  | { status: "complete"; report: RoundTripReport }
  | { status: "error"; message: string };

type RoundTripReport = {
  network: "testnet";
  market: string;
  notional_usd: number;
  claim_store: "postgres";
  entry_status: "filled";
  entry_fill_proven: true;
  duplicate_entry_prevented: true;
  exit_status: "filled";
  exit_fill_proven: true;
  duplicate_exit_prevented: true;
  flat_after_exit: true;
  open_orders_after_exit: 0;
  stored_receipt_replayed: true;
  entry_work_order_commitment: string;
  exit_work_order_commitment: string;
  completed_at: string;
};

const CONFIRMATION = "RUN_FUNDED_HYPERLIQUID_TESTNET_ROUND_TRIP";

export function FundedTestnetRoundTrip({ market, notionalUsd }: { market: string; notionalUsd: number }) {
  const [state, setState] = useState<RoundTripState>({ status: "idle" });

  async function run() {
    if (state.status !== "confirming") return;
    setState({ status: "running" });
    try {
      const response = await fetch("/api/testnet/hyperliquid-roundtrip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ confirmation: CONFIRMATION }),
      });
      const body = await response.json().catch(() => ({})) as Partial<RoundTripReport> & { error?: string };
      if (!response.ok || body.flat_after_exit !== true || body.open_orders_after_exit !== 0) {
        throw new Error(body.error || "Funded testnet round trip did not return flat proof.");
      }
      setState({ status: "complete", report: body as RoundTripReport });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Funded testnet round trip failed.",
      });
    }
  }

  return (
    <main className="min-h-screen bg-[#05070b] p-4 font-mono text-[#dce6f4] sm:p-8">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-[#223149] bg-[#090d14] shadow-2xl shadow-black/40">
        <header className="border-b border-[#223149] px-5 py-5 sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
              <TestTube2 aria-hidden className="h-4 w-4" /> Funded execution staging
            </p>
            <span className="rounded border border-emerald-300/30 bg-emerald-300/[0.06] px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-emerald-300">
              Hyperliquid testnet only
            </span>
          </div>
          <h1 className="mt-3 text-xl font-semibold text-white sm:text-2xl">Filled round-trip proof</h1>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#8d9bb1] sm:text-sm">
            Browser → guarded Next route → Postgres execution claims → funded Hyperliquid testnet entry → reduce-only exit → exact receipt replay → flat-account proof.
          </p>
        </header>

        <div className="grid gap-4 p-5 sm:grid-cols-4 sm:p-7">
          <Metric label="Network" value="testnet" />
          <Metric label="Market" value={market} />
          <Metric label="Maximum notional" value={`$${notionalUsd}`} />
          <Metric label="Claim store" value="Postgres" />
        </div>

        <div className="border-t border-[#223149] px-5 py-5 sm:px-7">
          {state.status === "complete" ? (
            <Complete report={state.report} />
          ) : state.status === "confirming" ? (
            <div className="rounded-md border border-amber-300/35 bg-amber-300/[0.06] p-4">
              <p className="flex items-start gap-2 text-sm leading-6 text-amber-100">
                <ShieldAlert aria-hidden className="mt-1 h-4 w-4 shrink-0 text-amber-300" />
                This will open and immediately close a real funded <strong>testnet</strong> position. It cannot target mainnet. Failure invokes the emergency flatten path.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => void run()} className="rounded bg-cyan-300 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-200">
                  Confirm ${notionalUsd} testnet round trip
                </button>
                <button type="button" onClick={() => setState({ status: "idle" })} className="rounded border border-[#34425a] px-4 py-2 text-sm text-[#b8c4d8] hover:border-[#62708a]">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={state.status === "running"}
                onClick={() => setState({ status: "confirming" })}
                className="flex min-h-11 items-center gap-2 rounded bg-cyan-300 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-60"
              >
                {state.status === "running" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <TestTube2 aria-hidden className="h-4 w-4" />}
                {state.status === "running" ? "Opening, filling, and flattening…" : "Run funded testnet round trip"}
              </button>
              <Link href="/trade?flow=hyperliquid-live" className="rounded border border-[#34425a] px-4 py-2 text-sm text-[#b8c4d8] hover:border-[#62708a]">
                Return to terminal
              </Link>
            </div>
          )}
          <p role="status" data-testid="funded-testnet-state" aria-live="polite" className="mt-3 text-xs text-[#8d9bb1]">
            State: {state.status === "complete" ? "flat" : state.status}
          </p>
          {state.status === "error" ? (
            <p role="alert" className="mt-3 flex items-start gap-2 text-xs leading-5 text-rose-300">
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {state.message}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
function Complete({ report }: { report: RoundTripReport }) {
  const checks = [
    ["Entry", `${report.entry_status} · venue/fill proof`],
    ["Entry replay", report.duplicate_entry_prevented ? "duplicate prevented" : "failed"],
    ["Exit", `${report.exit_status} · reduce-only fill proof`],
    ["Exit replay", report.duplicate_exit_prevented ? "duplicate prevented" : "failed"],
    ["Recovery", report.stored_receipt_replayed ? "exact receipt replayed" : "failed"],
    ["Final account", report.flat_after_exit && report.open_orders_after_exit === 0 ? "flat · 0 open orders" : "not flat"],
  ];
  return (
    <div className="rounded-md border border-emerald-300/35 bg-emerald-300/[0.05] p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
        <CheckCircle2 aria-hidden className="h-5 w-5" /> Filled round trip verified
      </p>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        {checks.map(([label, value]) => (
          <div key={label} className="rounded border border-emerald-300/15 bg-black/15 px-3 py-2">
            <dt className="text-[9px] uppercase tracking-[0.14em] text-[#789087]">{label}</dt>
            <dd className="mt-1 text-xs text-emerald-100">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 break-all text-[10px] leading-5 text-[#8d9bb1]">Entry claim: {report.entry_work_order_commitment}</p>
      <p className="break-all text-[10px] leading-5 text-[#8d9bb1]">Exit claim: {report.exit_work_order_commitment}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#223149] bg-black/15 p-3">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[#66738c]">{label}</p>
      <p className="mt-1 text-sm text-cyan-100">{value}</p>
    </div>
  );
}
