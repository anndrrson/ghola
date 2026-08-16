import { describe, expect, it } from "vitest";
import {
  applyCrossVenueWorkerReport,
  completeCrossVenueClose,
  createCrossVenueExecutionPlan,
  isProvenLiveCrossVenuePair,
  provenCrossVenueBaseSize,
  requestCrossVenueCancellation,
  requestCrossVenueClose,
  type CrossVenueExecutionPlan,
} from "./cross-venue-execution";

describe("cross-venue execution state machine", () => {
  it("permits only the recovery-proven Hyperliquid and Backpack SOL perpetual pair", () => {
    expect(isProvenLiveCrossVenuePair([
      { venue_id: "hyperliquid", symbol: "SOL" },
      { venue_id: "backpack", symbol: "SOL_USDC_PERP" },
    ])).toBe(true);
    expect(isProvenLiveCrossVenuePair([
      { venue_id: "hyperliquid", symbol: "SOL" },
      { venue_id: "phoenix", symbol: "SOL-PERP" },
    ])).toBe(false);
    expect(isProvenLiveCrossVenuePair([
      { venue_id: "hyperliquid", symbol: "HYPE" },
      { venue_id: "backpack", symbol: "SOL_USDC_PERP" },
    ])).toBe(false);
  });

  it("derives a shared SOL lot and measures matched exposure by base, not differing fill notionals", () => {
    const base = provenCrossVenueBaseSize({
      matchedNotionalMicroUsdc: 11_000_000,
      limitPrices: ["75.76", "75.71"],
      maxSlippageBps: 25,
    });
    expect(base).toBe("0.14");
    const created = createCrossVenueExecutionPlan({
      owner_commitment: "owner_live_pair",
      idempotency_key: "execution:live:pair",
      opportunity_commitment: "ghola_opportunity_live_pair",
      market: "SOL-USD",
      matched_notional_micro_usdc: 11_000_000,
      risk_budget: {
        max_unhedged_notional_micro_usdc: 11_000_000,
        max_hedge_slippage_bps: 25,
        max_hedge_duration_ms: 5_000,
        max_unwind_loss_micro_usdc: 250_000,
        max_daily_loss_micro_usdc: 11_000_000,
      },
      legs: [
        { venue_id: "hyperliquid", side: "buy", symbol: "SOL", limit_price: "75.76", target_base_size: base },
        { venue_id: "backpack", side: "sell", symbol: "SOL_USDC_PERP", limit_price: "75.71", target_base_size: base },
      ],
    });
    const complete = applyCrossVenueWorkerReport(created, {
      sequence: 1,
      phase: "complete",
      legs: created.legs.map((leg, index) => ({
        leg_id: leg.leg_id,
        status: "filled",
        filled_notional_micro_usdc: index === 0 ? 10_606_400 : 10_599_400,
        filled_base_size: base,
      })),
      observed_at: new Date(Date.parse(created.created_at) + 100).toISOString(),
    });
    expect(complete.status).toBe("both_filled");
    expect(complete.residual_notional_micro_usdc).toBe(0);
  });
  it("requires two opposite legs on distinct venues", () => {
    expect(() => plan({ venues: ["hyperliquid", "hyperliquid"] })).toThrow("distinct_venues_required");
    expect(() => plan({ sides: ["buy", "buy"] })).toThrow("opposite_sides_required");
  });

  it("tracks partial hedges and only reports success at zero residual", () => {
    const created = plan({ maxUnhedged: 5_000_000 });
    const accepted = report(created, 1, "accepted", [0, 0], ["submitted", "submitted"]);
    const partial = report(accepted, 2, "hedging", [2_000_000, 1_800_000], ["partially_filled", "partially_filled"]);
    expect(partial.status).toBe("hedging");
    expect(partial.residual_notional_micro_usdc).toBe(200_000);
    const complete = report(partial, 3, "complete", [2_000_000, 2_000_000], ["filled", "filled"]);
    expect(complete.status).toBe("both_filled");
    expect(complete.residual_notional_micro_usdc).toBe(0);
  });

  it("fails closed on replay, fill regression, and exposure budget breaches", () => {
    const created = plan({ maxUnhedged: 500_000 });
    const accepted = report(created, 1, "accepted", [0, 0], ["submitted", "submitted"]);
    expect(() => report(accepted, 1, "legs_open", [0, 0], ["submitted", "submitted"])).toThrow("report_sequence_replay");
    const exposed = report(accepted, 2, "legs_open", [1_000_000, 0], ["partially_filled", "submitted"]);
    expect(exposed.status).toBe("manual_intervention_required");
    expect(exposed.failure_code).toBe("unhedged_notional_budget_exceeded");
    expect(() => report(exposed, 3, "hedging", [900_000, 0], ["partially_filled", "submitted"])).toThrow("filled_notional_regression");
  });

  it("forces manual intervention after the hedge deadline", () => {
    const created = plan({ maxUnhedged: 5_000_000, now: new Date("2026-01-01T00:00:00.000Z") });
    const exposed = applyCrossVenueWorkerReport(created, {
      sequence: 1,
      phase: "legs_open",
      legs: [{
        leg_id: created.legs[0].leg_id,
        status: "filled",
        filled_notional_micro_usdc: 1_000_000,
      }],
      observed_at: "2026-01-01T00:00:00.100Z",
    });
    const late = applyCrossVenueWorkerReport(exposed, {
      sequence: 2,
      phase: "hedging",
      legs: [],
      observed_at: "2026-01-01T00:00:06.000Z",
    });
    expect(late.status).toBe("manual_intervention_required");
    expect(late.failure_code).toBe("hedge_deadline_exceeded");
  });

  it("records repair orders separately from original leg fills", () => {
    const created = plan({ maxUnhedged: 5_000_000 });
    const exposed = report(created, 1, "hedging", [5_000_000, 4_000_000], ["filled", "partially_filled"]);
    const repaired = applyCrossVenueWorkerReport(exposed, {
      sequence: 2,
      phase: "complete",
      legs: [],
      repair_fills: [{
        repair_id: "cross_repair_test_123",
        venue_id: "hyperliquid",
        side: "sell",
        filled_notional_micro_usdc: 1_000_000,
        venue_order_reference: "hedge-order-1",
      }],
      observed_at: new Date(Date.parse(created.created_at) + 200).toISOString(),
    });
    expect(repaired.status).toBe("hedged");
    expect(repaired.residual_notional_micro_usdc).toBe(0);
    expect(repaired.legs.map((leg) => leg.filled_notional_micro_usdc)).toEqual([5_000_000, 4_000_000]);
    expect(repaired.repair_fills).toHaveLength(1);
  });

  it("cancels clean plans but unwinds plans with fills", () => {
    const created = plan();
    expect(requestCrossVenueCancellation(created).status).toBe("cancelled");
    const filled = report(created, 1, "legs_open", [100_000, 0], ["partially_filled", "submitted"]);
    expect(requestCrossVenueCancellation(filled).status).toBe("unwinding");
  });

  it("keeps a matched pair active until exact worker flat proof closes it", () => {
    const created = plan();
    const filled = report(created, 1, "complete", [5_000_000, 5_000_000], ["filled", "filled"]);
    const closing = requestCrossVenueClose(filled, new Date("2026-01-01T00:00:01.000Z"));
    expect(closing.status).toBe("closing");
    expect(() => completeCrossVenueClose(closing, { accepted: true, receipt: { execution_id: closing.execution_id, status: "closed" } })).toThrow("flat_proof_required");
    const closed = completeCrossVenueClose(closing, {
      accepted: true,
      receipt: { execution_id: closing.execution_id, status: "closed", final_flat_proven: true },
    }, new Date("2026-01-01T00:00:02.000Z"));
    expect(closed).toMatchObject({ status: "closed", closed_at: "2026-01-01T00:00:02.000Z" });
    expect(closed.close_receipt_commitment).toMatch(/^consumer_cross_venue_close_receipt_/);
  });
});

function plan(input: {
  venues?: ["hyperliquid" | "phoenix", "hyperliquid" | "phoenix"];
  sides?: ["buy" | "sell", "buy" | "sell"];
  maxUnhedged?: number;
  now?: Date;
} = {}) {
  const venues = input.venues ?? ["hyperliquid", "phoenix"];
  const sides = input.sides ?? ["buy", "sell"];
  return createCrossVenueExecutionPlan({
    owner_commitment: "owner_test",
    idempotency_key: "execution:test:123",
    opportunity_commitment: "ghola_opportunity_test",
    market: "SOL-USD",
    matched_notional_micro_usdc: 5_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: input.maxUnhedged ?? 5_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      { venue_id: venues[0], side: sides[0], symbol: "SOL", limit_price: "150" },
      { venue_id: venues[1], side: sides[1], symbol: "SOL-PERP", limit_price: "151" },
    ],
    now: input.now,
  });
}

function report(
  current: CrossVenueExecutionPlan,
  sequence: number,
  phase: "accepted" | "legs_open" | "hedging" | "unwinding" | "complete" | "failed",
  fills: [number, number],
  statuses: ["submitted" | "partially_filled" | "filled", "submitted" | "partially_filled" | "filled"],
) {
  return applyCrossVenueWorkerReport(current, {
    sequence,
    phase,
    legs: current.legs.map((leg, index) => ({
      leg_id: leg.leg_id,
      status: statuses[index],
      filled_notional_micro_usdc: fills[index],
    })),
    observed_at: new Date(Date.parse(current.created_at) + sequence * 100).toISOString(),
  });
}
