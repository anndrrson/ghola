"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ChevronDown, Crosshair, Play, ShieldCheck, SlidersHorizontal } from "lucide-react";
import {
  buildGholaAgentChartOverlays,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaChartMode,
} from "@/lib/ghola-market-chart";
import type { HyperliquidAccountSnapshot, HyperliquidMarketSnapshot } from "@/lib/private-account-client";
import type { PhoenixMarketSnapshot } from "@/lib/phoenix-market-data";
import {
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import { deriveFrontRunProtection } from "@/lib/private-account-front-run-protection";
import {
  deriveMarketFeedFreshness,
  deriveOrderTicketDisplayState,
  type OrderTicketDisplayState,
  type TradingActionKind,
  type TradingNextAction,
  type TradingStatusTone,
  type VenueReadinessStep,
} from "@/lib/private-account-trading-ui";
import { GholaMarketChart } from "./GholaMarketChart";

export type ProTradingVenue = "phoenix" | "hyperliquid";
export type ProChartInterval = "1m" | "5m" | "15m" | "1h";
export type ProChartMode = GholaChartMode;

export interface ProTradingTerminalProps {
  venue: ProTradingVenue;
  venueOptions: Array<{ venue: ProTradingVenue; label: string }>;
  market: string;
  marketOptions: Array<{ value: string; label: string }>;
  interval: ProChartInterval;
  snapshot: HyperliquidMarketSnapshot | PhoenixMarketSnapshot | null;
  marketStatus: string;
  accountSnapshot?: HyperliquidAccountSnapshot | null;
  accountStatus?: string | null;
  order: PrivateExecutionOrderDraft;
  previewCommitment?: string | null;
  working?: boolean;
  nextAction: TradingNextAction;
  readinessSteps: VenueReadinessStep[];
  onVenueChange: (venue: ProTradingVenue) => void;
  onMarketChange: (market: string) => void;
  onIntervalChange: (interval: ProChartInterval) => void;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
  onAction: (kind: TradingActionKind) => void;
}

interface TerminalSnapshot {
  venue: ProTradingVenue;
  market: string;
  fetchedAt: string | null;
  stale: boolean;
  mid: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  spreadBps: number | null;
  markPrice: string | null;
  oraclePrice: string | null;
  dayVolume: string | null;
  openInterest: string | null;
  fundingRate: string | null;
  candles: TerminalCandle[];
  bids: TerminalBookLevel[];
  asks: TerminalBookLevel[];
  trades: TerminalTrade[];
}

interface TerminalCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

interface TerminalBookLevel {
  px: string;
  sz: string;
}

interface TerminalTrade {
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
}

const INTERVALS: Array<{ value: ProChartInterval; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
];

const TIFS = [
  { value: "Gtc", label: "GTC" },
  { value: "Ioc", label: "IOC" },
  { value: "Alo", label: "Post-only" },
];

const AGENT_STRATEGY_PROFILES = [
  ["trend_following", "Trend follow"],
  ["breakout", "Breakout trade"],
  ["reversal", "Reversal trade"],
  ["mean_reversion", "Mean reversion"],
  ["range_trade", "Range fade"],
  ["funding_basis", "Funding basis"],
  ["custom", "Custom"],
] as const;

const AGENT_ENTRY_TRIGGERS = [
  ["preview_now", "Use entry now"],
  ["break_level", "Breaks level"],
  ["retest_level", "Retests level"],
  ["sweep_reclaim", "Reclaims level"],
  ["book_imbalance", "Book imbalance"],
  ["funding_mark_divergence", "Funding edge"],
  ["route_edge_threshold", "Route edge"],
  ["custom", "Custom trigger"],
] as const;

const AGENT_EXIT_RULES = [
  ["manual_approval", "Ask me first"],
  ["take_profit_stop", "Take profit / stop"],
  ["trail_after_profit", "Trail after profit"],
  ["exit_on_invalidation", "Thesis invalid"],
  ["time_stop", "Time limit"],
  ["reduce_on_risk_flip", "Risk flip"],
] as const;

const AGENT_TIME_HORIZONS = [
  ["scalp", "Scalp"],
  ["session_trade", "Session"],
  ["intraday", "Intraday"],
  ["until_invalidated", "Until invalid"],
  ["custom_window", "Custom time"],
] as const;

const SLIPPAGE_CAP_OPTIONS = [["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"]] as const;

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a8d8ff]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070b]";

const MICRO_LABEL = "text-[10px] font-medium uppercase tracking-[0.18em] text-[#5e6e8c]";
const PANEL_TITLE = "text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]";
const FIELD_LABEL = "text-[10px] font-medium uppercase tracking-[0.14em] text-[#6b7997]";

export function ProTradingTerminal({
  venue,
  venueOptions,
  market,
  marketOptions,
  interval,
  snapshot,
  marketStatus,
  accountSnapshot,
  accountStatus,
  order,
  previewCommitment,
  working = false,
  nextAction,
  readinessSteps,
  onVenueChange,
  onMarketChange,
  onIntervalChange,
  onOrderChange,
  onAction,
}: ProTradingTerminalProps) {
  const [chartMode, setChartMode] = useState<ProChartMode>("candles");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [midPulse, setMidPulse] = useState(false);
  const snapshotKey = `${venue}:${market}:${interval}`;
  const rawTerminalSnapshot = useMemo(() => normalizeTerminalSnapshot(venue, snapshot), [venue, snapshot]);
  const [lastGoodSnapshot, setLastGoodSnapshot] = useState<{
    key: string;
    snapshot: TerminalSnapshot;
  } | null>(null);
  const previousMidRef = useRef<string | null>(null);
  const terminalSnapshot =
    rawTerminalSnapshot && hasRenderableMarketSnapshot(rawTerminalSnapshot)
      ? rawTerminalSnapshot
      : lastGoodSnapshot?.key === snapshotKey
        ? lastGoodSnapshot.snapshot
        : rawTerminalSnapshot;
  const usingCachedSnapshot =
    terminalSnapshot != null &&
    terminalSnapshot === lastGoodSnapshot?.snapshot &&
    rawTerminalSnapshot !== terminalSnapshot;
  const normalizedOrder = normalizeTerminalOrder(order, venue);
  const gholaFrame = useMemo(() => {
    if (venue === "hyperliquid") return gholaFrameFromHyperliquid(snapshot as HyperliquidMarketSnapshot | null);
    return gholaFrameFromPhoenix(snapshot as PhoenixMarketSnapshot | null);
  }, [snapshot, venue]);
  const errors = validatePrivateExecutionOrderDraft(normalizedOrder);
  const connection = deriveMarketFeedFreshness({
    status: marketStatus,
    fetchedAt: (rawTerminalSnapshot ?? terminalSnapshot)?.fetchedAt,
    stale: rawTerminalSnapshot?.stale ?? usingCachedSnapshot,
    nowMs,
  });
  const accountAccess = terminalAccountAccessCopy({
    venue,
    accountSnapshot,
    accountStatus,
    nextAction,
  });
  const ticketDisplay = deriveOrderTicketDisplayState({
    errors,
    hasPreview: Boolean(previewCommitment),
  });
  const disabled = working || nextAction.disabled || errors.length > 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!rawTerminalSnapshot || !hasRenderableMarketSnapshot(rawTerminalSnapshot)) return;
    setLastGoodSnapshot({ key: snapshotKey, snapshot: rawTerminalSnapshot });
  }, [rawTerminalSnapshot, snapshotKey]);

  useEffect(() => {
    const mid = terminalSnapshot?.mid ?? null;
    if (previousMidRef.current != null && mid != null && previousMidRef.current !== mid) {
      setMidPulse(true);
      const timer = window.setTimeout(() => setMidPulse(false), 480);
      previousMidRef.current = mid;
      return () => window.clearTimeout(timer);
    }
    previousMidRef.current = mid;
    return undefined;
  }, [terminalSnapshot?.mid]);

  function updateOrder(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange(normalizeTerminalOrder({ ...normalizedOrder, ...patch }, venue));
  }

  function pickBookPrice(price: string, side: "buy" | "sell") {
    updateOrder({
      side,
      limit_price: price,
      order_type: "limit",
      live_order_mode: undefined,
    });
  }

  return (
    <section className="relative border border-[#1c2940] bg-[#08090d] shadow-[0_28px_64px_-36px_rgba(0,0,0,0.95)]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#a8d8ff]/50 to-transparent"
      />
      <div className="grid gap-4 border-b border-[#172237] bg-gradient-to-b from-[#0a0e16] to-transparent p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center border border-[#1e2a3a] bg-gradient-to-b from-[#0c1320] to-[#070b12] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)]">
              <Activity className="h-[18px] w-[18px] text-[#a8d8ff]" />
            </span>
            <div>
              <h2 className="font-display text-[22px] font-semibold tracking-tight text-[#f6f8ff]">
                {venue === "phoenix" ? "Phoenix" : "Hyperliquid"}
              </h2>
              <p className="mt-0.5 text-sm text-[#8b95a8]">
                Pro chart, book, account state, and private execution preview in one place.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Venue">
            {venueOptions.map((option) => (
              <button
                key={option.venue}
                type="button"
                aria-pressed={option.venue === venue}
                onClick={() => onVenueChange(option.venue)}
                className={
                  option.venue === venue
                    ? `term-chip-on h-9 px-3.5 text-sm font-medium ${FOCUS_RING}`
                    : `term-chip h-9 px-3.5 text-sm font-medium ${FOCUS_RING}`
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="term-subpanel grid min-w-[240px] gap-2 px-3 py-2.5 sm:grid-cols-2 lg:grid-cols-1">
          <CompactStatus label="Market feed" value={connection.label} tone={connection.tone} live />
          <CompactStatus label="Access" value={accountAccess.label} tone={accountAccess.tone} live />
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <ToolbarSelect label="Market" value={market} options={marketOptions} onChange={onMarketChange} />
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Chart interval">
                {INTERVALS.map((option) => (
                  <Chip
                    key={option.value}
                    selected={interval === option.value}
                    onClick={() => onIntervalChange(option.value)}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end" role="group" aria-label="Chart mode">
                {(["candles", "line", "depth"] as const).map((mode) => (
                  <Chip key={mode} selected={chartMode === mode} onClick={() => setChartMode(mode)}>
                    {mode === "candles" ? "Candles" : mode === "line" ? "Line" : "Depth"}
                  </Chip>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <MarketStat label="Mid" value={fmt(terminalSnapshot?.mid)} strong pulse={midPulse} />
            <MarketStat label="Mark" value={fmt(terminalSnapshot?.markPrice)} />
            <MarketStat label="Funding" value={formatFunding(terminalSnapshot?.fundingRate)} />
            <MarketStat label="24h volume" value={compactUsd(terminalSnapshot?.dayVolume)} />
          </div>

          <div className="term-subpanel grid gap-2 px-3 py-2 sm:grid-cols-3">
            <CompactStatus label="Best bid" value={fmt(terminalSnapshot?.bestBid)} tone="neutral" />
            <CompactStatus label="Best ask" value={fmt(terminalSnapshot?.bestAsk)} tone="neutral" />
            <CompactStatus label="Spread" value={formatSpreadBps(terminalSnapshot?.spreadBps)} tone={terminalSnapshot?.spreadBps == null ? "neutral" : "good"} />
          </div>

          <GholaMarketChart
            label={venue === "phoenix" ? "Phoenix" : "Hyperliquid"}
            frame={gholaFrame}
            mode={chartMode}
            onModeChange={setChartMode}
            overlays={buildGholaAgentChartOverlays({
              order: normalizedOrder,
              mid: terminalSnapshot?.mid || terminalSnapshot?.markPrice || null,
              previewCommitment,
              accountReady: !nextAction.disabled,
              venueLabel: venue === "phoenix" ? "Phoenix" : "Hyperliquid",
            })}
            size="large"
            height={560}
            onSelectPrice={(price, side) => pickBookPrice(price, side)}
          />
        </div>

        <aside className="grid gap-4">
          <AgentControlPanel
            venue={venue}
            market={market}
            order={normalizedOrder}
            currentPrice={terminalSnapshot?.mid || terminalSnapshot?.markPrice || null}
            onChange={updateOrder}
          />
          <OrderTicket
            venue={venue}
            order={normalizedOrder}
            ticketDisplay={ticketDisplay}
            onChange={updateOrder}
          />
          <NextActionCard
            action={nextAction}
            working={working}
            disabled={disabled}
            disabledReason={ticketDisplay.primaryBlockerText}
            onAction={onAction}
          />
          <ReadinessCard steps={readinessSteps} />
        </aside>
      </div>

      <div className="grid gap-4 border-t border-[#172237] p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <OrderbookPanel snapshot={terminalSnapshot} onPick={pickBookPrice} />
        <div className="grid gap-4">
          <AccountPanel
            snapshot={accountSnapshot}
            venue={venue}
            accessLabel={accountAccess.label}
            accessTone={accountAccess.tone}
          />
          <TradeTape trades={terminalSnapshot?.trades ?? []} hasMarketSnapshot={terminalSnapshot != null} />
        </div>
      </div>
    </section>
  );
}

function AgentControlPanel({
  venue,
  market,
  order,
  currentPrice,
  onChange,
}: {
  venue: ProTradingVenue;
  market: string;
  order: PrivateExecutionOrderDraft;
  currentPrice: string | null;
  onChange: (patch: Partial<PrivateExecutionOrderDraft>) => void;
}) {
  const strategyProfile = normalizeAgentStrategyProfile(order.agent_strategy_profile || "trend_following");
  const entryTrigger = order.agent_entry_trigger || "preview_now";
  const exitRule = order.agent_exit_rule || "manual_approval";
  const timeHorizon = order.agent_time_horizon || "scalp";
  const marketLabel = venue === "phoenix" ? `${market}-PERP` : market;
  const needsTriggerLevel =
    entryTrigger === "break_level" ||
    entryTrigger === "retest_level" ||
    entryTrigger === "sweep_reclaim" ||
    entryTrigger === "custom";
  const needsEdgeThreshold =
    entryTrigger === "book_imbalance" ||
    entryTrigger === "funding_mark_divergence" ||
    entryTrigger === "route_edge_threshold" ||
    strategyProfile === "funding_mark_divergence" ||
    strategyProfile === "venue_route_edge" ||
    strategyProfile === "funding_basis";
  const needsInvalidation =
    exitRule === "exit_on_invalidation" ||
    exitRule === "reduce_on_risk_flip" ||
    strategyProfile === "reversal" ||
    strategyProfile === "sweep_reclaim";
  const needsTimeWindow = timeHorizon === "custom_window" || exitRule === "time_stop";
  const needsRange = strategyProfile === "range_trade";
  const strategyLabel = optionLabel(AGENT_STRATEGY_PROFILES, strategyProfile);
  const chartEntryPrice = order.limit_price?.trim() || currentPrice || "";
  const slippageBand = formatSlippageBand({
    entryPrice: chartEntryPrice,
    slippageBps: order.max_slippage_bps || "50",
    side: order.side,
  });
  const strategyCondition = formatAgentStrategyCondition({ strategyProfile, entryTrigger, order });
  const entryCondition = formatAgentEntryCondition({ entryTrigger, order });
  const frontRunProtection = deriveFrontRunProtection({
    accessMode: venue === "phoenix" ? "user_stealth" : "byo_api_key",
    noPublicMempool: true,
  });
  const planSummary = formatAgentPlanSummary({
    strategyCondition,
    entryCondition,
    horizonLabel: optionLabel(AGENT_TIME_HORIZONS, timeHorizon),
    exitLabel: optionLabel(AGENT_EXIT_RULES, exitRule),
  });

  return (
    <div className="term-panel p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[#a8d8ff]" />
            <p className={PANEL_TITLE}>Trade plan</p>
          </div>
          <p className="mt-1.5 truncate text-xs text-[#6f7d9a]">{marketLabel} mandate</p>
        </div>
        <span className="shrink-0 border border-[#a8d8ff]/25 bg-[#a8d8ff]/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[#a8d8ff]">
          {strategyLabel}
        </span>
      </div>

      <div className="term-subpanel mb-3 p-3">
        <div className="mb-2.5 flex items-center gap-2">
          <Crosshair className="h-3.5 w-3.5 text-[#a8d8ff]" />
          <span className={MICRO_LABEL}>Chart levels</span>
        </div>
        <div className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
            <TicketInput
              label="Entry price"
              value={order.limit_price || ""}
              placeholder={currentPrice ? fmt(currentPrice) : marketLabel}
              onChange={(limit_price) => onChange({ limit_price, order_type: "limit", live_order_mode: undefined })}
            />
            <button
              type="button"
              disabled={!currentPrice}
              onClick={() => currentPrice && onChange({ limit_price: currentPrice, order_type: "limit", live_order_mode: undefined })}
              className={`term-chip h-10 self-end px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
            >
              Use current
            </button>
          </div>
          <AgentChoiceGroup
            label="Slippage cap"
            value={order.max_slippage_bps || "50"}
            options={SLIPPAGE_CAP_OPTIONS}
            onChange={(max_slippage_bps) => onChange({ max_slippage_bps })}
          />
          <CompactStatus label="Slippage band" value={slippageBand} tone="warn" />
        </div>
      </div>

      <div className="grid gap-3">
        <div className="term-subpanel grid gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className={MICRO_LABEL}>Trading rules</span>
            <span className="text-xs text-[#a8d8ff]">{strategyLabel}</span>
          </div>
          <div className="grid gap-2">
            <AgentPlanSelect
              label="Trade idea"
              value={strategyProfile}
              options={AGENT_STRATEGY_PROFILES}
              onChange={(value) => onChange({ agent_strategy_profile: value as PrivateExecutionOrderDraft["agent_strategy_profile"] })}
            />
            <AgentPlanSelect
              label="Enter when"
              value={entryTrigger}
              options={AGENT_ENTRY_TRIGGERS}
              onChange={(value) => onChange({ agent_entry_trigger: value as PrivateExecutionOrderDraft["agent_entry_trigger"] })}
            />
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <AgentPlanSelect
                label="Hold for"
                value={timeHorizon}
                options={AGENT_TIME_HORIZONS}
                onChange={(value) => onChange({ agent_time_horizon: value as PrivateExecutionOrderDraft["agent_time_horizon"] })}
              />
              <AgentPlanSelect
                label="Exit on"
                value={exitRule}
                options={AGENT_EXIT_RULES}
                onChange={(value) => onChange({ agent_exit_rule: value as PrivateExecutionOrderDraft["agent_exit_rule"] })}
              />
            </div>
          </div>
          <div className="border-t border-[#162337] pt-3">
            <p className={FIELD_LABEL}>Plan summary</p>
            <p className="mt-1.5 text-sm leading-6 text-[#d8e6f8]">{planSummary}</p>
          </div>
          <FrontRunProtectionLine
            label={frontRunProtection.label}
            detail={frontRunProtection.detail}
            zeroFrontRun={frontRunProtection.zeroFrontRun}
          />
        </div>
        {(needsTriggerLevel || needsEdgeThreshold || needsInvalidation || needsTimeWindow || needsRange) && (
          <div className="term-subpanel grid gap-3 p-3">
            {needsRange && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <TicketInput
                  label="Range low"
                  value={order.agent_range_low || ""}
                  placeholder={marketLabel}
                  onChange={(agent_range_low) => onChange({ agent_range_low })}
                />
                <TicketInput
                  label="Range high"
                  value={order.agent_range_high || ""}
                  placeholder={marketLabel}
                  onChange={(agent_range_high) => onChange({ agent_range_high })}
                />
              </div>
            )}
            {needsTriggerLevel && (
              <TicketInput
                label={entryTrigger === "sweep_reclaim" ? "Reclaim level" : "Entry level"}
                value={order.agent_trigger_level || ""}
                placeholder={marketLabel}
                onChange={(agent_trigger_level) => onChange({ agent_trigger_level })}
              />
            )}
            {needsEdgeThreshold && (
              <TicketInput
                label="Required edge bps"
                value={order.agent_edge_threshold_bps || "25"}
                placeholder="25"
                onChange={(agent_edge_threshold_bps) => onChange({ agent_edge_threshold_bps })}
              />
            )}
            {needsInvalidation && (
              <TicketInput
                label="Stop level"
                value={order.agent_invalidation_level || ""}
                placeholder={marketLabel}
                onChange={(agent_invalidation_level) => onChange({ agent_invalidation_level })}
              />
            )}
            {needsTimeWindow && (
              <TicketInput
                label="Active window"
                value={order.agent_time_window || ""}
                placeholder="30m"
                onChange={(agent_time_window) => onChange({ agent_time_window })}
              />
            )}
          </div>
        )}

        {(strategyProfile === "custom" || entryTrigger === "custom") && (
          <label className="grid gap-1.5">
            <span className={FIELD_LABEL}>Custom rule</span>
            <textarea
              value={order.agent_strategy_note || ""}
              onChange={(event) => onChange({ agent_strategy_note: event.target.value.slice(0, 240) })}
              placeholder="Only enter if the level holds; invalidate on risk flip"
              spellCheck={false}
              className={`term-field min-h-20 resize-y px-3 py-2 text-xs leading-5 text-[#eef1f8] outline-none placeholder:text-[#59657a] ${FOCUS_RING}`}
            />
          </label>
        )}
      </div>
    </div>
  );
}

function FrontRunProtectionLine({
  label,
  detail,
  zeroFrontRun,
}: {
  label: string;
  detail: string;
  zeroFrontRun: boolean;
}) {
  return (
    <div className="border-t border-[#162337] pt-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs text-[#8b95a8]">Front-run protection</span>
        <span className={zeroFrontRun ? "text-xs font-medium text-emerald-200" : "text-xs font-medium text-amber-200"}>
          {label}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-[#8b95a8]">{detail}</p>
    </div>
  );
}

function AgentPlanSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 sm:grid-cols-[104px_minmax(0,1fr)] sm:items-center">
      <span className={FIELD_LABEL}>{label}</span>
      <span className="relative block">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`term-field h-10 w-full appearance-none px-3 pr-9 text-sm font-medium text-[#eef1f8] outline-none ${FOCUS_RING}`}
        >
          {options.map(([optionValue, text]) => (
            <option key={optionValue} value={optionValue}>{text}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-[#6f7d9a]" />
      </span>
    </label>
  );
}

function AgentChoiceGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map(([optionValue, text]) => {
          const selected = optionValue === value;
          return (
            <button
              key={optionValue}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(optionValue)}
              className={
                selected
                  ? `term-chip-on min-h-9 flex-1 basis-[92px] px-2.5 py-1.5 text-xs font-medium ${FOCUS_RING}`
                  : `term-chip min-h-9 flex-1 basis-[92px] px-2.5 py-1.5 text-xs font-medium ${FOCUS_RING}`
              }
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrderTicket({
  venue,
  order,
  ticketDisplay,
  onChange,
}: {
  venue: ProTradingVenue;
  order: PrivateExecutionOrderDraft;
  ticketDisplay: OrderTicketDisplayState;
  onChange: (patch: Partial<PrivateExecutionOrderDraft>) => void;
}) {
  const orderType = order.order_type || (order.live_order_mode === "tiny_fill" ? "market" : "limit");
  const sizeMode = order.size_mode || (order.quote_size ? "quote" : "base");
  const isMarket = orderType === "market";
  const marketUsesPriceLimit = isMarket && venue === "phoenix";
  const executionField = isMarket && !marketUsesPriceLimit ? "slippage" : "price";
  return (
    <div className="term-panel p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className={PANEL_TITLE}>Order ticket</span>
        <span className={ticketDisplay.statusTone === "warn" ? "text-xs text-amber-200" : "text-xs text-emerald-200"}>
          {ticketDisplay.statusLabel}
        </span>
      </div>
      <div className="grid gap-3">
        <Segment
          label="Side"
          value={order.side}
          options={[["buy", "Buy"], ["sell", "Sell"]]}
          onChange={(value) => onChange({ side: value as "buy" | "sell" })}
        />
        <Segment
          label="Order"
          value={orderType}
          options={[["market", "Market"], ["limit", "Limit"]]}
          onChange={(value) => onChange({
            order_type: value as "market" | "limit",
            live_order_mode: undefined,
            tif: value === "market" ? "Ioc" : order.tif || "Gtc",
            post_only: value === "market" ? false : order.post_only,
          })}
        />
        <Segment
          label="Size"
          value={sizeMode}
          options={[["quote", "USD"], ["base", venue === "phoenix" ? "SOL" : order.market]]}
          onChange={(value) => onChange({ size_mode: value as "quote" | "base" })}
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {sizeMode === "quote" ? (
            <TicketInput
              label="USD amount"
              value={order.quote_size || ""}
              placeholder="5"
              hint={ticketDisplay.fieldHints.size?.[0]}
              onChange={(quote_size) => onChange({ quote_size })}
            />
          ) : (
            <TicketInput
              label="Base size"
              value={order.base_size || ""}
              placeholder={venue === "phoenix" ? "0.05" : "0.001"}
              hint={ticketDisplay.fieldHints.size?.[0]}
              onChange={(base_size) => onChange({ base_size })}
            />
          )}
          <TicketInput
            label={isMarket ? marketUsesPriceLimit ? "Price limit" : "Slippage cap bps" : "Limit price"}
            value={isMarket ? marketUsesPriceLimit ? order.limit_price || "" : order.max_slippage_bps || "50" : order.limit_price || ""}
            placeholder={isMarket ? marketUsesPriceLimit ? "250" : "50" : "100"}
            hint={ticketDisplay.fieldHints[executionField]?.[0]}
            onChange={(value) => onChange(isMarket ? marketUsesPriceLimit ? { limit_price: value } : { max_slippage_bps: value } : { limit_price: value })}
          />
        </div>
        {!isMarket && (
          <Segment
            label="Time in force"
            value={order.post_only ? "Alo" : order.tif || "Gtc"}
            options={TIFS.map((item) => [item.value, item.label] as const)}
            onChange={(value) => onChange({
              tif: value as PrivateExecutionOrderDraft["tif"],
              post_only: value === "Alo",
            })}
          />
        )}
        <label className="term-subpanel flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span className="text-[#aab5c8]">Reduce only</span>
          <input
            aria-label="Reduce only"
            type="checkbox"
            checked={order.reduce_only === true}
            onChange={(event) => onChange({ reduce_only: event.target.checked })}
            className={`h-4 w-4 accent-[#a8d8ff] ${FOCUS_RING}`}
          />
        </label>
      </div>
      <div className="mt-3 grid gap-2 border-t border-[#162337] pt-3">
        <CompactStatus label="Main wallet" value="not exposed" tone="good" />
        <CompactStatus
          label={`${venue === "phoenix" ? "Phoenix" : "Hyperliquid"} sees`}
          value="venue account + order"
          tone="warn"
        />
      </div>
      {ticketDisplay.generalHints[0] && <p className="mt-3 text-xs text-amber-200">{ticketDisplay.generalHints[0]}</p>}
    </div>
  );
}

function NextActionCard({
  action,
  working,
  disabled,
  disabledReason,
  onAction,
}: {
  action: TradingNextAction;
  working: boolean;
  disabled: boolean;
  disabledReason?: string;
  onAction: (kind: TradingActionKind) => void;
}) {
  const descriptionId = useId();
  const copy = disabledReason || action.description;
  return (
    <div className={`border p-3 shadow-[inset_0_1px_0_rgba(220,238,255,0.05)] ${action.tone === "success" ? "border-emerald-300/25 bg-emerald-300/10" : action.tone === "warn" ? "border-amber-300/25 bg-amber-300/10" : action.tone === "danger" ? "border-red-400/25 bg-red-400/10" : "border-[#1c2940] bg-gradient-to-b from-[#0a0e16] to-[#05070b]"}`}>
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-[#a8d8ff]" />
        <div>
          <p className="text-sm font-medium text-[#f6f8ff]">{action.label}</p>
          <p id={descriptionId} className="mt-1 text-xs leading-5 text-[#8b95a8]">{copy}</p>
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={descriptionId}
        onClick={() => onAction(action.kind)}
        className={`term-action mt-3 inline-flex h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
      >
        <Play className="h-4 w-4" />
        {working ? "Working" : action.label}
      </button>
      {action.secondary && (
        <button
          type="button"
          disabled={working || action.secondary.disabled}
          aria-describedby={descriptionId}
          onClick={() => onAction(action.secondary!.kind)}
          className={`term-chip mt-2 h-10 w-full px-4 text-sm font-medium disabled:opacity-50 ${FOCUS_RING}`}
        >
          {action.secondary.label}
        </button>
      )}
    </div>
  );
}

function ReadinessCard({ steps }: { steps: VenueReadinessStep[] }) {
  return (
    <div className="term-panel p-3">
      <p className={`mb-3 ${PANEL_TITLE}`}>Readiness</p>
      <ol className="m-0 grid list-none gap-2 p-0">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2 text-[#8b95a8]">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${
                  step.status === "done"
                    ? "bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]"
                    : step.status === "blocked"
                      ? "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.7)]"
                      : step.status === "warn"
                        ? "bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.7)]"
                        : "bg-[#33415c]"
                }`}
              />
              {step.label}
            </span>
            <span
              role="status"
              aria-live="polite"
              className={step.status === "done" ? "text-emerald-200" : step.status === "blocked" ? "text-red-200" : step.status === "warn" ? "text-amber-200" : "text-[#aab5c8]"}
            >
              {step.value}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function OrderbookPanel({
  snapshot,
  onPick,
}: {
  snapshot: TerminalSnapshot | null;
  onPick: (price: string, side: "buy" | "sell") => void;
}) {
  return (
    <div className="term-panel p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className={PANEL_TITLE}>Order book</span>
        <span className="font-mono text-xs text-[#8b95a8]">{snapshot?.market ?? "market"}</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <BookSide title="Asks" side="ask" rows={snapshot?.asks ?? []} onPick={onPick} />
        <BookSide title="Bids" side="bid" rows={snapshot?.bids ?? []} onPick={onPick} />
      </div>
    </div>
  );
}

function BookSide({
  title,
  side,
  rows,
  onPick,
}: {
  title: string;
  side: "bid" | "ask";
  rows: TerminalBookLevel[];
  onPick: (price: string, side: "buy" | "sell") => void;
}) {
  const shown = side === "ask" ? rows.slice(0, 10).reverse() : rows.slice(0, 10);
  const max = Math.max(1, ...shown.map((row) => Number(row.sz)).filter(Number.isFinite));
  const color = side === "ask" ? "#f87171" : "#34d399";
  const orderSide = side === "ask" ? "sell" : "buy";
  return (
    <div>
      <div className={`mb-2 flex items-center justify-between ${MICRO_LABEL}`}>
        <span>{title}</span>
        <span>size</span>
      </div>
      <div className="grid gap-0.5">
        {shown.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#6f7d9a]">
            {side === "ask" ? "Waiting for asks" : "Waiting for bids"}
          </div>
        ) : shown.map((row, index) => {
          const width = Math.min(100, (Number(row.sz) / max) * 100);
          return (
            <button
              key={`${side}-${row.px}-${index}`}
              type="button"
              aria-label={`${orderSide === "buy" ? "Set buy limit" : "Set sell limit"} at ${fmt(row.px)} from ${title}`}
              onClick={() => onPick(row.px, orderSide)}
              className={`relative flex items-center justify-between px-2 py-1 font-mono text-xs tabular-nums transition-colors duration-100 hover:bg-[#0f1a2c] ${FOCUS_RING}`}
            >
              <span
                className="absolute inset-y-0 right-0 opacity-20"
                style={{ width: `${width}%`, background: `linear-gradient(270deg, ${color}, transparent)` }}
              />
              <span className="relative z-10" style={{ color }}>{fmt(row.px)}</span>
              <span className="relative z-10 text-[#8b95a8]">{trimSize(row.sz)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccountPanel({
  snapshot,
  venue,
  accessLabel,
  accessTone,
}: {
  snapshot?: HyperliquidAccountSnapshot | null;
  venue: ProTradingVenue;
  accessLabel: string;
  accessTone: TradingStatusTone;
}) {
  const rows = snapshot?.open_orders ?? [];
  const positions = snapshot?.positions ?? [];
  return (
    <div className="term-panel p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className={PANEL_TITLE}>Account</span>
        <span className="text-xs text-[#8b95a8]">{accountSourceLabel(snapshot?.account_source, venue)}</span>
      </div>
      <div className="grid gap-2">
        <CompactStatus label="Status" value={snapshot ? accountSnapshotStatusLabel(snapshot) : accessLabel} tone={snapshot ? accountSnapshotStatusTone(snapshot) : accessTone} />
        <CompactStatus label="Equity" value={equityBucketLabel(snapshot?.equity_bucket)} tone={snapshot?.equity_bucket === "ready" ? "good" : snapshot ? "warn" : "neutral"} />
        <CompactStatus label="Positions" value={String(snapshot?.position_count ?? positions.length)} tone="neutral" />
        <CompactStatus label="Open orders" value={String(snapshot?.open_order_count ?? rows.length)} tone="neutral" />
      </div>
      {!snapshot && (
        <p className="mt-3 border-t border-[#162337] pt-3 text-xs leading-5 text-[#8b95a8]">
          Connect to stream equity, positions, open orders, and fills.
        </p>
      )}
      {(positions.length > 0 || rows.length > 0) && (
        <div className="mt-3 border-t border-[#162337] pt-3">
          {positions.slice(0, 3).map((position) => (
            <div key={position.position_commitment} className="flex justify-between gap-3 text-xs">
              <span className="text-[#aab5c8]">{position.market} {position.side}</span>
              <span className="text-[#8b95a8]">{position.size_bucket}</span>
            </div>
          ))}
          {rows.slice(0, 3).map((order) => (
            <div key={order.order_handle_commitment} className="flex justify-between gap-3 text-xs">
              <span className="text-[#aab5c8]">{order.market} {order.side}</span>
              <span className="text-[#8b95a8]">{order.price_bucket}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradeTape({
  trades,
  hasMarketSnapshot,
}: {
  trades: TerminalTrade[];
  hasMarketSnapshot: boolean;
}) {
  return (
    <div className="term-panel p-3">
      <div className={`mb-2 flex items-center justify-between ${MICRO_LABEL}`}>
        <span>Trades</span>
        <span>size · price</span>
      </div>
      <div className="grid max-h-48 gap-0.5 overflow-hidden">
        {trades.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#6f7d9a]">
            {hasMarketSnapshot ? "No recent prints yet" : "Waiting for market prints"}
          </div>
        ) : trades.slice(0, 16).map((trade, index) => (
          <div
            key={`${trade.time}-${index}`}
            className="flex items-center justify-between font-mono text-xs tabular-nums"
            style={{
              color: trade.side === "buy" ? "#6ee7b7" : "#fca5a5",
              opacity: Math.max(0.4, 1 - index * 0.045),
            }}
          >
            <span>{trimSize(trade.sz)}</span>
            <span>{fmt(trade.px)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolbarSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <span className="relative block">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`term-field h-10 w-full appearance-none px-3 pr-9 text-sm font-medium text-[#eef1f8] outline-none ${FOCUS_RING}`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-[#6f7d9a]" />
      </span>
    </label>
  );
}

function optionLabel(options: ReadonlyArray<readonly [string, string]>, value: string): string {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? value;
}

function normalizeAgentStrategyProfile(value: string): NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]> {
  if (value === "momentum_continuation") return "trend_following";
  if (value === "breakout_retest") return "breakout";
  if (value === "sweep_reclaim") return "reversal";
  if (value === "funding_mark_divergence") return "funding_basis";
  if (value === "venue_route_edge") return "custom";
  return value as NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
}

function formatSlippageBand({
  entryPrice,
  slippageBps,
  side,
}: {
  entryPrice: string;
  slippageBps: string;
  side: "buy" | "sell";
}) {
  const entry = Number(entryPrice);
  const bps = Number(slippageBps);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(bps)) return "set entry price";
  const cap = side === "sell" ? entry * (1 - bps / 10_000) : entry * (1 + bps / 10_000);
  return `${fmt(String(entry))} to ${fmt(String(cap))}`;
}

function formatAgentStrategyCondition({
  strategyProfile,
  entryTrigger,
  order,
}: {
  strategyProfile: NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
  entryTrigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  order: PrivateExecutionOrderDraft;
}) {
  const trigger = order.agent_trigger_level?.trim();
  const rangeLow = order.agent_range_low?.trim();
  const rangeHigh = order.agent_range_high?.trim();
  const edge = order.agent_edge_threshold_bps?.trim() || "25";
  if (strategyProfile === "range_trade") {
    return rangeLow && rangeHigh ? `${fmt(rangeLow)} to ${fmt(rangeHigh)}` : "set range low/high";
  }
  if (strategyProfile === "funding_basis") return `basis edge >= ${edge} bps`;
  if (strategyProfile === "breakout") return trigger ? `price breaks ${fmt(trigger)}` : "set breakout level";
  if (strategyProfile === "reversal") return trigger ? `price reclaims ${fmt(trigger)}` : "set reclaim level";
  if (strategyProfile === "mean_reversion") return trigger ? `price fades toward ${fmt(trigger)}` : "set mean level";
  if (strategyProfile === "custom") return order.agent_strategy_note?.trim() ? "custom rule set" : "write custom rule";
  if (entryTrigger === "break_level") return trigger ? `price breaks ${fmt(trigger)}` : "set break level";
  if (entryTrigger === "retest_level") return trigger ? `price retests ${fmt(trigger)}` : "set retest level";
  if (entryTrigger === "sweep_reclaim") return trigger ? `price reclaims ${fmt(trigger)}` : "set reclaim level";
  if (entryTrigger === "book_imbalance") return `book edge >= ${edge} bps`;
  if (entryTrigger === "funding_mark_divergence") return `funding edge >= ${edge} bps`;
  if (entryTrigger === "route_edge_threshold") return `route edge >= ${edge} bps`;
  return "trend filter passes";
}

function formatAgentEntryCondition({
  entryTrigger,
  order,
}: {
  entryTrigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  order: PrivateExecutionOrderDraft;
}) {
  const trigger = order.agent_trigger_level?.trim();
  const edge = order.agent_edge_threshold_bps?.trim() || "25";
  if (entryTrigger === "break_level") return trigger ? `price breaks ${fmt(trigger)}` : "set break level";
  if (entryTrigger === "retest_level") return trigger ? `price retests ${fmt(trigger)}` : "set retest level";
  if (entryTrigger === "sweep_reclaim") return trigger ? `price reclaims ${fmt(trigger)}` : "set reclaim level";
  if (entryTrigger === "book_imbalance") return `book edge >= ${edge} bps`;
  if (entryTrigger === "funding_mark_divergence") return `funding edge >= ${edge} bps`;
  if (entryTrigger === "route_edge_threshold") return `route edge >= ${edge} bps`;
  if (entryTrigger === "custom") return order.agent_strategy_note?.trim() ? "custom trigger set" : "write custom rule";
  return "use entry price now";
}

function formatAgentPlanSummary({
  strategyCondition,
  entryCondition,
  horizonLabel,
  exitLabel,
}: {
  strategyCondition: string;
  entryCondition: string;
  horizonLabel: string;
  exitLabel: string;
}) {
  return `Only trade if ${strategyCondition}; enter when ${entryCondition}; hold for ${lowerFirst(horizonLabel)}; exit on ${lowerFirst(exitLabel)}.`;
}

function lowerFirst(value: string) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function Segment({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5" role="group" aria-label={label}>
      <span className={FIELD_LABEL}>{label}</span>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map(([optionValue, text]) => (
          <button
            key={optionValue}
            type="button"
            aria-pressed={value === optionValue}
            onClick={() => onChange(optionValue)}
            className={
              value === optionValue
                ? `term-chip-on h-9 px-2 text-xs font-medium ${FOCUS_RING}`
                : `term-chip h-9 px-2 text-xs font-medium ${FOCUS_RING}`
            }
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function TicketInput({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  return (
    <label className="grid gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        aria-invalid={hint ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        className={`term-field h-10 px-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none placeholder:text-[#59657a] ${FOCUS_RING}`}
      />
      {hint && <span id={hintId} className="text-xs leading-5 text-amber-200">{hint}</span>}
    </label>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={
        selected
          ? `term-chip-on h-9 min-w-16 px-3 text-sm font-medium ${FOCUS_RING}`
          : `term-chip h-9 min-w-16 px-3 text-sm font-medium ${FOCUS_RING}`
      }
    >
      {children}
    </button>
  );
}

function MarketStat({
  label,
  value,
  strong = false,
  pulse = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  pulse?: boolean;
}) {
  return (
    <div className={`term-subpanel px-3 py-2 transition-all duration-500 ${pulse ? "border-[#a8d8ff]/70 shadow-[0_0_20px_-6px_rgba(168,216,255,0.45)]" : ""}`}>
      <div className={MICRO_LABEL}>{label}</div>
      <div
        className={`${strong ? "mt-1 font-mono text-2xl font-medium tabular-nums text-[#f6f8ff]" : "mt-1 font-mono text-sm tabular-nums text-[#eef1f8]"} ${pulse ? "term-price-flash" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function CompactStatus({
  label,
  value,
  tone,
  live = false,
}: {
  label: string;
  value: string;
  tone: TradingStatusTone;
  live?: boolean;
}) {
  const toneClass =
    tone === "good" ? "text-emerald-200" :
      tone === "warn" ? "text-amber-200" :
        tone === "bad" ? "text-red-200" : "text-[#aab5c8]";
  const dotClass =
    tone === "good" ? "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]" :
      tone === "warn" ? "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]" :
        tone === "bad" ? "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]" : "bg-[#5e6e8c]";
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[#7b88a1]">{label}</span>
      <span
        role={live ? "status" : undefined}
        aria-live={live ? "polite" : undefined}
        className={`flex max-w-[240px] items-center gap-1.5 truncate font-mono tabular-nums ${toneClass}`}
      >
        {live && <span aria-hidden className={`term-live-dot h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />}
        {value}
      </span>
    </div>
  );
}

function normalizeTerminalSnapshot(
  venue: ProTradingVenue,
  snapshot: HyperliquidMarketSnapshot | PhoenixMarketSnapshot | null,
): TerminalSnapshot | null {
  if (!snapshot) return null;
  if (venue === "hyperliquid" && snapshot.platform === "hyperliquid") {
    return {
      venue,
      market: snapshot.coin,
      fetchedAt: snapshot.fetched_at,
      stale: snapshot.stale,
      mid: snapshot.mid,
      bestBid: snapshot.best_bid,
      bestAsk: snapshot.best_ask,
      spreadBps: snapshot.spread_bps,
      markPrice: snapshot.mark_price,
      oraclePrice: snapshot.oracle_price,
      dayVolume: snapshot.day_notional_volume,
      openInterest: snapshot.open_interest,
      fundingRate: snapshot.funding_rate,
      candles: snapshot.candles,
      bids: snapshot.bids,
      asks: snapshot.asks,
      trades: snapshot.recent_trades,
    };
  }
  if (venue === "phoenix" && snapshot.platform === "phoenix") {
    return {
      venue,
      market: `${snapshot.symbol}-PERP`,
      fetchedAt: snapshot.fetched_at,
      stale: snapshot.stale,
      mid: snapshot.mid,
      bestBid: snapshot.best_bid,
      bestAsk: snapshot.best_ask,
      spreadBps: snapshot.spread_bps,
      markPrice: snapshot.mark_price,
      oraclePrice: snapshot.oracle_price,
      dayVolume: snapshot.day_notional_volume,
      openInterest: snapshot.open_interest,
      fundingRate: snapshot.funding_rate,
      candles: snapshot.candles,
      bids: snapshot.bids,
      asks: snapshot.asks,
      trades: snapshot.recent_trades,
    };
  }
  return null;
}

function normalizeTerminalOrder(
  order: PrivateExecutionOrderDraft,
  venue: ProTradingVenue,
): PrivateExecutionOrderDraft {
  const orderType = order.order_type || (order.live_order_mode === "tiny_fill" ? "market" : "limit");
  const sizeMode = order.size_mode || (order.quote_size ? "quote" : "base");
  const postOnly = orderType === "limit" && (order.post_only === true || order.tif === "Alo");
  return {
    ...order,
    venue_id: venue === "phoenix" ? "phoenix" : "hyperliquid",
    operation_class: venue === "phoenix" ? "perp_limit_order" : "limit_order",
    market: (order.market || (venue === "phoenix" ? "SOL" : "BTC")).toUpperCase().split("-")[0],
    order_type: orderType,
    size_mode: sizeMode,
    tif: orderType === "market" ? "Ioc" : postOnly ? "Alo" : order.tif || "Gtc",
    live_order_mode: undefined,
    post_only: postOnly,
  };
}

function hasRenderableMarketSnapshot(snapshot: TerminalSnapshot | null): snapshot is TerminalSnapshot {
  if (!snapshot) return false;
  return snapshot.candles.length > 0 || snapshot.bids.length > 0 || snapshot.asks.length > 0;
}

function terminalAccountAccessCopy(input: {
  venue: ProTradingVenue;
  accountSnapshot?: HyperliquidAccountSnapshot | null;
  accountStatus?: string | null;
  nextAction: TradingNextAction;
}): { label: string; tone: TradingStatusTone } {
  const venueName = venueLabel(input.venue);
  if (input.nextAction.kind === "sign_in") return { label: "Sign in required", tone: "warn" };
  if (input.accountSnapshot) {
    return {
      label: accountSnapshotStatusLabel(input.accountSnapshot),
      tone: accountSnapshotStatusTone(input.accountSnapshot),
    };
  }
  const status = normalizeHumanStatus(input.accountStatus);
  if (status.includes("worker")) return { label: "Worker unavailable", tone: "bad" };
  if (status.includes("needs_funds") || status.includes("needs funds")) return { label: "Needs funds", tone: "warn" };
  if (status.includes("ready") || status.includes("connected") || status === "live") {
    return { label: "Ready to preview", tone: "good" };
  }
  if (input.nextAction.kind.startsWith("verify_") || status.includes("checking") || status.includes("connecting")) {
    return { label: "Checking account", tone: "warn" };
  }
  return { label: `Connect ${venueName} account`, tone: "warn" };
}

function accountSnapshotStatusLabel(snapshot: HyperliquidAccountSnapshot): string {
  if (snapshot.status === "ready_to_trade") return "Ready to preview";
  if (snapshot.status === "needs_funds") return "Needs funds";
  if (snapshot.status === "worker_unavailable" || snapshot.stream_status === "worker_unavailable") {
    return "Worker unavailable";
  }
  if (snapshot.status === "private_mode_waiting" || snapshot.stream_status === "connecting" || snapshot.stream_status === "backfilling") {
    return "Checking account";
  }
  return "Connect Hyperliquid account";
}

function accountSnapshotStatusTone(snapshot: HyperliquidAccountSnapshot): TradingStatusTone {
  if (snapshot.status === "ready_to_trade") return "good";
  if (snapshot.status === "worker_unavailable" || snapshot.stream_status === "worker_unavailable") return "bad";
  return "warn";
}

function accountSourceLabel(
  source: HyperliquidAccountSnapshot["account_source"] | undefined,
  venue: ProTradingVenue,
): string {
  if (source === "sealed_byo") return "Scoped API wallet";
  if (source === "ghola_managed") return "Ghola managed account";
  if (source === "ghola_pooled") return "Ghola Vault Mode";
  if (venue === "phoenix") return "Ghola Vault Mode";
  return `Connect ${venueLabel(venue)} account`;
}

function equityBucketLabel(bucket: HyperliquidAccountSnapshot["equity_bucket"] | undefined): string {
  if (bucket === "ready") return "Ready";
  if (bucket === "low" || bucket === "none") return "Needs funds";
  if (bucket === "unknown") return "Checking account";
  return "Connect to stream";
}

function normalizeHumanStatus(status: string | null | undefined): string {
  return String(status || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function venueLabel(venue: ProTradingVenue): string {
  return venue === "phoenix" ? "Phoenix" : "Hyperliquid";
}

function formatSpreadBps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 10) return `${value.toFixed(1)} bps`;
  return `${value.toFixed(2)} bps`;
}

function fmt(value: string | null | undefined): string {
  if (!value) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return formatPrice(num);
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function compactUsd(value: string | null | undefined): string {
  if (!value) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${formatPrice(num)}`;
}

function formatFunding(value: string | null | undefined): string {
  if (!value) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return `${num >= 0 ? "+" : ""}${(num * 100).toFixed(4)}%`;
}

function trimSize(value: string): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return Number(num.toFixed(4)).toString();
}
