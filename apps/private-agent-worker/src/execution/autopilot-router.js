import {
  SUPPORTED_EXECUTION_VENUES,
  rankExecutionRoutes,
  venueSupportsProduct,
} from "@ghola/execution-core";
import { venueStateForRouting } from "./venue-readiness.js";

const EXECUTION_VENUES = new Set(SUPPORTED_EXECUTION_VENUES);
const DEFAULT_FEE_BPS = Object.freeze({
  jupiter: 10,
  coinbase_advanced: 60,
  hyperliquid: 5,
  drift: 10,
});

export function routeModelProposal({ session, market, decision, signal_bps, env = process.env, now = new Date() }) {
  if (decision.objective === "spot_perp_hedge" || decision.objective === "delta_neutral_carry") {
    return {
      ok: false,
      error: "protected_multi_leg_strategy_required",
      message: "Hedge and carry proposals require the protected multi-leg executor.",
    };
  }
  const marketId = normalizeMarket(decision.market);
  const asset = assetForMarket(marketId);
  const referencePrice = positiveNumber(market.price || market.mid);
  if (!referencePrice) return { ok: false, error: "price_unavailable", message: "No deterministic reference price is available." };
  const referencePriceE8 = Math.round(referencePrice * 100_000_000);
  if (!Number.isSafeInteger(referencePriceE8) || referencePriceE8 <= 0) {
    return { ok: false, error: "price_out_of_range", message: "Reference price is outside the router range." };
  }
  const maxOrderUsd = bucketToUsd(session.session_policy.max_notional_bucket);
  const remainingDailyUsd = Math.max(
    0,
    bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0),
  );
  const operatorCapUsd = positiveNumber(env.PRIVATE_AGENT_ROUTER_MAX_NOTIONAL_USD) || Number.POSITIVE_INFINITY;
  const notionalUsd = Math.min(maxOrderUsd, remainingDailyUsd, operatorCapUsd);
  const notionalMicroUsdc = Math.floor(notionalUsd * 1_000_000);
  if (!Number.isSafeInteger(notionalMicroUsdc) || notionalMicroUsdc <= 0) {
    return { ok: false, error: "notional_cap_exhausted", message: "Deterministic order capacity is exhausted." };
  }
  const observedAtMs = observedAt(market, now);
  const spreadBps = nonNegativeInteger(market.spread_bps, 0);
  const liquidityUsd = positiveNumber(market.available_liquidity_usd || market.liquidity_usd) || notionalUsd;
  const latencyMs = nonNegativeInteger(market.latency_ms, 0);
  const allVenueStates = session.session_policy.venue_allowlist
    .filter((venue) => EXECUTION_VENUES.has(venue))
    .map((venue) => venueStateForRouting({
      venue_id: venue,
      access: session.venue_access?.[venue] || {},
      market_observed_at_ms: observedAtMs,
      market_latency_ms: latencyMs,
      now_ms: now.getTime(),
      env,
    }));
  const ready = allVenueStates.filter((state) => state.status === "ready").map((state) => state.venue_id);
  const productType = ready.some((venue) => venueSupportsProduct(venue, "spot")) ? "spot" : "perp";
  const eligible = ready.filter((venue) => venueSupportsProduct(venue, productType));
  if (eligible.length === 0) return { ok: false, error: "no_routable_venue", message: "No ready venue supports this product." };
  const quotes = eligible
    .filter((venue) => supportsMarket(venue, marketId))
    .map((venue) => {
      const slippageBps = Math.max(
        Math.ceil(spreadBps / 2),
        envInteger(env, `PRIVATE_AGENT_ROUTER_${envKey(venue)}_SLIPPAGE_BPS`, 2, 0, 10_000),
      );
      return {
        version: 1,
        venue_id: venue,
        market: marketId,
        asset,
        side: decision.side,
        product_type: productType,
        operation_class: operationForVenue(venue),
        notional_micro_usdc: notionalMicroUsdc,
        available_notional_micro_usdc: Math.floor(Math.max(0, liquidityUsd) * 1_000_000),
        execution_price_e8: referencePriceE8,
        fee_bps: envInteger(env, `PRIVATE_AGENT_ROUTER_${envKey(venue)}_FEE_BPS`, DEFAULT_FEE_BPS[venue], 0, 10_000),
        slippage_bps: slippageBps,
        funding_bps: productType === "perp" ? signedInteger(market.funding_bps_8h, 0, -10_000, 10_000) : 0,
        borrow_bps: productType === "spot" ? nonNegativeInteger(market.borrow_bps, 0) : 0,
        latency_penalty_bps: envInteger(env, `PRIVATE_AGENT_ROUTER_${envKey(venue)}_LATENCY_PENALTY_BPS`, 0, 0, 10_000),
        gas_micro_usdc: envInteger(env, `PRIVATE_AGENT_ROUTER_${envKey(venue)}_GAS_MICRO_USDC`, 0, 0, Number.MAX_SAFE_INTEGER),
        latency_ms: latencyMs,
        as_of_ms: observedAtMs,
      };
    });
  const venueStates = allVenueStates.filter((state) => eligible.includes(state.venue_id));
  const routed = rankExecutionRoutes({
    intent: {
      version: 1,
      market: marketId,
      asset,
      side: decision.side,
      product_type: productType,
      notional_micro_usdc: notionalMicroUsdc,
      reference_price_e8: referencePriceE8,
      allowed_venues: eligible,
      data_max_age_ms: session.session_policy.data_max_age_ms,
      max_fee_bps: envInteger(env, "PRIVATE_AGENT_ROUTER_MAX_FEE_BPS", 100, 0, 10_000),
      max_slippage_bps: session.session_policy.max_slippage_bps,
      max_gas_micro_usdc: envInteger(env, "PRIVATE_AGENT_ROUTER_MAX_GAS_MICRO_USDC", 1_000_000, 0, Number.MAX_SAFE_INTEGER),
      max_latency_ms: envInteger(env, "PRIVATE_AGENT_ROUTER_MAX_LATENCY_MS", 2_000, 0, 300_000),
      autonomous: true,
      expected_gross_benefit_bps: Math.max(0, nonNegativeInteger(signal_bps, 0)),
      min_expected_net_benefit_bps: session.session_policy.min_net_edge_bps,
    },
    quotes,
    venue_states: venueStates,
    now_ms: now.getTime(),
  });
  if (!routed.ok) {
    return {
      ok: false,
      error: routed.reason,
      message: "No route remained beneficial after deterministic cost and readiness checks.",
      routing: routed,
    };
  }
  return {
    ok: true,
    venue_id: routed.selected.venue_id,
    operation_class: routed.selected.operation_class,
    market: marketId,
    asset,
    product_type: productType,
    side: decision.side,
    notional_usd: notionalUsd,
    reference_price: referencePrice,
    routing: routed,
  };
}

function supportsMarket(venue, market) {
  if (venue === "jupiter") return market === "SOL-USD";
  return market === "SOL-USD" || market === "BTC-USD" || market === "ETH-USD";
}

function operationForVenue(venue) {
  if (venue === "jupiter") return "swap";
  if (venue === "coinbase_advanced") return "spot_market_order";
  if (venue === "drift") return "perp_limit_order";
  return "limit_order";
}

function observedAt(market, now) {
  const parsed = Date.parse(String(market.fetched_at || market.observed_at || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : now.getTime();
}

function assetForMarket(value) {
  return normalizeMarket(value).split(/[-/]/)[0];
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC" || upper === "SOL-USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  return upper;
}

function envKey(venue) {
  return venue.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function signedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function envInteger(env, key, fallback, min, max) {
  const number = Number.parseInt(String(env[key] ?? ""), 10);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
