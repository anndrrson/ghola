import assert from "node:assert/strict";
import test from "node:test";
import { validateAiDirectDecision } from "../src/execution/ai-direct-order.js";

function proposal(overrides = {}) {
  return {
    version: 2,
    action: "trade",
    objective: "best_execution",
    market: "SOL-USD",
    side: "buy",
    confidence_bps: 8_000,
    reason_codes: ["fresh_market"],
    user_intent_alignment: "Matches the signed objective.",
    risk_summary: "Deterministic routing and risk checks remain required.",
    ...overrides,
  };
}

test("accepts only a typed proposal without execution authority", () => {
  const validated = validateAiDirectDecision(proposal());
  assert.equal(validated.ok, true);
  assert.deepEqual(Object.keys(validated.decision).sort(), [
    "action",
    "confidence_bps",
    "market",
    "objective",
    "reason_codes",
    "risk_summary",
    "side",
    "user_intent_alignment",
    "version",
  ]);
});

test("rejects model attempts to choose venue, size, leverage, or order details", () => {
  for (const forbidden of [
    { venue_id: "jupiter" },
    { quote_size_usd: 10_000 },
    { leverage: 50 },
    { operation_class: "swap" },
    { limit_price: 100 },
  ]) {
    const validated = validateAiDirectDecision(proposal(forbidden));
    assert.equal(validated.ok, false);
    assert.equal(validated.error, "ai_decision_schema_invalid");
  }
});

test("fails closed on low confidence and missing trade side", () => {
  assert.equal(validateAiDirectDecision(proposal({ confidence_bps: 4_000 })).error, "ai_confidence_below_threshold");
  assert.equal(validateAiDirectDecision(proposal({ side: null })).error, "ai_trade_side_required");
});
