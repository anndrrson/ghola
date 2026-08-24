import { describe, expect, it } from "vitest";
import { buildCandidates, builderModel } from "./CarryWorkspace";

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

  it("prices fees, spread, collateral, and break-even without counting the risk buffer as realized cost", () => {
    const long = snapshot("hyperliquid", "BTC", 10_000_000, "ready");
    const short = snapshot("lighter", "BTC", 40_000_000, "ready");
    const [candidate] = buildCandidates([venue("hyperliquid", long), venue("lighter", short)]);
    const result = builderModel(candidate, "10000", "30");
    expect(result.costUsd).not.toBeNull();
    expect(result.minimumCollateralUsd).toBe(750);
    expect(result.breakEvenDays).toBeGreaterThan(0);
    expect(result.netUsd).toBeTypeOf("number");
    expect(result.publicInputsComplete).toBe(true);
    expect(result.creatable).toBe(false);
  });
});

function venue(venue_id: string, item: ReturnType<typeof snapshot>) {
  return { venue_id, ok: true, snapshots: [item] };
}

function snapshot(venue_id: string, asset: string, funding: number, status: "ready" | "degraded" | "quarantined") {
  return {
    venue_id,
    contract_id: `${venue_id}:${asset}`,
    asset,
    status,
    stale: false,
    funding_rate_e12_per_interval: funding,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 10_000_000,
    initial_margin_bps: venue_id === "hyperliquid" ? 250 : 500,
    maintenance_margin_bps: venue_id === "hyperliquid" ? 125 : 120,
    best_bid_e8: 5_999_900_000_000,
    best_ask_e8: 6_000_100_000_000,
    missing_fields: [],
  };
}
