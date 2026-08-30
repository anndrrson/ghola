import assert from "node:assert/strict";
import test from "node:test";
import {
  carryShadowFetchTimeoutMs,
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

test("normalizes Hyperliquid public base economics conservatively", () => {
  const [snapshot] = parseHyperliquidShadow({
    body: [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
      [{ markPx: "60000.1", oraclePx: "60001.2", funding: "0.0000125", impactPxs: ["59999", "60002"] }],
    ],
    books: {
      BTC: {
        time: NOW,
        levels: [
          [{ px: "59998", sz: "1" }],
          [{ px: "60003", sz: "1" }],
        ],
      },
    },
    now_ms: NOW,
  });
  assert.equal(snapshot.venue_id, "hyperliquid");
  assert.equal(snapshot.quote_asset, "USDT");
  assert.equal(snapshot.best_bid_e8, 5_999_800_000_000);
  assert.equal(snapshot.best_ask_e8, 6_000_300_000_000);
  assert.deepEqual(snapshot.depth_bids, [{ price_e8: 5_999_800_000_000, size_e8: 100_000_000 }]);
  assert.equal(snapshot.impact_bid_e8, 5_999_900_000_000);
  assert.equal(snapshot.funding_rate_e12_per_interval, 12_500_000);
  assert.equal(snapshot.funding_interval_ms, 3_600_000);
  assert.equal(snapshot.quantity_step_e8, 1_000);
  assert.equal(snapshot.price_tick_e8, 100_000_000);
  assert.equal(snapshot.maker_fee_bps, 2);
  assert.equal(snapshot.taker_fee_bps, 5);
  assert.equal(snapshot.minimum_notional_micro_usdc, 10_000_000);
  assert.equal(snapshot.liquidation_fee_bps, 0);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.executable, false);
  assert.ok(snapshot.quality_flags.includes("fees_venue_base_tier_ceiling"));
  assert.ok(snapshot.quality_flags.includes("fee_precision_rounded_up_to_bps"));
  assert.ok(snapshot.quality_flags.includes("minimum_notional_protocol_floor"));
  assert.ok(snapshot.quality_flags.includes("liquidation_has_no_clearance_fee"));
  assert.ok(snapshot.quality_flags.includes("contract_specs_usdt_denominated_usdc_margined"));
});

test("maps Hyperliquid's documented USDC-denominated validator-perp exceptions", () => {
  const snapshots = parseHyperliquidShadow({
    body: [
      { universe: [
        { name: "HYPE", szDecimals: 2, maxLeverage: 10 },
        { name: "PURR", szDecimals: 0, maxLeverage: 3 },
      ] },
      [
        { markPx: "50", oraclePx: "50", funding: "0" },
        { markPx: "0.1", oraclePx: "0.1", funding: "0" },
      ],
    ],
    now_ms: NOW,
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.quote_asset), ["USDC", "USDC"]);
  assert.ok(snapshots.every((snapshot) => snapshot.quality_flags.includes("contract_specs_usdc_denominated_usdc_margined")));
});

test("normalizes Lighter funding as the documented hourly settlement value", () => {
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
        min_initial_margin_fraction: 200,
        maintenance_margin_fraction: 120,
        liquidation_fee: "1.0",
      }],
    },
    funding: { timestamp: NOW, funding_rates: [{ market_id: 0, exchange: "lighter", symbol: "BTC", rate: "0.0001", timestamp: NOW }] },
    order_books: [{
      market_id: 0,
      timestamp: NOW,
      bids: [{ price: "59999", remaining_base_amount: "1.25" }],
      asks: [{ price: "60002", remaining_base_amount: "0.75" }],
    }],
    now_ms: NOW,
  });
  assert.equal(snapshot.funding_rate_e12_per_interval, 100_000_000);
  assert.equal(snapshot.funding_interval_ms, 3_600_000);
  assert.equal(snapshot.initial_margin_bps, 200);
  assert.equal(snapshot.maintenance_margin_bps, 120);
  assert.equal(snapshot.depth_asks[0].size_e8, 75_000_000);
  assert.equal(snapshot.status, "ready");
});

test("quarantines Lighter when funding age is stale despite a fresh market and book", () => {
  const [snapshot] = parseLighterShadow({
    details: { timestamp: Math.floor(NOW / 1_000), order_book_details: [{
      market_id: 0,
      symbol: "BTC",
      mark_price: "60000",
      index_price: "60001",
      best_bid: "59999",
      best_ask: "60002",
      maker_fee_rate: "0",
      taker_fee_rate: "0",
      min_quote_amount: "10",
      supported_size_decimals: 5,
      supported_price_decimals: 1,
      min_initial_margin_fraction: 200,
      maintenance_margin_fraction: 120,
      liquidation_fee: "1",
    }] },
    funding: { timestamp: NOW - 30_001, funding_rates: [{ market_id: 0, exchange: "lighter", rate: "0.0001" }] },
    order_books: [{ market_id: 0, timestamp: Math.floor(NOW / 1_000), bids: [{ price: "59999", size: "1" }], asks: [{ price: "60002", size: "1" }] }],
    now_ms: NOW,
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.status, "quarantined");
  assert.deepEqual(snapshot.stale_sources, ["funding"]);
});

test("fetches Lighter market, funding, and book timing from its public read-only WebSocket", async () => {
  const sourceNow = NOW + 5_500;
  const sockets = [];
  const sent = [];
  class PublicLighterSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(payload) {
      const message = JSON.parse(payload);
      sent.push(message);
      if (message.channel === "market_stats/all") {
        this.emit("message", { data: JSON.stringify({
          channel: "market_stats:all",
          timestamp: sourceNow - 1,
          type: "update/market_stats",
          market_stats: { 0: { market_id: 0, symbol: "ETH" } },
        }) });
        this.emit("message", { data: JSON.stringify({
          channel: "market_stats:all",
          timestamp: sourceNow,
          type: "update/market_stats",
          market_stats: {
            0: {
              market_id: 0,
              symbol: "ETH",
              mark_price: "2500",
              index_price: "2501",
              best_bid_price: "2499",
              best_ask_price: "2502",
              current_funding_rate: "0.0001",
              funding_rate: "0.0001",
              funding_timestamp: sourceNow - 1_000,
            },
            1: {
              market_id: 1,
              symbol: "BTC",
              mark_price: "60000",
              index_price: "60001",
              best_bid_price: "59999",
              best_ask_price: "60002",
              current_funding_rate: "0.0002",
              funding_rate: "0.0001",
              funding_timestamp: sourceNow - 1_000,
            },
          },
        }) });
      }
      if (message.channel === "order_book/1") {
        this.emit("message", { data: JSON.stringify({
          channel: "order_book:1",
          timestamp: sourceNow - 1,
          type: "update/order_book",
          order_book: { bids: [{ price: "59998", size: "1" }] },
        }) });
        this.emit("message", { data: JSON.stringify({
          channel: "order_book:1",
          timestamp: sourceNow,
          type: "update/order_book",
          order_book: {
            bids: [{ price: "59999", size: "1.25" }],
            asks: [{ price: "60002", size: "0.75" }],
          },
        }) });
      }
      if (message.channel === "order_book/0") {
        this.emit("message", { data: JSON.stringify({
          channel: "order_book:0",
          timestamp: sourceNow,
          type: "update/order_book",
          order_book: {
            bids: [{ price: "2499", size: "2" }],
            asks: [{ price: "2502", size: "3" }],
          },
        }) });
      }
    }

    close() {}

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }
  const fetchImpl = async (url) => {
    assert.match(String(url), /orderBookDetails$/);
    return response({ order_book_details: [
      {
        market_id: 1,
        symbol: "BTC",
        taker_fee: "0.0002",
        maker_fee: "0.0001",
        liquidation_fee: "0.01",
        min_quote_amount: "10",
        supported_size_decimals: 5,
        supported_price_decimals: 1,
        min_initial_margin_fraction: 200,
        maintenance_margin_fraction: 120,
      },
      {
        market_id: 0,
        symbol: "ETH",
        taker_fee: "0.0002",
        maker_fee: "0.0001",
        liquidation_fee: "0.01",
        min_quote_amount: "10",
        supported_size_decimals: 4,
        supported_price_decimals: 2,
        min_initial_margin_fraction: 200,
        maintenance_margin_fraction: 120,
      },
    ] });
  };

  const snapshots = await fetchPerpShadowVenue({
    venue_id: "lighter",
    fetchImpl,
    web_socket_ctor: PublicLighterSocket,
    clock: () => NOW + 6_000,
    now_ms: NOW,
    assets: ["BTC", "ETH"],
  });
  const snapshot = snapshots.find((row) => row.asset === "BTC");

  assert.equal(sockets[0].url, "wss://mainnet.zklighter.elliot.ai/stream?readonly=true");
  assert.deepEqual(sent, [
    { type: "subscribe", channel: "market_stats/all" },
    { type: "subscribe", channel: "order_book/1" },
    { type: "subscribe", channel: "order_book/0" },
  ]);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.depth_asks[0].size_e8, 75_000_000);
  assert.equal(snapshot.funding_rate_e12_per_interval, 200_000_000);
  assert.equal(snapshot.observed_at_ms, NOW + 6_000);
  assert.deepEqual(snapshot.source_observed_at_ms, {
    market: sourceNow,
    funding: sourceNow,
    orderbook: sourceNow,
  });
  assert.ok(snapshot.quality_flags.includes("market_funding_bound_to_public_websocket_time"));
  assert.ok(snapshot.quality_flags.includes("orderbook_bound_to_public_websocket_time"));
});

test("fails closed when a Lighter update stream never proves every requested book", async () => {
  class IncompleteLighterSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(payload) {
      if (JSON.parse(payload).channel !== "market_stats/all") return;
      this.emit("message", { data: JSON.stringify({
        channel: "market_stats:all",
        timestamp: NOW,
        type: "update/market_stats",
        market_stats: { 1: { market_id: 1, mark_price: "60000", index_price: "60001", current_funding_rate: "0.0001" } },
      }) });
    }

    close() {}

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }

  await assert.rejects(fetchPerpShadowVenue({
    venue_id: "lighter",
    fetchImpl: async () => response({ order_book_details: [{ market_id: 1, symbol: "BTC" }] }),
    web_socket_ctor: IncompleteLighterSocket,
    now_ms: NOW,
    assets: ["BTC"],
    timeout_ms: 25,
  }), /shadow_lighter_websocket_timeout/);
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
    funding_info: [{ symbol: "BTCUSDT", fundingIntervalHours: 4, time: NOW }],
    depth_books: { BTCUSDT: {
      E: NOW,
      bids: [["59999", "2"]],
      asks: [["60002", "3"]],
    } },
    now_ms: NOW,
  });
  assert.equal(snapshot.contract_id, "aster:BTCUSDT");
  assert.equal(snapshot.price_tick_e8, 10_000_000);
  assert.equal(snapshot.quantity_step_e8, 100_000);
  assert.equal(snapshot.funding_interval_ms, 14_400_000);
  assert.equal(snapshot.depth_asks[0].size_e8, 300_000_000);
  assert.equal(snapshot.maker_fee_bps, 0);
  assert.equal(snapshot.taker_fee_bps, 4);
  assert.equal(snapshot.status, "ready");
  assert.ok(snapshot.quality_flags.includes("fees_venue_base_schedule"));
});

test("keeps unsupported Aster quote fee schedules degraded", () => {
  const symbol = asterSymbol("BTCUSDC", "BTC", "USDC");
  symbol.quoteAsset = "USDC";
  symbol.marginAsset = "USDC";
  symbol.requiredMarginPercent = "5.0";
  symbol.maintMarginPercent = "2.5";
  symbol.liquidationFee = "0.025";
  const [snapshot] = parseAsterShadow({
    exchange_info: { symbols: [symbol] },
    premium_index: [asterPremium("BTCUSDC", NOW)],
    book_tickers: [asterBook("BTCUSDC", NOW)],
    funding_info: [{ symbol: "BTCUSDC", fundingIntervalHours: 8 }],
    depth_books: { BTCUSDC: { E: NOW, bids: [["59999", "1"]], asks: [["60002", "1"]] } },
    now_ms: NOW,
  });
  assert.equal(snapshot.status, "degraded");
  assert.deepEqual(snapshot.missing_fields, ["maker_fee_bps", "taker_fee_bps"]);
  assert.ok(snapshot.quality_flags.includes("fees_account_specific"));
});

test("quarantines Aster when premium funding is stale despite fresh depth", () => {
  const [snapshot] = parseAsterShadow({
    exchange_info: { serverTime: NOW, symbols: [asterSymbol("BTCUSDT", "BTC", "USDT")] },
    premium_index: [asterPremium("BTCUSDT", NOW - 30_001)],
    book_tickers: [asterBook("BTCUSDT", NOW)],
    funding_info: [{ symbol: "BTCUSDT", fundingIntervalHours: 8, time: NOW }],
    depth_books: { BTCUSDT: { E: NOW, bids: [["59999", "1"]], asks: [["60002", "1"]] } },
    now_ms: NOW,
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.status, "quarantined");
  assert.deepEqual(snapshot.stale_sources, ["market", "funding"]);
  assert.equal(snapshot.as_of_ms, NOW - 30_001);
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
    if (value.includes("fundingInfo")) return response([
      { symbol: "BTCUSD1", fundingIntervalHours: 4, time: NOW },
      { symbol: "BTCUSDT", fundingIntervalHours: 8, time: NOW },
    ]);
    if (value.includes("/depth?")) return response({
      E: NOW,
      bids: [["59999", "1"]],
      asks: [["60002", "1"]],
    });
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
        marketObservedAtMs: NOW,
        orderbookObservedAtMs: NOW,
        oraclePrice: "60000",
        indexPrice: "60001",
        fundingRate: "-0.00005537",
        impactBidPrice: "59999",
        impactAskPrice: "60002",
        fundingRateIntervalMin: "240",
        bestBidE8: 5_999_900_000_000,
        bestAskE8: 6_000_200_000_000,
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

test("keeps fresh edgeX responses live without trusting a stale funding source", () => {
  const contract = {
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
  };
  const row = {
    contractId: contract.contractId,
    fundingTimestamp: String(NOW - 60_000),
    observedAtMs: NOW,
    marketObservedAtMs: NOW,
    orderbookObservedAtMs: NOW,
    oraclePrice: "60000",
    indexPrice: "60001",
    markPrice: "60000",
    fundingRate: "0.00005",
    impactBidPrice: "59999",
    impactAskPrice: "60002",
    fundingRateIntervalMin: "240",
    bestBidE8: 5_999_900_000_000,
    bestAskE8: 6_000_200_000_000,
  };
  const [fresh] = parseEdgeXShadow({ funding: { data: [row], responseTime: String(NOW) }, contracts: [contract], now_ms: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.status, "ready");
  assert.equal(fresh.as_of_ms, NOW - 60_000);
  assert.ok(fresh.quality_flags.includes("funding_source_minute_cadence"));

  const [staleFunding] = parseEdgeXShadow({
    funding: { data: [{ ...row, fundingTimestamp: String(NOW - 180_000) }], responseTime: String(NOW) },
    contracts: [contract],
    now_ms: NOW,
  });
  assert.equal(staleFunding.status, "quarantined");
  assert.ok(staleFunding.missing_fields.includes("funding_rate_e12_per_interval"));
  assert.ok(staleFunding.quality_flags.includes("funding_source_stale"));
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
    if (value.includes("getDepth")) return response({
      data: [{
        contractId: "30000001",
        bids: [{ price: "59999", size: "1" }],
        asks: [{ price: "60002", size: "1" }],
      }],
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
  assert.equal(snapshot.depth_bids[0].size_e8, 100_000_000);
});

test("normalizes dYdX v4 markets with conservative live chain economics", () => {
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
    books: { "BTC-USD": { bids: [{ price: "59999", size: "0.5" }], asks: [{ price: "60003", size: "0.25" }] } },
    fee_params: {
      params: { tiers: [
        { maker_fee_ppm: 100, taker_fee_ppm: 500 },
        { maker_fee_ppm: -70, taker_fee_ppm: 250 },
      ] },
      ghola_source_consensus: true,
      ghola_source_count: 2,
    },
    source_observed_at_ms: { market: NOW, funding: NOW },
    orderbook_observed_at_ms_by_market: { "BTC-USD": NOW },
    now_ms: NOW,
  });
  assert.equal(snapshot.contract_id, "dydx:BTC-USD");
  assert.equal(snapshot.mark_price_e8, 6_000_100_000_000);
  assert.equal(snapshot.funding_rate_e12_per_interval, 3_153_846);
  assert.equal(snapshot.quantity_step_e8, 10_000);
  assert.equal(snapshot.depth_asks[0].size_e8, 25_000_000);
  assert.equal(snapshot.maker_fee_bps, 1);
  assert.equal(snapshot.taker_fee_bps, 5);
  assert.equal(snapshot.minimum_notional_micro_usdc, 6_000_100);
  assert.equal(snapshot.liquidation_fee_bps, 100);
  assert.equal(snapshot.status, "ready");
  assert.ok(snapshot.quality_flags.includes("fees_chain_parameter_ceiling"));
  assert.ok(snapshot.quality_flags.includes("fees_chain_source_consensus"));
  assert.ok(snapshot.quality_flags.includes("minimum_notional_market_step"));
  assert.ok(snapshot.quality_flags.includes("liquidation_fee_protocol_default"));
  assert.ok(snapshot.quality_flags.includes("market_funding_bound_to_indexer_response_time"));
  assert.ok(snapshot.quality_flags.includes("orderbook_bound_to_indexer_response_time"));
});

test("keeps dYdX degraded when its live chain fee parameters are unavailable", () => {
  const [snapshot] = parseDydxShadow({
    markets: { markets: { "BTC-USD": {
      ticker: "BTC-USD",
      status: "ACTIVE",
      oraclePrice: "60001",
      nextFundingRate: "0.0001",
      initialMarginFraction: "0.02",
      maintenanceMarginFraction: "0.012",
      tickSize: "1",
      stepSize: "0.0001",
    } } },
    books: { "BTC-USD": { bids: [{ price: "59999", size: "0.5" }], asks: [{ price: "60003", size: "0.25" }] } },
    source_observed_at_ms: { market: NOW, funding: NOW },
    orderbook_observed_at_ms_by_market: { "BTC-USD": NOW },
    now_ms: NOW,
  });
  assert.equal(snapshot.status, "degraded");
  assert.deepEqual(snapshot.missing_fields, ["maker_fee_bps", "taker_fee_bps"]);
  assert.ok(snapshot.quality_flags.includes("fees_chain_params_unavailable"));
});

test("quarantines every core venue when provider timing evidence is missing", () => {
  const [hyperliquid] = parseHyperliquidShadow({
    body: [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
      [{ markPx: "60000", oraclePx: "60001", funding: "0.0001" }],
    ],
    books: { BTC: { levels: [
      [{ px: "59999", sz: "1" }],
      [{ px: "60002", sz: "1" }],
    ] } },
    now_ms: NOW,
  });
  const [lighter] = parseLighterShadow({
    details: { order_book_details: [{ market_id: 0, symbol: "BTC" }] },
    funding: { funding_rates: [{ market_id: 0, exchange: "lighter", rate: "0.0001" }] },
    order_books: [{ market_id: 0, bids: [{ price: "59999", size: "1" }], asks: [{ price: "60002", size: "1" }] }],
    now_ms: NOW,
  });
  const [aster] = parseAsterShadow({
    exchange_info: { symbols: [asterSymbol("BTCUSDT", "BTC", "USDT")] },
    premium_index: [asterPremium("BTCUSDT", null)],
    book_tickers: [asterBook("BTCUSDT", null)],
    funding_info: [{ symbol: "BTCUSDT", fundingIntervalHours: 8 }],
    depth_books: { BTCUSDT: { bids: [["59999", "1"]], asks: [["60002", "1"]] } },
    now_ms: NOW,
  });
  const [edgex] = parseEdgeXShadow({
    funding: { responseTime: String(NOW), data: [{
      contractId: "1",
      fundingTimestamp: String(NOW),
      oraclePrice: "60000",
      indexPrice: "60001",
      fundingRate: "0.0001",
      bestBidE8: 5_999_900_000_000,
      bestAskE8: 6_000_200_000_000,
      depthBids: [{ price: "59999", size: "1" }],
      depthAsks: [{ price: "60002", size: "1" }],
    }] },
    contracts: [{ contractId: "1", symbol: "BTCUSDC", baseAsset: "BTC", quoteAsset: "USDC" }],
    now_ms: NOW,
  });
  const [dydx] = parseDydxShadow({
    markets: { markets: { "BTC-USD": { ticker: "BTC-USD", status: "ACTIVE" } } },
    books: { "BTC-USD": { bids: [{ price: "59999", size: "1" }], asks: [{ price: "60002", size: "1" }] } },
    server_time: { iso: new Date(NOW).toISOString() },
    now_ms: NOW,
  });

  assert.deepEqual(hyperliquid.stale_sources, ["market", "funding", "orderbook"]);
  assert.deepEqual(lighter.stale_sources, ["market", "funding", "orderbook"]);
  assert.deepEqual(aster.stale_sources, ["market", "funding", "orderbook"]);
  assert.deepEqual(edgex.stale_sources, ["market", "orderbook"]);
  assert.deepEqual(dydx.stale_sources, ["market", "funding", "orderbook"]);
  assert.equal(dydx.status, "quarantined", "a fresh dYdX server clock cannot refresh detached payloads");
  assert.ok([hyperliquid, lighter, aster, edgex, dydx].every((snapshot) =>
    snapshot.status === "quarantined" && snapshot.as_of_ms === null));
});

test("requires matching dYdX fee parameters from two independent chain nodes", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("perpetualMarkets")) return response({ markets: { "BTC-USD": {
      ticker: "BTC-USD",
      status: "ACTIVE",
      oraclePrice: "60001",
      nextFundingRate: "0.0001",
      initialMarginFraction: "0.02",
      maintenanceMarginFraction: "0.012",
      tickSize: "1",
      stepSize: "0.0001",
    } } });
    if (value.endsWith("/v4/time")) return response({ iso: new Date(NOW).toISOString() });
    if (value.includes("orderbooks")) return response({ bids: [{ price: "59999", size: "1" }], asks: [{ price: "60003", size: "1" }] });
    if (value.includes("kingnodes")) return { ok: false, status: 503, json: async () => ({}) };
    return response({ params: { tiers: [{ maker_fee_ppm: 100, taker_fee_ppm: 500 }] } });
  };
  const [snapshot] = await fetchPerpShadowVenue({
    venue_id: "dydx",
    fetchImpl,
    now_ms: NOW,
    assets: ["BTC"],
  });
  assert.equal(snapshot.status, "ready");
  assert.ok(snapshot.quality_flags.includes("fees_chain_source_consensus"));
  assert.equal(calls.filter((url) => url.includes("perpetual_fee_params")).length, 3);
});

test("degrades dYdX instead of choosing between conflicting chain fee sources", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("perpetualMarkets")) return response({ markets: { "BTC-USD": {
      ticker: "BTC-USD",
      status: "ACTIVE",
      oraclePrice: "60001",
      nextFundingRate: "0.0001",
      initialMarginFraction: "0.02",
      maintenanceMarginFraction: "0.012",
      tickSize: "1",
      stepSize: "0.0001",
    } } });
    if (value.endsWith("/v4/time")) return response({ iso: new Date(NOW).toISOString() });
    if (value.includes("orderbooks")) return response({ bids: [{ price: "59999", size: "1" }], asks: [{ price: "60003", size: "1" }] });
    const taker = value.includes("polkachu") ? 500 : value.includes("publicnode") ? 350 : 200;
    return response({ params: { tiers: [{ maker_fee_ppm: 100, taker_fee_ppm: taker }] } });
  };
  const [snapshot] = await fetchPerpShadowVenue({
    venue_id: "dydx",
    fetchImpl,
    now_ms: NOW,
    assets: ["BTC"],
  });
  assert.equal(snapshot.status, "degraded");
  assert.deepEqual(snapshot.missing_fields, ["maker_fee_bps", "taker_fee_bps"]);
  assert.ok(snapshot.quality_flags.includes("fees_chain_params_unavailable"));
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
    else if (String(url).includes("premiumIndex") || String(url).includes("bookTicker") || String(url).includes("fundingInfo")) body = [];
    else if (String(url).includes("getLatestFundingRate")) body = { data: [] };
    else if (String(url).includes("perpetualMarkets")) body = { markets: {} };
    else if (String(url).endsWith("/v4/time")) body = { iso: new Date(NOW).toISOString() };
    else if (String(url).includes("perpetual_fee_params")) body = { params: { tiers: [{ maker_fee_ppm: 100, taker_fee_ppm: 500 }] } };
    return { ok: true, json: async () => body };
  };
  const result = await fetchCorePerpShadowSet({ fetchImpl, now_ms: NOW, timeout_ms: 1_000 });
  assert.equal(result.length, 5);
  assert.ok(result.every((item) => item.ok));
  assert.ok(calls.every((call) => call.method === "GET" || (
    call.method === "POST" && call.url.endsWith("/info") && ["metaAndAssetCtxs", "l2Book"].includes(JSON.parse(call.body).type)
  )));
  assert.ok(calls.every((call) => !/\/private\/|\/order(?:\?|$)/i.test(call.url)));
});

test("caps each five-venue shadow adapter by one end-to-end deadline", async () => {
  const startedAt = Date.now();
  const fetchImpl = async (url) => {
    if (String(url).includes("edgex") && String(url).includes("getMetaData")) {
      return new Promise(() => {});
    }
    return response(String(url).includes("hyperliquid") ? [{ universe: [] }, []] : {});
  };

  const result = await fetchCorePerpShadowSet({
    fetchImpl,
    now_ms: NOW,
    timeout_ms: 25,
  });

  assert.ok(Date.now() - startedAt < 250);
  assert.equal(result.length, 5);
  assert.deepEqual(result.find((item) => item.venue_id === "edgex"), {
    venue_id: "edgex",
    ok: false,
    error: "shadow_timeout",
    snapshots: [],
  });
  assert.ok(result.filter((item) => item.venue_id !== "edgex").every((item) => item.ok));
  assert.equal(carryShadowFetchTimeoutMs({}), 4_000);
  assert.equal(carryShadowFetchTimeoutMs({ PRIVATE_AGENT_CARRY_SHADOW_FETCH_TIMEOUT_MS: "1500" }), 1_500);
  assert.equal(carryShadowFetchTimeoutMs({ PRIVATE_AGENT_CARRY_SHADOW_FETCH_TIMEOUT_MS: "50" }), 4_000);
});

function response(body) {
  return {
    ok: true,
    headers: { get: (name) => String(name).toLowerCase() === "date" ? new Date(NOW).toUTCString() : null },
    json: async () => body,
  };
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

function asterPremium(symbol, time = NOW) {
  return { symbol, markPrice: "60000", indexPrice: "60001", lastFundingRate: "0.0001", time };
}

function asterBook(symbol, time = NOW) {
  return { symbol, bidPrice: "59999", askPrice: "60002", time };
}
