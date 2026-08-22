import { createHash, createHmac } from "node:crypto";
import { canonicalInstrumentId, credentialVaultSchema } from "./types.js";
import { krakenCommitment } from "./commitment.js";

const DEFAULT_BASE_URL = "https://api.kraken.com";
const REQUIRED_PERMISSIONS = new Set([
  "query-funds",
  "query-open-trades",
  "query-closed-trades",
  "modify-trades",
  "close-trades",
  "create-ws-token",
]);
const BLOCKED_PERMISSIONS = new Set([
  "add-funds",
  "withdraw-funds",
  "earn-funds",
  "add-withdraw-address",
  "update-withdraw-address",
]);

export class KrakenSpotAdapter {
  constructor({
    credential,
    fetchImpl = fetch,
    now = () => new Date(),
    baseUrl,
  }) {
    this.credential = credentialVaultSchema.parse(credential);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.baseUrl = safeBaseUrl(baseUrl || credential.base_url || DEFAULT_BASE_URL);
    this.lastNonce = 0n;
    this.catalog = null;
  }

  capabilities() {
    return {
      version: 1,
      adapter_id: "kraken-spot-xstocks-v1",
      venue_id: "kraken",
      product_scope: "xstocks_spot",
      operations: [
        "instruments",
        "account_snapshot",
        "quote",
        "prepare",
        "submit",
        "cancel",
        "reconcile",
      ],
      blocked_operations: [
        "withdraw",
        "deposit",
        "transfer",
        "margin",
        "futures",
        "earn",
        "staking",
      ],
    };
  }

  async verifyPermissions() {
    const result = await this.privateRequest("/0/private/GetApiKeyInfo");
    const permissions = new Set(result.permissions || []);
    const missing = [...REQUIRED_PERMISSIONS].filter((permission) => !permissions.has(permission));
    const dangerous = [...BLOCKED_PERMISSIONS].filter((permission) => permissions.has(permission));
    if (missing.length > 0 || dangerous.length > 0) {
      throw new KrakenAdapterError(
        "Kraken key permissions do not match the trade-only policy",
        "credential_permissions_rejected",
        403,
        { missing_permissions: missing, blocked_permissions_present: dangerous },
      );
    }
    return {
      version: 1,
      status: "verified",
      permission_commitment: krakenCommitment("permissions", {
        permissions: [...permissions].sort(),
        api_key_name: result.apiKeyName || null,
        valid_until: result.validUntil || null,
        ip_allowlist: result.ipAllowlist || [],
      }),
      permissions: [...permissions].sort(),
      key_name: result.apiKeyName || null,
      valid_until: result.validUntil || null,
      ip_allowlist_configured: Array.isArray(result.ipAllowlist) && result.ipAllowlist.length > 0,
      checked_at: this.now().toISOString(),
    };
  }

  async listInstruments({ refresh = false } = {}) {
    if (this.catalog && !refresh) return this.catalog;
    const [pairs, assets] = await Promise.all([
      this.publicRequest("/0/public/AssetPairs"),
      this.publicRequest("/0/public/Assets"),
    ]);
    const instruments = [];
    for (const [pairKey, pair] of Object.entries(pairs || {})) {
      const baseKey = String(pair.base || "");
      const asset = assets?.[baseKey] || assets?.[stripKrakenPrefix(baseKey)] || {};
      const metadata = {
        pair_key: pairKey,
        altname: pair.altname || pairKey,
        wsname: pair.wsname || "",
        base: baseKey,
        quote: pair.quote || "",
        pair,
        asset,
      };
      if (!trustedXStockMetadata(metadata)) continue;
      const ticker = xStockTicker(metadata);
      if (!ticker) continue;
      instruments.push({
        version: 1,
        canonical_instrument_id: canonicalInstrumentId(ticker),
        underlying_ticker: ticker.replace(/x$/i, "").toUpperCase(),
        venue_id: "kraken",
        venue_symbol: pair.altname || pairKey,
        websocket_symbol: pair.wsname || null,
        base_asset: baseKey,
        quote_asset: pair.quote || "ZUSD",
        price_decimals: integer(pair.pair_decimals, 8),
        quantity_decimals: integer(pair.lot_decimals, 8),
        order_min: decimalOrNull(pair.ordermin),
        cost_min: decimalOrNull(pair.costmin),
        status: pair.status || "online",
        metadata_commitment: krakenCommitment("instrument_metadata", {
          pair_key: pairKey,
          pair,
          asset,
        }),
      });
    }
    instruments.sort((a, b) => a.canonical_instrument_id.localeCompare(b.canonical_instrument_id));
    this.catalog = {
      version: 1,
      venue_id: "kraken",
      instruments,
      catalog_commitment: krakenCommitment("instrument_catalog", instruments),
      fetched_at: this.now().toISOString(),
    };
    return this.catalog;
  }

  async readAccount() {
    const catalog = await this.listInstruments();
    const [balanceResult, openResult, tradesResult] = await Promise.all([
      this.privateRequest("/0/private/BalanceEx").catch(() => this.privateRequest("/0/private/Balance")),
      this.privateRequest("/0/private/OpenOrders", { trades: "true" }),
      this.privateRequest("/0/private/TradesHistory", { type: "all", trades: "true" }),
    ]);
    const tickers = await this.tickers(catalog.instruments);
    const balances = normalizeBalances(balanceResult);
    const positions = {};
    for (const instrument of catalog.instruments) {
      const quantity = balanceForInstrument(balances, instrument);
      if (quantity <= 0) continue;
      const price = tickerPrice(tickers, instrument);
      positions[instrument.canonical_instrument_id] = {
        canonical_instrument_id: instrument.canonical_instrument_id,
        venue_symbol: instrument.venue_symbol,
        quantity: decimal(quantity),
        mark_price_usd: decimal(price),
        notional_usd: decimal(quantity * price),
        source: "kraken_balance",
      };
    }
    const openOrders = normalizeOpenOrders(openResult?.open || {}, catalog.instruments, tickers);
    const fills = normalizeTrades(tradesResult?.trades || {}, catalog.instruments);
    const usdBalance = findUsdBalance(balances);
    const externalActivity = {
      open_orders: openOrders.filter((order) => !isGholaOrder(order)),
      fills: fills.filter((fill) => fill.client_order_id && !isGholaOrder(fill)),
    };
    const fetchedAt = this.now().toISOString();
    const snapshotSeed = {
      usd_balance: decimal(usdBalance),
      positions,
      open_orders: openOrders,
      recent_fills: fills.slice(0, 500),
      fetched_at: fetchedAt,
    };
    return {
      version: 1,
      venue_id: "kraken",
      snapshot_commitment: krakenCommitment("portfolio_snapshot", snapshotSeed),
      completeness: "complete",
      usd_balance: decimal(usdBalance),
      positions,
      open_orders_list: openOrders,
      open_orders: aggregateOpenOrders(openOrders),
      recent_fills: fills.slice(0, 500),
      external_activity: {
        detected: externalActivity.open_orders.length > 0 || externalActivity.fills.length > 0,
        external_order_count: externalActivity.open_orders.length,
        external_fill_count: externalActivity.fills.length,
      },
      fetched_at: fetchedAt,
    };
  }

  async quote({ canonical_instrument_id, side, notional_usd }) {
    const instrument = await this.instrument(canonical_instrument_id);
    const depth = await this.publicRequest("/0/public/Depth", {
      pair: instrument.venue_symbol,
      count: "25",
    });
    const book = depth[instrument.venue_symbol] ||
      depth[Object.keys(depth)[0]] ||
      {};
    const levels = side === "buy" ? book.asks || [] : book.bids || [];
    const quote = executableQuote(levels, Number(notional_usd));
    if (!quote) {
      throw new KrakenAdapterError("Kraken order book has insufficient depth", "insufficient_liquidity", 409);
    }
    const fetchedAt = this.now().toISOString();
    return {
      version: 1,
      venue_id: "kraken",
      canonical_instrument_id,
      venue_symbol: instrument.venue_symbol,
      side,
      requested_notional_usd: decimal(notional_usd),
      executable_notional_usd: decimal(quote.notional),
      quantity: decimal(quote.quantity),
      best_price: decimal(quote.bestPrice),
      average_price: decimal(quote.averagePrice),
      worst_price: decimal(quote.worstPrice),
      price_impact_bps: Math.max(
        0,
        Math.round(Math.abs(quote.averagePrice / quote.bestPrice - 1) * 10_000),
      ),
      fetched_at: fetchedAt,
      expires_at: new Date(this.now().getTime() + 5_000).toISOString(),
      quote_commitment: krakenCommitment("quote", {
        canonical_instrument_id,
        side,
        notional_usd: decimal(notional_usd),
        quote,
        fetched_at: fetchedAt,
      }),
    };
  }

  async prepare({ child_order, quote, max_slippage_bps, client_order_id }) {
    const instrument = await this.instrument(child_order.canonical_instrument_id);
    const quoteAge = this.now().getTime() - Date.parse(quote.fetched_at);
    if (quoteAge < 0 || quoteAge > Number(child_order.max_quote_age_ms || 10_000)) {
      throw new KrakenAdapterError("Kraken quote is stale", "quote_stale", 409);
    }
    const side = child_order.side;
    const slippage = Number(max_slippage_bps) / 10_000;
    const rawLimit = side === "buy"
      ? Number(quote.worst_price) * (1 + slippage)
      : Number(quote.worst_price) * (1 - slippage);
    const price = roundPrice(rawLimit, instrument.price_decimals, side);
    const maxQuantity = Number(child_order.notional_usd) / Number(quote.average_price);
    const quantity = roundDown(maxQuantity, instrument.quantity_decimals);
    if (quantity <= 0 || (instrument.order_min && quantity < Number(instrument.order_min))) {
      throw new KrakenAdapterError("Kraken order is below the instrument minimum", "order_below_minimum", 409);
    }
    const payload = {
      pair: instrument.venue_symbol,
      type: side,
      ordertype: "limit",
      price: decimal(price),
      volume: decimal(quantity),
      timeinforce: "IOC",
      oflags: "fciq",
      cl_ord_id: client_order_id,
    };
    return {
      version: 1,
      adapter_id: "kraken-spot-xstocks-v1",
      canonical_instrument_id: child_order.canonical_instrument_id,
      client_order_id,
      payload,
      request_commitment: krakenCommitment("prepared_order", payload),
      quote_commitment: quote.quote_commitment,
      prepared_at: this.now().toISOString(),
    };
  }

  async submit(prepared, { validateOnly = false } = {}) {
    const payload = {
      ...prepared.payload,
      ...(validateOnly ? { validate: "true" } : {}),
    };
    try {
      const result = await this.privateRequest("/0/private/AddOrder", payload, {
        ambiguousOnTransportFailure: !validateOnly,
      });
      return {
        version: 1,
        status: validateOnly ? "validated" : "acknowledged",
        client_order_id: prepared.client_order_id,
        transaction_ids: result.txid || [],
        description: result.descr || null,
        request_commitment: prepared.request_commitment,
        acknowledgement_commitment: krakenCommitment("order_acknowledgement", result),
        acknowledged_at: this.now().toISOString(),
      };
    } catch (error) {
      if (error instanceof KrakenAmbiguousSubmissionError) {
        return {
          version: 1,
          status: "unknown",
          client_order_id: prepared.client_order_id,
          transaction_ids: [],
          request_commitment: prepared.request_commitment,
          acknowledgement_commitment: null,
          error_code: error.code,
          acknowledged_at: this.now().toISOString(),
        };
      }
      throw error;
    }
  }

  async cancel({ transaction_id, client_order_id }) {
    const result = await this.privateRequest("/0/private/CancelOrder", transaction_id
      ? { txid: transaction_id }
      : { cl_ord_id: client_order_id });
    return {
      version: 1,
      status: "cancel_requested",
      count: Number(result.count || 0),
      pending: Boolean(result.pending),
      cancel_commitment: krakenCommitment("cancel", result),
      requested_at: this.now().toISOString(),
    };
  }

  async reconcile({ client_order_id, transaction_ids = [] }) {
    const [openResult, closedResult, tradesResult] = await Promise.all([
      this.privateRequest("/0/private/OpenOrders", { trades: "true" }),
      this.privateRequest("/0/private/ClosedOrders", { trades: "true" }),
      this.privateRequest("/0/private/TradesHistory", { type: "all", trades: "true" }),
    ]);
    const catalog = await this.listInstruments();
    const orderEntries = [
      ...Object.entries(openResult?.open || {}).map(([id, order]) => ({ id, order, open: true })),
      ...Object.entries(closedResult?.closed || {}).map(([id, order]) => ({ id, order, open: false })),
    ];
    const match = orderEntries.find(({ id, order }) =>
      transaction_ids.includes(id) ||
      String(order.cl_ord_id || order.client_order_id || "") === client_order_id
    );
    const fills = normalizeTrades(tradesResult?.trades || {}, catalog.instruments)
      .filter((fill) =>
        fill.client_order_id === client_order_id ||
        (match && fill.order_transaction_id === match.id)
      );
    if (!match && fills.length === 0) {
      return {
        version: 1,
        status: "not_found",
        client_order_id,
        transaction_id: null,
        fills: [],
        final: true,
        reconciliation_commitment: krakenCommitment("reconciliation", {
          client_order_id,
          status: "not_found",
        }),
        reconciled_at: this.now().toISOString(),
      };
    }
    const status = normalizeOrderStatus(match?.order, match?.open, fills);
    const result = {
      version: 1,
      status,
      client_order_id,
      transaction_id: match?.id || fills[0]?.order_transaction_id || null,
      fills,
      final: ["filled", "cancelled", "expired", "rejected", "no_fill"].includes(status),
      reconciled_at: this.now().toISOString(),
    };
    return {
      ...result,
      reconciliation_commitment: krakenCommitment("reconciliation", result),
    };
  }

  async instrument(canonicalId) {
    const catalog = await this.listInstruments();
    const instrument = catalog.instruments.find((item) =>
      item.canonical_instrument_id === canonicalId
    );
    if (!instrument) {
      throw new KrakenAdapterError("xStock is not available through the linked Kraken API", "instrument_unavailable", 404);
    }
    if (instrument.status !== "online") {
      throw new KrakenAdapterError("xStock is not currently tradable", "instrument_not_tradable", 409);
    }
    return instrument;
  }

  async tickers(instruments) {
    if (instruments.length === 0) return {};
    const pair = instruments.map((item) => item.venue_symbol).join(",");
    return this.publicRequest("/0/public/Ticker", { pair });
  }

  async publicRequest(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return this.request(url, { method: "GET" });
  }

  async privateRequest(path, params = {}, options = {}) {
    const nonce = this.nextNonce();
    const form = new URLSearchParams({ nonce, ...stringParams(params) });
    const signature = signKrakenRequest({
      secretBase64: this.credential.api_secret_base64,
      path,
      nonce,
      postData: form.toString(),
    });
    const url = new URL(path, this.baseUrl);
    return this.request(url, {
      method: "POST",
      headers: {
        "API-Key": this.credential.api_key,
        "API-Sign": signature,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      ambiguousOnTransportFailure: options.ambiguousOnTransportFailure,
    });
  }

  async request(url, init) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          ...(init.headers || {}),
        },
        body: init.body,
      });
    } catch (error) {
      if (init.ambiguousOnTransportFailure) {
        throw new KrakenAmbiguousSubmissionError(String(error?.message || "Kraken transport failure"));
      }
      throw new KrakenAdapterError("Kraken API is unavailable", "kraken_unavailable", 503);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = response.status === 429 ? "rate_limited" : "kraken_http_error";
      throw new KrakenAdapterError(`Kraken API returned HTTP ${response.status}`, code, response.status, body);
    }
    const errors = Array.isArray(body?.error) ? body.error.filter(Boolean) : [];
    if (errors.length > 0) {
      throw krakenApiError(errors);
    }
    return body?.result ?? {};
  }

  nextNonce() {
    const candidate = BigInt(this.now().getTime()) * 1_000n;
    this.lastNonce = candidate > this.lastNonce ? candidate : this.lastNonce + 1n;
    return this.lastNonce.toString();
  }
}

export function signKrakenRequest({ secretBase64, path, nonce, postData }) {
  let secret;
  try {
    secret = Buffer.from(secretBase64, "base64");
  } catch {
    throw new KrakenAdapterError("Kraken API secret is invalid", "credential_invalid", 400);
  }
  if (secret.length < 16) {
    throw new KrakenAdapterError("Kraken API secret is invalid", "credential_invalid", 400);
  }
  const encoded = createHash("sha256")
    .update(`${nonce}${postData}`)
    .digest();
  return createHmac("sha512", secret)
    .update(Buffer.concat([Buffer.from(path), encoded]))
    .digest("base64");
}

export function trustedXStockMetadata({ altname, wsname, base, quote, pair, asset }) {
  const symbol = `${altname || ""} ${wsname || ""} ${base || ""}`;
  const description = [
    pair?.description,
    pair?.name,
    pair?.asset_class,
    pair?.asset_type,
    asset?.description,
    asset?.name,
    asset?.asset_class,
    asset?.asset_type,
  ].filter(Boolean).join(" ");
  const explicitClass = /xstock|tokenized[_ -]?(equity|stock|etf)|equity[_ -]?token/i.test(description);
  const xStockSymbol = /[A-Z0-9.]+x(?:[\/._-]|$)/i.test(symbol);
  const usdQuote = /USD$/i.test(String(quote || pair?.quote || ""));
  // Kraken's current public documentation defines the trailing "x" as the
  // identifier for xStocks. Prefer explicit API metadata when present, but do
  // not require fields that AssetPairs does not consistently publish.
  return xStockSymbol && usdQuote && (explicitClass || hasCanonicalXStockPair({ altname, wsname }));
}

function hasCanonicalXStockPair({ altname, wsname }) {
  return /[A-Z0-9.]+x(?:USD|\/USD)$/i.test(String(altname || "")) ||
    /[A-Z0-9.]+x\/USD$/i.test(String(wsname || ""));
}

export class KrakenAdapterError extends Error {
  constructor(message, code = "kraken_error", status = 502, details = null) {
    super(message);
    this.name = "KrakenAdapterError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class KrakenAmbiguousSubmissionError extends KrakenAdapterError {
  constructor(message) {
    super(message, "submission_unknown", 503);
    this.name = "KrakenAmbiguousSubmissionError";
  }
}

function safeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && process.env.NODE_ENV !== "test") {
    throw new KrakenAdapterError("Kraken base URL must use HTTPS", "base_url_invalid", 400);
  }
  return url.origin;
}

function krakenApiError(errors) {
  const text = errors.join("; ");
  if (/permission denied|permission/i.test(text)) {
    return new KrakenAdapterError("Kraken API permission denied", "credential_permission_denied", 403, errors);
  }
  if (/insufficient funds/i.test(text)) {
    return new KrakenAdapterError("Kraken account has insufficient funds", "insufficient_funds", 409, errors);
  }
  if (/rate limit|throttled/i.test(text)) {
    return new KrakenAdapterError("Kraken API rate limit exceeded", "rate_limited", 429, errors);
  }
  if (/market.*(closed|unavailable)|service.*unavailable/i.test(text)) {
    return new KrakenAdapterError("Kraken xStock market is unavailable", "market_unavailable", 503, errors);
  }
  if (/invalid nonce/i.test(text)) {
    return new KrakenAdapterError("Kraken API nonce was rejected", "nonce_rejected", 409, errors);
  }
  return new KrakenAdapterError("Kraken API rejected the request", "venue_rejected", 409, errors);
}

function xStockTicker(metadata) {
  const candidates = [
    metadata.altname,
    String(metadata.wsname || "").split("/")[0],
    stripKrakenPrefix(metadata.base),
  ];
  return candidates
    .map((value) => String(value || "").replace(/(?:USD|ZUSD)$/i, ""))
    .find((value) => /x$/i.test(value)) || null;
}

function stripKrakenPrefix(value) {
  return String(value || "").replace(/^[XZ](?=[A-Z0-9])/i, "");
}

function normalizeBalances(result) {
  return Object.fromEntries(Object.entries(result || {}).map(([asset, value]) => {
    const balance = typeof value === "object" && value
      ? Number(value.balance || value.available || 0) - Number(value.hold_trade || 0)
      : Number(value || 0);
    return [asset, Number.isFinite(balance) ? balance : 0];
  }));
}

function findUsdBalance(balances) {
  for (const key of ["ZUSD", "USD"]) {
    if (Number.isFinite(balances[key])) return Math.max(0, balances[key]);
  }
  return 0;
}

function balanceForInstrument(balances, instrument) {
  const keys = [
    instrument.base_asset,
    stripKrakenPrefix(instrument.base_asset),
    `${instrument.underlying_ticker}x`,
  ];
  for (const key of keys) {
    if (Number.isFinite(balances[key])) return Math.max(0, balances[key]);
  }
  return 0;
}

function tickerPrice(tickers, instrument) {
  const ticker = tickers[instrument.venue_symbol] ||
    tickers[Object.keys(tickers).find((key) => key === instrument.venue_symbol)] ||
    {};
  return Number(ticker.c?.[0] || ticker.a?.[0] || ticker.b?.[0] || 0);
}

function normalizeOpenOrders(openOrders, instruments, tickers) {
  return Object.entries(openOrders).map(([transactionId, order]) => {
    const symbol = order.descr?.pair || order.pair || "";
    const instrument = matchInstrument(instruments, symbol);
    if (!instrument) return null;
    const side = String(order.descr?.type || order.type || "").toLowerCase();
    const quantity = Math.max(0, Number(order.vol || 0) - Number(order.vol_exec || 0));
    const price = Number(order.descr?.price || order.price || tickerPrice(tickers, instrument));
    const notional = quantity * price;
    return {
      transaction_id: transactionId,
      client_order_id: order.cl_ord_id || order.client_order_id || null,
      canonical_instrument_id: instrument.canonical_instrument_id,
      side,
      quantity: decimal(quantity),
      limit_price: decimal(price),
      remaining_notional_usd: decimal(notional),
      signed_notional_usd: decimal(side === "sell" ? -notional : notional),
      status: order.status || "open",
      opened_at: order.opentm ? new Date(Number(order.opentm) * 1_000).toISOString() : null,
    };
  }).filter(Boolean);
}

function normalizeTrades(trades, instruments) {
  return Object.entries(trades).map(([tradeId, trade]) => {
    const instrument = matchInstrument(instruments, trade.pair || trade.symbol || "");
    if (!instrument) return null;
    const side = String(trade.type || trade.side || "").toLowerCase();
    const quantity = Number(trade.vol || trade.quantity || 0);
    const price = Number(trade.price || 0);
    return {
      trade_id: tradeId,
      order_transaction_id: trade.ordertxid || trade.order_id || null,
      client_order_id: trade.cl_ord_id || trade.client_order_id || null,
      canonical_instrument_id: instrument.canonical_instrument_id,
      side,
      quantity: decimal(quantity),
      price: decimal(price),
      notional_usd: decimal(quantity * price),
      fee_usd: decimal(trade.fee || 0),
      executed_at: trade.time ? new Date(Number(trade.time) * 1_000).toISOString() : null,
    };
  }).filter(Boolean).sort((a, b) => String(b.executed_at).localeCompare(String(a.executed_at)));
}

function matchInstrument(instruments, symbol) {
  const normalized = String(symbol || "").replace(/[\/._-]/g, "").toUpperCase();
  return instruments.find((instrument) =>
    [
      instrument.venue_symbol,
      instrument.websocket_symbol,
      `${instrument.underlying_ticker}xUSD`,
    ].filter(Boolean).some((value) =>
      String(value).replace(/[\/._-]/g, "").toUpperCase() === normalized
    )
  );
}

function aggregateOpenOrders(orders) {
  const aggregated = {};
  for (const order of orders) {
    const asset = order.canonical_instrument_id;
    const current = aggregated[asset] || {
      canonical_instrument_id: asset,
      signed_notional_usd: 0,
      order_count: 0,
    };
    current.signed_notional_usd += Number(order.signed_notional_usd || 0);
    current.order_count += 1;
    aggregated[asset] = current;
  }
  return Object.fromEntries(Object.entries(aggregated).map(([asset, value]) => [
    asset,
    { ...value, signed_notional_usd: decimal(value.signed_notional_usd) },
  ]));
}

function isGholaOrder(value) {
  return String(value.client_order_id || "").startsWith("ghk-");
}

function executableQuote(levels, requestedNotional) {
  if (!Number.isFinite(requestedNotional) || requestedNotional <= 0) return null;
  let remaining = requestedNotional;
  let quantity = 0;
  let notional = 0;
  let bestPrice = 0;
  let worstPrice = 0;
  for (const level of levels) {
    const price = Number(Array.isArray(level) ? level[0] : level.price);
    const availableQuantity = Number(Array.isArray(level) ? level[1] : level.qty);
    if (!Number.isFinite(price) || !Number.isFinite(availableQuantity) || price <= 0 || availableQuantity <= 0) {
      continue;
    }
    if (!bestPrice) bestPrice = price;
    const availableNotional = price * availableQuantity;
    const takeNotional = Math.min(remaining, availableNotional);
    quantity += takeNotional / price;
    notional += takeNotional;
    remaining -= takeNotional;
    worstPrice = price;
    if (remaining <= 1e-8) break;
  }
  if (remaining > Math.max(0.01, requestedNotional * 0.001) || quantity <= 0) return null;
  return {
    quantity,
    notional,
    bestPrice,
    worstPrice,
    averagePrice: notional / quantity,
  };
}

function normalizeOrderStatus(order, isOpen, fills) {
  if (isOpen) return fills.length > 0 ? "partially_filled" : "open";
  const status = String(order?.status || "").toLowerCase();
  const volume = Number(order?.vol || 0);
  const executed = Number(order?.vol_exec || 0);
  if (status === "closed" && executed >= volume && volume > 0) return "filled";
  if (status === "canceled" || status === "cancelled") return fills.length > 0 ? "partially_filled" : "cancelled";
  if (status === "expired") return fills.length > 0 ? "partially_filled" : "expired";
  if (fills.length > 0) return "filled";
  return "no_fill";
}

function roundDown(value, decimals) {
  const factor = 10 ** Math.max(0, decimals);
  return Math.floor((Number(value) + Number.EPSILON) * factor) / factor;
}

function roundPrice(value, decimals, side) {
  const factor = 10 ** Math.max(0, decimals);
  const scaled = Number(value) * factor;
  return (side === "buy" ? Math.ceil(scaled) : Math.floor(scaled)) / factor;
}

function decimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toFixed(10).replace(/\.?0+$/, "") || "0";
}

function decimalOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return decimal(value);
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function stringParams(params) {
  return Object.fromEntries(Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]));
}
