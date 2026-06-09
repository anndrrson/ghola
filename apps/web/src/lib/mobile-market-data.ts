import {
  getCoinbaseMarketSnapshot,
  normalizeCoinbaseMarketInput,
  type CoinbaseBookLevel,
  type CoinbaseCandle,
  type CoinbaseCandleInterval,
  type CoinbaseMarketSnapshot,
  type CoinbaseProductId,
} from "./coinbase-market-data";
import {
  getPhoenixMarketSnapshot,
  type PhoenixBookLevel,
  type PhoenixCandle,
  type PhoenixCandleInterval,
  type PhoenixMarketSnapshot,
} from "./phoenix-market-data";

export type MobileMarketProductId = CoinbaseProductId;
export type MobileMarketInterval = CoinbaseCandleInterval;
export type MobileMarketLiveStatus = "connecting" | "live" | "fallback" | "stale" | "degraded";

export interface MobileMarketCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface MobileMarketBookLevel {
  px: string;
  sz: string;
}

export interface MobileMarketPrimary {
  platform: "coinbase";
  source: string | null;
  stale: boolean;
  price: string | null;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  price_percentage_change_24h: string | null;
  volume_24h: string | null;
  candles: MobileMarketCandle[];
  bids: MobileMarketBookLevel[];
  asks: MobileMarketBookLevel[];
}

export interface MobileMarketPhoenix {
  platform: "phoenix";
  source: string | null;
  stale: boolean;
  mid: string | null;
  mark_price: string | null;
  oracle_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  funding_rate: string | null;
  open_interest: string | null;
  day_notional_volume: string | null;
  candles: MobileMarketCandle[];
  bids: MobileMarketBookLevel[];
  asks: MobileMarketBookLevel[];
}

export interface MobileMarketJupiter {
  platform: "jupiter";
  input_mint: string;
  output_mint: string;
  input_amount: string;
  output_amount: string | null;
  price: string | null;
  price_impact_pct: string | null;
  slippage_bps: number;
  route_summary: string[];
  fetched_at: string;
  stale: boolean;
}

export interface MobileMarketSolanaDex {
  symbol: "SOL";
  phoenix: MobileMarketPhoenix | null;
  jupiter: MobileMarketJupiter | null;
}

export interface MobileMarketSnapshot {
  version: 1;
  product_id: MobileMarketProductId;
  base_currency: "BTC" | "ETH" | "SOL";
  quote_currency: "USD";
  interval: MobileMarketInterval;
  fetched_at: string;
  live_status: MobileMarketLiveStatus;
  warnings: string[];
  primary: MobileMarketPrimary;
  solana_dex: MobileMarketSolanaDex | null;
}

export interface MobileMarketSnapshotInput {
  productId?: string | null;
  interval?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  getCoinbaseSnapshot?: typeof getCoinbaseMarketSnapshot;
  getPhoenixSnapshot?: typeof getPhoenixMarketSnapshot;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SOL_AMOUNT_LAMPORTS = "1000000000";
const JUPITER_SLIPPAGE_BPS = 50;

export function normalizeMobileMarketInput(input: MobileMarketSnapshotInput): {
  productId: MobileMarketProductId;
  interval: MobileMarketInterval;
} {
  return normalizeCoinbaseMarketInput({
    productId: input.productId,
    interval: input.interval,
  });
}

export async function getMobileMarketSnapshot(input: MobileMarketSnapshotInput = {}): Promise<MobileMarketSnapshot> {
  const normalized = normalizeMobileMarketInput(input);
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const getCoinbase = input.getCoinbaseSnapshot ?? getCoinbaseMarketSnapshot;
  const coinbase = await getCoinbase({
    productId: normalized.productId,
    interval: normalized.interval,
    now,
    fetchImpl: input.fetchImpl,
  });
  if (coinbase.stale) warnings.push("coinbase_stale");

  let solanaDex: MobileMarketSolanaDex | null = null;
  if (normalized.productId === "SOL-USD") {
    const [phoenixResult, jupiterResult] = await Promise.allSettled([
      fetchPhoenixForMobile(normalized.interval, now, input.getPhoenixSnapshot ?? getPhoenixMarketSnapshot),
      fetchJupiterRouteQuote(now, input.fetchImpl ?? fetch),
    ]);
    const phoenix = phoenixResult.status === "fulfilled" ? phoenixResult.value : null;
    const jupiter = jupiterResult.status === "fulfilled" ? jupiterResult.value : null;
    if (!phoenix || phoenix.stale) warnings.push("phoenix_limited");
    if (!jupiter || jupiter.stale) warnings.push("jupiter_limited");
    solanaDex = { symbol: "SOL", phoenix, jupiter };
  }

  return {
    version: 1,
    product_id: normalized.productId,
    base_currency: coinbase.base_currency_id,
    quote_currency: "USD",
    interval: normalized.interval,
    fetched_at: now.toISOString(),
    live_status: liveStatus(coinbase, solanaDex, warnings),
    warnings,
    primary: coinbaseToMobilePrimary(coinbase),
    solana_dex: solanaDex,
  };
}

function liveStatus(
  coinbase: CoinbaseMarketSnapshot,
  solanaDex: MobileMarketSolanaDex | null,
  warnings: string[],
): MobileMarketLiveStatus {
  if (coinbase.stale && coinbase.candles.length === 0) return "stale";
  if (warnings.length > 0) return solanaDex ? "degraded" : "fallback";
  return "live";
}

async function fetchPhoenixForMobile(
  interval: MobileMarketInterval,
  now: Date,
  getPhoenix: typeof getPhoenixMarketSnapshot,
): Promise<MobileMarketPhoenix> {
  const snapshot = await getPhoenix({
    symbol: "SOL",
    interval: interval as PhoenixCandleInterval,
    now,
  });
  return {
    platform: "phoenix",
    source: snapshot.source,
    stale: snapshot.stale,
    mid: snapshot.mid,
    mark_price: snapshot.mark_price,
    oracle_price: snapshot.oracle_price,
    best_bid: snapshot.best_bid,
    best_ask: snapshot.best_ask,
    spread_bps: snapshot.spread_bps,
    funding_rate: snapshot.funding_rate,
    open_interest: snapshot.open_interest,
    day_notional_volume: snapshot.day_notional_volume,
    candles: snapshot.candles.map(phoenixCandle),
    bids: snapshot.bids.map(phoenixBookLevel),
    asks: snapshot.asks.map(phoenixBookLevel),
  };
}

async function fetchJupiterRouteQuote(now: Date, fetchImpl: typeof fetch): Promise<MobileMarketJupiter> {
  const quoteUrl = new URL(process.env.JUPITER_QUOTE_API_URL || DEFAULT_JUPITER_QUOTE_URL);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", USDC_MINT);
  quoteUrl.searchParams.set("amount", JUPITER_SOL_AMOUNT_LAMPORTS);
  quoteUrl.searchParams.set("slippageBps", String(JUPITER_SLIPPAGE_BPS));
  const response = await fetchImpl(quoteUrl, {
    headers: { "cache-control": "no-cache" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`jupiter_quote_${response.status}`);
  }
  const body = readRecord(await response.json());
  const outAmount = safeDecimalString(body?.outAmount);
  const routePlan = Array.isArray(body?.routePlan) ? body.routePlan : [];
  return {
    platform: "jupiter",
    input_mint: SOL_MINT,
    output_mint: USDC_MINT,
    input_amount: safeDecimalString(body?.inAmount) ?? JUPITER_SOL_AMOUNT_LAMPORTS,
    output_amount: outAmount,
    price: outAmount ? trimNumber(Number(outAmount) / 1_000_000) : null,
    price_impact_pct: safeSignedDecimalString(body?.priceImpactPct),
    slippage_bps: Number(body?.slippageBps) || JUPITER_SLIPPAGE_BPS,
    route_summary: routePlan.map(routeLabel).filter(Boolean).slice(0, 4) as string[],
    fetched_at: now.toISOString(),
    stale: false,
  };
}

function coinbaseToMobilePrimary(snapshot: CoinbaseMarketSnapshot): MobileMarketPrimary {
  return {
    platform: "coinbase",
    source: snapshot.source,
    stale: snapshot.stale,
    price: snapshot.price,
    mid: snapshot.mid,
    best_bid: snapshot.best_bid,
    best_ask: snapshot.best_ask,
    spread_bps: snapshot.spread_bps,
    price_percentage_change_24h: snapshot.price_percentage_change_24h,
    volume_24h: snapshot.volume_24h,
    candles: snapshot.candles.map(coinbaseCandle),
    bids: snapshot.bids.map(coinbaseBookLevel),
    asks: snapshot.asks.map(coinbaseBookLevel),
  };
}

function coinbaseCandle(candle: CoinbaseCandle): MobileMarketCandle {
  return { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v };
}

function phoenixCandle(candle: PhoenixCandle): MobileMarketCandle {
  return { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v };
}

function coinbaseBookLevel(level: CoinbaseBookLevel): MobileMarketBookLevel {
  return { px: level.px, sz: level.sz };
}

function phoenixBookLevel(level: PhoenixBookLevel): MobileMarketBookLevel {
  return { px: level.px, sz: level.sz };
}

function routeLabel(value: unknown): string | null {
  const row = readRecord(value);
  const swapInfo = readRecord(row?.swapInfo);
  const label = safeLabel(swapInfo?.label ?? swapInfo?.ammKey);
  const percent = typeof row?.percent === "number" ? `${row.percent}%` : null;
  if (!label && !percent) return null;
  return [label, percent].filter(Boolean).join(" ");
}

function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 48) : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

function safeSignedDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

function trimNumber(value: number): string {
  return Number(value).toString();
}
