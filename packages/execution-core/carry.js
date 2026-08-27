import { isCarryExecutionVenue, isExecutionVenue, venueSupportsProduct } from "./venues.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ID = /^[A-Za-z0-9:_-]{8,180}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
const ETH_ADDRESS = /^0x[0-9a-f]{40}$/;
const ETH_SIGNATURE = /^0x[0-9a-f]{130}$/;
const ETH_COMMITMENT = /^0x[0-9a-f]{64}$/;
const USD_STABLE_QUOTES = new Set(["USD", "USDC", "USDT"]);
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

export function normalizePerpContractSpec(value) {
  const raw = object(value, "contract_required");
  exactVersion(raw.version, "contract_version");
  const venueId = venue(raw.venue_id, "contract_venue");
  if (!venueSupportsProduct(venueId, "perp")) fail("contract_venue_not_perp");
  return deepFreeze({
    version: 1,
    venue_id: venueId,
    contract_id: identifier(raw.contract_id, "contract_id"),
    economic_equivalence_id: identifier(raw.economic_equivalence_id, "economic_equivalence_id"),
    asset: normalized(raw.asset, ASSET, "contract_asset"),
    market: normalized(raw.market, MARKET, "contract_market"),
    quote_asset: normalized(raw.quote_asset, ASSET, "contract_quote_asset"),
    collateral_asset: normalized(raw.collateral_asset, ASSET, "contract_collateral_asset"),
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
    minimum_notional_micro_usdc: positiveInteger(raw.minimum_notional_micro_usdc, "contract_minimum_notional"),
    quantity_step_e8: positiveInteger(raw.quantity_step_e8, "contract_quantity_step"),
    price_tick_e8: positiveInteger(raw.price_tick_e8, "contract_price_tick"),
    as_of_ms: positiveInteger(raw.as_of_ms, "contract_as_of"),
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
  const liquidationDistance = boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "liquidation_distance");
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
  if (headroom === 0 || liquidationDistance < minimumLiquidationDistance) status = "breached";
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
    owner_action_required: status === "critical" || status === "breached",
    automatic_transfer_permitted: false,
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

  const longFunding = fundingCashMicro("long", notional, longContract, horizonMs);
  const shortFunding = fundingCashMicro("short", notional, shortContract, horizonMs);
  const grossFunding = safeAdd(longFunding, shortFunding, "carry_funding_overflow");
  const legCostE6Bps = safeAdd(costE6Bps(longCosts), costE6Bps(shortCosts), "carry_cost_bps_overflow");
  const fixedTradingCost = safeAdd(
    microFromE6BpsCeil(notional, legCostE6Bps),
    safeAdd(longCosts.gas_micro_usdc, shortCosts.gas_micro_usdc, "carry_gas_overflow"),
    "carry_fixed_cost_overflow",
  );
  const baseRiskBuffer = microFromBpsCeil(notional, riskBufferBps);
  const collateralBasisRisk = microFromBpsCeil(notional, collateralBasisRiskBps);
  const riskBuffer = safeAdd(baseRiskBuffer, collateralBasisRisk, "carry_risk_buffer_overflow");
  const capitalCost = safeNumber(ceilDiv(
    BigInt(capitalCommitted) * BigInt(capitalCostBpsPerDay) * BigInt(horizonMs),
    10_000n * BigInt(DAY_MS),
  ));
  const totalModeledCost = safeAdd(safeAdd(fixedTradingCost, riskBuffer, "carry_cost_overflow"), capitalCost, "carry_cost_overflow");
  const expectedNet = safeAdd(grossFunding, -totalModeledCost, "carry_net_overflow");
  const expectedNetBps = ratioBpsFloor(expectedNet, notional);
  const dailyFunding = safeAdd(
    fundingCashMicro("long", notional, longContract, DAY_MS),
    fundingCashMicro("short", notional, shortContract, DAY_MS),
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
    projected_long_funding_micro_usdc: longFunding,
    projected_short_funding_micro_usdc: shortFunding,
    projected_gross_funding_micro_usdc: grossFunding,
    projected_trading_cost_micro_usdc: fixedTradingCost,
    projected_capital_cost_micro_usdc: capitalCost,
    base_risk_buffer_micro_usdc: baseRiskBuffer,
    collateral_basis_risk_bps: collateralBasisRiskBps,
    collateral_basis_risk_micro_usdc: collateralBasisRisk,
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
  if (signed.position_id !== raw.position_id
    || signed.mandate_id !== raw.mandate_id
    || signed.asset !== normalized(raw.asset, ASSET, "carry_position_asset")
    || signed.long_venue_id !== longVenue
    || signed.short_venue_id !== shortVenue
    || signed.target_notional_micro_usdc !== raw.target_notional_micro_usdc
    || JSON.stringify(signed.risk_mandate) !== JSON.stringify(mandate)) {
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
    long_filled_micro_usdc: 0,
    short_filled_micro_usdc: 0,
    hedge_error_micro_usdc: 0,
    status: "draft",
    risk_mandate: mandate,
    mandate_authorization: authorization,
    consecutive_exit_observations: 0,
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
  return deepFreeze({
    version: 1,
    position_id: identifier(raw.position_id, "carry_value_position_id"),
    currency: "USDC",
    status: "open",
    modeled: {
      gross_funding_micro_usdc: grossFunding,
      trading_cost_micro_usdc: tradingCost,
      capital_cost_micro_usdc: capitalCost,
      risk_buffer_micro_usdc: riskBuffer,
      net_value_micro_usdc: modeledNet,
    },
    realized: emptyRealizedValue(modeledNet),
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

export function appendCarryValueLedgerEntry({ ledger: ledgerInput, entry: entryInput, now_ms = Date.now() }) {
  try {
    const ledger = mutableValueLedger(ledgerInput);
    if (ledger.status !== "open") fail("carry_value_ledger_finalized");
    const entry = normalizeValueEntry(entryInput);
    const nowMs = positiveInteger(now_ms, "carry_value_entry_now");
    if (ledger.processed_entry_ids.includes(entry.entry_id)) {
      return deepFreeze({ ok: true, duplicate: true, ledger: deepFreeze(ledgerInput) });
    }
    const claimId = valueClaimId(entry);
    if (ledger.processed_claim_ids.includes(claimId)) fail("carry_value_evidence_claim_reused");
    if (entry.sequence !== ledger.last_sequence + 1) fail("carry_value_entry_sequence_invalid");
    if (entry.occurred_at_ms > nowMs) fail("carry_value_entry_from_future");
    ledger.entries.push(entry);
    ledger.processed_entry_ids.push(entry.entry_id);
    ledger.processed_claim_ids.push(claimId);
    ledger.last_sequence = entry.sequence;
    ledger.realized = summarizeRealizedValue(ledger.entries, ledger.modeled.net_value_micro_usdc);
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
    requireStatus(position, new Set(["opening"]));
    const longFilled = nonNegativeInteger(event.long_filled_micro_usdc, "carry_long_filled");
    const shortFilled = nonNegativeInteger(event.short_filled_micro_usdc, "carry_short_filled");
    const hedgeError = nonNegativeInteger(event.hedge_error_micro_usdc, "carry_hedge_error");
    position.long_filled_micro_usdc = longFilled;
    position.short_filled_micro_usdc = shortFilled;
    position.hedge_error_micro_usdc = hedgeError;
    if (longFilled === position.target_notional_micro_usdc && shortFilled === position.target_notional_micro_usdc && hedgeError <= position.risk_mandate.max_hedge_error_micro_usdc) {
      position.status = "active";
      position.next_actions = ["monitor_carry_and_margin"];
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
      if (runway === null) {
        if (status !== "healthy" && status !== "warning") unverifiableMargin = true;
        return status === "critical" || status === "breached";
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
    risk_mandate: normalizeCarryRiskMandate(raw.risk_mandate),
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
  return deepFreeze({
    venue_id: venue(raw.venue_id, "carry_margin_runway_venue"),
    status: enumValue(raw.status, new Set(["healthy", "warning", "critical", "breached"]), "carry_margin_runway_status"),
    runway_ms: raw.runway_ms === null ? null : nonNegativeInteger(raw.runway_ms, "carry_margin_runway_ms"),
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
  return {
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
}

function emptyRealizedValue(modeledNet) {
  return {
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
}

function summarizeRealizedValue(entries, modeledNet) {
  const value = emptyRealizedValue(modeledNet);
  for (const entry of entries) {
    applyRealizedEntry(value, entry);
    if (entry.venue_id !== null) {
      value.by_venue[entry.venue_id] ||= emptyRealizedVenueValue();
      applyRealizedEntry(value.by_venue[entry.venue_id], entry);
    }
  }
  value.net_value_micro_usdc = realizedNetValue(value);
  value.variance_from_modeled_micro_usdc = safeAdd(value.net_value_micro_usdc, -modeledNet, "carry_value_realized_overflow");
  for (const venueValue of Object.values(value.by_venue)) {
    venueValue.net_value_micro_usdc = realizedNetValue(venueValue);
  }
  return value;
}

function emptyRealizedVenueValue() {
  const { variance_from_modeled_micro_usdc: _variance, by_venue: _byVenue, ...value } = emptyRealizedValue(0);
  return value;
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
  ].join("|");
}

function fundingCashMicro(side, notional, contract, horizonMs) {
  const direction = side === "short" ? 1n : -1n;
  const numerator = direction * BigInt(notional) * BigInt(contract.funding_rate_e12_per_interval) * BigInt(horizonMs);
  return safeNumber(floorDiv(numerator, 1_000_000_000_000n * BigInt(contract.funding_interval_ms)));
}

function costE6Bps(costs) {
  return [
    costs.entry_fee_e6_bps,
    costs.exit_fee_e6_bps,
    costs.entry_slippage_e6_bps,
    costs.exit_slippage_e6_bps,
    costs.latency_penalty_bps * 1_000_000,
  ]
    .reduce((sum, value) => safeAdd(sum, value, "carry_cost_bps_overflow"), 0);
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
