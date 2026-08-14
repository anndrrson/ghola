export const MARKET_COMPONENTS = [
  "quote",
  "book",
  "market",
  "mark",
  "candles",
  "trades",
] as const;

export type MarketComponent = (typeof MARKET_COMPONENTS)[number];
export type MarketComponentClocks = Partial<Record<MarketComponent, number>>;

const attachedClocks = new WeakMap<object, MarketComponentClocks>();
const suppressedInferredClocks = new WeakMap<object, ReadonlySet<MarketComponent>>();
const attachedUpdates = new WeakMap<object, ReadonlySet<MarketComponent>>();

export function marketComponentClocks(value: unknown): MarketComponentClocks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clocks = {
    ...inferMarketComponentClocks(value as Record<string, unknown>),
    ...attachedClocks.get(value),
  };
  for (const component of suppressedInferredClocks.get(value) ?? []) delete clocks[component];
  return clocks;
}

export function advanceMarketComponent<T extends object>(
  previous: T,
  next: T,
  component: MarketComponent,
  sourceTimestamp: unknown,
): T {
  return advanceMarketComponents(previous, next, { [component]: sourceTimestamp });
}

export function advanceMarketComponents<T extends object>(
  previous: T,
  next: T,
  updates: Partial<Record<MarketComponent, unknown>>,
): T {
  if (next === previous) return previous;
  const previousClocks = marketComponentClocks(previous);
  const suppressed = new Set(suppressedInferredClocks.get(previous) ?? []);
  const clocks = { ...previousClocks };
  const changed = new Set<MarketComponent>();
  for (const component of MARKET_COMPONENTS) {
    if (!Object.prototype.hasOwnProperty.call(updates, component)) continue;
    const timestamp = normalizeMarketTimestamp(updates[component]);
    if (timestamp == null) continue;
    clocks[component] = timestamp;
    suppressed.delete(component);
    changed.add(component);
  }
  for (const component of MARKET_COMPONENTS) {
    if (clocks[component] == null) suppressed.add(component);
  }
  attachedClocks.set(next, clocks);
  if (suppressed.size > 0) suppressedInferredClocks.set(next, suppressed);
  if (changed.size > 0) attachedUpdates.set(next, changed);
  return next;
}

export function marketComponentUpdates(value: unknown): ReadonlySet<MarketComponent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Set();
  return attachedUpdates.get(value) ?? new Set();
}

export function hasAuthoritativePricingUpdate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const updates = marketComponentUpdates(value);
  const hasDisplayedQuote = positiveMarketValue(snapshot.best_bid) ||
    positiveMarketValue(snapshot.best_ask);
  return hasDisplayedQuote
    ? updates.has("quote")
    : updates.has("market") || updates.has("mark");
}

export function hasAuthoritativeDepthUpdate(value: unknown): boolean {
  return marketComponentUpdates(value).has("book");
}

export function carryMarketComponentClocks<T extends object>(source: unknown, target: T): T {
  const clocks = marketComponentClocks(source);
  if (MARKET_COMPONENTS.some((component) => clocks[component] != null)) {
    attachedClocks.set(target, clocks);
  }
  const suppressed = source && typeof source === "object" && !Array.isArray(source)
    ? suppressedInferredClocks.get(source)
    : undefined;
  if (suppressed && suppressed.size > 0) suppressedInferredClocks.set(target, suppressed);
  return target;
}

export function attachMarketComponentClocks<T extends object>(
  target: T,
  clocks: MarketComponentClocks,
  suppressMissing = false,
): T {
  const normalized: MarketComponentClocks = {};
  for (const component of MARKET_COMPONENTS) {
    const timestamp = normalizeMarketTimestamp(clocks[component]);
    if (timestamp != null) normalized[component] = timestamp;
  }
  if (MARKET_COMPONENTS.some((component) => normalized[component] != null)) {
    attachedClocks.set(target, normalized);
  }
  if (suppressMissing) {
    suppressedInferredClocks.set(
      target,
      new Set(MARKET_COMPONENTS.filter((component) => normalized[component] == null)),
    );
  }
  return target;
}

export function normalizeMarketTimestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeMarketTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function inferMarketComponentClocks(snapshot: Record<string, unknown>): MarketComponentClocks {
  const clocks: MarketComponentClocks = {};
  const sourceTimestamp = normalizeMarketTimestamp(snapshot.source_timestamp);
  const hasExplicitBookTimestamp = Object.prototype.hasOwnProperty.call(snapshot, "book_updated_at");
  const hasExplicitMarketTimestamp = Object.prototype.hasOwnProperty.call(snapshot, "market_updated_at");
  const bookTimestamp = normalizeMarketTimestamp(snapshot.book_updated_at);
  const marketTimestamp = normalizeMarketTimestamp(snapshot.market_updated_at);
  const candleTimestamp = latestArrayTimestamp(snapshot.candles, "t");
  const tradeTimestamp = latestArrayTimestamp(snapshot.recent_trades, "time");
  const hasBook = (
    Array.isArray(snapshot.bids) && snapshot.bids.length > 0 &&
    Array.isArray(snapshot.asks) && snapshot.asks.length > 0
  ) || (snapshot.best_bid != null && snapshot.best_ask != null);
  const hasMarket = snapshot.mid != null || snapshot.mark_price != null || snapshot.price != null;

  if (bookTimestamp != null) {
    clocks.book = bookTimestamp;
    if (hasBook) clocks.quote = bookTimestamp;
  } else if (!hasExplicitBookTimestamp && hasBook && sourceTimestamp != null) {
    clocks.book = sourceTimestamp;
    clocks.quote = sourceTimestamp;
  }
  if (marketTimestamp != null) clocks.market = marketTimestamp;
  else if (!hasExplicitMarketTimestamp && !hasBook && hasMarket && sourceTimestamp != null) clocks.market = sourceTimestamp;
  if (candleTimestamp != null) clocks.candles = candleTimestamp;
  if (tradeTimestamp != null) clocks.trades = tradeTimestamp;
  return clocks;
}

function latestArrayTimestamp(value: unknown, key: string): number | null {
  if (!Array.isArray(value)) return null;
  let latest: number | null = null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const timestamp = normalizeMarketTimestamp((item as Record<string, unknown>)[key]);
    if (timestamp != null && (latest == null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function positiveMarketValue(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}
