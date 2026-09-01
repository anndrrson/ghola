import { isCarryExecutionVenue, isExecutionVenue, venueAdapterCapability, venueSupportsProduct } from "./venues.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ID = /^[A-Za-z0-9:_-]{8,180}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
const ETH_ADDRESS = /^0x[0-9a-f]{40}$/;
const ETH_SIGNATURE = /^0x[0-9a-f]{130}$/;
const ETH_COMMITMENT = /^0x[0-9a-f]{64}$/;
const CARRY_OPPORTUNITY_EVIDENCE = /^carry:creation-opportunity:evidence:[0-9a-f]{64}$/;
const CURRENT_FUNDING_OBSERVATION = /^carry:funding:current:[0-9a-f]{64}$/;
const CASHFLOW_VALUATION_EVIDENCE = /^carry:cashflow-valuation:evidence:[0-9a-f]{64}$/;
const USD_STABLE_QUOTES = new Set(["USD", "USDC", "USDT"]);
const USDC_RATE_E8 = 100_000_000;
const MAX_CASHFLOW_VALUATION_LIFETIME_MS = 300_000;
const POSITION_STATUSES = new Set([
  "draft", "opening", "active", "rebalancing", "exiting", "reconciled", "frozen", "manual_intervention",
]);
const EVENT_TYPES = new Set([
  "preflight_passed", "entry_reconciled", "entry_failed_no_fill", "observation", "manual_exit_requested",
  "observation_unavailable", "mandate_invalid", "submission_ambiguous", "restart_detected", "recovery_failed", "reconciliation_complete", "exit_reconciled",
]);
const VALUE_ENTRY_TYPES = new Set([
  "funding", "trading_fee", "slippage", "gas", "capital_cost", "transfer_fee", "rebate", "settlement_adjustment",
]);
const DEBIT_ONLY_VALUE_ENTRY_TYPES = new Set([
  "trading_fee", "slippage", "gas", "capital_cost", "transfer_fee",
]);
const CREDIT_ONLY_VALUE_ENTRY_TYPES = new Set(["rebate"]);

export class CarryModelError extends Error {
  constructor(code) {
    super(code);
    this.name = "CarryModelError";
    this.code = code;
  }
}

export function canonicalCarryCommitmentJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCarryCommitmentJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalCarryCommitmentJson(child)}`)
    .join(",")}}`;
}

export function carryPrivatePrimeWorkerAuthenticationMessage({
  route_path,
  owner_commitment,
  asset,
  operation_class,
  work_order_commitment,
  evidence_commitment,
  checked_at_ms,
  expires_at_ms,
} = {}) {
  return canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-carry-private-prime-worker-authentication-v1",
    route_path,
    owner_commitment,
    asset,
    operation_class,
    work_order_commitment,
    evidence_commitment,
    checked_at_ms,
    expires_at_ms,
  });
}

export function carryCreationOpportunityAuthenticationMessage({
  owner_commitment,
  opportunity,
  checked_at_ms,
  expires_at_ms,
} = {}) {
  return canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-carry-creation-opportunity-authentication-v1",
    owner_commitment,
    opportunity,
    checked_at_ms,
    expires_at_ms,
  });
}

export function carryPortfolioValueAuthenticationMessage({
  route_path,
  owner_commitment,
  owner_capital_budget_micro_usdc,
  max_data_age_ms,
  minimum_transfer_arrival_buffer_ms,
  report_commitment,
  checked_at_ms,
  expires_at_ms,
} = {}) {
  return canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-carry-portfolio-value-authentication-v1",
    route_path,
    owner_commitment,
    owner_capital_budget_micro_usdc,
    max_data_age_ms,
    minimum_transfer_arrival_buffer_ms,
    report_commitment,
    checked_at_ms,
    expires_at_ms,
  });
}

export function carryReleaseMaterialAuthenticationMessage({
  route_path,
  owner_commitment,
  position_id,
  material_commitment,
  checked_at_ms,
  expires_at_ms,
} = {}) {
  return canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-carry-release-material-authentication-v1",
    route_path,
    owner_commitment,
    position_id,
    material_commitment,
    checked_at_ms,
    expires_at_ms,
  });
}

export function estimatePerpDepthExecution({
  side,
  depth_levels: depthLevels,
  fallback_price_e8: fallbackPriceE8 = null,
  target_notional_micro_usdc: targetNotionalMicroUsdc,
  phase = "entry",
} = {}) {
  const fallback = Number.isSafeInteger(fallbackPriceE8) && fallbackPriceE8 > 0 ? fallbackPriceE8 : null;
  if ((side !== "buy" && side !== "sell") ||
      !Number.isSafeInteger(targetNotionalMicroUsdc) || targetNotionalMicroUsdc <= 0 ||
      !Array.isArray(depthLevels) || depthLevels.length === 0) {
    return deepFreeze({
      phase,
      side,
      status: "unavailable",
      target_notional_micro_usdc: targetNotionalMicroUsdc,
      displayed_notional_micro_usdc: 0,
      execution_price_e8: fallback,
    });
  }
  const targetQuoteE16 = BigInt(targetNotionalMicroUsdc) * 10_000_000_000n;
  let remainingQuoteE16 = targetQuoteE16;
  let displayedQuoteE16 = 0n;
  let filledBaseE8 = 0n;
  let quotePriceBaseE16 = 0n;
  const sortedLevels = [...depthLevels].sort((left, right) => side === "buy"
    ? Number(left?.price_e8 || 0) - Number(right?.price_e8 || 0)
    : Number(right?.price_e8 || 0) - Number(left?.price_e8 || 0));
  for (const level of sortedLevels) {
    if (!Number.isSafeInteger(level?.price_e8) || level.price_e8 <= 0 ||
        !Number.isSafeInteger(level?.size_e8) || level.size_e8 <= 0) continue;
    const availableBaseE8 = BigInt(level.size_e8);
    const availableQuoteE16 = BigInt(level.price_e8) * availableBaseE8;
    displayedQuoteE16 += availableQuoteE16;
    if (remainingQuoteE16 <= 0n) continue;
    const takenQuoteE16 = availableQuoteE16 < remainingQuoteE16 ? availableQuoteE16 : remainingQuoteE16;
    const takenBaseE8 = takenQuoteE16 === availableQuoteE16
      ? availableBaseE8
      : (takenQuoteE16 + BigInt(level.price_e8) - 1n) / BigInt(level.price_e8);
    filledBaseE8 += takenBaseE8;
    quotePriceBaseE16 += BigInt(level.price_e8) * takenBaseE8;
    remainingQuoteE16 -= takenQuoteE16;
  }
  const executionPriceE8 = filledBaseE8 > 0n
    ? Number(side === "buy"
      ? (quotePriceBaseE16 + filledBaseE8 - 1n) / filledBaseE8
      : quotePriceBaseE16 / filledBaseE8)
    : fallback;
  const displayedNotional = Number(displayedQuoteE16 / 10_000_000_000n);
  return deepFreeze({
    phase,
    side,
    status: remainingQuoteE16 === 0n ? "sufficient" : "insufficient",
    target_notional_micro_usdc: targetNotionalMicroUsdc,
    displayed_notional_micro_usdc: Number.isSafeInteger(displayedNotional) ? displayedNotional : Number.MAX_SAFE_INTEGER,
    execution_price_e8: Number.isSafeInteger(executionPriceE8) ? executionPriceE8 : fallback,
  });
}

export function adverseExecutionSlippageE6Bps({ side, mark_price_e8: markPriceE8, execution_price_e8: executionPriceE8 } = {}) {
  if ((side !== "buy" && side !== "sell") ||
      !Number.isSafeInteger(markPriceE8) || markPriceE8 <= 0 ||
      !Number.isSafeInteger(executionPriceE8) || executionPriceE8 <= 0) {
    return 5_000_000;
  }
  const adverseMove = side === "buy"
    ? executionPriceE8 - markPriceE8
    : markPriceE8 - executionPriceE8;
  if (adverseMove <= 0) return 0;
  const numerator = BigInt(adverseMove) * 10_000_000_000n;
  return Number((numerator + BigInt(markPriceE8) - 1n) / BigInt(markPriceE8));
}

export function cashflowValuationEvidenceMessage({
  source_asset,
  valuation_asset,
  bound_source_amount_micro,
  bound_value_micro_usdc,
  credit_rate_e8,
  debit_rate_e8,
  observed_at_ms,
  expires_at_ms,
  evidence_source,
} = {}) {
  return canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-cashflow-valuation-evidence-v1",
    source_asset,
    valuation_asset,
    bound_source_amount_micro,
    bound_value_micro_usdc,
    credit_rate_e8,
    debit_rate_e8,
    observed_at_ms,
    expires_at_ms,
    evidence_source,
  });
}

export function normalizeCashflowValuation(value) {
  const raw = object(value, "cashflow_valuation_required");
  exactVersion(raw.version, "cashflow_valuation_version");
  const sourceAsset = enumValue(
    normalized(raw.source_asset, ASSET, "cashflow_valuation_source_asset"),
    USD_STABLE_QUOTES,
    "cashflow_valuation_source_asset",
  );
  if (raw.valuation_asset !== "USDC" || raw.verified !== true) {
    fail("cashflow_valuation_unverified");
  }
  const creditRateE8 = boundedInteger(
    raw.credit_rate_e8,
    1,
    1_000_000_000,
    "cashflow_valuation_credit_rate",
  );
  const debitRateE8 = boundedInteger(
    raw.debit_rate_e8,
    1,
    1_000_000_000,
    "cashflow_valuation_debit_rate",
  );
  if (creditRateE8 > debitRateE8) fail("cashflow_valuation_spread_invalid");
  const observedAtMs = positiveInteger(raw.observed_at_ms, "cashflow_valuation_observed_at");
  const expiresAtMs = positiveInteger(raw.expires_at_ms, "cashflow_valuation_expires_at");
  if (expiresAtMs <= observedAtMs
    || expiresAtMs - observedAtMs > MAX_CASHFLOW_VALUATION_LIFETIME_MS) {
    fail("cashflow_valuation_lifetime_invalid");
  }
  if (sourceAsset === "USDC"
    && (creditRateE8 !== USDC_RATE_E8 || debitRateE8 !== USDC_RATE_E8)) {
    fail("cashflow_valuation_identity_invalid");
  }
  const boundSourceAmountMicro = raw.bound_source_amount_micro == null
    ? null
    : signedInteger(raw.bound_source_amount_micro, "cashflow_valuation_bound_source_amount");
  if (boundSourceAmountMicro === 0) fail("cashflow_valuation_bound_source_amount");
  const boundValueMicroUsdc = raw.bound_value_micro_usdc == null
    ? null
    : signedInteger(raw.bound_value_micro_usdc, "cashflow_valuation_bound_value");
  if ((boundSourceAmountMicro === null) !== (boundValueMicroUsdc === null)
    || boundValueMicroUsdc === 0
    || (boundSourceAmountMicro !== null && (boundSourceAmountMicro < 0) !== (boundValueMicroUsdc < 0))) {
    fail("cashflow_valuation_bound_value");
  }
  const evidenceSource = identifier(raw.evidence_source, "cashflow_valuation_evidence_source");
  const evidenceMessage = cashflowValuationEvidenceMessage({
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    bound_source_amount_micro: boundSourceAmountMicro ?? undefined,
    bound_value_micro_usdc: boundValueMicroUsdc ?? undefined,
    credit_rate_e8: creditRateE8,
    debit_rate_e8: debitRateE8,
    observed_at_ms: observedAtMs,
    expires_at_ms: expiresAtMs,
    evidence_source: evidenceSource,
  });
  if (raw.evidence_message !== evidenceMessage) fail("cashflow_valuation_evidence_message");
  const evidenceCommitment = typeof raw.evidence_commitment === "string"
    && CASHFLOW_VALUATION_EVIDENCE.test(raw.evidence_commitment)
    ? raw.evidence_commitment
    : fail("cashflow_valuation_evidence_commitment");
  const evidencePayload = raw.evidence_payload == null
    ? null
    : object(raw.evidence_payload, "cashflow_valuation_evidence_payload");
  return deepFreeze({
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    conversion_required: sourceAsset !== "USDC",
    bound_source_amount_micro: boundSourceAmountMicro,
    bound_value_micro_usdc: boundValueMicroUsdc,
    credit_rate_e8: creditRateE8,
    debit_rate_e8: debitRateE8,
    observed_at_ms: observedAtMs,
    expires_at_ms: expiresAtMs,
    evidence_source: evidenceSource,
    evidence_message: evidenceMessage,
    evidence_commitment: evidenceCommitment,
    evidence_payload: evidencePayload,
  });
}

export function convertSignedCashflowToMicroUsdc({ amount_micro: amountMicro, valuation } = {}) {
  const amount = signedInteger(amountMicro, "cashflow_amount_invalid");
  const normalizedValuation = normalizeCashflowValuation(valuation);
  if (amount === 0) return 0;
  if (normalizedValuation.bound_source_amount_micro !== null) {
    if (amount !== normalizedValuation.bound_source_amount_micro) {
      fail("cashflow_valuation_bound_amount_mismatch");
    }
    return normalizedValuation.bound_value_micro_usdc;
  }
  const magnitude = BigInt(Math.abs(amount));
  const rateE8 = BigInt(amount > 0
    ? normalizedValuation.credit_rate_e8
    : normalizedValuation.debit_rate_e8);
  const converted = amount > 0
    ? magnitude * rateE8 / BigInt(USDC_RATE_E8)
    : ceilDiv(magnitude * rateE8, BigInt(USDC_RATE_E8));
  const result = safeNumber(converted);
  return amount > 0 ? result : -result;
}

export function normalizePerpContractSpec(value) {
  const raw = object(value, "contract_required");
  exactVersion(raw.version, "contract_version");
  const venueId = venue(raw.venue_id, "contract_venue");
  if (!venueSupportsProduct(venueId, "perp")) fail("contract_venue_not_perp");
  const declared = venueAdapterCapability(venueId, "perp_shadow");
  const asOfMs = positiveInteger(raw.as_of_ms, "contract_as_of");
  const quoteAsset = enumValue(
    normalized(raw.quote_asset, ASSET, "contract_quote_asset"),
    USD_STABLE_QUOTES,
    "contract_quote_asset_unsupported",
  );
  const collateralAsset = enumValue(
    normalized(raw.collateral_asset, ASSET, "contract_collateral_asset"),
    USD_STABLE_QUOTES,
    "contract_collateral_asset_unsupported",
  );
  const fundingSettlementAsset = enumValue(
    normalized(raw.funding_settlement_asset, ASSET, "contract_funding_settlement_asset"),
    USD_STABLE_QUOTES,
    "contract_funding_settlement_asset_unsupported",
  );
  const feeSettlementAsset = enumValue(
    normalized(raw.fee_settlement_asset, ASSET, "contract_fee_settlement_asset"),
    USD_STABLE_QUOTES,
    "contract_fee_settlement_asset_unsupported",
  );
  const assetValuations = normalizeContractAssetValuations(
    raw.asset_valuations,
    new Set([quoteAsset, fundingSettlementAsset, feeSettlementAsset]),
    asOfMs,
  );
  const initialMarginBps = boundedInteger(raw.initial_margin_bps, 1, 10_000, "contract_initial_margin");
  const maintenanceMarginBps = boundedInteger(raw.maintenance_margin_bps, 0, 9_999, "contract_maintenance_margin");
  if (initialMarginBps <= maintenanceMarginBps) fail("contract_margin_model_invalid");
  const marginModel = identifier(raw.margin_model, "contract_margin_model");
  const liquidationModel = identifier(raw.liquidation_model, "contract_liquidation_model");
  if (marginModel !== declared?.margin_model || liquidationModel !== declared?.liquidation_model) {
    fail("contract_risk_model_mismatch");
  }
  return deepFreeze({
    version: 1,
    venue_id: venueId,
    contract_id: identifier(raw.contract_id, "contract_id"),
    economic_equivalence_id: identifier(raw.economic_equivalence_id, "economic_equivalence_id"),
    asset: normalized(raw.asset, ASSET, "contract_asset"),
    market: normalized(raw.market, MARKET, "contract_market"),
    quote_asset: quoteAsset,
    collateral_asset: collateralAsset,
    funding_settlement_asset: fundingSettlementAsset,
    fee_settlement_asset: feeSettlementAsset,
    valuation_asset: "USDC",
    asset_valuations: assetValuations,
    contract_type: enumValue(raw.contract_type, new Set(["linear_perp", "inverse_perp"]), "contract_type"),
    mark_price_e8: positiveInteger(raw.mark_price_e8, "contract_mark_price"),
    index_price_e8: positiveInteger(raw.index_price_e8, "contract_index_price"),
    funding_rate_bps_per_interval: boundedInteger(raw.funding_rate_bps_per_interval, -10_000, 10_000, "contract_funding_rate"),
    funding_rate_e12_per_interval: raw.funding_rate_e12_per_interval === undefined
      ? raw.funding_rate_bps_per_interval * 100_000_000
      : boundedInteger(raw.funding_rate_e12_per_interval, -1_000_000_000_000, 1_000_000_000_000, "contract_funding_rate_e12"),
    funding_interval_ms: boundedInteger(raw.funding_interval_ms, 60_000, DAY_MS, "contract_funding_interval"),
    maker_fee_bps: boundedInteger(raw.maker_fee_bps, -1_000, 10_000, "contract_maker_fee"),
    taker_fee_bps: boundedInteger(raw.taker_fee_bps, 0, 10_000, "contract_taker_fee"),
    maker_fee_e6_bps: raw.maker_fee_e6_bps === undefined
      ? raw.maker_fee_bps * 1_000_000
      : boundedInteger(raw.maker_fee_e6_bps, -1_000_000_000, 10_000_000_000, "contract_maker_fee_e6"),
    taker_fee_e6_bps: raw.taker_fee_e6_bps === undefined
      ? raw.taker_fee_bps * 1_000_000
      : boundedInteger(raw.taker_fee_e6_bps, 0, 10_000_000_000, "contract_taker_fee_e6"),
    initial_margin_bps: initialMarginBps,
    maintenance_margin_bps: maintenanceMarginBps,
    liquidation_fee_bps: boundedInteger(raw.liquidation_fee_bps, 0, 10_000, "contract_liquidation_fee"),
    margin_model: marginModel,
    liquidation_model: liquidationModel,
    minimum_notional_micro_usdc: positiveInteger(raw.minimum_notional_micro_usdc, "contract_minimum_notional"),
    quantity_step_e8: positiveInteger(raw.quantity_step_e8, "contract_quantity_step"),
    price_tick_e8: positiveInteger(raw.price_tick_e8, "contract_price_tick"),
    as_of_ms: asOfMs,
  });
}

export function calculateMarginRunway(value) {
  const raw = object(value, "margin_runway_required");
  exactVersion(raw.version, "margin_runway_version");
  const venueId = venue(raw.venue_id, "margin_runway_venue");
  if (!venueSupportsProduct(venueId, "perp")) fail("margin_runway_venue_not_perp");
  const equity = nonNegativeInteger(raw.equity_micro_usdc, "margin_equity");
  const maintenance = nonNegativeInteger(raw.maintenance_margin_micro_usdc, "maintenance_margin");
  const safetyBuffer = nonNegativeInteger(raw.safety_buffer_micro_usdc, "margin_safety_buffer");
  const notional = positiveInteger(raw.position_notional_micro_usdc, "margin_position_notional");
  const stressBpsPerHour = boundedInteger(raw.stress_loss_bps_per_hour, 0, 10_000, "stress_loss_bps_per_hour");
  const fundingDebitBps = boundedInteger(raw.funding_debit_bps_per_interval, 0, 10_000, "funding_debit_bps_per_interval");
  const fundingInterval = boundedInteger(raw.funding_interval_ms, 60_000, DAY_MS, "margin_funding_interval");
  const transferLatency = nonNegativeInteger(raw.owner_transfer_latency_ms, "owner_transfer_latency");
  const responseBuffer = nonNegativeInteger(raw.owner_response_buffer_ms, "owner_response_buffer");
  const positionOpen = raw.position_open !== false;
  const liquidationDistance = raw.liquidation_distance_bps === null
    ? null
    : boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "liquidation_distance");
  const liquidationDistanceVerified = raw.liquidation_distance_verified === true;
  const liquidationDistanceSource = raw.liquidation_distance_source === null
    ? null
    : identifier(raw.liquidation_distance_source, "liquidation_distance_source");
  const verifiedLiquidationEvidence = liquidationDistanceVerified && liquidationDistanceSource !== null;
  const minimumLiquidationDistance = boundedInteger(raw.minimum_liquidation_distance_bps, 0, 100_000, "minimum_liquidation_distance");
  const headroom = Math.max(0, equity - maintenance - safetyBuffer);
  const stressLossPerHour = microFromBpsCeil(notional, stressBpsPerHour);
  const fundingDebitPerHour = safeNumber(ceilDiv(
    BigInt(microFromBpsCeil(notional, fundingDebitBps)) * BigInt(HOUR_MS),
    BigInt(fundingInterval),
  ));
  const burnPerHour = safeAdd(stressLossPerHour, fundingDebitPerHour, "margin_burn_overflow");
  const runwayMs = burnPerHour === 0
    ? null
    : safeNumber((BigInt(headroom) * BigInt(HOUR_MS)) / BigInt(burnPerHour));
  const requiredResponseMs = safeAdd(transferLatency, responseBuffer, "margin_response_overflow");
  let status = "healthy";
  if (headroom === 0
    || (positionOpen && (!verifiedLiquidationEvidence
      || liquidationDistance === null
      || liquidationDistance < minimumLiquidationDistance))) status = "breached";
  else if (runwayMs !== null && runwayMs <= requiredResponseMs) status = "critical";
  else if (runwayMs !== null && runwayMs <= requiredResponseMs * 2) status = "warning";
  return deepFreeze({
    version: 1,
    venue_id: venueId,
    as_of_ms: positiveInteger(raw.as_of_ms, "margin_as_of"),
    status,
    equity_micro_usdc: equity,
    maintenance_margin_micro_usdc: maintenance,
    safety_buffer_micro_usdc: safetyBuffer,
    margin_headroom_micro_usdc: headroom,
    stress_burn_micro_usdc_per_hour: burnPerHour,
    runway_ms: runwayMs,
    required_owner_response_ms: requiredResponseMs,
    position_open: positionOpen,
    liquidation_distance_bps: liquidationDistance,
    minimum_liquidation_distance_bps: minimumLiquidationDistance,
    liquidation_distance_verified: positionOpen && verifiedLiquidationEvidence,
    liquidation_distance_source: liquidationDistanceSource,
    owner_action_required: status === "critical" || status === "breached",
    automatic_transfer_permitted: false,
  });
}

export function compileCarryCapitalActionPlan(value) {
  const raw = object(value, "carry_capital_plan_required");
  exactVersion(raw.version, "carry_capital_plan_version");
  const nowMs = positiveInteger(raw.now_ms, "carry_capital_plan_now");
  const position = object(raw.position, "carry_capital_plan_position_required");
  const positionStatus = enumValue(position.status, POSITION_STATUSES, "carry_capital_plan_position_status");
  if (!new Set(["active", "rebalancing"]).has(positionStatus)) fail("carry_capital_plan_position_not_monitored");
  const positionId = identifier(position.position_id, "carry_capital_plan_position_id");
  const asset = normalized(position.asset, ASSET, "carry_capital_plan_asset");
  const longVenue = carryExecutionVenue(position.long_venue_id, "carry_capital_plan_long_venue");
  const shortVenue = carryExecutionVenue(position.short_venue_id, "carry_capital_plan_short_venue");
  if (longVenue === shortVenue) fail("carry_capital_plan_distinct_venues");
  const targetNotional = positiveInteger(position.target_notional_micro_usdc, "carry_capital_plan_notional");
  const authorization = normalizeCarryRiskMandateAuthorization(position.mandate_authorization);
  const signed = authorization.signed_mandate;
  const mandate = normalizeCarryRiskMandate(position.risk_mandate);
  if (signed.position_id !== positionId
    || signed.asset !== asset
    || signed.long_venue_id !== longVenue
    || signed.short_venue_id !== shortVenue
    || signed.target_notional_micro_usdc !== targetNotional
    || JSON.stringify(signed.risk_mandate) !== JSON.stringify(mandate)) {
    fail("carry_capital_plan_mandate_position_mismatch");
  }
  const evidence = array(raw.margin_runways, "carry_capital_plan_runways", 2, 2)
    .map(normalizeCapitalRunwayEvidence);
  const byVenue = new Map(evidence.map((item) => [item.venue_id, item]));
  if (byVenue.size !== 2 || !byVenue.has(longVenue) || !byVenue.has(shortVenue)) {
    fail("carry_capital_plan_runway_pair_mismatch");
  }
  const expired = signed.expires_at_ms <= nowMs;
  const reasons = expired ? ["risk_mandate_expired"] : [];
  const legs = [longVenue, shortVenue].map((venueId) => {
    const runway = byVenue.get(venueId);
    const stale = runway.as_of_ms > nowMs + 5_000 || nowMs - runway.as_of_ms > mandate.max_data_age_ms;
    const unsafe = runway.status === "critical"
      || runway.status === "breached"
      || (runway.runway_ms !== null && runway.runway_ms < mandate.min_margin_runway_ms);
    const warningBoundaryMs = safeAdd(
      safeNumber(BigInt(runway.required_owner_response_ms) * 2n),
      1,
      "carry_capital_target_runway_overflow",
    );
    const targetRunwayMs = Math.max(mandate.min_margin_runway_ms, warningBoundaryMs);
    const targetHeadroom = runway.stress_burn_micro_usdc_per_hour === 0
      ? runway.margin_headroom_micro_usdc
      : safeNumber(ceilDiv(
        BigInt(runway.stress_burn_micro_usdc_per_hour) * BigInt(targetRunwayMs),
        BigInt(HOUR_MS),
      ));
    const releasable = !expired && !stale && !unsafe && runway.status === "healthy"
      ? Math.max(0, runway.margin_headroom_micro_usdc - targetHeadroom)
      : 0;
    const base = {
      venue_id: venueId,
      account_commitment: runway.account_commitment,
      account_state_commitment: runway.account_state_commitment,
      status: runway.status,
      runway_ms: runway.runway_ms,
      target_runway_ms: targetRunwayMs,
      current_headroom_micro_usdc: runway.margin_headroom_micro_usdc,
      target_headroom_micro_usdc: targetHeadroom,
      stress_burn_micro_usdc_per_hour: runway.stress_burn_micro_usdc_per_hour,
      position_open: runway.position_open,
      liquidation_distance_bps: runway.liquidation_distance_bps,
      minimum_liquidation_distance_bps: runway.minimum_liquidation_distance_bps,
      liquidation_distance_verified: runway.liquidation_distance_verified,
      liquidation_distance_source: runway.liquidation_distance_source,
      potential_releasable_collateral_micro_usdc: releasable,
      owner_release_permitted: releasable > 0,
    };
    if (stale) reasons.push(`margin_data_stale:${venueId}`);
    if (!stale && unsafe) reasons.push(`margin_runway_unsafe:${venueId}`);
    if (expired) {
      return Object.freeze({
        ...base,
        potential_releasable_collateral_micro_usdc: 0,
        owner_release_permitted: false,
        minimum_additional_collateral_micro_usdc: 0,
        recommended_action: "reduce_only_exit",
        owner_funding_permitted: false,
      });
    }
    if (stale) {
      return Object.freeze({
        ...base,
        potential_releasable_collateral_micro_usdc: 0,
        owner_release_permitted: false,
        minimum_additional_collateral_micro_usdc: 0,
        recommended_action: "reconcile_only",
        owner_funding_permitted: false,
      });
    }
    if (unsafe) {
      return Object.freeze({
        ...base,
        potential_releasable_collateral_micro_usdc: 0,
        owner_release_permitted: false,
        minimum_additional_collateral_micro_usdc: 0,
        recommended_action: "reduce_only_exit",
        owner_funding_permitted: false,
      });
    }
    if (runway.status !== "warning") {
      return Object.freeze({
        ...base,
        minimum_additional_collateral_micro_usdc: 0,
        recommended_action: "none",
        owner_funding_permitted: false,
      });
    }
    const additional = Math.max(0, targetHeadroom - runway.margin_headroom_micro_usdc);
    return Object.freeze({
      ...base,
      minimum_additional_collateral_micro_usdc: additional,
      recommended_action: additional > 0 ? "owner_fund_venue" : "owner_review_required",
      owner_funding_permitted: true,
    });
  });
  const reduceOnlyExitRequired = legs.some((leg) => leg.recommended_action === "reduce_only_exit");
  const reconciliationRequired = !reduceOnlyExitRequired
    && legs.some((leg) => leg.recommended_action === "reconcile_only");
  const ownerFundingRequired = !reconciliationRequired && !reduceOnlyExitRequired
    && legs.some((leg) => leg.recommended_action === "owner_fund_venue"
      || leg.recommended_action === "owner_review_required");
  const minimumAdditionalCollateral = legs.reduce(
    (total, leg) => safeAdd(total, leg.minimum_additional_collateral_micro_usdc, "carry_capital_additional_overflow"),
    0,
  );
  const potentialReleasableCollateral = legs.reduce(
    (total, leg) => safeAdd(total, leg.potential_releasable_collateral_micro_usdc, "carry_capital_releasable_overflow"),
    0,
  );
  return deepFreeze({
    version: 1,
    kind: "ghola_carry_capital_action_plan",
    position_id: positionId,
    asset,
    status: reconciliationRequired ? "quarantined" : reduceOnlyExitRequired ? "exit_required" : ownerFundingRequired ? "owner_action_required" : "balanced",
    recommended_action: reconciliationRequired ? "reconcile_only" : reduceOnlyExitRequired ? "reduce_only_exit" : ownerFundingRequired ? "owner_collateral_review" : "none",
    reasons: [...new Set(reasons)],
    legs,
    minimum_additional_collateral_micro_usdc: reconciliationRequired || reduceOnlyExitRequired ? 0 : minimumAdditionalCollateral,
    potential_releasable_collateral_micro_usdc: reconciliationRequired || reduceOnlyExitRequired ? 0 : potentialReleasableCollateral,
    capital_optimization_available: !reconciliationRequired && !reduceOnlyExitRequired && potentialReleasableCollateral > 0,
    owner_funding_required: ownerFundingRequired,
    reduce_only_exit_required: reduceOnlyExitRequired,
    reconciliation_required: reconciliationRequired,
    proposal_only: true,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    owner_only_operations: ["fund", "transfer", "withdraw"],
    checked_at_ms: nowMs,
  });
}

export function compileCarryPortfolioCapitalPlan(value) {
  const raw = object(value, "carry_portfolio_capital_plan_required");
  exactVersion(raw.version, "carry_portfolio_capital_plan_version");
  const nowMs = positiveInteger(raw.now_ms, "carry_portfolio_capital_plan_now");
  const maxDataAgeMs = boundedInteger(
    raw.max_data_age_ms,
    250,
    300_000,
    "carry_portfolio_capital_plan_max_data_age",
  );
  const ownerCapitalBudget = nonNegativeInteger(
    raw.owner_capital_budget_micro_usdc,
    "carry_portfolio_capital_plan_owner_budget",
  );
  const minimumTransferArrivalBufferMs = boundedInteger(
    raw.minimum_transfer_arrival_buffer_ms ?? 300_000,
    0,
    DAY_MS,
    "carry_portfolio_capital_plan_transfer_arrival_buffer",
  );
  const transferRoutes = array(
    raw.transfer_routes ?? [],
    "carry_portfolio_capital_plan_transfer_routes",
    0,
    1_000,
  ).map(normalizeCarryTransferRouteEvidence);
  if (new Set(transferRoutes.map((route) => route.route_id)).size !== transferRoutes.length) {
    fail("carry_portfolio_capital_plan_duplicate_transfer_route");
  }
  const positionPlans = array(
    raw.position_plans,
    "carry_portfolio_capital_plan_positions",
    0,
    1_000,
  ).map(normalizePortfolioCapitalPositionPlan);
  if (new Set(positionPlans.map((plan) => plan.position_id)).size !== positionPlans.length) {
    fail("carry_portfolio_capital_plan_duplicate_position");
  }

  const stalePositionIds = positionPlans
    .filter((plan) => plan.checked_at_ms > nowMs + 5_000 || nowMs - plan.checked_at_ms > maxDataAgeMs)
    .map((plan) => plan.position_id);
  const allocationPermitted = stalePositionIds.length === 0;
  const accountGroups = new Map();
  for (const plan of positionPlans) {
    for (const leg of plan.legs) {
      const existing = accountGroups.get(leg.account_commitment);
      if (existing && existing.venue_id !== leg.venue_id) {
        fail("carry_portfolio_capital_account_venue_mismatch");
      }
      const group = existing || {
        account_commitment: leg.account_commitment,
        venue_id: leg.venue_id,
        account_state_commitment: leg.account_state_commitment,
        account_state_checked_at_ms: plan.checked_at_ms,
        entries: [],
      };
      if (existing
        && plan.checked_at_ms === group.account_state_checked_at_ms
        && leg.account_state_commitment !== group.account_state_commitment) {
        fail("carry_portfolio_capital_account_state_ambiguous");
      }
      if (plan.checked_at_ms > group.account_state_checked_at_ms) {
        group.account_state_commitment = leg.account_state_commitment;
        group.account_state_checked_at_ms = plan.checked_at_ms;
      }
      group.entries.push({ position_id: plan.position_id, plan, leg });
      accountGroups.set(leg.account_commitment, group);
    }
  }
  const accounts = [...accountGroups.values()].map((group) => {
    const positionIds = [...new Set(group.entries.map((entry) => entry.position_id))].sort();
    const blocked = group.entries.some((entry) => entry.plan.reconciliation_required
      || entry.plan.reduce_only_exit_required
      || ["reconcile_only", "reduce_only_exit"].includes(entry.leg.recommended_action));
    const currentHeadroom = group.entries.length === 0
      ? 0
      : Math.min(...group.entries.map((entry) => entry.leg.current_headroom_micro_usdc));
    const stressBurn = group.entries.reduce(
      (sum, entry) => safeAdd(sum, entry.leg.stress_burn_micro_usdc_per_hour, "carry_portfolio_capital_account_burn_overflow"),
      0,
    );
    const targetRunway = Math.max(0, ...group.entries.map((entry) => entry.leg.target_runway_ms));
    const targetHeadroom = stressBurn === 0
      ? currentHeadroom
      : safeNumber(ceilDiv(BigInt(stressBurn) * BigInt(targetRunway), BigInt(HOUR_MS)));
    const runwayMs = stressBurn === 0
      ? null
      : safeNumber((BigInt(currentHeadroom) * BigInt(HOUR_MS)) / BigInt(stressBurn));
    const runwayEvidenceAsOfMs = Math.min(...group.entries.map((entry) => entry.plan.checked_at_ms));
    const runwayDeadlineAtMs = runwayMs === null
      ? null
      : safeAdd(runwayEvidenceAsOfMs, runwayMs, "carry_portfolio_capital_runway_deadline_overflow");
    return Object.freeze({
      account_commitment: group.account_commitment,
      account_state_commitment: group.account_state_commitment,
      venue_id: group.venue_id,
      position_ids: Object.freeze(positionIds),
      position_count: positionIds.length,
      current_headroom_micro_usdc: currentHeadroom,
      aggregate_stress_burn_micro_usdc_per_hour: stressBurn,
      aggregate_runway_ms: runwayMs,
      runway_evidence_as_of_ms: runwayEvidenceAsOfMs,
      aggregate_runway_deadline_at_ms: runwayDeadlineAtMs,
      target_runway_ms: targetRunway,
      target_headroom_micro_usdc: targetHeadroom,
      requested_micro_usdc: allocationPermitted && !blocked ? Math.max(0, targetHeadroom - currentHeadroom) : 0,
      potential_releasable_micro_usdc: allocationPermitted && !blocked ? Math.max(0, currentHeadroom - targetHeadroom) : 0,
      risk_action_required: blocked,
    });
  }).sort((left, right) => left.venue_id.localeCompare(right.venue_id)
    || left.account_commitment.localeCompare(right.account_commitment));
  const requests = accounts.filter((account) => account.requested_micro_usdc > 0)
    .sort((left, right) => {
      const leftRunway = left.aggregate_runway_ms === null ? Number.MAX_SAFE_INTEGER : left.aggregate_runway_ms;
      const rightRunway = right.aggregate_runway_ms === null ? Number.MAX_SAFE_INTEGER : right.aggregate_runway_ms;
      return leftRunway - rightRunway
        || left.venue_id.localeCompare(right.venue_id)
        || left.account_commitment.localeCompare(right.account_commitment);
    });
  const releaseCandidates = accounts.filter((account) => account.potential_releasable_micro_usdc > 0)
    .map((account) => ({ ...account, remaining_micro_usdc: account.potential_releasable_micro_usdc }))
    .sort((left, right) => right.remaining_micro_usdc - left.remaining_micro_usdc
      || left.venue_id.localeCompare(right.venue_id)
      || left.account_commitment.localeCompare(right.account_commitment));
  const remainingByAccount = new Map(requests.map((request) => [request.account_commitment, request.requested_micro_usdc]));
  const remainingRouteCapacity = new Map(transferRoutes.map((route) => [route.route_id, route.maximum_transfer_micro_usdc]));
  const proposedReallocations = [];
  const transferRouteFailures = [];
  if (allocationPermitted) {
    for (const request of requests) {
      for (const source of releaseCandidates) {
        const needed = remainingByAccount.get(request.account_commitment) || 0;
        if (needed === 0) break;
        if (source.account_commitment === request.account_commitment || source.remaining_micro_usdc === 0) continue;
        const candidateRoutes = transferRoutes
          .filter((route) => route.from_account_commitment === source.account_commitment
            && route.from_venue_id === source.venue_id
            && route.source_account_state_commitment === source.account_state_commitment
            && route.to_account_commitment === request.account_commitment
            && route.to_venue_id === request.venue_id
            && route.destination_account_state_commitment === request.account_state_commitment)
          .sort((left, right) => left.estimated_latency_ms - right.estimated_latency_ms
            || left.fee_micro_usdc - right.fee_micro_usdc
            || left.route_id.localeCompare(right.route_id));
        if (candidateRoutes.length === 0) {
          transferRouteFailures.push(`transfer_route_missing:${source.account_commitment}:${request.account_commitment}`);
          continue;
        }
        let allocated = false;
        for (const route of candidateRoutes) {
          const currentNeed = remainingByAccount.get(request.account_commitment) || 0;
          if (currentNeed === 0) break;
          const stale = route.as_of_ms > nowMs + 5_000 || nowMs - route.as_of_ms > maxDataAgeMs;
          const expectedArrivalAtMs = safeAdd(
            nowMs,
            route.estimated_latency_ms,
            "carry_portfolio_capital_transfer_arrival_overflow",
          );
          const arrivalTooLate = request.aggregate_runway_deadline_at_ms !== null
            && safeAdd(
              expectedArrivalAtMs,
              minimumTransferArrivalBufferMs,
              "carry_portfolio_capital_transfer_arrival_overflow",
            ) >= request.aggregate_runway_deadline_at_ms;
          const routeCapacity = remainingRouteCapacity.get(route.route_id) || 0;
          if (route.status !== "available") {
            transferRouteFailures.push(`transfer_route_unavailable:${route.route_id}`);
            continue;
          }
          if (stale) {
            transferRouteFailures.push(`transfer_route_stale:${route.route_id}`);
            continue;
          }
          if (arrivalTooLate) {
            transferRouteFailures.push(`transfer_route_arrival_unsafe:${route.route_id}`);
            continue;
          }
          const maximumNet = Math.min(
            currentNeed,
            Math.max(0, source.remaining_micro_usdc - route.fee_micro_usdc),
            Math.max(0, routeCapacity - route.fee_micro_usdc),
          );
          const grossDebit = maximumNet + route.fee_micro_usdc;
          if (maximumNet <= 0 || grossDebit < route.minimum_transfer_micro_usdc) {
            transferRouteFailures.push(`transfer_route_capacity_insufficient:${route.route_id}`);
            continue;
          }
          source.remaining_micro_usdc -= grossDebit;
          remainingRouteCapacity.set(route.route_id, routeCapacity - grossDebit);
          remainingByAccount.set(request.account_commitment, currentNeed - maximumNet);
          proposedReallocations.push(Object.freeze({
            priority_rank: proposedReallocations.length + 1,
            route_id: route.route_id,
            route_evidence_as_of_ms: route.as_of_ms,
            route_evidence_commitment: route.evidence_commitment,
            route_evidence_checked_at_ms: route.evidence_checked_at_ms,
            route_evidence_source: route.evidence_source,
            route_observer_image_digest: route.worker_image_digest,
            from_account_commitment: source.account_commitment,
            from_venue_id: source.venue_id,
            to_account_commitment: request.account_commitment,
            to_venue_id: request.venue_id,
            source_adapter_id: route.source_adapter_id,
            destination_adapter_id: route.destination_adapter_id,
            source_account_state_commitment: route.source_account_state_commitment,
            destination_account_state_commitment: route.destination_account_state_commitment,
            route_quote_commitment: route.quote_commitment,
            valuation_asset: route.valuation_asset,
            source_collateral_asset: route.source_collateral_asset,
            destination_collateral_asset: route.destination_collateral_asset,
            conversion_required: route.conversion_required,
            conversion_quote_verified: route.conversion_quote_verified,
            conversion_rate_e8: route.conversion_rate_e8,
            amount_micro_usdc: maximumNet,
            gross_debit_micro_usdc: grossDebit,
            withdrawal_fee_micro_usdc: route.withdrawal_fee_micro_usdc,
            deposit_fee_micro_usdc: route.deposit_fee_micro_usdc,
            conversion_fee_micro_usdc: route.conversion_fee_micro_usdc,
            conversion_slippage_micro_usdc: route.conversion_slippage_micro_usdc,
            fee_micro_usdc: route.fee_micro_usdc,
            estimated_latency_ms: route.estimated_latency_ms,
            expected_arrival_at_ms: expectedArrivalAtMs,
            destination_runway_deadline_at_ms: request.aggregate_runway_deadline_at_ms,
            destination_runway_at_arrival_ms: request.aggregate_runway_deadline_at_ms === null
              ? null
              : request.aggregate_runway_deadline_at_ms - expectedArrivalAtMs,
            minimum_arrival_buffer_ms: minimumTransferArrivalBufferMs,
            route_verified: true,
            owner_transfer_approval_required: true,
            automatic_transfer_permitted: false,
            transaction_broadcast: false,
          }));
          allocated = true;
          if ((remainingByAccount.get(request.account_commitment) || 0) === 0) break;
        }
        if (!allocated && candidateRoutes.length > 0) continue;
      }
    }
  }
  let remainingBudget = allocationPermitted ? ownerCapitalBudget : 0;
  const allocations = requests.map((request, index) => {
    const remainingRequest = remainingByAccount.get(request.account_commitment) || 0;
    const proposed = Math.min(remainingBudget, remainingRequest);
    remainingBudget -= proposed;
    return Object.freeze({
      priority_rank: index + 1,
      account_commitment: request.account_commitment,
      venue_id: request.venue_id,
      position_ids: request.position_ids,
      aggregate_runway_ms: request.aggregate_runway_ms,
      requested_micro_usdc: request.requested_micro_usdc,
      proposed_internal_reallocation_micro_usdc: request.requested_micro_usdc - remainingRequest,
      proposed_allocation_micro_usdc: proposed,
      uncovered_shortfall_micro_usdc: remainingRequest - proposed,
      owner_approval_required: proposed > 0,
      transaction_broadcast: false,
    });
  });
  const totalRequested = requests.reduce(
    (sum, request) => safeAdd(sum, request.requested_micro_usdc, "carry_portfolio_capital_requested_overflow"),
    0,
  );
  const totalPotentialReleasable = accounts.reduce(
    (sum, account) => safeAdd(sum, account.potential_releasable_micro_usdc, "carry_portfolio_capital_releasable_overflow"),
    0,
  );
  const totalInternalReallocation = proposedReallocations.reduce(
    (sum, proposal) => safeAdd(sum, proposal.amount_micro_usdc, "carry_portfolio_capital_reallocation_overflow"),
    0,
  );
  const totalInternalReallocationFees = proposedReallocations.reduce(
    (sum, proposal) => safeAdd(sum, proposal.fee_micro_usdc, "carry_portfolio_capital_reallocation_fee_overflow"),
    0,
  );
  const totalProposed = allocations.reduce(
    (sum, allocation) => safeAdd(sum, allocation.proposed_allocation_micro_usdc, "carry_portfolio_capital_proposed_overflow"),
    0,
  );
  const netNewOwnerCapitalRequested = totalRequested - totalInternalReallocation;
  const uncovered = netNewOwnerCapitalRequested - totalProposed;
  const venueIds = [...new Set(accounts.map((account) => account.venue_id))].sort();
  const venues = venueIds.map((venueId) => {
    const venueRequests = allocations.filter((allocation) => allocation.venue_id === venueId);
    const venueAccounts = accounts.filter((account) => account.venue_id === venueId);
    const requested = venueRequests.reduce(
      (sum, item) => safeAdd(sum, item.requested_micro_usdc, "carry_portfolio_capital_venue_requested_overflow"),
      0,
    );
    const internallyReallocated = venueRequests.reduce(
      (sum, item) => safeAdd(sum, item.proposed_internal_reallocation_micro_usdc, "carry_portfolio_capital_venue_reallocation_overflow"),
      0,
    );
    const proposed = venueRequests.reduce(
      (sum, item) => safeAdd(sum, item.proposed_allocation_micro_usdc, "carry_portfolio_capital_venue_proposed_overflow"),
      0,
    );
    const releasable = venueAccounts.reduce(
      (sum, item) => safeAdd(sum, item.potential_releasable_micro_usdc, "carry_portfolio_capital_venue_releasable_overflow"),
      0,
    );
    return Object.freeze({
      venue_id: venueId,
      account_count: venueAccounts.length,
      requested_micro_usdc: requested,
      potential_releasable_micro_usdc: releasable,
      proposed_internal_reallocation_micro_usdc: internallyReallocated,
      proposed_allocation_micro_usdc: proposed,
      uncovered_shortfall_micro_usdc: requested - internallyReallocated - proposed,
      affected_position_count: new Set(venueRequests.flatMap((item) => item.position_ids)).size,
    });
  });
  const riskActions = positionPlans
    .filter((plan) => plan.reconciliation_required || plan.reduce_only_exit_required)
    .map((plan) => Object.freeze({
      position_id: plan.position_id,
      status: plan.status,
      recommended_action: plan.recommended_action,
      reasons: plan.reasons,
    }));
  const reviewOnlyCount = positionPlans.reduce(
    (count, plan) => count + plan.legs.filter((leg) => leg.recommended_action === "owner_review_required").length,
    0,
  );
  const reconciliationRequired = positionPlans.some((plan) => plan.reconciliation_required);
  const reduceOnlyExitRequired = positionPlans.some((plan) => plan.reduce_only_exit_required);
  const ownerActionRequired = totalRequested > 0 || reviewOnlyCount > 0;
  const capitalOptimizationAvailable = totalPotentialReleasable > totalInternalReallocation;
  const status = stalePositionIds.length > 0 || reconciliationRequired
    ? "quarantined"
    : reduceOnlyExitRequired
      ? "exit_required"
      : ownerActionRequired
        ? "owner_action_required"
        : "balanced";
  const recommendedAction = status === "quarantined"
    ? "reconcile_only"
    : status === "exit_required"
      ? "reduce_only_exit"
      : status === "owner_action_required"
        ? "owner_collateral_review"
        : "none";
  return deepFreeze({
    version: 1,
    kind: "ghola_carry_portfolio_capital_plan",
    max_data_age_ms: maxDataAgeMs,
    minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs,
    status,
    recommended_action: recommendedAction,
    position_count: positionPlans.length,
    account_count: accounts.length,
    owner_capital_budget_micro_usdc: ownerCapitalBudget,
    total_requested_micro_usdc: totalRequested,
    total_potential_releasable_micro_usdc: totalPotentialReleasable,
    total_proposed_internal_reallocation_micro_usdc: totalInternalReallocation,
    total_proposed_internal_reallocation_fees_micro_usdc: totalInternalReallocationFees,
    net_new_owner_capital_requested_micro_usdc: netNewOwnerCapitalRequested,
    total_proposed_allocation_micro_usdc: totalProposed,
    total_uncovered_shortfall_micro_usdc: uncovered,
    unallocated_owner_capital_micro_usdc: allocationPermitted ? remainingBudget : ownerCapitalBudget,
    budget_sufficient: allocationPermitted && uncovered === 0,
    stale_position_ids: stalePositionIds,
    reconciliation_required: reconciliationRequired || stalePositionIds.length > 0,
    reduce_only_exit_required: reduceOnlyExitRequired,
    owner_action_required: ownerActionRequired,
    capital_optimization_available: capitalOptimizationAvailable,
    routeable_capital_optimization_available: totalInternalReallocation > 0,
    transfer_route_count: transferRoutes.length,
    verified_transfer_route_count: new Set(proposedReallocations.map((proposal) => proposal.route_id)).size,
    transfer_route_failures: [...new Set(transferRouteFailures)],
    owner_approval_required: totalInternalReallocation > 0 || totalProposed > 0,
    owner_transfer_approval_required: totalInternalReallocation > 0,
    owner_funding_approval_required: totalProposed > 0,
    review_only_action_count: reviewOnlyCount,
    accounts,
    release_candidates: releaseCandidates.map(({ remaining_micro_usdc: _remaining, ...candidate }) => Object.freeze(candidate)),
    proposed_reallocations: proposedReallocations,
    allocations,
    venues,
    risk_actions: riskActions,
    proposal_only: true,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    owner_only_operations: ["fund", "transfer", "withdraw"],
    checked_at_ms: nowMs,
  });
}

export function compileCarryCollateralReview(value) {
  const raw = object(value, "carry_collateral_review_required");
  exactVersion(raw.version, "carry_collateral_review_version");
  const nowMs = positiveInteger(raw.now_ms, "carry_collateral_review_now");
  const expiresAtMs = positiveInteger(raw.expires_at_ms, "carry_collateral_review_expires_at");
  if (expiresAtMs <= nowMs || expiresAtMs - nowMs > 15 * 60_000) {
    fail("carry_collateral_review_expiry");
  }
  const ownerCommitment = identifier(raw.owner_commitment, "carry_collateral_review_owner");
  const reviewId = identifier(raw.review_id, "carry_collateral_review_id");
  const capitalPlan = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: nowMs,
    max_data_age_ms: raw.max_data_age_ms,
    owner_capital_budget_micro_usdc: raw.owner_capital_budget_micro_usdc,
    minimum_transfer_arrival_buffer_ms: raw.minimum_transfer_arrival_buffer_ms,
    transfer_routes: raw.transfer_routes,
    position_plans: raw.position_plans,
  });
  const blocked = capitalPlan.reconciliation_required === true
    || capitalPlan.reduce_only_exit_required === true
    || capitalPlan.status === "quarantined"
    || capitalPlan.status === "exit_required";
  const transfers = blocked ? [] : capitalPlan.proposed_reallocations.map((proposal) => Object.freeze({
    instruction_id: `${reviewId}:transfer:${proposal.priority_rank}`,
    sequence: proposal.priority_rank,
    operation: "owner_collateral_transfer_review",
    route_id: proposal.route_id,
    route_evidence_as_of_ms: proposal.route_evidence_as_of_ms,
    route_evidence_commitment: proposal.route_evidence_commitment,
    route_evidence_checked_at_ms: proposal.route_evidence_checked_at_ms,
    route_evidence_source: proposal.route_evidence_source,
    route_observer_image_digest: proposal.route_observer_image_digest,
    from_account_commitment: proposal.from_account_commitment,
    from_venue_id: proposal.from_venue_id,
    to_account_commitment: proposal.to_account_commitment,
    to_venue_id: proposal.to_venue_id,
    source_adapter_id: proposal.source_adapter_id,
    destination_adapter_id: proposal.destination_adapter_id,
    source_account_state_commitment: proposal.source_account_state_commitment,
    destination_account_state_commitment: proposal.destination_account_state_commitment,
    route_quote_commitment: proposal.route_quote_commitment,
    valuation_asset: proposal.valuation_asset,
    source_collateral_asset: proposal.source_collateral_asset,
    destination_collateral_asset: proposal.destination_collateral_asset,
    conversion_required: proposal.conversion_required,
    conversion_quote_verified: proposal.conversion_quote_verified,
    conversion_rate_e8: proposal.conversion_rate_e8,
    amount_micro_usdc: proposal.amount_micro_usdc,
    gross_debit_micro_usdc: proposal.gross_debit_micro_usdc,
    withdrawal_fee_micro_usdc: proposal.withdrawal_fee_micro_usdc,
    deposit_fee_micro_usdc: proposal.deposit_fee_micro_usdc,
    conversion_fee_micro_usdc: proposal.conversion_fee_micro_usdc,
    conversion_slippage_micro_usdc: proposal.conversion_slippage_micro_usdc,
    fee_micro_usdc: proposal.fee_micro_usdc,
    estimated_latency_ms: proposal.estimated_latency_ms,
    expected_arrival_at_ms: proposal.expected_arrival_at_ms,
    destination_runway_deadline_at_ms: proposal.destination_runway_deadline_at_ms,
    destination_runway_at_arrival_ms: proposal.destination_runway_at_arrival_ms,
    minimum_arrival_buffer_ms: proposal.minimum_arrival_buffer_ms,
    route_verified: true,
    owner_signature_required: true,
    execution_authorized: false,
    transaction_broadcast: false,
  }));
  const allocations = blocked ? [] : capitalPlan.allocations
    .filter((allocation) => allocation.proposed_allocation_micro_usdc > 0)
    .map((allocation) => Object.freeze({
      instruction_id: `${reviewId}:funding:${allocation.priority_rank}`,
      sequence: allocation.priority_rank,
      operation: "owner_new_capital_allocation_review",
      account_commitment: allocation.account_commitment,
      venue_id: allocation.venue_id,
      amount_micro_usdc: allocation.proposed_allocation_micro_usdc,
      owner_signature_required: true,
      execution_authorized: false,
      transaction_broadcast: false,
    }));
  const ownerSignatureRequired = transfers.length > 0 || allocations.length > 0;
  const ownerWalletAddress = raw.owner_wallet_address == null
    ? null
    : String(raw.owner_wallet_address).trim().toLowerCase();
  if ((ownerWalletAddress !== null && !ETH_ADDRESS.test(ownerWalletAddress))
    || (ownerSignatureRequired && ownerWalletAddress === null)) {
    fail("carry_collateral_review_owner_wallet");
  }
  const status = blocked ? "blocked"
    : ownerSignatureRequired ? "signature_required"
      : "no_action";
  return normalizeCarryCollateralReviewPayload({
    version: 1,
    kind: "ghola_carry_collateral_review",
    strategy_id: "delta_neutral_carry_v1",
    owner_commitment: ownerCommitment,
    owner_wallet_address: ownerWalletAddress,
    max_data_age_ms: capitalPlan.max_data_age_ms,
    minimum_transfer_arrival_buffer_ms: capitalPlan.minimum_transfer_arrival_buffer_ms,
    transfer_routes: raw.transfer_routes ?? [],
    review_id: reviewId,
    status,
    capital_plan: capitalPlan,
    transfer_instructions: transfers,
    funding_instructions: allocations,
    owner_signature_required: ownerSignatureRequired,
    owner_signature_status: ownerSignatureRequired ? "required" : blocked ? "blocked" : "not_required",
    proposal_only: true,
    review_only: true,
    execution_authorized: false,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    withdrawal_permitted: false,
    trade_permitted: false,
    owner_only_operations: ["fund", "transfer", "withdraw"],
    issued_at_ms: nowMs,
    expires_at_ms: expiresAtMs,
  });
}

export function normalizeCarryCollateralReviewPayload(value) {
  const raw = object(value, "carry_collateral_review_payload_required");
  exactVersion(raw.version, "carry_collateral_review_payload_version");
  if (raw.kind !== "ghola_carry_collateral_review") fail("carry_collateral_review_kind");
  if (raw.strategy_id !== "delta_neutral_carry_v1") fail("carry_collateral_review_strategy");
  const ownerCommitment = identifier(raw.owner_commitment, "carry_collateral_review_owner");
  const ownerWalletAddress = raw.owner_wallet_address == null
    ? null
    : String(raw.owner_wallet_address).trim().toLowerCase();
  if (ownerWalletAddress !== null && !ETH_ADDRESS.test(ownerWalletAddress)) {
    fail("carry_collateral_review_owner_wallet");
  }
  const reviewId = identifier(raw.review_id, "carry_collateral_review_id");
  const maxDataAgeMs = boundedInteger(
    raw.max_data_age_ms,
    250,
    300_000,
    "carry_collateral_review_max_data_age",
  );
  const minimumTransferArrivalBufferMs = boundedInteger(
    raw.minimum_transfer_arrival_buffer_ms ?? 300_000,
    0,
    DAY_MS,
    "carry_collateral_review_transfer_arrival_buffer",
  );
  const transferRoutes = array(
    raw.transfer_routes ?? [],
    "carry_collateral_review_transfer_routes",
    0,
    1_000,
  ).map(normalizeCarryTransferRouteEvidence);
  if (new Set(transferRoutes.map((route) => route.route_id)).size !== transferRoutes.length) {
    fail("carry_collateral_review_duplicate_transfer_route");
  }
  const issuedAtMs = positiveInteger(raw.issued_at_ms, "carry_collateral_review_issued_at");
  const expiresAtMs = positiveInteger(raw.expires_at_ms, "carry_collateral_review_expires_at");
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > 15 * 60_000) {
    fail("carry_collateral_review_expiry");
  }
  if (raw.proposal_only !== true || raw.review_only !== true
    || raw.execution_authorized !== false || raw.fund_movement_authorized !== false
    || raw.transaction_broadcast !== false || raw.automatic_transfer_permitted !== false
    || raw.withdrawal_permitted !== false || raw.trade_permitted !== false) {
    fail("carry_collateral_review_authority_boundary");
  }
  const ownerOnlyOperations = array(raw.owner_only_operations, "carry_collateral_review_owner_operations", 3, 3);
  if (!["fund", "transfer", "withdraw"].every((operation) => ownerOnlyOperations.includes(operation))) {
    fail("carry_collateral_review_owner_operations");
  }
  const capitalPlan = object(raw.capital_plan, "carry_collateral_review_capital_plan_required");
  exactVersion(capitalPlan.version, "carry_collateral_review_capital_plan_version");
  const capitalPlanStatus = enumValue(
    capitalPlan.status,
    new Set(["balanced", "owner_action_required", "exit_required", "quarantined"]),
    "carry_collateral_review_capital_plan_status",
  );
  const capitalPlanOwnerOperations = array(
    capitalPlan.owner_only_operations,
    "carry_collateral_review_capital_plan_owner_operations",
    3,
    3,
  );
  if (capitalPlan.kind !== "ghola_carry_portfolio_capital_plan"
    || capitalPlan.max_data_age_ms !== maxDataAgeMs
    || capitalPlan.minimum_transfer_arrival_buffer_ms !== minimumTransferArrivalBufferMs
    || capitalPlan.transfer_route_count !== transferRoutes.length
    || capitalPlan.proposal_only !== true || capitalPlan.transaction_broadcast !== false
    || capitalPlan.automatic_transfer_permitted !== false
    || !["fund", "transfer", "withdraw"].every((operation) => capitalPlanOwnerOperations.includes(operation))) {
    fail("carry_collateral_review_capital_plan_authority_boundary");
  }
  positiveInteger(capitalPlan.checked_at_ms, "carry_collateral_review_capital_plan_checked_at");
  const transferInstructions = array(
    raw.transfer_instructions,
    "carry_collateral_review_transfer_instructions",
    0,
    1_000,
  ).map((value) => normalizeCollateralReviewInstruction(value, reviewId, "transfer"));
  const fundingInstructions = array(
    raw.funding_instructions,
    "carry_collateral_review_funding_instructions",
    0,
    1_000,
  ).map((value) => normalizeCollateralReviewInstruction(value, reviewId, "funding"));
  const expectedTransfers = array(
    capitalPlan.proposed_reallocations,
    "carry_collateral_review_capital_plan_transfers",
    0,
    1_000,
  ).map((proposal) => normalizeCollateralReviewInstruction({
    instruction_id: `${reviewId}:transfer:${proposal.priority_rank}`,
    sequence: proposal.priority_rank,
    operation: "owner_collateral_transfer_review",
    route_id: proposal.route_id,
    route_evidence_as_of_ms: proposal.route_evidence_as_of_ms,
    route_evidence_commitment: proposal.route_evidence_commitment,
    route_evidence_checked_at_ms: proposal.route_evidence_checked_at_ms,
    route_evidence_source: proposal.route_evidence_source,
    route_observer_image_digest: proposal.route_observer_image_digest,
    from_account_commitment: proposal.from_account_commitment,
    from_venue_id: proposal.from_venue_id,
    to_account_commitment: proposal.to_account_commitment,
    to_venue_id: proposal.to_venue_id,
    source_adapter_id: proposal.source_adapter_id,
    destination_adapter_id: proposal.destination_adapter_id,
    source_account_state_commitment: proposal.source_account_state_commitment,
    destination_account_state_commitment: proposal.destination_account_state_commitment,
    route_quote_commitment: proposal.route_quote_commitment,
    valuation_asset: proposal.valuation_asset,
    source_collateral_asset: proposal.source_collateral_asset,
    destination_collateral_asset: proposal.destination_collateral_asset,
    conversion_required: proposal.conversion_required,
    conversion_quote_verified: proposal.conversion_quote_verified,
    conversion_rate_e8: proposal.conversion_rate_e8,
    amount_micro_usdc: proposal.amount_micro_usdc,
    gross_debit_micro_usdc: proposal.gross_debit_micro_usdc,
    withdrawal_fee_micro_usdc: proposal.withdrawal_fee_micro_usdc,
    deposit_fee_micro_usdc: proposal.deposit_fee_micro_usdc,
    conversion_fee_micro_usdc: proposal.conversion_fee_micro_usdc,
    conversion_slippage_micro_usdc: proposal.conversion_slippage_micro_usdc,
    fee_micro_usdc: proposal.fee_micro_usdc,
    estimated_latency_ms: proposal.estimated_latency_ms,
    expected_arrival_at_ms: proposal.expected_arrival_at_ms,
    destination_runway_deadline_at_ms: proposal.destination_runway_deadline_at_ms,
    destination_runway_at_arrival_ms: proposal.destination_runway_at_arrival_ms,
    minimum_arrival_buffer_ms: proposal.minimum_arrival_buffer_ms,
    route_verified: proposal.route_verified,
    owner_signature_required: true,
    execution_authorized: false,
    transaction_broadcast: false,
  }, reviewId, "transfer"));
  const expectedFunding = array(
    capitalPlan.allocations,
    "carry_collateral_review_capital_plan_allocations",
    0,
    1_000,
  ).filter((allocation) => allocation.proposed_allocation_micro_usdc > 0)
    .map((allocation) => normalizeCollateralReviewInstruction({
      instruction_id: `${reviewId}:funding:${allocation.priority_rank}`,
      sequence: allocation.priority_rank,
      operation: "owner_new_capital_allocation_review",
      account_commitment: allocation.account_commitment,
      venue_id: allocation.venue_id,
      amount_micro_usdc: allocation.proposed_allocation_micro_usdc,
      owner_signature_required: true,
      execution_authorized: false,
      transaction_broadcast: false,
    }, reviewId, "funding"));
  const instructionIds = [...transferInstructions, ...fundingInstructions].map((instruction) => instruction.instruction_id);
  if (new Set(instructionIds).size !== instructionIds.length) fail("carry_collateral_review_instruction_duplicate");
  const ownerSignatureRequired = transferInstructions.length > 0 || fundingInstructions.length > 0;
  const blocked = capitalPlan.reconciliation_required === true
    || capitalPlan.reduce_only_exit_required === true
    || capitalPlanStatus === "quarantined"
    || capitalPlanStatus === "exit_required";
  if (blocked && instructionIds.length > 0) fail("carry_collateral_review_blocked_instruction");
  const expectedReviewTransfers = blocked ? [] : expectedTransfers;
  const expectedReviewFunding = blocked ? [] : expectedFunding;
  if (!sameCollateralInstructions(transferInstructions, expectedReviewTransfers, "transfer")
    || !sameCollateralInstructions(fundingInstructions, expectedReviewFunding, "funding")) {
    fail("carry_collateral_review_instruction_plan_mismatch");
  }
  const expectedTransferTotal = expectedTransfers.reduce(
    (sum, instruction) => safeAdd(sum, instruction.amount_micro_usdc, "carry_collateral_review_transfer_overflow"),
    0,
  );
  const expectedFundingTotal = expectedFunding.reduce(
    (sum, instruction) => safeAdd(sum, instruction.amount_micro_usdc, "carry_collateral_review_funding_overflow"),
    0,
  );
  if (nonNegativeInteger(capitalPlan.total_proposed_internal_reallocation_micro_usdc, "carry_collateral_review_transfer_total") !== expectedTransferTotal
    || nonNegativeInteger(capitalPlan.total_proposed_allocation_micro_usdc, "carry_collateral_review_funding_total") !== expectedFundingTotal
    || (capitalPlan.owner_transfer_approval_required === true) !== (expectedTransferTotal > 0)
    || (capitalPlan.owner_funding_approval_required === true) !== (expectedFundingTotal > 0)
    || (capitalPlan.owner_approval_required === true) !== (expectedTransferTotal > 0 || expectedFundingTotal > 0)) {
    fail("carry_collateral_review_total_mismatch");
  }
  const status = enumValue(
    raw.status,
    new Set(["blocked", "signature_required", "no_action"]),
    "carry_collateral_review_status",
  );
  const expectedStatus = blocked ? "blocked" : ownerSignatureRequired ? "signature_required" : "no_action";
  if (status !== expectedStatus
    || raw.owner_signature_required !== ownerSignatureRequired
    || raw.owner_signature_status !== (ownerSignatureRequired ? "required" : blocked ? "blocked" : "not_required")) {
    fail("carry_collateral_review_status_inconsistent");
  }
  if (ownerSignatureRequired && ownerWalletAddress === null) fail("carry_collateral_review_owner_wallet");
  return deepFreeze({
    version: 1,
    kind: "ghola_carry_collateral_review",
    strategy_id: "delta_neutral_carry_v1",
    owner_commitment: ownerCommitment,
    owner_wallet_address: ownerWalletAddress,
    max_data_age_ms: maxDataAgeMs,
    minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs,
    transfer_routes: transferRoutes,
    review_id: reviewId,
    status,
    capital_plan: JSON.parse(JSON.stringify(capitalPlan)),
    transfer_instructions: transferInstructions,
    funding_instructions: fundingInstructions,
    owner_signature_required: ownerSignatureRequired,
    owner_signature_status: raw.owner_signature_status,
    proposal_only: true,
    review_only: true,
    execution_authorized: false,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    withdrawal_permitted: false,
    trade_permitted: false,
    owner_only_operations: ["fund", "transfer", "withdraw"],
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
  });
}

export function carryCollateralReviewMessage(value) {
  return `Ghola Carry collateral review v1\n${JSON.stringify(normalizeCarryCollateralReviewPayload(value))}`;
}

export function normalizeCarryCollateralReviewAuthorization(value) {
  const raw = object(value, "carry_collateral_review_authorization_required");
  exactVersion(raw.version, "carry_collateral_review_authorization_version");
  const signature = String(raw.signature || "").trim().toLowerCase();
  const reviewCommitment = String(raw.review_commitment || "").trim().toLowerCase();
  if (!ETH_SIGNATURE.test(signature)) fail("carry_collateral_review_signature_invalid");
  if (!ETH_COMMITMENT.test(reviewCommitment)) fail("carry_collateral_review_commitment_invalid");
  const review = normalizeCarryCollateralReviewPayload(raw.signed_review);
  if (review.status !== "signature_required" || review.owner_signature_required !== true) {
    fail("carry_collateral_review_signature_not_required");
  }
  return deepFreeze({
    version: 1,
    signed_review: review,
    signature,
    review_commitment: reviewCommitment,
  });
}

function normalizeCollateralReviewInstruction(value, reviewId, type) {
  const raw = object(value, "carry_collateral_review_instruction_required");
  const sequence = positiveInteger(raw.sequence, "carry_collateral_review_instruction_sequence");
  const expectedOperation = type === "transfer"
    ? "owner_collateral_transfer_review"
    : "owner_new_capital_allocation_review";
  if (raw.operation !== expectedOperation
    || raw.owner_signature_required !== true
    || raw.execution_authorized !== false
    || raw.transaction_broadcast !== false) {
    fail("carry_collateral_review_instruction_authority_boundary");
  }
  const instructionId = identifier(raw.instruction_id, "carry_collateral_review_instruction_id");
  if (instructionId !== `${reviewId}:${type}:${sequence}`) fail("carry_collateral_review_instruction_lineage");
  const base = {
    instruction_id: instructionId,
    sequence,
    operation: expectedOperation,
    amount_micro_usdc: positiveInteger(raw.amount_micro_usdc, "carry_collateral_review_instruction_amount"),
    owner_signature_required: true,
    execution_authorized: false,
    transaction_broadcast: false,
  };
  if (type === "transfer") {
    const fromAccount = identifier(raw.from_account_commitment, "carry_collateral_review_from_account");
    const toAccount = identifier(raw.to_account_commitment, "carry_collateral_review_to_account");
    const fromVenue = carryExecutionVenue(raw.from_venue_id, "carry_collateral_review_from_venue");
    const toVenue = carryExecutionVenue(raw.to_venue_id, "carry_collateral_review_to_venue");
    if (fromAccount === toAccount) {
      fail("carry_collateral_review_transfer_same_account");
    }
    const fee = nonNegativeInteger(raw.fee_micro_usdc, "carry_collateral_review_transfer_fee");
    if (raw.valuation_asset !== "USD") fail("carry_collateral_review_transfer_valuation_asset");
    const sourceCollateralAsset = enumValue(
      raw.source_collateral_asset,
      new Set(["USDC", "USDT"]),
      "carry_collateral_review_transfer_source_asset",
    );
    const destinationCollateralAsset = enumValue(
      raw.destination_collateral_asset,
      new Set(["USDC", "USDT"]),
      "carry_collateral_review_transfer_destination_asset",
    );
    const conversionRequired = sourceCollateralAsset !== destinationCollateralAsset;
    const conversionQuoteVerified = raw.conversion_quote_verified === true;
    const conversionRateE8 = nonNegativeInteger(
      raw.conversion_rate_e8,
      "carry_collateral_review_transfer_conversion_rate",
    );
    const withdrawalFee = nonNegativeInteger(
      raw.withdrawal_fee_micro_usdc,
      "carry_collateral_review_transfer_withdrawal_fee",
    );
    const depositFee = nonNegativeInteger(
      raw.deposit_fee_micro_usdc,
      "carry_collateral_review_transfer_deposit_fee",
    );
    const conversionFee = nonNegativeInteger(
      raw.conversion_fee_micro_usdc,
      "carry_collateral_review_transfer_conversion_fee",
    );
    const conversionSlippage = nonNegativeInteger(
      raw.conversion_slippage_micro_usdc,
      "carry_collateral_review_transfer_conversion_slippage",
    );
    if (raw.conversion_required !== conversionRequired
      || venueAdapterCapability(fromVenue, "collateral_route_observer")?.collateral_asset !== sourceCollateralAsset
      || venueAdapterCapability(toVenue, "collateral_route_observer")?.collateral_asset !== destinationCollateralAsset
      || (conversionRequired && !conversionQuoteVerified)
      || (conversionRequired && conversionRateE8 === 0)
      || (!conversionRequired && (conversionRateE8 !== 100_000_000 || conversionFee !== 0 || conversionSlippage !== 0))
      || fee !== safeAdd(
        safeAdd(withdrawalFee, depositFee, "carry_collateral_review_transfer_fee_overflow"),
        safeAdd(conversionFee, conversionSlippage, "carry_collateral_review_transfer_fee_overflow"),
        "carry_collateral_review_transfer_fee_overflow",
      )) {
      fail("carry_collateral_review_transfer_conversion_unverified");
    }
    const grossDebit = positiveInteger(raw.gross_debit_micro_usdc, "carry_collateral_review_transfer_gross_debit");
    if (grossDebit !== safeAdd(base.amount_micro_usdc, fee, "carry_collateral_review_transfer_gross_overflow")) {
      fail("carry_collateral_review_transfer_net_mismatch");
    }
    const estimatedLatency = nonNegativeInteger(raw.estimated_latency_ms, "carry_collateral_review_transfer_latency");
    const expectedArrivalAt = positiveInteger(raw.expected_arrival_at_ms, "carry_collateral_review_transfer_arrival");
    const destinationRunwayDeadlineAt = raw.destination_runway_deadline_at_ms === null
      ? null
      : positiveInteger(raw.destination_runway_deadline_at_ms, "carry_collateral_review_transfer_destination_runway_deadline");
    const destinationRunwayAtArrival = raw.destination_runway_at_arrival_ms === null
      ? null
      : nonNegativeInteger(raw.destination_runway_at_arrival_ms, "carry_collateral_review_transfer_destination_runway");
    const minimumArrivalBuffer = nonNegativeInteger(raw.minimum_arrival_buffer_ms, "carry_collateral_review_transfer_arrival_buffer");
    if ((destinationRunwayDeadlineAt === null) !== (destinationRunwayAtArrival === null)
      || (destinationRunwayDeadlineAt !== null
        && destinationRunwayDeadlineAt !== safeAdd(expectedArrivalAt, destinationRunwayAtArrival, "carry_collateral_review_transfer_runway_overflow"))
      || raw.route_verified !== true
      || (destinationRunwayAtArrival !== null && destinationRunwayAtArrival <= minimumArrivalBuffer)) {
      fail("carry_collateral_review_transfer_route_unverified");
    }
    return Object.freeze({
      ...base,
      route_id: identifier(raw.route_id, "carry_collateral_review_transfer_route"),
      route_evidence_as_of_ms: positiveInteger(raw.route_evidence_as_of_ms, "carry_collateral_review_transfer_route_as_of"),
      route_evidence_commitment: identifier(raw.route_evidence_commitment, "carry_collateral_review_transfer_route_evidence"),
      route_evidence_checked_at_ms: positiveInteger(raw.route_evidence_checked_at_ms, "carry_collateral_review_transfer_route_checked_at"),
      route_evidence_source: raw.route_evidence_source === "attested_worker"
        ? "attested_worker"
        : fail("carry_collateral_review_transfer_route_source"),
      route_observer_image_digest: identifier(raw.route_observer_image_digest, "carry_collateral_review_transfer_route_image"),
      from_account_commitment: fromAccount,
      from_venue_id: fromVenue,
      to_account_commitment: toAccount,
      to_venue_id: toVenue,
      source_adapter_id: identifier(raw.source_adapter_id, "carry_collateral_review_transfer_source_adapter"),
      destination_adapter_id: identifier(raw.destination_adapter_id, "carry_collateral_review_transfer_destination_adapter"),
      source_account_state_commitment: identifier(raw.source_account_state_commitment, "carry_collateral_review_transfer_source_state"),
      destination_account_state_commitment: identifier(raw.destination_account_state_commitment, "carry_collateral_review_transfer_destination_state"),
      route_quote_commitment: identifier(raw.route_quote_commitment, "carry_collateral_review_transfer_quote"),
      valuation_asset: "USD",
      source_collateral_asset: sourceCollateralAsset,
      destination_collateral_asset: destinationCollateralAsset,
      conversion_required: conversionRequired,
      conversion_quote_verified: conversionQuoteVerified,
      conversion_rate_e8: conversionRateE8,
      gross_debit_micro_usdc: grossDebit,
      withdrawal_fee_micro_usdc: withdrawalFee,
      deposit_fee_micro_usdc: depositFee,
      conversion_fee_micro_usdc: conversionFee,
      conversion_slippage_micro_usdc: conversionSlippage,
      fee_micro_usdc: fee,
      estimated_latency_ms: estimatedLatency,
      expected_arrival_at_ms: expectedArrivalAt,
      destination_runway_deadline_at_ms: destinationRunwayDeadlineAt,
      destination_runway_at_arrival_ms: destinationRunwayAtArrival,
      minimum_arrival_buffer_ms: minimumArrivalBuffer,
      route_verified: true,
    });
  }
  return Object.freeze({
    ...base,
    account_commitment: identifier(raw.account_commitment, "carry_collateral_review_funding_account"),
    venue_id: carryExecutionVenue(raw.venue_id, "carry_collateral_review_funding_venue"),
  });
}

function sameCollateralInstructions(actual, expected, type) {
  if (actual.length !== expected.length) return false;
  const fields = type === "transfer"
    ? ["instruction_id", "sequence", "operation", "route_id", "route_evidence_as_of_ms", "route_evidence_commitment", "route_evidence_checked_at_ms", "route_evidence_source", "route_observer_image_digest", "from_account_commitment", "from_venue_id", "to_account_commitment", "to_venue_id", "source_adapter_id", "destination_adapter_id", "source_account_state_commitment", "destination_account_state_commitment", "route_quote_commitment", "valuation_asset", "source_collateral_asset", "destination_collateral_asset", "conversion_required", "conversion_quote_verified", "conversion_rate_e8", "amount_micro_usdc", "gross_debit_micro_usdc", "withdrawal_fee_micro_usdc", "deposit_fee_micro_usdc", "conversion_fee_micro_usdc", "conversion_slippage_micro_usdc", "fee_micro_usdc", "estimated_latency_ms", "expected_arrival_at_ms", "destination_runway_deadline_at_ms", "destination_runway_at_arrival_ms", "minimum_arrival_buffer_ms", "route_verified", "owner_signature_required", "execution_authorized", "transaction_broadcast"]
    : ["instruction_id", "sequence", "operation", "account_commitment", "venue_id", "amount_micro_usdc", "owner_signature_required", "execution_authorized", "transaction_broadcast"];
  return actual.every((instruction, index) => fields.every((field) => instruction[field] === expected[index][field]));
}

export function compileCarryPortfolioValueReport(value) {
  const raw = object(value, "carry_portfolio_value_report_required");
  exactVersion(raw.version, "carry_portfolio_value_report_version");
  const nowMs = positiveInteger(raw.now_ms, "carry_portfolio_value_report_now");
  const positions = array(
    raw.position_values,
    "carry_portfolio_value_report_positions",
    0,
    1_000,
  ).map(normalizePortfolioValuePosition);
  if (new Set(positions.map((position) => position.position_id)).size !== positions.length) {
    fail("carry_portfolio_value_report_duplicate_position");
  }
  const capital = normalizePortfolioValueCapitalEvidence(raw.capital_evidence);
  const open = positions.filter((position) => position.ledger_status === "open");
  const finalized = positions.filter((position) => position.ledger_status === "finalized");
  const sum = (items, field, code) => items.reduce(
    (total, item) => safeAdd(total, item[field], code),
    0,
  );
  const modeled = {
    gross_funding_micro_usdc: sum(positions, "modeled_gross_funding_micro_usdc", "carry_portfolio_value_modeled_overflow"),
    trading_cost_micro_usdc: sum(positions, "modeled_trading_cost_micro_usdc", "carry_portfolio_value_modeled_overflow"),
    capital_cost_micro_usdc: sum(positions, "modeled_capital_cost_micro_usdc", "carry_portfolio_value_modeled_overflow"),
    risk_buffer_micro_usdc: sum(positions, "modeled_risk_buffer_micro_usdc", "carry_portfolio_value_modeled_overflow"),
    net_value_micro_usdc: sum(positions, "modeled_net_value_micro_usdc", "carry_portfolio_value_modeled_overflow"),
  };
  const observed = portfolioRealizedTotals(positions, "carry_portfolio_value_observed_overflow");
  const finalizedRealized = portfolioRealizedTotals(finalized, "carry_portfolio_value_finalized_overflow");
  const finalizedModeledNet = sum(finalized, "modeled_net_value_micro_usdc", "carry_portfolio_value_finalized_overflow");
  const openModeledNet = sum(open, "modeled_net_value_micro_usdc", "carry_portfolio_value_open_overflow");
  const openObservedNet = sum(open, "realized_net_value_micro_usdc", "carry_portfolio_value_open_overflow");
  const finalizedVariance = safeAdd(
    finalizedRealized.net_value_micro_usdc,
    -finalizedModeledNet,
    "carry_portfolio_value_finalized_overflow",
  );
  const valueProofStatus = positions.length === 0
    ? "empty"
    : finalized.length === positions.length
      ? "finalized"
      : finalized.length > 0
        ? "mixed"
        : "accruing";
  return deepFreeze({
    version: 1,
    kind: "ghola_carry_portfolio_value_report",
    value_proof_status: valueProofStatus,
    valuation_asset: "USDC",
    funding_valuation_basis: "usdc_equivalent_at_ledger_ingestion",
    position_count: positions.length,
    open_position_count: open.length,
    finalized_position_count: finalized.length,
    modeled,
    observed_cashflows: {
      ...observed,
      complete: positions.length > 0 && open.length === 0,
    },
    finalized_after_costs: {
      ...finalizedRealized,
      modeled_net_value_micro_usdc: finalizedModeledNet,
      variance_from_modeled_micro_usdc: finalizedVariance,
      position_count: finalized.length,
      complete: finalized.length > 0,
    },
    unfinalized: {
      position_count: open.length,
      modeled_net_value_micro_usdc: openModeledNet,
      observed_cashflow_net_micro_usdc: openObservedNet,
      costs_complete: false,
    },
    capital_efficiency: capital,
    proposal_only: true,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    owner_only_operations: ["fund", "transfer", "withdraw"],
    checked_at_ms: nowMs,
  });
}

export function evaluatePerpContractPairBasis(value) {
  const raw = object(value, "carry_contract_pair_required");
  exactVersion(raw.version, "carry_contract_pair_version");
  const longContract = normalizePairContract(raw.long_contract, "long");
  const shortContract = normalizePairContract(raw.short_contract, "short");
  const maxIndexPriceDivergenceBps = boundedInteger(
    raw.max_index_price_divergence_bps ?? 25,
    0,
    10_000,
    "carry_max_index_price_divergence",
  );
  const maxMarkPriceDivergenceBps = boundedInteger(
    raw.max_mark_price_divergence_bps ?? 50,
    0,
    10_000,
    "carry_max_mark_price_divergence",
  );
  const reasons = [];
  if (longContract.venue_id === shortContract.venue_id) reasons.push("distinct_venues_required");
  if (longContract.economic_equivalence_id !== shortContract.economic_equivalence_id) reasons.push("contracts_not_economically_equivalent");
  if (longContract.asset !== shortContract.asset) reasons.push("asset_mismatch");
  if (longContract.contract_type !== shortContract.contract_type) reasons.push("contract_type_mismatch");
  for (const contract of [longContract, shortContract]) {
    if (!USD_STABLE_QUOTES.has(contract.quote_asset)) reasons.push(`unsupported_quote_asset:${contract.venue_id}`);
  }
  const indexPriceDivergenceBps = priceDivergenceBpsCeil(longContract.index_price_e8, shortContract.index_price_e8);
  const markPriceDivergenceBps = priceDivergenceBpsCeil(longContract.mark_price_e8, shortContract.mark_price_e8);
  if (indexPriceDivergenceBps > maxIndexPriceDivergenceBps) reasons.push("index_price_divergence_exceeded");
  if (markPriceDivergenceBps > maxMarkPriceDivergenceBps) reasons.push("mark_price_divergence_exceeded");
  return deepFreeze({
    version: 1,
    eligible: [...new Set(reasons)].length === 0,
    reasons: [...new Set(reasons)],
    economic_equivalence_id: longContract.economic_equivalence_id === shortContract.economic_equivalence_id
      ? longContract.economic_equivalence_id
      : null,
    asset: longContract.asset === shortContract.asset ? longContract.asset : null,
    contract_type: longContract.contract_type === shortContract.contract_type ? longContract.contract_type : null,
    long_quote_asset: longContract.quote_asset,
    short_quote_asset: shortContract.quote_asset,
    index_price_divergence_bps: indexPriceDivergenceBps,
    mark_price_divergence_bps: markPriceDivergenceBps,
    max_index_price_divergence_bps: maxIndexPriceDivergenceBps,
    max_mark_price_divergence_bps: maxMarkPriceDivergenceBps,
  });
}

export function evaluateCarryOpportunity(value) {
  const raw = object(value, "carry_opportunity_required");
  exactVersion(raw.version, "carry_opportunity_version");
  const longContract = normalizePerpContractSpec(raw.long_contract);
  const shortContract = normalizePerpContractSpec(raw.short_contract);
  const nowMs = positiveInteger(raw.now_ms, "carry_now");
  assertContractValuationsCurrent(longContract, nowMs);
  assertContractValuationsCurrent(shortContract, nowMs);
  const maxAgeMs = boundedInteger(raw.max_data_age_ms, 250, 300_000, "carry_max_data_age");
  const maxContractDataSkewMs = boundedInteger(
    raw.max_contract_data_skew_ms,
    0,
    maxAgeMs,
    "carry_max_contract_data_skew",
  );
  const contractPairBasis = evaluatePerpContractPairBasis({
    version: 1,
    long_contract: longContract,
    short_contract: shortContract,
    max_index_price_divergence_bps: raw.max_index_price_divergence_bps,
    max_mark_price_divergence_bps: raw.max_mark_price_divergence_bps,
  });
  const notional = positiveInteger(raw.notional_micro_usdc, "carry_notional");
  const capitalCommitted = positiveInteger(raw.capital_committed_micro_usdc, "carry_capital_committed");
  const horizonMs = boundedInteger(raw.horizon_ms, 60_000, 366 * DAY_MS, "carry_horizon");
  const longCosts = normalizeLegCosts(raw.long_costs, longContract.taker_fee_e6_bps);
  const shortCosts = normalizeLegCosts(raw.short_costs, shortContract.taker_fee_e6_bps);
  const capitalCostBpsPerDay = boundedInteger(raw.capital_cost_bps_per_day, 0, 10_000, "carry_capital_cost");
  const riskBufferBps = boundedInteger(raw.risk_buffer_bps, 0, 10_000, "carry_risk_buffer");
  const collateralBasisRiskBps = boundedInteger(raw.collateral_basis_risk_bps ?? 0, 0, 10_000, "carry_collateral_basis_risk");
  const minimumNetBenefitBps = boundedInteger(raw.min_expected_net_benefit_bps, 0, 10_000, "carry_minimum_net_benefit");
  const minimumRunwayMs = boundedInteger(raw.min_margin_runway_ms, 0, 366 * DAY_MS, "carry_minimum_runway");
  const marginRunways = array(raw.margin_runways, "carry_margin_runways", 2, 2).map(normalizeMarginRunwayResult);
  const reasons = [];
  reasons.push(...contractPairBasis.reasons);
  if (notional < longContract.minimum_notional_micro_usdc || notional < shortContract.minimum_notional_micro_usdc) {
    reasons.push("notional_below_venue_minimum");
  }
  for (const contract of [longContract, shortContract]) {
    if (contract.as_of_ms > nowMs || nowMs - contract.as_of_ms > maxAgeMs) reasons.push(`contract_stale:${contract.venue_id}`);
  }
  const contractDataSkewMs = Math.abs(longContract.as_of_ms - shortContract.as_of_ms);
  if (contractDataSkewMs > maxContractDataSkewMs) reasons.push("contract_data_skew_exceeded");
  const marginByVenue = new Map(marginRunways.map((runway) => [runway.venue_id, runway]));
  for (const venueId of [longContract.venue_id, shortContract.venue_id]) {
    const runway = marginByVenue.get(venueId);
    if (!runway) reasons.push(`margin_runway_missing:${venueId}`);
    else if (runway.status === "critical" || runway.status === "breached" || (runway.runway_ms !== null && runway.runway_ms < minimumRunwayMs)) {
      reasons.push(`margin_runway_insufficient:${venueId}`);
    }
  }

  const longFundingNative = fundingCashMicro("long", notional, longContract, horizonMs);
  const shortFundingNative = fundingCashMicro("short", notional, shortContract, horizonMs);
  const longFunding = modeledContractCashflowMicroUsdc(
    longFundingNative,
    longContract,
    longContract.funding_settlement_asset,
    "carry_long_funding",
  );
  const shortFunding = modeledContractCashflowMicroUsdc(
    shortFundingNative,
    shortContract,
    shortContract.funding_settlement_asset,
    "carry_short_funding",
  );
  const grossFunding = safeAdd(longFunding, shortFunding, "carry_funding_overflow");
  const tradingFeeCost = modeledLegCostTotalMicroUsdc(
    notional,
    [[longContract, longCosts], [shortContract, shortCosts]],
    ["entry_fee_e6_bps", "exit_fee_e6_bps"],
    (contract) => contract.fee_settlement_asset,
    "carry_trading_fee",
  );
  const slippageCost = modeledLegCostTotalMicroUsdc(
    notional,
    [[longContract, longCosts], [shortContract, shortCosts]],
    ["entry_slippage_e6_bps", "exit_slippage_e6_bps"],
    (contract) => contract.quote_asset,
    "carry_slippage",
  );
  const latencyBuffer = modeledLegCostTotalMicroUsdc(
    notional,
    [[longContract, longCosts], [shortContract, shortCosts]],
    ["latency_penalty_bps"],
    (contract) => contract.quote_asset,
    "carry_latency",
    1_000_000,
  );
  const gasCost = safeAdd(longCosts.gas_micro_usdc, shortCosts.gas_micro_usdc, "carry_gas_overflow");
  const fixedTradingCost = [tradingFeeCost, slippageCost, latencyBuffer, gasCost]
    .reduce((sum, amount) => safeAdd(sum, amount, "carry_fixed_cost_overflow"), 0);
  const baseRiskBuffer = microFromBpsCeil(notional, riskBufferBps);
  const collateralBasisRisk = microFromBpsCeil(notional, collateralBasisRiskBps);
  const liquidationFeeRisk = safeAdd(
    modeledContractCostMicroUsdc(
      microFromBpsCeil(notional, longContract.liquidation_fee_bps),
      longContract,
      longContract.fee_settlement_asset,
      "carry_long_liquidation_fee",
    ),
    modeledContractCostMicroUsdc(
      microFromBpsCeil(notional, shortContract.liquidation_fee_bps),
      shortContract,
      shortContract.fee_settlement_asset,
      "carry_short_liquidation_fee",
    ),
    "carry_liquidation_fee_risk_overflow",
  );
  const riskBuffer = safeAdd(
    safeAdd(baseRiskBuffer, collateralBasisRisk, "carry_risk_buffer_overflow"),
    liquidationFeeRisk,
    "carry_risk_buffer_overflow",
  );
  const capitalCost = safeNumber(ceilDiv(
    BigInt(capitalCommitted) * BigInt(capitalCostBpsPerDay) * BigInt(horizonMs),
    10_000n * BigInt(DAY_MS),
  ));
  const totalModeledCost = safeAdd(safeAdd(fixedTradingCost, riskBuffer, "carry_cost_overflow"), capitalCost, "carry_cost_overflow");
  const expectedNet = safeAdd(grossFunding, -totalModeledCost, "carry_net_overflow");
  const expectedNetBps = ratioBpsFloor(expectedNet, notional);
  const dailyFunding = safeAdd(
    modeledContractCashflowMicroUsdc(
      fundingCashMicro("long", notional, longContract, DAY_MS),
      longContract,
      longContract.funding_settlement_asset,
      "carry_long_daily_funding",
    ),
    modeledContractCashflowMicroUsdc(
      fundingCashMicro("short", notional, shortContract, DAY_MS),
      shortContract,
      shortContract.funding_settlement_asset,
      "carry_short_daily_funding",
    ),
    "carry_daily_funding_overflow",
  );
  const dailyCapitalCost = microFromBpsCeil(capitalCommitted, capitalCostBpsPerDay);
  const netRecurringPerDay = safeAdd(dailyFunding, -dailyCapitalCost, "carry_daily_net_overflow");
  const oneTimeCost = safeAdd(fixedTradingCost, riskBuffer, "carry_one_time_cost_overflow");
  const breakEvenMs = netRecurringPerDay > 0
    ? safeNumber(ceilDiv(BigInt(oneTimeCost) * BigInt(DAY_MS), BigInt(netRecurringPerDay)))
    : null;
  if (netRecurringPerDay <= 0) reasons.push("recurring_carry_not_positive");
  if (breakEvenMs === null || breakEvenMs > horizonMs) reasons.push("break_even_outside_horizon");
  if (expectedNetBps < minimumNetBenefitBps) reasons.push("expected_net_benefit_below_floor");

  return deepFreeze({
    version: 1,
    eligible: [...new Set(reasons)].length === 0,
    reasons: [...new Set(reasons)],
    asset: longContract.asset,
    long_venue_id: longContract.venue_id,
    short_venue_id: shortContract.venue_id,
    notional_micro_usdc: notional,
    capital_committed_micro_usdc: capitalCommitted,
    horizon_ms: horizonMs,
    projected_long_funding_source_amount_micro: longFundingNative,
    projected_short_funding_source_amount_micro: shortFundingNative,
    projected_long_funding_micro_usdc: longFunding,
    projected_short_funding_micro_usdc: shortFunding,
    projected_gross_funding_micro_usdc: grossFunding,
    projected_funding_credit_micro_usdc: safeAdd(Math.max(0, longFunding), Math.max(0, shortFunding), "carry_funding_overflow"),
    projected_funding_debit_micro_usdc: safeAdd(Math.max(0, -longFunding), Math.max(0, -shortFunding), "carry_funding_overflow"),
    projected_trading_fee_micro_usdc: tradingFeeCost,
    projected_slippage_micro_usdc: slippageCost,
    projected_gas_micro_usdc: gasCost,
    projected_latency_buffer_micro_usdc: latencyBuffer,
    projected_trading_cost_micro_usdc: fixedTradingCost,
    projected_capital_cost_micro_usdc: capitalCost,
    base_risk_buffer_micro_usdc: baseRiskBuffer,
    collateral_basis_risk_bps: collateralBasisRiskBps,
    collateral_basis_risk_micro_usdc: collateralBasisRisk,
    liquidation_fee_risk_micro_usdc: liquidationFeeRisk,
    long_initial_margin_bps: longContract.initial_margin_bps,
    short_initial_margin_bps: shortContract.initial_margin_bps,
    long_maintenance_margin_bps: longContract.maintenance_margin_bps,
    short_maintenance_margin_bps: shortContract.maintenance_margin_bps,
    long_liquidation_fee_bps: longContract.liquidation_fee_bps,
    short_liquidation_fee_bps: shortContract.liquidation_fee_bps,
    long_margin_model: longContract.margin_model,
    short_margin_model: shortContract.margin_model,
    long_liquidation_model: longContract.liquidation_model,
    short_liquidation_model: shortContract.liquidation_model,
    risk_buffer_micro_usdc: riskBuffer,
    projected_total_cost_micro_usdc: totalModeledCost,
    projected_net_value_micro_usdc: expectedNet,
    projected_net_value_bps: expectedNetBps,
    recurring_net_value_micro_usdc_per_day: netRecurringPerDay,
    break_even_ms: breakEvenMs,
    contract_data_skew_ms: contractDataSkewMs,
    max_contract_data_skew_ms: maxContractDataSkewMs,
    contract_pair_basis: contractPairBasis,
    economic_equivalence_id: contractPairBasis.economic_equivalence_id,
    contract_type: contractPairBasis.contract_type,
    long_quote_asset: contractPairBasis.long_quote_asset,
    short_quote_asset: contractPairBasis.short_quote_asset,
    long_funding_settlement_asset: longContract.funding_settlement_asset,
    short_funding_settlement_asset: shortContract.funding_settlement_asset,
    long_fee_settlement_asset: longContract.fee_settlement_asset,
    short_fee_settlement_asset: shortContract.fee_settlement_asset,
    valuation_asset: "USDC",
    long_asset_valuations: longContract.asset_valuations,
    short_asset_valuations: shortContract.asset_valuations,
    index_price_divergence_bps: contractPairBasis.index_price_divergence_bps,
    mark_price_divergence_bps: contractPairBasis.mark_price_divergence_bps,
    max_index_price_divergence_bps: contractPairBasis.max_index_price_divergence_bps,
    max_mark_price_divergence_bps: contractPairBasis.max_mark_price_divergence_bps,
    margin_runways: marginRunways,
    checked_at_ms: nowMs,
  });
}

export function compileCarryMigrationProposal(value) {
  const raw = object(value, "carry_migration_required");
  exactVersion(raw.version, "carry_migration_version");
  const nowMs = positiveInteger(raw.now_ms, "carry_migration_now");
  const authorization = normalizeCarryRiskMandateAuthorization(raw.mandate_authorization);
  const signed = authorization.signed_mandate;
  const position = object(raw.position, "carry_migration_position_required");
  const positionId = identifier(position.position_id, "carry_migration_position_id");
  const asset = normalized(position.asset, ASSET, "carry_migration_asset");
  const longVenue = carryExecutionVenue(position.long_venue_id, "carry_migration_long_venue");
  const shortVenue = carryExecutionVenue(position.short_venue_id, "carry_migration_short_venue");
  if (longVenue === shortVenue) fail("carry_migration_distinct_current_venues");
  if (signed.position_id !== positionId || signed.asset !== asset
    || signed.long_venue_id !== longVenue || signed.short_venue_id !== shortVenue) {
    fail("carry_migration_mandate_position_mismatch");
  }
  if (signed.expires_at_ms <= nowMs) fail("carry_migration_mandate_expired");
  const mandate = signed.risk_mandate;
  const allowlist = new Set(Array.isArray(mandate.migration_venue_allowlist)
    ? mandate.migration_venue_allowlist
    : []);
  const minimumImprovement = mandate.min_migration_improvement_bps
    ?? mandate.min_expected_net_benefit_bps;
  const currentNet = boundedInteger(
    raw.current_expected_net_value_bps,
    -100_000,
    100_000,
    "carry_migration_current_net",
  );
  const economicEquivalenceId = identifier(
    raw.economic_equivalence_id,
    "carry_migration_economic_equivalence_id",
  );
  const assessments = [];
  const reasons = [];
  if (mandate.allow_migration !== true) reasons.push("migration_not_authorized");
  if (allowlist.size < 2) reasons.push("migration_venue_allowlist_missing");

  for (const [index, candidateInput] of array(raw.candidates, "carry_migration_candidates", 0, 32).entries()) {
    try {
      const candidate = object(candidateInput, "carry_migration_candidate_required");
      const candidateId = identifier(candidate.candidate_id, "carry_migration_candidate_id");
      const candidateLong = carryExecutionVenue(candidate.long_venue_id, "carry_migration_candidate_long_venue");
      const candidateShort = carryExecutionVenue(candidate.short_venue_id, "carry_migration_candidate_short_venue");
      const candidateReasons = [];
      if (candidateLong === candidateShort) candidateReasons.push("distinct_venues_required");
      if (candidateLong === longVenue && candidateShort === shortVenue) candidateReasons.push("route_unchanged");
      if (!allowlist.has(candidateLong) || !allowlist.has(candidateShort)) candidateReasons.push("venue_outside_signed_allowlist");
      if (normalized(candidate.asset, ASSET, "carry_migration_candidate_asset") !== asset) candidateReasons.push("asset_mismatch");
      if (identifier(candidate.economic_equivalence_id, "carry_migration_candidate_equivalence") !== economicEquivalenceId) {
        candidateReasons.push("contracts_not_economically_equivalent");
      }
      if (candidate.eligible !== true || candidate.no_submit_ready !== true
        || candidate.transaction_broadcast !== false
        || !Array.isArray(candidate.qualification_reasons)
        || candidate.qualification_reasons.length !== 0) {
        candidateReasons.push("candidate_not_execution_qualified");
      }
      const checkedAt = positiveInteger(candidate.checked_at_ms, "carry_migration_candidate_checked_at");
      if (checkedAt > nowMs || nowMs - checkedAt > mandate.max_data_age_ms) candidateReasons.push("candidate_stale");
      const expectedNet = boundedInteger(
        candidate.expected_net_value_bps,
        -100_000,
        100_000,
        "carry_migration_candidate_net",
      );
      const transitionCost = boundedInteger(
        candidate.transition_cost_bps,
        0,
        10_000,
        "carry_migration_transition_cost",
      );
      const improvement = safeAdd(
        safeAdd(expectedNet, -currentNet, "carry_migration_improvement_overflow"),
        -transitionCost,
        "carry_migration_improvement_overflow",
      );
      if (expectedNet < mandate.min_expected_net_benefit_bps) candidateReasons.push("candidate_net_below_signed_floor");
      if (improvement < minimumImprovement) candidateReasons.push("migration_improvement_below_signed_floor");
      assessments.push({
        candidate_id: candidateId,
        long_venue_id: candidateLong,
        short_venue_id: candidateShort,
        expected_net_value_bps: expectedNet,
        transition_cost_bps: transitionCost,
        projected_improvement_bps: improvement,
        eligible: candidateReasons.length === 0,
        reasons: [...new Set(candidateReasons)],
        checked_at_ms: checkedAt,
      });
    } catch (error) {
      assessments.push({
        candidate_id: `invalid:${index}`,
        eligible: false,
        reasons: [error instanceof CarryModelError ? error.code : "candidate_invalid"],
      });
    }
  }
  const eligible = assessments.filter((candidate) => candidate.eligible).sort((left, right) =>
    right.projected_improvement_bps - left.projected_improvement_bps
    || right.expected_net_value_bps - left.expected_net_value_bps
    || left.candidate_id.localeCompare(right.candidate_id));
  if (eligible.length === 0) reasons.push("no_qualified_migration_candidate");
  return deepFreeze({
    version: 1,
    position_id: positionId,
    proposal_only: true,
    transaction_broadcast: false,
    requires_reconciled_flat_transition: true,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    selected_candidate: reasons.length === 0 ? eligible[0] : null,
    candidates: assessments,
    checked_at_ms: nowMs,
  });
}

export function createCarryPosition(value) {
  const raw = object(value, "carry_position_required");
  exactVersion(raw.version, "carry_position_version");
  const longVenue = venue(raw.long_venue_id, "carry_long_venue");
  const shortVenue = venue(raw.short_venue_id, "carry_short_venue");
  if (longVenue === shortVenue) fail("carry_distinct_venues_required");
  if (!venueSupportsProduct(longVenue, "perp") || !venueSupportsProduct(shortVenue, "perp")) fail("carry_perp_venues_required");
  const nowMs = positiveInteger(raw.now_ms, "carry_position_now");
  const mandate = normalizeCarryRiskMandate(raw.risk_mandate);
  const authorization = normalizeCarryRiskMandateAuthorization(raw.mandate_authorization);
  const signed = authorization.signed_mandate;
  const migrationParentPositionId = raw.migration_parent_position_id === undefined
    ? null
    : identifier(raw.migration_parent_position_id, "carry_migration_parent_position_id");
  const migrationCandidateId = raw.migration_candidate_id === undefined
    ? null
    : identifier(raw.migration_candidate_id, "carry_migration_candidate_id");
  const opportunityEvidenceCommitment = raw.opportunity_evidence_commitment === undefined
    ? null
    : carryOpportunityEvidenceCommitment(raw.opportunity_evidence_commitment);
  if ((migrationParentPositionId === null) !== (migrationCandidateId === null)) {
    fail("carry_migration_lineage_incomplete");
  }
  if (signed.position_id !== raw.position_id
    || signed.mandate_id !== raw.mandate_id
    || signed.asset !== normalized(raw.asset, ASSET, "carry_position_asset")
    || signed.long_venue_id !== longVenue
    || signed.short_venue_id !== shortVenue
    || signed.target_notional_micro_usdc !== raw.target_notional_micro_usdc
    || (signed.opportunity_evidence_commitment ?? null) !== opportunityEvidenceCommitment
    || JSON.stringify(signed.risk_mandate) !== JSON.stringify(mandate)
    || (signed.migration_parent_position_id ?? null) !== migrationParentPositionId
    || (signed.migration_candidate_id ?? null) !== migrationCandidateId) {
    fail("carry_mandate_position_mismatch");
  }
  if (signed.issued_at_ms > nowMs + 300_000) fail("carry_mandate_issued_in_future");
  if (signed.expires_at_ms <= nowMs) fail("carry_mandate_expired");
  return deepFreeze({
    version: 1,
    position_id: identifier(raw.position_id, "carry_position_id"),
    mandate_id: identifier(raw.mandate_id, "carry_mandate_id"),
    asset: signed.asset,
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
    target_notional_micro_usdc: positiveInteger(raw.target_notional_micro_usdc, "carry_target_notional"),
    ...(opportunityEvidenceCommitment ? {
      opportunity_evidence_commitment: opportunityEvidenceCommitment,
    } : {}),
    long_filled_micro_usdc: 0,
    short_filled_micro_usdc: 0,
    hedge_error_micro_usdc: 0,
    status: "draft",
    risk_mandate: mandate,
    mandate_authorization: authorization,
    ...(migrationParentPositionId ? {
      migration_parent_position_id: migrationParentPositionId,
      migration_candidate_id: migrationCandidateId,
    } : {}),
    consecutive_exit_observations: 0,
    last_observation_as_of_ms: null,
    last_funding_observation_commitment: null,
    last_funding_source_observed_at_ms_by_venue: {},
    last_event_sequence: 0,
    processed_event_ids: [],
    next_actions: ["run_preflight"],
    retry_permitted: false,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    terminal_reason: null,
  });
}

export function advanceCarryPosition({ position: positionInput, event: eventInput, now_ms = Date.now() }) {
  let position;
  try {
    position = mutablePosition(positionInput);
    const event = normalizeEvent(eventInput);
    const nowMs = positiveInteger(now_ms, "carry_event_now");
    if (position.processed_event_ids.includes(event.event_id)) {
      return deepFreeze({ ok: true, duplicate: true, position: deepFreeze(positionInput) });
    }
    if (event.sequence !== position.last_event_sequence + 1) fail("carry_event_sequence_invalid");
    if (position.status === "reconciled" || position.status === "manual_intervention") fail("carry_position_terminal");
    applyEvent(position, event, nowMs);
    position.last_event_sequence = event.sequence;
    position.processed_event_ids.push(event.event_id);
    if (position.processed_event_ids.length > 256) position.processed_event_ids.shift();
    position.updated_at_ms = nowMs;
    return deepFreeze({ ok: true, duplicate: false, position: deepFreeze(position) });
  } catch (error) {
    return deepFreeze({ ok: false, error: error instanceof CarryModelError ? error.code : "carry_event_invalid", position: positionInput });
  }
}

export function createCarryValueLedger(value) {
  const raw = object(value, "carry_value_ledger_required");
  exactVersion(raw.version, "carry_value_ledger_version");
  const modeled = object(raw.modeled, "carry_value_modeled_required");
  const grossFunding = signedInteger(modeled.gross_funding_micro_usdc, "carry_value_modeled_funding");
  const tradingCost = nonNegativeInteger(modeled.trading_cost_micro_usdc, "carry_value_modeled_trading_cost");
  const capitalCost = nonNegativeInteger(modeled.capital_cost_micro_usdc, "carry_value_modeled_capital_cost");
  const riskBuffer = nonNegativeInteger(modeled.risk_buffer_micro_usdc, "carry_value_modeled_risk_buffer");
  const modeledNet = safeAdd(
    grossFunding,
    -safeAdd(safeAdd(tradingCost, capitalCost, "carry_value_modeled_cost_overflow"), riskBuffer, "carry_value_modeled_cost_overflow"),
    "carry_value_modeled_net_overflow",
  );
  const breakdown = normalizeModeledValueBreakdown(modeled, grossFunding, tradingCost);
  const modeledValue = {
    gross_funding_micro_usdc: grossFunding,
    trading_cost_micro_usdc: tradingCost,
    capital_cost_micro_usdc: capitalCost,
    risk_buffer_micro_usdc: riskBuffer,
    net_value_micro_usdc: modeledNet,
    ...breakdown,
  };
  return deepFreeze({
    version: 1,
    position_id: identifier(raw.position_id, "carry_value_position_id"),
    currency: "USDC",
    status: "open",
    modeled: modeledValue,
    realized: emptyRealizedValue(modeledValue),
    entries: [],
    processed_entry_ids: [],
    processed_claim_ids: [],
    last_sequence: 0,
    created_at_ms: positiveInteger(raw.now_ms, "carry_value_created_at"),
    updated_at_ms: positiveInteger(raw.now_ms, "carry_value_updated_at"),
    finalized_at_ms: null,
    finalization_evidence: null,
  });
}

export function normalizeCarryLifecycleValueAttribution(value) {
  const raw = object(value, "carry_lifecycle_value_attribution_required");
  const modeledRaw = object(raw.modeled, "carry_lifecycle_value_modeled_required");
  const realizedRaw = object(raw.realized, "carry_lifecycle_value_realized_required");
  const modeled = {
    gross_funding_micro_usdc: signedInteger(
      modeledRaw.gross_funding_micro_usdc,
      "carry_lifecycle_value_modeled_gross_funding_invalid",
    ),
    total_cost_micro_usdc: nonNegativeInteger(
      modeledRaw.total_cost_micro_usdc,
      "carry_lifecycle_value_modeled_total_cost_invalid",
    ),
    expected_net_micro_usdc: signedInteger(
      modeledRaw.expected_net_micro_usdc,
      "carry_lifecycle_value_modeled_expected_net_invalid",
    ),
  };
  const realized = {
    contract_pnl_micro_usdc: signedInteger(
      realizedRaw.contract_pnl_micro_usdc,
      "carry_lifecycle_value_realized_contract_pnl_invalid",
    ),
    funding_micro_usdc: signedInteger(
      realizedRaw.funding_micro_usdc,
      "carry_lifecycle_value_realized_funding_invalid",
    ),
    fees_micro_usdc: nonNegativeInteger(
      realizedRaw.fees_micro_usdc,
      "carry_lifecycle_value_realized_fees_invalid",
    ),
    slippage_micro_usdc: nonNegativeInteger(
      realizedRaw.slippage_micro_usdc,
      "carry_lifecycle_value_realized_slippage_invalid",
    ),
    gas_micro_usdc: nonNegativeInteger(
      realizedRaw.gas_micro_usdc,
      "carry_lifecycle_value_realized_gas_invalid",
    ),
    capital_cost_micro_usdc: nonNegativeInteger(
      realizedRaw.capital_cost_micro_usdc,
      "carry_lifecycle_value_realized_capital_cost_invalid",
    ),
    transfer_fees_micro_usdc: nonNegativeInteger(
      realizedRaw.transfer_fees_micro_usdc,
      "carry_lifecycle_value_realized_transfer_fees_invalid",
    ),
    rebates_micro_usdc: nonNegativeInteger(
      realizedRaw.rebates_micro_usdc,
      "carry_lifecycle_value_realized_rebates_invalid",
    ),
    net_value_micro_usdc: signedInteger(
      realizedRaw.net_value_micro_usdc,
      "carry_lifecycle_value_realized_net_invalid",
    ),
  };
  const modeledNet = safeAdd(
    modeled.gross_funding_micro_usdc,
    -modeled.total_cost_micro_usdc,
    "carry_lifecycle_value_modeled_overflow",
  );
  if (modeledNet !== modeled.expected_net_micro_usdc) {
    fail("carry_lifecycle_value_modeled_mismatch");
  }
  let realizedCost = 0;
  for (const cost of [
    realized.fees_micro_usdc,
    realized.slippage_micro_usdc,
    realized.gas_micro_usdc,
    realized.capital_cost_micro_usdc,
    realized.transfer_fees_micro_usdc,
    -realized.rebates_micro_usdc,
  ]) {
    realizedCost = safeAdd(realizedCost, cost, "carry_lifecycle_value_realized_cost_overflow");
  }
  const realizedGross = safeAdd(
    realized.contract_pnl_micro_usdc,
    realized.funding_micro_usdc,
    "carry_lifecycle_value_realized_gross_overflow",
  );
  const realizedNet = safeAdd(
    realizedGross,
    -realizedCost,
    "carry_lifecycle_value_realized_net_overflow",
  );
  if (realizedNet !== realized.net_value_micro_usdc) {
    fail("carry_lifecycle_value_realized_mismatch");
  }
  const variance = signedInteger(
    raw.variance_from_modeled_micro_usdc,
    "carry_lifecycle_value_variance_invalid",
  );
  const expectedVariance = safeAdd(
    realized.net_value_micro_usdc,
    -modeled.expected_net_micro_usdc,
    "carry_lifecycle_value_variance_overflow",
  );
  if (variance !== expectedVariance) fail("carry_lifecycle_value_variance_mismatch");
  return deepFreeze({
    modeled,
    realized,
    realized_total_cost_micro_usdc: realizedCost,
    variance_from_modeled_micro_usdc: variance,
  });
}

export function appendCarryValueLedgerEntry({ ledger: ledgerInput, entry: entryInput, now_ms = Date.now() }) {
  try {
    const ledger = mutableValueLedger(ledgerInput);
    if (ledger.status !== "open") fail("carry_value_ledger_finalized");
    const entry = normalizeValueEntry(entryInput);
    const nowMs = positiveInteger(now_ms, "carry_value_entry_now");
    if (ledger.processed_entry_ids.includes(entry.entry_id)) {
      const existing = ledger.entries.find((item) => item.entry_id === entry.entry_id);
      if (!existing || !sameValueEntryClaim(existing, entry)) fail("carry_value_entry_replay_mismatch");
      return deepFreeze({ ok: true, duplicate: true, ledger: deepFreeze(ledgerInput) });
    }
    if (entry.entry_type === "funding"
      && (entry.cashflow_valuation.observed_at_ms > nowMs + 5_000
        || entry.cashflow_valuation.expires_at_ms <= nowMs)) {
      fail("carry_value_funding_valuation_stale");
    }
    if (entry.entry_type === "funding" && entry.valued_at_ms !== nowMs) {
      fail("carry_value_funding_valued_at_mismatch");
    }
    const claimId = valueClaimId(entry);
    if (ledger.processed_claim_ids.includes(claimId)) fail("carry_value_evidence_claim_reused");
    if (entry.sequence !== ledger.last_sequence + 1) fail("carry_value_entry_sequence_invalid");
    if (entry.occurred_at_ms > nowMs) fail("carry_value_entry_from_future");
    ledger.entries.push(entry);
    ledger.processed_entry_ids.push(entry.entry_id);
    ledger.processed_claim_ids.push(claimId);
    ledger.last_sequence = entry.sequence;
    ledger.realized = summarizeRealizedValue(ledger.entries, ledger.modeled);
    ledger.updated_at_ms = nowMs;
    return deepFreeze({ ok: true, duplicate: false, ledger: deepFreeze(ledger) });
  } catch (error) {
    return deepFreeze({ ok: false, error: error instanceof CarryModelError ? error.code : "carry_value_entry_invalid", ledger: ledgerInput });
  }
}

export function finalizeCarryValueLedger({ ledger: ledgerInput, evidence: evidenceInput, now_ms = Date.now() }) {
  try {
    const ledger = mutableValueLedger(ledgerInput);
    if (ledger.status !== "open") fail("carry_value_ledger_finalized");
    const evidence = object(evidenceInput, "carry_value_finalization_evidence_required");
    const grossExposure = nonNegativeInteger(evidence.gross_exposure_micro_usdc, "carry_value_final_exposure");
    const openOrderCount = nonNegativeInteger(evidence.open_order_count, "carry_value_final_open_orders");
    if (grossExposure !== 0) fail("carry_value_final_exposure_not_flat");
    if (openOrderCount !== 0) fail("carry_value_final_open_orders_nonzero");
    if (evidence.costs_complete !== true) fail("carry_value_final_costs_incomplete");
    const nowMs = positiveInteger(now_ms, "carry_value_finalized_at");
    ledger.status = "finalized";
    ledger.updated_at_ms = nowMs;
    ledger.finalized_at_ms = nowMs;
    ledger.realized.attribution = summarizeValueAttribution(ledger.modeled, ledger.realized, true);
    ledger.finalization_evidence = {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      reconciliation_commitment: identifier(evidence.reconciliation_commitment, "carry_value_reconciliation_commitment"),
    };
    return deepFreeze({ ok: true, ledger: deepFreeze(ledger) });
  } catch (error) {
    return deepFreeze({ ok: false, error: error instanceof CarryModelError ? error.code : "carry_value_finalization_invalid", ledger: ledgerInput });
  }
}

function applyEvent(position, event, nowMs) {
  if (event.type === "mandate_invalid") {
    requireStatus(position, new Set(["active", "rebalancing", "frozen"]));
    position.status = "exiting";
    position.next_actions = ["reduce_only_close_both_legs"];
    position.retry_permitted = false;
    position.terminal_reason = "risk_mandate_authorization_unverifiable";
    return;
  }
  if (event.type === "observation_unavailable") {
    requireStatus(position, new Set(["active", "rebalancing"]));
    position.status = "frozen";
    position.next_actions = ["reconcile_only"];
    position.retry_permitted = false;
    position.terminal_reason = "observation_unavailable";
    return;
  }
  if (event.type === "submission_ambiguous" || event.type === "restart_detected" || event.type === "recovery_failed") {
    position.status = "frozen";
    position.next_actions = ["reconcile_only"];
    position.retry_permitted = false;
    position.terminal_reason = event.type;
    return;
  }
  if (event.type === "preflight_passed") {
    requireStatus(position, new Set(["draft"]));
    if (event.opportunity_eligible !== true || event.all_venues_ready !== true) fail("carry_preflight_evidence_missing");
    position.status = "opening";
    position.next_actions = ["submit_protected_multi_leg_entry"];
    return;
  }
  if (event.type === "entry_reconciled") {
    requireStatus(position, new Set(["opening", "frozen"]));
    if (position.status === "frozen" && position.terminal_reason !== "restart_detected") {
      fail("carry_event_not_allowed_in_state");
    }
    const longFilled = nonNegativeInteger(event.long_filled_micro_usdc, "carry_long_filled");
    const shortFilled = nonNegativeInteger(event.short_filled_micro_usdc, "carry_short_filled");
    const hedgeError = nonNegativeInteger(event.hedge_error_micro_usdc, "carry_hedge_error");
    position.long_filled_micro_usdc = longFilled;
    position.short_filled_micro_usdc = shortFilled;
    position.hedge_error_micro_usdc = hedgeError;
    if (longFilled === position.target_notional_micro_usdc && shortFilled === position.target_notional_micro_usdc && hedgeError <= position.risk_mandate.max_hedge_error_micro_usdc) {
      position.status = "active";
      position.next_actions = ["monitor_carry_and_margin"];
      position.terminal_reason = null;
    } else {
      position.status = "exiting";
      position.next_actions = ["cancel_open_orders", "reduce_only_close_filled_exposure"];
      position.terminal_reason = "entry_hedge_mismatch";
    }
    return;
  }
  if (event.type === "entry_failed_no_fill") {
    requireStatus(position, new Set(["opening"]));
    position.status = "reconciled";
    position.next_actions = [];
    position.terminal_reason = "entry_failed_no_fill";
    return;
  }
  if (event.type === "observation") {
    requireStatus(position, new Set(["active", "rebalancing"]));
    const mandateExpiresAt = position.mandate_authorization?.signed_mandate?.expires_at_ms;
    if (!Number.isSafeInteger(mandateExpiresAt) || mandateExpiresAt <= nowMs) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      position.terminal_reason = Number.isSafeInteger(mandateExpiresAt)
        ? "risk_mandate_expired"
        : "risk_mandate_authorization_unverifiable";
      return;
    }
    const asOf = positiveInteger(event.as_of_ms, "carry_observation_as_of");
    if (asOf > nowMs || nowMs - asOf > position.risk_mandate.max_data_age_ms) {
      position.status = "frozen";
      position.next_actions = ["reconcile_only"];
      position.retry_permitted = false;
      position.terminal_reason = "observation_stale";
      return;
    }
    const previousObservationAsOf = Number.isSafeInteger(position.last_observation_as_of_ms)
      ? position.last_observation_as_of_ms
      : null;
    if (previousObservationAsOf !== null && asOf < previousObservationAsOf) {
      position.status = "frozen";
      position.next_actions = ["reconcile_only"];
      position.retry_permitted = false;
      position.terminal_reason = "observation_time_regressed";
      return;
    }
    const contractDataSkewMs = event.contract_data_skew_ms;
    const indexPriceDivergenceBps = event.index_price_divergence_bps;
    const markPriceDivergenceBps = event.mark_price_divergence_bps;
    const observedMaxContractDataSkewMs = event.max_contract_data_skew_ms;
    const observedMaxIndexPriceDivergenceBps = event.max_index_price_divergence_bps;
    const observedMaxMarkPriceDivergenceBps = event.max_mark_price_divergence_bps;
    if (![contractDataSkewMs, indexPriceDivergenceBps, markPriceDivergenceBps,
      observedMaxContractDataSkewMs, observedMaxIndexPriceDivergenceBps, observedMaxMarkPriceDivergenceBps]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) {
      position.status = "frozen";
      position.next_actions = ["reconcile_only"];
      position.retry_permitted = false;
      position.terminal_reason = "contract_equivalence_unverifiable";
      return;
    }
    const maxContractDataSkewMs = Math.min(
      position.risk_mandate.max_contract_data_skew_ms ?? 2_000,
      observedMaxContractDataSkewMs,
    );
    const maxIndexPriceDivergenceBps = Math.min(
      position.risk_mandate.max_index_price_divergence_bps ?? 25,
      observedMaxIndexPriceDivergenceBps,
    );
    const maxMarkPriceDivergenceBps = Math.min(
      position.risk_mandate.max_mark_price_divergence_bps ?? 50,
      observedMaxMarkPriceDivergenceBps,
    );
    if (contractDataSkewMs > maxContractDataSkewMs) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      position.terminal_reason = "contract_data_skew_outside_mandate";
      return;
    }
    if (indexPriceDivergenceBps > maxIndexPriceDivergenceBps
      || markPriceDivergenceBps > maxMarkPriceDivergenceBps) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      position.terminal_reason = "contract_basis_outside_mandate";
      return;
    }
    const runways = object(event.margin_runway_ms_by_venue, "carry_observation_runways");
    const statuses = event.margin_runway_status_by_venue === undefined
      ? null
      : object(event.margin_runway_status_by_venue, "carry_observation_runway_statuses");
    let unverifiableMargin = false;
    const unsafeMargin = [position.long_venue_id, position.short_venue_id].some((venueId) => {
      if (!Object.hasOwn(runways, venueId)) {
        unverifiableMargin = true;
        return false;
      }
      const runway = runways[venueId];
      const rawStatus = statuses?.[venueId];
      const status = rawStatus === undefined
        ? null
        : enumValue(rawStatus, new Set(["healthy", "warning", "critical", "breached"]), "carry_observation_runway_status");
      if (status === null) {
        unverifiableMargin = true;
        return false;
      }
      if (runway === null) {
        if (status !== "healthy") unverifiableMargin = true;
        return false;
      }
      const normalizedRunway = nonNegativeInteger(runway, "carry_observation_runway");
      return status === "critical" || status === "breached" || normalizedRunway < position.risk_mandate.min_margin_runway_ms;
    });
    if (unverifiableMargin) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      position.terminal_reason = "margin_runway_unverifiable";
      return;
    }
    if (unsafeMargin) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      position.terminal_reason = "margin_runway_below_mandate";
      return;
    }
    const netCarryBps = boundedInteger(event.expected_net_value_bps, -100_000, 100_000, "carry_observation_net_value");
    const fundingCommitment = typeof event.funding_observation_commitment === "string"
      && CURRENT_FUNDING_OBSERVATION.test(event.funding_observation_commitment)
      ? event.funding_observation_commitment
      : null;
    let fundingSources = null;
    try {
      const rawSources = object(
        event.funding_source_observed_at_ms_by_venue,
        "carry_observation_funding_sources",
      );
      const venueIds = [position.long_venue_id, position.short_venue_id];
      if (Object.keys(rawSources).length !== venueIds.length
        || !venueIds.every((venueId) => Object.hasOwn(rawSources, venueId))) {
        fail("carry_observation_funding_sources_unbound");
      }
      fundingSources = Object.fromEntries(venueIds.map((venueId) => {
        const sourceAsOf = positiveInteger(
          rawSources[venueId],
          "carry_observation_funding_source_as_of",
        );
        if (sourceAsOf > asOf || asOf - sourceAsOf > position.risk_mandate.max_data_age_ms) {
          fail("carry_observation_funding_source_stale");
        }
        return [venueId, sourceAsOf];
      }));
    } catch {
      fundingSources = null;
    }
    if (!fundingCommitment || !fundingSources) {
      position.status = "frozen";
      position.next_actions = ["reconcile_only"];
      position.retry_permitted = false;
      position.terminal_reason = "funding_observation_unverifiable";
      return;
    }
    const previousFundingSources = position.last_funding_source_observed_at_ms_by_venue
      && typeof position.last_funding_source_observed_at_ms_by_venue === "object"
      && !Array.isArray(position.last_funding_source_observed_at_ms_by_venue)
      && [position.long_venue_id, position.short_venue_id].every((venueId) =>
        Number.isSafeInteger(position.last_funding_source_observed_at_ms_by_venue[venueId]))
      ? position.last_funding_source_observed_at_ms_by_venue
      : null;
    if (previousFundingSources) {
      const venueIds = [position.long_venue_id, position.short_venue_id];
      const sourceRegressed = venueIds.some((venueId) =>
        fundingSources[venueId] < previousFundingSources[venueId]);
      const sameSources = venueIds.every((venueId) =>
        fundingSources[venueId] === previousFundingSources[venueId]);
      const sameCommitment = fundingCommitment === position.last_funding_observation_commitment;
      if (sourceRegressed
        || (sameSources && !sameCommitment)
        || (!sameSources && sameCommitment)
        || (previousObservationAsOf === asOf && !sameSources)) {
        position.status = "frozen";
        position.next_actions = ["reconcile_only"];
        position.retry_permitted = false;
        position.terminal_reason = sourceRegressed
          ? "funding_observation_time_regressed"
          : "funding_observation_evidence_mismatch";
        return;
      }
      if (sameSources) {
        position.status = "active";
        position.next_actions = ["monitor_carry_and_margin"];
        return;
      }
    }
    if (previousObservationAsOf === asOf) {
      position.status = "active";
      position.next_actions = ["monitor_carry_and_margin"];
      return;
    }
    position.last_observation_as_of_ms = asOf;
    position.last_funding_observation_commitment = fundingCommitment;
    position.last_funding_source_observed_at_ms_by_venue = fundingSources;
    position.consecutive_exit_observations = netCarryBps <= position.risk_mandate.exit_net_value_bps
      ? position.consecutive_exit_observations + 1
      : 0;
    if (position.consecutive_exit_observations >= position.risk_mandate.exit_after_consecutive_observations) {
      position.status = "exiting";
      position.next_actions = ["reduce_only_close_both_legs"];
      const migration = migrationProposalFromObservation(position, event, nowMs);
      if (migration?.eligible === true) {
        position.pending_migration = {
          status: "awaiting_flat_exit",
          proposal_only: true,
          transaction_broadcast: false,
          selected_candidate: migration.selected_candidate,
          checked_at_ms: migration.checked_at_ms,
        };
        position.terminal_reason = "carry_below_exit_threshold_migration_proposed";
      } else {
        position.terminal_reason = "carry_below_exit_threshold";
      }
    } else {
      position.status = "active";
      position.next_actions = ["monitor_carry_and_margin"];
    }
    return;
  }
  if (event.type === "manual_exit_requested") {
    requireStatus(position, new Set(["active", "rebalancing", "frozen"]));
    position.status = "exiting";
    position.next_actions = ["reduce_only_close_both_legs"];
    position.terminal_reason = "owner_exit_requested";
    return;
  }
  if (event.type === "reconciliation_complete") {
    requireStatus(position, new Set(["frozen"]));
    if (event.known_flat === true && nonNegativeInteger(event.open_order_count, "carry_reconcile_open_orders") === 0) {
      position.long_filled_micro_usdc = 0;
      position.short_filled_micro_usdc = 0;
      position.hedge_error_micro_usdc = 0;
      position.status = "reconciled";
      position.next_actions = [];
      position.terminal_reason = "reconciled_flat";
    } else {
      position.status = "exiting";
      position.next_actions = ["cancel_open_orders", "reduce_only_close_observed_exposure"];
    }
    return;
  }
  if (event.type === "exit_reconciled") {
    requireStatus(position, new Set(["exiting"]));
    const grossExposure = nonNegativeInteger(event.gross_exposure_micro_usdc, "carry_exit_gross_exposure");
    const openOrders = nonNegativeInteger(event.open_order_count, "carry_exit_open_orders");
    if (grossExposure === 0 && openOrders === 0) {
      position.long_filled_micro_usdc = 0;
      position.short_filled_micro_usdc = 0;
      position.hedge_error_micro_usdc = 0;
      position.status = "reconciled";
      if (position.pending_migration?.status === "awaiting_flat_exit") {
        position.pending_migration.status = "owner_signature_required";
        position.next_actions = ["request_owner_signed_migration"];
        position.terminal_reason = "reconciled_flat_migration_ready";
      } else {
        position.next_actions = [];
        position.terminal_reason = "reconciled_flat";
      }
    } else {
      position.next_actions = ["cancel_open_orders", "reduce_only_close_observed_exposure"];
    }
  }
}

function migrationProposalFromObservation(position, event, nowMs) {
  if (position.risk_mandate.allow_migration !== true
    || !Array.isArray(event.migration_candidates)
    || typeof event.economic_equivalence_id !== "string") return null;
  try {
    return compileCarryMigrationProposal({
      version: 1,
      position,
      mandate_authorization: position.mandate_authorization,
      economic_equivalence_id: event.economic_equivalence_id,
      current_expected_net_value_bps: event.expected_net_value_bps,
      candidates: event.migration_candidates,
      now_ms: nowMs,
    });
  } catch {
    return null;
  }
}

export function normalizeCarryRiskMandate(value) {
  const raw = object(value, "carry_risk_mandate_required");
  const maxDataAgeMs = boundedInteger(raw.max_data_age_ms, 250, 300_000, "carry_mandate_data_age");
  return deepFreeze({
    min_expected_net_benefit_bps: boundedInteger(raw.min_expected_net_benefit_bps, 0, 10_000, "carry_mandate_minimum_net"),
    exit_net_value_bps: boundedInteger(raw.exit_net_value_bps, -10_000, 10_000, "carry_mandate_exit_net"),
    exit_after_consecutive_observations: boundedInteger(raw.exit_after_consecutive_observations, 1, 100, "carry_mandate_exit_observations"),
    min_margin_runway_ms: boundedInteger(raw.min_margin_runway_ms, 0, 366 * DAY_MS, "carry_mandate_margin_runway"),
    max_hedge_error_micro_usdc: nonNegativeInteger(raw.max_hedge_error_micro_usdc, "carry_mandate_hedge_error"),
    max_data_age_ms: maxDataAgeMs,
    ...(raw.max_contract_data_skew_ms === undefined ? {} : {
      max_contract_data_skew_ms: boundedInteger(raw.max_contract_data_skew_ms, 0, maxDataAgeMs, "carry_mandate_contract_data_skew"),
    }),
    ...(raw.max_index_price_divergence_bps === undefined ? {} : {
      max_index_price_divergence_bps: boundedInteger(raw.max_index_price_divergence_bps, 0, 10_000, "carry_mandate_index_price_divergence"),
    }),
    ...(raw.max_mark_price_divergence_bps === undefined ? {} : {
      max_mark_price_divergence_bps: boundedInteger(raw.max_mark_price_divergence_bps, 0, 10_000, "carry_mandate_mark_price_divergence"),
    }),
    ...(raw.min_migration_improvement_bps === undefined ? {} : {
      min_migration_improvement_bps: boundedInteger(raw.min_migration_improvement_bps, 0, 10_000, "carry_mandate_migration_improvement"),
    }),
    ...(raw.migration_venue_allowlist === undefined ? {} : {
      migration_venue_allowlist: Object.freeze([...new Set(array(
        raw.migration_venue_allowlist,
        "carry_mandate_migration_venues",
        0,
        16,
      ).map((venueId) => carryExecutionVenue(venueId, "carry_mandate_migration_venue")))]),
    }),
    allow_migration: raw.allow_migration === true,
    owner_only_operations: Object.freeze(["fund", "withdraw", "transfer"]),
  });
}

export function normalizeCarryRiskMandatePayload(value) {
  const raw = object(value, "carry_signed_mandate_required");
  exactVersion(raw.version, "carry_signed_mandate_version");
  if (raw.kind !== "ghola_carry_risk_mandate") fail("carry_signed_mandate_kind");
  if (raw.strategy_id !== "delta_neutral_carry_v1") fail("carry_signed_mandate_strategy");
  const ownerWalletAddress = String(raw.owner_wallet_address || "").trim().toLowerCase();
  if (!ETH_ADDRESS.test(ownerWalletAddress)) fail("carry_signed_mandate_owner_wallet");
  const issuedAtMs = positiveInteger(raw.issued_at_ms, "carry_signed_mandate_issued_at");
  const expiresAtMs = positiveInteger(raw.expires_at_ms, "carry_signed_mandate_expires_at");
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > 367 * DAY_MS) {
    fail("carry_signed_mandate_expiry");
  }
  const longVenue = venue(raw.long_venue_id, "carry_signed_mandate_long_venue");
  const shortVenue = venue(raw.short_venue_id, "carry_signed_mandate_short_venue");
  if (longVenue === shortVenue) fail("carry_signed_mandate_distinct_venues");
  const migrationParentPositionId = raw.migration_parent_position_id === undefined
    ? null
    : identifier(raw.migration_parent_position_id, "carry_signed_mandate_migration_parent");
  const migrationCandidateId = raw.migration_candidate_id === undefined
    ? null
    : identifier(raw.migration_candidate_id, "carry_signed_mandate_migration_candidate");
  const opportunityEvidenceCommitment = raw.opportunity_evidence_commitment === undefined
    ? null
    : carryOpportunityEvidenceCommitment(raw.opportunity_evidence_commitment);
  if ((migrationParentPositionId === null) !== (migrationCandidateId === null)) {
    fail("carry_signed_mandate_migration_lineage_incomplete");
  }
  return deepFreeze({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: enumValue(raw.network, new Set(["paper", "testnet", "mainnet"]), "carry_signed_mandate_network"),
    owner_commitment: identifier(raw.owner_commitment, "carry_signed_mandate_owner"),
    owner_wallet_address: ownerWalletAddress,
    position_id: identifier(raw.position_id, "carry_signed_mandate_position"),
    mandate_id: identifier(raw.mandate_id, "carry_signed_mandate_id"),
    asset: normalized(raw.asset, ASSET, "carry_signed_mandate_asset"),
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
    target_notional_micro_usdc: positiveInteger(raw.target_notional_micro_usdc, "carry_signed_mandate_notional"),
    ...(opportunityEvidenceCommitment ? {
      opportunity_evidence_commitment: opportunityEvidenceCommitment,
    } : {}),
    risk_mandate: normalizeCarryRiskMandate(raw.risk_mandate),
    ...(migrationParentPositionId ? {
      migration_parent_position_id: migrationParentPositionId,
      migration_candidate_id: migrationCandidateId,
    } : {}),
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
  });
}

export function carryRiskMandateMessage(value) {
  return `Ghola Carry risk mandate v1\n${JSON.stringify(normalizeCarryRiskMandatePayload(value))}`;
}

export function normalizeCarryRiskMandateAuthorization(value) {
  const raw = object(value, "carry_mandate_authorization_required");
  exactVersion(raw.version, "carry_mandate_authorization_version");
  const signature = String(raw.signature || "").trim().toLowerCase();
  const mandateCommitment = String(raw.mandate_commitment || "").trim().toLowerCase();
  if (!ETH_SIGNATURE.test(signature)) fail("carry_mandate_signature_invalid");
  if (!ETH_COMMITMENT.test(mandateCommitment)) fail("carry_mandate_commitment_invalid");
  return deepFreeze({
    version: 1,
    signed_mandate: normalizeCarryRiskMandatePayload(raw.signed_mandate),
    signature,
    mandate_commitment: mandateCommitment,
  });
}

function normalizeLegCosts(value, defaultFeeE6Bps) {
  const raw = object(value, "carry_leg_costs_required");
  const entryFeeE6Bps = raw.entry_fee_e6_bps === undefined
    ? (raw.entry_fee_bps === undefined ? defaultFeeE6Bps : boundedInteger(raw.entry_fee_bps, 0, 10_000, "carry_entry_fee") * 1_000_000)
    : boundedInteger(raw.entry_fee_e6_bps, 0, 10_000_000_000, "carry_entry_fee_e6");
  const exitFeeE6Bps = raw.exit_fee_e6_bps === undefined
    ? (raw.exit_fee_bps === undefined ? defaultFeeE6Bps : boundedInteger(raw.exit_fee_bps, 0, 10_000, "carry_exit_fee") * 1_000_000)
    : boundedInteger(raw.exit_fee_e6_bps, 0, 10_000_000_000, "carry_exit_fee_e6");
  const entrySlippageE6Bps = raw.entry_slippage_e6_bps === undefined
    ? boundedInteger(raw.entry_slippage_bps, 0, 10_000, "carry_entry_slippage") * 1_000_000
    : boundedInteger(raw.entry_slippage_e6_bps, 0, 10_000_000_000, "carry_entry_slippage_e6");
  const exitSlippageE6Bps = raw.exit_slippage_e6_bps === undefined
    ? boundedInteger(raw.exit_slippage_bps, 0, 10_000, "carry_exit_slippage") * 1_000_000
    : boundedInteger(raw.exit_slippage_e6_bps, 0, 10_000_000_000, "carry_exit_slippage_e6");
  return {
    entry_fee_e6_bps: entryFeeE6Bps,
    exit_fee_e6_bps: exitFeeE6Bps,
    entry_slippage_e6_bps: entrySlippageE6Bps,
    exit_slippage_e6_bps: exitSlippageE6Bps,
    latency_penalty_bps: boundedInteger(raw.latency_penalty_bps ?? 0, 0, 10_000, "carry_latency_penalty"),
    gas_micro_usdc: nonNegativeInteger(raw.gas_micro_usdc ?? 0, "carry_gas"),
  };
}

function normalizeMarginRunwayResult(value) {
  const raw = object(value, "carry_margin_runway_invalid");
  const positionOpen = raw.position_open !== false;
  const liquidationDistanceVerified = raw.liquidation_distance_verified === true;
  const liquidationDistance = raw.liquidation_distance_bps === null
    ? null
    : boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "carry_margin_runway_liquidation_distance");
  const liquidationDistanceSource = raw.liquidation_distance_source === null
    ? null
    : identifier(raw.liquidation_distance_source, "carry_margin_runway_liquidation_source");
  return deepFreeze({
    venue_id: venue(raw.venue_id, "carry_margin_runway_venue"),
    status: enumValue(raw.status, new Set(["healthy", "warning", "critical", "breached"]), "carry_margin_runway_status"),
    runway_ms: raw.runway_ms === null ? null : nonNegativeInteger(raw.runway_ms, "carry_margin_runway_ms"),
    position_open: positionOpen,
    liquidation_distance_bps: liquidationDistance,
    liquidation_distance_verified: positionOpen && liquidationDistanceVerified && liquidationDistanceSource !== null,
    liquidation_distance_source: liquidationDistanceSource,
  });
}

function normalizeCapitalRunwayEvidence(value) {
  const raw = object(value, "carry_capital_runway_invalid");
  if (raw.automatic_transfer_permitted !== false) fail("carry_capital_automatic_transfer_forbidden");
  const headroom = nonNegativeInteger(raw.margin_headroom_micro_usdc, "carry_capital_runway_headroom");
  const burn = nonNegativeInteger(raw.stress_burn_micro_usdc_per_hour, "carry_capital_runway_burn");
  const runwayMs = raw.runway_ms === null ? null : nonNegativeInteger(raw.runway_ms, "carry_capital_runway_ms");
  const expectedRunwayMs = burn === 0
    ? null
    : safeNumber((BigInt(headroom) * BigInt(HOUR_MS)) / BigInt(burn));
  if (runwayMs !== expectedRunwayMs) fail("carry_capital_runway_inconsistent");
  const requiredResponseMs = nonNegativeInteger(raw.required_owner_response_ms, "carry_capital_runway_response");
  const status = enumValue(raw.status, new Set(["healthy", "warning", "critical", "breached"]), "carry_capital_runway_status");
  const positionOpen = raw.position_open !== false;
  const liquidationDistance = raw.liquidation_distance_bps === null
    ? null
    : boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "carry_capital_runway_liquidation_distance");
  const minimumLiquidationDistance = boundedInteger(
    raw.minimum_liquidation_distance_bps,
    0,
    100_000,
    "carry_capital_runway_minimum_liquidation_distance",
  );
  const liquidationDistanceVerified = raw.liquidation_distance_verified === true;
  const liquidationDistanceSource = raw.liquidation_distance_source === null
    ? null
    : identifier(raw.liquidation_distance_source, "carry_capital_runway_liquidation_source");
  const liquidationEvidenceUnsafe = positionOpen
    && (!liquidationDistanceVerified
      || liquidationDistance === null
      || liquidationDistanceSource === null
      || liquidationDistance < minimumLiquidationDistance);
  const minimumStatus = headroom === 0 || liquidationEvidenceUnsafe
    ? "breached"
    : runwayMs !== null && runwayMs <= requiredResponseMs
      ? "critical"
      : runwayMs !== null && runwayMs <= requiredResponseMs * 2
        ? "warning"
        : "healthy";
  const severity = { healthy: 0, warning: 1, critical: 2, breached: 3 };
  if (severity[status] < severity[minimumStatus]) fail("carry_capital_runway_status_inconsistent");
  return Object.freeze({
    venue_id: carryExecutionVenue(raw.venue_id, "carry_capital_runway_venue"),
    account_commitment: identifier(raw.account_commitment, "carry_capital_runway_account"),
    account_state_commitment: identifier(raw.account_state_commitment, "carry_capital_runway_account_state"),
    as_of_ms: positiveInteger(raw.as_of_ms, "carry_capital_runway_as_of"),
    status,
    margin_headroom_micro_usdc: headroom,
    stress_burn_micro_usdc_per_hour: burn,
    runway_ms: runwayMs,
    required_owner_response_ms: requiredResponseMs,
    position_open: positionOpen,
    liquidation_distance_bps: liquidationDistance,
    minimum_liquidation_distance_bps: minimumLiquidationDistance,
    liquidation_distance_verified: positionOpen && liquidationDistanceVerified && liquidationDistanceSource !== null,
    liquidation_distance_source: liquidationDistanceSource,
  });
}

function mutablePosition(value) {
  const raw = object(value, "existing_carry_position_required");
  exactVersion(raw.version, "existing_carry_position_version");
  enumValue(raw.status, POSITION_STATUSES, "existing_carry_position_status");
  array(raw.processed_event_ids, "existing_carry_event_ids", 0, 256);
  return JSON.parse(JSON.stringify(raw));
}

function normalizeEvent(value) {
  const raw = object(value, "carry_event_required");
  exactVersion(raw.version, "carry_event_version");
  return {
    ...raw,
    event_id: identifier(raw.event_id, "carry_event_id"),
    sequence: positiveInteger(raw.sequence, "carry_event_sequence"),
    type: enumValue(raw.type, EVENT_TYPES, "carry_event_type"),
  };
}

function mutableValueLedger(value) {
  const raw = object(value, "existing_carry_value_ledger_required");
  exactVersion(raw.version, "existing_carry_value_ledger_version");
  enumValue(raw.status, new Set(["open", "finalized"]), "existing_carry_value_ledger_status");
  array(raw.entries, "existing_carry_value_entries", 0, 4_096);
  array(raw.processed_entry_ids, "existing_carry_value_entry_ids", 0, 4_096);
  const mutable = JSON.parse(JSON.stringify(raw));
  mutable.processed_claim_ids = raw.processed_claim_ids === undefined
    ? raw.entries.map((entry) => valueClaimId(normalizeValueEntry(entry)))
    : [...array(raw.processed_claim_ids, "existing_carry_value_claim_ids", 0, 4_096)];
  if (new Set(mutable.processed_claim_ids).size !== mutable.processed_claim_ids.length) {
    fail("existing_carry_value_claim_ids_duplicate");
  }
  return mutable;
}

function normalizeValueEntry(value) {
  const raw = object(value, "carry_value_entry_required");
  const entryType = enumValue(raw.entry_type, VALUE_ENTRY_TYPES, "carry_value_entry_type");
  const direction = enumValue(raw.direction, new Set(["credit", "debit"]), "carry_value_entry_direction");
  if (DEBIT_ONLY_VALUE_ENTRY_TYPES.has(entryType) && direction !== "debit") {
    fail("carry_value_cost_must_be_debit");
  }
  if (CREDIT_ONLY_VALUE_ENTRY_TYPES.has(entryType) && direction !== "credit") {
    fail("carry_value_rebate_must_be_credit");
  }
  const normalizedEntry = {
    version: 1,
    entry_id: identifier(raw.entry_id, "carry_value_entry_id"),
    sequence: positiveInteger(raw.sequence, "carry_value_entry_sequence"),
    entry_type: entryType,
    direction,
    amount_micro_usdc: nonNegativeInteger(raw.amount_micro_usdc, "carry_value_entry_amount"),
    venue_id: raw.venue_id == null ? null : venue(raw.venue_id, "carry_value_entry_venue"),
    leg_id: raw.leg_id == null ? null : identifier(raw.leg_id, "carry_value_entry_leg_id"),
    occurred_at_ms: positiveInteger(raw.occurred_at_ms, "carry_value_entry_occurred_at"),
    evidence_commitment: identifier(raw.evidence_commitment, "carry_value_entry_evidence"),
  };
  if (entryType !== "funding") return normalizedEntry;
  const sourceAmountMicro = signedInteger(
    raw.source_amount_micro,
    "carry_value_funding_source_amount",
  );
  const sourceAsset = enumValue(
    normalized(raw.source_asset, ASSET, "carry_value_funding_source_asset"),
    USD_STABLE_QUOTES,
    "carry_value_funding_source_asset",
  );
  const valuedAtMs = positiveInteger(raw.valued_at_ms, "carry_value_funding_valued_at");
  if (normalizedEntry.occurred_at_ms > valuedAtMs) fail("carry_value_funding_valued_before_occurrence");
  if ((sourceAmountMicro > 0 && direction !== "credit")
    || (sourceAmountMicro < 0 && direction !== "debit")) {
    fail("carry_value_funding_source_direction_mismatch");
  }
  const cashflowValuation = normalizeCashflowValuation(raw.cashflow_valuation);
  if (cashflowValuation.source_asset !== sourceAsset) {
    fail("carry_value_funding_valuation_asset_mismatch");
  }
  if (sourceAsset !== "USDC"
    && cashflowValuation.bound_source_amount_micro !== sourceAmountMicro) {
    fail("carry_value_funding_valuation_amount_mismatch");
  }
  const sourceAmountDecimal = typeof raw.source_amount_decimal === "string"
    && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.source_amount_decimal)
    ? raw.source_amount_decimal
    : fail("carry_value_funding_source_decimal");
  const sourceAmountScale = nonNegativeInteger(
    raw.source_amount_scale,
    "carry_value_funding_source_scale",
  );
  if (sourceAmountScale > 30
    || (sourceAmountDecimal.split(".")[1]?.length || 0) !== sourceAmountScale) {
    fail("carry_value_funding_source_scale");
  }
  const convertedAmountMicroUsdc = convertSignedCashflowToMicroUsdc({
    amount_micro: sourceAmountMicro,
    valuation: cashflowValuation,
  });
  if (Math.abs(convertedAmountMicroUsdc) !== normalizedEntry.amount_micro_usdc
    || (convertedAmountMicroUsdc > 0 && direction !== "credit")
    || (convertedAmountMicroUsdc < 0 && direction !== "debit")) {
    fail("carry_value_funding_conversion_mismatch");
  }
  return {
    ...normalizedEntry,
    source_amount_micro: sourceAmountMicro,
    source_amount_decimal: sourceAmountDecimal,
    source_amount_scale: sourceAmountScale,
    source_asset: sourceAsset,
    valued_at_ms: valuedAtMs,
    cashflow_valuation: cashflowValuation,
  };
}

function normalizePortfolioValuePosition(value) {
  const raw = object(value, "carry_portfolio_value_position_required");
  const positionId = identifier(raw.position_id, "carry_portfolio_value_position_id");
  const positionStatus = enumValue(
    raw.position_status,
    POSITION_STATUSES,
    "carry_portfolio_value_position_status",
  );
  const targetNotional = positiveInteger(
    raw.target_notional_micro_usdc,
    "carry_portfolio_value_position_notional",
  );
  const ledger = object(raw.value_ledger, "carry_portfolio_value_ledger_required");
  exactVersion(ledger.version, "carry_portfolio_value_ledger_version");
  if (identifier(ledger.position_id, "carry_portfolio_value_ledger_position_id") !== positionId) {
    fail("carry_portfolio_value_ledger_position_mismatch");
  }
  const ledgerStatus = enumValue(
    ledger.status,
    new Set(["open", "finalized"]),
    "carry_portfolio_value_ledger_status",
  );
  if ((ledgerStatus === "finalized") !== (positionStatus === "reconciled")) {
    fail("carry_portfolio_value_finalization_status_mismatch");
  }
  const rawModeled = object(ledger.modeled, "carry_portfolio_value_modeled_required");
  const modeledGrossFunding = signedInteger(
    rawModeled.gross_funding_micro_usdc,
    "carry_portfolio_value_modeled_funding",
  );
  const modeledTradingCost = nonNegativeInteger(
    rawModeled.trading_cost_micro_usdc,
    "carry_portfolio_value_modeled_trading_cost",
  );
  const modeledCapitalCost = nonNegativeInteger(
    rawModeled.capital_cost_micro_usdc,
    "carry_portfolio_value_modeled_capital_cost",
  );
  const modeledRiskBuffer = nonNegativeInteger(
    rawModeled.risk_buffer_micro_usdc,
    "carry_portfolio_value_modeled_risk_buffer",
  );
  const modeledNet = signedInteger(rawModeled.net_value_micro_usdc, "carry_portfolio_value_modeled_net");
  const expectedModeledNet = safeAdd(
    modeledGrossFunding,
    -safeAdd(
      safeAdd(modeledTradingCost, modeledCapitalCost, "carry_portfolio_value_modeled_overflow"),
      modeledRiskBuffer,
      "carry_portfolio_value_modeled_overflow",
    ),
    "carry_portfolio_value_modeled_overflow",
  );
  if (modeledNet !== expectedModeledNet) fail("carry_portfolio_value_modeled_net_mismatch");
  const modeled = {
    gross_funding_micro_usdc: modeledGrossFunding,
    trading_cost_micro_usdc: modeledTradingCost,
    capital_cost_micro_usdc: modeledCapitalCost,
    risk_buffer_micro_usdc: modeledRiskBuffer,
    net_value_micro_usdc: modeledNet,
    ...normalizeModeledValueBreakdown(rawModeled, modeledGrossFunding, modeledTradingCost),
  };
  if (canonicalCarryCommitmentJson(rawModeled) !== canonicalCarryCommitmentJson(modeled)) {
    fail("carry_portfolio_value_modeled_replay_mismatch");
  }
  const entries = array(ledger.entries, "carry_portfolio_value_entries", 0, 4_096)
    .map(normalizeValueEntry);
  const entryIds = entries.map((entry) => entry.entry_id);
  if (new Set(entryIds).size !== entryIds.length
    || entries.some((entry, index) => entry.sequence !== index + 1)) {
    fail("carry_portfolio_value_entry_sequence_mismatch");
  }
  const processedEntryIds = array(
    ledger.processed_entry_ids,
    "carry_portfolio_value_processed_entry_ids",
    0,
    4_096,
  ).map((entryId) => identifier(entryId, "carry_portfolio_value_processed_entry_id"));
  if (canonicalCarryCommitmentJson(processedEntryIds) !== canonicalCarryCommitmentJson(entryIds)) {
    fail("carry_portfolio_value_processed_entry_ids_mismatch");
  }
  const claimIds = entries.map(valueClaimId);
  const processedClaimIds = array(
    ledger.processed_claim_ids,
    "carry_portfolio_value_processed_claim_ids",
    0,
    4_096,
  ).map((claimId) => String(claimId));
  if (new Set(claimIds).size !== claimIds.length
    || canonicalCarryCommitmentJson(processedClaimIds) !== canonicalCarryCommitmentJson(claimIds)) {
    fail("carry_portfolio_value_processed_claim_ids_mismatch");
  }
  if (nonNegativeInteger(ledger.last_sequence, "carry_portfolio_value_last_sequence") !== entries.length) {
    fail("carry_portfolio_value_last_sequence_mismatch");
  }
  if (ledger.currency !== "USDC") fail("carry_portfolio_value_currency_mismatch");
  const createdAtMs = positiveInteger(ledger.created_at_ms, "carry_portfolio_value_created_at");
  const updatedAtMs = positiveInteger(ledger.updated_at_ms, "carry_portfolio_value_updated_at");
  if (updatedAtMs < createdAtMs
    || entries.some((entry) => entry.occurred_at_ms > updatedAtMs
      || (entry.entry_type === "funding" && entry.valued_at_ms > updatedAtMs))) {
    fail("carry_portfolio_value_ledger_time_mismatch");
  }
  const expectedRealized = summarizeRealizedValue(entries, modeled);
  expectedRealized.attribution = summarizeValueAttribution(
    modeled,
    expectedRealized,
    ledgerStatus === "finalized",
  );
  const realized = object(ledger.realized, "carry_portfolio_value_realized_required");
  if (canonicalCarryCommitmentJson(realized) !== canonicalCarryCommitmentJson(expectedRealized)) {
    fail("carry_portfolio_value_ledger_replay_mismatch");
  }
  const realizedValues = {
    funding_credit_micro_usdc: nonNegativeInteger(realized.funding_credit_micro_usdc, "carry_portfolio_value_realized_funding_credit"),
    funding_debit_micro_usdc: nonNegativeInteger(realized.funding_debit_micro_usdc, "carry_portfolio_value_realized_funding_debit"),
    trading_fee_micro_usdc: nonNegativeInteger(realized.trading_fee_micro_usdc, "carry_portfolio_value_realized_trading_fee"),
    slippage_micro_usdc: nonNegativeInteger(realized.slippage_micro_usdc, "carry_portfolio_value_realized_slippage"),
    gas_micro_usdc: nonNegativeInteger(realized.gas_micro_usdc, "carry_portfolio_value_realized_gas"),
    capital_cost_micro_usdc: nonNegativeInteger(realized.capital_cost_micro_usdc, "carry_portfolio_value_realized_capital_cost"),
    transfer_fee_micro_usdc: nonNegativeInteger(realized.transfer_fee_micro_usdc, "carry_portfolio_value_realized_transfer_fee"),
    rebate_micro_usdc: nonNegativeInteger(realized.rebate_micro_usdc, "carry_portfolio_value_realized_rebate"),
    settlement_adjustment_micro_usdc: signedInteger(realized.settlement_adjustment_micro_usdc, "carry_portfolio_value_realized_settlement"),
  };
  const realizedNet = signedInteger(realized.net_value_micro_usdc, "carry_portfolio_value_realized_net");
  if (realizedNet !== realizedNetValue(realizedValues)) fail("carry_portfolio_value_realized_net_mismatch");
  const variance = signedInteger(
    realized.variance_from_modeled_micro_usdc,
    "carry_portfolio_value_realized_variance",
  );
  if (variance !== safeAdd(realizedNet, -modeledNet, "carry_portfolio_value_realized_overflow")) {
    fail("carry_portfolio_value_realized_variance_mismatch");
  }
  if (ledgerStatus === "finalized") {
    const evidence = object(
      ledger.finalization_evidence,
      "carry_portfolio_value_finalization_evidence_required",
    );
    if (nonNegativeInteger(evidence.gross_exposure_micro_usdc, "carry_portfolio_value_final_exposure") !== 0
      || nonNegativeInteger(evidence.open_order_count, "carry_portfolio_value_final_orders") !== 0
      || evidence.costs_complete !== true) {
      fail("carry_portfolio_value_finalization_incomplete");
    }
    identifier(evidence.reconciliation_commitment, "carry_portfolio_value_reconciliation_commitment");
  } else if (ledger.finalization_evidence !== null) {
    fail("carry_portfolio_value_open_ledger_finalization_evidence");
  }
  return Object.freeze({
    position_id: positionId,
    position_status: positionStatus,
    target_notional_micro_usdc: targetNotional,
    ledger_status: ledgerStatus,
    modeled_gross_funding_micro_usdc: modeledGrossFunding,
    modeled_trading_cost_micro_usdc: modeledTradingCost,
    modeled_capital_cost_micro_usdc: modeledCapitalCost,
    modeled_risk_buffer_micro_usdc: modeledRiskBuffer,
    modeled_net_value_micro_usdc: modeledNet,
    ...realizedValues,
    realized_net_value_micro_usdc: realizedNet,
  });
}

function normalizePortfolioValueCapitalEvidence(value) {
  const raw = object(value, "carry_portfolio_value_capital_evidence_required");
  const status = enumValue(
    raw.status,
    new Set(["ready", "incomplete"]),
    "carry_portfolio_value_capital_evidence_status",
  );
  if (status === "incomplete") {
    const missingPositionIds = array(
      raw.missing_position_ids,
      "carry_portfolio_value_missing_capital_positions",
      1,
      1_000,
    ).map((item) => identifier(item, "carry_portfolio_value_missing_capital_position"));
    if (new Set(missingPositionIds).size !== missingPositionIds.length) {
      fail("carry_portfolio_value_missing_capital_position_duplicate");
    }
    return Object.freeze({
      status,
      missing_position_ids: Object.freeze(missingPositionIds.sort()),
      potential_releasable_micro_usdc: null,
      proposed_reallocation_micro_usdc: null,
      potential_new_cash_avoided_micro_usdc: null,
      new_owner_cash_requested_micro_usdc: null,
      uncovered_shortfall_micro_usdc: null,
      owner_approval_required: false,
      proposal_only: true,
    });
  }
  const plan = object(raw.plan, "carry_portfolio_value_capital_plan_required");
  if (plan.kind !== "ghola_carry_portfolio_capital_plan"
    || plan.proposal_only !== true
    || plan.transaction_broadcast !== false
    || plan.automatic_transfer_permitted !== false) {
    fail("carry_portfolio_value_capital_authority_boundary");
  }
  const ownerOnlyOperations = array(
    plan.owner_only_operations,
    "carry_portfolio_value_capital_owner_operations",
    3,
    3,
  );
  if (!["fund", "transfer", "withdraw"].every((operation) => ownerOnlyOperations.includes(operation))) {
    fail("carry_portfolio_value_capital_owner_operations");
  }
  const requested = nonNegativeInteger(plan.total_requested_micro_usdc, "carry_portfolio_value_capital_requested");
  const potential = nonNegativeInteger(plan.total_potential_releasable_micro_usdc, "carry_portfolio_value_capital_releasable");
  const reallocation = nonNegativeInteger(plan.total_proposed_internal_reallocation_micro_usdc, "carry_portfolio_value_capital_reallocation");
  const newCash = nonNegativeInteger(plan.net_new_owner_capital_requested_micro_usdc, "carry_portfolio_value_capital_new_cash");
  const ownerAllocation = nonNegativeInteger(plan.total_proposed_allocation_micro_usdc, "carry_portfolio_value_capital_owner_allocation");
  const uncovered = nonNegativeInteger(plan.total_uncovered_shortfall_micro_usdc, "carry_portfolio_value_capital_uncovered");
  if (reallocation > potential
    || requested !== reallocation + newCash
    || newCash !== ownerAllocation + uncovered
    || (plan.owner_transfer_approval_required === true) !== (reallocation > 0)
    || (plan.owner_funding_approval_required === true) !== (ownerAllocation > 0)) {
    fail("carry_portfolio_value_capital_arithmetic_mismatch");
  }
  return Object.freeze({
    status,
    missing_position_ids: Object.freeze([]),
    potential_releasable_micro_usdc: potential,
    proposed_reallocation_micro_usdc: reallocation,
    potential_new_cash_avoided_micro_usdc: reallocation,
    new_owner_cash_requested_micro_usdc: newCash,
    uncovered_shortfall_micro_usdc: uncovered,
    owner_approval_required: reallocation > 0 || ownerAllocation > 0,
    proposal_only: true,
  });
}

function portfolioRealizedTotals(positions, code) {
  const fields = [
    "funding_credit_micro_usdc",
    "funding_debit_micro_usdc",
    "trading_fee_micro_usdc",
    "slippage_micro_usdc",
    "gas_micro_usdc",
    "capital_cost_micro_usdc",
    "transfer_fee_micro_usdc",
    "rebate_micro_usdc",
    "settlement_adjustment_micro_usdc",
    "realized_net_value_micro_usdc",
  ];
  return Object.fromEntries(fields.map((field) => [
    field === "realized_net_value_micro_usdc" ? "net_value_micro_usdc" : field,
    positions.reduce((total, position) => safeAdd(total, position[field], code), 0),
  ]));
}

function normalizeCarryTransferRouteEvidence(value) {
  const raw = object(value, "carry_transfer_route_required");
  exactVersion(raw.version, "carry_transfer_route_version");
  if (raw.valuation_asset !== "USD") fail("carry_transfer_route_valuation_asset");
  if (raw.owner_approval_required !== true
    || raw.fund_movement_authorized !== false
    || raw.transaction_broadcast !== false
    || raw.automatic_transfer_permitted !== false) {
    fail("carry_transfer_route_authority_boundary");
  }
  const fromAccount = identifier(raw.from_account_commitment, "carry_transfer_route_from_account");
  const toAccount = identifier(raw.to_account_commitment, "carry_transfer_route_to_account");
  if (fromAccount === toAccount) fail("carry_transfer_route_distinct_accounts");
  const fromVenue = carryExecutionVenue(raw.from_venue_id, "carry_transfer_route_from_venue");
  const toVenue = carryExecutionVenue(raw.to_venue_id, "carry_transfer_route_to_venue");
  const sourceAdapterId = identifier(raw.source_adapter_id, "carry_transfer_route_source_adapter");
  const destinationAdapterId = identifier(raw.destination_adapter_id, "carry_transfer_route_destination_adapter");
  const sourceCapability = venueAdapterCapability(fromVenue, "collateral_route_observer");
  const destinationCapability = venueAdapterCapability(toVenue, "collateral_route_observer");
  const sourceCollateralAsset = enumValue(
    raw.source_collateral_asset,
    new Set(["USDC", "USDT"]),
    "carry_transfer_route_source_collateral_asset",
  );
  const destinationCollateralAsset = enumValue(
    raw.destination_collateral_asset,
    new Set(["USDC", "USDT"]),
    "carry_transfer_route_destination_collateral_asset",
  );
  const conversionRequired = sourceCollateralAsset !== destinationCollateralAsset;
  if (fromVenue === toVenue
    || sourceCapability?.adapter_id !== sourceAdapterId
    || destinationCapability?.adapter_id !== destinationAdapterId) {
    fail("carry_transfer_route_adapter_binding");
  }
  if (sourceCapability?.collateral_asset !== sourceCollateralAsset
    || destinationCapability?.collateral_asset !== destinationCollateralAsset
    || raw.conversion_required !== conversionRequired) {
    fail("carry_transfer_route_asset_binding");
  }
  const evidenceCheckedAtMs = positiveInteger(raw.evidence_checked_at_ms, "carry_transfer_route_evidence_checked_at");
  const asOfMs = positiveInteger(raw.as_of_ms, "carry_transfer_route_as_of");
  if (asOfMs > evidenceCheckedAtMs + 5_000 || evidenceCheckedAtMs - asOfMs > 300_000) {
    fail("carry_transfer_route_evidence_time_mismatch");
  }
  const minimumTransfer = nonNegativeInteger(raw.minimum_transfer_micro_usdc, "carry_transfer_route_minimum");
  const maximumTransfer = nonNegativeInteger(raw.maximum_transfer_micro_usdc, "carry_transfer_route_maximum");
  if (maximumTransfer < minimumTransfer) fail("carry_transfer_route_capacity_invalid");
  const routeStatus = enumValue(
    raw.status,
    new Set(["available", "degraded", "unavailable"]),
    "carry_transfer_route_status",
  );
  const quoteVerified = raw.quote_verified === true;
  const allInFeeVerified = raw.all_in_fee_verified === true;
  const valuationBasisVerified = raw.valuation_basis_verified === true;
  const conversionQuoteVerified = raw.conversion_quote_verified === true;
  const conversionRateE8 = nonNegativeInteger(raw.conversion_rate_e8, "carry_transfer_route_conversion_rate");
  const withdrawalFee = nonNegativeInteger(raw.withdrawal_fee_micro_usdc, "carry_transfer_route_withdrawal_fee");
  const depositFee = nonNegativeInteger(raw.deposit_fee_micro_usdc, "carry_transfer_route_deposit_fee");
  const conversionFee = nonNegativeInteger(raw.conversion_fee_micro_usdc, "carry_transfer_route_conversion_fee");
  const conversionSlippage = nonNegativeInteger(raw.conversion_slippage_micro_usdc, "carry_transfer_route_conversion_slippage");
  const totalFee = nonNegativeInteger(raw.fee_micro_usdc, "carry_transfer_route_fee");
  if ((routeStatus === "available" && maximumTransfer === 0)
    || (routeStatus !== "unavailable" && (!quoteVerified || !allInFeeVerified || !valuationBasisVerified))
    || (conversionRequired && routeStatus !== "unavailable" && !conversionQuoteVerified)
    || (conversionRequired && routeStatus !== "unavailable" && conversionRateE8 === 0)
    || (!conversionRequired && (conversionRateE8 !== 100_000_000 || conversionFee !== 0 || conversionSlippage !== 0))
    || totalFee !== safeAdd(
      safeAdd(withdrawalFee, depositFee, "carry_transfer_route_fee_overflow"),
      safeAdd(conversionFee, conversionSlippage, "carry_transfer_route_fee_overflow"),
      "carry_transfer_route_fee_overflow",
    )) {
    fail("carry_transfer_route_quote_unverified");
  }
  return Object.freeze({
    version: 1,
    route_id: identifier(raw.route_id, "carry_transfer_route_id"),
    evidence_source: raw.evidence_source === "attested_worker"
      ? "attested_worker"
      : fail("carry_transfer_route_evidence_source"),
    evidence_commitment: identifier(raw.evidence_commitment, "carry_transfer_route_evidence_commitment"),
    evidence_checked_at_ms: evidenceCheckedAtMs,
    worker_image_digest: identifier(raw.worker_image_digest, "carry_transfer_route_worker_image"),
    from_account_commitment: fromAccount,
    from_venue_id: fromVenue,
    to_account_commitment: toAccount,
    to_venue_id: toVenue,
    source_adapter_id: sourceAdapterId,
    destination_adapter_id: destinationAdapterId,
    source_account_state_commitment: identifier(raw.source_account_state_commitment, "carry_transfer_route_source_state"),
    destination_account_state_commitment: identifier(raw.destination_account_state_commitment, "carry_transfer_route_destination_state"),
    quote_commitment: identifier(raw.quote_commitment, "carry_transfer_route_quote"),
    valuation_asset: "USD",
    source_collateral_asset: sourceCollateralAsset,
    destination_collateral_asset: destinationCollateralAsset,
    conversion_required: conversionRequired,
    status: routeStatus,
    quote_verified: quoteVerified,
    all_in_fee_verified: allInFeeVerified,
    valuation_basis_verified: valuationBasisVerified,
    conversion_quote_verified: conversionQuoteVerified,
    conversion_rate_e8: conversionRateE8,
    minimum_transfer_micro_usdc: minimumTransfer,
    maximum_transfer_micro_usdc: maximumTransfer,
    withdrawal_fee_micro_usdc: withdrawalFee,
    deposit_fee_micro_usdc: depositFee,
    conversion_fee_micro_usdc: conversionFee,
    conversion_slippage_micro_usdc: conversionSlippage,
    fee_micro_usdc: totalFee,
    estimated_latency_ms: boundedInteger(raw.estimated_latency_ms, 0, 7 * DAY_MS, "carry_transfer_route_latency"),
    as_of_ms: asOfMs,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  });
}

function normalizePortfolioCapitalPositionPlan(value) {
  const raw = object(value, "carry_portfolio_capital_position_plan_required");
  exactVersion(raw.version, "carry_portfolio_capital_position_plan_version");
  if (raw.kind !== "ghola_carry_capital_action_plan") fail("carry_portfolio_capital_position_plan_kind");
  const positionId = identifier(raw.position_id, "carry_portfolio_capital_position_id");
  const status = enumValue(
    raw.status,
    new Set(["balanced", "owner_action_required", "exit_required", "quarantined"]),
    "carry_portfolio_capital_position_status",
  );
  const recommendedAction = enumValue(
    raw.recommended_action,
    new Set(["none", "owner_collateral_review", "reduce_only_exit", "reconcile_only"]),
    "carry_portfolio_capital_position_action",
  );
  const legs = array(raw.legs, "carry_portfolio_capital_position_legs", 2, 2).map((value) => {
    const leg = object(value, "carry_portfolio_capital_position_leg_required");
    const recommendedAction = enumValue(
      leg.recommended_action,
      new Set(["none", "owner_fund_venue", "owner_review_required", "reduce_only_exit", "reconcile_only"]),
      "carry_portfolio_capital_position_leg_action",
    );
    const additional = nonNegativeInteger(
      leg.minimum_additional_collateral_micro_usdc,
      "carry_portfolio_capital_position_leg_additional",
    );
    const currentHeadroom = nonNegativeInteger(
      leg.current_headroom_micro_usdc,
      "carry_portfolio_capital_position_leg_headroom",
    );
    const targetHeadroom = nonNegativeInteger(
      leg.target_headroom_micro_usdc,
      "carry_portfolio_capital_position_leg_target_headroom",
    );
    const stressBurn = nonNegativeInteger(
      leg.stress_burn_micro_usdc_per_hour,
      "carry_portfolio_capital_position_leg_stress_burn",
    );
    const releasable = nonNegativeInteger(
      leg.potential_releasable_collateral_micro_usdc,
      "carry_portfolio_capital_position_leg_releasable",
    );
    const ownerFundingPermitted = leg.owner_funding_permitted === true;
    const ownerReleasePermitted = leg.owner_release_permitted === true;
    if (["owner_fund_venue", "owner_review_required"].includes(recommendedAction) !== ownerFundingPermitted
      || (recommendedAction === "owner_fund_venue" && additional === 0)
      || (!["owner_fund_venue", "owner_review_required"].includes(recommendedAction) && additional !== 0)) {
      fail("carry_portfolio_capital_position_leg_authority_semantics");
    }
    if ((releasable > 0) !== ownerReleasePermitted
      || (ownerReleasePermitted && recommendedAction !== "none")
      || (ownerReleasePermitted && releasable !== Math.max(0, currentHeadroom - targetHeadroom))) {
      fail("carry_portfolio_capital_position_leg_release_semantics");
    }
    return Object.freeze({
      venue_id: carryExecutionVenue(leg.venue_id, "carry_portfolio_capital_position_leg_venue"),
      account_commitment: identifier(
        leg.account_commitment,
        "carry_portfolio_capital_position_leg_account",
      ),
      account_state_commitment: identifier(
        leg.account_state_commitment,
        "carry_portfolio_capital_position_leg_account_state",
      ),
      runway_ms: leg.runway_ms === null
        ? null
        : nonNegativeInteger(leg.runway_ms, "carry_portfolio_capital_position_leg_runway"),
      target_runway_ms: nonNegativeInteger(
        leg.target_runway_ms,
        "carry_portfolio_capital_position_leg_target_runway",
      ),
      current_headroom_micro_usdc: currentHeadroom,
      target_headroom_micro_usdc: targetHeadroom,
      stress_burn_micro_usdc_per_hour: stressBurn,
      position_open: leg.position_open !== false,
      liquidation_distance_bps: leg.liquidation_distance_bps === null
        ? null
        : boundedInteger(leg.liquidation_distance_bps, 0, 100_000, "carry_portfolio_capital_position_leg_liquidation_distance"),
      minimum_liquidation_distance_bps: boundedInteger(
        leg.minimum_liquidation_distance_bps,
        0,
        100_000,
        "carry_portfolio_capital_position_leg_minimum_liquidation_distance",
      ),
      liquidation_distance_verified: leg.position_open !== false && leg.liquidation_distance_verified === true,
      liquidation_distance_source: leg.liquidation_distance_source === null
        ? null
        : identifier(leg.liquidation_distance_source, "carry_portfolio_capital_position_leg_liquidation_source"),
      minimum_additional_collateral_micro_usdc: additional,
      potential_releasable_collateral_micro_usdc: releasable,
      recommended_action: recommendedAction,
      owner_funding_permitted: ownerFundingPermitted,
      owner_release_permitted: ownerReleasePermitted,
    });
  });
  if (new Set(legs.map((leg) => leg.venue_id)).size !== 2) {
    fail("carry_portfolio_capital_position_leg_duplicate_venue");
  }
  const minimumAdditional = nonNegativeInteger(
    raw.minimum_additional_collateral_micro_usdc,
    "carry_portfolio_capital_position_additional",
  );
  const legAdditional = legs.reduce(
    (sum, leg) => safeAdd(sum, leg.minimum_additional_collateral_micro_usdc, "carry_portfolio_capital_position_additional_overflow"),
    0,
  );
  if (minimumAdditional !== legAdditional) fail("carry_portfolio_capital_position_additional_mismatch");
  const potentialReleasable = nonNegativeInteger(
    raw.potential_releasable_collateral_micro_usdc,
    "carry_portfolio_capital_position_releasable",
  );
  const legReleasable = legs.reduce(
    (sum, leg) => safeAdd(sum, leg.potential_releasable_collateral_micro_usdc, "carry_portfolio_capital_position_releasable_overflow"),
    0,
  );
  if (potentialReleasable !== legReleasable
    || (raw.capital_optimization_available === true) !== (potentialReleasable > 0)) {
    fail("carry_portfolio_capital_position_releasable_mismatch");
  }
  if (raw.proposal_only !== true
    || raw.transaction_broadcast !== false
    || raw.automatic_transfer_permitted !== false
    || !Array.isArray(raw.owner_only_operations)
    || !["fund", "transfer", "withdraw"].every((operation) => raw.owner_only_operations.includes(operation))) {
    fail("carry_portfolio_capital_position_authority_boundary");
  }
  const reconciliationRequired = raw.reconciliation_required === true;
  const reduceOnlyExitRequired = raw.reduce_only_exit_required === true;
  const ownerFundingRequired = raw.owner_funding_required === true;
  const expectedReduceOnlyExitRequired = legs.some((leg) => leg.recommended_action === "reduce_only_exit");
  const expectedReconciliationRequired = !expectedReduceOnlyExitRequired
    && legs.some((leg) => leg.recommended_action === "reconcile_only");
  const expectedOwnerFundingRequired = !expectedReduceOnlyExitRequired && !expectedReconciliationRequired
    && legs.some((leg) => ["owner_fund_venue", "owner_review_required"].includes(leg.recommended_action));
  if (reconciliationRequired !== expectedReconciliationRequired
    || reduceOnlyExitRequired !== expectedReduceOnlyExitRequired
    || ownerFundingRequired !== expectedOwnerFundingRequired) {
    fail("carry_portfolio_capital_position_flag_semantics");
  }
  const expectedStatus = reconciliationRequired
    ? "quarantined"
    : reduceOnlyExitRequired
      ? "exit_required"
      : ownerFundingRequired
        ? "owner_action_required"
        : "balanced";
  const expectedAction = reconciliationRequired
    ? "reconcile_only"
    : reduceOnlyExitRequired
      ? "reduce_only_exit"
      : ownerFundingRequired
        ? "owner_collateral_review"
        : "none";
  if (status !== expectedStatus || recommendedAction !== expectedAction) {
    fail("carry_portfolio_capital_position_semantics");
  }
  return Object.freeze({
    version: 1,
    kind: raw.kind,
    position_id: positionId,
    status,
    recommended_action: recommendedAction,
    reasons: Array.isArray(raw.reasons) ? [...new Set(raw.reasons.filter((reason) => typeof reason === "string"))] : [],
    minimum_additional_collateral_micro_usdc: minimumAdditional,
    potential_releasable_collateral_micro_usdc: potentialReleasable,
    owner_funding_required: ownerFundingRequired,
    reduce_only_exit_required: reduceOnlyExitRequired,
    reconciliation_required: reconciliationRequired,
    checked_at_ms: positiveInteger(raw.checked_at_ms, "carry_portfolio_capital_position_checked_at"),
    legs,
  });
}

function normalizeModeledValueBreakdown(modeled, grossFunding, tradingCost) {
  const fields = [
    "funding_credit_micro_usdc",
    "funding_debit_micro_usdc",
    "trading_fee_micro_usdc",
    "slippage_micro_usdc",
    "gas_micro_usdc",
    "latency_buffer_micro_usdc",
  ];
  const provided = fields.filter((field) => modeled[field] !== undefined);
  if (provided.length === 0) return { breakdown_complete: false };
  if (provided.length !== fields.length) fail("carry_value_modeled_breakdown_incomplete");
  const values = Object.fromEntries(fields.map((field) => [
    field,
    nonNegativeInteger(modeled[field], `carry_value_modeled_${field}`),
  ]));
  if (safeAdd(values.funding_credit_micro_usdc, -values.funding_debit_micro_usdc, "carry_value_modeled_funding_overflow") !== grossFunding) {
    fail("carry_value_modeled_funding_breakdown_mismatch");
  }
  const modeledTradingCost = [
    values.trading_fee_micro_usdc,
    values.slippage_micro_usdc,
    values.gas_micro_usdc,
    values.latency_buffer_micro_usdc,
  ].reduce((sum, amount) => safeAdd(sum, amount, "carry_value_modeled_cost_overflow"), 0);
  if (modeledTradingCost !== tradingCost) fail("carry_value_modeled_trading_breakdown_mismatch");
  return { breakdown_complete: true, ...values };
}

function emptyRealizedValue(modeled) {
  const modeledNet = typeof modeled === "number" ? modeled : modeled.net_value_micro_usdc;
  const value = {
    funding_credit_micro_usdc: 0,
    funding_debit_micro_usdc: 0,
    trading_fee_micro_usdc: 0,
    slippage_micro_usdc: 0,
    gas_micro_usdc: 0,
    capital_cost_micro_usdc: 0,
    transfer_fee_micro_usdc: 0,
    rebate_micro_usdc: 0,
    settlement_adjustment_micro_usdc: 0,
    net_value_micro_usdc: 0,
    variance_from_modeled_micro_usdc: -modeledNet,
    by_venue: {},
  };
  value.attribution = summarizeValueAttribution(
    typeof modeled === "number" ? { net_value_micro_usdc: modeled, breakdown_complete: false } : modeled,
    value,
    false,
  );
  return value;
}

function summarizeRealizedValue(entries, modeled) {
  const value = emptyRealizedValue(modeled);
  for (const entry of entries) {
    applyRealizedEntry(value, entry);
    if (entry.venue_id !== null) {
      value.by_venue[entry.venue_id] ||= emptyRealizedVenueValue();
      applyRealizedEntry(value.by_venue[entry.venue_id], entry);
    }
  }
  value.net_value_micro_usdc = realizedNetValue(value);
  value.variance_from_modeled_micro_usdc = safeAdd(value.net_value_micro_usdc, -modeled.net_value_micro_usdc, "carry_value_realized_overflow");
  for (const venueValue of Object.values(value.by_venue)) {
    venueValue.net_value_micro_usdc = realizedNetValue(venueValue);
  }
  value.attribution = summarizeValueAttribution(modeled, value, false);
  return value;
}

function emptyRealizedVenueValue() {
  const {
    variance_from_modeled_micro_usdc: _variance,
    attribution: _attribution,
    by_venue: _byVenue,
    ...value
  } = emptyRealizedValue(0);
  return value;
}

function summarizeValueAttribution(modeled, realized, finalized) {
  const netVariance = safeAdd(
    realized.net_value_micro_usdc,
    -modeled.net_value_micro_usdc,
    "carry_value_realized_overflow",
  );
  if (modeled.breakdown_complete !== true) {
    return {
      status: finalized ? "finalized_net_only" : "net_only",
      funding_micro_usdc: null,
      trading_fee_micro_usdc: null,
      slippage_micro_usdc: null,
      gas_micro_usdc: null,
      capital_cost_micro_usdc: null,
      net_value_micro_usdc: netVariance,
    };
  }
  const realizedFunding = safeAdd(
    realized.funding_credit_micro_usdc,
    -realized.funding_debit_micro_usdc,
    "carry_value_realized_overflow",
  );
  return {
    status: finalized ? "finalized" : "accruing",
    funding_micro_usdc: safeAdd(realizedFunding, -modeled.gross_funding_micro_usdc, "carry_value_realized_overflow"),
    trading_fee_micro_usdc: safeAdd(modeled.trading_fee_micro_usdc, -realized.trading_fee_micro_usdc, "carry_value_realized_overflow"),
    slippage_micro_usdc: safeAdd(modeled.slippage_micro_usdc, -realized.slippage_micro_usdc, "carry_value_realized_overflow"),
    gas_micro_usdc: safeAdd(modeled.gas_micro_usdc, -realized.gas_micro_usdc, "carry_value_realized_overflow"),
    capital_cost_micro_usdc: safeAdd(modeled.capital_cost_micro_usdc, -realized.capital_cost_micro_usdc, "carry_value_realized_overflow"),
    net_value_micro_usdc: netVariance,
  };
}

function applyRealizedEntry(value, entry) {
  const amount = entry.amount_micro_usdc;
  if (entry.entry_type === "funding") {
    const field = entry.direction === "credit" ? "funding_credit_micro_usdc" : "funding_debit_micro_usdc";
    value[field] = safeAdd(value[field], amount, "carry_value_realized_overflow");
  } else if (entry.entry_type === "settlement_adjustment") {
    value.settlement_adjustment_micro_usdc = safeAdd(
      value.settlement_adjustment_micro_usdc,
      entry.direction === "credit" ? amount : -amount,
      "carry_value_realized_overflow",
    );
  } else {
    const field = `${entry.entry_type}_micro_usdc`;
    value[field] = safeAdd(value[field], amount, "carry_value_realized_overflow");
  }
}

function realizedNetValue(value) {
  const credits = safeAdd(
    safeAdd(value.funding_credit_micro_usdc, value.rebate_micro_usdc, "carry_value_realized_overflow"),
    Math.max(0, value.settlement_adjustment_micro_usdc),
    "carry_value_realized_overflow",
  );
  const debits = [
    value.funding_debit_micro_usdc,
    value.trading_fee_micro_usdc,
    value.slippage_micro_usdc,
    value.gas_micro_usdc,
    value.capital_cost_micro_usdc,
    value.transfer_fee_micro_usdc,
    Math.max(0, -value.settlement_adjustment_micro_usdc),
  ].reduce((sum, amount) => safeAdd(sum, amount, "carry_value_realized_overflow"), 0);
  return safeAdd(credits, -debits, "carry_value_realized_overflow");
}

function valueClaimId(entry) {
  return [
    entry.evidence_commitment,
    entry.entry_type,
    entry.venue_id || "portfolio",
    entry.leg_id || "none",
    entry.source_asset || "none",
    entry.source_amount_micro ?? "none",
    entry.source_amount_decimal || "none",
    entry.source_amount_scale ?? "none",
    entry.valued_at_ms ?? "none",
    entry.cashflow_valuation?.evidence_commitment || "none",
  ].join("|");
}

function sameValueEntryClaim(left, right) {
  return left.entry_id === right.entry_id
    && left.entry_type === right.entry_type
    && left.direction === right.direction
    && left.amount_micro_usdc === right.amount_micro_usdc
    && left.venue_id === right.venue_id
    && left.leg_id === right.leg_id
    && left.occurred_at_ms === right.occurred_at_ms
    && left.evidence_commitment === right.evidence_commitment
    && left.source_amount_micro === right.source_amount_micro
    && left.source_amount_decimal === right.source_amount_decimal
    && left.source_amount_scale === right.source_amount_scale
    && left.valued_at_ms === right.valued_at_ms
    && left.source_asset === right.source_asset
    && left.cashflow_valuation?.evidence_message === right.cashflow_valuation?.evidence_message
    && left.cashflow_valuation?.evidence_commitment === right.cashflow_valuation?.evidence_commitment;
}

function fundingCashMicro(side, notional, contract, horizonMs) {
  const direction = side === "short" ? 1n : -1n;
  const numerator = direction * BigInt(notional) * BigInt(contract.funding_rate_e12_per_interval) * BigInt(horizonMs);
  return safeNumber(floorDiv(numerator, 1_000_000_000_000n * BigInt(contract.funding_interval_ms)));
}

function modeledContractCashflowMicroUsdc(amountMicro, contract, sourceAsset, code) {
  const valuation = contract.asset_valuations[sourceAsset];
  if (!valuation) fail(`${code}_valuation_missing`);
  if (valuation.bound_source_amount_micro != null
    && valuation.bound_source_amount_micro !== amountMicro) {
    fail(`${code}_valuation_amount_mismatch`);
  }
  return convertSignedCashflowToMicroUsdc({ amount_micro: amountMicro, valuation });
}

function modeledContractCostMicroUsdc(amountMicro, contract, sourceAsset, code) {
  if (amountMicro === 0) return 0;
  return -modeledContractCashflowMicroUsdc(-amountMicro, contract, sourceAsset, code);
}

function modeledLegCostTotalMicroUsdc(
  notional,
  legs,
  fields,
  sourceAsset,
  code,
  multiplier = 1,
) {
  return legs.reduce((total, [contract, costs], legIndex) => {
    const e6Bps = fields.reduce(
      (sum, field) => safeAdd(sum, costs[field] * multiplier, `${code}_bps_overflow`),
      0,
    );
    const nativeCost = microFromE6BpsCeil(notional, e6Bps);
    const convertedCost = modeledContractCostMicroUsdc(
      nativeCost,
      contract,
      sourceAsset(contract),
      `${code}_${legIndex}`,
    );
    return safeAdd(total, convertedCost, `${code}_overflow`);
  }, 0);
}

function sumCostFields(costs, fields, multiplier = 1) {
  return costs.flatMap((cost) => fields.map((field) => cost[field] * multiplier))
    .reduce((sum, value) => safeAdd(sum, value, "carry_cost_bps_overflow"), 0);
}

function allocateE6BpsMicroCosts(amount, e6BpsComponents) {
  const denominator = 10_000_000_000n;
  const rows = e6BpsComponents.map((e6Bps, index) => {
    const numerator = BigInt(amount) * BigInt(e6Bps);
    return { index, quotient: numerator / denominator, remainder: numerator % denominator };
  });
  const totalNumerator = rows.reduce((sum, row) => sum + row.quotient * denominator + row.remainder, 0n);
  const target = ceilDiv(totalNumerator, denominator);
  let remainderUnits = target - rows.reduce((sum, row) => sum + row.quotient, 0n);
  for (const row of [...rows].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  })) {
    if (remainderUnits === 0n || row.remainder === 0n) break;
    row.quotient += 1n;
    remainderUnits -= 1n;
  }
  if (remainderUnits !== 0n) fail("carry_cost_allocation_invalid");
  return rows.sort((left, right) => left.index - right.index).map((row) => safeNumber(row.quotient));
}

function microFromBpsCeil(amount, bps) {
  return safeNumber(ceilDiv(BigInt(amount) * BigInt(bps), 10_000n));
}

function microFromE6BpsCeil(amount, e6Bps) {
  return safeNumber(ceilDiv(BigInt(amount) * BigInt(e6Bps), 10_000_000_000n));
}

function ratioBpsFloor(amount, denominator) {
  return safeNumber(floorDiv(BigInt(amount) * 10_000n, BigInt(denominator)));
}

function priceDivergenceBpsCeil(left, right) {
  const lower = Math.min(left, right);
  const difference = Math.abs(left - right);
  return safeNumber(ceilDiv(BigInt(difference) * 10_000n, BigInt(lower)));
}

function normalizePairContract(value, leg) {
  const raw = object(value, `carry_${leg}_pair_contract_required`);
  return deepFreeze({
    venue_id: venue(raw.venue_id, `carry_${leg}_pair_contract_venue`),
    economic_equivalence_id: identifier(raw.economic_equivalence_id, `carry_${leg}_pair_economic_equivalence_id`),
    asset: normalized(raw.asset, ASSET, `carry_${leg}_pair_asset`),
    quote_asset: normalized(raw.quote_asset, ASSET, `carry_${leg}_pair_quote_asset`),
    contract_type: enumValue(raw.contract_type, new Set(["linear_perp", "inverse_perp"]), `carry_${leg}_pair_contract_type`),
    mark_price_e8: positiveInteger(raw.mark_price_e8, `carry_${leg}_pair_mark_price`),
    index_price_e8: positiveInteger(raw.index_price_e8, `carry_${leg}_pair_index_price`),
  });
}

function normalizeContractAssetValuations(value, requiredAssets, contractAsOfMs) {
  const rows = value === undefined
    ? []
    : array(value, "contract_asset_valuations", 0, USD_STABLE_QUOTES.size);
  const byAsset = new Map();
  for (const row of rows) {
    const valuation = normalizeCashflowValuation(row);
    if (byAsset.has(valuation.source_asset)) fail("contract_asset_valuation_duplicate");
    byAsset.set(valuation.source_asset, valuation);
  }
  for (const sourceAsset of byAsset.keys()) {
    if (!requiredAssets.has(sourceAsset)) fail("contract_asset_valuation_unbound");
  }
  for (const sourceAsset of requiredAssets) {
    if (sourceAsset === "USDC" && !byAsset.has(sourceAsset)) {
      byAsset.set(sourceAsset, usdcIdentityValuation(contractAsOfMs));
    }
    const valuation = byAsset.get(sourceAsset);
    if (!valuation) fail("contract_asset_valuation_missing");
    if (valuation.source_asset !== sourceAsset) fail("contract_asset_valuation_asset_mismatch");
    if (valuation.observed_at_ms > contractAsOfMs + 5_000
      || valuation.expires_at_ms <= contractAsOfMs) {
      fail("contract_asset_valuation_stale");
    }
  }
  return deepFreeze(Object.fromEntries(
    [...byAsset.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function usdcIdentityValuation(observedAtMs) {
  const valuation = {
    version: 1,
    source_asset: "USDC",
    valuation_asset: "USDC",
    verified: true,
    conversion_required: false,
    credit_rate_e8: USDC_RATE_E8,
    debit_rate_e8: USDC_RATE_E8,
    observed_at_ms: observedAtMs,
    expires_at_ms: Math.min(Number.MAX_SAFE_INTEGER, observedAtMs + MAX_CASHFLOW_VALUATION_LIFETIME_MS),
    evidence_source: "identity:usdc:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${"0".repeat(64)}`,
  };
  return deepFreeze({
    ...valuation,
    evidence_message: cashflowValuationEvidenceMessage(valuation),
  });
}

function assertContractValuationsCurrent(contract, nowMs) {
  for (const valuation of Object.values(contract.asset_valuations)) {
    if (valuation.observed_at_ms > nowMs + 5_000 || valuation.expires_at_ms <= nowMs) {
      fail("carry_cashflow_valuation_stale");
    }
  }
}

function requireStatus(position, allowed) {
  if (!allowed.has(position.status)) fail("carry_event_not_allowed_in_state");
}

function venue(value, code) {
  if (typeof value !== "string" || !isExecutionVenue(value)) fail(code);
  return value;
}

function carryExecutionVenue(value, code) {
  if (typeof value !== "string" || !isCarryExecutionVenue(value)) fail(code);
  return value;
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function array(value, code, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code);
  return value;
}

function identifier(value, code) {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}

function normalized(value, pattern, code) {
  if (typeof value !== "string") fail(code);
  const result = value.trim().toUpperCase();
  if (!pattern.test(result)) fail(code);
  return result;
}

function carryOpportunityEvidenceCommitment(value) {
  const commitment = typeof value === "string" ? value.trim() : "";
  if (!CARRY_OPPORTUNITY_EVIDENCE.test(commitment)) fail("carry_opportunity_evidence_commitment_invalid");
  return commitment;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function exactVersion(value, code) {
  if (value !== 1) fail(code);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function signedInteger(value, code) {
  if (!Number.isSafeInteger(value)) fail(code);
  return value;
}

function boundedInteger(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function safeAdd(left, right, code) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail(code);
  return result;
}

function safeNumber(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail("carry_integer_overflow");
  return result;
}

function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) fail("carry_division_invalid");
  return (numerator + denominator - 1n) / denominator;
}

function floorDiv(numerator, denominator) {
  if (denominator <= 0n) fail("carry_division_invalid");
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function fail(code) {
  throw new CarryModelError(code);
}
