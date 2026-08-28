import { createHash } from "node:crypto";
import {
  CARRY_EXECUTION_VENUES,
  adverseExecutionSlippageE6Bps,
  estimatePerpDepthExecution,
  evaluateCarryOpportunity,
} from "@ghola/execution-core";

const DAY_MS = 86_400_000;
const DEFAULT_NOTIONAL_MICRO_USDC = 10_000_000_000;
const FUNDING_COMMITMENT = /^carry:funding:[a-f0-9]{64}$/;
const QUALIFICATION_COMMITMENT = /^carry:shadow:qualification:[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{12,128}$/;

export function buildCarryRoutingAdvantageEvidence({
  venues,
  funding_persistence: fundingPersistence,
  shadow_qualification: shadowQualification,
  assets = [],
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const requestedAssets = normalizeAssets(assets);
  const notionalMicro = boundedInteger(
    env.PRIVATE_AGENT_CARRY_ROUTING_MODEL_NOTIONAL_MICRO_USDC,
    1_000_000,
    1_000_000_000_000,
    DEFAULT_NOTIONAL_MICRO_USDC,
  );
  const failures = [];
  if (!qualificationReady(shadowQualification)) failures.push("shadow_market_not_qualified");
  if (fundingPersistence?.transaction_broadcast !== false || !Array.isArray(fundingPersistence?.routes)) {
    failures.push("funding_persistence_unavailable");
  }

  const venueMap = new Map((Array.isArray(venues) ? venues : [])
    .filter((venue) => CARRY_EXECUTION_VENUES.includes(venue?.venue_id))
    .map((venue) => [venue.venue_id, venue]));
  const modeledRoutes = (Array.isArray(fundingPersistence?.routes) ? fundingPersistence.routes : [])
    .filter((route) => requestedAssets.includes(route?.asset))
    .flatMap((route) => {
      if (!fundingRouteReady(route)) return [];
      try {
        return [modelRoute({ route, venueMap, notionalMicro, nowMs })];
      } catch {
        return [];
      }
    });

  const routes = requestedAssets.map((asset) => {
    const candidates = modeledRoutes.filter((route) => route.asset === asset);
    if (new Set(candidates.map(routeKey)).size !== candidates.length) {
      failures.push(`routing_advantage_unavailable:${asset}`);
      return unavailableRoute(asset, "duplicate_route_evidence");
    }
    if (candidates.length < 2) {
      failures.push(`routing_advantage_unavailable:${asset}`);
      return unavailableRoute(asset, candidates.length === 0
        ? "modeled_route_unavailable"
        : "comparison_route_unavailable");
    }
    const selected = bestRoute(candidates);
    const baseline = bestRoute(candidates.filter((route) => !sameRoute(route, selected)));
    const dailyAdvantage = selected.modeled_net_micro_usdc_per_day - baseline.modeled_net_micro_usdc_per_day;
    return Object.freeze({
      asset,
      status: dailyAdvantage > 0 ? "advantaged" : dailyAdvantage < 0 ? "disadvantaged" : "equal",
      selected_route: routeIdentity(selected),
      baseline_route: routeIdentity(baseline),
      selected_modeled_net_micro_usdc_per_day: selected.modeled_net_micro_usdc_per_day,
      baseline_modeled_net_micro_usdc_per_day: baseline.modeled_net_micro_usdc_per_day,
      daily_net_advantage_micro_usdc: dailyAdvantage,
      daily_net_advantage_e6_bps: ratioE6Bps(dailyAdvantage, notionalMicro),
      sample_count: Math.min(selected.sample_count, baseline.sample_count),
      minimum_samples: Math.max(selected.minimum_samples, baseline.minimum_samples),
      observed_span_ms: Math.min(selected.observed_span_ms, baseline.observed_span_ms),
      minimum_span_ms: Math.max(selected.minimum_span_ms, baseline.minimum_span_ms),
      funding_evidence_commitments: Object.freeze([...new Set([
        selected.funding_evidence_commitment,
        baseline.funding_evidence_commitment,
      ])].sort()),
      ready: true,
      reasons: Object.freeze([]),
    });
  });

  const record = {
    version: 2,
    kind: "carry_routing_advantage",
    ready: failures.length === 0 && routes.length === requestedAssets.length && routes.every((route) => route.ready),
    failures: [...new Set(failures)],
    benchmark_kind: "next_best_executable_route",
    execution_venue_ids: [...CARRY_EXECUTION_VENUES],
    requested_assets: requestedAssets,
    notional_micro_usdc: notionalMicro,
    horizon_ms: DAY_MS,
    modeled: true,
    realized: false,
    account_fee_tier_included: false,
    execution_ready: false,
    transaction_broadcast: false,
    shadow_qualification_commitment: shadowQualification?.evidence_commitment || null,
    observer_image_digest: shadowQualification?.image_digest || null,
    observed_at_ms: nowMs,
    routes,
  };
  record.evidence_commitment = evidenceCommitment(record);
  return Object.freeze(record);
}

function modelRoute({ route, venueMap, notionalMicro, nowMs }) {
  const longSnapshot = trustedSnapshot(venueMap.get(route.long_venue_id), route.asset, nowMs);
  const shortSnapshot = trustedSnapshot(venueMap.get(route.short_venue_id), route.asset, nowMs);
  const conservativeRates = route.conservative_funding_rate_e12_by_venue;
  const longContract = contractSpec(longSnapshot, conservativeRates[route.long_venue_id]);
  const shortContract = contractSpec(shortSnapshot, conservativeRates[route.short_venue_id]);
  const longCosts = legCosts(longSnapshot, "buy", notionalMicro);
  const shortCosts = legCosts(shortSnapshot, "sell", notionalMicro);
  if ([...longCosts.depth_impact, ...shortCosts.depth_impact].some((item) => item.status !== "sufficient")) {
    throw new Error("routing_depth_insufficient");
  }
  const collateralBasisRiskBps = collateralBasisRisk(longContract.collateral_asset, shortContract.collateral_asset);
  const opportunity = evaluateCarryOpportunity({
    version: 1,
    long_contract: longContract,
    short_contract: shortContract,
    notional_micro_usdc: notionalMicro,
    capital_committed_micro_usdc: notionalMicro * 2,
    horizon_ms: DAY_MS,
    long_costs: longCosts,
    short_costs: shortCosts,
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 10,
    collateral_basis_risk_bps: collateralBasisRiskBps,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 0,
    margin_runways: [
      { venue_id: route.long_venue_id, status: "healthy", runway_ms: null },
      { venue_id: route.short_venue_id, status: "healthy", runway_ms: null },
    ],
    now_ms: nowMs,
    max_data_age_ms: 60_000,
    max_contract_data_skew_ms: 2_000,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
  });
  if (!opportunity.contract_pair_basis.eligible) throw new Error("routing_contract_pair_invalid");
  return Object.freeze({
    asset: route.asset,
    long_venue_id: route.long_venue_id,
    short_venue_id: route.short_venue_id,
    modeled_net_micro_usdc_per_day: opportunity.projected_net_value_micro_usdc,
    sample_count: route.sample_count,
    minimum_samples: route.minimum_samples,
    observed_span_ms: route.observed_span_ms,
    minimum_span_ms: route.minimum_span_ms,
    funding_evidence_commitment: route.evidence_commitment,
  });
}

function contractSpec(snapshot, conservativeFundingRate) {
  if (typeof snapshot.maker_fee_bps !== "number" || !Number.isFinite(snapshot.maker_fee_bps)
    || typeof snapshot.taker_fee_bps !== "number" || !Number.isFinite(snapshot.taker_fee_bps)) {
    throw new Error("routing_fee_unavailable");
  }
  const makerFee = snapshot.maker_fee_bps;
  const takerFee = snapshot.taker_fee_bps;
  return {
    version: 1,
    venue_id: snapshot.venue_id,
    contract_id: snapshot.contract_id,
    economic_equivalence_id: snapshot.economic_equivalence_id,
    asset: snapshot.asset,
    market: snapshot.market,
    quote_asset: snapshot.quote_asset,
    collateral_asset: snapshot.collateral_asset,
    contract_type: snapshot.contract_type,
    mark_price_e8: snapshot.mark_price_e8,
    index_price_e8: snapshot.index_price_e8,
    funding_rate_bps_per_interval: Math.trunc(conservativeFundingRate / 100_000_000),
    funding_rate_e12_per_interval: conservativeFundingRate,
    funding_interval_ms: snapshot.funding_interval_ms,
    maker_fee_bps: Math.ceil(makerFee),
    taker_fee_bps: Math.ceil(takerFee),
    maker_fee_e6_bps: Math.round(makerFee * 1_000_000),
    taker_fee_e6_bps: Math.round(takerFee * 1_000_000),
    minimum_notional_micro_usdc: snapshot.minimum_notional_micro_usdc,
    quantity_step_e8: snapshot.quantity_step_e8,
    price_tick_e8: snapshot.price_tick_e8,
    as_of_ms: snapshot.as_of_ms,
  };
}

function legCosts(snapshot, entrySide, notionalMicro) {
  const exitSide = entrySide === "buy" ? "sell" : "buy";
  const entry = depthExecution(snapshot, entrySide, notionalMicro, "entry");
  const exit = depthExecution(snapshot, exitSide, notionalMicro, "exit");
  const feeE6Bps = Math.round(Number(snapshot.taker_fee_bps) * 1_000_000);
  return {
    venue_id: snapshot.venue_id,
    entry_fee_e6_bps: feeE6Bps,
    exit_fee_e6_bps: feeE6Bps,
    entry_slippage_e6_bps: adverseExecutionSlippageE6Bps({
      side: entrySide,
      mark_price_e8: snapshot.mark_price_e8,
      execution_price_e8: entry.execution_price_e8,
    }),
    exit_slippage_e6_bps: adverseExecutionSlippageE6Bps({
      side: exitSide,
      mark_price_e8: snapshot.mark_price_e8,
      execution_price_e8: exit.execution_price_e8,
    }),
    latency_penalty_bps: 1,
    gas_micro_usdc: 0,
    depth_impact: Object.freeze([entry, exit]),
  };
}

function depthExecution(snapshot, side, notionalMicro, phase) {
  return estimatePerpDepthExecution({
    side,
    depth_levels: side === "buy" ? snapshot.depth_asks : snapshot.depth_bids,
    fallback_price_e8: side === "buy" ? snapshot.best_ask_e8 : snapshot.best_bid_e8,
    target_notional_micro_usdc: notionalMicro,
    phase,
  });
}

function trustedSnapshot(venue, asset, nowMs) {
  const snapshot = venue?.snapshots?.find((item) => item?.asset === asset);
  if (venue?.ok !== true || snapshot?.status !== "ready" || snapshot.stale === true) throw new Error("routing_snapshot_unavailable");
  if (!Number.isSafeInteger(snapshot.as_of_ms) || snapshot.as_of_ms > nowMs || nowMs - snapshot.as_of_ms > 60_000) {
    throw new Error("routing_snapshot_stale");
  }
  return snapshot;
}

function fundingRouteReady(route) {
  const rates = route?.conservative_funding_rate_e12_by_venue;
  return route?.ready === true
    && Array.isArray(route.reasons) && route.reasons.length === 0
    && CARRY_EXECUTION_VENUES.includes(route.long_venue_id)
    && CARRY_EXECUTION_VENUES.includes(route.short_venue_id)
    && route.long_venue_id !== route.short_venue_id
    && Number.isSafeInteger(route.sample_count) && route.sample_count >= route.minimum_samples
    && Number.isSafeInteger(route.observed_span_ms) && route.observed_span_ms >= route.minimum_span_ms
    && FUNDING_COMMITMENT.test(String(route.evidence_commitment || ""))
    && Number.isSafeInteger(rates?.[route.long_venue_id])
    && Number.isSafeInteger(rates?.[route.short_venue_id]);
}

function qualificationReady(value) {
  return value?.ready === true
    && value.release_bound === true
    && value.transaction_broadcast === false
    && QUALIFICATION_COMMITMENT.test(String(value.evidence_commitment || ""))
    && IMAGE_DIGEST.test(String(value.image_digest || ""));
}

function collateralBasisRisk(longAsset, shortAsset) {
  if (longAsset === shortAsset) return 0;
  const stablecoins = new Set(["USDC", "USDT"]);
  if (stablecoins.has(longAsset) && stablecoins.has(shortAsset)) return 50;
  throw new Error("routing_collateral_basis_unsupported");
}

function bestRoute(routes) {
  return routes.reduce((best, route) =>
    route.modeled_net_micro_usdc_per_day > best.modeled_net_micro_usdc_per_day ? route : best
  );
}

function sameRoute(left, right) {
  return left.long_venue_id === right.long_venue_id
    && left.short_venue_id === right.short_venue_id;
}

function routeKey(route) {
  return `${route.long_venue_id}:${route.short_venue_id}`;
}

function routeIdentity(route) {
  return Object.freeze({
    long_venue_id: route.long_venue_id,
    short_venue_id: route.short_venue_id,
  });
}

function unavailableRoute(asset, reason) {
  return Object.freeze({
    asset,
    status: "unavailable",
    selected_route: null,
    baseline_route: null,
    selected_modeled_net_micro_usdc_per_day: null,
    baseline_modeled_net_micro_usdc_per_day: null,
    daily_net_advantage_micro_usdc: null,
    daily_net_advantage_e6_bps: null,
    sample_count: 0,
    minimum_samples: 0,
    observed_span_ms: 0,
    minimum_span_ms: 0,
    funding_evidence_commitments: Object.freeze([]),
    ready: false,
    reasons: Object.freeze([reason]),
  });
}

function ratioE6Bps(value, notional) {
  return Number(BigInt(value) * 10_000_000_000n / BigInt(notional));
}

function normalizeAssets(assets) {
  return Object.freeze([...new Set((Array.isArray(assets) ? assets : [])
    .map((asset) => String(asset).trim().toUpperCase())
    .filter((asset) => /^[A-Z0-9._-]{1,16}$/.test(asset)))].slice(0, 10));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function evidenceCommitment(record) {
  return `carry:routing:advantage:${createHash("sha256").update(stableJson(record)).digest("hex")}`;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([key, child]) => key !== "evidence_commitment" && child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
