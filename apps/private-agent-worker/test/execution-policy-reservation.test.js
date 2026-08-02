import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeHyperliquidOrder } from "../src/execution/private-execution.js";
import { HyperliquidExecutionError } from "../src/venues/hyperliquid.js";
import { createWorkerStateAdapter } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

describe("Hyperliquid policy reservation lifecycle", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "15";
    process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD = "25";
    process.env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE = "0";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("releases all policy reservations after a definite venue rejection", async () => {
    const { state, body } = fixture("definite_rejection");
    await assert.rejects(
      () => executeHyperliquidOrder({
        body,
        recipient: {},
        state,
        submitHyperliquid: async () => {
          throw new HyperliquidExecutionError(
            "sanitized venue rejection",
            422,
            "venue_rejected",
            "not_submitted",
          );
        },
      }),
      /sanitized venue rejection/,
    );

    const day = new Date().toISOString().slice(0, 10);
    assert.equal(await state.getPolicyAmount(`session_daily_notional:v2:policy_definite_rejection:${day}`), 0);
    assert.equal(await state.getPolicyAmount(`hyperliquid_live_notional:v2:vault_definite_rejection:${day}`), 0);
    assert.equal(await state.getPolicyCount("session_order_count:v2:policy_definite_rejection"), 0);
    const attempt = await state.getExecutionAttempt(body.work_order_commitment);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.submission_state, "not_submitted");
    assert.equal(attempt.policy_reservation_status, "released");
    assert.equal(JSON.stringify(attempt).includes("api_wallet_private_key"), false);
  });

  it("holds reservations when the adapter outcome is unknown", async () => {
    const { state, body } = fixture("unknown_outcome");
    await assert.rejects(
      () => executeHyperliquidOrder({
        body,
        recipient: {},
        state,
        submitHyperliquid: async () => {
          throw new HyperliquidExecutionError(
            "sanitized adapter timeout",
            504,
            "connector_submit_failed",
            "unknown",
          );
        },
      }),
      /sanitized adapter timeout/,
    );

    const day = new Date().toISOString().slice(0, 10);
    assert.equal(await state.getPolicyAmount(`session_daily_notional:v2:policy_unknown_outcome:${day}`), 11);
    assert.equal(await state.getPolicyAmount(`hyperliquid_live_notional:v2:vault_unknown_outcome:${day}`), 11);
    assert.equal(await state.getPolicyCount("session_order_count:v2:policy_unknown_outcome"), 1);
    const attempt = await state.getExecutionAttempt(body.work_order_commitment);
    assert.equal(attempt.status, "outcome_unknown");
    assert.equal(attempt.submission_state, "unknown");
    assert.equal(attempt.policy_reservation_status, "held_for_reconciliation");
  });
});

function fixture(suffix) {
  let stored = {};
  const state = createWorkerStateAdapter({
    path: `memory:${suffix}`,
    hmacSecret: "11".repeat(32),
    async load() {
      return structuredClone(stored);
    },
    async save(next) {
      stored = structuredClone(next);
    },
  });
  state.findSession = async () => ({
    venue_id: "hyperliquid",
    policy_commitment: `policy_${suffix}`,
    strategy_policy: {
      execution_instruction_template: {
        order: {
          market: "SOL",
          side: "buy",
          quote_size: "11",
          live_order_mode: "tiny_fill",
          max_slippage_bps: "50",
          tif: "Ioc",
        },
      },
    },
  });
  return {
    state,
    body: {
      work_order_commitment: `work_order_${suffix}`,
      vault_commitment: `vault_${suffix}`,
      policy_commitment: `policy_${suffix}`,
      operation_class: "limit_order",
      session_policy: {
        policy_commitment: `policy_${suffix}`,
        market_allowlist: ["SOL"],
        max_notional_bucket: "25",
        max_daily_notional_bucket: "25",
        max_order_count: 5,
      },
    },
  };
}
