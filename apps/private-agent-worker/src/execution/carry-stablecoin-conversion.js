import { createHash } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  cashflowValuationEvidenceMessage,
  normalizeCashflowValuation,
} from "@ghola/execution-core";

const ASTER_USDC_USDT_DEPTH_URL = "https://sapi.asterdex.com/api/v3/depth?symbol=USDCUSDT&limit=100";
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
    const evidenceSource = "aster:USDCUSDT:book:v1";
    const valuation = {
      version: 1,
      source_asset: "USDT",
      valuation_asset: "USDC",
      verified: true,
      ...(boundSourceAmountMicro === null ? {} : { bound_source_amount_micro: boundSourceAmountMicro }),
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
  return async function readCoinbaseUsdCashflowValuation(request) {
    const checkedAtMs = positiveInteger(request?.checked_at_ms, "cashflow_valuation_checked_at_invalid");
    const observedNowMs = positiveInteger(now(), "cashflow_valuation_now_invalid");
    if (Math.abs(observedNowMs - checkedAtMs) > 5_000) fail("cashflow_valuation_checked_at_stale");
    if (String(request?.source_asset || "") !== "USD") fail("cashflow_valuation_pair_unsupported");
    const response = await fetchImpl("https://api.exchange.coinbase.com/products/USDC-USD/book?level=2", {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response?.ok) fail("cashflow_valuation_book_unavailable");
    const observedAtMs = Date.parse(String(response.headers?.get?.("date") || ""));
    if (!Number.isSafeInteger(observedAtMs)
      || observedAtMs > checkedAtMs + 5_000
      || checkedAtMs - observedAtMs > 5_000) fail("cashflow_valuation_book_stale");
    const body = await response.json();
    const bids = normalizedBookLevels(body?.bids, "bid");
    const asks = normalizedBookLevels(body?.asks, "ask");
    if (bids[0].price_e8 > asks[0].price_e8) fail("cashflow_valuation_book_crossed");
    const valuation = {
      version: 1,
      source_asset: "USD",
      valuation_asset: "USDC",
      verified: true,
      credit_rate_e8: safeNumber(
        RATE_SCALE * RATE_SCALE / BigInt(asks[0].price_e8),
        "cashflow_valuation_credit_rate_invalid",
      ),
      debit_rate_e8: safeNumber(
        ceilingDivide(RATE_SCALE * RATE_SCALE, BigInt(bids[0].price_e8)),
        "cashflow_valuation_debit_rate_invalid",
      ),
      observed_at_ms: observedAtMs,
      expires_at_ms: observedAtMs + 30_000,
      evidence_source: "coinbase-exchange:USDC-USD:book:v1",
    };
    const evidenceMessage = cashflowValuationEvidenceMessage(valuation);
    const evidencePayload = {
      venue_id: "coinbase_exchange",
      market: "USDC-USD",
      sequence: String(body?.sequence ?? ""),
      observed_at_ms: observedAtMs,
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

function depthBoundValuationRates(sourceMagnitudeMicro, bidRows, askRows) {
  const usdcCreditMicro = buyBaseWithQuote(sourceMagnitudeMicro, askRows);
  const usdcDebitMicro = baseRequiredForQuote(sourceMagnitudeMicro, bidRows);
  return {
    credit_rate_e8: usdcCreditMicro * RATE_SCALE / sourceMagnitudeMicro,
    debit_rate_e8: ceilingDivide(usdcDebitMicro * RATE_SCALE, sourceMagnitudeMicro),
  };
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
