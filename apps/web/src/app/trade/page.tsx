"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  Pause,
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
import type {
  HyperliquidMarketSnapshot,
  PrivateAccountLiveTradingStatus,
} from "@/lib/private-account-client";
import type { CoinbaseMarketSnapshot } from "@/lib/coinbase-market-data";
import type { PhoenixMarketSnapshot } from "@/lib/phoenix-market-data";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { handleTwitterSession } from "@/lib/thumper-api";

type VenueId = "hyperliquid" | "phoenix" | "coinbase";
type Side = "buy" | "sell";
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
    api: "/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=5m",
    chartVenue: "hyperliquid",
  },
  {
    id: "phoenix",
    label: "Phoenix",
    product: "SOL-PERP",
    api: "/v1/private-account/phoenix/market-snapshot?symbol=SOL&interval=5m",
    chartVenue: "phoenix",
  },
  {
    id: "coinbase",
    label: "Coinbase",
    product: "BTC-USD",
    api: "/v1/private-account/coinbase/market-snapshot?product_id=BTC-USD&interval=5m",
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

export default function TradePage() {
  const thumperAuth = useThumperAuth();
  const { setAuth } = thumperAuth;
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [venueId, setVenueId] = useState<VenueId>("hyperliquid");
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
  const [agentRunning, setAgentRunning] = useState(false);
  const venue = VENUES.find((item) => item.id === venueId) ?? VENUES[0];
  const mid = frameMidNumber(frame);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingMarket(true);
      setMarketError(null);
      try {
        const res = await fetch(venue.api, { cache: "no-store" });
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
  }, [venue]);

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

  const conditionLevel = useMemo(() => {
    const base = entryPrice ?? mid;
    if (!base) return null;
    if (entryTrigger === "preview_now") return null;
    if (entryTrigger === "retest_level") return base * (side === "buy" ? 0.9975 : 1.0025);
    if (entryTrigger === "sweep_reclaim") return base * (side === "buy" ? 0.995 : 1.005);
    if (entryTrigger === "book_imbalance") return base * (side === "buy" ? 1.0015 : 0.9985);
    if (entryTrigger === "funding_mark_divergence") return base * (side === "buy" ? 0.996 : 1.004);
    if (entryTrigger === "route_edge_threshold") return base * (side === "buy" ? 1.0025 : 0.9975);
    return base * (side === "buy" ? 1.005 : 0.995);
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
      agent_edge_threshold_bps: strategy === "funding_basis" ? "25" : undefined,
      agent_strategy_note: selectedStrategy(STRATEGIES, strategy).condition,
      agent_route_priority: "most_private",
    };
  }, [conditionLevel, entryPrice, entryTrigger, horizon, mid, notional, side, slippageBps, stopRule, strategy, venue]);

  const overlays = useMemo(() => buildGholaAgentChartOverlays({
    order: orderDraft,
    mid: mid ? String(mid) : null,
    accountReady: thumperAuth.authenticated,
    venueLabel: venue.label,
  }), [mid, orderDraft, thumperAuth.authenticated, venue.label]);

  const slippageBand = useMemo(() => {
    const price = entryPrice ?? mid;
    if (!price) return "Waiting";
    const upper = price * (1 + slippageBps / 10_000);
    const lower = price * (1 - slippageBps / 10_000);
    return `${formatPrice(lower)} to ${formatPrice(upper)}`;
  }, [entryPrice, mid, slippageBps]);

  const venueLiveStatus = venueStatus(liveStatus, venue.id);
  const readyToPreview = thumperAuth.authenticated && venueLiveStatus === "green";

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
      <header className="flex h-14 items-center justify-between border-b border-[#182234] bg-[#070a10] px-4 sm:px-6">
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
            className="hidden rounded-md border border-[#1e2a3a] px-3 py-1.5 text-sm text-[#aab5c8] transition hover:border-[#34506f] hover:text-[#eef1f8] sm:inline-flex"
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
                className="rounded-md bg-[#5aa7ff] px-3 py-1.5 text-sm font-medium text-[#07101c] transition hover:bg-[#7bb9ff]"
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
                  }}
                  className={`h-9 rounded-md border px-3 text-sm font-medium transition ${
                    venueId === item.id
                      ? "border-[#5aa7ff]/60 bg-[#132338] text-[#eef1f8]"
                      : "border-[#1e2a3a] bg-[#09111c] text-[#8b95a8] hover:border-[#34506f] hover:text-[#eef1f8]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {(["1m", "5m", "15m", "1h"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`h-8 w-12 rounded-md border text-sm ${
                    item === "5m"
                      ? "border-[#5aa7ff]/50 bg-[#132338] text-[#eef1f8]"
                      : "border-[#1e2a3a] text-[#8b95a8]"
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
                  <p className="text-xs uppercase tracking-[0.2em] text-[#6f7d9a]">{venue.label}</p>
                  <h1 className="mt-1 text-3xl font-semibold text-[#f6f8ff]">{venue.product}</h1>
                </div>
                <div className="grid grid-cols-2 gap-3 text-right sm:grid-cols-4">
                  <Metric label="Mid" value={formatPrice(mid)} />
                  <Metric label="Spread" value={frame?.spreadBps != null ? `${frame.spreadBps.toFixed(2)} bps` : "-"} />
                  <Metric label="Funding" value={formatRate(frame?.fundingRate)} />
                  <Metric label="24h volume" value={formatCompact(frame?.dayVolume)} />
                </div>
              </div>
              <div className="px-3 pb-3 sm:px-6">
                <MarketChart frame={frame} overlays={overlays} side={side} />
              </div>
            </div>

            <aside className="border-t border-[#182234] lg:border-l lg:border-t-0">
              <div className="border-b border-[#182234] px-4 py-3">
                <h2 className="text-sm font-medium text-[#eef1f8]">Order book</h2>
              </div>
              <BookTable frame={frame} />
              <div className="border-y border-[#182234] px-4 py-3">
                <h2 className="text-sm font-medium text-[#eef1f8]">Recent trades</h2>
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

            <div className="mt-5 grid gap-3 rounded-md border border-[#1e2a3a] bg-[#090d14] p-4">
              <SummaryRow label="Venue" value={venue.label} />
              <SummaryRow label="Idea" value={selectedStrategy(STRATEGIES, strategy).label} />
              <SummaryRow label="Only trade if" value={selectedStrategy(STRATEGIES, strategy).condition} accent />
              <SummaryRow label="Entry" value={entryTriggerLabel(entryTrigger)} />
              <SummaryRow label="Slippage band" value={slippageBand} warn />
            </div>
          </div>

          <div className="h-[calc(100vh-12rem)] overflow-y-auto p-5">
            <ControlSection title="Trade idea">
              <ButtonGrid
                items={STRATEGIES}
                selected={strategy}
                onSelect={(id) => setStrategy(id)}
              />
            </ControlSection>

            <ControlSection title="Entry trigger" sideValue={entryTriggerLabel(entryTrigger)}>
              <ButtonGrid
                items={ENTRY_TRIGGERS}
                selected={entryTrigger}
                onSelect={(id) => setEntryTrigger(id)}
              />
            </ControlSection>

            <ControlSection title="Entry price" sideValue={formatPrice(entryPrice ?? mid)}>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  inputMode="decimal"
                  value={entryPrice ? String(roundForInput(entryPrice)) : ""}
                  onChange={(event) => {
                    const next = Number(event.target.value.replaceAll(",", ""));
                    setEntryPinned(true);
                    setEntryPrice(Number.isFinite(next) && next > 0 ? next : null);
                  }}
                  className="h-11 min-w-0 rounded-md border border-[#1e2a3a] bg-[#090d14] px-3 font-mono text-sm text-[#eef1f8] outline-none focus:border-[#5aa7ff]"
                />
                <button
                  type="button"
                  onClick={() => {
                    setEntryPinned(false);
                    if (mid) setEntryPrice(mid);
                  }}
                  className="h-11 rounded-md border border-[#1e2a3a] px-3 text-sm text-[#aab5c8] transition hover:border-[#34506f] hover:text-[#eef1f8]"
                >
                  Current
                </button>
              </div>
            </ControlSection>

            <ControlSection title="Side and size">
              <div className="grid grid-cols-2 gap-2">
                {(["buy", "sell"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setSide(item)}
                    className={`h-11 rounded-md border text-sm font-medium capitalize ${
                      side === item
                        ? item === "buy"
                          ? "border-emerald-400/60 bg-emerald-400/12 text-emerald-200"
                          : "border-rose-400/60 bg-rose-400/12 text-rose-200"
                        : "border-[#1e2a3a] bg-[#090d14] text-[#8b95a8]"
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
                    className={`h-10 rounded-md border text-sm ${
                      notional === item
                        ? "border-[#5aa7ff]/60 bg-[#132338] text-[#eef1f8]"
                        : "border-[#1e2a3a] bg-[#090d14] text-[#8b95a8]"
                    }`}
                  >
                    ${item}
                  </button>
                ))}
              </div>
            </ControlSection>

            <ControlSection title="Slippage cap" sideValue={`${slippageBps} bps`}>
              <div className="grid grid-cols-3 gap-2">
                {[25, 50, 100].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setSlippageBps(item)}
                    className={`h-11 rounded-md border text-sm ${
                      slippageBps === item
                        ? "border-[#f8e56b]/70 bg-[#2a2610] text-[#fff27a]"
                        : "border-[#1e2a3a] bg-[#090d14] text-[#8b95a8]"
                    }`}
                  >
                    {item} bps
                  </button>
                ))}
              </div>
            </ControlSection>

            <ControlSection title="Horizon">
              <ButtonGrid items={HORIZONS} selected={horizon} onSelect={(id) => setHorizon(id)} />
            </ControlSection>

            <ControlSection title="Stop rule">
              <ButtonGrid items={STOP_RULES} selected={stopRule} onSelect={(id) => setStopRule(id)} />
            </ControlSection>
          </div>

          <div className="border-t border-[#182234] p-5">
            <div className="grid gap-2">
              {!thumperAuth.authenticated ? (
                <button
                  type="button"
                  onClick={() => openAuth("signup")}
                  className="flex h-12 items-center justify-center gap-2 rounded-md bg-[#eef1f8] text-sm font-medium text-[#07101c] transition hover:bg-white"
                >
                  <KeyRound className="h-4 w-4" />
                  Sign in to connect venue
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setAgentRunning((value) => !value)}
                  className={`flex h-12 items-center justify-center gap-2 rounded-md text-sm font-medium transition ${
                    agentRunning
                      ? "bg-amber-300 text-[#171103] hover:bg-amber-200"
                      : "bg-[#5aa7ff] text-[#07101c] hover:bg-[#7bb9ff]"
                  }`}
                >
                  {agentRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {agentRunning ? "Pause watched plan" : "Preview watched plan"}
                </button>
              )}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="flex h-10 items-center justify-center gap-2 rounded-md border border-[#1e2a3a] text-sm text-[#aab5c8] transition hover:border-[#34506f] hover:text-[#eef1f8]"
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

function MarketChart({
  frame,
  overlays,
  side,
}: {
  frame: GholaMarketFrame | null;
  overlays: GholaChartOverlay[];
  side: Side;
}) {
  const candles = useMemo(() => decimateCandles(frame?.candles ?? [], 96), [frame]);
  const chart = chartLayout(candles, overlays);
  return (
    <div className="relative h-[31rem] overflow-hidden rounded-md border border-[#182234] bg-[#05070b]">
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="h-full w-full" role="img" aria-label="Trading chart">
        <defs>
          <linearGradient id="tradeBand" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#f8e56b" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f8e56b" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <rect width={chart.width} height={chart.height} fill="#05070b" />
        {chart.grid.map((line) => (
          <g key={line.y}>
            <line x1="0" x2={chart.width} y1={line.y} y2={line.y} stroke="#162033" strokeWidth="1" />
            <text x={chart.width - 10} y={line.y - 5} textAnchor="end" fill="#566278" fontSize="11">
              {formatPrice(line.price)}
            </text>
          </g>
        ))}
        {candles.map((candle, index) => {
          const x = chart.x(index);
          const open = chart.y(Number(candle.o));
          const close = chart.y(Number(candle.c));
          const high = chart.y(Number(candle.h));
          const low = chart.y(Number(candle.l));
          const up = Number(candle.c) >= Number(candle.o);
          return (
            <g key={`${candle.t}-${index}`}>
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
        {overlays.map((overlay, index) => (
          <OverlaySvg key={overlay.id} overlay={overlay} chart={chart} side={side} index={index} />
        ))}
      </svg>
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-md border border-[#1e2a3a] bg-[#070a10]/82 px-3 py-2 text-xs text-[#aab5c8]">
        <Activity className="h-4 w-4 text-[#5aa7ff]" />
        {frame?.product ?? "Loading"} {frame?.interval ? `/ ${frame.interval}` : ""}
      </div>
    </div>
  );
}

function OverlaySvg({
  overlay,
  chart,
  side,
  index,
}: {
  overlay: GholaChartOverlay;
  chart: ReturnType<typeof chartLayout>;
  side: Side;
  index: number;
}) {
  const color = overlay.tone === "warn" ? "#f8e56b" : overlay.tone === "good" ? "#62d6a3" : "#9ccfff";
  if (overlay.kind === "price_band" && overlay.price && overlay.priceEnd) {
    const y1 = chart.y(overlay.price);
    const y2 = chart.y(overlay.priceEnd);
    return (
      <g>
        <rect x="0" y={Math.min(y1, y2)} width={chart.width} height={Math.abs(y2 - y1)} fill="url(#tradeBand)" />
        <line x1="0" x2={chart.width} y1={y1} y2={y1} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
        <line x1="0" x2={chart.width} y1={y2} y2={y2} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
        <Label x={28} y={Math.min(y1, y2) + 20} color={color} text={overlay.label} />
      </g>
    );
  }
  if (!overlay.price) return null;
  const y = chart.y(overlay.price);
  return (
    <g>
      <line
        x1="0"
        x2={chart.width}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth="1.2"
        strokeDasharray={overlay.id === "agent-entry" ? undefined : "7 7"}
      />
      <Label
        x={28}
        y={Math.max(18, y - 8 - index * 2)}
        color={color}
        text={overlay.id === "agent-entry" ? `${side} entry` : overlay.label}
      />
    </g>
  );
}

function Label({ x, y, color, text }: { x: number; y: number; color: string; text: string }) {
  return (
    <g>
      <rect x={x - 8} y={y - 16} width={Math.max(96, text.length * 8 + 16)} height="24" fill="#070a10" stroke={color} rx="2" />
      <text x={x} y={y} fill={color} fontSize="13" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
        {text}
      </text>
    </g>
  );
}

function BookTable({ frame }: { frame: GholaMarketFrame | null }) {
  const asks = (frame?.asks ?? []).slice(0, 7).reverse();
  const bids = (frame?.bids ?? []).slice(0, 7);
  return (
    <div className="px-4 py-3 font-mono text-xs">
      <div className="grid grid-cols-2 pb-2 text-[#566278]">
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>
      {asks.map((level, index) => (
        <BookRow key={`ask-${index}`} price={level.px} size={level.sz} tone="ask" />
      ))}
      <div className="my-2 rounded bg-[#111a28] px-2 py-1 text-center text-[#eef1f8]">{formatPrice(frameMidNumber(frame))}</div>
      {bids.map((level, index) => (
        <BookRow key={`bid-${index}`} price={level.px} size={level.sz} tone="bid" />
      ))}
    </div>
  );
}

function BookRow({ price, size, tone }: { price: string; size: string; tone: "bid" | "ask" }) {
  return (
    <div className="grid grid-cols-2 py-1">
      <span className={tone === "bid" ? "text-emerald-300" : "text-rose-300"}>{formatPrice(Number(price))}</span>
      <span className="text-right text-[#8b95a8]">{Number(size).toFixed(4)}</span>
    </div>
  );
}

function TradeTape({ frame }: { frame: GholaMarketFrame | null }) {
  return (
    <div className="max-h-48 overflow-hidden px-4 py-3 font-mono text-xs">
      {(frame?.trades ?? []).slice(0, 10).map((trade, index) => (
        <div key={`${trade.time}-${index}`} className="grid grid-cols-3 py-1">
          <span className={trade.side === "buy" ? "text-emerald-300" : "text-rose-300"}>{trade.side}</span>
          <span className="text-right text-[#eef1f8]">{formatPrice(Number(trade.px))}</span>
          <span className="text-right text-[#8b95a8]">{Number(trade.sz).toFixed(4)}</span>
        </div>
      ))}
    </div>
  );
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
          className={`min-h-11 rounded-md border px-3 py-2 text-sm font-medium transition ${
            selected === item.id
              ? "border-[#5aa7ff]/60 bg-[#132338] text-[#eef1f8]"
              : "border-[#1e2a3a] bg-[#090d14] text-[#8b95a8] hover:border-[#34506f] hover:text-[#eef1f8]"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ControlSection({
  title,
  sideValue,
  children,
}: {
  title: string;
  sideValue?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[#8b95a8]">{title}</h3>
        {sideValue ? <span className="text-sm text-[#a8ffd8]">{sideValue}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[#566278]">{label}</p>
      <p className="mt-1 font-mono text-sm text-[#eef1f8]">{value}</p>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-[#8b95a8]">{label}</span>
      <span className={`text-right font-medium ${warn ? "text-[#fff27a]" : accent ? "text-[#a8ffd8]" : "text-[#eef1f8]"}`}>
        {value}
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
  tone: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : tone === "bad"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${color}`}>
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
  const grid = Array.from({ length: 6 }, (_, index) => {
    const price = min + ((max - min) * index) / 5;
    return { price, y: y(price) };
  });
  return { width, height, padding, y, x, candleWidth, grid };
}

function selectedStrategy<T extends { id: string }>(items: T[], id: string): T {
  return items.find((item) => item.id === id) ?? items[0];
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
