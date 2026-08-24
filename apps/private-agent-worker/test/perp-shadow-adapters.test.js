import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCorePerpShadowSet,
  fetchPerpShadowVenue,
  parseAsterShadow,
  parseDydxShadow,
  parseEdgeXShadow,
  parseHyperliquidShadow,
  parseLighterShadow,
  parseVariationalShadow,
} from "../src/execution/perp-shadow-adapters.js";

const NOW = 1_800_000_000_000;

test("normalizes Hyperliquid public perp context without claiming missing fee data", () => {
  const [snapshot] = parseHyperliquidShadow({
    body: [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
      [{ markPx: "60000.1", oraclePx: "60001.2", funding: "0.0000125", impactPxs: ["59999", "60002"] }],
    ],
    now_ms: NOW,
  });
  assert.equal(snapshot.venue_id, "hyperliquid");
  assert.equal(snapshot.funding_rate_e12_per_interval, 12_500_000);
  assert.equal(snapshot.funding_interval_ms, 3_600_000);
  assert.equal(snapshot.quantity_step_e8, 1_000);
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.executable, false);
});

test("normalizes Lighter funding as the documented 8-hour-equivalent value", () => {
  const [snapshot] = parseLighterShadow({
    details: {
      order_book_details: [{
        market_id: 0,
        symbol: "BTC",
        mark_price: "60000",
        index_price: "60001",
        best_bid: "59999",
        best_ask: "60002",
        maker_fee_rate: "0.0001",
        taker_fee_rate: "0.0002",
        min_quote_amount: "10",
        supported_size_decimals: 5,
        supported_price_decimals: 1,
        default_initial_margin_fraction: 500,
        maintenance_margin_fraction: 120,
        liquidation_fee: "1.0",
      }],
    },
    funding: { funding_rates: [{ market_id: 0, exchange: "lighter", symbol: "BTC", rate: "0.0001" }] },
    now_ms: NOW,
  });
  assert.equal(snapshot.funding_rate_e12_per_interval, 100_000_000);
  assert.equal(snapshot.funding_interval_ms, 28_800_000);
  assert.equal(snapshot.initial_margin_bps, 500);
  assert.equal(snapshot.maintenance_margin_bps, 120);
  assert.equal(snapshot.status, "ready");
});

test("normalizes Aster V3 exchange, premium, and book schemas", () => {
  const [snapshot] = parseAsterShadow({
    exchange_info: {
      serverTime: NOW,
      symbols: [{
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        requiredMarginPercent: "5.0",
        maintMarginPercent: "2.5",
        liquidationFee: "0.025",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.1" },
          { filterType: "LOT_SIZE", stepSize: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      }],
    },
    premium_index: [{ symbol: "BTCUSDT", markPrice: "60000", indexPrice: "60001", lastFundingRate: "0.0001", time: NOW }],
    book_tickers: [{ symbol: "BTCUSDT", bidPrice: "59999", askPrice: "60002", time: NOW }],
    now_ms: NOW,
  });
  assert.equal(snapshot.contract_id, "aster:BTCUSDT");
  assert.equal(snapshot.price_tick_e8, 10_000_000);
  assert.equal(snapshot.quantity_step_e8, 100_000);
  assert.equal(snapshot.status, "degraded");
});

test("live Aster shadow selection emits one deterministic contract per asset", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("exchangeInfo")) return response({
      serverTime: NOW,
      symbols: [
        asterSymbol("BTCUSD1", "BTC", "USD1"),
        asterSymbol("BTCUSDT", "BTC", "USDT"),
      ],
    });
    if (value.includes("premiumIndex")) return response([
      asterPremium("BTCUSD1"),
      asterPremium("BTCUSDT"),
    ]);
    return response([
      asterBook("BTCUSD1"),
      asterBook("BTCUSDT"),
    ]);
  };
  const snapshots = await fetchPerpShadowVenue({
    venue_id: "aster",
    fetchImpl,
    now_ms: NOW,
    assets: ["BTC"],
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.contract_id), ["aster:BTCUSDT"]);
});

test("normalizes edgeX funding interval and contract metadata", () => {
  const [snapshot] = parseEdgeXShadow({
    funding: {
      code: "SUCCESS",
      responseTime: String(NOW),
      data: [{
        contractId: "10000001",
        fundingTimestamp: String(NOW),
        oraclePrice: "60000",
        indexPrice: "60001",
        fundingRate: "-0.00005537",
        impactBidPrice: "59999",
        impactAskPrice: "60002",
        fundingRateIntervalMin: "240",
      }],
    },
    contracts: [{
      contractId: "10000001",
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      makerFeeRate: "0.0001",
      takerFeeRate: "0.0002",
      liquidateFeeRate: "0.01",
      riskTierList: [{ positionValueUpperBound: "800000", maxLeverage: "100", maintenanceMarginRate: "0.005" }],
      minNotional: "10",
      stepSize: "0.001",
      tickSize: "0.1",
    }],
    now_ms: NOW,
  });
  assert.equal(snapshot.funding_rate_e12_per_interval, -55_370_000);
  assert.equal(snapshot.funding_interval_ms, 14_400_000);
  assert.equal(snapshot.initial_margin_bps, 100);
  assert.equal(snapshot.maintenance_margin_bps, 50);
  assert.equal(snapshot.status, "ready");
  assert.ok(snapshot.quality_flags.includes("impact_mid_used_as_mark_proxy"));
});

test("fetches fresh edgeX V2 metadata, ticker, and funding", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("getMetaData")) return response({
      data: {
        global: { collateralCoinId: "1000" },
        coinList: [
          { coinId: "1000", coinName: "USDC" },
          { coinId: "1001", coinName: "BTC" },
        ],
        contractList: [{
          contractId: "30000001",
          contractName: "BTCUSDC",
          baseCoinId: "1001",
          quoteCoinId: "1000",
          minOrderSize: "0.001",
          stepSize: "0.001",
          tickSize: "0.1",
          defaultMakerFeeRate: "0.0004",
          defaultTakerFeeRate: "0.00045",
          fundingRateIntervalMin: "240",
          riskTierList: [{ positionValueUpperBound: "500000", maxLeverage: "100", maintenanceMarginRate: "0.005" }],
        }],
      },
      responseTime: String(NOW),
    });
    if (value.includes("getTicker")) return response({
      data: [{ contractId: "30000001", markPrice: "60000", indexPrice: "60001" }],
      responseTime: String(NOW),
    });
    return response({
      data: [{
        contractId: "30000001",
        fundingTimestamp: String(NOW),
        markPrice: "60000",
        indexPrice: "60001",
        fundingRate: "0.00005",
        impactBidPrice: "59999",
        impactAskPrice: "60002",
        fundingRateIntervalMin: "240",
      }],
      responseTime: String(NOW),
    });
  };
  const [snapshot] = await fetchPerpShadowVenue({
    venue_id: "edgex",
    fetchImpl,
    now_ms: NOW,
    assets: ["BTC"],
  });
  assert.equal(snapshot.contract_id, "edgex:30000001");
  assert.equal(snapshot.quote_asset, "USDC");
  assert.equal(snapshot.collateral_asset, "USDC");
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.source_schema, "edgex_public_v2");
});

test("normalizes dYdX v4 markets, funding, and orderbook without inventing fees", () => {
  const [snapshot] = parseDydxShadow({
    markets: { markets: { "BTC-USD": {
      ticker: "BTC-USD",
      status: "ACTIVE",
      oraclePrice: "60001",
      nextFundingRate: "0.00000315384615384615",
      initialMarginFraction: "0.02",
      maintenanceMarginFraction: "0.012",
      tickSize: "1",
      stepSize: "0.0001",
    } } },
    books: { "BTC-USD": { bids: [{ price: "59999" }], asks: [{ price: "60003" }] } },
    server_time: { iso: new Date(NOW).toISOString() },
    now_ms: NOW,
  });
  assert.equal(snapshot.contract_id, "dydx:BTC-USD");
  assert.equal(snapshot.mark_price_e8, 6_000_100_000_000);
  assert.equal(snapshot.funding_rate_e12_per_interval, 3_153_846);
  assert.equal(snapshot.quantity_step_e8, 10_000);
  assert.equal(snapshot.status, "degraded");
  assert.deepEqual(snapshot.missing_fields, ["maker_fee_bps", "taker_fee_bps", "minimum_notional_micro_usdc", "liquidation_fee_bps"]);
});

test("keeps Variational read-only and quarantined while its trading API and index data are unavailable", () => {
  const [snapshot] = parseVariationalShadow({
    stats: {
      listings: [{
        ticker: "BTC",
        mark_price: "60000",
        funding_rate: "0.0001",
        funding_interval_s: 28_800,
        quotes: { updated_at: new Date(NOW).toISOString(), size_1k: { bid: "59999", ask: "60002" } },
      }],
    },
    now_ms: NOW,
  });
  assert.equal(snapshot.trading_api_available, false);
  assert.equal(snapshot.status, "quarantined");
  assert.ok(snapshot.missing_fields.includes("index_price_e8"));
});

test("all five shadow fetchers are read-only and never call private or order endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body || null });
    let body = {};
    if (String(url).includes("hyperliquid")) body = [{ universe: [] }, []];
    else if (String(url).includes("orderBookDetails")) body = { order_book_details: [] };
    else if (String(url).includes("funding-rates")) body = { funding_rates: [] };
    else if (String(url).includes("exchangeInfo")) body = { symbols: [] };
    else if (String(url).includes("premiumIndex") || String(url).includes("bookTicker")) body = [];
    else if (String(url).includes("getLatestFundingRate")) body = { data: [] };
    else if (String(url).includes("perpetualMarkets")) body = { markets: {} };
    else if (String(url).endsWith("/v4/time")) body = { iso: new Date(NOW).toISOString() };
    return { ok: true, json: async () => body };
  };
  const result = await fetchCorePerpShadowSet({ fetchImpl, now_ms: NOW, timeout_ms: 1_000 });
  assert.equal(result.length, 5);
  assert.ok(result.every((item) => item.ok));
  assert.ok(calls.every((call) => call.method === "GET" || (
    call.method === "POST" && call.url.endsWith("/info") && JSON.parse(call.body).type === "metaAndAssetCtxs"
  )));
  assert.ok(calls.every((call) => !/\/private\/|\/order(?:\?|$)/i.test(call.url)));
});

function response(body) {
  return { ok: true, json: async () => body };
}

function asterSymbol(symbol, baseAsset, quoteAsset) {
  return {
    symbol,
    baseAsset,
    quoteAsset,
    marginAsset: quoteAsset,
    contractType: "PERPETUAL",
    status: "TRADING",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "0.001" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  };
}

function asterPremium(symbol) {
  return { symbol, markPrice: "60000", indexPrice: "60001", lastFundingRate: "0.0001", time: NOW };
}

function asterBook(symbol) {
  return { symbol, bidPrice: "59999", askPrice: "60002", time: NOW };
}
