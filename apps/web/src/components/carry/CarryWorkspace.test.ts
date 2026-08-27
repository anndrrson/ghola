import { describe, expect, it } from "vitest";
import {
  applyCarryLivePatches,
  buildCandidates,
  buildPairCandidates,
  builderModel,
  carryCandidateAgeMs,
  quoteCarryCandidate,
  rankCarryCandidatesByNet,
} from "@/lib/carry-market";

describe("CarryWorkspace model", () => {
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
      venue("lighter", snapshot("lighter", "BTC", 100_000_000, "ready", { taker_fee_bps: 100 })),
      venue("aster", snapshot("aster", "BTC", 80_000_000, "ready")),
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

  it("ranks a proven positive-net route above a larger unpriced spread", () => {
    const venues = [
      venue("hyperliquid", snapshot("hyperliquid", "BTC", 10_000_000, "ready")),
      venue("lighter", snapshot("lighter", "BTC", 200_000_000, "degraded", { taker_fee_bps: null })),
      venue("aster", snapshot("aster", "BTC", 80_000_000, "ready")),
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

  it("prices fees, spread, collateral, and break-even without counting the risk buffer as realized cost", () => {
    const long = snapshot("hyperliquid", "BTC", 10_000_000, "ready");
    const short = snapshot("lighter", "BTC", 40_000_000, "ready");
    const [candidate] = buildCandidates([venue("hyperliquid", long), venue("lighter", short)]);
    const result = builderModel(candidate, "10000", "30");
    expect(result.costUsd).not.toBeNull();
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
