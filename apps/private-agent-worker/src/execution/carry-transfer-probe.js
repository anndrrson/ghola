const STATUSES = new Set(["available", "degraded"]);
const COMPONENT_KINDS = new Set(["withdrawal", "deposit", "conversion"]);
const MAX_LATENCY_MS = 7 * 86_400_000;

export function createCarryTransferRouteProbe({
  venue_route_readers: venueRouteReaders,
  read_conversion_quote: readConversionQuote,
}) {
  if (!venueRouteReaders || typeof venueRouteReaders !== "object" || Array.isArray(venueRouteReaders)) {
    fail("carry_transfer_probe_readers_invalid");
  }
  return async function probeCarryTransferRoute(request, probeContext) {
    const sourceReader = venueRouteReaders[request?.from_venue_id]?.read_withdrawal_quote;
    const destinationReader = venueRouteReaders[request?.to_venue_id]?.read_deposit_quote;
    if (typeof sourceReader !== "function" || typeof destinationReader !== "function") {
      fail("carry_transfer_probe_reader_unavailable");
    }
    const checkedAtMs = positiveInteger(request.checked_at_ms, "carry_transfer_probe_checked_at_invalid");
    const reads = [
      sourceReader(Object.freeze({ ...request, operation: "read_only_withdrawal_quote" }), probeContext),
      destinationReader(Object.freeze({ ...request, operation: "read_only_deposit_quote" }), probeContext),
    ];
    if (request.conversion_required) {
      if (typeof readConversionQuote !== "function") fail("carry_transfer_probe_conversion_reader_unavailable");
      reads.push(readConversionQuote(Object.freeze({ ...request, operation: "read_only_conversion_quote" }), probeContext));
    }
    const [rawWithdrawal, rawDeposit, rawConversion] = await Promise.all(reads);
    const withdrawal = component(rawWithdrawal, {
      kind: "withdrawal",
      venueId: request.from_venue_id,
      asset: request.source_collateral_asset,
      accountStateCommitment: request.source_account_state_commitment,
      checkedAtMs,
    });
    const deposit = component(rawDeposit, {
      kind: "deposit",
      venueId: request.to_venue_id,
      asset: request.destination_collateral_asset,
      accountStateCommitment: request.destination_account_state_commitment,
      checkedAtMs,
    });
    const conversion = request.conversion_required
      ? component(rawConversion, {
          kind: "conversion",
          sourceAsset: request.source_collateral_asset,
          destinationAsset: request.destination_collateral_asset,
          checkedAtMs,
        })
      : sameAssetConversion(request.source_collateral_asset, checkedAtMs);
    const minimum = Math.max(
      withdrawal.minimum_transfer_micro_usdc,
      deposit.minimum_transfer_micro_usdc,
      conversion.minimum_transfer_micro_usdc,
    );
    const maximum = Math.min(
      withdrawal.maximum_transfer_micro_usdc,
      deposit.maximum_transfer_micro_usdc,
      conversion.maximum_transfer_micro_usdc,
    );
    if (maximum < minimum || maximum === 0) fail("carry_transfer_probe_capacity_unavailable");
    const totalFee = safeAdd(
      safeAdd(withdrawal.fee_upper_bound_micro_usdc, deposit.fee_upper_bound_micro_usdc),
      safeAdd(conversion.fee_upper_bound_micro_usdc, conversion.slippage_upper_bound_micro_usdc),
    );
    return Object.freeze({
      valuation_asset: "USD",
      source_collateral_asset: request.source_collateral_asset,
      destination_collateral_asset: request.destination_collateral_asset,
      conversion_required: request.conversion_required,
      status: [withdrawal, deposit, conversion].some((item) => item.status === "degraded")
        ? "degraded"
        : "available",
      quote_verified: true,
      all_in_fee_verified: true,
      valuation_basis_verified: true,
      conversion_quote_verified: true,
      conversion_rate_e8: conversion.rate_floor_e8,
      minimum_transfer_micro_usdc: minimum,
      maximum_transfer_micro_usdc: maximum,
      withdrawal_fee_micro_usdc: withdrawal.fee_upper_bound_micro_usdc,
      deposit_fee_micro_usdc: deposit.fee_upper_bound_micro_usdc,
      conversion_fee_micro_usdc: conversion.fee_upper_bound_micro_usdc,
      conversion_slippage_micro_usdc: conversion.slippage_upper_bound_micro_usdc,
      fee_micro_usdc: totalFee,
      estimated_latency_ms: safeAdd(
        safeAdd(withdrawal.latency_upper_bound_ms, deposit.latency_upper_bound_ms),
        conversion.latency_upper_bound_ms,
        MAX_LATENCY_MS,
      ),
      as_of_ms: Math.min(withdrawal.as_of_ms, deposit.as_of_ms, conversion.as_of_ms),
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    });
  };
}

function component(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("carry_transfer_probe_component_invalid");
  if (!COMPONENT_KINDS.has(value.kind) || value.kind !== expected.kind || !STATUSES.has(value.status)) {
    fail("carry_transfer_probe_component_status_invalid");
  }
  if (value.valuation_asset !== "USD"
    || value.verified !== true
    || value.capacity_bound_verified !== true
    || value.fee_upper_bound_verified !== true
    || value.latency_upper_bound_verified !== true
    || value.read_only !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false) {
    fail("carry_transfer_probe_component_unverified");
  }
  if (expected.kind === "conversion") {
    if (value.source_asset !== expected.sourceAsset || value.destination_asset !== expected.destinationAsset) {
      fail("carry_transfer_probe_component_binding_invalid");
    }
  } else if (value.venue_id !== expected.venueId
    || value.collateral_asset !== expected.asset
    || value.account_state_commitment !== expected.accountStateCommitment) {
    fail("carry_transfer_probe_component_binding_invalid");
  }
  const asOfMs = positiveInteger(value.as_of_ms, "carry_transfer_probe_component_time_invalid");
  if (asOfMs > expected.checkedAtMs + 5_000 || expected.checkedAtMs - asOfMs > 300_000) {
    fail("carry_transfer_probe_component_time_invalid");
  }
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_transfer_probe_component_minimum_invalid");
  const maximum = nonnegativeInteger(value.maximum_transfer_micro_usdc, "carry_transfer_probe_component_maximum_invalid");
  if (maximum < minimum) fail("carry_transfer_probe_component_capacity_invalid");
  const rateFloor = expected.kind === "conversion"
    ? positiveInteger(value.rate_floor_e8, "carry_transfer_probe_conversion_rate_invalid")
    : 100_000_000;
  return Object.freeze({
    status: value.status,
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_upper_bound_micro_usdc: nonnegativeInteger(
      value.fee_upper_bound_micro_usdc,
      "carry_transfer_probe_component_fee_invalid",
    ),
    slippage_upper_bound_micro_usdc: expected.kind === "conversion"
      ? nonnegativeInteger(value.slippage_upper_bound_micro_usdc, "carry_transfer_probe_conversion_slippage_invalid")
      : 0,
    latency_upper_bound_ms: boundedInteger(
      value.latency_upper_bound_ms,
      0,
      MAX_LATENCY_MS,
      "carry_transfer_probe_component_latency_invalid",
    ),
    rate_floor_e8: rateFloor,
    as_of_ms: asOfMs,
  });
}

function sameAssetConversion(asset, checkedAtMs) {
  return Object.freeze({
    kind: "conversion",
    status: "available",
    source_asset: asset,
    destination_asset: asset,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: Number.MAX_SAFE_INTEGER,
    fee_upper_bound_micro_usdc: 0,
    slippage_upper_bound_micro_usdc: 0,
    latency_upper_bound_ms: 0,
    rate_floor_e8: 100_000_000,
    as_of_ms: checkedAtMs,
  });
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

function safeAdd(left, right, maximum = Number.MAX_SAFE_INTEGER) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > maximum) fail("carry_transfer_probe_numeric_overflow");
  return result;
}

function fail(code) {
  throw new Error(code);
}
