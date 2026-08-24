const ID = /^[A-Za-z0-9:_-]{8,180}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
import { SUPPORTED_EXECUTION_VENUES } from "./venues.js";

const VENUES = new Set(SUPPORTED_EXECUTION_VENUES);

export function normalizeVenueAccountingSnapshot(value) {
  const raw = object(value, "accounting_snapshot_required");
  exactVersion(raw.version, "accounting_snapshot_version");
  if (raw.custody_type === "pooled_platform_account") fail("pooled_custody_forbidden");
  const custodyType = enumValue(raw.custody_type, new Set(["turnkey_wallet", "user_exchange_account"]), "custody_type");
  const balances = array(raw.balances, "balances", 0, 200).map((item) => {
    const balance = object(item, "balance_invalid");
    return {
      asset: normalized(balance.asset, ASSET, "balance_asset"),
      value_micro_usdc: nonNegativeInteger(balance.value_micro_usdc, "balance_value"),
      available_value_micro_usdc: nonNegativeInteger(balance.available_value_micro_usdc, "balance_available_value"),
    };
  });
  uniqueBy(balances, (item) => item.asset, "duplicate_balance_asset");
  const positions = array(raw.positions, "positions", 0, 1_000).map((item) => {
    const position = object(item, "position_invalid");
    const productType = enumValue(position.product_type, new Set(["spot", "perp"]), "position_product_type");
    return {
      position_key: identifier(position.position_key, "position_key"),
      asset: normalized(position.asset, ASSET, "position_asset"),
      market: normalized(position.market, MARKET, "position_market"),
      product_type: productType,
      signed_notional_micro_usdc: integer(position.signed_notional_micro_usdc, "position_notional"),
      unrealized_pnl_micro_usdc: integer(position.unrealized_pnl_micro_usdc ?? 0, "position_unrealized_pnl"),
      leverage_x100: productType === "perp" ? boundedInteger(position.leverage_x100, 100, 10_000, "position_leverage") : 100,
      liquidation_distance_bps: productType === "perp"
        ? boundedInteger(position.liquidation_distance_bps, 0, 100_000, "position_liquidation_distance")
        : 100_000,
    };
  });
  uniqueBy(positions, (item) => item.position_key, "duplicate_position_key");
  const openOrders = array(raw.open_orders, "open_orders", 0, 5_000).map((item) => {
    const order = object(item, "open_order_invalid");
    return {
      order_commitment: identifier(order.order_commitment, "order_commitment"),
      asset: normalized(order.asset, ASSET, "order_asset"),
      market: normalized(order.market, MARKET, "order_market"),
      side: enumValue(order.side, new Set(["buy", "sell"]), "order_side"),
      remaining_notional_micro_usdc: nonNegativeInteger(order.remaining_notional_micro_usdc, "order_remaining_notional"),
      reduce_only: order.reduce_only === true,
    };
  });
  uniqueBy(openOrders, (item) => item.order_commitment, "duplicate_order_commitment");
  return deepFreeze({
    version: 1,
    snapshot_id: identifier(raw.snapshot_id, "snapshot_id"),
    venue_id: enumValue(raw.venue_id, VENUES, "snapshot_venue"),
    account_commitment: identifier(raw.account_commitment, "account_commitment"),
    custody_type: custodyType,
    as_of_ms: positiveInteger(raw.as_of_ms, "snapshot_as_of"),
    sequence: nonNegativeInteger(raw.sequence, "snapshot_sequence"),
    equity_micro_usdc: nonNegativeInteger(raw.equity_micro_usdc, "snapshot_equity"),
    collateral_micro_usdc: nonNegativeInteger(raw.collateral_micro_usdc, "snapshot_collateral"),
    fees_today_micro_usdc: nonNegativeInteger(raw.fees_today_micro_usdc ?? 0, "snapshot_fees"),
    funding_today_micro_usdc: integer(raw.funding_today_micro_usdc ?? 0, "snapshot_funding"),
    balances,
    positions,
    open_orders: openOrders,
  });
}

export function aggregatePortfolioAccounting({ snapshots: snapshotInputs, now_ms = Date.now(), max_age_ms }) {
  const snapshots = array(snapshotInputs, "snapshots", 1, 16).map(normalizeVenueAccountingSnapshot);
  uniqueBy(snapshots, (item) => item.venue_id, "duplicate_venue_snapshot");
  const maxAgeMs = boundedInteger(max_age_ms, 250, 300_000, "accounting_max_age");
  const staleVenues = snapshots
    .filter((snapshot) => snapshot.as_of_ms > now_ms || now_ms - snapshot.as_of_ms > maxAgeMs)
    .map((snapshot) => snapshot.venue_id);
  const exposure = {};
  let equity = 0;
  let collateral = 0;
  let gross = 0;
  let fees = 0;
  let funding = 0;
  let openOrders = 0;
  let minLiquidationDistance = 100_000;
  for (const snapshot of snapshots) {
    equity = safeAdd(equity, snapshot.equity_micro_usdc);
    collateral = safeAdd(collateral, snapshot.collateral_micro_usdc);
    fees = safeAdd(fees, snapshot.fees_today_micro_usdc);
    funding = safeAdd(funding, snapshot.funding_today_micro_usdc);
    openOrders = safeAdd(openOrders, snapshot.open_orders.length);
    for (const position of snapshot.positions) {
      gross = safeAdd(gross, Math.abs(position.signed_notional_micro_usdc));
      exposure[position.asset] = safeAdd(exposure[position.asset] || 0, position.signed_notional_micro_usdc);
      if (position.product_type === "perp") {
        minLiquidationDistance = Math.min(minLiquidationDistance, position.liquidation_distance_bps);
      }
    }
  }
  const net = Object.values(exposure).reduce((sum, value) => safeAdd(sum, Math.abs(value)), 0);
  return deepFreeze({
    version: 1,
    status: staleVenues.length === 0 ? "ready" : "stale",
    stale_venues: staleVenues,
    as_of_ms: Math.min(...snapshots.map((snapshot) => snapshot.as_of_ms)),
    venue_count: snapshots.length,
    equity_micro_usdc: equity,
    collateral_micro_usdc: collateral,
    gross_exposure_micro_usdc: gross,
    net_exposure_micro_usdc: net,
    signed_exposure_micro_usdc_by_asset: exposure,
    open_order_count: openOrders,
    fees_today_micro_usdc: fees,
    funding_today_micro_usdc: funding,
    minimum_liquidation_distance_bps: minLiquidationDistance,
    custody: snapshots.map((snapshot) => ({
      venue_id: snapshot.venue_id,
      custody_type: snapshot.custody_type,
      account_commitment: snapshot.account_commitment,
    })),
  });
}

export function reconcilePortfolioAccounting({ expected: expectedInputs, observed: observedInputs, now_ms = Date.now(), max_age_ms, tolerance_micro_usdc = 1 }) {
  const expected = array(expectedInputs, "expected_snapshots", 1, 16).map(normalizeVenueAccountingSnapshot);
  const observed = array(observedInputs, "observed_snapshots", 1, 16).map(normalizeVenueAccountingSnapshot);
  uniqueBy(expected, (item) => item.venue_id, "duplicate_expected_venue");
  uniqueBy(observed, (item) => item.venue_id, "duplicate_observed_venue");
  const maxAgeMs = boundedInteger(max_age_ms, 250, 300_000, "reconcile_max_age");
  const tolerance = nonNegativeInteger(tolerance_micro_usdc, "reconcile_tolerance");
  const expectedByVenue = new Map(expected.map((item) => [item.venue_id, item]));
  const observedByVenue = new Map(observed.map((item) => [item.venue_id, item]));
  const venueIds = [...new Set([...expectedByVenue.keys(), ...observedByVenue.keys()])].sort();
  const mismatches = [];
  const staleVenues = [];
  for (const venueId of venueIds) {
    const left = expectedByVenue.get(venueId);
    const right = observedByVenue.get(venueId);
    if (!left) {
      mismatches.push({ venue_id: venueId, kind: "unexpected_venue" });
      continue;
    }
    if (!right) {
      mismatches.push({ venue_id: venueId, kind: "missing_venue" });
      continue;
    }
    if (right.as_of_ms > now_ms || now_ms - right.as_of_ms > maxAgeMs) staleVenues.push(venueId);
    compareAmount(mismatches, venueId, "equity", left.equity_micro_usdc, right.equity_micro_usdc, tolerance);
    compareAmount(mismatches, venueId, "collateral", left.collateral_micro_usdc, right.collateral_micro_usdc, tolerance);
    compareKeyedAmounts({
      mismatches,
      venueId,
      kind: "balance",
      left: left.balances,
      right: right.balances,
      key: (item) => item.asset,
      amount: (item) => item.value_micro_usdc,
      tolerance,
    });
    compareKeyedAmounts({
      mismatches,
      venueId,
      kind: "position",
      left: left.positions,
      right: right.positions,
      key: (item) => item.position_key,
      amount: (item) => item.signed_notional_micro_usdc,
      tolerance,
    });
    compareSets(
      mismatches,
      venueId,
      "open_order",
      left.open_orders.map((item) => item.order_commitment),
      right.open_orders.map((item) => item.order_commitment),
    );
  }
  const status = staleVenues.length > 0 ? "stale" : mismatches.length > 0 ? "mismatch" : "reconciled";
  return deepFreeze({
    version: 1,
    status,
    reconciled: status === "reconciled",
    freeze_risk_increase: status !== "reconciled",
    allowed_actions: status === "reconciled" ? ["normal"] : ["reconcile", "cancel", "reduce_only"],
    stale_venues: staleVenues,
    mismatches,
    checked_at_ms: now_ms,
  });
}

export function buildExecutionQualityReceipt(value) {
  const raw = object(value, "execution_quality_required");
  exactVersion(raw.version, "execution_quality_version");
  const side = enumValue(raw.side, new Set(["buy", "sell"]), "execution_side");
  const targetNotional = positiveInteger(raw.target_notional_micro_usdc, "execution_target_notional");
  const benchmarkPrice = positiveInteger(raw.benchmark_price_e8, "execution_benchmark_price");
  const fills = array(raw.fills, "execution_fills", 0, 10_000).map((item) => {
    const fill = object(item, "execution_fill_invalid");
    return {
      fill_commitment: identifier(fill.fill_commitment, "fill_commitment"),
      notional_micro_usdc: positiveInteger(fill.notional_micro_usdc, "fill_notional"),
      price_e8: positiveInteger(fill.price_e8, "fill_price"),
      fee_micro_usdc: nonNegativeInteger(fill.fee_micro_usdc ?? 0, "fill_fee"),
      gas_micro_usdc: nonNegativeInteger(fill.gas_micro_usdc ?? 0, "fill_gas"),
      filled_at_ms: positiveInteger(fill.filled_at_ms, "fill_time"),
    };
  });
  uniqueBy(fills, (item) => item.fill_commitment, "duplicate_fill_commitment");
  const filledNotional = fills.reduce((sum, fill) => safeAdd(sum, fill.notional_micro_usdc), 0);
  if (filledNotional > targetNotional) fail("fill_exceeds_target");
  const weightedPrice = fills.reduce(
    (sum, fill) => sum + BigInt(fill.price_e8) * BigInt(fill.notional_micro_usdc),
    0n,
  );
  const averagePrice = filledNotional > 0 ? safeBigInt(weightedPrice / BigInt(filledNotional)) : null;
  const fees = fills.reduce((sum, fill) => safeAdd(sum, fill.fee_micro_usdc), 0);
  const gas = fills.reduce((sum, fill) => safeAdd(sum, fill.gas_micro_usdc), 0);
  const priceShortfallBps = averagePrice === null ? null : adversePriceBps(side, averagePrice, benchmarkPrice);
  const feeBps = filledNotional > 0 ? ratioBps(fees, filledNotional) : 0;
  const gasBps = filledNotional > 0 ? ratioBps(gas, filledNotional) : 0;
  const implementationShortfallBps = priceShortfallBps === null ? null : safeAdd(safeAdd(priceShortfallBps, feeBps), gasBps);
  const lastFillAt = fills.length > 0 ? Math.max(...fills.map((fill) => fill.filled_at_ms)) : null;
  const decisionAt = positiveInteger(raw.decision_at_ms, "execution_decision_time");
  return deepFreeze({
    version: 1,
    execution_id: identifier(raw.execution_id, "execution_id"),
    plan_commitment: identifier(raw.plan_commitment, "execution_plan_commitment"),
    venue_id: enumValue(raw.venue_id, VENUES, "execution_venue"),
    strategy_id: text(raw.strategy_id, "execution_strategy"),
    market: normalized(raw.market, MARKET, "execution_market"),
    side,
    benchmark_source: enumValue(raw.benchmark_source, new Set(["decision_mid", "arrival_mid", "route_quote"]), "benchmark_source"),
    target_notional_micro_usdc: targetNotional,
    filled_notional_micro_usdc: filledNotional,
    fill_rate_bps: ratioBps(filledNotional, targetNotional),
    rejected: raw.rejected === true,
    reject_code: raw.rejected === true ? text(raw.reject_code, "execution_reject_code") : null,
    benchmark_price_e8: benchmarkPrice,
    average_fill_price_e8: averagePrice,
    price_shortfall_bps: priceShortfallBps,
    fee_bps: feeBps,
    gas_bps: gasBps,
    implementation_shortfall_bps: implementationShortfallBps,
    fees_micro_usdc: fees,
    gas_micro_usdc: gas,
    decision_to_last_fill_ms: lastFillAt === null ? null : Math.max(0, lastFillAt - decisionAt),
    expected_cost_bps: boundedInteger(raw.expected_cost_bps, -10_000, 100_000, "expected_cost_bps"),
    cost_model_error_bps: implementationShortfallBps === null ? null : implementationShortfallBps - raw.expected_cost_bps,
    fills,
  });
}

export function aggregateExecutionQuality(receiptInputs) {
  const receipts = array(receiptInputs, "quality_receipts", 1, 100_000).map(buildExecutionQualityReceipt);
  uniqueBy(receipts, (item) => item.execution_id, "duplicate_execution_id");
  const target = receipts.reduce((sum, receipt) => safeAdd(sum, receipt.target_notional_micro_usdc), 0);
  const filled = receipts.reduce((sum, receipt) => safeAdd(sum, receipt.filled_notional_micro_usdc), 0);
  const measured = receipts.filter((receipt) => receipt.implementation_shortfall_bps !== null && receipt.filled_notional_micro_usdc > 0);
  const weightedShortfall = measured.reduce(
    (sum, receipt) => sum + BigInt(receipt.implementation_shortfall_bps) * BigInt(receipt.filled_notional_micro_usdc),
    0n,
  );
  const measuredNotional = measured.reduce((sum, receipt) => safeAdd(sum, receipt.filled_notional_micro_usdc), 0);
  const latencies = receipts.map((receipt) => receipt.decision_to_last_fill_ms).filter((value) => value !== null);
  return deepFreeze({
    version: 1,
    execution_count: receipts.length,
    rejection_count: receipts.filter((receipt) => receipt.rejected).length,
    reject_rate_bps: ratioBps(receipts.filter((receipt) => receipt.rejected).length, receipts.length),
    aggregate_fill_rate_bps: ratioBps(filled, target),
    weighted_implementation_shortfall_bps: measuredNotional > 0
      ? safeBigInt(divideConservative(weightedShortfall, BigInt(measuredNotional)))
      : null,
    average_decision_to_last_fill_ms: latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null,
    fees_micro_usdc: receipts.reduce((sum, receipt) => safeAdd(sum, receipt.fees_micro_usdc), 0),
    gas_micro_usdc: receipts.reduce((sum, receipt) => safeAdd(sum, receipt.gas_micro_usdc), 0),
  });
}

function compareAmount(mismatches, venueId, kind, expected, observed, tolerance) {
  const delta = observed - expected;
  if (Math.abs(delta) > tolerance) mismatches.push({ venue_id: venueId, kind, expected, observed, delta });
}

function compareKeyedAmounts({ mismatches, venueId, kind, left, right, key, amount, tolerance }) {
  const leftMap = new Map(left.map((item) => [key(item), amount(item)]));
  const rightMap = new Map(right.map((item) => [key(item), amount(item)]));
  for (const itemKey of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()) {
    if (!leftMap.has(itemKey)) mismatches.push({ venue_id: venueId, kind: `unexpected_${kind}`, key: itemKey });
    else if (!rightMap.has(itemKey)) mismatches.push({ venue_id: venueId, kind: `missing_${kind}`, key: itemKey });
    else compareAmount(mismatches, venueId, `${kind}:${itemKey}`, leftMap.get(itemKey), rightMap.get(itemKey), tolerance);
  }
}

function compareSets(mismatches, venueId, kind, left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  for (const key of [...leftSet].sort()) if (!rightSet.has(key)) mismatches.push({ venue_id: venueId, kind: `missing_${kind}`, key });
  for (const key of [...rightSet].sort()) if (!leftSet.has(key)) mismatches.push({ venue_id: venueId, kind: `unexpected_${kind}`, key });
}

function adversePriceBps(side, execution, benchmark) {
  const difference = side === "buy" ? execution - benchmark : benchmark - execution;
  return safeBigInt(divideConservative(BigInt(difference) * 10_000n, BigInt(benchmark)));
}

function ratioBps(numerator, denominator) {
  if (denominator <= 0) fail("ratio_denominator_invalid");
  return safeBigInt(divideConservative(BigInt(numerator) * 10_000n, BigInt(denominator)));
}

function divideConservative(numerator, denominator) {
  if (numerator >= 0n) return (numerator + denominator - 1n) / denominator;
  return numerator / denominator;
}

function uniqueBy(values, key, code) {
  if (new Set(values.map(key)).size !== values.length) fail(code);
}

function identifier(value, code) {
  const result = text(value, code);
  if (!ID.test(result)) fail(code);
  return result;
}

function normalized(value, pattern, code) {
  const result = text(value, code).toUpperCase();
  if (!pattern.test(result)) fail(code);
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function exactVersion(value, code) {
  if (value !== 1) fail(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function array(value, code, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value.trim();
}

function integer(value, code) {
  if (!Number.isSafeInteger(value)) fail(code);
  return value;
}

function positiveInteger(value, code) {
  const result = integer(value, code);
  if (result <= 0) fail(code);
  return result;
}

function nonNegativeInteger(value, code) {
  const result = integer(value, code);
  if (result < 0) fail(code);
  return result;
}

function boundedInteger(value, min, max, code) {
  const result = integer(value, code);
  if (result < min || result > max) fail(code);
  return result;
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("integer_overflow");
  return result;
}

function safeBigInt(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail("integer_overflow");
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
