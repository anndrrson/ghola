import { describe, expect, it } from "vitest";
import { CORE_PERP_VENUES } from "@ghola/execution-core";
import {
  applyCarryLivePatches,
  buildCandidates,
  buildPairCandidates,
  builderModel,
  carryCandidateAgeMs,
  carryMarketQualificationEvidence,
  carryRoutingAdvantage,
  carryRoutingAdvantageEvidence,
  quoteCarryCandidate,
  rankCarryCandidatesByNet,
  type CarryShadowResponse,
} from "@/lib/carry-market";

describe("Carry market model", () => {
  it("derives shadow qualification coverage from the venue registry", () => {
    const qualification = qualificationSummary();
    const evidence = carryMarketQualificationEvidence({
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(qualification.checked_at_ms || 0).toISOString(),
      venues: [],
      shadow_qualification: qualification,
    });
    expect(qualification.venues).toBe(CORE_PERP_VENUES.length);
    expect(qualification.expected_snapshots_per_sample).toBe(CORE_PERP_VENUES.length * qualification.assets);
    expect(evidence).toMatchObject({ status: "ready", value: `${CORE_PERP_VENUES.length}V 3/3` });
  });

  it("chooses the lowest funding long and highest funding short while excluding quarantined venues", () => {
    const candidates = buildCandidates([
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "degraded")),
      venue("lighter", snapshot("lighter", "BTC", 40_000_000, "ready")),
      venue("edgex", snapshot("edgex", "BTC", 90_000_000, "quarantined")),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].long.venue_id).toBe("hyperliquid");
    expect(candidates[0].short.venue_id).toBe("lighter");
    expect(candidates[0].exact).toBe(false);
  });

  it("keeps a valid execution route when a better shadow-only venue exists", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 40_000_000, "ready")),
      venue("edgex", snapshot("edgex", "BTC", 90_000_000, "ready")),
    ];
    expect(buildCandidates(venues)[0].short.venue_id).toBe("edgex");
    expect(buildCandidates(venues, ["hyperliquid", "lighter", "aster"])[0].short.venue_id).toBe("lighter");
  });

  it("ranks every equivalent pair by net value instead of gross funding alone", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 200_000_000, "ready", { taker_fee_bps: 100 })),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const pairs = buildPairCandidates(venues);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].short.venue_id).toBe("lighter");
    const ranked = rankCarryCandidatesByNet(pairs);
    expect(ranked[0].candidate.short.venue_id).toBe("aster");
    expect(ranked[0].quote.expectedNetDailyUsd).toBeGreaterThan(0);
    expect(ranked.find((item) => item.candidate.short.venue_id === "lighter")?.quote.expectedNetDailyUsd)
      .toBeLessThan(0);
  });

  it("quantifies exact-cost route edge against the next-best executable route", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 40_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 10_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    const advantage = carryRoutingAdvantage(ranked[0], ranked);
    expect(advantage).toMatchObject({
      status: "advantaged",
      indicative: true,
      benchmarkKind: "next_best_executable_route",
      selectedRoute: "BTC:lighter:aster",
      baselineRoute: "BTC:hyperliquid:aster",
      reason: null,
    });
    expect(advantage.dailyNetAdvantageUsd).toBeGreaterThan(0);
    expect(advantage.dailyNetAdvantageBps).toBeGreaterThan(0);
  });

  it("refuses a routing-edge claim when another exact executable route is unavailable", () => {
    const ranked = rankCarryCandidatesByNet(buildPairCandidates([
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "degraded", { taker_fee_bps: null })),
      venue("lighter", snapshot("lighter", "BTC", 40_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 80_000_000, "ready")),
    ]));
    const selected = ranked.find((item) => item.candidate.long.venue_id === "lighter") || null;
    expect(carryRoutingAdvantage(selected, ranked)).toMatchObject({
      status: "unavailable",
      indicative: true,
      baselineRoute: null,
      dailyNetAdvantageUsd: null,
      reason: "comparison_route_unavailable",
    });
  });

  it("accepts only worker-committed modeled edge for the selected route", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 40_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 10_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    const selected = ranked[0];
    const pointInTime = carryRoutingAdvantage(selected, ranked);
    const response: CarryShadowResponse = {
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(1_800_000_000_000).toISOString(),
      venues,
      shadow_qualification: qualificationSummary(),
      funding_persistence: fundingPersistenceSummary(),
      routing_advantage: routingAdvantageSummary(),
    };
    const evidence = carryRoutingAdvantageEvidence(response, selected, pointInTime);
    expect(evidence.status).toBe("committed");
    expect(evidence.label).toBe("EDGE✓");
    expect(evidence.advantage).toMatchObject({
      status: "advantaged",
      selectedRoute: "BTC:lighter:aster",
      baselineRoute: "BTC:hyperliquid:aster",
      dailyNetAdvantageUsd: 1.25,
      dailyNetAdvantageBps: 1.25,
    });
    expect(evidence.selectedNet).toEqual({
      benchmarkKind: "no_trade",
      dailyNetUsd: 3.5,
      dailyNetBps: 3.5,
      sampleCount: 8,
    });
    expect(evidence.detail).toContain("worker-committed modeled net");
    expect(evidence.detail).toContain("not realized P&L");
  });

  it("accepts selected-route history longer than the comparison route", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 40_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 10_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    const summary = routingAdvantageSummary();
    summary.routes[0].selected_value!.sample_count = 12;
    summary.routes[0].selected_value!.observed_span_ms = 2 * 60 * 60_000;
    const evidence = carryRoutingAdvantageEvidence({
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(1_800_000_000_000).toISOString(),
      venues,
      shadow_qualification: qualificationSummary(),
      funding_persistence: fundingPersistenceSummary(),
      routing_advantage: summary,
    }, ranked[0], carryRoutingAdvantage(ranked[0], ranked));
    expect(evidence.status).toBe("committed");
    expect(evidence.label).toBe("EDGE✓");
    expect(evidence.selectedNet?.sampleCount).toBe(12);
  });

  it("shows worker-committed net value without inventing route savings", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 40_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 10_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    const selected = ranked[0];
    const summary = routingAdvantageSummary();
    const route = summary.routes[0];
    summary.ready = false;
    summary.failures = ["routing_advantage_unavailable:BTC"];
    route.status = "unavailable";
    route.baseline_route = null;
    route.baseline_modeled_net_micro_usdc_per_day = null;
    route.daily_net_advantage_micro_usdc = null;
    route.daily_net_advantage_e6_bps = null;
    route.funding_evidence_commitments = [`carry:funding:${"a".repeat(64)}`];
    route.ready = false;
    route.reasons = ["comparison_route_unavailable"];
    const evidence = carryRoutingAdvantageEvidence({
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(1_800_000_000_000).toISOString(),
      venues,
      shadow_qualification: qualificationSummary(),
      funding_persistence: fundingPersistenceSummary(),
      routing_advantage: summary,
    }, selected, carryRoutingAdvantage(selected, ranked));
    expect(evidence).toMatchObject({
      status: "committed",
      label: "NET✓",
      advantage: {
        status: "advantaged",
        benchmarkKind: "no_trade",
        selectedRoute: "BTC:lighter:aster",
        baselineRoute: null,
        dailyNetAdvantageUsd: 3.5,
        dailyNetAdvantageBps: 3.5,
      },
      selectedNet: {
        benchmarkKind: "no_trade",
        dailyNetUsd: 3.5,
        dailyNetBps: 3.5,
        sampleCount: 8,
      },
    });
    expect(evidence.detail).toContain("no second funding-qualified route exists");
    expect(evidence.detail).toContain("not realized P&L");
  });

  it("rejects a forged ready routing advantage", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 40_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 10_000_000, "ready")),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    const pointInTime = carryRoutingAdvantage(ranked[0], ranked);
    const summary = routingAdvantageSummary();
    summary.evidence_commitment = "forged";
    const evidence = carryRoutingAdvantageEvidence({
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(1_800_000_000_000).toISOString(),
      venues,
      shadow_qualification: qualificationSummary(),
      funding_persistence: fundingPersistenceSummary(),
      routing_advantage: summary,
    }, ranked[0], pointInTime);
    expect(evidence.status).toBe("rejected");
    expect(evidence.label).toBe("EDGE!");
    expect(evidence.advantage.dailyNetAdvantageBps).toBeNull();
  });

  it("ranks a proven positive-net route above a larger unpriced spread", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 200_000_000, "degraded", { taker_fee_bps: null })),
      venue("aster", snapshot("aster", "BTC", 150_000_000, "ready")),
    ];
    const ranked = rankCarryCandidatesByNet(buildPairCandidates(venues));
    expect(ranked[0].candidate.short.venue_id).toBe("aster");
    expect(ranked[0].economics_quality).toBe("positive_net");
    expect(ranked.find((item) => item.candidate.short.venue_id === "lighter")?.economics_quality)
      .toBe("gross_only");
  });

  it("excludes same-ticker contracts when equivalence, basis, or synchronization evidence fails", () => {
    const base = snapshot("hyperliquid", "BTC", 10_000_000, "ready");
    const differentContract = snapshot("lighter", "BTC", 40_000_000, "ready", {
      economic_equivalence_id: "carry:BTC-other-index",
    });
    const divergentIndex = snapshot("lighter", "BTC", 40_000_000, "ready", {
      index_price_e8: 6_015_600_000_000,
    });
    const unsynchronized = snapshot("lighter", "BTC", 40_000_000, "ready", {
      as_of_ms: 1_800_000_003_000,
    });
    expect(buildPairCandidates([venue("hyperliquid", base), venue("lighter", differentContract)]))
      .toHaveLength(0);
    expect(buildPairCandidates([venue("hyperliquid", base), venue("lighter", divergentIndex)]))
      .toHaveLength(0);
    expect(buildPairCandidates([venue("hyperliquid", base), venue("lighter", unsynchronized)]))
      .toHaveLength(0);
  });

  it("separates execution cost from conservative risk-adjusted projected net", () => {
    const long = snapshot("hyperliquid", "BTC", 10_000_000, "ready");
    const short = snapshot("lighter", "BTC", 40_000_000, "ready");
    const [candidate] = buildCandidates([venue("hyperliquid", long), venue("lighter", short)]);
    const result = builderModel(candidate, "10000", "30");
    expect(result.costUsd).not.toBeNull();
    expect(result.costUsd).toBeGreaterThan(result.tradingFeeUsd! + result.slippageUsd!);
    expect(result.netUsd).toBe(result.grossFundingUsd - result.costUsd!);
    expect(result.minimumCollateralUsd).toBe(750);
    expect(result.requiredOpeningCapitalUsd).toBe(20_000);
    expect(result.capitalPlan).toEqual([
      expect.objectContaining({ venueId: "hyperliquid", requiredOpeningCapitalUsd: 10_000, executionLeverage: 1 }),
      expect.objectContaining({ venueId: "lighter", requiredOpeningCapitalUsd: 10_000, executionLeverage: 1 }),
    ]);
    expect(result.breakEvenDays).toBeGreaterThan(0);
    expect(result.netUsd).toBeTypeOf("number");
    expect(result.publicInputsComplete).toBe(true);
    expect(result.creatable).toBe(false);
    expect(result.contractsComparable).toBe(true);
    expect(result.contractDataSkewMs).toBe(0);
    expect(result.indexPriceDivergenceBps).toBe(0);
    expect(result.markPriceDivergenceBps).toBe(0);
  });

  it("surfaces capital-free public contract synchronization and basis evidence", () => {
    const long = snapshot("hyperliquid", "BTC", 10_000_000, "ready", {
      as_of_ms: 1_800_000_000_000,
      index_price_e8: 6_000_000_000_000,
      mark_price_e8: 6_000_000_000_000,
    });
    const short = snapshot("lighter", "BTC", 40_000_000, "ready", {
      as_of_ms: 1_800_000_000_400,
      index_price_e8: 6_001_200_000_000,
      mark_price_e8: 6_001_800_000_000,
    });
    const [candidate] = buildCandidates([venue("hyperliquid", long), venue("lighter", short)]);
    const result = builderModel(candidate, "10000", "30");
    expect(result).toMatchObject({
      contractsComparable: true,
      contractDataSkewMs: 400,
      indexPriceDivergenceBps: 2,
      markPriceDivergenceBps: 3,
    });
  });

  it("charges capital, latency, and cross-collateral basis buffers before ranking net value", () => {
    const candidate = buildPairCandidates([
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready", { collateral_asset: "USDC" })),
      venue("lighter", snapshot("lighter", "BTC", 150_000_000, "ready", { collateral_asset: "USDT" })),
    ])[0];
    const quote = quoteCarryCandidate(candidate, 10_000, 24, 1_800_000_000_000);
    expect(quote.latencyBufferUsd).toBe(2);
    expect(quote.capitalCostUsd).toBe(2);
    expect(quote.collateralBasisRiskUsd).toBe(50);
    expect(quote.riskBufferUsd).toBe(60);
    expect(quote.modeledTotalCostUsd).toBe(
      quote.roundTripCostUsd! + quote.latencyBufferUsd! + quote.capitalCostUsd! + quote.riskBufferUsd!,
    );
  });

  it("fails exact economics closed when displayed depth cannot fill the requested notional", () => {
    const thinDepth = [{ price_e8: 6_000_100_000_000, size_e8: 1_000 }];
    const long = snapshot("hyperliquid", "BTC", 10_000_000, "ready", {
      depth_bids: thinDepth,
      depth_asks: thinDepth,
    });
    const short = snapshot("lighter", "BTC", 40_000_000, "ready");
    const [candidate] = buildCandidates([venue("hyperliquid", long), venue("lighter", short)]);
    const quote = quoteCarryCandidate(candidate, 10_000, 24, 1_800_000_000_000);
    expect(quote.depthStatus).toBe("insufficient");
    expect(quote.exactCosts).toBe(false);
    expect(quote.expectedNetUsd).toBeNull();
  });

  it("merges fresh venue ticks before recomputing route economics", () => {
    const now = 1_800_000_000_000;
    const hyperliquid = snapshot("hyperliquid", "BTC", 10_000_000, "ready");
    const lighter = snapshot("lighter", "BTC", 40_000_000, "ready");
    const updated = applyCarryLivePatches([
      venue("hyperliquid", hyperliquid),
      venue("lighter", lighter),
    ], [{
      venue_id: "hyperliquid",
      asset: "BTC",
      received_at_ms: now - 4,
      source_at_ms: now - 8,
      mark_price_e8: 6_000_000_000_000,
      index_price_e8: 6_000_000_000_000,
      best_bid_e8: 5_999_990_000_000,
      best_ask_e8: 6_000_010_000_000,
      funding_rate_e12_per_interval: 20_000_000,
      funding_interval_ms: 3_600_000,
    }], now);
    const [candidate] = buildCandidates(updated);
    expect(candidate.long.funding_rate_e12_per_interval).toBe(20_000_000);
    expect(carryCandidateAgeMs(candidate, now)).toBe(8);
    const quote = quoteCarryCandidate(candidate, 10_000, 24);
    expect(quote.grossDailyUsd).toBeGreaterThan(0);
    expect(quote.expectedNetUsd).toBeTypeOf("number");
    expect(quote.breakEvenHours).toBeGreaterThan(0);
  });

  it("preserves deeper REST liquidity when a partial top-of-book tick arrives", () => {
    const now = 1_800_000_000_000;
    const originalDepthAt = now - 1_000;
    const base = venue("lighter", snapshot("lighter", "BTC", 40_000_000, "ready", {
      depth_bids: [
        { price_e8: 5_999_900_000_000, size_e8: 100_000_000 },
        { price_e8: 5_999_800_000_000, size_e8: 200_000_000 },
      ],
      depth_observed_at_ms: originalDepthAt,
    }));
    const [updated] = applyCarryLivePatches([base], [{
      venue_id: "lighter",
      asset: "BTC",
      received_at_ms: now,
      best_bid_e8: 5_999_850_000_000,
      depth_bids: [{ price_e8: 5_999_850_000_000, size_e8: 150_000_000 }],
    }], now);
    expect(updated.snapshots[0].depth_bids).toEqual([
      { price_e8: 5_999_850_000_000, size_e8: 150_000_000 },
      { price_e8: 5_999_800_000_000, size_e8: 200_000_000 },
    ]);
    expect(updated.snapshots[0].depth_observed_at_ms).toBe(originalDepthAt);
  });

  it("ignores expired live patches instead of presenting stale routes", () => {
    const now = 1_800_000_000_000;
    const base = venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready"));
    const [unchanged] = applyCarryLivePatches([base], [{
      venue_id: "hyperliquid",
      asset: "BTC",
      received_at_ms: now - 6_000,
      funding_rate_e12_per_interval: 99_000_000,
    }], now);
    expect(unchanged).toBe(base);
  });

  it("does not let an orderbook patch revive stale funding", () => {
    const now = 1_800_000_000_000;
    const base = venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "quarantined", {
      stale: true,
      source_observed_at_ms: {
        market: now - 1_000,
        funding: now - 31_000,
        orderbook: now - 1_000,
      },
      source_max_age_ms: { market: 30_000, funding: 30_000, orderbook: 30_000 },
    }));
    const [updated] = applyCarryLivePatches([base], [{
      venue_id: "hyperliquid",
      asset: "BTC",
      received_at_ms: now,
      best_bid_e8: 5_999_990_000_000,
      best_ask_e8: 6_000_010_000_000,
    }], now);
    expect(updated.snapshots[0]).toMatchObject({
      stale: true,
      status: "quarantined",
      stale_sources: ["funding"],
    });
    expect(buildPairCandidates([
      updated,
      venue("lighter", snapshot("lighter", "BTC", 40_000_000, "ready")),
    ])).toHaveLength(0);
  });
});

function venue(venue_id: string, item: ReturnType<typeof snapshot>) {
  return { venue_id, ok: true, snapshots: [item] };
}

function snapshot(
  venue_id: string,
  asset: string,
  funding: number,
  status: "ready" | "degraded" | "quarantined",
  overrides: Record<string, unknown> = {},
) {
  return {
    venue_id,
    contract_id: `${venue_id}:${asset}`,
    economic_equivalence_id: `carry:${asset}-usd-linear`,
    asset,
    market: `${asset}-USD`,
    quote_asset: "USDC",
    collateral_asset: "USDC",
    contract_type: "linear_perp" as const,
    status,
    stale: false,
    funding_rate_e12_per_interval: funding,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 10_000_000,
    initial_margin_bps: venue_id === "hyperliquid" ? 250 : 500,
    maintenance_margin_bps: venue_id === "hyperliquid" ? 125 : 120,
    mark_price_e8: 6_000_000_000_000,
    index_price_e8: 6_000_000_000_000,
    best_bid_e8: 5_999_900_000_000,
    best_ask_e8: 6_000_100_000_000,
    depth_bids: [{ price_e8: 5_999_900_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 6_000_100_000_000, size_e8: 100_000_000 }],
    depth_observed_at_ms: 1_800_000_000_000,
    as_of_ms: 1_800_000_000_000,
    missing_fields: [],
    ...overrides,
  };
}

function routingAdvantageSummary(): NonNullable<CarryShadowResponse["routing_advantage"]> {
  return {
    version: 2,
    kind: "carry_routing_advantage",
    ready: true,
    failures: [],
    benchmark_kind: "next_best_executable_route",
    execution_venue_ids: ["hyperliquid", "lighter", "aster"],
    requested_assets: ["BTC"],
    notional_micro_usdc: 10_000_000_000,
    horizon_ms: 86_400_000,
    modeled: true,
    realized: false,
    account_fee_tier_included: false,
    execution_ready: false,
    transaction_broadcast: false,
    shadow_qualification_commitment: `carry:shadow:qualification:${"d".repeat(64)}`,
    observer_image_digest: `sha256:${"e".repeat(64)}`,
    observed_at_ms: 1_800_000_000_000,
    evidence_commitment: `carry:routing:advantage:${"f".repeat(64)}`,
    routes: [{
      asset: "BTC",
      status: "advantaged",
      selected_route: { long_venue_id: "lighter", short_venue_id: "aster" },
      baseline_route: { long_venue_id: "hyperliquid", short_venue_id: "aster" },
      selected_modeled_net_micro_usdc_per_day: 3_500_000,
      baseline_modeled_net_micro_usdc_per_day: 2_250_000,
      daily_net_advantage_micro_usdc: 1_250_000,
      daily_net_advantage_e6_bps: 1_250_000,
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      selected_value: {
        benchmark_kind: "no_trade",
        selected_route: { long_venue_id: "lighter", short_venue_id: "aster" },
        modeled_net_micro_usdc_per_day: 3_500_000,
        modeled_net_e6_bps_per_day: 3_500_000,
        sample_count: 8,
        minimum_samples: 8,
        observed_span_ms: 35 * 60_000,
        minimum_span_ms: 30 * 60_000,
        funding_evidence_commitment: `carry:funding:${"a".repeat(64)}`,
        ready: true,
        reasons: [],
      },
      funding_evidence_commitments: [
        `carry:funding:${"a".repeat(64)}`,
        `carry:funding:${"b".repeat(64)}`,
      ],
      ready: true,
      reasons: [],
    }],
  };
}

function qualificationSummary(): NonNullable<CarryShadowResponse["shadow_qualification"]> {
  return {
    version: 1,
    kind: "carry_shadow_qualification",
    ready: true,
    release_bound: true,
    transaction_broadcast: false,
    image_digest: `sha256:${"e".repeat(64)}`,
    checked_at_ms: 1_800_000_000_000,
    required_samples: 3,
    completed_samples: 3,
    venues: CORE_PERP_VENUES.length,
    assets: 3,
    requested_assets: ["BTC", "ETH", "SOL"],
    minimum_span_ms: 120_000,
    duration_ms: 120_000,
    expected_snapshots_per_sample: CORE_PERP_VENUES.length * 3,
    sample_commitments: ["a", "b", "c"].map((value) => `carry:shadow:sample:${value.repeat(64)}`),
    source_observation_commitments: ["d", "e", "f"].map((value) => `carry:shadow:sources:${value.repeat(64)}`),
    failures: [],
    evidence_commitment: `carry:shadow:qualification:${"d".repeat(64)}`,
  };
}

function fundingPersistenceSummary(): NonNullable<CarryShadowResponse["funding_persistence"]> {
  return {
    version: 1,
    transaction_broadcast: false,
    observed_route_count: 2,
    ready_route_count: 2,
    routes: ["a", "b"].map((suffix, index) => ({
      asset: "BTC",
      long_venue_id: index === 0 ? "lighter" : "hyperliquid",
      short_venue_id: "aster",
      ready: true,
      reasons: [],
      sample_count: 8,
      minimum_samples: 8,
      observed_span_ms: 35 * 60_000,
      minimum_span_ms: 30 * 60_000,
      conservative_hourly_spread_e12: 1,
      evidence_commitment: `carry:funding:${suffix.repeat(64)}`,
    })),
  };
}
