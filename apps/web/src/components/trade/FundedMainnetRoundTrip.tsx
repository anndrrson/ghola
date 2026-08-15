"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Loader2, ShieldAlert, TriangleAlert, Zap } from "lucide-react";
import {
  HYPERLIQUID_MAINNET_PROOF_CONFIRMATION,
  bindPrivateMobileWallet,
  getPrivateMobileWalletBindingChallenge,
  runHyperliquidMainnetRoundTrip,
  verifyVenueEligibility,
} from "@/lib/private-account-client";
import {
  LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
} from "@/lib/live-trading-contract";
import {
  connectSolanaWallet,
  privateAccountMobileProofHeaders,
  requiredSolanaProvider,
  walletSignBytes,
} from "@/lib/wallet-request-proof";

type FillSummary = {
  filled_base_size: string;
  filled_notional_usd: number;
  average_fill_price: number | null;
  fee_usd: number;
};

type VenueEvidenceLeg = {
  oid: string;
  cloid: string;
  order_status: "filled";
  reduce_only: boolean;
  filled_base_size: string;
  average_fill_price: number;
  filled_notional_usd: number;
  fee_usd: number;
  fee_token: "USDC";
  transaction_hashes: string[];
};

type MainnetRoundTripReport = {
  ok: true;
  network: "mainnet";
  market: "HYPE";
  notional_usd: 10.5;
  max_slippage_bps: 100;
  claim_store: "postgres";
  preflight_verified: true;
  api_wallet_authorization_verified: true;
  api_wallet_address: string;
  api_wallet_valid_until: string;
  preflight_transaction_broadcast: false;
  preflight_action_expiry_proven: true;
  entry_order_readback_proven: true;
  exit_order_readback_proven: true;
  entry_status: "filled";
  entry_fill_proven: true;
  entry_fill_summary: FillSummary;
  duplicate_entry_prevented: true;
  venue_position_protection_proven: true;
  protection_cleanup_confirmed: true;
  protection_children_terminal: true;
  take_profit_oid: string;
  stop_loss_oid: string;
  exit_status: "filled";
  exit_fill_proven: true;
  exit_fill_summary: FillSummary;
  duplicate_exit_prevented: true;
  stored_receipt_replayed: true;
  independent_venue_evidence_proven: true;
  entry_order_reference: VenueEvidenceLeg;
  exit_order_reference: VenueEvidenceLeg;
  venue_evidence_commitment: string;
  flat_after_exit: true;
  open_orders_after_exit: 0;
  proof_work_order_commitment: string;
  entry_work_order_commitment: string;
  exit_work_order_commitment: string;
  completed_at: string;
};

type State =
  | { status: "idle" | "confirming" | "authorizing" | "running" }
  | { status: "complete"; report: MainnetRoundTripReport }
  | { status: "error"; message: string };

const REQUEST_BODY = { confirmation: HYPERLIQUID_MAINNET_PROOF_CONFIRMATION };

export function FundedMainnetRoundTrip() {
  const [state, setState] = useState<State>({ status: "idle" });
  const [eligibleNonUs, setEligibleNonUs] = useState(false);

  async function run() {
    if (state.status !== "confirming" || !eligibleNonUs) return;
    try {
      setState({ status: "authorizing" });
      const wallet = await connectSolanaWallet();
      const provider = requiredSolanaProvider();
      const challenge = await getPrivateMobileWalletBindingChallenge(wallet);
      const bindingSignature = await walletSignBytes(
        provider,
        new TextEncoder().encode(challenge.message),
      );
      await bindPrivateMobileWallet({
        wallet_pubkey: wallet,
        message: challenge.message,
        signature_b64: bytesToBase64(bindingSignature),
      });
      await verifyVenueEligibility({
        venue_id: "hyperliquid",
        credential_type: "self_attested_eligible_user",
        eligible_non_us: true,
        terms_version: LIVE_TRADING_TERMS_VERSION,
        risk_disclosure_version: LIVE_TRADING_RISK_DISCLOSURE_VERSION,
        confirmation: LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
      });
      const proofHeaders = await privateAccountMobileProofHeaders({
        path: "/v1/private-account/hyperliquid/mainnet-roundtrip",
        body: REQUEST_BODY,
        wallet,
        signBytes: async (bytes) => walletSignBytes(provider, bytes),
      });
      setState({ status: "running" });
      const report = await runHyperliquidMainnetRoundTrip({ proofHeaders }) as MainnetRoundTripReport;
      if (!report.ok || !report.flat_after_exit || report.open_orders_after_exit !== 0 ||
          !report.venue_position_protection_proven || !report.protection_cleanup_confirmed ||
          !report.protection_children_terminal) {
        throw new Error("Mainnet proof did not return a final-flat receipt.");
      }
      setState({ status: "complete", report });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Hyperliquid mainnet proof failed.",
      });
    }
  }

  const working = state.status === "authorizing" || state.status === "running";
  return (
    <main className="min-h-screen bg-[#05070b] p-4 font-mono text-[#dce6f4] sm:p-8">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-[#2d3342] bg-[#090d14] shadow-2xl shadow-black/40">
        <header className="border-b border-[#2d3342] px-5 py-5 sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300">
              <Zap aria-hidden className="h-4 w-4" /> Real execution proof
            </p>
            <span className="rounded border border-rose-300/40 bg-rose-300/[0.07] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-rose-200">
              Hyperliquid mainnet · real funds
            </span>
          </div>
          <h1 className="mt-3 text-xl font-semibold text-white sm:text-2xl">$10.50 filled round trip</h1>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#8d9bb1] sm:text-sm">
            A protected HYPE IOC entry and reduce-only exit through the sealed trade-only wallet,
            with venue-native TP/SL, exact cleanup, Postgres claims, duplicate-submit protection,
            exact receipt replay, and final-flat proof.
          </p>
        </header>

        <div className="grid gap-3 p-5 sm:grid-cols-4 sm:p-7">
          <Metric label="Network" value="mainnet" />
          <Metric label="Market" value="HYPE-PERP" />
          <Metric label="Hard notional" value="$10.50" />
          <Metric label="Max slippage" value="100 bp" />
        </div>

        <div className="border-t border-[#2d3342] px-5 py-5 sm:px-7">
          {state.status === "complete" ? (
            <Complete report={state.report} />
          ) : state.status === "confirming" ? (
            <div className="rounded-md border border-rose-300/40 bg-rose-300/[0.06] p-4">
              <p className="flex items-start gap-2 text-sm leading-6 text-rose-100">
                <ShieldAlert aria-hidden className="mt-1 h-4 w-4 shrink-0 text-rose-300" />
                This broadcasts real mainnet orders. The worker refuses non-HYPE, more than $10.50,
                more than 100 bp slippage, a pre-existing HYPE position, or open HYPE orders.
              </p>
              <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-[#c5cfde]">
                <input
                  type="checkbox"
                  checked={eligibleNonUs}
                  onChange={(event) => setEligibleNonUs(event.target.checked)}
                  className="mt-1"
                />
                <span>I attest that I am an eligible non-US user and accept the live-trading terms and risk disclosure.</span>
              </label>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" disabled={!eligibleNonUs} onClick={() => void run()} className="rounded bg-rose-300 px-4 py-2 text-sm font-semibold text-black hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-50">
                  Confirm real $10.50 round trip
                </button>
                <button type="button" onClick={() => setState({ status: "idle" })} className="rounded border border-[#48536a] px-4 py-2 text-sm text-[#c5cfde] hover:border-[#76839c]">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={working}
                onClick={() => setState({ status: "confirming" })}
                className="flex min-h-11 items-center gap-2 rounded bg-amber-300 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-200 disabled:cursor-wait disabled:opacity-60"
              >
                {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Zap aria-hidden className="h-4 w-4" />}
                {state.status === "authorizing"
                  ? "Authorizing with Solana wallet…"
                  : state.status === "running"
                    ? "Opening, filling, and flattening…"
                    : "Run real Hyperliquid proof trade"}
              </button>
              <Link href="/trade?flow=hyperliquid-live" className="rounded border border-[#48536a] px-4 py-2 text-sm text-[#c5cfde] hover:border-[#76839c]">
                Connect account / return to terminal
              </Link>
            </div>
          )}
          <p role="status" data-testid="funded-mainnet-state" aria-live="polite" className="mt-3 text-xs text-[#8d9bb1]">
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

function Complete({ report }: { report: MainnetRoundTripReport }) {
  const entryPrice = report.entry_fill_summary.average_fill_price;
  const exitPrice = report.exit_fill_summary.average_fill_price;
  return (
    <div className="rounded-md border border-emerald-300/35 bg-emerald-300/[0.05] p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
        <CheckCircle2 aria-hidden className="h-5 w-5" /> Real filled round trip verified
      </p>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Proof label="Entry fill" value={`${formatPrice(entryPrice)} · ${report.entry_fill_summary.filled_base_size} HYPE`} />
        <Proof label="Preflight" value="authorized API wallet · no broadcast" />
        <Proof label="Venue readback" value="entry + exit confirmed by cloid" />
        <Proof label="Venue protection" value="TP + SL accepted, then terminally canceled" />
        <Proof label="Exit fill" value={`${formatPrice(exitPrice)} · reduce-only`} />
        <Proof label="Duplicate defense" value="entry + exit replayed, no rebroadcast" />
        <Proof label="Recovery proof" value="exact stored receipt replayed" />
        <Proof label="Independent proof" value="orders + fills re-read from Hyperliquid" />
        <Proof label="Venue references" value={`${shortRef(report.entry_order_reference.oid)} → ${shortRef(report.exit_order_reference.oid)}`} />
        <Proof label="Venue fees" value={`${formatFee(report.entry_order_reference.fee_usd + report.exit_order_reference.fee_usd)} USDC`} />
        <Proof label="Final account" value="flat · 0 HYPE open orders" />
        <Proof label="Claim store" value="Postgres" />
      </dl>
      <p className="mt-4 break-all text-[10px] leading-5 text-[#8d9bb1]">Proof claim: {report.proof_work_order_commitment}</p>
      <p className="break-all text-[10px] leading-5 text-[#8d9bb1]">Entry claim: {report.entry_work_order_commitment}</p>
      <p className="break-all text-[10px] leading-5 text-[#8d9bb1]">Exit claim: {report.exit_work_order_commitment}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#2d3342] bg-black/15 p-3">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[#737f95]">{label}</p>
      <p className="mt-1 text-sm text-amber-100">{value}</p>
    </div>
  );
}

function Proof({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-emerald-300/15 bg-black/15 px-3 py-2">
      <dt className="text-[9px] uppercase tracking-[0.14em] text-[#789087]">{label}</dt>
      <dd className="mt-1 text-xs text-emerald-100">{value}</dd>
    </div>
  );
}

function formatPrice(value: number | null) {
  return value == null ? "fill proven" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function formatFee(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function shortRef(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
