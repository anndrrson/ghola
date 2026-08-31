import { createHash } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  cashflowValuationEvidenceMessage,
  normalizeCashflowValuation,
} from "@ghola/execution-core";

const ASTER_USDC_USDT_DEPTH_URL = "https://sapi.asterdex.com/api/v3/depth?symbol=USDCUSDT&limit=100";
const COINBASE_USDT_USDC_DEPTH_URL = "https://api.exchange.coinbase.com/products/USDT-USDC/book?level=2";
const COINBASE_USDT_USD_DEPTH_URL = "https://api.exchange.coinbase.com/products/USDT-USD/book?level=2";
const RATE_SCALE = 100_000_000n;

export function createAsterStablecoinConversionQuoteReader({
  policy,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  return async function readAsterStablecoinConversionQuote(request) {
    const checkedAtMs = positiveInteger(request?.checked_at_ms, "carry_conversion_checked_at_invalid");
    const observedAtMs = positiveInteger(now(), "carry_conversion_now_invalid");
    if (Math.abs(observedAtMs - checkedAtMs) > 5_000) fail("carry_conversion_checked_at_stale");
    const normalizedPolicy = conversionPolicy(resolvePolicy(policy, {
      checked_at_ms: checkedAtMs,
      source_collateral_asset: request?.source_collateral_asset,
      destination_collateral_asset: request?.destination_collateral_asset,
    }), checkedAtMs);
    const sourceAsset = String(request?.source_collateral_asset || "");
    const destinationAsset = String(request?.destination_collateral_asset || "");
    if (!((sourceAsset === "USDC" && destinationAsset === "USDT")
      || (sourceAsset === "USDT" && destinationAsset === "USDC"))) {
      fail("carry_conversion_pair_unsupported");
    }
    const response = await fetchImpl(ASTER_USDC_USDT_DEPTH_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response?.ok) fail("carry_conversion_book_unavailable");
    const body = await response.json();
    if (body?.symbol !== "USDCUSDT") fail("carry_conversion_book_binding_invalid");
    const bookTimeMs = positiveInteger(body?.T ?? body?.E, "carry_conversion_book_time_invalid");
    if (bookTimeMs > checkedAtMs + 5_000 || checkedAtMs - bookTimeMs > 5_000) {
      fail("carry_conversion_book_stale");
    }
    const levels = sourceAsset === "USDC"
      ? conversionLevels(body?.bids, "sell_base")
      : conversionLevels(body?.asks, "buy_base");
    const bestRateE8 = levels[0].rate_e8;
    const thresholdRateE8 = bestRateE8
      * BigInt(10_000 - normalizedPolicy.max_slippage_bps) / 10_000n;
    const eligible = levels.filter((level) => level.rate_e8 >= thresholdRateE8);
    if (eligible.length === 0) fail("carry_conversion_depth_unavailable");
    const depthCapacity = eligible.reduce((total, level) => total + level.input_micro_usdc, 0n);
    const maximum = minBigInt(depthCapacity, BigInt(normalizedPolicy.maximum_transfer_micro_usdc));
    const minimum = BigInt(normalizedPolicy.minimum_transfer_micro_usdc);
    if (maximum < minimum || maximum === 0n) fail("carry_conversion_capacity_unavailable");
    const rateFloorE8 = eligible.reduce(
      (floor, level) => level.rate_e8 < floor ? level.rate_e8 : floor,
      eligible[0].rate_e8,
    );
    const fee = ceilingDivide(maximum * BigInt(normalizedPolicy.fee_ceiling_bps), 10_000n);
    const rateShortfall = rateFloorE8 < RATE_SCALE ? RATE_SCALE - rateFloorE8 : 0n;
    const slippage = ceilingDivide(maximum * rateShortfall, RATE_SCALE);
    return Object.freeze({
      kind: "conversion",
      status: "available",
      valuation_asset: "USD",
      source_asset: sourceAsset,
      destination_asset: destinationAsset,
      venue_id: "aster",
      market: "USDCUSDT",
      verified: true,
      capacity_bound_verified: true,
      fee_upper_bound_verified: true,
      latency_upper_bound_verified: true,
      read_only: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      minimum_transfer_micro_usdc: safeNumber(minimum, "carry_conversion_minimum_invalid"),
      maximum_transfer_micro_usdc: safeNumber(maximum, "carry_conversion_maximum_invalid"),
      fee_upper_bound_micro_usdc: safeNumber(fee, "carry_conversion_fee_invalid"),
      slippage_upper_bound_micro_usdc: safeNumber(slippage, "carry_conversion_slippage_invalid"),
      latency_upper_bound_ms: normalizedPolicy.latency_ceiling_ms,
      rate_floor_e8: safeNumber(rateFloorE8, "carry_conversion_rate_invalid"),
      as_of_ms: bookTimeMs,
    });
  };
}

export function createAsterCashflowValuationReader({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let cachedBookPromise = null;
  return async function readAsterCashflowValuation(request) {
    const checkedAtMs = positiveInteger(request?.checked_at_ms, "cashflow_valuation_checked_at_invalid");
    const observedNowMs = positiveInteger(now(), "cashflow_valuation_now_invalid");
    if (Math.abs(observedNowMs - checkedAtMs) > 5_000) fail("cashflow_valuation_checked_at_stale");
    if (String(request?.source_asset || "") !== "USDT") fail("cashflow_valuation_pair_unsupported");
    cachedBookPromise ??= readJsonBook(fetchImpl, ASTER_USDC_USDT_DEPTH_URL);
    const body = await cachedBookPromise;
    if (body?.symbol !== "USDCUSDT") fail("cashflow_valuation_book_binding_invalid");
    const bookTimeMs = positiveInteger(body?.T ?? body?.E, "cashflow_valuation_book_time_invalid");
    if (bookTimeMs > checkedAtMs + 5_000 || checkedAtMs - bookTimeMs > 5_000) {
      fail("cashflow_valuation_book_stale");
    }
    const bids = normalizedBookLevels(body?.bids, "bid");
    const asks = normalizedBookLevels(body?.asks, "ask");
    const bestBidE8 = bids[0].price_e8;
    const bestAskE8 = asks[0].price_e8;
    if (bestBidE8 > bestAskE8) fail("cashflow_valuation_book_crossed");
    const boundSourceAmountMicro = request?.source_amount_micro === undefined
      ? null
      : signedSafeInteger(request.source_amount_micro, "cashflow_valuation_source_amount_invalid");
    if (boundSourceAmountMicro === 0) fail("cashflow_valuation_source_amount_invalid");
    const sourceAmountDecimal = boundSourceAmountMicro === null
      ? null
      : canonicalSourceDecimal(request?.source_amount_decimal);
    const sourceAmountScale = sourceAmountDecimal === null
      ? null
      : sourceAmountDecimal.split(".")[1]?.length || 0;
    if (boundSourceAmountMicro !== null && request?.source_amount_scale !== sourceAmountScale) {
      fail("cashflow_valuation_source_scale_invalid");
    }
    const rates = boundSourceAmountMicro === null
      ? {
          credit_rate_e8: RATE_SCALE * RATE_SCALE / BigInt(bestAskE8),
          debit_rate_e8: ceilingDivide(RATE_SCALE * RATE_SCALE, BigInt(bestBidE8)),
        }
      : depthBoundValuationRates(BigInt(Math.abs(boundSourceAmountMicro)), bids, asks);
    const boundValueMicroUsdc = boundSourceAmountMicro === null
      ? null
      : asterBoundValueMicroUsdc(boundSourceAmountMicro, bids, asks);
    const evidenceSource = "aster:USDCUSDT:book:v1";
    const valuation = {
      version: 1,
      source_asset: "USDT",
      valuation_asset: "USDC",
      verified: true,
      ...(boundSourceAmountMicro === null ? {} : { bound_source_amount_micro: boundSourceAmountMicro }),
      ...(boundValueMicroUsdc === null ? {} : { bound_value_micro_usdc: boundValueMicroUsdc }),
      credit_rate_e8: safeNumber(rates.credit_rate_e8, "cashflow_valuation_credit_rate_invalid"),
      debit_rate_e8: safeNumber(rates.debit_rate_e8, "cashflow_valuation_debit_rate_invalid"),
      observed_at_ms: bookTimeMs,
      expires_at_ms: bookTimeMs + 30_000,
      evidence_source: evidenceSource,
    };
    const evidenceMessage = cashflowValuationEvidenceMessage(valuation);
    const evidencePayload = {
      venue_id: "aster",
      market: "USDCUSDT",
      book_time_ms: bookTimeMs,
      ...(boundSourceAmountMicro === null ? {} : {
        source_amount_micro: boundSourceAmountMicro,
        source_amount_decimal: sourceAmountDecimal,
        source_amount_scale: sourceAmountScale,
      }),
      bids,
      asks,
    };
    return normalizeCashflowValuation({
      ...valuation,
      evidence_message: evidenceMessage,
      evidence_payload: evidencePayload,
      evidence_commitment: valuationCommitment(evidenceMessage, evidencePayload),
    });
  };
}

export function createCoinbaseUsdCashflowValuationReader({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  return createCoinbaseCashflowValuationReader({ sourceAsset: "USD", fetchImpl, now });
}

export function createCoinbaseUsdtCashflowValuationReader({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  return createCoinbaseCashflowValuationReader({ sourceAsset: "USDT", fetchImpl, now });
}

export function verifyCashflowValuationEvidence(value) {
  const valuation = normalizeCashflowValuation(value);
  if (valuation.source_asset === "USDC") return valuation;
  const payload = valuation.evidence_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("cashflow_valuation_evidence_payload_invalid");
  }
  if (valuation.evidence_commitment !== valuationCommitment(valuation.evidence_message, payload)) {
    fail("cashflow_valuation_evidence_commitment_invalid");
  }
  verifyBoundEvidencePayload(valuation, payload);

  let rates;
  let observedAtMs;
  let boundValueMicroUsdc = null;
  const magnitude = valuation.bound_source_amount_micro === null
    ? null
    : BigInt(Math.abs(valuation.bound_source_amount_micro));
  if (valuation.evidence_source === "aster:USDCUSDT:book:v1") {
    if (valuation.source_asset !== "USDT"
      || payload.venue_id !== "aster"
      || payload.market !== "USDCUSDT") fail("cashflow_valuation_evidence_binding_invalid");
    observedAtMs = positiveInteger(payload.book_time_ms, "cashflow_valuation_evidence_time_invalid");
    const book = evidenceBook(payload, "USDCUSDT", observedAtMs);
    rates = magnitude === null
      ? {
          credit_rate_e8: RATE_SCALE * RATE_SCALE / BigInt(book.asks[0].price_e8),
          debit_rate_e8: ceilingDivide(RATE_SCALE * RATE_SCALE, BigInt(book.bids[0].price_e8)),
        }
      : depthBoundValuationRates(magnitude, book.bids, book.asks);
    boundValueMicroUsdc = valuation.bound_source_amount_micro === null
      ? null
      : asterBoundValueMicroUsdc(valuation.bound_source_amount_micro, book.bids, book.asks);
  } else if (valuation.evidence_source === "coinbase-exchange:USDT-USDC:book:v1") {
    if (valuation.source_asset !== "USDT") fail("cashflow_valuation_evidence_binding_invalid");
    const books = coinbaseEvidenceBooks(payload, ["USDT-USDC"]);
    observedAtMs = books[0].observed_at_ms;
    rates = coinbaseUsdtValuationRates(magnitude, books[0]);
    boundValueMicroUsdc = valuation.bound_source_amount_micro === null
      ? null
      : coinbaseBoundValueMicroUsdc("USDT", valuation.bound_source_amount_micro, books);
  } else if (valuation.evidence_source === "coinbase-exchange:USDT-USD:USDT-USDC:cross-book:v1") {
    if (valuation.source_asset !== "USD") fail("cashflow_valuation_evidence_binding_invalid");
    const books = coinbaseEvidenceBooks(payload, ["USDT-USDC", "USDT-USD"]);
    observedAtMs = Math.min(...books.map((book) => book.observed_at_ms));
    rates = coinbaseUsdValuationRates(magnitude, books[0], books[1]);
    boundValueMicroUsdc = valuation.bound_source_amount_micro === null
      ? null
      : coinbaseBoundValueMicroUsdc("USD", valuation.bound_source_amount_micro, books);
  } else {
    fail("cashflow_valuation_evidence_source_unsupported");
  }
  if (observedAtMs !== valuation.observed_at_ms
    || valuation.expires_at_ms !== observedAtMs + 30_000) {
    fail("cashflow_valuation_evidence_time_invalid");
  }
  if (safeNumber(rates.credit_rate_e8, "cashflow_valuation_credit_rate_invalid") !== valuation.credit_rate_e8
    || safeNumber(rates.debit_rate_e8, "cashflow_valuation_debit_rate_invalid") !== valuation.debit_rate_e8) {
    fail("cashflow_valuation_evidence_rate_mismatch");
  }
  if (boundValueMicroUsdc !== valuation.bound_value_micro_usdc) {
    fail("cashflow_valuation_evidence_bound_value_mismatch");
  }
  return valuation;
}

function createCoinbaseCashflowValuationReader({ sourceAsset, fetchImpl, now }) {
  let cachedBooksPromise = null;
  return async function readCoinbaseCashflowValuation(request) {
    const checkedAtMs = positiveInteger(request?.checked_at_ms, "cashflow_valuation_checked_at_invalid");
    const observedNowMs = positiveInteger(now(), "cashflow_valuation_now_invalid");
    if (Math.abs(observedNowMs - checkedAtMs) > 5_000) fail("cashflow_valuation_checked_at_stale");
    if (String(request?.source_asset || "") !== sourceAsset) fail("cashflow_valuation_pair_unsupported");
    const bound = boundSourceAmount(request);
    cachedBooksPromise ??= Promise.all([
      readCoinbaseBook(fetchImpl, COINBASE_USDT_USDC_DEPTH_URL, "USDT-USDC"),
      ...(sourceAsset === "USD"
        ? [readCoinbaseBook(fetchImpl, COINBASE_USDT_USD_DEPTH_URL, "USDT-USD")]
        : []),
    ]);
    const books = await cachedBooksPromise;
    if (books.some((book) => book.observed_at_ms > checkedAtMs + 5_000
      || checkedAtMs - book.observed_at_ms > 5_000)) fail("cashflow_valuation_book_stale");
    const observedAtMs = Math.min(...books.map((book) => book.observed_at_ms));
    const magnitude = bound.amount_micro === null ? null : BigInt(Math.abs(bound.amount_micro));
    const rates = sourceAsset === "USDT"
      ? coinbaseUsdtValuationRates(magnitude, books[0])
      : coinbaseUsdValuationRates(magnitude, books[0], books[1]);
    const boundValueMicroUsdc = bound.amount_micro === null
      ? null
      : coinbaseBoundValueMicroUsdc(sourceAsset, bound.amount_micro, books);
    const evidenceSource = sourceAsset === "USDT"
      ? "coinbase-exchange:USDT-USDC:book:v1"
      : "coinbase-exchange:USDT-USD:USDT-USDC:cross-book:v1";
    const valuation = {
      version: 1,
      source_asset: sourceAsset,
      valuation_asset: "USDC",
      verified: true,
      ...(bound.amount_micro === null ? {} : { bound_source_amount_micro: bound.amount_micro }),
      ...(boundValueMicroUsdc === null ? {} : { bound_value_micro_usdc: boundValueMicroUsdc }),
      credit_rate_e8: safeNumber(rates.credit_rate_e8, "cashflow_valuation_credit_rate_invalid"),
      debit_rate_e8: safeNumber(rates.debit_rate_e8, "cashflow_valuation_debit_rate_invalid"),
      observed_at_ms: observedAtMs,
      expires_at_ms: observedAtMs + 30_000,
      evidence_source: evidenceSource,
    };
    const evidenceMessage = cashflowValuationEvidenceMessage(valuation);
    const evidencePayload = {
      venue_id: "coinbase_exchange",
      markets: books.map((book) => book.market),
      source_observed_at_ms: Object.fromEntries(books.map((book) => [book.market, book.observed_at_ms])),
      ...(bound.amount_micro === null ? {} : {
        source_amount_micro: bound.amount_micro,
        source_amount_decimal: bound.amount_decimal,
        source_amount_scale: bound.amount_scale,
      }),
      books: books.map(({ market, sequence, observed_at_ms, provider_book_time_ms, bids, asks }) => ({
        market,
        sequence,
        observed_at_ms,
        provider_book_time_ms,
        bids,
        asks,
      })),
    };
    return normalizeCashflowValuation({
      ...valuation,
      evidence_message: evidenceMessage,
      evidence_payload: evidencePayload,
      evidence_commitment: valuationCommitment(evidenceMessage, evidencePayload),
    });
  };
}

function verifyBoundEvidencePayload(valuation, payload) {
  const amount = valuation.bound_source_amount_micro;
  if (amount === null) {
    if (payload.source_amount_micro !== undefined
      || payload.source_amount_decimal !== undefined
      || payload.source_amount_scale !== undefined) {
      fail("cashflow_valuation_evidence_amount_unbound");
    }
    return;
  }
  const decimal = canonicalSourceDecimal(payload.source_amount_decimal);
  const scale = decimal.split(".")[1]?.length || 0;
  if (payload.source_amount_micro !== amount || payload.source_amount_scale !== scale) {
    fail("cashflow_valuation_evidence_amount_mismatch");
  }
  if ((amount < 0) !== decimal.startsWith("-")) fail("cashflow_valuation_evidence_amount_sign_mismatch");
}

function coinbaseEvidenceBooks(payload, markets) {
  if (payload.venue_id !== "coinbase_exchange"
    || !Array.isArray(payload.markets)
    || payload.markets.length !== markets.length
    || payload.markets.some((market, index) => market !== markets[index])
    || !Array.isArray(payload.books)
    || payload.books.length !== markets.length
    || !payload.source_observed_at_ms
    || typeof payload.source_observed_at_ms !== "object"
    || Array.isArray(payload.source_observed_at_ms)) {
    fail("cashflow_valuation_evidence_binding_invalid");
  }
  return payload.books.map((book, index) => {
    const observedAtMs = positiveInteger(book?.observed_at_ms, "cashflow_valuation_evidence_time_invalid");
    if (payload.source_observed_at_ms[markets[index]] !== observedAtMs) {
      fail("cashflow_valuation_evidence_time_invalid");
    }
    return evidenceBook(book, markets[index], observedAtMs);
  });
}

function evidenceBook(value, market, observedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.market !== undefined && value.market !== market)
    || (value.observed_at_ms !== undefined && value.observed_at_ms !== observedAtMs)) {
    fail("cashflow_valuation_evidence_book_invalid");
  }
  const bids = evidenceBookLevels(value.bids, "bid");
  const asks = evidenceBookLevels(value.asks, "ask");
  if (bids[0].price_e8 > asks[0].price_e8) fail("cashflow_valuation_book_crossed");
  return Object.freeze({ market, observed_at_ms: observedAtMs, bids, asks });
}

function evidenceBookLevels(value, side) {
  if (!Array.isArray(value) || value.length === 0) fail("cashflow_valuation_evidence_book_invalid");
  const levels = value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !Number.isSafeInteger(row.price_e8) || row.price_e8 <= 0
      || !Number.isSafeInteger(row.size_micro) || row.size_micro <= 0) {
      fail("cashflow_valuation_evidence_book_invalid");
    }
    return Object.freeze({ price_e8: row.price_e8, size_micro: row.size_micro });
  });
  for (let index = 1; index < levels.length; index += 1) {
    if ((side === "bid" && levels[index - 1].price_e8 < levels[index].price_e8)
      || (side === "ask" && levels[index - 1].price_e8 > levels[index].price_e8)) {
      fail("cashflow_valuation_evidence_book_order_invalid");
    }
  }
  return Object.freeze(levels);
}

function resolvePolicy(value, context) {
  return typeof value === "function" ? value(Object.freeze(context)) : value;
}

function conversionPolicy(value, checkedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || value.venue_id !== "aster"
    || value.market !== "USDCUSDT"
    || value.verified !== true
    || value.read_only !== true
    || value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false) {
    fail("carry_conversion_policy_invalid");
  }
  const observedAtMs = positiveInteger(value.observed_at_ms, "carry_conversion_policy_time_invalid");
  const expiresAtMs = positiveInteger(value.expires_at_ms, "carry_conversion_policy_expiry_invalid");
  if (observedAtMs > checkedAtMs + 5_000 || expiresAtMs <= checkedAtMs
    || expiresAtMs - observedAtMs > 86_400_000) {
    fail("carry_conversion_policy_stale");
  }
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_conversion_policy_minimum_invalid");
  const maximum = positiveInteger(value.maximum_transfer_micro_usdc, "carry_conversion_policy_maximum_invalid");
  if (maximum < minimum) fail("carry_conversion_policy_capacity_invalid");
  return Object.freeze({
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_ceiling_bps: boundedInteger(value.fee_ceiling_bps, 0, 1_000, "carry_conversion_policy_fee_invalid"),
    max_slippage_bps: boundedInteger(value.max_slippage_bps, 0, 1_000, "carry_conversion_policy_slippage_invalid"),
    latency_ceiling_ms: boundedInteger(value.latency_ceiling_ms, 0, 300_000, "carry_conversion_policy_latency_invalid"),
  });
}

function conversionLevels(rows, direction) {
  if (!Array.isArray(rows) || rows.length === 0) fail("carry_conversion_depth_invalid");
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length < 2) fail("carry_conversion_depth_invalid");
    const priceE8 = decimalToScaled(
      row[0],
      8,
      "carry_conversion_price_invalid",
      direction === "buy_base" ? "ceil" : "floor",
    );
    const baseMicro = decimalToScaled(row[1], 6, "carry_conversion_quantity_invalid");
    if (priceE8 <= 0n || baseMicro <= 0n) fail("carry_conversion_depth_invalid");
    return direction === "sell_base"
      ? Object.freeze({ rate_e8: priceE8, input_micro_usdc: baseMicro })
      : Object.freeze({
          rate_e8: RATE_SCALE * RATE_SCALE / priceE8,
          input_micro_usdc: ceilingDivide(baseMicro * priceE8, RATE_SCALE),
        });
  });
}

function bestBookPriceE8(rows, side) {
  if (!Array.isArray(rows) || rows.length === 0) fail("cashflow_valuation_depth_invalid");
  const prices = rows.map((row) => {
    if (!Array.isArray(row) || row.length < 2) fail("cashflow_valuation_depth_invalid");
    const price = decimalToScaled(
      row[0],
      8,
      "cashflow_valuation_price_invalid",
      side === "ask" ? "ceil" : "floor",
    );
    const quantity = decimalToScaled(row[1], 6, "cashflow_valuation_quantity_invalid");
    if (price <= 0n || quantity <= 0n) fail("cashflow_valuation_depth_invalid");
    return price;
  });
  return side === "bid"
    ? prices.reduce((best, value) => value > best ? value : best)
    : prices.reduce((best, value) => value < best ? value : best);
}

function normalizedBookLevels(rows, side) {
  if (!Array.isArray(rows) || rows.length === 0) fail("cashflow_valuation_depth_invalid");
  const levels = rows.map((row) => {
    if (!Array.isArray(row) || row.length < 2) fail("cashflow_valuation_depth_invalid");
    const priceE8 = decimalToScaled(
      row[0],
      8,
      "cashflow_valuation_price_invalid",
      side === "ask" ? "ceil" : "floor",
    );
    const sizeMicro = decimalToScaled(row[1], 6, "cashflow_valuation_quantity_invalid", "floor");
    if (priceE8 <= 0n || sizeMicro <= 0n) fail("cashflow_valuation_depth_invalid");
    return Object.freeze({
      price_e8: safeNumber(priceE8, "cashflow_valuation_price_invalid"),
      size_micro: safeNumber(sizeMicro, "cashflow_valuation_quantity_invalid"),
    });
  }).sort((left, right) => side === "bid"
    ? right.price_e8 - left.price_e8
    : left.price_e8 - right.price_e8);
  return Object.freeze(levels);
}

function boundSourceAmount(request) {
  const amountMicro = request?.source_amount_micro === undefined
    ? null
    : signedSafeInteger(request.source_amount_micro, "cashflow_valuation_source_amount_invalid");
  if (amountMicro === 0) fail("cashflow_valuation_source_amount_invalid");
  const amountDecimal = amountMicro === null
    ? null
    : canonicalSourceDecimal(request?.source_amount_decimal);
  const amountScale = amountDecimal === null ? null : amountDecimal.split(".")[1]?.length || 0;
  if (amountMicro !== null && request?.source_amount_scale !== amountScale) {
    fail("cashflow_valuation_source_scale_invalid");
  }
  return Object.freeze({ amount_micro: amountMicro, amount_decimal: amountDecimal, amount_scale: amountScale });
}

async function readCoinbaseBook(fetchImpl, url, market) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response?.ok) fail("cashflow_valuation_book_unavailable");
  const body = await response.json();
  const observedAtMs = coinbaseBookTime(response, body);
  const providerBookTimeMs = Date.parse(String(body?.time || ""));
  const bids = normalizedBookLevels(body?.bids, "bid");
  const asks = normalizedBookLevels(body?.asks, "ask");
  if (bids[0].price_e8 > asks[0].price_e8) fail("cashflow_valuation_book_crossed");
  return Object.freeze({
    market,
    sequence: String(body?.sequence ?? ""),
    observed_at_ms: observedAtMs,
    provider_book_time_ms: Number.isSafeInteger(providerBookTimeMs) && providerBookTimeMs > 0
      ? providerBookTimeMs
      : null,
    bids,
    asks,
  });
}

function coinbaseBookTime(response, body) {
  const servedAtMs = Date.parse(String(response.headers?.get?.("date") || ""));
  const ageSeconds = Number.parseInt(String(response.headers?.get?.("age") ?? "0"), 10);
  const observedAtMs = servedAtMs - ageSeconds * 1_000;
  if (Number.isSafeInteger(servedAtMs)
    && Number.isSafeInteger(ageSeconds)
    && ageSeconds >= 0
    && Number.isSafeInteger(observedAtMs)
    && observedAtMs > 0) return observedAtMs;
  const payloadTime = Date.parse(String(body?.time || ""));
  if (Number.isSafeInteger(payloadTime) && payloadTime > 0) return payloadTime;
  fail("cashflow_valuation_book_time_invalid");
}

function coinbaseUsdtValuationRates(sourceMagnitudeMicro, usdtUsdcBook) {
  if (sourceMagnitudeMicro === null) {
    return {
      credit_rate_e8: BigInt(usdtUsdcBook.bids[0].price_e8),
      debit_rate_e8: BigInt(usdtUsdcBook.asks[0].price_e8),
    };
  }
  const creditMicroUsdc = sellBaseForQuote(sourceMagnitudeMicro, usdtUsdcBook.bids);
  const debitMicroUsdc = quoteRequiredForBase(sourceMagnitudeMicro, usdtUsdcBook.asks);
  return {
    credit_rate_e8: creditMicroUsdc * RATE_SCALE / sourceMagnitudeMicro,
    debit_rate_e8: ceilingDivide(debitMicroUsdc * RATE_SCALE, sourceMagnitudeMicro),
  };
}

function coinbaseUsdValuationRates(sourceMagnitudeMicro, usdtUsdcBook, usdtUsdBook) {
  if (sourceMagnitudeMicro === null) {
    return {
      credit_rate_e8: BigInt(usdtUsdcBook.bids[0].price_e8) * RATE_SCALE
        / BigInt(usdtUsdBook.asks[0].price_e8),
      debit_rate_e8: ceilingDivide(
        BigInt(usdtUsdcBook.asks[0].price_e8) * RATE_SCALE,
        BigInt(usdtUsdBook.bids[0].price_e8),
      ),
    };
  }
  const creditUsdtMicro = buyBaseWithQuote(sourceMagnitudeMicro, usdtUsdBook.asks);
  const creditMicroUsdc = sellBaseForQuote(creditUsdtMicro, usdtUsdcBook.bids);
  const debitUsdtMicro = baseRequiredForQuote(sourceMagnitudeMicro, usdtUsdBook.bids);
  const debitMicroUsdc = quoteRequiredForBase(debitUsdtMicro, usdtUsdcBook.asks);
  return {
    credit_rate_e8: creditMicroUsdc * RATE_SCALE / sourceMagnitudeMicro,
    debit_rate_e8: ceilingDivide(debitMicroUsdc * RATE_SCALE, sourceMagnitudeMicro),
  };
}

function depthBoundValuationRates(sourceMagnitudeMicro, bidRows, askRows) {
  const usdcCreditMicro = buyBaseWithQuote(sourceMagnitudeMicro, askRows);
  const usdcDebitMicro = baseRequiredForQuote(sourceMagnitudeMicro, bidRows);
  return {
    credit_rate_e8: usdcCreditMicro * RATE_SCALE / sourceMagnitudeMicro,
    debit_rate_e8: ceilingDivide(usdcDebitMicro * RATE_SCALE, sourceMagnitudeMicro),
  };
}

function asterBoundValueMicroUsdc(sourceAmountMicro, bidRows, askRows) {
  const magnitude = BigInt(Math.abs(sourceAmountMicro));
  const value = sourceAmountMicro > 0
    ? buyBaseWithQuote(magnitude, askRows)
    : baseRequiredForQuote(magnitude, bidRows);
  return signedSafeNumber(sourceAmountMicro > 0 ? value : -value, "cashflow_valuation_bound_value_invalid");
}

function coinbaseBoundValueMicroUsdc(sourceAsset, sourceAmountMicro, books) {
  const magnitude = BigInt(Math.abs(sourceAmountMicro));
  let value;
  if (sourceAsset === "USDT") {
    value = sourceAmountMicro > 0
      ? sellBaseForQuote(magnitude, books[0].bids)
      : quoteRequiredForBase(magnitude, books[0].asks);
  } else if (sourceAsset === "USD") {
    if (sourceAmountMicro > 0) {
      const usdt = buyBaseWithQuote(magnitude, books[1].asks);
      value = sellBaseForQuote(usdt, books[0].bids);
    } else {
      const usdt = baseRequiredForQuote(magnitude, books[1].bids);
      value = quoteRequiredForBase(usdt, books[0].asks);
    }
  } else {
    fail("cashflow_valuation_pair_unsupported");
  }
  return signedSafeNumber(sourceAmountMicro > 0 ? value : -value, "cashflow_valuation_bound_value_invalid");
}

function buyBaseWithQuote(sourceQuoteMicro, rows) {
  let remainingQuote = sourceQuoteMicro;
  let outputBase = 0n;
  for (const row of rows) {
    if (remainingQuote === 0n) break;
    const price = BigInt(row.price_e8);
    const availableBase = BigInt(row.size_micro);
    const quoteCapacity = ceilingDivide(availableBase * price, RATE_SCALE);
    if (remainingQuote >= quoteCapacity) {
      outputBase += availableBase;
      remainingQuote -= quoteCapacity;
    } else {
      outputBase += remainingQuote * RATE_SCALE / price;
      remainingQuote = 0n;
    }
  }
  if (remainingQuote !== 0n || outputBase === 0n) fail("cashflow_valuation_depth_insufficient");
  return outputBase;
}

function baseRequiredForQuote(sourceQuoteMicro, rows) {
  let remainingQuote = sourceQuoteMicro;
  let requiredBase = 0n;
  for (const row of rows) {
    if (remainingQuote === 0n) break;
    const price = BigInt(row.price_e8);
    const availableBase = BigInt(row.size_micro);
    const quoteCapacity = availableBase * price / RATE_SCALE;
    if (remainingQuote > quoteCapacity) {
      requiredBase += availableBase;
      remainingQuote -= quoteCapacity;
    } else {
      requiredBase += ceilingDivide(remainingQuote * RATE_SCALE, price);
      remainingQuote = 0n;
    }
  }
  if (remainingQuote !== 0n || requiredBase === 0n) fail("cashflow_valuation_depth_insufficient");
  return requiredBase;
}

function sellBaseForQuote(sourceBaseMicro, rows) {
  let remainingBase = sourceBaseMicro;
  let outputQuote = 0n;
  for (const row of rows) {
    if (remainingBase === 0n) break;
    const price = BigInt(row.price_e8);
    const availableBase = BigInt(row.size_micro);
    const consumedBase = remainingBase < availableBase ? remainingBase : availableBase;
    outputQuote += consumedBase * price / RATE_SCALE;
    remainingBase -= consumedBase;
  }
  if (remainingBase !== 0n || outputQuote === 0n) fail("cashflow_valuation_depth_insufficient");
  return outputQuote;
}

function quoteRequiredForBase(sourceBaseMicro, rows) {
  let remainingBase = sourceBaseMicro;
  let requiredQuote = 0n;
  for (const row of rows) {
    if (remainingBase === 0n) break;
    const price = BigInt(row.price_e8);
    const availableBase = BigInt(row.size_micro);
    const consumedBase = remainingBase < availableBase ? remainingBase : availableBase;
    requiredQuote += ceilingDivide(consumedBase * price, RATE_SCALE);
    remainingBase -= consumedBase;
  }
  if (remainingBase !== 0n || requiredQuote === 0n) fail("cashflow_valuation_depth_insufficient");
  return requiredQuote;
}

async function readJsonBook(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response?.ok) fail("cashflow_valuation_book_unavailable");
  return response.json();
}

function canonicalSourceDecimal(value) {
  const text = String(value ?? "").trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail("cashflow_valuation_source_decimal_invalid");
  return text;
}

function signedSafeInteger(value, code) {
  if (!Number.isSafeInteger(value)) fail(code);
  return value;
}

function signedSafeNumber(value, code) {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
  return Number(value);
}

function valuationCommitment(evidenceMessage, evidencePayload) {
  return `carry:cashflow-valuation:evidence:${createHash("sha256")
    .update(canonicalCarryCommitmentJson({ evidence_message: evidenceMessage, evidence_payload: evidencePayload }))
    .digest("hex")}`;
}

function decimalToScaled(value, decimals, code, rounding = "floor") {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail(code);
  const [whole, fraction = ""] = text.split(".");
  const scale = 10n ** BigInt(decimals);
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  const base = BigInt(whole) * scale + BigInt(padded || "0");
  return rounding === "ceil" && fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))
    ? base + 1n
    : base;
}

function ceilingDivide(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function safeNumber(value, code) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
  return Number(value);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  const normalized = nonnegativeInteger(value, code);
  if (normalized < minimum || normalized > maximum) fail(code);
  return normalized;
}

function fail(code) {
  throw new Error(code);
}
