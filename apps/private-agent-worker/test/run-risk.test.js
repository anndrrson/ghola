import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEstimatedFill,
  lossCircuitDecision,
  markRunPositions,
  protectiveExitDecision,
  projectRunExposure,
  summarizeRunRisk,
} from "../src/execution/run-risk.js";

const now = new Date("2026-07-15T12:00:00.000Z");

describe("autopilot run risk", () => {
  it("tracks weighted entry, partial close, and realized loss", () => {
    const opened = applyEstimatedFill(null, fill("buy", 100, 100));
    const added = applyEstimatedFill(opened, fill("buy", 50, 50));
    const closed = applyEstimatedFill(added, fill("sell", 75, 75, 90));
    assert.equal(added.signed_quantity, 1.5);
    assert.equal(added.average_entry_price, 100);
    assert.equal(closed.signed_quantity, 0.66666667);
    assert.equal(closed.realized_pnl_usd, -8.33333333);
  });

  it("marks open positions and trips at the configured loss limit", () => {
    const opened = applyEstimatedFill(null, fill("buy", 100, 100));
    const marked = markRunPositions([opened], { product_id: "SOL-USD", price: 90 }, now);
    const summary = summarizeRunRisk(marked, { now, maxMarkAgeMs: 10_000 });
    assert.equal(summary.exposure_usd, 90);
    assert.equal(summary.estimated_total_pnl_usd, -10);
    assert.deepEqual(lossCircuitDecision(summary, 10), {
      ok: false,
      trip: true,
      reason: "loss_limit_reached",
    });
  });

  it("fails closed when an open position has no fresh mark", () => {
    const opened = applyEstimatedFill(null, fill("buy", 100, 100));
    const summary = summarizeRunRisk([opened], {
      now: new Date(now.getTime() + 60_000),
      maxMarkAgeMs: 10_000,
    });
    assert.equal(summary.complete, false);
    assert.equal(lossCircuitDecision(summary, 25).reason, "risk_mark_stale");
  });

  it("retains realized losses after a position is fully closed", () => {
    const opened = applyEstimatedFill(null, fill("buy", 100, 100));
    const closed = applyEstimatedFill(opened, fill("sell", 90, 90, 90));
    const summary = summarizeRunRisk([closed], { now, maxMarkAgeMs: 10_000 });
    assert.equal(closed.signed_quantity, 0);
    assert.equal(summary.realized_pnl_usd, -10);
    assert.equal(lossCircuitDecision(summary, 10).reason, "loss_limit_reached");
  });

  it("projects aggregate exposure before submission", () => {
    const first = applyEstimatedFill(null, fill("buy", 100, 100));
    const projected = projectRunExposure([first], {
      ...fill("buy", 75, 75),
      venue_id: "hyperliquid",
      market: "BTC-USD",
    }, { now, maxMarkAgeMs: 30_000 });
    assert.equal(projected.summary.exposure_usd, 175);
  });

  it("triggers stop-loss and take-profit exits only for session-managed Hyperliquid positions", () => {
    const unmanaged = {
      ...applyEstimatedFill(null, fill("buy", 100, 100)),
      venue_id: "hyperliquid",
      market: "BTC-USD",
      managed_by_session: false,
      average_entry_price: 100,
      last_mark_price: 80,
    };
    assert.equal(protectiveExitDecision([unmanaged], { stopLossBps: 500, takeProfitBps: 1_000 }).exit, false);

    const managedLong = { ...unmanaged, managed_by_session: true, last_mark_price: 94 };
    assert.deepEqual(
      protectiveExitDecision([managedLong], { stopLossBps: 500, takeProfitBps: 1_000 }),
      {
        exit: true,
        reason: "stop_loss",
        venue_id: "hyperliquid",
        market: "BTC-USD",
        side: "sell",
        base_size: 1,
        mark_price: 94,
        pnl_bps: -600,
        last_work_order_commitment: "work_buy_100_100",
      },
    );

    const managedShort = { ...managedLong, signed_quantity: -1, last_mark_price: 88 };
    const takeProfit = protectiveExitDecision([managedShort], { stopLossBps: 500, takeProfitBps: 1_000 });
    assert.equal(takeProfit.exit, true);
    assert.equal(takeProfit.reason, "take_profit");
    assert.equal(takeProfit.side, "buy");
  });
});

function fill(side, notional, quantityNotUsed, price = 100) {
  return {
    venue_id: "jupiter",
    market: "SOL-USD",
    side,
    notional_usd: notional,
    price,
    at: now.toISOString(),
    work_order_commitment: `work_${side}_${notional}_${quantityNotUsed}`,
  };
}
