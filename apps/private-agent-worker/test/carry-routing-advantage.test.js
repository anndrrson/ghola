import assert from "node:assert/strict";
import test from "node:test";
import { executionVenueSpec } from "@ghola/execution-core";
import { buildCarryRoutingAdvantageEvidence } from "../src/execution/carry-routing-advantage.js";

const NOW = 1_800_000_000_000;

function snapshot(venueId, fundingRate, takerFeeBps) {
  const shadow = executionVenueSpec(venueId).adapter_capabilities.perp_shadow;
  return {
    version: 1,
    venue_id: venueId,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: "USDC",
    collateral_asset: "USDC",
    funding_settlement_asset: "USDC",
    fee_settlement_asset: "USDC",
    asset_valuations: [],
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    best_bid_e8: 9_999_000_000,
    best_ask_e8: 10_001_000_000,
    depth_bids: [{ price_e8: 9_999_000_000, size_e8: 20_000_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000, size_e8: 20_000_000_000 }],
    funding_rate_e12_per_interval: fundingRate,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 0,
    taker_fee_bps: takerFeeBps,
    initial_margin_bps: 1_000,
    maintenance_margin_bps: 500,
    liquidation_fee_bps: 0,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    minimum_notional_micro_usdc: 1_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000,
    as_of_ms: NOW,
    status: "ready",
    stale: false,
  };
}

function venues() {
  return [
    { venue_id: "hyperliquid", ok: true, snapshots: [snapshot("hyperliquid", 0, 20)] },
    { venue_id: "lighter", ok: true, snapshots: [snapshot("lighter", 10_000_000, 0)] },
    { venue_id: "aster", ok: true, snapshots: [snapshot("aster", 100_000_000, 0)] },
  ];
}

function fundingPersistence() {
  const route = (longVenue, shortVenue, longRate, shortRate, suffix) => ({
    asset: "BTC",
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
    ready: true,
    reasons: [],
    sample_count: 8,
    minimum_samples: 8,
    observed_span_ms: 35 * 60_000,
    minimum_span_ms: 30 * 60_000,
    conservative_funding_rate_e12_by_venue: {
      [longVenue]: longRate,
      [shortVenue]: shortRate,
    },
    evidence_commitment: `carry:funding:${suffix.repeat(64)}`,
  });
  return {
    version: 1,
    transaction_broadcast: false,
    routes: [
      route("hyperliquid", "lighter", 0, 10_000_000, "a"),
      route("hyperliquid", "aster", 0, 100_000_000, "b"),
      route("lighter", "aster", 10_000_000, 100_000_000, "c"),
    ],
  };
}

function qualification(overrides = {}) {
  return {
    ready: true,
    release_bound: true,
    transaction_broadcast: false,
    evidence_commitment: `carry:shadow:qualification:${"d".repeat(64)}`,
    image_digest: `sha256:${"e".repeat(64)}`,
    ...overrides,
  };
}

test("commits conservative route savings against the next-best executable route", () => {
  const result = buildCarryRoutingAdvantageEvidence({
    venues: venues(),
    funding_persistence: fundingPersistence(),
    shadow_qualification: qualification(),
    assets: ["BTC"],
    now_ms: NOW,
  });

  assert.equal(result.ready, true);
  assert.equal(result.version, 2);
  assert.equal(result.benchmark_kind, "next_best_executable_route");
  assert.equal(result.modeled, true);
  assert.equal(result.realized, false);
  assert.equal(result.account_fee_tier_included, false);
  assert.equal(result.execution_ready, false);
  assert.equal(result.transaction_broadcast, false);
  assert.match(result.evidence_commitment, /^carry:routing:advantage:[a-f0-9]{64}$/);
  assert.equal(result.routes[0].status, "advantaged");
  assert.deepEqual(result.routes[0].selected_route, {
    long_venue_id: "lighter",
    short_venue_id: "aster",
  });
  assert.deepEqual(result.routes[0].baseline_route, {
    long_venue_id: "hyperliquid",
    short_venue_id: "aster",
  });
  assert.ok(result.routes[0].daily_net_advantage_micro_usdc > 0);
  assert.equal(result.routes[0].sample_count, 8);
  assert.equal(result.routes[0].funding_evidence_commitments.length, 2);
});

test("keeps the routing benchmark venue-neutral", () => {
  const evidence = fundingPersistence();
  const comparison = structuredClone(evidence.routes[2]);
  comparison.long_venue_id = "aster";
  comparison.short_venue_id = "lighter";
  comparison.conservative_funding_rate_e12_by_venue = {
    aster: 100_000_000,
    lighter: 10_000_000,
  };
  evidence.routes = [evidence.routes[2], comparison];
  const result = buildCarryRoutingAdvantageEvidence({
    venues: venues(),
    funding_persistence: evidence,
    shadow_qualification: qualification(),
    assets: ["BTC"],
    now_ms: NOW,
  });

  assert.equal(result.ready, true);
  assert.notEqual(result.routes[0].selected_route.long_venue_id, "hyperliquid");
  assert.notEqual(result.routes[0].selected_route.short_venue_id, "hyperliquid");
  assert.notEqual(result.routes[0].baseline_route.long_venue_id, "hyperliquid");
  assert.notEqual(result.routes[0].baseline_route.short_venue_id, "hyperliquid");
});

test("fails closed without a distinct comparison route", () => {
  const evidence = fundingPersistence();
  evidence.routes = [evidence.routes[2]];
  const result = buildCarryRoutingAdvantageEvidence({
    venues: venues(),
    funding_persistence: evidence,
    shadow_qualification: qualification(),
    assets: ["BTC"],
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.equal(result.routes[0].reasons[0], "comparison_route_unavailable");
  assert.equal(result.failures[0], "routing_advantage_unavailable:BTC");
});

test("fails closed when five-venue evidence is not worker-qualified", () => {
  const result = buildCarryRoutingAdvantageEvidence({
    venues: venues(),
    funding_persistence: fundingPersistence(),
    shadow_qualification: qualification({ release_bound: false }),
    assets: ["BTC"],
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("shadow_market_not_qualified"));
  assert.equal(result.routes[0].ready, true);
});

test("fails closed instead of estimating an unpriced route", () => {
  const unavailable = venues();
  for (const venue of unavailable) venue.snapshots[0].taker_fee_bps = null;
  const result = buildCarryRoutingAdvantageEvidence({
    venues: unavailable,
    funding_persistence: fundingPersistence(),
    shadow_qualification: qualification(),
    assets: ["BTC"],
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.equal(result.routes[0].status, "unavailable");
  assert.ok(result.failures.includes("routing_advantage_unavailable:BTC"));
});
