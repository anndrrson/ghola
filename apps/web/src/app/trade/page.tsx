"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LockKeyhole,
  Play,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { GholaLogo } from "@/components/GholaLogo";
import {
  buildGholaAgentChartOverlays,
  decimateCandles,
  frameMidNumber,
  gholaFrameFromCoinbase,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaChartCandle,
  type GholaChartOverlay,
  type GholaChartVenue,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";
import {
  createPrivateAccountIntent,
  listPrivateAutopilotSessions,
  previewPrivateAccountAction,
  type HyperliquidMarketSnapshot,
  type PrivateAccountLiveTradingStatus,
  type PrivateAccountSafeInput,
  type PrivateAutopilotSession,
  type PrivateAutopilotStatus,
} from "@/lib/private-account-client";
import type { CoinbaseMarketSnapshot } from "@/lib/coinbase-market-data";
import type { PhoenixMarketSnapshot } from "@/lib/phoenix-market-data";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { handleTwitterSession } from "@/lib/thumper-api";

type VenueId = "hyperliquid" | "phoenix" | "coinbase";
type Side = "buy" | "sell";
type ChartInterval = "1m" | "5m" | "15m" | "1h";

const CHART_INTERVALS: ChartInterval[] = ["1m", "5m", "15m", "1h"];
type EntryTrigger =
  | "preview_now"
  | "break_level"
  | "retest_level"
  | "sweep_reclaim"
  | "book_imbalance"
  | "funding_mark_divergence"
  | "route_edge_threshold"
  | "custom";
type StrategyProfile =
  | "trend_following"
  | "breakout"
  | "reversal"
  | "mean_reversion"
  | "range_trade"
  | "funding_basis"
  | "custom";
type Horizon = "scalp" | "session_trade" | "intraday" | "until_invalidated";
type StopRule =
  | "manual_approval"
  | "take_profit_stop"
  | "trail_after_profit"
  | "exit_on_invalidation";

const VENUES: Array<{
  id: VenueId;
  label: string;
  product: string;
  api: string;
  chartVenue: GholaChartVenue;
}> = [
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    product: "BTC-PERP",
    api: "/v1/private-account/hyperliquid/market-snapshot?coin=BTC",
    chartVenue: "hyperliquid",
  },
  {
    id: "phoenix",
    label: "Phoenix",
    product: "SOL-PERP",
    api: "/v1/private-account/phoenix/market-snapshot?symbol=SOL",
    chartVenue: "phoenix",
  },
  {
    id: "coinbase",
    label: "Coinbase",
    product: "BTC-USD",
    api: "/v1/private-account/coinbase/market-snapshot?product_id=BTC-USD",
    chartVenue: "coinbase",
  },
];

const STRATEGIES: Array<{ id: StrategyProfile; label: string; condition: string }> = [
  { id: "trend_following", label: "Trend follow", condition: "higher high + pullback" },
  { id: "breakout", label: "Breakout", condition: "breaks level with spread ok" },
  { id: "reversal", label: "Reversal", condition: "sweep rejects and reclaims" },
  { id: "mean_reversion", label: "Mean reversion", condition: "returns to marked range" },
  { id: "range_trade", label: "Range fade", condition: "near range edge" },
  { id: "funding_basis", label: "Funding basis", condition: "basis edge >= threshold" },
  { id: "custom", label: "Custom", condition: "custom rule" },
];

const ENTRY_TRIGGERS: Array<{ id: EntryTrigger; label: string }> = [
  { id: "preview_now", label: "Enter now" },
  { id: "break_level", label: "Breaks level" },
  { id: "retest_level", label: "Retests level" },
  { id: "sweep_reclaim", label: "Reclaims level" },
  { id: "book_imbalance", label: "Book shifts" },
  { id: "funding_mark_divergence", label: "Funding edge" },
  { id: "route_edge_threshold", label: "Route improves" },
  { id: "custom", label: "Custom rule" },
];

// How each trigger reads inside the mandate: the chip term, then the
// connective that links it to the entry price.
const TRIGGER_PHRASES: Record<EntryTrigger, { term: string; connective: string }> = {
  preview_now: { term: "enter now", connective: "at" },
  break_level: { term: "enter on a break", connective: "of" },
  retest_level: { term: "enter on a retest", connective: "of" },
  sweep_reclaim: { term: "enter on a reclaim", connective: "of" },
  book_imbalance: { term: "enter on a book shift", connective: "near" },
  funding_mark_divergence: { term: "enter on a funding edge", connective: "near" },
  route_edge_threshold: { term: "enter when the route improves", connective: "near" },
  custom: { term: "enter on a custom rule", connective: "at" },
};

const HORIZONS: Array<{ id: Horizon; label: string }> = [
  { id: "scalp", label: "Scalp" },
  { id: "session_trade", label: "Session" },
  { id: "intraday", label: "Intraday" },
  { id: "until_invalidated", label: "Until invalidated" },
];

const STOP_RULES: Array<{ id: StopRule; label: string }> = [
  { id: "manual_approval", label: "Manual approval" },
  { id: "take_profit_stop", label: "TP / stop" },
  { id: "trail_after_profit", label: "Trail profit" },
  { id: "exit_on_invalidation", label: "Invalidation exit" },
];

// Triggers that are coherent with each trade idea. The first entry is the
// playbook default applied when an idea is chosen manually.
const TRIGGERS_FOR: Record<StrategyProfile, EntryTrigger[]> = {
  trend_following: ["preview_now", "break_level", "retest_level", "book_imbalance", "custom"],
  breakout: ["break_level", "retest_level", "book_imbalance", "custom"],
  reversal: ["sweep_reclaim", "retest_level", "custom"],
  mean_reversion: ["retest_level", "sweep_reclaim", "preview_now", "custom"],
  range_trade: ["retest_level", "sweep_reclaim", "custom"],
  funding_basis: ["funding_mark_divergence", "route_edge_threshold", "custom"],
  custom: [
    "preview_now",
    "break_level",
    "retest_level",
    "sweep_reclaim",
    "book_imbalance",
    "funding_mark_divergence",
    "route_edge_threshold",
    "custom",
  ],
};

const STOP_DEFAULT_PCT = 0.0075;

export default function TradePage() {
  const thumperAuth = useThumperAuth();
  const { setAuth } = thumperAuth;
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [venueId, setVenueId] = useState<VenueId>("hyperliquid");
  const [chartInterval, setChartInterval] = useState<ChartInterval>("5m");
  const [frame, setFrame] = useState<GholaMarketFrame | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<PrivateAccountLiveTradingStatus | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [workerLabel, setWorkerLabel] = useState("checking");
  const [strategy, setStrategy] = useState<StrategyProfile>("trend_following");
  const [entryTrigger, setEntryTrigger] = useState<EntryTrigger>("preview_now");
  const [horizon, setHorizon] = useState<Horizon>("scalp");
  const [stopRule, setStopRule] = useState<StopRule>("manual_approval");
  const [side, setSide] = useState<Side>("buy");
  const [notional, setNotional] = useState(10);
  const [slippageBps, setSlippageBps] = useState(50);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);
  const [entryPinned, setEntryPinned] = useState(false);
  const [stopPrice, setStopPrice] = useState<number | null>(null);
  const [stopPinned, setStopPinned] = useState(false);
  const [ideaManual, setIdeaManual] = useState(false);
  const [triggerManual, setTriggerManual] = useState(false);
  const [stopRuleManual, setStopRuleManual] = useState(false);
  const [preview, setPreview] = useState<
    | { status: "idle" }
    | { status: "working" }
    | { status: "done"; commitment: string }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [bookOpen, setBookOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const venue = VENUES.find((item) => item.id === venueId) ?? VENUES[0];
  const mid = frameMidNumber(frame);
  const [midFlash, setMidFlash] = useState(false);
  const prevMidRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevMidRef.current != null && mid != null && prevMidRef.current !== mid) {
      setMidFlash(true);
      const timer = window.setTimeout(() => setMidFlash(false), 480);
      prevMidRef.current = mid;
      return () => window.clearTimeout(timer);
    }
    prevMidRef.current = mid;
    return undefined;
  }, [mid]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingMarket(true);
      setMarketError(null);
      try {
        const res = await fetch(`${venue.api}&interval=${chartInterval}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`market_${res.status}`);
        const body = await res.json();
        const next =
          venue.id === "hyperliquid"
            ? gholaFrameFromHyperliquid(body as HyperliquidMarketSnapshot)
            : venue.id === "phoenix"
              ? gholaFrameFromPhoenix(body as PhoenixMarketSnapshot)
              : gholaFrameFromCoinbase(body as CoinbaseMarketSnapshot);
        if (!cancelled) setFrame(next);
      } catch {
        if (!cancelled) {
          setFrame(fallbackFrame(venue));
          setMarketError("fallback");
        }
      } finally {
        if (!cancelled) setLoadingMarket(false);
      }
    }
    void load();
    const interval = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [venue, chartInterval]);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const [liveRes, workerRes] = await Promise.all([
          fetch("/v1/private-account/live-trading/status", { cache: "no-store" }),
          fetch("/api/private-agent/status", { cache: "no-store" }),
        ]);
        if (liveRes.ok) {
          const live = (await liveRes.json()) as PrivateAccountLiveTradingStatus;
          if (!cancelled) setLiveStatus(live);
        }
        if (workerRes.ok) {
          const worker = await workerRes.json() as {
            remote_execution_ready?: boolean;
            providers?: Array<{ id: string; evidence?: { cvm_status?: string } }>;
          };
          if (!cancelled) {
            setWorkerReady(worker.remote_execution_ready === true);
            const phala = worker.providers?.find((provider) => provider.id === "phala");
            setWorkerLabel(worker.remote_execution_ready ? "attested" : phala?.evidence?.cvm_status || "off");
          }
        }
      } catch {
        if (!cancelled) setWorkerLabel("unknown");
      }
    }
    void loadStatus();
    const interval = window.setInterval(loadStatus, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!entryPinned && mid) setEntryPrice(mid);
  }, [entryPinned, mid]);

  useEffect(() => {
    setPreview((current) => (current.status === "idle" ? current : { status: "idle" }));
  }, [venueId, side, notional, slippageBps, strategy, entryTrigger, horizon, stopRule, entryPinned, stopPinned]);

  const entryLevel = entryPrice ?? mid;
  const stopLevel = stopPinned && stopPrice != null
    ? stopPrice
    : entryLevel != null
      ? side === "buy"
        ? entryLevel * (1 - STOP_DEFAULT_PCT)
        : entryLevel * (1 + STOP_DEFAULT_PCT)
      : null;

  // The agent reads levels off the chart: once the entry is placed, infer the
  // trade idea and trigger from geometry unless the user has overridden them.
  useEffect(() => {
    if (!entryPinned || entryPrice == null || !mid) return;
    const interp = interpretGeometry({ entry: entryPrice, mid, side, candles: frame?.candles ?? [] });
    if (!interp) return;
    if (!ideaManual && strategy !== interp.strategy) setStrategy(interp.strategy);
    if (!triggerManual && entryTrigger !== interp.trigger) setEntryTrigger(interp.trigger);
  }, [entryPinned, entryPrice, mid, side, frame, ideaManual, triggerManual, strategy, entryTrigger]);

  function handleEntryDrag(price: number) {
    setEntryPinned(true);
    setEntryPrice(price);
  }

  function handleStopChange(price: number) {
    setStopPinned(true);
    setStopPrice(price);
    const entry = entryPrice ?? mid;
    if (entry != null) {
      if (price > entry && side === "buy") setSide("sell");
      if (price < entry && side === "sell") setSide("buy");
    }
    if (!stopRuleManual && stopRule !== "exit_on_invalidation") setStopRule("exit_on_invalidation");
  }

  function selectIdea(id: StrategyProfile) {
    setStrategy(id);
    setIdeaManual(true);
    const allowed = TRIGGERS_FOR[id];
    if (!allowed.includes(entryTrigger)) setEntryTrigger(allowed[0]);
  }

  function selectTrigger(id: EntryTrigger) {
    setEntryTrigger(id);
    setTriggerManual(true);
  }

  const conditionLevel = useMemo(() => {
    const base = entryPrice ?? mid;
    if (!base) return null;
    if (entryTrigger === "preview_now") return null;
    // Level-based triggers watch the level the user actually drew.
    if (entryTrigger === "break_level" || entryTrigger === "retest_level" || entryTrigger === "sweep_reclaim" || entryTrigger === "custom") {
      return base;
    }
    if (entryTrigger === "book_imbalance") return base * (side === "buy" ? 1.0015 : 0.9985);
    if (entryTrigger === "funding_mark_divergence") return base * (side === "buy" ? 0.996 : 1.004);
    return base * (side === "buy" ? 1.0025 : 0.9975);
  }, [entryPrice, entryTrigger, mid, side]);

  const orderDraft = useMemo<PrivateExecutionOrderDraft>(() => {
    const price = entryPrice ?? mid ?? 0;
    return {
      venue_id: venue.id === "coinbase" ? "coinbase_advanced" : venue.id,
      operation_class: venue.id === "coinbase" ? "spot_limit_order" : "limit_order",
      market: venue.product,
      side,
      base_size: venue.id === "hyperliquid" ? "0.001" : "0.01",
      quote_size: String(notional),
      limit_price: price > 0 ? price.toFixed(price >= 1_000 ? 1 : 2) : "",
      max_slippage_bps: String(slippageBps),
      order_type: "limit",
      size_mode: "quote",
      agent_strategy_profile: strategy,
      agent_entry_trigger: entryTrigger,
      agent_exit_rule: stopRule,
      agent_time_horizon: horizon,
      agent_trigger_level: conditionLevel ? conditionLevel.toFixed(conditionLevel >= 1_000 ? 1 : 2) : undefined,
      agent_invalidation_level: stopLevel ? stopLevel.toFixed(stopLevel >= 1_000 ? 1 : 2) : undefined,
      agent_edge_threshold_bps: strategy === "funding_basis" ? "25" : undefined,
      agent_strategy_note: selectedStrategy(STRATEGIES, strategy).condition,
      agent_route_priority: "most_private",
    };
  }, [conditionLevel, entryPrice, entryTrigger, horizon, mid, notional, side, slippageBps, stopLevel, stopRule, strategy, venue]);

  const overlays = useMemo(() => {
    const generated = buildGholaAgentChartOverlays({
      order: orderDraft,
      mid: mid ? String(mid) : null,
      previewCommitment: preview.status === "done" ? preview.commitment : null,
      accountReady: thumperAuth.authenticated,
      venueLabel: venue.label,
    });
    const entry = entryPrice ?? mid;
    return generated.filter((overlay) => {
      // Entry and stop are rendered as draggable lines by the chart itself.
      if (overlay.id === "agent-entry") return false;
      // Drop the condition line when it sits exactly on the drawn entry.
      if (
        overlay.id === "agent-condition-level" &&
        entry != null &&
        overlay.price != null &&
        Math.abs(Number(overlay.price) - entry) <= entry * 0.0001
      ) {
        return false;
      }
      return true;
    });
  }, [entryPrice, mid, orderDraft, preview, thumperAuth.authenticated, venue.label]);

  const safeInput = useMemo<PrivateAccountSafeInput>(() => ({
    action_class: "trade_on_platform",
    platform_class:
      venue.id === "coinbase"
        ? "coinbase_style_provider"
        : venue.id === "phoenix"
          ? "solana_perps_market"
          : "hyperliquid_style_market",
    product_bucket: venue.id === "coinbase" ? "provider" : "perps",
    amount_bucket: (notional === 5 || notional === 10 || notional === 25 ? String(notional) : "10") as PrivateAccountSafeInput["amount_bucket"],
    urgency: "maximum_privacy",
    destination_class: "platform_subaccount",
    asset_bucket: venue.id === "phoenix" ? "SOL" : "BTC",
    solver_count_bucket: "1",
  }), [notional, venue.id]);

  async function handlePreview() {
    if (preview.status === "working") return;
    setPreview({ status: "working" });
    try {
      const intentBody = (await createPrivateAccountIntent(safeInput)) as {
        intent_id?: string;
        intent?: { intent_id?: string };
      };
      const intentId = intentBody.intent_id ?? intentBody.intent?.intent_id;
      if (!intentId) throw new Error("Intent was not created");
      const previewBody = (await previewPrivateAccountAction({
        intent_id: intentId,
        safe_input: safeInput,
      })) as { preview_commitment?: string; preview?: { preview_commitment?: string } };
      const commitment = previewBody.preview_commitment ?? previewBody.preview?.preview_commitment;
      if (!commitment) throw new Error("Preview returned no commitment");
      setPreview({ status: "done", commitment });
    } catch (error) {
      setPreview({
        status: "error",
        message: error instanceof Error ? error.message : "Preview failed",
      });
    }
  }

  const slippageBand = useMemo(() => {
    const price = entryPrice ?? mid;
    if (!price) return "Waiting";
    const upper = price * (1 + slippageBps / 10_000);
    const lower = price * (1 - slippageBps / 10_000);
    return `${formatPrice(lower)} to ${formatPrice(upper)}`;
  }, [entryPrice, mid, slippageBps]);

  const venueLiveStatus = venueStatus(liveStatus, venue.id);
  const readyToPreview = thumperAuth.authenticated && venueLiveStatus === "green";

  const stopDistancePct = entryLevel && stopLevel ? Math.abs(entryLevel - stopLevel) / entryLevel : null;
  const maxLossUsd = stopDistancePct != null ? notional * (stopDistancePct + slippageBps / 10_000) : null;
  const worstFill = entryLevel
    ? side === "buy"
      ? entryLevel * (1 + slippageBps / 10_000)
      : entryLevel * (1 - slippageBps / 10_000)
    : null;


  useEffect(() => {
    if (typeof window === "undefined") return;
    const searchParams = new URLSearchParams(window.location.search);
    const exchangeCode = searchParams.get("code");
    if (!exchangeCode) return;
    fetch("/api/auth/twitter/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: exchangeCode }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Exchange failed");
        return res.json();
      })
      .then((data: { user: { id: string; email: string; name?: string } }) => {
        const res = handleTwitterSession(data.user);
        setAuth(res.user);
      })
      .catch(() => {})
      .finally(() => {
        router.replace("/trade");
      });
  }, [router, setAuth]);

  function openAuth(mode: AuthMode) {
    setAuthMode(mode);
    setAuthOpen(true);
  }

  return (
    <div className="min-h-screen bg-[#05070b] text-[#eef1f8]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo="/trade"
      />
      <header className="relative flex h-14 items-center justify-between border-b border-[#182234] bg-gradient-to-b from-[#0a0e16] to-[#070a10] px-4 sm:px-6">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#5aa7ff]/50 to-transparent"
        />
        <Link href="/" className="flex items-center gap-2">
          <GholaLogo size={26} className="text-[#eef1f8]" />
          <span className="text-lg font-semibold">ghola</span>
        </Link>
        <div className="hidden items-center gap-2 text-xs text-[#8b95a8] md:flex">
          <StatusPill label="Market" value={loadingMarket ? "loading" : marketError ? "fallback" : frame?.stale ? "stale" : "live"} tone={marketError ? "warn" : frame?.stale ? "warn" : "good"} />
          <StatusPill label="BYO live" value={liveStatus?.byo_live_trading_enabled ? "enabled" : "locked"} tone={liveStatus?.byo_live_trading_enabled ? "good" : "warn"} />
          <StatusPill label="Worker" value={workerLabel} tone={workerReady ? "good" : "warn"} />
          <StatusPill label="Pooled" value={liveStatus?.pooled_live_trading_enabled ? "enabled" : "off"} tone={liveStatus?.pooled_live_trading_enabled ? "good" : "warn"} />
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/private-balance"
            className="trade-chip hidden rounded-md px-3 py-1.5 text-sm sm:inline-flex"
          >
            Balance
          </Link>
          {thumperAuth.authenticated ? (
            <span className="rounded-md bg-[#101927] px-3 py-1.5 text-sm text-[#a8d8ff]">
              {thumperAuth.user?.email}
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => openAuth("signin")}
                className="rounded-md px-3 py-1.5 text-sm text-[#8b95a8] transition hover:text-[#eef1f8]"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => openAuth("signup")}
                className="trade-action rounded-md px-3 py-1.5 text-sm font-semibold"
              >
                Get started
              </button>
            </>
          )}
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="min-w-0 border-r border-[#182234]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#182234] px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              {VENUES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setVenueId(item.id);
                    setEntryPinned(false);
                    setStopPinned(false);
                  }}
                  className={`h-9 rounded-md px-3 text-sm font-medium ${
                    venueId === item.id ? "trade-chip-on" : "trade-chip"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {CHART_INTERVALS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={item === chartInterval}
                  onClick={() => setChartInterval(item)}
                  className={`h-8 w-12 rounded-md text-sm tabular-nums ${
                    item === chartInterval ? "trade-chip-on" : "trade-chip"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-[#5aa7ff]/80">{venue.label}</p>
                  <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-[#f6f8ff]">{venue.product}</h1>
                </div>
                <div className="grid grid-cols-2 gap-3 text-right sm:grid-cols-4">
                  <Metric label="Mid" value={formatPrice(mid)} flash={midFlash} />
                  <Metric label="Spread" value={frame?.spreadBps != null ? `${frame.spreadBps.toFixed(2)} bps` : "-"} />
                  <Metric label="Funding" value={formatRate(frame?.fundingRate)} />
                  <Metric label="24h volume" value={formatCompact(frame?.dayVolume)} />
                </div>
              </div>
              <div className="px-3 pb-3 sm:px-6">
                <MarketChart
                  frame={frame}
                  overlays={overlays}
                  side={side}
                  entryPrice={entryLevel}
                  stopPrice={stopLevel}
                  stopSuggested={!stopPinned}
                  onEntryDrag={handleEntryDrag}
                  onStopDrag={handleStopChange}
                />
              </div>
            </div>

            <aside className="border-t border-[#182234] lg:border-l lg:border-t-0">
              <div className="border-b border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent px-4 py-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Agent activity</h2>
              </div>
              <AgentActivity authenticated={thumperAuth.authenticated} onSignIn={() => openAuth("signin")} />
              <button
                type="button"
                aria-expanded={bookOpen}
                onClick={() => setBookOpen((value) => !value)}
                className="flex w-full items-center justify-between border-y border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent px-4 py-3 transition-colors hover:bg-[#0c1220]"
              >
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Order book</h2>
                <ChevronDown className={`h-3.5 w-3.5 text-[#566278] transition-transform ${bookOpen ? "rotate-180" : ""}`} />
              </button>
              {bookOpen ? <BookTable frame={frame} /> : <BookSummary frame={frame} />}
              <div className="border-y border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent px-4 py-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Market tape</h2>
              </div>
              <TradeTape frame={frame} />
            </aside>
          </div>
        </section>

        <aside className="bg-[#070a10]">
          <div className="border-b border-[#182234] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm text-[#a8d8ff]">
                  <SlidersHorizontal className="h-4 w-4" />
                  Trade plan
                </div>
                <p className="mt-1 text-xs text-[#6f7d9a]">{venue.product} agent stack</p>
              </div>
              <ReadinessBadge label={readyToPreview ? "Preview ready" : thumperAuth.authenticated ? "Connect venue" : "Sign in needed"} ready={readyToPreview} />
            </div>

          </div>

          <div className="h-[calc(100vh-12rem)] overflow-y-auto p-5">
            <div className="trade-panel relative rounded-md p-4">
              <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-[9px] font-semibold uppercase tracking-[0.24em] text-[#5aa7ff]/70">Mandate</span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.18em] ${
                    preview.status === "done" ? "text-emerald-300" : "text-[#566278]"
                  }`}
                >
                  {preview.status === "done" ? `sealed · ${preview.commitment.slice(0, 8)}` : "draft"}
                </span>
              </div>
              <div className="grid gap-2 text-[15px] text-[#7b88a1]">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <Token
                  active={openRow === "size"}
                  tone={side === "buy" ? "good" : "bad"}
                  onClick={() => setOpenRow(openRow === "size" ? null : "size")}
                >
                  {side === "buy" ? "Buy" : "Sell"} ${notional}
                </Token>
                <span>of</span>
                <span className="font-medium text-[#eef1f8]">{venue.product}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span>when</span>
                <Token
                  active={openRow === "idea"}
                  auto={!ideaManual}
                  onClick={() => setOpenRow(openRow === "idea" ? null : "idea")}
                >
                  {selectedStrategy(STRATEGIES, strategy).condition}
                </Token>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <Token
                  active={openRow === "trigger"}
                  auto={!triggerManual}
                  onClick={() => setOpenRow(openRow === "trigger" ? null : "trigger")}
                >
                  {TRIGGER_PHRASES[entryTrigger].term}
                </Token>
                <span>{TRIGGER_PHRASES[entryTrigger].connective}</span>
                <Token
                  active={openRow === "entry"}
                  auto={!entryPinned}
                  mono
                  onClick={() => setOpenRow(openRow === "entry" ? null : "entry")}
                >
                  {formatPrice(entryPrice ?? mid)}
                </Token>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <span>stop at</span>
                  <Token
                    active={openRow === "stop"}
                    auto={!stopPinned}
                    tone="bad"
                    mono
                    onClick={() => setOpenRow(openRow === "stop" ? null : "stop")}
                  >
                    {stopLevel ? formatPrice(stopLevel) : "not set"}
                  </Token>
                </span>
                <span className="text-[#3c4961]">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span>slippage ≤</span>
                  <Token
                    active={openRow === "slippage"}
                    tone="warn"
                    mono
                    onClick={() => setOpenRow(openRow === "slippage" ? null : "slippage")}
                  >
                    {slippageBps} bps
                  </Token>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Token
                    active={openRow === "horizon"}
                    onClick={() => setOpenRow(openRow === "horizon" ? null : "horizon")}
                  >
                    {HORIZONS.find((item) => item.id === horizon)?.label ?? horizon}
                  </Token>
                  <span>horizon</span>
                </span>
                <span className="text-[#3c4961]">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Token
                    active={openRow === "stoprule"}
                    auto={!stopRuleManual}
                    onClick={() => setOpenRow(openRow === "stoprule" ? null : "stoprule")}
                  >
                    {(STOP_RULES.find((item) => item.id === stopRule)?.label ?? stopRule).toLowerCase()}
                  </Token>
                  <span>exit</span>
                </span>
              </div>
              </div>
            </div>
            <p className="mt-2.5 text-[11px] leading-5 text-[#566278]">
              Your agent&apos;s read of the plan — tap any highlighted term to change it, or drag the
              lines on the chart.
              <span className="text-emerald-300/80"> Green dots</span> mark what it inferred.
            </p>
            {openRow && (
              <div className="trade-panel mt-4 rounded-md p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#6b7997]">
                    {TOKEN_TITLES[openRow] ?? openRow}
                  </span>
                  <span className="flex items-center gap-3">
                    {openRow === "idea" && ideaManual && (
                      <EditorResetButton onClick={() => setIdeaManual(false)} />
                    )}
                    {openRow === "trigger" && triggerManual && (
                      <EditorResetButton onClick={() => setTriggerManual(false)} />
                    )}
                    {openRow === "entry" && entryPinned && (
                      <EditorResetButton
                        onClick={() => {
                          setEntryPinned(false);
                          if (mid) setEntryPrice(mid);
                        }}
                      />
                    )}
                    {openRow === "stop" && stopPinned && (
                      <EditorResetButton onClick={() => setStopPinned(false)} />
                    )}
                    {openRow === "stoprule" && stopRuleManual && (
                      <EditorResetButton onClick={() => setStopRuleManual(false)} />
                    )}
                    <button
                      type="button"
                      aria-label="Close editor"
                      onClick={() => setOpenRow(null)}
                      className="text-sm leading-none text-[#566278] transition hover:text-[#eef1f8]"
                    >
                      ✕
                    </button>
                  </span>
                </div>

                {openRow === "idea" && (
                  <ButtonGrid items={STRATEGIES} selected={strategy} onSelect={selectIdea} />
                )}
                {openRow === "trigger" && (
                  <ButtonGrid
                    items={ENTRY_TRIGGERS.filter((item) => TRIGGERS_FOR[strategy].includes(item.id))}
                    selected={entryTrigger}
                    onSelect={selectTrigger}
                  />
                )}
                {openRow === "entry" && (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      inputMode="decimal"
                      aria-label="Entry price"
                      value={entryPrice ? String(roundForInput(entryPrice)) : ""}
                      onChange={(event) => {
                        const next = Number(event.target.value.replaceAll(",", ""));
                        setEntryPinned(true);
                        setEntryPrice(Number.isFinite(next) && next > 0 ? next : null);
                      }}
                      className="trade-field h-10 min-w-0 rounded-md px-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setEntryPinned(false);
                        if (mid) setEntryPrice(mid);
                      }}
                      className="trade-chip h-10 rounded-md px-3 text-sm"
                    >
                      Current
                    </button>
                  </div>
                )}
                {openRow === "stop" && (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      inputMode="decimal"
                      aria-label="Stop level"
                      value={stopLevel ? String(roundForInput(stopLevel)) : ""}
                      onChange={(event) => {
                        const next = Number(event.target.value.replaceAll(",", ""));
                        if (Number.isFinite(next) && next > 0) handleStopChange(next);
                      }}
                      className="trade-field h-10 min-w-0 rounded-md px-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setStopPinned(false)}
                      className="trade-chip h-10 rounded-md px-3 text-sm"
                    >
                      Auto
                    </button>
                  </div>
                )}
                {openRow === "size" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {(["buy", "sell"] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => {
                            setSide(item);
                            setStopPinned(false);
                          }}
                          className={`h-10 rounded-md text-sm font-medium capitalize transition-shadow duration-150 ${
                            side === item
                              ? item === "buy"
                                ? "border border-emerald-400/60 bg-gradient-to-b from-emerald-400/20 to-emerald-400/8 text-emerald-200 shadow-[inset_0_1px_0_rgba(110,231,183,0.2),0_0_16px_-6px_rgba(52,211,153,0.5)]"
                                : "border border-rose-400/60 bg-gradient-to-b from-rose-400/20 to-rose-400/8 text-rose-200 shadow-[inset_0_1px_0_rgba(251,113,133,0.2),0_0_16px_-6px_rgba(251,113,133,0.5)]"
                              : "trade-chip"
                          }`}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {[5, 10, 25].map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setNotional(item)}
                          className={`h-9 rounded-md text-sm tabular-nums ${
                            notional === item ? "trade-chip-on" : "trade-chip"
                          }`}
                        >
                          ${item}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {openRow === "slippage" && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {[25, 50, 100].map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setSlippageBps(item)}
                          className={`h-10 rounded-md text-sm tabular-nums transition-shadow duration-150 ${
                            slippageBps === item
                              ? "border border-[#f8e56b]/70 bg-gradient-to-b from-[#332d12] to-[#231f0c] text-[#fff27a] shadow-[inset_0_1px_0_rgba(248,229,107,0.18),0_0_16px_-6px_rgba(248,229,107,0.45)]"
                              : "trade-chip"
                          }`}
                        >
                          {item} bps
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 font-mono text-[11px] tabular-nums text-[#8b95a8]">Band: {slippageBand}</p>
                  </>
                )}
                {openRow === "horizon" && (
                  <ButtonGrid items={HORIZONS} selected={horizon} onSelect={(id) => setHorizon(id)} />
                )}
                {openRow === "stoprule" && (
                  <ButtonGrid
                    items={STOP_RULES}
                    selected={stopRule}
                    onSelect={(id) => {
                      setStopRule(id);
                      setStopRuleManual(true);
                    }}
                  />
                )}
              </div>
            )}

            <div className="mt-6 border-t border-[#141d2e] pt-4">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b7997]">Risk</p>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Stop dist</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-[#eef1f8]">
                    {stopDistancePct != null ? `${(stopDistancePct * 100).toFixed(2)}%` : "-"}
                  </p>
                </div>
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Max loss</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-rose-200">
                    {maxLossUsd != null ? `$${maxLossUsd.toFixed(2)}` : "-"}
                  </p>
                </div>
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Worst fill</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-[#fff27a]">
                    {worstFill != null ? formatPrice(worstFill) : "-"}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[#566278]">
                Max loss assumes the stop fills with the full slippage cap. The agent cannot exceed it.
              </p>
            </div>

            <div className="mt-5 border-t border-[#141d2e] pt-4">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b7997]">Visibility</p>
              <div className="mt-2.5 grid gap-2">
                <VisibilityRow label="Main wallet" value="never exposed" tone="good" />
                <VisibilityRow label="Execution" value="sealed runtime" tone="good" />
                <VisibilityRow label={`${venue.label} sees`} value="venue account + order" tone="warn" />
              </div>
            </div>
          </div>

          <div className="border-t border-[#182234] p-5">
            <div className="grid gap-2">
              {!thumperAuth.authenticated ? (
                <button
                  type="button"
                  onClick={() => openAuth("signup")}
                  className="trade-action flex h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold"
                >
                  <KeyRound className="h-4 w-4" />
                  Sign in to connect venue
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handlePreview}
                    disabled={preview.status === "working"}
                    className="trade-action flex h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-wait disabled:opacity-70"
                  >
                    {preview.status === "working" ? (
                      <RefreshCcw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {preview.status === "working"
                      ? "Sealing preview"
                      : preview.status === "done"
                        ? "Preview again"
                        : "Preview watched plan"}
                  </button>
                  {preview.status === "done" && (
                    <p className="flex items-center gap-1.5 font-mono text-xs text-emerald-200">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Sealed preview {preview.commitment.slice(0, 14)}…
                    </p>
                  )}
                  {preview.status === "error" && (
                    <p className="text-xs leading-5 text-rose-300">{preview.message}</p>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="trade-chip flex h-10 items-center justify-center gap-2 rounded-md text-sm"
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh market
              </button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

const CHART_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

function MarketChart({
  frame,
  overlays,
  side,
  entryPrice,
  stopPrice,
  stopSuggested,
  onEntryDrag,
  onStopDrag,
}: {
  frame: GholaMarketFrame | null;
  overlays: GholaChartOverlay[];
  side: Side;
  entryPrice: number | null;
  stopPrice: number | null;
  stopSuggested: boolean;
  onEntryDrag: (price: number) => void;
  onStopDrag: (price: number) => void;
}) {
  const candles = useMemo(() => decimateCandles(frame?.candles ?? [], 96), [frame]);
  const layoutOverlays = useMemo(() => {
    const extra: GholaChartOverlay[] = [];
    if (entryPrice != null && entryPrice > 0) {
      extra.push({ id: "drag-entry", kind: "price_line", label: "entry", tone: "accent", price: entryPrice });
    }
    if (stopPrice != null && stopPrice > 0) {
      extra.push({ id: "drag-stop", kind: "price_line", label: "stop", tone: "bad", price: stopPrice });
    }
    return overlays.concat(extra);
  }, [overlays, entryPrice, stopPrice]);
  const chart = chartLayout(candles, layoutOverlays);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const [drag, setDrag] = useState<"entry" | "stop" | null>(null);
  const hovered = hover ? candles[hover.index] : null;
  const last = candles.at(-1);
  const lastClose = last ? Number(last.c) : null;
  const lastUp = last ? Number(last.c) >= Number(last.o) : true;
  const lastColor = lastUp ? "#34d399" : "#fb7185";
  const labels = overlayLabelSlots(overlays, chart, side);
  const entryColor = side === "buy" ? "#34d399" : "#fb7185";
  const entryY = entryPrice != null && entryPrice > 0 ? chart.y(entryPrice) : null;
  const stopY = stopPrice != null && stopPrice > 0 ? chart.y(stopPrice) : null;
  const HIT_RADIUS = 12;
  const hoverNearLine =
    hover != null &&
    [entryY, stopY].some((lineY) => lineY != null && Math.abs(hover.y - lineY) <= HIT_RADIUS);

  function svgPoint(event: React.PointerEvent<SVGSVGElement>) {
    // The SVG preserves its viewBox aspect ratio (xMidYMid meet), so the
    // drawing is letterboxed inside the element — map through the real
    // scale and centering offsets or pointer hits land off-target.
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / chart.width, rect.height / chart.height) || 1;
    const offsetX = (rect.width - chart.width * scale) / 2;
    const offsetY = (rect.height - chart.height * scale) / 2;
    return {
      x: (event.clientX - rect.left - offsetX) / scale,
      y: (event.clientY - rect.top - offsetY) / scale,
    };
  }

  function clampPlotY(y: number) {
    return Math.min(chart.height - chart.padding.bottom, Math.max(chart.padding.top, y));
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (candles.length === 0) return;
    const { x, y } = svgPoint(event);
    if (drag) {
      const price = chart.priceAt(clampPlotY(y));
      if (Number.isFinite(price) && price > 0) {
        if (drag === "entry") onEntryDrag(roundForInput(price));
        else onStopDrag(roundForInput(price));
      }
      return;
    }
    const ratio = (x - chart.padding.left) / Math.max(1, chart.plotWidth);
    const index = Math.min(candles.length - 1, Math.max(0, Math.round(ratio * (candles.length - 1))));
    setHover({ index, y: clampPlotY(y) });
  }

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (candles.length === 0) return;
    const { y } = svgPoint(event);
    const nearEntry = entryY != null && Math.abs(y - entryY) <= HIT_RADIUS;
    const nearStop = stopY != null && Math.abs(y - stopY) <= HIT_RADIUS;
    let target: "entry" | "stop" | null = null;
    if (nearEntry && nearStop) {
      target = Math.abs(y - (entryY as number)) <= Math.abs(y - (stopY as number)) ? "entry" : "stop";
    } else if (nearEntry) {
      target = "entry";
    } else if (nearStop) {
      target = "stop";
    }
    if (target) {
      setDrag(target);
      setHover(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }

  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (drag) {
      setDrag(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  return (
    <div className="relative h-[31rem] overflow-hidden rounded-md border border-[#182234] bg-[#05070b]">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className={`h-full w-full touch-none ${drag ? "cursor-grabbing" : hoverNearLine ? "cursor-ns-resize" : "cursor-crosshair"}`}
        role="img"
        aria-label="Trading chart. Drag the entry and stop lines to set levels."
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={(event) => {
          setHover(null);
          handlePointerUp(event);
        }}
      >
        <defs>
          <linearGradient id="tradeBand" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#f8e56b" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f8e56b" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <rect width={chart.width} height={chart.height} fill="#05070b" />
        {chart.timeTicks.map((tick) => (
          <g key={`t-${tick.x}`}>
            <line x1={tick.x} x2={tick.x} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke="#0e1626" strokeWidth="1" />
            <text x={tick.x} y={chart.height - 12} textAnchor="middle" fill="#566278" fontSize="10" fontFamily={CHART_FONT}>
              {tick.label}
            </text>
          </g>
        ))}
        {chart.grid.map((line) => (
          <g key={line.y}>
            <line x1="0" x2={chart.width} y1={line.y} y2={line.y} stroke="#162033" strokeWidth="1" />
            <text x={chart.width - 10} y={line.y - 5} textAnchor="end" fill="#566278" fontSize="11" fontFamily={CHART_FONT}>
              {formatPrice(line.price)}
            </text>
          </g>
        ))}
        {chart.maxVolume > 0 && candles.map((candle, index) => {
          const volume = Number(candle.v);
          if (!Number.isFinite(volume) || volume <= 0) return null;
          const x = chart.x(index);
          const barHeight = Math.max(1, (volume / chart.maxVolume) * 52);
          const up = Number(candle.c) >= Number(candle.o);
          return (
            <rect
              key={`v-${candle.t}-${index}`}
              x={x - chart.candleWidth / 2}
              y={chart.height - chart.padding.bottom - barHeight}
              width={chart.candleWidth}
              height={barHeight}
              fill={up ? "#34d399" : "#fb7185"}
              opacity={hover?.index === index ? 0.42 : 0.16}
            />
          );
        })}
        {candles.map((candle, index) => {
          const x = chart.x(index);
          const open = chart.y(Number(candle.o));
          const close = chart.y(Number(candle.c));
          const high = chart.y(Number(candle.h));
          const low = chart.y(Number(candle.l));
          const up = Number(candle.c) >= Number(candle.o);
          const dimmed = hover != null && hover.index !== index;
          return (
            <g key={`${candle.t}-${index}`} opacity={dimmed ? 0.62 : 1}>
              <line x1={x} x2={x} y1={high} y2={low} stroke={up ? "#62d6a3" : "#f59aa0"} strokeWidth="1.4" />
              <rect
                x={x - chart.candleWidth / 2}
                y={Math.min(open, close)}
                width={chart.candleWidth}
                height={Math.max(2, Math.abs(close - open))}
                fill={up ? "#58d99a" : "#f08a93"}
                rx="1"
              />
            </g>
          );
        })}
        {overlays.map((overlay) => (
          <OverlaySvg key={overlay.id} overlay={overlay} chart={chart} side={side} />
        ))}
        {labels.map((label) => (
          <Label key={label.id} x={28} y={label.y} color={label.color} text={label.text} />
        ))}
        {stopY != null && (
          <g opacity={stopSuggested ? 0.6 : 1}>
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={stopY} y2={stopY} stroke="#fb7185" strokeWidth="1.4" strokeDasharray="5 5" />
            <DragGrip y={stopY} chart={chart} color="#fb7185" />
            <Label x={28} y={stopY + 16} color="#fb7185" text={stopSuggested ? "stop · auto · drag" : "stop · drag"} />
            {stopPrice != null && <PriceTag y={stopY} chart={chart} color="#fb7185" text={formatPrice(stopPrice)} />}
          </g>
        )}
        {entryY != null && (
          <g>
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={entryY} y2={entryY} stroke={entryColor} strokeWidth="1.6" />
            <DragGrip y={entryY} chart={chart} color={entryColor} />
            <Label x={28} y={entryY - 10} color={entryColor} text={`${side} entry · drag`} />
            {entryPrice != null && <PriceTag y={entryY} chart={chart} color={entryColor} text={formatPrice(entryPrice)} />}
          </g>
        )}
        {lastClose != null && (
          <g>
            <line
              x1="0"
              x2={chart.width - chart.padding.right + 4}
              y1={chart.y(lastClose)}
              y2={chart.y(lastClose)}
              stroke={lastColor}
              strokeWidth="1"
              strokeDasharray="2 4"
              opacity="0.85"
            />
            <PriceTag y={chart.y(lastClose)} chart={chart} color={lastColor} text={formatPrice(lastClose)} solid />
          </g>
        )}
        {hover && hovered && (
          <g>
            <line
              x1={chart.x(hover.index)}
              x2={chart.x(hover.index)}
              y1={chart.padding.top}
              y2={chart.height - chart.padding.bottom}
              stroke="#3a4a64"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={hover.y} y2={hover.y} stroke="#3a4a64" strokeWidth="1" strokeDasharray="4 4" />
            <PriceTag y={hover.y} chart={chart} color="#8fa3c4" text={formatPrice(chart.priceAt(hover.y))} />
            <TimeTag x={chart.x(hover.index)} chart={chart} text={formatChartTime(hovered.t)} />
          </g>
        )}
      </svg>
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-md border border-[#1e2a3a] bg-[#070a10]/82 px-3 py-2 font-mono text-xs text-[#aab5c8] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)] backdrop-blur-sm">
        <Activity className="h-4 w-4 text-[#5aa7ff]" />
        {frame?.product ?? "Loading"} {frame?.interval ? `/ ${frame.interval}` : ""}
      </div>
      {hovered && (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-md border border-[#1e2a3a] bg-[#070a10]/88 px-3 py-2 font-mono text-[11px] tabular-nums text-[#aab5c8] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)] backdrop-blur-sm">
          <OhlcStat label="O" value={formatPrice(Number(hovered.o))} />
          <OhlcStat label="H" value={formatPrice(Number(hovered.h))} />
          <OhlcStat label="L" value={formatPrice(Number(hovered.l))} />
          <OhlcStat
            label="C"
            value={formatPrice(Number(hovered.c))}
            color={Number(hovered.c) >= Number(hovered.o) ? "#62d6a3" : "#f59aa0"}
          />
          {Number(hovered.v) > 0 && <OhlcStat label="V" value={formatCompact(hovered.v)} />}
        </div>
      )}
      <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
    </div>
  );
}

function DragGrip({ y, chart, color }: { y: number; chart: ReturnType<typeof chartLayout>; color: string }) {
  const x = chart.width - chart.padding.right - 34;
  return (
    <g>
      <rect x={x} y={y - 7} width="26" height="14" fill="#070a10" stroke={color} strokeOpacity="0.7" rx="3" />
      <line x1={x + 6} x2={x + 20} y1={y - 2.5} y2={y - 2.5} stroke={color} strokeWidth="1.2" />
      <line x1={x + 6} x2={x + 20} y1={y + 2.5} y2={y + 2.5} stroke={color} strokeWidth="1.2" />
    </g>
  );
}

function OhlcStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[#566278]">{label}</span>
      <span style={color ? { color } : undefined} className={color ? undefined : "text-[#eef1f8]"}>{value}</span>
    </span>
  );
}

function PriceTag({
  y,
  chart,
  color,
  text,
  solid,
}: {
  y: number;
  chart: ReturnType<typeof chartLayout>;
  color: string;
  text: string;
  solid?: boolean;
}) {
  const x = chart.width - chart.padding.right + 4;
  const tagWidth = chart.padding.right - 6;
  return (
    <g>
      <rect x={x} y={y - 10} width={tagWidth} height="20" fill={solid ? color : "#0b1322"} stroke={color} strokeWidth="1" rx="2" />
      <text
        x={x + tagWidth / 2}
        y={y + 4}
        textAnchor="middle"
        fill={solid ? "#05070b" : color}
        fontSize="11"
        fontWeight={solid ? 700 : 400}
        fontFamily={CHART_FONT}
      >
        {text}
      </text>
    </g>
  );
}

function TimeTag({ x, chart, text }: { x: number; chart: ReturnType<typeof chartLayout>; text: string }) {
  const width = 52;
  const left = Math.min(chart.width - chart.padding.right - width, Math.max(2, x - width / 2));
  return (
    <g>
      <rect x={left} y={chart.height - chart.padding.bottom + 4} width={width} height="18" fill="#0b1322" stroke="#3a4a64" strokeWidth="1" rx="2" />
      <text x={left + width / 2} y={chart.height - chart.padding.bottom + 17} textAnchor="middle" fill="#8fa3c4" fontSize="10" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}

function OverlaySvg({
  overlay,
  chart,
  side,
}: {
  overlay: GholaChartOverlay;
  chart: ReturnType<typeof chartLayout>;
  side: Side;
}) {
  const color = overlayColor(overlay, side);
  if (overlay.kind === "price_band" && overlay.price && overlay.priceEnd) {
    const y1 = chart.y(overlay.price);
    const y2 = chart.y(overlay.priceEnd);
    return (
      <g>
        <rect x="0" y={Math.min(y1, y2)} width={chart.width} height={Math.abs(y2 - y1)} fill="url(#tradeBand)" />
        <line x1="0" x2={chart.width} y1={y1} y2={y1} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
        <line x1="0" x2={chart.width} y1={y2} y2={y2} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
      </g>
    );
  }
  if (!overlay.price) return null;
  const y = chart.y(overlay.price);
  return (
    <line
      x1="0"
      x2={chart.width}
      y1={y}
      y2={y}
      stroke={color}
      strokeWidth="1.2"
      strokeDasharray={overlay.id === "agent-entry" ? undefined : "7 7"}
    />
  );
}

function overlayColor(overlay: GholaChartOverlay, side: Side) {
  if (overlay.id === "agent-entry") return side === "buy" ? "#34d399" : "#fb7185";
  return overlay.tone === "warn" ? "#f8e56b" : overlay.tone === "good" ? "#62d6a3" : "#9ccfff";
}

function overlayLabelSlots(
  overlays: GholaChartOverlay[],
  chart: ReturnType<typeof chartLayout>,
  side: Side,
) {
  const entries = overlays
    .filter((overlay) => overlay.price != null)
    .map((overlay) => {
      const anchorPrice =
        overlay.kind === "price_band" && overlay.priceEnd
          ? Math.max(Number(overlay.price), Number(overlay.priceEnd))
          : Number(overlay.price);
      return {
        id: overlay.id,
        text: overlay.id === "agent-entry" ? `${side} entry` : overlay.label,
        color: overlayColor(overlay, side),
        y: chart.y(anchorPrice) + (overlay.kind === "price_band" ? 16 : -8),
      };
    })
    .sort((a, b) => a.y - b.y);
  let previous = chart.padding.top - 10;
  for (const entry of entries) {
    entry.y = Math.max(entry.y, previous + 24);
    previous = entry.y;
  }
  return entries;
}

function Label({ x, y, color, text }: { x: number; y: number; color: string; text: string }) {
  return (
    <g>
      <rect x={x - 8} y={y - 14} width={Math.max(80, text.length * 6.8 + 16)} height="20" fill="#070a10" fillOpacity="0.92" stroke={color} rx="2" />
      <text x={x} y={y} fill={color} fontSize="11" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}

function BookSummary({ frame }: { frame: GholaMarketFrame | null }) {
  const bids = (frame?.bids ?? []).slice(0, 5);
  const asks = (frame?.asks ?? []).slice(0, 5);
  const bidTotal = bids.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const askTotal = asks.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const total = bidTotal + askTotal;
  const bidShare = total > 0 ? (bidTotal / total) * 100 : 50;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between font-mono text-xs tabular-nums">
        <span className="text-emerald-300">{frame?.bestBid ? formatPrice(Number(frame.bestBid)) : "-"}</span>
        <span className="text-sm text-[#eef1f8]">{formatPrice(frameMidNumber(frame))}</span>
        <span className="text-rose-300">{frame?.bestAsk ? formatPrice(Number(frame.bestAsk)) : "-"}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rose-400/25">
        <div
          className="h-full rounded-full bg-emerald-400/60 transition-[width] duration-500"
          style={{ width: `${bidShare}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[#566278]">
        <span>bids {Math.round(bidShare)}%</span>
        <span>asks {Math.round(100 - bidShare)}%</span>
      </div>
    </div>
  );
}

function BookTable({ frame }: { frame: GholaMarketFrame | null }) {
  const asks = (frame?.asks ?? []).slice(0, 5).reverse();
  const bids = (frame?.bids ?? []).slice(0, 5);
  const maxSize = Math.max(
    1e-9,
    ...[...asks, ...bids].map((level) => Number(level.sz)).filter(Number.isFinite),
  );
  return (
    <div className="px-4 py-3 font-mono text-xs">
      <div className="grid grid-cols-2 pb-2 text-[10px] uppercase tracking-[0.16em] text-[#566278]">
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>
      {asks.map((level, index) => (
        <BookRow key={`ask-${index}`} price={level.px} size={level.sz} tone="ask" maxSize={maxSize} />
      ))}
      <div className="my-2 rounded border border-[#1e2a3a] bg-[#111a28] px-2 py-1 text-center text-sm tabular-nums text-[#eef1f8] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)]">
        {formatPrice(frameMidNumber(frame))}
      </div>
      {bids.map((level, index) => (
        <BookRow key={`bid-${index}`} price={level.px} size={level.sz} tone="bid" maxSize={maxSize} />
      ))}
    </div>
  );
}

function BookRow({
  price,
  size,
  tone,
  maxSize,
}: {
  price: string;
  size: string;
  tone: "bid" | "ask";
  maxSize: number;
}) {
  const width = Math.min(100, Math.max(4, (Number(size) / maxSize) * 100));
  const color = tone === "bid" ? "#34d399" : "#fb7185";
  return (
    <div className="relative grid grid-cols-2 overflow-hidden rounded-sm px-1 py-1 transition-colors duration-100 hover:bg-[#0f1a2c]">
      <span
        aria-hidden
        className="absolute inset-y-0 right-0 opacity-15"
        style={{ width: `${width}%`, background: `linear-gradient(270deg, ${color}, transparent)` }}
      />
      <span className={`relative tabular-nums ${tone === "bid" ? "text-emerald-300" : "text-rose-300"}`}>{formatPrice(Number(price))}</span>
      <span className="relative text-right tabular-nums text-[#8b95a8]">{Number(size).toFixed(4)}</span>
    </div>
  );
}

function TradeTape({ frame }: { frame: GholaMarketFrame | null }) {
  return (
    <div className="px-4 py-3 font-mono text-xs">
      {(frame?.trades ?? []).slice(0, 6).map((trade, index) => (
        <div
          key={`${trade.time}-${index}`}
          className="grid grid-cols-3 py-1 tabular-nums"
          style={{ opacity: Math.max(0.4, 1 - index * 0.06) }}
        >
          <span className={trade.side === "buy" ? "text-emerald-300" : "text-rose-300"}>{trade.side}</span>
          <span className="text-right text-[#eef1f8]">{formatPrice(Number(trade.px))}</span>
          <span className="text-right text-[#8b95a8]">{Number(trade.sz).toFixed(4)}</span>
        </div>
      ))}
    </div>
  );
}

function AgentActivity({
  authenticated,
  onSignIn,
}: {
  authenticated: boolean;
  onSignIn: () => void;
}) {
  const [sessions, setSessions] = useState<PrivateAutopilotSession[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!authenticated) {
      setSessions(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const body = await listPrivateAutopilotSessions();
        if (!cancelled) {
          setSessions(body.autopilot_sessions ?? []);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authenticated]);

  if (!authenticated) {
    return (
      <div className="px-4 py-4">
        <p className="text-xs leading-5 text-[#566278]">
          Your agent&apos;s sessions, decisions, and orders show up here.
        </p>
        <button type="button" onClick={onSignIn} className="trade-chip mt-2 h-8 rounded-md px-3 text-xs">
          Sign in to view
        </button>
      </div>
    );
  }
  if (failed) {
    return <p className="px-4 py-4 text-xs text-[#566278]">Agent activity is unavailable right now.</p>;
  }
  if (sessions == null) {
    return <p className="px-4 py-4 text-xs text-[#566278]">Checking agent sessions...</p>;
  }
  if (sessions.length === 0) {
    return (
      <p className="px-4 py-4 text-xs leading-5 text-[#566278]">
        No agent sessions yet. Draw your levels on the chart and preview the plan to arm one.
      </p>
    );
  }
  const shown = [...sessions]
    .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
    .slice(0, 5);
  return (
    <div className="grid gap-2 px-4 py-3">
      {shown.map((session) => (
        <div key={session.autopilot_session_id} className="rounded-md border border-[#1e2a3a] bg-[#090d14] px-3 py-2 shadow-[inset_0_1px_0_rgba(220,238,255,0.04)]">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium capitalize text-[#eef1f8]">
              <span aria-hidden className={`trade-live-dot h-1.5 w-1.5 rounded-full ${autopilotStatusDot(session.status)}`} />
              {session.status.replaceAll("_", " ")}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[#566278]">{formatAgo(session.updated_at)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#8b95a8]">
            <span className="shrink-0 font-mono tabular-nums">
              {session.order_count} order{session.order_count === 1 ? "" : "s"}
            </span>
            <span className="truncate text-right">{session.next_step}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function autopilotStatusDot(status: PrivateAutopilotStatus) {
  if (status === "running" || status === "watching") {
    return "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]";
  }
  if (status === "armed") return "bg-[#5aa7ff] shadow-[0_0_8px_rgba(90,167,255,0.8)]";
  if (status === "paused" || status === "pending_worker" || status === "pending_funding") {
    return "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  }
  return "bg-[#566278]";
}

function formatAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ButtonGrid<T extends string>({
  items,
  selected,
  onSelect,
}: {
  items: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={`min-h-10 rounded-md px-3 py-1.5 text-sm font-medium ${
            selected === item.id ? "trade-chip-on" : "trade-chip"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const TOKEN_TITLES: Record<string, string> = {
  size: "Side & size",
  idea: "Trade idea",
  trigger: "Entry trigger",
  entry: "Entry price",
  stop: "Stop level",
  slippage: "Slippage cap",
  horizon: "Horizon",
  stoprule: "Stop rule",
};

// An editable term inside the mandate sentence, styled as an inline chip:
// soft fill, border, and a caret so it unmistakably reads as a control.
// The dot marks values the agent inferred from the chart.
function Token({
  active,
  auto,
  tone,
  mono,
  onClick,
  children,
}: {
  active: boolean;
  auto?: boolean;
  tone?: "good" | "bad" | "warn";
  mono?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const color =
    tone === "good"
      ? "border-emerald-300/30 bg-emerald-300/8 text-emerald-200 hover:border-emerald-300/60 hover:bg-emerald-300/15"
      : tone === "bad"
        ? "border-rose-300/30 bg-rose-300/8 text-rose-200 hover:border-rose-300/60 hover:bg-rose-300/15"
        : tone === "warn"
          ? "border-[#f8e56b]/30 bg-[#f8e56b]/8 text-[#fff27a] hover:border-[#f8e56b]/60 hover:bg-[#f8e56b]/15"
          : "border-[#5aa7ff]/30 bg-[#5aa7ff]/8 text-[#cfe2ff] hover:border-[#5aa7ff]/60 hover:bg-[#5aa7ff]/15";
  return (
    <button
      type="button"
      aria-expanded={active}
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 transition-colors duration-100 ${color} ${
        mono ? "font-mono tabular-nums" : ""
      } ${active ? "shadow-[0_0_0_1px_rgba(90,167,255,0.35),0_0_14px_-4px_rgba(90,167,255,0.5)]" : ""}`}
    >
      {auto && (
        <span
          aria-hidden
          title="Read by the agent from your chart"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]"
        />
      )}
      {children}
      <ChevronDown
        aria-hidden
        className={`h-3 w-3 shrink-0 opacity-50 transition-transform ${active ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function VisibilityRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[#7b88a1]">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-mono ${
          tone === "good" ? "text-emerald-200" : "text-amber-200"
        }`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            tone === "good"
              ? "bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]"
              : "bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.7)]"
          }`}
        />
        {value}
      </span>
    </div>
  );
}

function EditorResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300/80 transition hover:text-emerald-200"
    >
      ↺ agent read
    </button>
  );
}

function Metric({ label, value, flash }: { label: string; value: string; flash?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#566278]">{label}</p>
      <p className={`mt-1 font-mono text-sm tabular-nums text-[#eef1f8] ${flash ? "trade-price-flash" : ""}`}>{value}</p>
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
  tone: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : tone === "bad"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100";
  const dot =
    tone === "good"
      ? "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]"
      : tone === "bad"
        ? "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.8)]"
        : "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${color}`}>
      <span aria-hidden className={`trade-live-dot h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-[#8b95a8]">{label}</span>
      {value}
    </span>
  );
}

function ReadinessBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
      ready
        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100"
    }`}>
      {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <LockKeyhole className="h-3.5 w-3.5" />}
      {label}
    </div>
  );
}

function chartLayout(candles: GholaChartCandle[], overlays: GholaChartOverlay[]) {
  const width = 980;
  const height = 520;
  const padding = { top: 28, right: 74, bottom: 34, left: 18 };
  const candlePrices = candles.flatMap((candle) => [Number(candle.h), Number(candle.l), Number(candle.o), Number(candle.c)]);
  const overlayPrices = overlays.flatMap((overlay) => [overlay.price, overlay.priceEnd].map((value) => Number(value)).filter(Number.isFinite));
  const prices = [...candlePrices, ...overlayPrices].filter((price) => Number.isFinite(price) && price > 0);
  const fallbackMid = 100;
  const rangePrices = prices.length > 0 ? prices : [fallbackMid];
  const minRaw = Math.min(...rangePrices);
  const maxRaw = Math.max(...rangePrices);
  const pad = Math.max((maxRaw - minRaw) * 0.16, maxRaw * 0.002);
  const min = minRaw - pad;
  const max = maxRaw + pad;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const candleWidth = Math.max(3, Math.min(9, plotWidth / Math.max(1, candles.length) * 0.58));
  const y = (price: number) => padding.top + ((max - price) / Math.max(1e-9, max - min)) * plotHeight;
  const x = (index: number) => padding.left + (index / Math.max(1, candles.length - 1)) * plotWidth;
  const priceAt = (yPos: number) => max - ((yPos - padding.top) / Math.max(1e-9, plotHeight)) * (max - min);
  const grid = Array.from({ length: 6 }, (_, index) => {
    const price = min + ((max - min) * index) / 5;
    return { price, y: y(price) };
  });
  const tickCount = Math.min(6, Math.max(2, candles.length));
  const timeTicks = candles.length > 1
    ? Array.from(new Set(Array.from({ length: tickCount }, (_, index) =>
        Math.round((index * (candles.length - 1)) / (tickCount - 1))))).map((index) => ({
        x: x(index),
        label: formatChartTime(candles[index].t),
      }))
    : [];
  const maxVolume = Math.max(0, ...candles.map((candle) => Number(candle.v)).filter(Number.isFinite));
  return { width, height, padding, plotWidth, plotHeight, y, x, priceAt, candleWidth, grid, timeTicks, maxVolume };
}

function formatChartTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function selectedStrategy<T extends { id: string }>(items: T[], id: string): T {
  return items.find((item) => item.id === id) ?? items[0];
}

// Reads trade intent off the chart geometry: where the entry sits relative
// to the live price and the recent range decides what kind of trade this is.
function interpretGeometry(input: {
  entry: number;
  mid: number;
  side: Side;
  candles: GholaChartCandle[];
}): { strategy: StrategyProfile; trigger: EntryTrigger } | null {
  const { entry, mid, side, candles } = input;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mid) || mid <= 0) return null;
  const recent = candles.slice(-60);
  const highs = recent.map((candle) => Number(candle.h)).filter(Number.isFinite);
  const lows = recent.map((candle) => Number(candle.l)).filter(Number.isFinite);
  const rangeHigh = highs.length > 0 ? Math.max(...highs) : mid;
  const rangeLow = lows.length > 0 ? Math.min(...lows) : mid;
  const span = Math.max(rangeHigh - rangeLow, mid * 0.001);
  const tolerance = mid * 0.0012;
  if (Math.abs(entry - mid) <= tolerance) {
    return { strategy: "trend_following", trigger: "preview_now" };
  }
  if (side === "buy") {
    if (entry > mid) return { strategy: "breakout", trigger: "break_level" };
    if (entry <= rangeLow + span * 0.05) return { strategy: "reversal", trigger: "sweep_reclaim" };
    if (entry <= rangeLow + span * 0.4) return { strategy: "range_trade", trigger: "retest_level" };
    return { strategy: "mean_reversion", trigger: "retest_level" };
  }
  if (entry < mid) return { strategy: "breakout", trigger: "break_level" };
  if (entry >= rangeHigh - span * 0.05) return { strategy: "reversal", trigger: "sweep_reclaim" };
  if (entry >= rangeHigh - span * 0.4) return { strategy: "range_trade", trigger: "retest_level" };
  return { strategy: "mean_reversion", trigger: "retest_level" };
}

function entryTriggerLabel(trigger: EntryTrigger) {
  return ENTRY_TRIGGERS.find((item) => item.id === trigger)?.label ?? "Enter now";
}

function venueStatus(status: PrivateAccountLiveTradingStatus | null, venue: VenueId) {
  if (!status) return "unknown";
  const id = venue === "coinbase" ? "coinbase" : venue;
  return status.byo_live_venues.find((item) => item.id === id)?.status ?? "unknown";
}

function formatPrice(value: number | string | null | undefined) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(number) || !number) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: number >= 1_000 ? 1 : 2,
    maximumFractionDigits: number >= 1_000 ? 1 : 4,
  }).format(number);
}

function roundForInput(value: number) {
  return value >= 1_000 ? Number(value.toFixed(1)) : Number(value.toFixed(2));
}

function formatRate(value: string | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${(number * 100).toFixed(4)}%`;
}

function formatCompact(value: string | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

function fallbackFrame(venue: typeof VENUES[number]): GholaMarketFrame {
  const now = Date.now();
  const base = venue.id === "phoenix" ? 158 : 63_500;
  const candles = Array.from({ length: 90 }, (_, index) => {
    const t = now - (90 - index) * 300_000;
    const wave = Math.sin(index / 6) * base * 0.006 + Math.cos(index / 13) * base * 0.004;
    const close = base + wave - index * base * 0.00008;
    const open = close + Math.sin(index) * base * 0.0015;
    const high = Math.max(open, close) + base * 0.002;
    const low = Math.min(open, close) - base * 0.002;
    return {
      t,
      T: t + 299_999,
      o: open.toFixed(2),
      h: high.toFixed(2),
      l: low.toFixed(2),
      c: close.toFixed(2),
      v: String(20 + index),
      n: 4,
    };
  });
  const mid = Number(candles.at(-1)?.c ?? base);
  return {
    version: 1,
    venue: venue.chartVenue,
    product: venue.product,
    interval: "5m",
    fetchedAt: new Date(now).toISOString(),
    stale: true,
    mid: String(mid),
    bestBid: String(mid * 0.9999),
    bestAsk: String(mid * 1.0001),
    spreadBps: 2,
    markPrice: String(mid),
    oraclePrice: String(mid),
    fundingRate: "0.00001",
    openInterest: null,
    dayVolume: "1000000000",
    candles,
    bids: Array.from({ length: 12 }, (_, index) => ({
      px: (mid * (1 - (index + 1) * 0.0002)).toFixed(2),
      sz: (0.2 + index * 0.04).toFixed(4),
      n: 2,
    })),
    asks: Array.from({ length: 12 }, (_, index) => ({
      px: (mid * (1 + (index + 1) * 0.0002)).toFixed(2),
      sz: (0.18 + index * 0.04).toFixed(4),
      n: 2,
    })),
    trades: Array.from({ length: 12 }, (_, index) => ({
      side: index % 2 === 0 ? "buy" : "sell",
      px: (mid * (1 + Math.sin(index) * 0.0004)).toFixed(2),
      sz: (0.01 + index * 0.002).toFixed(4),
      time: now - index * 12_000,
    })),
    routeQuotes: [],
  };
}
