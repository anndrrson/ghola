import { beforeEach, describe, expect, it } from "vitest";
import { createCrossVenueExecutionPlan } from "./cross-venue-execution";
import {
  applyStoredCrossVenueWorkerReport,
  createStoredCrossVenueExecution,
  getStoredCrossVenueExecution,
  hasActiveCrossVenueExposure,
  markStoredCrossVenueExecutionClosed,
  markStoredCrossVenueExecutionClosing,
  resetCrossVenueExecutionStoreForTests,
} from "./cross-venue-execution-store";

describe("cross-venue durable store", () => {
  beforeEach(() => resetCrossVenueExecutionStoreForTests());

  it("makes creation idempotent and rejects key reuse with a different plan", async () => {
    const original = execution("ghola_opportunity_one");
    expect((await createStoredCrossVenueExecution(original)).disposition).toBe("created");
    expect((await createStoredCrossVenueExecution(original)).disposition).toBe("replayed");
    const conflicting = { ...execution("ghola_opportunity_two"), execution_id: original.execution_id };
    expect((await createStoredCrossVenueExecution(conflicting)).disposition).toBe("conflict");
  });

  it("accepts only one of two concurrent reports with the same sequence", async () => {
    const original = execution("ghola_opportunity_one");
    await createStoredCrossVenueExecution(original);
    const reports = await Promise.all([
      applyStoredCrossVenueWorkerReport({
        execution_id: original.execution_id,
        owner_commitment: original.owner_commitment,
        report: { sequence: 1, phase: "legs_open", legs: [], observed_at: "2026-01-01T00:00:01.000Z" },
      }),
      applyStoredCrossVenueWorkerReport({
        execution_id: original.execution_id,
        owner_commitment: original.owner_commitment,
        report: { sequence: 1, phase: "legs_open", legs: [], observed_at: "2026-01-01T00:00:02.000Z" },
      }),
    ]);
    expect(reports.filter((result) => result.ok)).toHaveLength(1);
    expect((await getStoredCrossVenueExecution({ execution_id: original.execution_id }))?.last_report_sequence).toBe(1);
  });

  it("treats both-filled positions as active until a proved close is stored", async () => {
    const original = execution("ghola_opportunity_close");
    await createStoredCrossVenueExecution(original);
    const filled = await applyStoredCrossVenueWorkerReport({
      execution_id: original.execution_id,
      owner_commitment: original.owner_commitment,
      report: {
        sequence: 1,
        phase: "complete",
        legs: original.legs.map((leg) => ({
          leg_id: leg.leg_id,
          status: "filled",
          filled_notional_micro_usdc: leg.target_notional_micro_usdc,
        })),
        observed_at: "2026-01-01T00:00:01.000Z",
      },
    });
    expect(filled.ok && filled.plan.status).toBe("both_filled");
    expect(await hasActiveCrossVenueExposure()).toBe(true);
    await markStoredCrossVenueExecutionClosing({ execution_id: original.execution_id, owner_commitment: original.owner_commitment });
    await markStoredCrossVenueExecutionClosed({
      execution_id: original.execution_id,
      owner_commitment: original.owner_commitment,
      worker_receipt: { accepted: true, receipt: { execution_id: original.execution_id, status: "closed", final_flat_proven: true } },
    });
    expect((await getStoredCrossVenueExecution({ execution_id: original.execution_id }))?.status).toBe("closed");
    expect(await hasActiveCrossVenueExposure()).toBe(false);
  });
});

function execution(opportunity: string) {
  return createCrossVenueExecutionPlan({
    owner_commitment: "owner_store_test",
    idempotency_key: "execution:store:123",
    opportunity_commitment: opportunity,
    market: "SOL-USD",
    matched_notional_micro_usdc: 5_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 5_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      { venue_id: "hyperliquid", side: "buy", symbol: "SOL", limit_price: "150" },
      { venue_id: "phoenix", side: "sell", symbol: "SOL-PERP", limit_price: "151" },
    ],
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
}
