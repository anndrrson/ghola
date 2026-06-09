import type { HyperliquidMarketSnapshot } from "./private-account-client";
import type { CoinbaseMarketSnapshot } from "./coinbase-market-data";
import type { PhoenixMarketSnapshot } from "./phoenix-market-data";
import type { MobileMarketJupiter } from "./mobile-market-data";
import type { PrivateExecutionOrderDraft } from "./private-execution-instruction-seal";

export type GholaChartVenue = "hyperliquid" | "phoenix" | "coinbase" | "jupiter";
export type GholaChartMode = "candles" | "line" | "depth" | "compare" | "route" | "slippage" | "quote";
export type GholaChartTone = "good" | "bad" | "warn" | "accent" | "neutral";

export interface GholaChartCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface GholaChartBookLevel {
  px: string;
  sz: string;
  n: number | null;
}

export interface GholaChartTrade {
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
}

export interface GholaRouteQuotePoint {
  t: number;
  inputAmount: string;
  outputAmount: string | null;
  price: string | null;
  priceImpactPct: string | null;
  slippageBps: number;
  routeSummary: string[];
}

export interface GholaMarketFrame {
  version: 1;
  venue: GholaChartVenue;
  product: string;
  interval: string;
  fetchedAt: string | null;
  stale: boolean;
  mid: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  spreadBps: number | null;
  markPrice: string | null;
  oraclePrice: string | null;
  fundingRate: string | null;
  openInterest: string | null;
  dayVolume: string | null;
  candles: GholaChartCandle[];
  bids: GholaChartBookLevel[];
  asks: GholaChartBookLevel[];
  trades: GholaChartTrade[];
  routeQuotes: GholaRouteQuotePoint[];
}

export interface GholaChartOverlay {
  id: string;
  kind: "price_line" | "price_band" | "event" | "visibility" | "receipt";
  label: string;
  tone: GholaChartTone;
  price?: number | null;
  priceEnd?: number | null;
  time?: number | null;
  status?: string | null;
  detail?: string | null;
  side?: "buy" | "sell" | null;
}

export interface GholaAgentOverlayInput {
  order: PrivateExecutionOrderDraft;
  mid: string | null;
  previewCommitment?: string | null;
  accountReady?: boolean;
  venueLabel: string;
  receiptCommitment?: string | null;
}

export class FixedRingBuffer<T> {
  private values: T[] = [];

  constructor(private readonly maxLength: number) {}

  push(value: T) {
    this.values.push(value);
    if (this.values.length > this.maxLength) {
      this.values.splice(0, this.values.length - this.maxLength);
    }
  }

  replace(values: T[]) {
    this.values = values.slice(-this.maxLength);
  }

  clear() {
    this.values = [];
  }

  toArray() {
    return this.values.slice();
  }

  last() {
    return this.values[this.values.length - 1];
  }

  get length() {
    return this.values.length;
  }
}

export class GholaChartStore {
  private key: string | null = null;
  private latest: GholaMarketFrame | null = null;
  private candles = new FixedRingBuffer<GholaChartCandle>(2_000);
  private trades = new FixedRingBuffer<GholaChartTrade>(1_000);
  private bids = new FixedRingBuffer<GholaChartBookLevel>(100);
  private asks = new FixedRingBuffer<GholaChartBookLevel>(100);
  private routeQuotes = new FixedRingBuffer<GholaRouteQuotePoint>(600);

  ingest(frame: GholaMarketFrame | null) {
    if (!frame) {
      this.latest = null;
      return;
    }
    const nextKey = `${frame.venue}:${frame.product}:${frame.interval}`;
    if (nextKey !== this.key) {
      this.key = nextKey;
      this.candles.clear();
      this.trades.clear();
      this.bids.clear();
      this.asks.clear();
      this.routeQuotes.clear();
    }
    this.candles.replace(frame.candles);
    this.trades.replace(frame.trades);
    this.bids.replace(frame.bids);
    this.asks.replace(frame.asks);
    if (frame.routeQuotes.length > 1) {
      this.routeQuotes.replace(frame.routeQuotes);
    } else if (frame.routeQuotes.length === 1) {
      const quote = frame.routeQuotes[0];
      const last = this.routeQuotes.last();
      if (!last || last.t !== quote.t || last.price !== quote.price || last.outputAmount !== quote.outputAmount) {
        this.routeQuotes.push(quote);
      }
    } else if (frame.venue !== "jupiter") {
      this.routeQuotes.clear();
    }
    this.latest = {
      ...frame,
      candles: this.candles.toArray(),
      trades: this.trades.toArray(),
      bids: this.bids.toArray(),
      asks: this.asks.toArray(),
      routeQuotes: this.routeQuotes.toArray(),
    };
  }

  frame() {
    return this.latest;
  }
}

export function gholaFrameFromHyperliquid(snapshot: HyperliquidMarketSnapshot | null): GholaMarketFrame | null {
  if (!snapshot) return null;
  return {
    version: 1,
    venue: "hyperliquid",
    product: snapshot.coin,
    interval: snapshot.interval,
    fetchedAt: snapshot.fetched_at,
    stale: snapshot.stale,
    mid: snapshot.mid,
    bestBid: snapshot.best_bid,
    bestAsk: snapshot.best_ask,
    spreadBps: snapshot.spread_bps,
    markPrice: snapshot.mark_price,
    oraclePrice: snapshot.oracle_price,
    fundingRate: snapshot.funding_rate,
    openInterest: snapshot.open_interest,
    dayVolume: snapshot.day_notional_volume,
    candles: snapshot.candles.map(normalizeCandle),
    bids: snapshot.bids.map(normalizeBookLevel),
    asks: snapshot.asks.map(normalizeBookLevel),
    trades: snapshot.recent_trades.map((trade) => ({
      side: trade.side,
      px: trade.px,
      sz: trade.sz,
      time: trade.time,
    })),
    routeQuotes: [],
  };
}

export function gholaFrameFromPhoenix(snapshot: PhoenixMarketSnapshot | null): GholaMarketFrame | null {
  if (!snapshot) return null;
  return {
    version: 1,
    venue: "phoenix",
    product: `${snapshot.symbol}-PERP`,
    interval: snapshot.interval,
    fetchedAt: snapshot.fetched_at,
    stale: snapshot.stale,
    mid: snapshot.mid,
    bestBid: snapshot.best_bid,
    bestAsk: snapshot.best_ask,
    spreadBps: snapshot.spread_bps,
    markPrice: snapshot.mark_price,
    oraclePrice: snapshot.oracle_price,
    fundingRate: snapshot.funding_rate,
    openInterest: snapshot.open_interest,
    dayVolume: snapshot.day_notional_volume,
    candles: snapshot.candles.map(normalizeCandle),
    bids: snapshot.bids.map(normalizeBookLevel),
    asks: snapshot.asks.map(normalizeBookLevel),
    trades: snapshot.recent_trades.map((trade) => ({
      side: trade.side,
      px: trade.px,
      sz: trade.sz,
      time: trade.time,
    })),
    routeQuotes: [],
  };
}

export function gholaFrameFromCoinbase(snapshot: CoinbaseMarketSnapshot | null): GholaMarketFrame | null {
  if (!snapshot) return null;
  return {
    version: 1,
    venue: "coinbase",
    product: snapshot.product_id,
    interval: snapshot.interval,
    fetchedAt: snapshot.fetched_at,
    stale: snapshot.stale,
    mid: snapshot.mid || snapshot.price,
    bestBid: snapshot.best_bid,
    bestAsk: snapshot.best_ask,
    spreadBps: snapshot.spread_bps,
    markPrice: snapshot.price,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: snapshot.volume_24h,
    candles: snapshot.candles.map(normalizeCandle),
    bids: snapshot.bids.map(normalizeBookLevel),
    asks: snapshot.asks.map(normalizeBookLevel),
    trades: snapshot.recent_trades.map((trade) => ({
      side: trade.side,
      px: trade.px,
      sz: trade.sz,
      time: trade.time,
    })),
    routeQuotes: [],
  };
}

export function gholaFrameFromJupiter(quote: MobileMarketJupiter | null): GholaMarketFrame | null {
  if (!quote) return null;
  return {
    version: 1,
    venue: "jupiter",
    product: "SOL/USDC",
    interval: "quote",
    fetchedAt: quote.fetched_at,
    stale: quote.stale,
    mid: quote.price,
    bestBid: null,
    bestAsk: null,
    spreadBps: null,
    markPrice: quote.price,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [{
      t: Date.parse(quote.fetched_at) || Date.now(),
      inputAmount: quote.input_amount,
      outputAmount: quote.output_amount,
      price: quote.price,
      priceImpactPct: quote.price_impact_pct,
      slippageBps: quote.slippage_bps,
      routeSummary: quote.route_summary,
    }],
  };
}

export function buildGholaAgentChartOverlays(input: GholaAgentOverlayInput): GholaChartOverlay[] {
  const side: "buy" | "sell" = input.order.side === "sell" ? "sell" : "buy";
  const entryPrice = Number(input.order.limit_price) || Number(input.mid);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return [];
  const slippageBps = finiteOrDefault(Number(input.order.max_slippage_bps || "50"), 50);
  const guardMultiplier = side === "buy" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  const guardPrice = entryPrice * guardMultiplier;
  const status = input.previewCommitment ? "previewed" : input.accountReady ? "preview ready" : "access needed";
  const overlays: GholaChartOverlay[] = [
    {
      id: "agent-slippage-band",
      kind: "price_band",
      label: "Slippage band",
      tone: "accent",
      price: Math.min(entryPrice, guardPrice),
      priceEnd: Math.max(entryPrice, guardPrice),
      side,
      status,
    },
    {
      id: "agent-entry",
      kind: "price_line",
      label: "Entry",
      tone: "accent",
      price: entryPrice,
      side,
      status,
    },
    {
      id: "agent-guard",
      kind: "price_line",
      label: `Slippage cap ${slippageBps} bps`,
      tone: "warn",
      price: guardPrice,
      side,
      status,
    },
  ];
  const triggerLevel = Number(input.order.agent_trigger_level);
  if (Number.isFinite(triggerLevel) && triggerLevel > 0) {
    overlays.push({
      id: "agent-condition-level",
      kind: "price_line",
      label: "Condition level",
      tone: "neutral",
      price: triggerLevel,
      side,
      status,
    });
  }
  const rangeLow = Number(input.order.agent_range_low);
  if (Number.isFinite(rangeLow) && rangeLow > 0) {
    overlays.push({
      id: "agent-range-low",
      kind: "price_line",
      label: "Range low",
      tone: "neutral",
      price: rangeLow,
      side,
      status,
    });
  }
  const rangeHigh = Number(input.order.agent_range_high);
  if (Number.isFinite(rangeHigh) && rangeHigh > 0) {
    overlays.push({
      id: "agent-range-high",
      kind: "price_line",
      label: "Range high",
      tone: "neutral",
      price: rangeHigh,
      side,
      status,
    });
  }
  if (input.previewCommitment) {
    overlays.push({
      id: "preview",
      kind: "event",
      label: "preview",
      tone: "good",
      price: entryPrice,
      detail: input.previewCommitment,
      side,
      status,
    });
  }
  if (input.receiptCommitment) {
    overlays.push({
      id: "receipt",
      kind: "receipt",
      label: "receipt",
      tone: "good",
      price: entryPrice,
      detail: input.receiptCommitment,
      side,
      status: "receipt issued",
    });
  }
  return overlays;
}

export function decimateCandles(candles: GholaChartCandle[], maxPoints: number): GholaChartCandle[] {
  if (candles.length <= maxPoints || maxPoints <= 0) return candles.slice();
  const bucketSize = Math.ceil(candles.length / Math.max(1, Math.floor(maxPoints / 2)));
  const output: GholaChartCandle[] = [];
  for (let start = 0; start < candles.length; start += bucketSize) {
    const bucket = candles.slice(start, start + bucketSize);
    let high = bucket[0];
    let low = bucket[0];
    for (const candle of bucket) {
      if (Number(candle.h) > Number(high.h)) high = candle;
      if (Number(candle.l) < Number(low.l)) low = candle;
    }
    const ordered = [high, low].sort((a, b) => a.t - b.t);
    for (const candle of ordered) {
      if (output[output.length - 1] !== candle) output.push(candle);
    }
  }
  const latest = candles[candles.length - 1];
  if (latest && output[output.length - 1]?.t !== latest.t) output.push(latest);
  return output.slice(-maxPoints);
}

export function cumulativeDepth(levels: GholaChartBookLevel[], side: "bid" | "ask") {
  let cumulative = 0;
  const points = levels
    .map((level) => {
      const px = Number(level.px);
      const sz = Number(level.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;
      cumulative += sz;
      return { px, sz, cumulative };
    })
    .filter(Boolean) as Array<{ px: number; sz: number; cumulative: number }>;
  return side === "bid"
    ? points.sort((a, b) => a.px - b.px)
    : points.sort((a, b) => a.px - b.px);
}

export function frameMidNumber(frame: GholaMarketFrame | null): number | null {
  if (!frame) return null;
  for (const value of [frame.mid, frame.markPrice, frame.bestBid && frame.bestAsk ? String((Number(frame.bestBid) + Number(frame.bestAsk)) / 2) : null]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function normalizeCandle(candle: { t: number; T?: number | null; o: string; h: string; l: string; c: string; v: string; n?: number | null }): GholaChartCandle {
  return {
    t: candle.t,
    T: candle.T ?? null,
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
    v: candle.v,
    n: candle.n ?? null,
  };
}

function normalizeBookLevel(level: { px: string; sz: string; n?: number | null }): GholaChartBookLevel {
  return {
    px: level.px,
    sz: level.sz,
    n: level.n ?? null,
  };
}

function finiteOrDefault(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
