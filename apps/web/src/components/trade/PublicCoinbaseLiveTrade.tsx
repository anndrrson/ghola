"use client";

import Link from "next/link";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  ChevronDown,
  KeyRound,
  LogIn,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import {
  buildPrivateExecutionInstructionBundle,
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import {
  selectCoinbaseDisplayPrice,
  type CoinbaseCandleInterval,
  type CoinbaseProductId,
} from "@/lib/coinbase-market-data";
import {
  buildGholaAgentChartOverlays,
  type GholaChartMode,
} from "@/lib/ghola-market-chart";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { GholaMarketChart } from "@/components/private-account/GholaMarketChart";
import {
  formatAssetQuantity,
  formatCompactUsd,
  formatSignedPercent,
  formatUsdPrice,
} from "@/lib/market-number-format";
import {
  capabilitiesForProduct,
  type TradeProduct,
  type TradeVenueId,
} from "@/lib/trading-capabilities";
import {
  approvePrivateAccountAction,
  armHyperliquidExecutionAgent,
  createPrivateAccountIntent,
  createPrivateAccountRuntimeEnvelope,
  executePrivateAccountAction,
  getHyperliquidAccountSnapshot,
  getHyperliquidExecutionVaultStatus,
  openHyperliquidAccountStream,
  previewPrivateAccountAction,
  type HyperliquidAccountSnapshot,
  type PrivateAccountSafeInput,
} from "@/lib/private-account-client";
import { useMarketData } from "@/lib/market-data-store";
import {
  hyperliquidCredentialsSealed,
  hyperliquidPerpsReadiness,
  mergeHyperliquidAccountSnapshot,
  spotVenueReadiness,
} from "@/lib/trade-readiness";

type LiveStep = "idle" | "prepared" | "submitted";

type PublicLivePrepareResult = {
  status: string;
  account_commitment?: string;
  can_submit_live?: boolean;
  blocking_reason_codes?: string[];
  balance?: {
    available_micro_usdc?: number;
    available_usd?: string;
  } | null;
  required_margin_micro_usdc?: number;
  allocation?: {
    allocation?: {
      allocation_commitment?: string;
      status?: string;
    };
  };
  agent?: {
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
  };
  live_access?: {
    allocation_commitment?: string;
    policy_commitment?: string;
  };
};

type LiveTradingStatus = {
  status: "green" | "red";
  no_key_live_trading_enabled?: boolean;
  no_key_primary_venue?: string;
  coinbase_public_live_ready?: boolean;
  phoenix_public_live_ready?: boolean;
  no_key_blocking_reason_codes?: string[];
};

const DEFAULT_PRODUCT: CoinbaseProductId = "SOL-USD";
const DEFAULT_QUOTE_SIZE = "25";
const QUOTE_SIZE_OPTIONS = ["5", "25", "100"] as const;
const PRODUCTS: CoinbaseProductId[] = ["SOL-USD", "BTC-USD", "ETH-USD"];
const INTERVALS: CoinbaseCandleInterval[] = ["1m", "5m", "15m", "1h"];
const TRADE_PRODUCTS: Array<{ id: TradeProduct; label: string }> = [
  { id: "spot", label: "Spot" },
  { id: "perps", label: "Perps" },
  { id: "swap", label: "Swap" },
  { id: "automate", label: "Automate" },
];
const SURFACE_RAISED = "border border-[#292c33] bg-[linear-gradient(180deg,#121317_0%,#0c0d10_58%,#090a0c_100%)] shadow-[0_24px_70px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.045),inset_0_-1px_0_rgba(0,0,0,0.42)]";
const SURFACE_SUNKEN = "border border-[#24272e] bg-[linear-gradient(180deg,#090a0d_0%,#07080a_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),inset_0_12px_28px_rgba(0,0,0,0.24)]";
const LAST_TRADE_PRODUCT_KEY = "ghola:last-trade-product:v1";
const LAST_PERP_MARKET_KEY = "ghola:last-perp-market:v1";

export function PublicCoinbaseLiveTrade({
  hyperliquidNetwork,
  productEnvironment,
  hyperliquidMaxSlippageBps,
}: {
  hyperliquidNetwork: "mainnet" | "testnet";
  productEnvironment: "production" | "testnet";
  hyperliquidMaxSlippageBps: number;
}) {
  const auth = useThumperAuth();
  const searchParams = useSearchParams();
  const initialProduct = searchParams.get("product");
  const [tradeProduct, setTradeProduct] = useState<TradeProduct>(
    initialProduct === "perps" || initialProduct === "swap" || initialProduct === "automate"
      ? initialProduct
      : "spot",
  );
  const [venue, setVenue] = useState<TradeVenueId>(
    tradeProduct === "perps" ? "hyperliquid" : tradeProduct === "swap" ? "jupiter" : "coinbase_advanced",
  );
  const [step, setStep] = useState<LiveStep>("idle");
  const [product, setProduct] = useState<CoinbaseProductId>(DEFAULT_PRODUCT);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quoteSize, setQuoteSize] = useState(DEFAULT_QUOTE_SIZE);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [notProhibited, setNotProhibited] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PublicLivePrepareResult | null>(null);
  const [submitted, setSubmitted] = useState<PublicLiveSubmitResult | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveTradingStatus | null>(null);
  const [interval, setIntervalValue] = useState<CoinbaseCandleInterval>("1m");
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const [showReview, setShowReview] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const submitInFlight = useRef(false);
  const coinbaseRecord = useMarketData({ venue: "coinbase", productId: product, interval });
  const market = coinbaseRecord.snapshot?.platform === "coinbase" ? coinbaseRecord.snapshot : null;
  const marketStatus = coinbaseRecord.status;

  useEffect(() => {
    const requestedProduct = searchParams.get("product");
    const nextProduct: TradeProduct =
      requestedProduct === "perps" || requestedProduct === "swap" || requestedProduct === "automate"
        ? requestedProduct
        : requestedProduct === "spot"
          ? "spot"
      : readStoredTradeProduct() || "spot";
    if (TRADE_PRODUCTS.some((item) => item.id === nextProduct)) {
      setTradeProduct(nextProduct);
    }
    const requestedVenue = searchParams.get("venue");
    if (
      requestedVenue === "coinbase_advanced" ||
      requestedVenue === "phoenix" ||
      requestedVenue === "hyperliquid" ||
      requestedVenue === "jupiter" ||
      requestedVenue === "backpack"
    ) {
      setVenue(requestedVenue);
    }
    // Alternate workspaces own their market state. Letting SOL-USDC or BTC-PERP
    // flow into the spot state makes a tab change silently replace the user's
    // selected spot market.
    if (!requestedProduct || requestedProduct === "spot" || requestedProduct === "automate") {
      const requestedMarket = searchParams.get("market")?.toUpperCase();
      const requestedBase = requestedMarket?.split("-")[0];
      const referenceMarket = requestedBase ? `${requestedBase}-USD` : "";
      if (PRODUCTS.includes(referenceMarket as CoinbaseProductId)) {
        setProduct(referenceMarket as CoinbaseProductId);
      }
    }
  }, [searchParams]);

  const order = useMemo<PrivateExecutionOrderDraft>(() => ({
    venue_id: "coinbase_advanced",
    operation_class: "spot_market_order",
    market: product,
    side,
    base_size: "",
    quote_size: quoteSize,
    limit_price: "",
    order_type: "market",
    size_mode: "quote",
    tif: "ioc",
    agent_strategy_profile: "momentum_continuation",
    agent_entry_trigger: "preview_now",
    agent_exit_rule: "manual_approval",
    agent_time_horizon: "scalp",
    agent_route_priority: "most_private",
    protective_orders: {
      ...(stopLoss.trim() ? { stop_loss: stopLoss.trim() } : {}),
      ...(takeProfit.trim() ? { take_profit: takeProfit.trim() } : {}),
    },
  }), [product, quoteSize, side, stopLoss, takeProfit]);
  const orderErrors = validatePrivateExecutionOrderDraft(order);
  const acknowledgementsReady = acceptedTerms && acceptedRisk && notProhibited;
  const venueStatus = useMemo(() => spotVenueReadiness("coinbase", liveStatus), [liveStatus]);
  const liveReady = venueStatus.ready;
  const orderStatus = submitted?.status || (step === "prepared" ? "ready to submit" : "not started");
  const balanceReady = prepared?.can_submit_live === true;
  const canSubmit = Boolean(auth.authenticated && acknowledgementsReady && liveReady && balanceReady && orderErrors.length === 0);
  const priceSelection = selectCoinbaseDisplayPrice(market);
  const mid = priceSelection.value || "";
  const displayPrice = formatUsdPrice(mid, market?.quote_increment);
  const estimatedBase = Number(mid) > 0 ? Number(quoteSize) / Number(mid) : null;
  const baseSymbol = product.split("-")[0];
  const quoteVolume =
    market?.approximate_quote_24h_volume ||
    (
      Number.isFinite(Number(market?.volume_24h)) && Number.isFinite(Number(mid))
        ? String(Number(market?.volume_24h) * Number(mid))
        : null
    );
  const dayChange = Number(market?.price_percentage_change_24h);
  const dayChangeClass = !Number.isFinite(dayChange)
    ? "text-[#8ea0ba]"
    : dayChange >= 0 ? "text-emerald-200" : "text-rose-200";

  function changeTradeProduct(next: TradeProduct) {
    const nextVenue: TradeVenueId =
      next === "perps" ? "hyperliquid" :
      next === "swap" ? "jupiter" :
      next === "automate" ? "coinbase_advanced" :
      "coinbase_advanced";
    // Keep the current fully-rendered workspace visible while React prepares
    // the next one. URL synchronization is deliberately post-paint because
    // Next patches history and can otherwise turn a local tab click into a
    // route reconciliation on the interaction's critical path.
    startTransition(() => {
      setTradeProduct(next);
      setVenue(nextVenue);
    });
    writeStoredPreference(LAST_TRADE_PRODUCT_KEY, next);
    const retainedPerpMarket = readStoredPerpMarket() || "SOL";
    const params = new URLSearchParams(searchParams.toString());
    params.set("product", next);
    params.set("venue", nextVenue);
    params.set("market", next === "perps" ? `${retainedPerpMarket}-PERP` : next === "swap" ? "SOL-USDC" : product);
    replaceTradeUrlAfterPaint(`/trade?${params.toString()}`);
  }

  function editTrade(patch: {
    product?: CoinbaseProductId;
    side?: "buy" | "sell";
    quoteSize?: string;
  }) {
    setError(null);
    setPrepared(null);
    setSubmitted(null);
    setShowReview(false);
    setStep("idle");
    if (patch.product) setProduct(patch.product);
    if (patch.side) setSide(patch.side);
    if (patch.quoteSize) setQuoteSize(patch.quoteSize);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const status = await fetchJson<LiveTradingStatus>("/v1/private-account/live-trading/status");
        if (!cancelled) setLiveStatus(status);
      } catch {
        if (!cancelled) setLiveStatus(null);
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
    if (!showReview) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && working !== "submit") setShowReview(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showReview, working]);

  async function prepareAccess() {
    if (!auth.authenticated) {
      setError("Sign in to review and submit a real order.");
      return;
    }
    if (!acknowledgementsReady) {
      setError("Accept the trade confirmation before continuing.");
      return;
    }
    if (!liveReady) {
      setError("Coinbase execution is not ready. Market data remains available.");
      return;
    }
    setWorking("prepare");
    setError(null);
    try {
      const result = await postJson<PublicLivePrepareResult>("/v1/private-account/public-live/coinbase/prepare", acknowledgements());
      setPrepared(result);
      setSubmitted(null);
      setStep("prepared");
      if (result.can_submit_live !== false) setShowReview(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Coinbase access was not prepared.");
    } finally {
      setWorking(null);
    }
  }

  async function submitTinySpot() {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setWorking("submit");
    setError(null);
    try {
      const access = prepared || await postJson<PublicLivePrepareResult>("/v1/private-account/public-live/coinbase/prepare", acknowledgements());
      setPrepared(access);
      if (access.can_submit_live === false) throw new Error("Coinbase public live is not ready to submit yet.");
      const workOrderCommitment = `public_live_coinbase_${crypto.randomUUID()}`;
      const secret = ed25519.utils.randomPrivateKey();
      const ownerWalletAddress = bs58.encode(ed25519.getPublicKey(secret));
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress,
        previewCommitment: "",
        workOrderCommitment,
        order,
        signBytes: async (bytes) => ed25519.sign(bytes, secret),
      });
      const result = await postJson<PublicLiveSubmitResult>("/v1/private-account/public-live/coinbase/submit", {
        ...acknowledgements(),
        ack_live_order: true,
        work_order_commitment: workOrderCommitment,
        order_summary: {
          venue_id: "coinbase_advanced",
          market: product,
          notional_bucket: quoteSize,
          side,
          work_order_commitment: workOrderCommitment,
        },
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      setSubmitted(result);
      setStep("submitted");
      setShowReview(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Coinbase order was not submitted.");
    } finally {
      submitInFlight.current = false;
      setWorking(null);
    }
  }

  function acknowledgements() {
    return {
      accepted_terms: acceptedTerms,
      accepted_risk: acceptedRisk,
      not_prohibited_person: notProhibited,
      jurisdiction_assertion: "self_attested_eligible_us",
      country_code: "US",
      utilization_bucket: quoteSize,
    };
  }

  return (
    <>
    <div
      className={tradeProduct === "spot" ? "block" : "hidden"}
      aria-hidden={tradeProduct !== "spot"}
      inert={tradeProduct !== "spot"}
    >
    <main className="min-h-screen bg-[#08090b] pt-16 font-sans text-[#eceef2]">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="relative flex items-center justify-between gap-4 border-b border-[#272a31] pb-5">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[#111216] text-[#d7dbe2]">
              <Activity className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight text-white sm:text-xl">Spot trading</h1>
              <p className="truncate text-xs text-[#8fa0b9] sm:text-sm">
                {product} on Coinbase <span className="px-1 text-[#4e607a]">·</span> capped at ${quoteSize} <span className="hidden px-1 text-[#4e607a] sm:inline">·</span> <span className="hidden sm:inline">no withdrawal access</span>
              </p>
            </div>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <CommandStatus
              label="Account"
              value={auth.loading ? "checking" : auth.authenticated ? "signed in" : "sign in"}
              ready={auth.authenticated}
            />
            <CommandStatus label="Venue" value={venueStatus.label} ready={venueStatus.ready} />
            <CommandStatus
              label="Order"
              value={orderStatus}
              ready={Boolean(submitted)}
            />
            <Link
              href="/account?flow=private-mode"
              className="inline-flex h-9 items-center justify-center rounded-md border border-[#2a3a55] bg-[#0b111b] px-3 text-xs font-medium text-[#cbd5e1] transition hover:border-[#4d6891] hover:text-white"
            >
              Add balance
            </Link>
          </div>
          {!auth.authenticated && (
            <Link
              href="/signin?redirect=/trade"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-[#eef1f8] px-4 text-sm font-semibold text-[#08090d] transition hover:bg-white md:hidden"
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Link>
          )}
        </header>

        <WorkspaceProductNav value={tradeProduct} onChange={changeTradeProduct} />

        <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 overflow-hidden rounded-xl border border-[#292c33] bg-[#0b0c0f] p-4 shadow-[0_22px_70px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.03)] sm:p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium tracking-tight text-[#eef1f8]">Coinbase · {product}</h3>
                <p className="mt-1 text-xs leading-5 text-[#8b95a8]">Public spot market data with private capped execution.</p>
              </div>
              <span className={marketStatus === "live" || marketStatus === "fallback_polling" ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {formatStatus(marketStatus, Boolean(market))}
              </span>
            </div>

            <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <Segmented label="Product" value={product} options={PRODUCTS} onChange={(value) => editTrade({ product: value as CoinbaseProductId })} />
              <Segmented label="Interval" value={interval} options={INTERVALS} onChange={(value) => setIntervalValue(value as CoinbaseCandleInterval)} align="right" />
            </div>

            <div className="mb-3 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className={`self-start rounded-md p-4 ${SURFACE_SUNKEN}`}>
                <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)] lg:items-end">
                  <div>
                    <p className="text-xs font-medium text-[#7f90aa]">{product} spot</p>
                    <p className="mt-1 font-mono text-4xl font-semibold tracking-[-0.04em] text-[#eef1f8] tabular-nums">
                      {mid ? displayPrice : "—"}
                    </p>
                    <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5">
                      <span className={priceSelection.stale ? "whitespace-nowrap text-[#d9b96e]" : "whitespace-nowrap text-[#8ea0ba]"}>
                        {priceSelection.kind === "book_mid" ? "Book midpoint" : priceSelection.kind === "last_trade" ? `${priceSelection.stale ? "Delayed " : ""}last trade` : "Price unavailable"}
                      </span>
                      <span className={`whitespace-nowrap ${dayChangeClass}`}>
                        {formatSignedPercent(market?.price_percentage_change_24h)} today
                      </span>
                      <SpreadMetric
                        spreadBps={market?.spread_bps}
                        bestBid={market?.best_bid}
                        bestAsk={market?.best_ask}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <MarketDatum label="Bid" value={formatUsdPrice(market?.best_bid, market?.quote_increment)} tone="buy" />
                    <MarketDatum label="Ask" value={formatUsdPrice(market?.best_ask, market?.quote_increment)} tone="sell" />
                    <MarketDatum label="24h volume" value={formatCompactUsd(quoteVolume)} />
                  </div>
                </div>
              </div>
              <div className={`self-start lg:row-span-2 rounded-lg p-4 ${SURFACE_SUNKEN}`}>
                <p className="text-xs font-medium text-[#7f90aa]">Choose direction</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={side === "buy"}
                    onClick={() => editTrade({ side: "buy" })}
                    className={side === "buy"
                      ? "h-12 rounded-md border border-emerald-300/40 bg-emerald-300/15 text-sm font-semibold text-emerald-100 shadow-[inset_0_0_0_1px_rgba(110,231,183,0.08)]"
                      : "h-12 rounded-md border border-transparent text-sm font-medium text-[#8ea0ba] hover:border-[#2b3a51] hover:bg-[#111827] hover:text-white"}
                  >
                    {side === "buy" ? "✓ Buy selected" : "Buy"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={side === "sell"}
                    onClick={() => editTrade({ side: "sell" })}
                    className={side === "sell"
                      ? "h-12 rounded-md border border-rose-300/40 bg-rose-300/15 text-sm font-semibold text-rose-100 shadow-[inset_0_0_0_1px_rgba(253,164,175,0.08)]"
                      : "h-12 rounded-md border border-transparent text-sm font-medium text-[#8ea0ba] hover:border-[#2b3a51] hover:bg-[#111827] hover:text-white"}
                  >
                    {side === "sell" ? "✓ Sell selected" : "Sell"}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#7f90aa]">
                  This only changes your order direction. Sign-in is required later to send it.
                </p>
                <Metric label="USD cap" value={`$${quoteSize}`} />
                <Metric label="Type" value="Market IOC" />
                <div className="mt-3">
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-[#6f7d9a]">
                    Amount
                  </p>
                  <div className="grid grid-cols-3 gap-2" role="group" aria-label="Order amount">
                    {QUOTE_SIZE_OPTIONS.map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        aria-pressed={quoteSize === amount}
                        onClick={() => editTrade({ quoteSize: amount })}
                        className={quoteSize === amount
                          ? "h-10 rounded-md border border-sky-300/45 bg-sky-300/15 font-mono text-sm font-semibold text-sky-100"
                          : "h-10 rounded-md border border-[#24324a] bg-[#080c13] font-mono text-sm text-[#8ea0ba] hover:border-[#405473] hover:text-white"}
                      >
                        ${amount}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#7f90aa]">
                    Your available balance and live policy are checked before approval.
                  </p>
                </div>
              </div>
              <div className="min-w-0">
                <GholaMarketChart
                  label="Coinbase"
                  frame={coinbaseRecord.frame}
                  overlays={buildGholaAgentChartOverlays({
                    order,
                    mid: priceSelection.value,
                    previewCommitment: submitted?.work_order_commitment || null,
                    accountReady: canSubmit,
                    venueLabel: "Coinbase",
                  })}
                  mode={chartMode}
                  onModeChange={setChartMode}
                  size="large"
                  height={280}
                />
              </div>
            </div>
          </div>

          <aside className="grid content-start gap-4 xl:sticky xl:top-20">
            <Panel title={`Your ${side} order`}>
              <div className="grid grid-cols-2 gap-2">
                <ReviewMetric label="Size" value={`$${quoteSize}.00`} />
                <ReviewMetric label="Est. quantity" value={`${formatAssetQuantity(estimatedBase)} ${baseSymbol}`} />
              </div>
              <ReadinessRow label="Account" ready={Boolean(auth.authenticated)} value={auth.authenticated ? "signed in" : "required"} />
              <ReadinessRow label="Secure venue" ready={venueStatus.ready} value={venueStatus.label} title={venueStatus.detail} />
              <ReadinessRow label="Balance" ready={balanceReady} value={prepared?.balance?.available_usd ? `$${prepared.balance.available_usd}` : "checked at review"} />
              <Ack
                checked={acknowledgementsReady}
                onChange={(checked) => {
                  setAcceptedTerms(checked);
                  setAcceptedRisk(checked);
                  setNotProhibited(checked);
                }}
                label={`I accept the beta terms, understand this is a real $${quoteSize} spot trade, and confirm I am eligible.`}
              />
              <button
                type="button"
                onClick={() => setAdvancedOpen((value) => !value)}
                aria-expanded={advancedOpen}
                className="flex min-h-11 items-center justify-between rounded-md border border-[#29313d] bg-[#0b0d11] px-3 text-left text-sm text-[#c9d0da] transition hover:border-[#3b82f6]/50"
              >
                <span className="inline-flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[#3da8ff]" />
                  Protection
                </span>
                <span className="text-xs text-[#778295]">
                  {stopLoss || takeProfit ? "Configured" : "Optional"}
                </span>
              </button>
              {advancedOpen && (
                <div className="grid gap-3 rounded-md border border-[#26313f] bg-[#090b0f] p-3">
                  <div>
                    <label htmlFor="spot-stop-loss" className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">
                      Stop loss
                    </label>
                    <div className="mt-1 flex h-11 items-center rounded-md border border-[#2b3441] bg-[#07090c] px-3 focus-within:border-[#3da8ff]">
                      <span className="text-[#647083]">$</span>
                      <input
                        id="spot-stop-loss"
                        inputMode="decimal"
                        value={stopLoss}
                        onChange={(event) => setStopLoss(event.target.value)}
                        placeholder="Optional"
                        className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm text-white outline-none placeholder:text-[#4f5868]"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="spot-take-profit" className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">
                      Take profit
                    </label>
                    <div className="mt-1 flex h-11 items-center rounded-md border border-[#2b3441] bg-[#07090c] px-3 focus-within:border-[#3da8ff]">
                      <span className="text-[#647083]">$</span>
                      <input
                        id="spot-take-profit"
                        inputMode="decimal"
                        value={takeProfit}
                        onChange={(event) => setTakeProfit(event.target.value)}
                        placeholder="Optional"
                        className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm text-white outline-none placeholder:text-[#4f5868]"
                      />
                    </div>
                  </div>
                  <p className="text-xs leading-5 text-[#778295]">
                    Coinbase receives these as a native attached bracket. Ghola does not simulate stops with a background worker.
                  </p>
                </div>
              )}
              {orderErrors[0] && <Alert>{orderErrors[0]}</Alert>}
              {error && <Alert>{error}</Alert>}
              {!auth.authenticated ? (
                <Link
                  href="/signin?redirect=/trade"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#eaf2ff] px-4 text-sm font-semibold text-[#07101d] transition hover:bg-white"
                >
                  <LogIn className="h-4 w-4" />
                  Sign in to {side} {baseSymbol}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (prepared?.can_submit_live) {
                      setShowReview(true);
                      return;
                    }
                    void prepareAccess();
                  }}
                  disabled={working !== null || orderErrors.length > 0}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#eaf2ff] px-4 text-sm font-semibold text-[#07101d] transition hover:bg-white disabled:cursor-wait disabled:bg-[#263241] disabled:text-[#8ea0ba]"
                >
                  <KeyRound className="h-4 w-4" />
                  {working === "prepare" ? "Checking trade" : `Review $${quoteSize} ${side}`}
                </button>
              )}
            </Panel>

            {submitted && (
              <details className={`rounded-lg p-4 ${SURFACE_RAISED}`}>
                <summary className="cursor-pointer text-sm font-medium text-white">
                  View execution receipt
                </summary>
                <div className="mt-3 grid gap-2">
                  <Metric label="Work order" value={submitted.work_order_commitment ? short(submitted.work_order_commitment) : "pending"} />
                  <Metric label="Reservation" value={submitted.balance_reservation_commitment ? short(submitted.balance_reservation_commitment) : "none"} />
                  <Metric label="Worker result" value={submitted.worker_receipt?.result_commitment ? short(submitted.worker_receipt.result_commitment) : "pending"} />
                  <Metric label="Provider ref" value={submitted.worker_receipt?.provider_ref_commitment ? short(submitted.worker_receipt.provider_ref_commitment) : "pending"} />
                </div>
              </details>
            )}
          </aside>
        </section>
      </div>
      {showReview && (
        <CoinbaseTradeReview
          product={product}
          side={side}
          price={displayPrice}
          quoteSize={quoteSize}
          estimatedBase={estimatedBase}
          baseSymbol={baseSymbol}
          working={working === "submit"}
          canConfirm={canSubmit}
          onClose={() => setShowReview(false)}
          onConfirm={() => void submitTinySpot()}
        />
      )}
    </main>
    </div>
    <div
      className={tradeProduct === "spot" ? "hidden" : "block"}
      aria-hidden={tradeProduct === "spot"}
      inert={tradeProduct === "spot"}
    >
      <AlternateProductWorkspace
        active={tradeProduct !== "spot"}
        product={tradeProduct === "spot" ? "perps" : tradeProduct}
        venue={venue}
        onProductChange={changeTradeProduct}
        onVenueChange={setVenue}
        interval={interval}
        onIntervalChange={setIntervalValue}
        chartMode={chartMode}
        onChartModeChange={setChartMode}
        referenceProduct={product}
        authenticated={auth.authenticated}
        hyperliquidNetwork={hyperliquidNetwork}
        productEnvironment={productEnvironment}
        hyperliquidMaxSlippageBps={hyperliquidMaxSlippageBps}
      />
    </div>
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg p-4 ${SURFACE_RAISED}`}>
      <div className="mb-3 text-sm font-medium tracking-tight text-white">{title}</div>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

function WorkspaceProductNav({
  value,
  onChange,
}: {
  value: TradeProduct;
  onChange: (value: TradeProduct) => void;
}) {
  return (
    <nav
      aria-label="Trading product"
      className="flex w-full gap-1 overflow-x-auto rounded-lg border border-[#252a32] bg-[#0b0d11] p-1"
    >
      {TRADE_PRODUCTS.map((product) => (
        <button
          key={product.id}
          type="button"
          aria-current={value === product.id ? "page" : undefined}
          onClick={() => onChange(product.id)}
          className={
            value === product.id
              ? "min-w-[88px] flex-1 rounded-md bg-[#142235] px-4 py-2.5 text-sm font-semibold text-[#8fcbff] shadow-[inset_0_0_0_1px_rgba(61,168,255,0.24)]"
              : "min-w-[88px] flex-1 rounded-md px-4 py-2.5 text-sm font-medium text-[#7f8998] transition hover:bg-white/[0.035] hover:text-[#dfe5ed]"
          }
        >
          {product.label}
        </button>
      ))}
    </nav>
  );
}

function AlternateProductWorkspace({
  active,
  product,
  venue,
  onProductChange,
  onVenueChange,
  interval,
  onIntervalChange,
  chartMode,
  onChartModeChange,
  referenceProduct,
  authenticated,
  hyperliquidNetwork,
  productEnvironment,
  hyperliquidMaxSlippageBps,
}: {
  active: boolean;
  product: Exclude<TradeProduct, "spot">;
  venue: TradeVenueId;
  onProductChange: (value: TradeProduct) => void;
  onVenueChange: (value: TradeVenueId) => void;
  interval: CoinbaseCandleInterval;
  onIntervalChange: (value: CoinbaseCandleInterval) => void;
  chartMode: GholaChartMode;
  onChartModeChange: (value: GholaChartMode) => void;
  referenceProduct: CoinbaseProductId;
  authenticated: boolean;
  hyperliquidNetwork: "mainnet" | "testnet";
  productEnvironment: "production" | "testnet";
  hyperliquidMaxSlippageBps: number;
}) {
  const workspaceParams = useSearchParams();
  const turnkeyWallet = useTurnkeyWallet();
  // This value must be identical during SSR and the browser's first render.
  // Browser preferences are reconciled in an effect after hydration.
  const requestedPerpMarket = workspaceParams.get("product") === "perps"
    ? normalizePerpMarket(workspaceParams.get("market")?.replace(/-PERP$/i, "").split("-")[0])
    : null;
  const initialPerpMarket = requestedPerpMarket || "SOL";
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("10");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [timeInForce, setTimeInForce] = useState<"Gtc" | "Ioc" | "Alo">("Gtc");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverage, setLeverage] = useState("1");
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [maxSlippageBps, setMaxSlippageBps] = useState(String(hyperliquidMaxSlippageBps));
  const [perpWorking, setPerpWorking] = useState<"preview" | "submit" | null>(null);
  const [perpError, setPerpError] = useState<string | null>(null);
  const [perpNotice, setPerpNotice] = useState<string | null>(null);
  const [perpReview, setPerpReview] = useState<{
    intentId: string;
    previewCommitment: string;
    createdAt: number;
  } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<"positions" | "orders" | "activity">("positions");
  const [perpMarket, setPerpMarket] = useState(initialPerpMarket);
  const [perpMarkets, setPerpMarkets] = useState<Array<{ coin: string; max_leverage: number | null }>>([
    { coin: initialPerpMarket, max_leverage: null },
  ]);
  const [perpMarketCatalogState, setPerpMarketCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [hyperliquidAccount, setHyperliquidAccount] = useState<HyperliquidAccountSnapshot | null>(null);
  const [hyperliquidConnectionReady, setHyperliquidConnectionReady] = useState(false);
  const [accountState, setAccountState] = useState<"loading" | "ready" | "unavailable">("loading");
  const venues = capabilitiesForProduct(product);
  const selectedVenue = venues.find((item) => item.id === venue) ?? venues[0];
  const productLabel = product === "perps" ? "Perpetuals" : product === "swap" ? "Swap" : "Automation";
  const baseSymbol = product === "perps" ? perpMarket : product === "swap" ? "SOL" : referenceProduct.split("-")[0];
  const marketLabel = product === "perps" ? `${baseSymbol}-PERP` : product === "swap" ? "SOL / USDC" : referenceProduct;
  const nativeProtection = selectedVenue?.protective_orders === "native";
  const setupHref = `/account?flow=private-mode&setup=${encodeURIComponent(venue)}&return_to=${encodeURIComponent(`/trade?product=${product}&venue=${venue}&market=${marketLabel}`)}`;
  const useHyperliquidMarket = active && product === "perps" && venue === "hyperliquid";
  const hyperliquidRecord = useMarketData({
    venue: "hyperliquid",
    network: hyperliquidNetwork,
    coin: perpMarket,
    interval,
  }, useHyperliquidMarket);
  const hyperliquidMarket = hyperliquidRecord.snapshot?.platform === "hyperliquid" ? hyperliquidRecord.snapshot : null;
  const hyperliquidStatus = hyperliquidRecord.status;
  const requestedReferenceProduct = product === "swap"
    ? "SOL-USD"
    : product === "perps"
      ? `${perpMarket}-USD`
      : referenceProduct;
  const referenceMarketProduct = PRODUCTS.includes(requestedReferenceProduct as CoinbaseProductId)
    ? requestedReferenceProduct as CoinbaseProductId
    : null;
  const useCoinbaseReference = active && !useHyperliquidMarket && referenceMarketProduct != null;
  const referenceRecord = useMarketData({
    venue: "coinbase",
    productId: referenceMarketProduct ?? "SOL-USD",
    interval,
  }, useCoinbaseReference);
  const referenceMarket = referenceRecord.snapshot?.platform === "coinbase" ? referenceRecord.snapshot : null;
  const coinbasePriceSelection = selectCoinbaseDisplayPrice(referenceMarket);
  const displayedMid = useHyperliquidMarket
    ? hyperliquidMarket?.mid || hyperliquidMarket?.mark_price
    : coinbasePriceSelection.value;
  const displayedFrame = useHyperliquidMarket
    ? hyperliquidRecord.frame
    : referenceMarketProduct ? referenceRecord.frame : null;
  const displayedMarketStatus = useHyperliquidMarket ? hyperliquidStatus : referenceRecord.status;
  const selectedMarketCapability = perpMarkets.find((item) => item.coin === perpMarket);
  const hyperliquidReadiness = useMemo(() => hyperliquidPerpsReadiness({
    authenticated,
    network: hyperliquidNetwork,
    credentialsReady: hyperliquidConnectionReady,
    accountState,
    account: hyperliquidAccount,
    marketCatalogState: perpMarketCatalogState,
    selectedMarketAvailable: Boolean(selectedMarketCapability),
  }), [accountState, authenticated, hyperliquidAccount, hyperliquidConnectionReady, hyperliquidNetwork, perpMarketCatalogState, selectedMarketCapability]);
  const maxLeverage = hyperliquidMarket?.max_leverage ?? selectedMarketCapability?.max_leverage ?? null;
  const perpOrder = useMemo<PrivateExecutionOrderDraft>(() => ({
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: perpMarket,
    side,
    base_size: "",
    quote_size: amount,
    limit_price: orderType === "limit" ? limitPrice : "",
    order_type: orderType,
    size_mode: "quote",
    tif: orderType === "market" ? "Ioc" : timeInForce,
    max_slippage_bps: maxSlippageBps,
    reduce_only: reduceOnly,
    post_only: orderType === "limit" && timeInForce === "Alo",
    leverage: Number(leverage),
    margin_mode: marginMode,
    protective_orders: reduceOnly ? undefined : {
      ...(stopLoss.trim() ? { stop_loss: stopLoss.trim() } : {}),
      ...(takeProfit.trim() ? { take_profit: takeProfit.trim() } : {}),
    },
  }), [amount, leverage, limitPrice, marginMode, maxSlippageBps, orderType, perpMarket, reduceOnly, side, stopLoss, takeProfit, timeInForce]);
  const perpOrderErrors = useMemo(
    () => validatePerpTicket(perpOrder, displayedMid, maxLeverage, hyperliquidMaxSlippageBps),
    [displayedMid, hyperliquidMaxSlippageBps, maxLeverage, perpOrder],
  );

  useEffect(() => {
    if (requestedPerpMarket) {
      setPerpMarket(requestedPerpMarket);
      return;
    }
    const retained = readStoredPerpMarket();
    if (retained) setPerpMarket(retained);
  }, [requestedPerpMarket]);

  useEffect(() => {
    if (!useHyperliquidMarket) return;
    let cancelled = false;
    const cancelSchedule = scheduleAfterPaint(() => {
      void fetch("/v1/private-account/hyperliquid/markets", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("markets unavailable");
          return response.json() as Promise<{ markets?: Array<{ coin?: string; max_leverage?: number | null }> }>;
        })
        .then((result) => {
          if (cancelled) return;
          const next = (result.markets ?? []).flatMap((item) =>
            item.coin ? [{ coin: item.coin, max_leverage: item.max_leverage ?? null }] : []
          );
          if (next.length > 0) startTransition(() => setPerpMarkets(next));
          if (!cancelled) setPerpMarketCatalogState("ready");
        })
        .catch(() => {
          if (!cancelled) setPerpMarketCatalogState("unavailable");
        });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [useHyperliquidMarket]);

  useEffect(() => {
    if (useHyperliquidMarket) setPerpMarketCatalogState("loading");
  }, [perpMarket, useHyperliquidMarket]);

  useEffect(() => {
    if (!authenticated) {
      setHyperliquidAccount(null);
      setAccountState("loading");
      return;
    }
    if (!useHyperliquidMarket) {
      // The alternate workspace stays mounted. Preserve the last coherent
      // account snapshot so returning to Perps never flashes an empty state.
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await getHyperliquidAccountSnapshot();
        if (!cancelled) {
          setHyperliquidAccount(snapshot);
          setAccountState("ready");
        }
      } catch {
        if (!cancelled) {
          setHyperliquidAccount(null);
          setAccountState("unavailable");
        }
      }
    };
    const cancelSchedule = scheduleAfterPaint(() => void load());
    const stream = openHyperliquidAccountStream({
      coin: perpMarket,
      onState(snapshot) {
        if (!cancelled) {
          setHyperliquidAccount((current) => mergeHyperliquidAccountSnapshot(current, snapshot));
          setAccountState("ready");
        }
      },
      onError() {
        // Preserve the last coherent snapshot while the stream reconnects.
      },
    });
    return () => {
      cancelled = true;
      cancelSchedule();
      stream.close();
    };
  }, [authenticated, perpMarket, useHyperliquidMarket]);

  useEffect(() => {
    if (!authenticated || !useHyperliquidMarket) return;
    let cancelled = false;
    void getHyperliquidExecutionVaultStatus()
      .then((status) => {
        if (!cancelled) setHyperliquidConnectionReady(hyperliquidCredentialsSealed(status));
      })
      .catch(() => {
        if (!cancelled) setHyperliquidConnectionReady(false);
      });
    return () => { cancelled = true; };
  }, [authenticated, useHyperliquidMarket]);

  useEffect(() => {
    if (!authenticated || !useHyperliquidMarket || !hyperliquidConnectionReady || perpMarkets.length === 0) return;
    let cancelled = false;
    void armHyperliquidExecutionAgent({
      execution_mode: "byo_api_key",
      market_allowlist: perpMarkets.map((item) => item.coin),
      max_notional_bucket: "10",
      max_order_count: 100,
      kill_switch: false,
    }).catch((error) => {
      if (!cancelled) setPerpError(friendlyPerpError(error));
    });
    return () => { cancelled = true; };
  }, [authenticated, hyperliquidConnectionReady, perpMarkets, useHyperliquidMarket]);

  function changePerpMarket(next: string) {
    setPerpMarket(next);
    writeStoredPreference(LAST_PERP_MARKET_KEY, next);
    const params = new URLSearchParams(workspaceParams.toString());
    params.set("product", "perps");
    params.set("venue", venue);
    params.set("market", `${next}-PERP`);
    replaceTradeUrlAfterPaint(`/trade?${params.toString()}`);
  }

  function changeVenue(next: TradeVenueId) {
    onVenueChange(next);
    const params = new URLSearchParams(workspaceParams.toString());
    params.set("product", product);
    params.set("venue", next);
    params.set("market", marketLabel.replace(" / ", "-"));
    replaceTradeUrlAfterPaint(`/trade?${params.toString()}`);
  }

  async function reviewPerpOrder() {
    setPerpError(null);
    setPerpNotice(null);
    if (!authenticated) {
      setSetupOpen(true);
      return;
    }
    if (!hyperliquidConnectionReady) {
      setSetupOpen(true);
      return;
    }
    if (perpOrderErrors.length > 0) {
      setPerpError(perpOrderErrors[0]);
      return;
    }
    if (hyperliquidAccount?.status !== "ready_to_trade") {
      setPerpError(hyperliquidAccount?.next_step || "Add Hyperliquid collateral before reviewing this order.");
      return;
    }
    setPerpWorking("preview");
    try {
      // The eager arming effect keeps this path fast. Refresh at point of use
      // as well so an idle tab can never review against an expired session.
      await armHyperliquidExecutionAgent({
        execution_mode: "byo_api_key",
        market_allowlist: perpMarkets.map((item) => item.coin),
        max_notional_bucket: "10",
        max_order_count: 100,
        kill_switch: false,
      });
      const safeInput = perpSafeInput(perpMarket, amount);
      const intent = await createPrivateAccountIntent(safeInput) as { intent_id?: string };
      if (!intent.intent_id) throw new Error("Ghola could not create the private order intent.");
      const runtime = await createPrivateAccountRuntimeEnvelope({
        intent_id: intent.intent_id,
        safe_input: safeInput,
      }) as { runtime_envelope?: { runtime_envelope_commitment?: string } };
      const preview = await previewPrivateAccountAction({
        intent_id: intent.intent_id,
        safe_input: safeInput,
        // A BYO Hyperliquid API wallet is a direct venue route. It is encrypted
        // in Ghola, but Hyperliquid necessarily sees the account and order, so
        // request the explicit degraded rail instead of a batch-anonymity rail.
        requested_rail: "direct_public_fallback",
        runtime_envelope_commitment: runtime.runtime_envelope?.runtime_envelope_commitment,
      }) as {
        preview?: {
          preview_commitment?: string;
          claim_status?: string;
          blocked_reasons?: string[];
          wait_reasons?: string[];
        };
      };
      if (preview.preview?.claim_status === "blocked_leaky_path") {
        throw new Error(preview.preview.blocked_reasons?.[0] || "Privacy policy blocked this venue route.");
      }
      if (preview.preview?.claim_status === "wait_for_anonymity") {
        throw new Error(preview.preview.wait_reasons?.[0] || "Privacy policy is still waiting.");
      }
      const previewCommitment = preview.preview?.preview_commitment;
      if (!previewCommitment) throw new Error("Ghola did not return a review commitment.");
      setPerpReview({ intentId: intent.intent_id, previewCommitment, createdAt: Date.now() });
    } catch (error) {
      setPerpError(friendlyPerpError(error));
    } finally {
      setPerpWorking(null);
    }
  }

  async function submitPerpOrder() {
    if (!perpReview || perpWorking) return;
    setPerpError(null);
    if (Date.now() - perpReview.createdAt > 15_000) {
      setPerpReview(null);
      setPerpError("The live review expired. Review the order again for a fresh price and account check.");
      return;
    }
    if (!turnkeyWallet.walletAddress) {
      setPerpError("Unlock your Ghola wallet to approve this private order.");
      return;
    }
    setPerpWorking("submit");
    try {
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: turnkeyWallet.walletAddress,
        previewCommitment: perpReview.previewCommitment,
        order: perpOrder,
        signBytes: turnkeyWallet.signBytes,
        ttlMs: 60_000,
      });
      const approval = await approvePrivateAccountAction({
        intent_id: perpReview.intentId,
        preview_commitment: perpReview.previewCommitment,
        degraded_accepted: true,
      }) as { approval?: { approval_commitment?: string } };
      const approvalCommitment = approval.approval?.approval_commitment;
      if (!approvalCommitment) throw new Error("Order approval was not recorded.");
      const execution = await executePrivateAccountAction({
        intent_id: perpReview.intentId,
        preview_commitment: perpReview.previewCommitment,
        approval_commitment: approvalCommitment,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      }) as { execution?: { status?: string }; status?: string };
      const status = execution.execution?.status || execution.status || "submitted";
      setPerpNotice(`Hyperliquid order ${status.replaceAll("_", " ")}. Reconciliation is active.`);
      setPerpReview(null);
    } catch (error) {
      setPerpError(friendlyPerpError(error));
    } finally {
      setPerpWorking(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#08090b] pt-16 font-sans text-[#eceef2]">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        {productEnvironment === "testnet" && product === "perps" && (
          <section className="flex flex-col gap-3 rounded-lg border border-[#315d55] bg-[linear-gradient(90deg,rgba(19,64,54,0.72),rgba(10,25,27,0.92))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" aria-label="Testnet environment">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#7de0bd]" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9aebce]">Hyperliquid testnet</p>
                <p className="mt-1 text-xs leading-5 text-[#aabdb8]">Real testnet execution through Ghola&apos;s attested worker. Collateral and fills are simulated and never move mainnet funds.</p>
              </div>
            </div>
            <span className="inline-flex w-fit rounded-full border border-[#397665] bg-[#102d25] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#91e7c7]">Network-bound</span>
          </section>
        )}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#242a32] pb-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#3da8ff]">Unified trading</p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.025em] text-white">{productLabel}</h1>
            <p className="mt-1 text-sm text-[#7f8998]">{marketLabel} · market context stays in place</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 items-center gap-2 rounded-md border border-[#26313f] bg-[#0b0e13] px-3 text-xs text-[#a8b2c1]">
              <span className={displayedMarketStatus === "live" ? "h-1.5 w-1.5 rounded-full bg-[#62d6a5]" : "h-1.5 w-1.5 rounded-full bg-[#d9b96e]"} />
              {formatStatus(displayedMarketStatus, Boolean(displayedFrame))}
            </span>
            {product === "perps" && (
              <span className="inline-flex h-9 items-center gap-2 rounded-md border border-[#26313f] bg-[#0b0e13] px-3 text-xs text-[#a8b2c1]" title={hyperliquidReadiness.detail}>
                <span className={hyperliquidReadiness.ready ? "h-1.5 w-1.5 rounded-full bg-[#62d6a5]" : "h-1.5 w-1.5 rounded-full bg-[#d9b96e]"} />
                {hyperliquidReadiness.label}
              </span>
            )}
            <button
              type="button"
              onClick={() => setSetupOpen(true)}
              className="h-9 rounded-md border border-[#315478] bg-[#102033] px-3 text-xs font-semibold text-[#8fcbff] hover:border-[#3da8ff]"
            >
              {product === "perps" && !hyperliquidConnectionReady
                ? `Connect Hyperliquid ${hyperliquidNetwork}`
                : product === "perps" ? "Connected" : "Venue setup"}
            </button>
          </div>
        </header>

        <WorkspaceProductNav value={product} onChange={onProductChange} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0 overflow-hidden rounded-xl border border-[#252a32] bg-[#0b0d10] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.34)] sm:p-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs text-[#768194]">
                  {useHyperliquidMarket ? `Hyperliquid ${hyperliquidNetwork} market` : referenceMarketProduct ? `Coinbase ${referenceMarketProduct} reference` : "Reference unavailable"} · {marketLabel}
                </p>
                <p className="mt-1 font-mono text-3xl font-semibold tracking-[-0.04em] text-white">
                  {formatUsdPrice(displayedMid, useHyperliquidMarket ? undefined : referenceMarket?.quote_increment)}
                </p>
                {!useHyperliquidMarket && (
                  <p className={coinbasePriceSelection.stale ? "mt-1 text-[11px] text-[#d9b96e]" : "mt-1 text-[11px] text-[#768194]"}>
                    {coinbasePriceSelection.kind === "book_mid" ? "Book midpoint" : coinbasePriceSelection.kind === "last_trade" ? `${coinbasePriceSelection.stale ? "Delayed " : ""}last trade` : "Price unavailable"}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {product === "perps" && (
                  <PerpMarketPicker
                    value={perpMarket}
                    markets={perpMarkets}
                    onChange={changePerpMarket}
                  />
                )}
                <Segmented
                  label="Interval"
                  value={interval}
                  options={INTERVALS}
                  onChange={(value) => onIntervalChange(value as CoinbaseCandleInterval)}
                  align="right"
                />
              </div>
            </div>
            {useHyperliquidMarket && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <PerpDatum label="Mark" value={formatUsdPrice(hyperliquidMarket?.mark_price)} />
                <PerpDatum label="Oracle" value={formatUsdPrice(hyperliquidMarket?.oracle_price)} />
                <PerpDatum label="Funding / 8h" value={formatFundingRate(hyperliquidMarket?.funding_rate)} />
                <PerpDatum label="Open interest" value={formatPerpValue(hyperliquidMarket?.open_interest)} />
                <PerpDatum label="Max leverage" value={maxLeverage ? `${maxLeverage}×` : "Unavailable"} />
              </div>
            )}
            <GholaMarketChart
              label={useHyperliquidMarket ? "Hyperliquid" : referenceMarketProduct ? `Coinbase · ${referenceMarketProduct}` : `${marketLabel} reference`}
              frame={displayedFrame}
              mode={chartMode}
              onModeChange={onChartModeChange}
              size="large"
              height={390}
            />
            <div className="mt-4 border-t border-[#20252d] pt-3">
              <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Trading activity">
                {(["positions", "orders", "activity"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activityTab === tab}
                    onClick={() => setActivityTab(tab)}
                    className={activityTab === tab
                      ? "rounded-md bg-[#172235] px-3 py-2 text-xs font-semibold capitalize text-[#9ccfff]"
                      : "rounded-md px-3 py-2 text-xs font-medium capitalize text-[#747f90] hover:text-white"}
                  >
                    {tab === "orders" ? "Open orders" : tab}
                  </button>
                ))}
              </div>
              <AccountActivityPanel
                tab={activityTab}
                authenticated={authenticated}
                state={accountState}
                snapshot={hyperliquidAccount}
                venueLabel={selectedVenue?.label ?? "venue"}
                supported={useHyperliquidMarket}
              />
            </div>
          </section>

          <aside className="xl:sticky xl:top-20 xl:self-start">
            <div className="rounded-xl border border-[#292f38] bg-[linear-gradient(180deg,#11141a_0%,#0b0d11_100%)] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.4)]">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {product === "automate" ? "Agent mandate" : product === "swap" ? "Swap SOL" : "Place order"}
                  </p>
                  <p className="mt-1 text-xs text-[#788395]">{selectedVenue?.label}{useHyperliquidMarket ? ` ${hyperliquidNetwork}` : ""} · {marketLabel}</p>
                </div>
                <select
                  aria-label="Execution venue"
                  value={selectedVenue?.id}
                  onChange={(event) => changeVenue(event.target.value as TradeVenueId)}
                  className="h-9 rounded-md border border-[#2b3542] bg-[#090c10] px-2 text-xs text-[#cbd3df] outline-none focus:border-[#3da8ff]"
                >
                  {venues.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </div>

              {product === "automate" ? (
                <div className="grid gap-3">
                  <TicketField label="Strategy" value="Momentum with risk cap" readOnly />
                  <TicketInput label="Max order" prefix="$" value={amount} onChange={setAmount} />
                  <TicketField label="Duration" value="4 hours" readOnly />
                  <div className="rounded-md border border-[#263448] bg-[#0b1320] p-3 text-xs leading-5 text-[#9fb5cf]">
                    The agent can monitor and propose locally. Live execution stays off until the venue is connected and the mandate is reviewed.
                  </div>
                </div>
              ) : product === "swap" ? (
                <div className="grid gap-3">
                  <TicketInput label="You pay" suffix="SOL" value={amount} onChange={setAmount} />
                  <div className="flex justify-center"><RefreshCw className="h-4 w-4 text-[#637083]" /></div>
                  <TicketField label="You receive" value="USDC · quote at review" readOnly />
                  <TicketField label="Max slippage" value="0.50%" readOnly />
                  <p className="text-xs leading-5 text-[#778295]">Swaps do not support stop-loss or take-profit orders.</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid grid-cols-2 gap-2">
                    {(["buy", "sell"] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        onClick={() => setSide(direction)}
                        className={side === direction
                          ? direction === "buy"
                            ? "h-11 rounded-md border border-[#62d6a5]/40 bg-[#62d6a5]/12 text-sm font-semibold text-[#a8efd1]"
                            : "h-11 rounded-md border border-[#ef8f97]/40 bg-[#ef8f97]/12 text-sm font-semibold text-[#ffc2c7]"
                          : "h-11 rounded-md border border-[#252d37] bg-[#090b0e] text-sm text-[#778295]"}
                      >
                        {direction === "buy" ? "Long" : "Short"}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="Order type">
                    {(["market", "limit"] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={orderType === type}
                        onClick={() => setOrderType(type)}
                        className={orderType === type
                          ? "h-10 rounded-md border border-[#3da8ff]/45 bg-[#3da8ff]/12 text-sm font-semibold capitalize text-[#a9d8ff]"
                          : "h-10 rounded-md border border-[#252d37] bg-[#090b0e] text-sm capitalize text-[#778295]"}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <TicketInput label="Size" prefix="$" value={amount} onChange={setAmount} />
                  {orderType === "limit" && (
                    <TicketInput label="Limit price" prefix="$" value={limitPrice} onChange={setLimitPrice} placeholder="Required" />
                  )}
                  <label className="block">
                    <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">Leverage</span>
                    <select
                      value={leverage}
                      onChange={(event) => setLeverage(event.target.value)}
                      className="mt-1 h-11 w-full rounded-md border border-[#2b3441] bg-[#07090c] px-3 font-mono text-sm text-white outline-none focus:border-[#3da8ff]"
                    >
                      {[1, 2, 3, 5, 10, 20, 25, 40]
                        .filter((value) => maxLeverage == null || value <= maxLeverage)
                        .map((value) => <option key={value} value={value}>{value}×</option>)}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="Margin mode">
                    {(["cross", "isolated"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={marginMode === mode}
                        onClick={() => setMarginMode(mode)}
                        className={marginMode === mode
                          ? "h-10 rounded-md border border-[#3da8ff]/45 bg-[#3da8ff]/10 text-sm font-semibold capitalize text-[#a9d8ff]"
                          : "h-10 rounded-md border border-[#252d37] bg-[#090b0e] text-sm capitalize text-[#778295]"}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setAdvanced((value) => !value)}
                    className="flex h-11 items-center justify-between rounded-md border border-[#28313d] bg-[#090b0e] px-3 text-sm text-[#aab4c2]"
                  >
                    <span className="inline-flex items-center gap-2"><Settings2 className="h-4 w-4 text-[#3da8ff]" />Protection & advanced</span>
                    <ChevronDown className={`h-4 w-4 transition ${advanced ? "rotate-180" : ""}`} />
                  </button>
                  {advanced && (
                    <div className="grid gap-3 rounded-md border border-[#27313e] bg-[#090b0f] p-3">
                      <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-[#28313d] bg-[#080a0d] px-3 text-sm text-[#aab4c2]">
                        Reduce only
                        <input
                          type="checkbox"
                          checked={reduceOnly}
                          onChange={(event) => setReduceOnly(event.target.checked)}
                          className="h-4 w-4 accent-[#3da8ff]"
                        />
                      </label>
                      {orderType === "limit" && (
                        <label className="block">
                          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">Time in force</span>
                          <select
                            value={timeInForce}
                            onChange={(event) => setTimeInForce(event.target.value as "Gtc" | "Ioc" | "Alo")}
                            className="mt-1 h-10 w-full rounded-md border border-[#2b3441] bg-[#07090c] px-3 text-sm text-white outline-none"
                          >
                            <option value="Gtc">Good til canceled</option>
                            <option value="Ioc">Immediate or cancel</option>
                            <option value="Alo">Post only</option>
                          </select>
                        </label>
                      )}
                      {orderType === "market" && (
                        <TicketInput label="Max slippage" suffix="bps" value={maxSlippageBps} onChange={setMaxSlippageBps} />
                      )}
                      {nativeProtection && !reduceOnly ? (
                        <>
                          <TicketInput label="Stop loss" prefix="$" value={stopLoss} onChange={setStopLoss} placeholder="Optional" />
                          <TicketInput label="Take profit" prefix="$" value={takeProfit} onChange={setTakeProfit} placeholder="Optional" />
                          <p className="text-xs leading-5 text-[#778295]">Submitted with the entry as native reduce-only mark-price triggers on {selectedVenue?.label}.</p>
                        </>
                      ) : (
                        <p className="text-xs leading-5 text-[#778295]">
                          {reduceOnly ? "Reduce-only exits cannot attach a new bracket." : "This venue does not expose native bracket protection."}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                disabled={perpWorking !== null}
                onClick={() => { if (product === "perps" && hyperliquidConnectionReady) void reviewPerpOrder(); else setSetupOpen(true); }}
                className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#3da8ff] text-sm font-bold text-[#03101d] transition hover:bg-[#67baff] disabled:cursor-wait disabled:opacity-70"
              >
                {product === "perps" && hyperliquidConnectionReady ? <Send className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                {product === "perps" && hyperliquidConnectionReady
                  ? perpWorking === "preview" ? "Checking live order…" : "Review order"
                  : authenticated && product === "perps" ? `Connect Hyperliquid ${hyperliquidNetwork}` : authenticated ? `Set up ${selectedVenue?.label}` : "Sign in to continue"}
              </button>
              {product === "perps" && (
                <p className={hyperliquidReadiness.ready ? "mt-3 text-center text-[11px] leading-4 text-[#68be98]" : "mt-3 text-center text-[11px] leading-4 text-[#aab4c2]"}>{hyperliquidReadiness.detail}</p>
              )}
              {perpError && <p role="alert" className="mt-3 rounded-md border border-[#5d3036] bg-[#2a1115] px-3 py-2 text-xs leading-5 text-[#ffb7bd]">{perpError}</p>}
              {perpNotice && <p role="status" className="mt-3 rounded-md border border-[#285c49] bg-[#0d251c] px-3 py-2 text-xs leading-5 text-[#92e1bd]">{perpNotice}</p>}
            </div>
          </aside>
        </div>
      </div>

      {setupOpen && (
        <div
          className="fixed inset-0 z-[100] flex justify-end bg-black/65 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSetupOpen(false);
          }}
        >
          <aside role="dialog" aria-modal="true" aria-label="Venue setup" className="h-full w-full max-w-md border-l border-[#29313c] bg-[#0b0e13] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#3da8ff]">Secure connection</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Connect {selectedVenue?.label}</h2>
              </div>
              <button type="button" onClick={() => setSetupOpen(false)} className="rounded-md p-2 text-[#7f8998] hover:bg-white/5 hover:text-white">Close</button>
            </div>
            <div className="mt-6 rounded-lg border border-[#27313e] bg-[#090b0f] p-4">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-md bg-[#132238] text-[#62b7ff]">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-white">Scoped trading access</p>
                  <p className="mt-1 text-xs text-[#7f8998]">Trade-only access. Withdrawals stay disabled.</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-[#9da8b8]">
                {product === "perps"
                  ? "Use a dedicated Hyperliquid API wallet. Ghola encrypts it in your browser, checks the connection without placing an order, and only then marks the account connected."
                  : selectedVenue?.unavailable_reason ?? "This venue is ready for capped execution."}
              </p>
            </div>
            <Link
              href={setupHref}
              className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-md bg-[#3da8ff] text-sm font-bold text-[#03101d] hover:bg-[#67baff]"
            >
              {product === "perps" ? "Connect Hyperliquid" : "Continue secure setup"}
            </Link>
            <p className="mt-3 text-xs leading-5 text-[#697486]">
              {product === "perps"
                ? "You’ll need your Hyperliquid account address and a dedicated API wallet key—not your main wallet seed."
                : "Setup opens in a secure account flow."}
            </p>
          </aside>
        </div>
      )}
      {perpReview && (
        <div className="fixed inset-0 z-[110] flex justify-end bg-black/70 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !perpWorking) setPerpReview(null); }}>
          <aside role="dialog" aria-modal="true" aria-label="Review Hyperliquid order" className="flex h-full w-full max-w-md flex-col border-l border-[#29313c] bg-[#0b0e13] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#232b35] pb-5">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#3da8ff]">Final review</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">{side === "buy" ? "Long" : "Short"} {perpMarket}-PERP</h2>
                <p className="mt-1 text-sm text-[#7f8998]">Hyperliquid · {marginMode} · {leverage}×</p>
              </div>
              <button type="button" disabled={perpWorking !== null} onClick={() => setPerpReview(null)} className="rounded-md p-2 text-[#7f8998] hover:bg-white/5 hover:text-white disabled:opacity-40">Close</button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <ReviewDatum label="Order" value={orderType === "market" ? `Market · ${maxSlippageBps} bps max` : `Limit · ${timeInForce}`} />
              <ReviewDatum label="Notional" value={`$${amount}`} />
              <ReviewDatum label="Reference" value={formatUsdPrice(displayedMid)} />
              <ReviewDatum label="Estimated size" value={estimatedPerpSize(amount, displayedMid, perpMarket)} />
              <ReviewDatum label="Initial margin" value={estimatedMargin(amount, leverage)} />
              <ReviewDatum label="Mode" value={`${reduceOnly ? "reduce-only · " : ""}${marginMode} · ${leverage}×`} />
            </div>
            {(stopLoss || takeProfit) && !reduceOnly && (
              <div className="mt-4 rounded-lg border border-[#294437] bg-[#0b1913] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#76d3a7]">Native protection</p>
                <p className="mt-2 text-sm text-[#b8c8bf]">{stopLoss ? `Stop $${stopLoss}` : "No stop"} · {takeProfit ? `Take profit $${takeProfit}` : "No take profit"}</p>
                <p className="mt-2 text-xs leading-5 text-[#748b7f]">The bracket is submitted as reduce-only venue triggers with the entry.</p>
              </div>
            )}
            <div className="mt-4 rounded-lg border border-[#303744] bg-[#090b0f] p-4 text-xs leading-5 text-[#8d98a8]">
              Hyperliquid can see the execution account and order. Ghola stores the approval, ciphertext, and reconciliation commitments. This quote expires after 15 seconds.
            </div>
            <div className="mt-auto grid gap-2 pt-6">
              <button type="button" disabled={perpWorking !== null} onClick={() => void submitPerpOrder()} className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#3da8ff] text-sm font-bold text-[#03101d] hover:bg-[#67baff] disabled:cursor-wait disabled:opacity-65">
                <ShieldCheck className="h-4 w-4" />
                {perpWorking === "submit" ? "Submitting securely…" : `Submit ${side === "buy" ? "long" : "short"}`}
              </button>
              <button type="button" disabled={perpWorking !== null} onClick={() => setPerpReview(null)} className="h-11 rounded-md border border-[#2b3441] text-sm text-[#aab4c2] hover:border-[#465367] hover:text-white disabled:opacity-40">Back to ticket</button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function PerpMarketPicker({
  value,
  markets,
  onChange,
}: {
  value: string;
  markets: Array<{ coin: string; max_leverage: number | null }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = markets.find((item) => item.coin === value);
  const visibleMarkets = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase();
    const matches = normalizedQuery
      ? markets.filter((item) => item.coin.toUpperCase().includes(normalizedQuery))
      : markets;
    return matches.slice(0, 24);
  }, [markets, query]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="relative">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-[#6f7d90]">
        Perp market
      </span>
      <button
        type="button"
        aria-label="Perpetual market"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 min-w-36 items-center justify-between gap-3 rounded-md border border-[#315478] bg-[#0b1420] px-3 text-xs font-semibold text-[#9ccfff] outline-none hover:border-[#3da8ff] focus:border-[#3da8ff]"
      >
        <span>{value}-PERP{selected?.max_leverage ? ` · ${selected.max_leverage}×` : ""}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-lg border border-[#2b3b50] bg-[#0a0d12] p-2 shadow-[0_18px_60px_rgba(0,0,0,0.65)]">
          <label className="block">
            <span className="sr-only">Search perpetual markets</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search markets"
              className="h-10 w-full rounded-md border border-[#283544] bg-[#07090c] px-3 text-sm text-white outline-none placeholder:text-[#566174] focus:border-[#3da8ff]"
            />
          </label>
          <div role="listbox" aria-label="Perpetual markets" className="mt-2 max-h-72 overflow-y-auto">
            {visibleMarkets.map((item) => (
              <button
                key={item.coin}
                type="button"
                role="option"
                aria-selected={item.coin === value}
                onClick={() => {
                  onChange(item.coin);
                  setQuery("");
                  setOpen(false);
                }}
                className={item.coin === value
                  ? "flex h-9 w-full items-center justify-between rounded-md bg-[#14253a] px-3 text-left text-xs font-semibold text-[#a8d7ff]"
                  : "flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-xs text-[#a3adbb] hover:bg-white/[0.045] hover:text-white"}
              >
                <span>{item.coin}-PERP</span>
                <span className="font-mono text-[10px] text-[#647286]">{item.max_leverage ? `${item.max_leverage}×` : "—"}</span>
              </button>
            ))}
            {visibleMarkets.length === 0 && (
              <p className="px-3 py-5 text-center text-xs text-[#687385]">No matching market</p>
            )}
          </div>
          {visibleMarkets.length < markets.length && (
            <p className="border-t border-[#202833] px-3 pt-2 text-[10px] text-[#596578]">
              Type to search {markets.length} available markets
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TicketInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">{label}</span>
      <span className="mt-1 flex h-12 items-center rounded-md border border-[#2b3441] bg-[#07090c] px-3 focus-within:border-[#3da8ff]">
        {prefix && <span className="text-[#647083]">{prefix}</span>}
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm text-white outline-none placeholder:text-[#4f5868]"
        />
        {suffix && <span className="text-xs text-[#788395]">{suffix}</span>}
      </span>
    </label>
  );
}

function TicketField({ label, value, readOnly }: { label: string; value: string; readOnly?: boolean }) {
  return (
    <div className="rounded-md border border-[#2b3441] bg-[#07090c] px-3 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#778295]">{label}</p>
      <p className={`mt-1 text-sm ${readOnly ? "text-[#aab4c2]" : "text-white"}`}>{value}</p>
    </div>
  );
}

function ReviewDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#28313d] bg-[#080a0d] px-3 py-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#687587]">{label}</p>
      <p className="mt-1 font-mono text-sm text-[#e1e6ed]">{value}</p>
    </div>
  );
}

export function validatePerpTicket(
  order: PrivateExecutionOrderDraft,
  referencePrice: string | null | undefined,
  maxLeverage: number | null,
  maxSlippagePolicyBps: number,
): string[] {
  const errors = validatePrivateExecutionOrderDraft(order);
  const notional = Number(order.quote_size);
  const reference = Number(referencePrice);
  const stop = Number(order.protective_orders?.stop_loss);
  const takeProfit = Number(order.protective_orders?.take_profit);
  const slippage = Number(order.max_slippage_bps);
  if (Number.isFinite(notional) && notional < 10) errors.unshift("Hyperliquid orders must be at least $10.");
  if (Number.isFinite(notional) && notional > 10) errors.unshift("Orders are capped at $10 during the bounded mainnet launch.");
  if (maxLeverage != null && Number(order.leverage) > maxLeverage) errors.unshift(`This market supports at most ${maxLeverage}× leverage.`);
  if (Number.isFinite(slippage) && slippage > maxSlippagePolicyBps) {
    errors.unshift(`Max slippage is capped at ${maxSlippagePolicyBps} bps for this environment.`);
  }
  if (Number.isFinite(reference) && reference > 0 && Number.isFinite(stop) && stop > 0) {
    if (order.side === "buy" && stop >= reference) errors.unshift("A long stop-loss must be below the current mark price.");
    if (order.side === "sell" && stop <= reference) errors.unshift("A short stop-loss must be above the current mark price.");
  }
  if (Number.isFinite(reference) && reference > 0 && Number.isFinite(takeProfit) && takeProfit > 0) {
    if (order.side === "buy" && takeProfit <= reference) errors.unshift("A long take-profit must be above the current mark price.");
    if (order.side === "sell" && takeProfit >= reference) errors.unshift("A short take-profit must be below the current mark price.");
  }
  return [...new Set(errors)];
}

function perpSafeInput(market: string, amount: string): PrivateAccountSafeInput {
  const notional = Number(amount);
  const buckets = [5, 10, 25, 50, 100, 250, 500, 1_000] as const;
  const bucket = buckets.find((candidate) => candidate >= notional) ?? 1_000;
  const normalized = market.toUpperCase();
  return {
    action_class: "trade_on_platform",
    platform_class: "hyperliquid_style_market",
    product_bucket: "perps",
    amount_bucket: String(bucket) as PrivateAccountSafeInput["amount_bucket"],
    urgency: "fast_degraded",
    destination_class: "platform_subaccount",
    asset_bucket: normalized === "BTC" || normalized === "ETH" || normalized === "SOL" ? normalized : "major",
    solver_count_bucket: "5+",
  };
}

function estimatedPerpSize(amount: string, price: string | null | undefined, market: string): string {
  const notional = Number(amount);
  const reference = Number(price);
  if (!Number.isFinite(notional) || !Number.isFinite(reference) || reference <= 0) return "At venue review";
  return `${formatAssetQuantity(notional / reference, 6)} ${market}`;
}

function estimatedMargin(amount: string, leverage: string): string {
  const notional = Number(amount);
  const multiple = Number(leverage);
  if (!Number.isFinite(notional) || !Number.isFinite(multiple) || multiple <= 0) return "Unavailable";
  return formatCompactUsd(notional / multiple);
}

function friendlyPerpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Hyperliquid order failed.");
  const normalized = raw.toLowerCase();
  if (normalized.includes("insufficient") || normalized.includes("needs_funds")) return "This Hyperliquid account needs enough perp collateral for the order and fees.";
  if (normalized.includes("preview_expired") || normalized.includes("intent_expired")) return "The live review expired. Review the order again.";
  if (normalized.includes("max notional") || normalized.includes("notional cap")) return "This order exceeds the account’s configured trading limit.";
  if (normalized.includes("worker") || normalized.includes("connector")) return "The private execution worker is reconnecting. Your order was not blindly resubmitted.";
  if (normalized.includes("venue_rejected")) return "Hyperliquid rejected the order. Recheck collateral, price, size, and leverage.";
  return raw.replaceAll("_", " ");
}

function PerpDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#252e39] bg-[#090b0f] px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#697587]">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-semibold text-[#d9e1ea] tabular-nums" title={value}>{value}</p>
    </div>
  );
}

function SpreadMetric({
  spreadBps,
  bestBid,
  bestAsk,
}: {
  spreadBps: number | null | undefined;
  bestBid: string | null | undefined;
  bestAsk: string | null | undefined;
}) {
  const previous = useRef<number | null>(null);
  const [movement, setMovement] = useState<"wider" | "tighter" | null>(null);

  useEffect(() => {
    if (spreadBps == null || !Number.isFinite(spreadBps)) return;
    const prior = previous.current;
    previous.current = spreadBps;
    if (prior == null || prior === spreadBps) return;
    setMovement(spreadBps > prior ? "wider" : "tighter");
    const timer = window.setTimeout(() => setMovement(null), 280);
    return () => window.clearTimeout(timer);
  }, [spreadBps]);

  const title = bestBid && bestAsk
    ? `Best bid ${bestBid} · best ask ${bestAsk}`
    : "Order book unavailable";
  return (
    <span
      className={movement === "wider"
        ? "inline-flex min-w-[8.75rem] whitespace-nowrap rounded px-1.5 py-0.5 font-mono tabular-nums text-[#e5c77f] transition-colors duration-300"
        : movement === "tighter"
          ? "inline-flex min-w-[8.75rem] whitespace-nowrap rounded px-1.5 py-0.5 font-mono tabular-nums text-[#7ee0b7] transition-colors duration-300"
          : "inline-flex min-w-[8.75rem] whitespace-nowrap rounded px-1.5 py-0.5 font-mono tabular-nums text-[#8ea0ba] transition-colors duration-300"}
      title={title}
    >
      Spread {spreadBps == null ? "—" : `${spreadBps.toFixed(2)} bps`}
    </span>
  );
}

function AccountActivityPanel({
  tab,
  authenticated,
  state,
  snapshot,
  venueLabel,
  supported,
}: {
  tab: "positions" | "orders" | "activity";
  authenticated: boolean;
  state: "loading" | "ready" | "unavailable";
  snapshot: HyperliquidAccountSnapshot | null;
  venueLabel: string;
  supported: boolean;
}) {
  if (!supported) {
    return <ActivityNotice>No live venue session · activity will appear here after setup.</ActivityNotice>;
  }
  if (!authenticated) {
    return <ActivityNotice>Sign in to load private positions, working orders, and fills.</ActivityNotice>;
  }
  if (state === "loading") {
    return <ActivityNotice>Private {venueLabel} account · syncing…</ActivityNotice>;
  }
  if (state === "unavailable" || !snapshot) {
    return <ActivityNotice>Account data is unavailable. No claim is being made about positions or orders.</ActivityNotice>;
  }
  if (snapshot.status !== "ready_to_trade") {
    return <ActivityNotice>{snapshot.next_step || "Hyperliquid account connection is not verified."}</ActivityNotice>;
  }

  if (tab === "positions") {
    const rows = snapshot.positions ?? [];
    if (rows.length === 0) return <ActivityNotice>Account checked · no open positions.</ActivityNotice>;
    return (
      <div className="mt-3 overflow-x-auto rounded-md border border-[#262d37] bg-[#090b0e]">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="border-b border-[#232a33] text-[#667284]">
            <tr><th className="px-3 py-2 font-medium">Market</th><th className="px-3 py-2 font-medium">Side</th><th className="px-3 py-2 font-medium">Size</th><th className="px-3 py-2 font-medium">Entry</th><th className="px-3 py-2 font-medium">Unrealized P&amp;L</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.position_commitment} className="border-b border-[#1d232b] last:border-0">
                <td className="px-3 py-2.5 font-mono text-white">{row.market}</td>
                <td className={row.side === "long" ? "px-3 py-2.5 text-[#79ddb7]" : "px-3 py-2.5 text-[#f28d95]"}>{row.side}</td>
                <td className="px-3 py-2.5 font-mono text-[#c2cad5]">{row.size_bucket}</td>
                <td className="px-3 py-2.5 font-mono text-[#c2cad5]">{row.entry_price_bucket}</td>
                <td className="px-3 py-2.5 font-mono text-[#c2cad5]">{row.unrealized_pnl_bucket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "orders") {
    const rows = snapshot.open_orders ?? [];
    if (rows.length === 0) return <ActivityNotice>Account checked · no working orders.</ActivityNotice>;
    return (
      <div className="mt-3 overflow-x-auto rounded-md border border-[#262d37] bg-[#090b0e]">
        <table className="w-full min-w-[540px] text-left text-xs">
          <thead className="border-b border-[#232a33] text-[#667284]">
            <tr><th className="px-3 py-2 font-medium">Market</th><th className="px-3 py-2 font-medium">Side</th><th className="px-3 py-2 font-medium">Size</th><th className="px-3 py-2 font-medium">Price</th><th className="px-3 py-2 font-medium">Status</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.order_handle_commitment} className="border-b border-[#1d232b] last:border-0">
                <td className="px-3 py-2.5 font-mono text-white">{row.market}</td>
                <td className="px-3 py-2.5 capitalize text-[#c2cad5]">{row.side}</td>
                <td className="px-3 py-2.5 font-mono text-[#c2cad5]">{row.size_bucket}</td>
                <td className="px-3 py-2.5 font-mono text-[#c2cad5]">{row.price_bucket}</td>
                <td className="px-3 py-2.5 text-[#8fcaff]">{row.status}{row.reduce_only ? " · reduce only" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const fills = snapshot.recent_fills ?? [];
  if (fills.length === 0) return <ActivityNotice>Account checked · no recent fills.</ActivityNotice>;
  return (
    <div className="mt-3 grid gap-1.5">
      {fills.map((fill) => (
        <div key={fill.fill_commitment} className="grid grid-cols-[1fr_auto_auto] gap-3 rounded-md border border-[#242c36] bg-[#090b0e] px-3 py-2.5 text-xs">
          <span className="font-mono text-white">{fill.market}</span>
          <span className="capitalize text-[#9aa6b6]">{fill.side} · {fill.size_bucket}</span>
          <span className="font-mono text-[#c2cad5]">{fill.price_bucket}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 grid min-h-20 place-items-center rounded-md border border-dashed border-[#262d37] bg-[#090b0e] px-4 text-center text-xs text-[#687385]">
      {children}
    </div>
  );
}

function formatFundingRate(value: string | null | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unavailable";
  const sign = number > 0 ? "+" : "";
  return `${sign}${(number * 100).toFixed(4)}%`;
}

function formatPerpValue(value: string | null | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

function normalizePerpMarket(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9_:@.-]{1,48}$/.test(normalized) ? normalized : null;
}

function readStoredTradeProduct(): TradeProduct | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_TRADE_PRODUCT_KEY)
      ?? window.localStorage.getItem("ghola:last-trade-product");
    return TRADE_PRODUCTS.some((item) => item.id === value) ? value as TradeProduct : null;
  } catch {
    return null;
  }
}

function readStoredPerpMarket(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizePerpMarket(
      window.localStorage.getItem(LAST_PERP_MARKET_KEY)
        ?? window.localStorage.getItem("ghola:last-perp-market"),
    );
  } catch {
    return null;
  }
}

function writeStoredPreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are optional when storage is unavailable or restricted.
  }
}

function scheduleAfterPaint(callback: () => void) {
  let timer: number | null = null;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(callback, 0);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (timer != null) window.clearTimeout(timer);
  };
}

function replaceTradeUrlAfterPaint(url: string) {
  scheduleAfterPaint(() => {
    window.history.replaceState(window.history.state, "", url);
  });
}

function CoinbaseTradeReview({
  product,
  side,
  price,
  quoteSize,
  estimatedBase,
  baseSymbol,
  working,
  canConfirm,
  onClose,
  onConfirm,
}: {
  product: CoinbaseProductId;
  side: "buy" | "sell";
  price: string;
  quoteSize: string;
  estimatedBase: number | null;
  baseSymbol: string;
  working: boolean;
  canConfirm: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-end bg-black/75 p-0 backdrop-blur-sm sm:place-items-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !working) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="coinbase-review-title"
        className="w-full overflow-hidden rounded-t-2xl border border-[#2a3952] bg-[#090e16] shadow-2xl sm:max-w-lg sm:rounded-xl"
      >
        <div className="border-b border-[#1d2a40] px-5 py-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#7cf5c6]">
            Final review
          </p>
          <h2 id="coinbase-review-title" className="mt-1 text-2xl font-semibold text-white">
            {side === "buy" ? "Buy" : "Sell"} {product}
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#9fb1ca]">
            One capped spot order. Nothing is sent until you confirm.
          </p>
        </div>
        <div className="grid gap-4 p-5">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#223047] bg-[#223047]">
            <ReviewMetric label="Order size" value={`$${quoteSize}.00`} />
            <ReviewMetric label="Reference price" value={price} />
            <ReviewMetric
              label={`Estimated ${baseSymbol}`}
              value={formatAssetQuantity(estimatedBase)}
            />
            <ReviewMetric label="Order type" value="Market IOC" />
          </div>
          <div className="rounded-lg border border-[#263852] bg-[#0d1521] p-4 text-sm leading-6 text-[#c6d4e7]">
            Ghola enforces the <span className="font-semibold text-white">${quoteSize}</span> cap before routing. Coinbase receives only the
            spot order required for this instruction.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={onClose}
              disabled={working || !canConfirm}
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
              {working ? "Sending securely" : canConfirm ? "Confirm and send" : "Trade not ready"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#080c13] p-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#71829d]">{label}</div>
      <div className="mt-1 font-mono text-base text-white tabular-nums">{value}</div>
    </div>
  );
}

function MarketDatum({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "buy" | "sell" | "neutral";
}) {
  const valueClass = tone === "buy"
    ? "text-emerald-100"
    : tone === "sell" ? "text-rose-100" : "text-[#edf2f8]";
  return (
    <div className="rounded-md border border-[#2c3038] bg-[#0d0f13] px-3 py-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#71829d]">{label}</div>
      <div className={`mt-1 whitespace-nowrap font-mono text-sm font-semibold tabular-nums ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={`mt-2 flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${SURFACE_SUNKEN}`}>
      <span className="min-w-0 text-[#8ea0ba]">{label}</span>
      <span className="max-w-[190px] truncate font-medium text-[#edf2f8]" title={value}>{value}</span>
    </div>
  );
}

function ReadinessRow({ label, ready, value, title }: { label: string; ready: boolean; value: string; title?: string }) {
  return (
    <div className={`flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${SURFACE_SUNKEN}`}>
      <span className="flex min-w-0 items-center gap-2 text-[#cbd7e8]">
        <span className={ready ? "h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(124,245,198,0.45)]" : "h-2 w-2 rounded-full bg-[#47546a]"} />
        {label}
      </span>
      <span className={ready ? "max-w-[170px] truncate text-sm font-medium text-emerald-100" : "max-w-[170px] truncate text-sm text-[#8ea0ba]"} title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

function CommandStatus({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[#24324a] bg-[#090e16] px-2.5">
      <span className={ready ? "h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(124,245,198,0.5)]" : "h-1.5 w-1.5 shrink-0 rounded-full bg-[#526078]"} />
      <span className="hidden text-[10px] font-medium uppercase tracking-[0.1em] text-[#71829d] lg:inline">{label}</span>
      <span className={ready ? "whitespace-nowrap text-xs font-medium text-emerald-100" : "whitespace-nowrap text-xs font-medium text-[#aebbd0]"} title={value}>
        {value}
      </span>
    </div>
  );
}

function Ack({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className={checked ? "flex items-start gap-3 rounded-md border border-emerald-300/25 bg-emerald-300/8 p-3 text-sm text-[#d9e7f5]" : "flex items-start gap-3 rounded-md border border-[#172033] bg-[#05070b] p-3 text-sm text-[#cbd7e8]"}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#7cf5c6]" />
      <span>{label}</span>
    </label>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100">
      {children}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  align = "left",
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  align?: "left" | "right";
  onChange: (value: string) => void;
}) {
  return (
    <div className={align === "right" ? "grid gap-1.5 lg:justify-items-end" : "grid gap-1.5"}>
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={option === value ? "term-chip-on h-8 min-w-14 px-3 text-sm font-medium" : "term-chip h-8 min-w-14 px-3 text-sm font-medium"}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
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
  if (!response.ok) throw new Error("status_unavailable");
  return parsed as T;
}

function formatStatus(status: string, hasMarketData = false) {
  if (status === "live") return "Live";
  if (status === "fallback_polling") return "Live · fallback";
  if (status === "reconnecting") return hasMarketData ? "Live cache · reconnecting" : "Reconnecting";
  if (status === "stale") return "Delayed";
  if (status === "error") return "Feed unavailable";
  return hasMarketData ? "Live cache · refreshing" : "Establishing feed";
}

function short(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}
