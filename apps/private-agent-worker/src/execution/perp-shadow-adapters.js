import {
  CORE_PERP_VENUES,
  SUPPORTED_EXECUTION_VENUES,
  venueAdapterCapability,
} from "@ghola/execution-core";

const HOUR_MS = 3_600_000;
const DEFAULT_MAX_AGE_MS = 30_000;
const HYPERLIQUID_QUOTE_ASSETS = Object.freeze({
  BTC: "USDT",
  ETH: "USDT",
  SOL: "USDT",
  HYPE: "USDC",
  PURR: "USDC",
});

export const PERP_SHADOW_ADAPTERS = Object.freeze(Object.fromEntries(
  SUPPORTED_EXECUTION_VENUES.flatMap((venueId) => {
    const declared = venueAdapterCapability(venueId, "perp_shadow");
    return declared ? [[venueId, declared]] : [];
  }),
));

export async function fetchCorePerpShadowSet(options = {}) {
  const settled = await Promise.allSettled(CORE_PERP_VENUES.map((venueId) =>
    fetchPerpShadowVenue({ ...options, venue_id: venueId })
  ));
  return Object.freeze(CORE_PERP_VENUES.map((venueId, index) => {
    const result = settled[index];
    return result.status === "fulfilled"
      ? Object.freeze({ venue_id: venueId, ok: true, snapshots: result.value })
      : Object.freeze({ venue_id: venueId, ok: false, error: errorCode(result.reason), snapshots: Object.freeze([]) });
  }));
}

export async function fetchPerpShadowVenue({
  venue_id: venueId,
  fetchImpl = fetch,
  now_ms: nowMs = Date.now(),
  max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS,
  timeout_ms: timeoutMs = 5_000,
  market_metadata: marketMetadata = {},
  assets = ["BTC", "ETH", "SOL"],
} = {}) {
  const declared = venueAdapterCapability(venueId, "perp_shadow");
  if (!CORE_PERP_VENUES.includes(venueId) || declared?.status !== "enabled") throw new Error("shadow_venue_unsupported");
  const adapterId = declared.adapter_id;
  if (adapterId === "hyperliquid_shadow_v1") {
    const body = await jsonRequest(fetchImpl, "https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }, timeoutMs);
    const allowed = normalizedAssetSet(assets);
    const universe = Array.isArray(body?.[0]?.universe) ? body[0].universe : [];
    const coins = universe
      .map((row) => assetName(row?.name))
      .filter((asset) => allowed.size === 0 || allowed.has(asset));
    const books = Object.fromEntries(await Promise.all(coins.map(async (coin) => [
      coin,
      await jsonRequest(fetchImpl, "https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin }),
      }, timeoutMs),
    ])));
    return selectAssets(parseHyperliquidShadow({ body, books, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  if (adapterId === "lighter_shadow_v1") {
    const [details, funding] = await Promise.all([
      jsonRequest(fetchImpl, "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates", {}, timeoutMs),
    ]);
    const selectedDetails = rowsFrom(details, ["order_book_details", "order_books", "markets"])
      .filter((row) => normalizedAssetSet(assets).has(assetName(row.symbol || row.market_symbol)));
    const orderBooks = await Promise.all(selectedDetails.map(async (row) => ({
      market_id: row.market_id ?? row.market_index,
      ...(await jsonRequest(
        fetchImpl,
        `https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${encodeURIComponent(row.market_id ?? row.market_index)}&limit=20`,
        {},
        timeoutMs,
      )),
    })));
    return selectAssets(parseLighterShadow({ details, funding, order_books: orderBooks, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  if (adapterId === "aster_shadow_v1") {
    const [exchangeInfo, premiums, books, fundingInfo] = await Promise.all([
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/exchangeInfo", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/premiumIndex", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/ticker/bookTicker", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v1/fundingInfo", {}, timeoutMs),
    ]);
    const allowed = normalizedAssetSet(assets);
    const selectedSymbols = (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
      .filter((row) => row.contractType === "PERPETUAL" && row.status === "TRADING")
      .filter((row) => allowed.size === 0 || allowed.has(assetName(row.baseAsset)));
    const depthBooks = Object.fromEntries(await Promise.all(selectedSymbols.map(async (row) => [
      row.symbol,
      await jsonRequest(
        fetchImpl,
        `https://fapi.asterdex.com/fapi/v1/depth?symbol=${encodeURIComponent(row.symbol)}&limit=20`,
        {},
        timeoutMs,
      ),
    ])));
    return selectPreferredAssetSnapshots(
      selectAssets(parseAsterShadow({
        exchange_info: exchangeInfo,
        premium_index: premiums,
        book_tickers: books,
        funding_info: fundingInfo,
        depth_books: depthBooks,
        now_ms: nowMs,
        max_age_ms: maxAgeMs,
      }), assets),
      ["USDT", "USDC", "USD", "USD1", "U"],
    );
  }
  if (adapterId === "edgex_shadow_v1") {
    const baseUrl = "https://edgex-prod-v2.edgex.exchange";
    const metadata = await jsonRequest(
      fetchImpl,
      `${baseUrl}/api/v2/public/meta/getMetaData`,
      {},
      timeoutMs,
    );
    const coins = new Map((metadata?.data?.coinList || [])
      .map((row) => [String(row.coinId), assetName(row.coinName)]));
    const collateralAsset = coins.get(String(metadata?.data?.global?.collateralCoinId)) || "USDC";
    const contracts = (marketMetadata.edgex_contracts || metadata?.data?.contractList || []).map((row) => ({
      ...row,
      symbol: row.symbol || row.contractName,
      baseAsset: row.baseAsset || coins.get(String(row.baseCoinId)),
      quoteAsset: row.quoteAsset || coins.get(String(row.quoteCoinId)),
      settleAsset: row.settleAsset || collateralAsset,
    }));
    const selectedContracts = contracts.filter((row) => normalizedAssetSet(assets).has(edgeXAsset(row)));
    const observations = await Promise.all(selectedContracts.map(async (row) => {
      const contractId = encodeURIComponent(row.contractId);
      const [funding, ticker, depth] = await Promise.all([
        jsonRequest(fetchImpl, `${baseUrl}/api/v2/public/funding/getLatestFundingRate?contractId=${contractId}`, {}, timeoutMs),
        jsonRequest(fetchImpl, `${baseUrl}/api/v2/public/quote/getTicker?contractId=${contractId}`, {}, timeoutMs),
        jsonRequest(fetchImpl, `${baseUrl}/api/v2/public/quote/getDepth?contractId=${contractId}&level=15`, {}, timeoutMs),
      ]);
      const tickerRow = arrayValue(ticker?.data)[0] || {};
      const fundingRow = arrayValue(funding?.data)[0] || {};
      const depthRow = arrayValue(depth?.data)[0] || {};
      return {
        row: {
          ...tickerRow,
          ...fundingRow,
          contractId: fundingRow.contractId || tickerRow.contractId || row.contractId,
          bestBidE8: bestBookPrice(depthRow.bids, "bid"),
          bestAskE8: bestBookPrice(depthRow.asks, "ask"),
          depthBids: depthRow.bids,
          depthAsks: depthRow.asks,
          marketObservedAtMs: timestamp(ticker?.responseTime),
          fundingObservedAtMs: timestamp(fundingRow.fundingTimestamp ?? funding?.responseTime),
          orderbookObservedAtMs: timestamp(depth?.responseTime),
          observedAtMs: Math.max(
            timestamp(funding?.responseTime),
            timestamp(ticker?.responseTime),
            timestamp(depth?.responseTime),
          ),
        },
        responseTime: Math.max(
          timestamp(funding?.responseTime),
          timestamp(ticker?.responseTime),
          timestamp(depth?.responseTime),
        ),
      };
    }));
    const funding = {
      data: observations.map((observation) => observation.row),
      responseTime: Math.max(0, ...observations.map((observation) => observation.responseTime)),
    };
    return selectAssets(parseEdgeXShadow({ funding, contracts: selectedContracts, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  if (adapterId === "dydx_shadow_v1") {
    const [markets, serverTime] = await Promise.all([
      jsonRequest(fetchImpl, "https://indexer.dydx.trade/v4/perpetualMarkets", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://indexer.dydx.trade/v4/time", {}, timeoutMs),
    ]);
    const allowed = normalizedAssetSet(assets);
    const selectedMarkets = Object.values(markets?.markets || {})
      .filter((row) => row?.status === "ACTIVE" && allowed.has(assetName(String(row.ticker || "").split("-")[0])));
    const books = Object.fromEntries(await Promise.all(selectedMarkets.map(async (row) => [
      row.ticker,
      await jsonRequest(
        fetchImpl,
        `https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${encodeURIComponent(row.ticker)}`,
        {},
        timeoutMs,
      ),
    ])));
    return selectAssets(parseDydxShadow({ markets, books, server_time: serverTime, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  throw new Error("shadow_adapter_unimplemented");
}

export function parseHyperliquidShadow({ body, books = {}, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const pair = Array.isArray(body) ? body : [];
  const universe = Array.isArray(pair[0]?.universe) ? pair[0].universe : [];
  const contexts = Array.isArray(pair[1]) ? pair[1] : [];
  const marginTables = new Map((Array.isArray(pair[0]?.marginTables) ? pair[0].marginTables : [])
    .map((row) => [String(row?.[0]), row?.[1]]));
  return freezeSnapshots(universe.map((meta, index) => {
    const context = contexts[index] || {};
    const asset = assetName(meta?.name);
    const impact = Array.isArray(context.impactPxs) ? context.impactPxs : [];
    const book = books[asset] || {};
    const levels = Array.isArray(book.levels) ? book.levels : [];
    const marginTiers = normalizedMarginTiers(marginTables.get(String(meta?.marginTableId))?.marginTiers);
    const maxLeverage = positiveNumber(meta?.maxLeverage);
    return shadowSnapshot({
      venue_id: "hyperliquid",
      contract_id: `hyperliquid:${asset}`,
      asset,
      quote_asset: hyperliquidQuoteAsset(asset),
      collateral_asset: "USDC",
      mark_price_e8: priceE8(context.markPx),
      index_price_e8: priceE8(context.oraclePx),
      best_bid_e8: bestBookPrice(levels[0], "bid"),
      best_ask_e8: bestBookPrice(levels[1], "ask"),
      depth_bids: normalizedDepthLevels(levels[0], "bid"),
      depth_asks: normalizedDepthLevels(levels[1], "ask"),
      impact_bid_e8: priceE8(impact[0]),
      impact_ask_e8: priceE8(impact[1]),
      funding_rate_e12_per_interval: rateE12(context.funding),
      funding_interval_ms: HOUR_MS,
      maker_fee_bps: null,
      taker_fee_bps: null,
      minimum_notional_micro_usdc: null,
      quantity_step_e8: decimalStepE8(meta?.szDecimals),
      price_tick_e8: null,
      initial_margin_bps: leverageMarginBps(maxLeverage, 10_000),
      maintenance_margin_bps: leverageMarginBps(maxLeverage, 5_000),
      liquidation_fee_bps: 0,
      margin_tiers: marginTiers,
      liquidation_model: "account_equity_below_tiered_maintenance_margin",
      as_of_ms: timestamp(book.time) || nowMs,
      source_observed_at_ms: {
        market: nowMs,
        funding: nowMs,
        orderbook: timestamp(book.time) || nowMs,
      },
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: [
        "fees_account_specific",
        "minimum_notional_unverified",
        "price_tick_dynamic",
        hyperliquidQuoteEvidenceFlag(asset),
        ...(levels.length >= 2 ? ["public_l2_bbo"] : ["orderbook_bbo_missing"]),
      ],
      ...PERP_SHADOW_ADAPTERS.hyperliquid,
    });
  }));
}

export function parseLighterShadow({ details, funding, order_books: orderBooks = [], now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const rows = rowsFrom(details, ["order_book_details", "order_books", "markets"]);
  const fundingRows = rowsFrom(funding, ["funding_rates", "rates"]);
  const fundingByMarket = new Map(fundingRows
    .filter((row) => !row.exchange || String(row.exchange).toLowerCase() === "lighter")
    .map((row) => [String(row.market_id ?? row.market_index), row]));
  const booksByMarket = new Map((Array.isArray(orderBooks) ? orderBooks : [])
    .map((row) => [String(row.market_id ?? row.market_index), row]));
  return freezeSnapshots(rows.map((row) => {
    const asset = assetName(row.symbol || row.market_symbol);
    const fundingRow = fundingByMarket.get(String(row.market_id ?? row.market_index)) || {};
    const book = booksByMarket.get(String(row.market_id ?? row.market_index)) || {};
    return shadowSnapshot({
      venue_id: "lighter",
      contract_id: `lighter:${row.market_id ?? row.market_index ?? asset}`,
      asset,
      quote_asset: "USD",
      collateral_asset: "USDC",
      mark_price_e8: priceE8(row.mark_price ?? row.last_trade_price ?? row.market_price),
      index_price_e8: priceE8(row.index_price),
      best_bid_e8: priceE8(row.best_bid ?? row.bid_price ?? book.bids?.[0]?.price),
      best_ask_e8: priceE8(row.best_ask ?? row.ask_price ?? book.asks?.[0]?.price),
      depth_bids: normalizedDepthLevels(book.bids, "bid"),
      depth_asks: normalizedDepthLevels(book.asks, "ask"),
      funding_rate_e12_per_interval: rateE12(fundingRow.rate ?? row.funding_rate),
      funding_interval_ms: HOUR_MS,
      maker_fee_bps: feeBps(row.maker_fee ?? row.maker_fee_rate),
      taker_fee_bps: feeBps(row.taker_fee ?? row.taker_fee_rate),
      minimum_notional_micro_usdc: moneyMicro(row.min_quote_amount ?? row.minimum_notional),
      quantity_step_e8: decimalStepE8(row.supported_size_decimals ?? row.size_decimals),
      price_tick_e8: decimalStepE8(row.supported_price_decimals ?? row.price_decimals),
      initial_margin_bps: integerOrNull(row.min_initial_margin_fraction ?? row.default_initial_margin_fraction),
      maintenance_margin_bps: integerOrNull(row.maintenance_margin_fraction),
      liquidation_fee_bps: percentBps(row.liquidation_fee),
      margin_tiers: Object.freeze([]),
      liquidation_model: "account_initial_maintenance_closeout_waterfall",
      as_of_ms: oldestTimestamp([
        timestamp(row.timestamp ?? details?.timestamp) || nowMs,
        timestamp(fundingRow.timestamp ?? funding?.timestamp) || nowMs,
        timestamp(book.timestamp) || nowMs,
      ], nowMs),
      source_observed_at_ms: {
        market: timestamp(row.timestamp ?? details?.timestamp) || nowMs,
        funding: timestamp(fundingRow.timestamp ?? funding?.timestamp) || nowMs,
        orderbook: timestamp(book.timestamp) || nowMs,
      },
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["funding_settles_hourly", "initial_margin_is_market_minimum"],
      ...PERP_SHADOW_ADAPTERS.lighter,
    });
  }));
}

export function parseAsterShadow({ exchange_info: exchangeInfo, premium_index: premiumIndex, book_tickers: bookTickers, funding_info: fundingInfo = [], depth_books: depthBooks = {}, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const symbols = Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [];
  const premiums = new Map(arrayValue(premiumIndex).map((row) => [String(row.symbol), row]));
  const books = new Map(arrayValue(bookTickers).map((row) => [String(row.symbol), row]));
  const fundingConfigs = new Map(arrayValue(fundingInfo).map((row) => [String(row.symbol), row]));
  return freezeSnapshots(symbols.filter((row) => row.contractType === "PERPETUAL" && row.status === "TRADING").map((row) => {
    const premium = premiums.get(String(row.symbol)) || {};
    const book = books.get(String(row.symbol)) || {};
    const depth = depthBooks?.[row.symbol] || {};
    const fundingConfig = fundingConfigs.get(String(row.symbol)) || {};
    const filters = new Map((Array.isArray(row.filters) ? row.filters : []).map((item) => [item.filterType, item]));
    const priceFilter = filters.get("PRICE_FILTER") || {};
    const lotFilter = filters.get("LOT_SIZE") || {};
    const notionalFilter = filters.get("MIN_NOTIONAL") || {};
    const asset = assetName(row.baseAsset || String(row.symbol).replace(/USDT$|USDC$|USD$/, ""));
    return shadowSnapshot({
      venue_id: "aster",
      contract_id: `aster:${row.symbol}`,
      asset,
      quote_asset: assetName(row.quoteAsset || "USDT"),
      collateral_asset: assetName(row.marginAsset || row.quoteAsset || "USDT"),
      mark_price_e8: priceE8(premium.markPrice),
      index_price_e8: priceE8(premium.indexPrice),
      best_bid_e8: priceE8(book.bidPrice),
      best_ask_e8: priceE8(book.askPrice),
      depth_bids: normalizedDepthLevels(depth.bids, "bid"),
      depth_asks: normalizedDepthLevels(depth.asks, "ask"),
      funding_rate_e12_per_interval: rateE12(premium.lastFundingRate),
      funding_interval_ms: positiveIntegerFrom(fundingConfig.fundingIntervalHours, null, HOUR_MS),
      maker_fee_bps: null,
      taker_fee_bps: null,
      minimum_notional_micro_usdc: moneyMicro(notionalFilter.notional ?? notionalFilter.minNotional),
      quantity_step_e8: decimalE8(lotFilter.stepSize),
      price_tick_e8: decimalE8(priceFilter.tickSize),
      initial_margin_bps: percentBps(row.requiredMarginPercent),
      maintenance_margin_bps: percentBps(row.maintMarginPercent),
      liquidation_fee_bps: feeBps(row.liquidationFee),
      margin_tiers: Object.freeze([]),
      liquidation_model: "cross_or_isolated_account_margin",
      as_of_ms: oldestTimestamp([
        timestamp(premium.time) || nowMs,
        timestamp(depth.E ?? depth.T ?? book.time) || nowMs,
      ], nowMs),
      source_observed_at_ms: {
        market: timestamp(premium.time) || nowMs,
        funding: timestamp(premium.time) || nowMs,
        orderbook: timestamp(depth.E ?? depth.T ?? book.time) || nowMs,
      },
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["funding_interval_public_config", "fees_account_specific"],
      ...PERP_SHADOW_ADAPTERS.aster,
    });
  }));
}

export function parseEdgeXShadow({ funding, contracts = [], now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const rows = rowsFrom(funding, ["data"]);
  const contractsById = new Map((Array.isArray(contracts) ? contracts : []).map((row) => [String(row.contractId ?? row.contract_id), row]));
  return freezeSnapshots(rows.map((row) => {
    const contract = contractsById.get(String(row.contractId)) || {};
    const symbol = contract.symbol || contract.contractName || `CONTRACT_${row.contractId}`;
    const asset = edgeXAsset(contract);
    const impactBid = priceE8(row.impactBidPrice);
    const impactAsk = priceE8(row.impactAskPrice);
    const bid = integerOrNull(row.bestBidE8);
    const ask = integerOrNull(row.bestAskE8);
    const mark = priceE8(row.markPrice) || midpoint(impactBid, impactAsk) || priceE8(row.oraclePrice);
    const fundingSourceAt = timestamp(row.fundingTimestamp);
    const fundingSourceFresh = observationFresh(
      fundingSourceAt,
      nowMs,
      Math.max(maxAgeMs, 2 * 60_000),
    );
    const marginTiers = normalizedEdgeXMarginTiers(contract.riskTierList);
    const firstMarginTier = marginTiers[0] || {};
    return shadowSnapshot({
      venue_id: "edgex",
      contract_id: `edgex:${row.contractId}`,
      asset,
      quote_asset: assetName(contract.quoteAsset || "USD"),
      collateral_asset: assetName(contract.settleAsset || contract.quoteAsset || "USDC"),
      mark_price_e8: mark,
      index_price_e8: priceE8(row.indexPrice),
      best_bid_e8: bid,
      best_ask_e8: ask,
      depth_bids: normalizedDepthLevels(row.depthBids, "bid"),
      depth_asks: normalizedDepthLevels(row.depthAsks, "ask"),
      impact_bid_e8: impactBid,
      impact_ask_e8: impactAsk,
      funding_rate_e12_per_interval: fundingSourceFresh ? rateE12(row.fundingRate) : null,
      funding_interval_ms: positiveIntegerFrom(row.fundingRateIntervalMin ?? contract.fundingRateIntervalMin, null, 60_000),
      maker_fee_bps: feeBps(contract.makerFeeRate ?? contract.defaultMakerFeeRate),
      taker_fee_bps: feeBps(contract.takerFeeRate ?? contract.defaultTakerFeeRate),
      minimum_notional_micro_usdc: moneyMicro(contract.minNotional) ?? decimalProductMicro(contract.minOrderSize, mark),
      quantity_step_e8: decimalE8(contract.stepSize ?? contract.sizeStep),
      price_tick_e8: decimalE8(contract.tickSize ?? contract.priceStep),
      initial_margin_bps: leverageMarginBps(firstMarginTier.max_leverage, 10_000),
      maintenance_margin_bps: firstMarginTier.maintenance_margin_bps ?? null,
      liquidation_fee_bps: feeBps(contract.liquidateFeeRate),
      margin_tiers: marginTiers,
      liquidation_model: "tiered_starkex_maintenance_margin",
      as_of_ms: timestamp(row.observedAtMs ?? funding?.responseTime) || fundingSourceAt || nowMs,
      source_observed_at_ms: {
        market: timestamp(row.marketObservedAtMs) || nowMs,
        funding: fundingSourceAt || timestamp(row.fundingObservedAtMs) || nowMs,
        orderbook: timestamp(row.orderbookObservedAtMs) || nowMs,
      },
      source_max_age_ms: { funding: Math.max(maxAgeMs, 2 * 60_000) },
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: [
        ...(row.markPrice ? [] : ["impact_mid_used_as_mark_proxy"]),
        ...(bid && ask ? ["public_depth_bbo"] : ["orderbook_bbo_missing"]),
        ...(impactBid && impactAsk ? ["funding_impact_prices_available"] : []),
        ...(fundingSourceFresh ? ["funding_source_minute_cadence"] : ["funding_source_stale"]),
        "fees_venue_default",
        ...(contractsById.has(String(row.contractId)) ? [] : ["contract_metadata_missing"]),
      ],
      ...PERP_SHADOW_ADAPTERS.edgex,
    });
  }));
}

export function parseDydxShadow({ markets, books = {}, server_time: serverTime, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const rows = Object.values(markets?.markets || {});
  const asOfMs = timestamp(serverTime?.iso) || positiveIntegerFrom(serverTime?.epoch, 0, 1_000) || nowMs;
  return freezeSnapshots(rows.filter((row) => row?.status === "ACTIVE").map((row) => {
    const [base, quote = "USD"] = String(row.ticker || "").split("-");
    const asset = assetName(base);
    const book = books[row.ticker] || {};
    const bid = bestBookPrice(book.bids, "bid");
    const ask = bestBookPrice(book.asks, "ask");
    return shadowSnapshot({
      venue_id: "dydx",
      contract_id: `dydx:${row.ticker}`,
      asset,
      quote_asset: assetName(quote),
      collateral_asset: "USDC",
      mark_price_e8: midpoint(bid, ask) || priceE8(row.oraclePrice),
      index_price_e8: priceE8(row.oraclePrice),
      best_bid_e8: bid,
      best_ask_e8: ask,
      depth_bids: normalizedDepthLevels(book.bids, "bid"),
      depth_asks: normalizedDepthLevels(book.asks, "ask"),
      funding_rate_e12_per_interval: rateE12(row.nextFundingRate ?? row.defaultFundingRate1H),
      funding_interval_ms: HOUR_MS,
      maker_fee_bps: null,
      taker_fee_bps: null,
      minimum_notional_micro_usdc: null,
      quantity_step_e8: decimalE8(row.stepSize),
      price_tick_e8: decimalE8(row.tickSize),
      initial_margin_bps: feeBps(row.initialMarginFraction),
      maintenance_margin_bps: feeBps(row.maintenanceMarginFraction),
      liquidation_fee_bps: null,
      margin_tiers: Object.freeze([]),
      liquidation_model: "cross_or_isolated_subaccount_margin",
      as_of_ms: asOfMs,
      source_observed_at_ms: { market: asOfMs, funding: asOfMs, orderbook: asOfMs },
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: [
        "orderbook_mid_used_as_mark_proxy",
        "fees_account_specific",
        "minimum_notional_unverified",
        "liquidation_fee_unverified",
      ],
      ...PERP_SHADOW_ADAPTERS.dydx,
    });
  }));
}

export function parseVariationalShadow({ stats, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const listings = Array.isArray(stats?.listings) ? stats.listings : [];
  return freezeSnapshots(listings.map((row) => {
    const quote = row.quotes?.size_1k || {};
    return shadowSnapshot({
      venue_id: "variational_omni",
      contract_id: `variational:${assetName(row.ticker)}`,
      asset: assetName(row.ticker),
      quote_asset: "USDC",
      collateral_asset: "USDC",
      mark_price_e8: priceE8(row.mark_price),
      index_price_e8: null,
      best_bid_e8: priceE8(quote.bid),
      best_ask_e8: priceE8(quote.ask),
      funding_rate_e12_per_interval: rateE12(row.funding_rate),
      funding_interval_ms: positiveIntegerFrom(row.funding_interval_s, null, 1_000),
      maker_fee_bps: 0,
      taker_fee_bps: 0,
      minimum_notional_micro_usdc: null,
      quantity_step_e8: null,
      price_tick_e8: null,
      initial_margin_bps: null,
      maintenance_margin_bps: null,
      liquidation_fee_bps: null,
      margin_tiers: Object.freeze([]),
      liquidation_model: "unavailable",
      as_of_ms: timestamp(row.quotes?.updated_at) || nowMs,
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["public_quotes_may_be_cached", "trading_api_unavailable"],
      ...PERP_SHADOW_ADAPTERS.variational_omni,
    });
  }));
}

function shadowSnapshot(value) {
  const fields = [
    "mark_price_e8", "index_price_e8", "best_bid_e8", "best_ask_e8",
    "funding_rate_e12_per_interval", "funding_interval_ms", "maker_fee_bps", "taker_fee_bps",
    "minimum_notional_micro_usdc", "quantity_step_e8", "price_tick_e8",
    "initial_margin_bps", "maintenance_margin_bps", "liquidation_fee_bps",
  ];
  const missingFields = fields.filter((field) => value[field] === null);
  const staleSourceNames = staleSources(value);
  const stale = value.as_of_ms > value.now_ms + 5_000 || value.now_ms - value.as_of_ms > value.max_age_ms || staleSourceNames.length > 0;
  const criticalMissing = ["mark_price_e8", "index_price_e8", "funding_rate_e12_per_interval", "funding_interval_ms"]
    .some((field) => value[field] === null);
  const status = stale || criticalMissing ? "quarantined" : missingFields.length > 0 ? "degraded" : "ready";
  return Object.freeze({
    version: 1,
    venue_id: value.venue_id,
    adapter_mode: "shadow_read_only",
    source_schema: value.source_schema,
    trading_api_available: value.trading_api_available,
    contract_id: value.contract_id,
    economic_equivalence_id: `carry:${value.asset}-usd-linear`,
    asset: value.asset,
    market: `${value.asset}-USD`,
    quote_asset: value.quote_asset,
    collateral_asset: value.collateral_asset,
    contract_type: "linear_perp",
    mark_price_e8: value.mark_price_e8,
    index_price_e8: value.index_price_e8,
    best_bid_e8: value.best_bid_e8,
    best_ask_e8: value.best_ask_e8,
    depth_bids: Object.freeze([...(value.depth_bids || [])]),
    depth_asks: Object.freeze([...(value.depth_asks || [])]),
    impact_bid_e8: value.impact_bid_e8 ?? null,
    impact_ask_e8: value.impact_ask_e8 ?? null,
    funding_rate_e12_per_interval: value.funding_rate_e12_per_interval,
    funding_interval_ms: value.funding_interval_ms,
    maker_fee_bps: value.maker_fee_bps,
    taker_fee_bps: value.taker_fee_bps,
    minimum_notional_micro_usdc: value.minimum_notional_micro_usdc,
    quantity_step_e8: value.quantity_step_e8,
    price_tick_e8: value.price_tick_e8,
    initial_margin_bps: value.initial_margin_bps,
    maintenance_margin_bps: value.maintenance_margin_bps,
    liquidation_fee_bps: value.liquidation_fee_bps,
    margin_tiers: Object.freeze([...(value.margin_tiers || [])]),
    liquidation_model: value.liquidation_model,
    as_of_ms: value.as_of_ms,
    source_observed_at_ms: Object.freeze({ ...(value.source_observed_at_ms || {}) }),
    stale_sources: Object.freeze(staleSourceNames),
    observed_at_ms: value.now_ms,
    status,
    stale,
    missing_fields: Object.freeze(missingFields),
    quality_flags: Object.freeze([...new Set([
      ...(value.quality_flags || []),
      ...((value.depth_bids?.length && value.depth_asks?.length) ? ["public_depth_ladder"] : ["depth_ladder_missing"]),
      ...staleSourceNames.map((source) => `source_stale:${source}`),
    ])]),
    executable: false,
  });
}

async function jsonRequest(fetchImpl, url, options, timeoutMs) {
  const response = await withTimeout(fetchImpl(url, { cache: "no-store", ...options }), timeoutMs);
  if (!response?.ok) throw new Error(`shadow_http_${response?.status || "failed"}`);
  return withTimeout(response.json(), timeoutMs);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("shadow_timeout")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function rowsFrom(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    const nested = value?.[key];
    if (Array.isArray(nested)) return nested;
    if (nested && Array.isArray(nested.dataList)) return nested.dataList;
  }
  return [];
}

function arrayValue(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function assetName(value) {
  const result = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return result || "UNKNOWN";
}

function priceE8(value) {
  return scaledDecimal(value, 100_000_000, { positive: true });
}

function rateE12(value) {
  return scaledDecimal(value, 1_000_000_000_000, { signed: true });
}

function feeBps(value) {
  return scaledDecimal(value, 10_000, { signed: true });
}

function percentBps(value) {
  return scaledDecimal(value, 100, { signed: true });
}

function moneyMicro(value) {
  return scaledDecimal(value, 1_000_000, { positive: true });
}

function decimalE8(value) {
  return scaledDecimal(value, 100_000_000, { positive: true });
}

function decimalStepE8(value) {
  const decimals = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;
  return 10 ** (8 - decimals);
}

function decimalProductMicro(quantity, priceScaledE8) {
  const quantityE8 = decimalE8(quantity);
  if (!quantityE8 || !priceScaledE8) return null;
  const numerator = BigInt(quantityE8) * BigInt(priceScaledE8);
  const result = Number((numerator + 9_999_999_999n) / 10_000_000_000n);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function scaledDecimal(value, scale, { positive = false, signed = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const decimals = String(scale).length - 1;
  const fraction = (match[3] || "").padEnd(decimals, "0");
  const kept = fraction.slice(0, decimals) || "0";
  const next = fraction.length > decimals ? Number(fraction[decimals]) : 0;
  let result = BigInt(match[2]) * BigInt(scale) + BigInt(kept);
  if (next >= 5) result += 1n;
  if (match[1] === "-") result = -result;
  const number = Number(result);
  if (!Number.isSafeInteger(number) || (positive && number <= 0) || (!signed && !positive && number < 0)) return null;
  return number;
}

function positiveIntegerFrom(value, fallback, multiplier = 1) {
  const parsed = Number(value);
  const result = parsed * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : fallback;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function leverageMarginBps(maxLeverage, numerator) {
  const parsed = positiveNumber(maxLeverage);
  if (!parsed) return null;
  const value = Math.ceil(numerator / parsed);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedMarginTiers(rows) {
  return Object.freeze((Array.isArray(rows) ? rows : []).map((row) => Object.freeze({
    lower_bound_micro_usdc: moneyMicro(row?.lowerBound),
    max_leverage: positiveNumber(row?.maxLeverage),
    initial_margin_bps: leverageMarginBps(row?.maxLeverage, 10_000),
    maintenance_margin_bps: leverageMarginBps(row?.maxLeverage, 5_000),
  })).filter((row) => row.max_leverage));
}

function normalizedEdgeXMarginTiers(rows) {
  return Object.freeze((Array.isArray(rows) ? rows : []).map((row) => Object.freeze({
    lower_bound_micro_usdc: null,
    upper_bound_micro_usdc: moneyMicro(row?.positionValueUpperBound),
    max_leverage: positiveNumber(row?.maxLeverage),
    initial_margin_bps: leverageMarginBps(row?.maxLeverage, 10_000),
    maintenance_margin_bps: feeBps(row?.maintenanceMarginRate),
  })).filter((row) => row.max_leverage));
}

function bestBookPrice(rows, side) {
  const prices = (Array.isArray(rows) ? rows : [])
    .map((row) => priceE8(Array.isArray(row) ? row[0] : row?.price ?? row?.px))
    .filter(Number.isSafeInteger);
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

function normalizedDepthLevels(rows, side) {
  const levels = (Array.isArray(rows) ? rows : []).map((row) => {
    const price = priceE8(Array.isArray(row) ? row[0] : row?.price ?? row?.px);
    const size = decimalE8(Array.isArray(row)
      ? row[1]
      : row?.remaining_base_amount ?? row?.size ?? row?.sz ?? row?.quantity);
    return price && size ? { price_e8: price, size_e8: size } : null;
  }).filter(Boolean).sort((left, right) => side === "bid"
    ? right.price_e8 - left.price_e8
    : left.price_e8 - right.price_e8);
  return Object.freeze(levels.slice(0, 100).map((level) => Object.freeze(level)));
}

function midpoint(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left <= 0 || right <= 0) return null;
  return Math.floor((left + right) / 2);
}

function timestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) return epochMilliseconds(value);
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return epochMilliseconds(numeric);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function epochMilliseconds(value) {
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function oldestTimestamp(values, fallback) {
  const valid = values.filter((value) => Number.isSafeInteger(value) && value > 0);
  return valid.length > 0 ? Math.min(...valid) : fallback;
}

function staleSources(value) {
  return Object.entries(value.source_observed_at_ms || {}).flatMap(([source, observedAt]) => {
    const maxAgeMs = value.source_max_age_ms?.[source] ?? value.max_age_ms;
    return observationFresh(observedAt, value.now_ms, maxAgeMs) ? [] : [source];
  });
}

function observationFresh(observedAt, nowMs, maxAgeMs) {
  return Number.isSafeInteger(observedAt) && observedAt > 0 &&
    observedAt <= nowMs + 5_000 && nowMs - observedAt <= maxAgeMs;
}

function freezeSnapshots(values) {
  return Object.freeze(values.filter((value) => value.asset !== "UNKNOWN"));
}

function selectAssets(snapshots, assets) {
  const allowed = normalizedAssetSet(assets);
  return Object.freeze(snapshots.filter((snapshot) => allowed.size === 0 || allowed.has(snapshot.asset)));
}

function selectPreferredAssetSnapshots(snapshots, quotePriority = []) {
  const quoteRank = new Map(quotePriority.map((quote, index) => [assetName(quote), index]));
  const ranked = [...snapshots].sort((left, right) => {
    const leftRank = quoteRank.get(left.quote_asset) ?? quotePriority.length;
    const rightRank = quoteRank.get(right.quote_asset) ?? quotePriority.length;
    return leftRank - rightRank || left.contract_id.localeCompare(right.contract_id);
  });
  const selected = new Map();
  for (const snapshot of ranked) {
    if (!selected.has(snapshot.asset)) selected.set(snapshot.asset, snapshot);
  }
  return Object.freeze([...selected.values()]);
}

function normalizedAssetSet(assets) {
  return new Set((Array.isArray(assets) ? assets : []).map(assetName).filter((asset) => asset !== "UNKNOWN"));
}

function edgeXAsset(contract) {
  return assetName(contract?.baseAsset || String(contract?.symbol || contract?.contractName || "")
    .replace(/USDT$|USDC$|USD$|-PERP$/, ""));
}

function hyperliquidQuoteAsset(asset) {
  return HYPERLIQUID_QUOTE_ASSETS[asset] || "USD";
}

function hyperliquidQuoteEvidenceFlag(asset) {
  if (HYPERLIQUID_QUOTE_ASSETS[asset] === "USDT") return "contract_specs_usdt_denominated_usdc_margined";
  if (HYPERLIQUID_QUOTE_ASSETS[asset] === "USDC") return "contract_specs_usdc_denominated_usdc_margined";
  return "quote_asset_unverified";
}

function errorCode(error) {
  const message = String(error?.message || "shadow_fetch_failed");
  return /^[a-z0-9_:-]{3,100}$/.test(message) ? message : "shadow_fetch_failed";
}
