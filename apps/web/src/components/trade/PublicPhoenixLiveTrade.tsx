"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LogIn,
  LockKeyhole,
  Power,
  Send,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  buildPrivateExecutionInstructionBundle,
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import type { PhoenixCandleInterval, PhoenixMarketSnapshot } from "@/lib/phoenix-market-data";
import type { PhoenixLiveMarketStatus } from "@/lib/phoenix-live-market";
import { useMarketData } from "@/lib/market-data-store";
import { formatPhoenixPrice } from "@/lib/phoenix-chart-helpers";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { PhoenixLiveTerminal } from "@/components/private-account/PhoenixLiveTerminal";

type LiveStep = "idle" | "connected" | "prepared" | "submitted";

type SolanaProvider = {
  connect?: () => Promise<{ publicKey?: unknown } | unknown>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<Uint8Array | { signature?: Uint8Array | number[]; publicKey?: unknown }>;
  publicKey?: unknown;
  isPhantom?: boolean;
};

type TradeWindow = Window & {
  solana?: SolanaProvider;
};

type PublicLiveChallenge = {
  wallet_pubkey: string;
  message: string;
};

type PublicLivePrepareResult = {
  status: string;
  account_commitment?: string;
  submit_path?: string;
  balance?: {
    available_micro_usdc?: number;
    available_usd?: string;
    withdrawable_micro_usdc?: number;
    withdrawable_usd?: string;
  } | null;
  required_margin_micro_usdc?: number;
  can_submit_live?: boolean;
  blocking_reason_codes?: string[];
  allocation?: {
    pooled_allocation?: {
      pooled_allocation_commitment?: string;
      status?: string;
    };
  };
  agent?: {
    agent_session_commitment?: string;
    session_policy?: {
      policy_commitment?: string;
    };
  };
  live_limits?: {
    max_notional_bucket?: string;
    max_order_count?: number;
    allowed_markets?: string[];
  };
};

type PublicLiveSubmitResult = {
  status: string;
  work_order_commitment?: string;
  balance_reservation_commitment?: string | null;
  balance_order_commitment?: string | null;
  next_status?: string;
  worker_receipt?: {
    status?: string;
    result_commitment?: string;
    provider_ref_commitment?: string;
    visibility_summary?: Record<string, unknown>;
  };
  live_access?: {
    allocation_commitment?: string;
    policy_commitment?: string;
  };
};

type PublicLiveWakeResult = {
  status: "ready" | "waking" | "blocked";
  ready: boolean;
  lease_ms?: number;
  provisioning?: {
    status?: string;
    reason?: string | null;
    cvm_name?: string | null;
  };
  provider?: {
    available?: boolean;
    attested?: boolean;
    supports_trading_execution?: boolean;
    cvm_status?: string | null;
  };
};

type LiveTradingStatus = {
  status: "green" | "red";
  live_trading_enabled: boolean;
  live_submit_mode: "disabled" | "byo_mainnet" | "byo_testnet" | "pooled_account" | "pooled_and_byo";
  fresh_user_live_ready?: boolean;
  no_key_live_trading_enabled?: boolean;
  no_key_requires_auth?: boolean;
  no_key_requires_allowlist?: boolean;
  no_key_requires_balance?: boolean;
  no_key_blocking_reason_codes?: string[];
  phoenix_public_live_ready?: boolean;
  byo_live_trading_enabled: boolean;
  pooled_live_trading_enabled: boolean;
  pooled_live_venues?: string[];
  public_market_data_enabled?: boolean;
  gate_commitment?: string;
  checked_at?: string;
  pooled_worker_readiness?: {
    status: "ready" | "blocked" | "unavailable";
    ready: boolean;
    endpoint_configured: boolean;
    reason_codes: string[];
    checked_at: string;
  };
  required_venues?: Array<{
    id: "hyperliquid" | "phoenix" | "backpack" | "jupiter" | "coinbase";
    label: string;
    status: "green" | "red";
    canary_status?: "green" | "missing" | "red" | "stale";
    canary_reason_codes?: string[];
    capital_free_proof_status?: "green" | "missing" | "red" | "stale";
    capital_free_proof_reason_codes?: string[];
    reason_codes: string[];
  }>;
  byo_live_venues?: Array<{
    id: "hyperliquid" | "phoenix" | "backpack" | "jupiter" | "coinbase";
    label: string;
    status: "green" | "red";
    reason_codes: string[];
  }>;
  pooled_reason_codes?: string[];
  pooled_unavailable_reason_codes?: string[];
  reason_codes?: string[];
  execution_display?: {
    mode: "needs_setup" | "preview" | "live_capped" | "waiting" | "paused" | "stopped";
    label: string;
    detail: string;
    can_trade: boolean;
    next_action_label: string;
    plain_reason: string | null;
    limits: {
      venues: string[];
      markets: string[];
      max_order_usd: string | null;
      daily_cap_usd: string | null;
      slippage_bps: number | null;
    };
    debug_reason_codes: string[];
  };
};

const DEFAULT_PRICE = "";
const DEFAULT_QUOTE_SIZE = "5";
const SURFACE_RAISED = "border border-[#24324a] bg-[linear-gradient(180deg,#111722_0%,#090e16_58%,#06090f_100%)] shadow-[0_24px_70px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.055),inset_0_-1px_0_rgba(0,0,0,0.42)]";
const SURFACE_SUNKEN = "border border-[#172033] bg-[linear-gradient(180deg,#070b12_0%,#04070c_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.035),inset_0_12px_28px_rgba(0,0,0,0.24)]";
const CHIP_RAISED = "border border-[#293852] bg-[linear-gradient(180deg,#121a27,#080d15)] shadow-[0_7px_16px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.055),inset_0_-1px_0_rgba(0,0,0,0.38)]";

export function PublicPhoenixLiveTrade() {
  const auth = useThumperAuth();
  const [step, setStep] = useState<LiveStep>("idle");
  const [wallet, setWallet] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [limitPrice, setLimitPrice] = useState(DEFAULT_PRICE);
  const [limitPriceTouched, setLimitPriceTouched] = useState(false);
  const [quoteSize, setQuoteSize] = useState(DEFAULT_QUOTE_SIZE);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [notProhibited, setNotProhibited] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PublicLivePrepareResult | null>(null);
  const [submitted, setSubmitted] = useState<PublicLiveSubmitResult | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveTradingStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [phoenixInterval, setPhoenixInterval] = useState<PhoenixCandleInterval>("1m");
  const submitInFlight = useRef(false);
  const phoenixRecord = useMarketData({ venue: "phoenix", network: "mainnet", symbol: "SOL", interval: phoenixInterval });
  const phoenixMarket = phoenixRecord.snapshot?.platform === "phoenix" ? phoenixRecord.snapshot : null;
  const phoenixMarketStatus = phoenixRecord.status as PhoenixLiveMarketStatus;

  const order = useMemo<PrivateExecutionOrderDraft>(() => ({
    venue_id: "phoenix",
    operation_class: "perp_limit_order",
    market: "SOL-PERP",
    side,
    base_size: "",
    quote_size: quoteSize,
    limit_price: limitPrice,
    max_slippage_bps: "50",
    live_order_mode: "tiny_fill",
    order_type: "market",
    size_mode: "quote",
    tif: "Ioc",
    agent_strategy_profile: "momentum_continuation",
    agent_entry_trigger: "preview_now",
    agent_exit_rule: "manual_approval",
    agent_time_horizon: "scalp",
    agent_route_priority: "most_private",
  }), [limitPrice, quoteSize, side]);
  const orderErrors = validatePrivateExecutionOrderDraft(order);
  const phoenixGate = liveStatus?.required_venues?.find((venue) => venue.id === "phoenix") || null;
  const phoenixPooledReady =
    liveStatus?.phoenix_public_live_ready === true ||
    (
      liveStatus?.no_key_live_trading_enabled !== false &&
      liveStatus?.pooled_live_trading_enabled === true &&
      phoenixGate?.status === "green" &&
      liveStatus?.pooled_live_venues?.includes("phoenix") === true
    );
  const liveGateChecked = Boolean(liveStatus || statusError);
  const liveGateReasons = publicLiveGateReasons(liveStatus, phoenixGate, statusError);
  const workerAsleep = !phoenixPooledReady && liveGateReasons.includes("pooled_worker_probe_failed");
  const phoenixWorkerValue = phoenixPooledReady ? "ready" : workerAsleep ? "standby" : liveStatus?.pooled_worker_readiness?.status === "ready" ? "ready" : "preparing";
  const authRequired = liveStatus?.no_key_requires_auth !== false;
  const authReady = !authRequired || auth.authenticated;
  const balanceRequired = liveStatus?.no_key_requires_balance === true;
  const balanceReady = balanceRequired
    ? prepared?.can_submit_live === true
    : prepared?.can_submit_live !== false;
  const canAct = Boolean(wallet && authReady && acceptedTerms && acceptedRisk && notProhibited && phoenixPooledReady);
  const acknowledgementsReady = acceptedTerms && acceptedRisk && notProhibited;
  const preparedReady = prepared?.status === "live_ready" && prepared.can_submit_live !== false;
  const submittedReady = submitted?.status === "submitted";
  const tradePreviewCommitment =
    prepared?.agent?.session_policy?.policy_commitment ||
    prepared?.allocation?.pooled_allocation?.pooled_allocation_commitment ||
    null;
  const primaryActionLabel = !wallet
    ? "Connect wallet first"
    : !authReady
      ? "Sign in required"
    : !acknowledgementsReady
      ? "Accept signer checks"
      : !balanceReady
        ? "Add Ghola balance"
      : !phoenixPooledReady
        ? workerAsleep
          ? "Start worker to enable"
          : "Setup pending"
        : "Ready to sign";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const status = await fetchJson<LiveTradingStatus>("/v1/private-account/live-trading/status");
        if (!cancelled) {
          setLiveStatus(status);
          setStatusError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLiveStatus(null);
          setStatusError(err instanceof Error ? err.message : "Could not load live trading status.");
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (limitPriceTouched) return;
    const currentPrice = currentPhoenixPriceInput(phoenixMarket);
    if (currentPrice) setLimitPrice(currentPrice);
  }, [limitPriceTouched, phoenixMarket]);

  useEffect(() => {
    if (!showReview) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && working !== "submit") setShowReview(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showReview, working]);

  function syncOrderFromTerminal(nextOrder: PrivateExecutionOrderDraft) {
    setSubmitted(null);
    setPrepared(null);
    setSide(nextOrder.side === "sell" ? "sell" : "buy");
    setLimitPriceTouched(true);
    setLimitPrice(nextOrder.limit_price || currentPhoenixPriceInput(phoenixMarket) || DEFAULT_PRICE);
    setQuoteSize(nextOrder.quote_size || quoteSize || DEFAULT_QUOTE_SIZE);
  }

  function editTrade(patch: { side?: "buy" | "sell"; limitPrice?: string }) {
    setPrepared(null);
    setSubmitted(null);
    setShowReview(false);
    if (patch.side) setSide(patch.side);
    if (patch.limitPrice !== undefined) {
      setLimitPriceTouched(true);
      setLimitPrice(patch.limitPrice);
    }
  }

  async function connectWallet() {
    setWorking("wallet");
    setError(null);
    try {
      const provider = solanaProvider();
      if (!provider?.connect) throw new Error("Open this page with a Solana wallet installed.");
      const connected = await provider.connect();
      const pubkey = publicKeyString((connected as { publicKey?: unknown })?.publicKey || provider.publicKey);
      if (!pubkey) throw new Error("No Solana public key was returned.");
      if (wallet && wallet !== pubkey) {
        setPrepared(null);
        setSubmitted(null);
        setShowReview(false);
      }
      setWallet(pubkey);
      setStep("connected");
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
      const result = await postJson<PublicLiveWakeResult>("/v1/private-account/public-live/phoenix/wake", {
        venue_id: "phoenix",
      });
      const status = await fetchJson<LiveTradingStatus>("/v1/private-account/live-trading/status");
      setLiveStatus(status);
      setStatusError(null);
      const phoenix = status.required_venues?.find((venue) => venue.id === "phoenix") || null;
      const ready = status.pooled_live_trading_enabled === true &&
        phoenix?.status === "green" &&
        status.pooled_live_venues?.includes("phoenix") === true;
      if (!ready) {
        setError(result.provisioning?.reason || "Secure worker is starting. Refresh readiness in a moment.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the secure worker.");
    } finally {
      setWorking(null);
    }
  }

  async function prepareAccess() {
    if (!phoenixPooledReady) {
      setError("Live Capped Phoenix is still being prepared. Try again when readiness is complete.");
      return null;
    }
    if (!canAct) {
      setError("Connect a wallet and accept the live trading acknowledgements.");
      return null;
    }
    setWorking("prepare");
    setLimitPriceTouched(true);
    setError(null);
    setSubmitted(null);
    try {
      const proof = await signFreshChallenge(wallet);
      const result = await postJson<PublicLivePrepareResult>("/v1/private-account/public-live/phoenix/prepare", {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
        jurisdiction_assertion: "self_attested_eligible",
        utilization_bucket: "5",
      });
      setPrepared(result);
      setStep("prepared");
      if (result.status === "live_ready" && result.can_submit_live !== false) {
        setShowReview(true);
      }
      if (result.can_submit_live === false && result.blocking_reason_codes?.length) {
        setError("Live Capped Phoenix is still being prepared. Review the technical details if needed.");
      }
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare Phoenix live access.");
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function submitTinyFill() {
    if (submitInFlight.current) return;
    if (!phoenixPooledReady) {
      setError("Live Capped Phoenix is still being prepared. Try again when readiness is complete.");
      return;
    }
    const validation = validatePrivateExecutionOrderDraft(order);
    if (validation[0]) {
      setError(validation[0]);
      return;
    }
    if (!canAct) {
      setError("Connect a wallet and accept the live trading acknowledgements.");
      return;
    }
    submitInFlight.current = true;
    setWorking("submit");
    setError(null);
    try {
      const access = prepared?.status === "live_ready" ? prepared : await prepareAccess();
      if (!access || access.status !== "live_ready") throw new Error("Phoenix live access is not ready.");
      if (access.can_submit_live === false) {
        throw new Error("Live Capped Phoenix is not ready to submit yet.");
      }
      const workOrderCommitment = `public_live_phoenix_${crypto.randomUUID()}`;
      const provider = solanaProvider();
      if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: wallet,
        previewCommitment: "",
        workOrderCommitment,
        order,
        signBytes: async (bytes) => walletSignBytes(provider, bytes),
      });
      const proof = await signFreshChallenge(wallet);
      const result = await postJson<PublicLiveSubmitResult>("/v1/private-account/public-live/phoenix/submit", {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
        jurisdiction_assertion: "self_attested_eligible",
        utilization_bucket: "5",
        ack_live_order: true,
        work_order_commitment: workOrderCommitment,
        order_summary: {
          venue_id: "phoenix",
          market: "SOL-PERP",
          notional_bucket: "5",
          side,
          work_order_commitment: workOrderCommitment,
        },
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      setSubmitted(result);
      setStep("submitted");
      setShowReview(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Phoenix order was not submitted. Try again when readiness is complete.");
    } finally {
      submitInFlight.current = false;
      setWorking(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070b] pt-14 font-sans text-[#edf2f8]">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-4 border-b border-[#172033] pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-[#91a2bc]">
              <Activity className="h-4 w-4 text-[#8bd3ff]" />
              <span>Simple live trading</span>
            </div>
            <h1 className="mt-2 text-3xl font-medium tracking-tight text-white sm:text-4xl">
              Trade SOL in a few clear steps
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#aebbd0]">
              Choose a side, review the exact $5 capped order, then approve it with your wallet.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {!auth.authenticated && (
                <Link
                  href="/signin?redirect=/trade"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] transition hover:bg-white"
                >
                  <LogIn className="h-4 w-4" />
                  Sign in
                </Link>
              )}
              <Link
                href="/account?flow=private-mode"
                className="inline-flex h-10 items-center justify-center rounded-md border border-[#2a3a55] bg-[#0b111b] px-4 text-sm font-medium text-[#cbd5e1] transition hover:border-[#3b5174] hover:text-white"
              >
                Add Ghola balance
              </Link>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[520px]">
            <StatusPill
              label="Account"
              value={auth.loading ? "checking" : auth.authenticated ? "signed in" : "sign in"}
              tone={auth.authenticated ? "good" : "muted"}
            />
            <StatusPill
              label="Execution"
              value={phoenixPooledReady ? "Live Capped" : workerAsleep ? "standby" : liveGateChecked ? "preparing" : "checking"}
              tone={phoenixPooledReady ? "good" : workerAsleep ? "accent" : "muted"}
            />
            <StatusPill
              label="Receipt"
              value={submittedReady ? "submitted" : step === "prepared" ? "armed" : "pending"}
              tone={submittedReady || step === "prepared" ? "good" : "muted"}
            />
          </div>
        </header>

        <section className={`relative overflow-hidden rounded-lg p-4 sm:p-5 ${SURFACE_RAISED}`}>
          <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[#7cf5c6]/40 to-transparent" />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(124,245,198,0.18),rgba(7,16,13,0.92))] text-emerald-100 shadow-[0_10px_24px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <LockKeyhole className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">
                    Live Capped agent
                  </p>
                  <h2 className="text-lg font-medium tracking-tight text-white">
                    {phoenixPooledReady ? "SOL-PERP is ready" : "Getting secure execution ready"}
                  </h2>
                </div>
                <span className={phoenixPooledReady
                  ? "rounded-md border border-emerald-300/25 bg-[linear-gradient(145deg,rgba(124,245,198,0.16),rgba(7,16,13,0.88))] px-2.5 py-1 text-xs font-medium text-emerald-100 shadow-[0_8px_18px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]"
                  : `rounded-md px-2.5 py-1 text-xs font-medium text-[#aebbd0] ${CHIP_RAISED}`
                }>
                  {phoenixPooledReady ? "Ready" : "Preparing"}
                </span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[#aebbd0]">
                {phoenixPooledReady
                  ? "Set your direction and price. Ghola checks the order before your wallet approves anything."
                  : "You can explore the live market now. Trading unlocks automatically when the secure worker is ready."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
                <span className={`rounded-md px-2.5 py-1 text-[#cbd7e8] ${CHIP_RAISED}`}>SOL-PERP</span>
                <span className={`rounded-md px-2.5 py-1 text-[#cbd7e8] ${CHIP_RAISED}`}>${quoteSize} order</span>
                <span className={`rounded-md px-2.5 py-1 text-[#cbd7e8] ${CHIP_RAISED}`}>50 bps max slippage</span>
                <span className={`rounded-md px-2.5 py-1 text-[#cbd7e8] ${CHIP_RAISED}`}>Pause anytime</span>
              </div>
            </div>

            {workerAsleep ? (
              <button
                type="button"
                onClick={() => void wakeWorker()}
                disabled={working !== null}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-sky-300/30 bg-sky-300/10 px-4 text-sm font-medium text-sky-50 transition hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                {working === "wake" ? "Starting" : "Start agent"}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <span className={`rounded-md px-3 py-2 text-sm font-medium text-white ${CHIP_RAISED}`}>
                  {primaryActionLabel}
                </span>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#1d2a40] bg-[#080c13] shadow-[0_22px_70px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.035)]">
            <PhoenixLiveTerminal
              symbol="SOL"
              interval={phoenixInterval}
              snapshot={phoenixMarket}
              marketStatus={phoenixMarketStatus}
              order={order}
              previewCommitment={tradePreviewCommitment}
              working={working !== null}
              onIntervalChange={setPhoenixInterval}
              onOrderChange={syncOrderFromTerminal}
              onPreview={() => {
                document.getElementById("public-live-signer")?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              }}
            />
          </div>
        </section>

        <section id="public-live-signer" className="scroll-mt-24 grid gap-5 xl:grid-cols-[minmax(0,1.36fr)_minmax(360px,0.64fr)]">
          <div className="grid gap-5">
            <section className="overflow-hidden rounded-lg border border-[#1d2a40] bg-[#090d14] shadow-[0_18px_58px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.035)]">
              <div className="border-b border-[#172033] bg-[linear-gradient(180deg,#0d1420,#090d14)] px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-medium tracking-tight text-white">SOL-PERP live ticket</h2>
                      <span className="rounded border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100">
                        Fixed $5 safety cap
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-[#9fb1ca]">
                      No order is sent until you review the final details and approve with your wallet.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void connectWallet()}
                    disabled={working === "wallet"}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-[#2a3a55] bg-[#111827] px-4 text-sm font-medium text-white transition hover:border-[#3b5174] hover:bg-[#151f31] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Wallet className="h-4 w-4" />
                    {wallet ? "Wallet connected" : working === "wallet" ? "Connecting" : "Connect wallet"}
                  </button>
                </div>
              </div>

              <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.55fr)]">
                <div className="grid gap-4">
                  <div className={`grid gap-3 rounded-md p-4 sm:grid-cols-3 ${SURFACE_SUNKEN}`}>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">Market</div>
                      <div className="mt-2 font-mono text-lg text-white">SOL-PERP</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">Side</div>
                      <div className={side === "buy" ? "mt-2 font-mono text-lg text-emerald-200" : "mt-2 font-mono text-lg text-rose-200"}>
                        {side.toUpperCase()}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">Max notional</div>
                      <div className="mt-2 font-mono text-lg text-white">${quoteSize || DEFAULT_QUOTE_SIZE}</div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)]">
                    <label className="grid gap-2 text-sm">
                      <span className="text-[#9fb1ca]">Side</span>
                      <div className="grid h-11 grid-cols-2 overflow-hidden rounded-md border border-[#223047] bg-[#05070b] p-1">
                        <button
                          type="button"
                          aria-pressed={side === "buy"}
                          onClick={() => editTrade({ side: "buy" })}
                          className={side === "buy" ? "rounded bg-emerald-300/15 text-emerald-100" : "rounded text-[#8ea0ba] hover:bg-[#111827] hover:text-white"}
                        >
                          Buy
                        </button>
                        <button
                          type="button"
                          aria-pressed={side === "sell"}
                          onClick={() => editTrade({ side: "sell" })}
                          className={side === "sell" ? "rounded bg-rose-300/15 text-rose-100" : "rounded text-[#8ea0ba] hover:bg-[#111827] hover:text-white"}
                        >
                          Sell
                        </button>
                      </div>
                    </label>
                    <label className="grid gap-2 text-sm">
                      <span className="text-[#9fb1ca]">Limit price</span>
                      <input
                        value={limitPrice}
                        onChange={(event) => {
                          editTrade({ limitPrice: event.target.value });
                        }}
                        inputMode="decimal"
                        className="h-11 rounded-md border border-[#223047] bg-[#05070b] px-3 font-mono text-white outline-none transition focus:border-[#6ea8ff]"
                      />
                    </label>
                    <label className="grid gap-2 text-sm">
                      <span className="text-[#9fb1ca]">Order size</span>
                      <input
                        value={quoteSize}
                        readOnly
                        aria-readonly="true"
                        inputMode="decimal"
                        className="h-11 rounded-md border border-[#223047] bg-[#080c13] px-3 font-mono text-[#cbd7e8] outline-none"
                      />
                    </label>
                  </div>

                  <Ack
                    checked={acknowledgementsReady}
                    onChange={(checked) => {
                      setAcceptedTerms(checked);
                      setAcceptedRisk(checked);
                      setNotProhibited(checked);
                    }}
                    label="I accept the beta terms, understand this is a real $5 trade, and confirm I am eligible to use Phoenix."
                  />

                  {orderErrors[0] && (
                    <Alert tone="warn">{orderErrors[0]}</Alert>
                  )}
                  {error && (
                    <Alert tone="danger">{error}</Alert>
                  )}
                </div>

                <div className={`grid content-start gap-3 rounded-md p-4 ${SURFACE_SUNKEN}`}>
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">Agent instruction</div>
                    <p className="mt-2 text-sm leading-6 text-[#cbd7e8]">
                      Ghola sends one immediate-or-cancel limit order. Any unfilled portion is cancelled automatically.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <ReadinessRow label="Wallet proof" ready={Boolean(wallet)} value={wallet ? short(wallet) : "required"} />
                    <ReadinessRow label="Ghola account" ready={authReady} value={auth.loading ? "checking" : authReady ? "signed in" : "required"} />
                    <ReadinessRow label="Trade confirmation" ready={acknowledgementsReady} value={acknowledgementsReady ? "accepted" : "required"} />
                    <ReadinessRow
                      label="Balance cap"
                      ready={balanceReady}
                      value={prepared?.balance?.available_usd ? `$${prepared.balance.available_usd}` : liveStatus?.no_key_requires_balance ? "$5 required" : "not required"}
                    />
                    <ReadinessRow label="Phoenix worker" ready={phoenixPooledReady} value={phoenixWorkerValue} />
                    <ReadinessRow label="Live access" ready={preparedReady} value={preparedReady ? "prepared" : "not prepared"} />
                  </div>
                  <div className="mt-2 grid gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (preparedReady) {
                          setShowReview(true);
                          return;
                        }
                        void prepareAccess();
                      }}
                      disabled={!canAct || working !== null}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[#eaf2ff] px-4 text-sm font-semibold text-[#07101d] transition hover:bg-white disabled:cursor-not-allowed disabled:bg-[#263241] disabled:text-[#8ea0ba]"
                    >
                      <KeyRound className="h-4 w-4" />
                      {working === "prepare"
                        ? "Checking your trade"
                        : preparedReady
                          ? `Review ${side === "buy" ? "buy" : "sell"} order`
                          : `Review $${quoteSize} ${side === "buy" ? "buy" : "sell"}`}
                    </button>
                    {preparedReady && (
                      <button
                        type="button"
                        onClick={() => setShowReview(true)}
                        disabled={working !== null}
                        className="inline-flex h-10 items-center justify-center text-sm font-medium text-[#a8d8ff] hover:text-white disabled:opacity-50"
                      >
                        Open final review
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <aside className="grid content-start gap-4">
            <Panel title="Trade status" icon={<CheckCircle2 className="h-4 w-4" />}>
              <Metric label="Order" value={submitted ? "sent to secure worker" : preparedReady ? "ready for approval" : "not sent"} />
              <Metric label="Next" value={submitted ? "awaiting reconciliation" : "review and approve"} />
              <Metric label="Reservation" value={submitted?.balance_reservation_commitment ? short(submitted.balance_reservation_commitment) : "none"} />
              <Metric
                label="Work order"
                value={submitted?.work_order_commitment ? short(submitted.work_order_commitment) : "none"}
              />
              <Metric
                label="Worker result"
                value={submitted?.worker_receipt?.result_commitment ? short(submitted.worker_receipt.result_commitment) : "none"}
              />
              <Metric
                label="Provider ref"
                value={submitted?.worker_receipt?.provider_ref_commitment ? short(submitted.worker_receipt.provider_ref_commitment) : "none"}
              />
            </Panel>
          </aside>
        </section>
      </div>
      {showReview && (
        <TradeReviewDialog
          side={side}
          quoteSize={quoteSize}
          limitPrice={limitPrice}
          working={working === "submit"}
          onClose={() => setShowReview(false)}
          onConfirm={() => void submitTinyFill()}
        />
      )}
    </main>
  );
}

type SignalTone = "good" | "warn" | "muted" | "accent";

function TradeReviewDialog({
  side,
  quoteSize,
  limitPrice,
  working,
  onClose,
  onConfirm,
}: {
  side: "buy" | "sell";
  quoteSize: string;
  limitPrice: string;
  working: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const notional = Number(quoteSize);
  const price = Number(limitPrice);
  const estimatedQuantity =
    Number.isFinite(notional) && Number.isFinite(price) && price > 0
      ? notional / price
      : null;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-end bg-black/75 p-0 backdrop-blur-sm sm:place-items-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-review-title"
        className="w-full overflow-hidden rounded-t-2xl border border-[#2a3952] bg-[#090e16] shadow-2xl sm:max-w-lg sm:rounded-xl"
      >
        <div className="border-b border-[#1d2a40] px-5 py-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#7cf5c6]">
            Final review
          </p>
          <h2 id="trade-review-title" className="mt-1 text-2xl font-semibold text-white">
            {side === "buy" ? "Buy" : "Sell"} SOL-PERP
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#9fb1ca]">
            Check the order once. Your wallet approval is the final step.
          </p>
        </div>
        <div className="grid gap-4 p-5">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#223047] bg-[#223047]">
            <ReviewValue label="Order size" value={`$${quoteSize}`} />
            <ReviewValue label="Limit price" value={`$${limitPrice}`} />
            <ReviewValue
              label="Estimated SOL"
              value={estimatedQuantity == null ? "—" : estimatedQuantity.toFixed(6)}
            />
            <ReviewValue label="Unfilled amount" value="Cancelled" />
          </div>
          <div className="rounded-lg border border-[#263852] bg-[#0d1521] p-4 text-sm leading-6 text-[#c6d4e7]">
            Ghola will send one IOC limit order with a 50 bps slippage ceiling.
            Phoenix cannot withdraw funds, and the worker cannot exceed this $5 instruction.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={onClose}
              disabled={working}
              className="h-12 rounded-md border border-[#2a3952] bg-[#111827] text-sm font-semibold text-[#d8e2f1] hover:border-[#405473] disabled:opacity-50"
            >
              Go back
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={working}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#7cf5c6] text-sm font-bold text-[#04110d] hover:bg-[#9affda] disabled:cursor-wait disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
              {working ? "Sending securely" : "Approve and send"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#080c13] p-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#71829d]">{label}</div>
      <div className="mt-1 font-mono text-base text-white">{value}</div>
    </div>
  );
}

function Ack({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className={checked
      ? "flex items-start gap-3 rounded-md border border-emerald-300/25 bg-emerald-300/8 p-3 text-sm text-[#d9e7f5]"
      : "flex items-start gap-3 rounded-md border border-[#172033] bg-[#05070b] p-3 text-sm text-[#cbd7e8]"}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#7cf5c6]"
      />
      <span>{label}</span>
    </label>
  );
}

function Alert({ tone, children }: { tone: "warn" | "danger"; children: ReactNode }) {
  const classes = tone === "danger"
    ? "border-red-300/25 bg-red-400/10 text-red-100"
    : "border-amber-300/25 bg-amber-300/10 text-amber-100";
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${classes}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg p-4 ${SURFACE_RAISED}`}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium tracking-tight text-white">
        {icon}
        <span>{title}</span>
      </div>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={`flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${SURFACE_SUNKEN}`}>
      <span className="min-w-0 text-[#8ea0ba]">{label}</span>
      <span className="max-w-[190px] truncate font-medium text-[#edf2f8]" title={value}>{value}</span>
    </div>
  );
}

function ReadinessRow({ label, ready, value }: { label: string; ready: boolean; value: string }) {
  return (
    <div className={`flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${SURFACE_SUNKEN}`}>
      <span className="flex min-w-0 items-center gap-2 text-[#cbd7e8]">
        <span className={ready ? "h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(124,245,198,0.45)]" : "h-2 w-2 rounded-full bg-[#47546a]"} />
        {label}
      </span>
      <span className={ready ? "max-w-[170px] truncate text-sm font-medium text-emerald-100" : "max-w-[170px] truncate text-sm text-[#8ea0ba]"} title={formatReason(value)}>
        {formatReason(value)}
      </span>
    </div>
  );
}

function StatusPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: SignalTone;
}) {
  return (
    <div className={`min-w-0 rounded-md px-3 py-2 ${toneClass(tone)}`}>
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#7f90aa]">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value}>{value}</div>
    </div>
  );
}

function toneClass(tone: SignalTone) {
  const raised = "shadow-[0_10px_24px_rgba(0,0,0,0.26),inset_0_1px_0_rgba(255,255,255,0.05)]";
  if (tone === "good") return `border border-emerald-300/25 bg-[linear-gradient(145deg,rgba(124,245,198,0.14),rgba(7,16,13,0.9))] text-emerald-100 ${raised}`;
  if (tone === "accent") return `border border-sky-300/25 bg-[linear-gradient(145deg,rgba(56,189,248,0.14),rgba(6,14,24,0.92))] text-sky-100 ${raised}`;
  if (tone === "warn") return `border border-amber-300/25 bg-[linear-gradient(145deg,rgba(251,191,36,0.13),rgba(20,14,5,0.92))] text-amber-100 ${raised}`;
  return `${CHIP_RAISED} text-[#aebbd0]`;
}

function publicLiveGateReasons(
  status: LiveTradingStatus | null,
  phoenixGate: NonNullable<LiveTradingStatus["required_venues"]>[number] | null,
  statusError: string | null,
) {
  if (statusError) return [`status_error:${statusError}`];
  if (!status) return ["checking_live_trading_status"];
  const reasons = [
    ...(status.pooled_live_trading_enabled ? [] : ["pooled_live_trading_disabled"]),
    ...(status.pooled_worker_readiness?.reason_codes ?? []),
    ...(phoenixGate?.reason_codes ?? []),
    ...(phoenixGate?.canary_reason_codes ?? []),
    ...(phoenixGate?.capital_free_proof_reason_codes ?? []),
    ...(status.no_key_blocking_reason_codes ?? []),
    ...(status.pooled_reason_codes ?? []),
    ...(status.pooled_unavailable_reason_codes ?? []),
  ];
  return [...new Set(reasons.filter(Boolean))];
}

function formatReason(value: string) {
  return value.replaceAll("_", " ").replaceAll(":", ": ");
}

async function signFreshChallenge(walletPubkey: string) {
  const challenge = await fetchJson<PublicLiveChallenge>(
    `/v1/private-account/public-live/phoenix/challenge?wallet_pubkey=${encodeURIComponent(walletPubkey)}`,
  );
  const provider = solanaProvider();
  if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
  const signature = await walletSignBytes(provider, new TextEncoder().encode(challenge.message));
  return {
    wallet_pubkey: challenge.wallet_pubkey,
    message: challenge.message,
    signature_b64: bytesToBase64(signature),
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parsed as T;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parsed as T;
}

function currentPhoenixPriceInput(snapshot: PhoenixMarketSnapshot | null): string {
  const price = Number(snapshot?.mid ?? snapshot?.mark_price);
  return Number.isFinite(price) && price > 0 ? formatPhoenixPrice(price) : "";
}

function solanaProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  return (window as TradeWindow).solana ?? null;
}

async function walletSignBytes(provider: SolanaProvider, bytes: Uint8Array): Promise<Uint8Array> {
  const signed = await provider.signMessage?.(bytes, "utf8");
  if (!signed) throw new Error("Wallet declined message signing.");
  if (signed instanceof Uint8Array) return signed;
  if (Array.isArray(signed.signature)) return Uint8Array.from(signed.signature);
  if (signed.signature instanceof Uint8Array) return signed.signature;
  throw new Error("Wallet returned an unsupported signature.");
}

function publicKeyString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: unknown }).toBase58 === "function") {
    return String((value as { toBase58: () => string }).toBase58());
  }
  if (typeof (value as { toString?: unknown }).toString === "function") {
    const text = String((value as { toString: () => string }).toString());
    return text && text !== "[object Object]" ? text : null;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function short(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
