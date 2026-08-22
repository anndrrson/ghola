import {
  aggregatePortfolioAccounting,
  evaluatePortfolioPlan,
  normalizePortfolioMandate,
  reconcilePortfolioAccounting,
} from "@ghola/execution-core";
import { createHash } from "node:crypto";
import { venueStateForRouting } from "./venue-readiness.js";

const CORE_VENUES = new Set(["hyperliquid", "drift", "coinbase_advanced", "jupiter"]);
const PERP_VENUES = new Set(["hyperliquid", "drift"]);

export function portfolioMandateForSession({ session_id, owner_commitment, policy, now = new Date() }) {
  const allowedVenues = policy.venue_allowlist.filter((venue) => CORE_VENUES.has(venue));
  const allowedAssets = [...new Set(policy.market_allowlist.map(assetForMarket).filter(Boolean))];
  const orderCap = usdToMicro(bucketToUsd(policy.max_notional_bucket));
  const positionCap = usdToMicro(bucketToUsd(policy.max_position_notional_bucket));
  const turnoverCap = usdToMicro(bucketToUsd(policy.max_daily_notional_bucket));
  const mandate = {
    version: 1,
    mandate_id: `mandate:${hash(policy.policy_commitment).slice(0, 32)}`,
    network: policy.execution_network,
    custody_model: "self_custodial_turnkey",
    owner_wallet_id: `owner:${hash(owner_commitment).slice(0, 32)}`,
    agent_wallet_id: `agent:${hash(session_id).slice(0, 32)}`,
    allowed_venues: allowedVenues,
    allowed_assets: allowedAssets,
    allowed_strategies: strategiesForPolicy(policy),
    configured_leverage_x100: policy.configured_leverage_x100,
    max_leverage_x100: policy.max_leverage_x100,
    min_liquidation_distance_bps: policy.min_liquidation_distance_bps,
    max_gross_exposure_micro_usdc: Math.max(1, Math.min(turnoverCap, positionCap * Math.max(1, allowedAssets.length))),
    max_net_exposure_micro_usdc: Math.max(1, positionCap),
    max_asset_concentration_bps: policy.max_asset_concentration_bps,
    max_daily_turnover_micro_usdc: Math.max(1, turnoverCap),
    daily_loss_limit_micro_usdc: Math.max(1, usdToMicro(bucketToUsd(policy.daily_loss_limit_bucket) || bucketToUsd(policy.max_notional_bucket))),
    max_drawdown_micro_usdc: Math.max(1, usdToMicro(bucketToUsd(policy.max_drawdown_bucket) || bucketToUsd(policy.max_position_notional_bucket))),
    max_drawdown_bps: policy.max_drawdown_bps,
    max_funding_bps_8h: policy.max_funding_bps_8h,
    max_basis_bps: policy.max_basis_bps,
    max_fee_bps: policy.max_fee_bps,
    max_gas_micro_usdc: policy.max_gas_micro_usdc,
    max_open_orders: policy.max_open_orders,
    max_model_decisions_per_hour: policy.max_model_decisions_per_hour,
    max_model_cost_micro_usdc_per_day: policy.max_model_cost_micro_usdc_per_day,
    data_max_age_ms: policy.data_max_age_ms,
    min_expected_net_benefit_bps: policy.min_net_edge_bps,
    expires_at_ms: new Date(policy.expires_at).getTime(),
    kill_switch: policy.kill_switch === true,
    reduce_only: policy.reduce_only === true,
    mainnet_activation_id: policy.mainnet_activation_id,
  };
  const normalized = normalizePortfolioMandate(mandate);
  return Object.freeze({
    ...normalized,
    authorization: Object.freeze({
      kind: "body_bound_worker_capability",
      policy_commitment: policy.policy_commitment,
      owner_authorization_commitment: policy.owner_authorization_commitment,
      created_at_ms: now.getTime(),
    }),
  });
}

export function evaluateAutopilotPortfolioProposal({
  session,
  positions = [],
  proposal,
  market,
  model_decisions_last_hour = 0,
  model_cost_today_micro_usdc = 0,
  now = new Date(),
  env = process.env,
}) {
  const mandate = session.portfolio_mandate;
  if (!mandate) return denied("portfolio_mandate_missing");
  if (!CORE_VENUES.has(proposal.venue_id)) return denied("portfolio_venue_contract_unavailable");
  if (mandate.network === "paper" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    return denied("paper_network_requires_dry_run");
  }
  if (mandate.network === "mainnet") {
    if (!mandate.authorization?.owner_authorization_commitment) {
      return denied("owner_mandate_authorization_required");
    }
    if (session.portfolio_accounting?.reconciliation?.reconciled !== true) {
      return denied("portfolio_reconciliation_required");
    }
    if (!session.portfolio_accounting.aggregate?.custody?.some((item) => item.venue_id === proposal.venue_id)) {
      return denied("venue_accounting_required");
    }
  }
  const portfolio = session.portfolio_accounting?.portfolio_state || portfolioStateFromSession({
    session,
    positions,
    model_decisions_last_hour,
    model_cost_today_micro_usdc,
    now,
  });
  const costs = proposal.routing?.selected_costs || {};
  const productType = proposalProductType(proposal);
  const notionalMicro = usdToMicro(proposal.notional_usd);
  const plan = {
    version: 1,
    plan_id: `plan:${hash(proposal.proposal_commitment).slice(0, 32)}`,
    network: mandate.network,
    custody_model: mandate.custody_model,
    owner_wallet_id: mandate.owner_wallet_id,
    agent_wallet_id: mandate.agent_wallet_id,
    strategy_id: proposal.objective || "best_execution",
    risk_effect: proposal.instruction?.order?.reduce_only === true ? "reduce" : "increase",
    as_of_ms: observedAt(market, now),
    benefit_source: "deterministic_market_state",
    expected_gross_benefit_bps: integer(proposal.routing?.expected_gross_benefit_bps ?? proposal.signal_bps, 0),
    model_decision_id: proposal.decision_id || null,
    model_cost_micro_usdc: integer(proposal.model_cost_micro_usdc, 0),
    legs: [{
      venue_id: proposal.venue_id,
      asset: assetForMarket(proposal.market),
      market: normalizeMarket(proposal.market),
      product_type: productType,
      operation_class: proposal.operation_class,
      side: proposal.side,
      notional_micro_usdc: notionalMicro,
      leverage_x100: productType === "perp" ? mandate.configured_leverage_x100 : 100,
      liquidation_distance_bps: productType === "perp"
        ? integer(market?.projected_liquidation_distance_bps, mandate.min_liquidation_distance_bps)
        : 100_000,
      reduce_only: proposal.instruction?.order?.reduce_only === true,
      spread_bps: integer(costs.price_bps, Math.ceil(integer(market?.spread_bps, 0) / 2)),
      slippage_bps: integer(costs.slippage_bps, 0),
      fee_bps: integer(costs.fee_bps, 0),
      funding_bps_8h: integer(costs.funding_bps, integer(market?.funding_bps_8h, 0)),
      borrow_bps: integer(costs.borrow_bps, integer(market?.borrow_bps, 0)),
      basis_bps: integer(market?.basis_bps, 0),
      latency_penalty_bps: integer(costs.latency_bps, 0),
      gas_micro_usdc: integer(proposal.routing?.selected_quote?.gas_micro_usdc, 0),
    }],
  };
  const venueState = venueStateForRouting({
    venue_id: proposal.venue_id,
    access: session.venue_access?.[proposal.venue_id] || {},
    market_observed_at_ms: observedAt(market, now),
    market_latency_ms: integer(market?.latency_ms, 0),
    now_ms: now.getTime(),
    env,
  });
  return evaluatePortfolioPlan({ mandate, portfolio, plan, venue_states: [venueState], now_ms: now.getTime() });
}

export function evaluateAutopilotMultiLegPlan({
  session,
  positions = [],
  strategy_id,
  legs,
  expected_gross_benefit_bps,
  plan_commitment,
  now = new Date(),
  env = process.env,
}) {
  const mandate = session.portfolio_mandate;
  if (!mandate) return denied("portfolio_mandate_missing");
  if (mandate.network === "paper" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    return denied("paper_network_requires_dry_run");
  }
  if (!Array.isArray(legs) || legs.length < 2 || legs.some((leg) => !CORE_VENUES.has(leg.venue_id))) {
    return denied("portfolio_venue_contract_unavailable");
  }
  if (mandate.network === "mainnet") {
    if (!mandate.authorization?.owner_authorization_commitment) {
      return denied("owner_mandate_authorization_required");
    }
    if (session.portfolio_accounting?.reconciliation?.reconciled !== true) {
      return denied("portfolio_reconciliation_required");
    }
    const accounted = new Set(session.portfolio_accounting.aggregate?.custody?.map((item) => item.venue_id));
    if (legs.some((leg) => !accounted.has(leg.venue_id))) return denied("venue_accounting_required");
  }
  const portfolio = session.portfolio_accounting?.portfolio_state || portfolioStateFromSession({
    session,
    positions,
    model_decisions_last_hour: 0,
    model_cost_today_micro_usdc: 0,
    now,
  });
  const normalizedLegs = legs.map((leg) => ({
    venue_id: leg.venue_id,
    asset: leg.asset || assetForMarket(leg.market),
    market: normalizeMarket(leg.market),
    product_type: leg.product_type,
    operation_class: leg.operation_class,
    side: leg.side,
    notional_micro_usdc: leg.notional_micro_usdc,
    leverage_x100: leg.product_type === "perp" ? mandate.configured_leverage_x100 : 100,
    liquidation_distance_bps: leg.product_type === "perp"
      ? integer(leg.liquidation_distance_bps, 100_000)
      : 100_000,
    reduce_only: leg.reduce_only === true,
    spread_bps: integer(leg.spread_bps, 0),
    slippage_bps: integer(leg.slippage_bps, 0),
    fee_bps: integer(leg.fee_bps, 0),
    funding_bps_8h: integer(leg.funding_bps_8h, 0),
    borrow_bps: integer(leg.borrow_bps, 0),
    basis_bps: integer(leg.basis_bps, 0),
    latency_penalty_bps: integer(leg.latency_penalty_bps, 0),
    gas_micro_usdc: integer(leg.gas_micro_usdc, 0),
  }));
  const plan = {
    version: 1,
    plan_id: `plan:${hash(plan_commitment).slice(0, 32)}`,
    network: mandate.network,
    custody_model: mandate.custody_model,
    owner_wallet_id: mandate.owner_wallet_id,
    agent_wallet_id: mandate.agent_wallet_id,
    strategy_id,
    risk_effect: normalizedLegs.every((leg) => leg.reduce_only) ? "reduce" : "neutral",
    as_of_ms: now.getTime(),
    benefit_source: "deterministic_market_state",
    expected_gross_benefit_bps: integer(expected_gross_benefit_bps, 0),
    model_decision_id: null,
    model_cost_micro_usdc: 0,
    legs: normalizedLegs,
  };
  const venueStates = [...new Set(normalizedLegs.map((leg) => leg.venue_id))].map((venueId) =>
    venueStateForRouting({
      venue_id: venueId,
      access: session.venue_access?.[venueId] || {},
      market_observed_at_ms: now.getTime(),
      market_latency_ms: integer(session.venue_access?.[venueId]?.latency_ms, 0),
      now_ms: now.getTime(),
      env,
    })
  );
  return evaluatePortfolioPlan({ mandate, portfolio, plan, venue_states: venueStates, now_ms: now.getTime() });
}

export function reconcileSessionPortfolio({ session, expected_snapshots, observed_snapshots, now = new Date() }) {
  const maxAge = session.portfolio_mandate?.data_max_age_ms || session.session_policy.data_max_age_ms;
  const reconciliation = reconcilePortfolioAccounting({
    expected: expected_snapshots,
    observed: observed_snapshots,
    now_ms: now.getTime(),
    max_age_ms: maxAge,
  });
  const aggregate = aggregatePortfolioAccounting({
    snapshots: observed_snapshots,
    now_ms: now.getTime(),
    max_age_ms: maxAge,
  });
  const prior = session.portfolio_accounting?.portfolio_state;
  const portfolioState = {
    version: 1,
    as_of_ms: aggregate.as_of_ms,
    equity_micro_usdc: aggregate.equity_micro_usdc,
    day_start_equity_micro_usdc: prior?.day_start_equity_micro_usdc ?? aggregate.equity_micro_usdc,
    peak_equity_micro_usdc: Math.max(prior?.peak_equity_micro_usdc ?? 0, aggregate.equity_micro_usdc),
    daily_turnover_micro_usdc: usdToMicro(Number(session.daily_notional_used_bucket || 0)),
    open_order_count: aggregate.open_order_count,
    model_decisions_last_hour: prior?.model_decisions_last_hour ?? 0,
    model_cost_today_micro_usdc: prior?.model_cost_today_micro_usdc ?? 0,
    positions: observed_snapshots.flatMap((snapshot) => snapshot.positions.map((position) => ({
      venue_id: snapshot.venue_id,
      asset: position.asset,
      market: position.market,
      product_type: position.product_type,
      signed_notional_micro_usdc: position.signed_notional_micro_usdc,
      leverage_x100: position.leverage_x100,
      liquidation_distance_bps: position.liquidation_distance_bps,
    }))),
  };
  return Object.freeze({
    version: 1,
    status: reconciliation.reconciled && aggregate.status === "ready" ? "reconciled" : "frozen",
    aggregate,
    reconciliation,
    portfolio_state: Object.freeze(portfolioState),
    updated_at: now.toISOString(),
  });
}

function portfolioStateFromSession({ session, positions, model_decisions_last_hour, model_cost_today_micro_usdc, now }) {
  const normalizedPositions = positions
    .filter((position) => CORE_VENUES.has(position.venue_id))
    .map((position) => {
      const notional = integer(
        position.signed_notional_micro_usdc,
        usdToMicro(Number(position.estimated_exposure_notional_usd ?? position.notional_usd ?? 0)) * (position.side === "sell" ? -1 : 1),
      );
      const productType = position.product_type || (PERP_VENUES.has(position.venue_id) ? "perp" : "spot");
      return {
        venue_id: position.venue_id,
        asset: position.asset || assetForMarket(position.market),
        market: normalizeMarket(position.market),
        product_type: productType,
        signed_notional_micro_usdc: notional,
        leverage_x100: productType === "perp" ? integer(position.leverage_x100, session.portfolio_mandate.configured_leverage_x100) : 100,
        liquidation_distance_bps: productType === "perp"
          ? integer(position.liquidation_distance_bps, 100_000)
          : 100_000,
      };
    });
  const equity = Math.max(
    session.portfolio_mandate.max_gross_exposure_micro_usdc * 2,
    session.portfolio_mandate.max_net_exposure_micro_usdc * 2,
  );
  return {
    version: 1,
    as_of_ms: now.getTime(),
    equity_micro_usdc: equity,
    day_start_equity_micro_usdc: equity,
    peak_equity_micro_usdc: equity,
    daily_turnover_micro_usdc: usdToMicro(Number(session.daily_notional_used_bucket || 0)),
    open_order_count: session.pending_execution ? 1 : 0,
    model_decisions_last_hour: integer(model_decisions_last_hour, 0),
    model_cost_today_micro_usdc: integer(model_cost_today_micro_usdc, 0),
    positions: normalizedPositions,
  };
}

function proposalProductType(proposal) {
  if (proposal.product_type === "spot" || proposal.product_type === "perp") return proposal.product_type;
  return PERP_VENUES.has(proposal.venue_id) ? "perp" : "spot";
}

function strategiesForPolicy(policy) {
  if (policy.strategy_id === "delta_neutral_carry_v1") return ["delta_neutral_carry"];
  if (policy.strategy_id === "hedged_spread_arbitrage_v1") return ["spot_perp_hedge"];
  return ["best_execution", "exposure_rebalance"];
}

function observedAt(market, now) {
  const parsed = Date.parse(String(market?.fetched_at || market?.observed_at || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : now.getTime();
}

function denied(reason) {
  return Object.freeze({ version: 1, allowed: false, reasons: [reason], action_class: "risk_increase", metrics: null });
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL/USDC" || upper === "SOL-USDC") return "SOL-USD";
  return upper;
}

function assetForMarket(value) {
  return normalizeMarket(value).split(/[-/]/)[0] || null;
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function usdToMicro(value) {
  const number = Math.round(Number(value || 0) * 1_000_000);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function hash(value) {
  return createHash("sha256").update(String(value || "unknown")).digest("hex");
}
