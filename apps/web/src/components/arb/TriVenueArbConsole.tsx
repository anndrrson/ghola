"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Transaction } from "@solana/web3.js";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Crosshair,
  KeyRound,
  LockKeyhole,
  Power,
  Radar,
  Send,
  ShieldCheck,
  Square,
  Wallet,
} from "lucide-react";
import { GholaMarketChart } from "@/components/private-account/GholaMarketChart";
import {
  gholaFrameFromBackpack,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaChartMode,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";
import {
  buildPrivateExecutionInstructionBundle,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import {
  publicKeyString,
  requiredSolanaProvider,
  solanaProvider,
  walletSignBytes,
} from "@/lib/wallet-request-proof";

import type {
  TriVenueMarketBundle,
  TriVenueOpportunity,
  TriVenueStatus,
  TriVenueQuote,
} from "@/lib/private-account-tri-venue-arb";

type Challenge = {
  wallet_pubkey: string;
  message: string;
};

type TriVenueLiveResult = {
  version: 1;
  error?: string;
  access_mode?: string;
  session?: {
    autopilot_session_id?: string;
    status?: string;
    worker_autopilot_session_id?: string | null;
    worker_session_commitment?: string | null;
    next_step?: string;
  };
  result?: Record<string, unknown> | null;
  status?: TriVenueStatus;
};

type PhoenixLiveResult = {
  version: 1;
  error?: string;
  status?: "submitted" | string;
  venue_id?: "phoenix";
  execution_mode?: "ghola_pooled";
  work_order_commitment?: string;
  policy_commitment?: string;
  allocation_commitment?: string;
  worker_receipt?: Record<string, unknown> | null;
  live_access?: {
    allocation_commitment?: string;
    policy_commitment?: string;
  };
  wallet_proof?: {
    proof_commitment?: string;
  };
};

type LiveResult = TriVenueLiveResult | PhoenixLiveResult;

type DepositIntentResult = {
  deposit_intent_id: string;
  rail: "solana_usdc" | "solana_shielded_usdcx";
  amount_micro_usdc: number;
  status: string;
  deposit_instructions?: Record<string, unknown>;
};

type ConsumerBalanceResult = {
  balance: { available_micro_usdc: number; reserved_micro_usdc: number };
};

type WithdrawalResult = {
  withdrawal_id: string;
  status: string;
  transaction_base64?: string;
  transaction_signature?: string;
};

type CrossVenueReadiness = {
  enabled: boolean;
  ready: boolean;
  execution_mode: "coordinated_byo";
  atomic: false;
  reason_codes: string[];
};

type CrossVenueExecutionResult = {
  execution: {
    execution_id: string;
    status: string;
    residual_notional_micro_usdc: number;
    hedge_deadline_at: string | null;
  };
};

const VENUES = ["phoenix", "hyperliquid", "backpack"] as const;
type VenueId = (typeof VENUES)[number];

export function TriVenueArbConsole() {
  const [status, setStatus] = useState<TriVenueStatus | null>(null);
  const [bundle, setBundle] = useState<TriVenueMarketBundle | null>(null);
  const [wallet, setWallet] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [notProhibited, setNotProhibited] = useState(false);
  const [phoenixSide, setPhoenixSide] = useState<"buy" | "sell">("buy");
  const [selectedVenue, setSelectedVenue] = useState<VenueId>("phoenix");
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [workerProbeEnabled, setWorkerProbeEnabled] = useState(false);
  const [orderUsd, setOrderUsd] = useState("5");
  const [fundingRail, setFundingRail] = useState<"solana_usdc" | "solana_shielded_usdcx">("solana_usdc");
  const [fundingUsd, setFundingUsd] = useState("5");
  const [depositIntent, setDepositIntent] = useState<DepositIntentResult | null>(null);
  const [depositEvidence, setDepositEvidence] = useState("");
  const [consumerBalance, setConsumerBalance] = useState<ConsumerBalanceResult["balance"] | null>(null);
  const [withdrawalUsd, setWithdrawalUsd] = useState("5");
  const [withdrawalStatus, setWithdrawalStatus] = useState<WithdrawalResult | null>(null);
  const [crossVenueReadiness, setCrossVenueReadiness] = useState<CrossVenueReadiness | null>(null);
  const [crossVenueExecution, setCrossVenueExecution] = useState<CrossVenueExecutionResult["execution"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const statusPath = workerProbeEnabled
      ? "/v1/private-account/arb/tri-venue/status?probe_worker=1"
      : "/v1/private-account/arb/tri-venue/status";
    async function load() {
      try {
        const [nextStatus, nextBundle, nextCrossVenue] = await Promise.all([
          fetchJson<TriVenueStatus>(statusPath),
          fetchJson<TriVenueMarketBundle>("/v1/private-account/arb/tri-venue/opportunities?market=SOL-USD&interval=1m"),
          fetchJson<CrossVenueReadiness>("/v1/private-account/cross-venue/status"),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setBundle(nextBundle);
          setCrossVenueReadiness(nextCrossVenue);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load tri-venue state.");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workerProbeEnabled]);

  useEffect(() => {
    if (!crossVenueExecution || ["both_filled", "hedged", "cancelled", "failed", "manual_intervention_required"].includes(crossVenueExecution.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchJson<CrossVenueExecutionResult>(`/v1/private-account/cross-venue/executions/${encodeURIComponent(crossVenueExecution.execution_id)}`);
        if (!cancelled) setCrossVenueExecution(next.execution);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not refresh cross-venue execution.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [crossVenueExecution]);

  const frames = useMemo(() => {
    if (!bundle) return {} as Record<VenueId, GholaMarketFrame | null>;
    return {
      phoenix: gholaFrameFromPhoenix(bundle.snapshots.phoenix),
      hyperliquid: gholaFrameFromHyperliquid(bundle.snapshots.hyperliquid),
      backpack: gholaFrameFromBackpack(bundle.snapshots.backpack),
    };
  }, [bundle]);
  const selectedFrame = frames[selectedVenue] ?? null;
  const compareFrames = VENUES
    .filter((venue) => venue !== selectedVenue)
    .map((venue) => frames[venue])
    .filter(Boolean) as GholaMarketFrame[];
  const quotes = bundle?.quotes ?? [];
  const opportunities = bundle?.opportunities ?? [];
  const bestOpportunity = opportunities.find((item) => item.status === "preflight_pass") ?? opportunities[0] ?? null;
  const ready = status?.can_live_submit === true;
  const phoenixQuote = quotes.find((quote) => quote.venue_id === "phoenix") ?? null;
  const phoenixLimit = phoenixTinyFillLimit(phoenixQuote, phoenixSide);
  const workerStandby = status?.worker_readiness.endpoint_configured === true && status?.worker_readiness.status !== "ready";
  const workerReady = status?.worker_readiness.status === "ready";
  const workerOnline = workerReady || workerStandby;
  const liveQuoteCount = quotes.filter((quote) => quote.status === "live").length;
  const marketLive = status?.public_market_data_enabled === true || liveQuoteCount > 0;
  const phoenixGate = status?.gates.find((gate) => gate.id === "phoenix");
  const hyperliquidGate = status?.gates.find((gate) => gate.id === "hyperliquid");
  const backpackGate = status?.gates.find((gate) => gate.id === "backpack");
  const phoenixConfigured = phoenixGate
    ? phoenixGate.status === "green" || phoenixGate.reason_codes.every((reason) => reason === "worker_probe_not_requested")
    : workerOnline;
  const venueCredentialGateCount = [hyperliquidGate, backpackGate].filter((gate) => gate?.status === "red").length;
  const launchTone = ready ? "good" : marketLive && (workerOnline || phoenixConfigured) ? "accent" : "warn";
  const launchTitle = ready
    ? "Tri-venue consumer live enabled"
    : phoenixConfigured
      ? "Live scanner plus Phoenix path online"
      : "Live scanner online; execution fail-closed";
  const launchBadge = ready
    ? "end-to-end enabled"
    : phoenixConfigured
      ? "public live path"
      : "credential gated";
  const launchCopy = ready
    ? "The agent can sign, arm, submit bounded consumer orders, start maker quotes, and kill resting orders under the consumer's prepaid balance and risk policy."
    : "Ghola is reading live Phoenix, Hyperliquid, and Backpack books, building arb and market-maker plans, and keeping multi-venue submit fail-closed until real venue credentials are sealed into the worker.";
  const acknowledgementsReady = acceptedTerms && acceptedRisk && notProhibited;
  const canSign = Boolean(wallet && acknowledgementsReady);
  const phoenixCanSubmit = canSign && phoenixConfigured && Boolean(phoenixLimit);
  const gateReasons = status?.gates.flatMap((gate) => gate.reason_codes.map((reason) => `${gate.id}:${reason}`)) ?? [];

  async function connectWallet() {
    setWorking("wallet");
    setError(null);
    try {
      const provider = solanaProvider();
      if (!provider?.connect) throw new Error("Open this page with a Solana wallet installed.");
      const connected = await provider.connect();
      const pubkey = publicKeyString((connected as { publicKey?: unknown })?.publicKey || provider.publicKey);
      if (!pubkey) throw new Error("No Solana public key was returned.");
      setWallet(pubkey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setWorking(null);
    }
  }

  async function wakeWorker() {
    setWorking("wake");
    setError(null);
    try {
      await postJson("/v1/private-account/public-live/phoenix/wake", { venue_id: "tri_venue_sol" });
      setWorkerProbeEnabled(true);
      setStatus(await fetchJson<TriVenueStatus>("/v1/private-account/arb/tri-venue/status?probe_worker=1"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the secure worker.");
    } finally {
      setWorking(null);
    }
  }

  async function runLive(action: "arm" | "run" | "market-maker/start" | "kill") {
    if (!canSign) {
      setError("Connect a wallet and accept the live execution checks.");
      return;
    }
    if (action !== "kill" && !ready) {
      setError(`Tri-venue live is not green: ${gateReasons.slice(0, 4).map(formatReason).join(", ") || "gate unavailable"}.`);
      return;
    }
    setWorking(action);
    setError(null);
    try {
      const proof = await signFreshChallenge(wallet);
      const path = `/v1/private-account/arb/tri-venue/${action}`;
      const response = await postJson<TriVenueLiveResult>(path, {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
        jurisdiction_assertion: "self_attested_eligible",
        market: "SOL-USD",
        max_leg_notional_usd: "5",
        selected_opportunity_commitment: bestOpportunity?.commitment ?? null,
      });
      setResult(response);
      if (response.error) setError(response.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live command failed.");
    } finally {
      setWorking(null);
    }
  }

  async function runPhoenixTinyFill() {
    if (!canSign) {
      setError("Connect a wallet and accept the live execution checks.");
      return;
    }
    if (!phoenixLimit || !phoenixQuote) {
      setError("Phoenix live quote is not ready.");
      return;
    }
    setWorking("phoenix-submit");
    setError(null);
    try {
      const notionalMicroUsdc = usdToMicro(orderUsd);
      await postJson("/v1/private-account/public-live/phoenix/wake", { reason: "arb_phoenix_tiny_fill" });
      const accessProof = await signFreshPublicLiveChallenge(wallet);
      await postJson("/v1/private-account/consumer/access", {
        ...accessProof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
      });
      await requestJson("/v1/private-account/risk-policy", "PUT", {
        max_order_micro_usdc: notionalMicroUsdc,
        max_daily_notional_micro_usdc: notionalMicroUsdc * 3,
        max_position_micro_usdc: notionalMicroUsdc * 5,
        max_slippage_bps: 25,
        market_allowlist: ["SOL-PERP"],
      });
      const proof = await signFreshPublicLiveChallenge(wallet);
      const workOrderCommitment = publicLivePhoenixWorkOrderCommitment();
      const order = phoenixTinyFillOrder({
        side: phoenixSide,
        limitPrice: phoenixLimit,
        quoteSize: orderUsd,
      });
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: wallet,
        previewCommitment: "",
        workOrderCommitment,
        order,
        signBytes: async (bytes) => walletSignBytes(requiredSolanaProvider(), bytes),
      });
      const response = await postJson<PhoenixLiveResult>("/v1/private-account/public-live/phoenix/submit", {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
        jurisdiction_assertion: "self_attested_eligible",
        utilization_bucket: orderUsd,
        ack_live_order: true,
        work_order_commitment: workOrderCommitment,
        declared_notional_micro_usdc: notionalMicroUsdc,
        declared_max_slippage_bps: 25,
        declared_market: "SOL-PERP",
        declared_side: phoenixSide,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      setWorkerProbeEnabled(true);
      setResult(response);
      if (response.error) setError(response.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Phoenix live submit failed.");
    } finally {
      setWorking(null);
    }
  }

  async function runCrossVenueExecution() {
    if (!canSign) return setError("Connect a wallet and accept the live execution checks.");
    if (!crossVenueReadiness?.ready) return setError(`Cross-venue execution is gated: ${crossVenueReadiness?.reason_codes.map(formatReason).join(", ") || "not configured"}.`);
    if (!bestOpportunity || bestOpportunity.status !== "preflight_pass" || !bestOpportunity.leg_plan) {
      return setError("No fresh cross-venue opportunity currently passes the edge and market-data checks.");
    }
    setWorking("cross-venue-submit");
    setError(null);
    try {
      const notional = usdToMicro(orderUsd);
      const proof = await signFreshChallenge(wallet);
      const response = await postIdempotentJson<CrossVenueExecutionResult>(
        "/v1/private-account/cross-venue/executions",
        `cross:${crypto.randomUUID()}`,
        {
          ...proof,
          opportunity_commitment: bestOpportunity.commitment,
          matched_notional_micro_usdc: notional,
          risk_budget: {
            max_unhedged_notional_micro_usdc: notional,
            max_hedge_slippage_bps: 25,
            max_hedge_duration_ms: 5_000,
            max_unwind_loss_micro_usdc: Math.min(notional, 250_000),
            max_daily_loss_micro_usdc: notional,
          },
        },
      );
      setCrossVenueExecution(response.execution);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cross-venue execution failed.");
    } finally {
      setWorking(null);
    }
  }

  async function cancelCrossVenueExecution() {
    if (!crossVenueExecution) return;
    setWorking("cross-venue-cancel");
    setError(null);
    try {
      const response = await postJson<CrossVenueExecutionResult>(
        `/v1/private-account/cross-venue/executions/${encodeURIComponent(crossVenueExecution.execution_id)}/cancel`,
        {},
      );
      setCrossVenueExecution(response.execution);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel and unwind the cross-venue execution.");
    } finally {
      setWorking(null);
    }
  }

  async function createFundingIntent() {
    if (!canSign) return setError("Connect a wallet and accept the consumer terms before funding.");
    setWorking("deposit-intent");
    setError(null);
    try {
      const proof = await signFreshPublicLiveChallenge(wallet);
      await postJson("/v1/private-account/consumer/access", {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
      });
      const intent = await postJson<DepositIntentResult>("/v1/private-account/balance/deposit-intents", {
        rail: fundingRail,
        amount_micro_usdc: usdToMicro(fundingUsd),
      });
      setDepositIntent(intent);
      setDepositEvidence("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a deposit intent.");
    } finally {
      setWorking(null);
    }
  }

  async function confirmFundingIntent() {
    if (!depositIntent) return setError("Create a deposit intent first.");
    if (depositIntent.rail === "solana_shielded_usdcx" && !depositEvidence.trim()) return setError("Enter the shielded receipt ID.");
    setWorking("deposit-confirm");
    setError(null);
    try {
      let evidence = depositEvidence.trim();
      if (depositIntent.rail === "solana_usdc" && !evidence) {
        const provider = requiredSolanaProvider();
        if (!provider.signAndSendTransaction) throw new Error("Your Solana wallet must support sign-and-send transactions.");
        const prepared = await postJson<{ transaction_base64: string }>(`/v1/private-account/balance/deposit-intents/${encodeURIComponent(depositIntent.deposit_intent_id)}/prepare`, {});
        const transaction = Transaction.from(base64ToBytes(prepared.transaction_base64));
        const sent = await provider.signAndSendTransaction(transaction);
        evidence = typeof sent === "string" ? sent : sent?.signature || "";
        if (!evidence) throw new Error("The wallet did not return a Solana transaction signature.");
        setDepositEvidence(evidence);
      }
      const confirmationBody = depositIntent.rail === "solana_usdc"
        ? { transaction_signature: evidence }
        : { receipt_id: evidence };
      let confirmed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await postJson(`/v1/private-account/balance/deposit-intents/${encodeURIComponent(depositIntent.deposit_intent_id)}/confirm`, confirmationBody);
          confirmed = true;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (depositIntent.rail !== "solana_usdc" || !message.includes("solana_deposit_not_finalized") || attempt === 19) throw err;
          await delay(2_000);
        }
      }
      if (!confirmed) throw new Error("Deposit did not finalize in time; retry confirmation with the same signature.");
      setDepositIntent({ ...depositIntent, status: "confirmed" });
      const balance = await fetchJson<ConsumerBalanceResult>("/v1/private-account/balance/ledger");
      setConsumerBalance(balance.balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit confirmation failed.");
    } finally {
      setWorking(null);
    }
  }

  async function withdrawPublicUsdc() {
    if (!canSign) return setError("Connect the bound wallet and accept the consumer terms before withdrawing.");
    const provider = requiredSolanaProvider();
    if (!provider.signTransaction) return setError("Your Solana wallet must support transaction signing.");
    setWorking("withdraw");
    setError(null);
    let queuedWithdrawalId = "";
    let broadcastAttempted = false;
    try {
      const proof = await signFreshWithdrawalChallenge(wallet, "create");
      const queued = await postJson<WithdrawalResult>("/v1/private-account/balance/withdrawals", {
        ...proof,
        amount_micro_usdc: usdToMicro(withdrawalUsd),
      });
      queuedWithdrawalId = queued.withdrawal_id;
      setWithdrawalStatus(queued);
      const prepared = await postJson<WithdrawalResult>(`/v1/private-account/balance/withdrawals/${encodeURIComponent(queued.withdrawal_id)}/prepare`, {});
      if (!prepared.transaction_base64) throw new Error("Withdrawal transaction was not prepared.");
      const partial = Transaction.from(base64ToBytes(prepared.transaction_base64));
      const signed = await provider.signTransaction(partial);
      const signedBytes = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
      broadcastAttempted = true;
      const submitted = await postJson<WithdrawalResult>(`/v1/private-account/balance/withdrawals/${encodeURIComponent(queued.withdrawal_id)}/submit`, {
        transaction_base64: bytesToBase64(signedBytes),
      });
      setWithdrawalStatus(submitted);
      const balance = await fetchJson<ConsumerBalanceResult>("/v1/private-account/balance/ledger");
      setConsumerBalance(balance.balance);
    } catch (err) {
      if (queuedWithdrawalId && !broadcastAttempted) {
        try {
          const proof = await signFreshWithdrawalChallenge(wallet, "cancel", queuedWithdrawalId);
          const cancelled = await postJson<WithdrawalResult>(`/v1/private-account/balance/withdrawals/${encodeURIComponent(queuedWithdrawalId)}/cancel`, proof);
          setWithdrawalStatus(cancelled);
        } catch {
          // Funds remain held in a visible prepared withdrawal; never guess that
          // an ambiguous cancellation succeeded.
        }
      }
      setError(err instanceof Error ? err.message : "Withdrawal failed.");
    } finally {
      setWorking(null);
    }
  }

  async function cancelWithdrawal() {
    if (!withdrawalStatus || !["queued", "prepared"].includes(withdrawalStatus.status)) return;
    setWorking("withdraw-cancel");
    setError(null);
    try {
      const proof = await signFreshWithdrawalChallenge(wallet, "cancel", withdrawalStatus.withdrawal_id);
      const cancelled = await postJson<WithdrawalResult>(`/v1/private-account/balance/withdrawals/${encodeURIComponent(withdrawalStatus.withdrawal_id)}/cancel`, proof);
      setWithdrawalStatus(cancelled);
      const balance = await fetchJson<ConsumerBalanceResult>("/v1/private-account/balance/ledger");
      setConsumerBalance(balance.balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal cancellation failed.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070b] pt-14 text-[#edf2f8]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-4 border-b border-[#172033] pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-[#91a2bc]">
              <Radar className="h-4 w-4 text-[#8bd3ff]" />
              <span>Cross-venue live agent</span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">
              Ghola Live Agent
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#aebbd0]">
              Live SOL markets feed an attested worker that turns captured intent into bounded arb plans, market-maker quotes, and a capped Phoenix execution path.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[680px] lg:grid-cols-4">
            <StatusPill label="Market" value={marketLive ? `${liveQuoteCount || 3} live feeds` : "loading"} tone={marketLive ? "good" : "warn"} />
            <StatusPill label="Worker" value={workerReady ? "ready" : workerStandby ? "on demand" : "not started"} tone={workerReady ? "good" : workerStandby ? "accent" : "muted"} />
            <StatusPill label="Phoenix" value={phoenixConfigured ? "live path" : "checking"} tone={phoenixConfigured ? "good" : "warn"} />
            <StatusPill label="Wallet" value={wallet ? short(wallet) : "not connected"} tone={wallet ? "good" : "muted"} />
          </div>
        </header>

        <section className={railClass(launchTone)}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <span className={iconClass(launchTone)}>
                {ready ? <CheckCircle2 className="h-4 w-4" /> : phoenixConfigured ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-white">
                    {launchTitle}
                  </h2>
                  <span className={badgeClass(launchTone)}>
                    {launchBadge}
                  </span>
                </div>
                <p className="mt-1 max-w-4xl text-sm leading-6 text-[#aebbd0]">
                  {launchCopy}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/trade"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-emerald-300/30 bg-emerald-300/10 px-4 text-sm font-medium text-emerald-50 transition hover:bg-emerald-300/15"
              >
                <ArrowRight className="h-4 w-4" />
                Open live trade
              </Link>
              <button
                type="button"
                onClick={() => void wakeWorker()}
                disabled={working !== null}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-sky-300/30 bg-sky-300/10 px-4 text-sm font-medium text-sky-50 transition hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                {working === "wake" ? "Starting worker" : "Start worker"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <GateMetric label="Market data" value={marketLive ? "live" : "loading"} tone={marketLive ? "good" : "warn"} />
            <GateMetric label="Phoenix path" value={phoenixConfigured ? "available" : "checking"} tone={phoenixConfigured ? "good" : "warn"} />
            <GateMetric label="Worker" value={workerReady ? "attested" : workerStandby ? "standby" : "sleeping"} tone={workerReady ? "good" : workerStandby ? "accent" : "warn"} />
            <GateMetric label="Multi-venue" value={ready ? "submit live" : `${venueCredentialGateCount || 2} gates`} tone={ready ? "good" : "warn"} />
            <GateMetric label="Risk policy" value="user capped" tone="good" />
          </div>

          {!ready && gateReasons.length > 0 && (
            <details className="mt-4 border-t border-amber-300/20 pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm text-amber-100">
                <span className="inline-flex items-center gap-2">
                  <LockKeyhole className="h-4 w-4" />
                  Operator credential gates
                </span>
                <span className="font-mono text-xs text-amber-100/80">{gateReasons.length} open</span>
              </summary>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {gateReasons.slice(0, 12).map((reason) => (
                  <span key={reason} className="rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-xs text-amber-100">
                    {formatReason(reason)}
                  </span>
                ))}
              </div>
            </details>
          )}

          {status?.gate_commitment && (
            <p className="mt-3 truncate font-mono text-[11px] text-[#7f90aa]">
              gate {status.gate_commitment}
              {status.checked_at ? ` · checked ${new Date(status.checked_at).toLocaleTimeString()}` : ""}
            </p>
          )}
        </section>

        <section className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#172033] bg-[#08090d] shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
            <div className="grid gap-4 border-b border-[#172033] bg-[#0b111b] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">Live venue canvas</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {VENUES.map((venue) => (
                    <button
                      key={venue}
                      type="button"
                      onClick={() => setSelectedVenue(venue)}
                      className={venue === selectedVenue ? tabClass("active") : tabClass("idle")}
                    >
                      {venueLabel(venue)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["candles", "line", "depth", "compare"] as GholaChartMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setChartMode(mode)}
                    className={mode === chartMode ? smallTabClass("active") : smallTabClass("idle")}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <GholaMarketChart
              frame={selectedFrame}
              compareFrames={compareFrames}
              mode={chartMode}
              onModeChange={setChartMode}
              size="large"
              height={520}
              label={`${venueLabel(selectedVenue)} SOL`}
            />
          </div>

          <aside className="grid gap-5">
            <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Crosshair className="h-4 w-4 text-[#8bd3ff]" />
                    Agent plan
                  </div>
                  <p className="mt-1 text-sm text-[#9fb1ca]">Delta-neutral arb first; maker quotes stay post-only and capped.</p>
                </div>
                <span className="rounded border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100">
                  prepaid
                </span>
              </div>

              <div className="mt-4 grid gap-2">
                <PlanRow label="Market" value="SOL-USD" />
                <PlanRow label="Venues" value="Phoenix + Hype + Backpack" />
                <PlanRow label="Live submit" value={ready ? "tri-venue enabled" : "Phoenix path; multi-venue gated"} />
                <PlanRow label="Phoenix ticket" value={`${phoenixSide} $${orderUsd}${phoenixLimit ? ` @ ${phoenixLimit}` : ""}`} />
                <PlanRow label="Edge filter" value="25 bps net" />
                <PlanRow label="Hedge state" value="zero net SOL target" />
                <PlanRow label="Maker loop" value="2 orders, 10s TTL" />
              </div>
            </section>

            <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Wallet className="h-4 w-4 text-[#8bd3ff]" />
                  Live signer
                </div>
                <button
                  type="button"
                  onClick={() => void connectWallet()}
                  disabled={working === "wallet"}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[#2a3a55] bg-[#111827] px-3 text-sm font-medium text-white transition hover:border-[#3b5174] hover:bg-[#151f31] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Wallet className="h-4 w-4" />
                  {wallet ? "Connected" : "Connect"}
                </button>
              </div>

              <div className="mt-4 grid gap-2">
                <CheckRow checked={acceptedTerms} onChange={setAcceptedTerms} label="I accept Ghola consumer terms for real-money execution." />
                <CheckRow checked={acceptedRisk} onChange={setAcceptedRisk} label="I understand this can submit real orders through supported venues." />
                <CheckRow checked={notProhibited} onChange={setNotProhibited} label="I self-attest that I am legally allowed to use this feature." />
              </div>

              <div className="mt-4 rounded-md border border-cyan-300/20 bg-cyan-300/5 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Coordinated BYO execution</div>
                    <p className="mt-1 text-xs leading-5 text-[#8ea1bf]">Two opposite IOC legs across user-owned venue accounts. Ghola measures any unmatched fill and automatically hedges or unwinds inside the displayed risk budget.</p>
                  </div>
                  <span className={crossVenueReadiness?.ready ? badgeClass("good") : badgeClass("warn")}>
                    {crossVenueReadiness?.ready ? "ready" : "gated"}
                  </span>
                </div>
                <div className="mt-3 grid gap-2">
                  <PlanRow label="Execution" value="coordinated, non-atomic" />
                  <PlanRow label="Temporary exposure" value={`up to $${orderUsd}`} />
                  <PlanRow label="Hedge window" value="5 seconds" />
                  <PlanRow label="Hedge slippage" value="25 bps max" />
                  <PlanRow label="Daily loss stop" value={`$${orderUsd}`} />
                </div>
                <button
                  type="button"
                  onClick={() => void runCrossVenueExecution()}
                  disabled={!canSign || !crossVenueReadiness?.ready || bestOpportunity?.status !== "preflight_pass" || working !== null}
                  className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-300/12 px-3 text-sm font-medium text-cyan-50 transition hover:bg-cyan-300/18 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Crosshair className="h-4 w-4" />
                  {working === "cross-venue-submit" ? "Coordinating both legs" : `Execute matched $${orderUsd}`}
                </button>
                {crossVenueExecution && (
                  <p className="mt-2 break-all font-mono text-[11px] text-cyan-100">
                    {crossVenueExecution.status} · residual ${(crossVenueExecution.residual_notional_micro_usdc / 1_000_000).toFixed(2)} · {crossVenueExecution.execution_id}
                  </p>
                )}
                {crossVenueExecution && !["both_filled", "hedged", "cancelled", "failed", "manual_intervention_required"].includes(crossVenueExecution.status) && (
                  <button type="button" onClick={() => void cancelCrossVenueExecution()} disabled={working !== null} className="mt-2 h-9 w-full rounded-md border border-rose-300/25 bg-rose-300/10 text-xs text-rose-50 disabled:opacity-45">
                    {working === "cross-venue-cancel" ? "Cancelling and unwinding" : "Cancel / unwind both legs"}
                  </button>
                )}
                {!crossVenueReadiness?.ready && (
                  <p className="mt-2 text-[11px] leading-5 text-amber-100">{crossVenueReadiness?.reason_codes.map(formatReason).join(" · ") || "Checking the execution worker."}</p>
                )}
              </div>

              <div className="mt-4 rounded-md border border-emerald-300/20 bg-emerald-300/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-white">Phoenix prepaid perpetual order</div>
                    <div className="mt-1 font-mono text-xs text-[#8ea1bf]">
                      {phoenixLimit ? `$${orderUsd} ${phoenixSide} IOC @ ${phoenixLimit}` : "waiting for Phoenix quote"}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setPhoenixSide("buy")}
                      className={phoenixSide === "buy" ? sideButtonClass("active") : sideButtonClass("idle")}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      onClick={() => setPhoenixSide("sell")}
                      disabled
                      title="Pooled sells remain disabled until the asset-position subledger is enabled."
                      className={phoenixSide === "sell" ? sideButtonClass("active") : sideButtonClass("idle")}
                    >
                      Sell
                    </button>
                  </div>
                </div>
                <label className="mt-3 block text-xs text-[#9fb1ca]">
                  Order notional (USDC)
                  <input value={orderUsd} onChange={(event) => setOrderUsd(event.target.value)} inputMode="decimal" className="mt-1 h-10 w-full rounded-md border border-[#24324a] bg-[#070a10] px-3 font-mono text-sm text-white" />
                </label>
                <button
                  type="button"
                  onClick={() => void runPhoenixTinyFill()}
                  disabled={!phoenixCanSubmit || working !== null}
                  className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-emerald-300/30 bg-emerald-300/12 px-3 text-sm font-medium text-emerald-50 transition hover:bg-emerald-300/18 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Send className="h-4 w-4" />
                  {working === "phoenix-submit" ? "Submitting Phoenix" : `Submit Phoenix $${orderUsd}`}
                </button>
              </div>

              <div className="mt-4 rounded-md border border-sky-300/20 bg-sky-300/5 p-3">
                <div className="text-sm font-semibold text-white">Prepaid consumer balance</div>
                <p className="mt-1 text-xs leading-5 text-[#8ea1bf]">Create a single-use deposit intent, transfer from the bound wallet, then confirm finalized public USDC or the shielded receipt. Rails never fall back into one another.</p>
                {consumerBalance && <p className="mt-2 font-mono text-xs text-sky-100">available ${(consumerBalance.available_micro_usdc / 1_000_000).toFixed(2)} · reserved ${(consumerBalance.reserved_micro_usdc / 1_000_000).toFixed(2)}</p>}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <select value={fundingRail} onChange={(event) => setFundingRail(event.target.value as typeof fundingRail)} className="h-10 rounded-md border border-[#24324a] bg-[#070a10] px-2 text-sm text-white">
                    <option value="solana_usdc">Public USDC</option>
                    <option value="solana_shielded_usdcx">Shielded USDCx</option>
                  </select>
                  <input value={fundingUsd} onChange={(event) => setFundingUsd(event.target.value)} inputMode="decimal" aria-label="Deposit amount in USDC" className="h-10 rounded-md border border-[#24324a] bg-[#070a10] px-3 font-mono text-sm text-white" />
                </div>
                <button type="button" onClick={() => void createFundingIntent()} disabled={!canSign || working !== null} className="mt-2 h-10 w-full rounded-md border border-sky-300/30 bg-sky-300/10 text-sm text-sky-50 disabled:opacity-45">
                  {working === "deposit-intent" ? "Creating intent" : "Create deposit intent"}
                </button>
                {depositIntent && (
                  <div className="mt-3 border-t border-sky-300/15 pt-3">
                    <p className="break-all font-mono text-[11px] text-[#8ea1bf]">intent {depositIntent.deposit_intent_id} · {depositIntent.status}</p>
                    <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] text-[#9fb1ca]">{JSON.stringify(depositIntent.deposit_instructions ?? {}, null, 2)}</pre>
                    <input value={depositEvidence} onChange={(event) => setDepositEvidence(event.target.value)} placeholder={depositIntent.rail === "solana_usdc" ? "Optional existing transaction signature" : "Shielded receipt ID"} className="mt-2 h-10 w-full rounded-md border border-[#24324a] bg-[#070a10] px-3 font-mono text-xs text-white" />
                    <button type="button" onClick={() => void confirmFundingIntent()} disabled={working !== null || depositIntent.status === "confirmed"} className="mt-2 h-10 w-full rounded-md border border-emerald-300/30 bg-emerald-300/10 text-sm text-emerald-50 disabled:opacity-45">
                      {working === "deposit-confirm" ? "Signing / verifying finality" : depositIntent.rail === "solana_usdc" && !depositEvidence ? "Sign and deposit USDC" : "Confirm deposit"}
                    </button>
                  </div>
                )}
                <div className="mt-3 border-t border-sky-300/15 pt-3">
                  <p className="text-xs leading-5 text-[#8ea1bf]">Withdraw unreserved USDC to this same bound wallet. Your wallet co-signs and pays the Solana network fee; Ghola cannot redirect the transfer.</p>
                  <input value={withdrawalUsd} onChange={(event) => setWithdrawalUsd(event.target.value)} inputMode="decimal" aria-label="Withdrawal amount in USDC" className="mt-2 h-10 w-full rounded-md border border-[#24324a] bg-[#070a10] px-3 font-mono text-sm text-white" />
                  <button type="button" onClick={() => void withdrawPublicUsdc()} disabled={!canSign || working !== null} className="mt-2 h-10 w-full rounded-md border border-violet-300/30 bg-violet-300/10 text-sm text-violet-50 disabled:opacity-45">
                    {working === "withdraw" ? "Signing withdrawal" : "Withdraw USDC"}
                  </button>
                  {withdrawalStatus && <p className="mt-2 break-all font-mono text-[11px] text-[#aebbd0]">{withdrawalStatus.status} · {withdrawalStatus.transaction_signature || withdrawalStatus.withdrawal_id}</p>}
                  {withdrawalStatus && ["queued", "prepared"].includes(withdrawalStatus.status) && (
                    <button type="button" onClick={() => void cancelWithdrawal()} disabled={working !== null} className="mt-2 h-9 w-full rounded-md border border-rose-300/25 bg-rose-300/10 text-xs text-rose-50 disabled:opacity-45">
                      {working === "withdraw-cancel" ? "Cancelling" : "Cancel and release balance"}
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <ActionButton icon={<KeyRound className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("arm")}>
                  {working === "arm" ? "Arming" : "Arm tiny live"}
                </ActionButton>
                <ActionButton icon={<Send className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("run")}>
                  {working === "run" ? "Running" : "Run one arb"}
                </ActionButton>
                <ActionButton icon={<Activity className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("market-maker/start")}>
                  {working === "market-maker/start" ? "Starting" : "Start maker"}
                </ActionButton>
                <ActionButton icon={<Square className="h-4 w-4" />} disabled={!canSign || working !== null} onClick={() => void runLive("kill")}>
                  {working === "kill" ? "Stopping" : "Kill orders"}
                </ActionButton>
              </div>

              {(error || result) && (
                <div className="mt-4 rounded-md border border-[#24324a] bg-[#070a10] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">Live result</div>
                  <p className={error ? "mt-2 text-sm text-amber-100" : "mt-2 text-sm text-emerald-100"}>
                    {error ?? liveResultMessage(result)}
                  </p>
                  {liveResultCommitment(result) && (
                    <p className="mt-2 truncate font-mono text-xs text-[#8ea1bf]">{liveResultCommitment(result)}</p>
                  )}
                </div>
              )}
            </section>
          </aside>
        </section>

        <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.65fr)]">
          <VenueMatrix quotes={quotes} />
          <OpportunityRail opportunities={opportunities} />
        </section>
      </div>
    </main>
  );
}

function VenueMatrix({ quotes }: { quotes: TriVenueQuote[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-[#172033] bg-[#090d14] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Venue matrix</h2>
        <span className="font-mono text-xs text-[#8ea1bf]">SOL only</span>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        {quotes.map((quote) => (
          <article key={quote.venue_id} className="min-w-0 rounded-md border border-[#1a2639] bg-[#070a10] p-4">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">{quote.label}</h3>
                <p className="mt-1 font-mono text-xs text-[#7f90aa]">{quote.venue_symbol}</p>
              </div>
              <span className={quote.status === "live" ? badgeClass("good") : badgeClass("warn")}>{quote.status}</span>
            </div>
            <div className="mt-4 grid min-w-0 grid-cols-2 gap-2">
              <Metric label="Bid" value={quote.best_bid ?? "n/a"} tone="good" />
              <Metric label="Ask" value={quote.best_ask ?? "n/a"} tone="bad" />
              <Metric label="Spread" value={quote.spread_bps === null ? "n/a" : `${quote.spread_bps} bps`} />
              <Metric label="Funding" value={quote.funding_rate ?? "n/a"} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function OpportunityRail({ opportunities }: { opportunities: TriVenueOpportunity[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-[#172033] bg-[#090d14] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Opportunity rail</h2>
        <span className="font-mono text-xs text-[#8ea1bf]">{opportunities.length} plans</span>
      </div>
      <div className="grid gap-3">
        {opportunities.length === 0 && (
          <div className="rounded-md border border-[#1a2639] bg-[#070a10] p-4 text-sm text-[#9fb1ca]">
            Waiting for live venue data.
          </div>
        )}
        {opportunities.slice(0, 5).map((item) => (
          <article key={item.commitment} className="min-w-0 rounded-md border border-[#1a2639] bg-[#070a10] p-4">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={item.status === "preflight_pass" ? badgeClass("good") : item.strategy === "market_making" ? badgeClass("accent") : badgeClass("warn")}>
                    {item.strategy === "market_making" ? "maker" : "delta-neutral"}
                  </span>
                  <span className="font-mono text-sm text-white">{item.net_edge_bps} bps net</span>
                </div>
                <p className="mt-2 text-sm text-[#9fb1ca]">
                  {item.strategy === "market_making" && item.quote_plan
                    ? `Post ${item.quote_plan.symbol} quotes on ${venueLabel(item.quote_plan.venue_id)} for 10s.`
                    : `${venueLabel(item.buy_venue)} buy / ${venueLabel(item.sell_venue)} sell under $5 cap.`}
                </p>
              </div>
              <span className={item.status === "preflight_pass" ? "text-xs text-emerald-100" : "text-xs text-amber-100"}>
                {item.status.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-3 truncate font-mono text-[11px] text-[#7f90aa]">{item.commitment}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-12 items-center gap-3 rounded-md border border-[#172033] bg-[#070a10] px-3 py-2 text-sm text-[#c4cedf]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 accent-[#8bd3ff]"
      />
      <span>{label}</span>
    </label>
  );
}

function ActionButton({
  children,
  disabled,
  icon,
  onClick,
}: {
  children: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[#2a3a55] bg-[#111827] px-3 text-sm font-medium text-white transition hover:border-[#3b5174] hover:bg-[#151f31] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      {children}
    </button>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "accent" | "muted" }) {
  return (
    <div className="rounded-md border border-[#1b2940] bg-[#090d14] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={toneText(tone)}>{value}</div>
    </div>
  );
}

function GateMetric({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "accent" }) {
  return (
    <div className="rounded-md border border-[#1a2639] bg-[#060910] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={toneText(tone)}>{value}</div>
    </div>
  );
}

function Metric({ label, value, tone = "muted" }: { label: string; value: string; tone?: "good" | "bad" | "muted" }) {
  const color = tone === "good" ? "text-emerald-100" : tone === "bad" ? "text-rose-100" : "text-white";
  return (
    <div className="rounded border border-[#172033] bg-[#05070b] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={`mt-1 truncate font-mono text-sm ${color}`}>{value}</div>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-[#172033] bg-[#070a10] px-3 py-2">
      <span className="text-sm text-[#91a2bc]">{label}</span>
      <span className="text-right font-mono text-sm text-white">{value}</span>
    </div>
  );
}

async function signFreshChallenge(wallet: string) {
  const challenge = await fetchJson<Challenge>(`/v1/private-account/arb/tri-venue/challenge?wallet_pubkey=${encodeURIComponent(wallet)}`);
  const provider = solanaProvider();
  if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
  const signature = await walletSignBytes(provider, new TextEncoder().encode(challenge.message));
  return {
    wallet_pubkey: wallet,
    message: challenge.message,
    signature_b64: bytesToBase64(signature),
  };
}

async function signFreshPublicLiveChallenge(wallet: string) {
  const challenge = await fetchJson<Challenge>(`/v1/private-account/public-live/phoenix/challenge?wallet_pubkey=${encodeURIComponent(wallet)}`);
  const signature = await walletSignBytes(requiredSolanaProvider(), new TextEncoder().encode(challenge.message));
  return {
    wallet_pubkey: wallet,
    message: challenge.message,
    signature_b64: bytesToBase64(signature),
  };
}

async function signFreshWithdrawalChallenge(wallet: string, action: "create" | "cancel", withdrawalId?: string) {
  const params = new URLSearchParams({ action });
  if (withdrawalId) params.set("withdrawal_id", withdrawalId);
  const challenge = await fetchJson<Challenge>(`/v1/private-account/balance/withdrawals/challenge?${params.toString()}`);
  const signature = await walletSignBytes(requiredSolanaProvider(), new TextEncoder().encode(challenge.message));
  return { message: challenge.message, signature_b64: bytesToBase64(signature) };
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(body) ?? `${res.status} ${res.statusText}`);
  return body as T;
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  return requestJson(path, "POST", body);
}

async function postIdempotentJson<T>(path: string, idempotencyKey: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(responseBody) ?? `${res.status} ${res.statusText}`);
  return responseBody as T;
}

async function requestJson<T = unknown>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(responseBody) ?? `${res.status} ${res.statusText}`);
  return responseBody as T;
}

function errorMessage(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { error?: unknown }).error === "string"
    ? String((value as { error: string }).error)
    : null;
}

function usdToMicro(value: string): number {
  const dollars = Number(value);
  const micro = Math.round(dollars * 1_000_000);
  if (!Number.isFinite(dollars) || dollars < 1 || !Number.isSafeInteger(micro)) throw new Error("Amount must be at least 1 USDC.");
  return micro;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function venueLabel(venue?: string) {
  if (venue === "phoenix") return "Phoenix";
  if (venue === "hyperliquid") return "Hyperliquid";
  if (venue === "backpack") return "Backpack";
  return "venue";
}

function formatReason(value: string) {
  return value.replace(/_/g, " ").replace(/:/g, " · ");
}

function phoenixTinyFillLimit(quote: TriVenueQuote | null, side: "buy" | "sell"): string | null {
  if (!quote || quote.status !== "live") return null;
  const raw = side === "buy" ? quote.best_ask : quote.best_bid;
  const price = numericPrice(raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const guarded = side === "buy" ? price * 1.0025 : price * 0.9975;
  return formatPhoenixPrice(guarded);
}

function numericPrice(value: string | null): number {
  if (!value) return Number.NaN;
  return Number(value.replace(/,/g, ""));
}

function formatPhoenixPrice(value: number): string {
  if (value >= 1000) return value.toFixed(1);
  if (value >= 100) return value.toFixed(2);
  return value.toFixed(3);
}

function phoenixTinyFillOrder({
  side,
  limitPrice,
  quoteSize,
}: {
  side: "buy" | "sell";
  limitPrice: string;
  quoteSize: string;
}): PrivateExecutionOrderDraft {
  return {
    venue_id: "phoenix",
    operation_class: "perp_limit_order",
    market: "SOL-PERP",
    side,
    base_size: "",
    quote_size: quoteSize,
    limit_price: limitPrice,
    max_slippage_bps: "25",
    live_order_mode: "tiny_fill",
    order_type: "limit",
    size_mode: "quote",
    tif: "Ioc",
    agent_strategy_profile: "venue_route_edge",
    agent_entry_trigger: "preview_now",
    agent_exit_rule: "manual_approval",
    agent_time_horizon: "scalp",
    agent_route_priority: "most_private",
    agent_strategy_note: "Phoenix prepaid consumer perpetual order from the Ghola live console.",
  };
}

function publicLivePhoenixWorkOrderCommitment() {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `public_live_phoenix_work_order_${randomPart}`;
}

function sideButtonClass(state: "active" | "idle") {
  return state === "active"
    ? "h-9 rounded-md border border-emerald-300/40 bg-emerald-300/18 px-3 text-sm font-medium text-emerald-50"
    : "h-9 rounded-md border border-[#24324a] bg-[#070a10] px-3 text-sm font-medium text-[#91a2bc] transition hover:text-white";
}

function liveResultMessage(result: LiveResult | null): string {
  if (!result) return "Command accepted.";
  if (isPhoenixLiveResult(result)) {
    if (result.status === "submitted") return "Phoenix order submitted and pending reconciliation.";
    return `Phoenix ${String(result.status || "accepted").replace(/_/g, " ")}.`;
  }
  return result.session?.next_step || result.session?.status || "Command accepted.";
}

function liveResultCommitment(result: LiveResult | null): string | null {
  if (!result) return null;
  if (isPhoenixLiveResult(result)) {
    return result.work_order_commitment || result.allocation_commitment || null;
  }
  return result.session?.autopilot_session_id || result.session?.worker_session_commitment || null;
}

function isPhoenixLiveResult(result: LiveResult): result is PhoenixLiveResult {
  return "work_order_commitment" in result || ("venue_id" in result && result.venue_id === "phoenix");
}

function short(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function railClass(tone: "good" | "warn" | "accent") {
  const toneClass = tone === "good"
    ? "border-emerald-300/30 bg-emerald-300/10"
    : tone === "accent"
      ? "border-sky-300/25 bg-sky-300/10"
      : "border-amber-300/25 bg-amber-300/10";
  return `rounded-lg border p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)] ${toneClass}`;
}

function iconClass(tone: "good" | "warn" | "accent") {
  const toneClass = tone === "good"
    ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
    : tone === "accent"
      ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
      : "border-amber-300/30 bg-amber-300/10 text-amber-100";
  return `mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${toneClass}`;
}

function badgeClass(tone: "good" | "warn" | "accent") {
  if (tone === "good") return "rounded border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100";
  if (tone === "accent") return "rounded border border-sky-300/20 bg-sky-300/10 px-2 py-1 text-xs font-medium text-sky-100";
  return "rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-xs font-medium text-amber-100";
}

function tabClass(state: "active" | "idle") {
  return state === "active"
    ? "rounded-md border border-sky-300/40 bg-sky-300/15 px-3 py-2 text-sm font-medium text-white"
    : "rounded-md border border-[#24324a] bg-[#070a10] px-3 py-2 text-sm font-medium text-[#91a2bc] transition hover:text-white";
}

function smallTabClass(state: "active" | "idle") {
  return state === "active"
    ? "rounded-md border border-[#9fcfff] bg-[#b7dcff] px-3 py-2 text-sm font-medium text-[#07111c]"
    : "rounded-md border border-[#24324a] bg-[#070a10] px-3 py-2 text-sm font-medium text-[#91a2bc] transition hover:text-white";
}

function toneText(tone: "good" | "warn" | "accent" | "muted") {
  if (tone === "good") return "mt-1 truncate font-mono text-sm text-emerald-100";
  if (tone === "warn") return "mt-1 truncate font-mono text-sm text-amber-100";
  if (tone === "accent") return "mt-1 truncate font-mono text-sm text-sky-100";
  return "mt-1 truncate font-mono text-sm text-[#c4cedf]";
}
