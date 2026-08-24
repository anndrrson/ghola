import { CORE_PERP_VENUES } from "@ghola/execution-core";

const HOUR_MS = 3_600_000;
const EIGHT_HOURS_MS = 8 * HOUR_MS;
const DEFAULT_MAX_AGE_MS = 30_000;

export const PERP_SHADOW_ADAPTERS = Object.freeze({
  hyperliquid: Object.freeze({ read_only: true, trading_api_available: true, source_schema: "hyperliquid_metaAndAssetCtxs_v1" }),
  lighter: Object.freeze({ read_only: true, trading_api_available: true, source_schema: "lighter_orderBookDetails_fundingRates_v1" }),
  aster: Object.freeze({ read_only: true, trading_api_available: true, source_schema: "aster_fapi_v3" }),
  edgex: Object.freeze({ read_only: true, trading_api_available: true, source_schema: "edgex_public_v2" }),
  dydx: Object.freeze({ read_only: true, trading_api_available: true, source_schema: "dydx_indexer_v4" }),
  variational_omni: Object.freeze({ read_only: true, trading_api_available: false, source_schema: "variational_metadata_stats_v1" }),
});

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
  if (!CORE_PERP_VENUES.includes(venueId)) throw new Error("shadow_venue_unsupported");
  if (venueId === "hyperliquid") {
    const body = await jsonRequest(fetchImpl, "https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }, timeoutMs);
    return selectAssets(parseHyperliquidShadow({ body, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  if (venueId === "lighter") {
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
  if (venueId === "aster") {
    const [exchangeInfo, premiums, books] = await Promise.all([
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/exchangeInfo", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/premiumIndex", {}, timeoutMs),
      jsonRequest(fetchImpl, "https://fapi.asterdex.com/fapi/v3/ticker/bookTicker", {}, timeoutMs),
    ]);
    return selectPreferredAssetSnapshots(
      selectAssets(parseAsterShadow({ exchange_info: exchangeInfo, premium_index: premiums, book_tickers: books, now_ms: nowMs, max_age_ms: maxAgeMs }), assets),
      ["USDT", "USDC", "USD", "USD1", "U"],
    );
  }
  if (venueId === "edgex") {
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
      const [funding, ticker] = await Promise.all([
        jsonRequest(fetchImpl, `${baseUrl}/api/v2/public/funding/getLatestFundingRate?contractId=${contractId}`, {}, timeoutMs),
        jsonRequest(fetchImpl, `${baseUrl}/api/v2/public/quote/getTicker?contractId=${contractId}`, {}, timeoutMs),
      ]);
      const tickerRow = arrayValue(ticker?.data)[0] || {};
      const fundingRow = arrayValue(funding?.data)[0] || {};
      return {
        row: { ...tickerRow, ...fundingRow, contractId: fundingRow.contractId || tickerRow.contractId || row.contractId },
        responseTime: Math.max(timestamp(funding?.responseTime), timestamp(ticker?.responseTime)),
      };
    }));
    const funding = {
      data: observations.map((observation) => observation.row),
      responseTime: Math.max(0, ...observations.map((observation) => observation.responseTime)),
    };
    return selectAssets(parseEdgeXShadow({ funding, contracts: selectedContracts, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
  }
  if (venueId === "dydx") {
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
  const stats = await jsonRequest(
    fetchImpl,
    "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats",
    {},
    timeoutMs,
  );
  return selectAssets(parseVariationalShadow({ stats, now_ms: nowMs, max_age_ms: maxAgeMs }), assets);
}

export function parseHyperliquidShadow({ body, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const pair = Array.isArray(body) ? body : [];
  const universe = Array.isArray(pair[0]?.universe) ? pair[0].universe : [];
  const contexts = Array.isArray(pair[1]) ? pair[1] : [];
  const marginTables = new Map((Array.isArray(pair[0]?.marginTables) ? pair[0].marginTables : [])
    .map((row) => [String(row?.[0]), row?.[1]]));
  return freezeSnapshots(universe.map((meta, index) => {
    const context = contexts[index] || {};
    const asset = assetName(meta?.name);
    const impact = Array.isArray(context.impactPxs) ? context.impactPxs : [];
    const marginTiers = normalizedMarginTiers(marginTables.get(String(meta?.marginTableId))?.marginTiers);
    const maxLeverage = positiveNumber(meta?.maxLeverage);
    return shadowSnapshot({
      venue_id: "hyperliquid",
      contract_id: `hyperliquid:${asset}`,
      asset,
      quote_asset: "USD",
      collateral_asset: "USDC",
      mark_price_e8: priceE8(context.markPx),
      index_price_e8: priceE8(context.oraclePx),
      best_bid_e8: priceE8(impact[0]),
      best_ask_e8: priceE8(impact[1]),
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
      as_of_ms: nowMs,
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["fees_account_specific", "price_tick_dynamic"],
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
      funding_rate_e12_per_interval: rateE12(fundingRow.rate ?? row.funding_rate),
      funding_interval_ms: EIGHT_HOURS_MS,
      maker_fee_bps: feeBps(row.maker_fee ?? row.maker_fee_rate),
      taker_fee_bps: feeBps(row.taker_fee ?? row.taker_fee_rate),
      minimum_notional_micro_usdc: moneyMicro(row.min_quote_amount ?? row.minimum_notional),
      quantity_step_e8: decimalStepE8(row.supported_size_decimals ?? row.size_decimals),
      price_tick_e8: decimalStepE8(row.supported_price_decimals ?? row.price_decimals),
      initial_margin_bps: integerOrNull(row.default_initial_margin_fraction),
      maintenance_margin_bps: integerOrNull(row.maintenance_margin_fraction),
      liquidation_fee_bps: percentBps(row.liquidation_fee),
      margin_tiers: Object.freeze([]),
      liquidation_model: "account_equity_below_maintenance_margin",
      as_of_ms: timestamp(row.timestamp ?? details?.timestamp) || nowMs,
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["funding_rate_8h_equivalent"],
      ...PERP_SHADOW_ADAPTERS.lighter,
    });
  }));
}

export function parseAsterShadow({ exchange_info: exchangeInfo, premium_index: premiumIndex, book_tickers: bookTickers, now_ms: nowMs, max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const symbols = Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [];
  const premiums = new Map(arrayValue(premiumIndex).map((row) => [String(row.symbol), row]));
  const books = new Map(arrayValue(bookTickers).map((row) => [String(row.symbol), row]));
  return freezeSnapshots(symbols.filter((row) => row.contractType === "PERPETUAL" && row.status === "TRADING").map((row) => {
    const premium = premiums.get(String(row.symbol)) || {};
    const book = books.get(String(row.symbol)) || {};
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
      funding_rate_e12_per_interval: rateE12(premium.lastFundingRate),
      funding_interval_ms: EIGHT_HOURS_MS,
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
      as_of_ms: timestamp(premium.time ?? book.time ?? exchangeInfo.serverTime) || nowMs,
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["funding_interval_venue_default", "fees_account_specific"],
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
    const bid = priceE8(row.impactBidPrice);
    const ask = priceE8(row.impactAskPrice);
    const mark = priceE8(row.markPrice) || midpoint(bid, ask) || priceE8(row.oraclePrice);
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
      funding_rate_e12_per_interval: rateE12(row.fundingRate),
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
      as_of_ms: timestamp(row.fundingTimestamp ?? funding?.responseTime) || nowMs,
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: [
        ...(row.markPrice ? [] : ["impact_mid_used_as_mark_proxy"]),
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
      now_ms: nowMs,
      max_age_ms: maxAgeMs,
      quality_flags: ["orderbook_mid_used_as_mark_proxy", "fees_account_specific", "minimum_notional_unverified"],
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
  const stale = value.as_of_ms > value.now_ms + 5_000 || value.now_ms - value.as_of_ms > value.max_age_ms;
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
    observed_at_ms: value.now_ms,
    status,
    stale,
    missing_fields: Object.freeze(missingFields),
    quality_flags: Object.freeze([...new Set(value.quality_flags || [])]),
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
  const prices = (Array.isArray(rows) ? rows : []).map((row) => priceE8(row?.price)).filter(Number.isSafeInteger);
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

function midpoint(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left <= 0 || right <= 0) return null;
  return Math.floor((left + right) / 2);
}

function timestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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

function errorCode(error) {
  const message = String(error?.message || "shadow_fetch_failed");
  return /^[a-z0-9_:-]{3,100}$/.test(message) ? message : "shadow_fetch_failed";
}
