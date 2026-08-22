import { getCoinbaseMarketSnapshot, type CoinbaseProductId } from "./coinbase-market-data";
import { getHyperliquidMarketSnapshot, getHyperliquidMarketUniverse } from "./hyperliquid-market-data";

const WARM_INTERVAL_MS = 4_500;
const POPULAR_COINBASE_MARKETS: CoinbaseProductId[] = ["BTC-USD", "ETH-USD", "SOL-USD"];
const POPULAR_HYPERLIQUID_MARKETS = ["BTC", "ETH", "SOL"] as const;

type MarketWarmerState = {
  timer: ReturnType<typeof setInterval>;
  refresh: Promise<void> | null;
};

const warmerGlobal = globalThis as typeof globalThis & {
  __gholaMarketWarmerV1?: MarketWarmerState;
};

/**
 * Keeps the liquid default markets hot in a long-lived Node process. Serverless
 * runtimes may suspend the timer between requests; stale-while-revalidate in the
 * snapshot stores remains the correctness and latency fallback there.
 */
export function ensureMarketDataWarmer() {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  const existing = warmerGlobal.__gholaMarketWarmerV1;
  if (existing) return existing.refresh ?? Promise.resolve();
  const state: MarketWarmerState = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    refresh: null,
  };
  const refresh = () => {
    if (state.refresh) return state.refresh;
    state.refresh = refreshPopularMarkets().finally(() => {
      state.refresh = null;
    });
    return state.refresh;
  };
  state.timer = setInterval(() => void refresh(), WARM_INTERVAL_MS);
  state.timer.unref?.();
  warmerGlobal.__gholaMarketWarmerV1 = state;
  return refresh();
}

async function refreshPopularMarkets() {
  const tasks: Array<Promise<unknown>> = [
    getHyperliquidMarketUniverse(),
    ...POPULAR_COINBASE_MARKETS.map((productId) => getCoinbaseMarketSnapshot({
      productId,
      interval: "1m",
      cacheMode: "refresh",
    })),
    ...POPULAR_HYPERLIQUID_MARKETS.map((coin) => getHyperliquidMarketSnapshot({
      network: "mainnet",
      coin,
      interval: "1m",
      cacheMode: "refresh",
    })),
  ];
  await Promise.allSettled(tasks);
}

export function resetMarketDataWarmerForTests() {
  const state = warmerGlobal.__gholaMarketWarmerV1;
  if (!state) return;
  clearInterval(state.timer);
  delete warmerGlobal.__gholaMarketWarmerV1;
}
