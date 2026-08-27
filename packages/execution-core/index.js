const ID = /^[A-Za-z0-9:_-]{8,160}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

import {
  SUPPORTED_EXECUTION_VENUES,
  requiredVenueCapabilities,
} from "./venues.js";

export { advanceMultiLegSaga, createMultiLegSaga } from "./multi-leg.js";
export {
  aggregateExecutionQuality,
  aggregatePortfolioAccounting,
  buildExecutionQualityReceipt,
  normalizeVenueAccountingSnapshot,
  reconcilePortfolioAccounting,
} from "./accounting.js";
export {
  CarryModelError,
  adverseExecutionSlippageE6Bps,
  appendCarryValueLedgerEntry,
  advanceCarryPosition,
  calculateMarginRunway,
  carryCollateralReviewMessage,
  carryRiskMandateMessage,
  compileCarryCapitalActionPlan,
  compileCarryCollateralReview,
  compileCarryPortfolioCapitalPlan,
  compileCarryPortfolioValueReport,
  compileCarryMigrationProposal,
  createCarryPosition,
  createCarryValueLedger,
  evaluateCarryOpportunity,
  evaluatePerpContractPairBasis,
  estimatePerpDepthExecution,
  finalizeCarryValueLedger,
  normalizeCarryRiskMandate,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
  normalizeCarryCollateralReviewPayload,
  normalizePerpContractSpec,
} from "./carry.js";
export {
  CARRY_BROWSER_STREAM_VENUES,
  CARRY_EXECUTION_VENUES,
  CORE_PERP_VENUES,
  EXECUTION_VENUE_SPECS,
  SUPPORTED_EXECUTION_VENUES,
  exactQuantityRecoveryAdapter,
  executionVenueSpec,
  isCarryExecutionVenue,
  isExecutionVenue,
  requiredVenueCapabilities,
  supportsExactQuantityRecovery,
  venueAdapterCapability,
  venueSupportsProduct,
  venuesWithAdapterCapability,
} from "./venues.js";

export const EXECUTION_CORE_VERSION = 1;
export const SUPPORTED_STRATEGIES = Object.freeze([
  "best_execution",
  "spot_perp_hedge",
  "delta_neutral_carry",
  "exposure_rebalance",
]);
export const PORTFOLIO_SIGNING_BOUNDARY = Object.freeze({
  model: Object.freeze(["structured_proposal"]),
  deterministic: Object.freeze(["route", "size", "risk_veto", "unwind"]),
  agent: Object.freeze(["allowed_order", "managed_cancel", "reduce_only"]),
  owner_only: Object.freeze([
    "fund",
    "withdraw",
    "transfer",
    "configure_leverage",
    "activate_mainnet",
    "revoke_agent",
  ]),
});

export class ExecutionCoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionCoreError";
    this.code = code;
  }
}

export function normalizePortfolioMandate(value) {
  const raw = object(value, "mandate_required");
  version(raw.version, "mandate_version");
  const mandateId = identifier(raw.mandate_id, "mandate_id");
  const ownerWalletId = identifier(raw.owner_wallet_id, "owner_wallet_id");
  const agentWalletId = identifier(raw.agent_wallet_id, "agent_wallet_id");
  if (ownerWalletId === agentWalletId) fail("wallet_separation", "Owner and agent wallets must differ.");
  if (raw.custody_model !== "self_custodial_turnkey") {
    fail("custody_model", "Only self-custodial Turnkey wallets are supported.");
  }
  const allowedVenues = normalizedSet(raw.allowed_venues, SUPPORTED_EXECUTION_VENUES, "allowed_venues", 16);
  const allowedAssets = uniqueArray(raw.allowed_assets, "allowed_assets", 50).map((item) => asset(item, "allowed_asset"));
  if (allowedAssets.length === 0) fail("allowed_assets", "At least one asset is required.");
  const allowedStrategies = normalizedSet(raw.allowed_strategies, SUPPORTED_STRATEGIES, "allowed_strategies", 4);
  const configuredLeverageX100 = boundedInteger(raw.configured_leverage_x100, 100, 5_000, "configured_leverage_x100");
  const maxLeverageX100 = boundedInteger(raw.max_leverage_x100, 100, 5_000, "max_leverage_x100");
  if (configuredLeverageX100 > maxLeverageX100) {
    fail("configured_leverage", "Configured leverage exceeds the mandate maximum.");
  }
  const network = enumValue(raw.network, ["paper", "testnet", "mainnet"], "network");
  const mainnetActivationId = optionalIdentifier(raw.mainnet_activation_id, "mainnet_activation_id");

  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    mandate_id: mandateId,
    network,
    custody_model: "self_custodial_turnkey",
    owner_wallet_id: ownerWalletId,
    agent_wallet_id: agentWalletId,
    allowed_venues: allowedVenues,
    allowed_assets: allowedAssets,
    allowed_strategies: allowedStrategies,
    configured_leverage_x100: configuredLeverageX100,
    max_leverage_x100: maxLeverageX100,
    min_liquidation_distance_bps: boundedInteger(raw.min_liquidation_distance_bps, 1, 10_000, "min_liquidation_distance_bps"),
    max_gross_exposure_micro_usdc: positiveInteger(raw.max_gross_exposure_micro_usdc, "max_gross_exposure"),
    max_net_exposure_micro_usdc: positiveInteger(raw.max_net_exposure_micro_usdc, "max_net_exposure"),
    max_asset_concentration_bps: boundedInteger(raw.max_asset_concentration_bps, 1, 10_000, "max_asset_concentration_bps"),
    max_daily_turnover_micro_usdc: positiveInteger(raw.max_daily_turnover_micro_usdc, "max_daily_turnover"),
    daily_loss_limit_micro_usdc: positiveInteger(raw.daily_loss_limit_micro_usdc, "daily_loss_limit"),
    max_drawdown_micro_usdc: positiveInteger(raw.max_drawdown_micro_usdc, "max_drawdown"),
    max_drawdown_bps: boundedInteger(raw.max_drawdown_bps, 1, 10_000, "max_drawdown_bps"),
    max_funding_bps_8h: boundedInteger(raw.max_funding_bps_8h, 0, 10_000, "max_funding_bps_8h"),
    max_basis_bps: boundedInteger(raw.max_basis_bps, 0, 10_000, "max_basis_bps"),
    max_fee_bps: boundedInteger(raw.max_fee_bps, 0, 10_000, "max_fee_bps"),
    max_gas_micro_usdc: nonNegativeInteger(raw.max_gas_micro_usdc, "max_gas"),
    max_open_orders: boundedInteger(raw.max_open_orders, 0, 1_000, "max_open_orders"),
    max_model_decisions_per_hour: boundedInteger(raw.max_model_decisions_per_hour, 0, 10_000, "max_model_decisions_per_hour"),
    max_model_cost_micro_usdc_per_day: nonNegativeInteger(raw.max_model_cost_micro_usdc_per_day, "max_model_cost"),
    data_max_age_ms: boundedInteger(raw.data_max_age_ms, 250, 300_000, "data_max_age_ms"),
    min_expected_net_benefit_bps: boundedInteger(raw.min_expected_net_benefit_bps, 0, 10_000, "min_expected_net_benefit_bps"),
    expires_at_ms: positiveInteger(raw.expires_at_ms, "expires_at_ms"),
    kill_switch: raw.kill_switch === true,
    reduce_only: raw.reduce_only === true,
    mainnet_activation_id: mainnetActivationId,
    owner_only_operations: PORTFOLIO_SIGNING_BOUNDARY.owner_only,
  });
}

export function normalizePortfolioState(value) {
  const raw = object(value, "portfolio_state_required");
  version(raw.version, "portfolio_state_version");
  const positions = array(raw.positions, "positions", 1_000).map(normalizePosition);
  const exposureByAsset = {};
  let grossExposure = 0;
  for (const position of positions) {
    grossExposure = safeAdd(grossExposure, Math.abs(position.signed_notional_micro_usdc), "gross_exposure_overflow");
    exposureByAsset[position.asset] = safeAdd(
      exposureByAsset[position.asset] || 0,
      position.signed_notional_micro_usdc,
      "net_exposure_overflow",
    );
  }
  const netExposure = Object.values(exposureByAsset).reduce(
    (sum, amount) => safeAdd(sum, Math.abs(amount), "net_exposure_overflow"),
    0,
  );
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    as_of_ms: positiveInteger(raw.as_of_ms, "portfolio_as_of"),
    equity_micro_usdc: nonNegativeInteger(raw.equity_micro_usdc, "equity"),
    day_start_equity_micro_usdc: nonNegativeInteger(raw.day_start_equity_micro_usdc, "day_start_equity"),
    peak_equity_micro_usdc: nonNegativeInteger(raw.peak_equity_micro_usdc, "peak_equity"),
    daily_turnover_micro_usdc: nonNegativeInteger(raw.daily_turnover_micro_usdc, "daily_turnover"),
    open_order_count: nonNegativeInteger(raw.open_order_count, "open_order_count"),
    model_decisions_last_hour: nonNegativeInteger(raw.model_decisions_last_hour, "model_decisions_last_hour"),
    model_cost_today_micro_usdc: nonNegativeInteger(raw.model_cost_today_micro_usdc, "model_cost_today"),
    positions,
    gross_exposure_micro_usdc: grossExposure,
    net_exposure_micro_usdc: netExposure,
    signed_exposure_micro_usdc_by_asset: exposureByAsset,
  });
}

export function assessVenueReadiness({ venue_state, required_capabilities, now_ms = Date.now(), max_age_ms }) {
  const venue = normalizeVenueState(venue_state);
  const required = required_capabilities === undefined
    ? requiredVenueCapabilities({ venue_id: venue.venue_id })
    : uniqueArray(required_capabilities, "required_capabilities", 32).map((item) => text(item, "required_capability"));
  const reasons = [];
  if (venue.status === "quarantined") reasons.push("venue_quarantined");
  else if (venue.status !== "ready") reasons.push(`venue_${venue.status}`);
  if (venue.as_of_ms > now_ms || now_ms - venue.as_of_ms > boundedInteger(max_age_ms, 250, 300_000, "max_age_ms")) {
    reasons.push("venue_state_stale");
  }
  for (const capability of required) {
    if (venue.capabilities[capability] !== true) reasons.push(`capability_missing:${capability}`);
  }
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    venue_id: venue.venue_id,
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checked_at_ms: now_ms,
  });
}

export function rankExecutionRoutes({ intent: intentInput, quotes: quoteInputs, venue_states = [], now_ms = Date.now() }) {
  const intent = normalizeRouteIntent(intentInput);
  const venueStates = new Map(array(venue_states, "venue_states", 16).map((state) => {
    const normalized = normalizeVenueState(state);
    return [normalized.venue_id, normalized];
  }));
  const candidates = array(quoteInputs, "quotes", 1_000).map((input) => {
    let quote;
    try {
      quote = normalizeRouteQuote(input);
    } catch (error) {
      return rejectedQuote(input, error instanceof ExecutionCoreError ? error.code : "quote_invalid");
    }
    const reasons = [];
    if (quote.market !== intent.market) reasons.push("market_mismatch");
    if (quote.asset !== intent.asset) reasons.push("asset_mismatch");
    if (quote.side !== intent.side) reasons.push("side_mismatch");
    if (quote.product_type !== intent.product_type) reasons.push("product_type_mismatch");
    if (!intent.allowed_venues.includes(quote.venue_id)) reasons.push("venue_not_allowed");
    if (quote.notional_micro_usdc < intent.notional_micro_usdc) reasons.push("quote_notional_too_small");
    if (quote.available_notional_micro_usdc < intent.notional_micro_usdc) reasons.push("liquidity_insufficient");
    if (quote.fee_bps > intent.max_fee_bps) reasons.push("fee_limit");
    if (quote.slippage_bps > intent.max_slippage_bps) reasons.push("slippage_limit");
    if (quote.gas_micro_usdc > intent.max_gas_micro_usdc) reasons.push("gas_limit");
    if (quote.latency_ms > intent.max_latency_ms) reasons.push("latency_limit");
    if (quote.as_of_ms > now_ms || now_ms - quote.as_of_ms > intent.data_max_age_ms) reasons.push("quote_stale");
    const venueState = venueStates.get(quote.venue_id);
    if (!venueState) {
      reasons.push("venue_state_missing");
    } else {
      const readiness = assessVenueReadiness({
        venue_state: venueState,
        required_capabilities: routeCapabilities(quote),
        now_ms,
        max_age_ms: intent.data_max_age_ms,
      });
      reasons.push(...readiness.reasons);
    }
    const priceCostBps = adversePriceBps(intent.side, quote.execution_price_e8, intent.reference_price_e8);
    const gasBps = ratioBps(quote.gas_micro_usdc, intent.notional_micro_usdc);
    const totalCostBps = safeCostSum([
      priceCostBps,
      quote.fee_bps,
      quote.slippage_bps,
      quote.funding_bps,
      quote.borrow_bps,
      quote.latency_penalty_bps,
      gasBps,
    ]);
    const netBenefitBps = intent.expected_gross_benefit_bps - totalCostBps;
    if (intent.autonomous && netBenefitBps < intent.min_expected_net_benefit_bps) {
      reasons.push("expected_net_benefit_below_floor");
    }
    return deepFreeze({
      version: EXECUTION_CORE_VERSION,
      venue_id: quote.venue_id,
      operation_class: quote.operation_class,
      status: reasons.length === 0 ? "ready" : "blocked",
      reasons: [...new Set(reasons)],
      execution_price_e8: quote.execution_price_e8,
      available_notional_micro_usdc: quote.available_notional_micro_usdc,
      latency_ms: quote.latency_ms,
      costs: {
        price_bps: priceCostBps,
        fee_bps: quote.fee_bps,
        slippage_bps: quote.slippage_bps,
        funding_bps: quote.funding_bps,
        borrow_bps: quote.borrow_bps,
        latency_bps: quote.latency_penalty_bps,
        gas_bps: gasBps,
        total_bps: totalCostBps,
      },
      expected_gross_benefit_bps: intent.expected_gross_benefit_bps,
      expected_net_benefit_bps: netBenefitBps,
      quote,
    });
  });
  const ranked = candidates
    .filter((candidate) => candidate.status === "ready")
    .sort((left, right) =>
      left.costs.total_bps - right.costs.total_bps ||
      left.latency_ms - right.latency_ms ||
      left.venue_id.localeCompare(right.venue_id));
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    ok: ranked.length > 0,
    selected: ranked[0] || null,
    ranked,
    candidates,
    reason: ranked.length > 0 ? null : "no_route_passed",
    checked_at_ms: now_ms,
  });
}

export function evaluatePortfolioPlan({ mandate: mandateInput, portfolio: portfolioInput, plan: planInput, venue_states = [], now_ms = Date.now() }) {
  let mandate;
  let portfolio;
  let plan;
  try {
    mandate = normalizePortfolioMandate(mandateInput);
    portfolio = normalizePortfolioState(portfolioInput);
    plan = normalizePlan(planInput);
  } catch (error) {
    return denied(error instanceof ExecutionCoreError ? error.code : "risk_input_invalid");
  }
  const reasons = [];
  const reducing = plan.risk_effect === "reduce" && plan.legs.every((leg) => leg.reduce_only);
  check(reasons, now_ms <= mandate.expires_at_ms, "mandate_expired");
  check(reasons, plan.network === mandate.network, "network_mismatch");
  check(reasons, plan.owner_wallet_id === mandate.owner_wallet_id, "owner_wallet_mismatch");
  check(reasons, plan.agent_wallet_id === mandate.agent_wallet_id, "agent_wallet_mismatch");
  check(reasons, plan.custody_model === mandate.custody_model, "custody_model_mismatch");
  check(reasons, mandate.allowed_strategies.includes(plan.strategy_id), "strategy_not_allowed");
  check(reasons, !mandate.kill_switch || reducing, "kill_switch_active");
  check(reasons, !mandate.reduce_only || reducing, "mandate_reduce_only");
  check(reasons, portfolio.as_of_ms <= now_ms && now_ms - portfolio.as_of_ms <= mandate.data_max_age_ms, "portfolio_state_stale");
  check(reasons, plan.as_of_ms <= now_ms && now_ms - plan.as_of_ms <= mandate.data_max_age_ms, "plan_stale");
  if (plan.network === "mainnet") check(reasons, Boolean(mandate.mainnet_activation_id), "owner_mainnet_activation_required");

  const venueStateMap = new Map(array(venue_states, "venue_states", 16).map((state) => {
    const normalized = normalizeVenueState(state);
    return [normalized.venue_id, normalized];
  }));
  let projectedGross = portfolio.gross_exposure_micro_usdc;
  const projectedByAsset = { ...portfolio.signed_exposure_micro_usdc_by_asset };
  let plannedTurnover = 0;
  let plannedGas = 0;
  let weightedCosts = 0n;
  let totalNotional = 0;
  let minLiquidationDistance = 10_000;

  for (const position of portfolio.positions) {
    if (position.product_type === "perp") {
      minLiquidationDistance = Math.min(minLiquidationDistance, position.liquidation_distance_bps);
      check(reasons, position.liquidation_distance_bps >= mandate.min_liquidation_distance_bps || reducing, "liquidation_distance_limit");
    }
  }
  for (const leg of plan.legs) {
    check(reasons, mandate.allowed_venues.includes(leg.venue_id), "venue_not_allowed");
    check(reasons, mandate.allowed_assets.includes(leg.asset), "asset_not_allowed");
    if (leg.product_type === "perp") {
      check(reasons, leg.leverage_x100 === mandate.configured_leverage_x100 || leg.reduce_only, "leverage_changed");
      check(reasons, leg.leverage_x100 <= mandate.max_leverage_x100 || leg.reduce_only, "leverage_limit");
    }
    check(reasons, Math.abs(leg.funding_bps_8h) <= mandate.max_funding_bps_8h || leg.reduce_only, "funding_limit");
    check(reasons, Math.abs(leg.basis_bps) <= mandate.max_basis_bps || leg.reduce_only, "basis_limit");
    check(reasons, leg.fee_bps <= mandate.max_fee_bps || leg.reduce_only, "fee_limit");
    plannedGas = safeAdd(plannedGas, leg.gas_micro_usdc, "gas_overflow");
    plannedTurnover = safeAdd(plannedTurnover, leg.notional_micro_usdc, "turnover_overflow");
    totalNotional = safeAdd(totalNotional, leg.notional_micro_usdc, "notional_overflow");
    weightedCosts += BigInt(leg.notional_micro_usdc) * BigInt(legCostBps(leg));
    if (leg.product_type === "perp") {
      minLiquidationDistance = Math.min(minLiquidationDistance, leg.liquidation_distance_bps);
      check(reasons, leg.liquidation_distance_bps >= mandate.min_liquidation_distance_bps || leg.reduce_only, "liquidation_distance_limit");
    }
    projectedByAsset[leg.asset] = safeAdd(
      projectedByAsset[leg.asset] || 0,
      leg.side === "buy" ? leg.notional_micro_usdc : -leg.notional_micro_usdc,
      "net_exposure_overflow",
    );
    projectedGross = leg.reduce_only
      ? Math.max(0, projectedGross - leg.notional_micro_usdc)
      : safeAdd(projectedGross, leg.notional_micro_usdc, "gross_exposure_overflow");
    const venueState = venueStateMap.get(leg.venue_id);
    if (!venueState) {
      reasons.push("venue_state_missing");
    } else {
      const readiness = assessVenueReadiness({
        venue_state: venueState,
        required_capabilities: planCapabilities(leg),
        now_ms,
        max_age_ms: mandate.data_max_age_ms,
      });
      if (!readiness.ready && !reducing) reasons.push(...readiness.reasons);
    }
  }
  const projectedNet = Object.values(projectedByAsset).reduce(
    (sum, amount) => safeAdd(sum, Math.abs(amount), "net_exposure_overflow"),
    0,
  );
  const maxAssetExposure = Math.max(0, ...Object.values(projectedByAsset).map(Math.abs));
  const concentrationBps = projectedGross > 0 ? ratioBps(maxAssetExposure, projectedGross) : 0;
  const dailyLoss = Math.max(0, portfolio.day_start_equity_micro_usdc - portfolio.equity_micro_usdc);
  const drawdown = Math.max(0, portfolio.peak_equity_micro_usdc - portfolio.equity_micro_usdc);
  const drawdownBps = portfolio.peak_equity_micro_usdc > 0
    ? ratioBps(drawdown, portfolio.peak_equity_micro_usdc)
    : 10_000;
  const modeledCostBps = totalNotional > 0 ? conservativeWeightedBps(weightedCosts, totalNotional) : 0;
  const expectedNetBenefitBps = plan.expected_gross_benefit_bps - modeledCostBps;

  check(reasons, plannedGas <= mandate.max_gas_micro_usdc || reducing, "gas_limit");
  check(reasons, portfolio.open_order_count + plan.legs.length <= mandate.max_open_orders || reducing, "open_order_limit");
  check(reasons, portfolio.daily_turnover_micro_usdc + plannedTurnover <= mandate.max_daily_turnover_micro_usdc || reducing, "daily_turnover_limit");
  check(reasons, dailyLoss < mandate.daily_loss_limit_micro_usdc || reducing, "daily_loss_limit_reached");
  check(reasons, drawdown < mandate.max_drawdown_micro_usdc || reducing, "drawdown_usd_limit_reached");
  check(reasons, drawdownBps < mandate.max_drawdown_bps || reducing, "drawdown_bps_limit_reached");
  check(reasons, projectedGross <= mandate.max_gross_exposure_micro_usdc || reducing, "gross_exposure_limit");
  check(reasons, projectedNet <= mandate.max_net_exposure_micro_usdc || reducing, "net_exposure_limit");
  check(reasons, concentrationBps <= mandate.max_asset_concentration_bps || reducing, "asset_concentration_limit");
  if (plan.model_decision_id) {
    check(reasons, portfolio.model_decisions_last_hour < mandate.max_model_decisions_per_hour, "model_decision_budget_exhausted");
    check(
      reasons,
      portfolio.model_cost_today_micro_usdc + plan.model_cost_micro_usdc <= mandate.max_model_cost_micro_usdc_per_day,
      "model_cost_budget_exhausted",
    );
  }
  check(reasons, plan.benefit_source === "deterministic_market_state", "deterministic_benefit_required");
  check(reasons, expectedNetBenefitBps >= mandate.min_expected_net_benefit_bps || reducing, "expected_net_benefit_below_floor");

  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    allowed: [...new Set(reasons)].length === 0,
    reasons: [...new Set(reasons)],
    action_class: reducing ? "reduce_only" : "risk_increase",
    metrics: {
      projected_gross_exposure_micro_usdc: projectedGross,
      projected_net_exposure_micro_usdc: projectedNet,
      projected_asset_concentration_bps: concentrationBps,
      daily_loss_micro_usdc: dailyLoss,
      drawdown_micro_usdc: drawdown,
      drawdown_bps: drawdownBps,
      minimum_liquidation_distance_bps: minLiquidationDistance,
      planned_turnover_micro_usdc: plannedTurnover,
      planned_gas_micro_usdc: plannedGas,
      modeled_cost_bps: modeledCostBps,
      expected_net_benefit_bps: expectedNetBenefitBps,
      checked_at_ms: now_ms,
    },
    signing_boundary: PORTFOLIO_SIGNING_BOUNDARY,
  });
}

function normalizeVenueState(value) {
  const raw = object(value, "venue_state_required");
  version(raw.version, "venue_state_version");
  const venueId = enumValue(raw.venue_id, SUPPORTED_EXECUTION_VENUES, "venue_id");
  const capabilities = object(raw.capabilities, "venue_capabilities");
  const normalizedCapabilities = {};
  for (const [key, enabled] of Object.entries(capabilities)) normalizedCapabilities[text(key, "capability")] = enabled === true;
  return {
    version: EXECUTION_CORE_VERSION,
    venue_id: venueId,
    status: enumValue(raw.status, ["ready", "degraded", "down", "quarantined"], "venue_status"),
    as_of_ms: positiveInteger(raw.as_of_ms, "venue_as_of"),
    latency_ms: nonNegativeInteger(raw.latency_ms ?? 0, "venue_latency"),
    capabilities: normalizedCapabilities,
  };
}

function normalizePosition(value) {
  const raw = object(value, "position_invalid");
  const productType = enumValue(raw.product_type, ["spot", "perp"], "position_product_type");
  return {
    venue_id: enumValue(raw.venue_id, SUPPORTED_EXECUTION_VENUES, "position_venue"),
    asset: asset(raw.asset, "position_asset"),
    market: market(raw.market, "position_market"),
    product_type: productType,
    signed_notional_micro_usdc: integer(raw.signed_notional_micro_usdc, "position_notional"),
    leverage_x100: productType === "perp" ? boundedInteger(raw.leverage_x100, 100, 10_000, "position_leverage") : 100,
    liquidation_distance_bps: productType === "perp"
      ? boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "position_liquidation_distance")
      : 100_000,
  };
}

function normalizeRouteIntent(value) {
  const raw = object(value, "route_intent_required");
  version(raw.version, "route_intent_version");
  return {
    version: EXECUTION_CORE_VERSION,
    market: market(raw.market, "route_market"),
    asset: asset(raw.asset, "route_asset"),
    side: enumValue(raw.side, ["buy", "sell"], "route_side"),
    product_type: enumValue(raw.product_type, ["spot", "perp"], "route_product_type"),
    notional_micro_usdc: positiveInteger(raw.notional_micro_usdc, "route_notional"),
    reference_price_e8: positiveInteger(raw.reference_price_e8, "route_reference_price"),
    allowed_venues: normalizedSet(raw.allowed_venues, SUPPORTED_EXECUTION_VENUES, "route_allowed_venues", 16),
    data_max_age_ms: boundedInteger(raw.data_max_age_ms, 250, 300_000, "route_data_max_age"),
    max_fee_bps: boundedInteger(raw.max_fee_bps ?? 10_000, 0, 10_000, "route_max_fee_bps"),
    max_slippage_bps: boundedInteger(raw.max_slippage_bps ?? 10_000, 0, 10_000, "route_max_slippage_bps"),
    max_gas_micro_usdc: nonNegativeInteger(raw.max_gas_micro_usdc ?? Number.MAX_SAFE_INTEGER, "route_max_gas"),
    max_latency_ms: nonNegativeInteger(raw.max_latency_ms ?? 300_000, "route_max_latency"),
    autonomous: raw.autonomous === true,
    expected_gross_benefit_bps: boundedInteger(raw.expected_gross_benefit_bps ?? 0, -10_000, 100_000, "expected_gross_benefit_bps"),
    min_expected_net_benefit_bps: boundedInteger(raw.min_expected_net_benefit_bps ?? 0, 0, 10_000, "min_expected_net_benefit_bps"),
  };
}

function normalizeRouteQuote(value) {
  const raw = object(value, "route_quote_required");
  version(raw.version, "route_quote_version");
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    venue_id: enumValue(raw.venue_id, SUPPORTED_EXECUTION_VENUES, "quote_venue"),
    market: market(raw.market, "quote_market"),
    asset: asset(raw.asset, "quote_asset"),
    side: enumValue(raw.side, ["buy", "sell"], "quote_side"),
    product_type: enumValue(raw.product_type, ["spot", "perp"], "quote_product_type"),
    operation_class: text(raw.operation_class, "quote_operation_class"),
    notional_micro_usdc: positiveInteger(raw.notional_micro_usdc, "quote_notional"),
    available_notional_micro_usdc: nonNegativeInteger(raw.available_notional_micro_usdc, "quote_liquidity"),
    execution_price_e8: positiveInteger(raw.execution_price_e8, "quote_execution_price"),
    fee_bps: boundedInteger(raw.fee_bps, 0, 10_000, "quote_fee_bps"),
    slippage_bps: boundedInteger(raw.slippage_bps, 0, 10_000, "quote_slippage_bps"),
    funding_bps: boundedInteger(raw.funding_bps ?? 0, -10_000, 10_000, "quote_funding_bps"),
    borrow_bps: boundedInteger(raw.borrow_bps ?? 0, 0, 10_000, "quote_borrow_bps"),
    latency_penalty_bps: boundedInteger(raw.latency_penalty_bps ?? 0, 0, 10_000, "quote_latency_penalty_bps"),
    gas_micro_usdc: nonNegativeInteger(raw.gas_micro_usdc ?? 0, "quote_gas"),
    latency_ms: nonNegativeInteger(raw.latency_ms ?? 0, "quote_latency"),
    as_of_ms: positiveInteger(raw.as_of_ms, "quote_as_of"),
  });
}

function normalizePlan(value) {
  const raw = object(value, "plan_required");
  version(raw.version, "plan_version");
  if (raw.custody_model !== "self_custodial_turnkey") fail("plan_custody_model", "Plan custody must be self-custodial Turnkey.");
  const benefitSource = enumValue(raw.benefit_source, ["deterministic_market_state"], "benefit_source");
  return {
    version: EXECUTION_CORE_VERSION,
    plan_id: identifier(raw.plan_id, "plan_id"),
    network: enumValue(raw.network, ["paper", "testnet", "mainnet"], "plan_network"),
    custody_model: "self_custodial_turnkey",
    owner_wallet_id: identifier(raw.owner_wallet_id, "plan_owner_wallet_id"),
    agent_wallet_id: identifier(raw.agent_wallet_id, "plan_agent_wallet_id"),
    strategy_id: enumValue(raw.strategy_id, SUPPORTED_STRATEGIES, "plan_strategy"),
    risk_effect: enumValue(raw.risk_effect, ["increase", "reduce", "neutral"], "risk_effect"),
    as_of_ms: positiveInteger(raw.as_of_ms, "plan_as_of"),
    benefit_source: benefitSource,
    expected_gross_benefit_bps: boundedInteger(raw.expected_gross_benefit_bps, -10_000, 100_000, "plan_expected_benefit"),
    model_decision_id: optionalIdentifier(raw.model_decision_id, "model_decision_id"),
    model_cost_micro_usdc: nonNegativeInteger(raw.model_cost_micro_usdc ?? 0, "model_cost"),
    legs: array(raw.legs, "plan_legs", 16, 1).map(normalizePlanLeg),
  };
}

function normalizePlanLeg(value) {
  const raw = object(value, "plan_leg_invalid");
  const productType = enumValue(raw.product_type, ["spot", "perp"], "leg_product_type");
  return {
    venue_id: enumValue(raw.venue_id, SUPPORTED_EXECUTION_VENUES, "leg_venue"),
    asset: asset(raw.asset, "leg_asset"),
    market: market(raw.market, "leg_market"),
    product_type: productType,
    operation_class: text(raw.operation_class, "leg_operation_class"),
    side: enumValue(raw.side, ["buy", "sell"], "leg_side"),
    notional_micro_usdc: positiveInteger(raw.notional_micro_usdc, "leg_notional"),
    leverage_x100: productType === "perp" ? boundedInteger(raw.leverage_x100, 100, 10_000, "leg_leverage") : 100,
    liquidation_distance_bps: productType === "perp"
      ? boundedInteger(raw.liquidation_distance_bps, 0, 100_000, "leg_liquidation_distance")
      : 100_000,
    reduce_only: raw.reduce_only === true,
    spread_bps: boundedInteger(raw.spread_bps ?? 0, 0, 10_000, "leg_spread"),
    slippage_bps: boundedInteger(raw.slippage_bps ?? 0, 0, 10_000, "leg_slippage"),
    fee_bps: boundedInteger(raw.fee_bps ?? 0, 0, 10_000, "leg_fee"),
    funding_bps_8h: boundedInteger(raw.funding_bps_8h ?? 0, -10_000, 10_000, "leg_funding"),
    borrow_bps: boundedInteger(raw.borrow_bps ?? 0, 0, 10_000, "leg_borrow"),
    basis_bps: boundedInteger(raw.basis_bps ?? 0, -100_000, 100_000, "leg_basis"),
    latency_penalty_bps: boundedInteger(raw.latency_penalty_bps ?? 0, 0, 10_000, "leg_latency_penalty"),
    gas_micro_usdc: nonNegativeInteger(raw.gas_micro_usdc ?? 0, "leg_gas"),
  };
}

function routeCapabilities(quote) {
  return requiredVenueCapabilities(quote);
}

function planCapabilities(leg) {
  return requiredVenueCapabilities(leg);
}

function legCostBps(leg) {
  const gasBps = ratioBps(leg.gas_micro_usdc, leg.notional_micro_usdc);
  return safeCostSum([
    leg.spread_bps,
    leg.slippage_bps,
    leg.fee_bps,
    leg.funding_bps_8h,
    leg.borrow_bps,
    leg.latency_penalty_bps,
    gasBps,
  ]);
}

function adversePriceBps(side, executionPrice, referencePrice) {
  const numerator = side === "buy" ? executionPrice - referencePrice : referencePrice - executionPrice;
  return signedRatioBps(numerator, referencePrice);
}

function ratioBps(numerator, denominator) {
  if (denominator <= 0) fail("ratio_denominator", "Ratio denominator must be positive.");
  return safeBigIntToNumber(divideConservative(BigInt(numerator) * 10_000n, BigInt(denominator)), "ratio_overflow");
}

function signedRatioBps(numerator, denominator) {
  if (denominator <= 0) fail("ratio_denominator", "Ratio denominator must be positive.");
  return safeBigIntToNumber(divideConservative(BigInt(numerator) * 10_000n, BigInt(denominator)), "ratio_overflow");
}

function conservativeWeightedBps(weighted, totalNotional) {
  return safeBigIntToNumber(divideConservative(weighted, BigInt(totalNotional)), "weighted_cost_overflow");
}

function divideConservative(numerator, denominator) {
  if (numerator >= 0n) return (numerator + denominator - 1n) / denominator;
  return numerator / denominator;
}

function safeCostSum(values) {
  return values.reduce((sum, value) => safeAdd(sum, value, "cost_overflow"), 0);
}

function rejectedQuote(value, code) {
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    venue_id: typeof value?.venue_id === "string" ? value.venue_id : "invalid",
    operation_class: typeof value?.operation_class === "string" ? value.operation_class : "invalid",
    status: "blocked",
    reasons: [code],
    costs: null,
    expected_gross_benefit_bps: null,
    expected_net_benefit_bps: null,
    quote: null,
    latency_ms: Number.isSafeInteger(value?.latency_ms) ? value.latency_ms : 0,
  });
}

function denied(code) {
  return deepFreeze({
    version: EXECUTION_CORE_VERSION,
    allowed: false,
    reasons: [code],
    action_class: "invalid",
    metrics: null,
    signing_boundary: PORTFOLIO_SIGNING_BOUNDARY,
  });
}

function normalizedSet(value, allowed, code, max) {
  const normalized = uniqueArray(value, code, max).map((item) => enumValue(item, allowed, code));
  if (normalized.length === 0) fail(code, `${code} must not be empty.`);
  return normalized;
}

function safeAdd(left, right, code) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail(code, "Integer overflow.");
  return value;
}

function safeBigIntToNumber(value, code) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail(code, "Integer overflow.");
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function check(reasons, condition, code) {
  if (!condition) reasons.push(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${code} must be an object.`);
  return value;
}

function array(value, code, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code, `${code} has an invalid length.`);
  return value;
}

function uniqueArray(value, code, max) {
  const items = array(value, code, max);
  if (new Set(items).size !== items.length) fail(code, `${code} contains duplicates.`);
  return [...items];
}

function version(value, code) {
  if (integer(value, code) !== EXECUTION_CORE_VERSION) fail(code, "Unsupported version.");
}

function identifier(value, code) {
  const normalized = text(value, code);
  if (!ID.test(normalized)) fail(code, `${code} is invalid.`);
  return normalized;
}

function optionalIdentifier(value, code) {
  return value === undefined || value === null || value === "" ? null : identifier(value, code);
}

function asset(value, code) {
  const normalized = text(value, code).toUpperCase();
  if (!ASSET.test(normalized)) fail(code, `${code} is invalid.`);
  return normalized;
}

function market(value, code) {
  const normalized = text(value, code).toUpperCase();
  if (!MARKET.test(normalized)) fail(code, `${code} is invalid.`);
  return normalized;
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) fail(code, `${code} is unsupported.`);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code, `${code} is required.`);
  return value.trim();
}

function integer(value, code) {
  if (!Number.isSafeInteger(value)) fail(code, `${code} must be a safe integer.`);
  return value;
}

function positiveInteger(value, code) {
  const normalized = integer(value, code);
  if (normalized <= 0) fail(code, `${code} must be positive.`);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = integer(value, code);
  if (normalized < 0) fail(code, `${code} must not be negative.`);
  return normalized;
}

function boundedInteger(value, min, max, code) {
  const normalized = integer(value, code);
  if (normalized < min || normalized > max) fail(code, `${code} is outside bounds.`);
  return normalized;
}

function fail(code, message) {
  throw new ExecutionCoreError(code, message);
}
