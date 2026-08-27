const ASTER_WITHDRAWAL_FEE_URL = "https://sapi.asterdex.com/api/v1/aster/withdraw/estimateFee?chainId=42161&asset=USDT";

export function createCarryTransferVenueReaders({
  read_account_capacity: readAccountCapacity,
  read_deposit_quote: readDepositQuote,
  read_lighter_withdrawal_quote: readLighterWithdrawalQuote,
  withdrawal_policies: withdrawalPolicies,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (typeof readAccountCapacity !== "function" || typeof readDepositQuote !== "function") {
    fail("carry_transfer_venue_reader_dependency_missing");
  }
  const deposit = (venueId) => async (request, probeContext) => {
    const quote = await readDepositQuote(Object.freeze({ ...request, venue_id: venueId }), probeContext);
    return quote;
  };
  return Object.freeze({
    hyperliquid: Object.freeze({
      read_withdrawal_quote: policyWithdrawalReader({
        venueId: "hyperliquid",
        asset: "USDC",
        readAccountCapacity,
        policy: withdrawalPolicySource(withdrawalPolicies, "hyperliquid"),
        now,
      }),
      read_deposit_quote: deposit("hyperliquid"),
    }),
    lighter: Object.freeze({
      read_withdrawal_quote: async (request, probeContext) => {
        if (typeof readLighterWithdrawalQuote !== "function") {
          fail("carry_transfer_lighter_withdrawal_reader_missing");
        }
        return readLighterWithdrawalQuote(request, probeContext);
      },
      read_deposit_quote: deposit("lighter"),
    }),
    aster: Object.freeze({
      read_withdrawal_quote: asterWithdrawalReader({
        readAccountCapacity,
        policy: withdrawalPolicySource(withdrawalPolicies, "aster"),
        fetchImpl,
        now,
      }),
      read_deposit_quote: deposit("aster"),
    }),
  });
}

function policyWithdrawalReader({ venueId, asset, readAccountCapacity, policy, now }) {
  return async (request, probeContext) => {
    const observedAtMs = now();
    const normalizedPolicy = withdrawalPolicy(resolvePolicy(policy, {
      venue_id: venueId,
      collateral_asset: asset,
      checked_at_ms: observedAtMs,
    }), venueId, asset, observedAtMs);
    const capacity = await accountCapacity(await readAccountCapacity(Object.freeze({
      ...request,
      venue_id: venueId,
      collateral_asset: asset,
    }), probeContext), request, venueId, asset, observedAtMs);
    return withdrawalComponent({
      venueId,
      asset,
      request,
      capacity,
      feeMicroUsdc: normalizedPolicy.fee_ceiling_micro_usdc,
      latencyMs: normalizedPolicy.latency_ceiling_ms,
      asOfMs: Math.min(capacity.as_of_ms, normalizedPolicy.observed_at_ms),
    });
  };
}

function asterWithdrawalReader({ readAccountCapacity, policy, fetchImpl, now }) {
  return async (request, probeContext) => {
    const observedAtMs = now();
    const normalizedPolicy = withdrawalPolicy(resolvePolicy(policy, {
      venue_id: "aster",
      collateral_asset: "USDT",
      checked_at_ms: observedAtMs,
    }), "aster", "USDT", observedAtMs);
    const [capacityValue, response] = await Promise.all([
      readAccountCapacity(Object.freeze({
        ...request,
        venue_id: "aster",
        collateral_asset: "USDT",
      }), probeContext),
      fetchImpl(ASTER_WITHDRAWAL_FEE_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    if (!response?.ok) fail("carry_transfer_aster_fee_unavailable");
    const body = await response.json();
    const liveFee = decimalToMicroCeiling(body?.gasUsdValue, "carry_transfer_aster_fee_invalid");
    if (liveFee > normalizedPolicy.fee_ceiling_micro_usdc) {
      fail("carry_transfer_aster_fee_above_policy");
    }
    const capacity = accountCapacity(capacityValue, request, "aster", "USDT", observedAtMs);
    return withdrawalComponent({
      venueId: "aster",
      asset: "USDT",
      request,
      capacity,
      feeMicroUsdc: normalizedPolicy.fee_ceiling_micro_usdc,
      latencyMs: normalizedPolicy.latency_ceiling_ms,
      asOfMs: Math.min(capacity.as_of_ms, observedAtMs),
    });
  };
}

function withdrawalPolicySource(policies, venueId) {
  return typeof policies === "function" ? policies : policies?.[venueId];
}

function resolvePolicy(value, context) {
  return typeof value === "function" ? value(Object.freeze(context)) : value;
}

function withdrawalPolicy(value, venueId, asset, nowMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || value.venue_id !== venueId
    || value.collateral_asset !== asset
    || value.verified !== true
    || value.read_only !== true
    || value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false) {
    fail("carry_transfer_withdrawal_policy_invalid");
  }
  const observedAtMs = positiveInteger(value.observed_at_ms, "carry_transfer_withdrawal_policy_time_invalid");
  const expiresAtMs = positiveInteger(value.expires_at_ms, "carry_transfer_withdrawal_policy_expiry_invalid");
  if (observedAtMs > nowMs + 5_000 || expiresAtMs <= nowMs || expiresAtMs - observedAtMs > 86_400_000) {
    fail("carry_transfer_withdrawal_policy_stale");
  }
  return Object.freeze({
    observed_at_ms: observedAtMs,
    fee_ceiling_micro_usdc: nonnegativeInteger(value.fee_ceiling_micro_usdc, "carry_transfer_withdrawal_policy_fee_invalid"),
    latency_ceiling_ms: boundedInteger(value.latency_ceiling_ms, 0, 7 * 86_400_000, "carry_transfer_withdrawal_policy_latency_invalid"),
  });
}

function accountCapacity(value, request, venueId, asset, nowMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.verified !== true
    || value.venue_id !== venueId
    || value.collateral_asset !== asset
    || value.account_state_commitment !== request.source_account_state_commitment
    || value.read_only !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false) {
    fail("carry_transfer_account_capacity_invalid");
  }
  const asOfMs = positiveInteger(value.as_of_ms, "carry_transfer_account_capacity_time_invalid");
  if (asOfMs > nowMs + 5_000 || nowMs - asOfMs > 30_000) fail("carry_transfer_account_capacity_stale");
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_transfer_account_capacity_minimum_invalid");
  const maximum = nonnegativeInteger(value.maximum_transfer_micro_usdc, "carry_transfer_account_capacity_maximum_invalid");
  if (maximum < minimum) fail("carry_transfer_account_capacity_range_invalid");
  return Object.freeze({
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    as_of_ms: asOfMs,
  });
}

function withdrawalComponent({ venueId, asset, request, capacity, feeMicroUsdc, latencyMs, asOfMs }) {
  return Object.freeze({
    kind: "withdrawal",
    status: "available",
    valuation_asset: "USD",
    venue_id: venueId,
    collateral_asset: asset,
    account_state_commitment: request.source_account_state_commitment,
    verified: true,
    capacity_bound_verified: true,
    fee_upper_bound_verified: true,
    latency_upper_bound_verified: true,
    read_only: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    minimum_transfer_micro_usdc: capacity.minimum_transfer_micro_usdc,
    maximum_transfer_micro_usdc: capacity.maximum_transfer_micro_usdc,
    fee_upper_bound_micro_usdc: feeMicroUsdc,
    latency_upper_bound_ms: latencyMs,
    as_of_ms: asOfMs,
  });
}

function decimalToMicroCeiling(value, code) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail(code);
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000000`;
  const base = BigInt(whole) * 1_000_000n + BigInt(padded.slice(0, 6));
  const rounded = fraction.length > 6 && /[1-9]/.test(fraction.slice(6)) ? base + 1n : base;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
  return Number(rounded);
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
