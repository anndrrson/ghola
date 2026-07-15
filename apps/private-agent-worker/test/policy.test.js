import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enforceInstructionPolicy,
  normalizeInstruction,
} from "../src/execution/policy.js";

const OLD_ENV = { ...process.env };

describe("full-ticket execution policy", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";
    process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
    process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = "5000";
    process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = "100";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("blocks Hyperliquid full-ticket orders over the launch notional cap", async () => {
    const instruction = hyperliquidFullTicketOrder({ quote_size: "1001", max_slippage_bps: "50" });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      /notional cap/,
    );
  });

  it("blocks Hyperliquid full-ticket orders over the slippage cap", async () => {
    const instruction = hyperliquidFullTicketOrder({ quote_size: "10", max_slippage_bps: "101" });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      /slippage/,
    );
  });

  it("counts Hyperliquid full-ticket daily notional when state is available", async () => {
    const instruction = hyperliquidFullTicketOrder({ quote_size: "10", max_slippage_bps: "50" });
    const state = {
      async incrementPolicyAmount() {
        return { ok: false };
      },
    };
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state }),
      /daily notional cap/,
    );
  });

  it("allows reduce-only exits after opening caps are exhausted", async () => {
    const instruction = hyperliquidFullTicketOrder({
      base_size: "1",
      quote_size: undefined,
      reduce_only: true,
      max_slippage_bps: "50",
    });
    const state = {
      async incrementPolicyAmount() {
        return { ok: false };
      },
      async incrementPolicyCount() {
        return { ok: false };
      },
    };
    await enforceInstructionPolicy({
      body: {
        policy_commitment: "policy_test",
        session_policy: {
          policy_commitment: "policy_test",
          max_notional_bucket: "5",
          max_daily_notional_bucket: "5",
          max_order_count: 0,
        },
      },
      instruction,
      session: null,
      state,
    });
  });

  it("still enforces the slippage guard on reduce-only exits", async () => {
    const instruction = hyperliquidFullTicketOrder({
      base_size: "1",
      quote_size: undefined,
      reduce_only: true,
      max_slippage_bps: "101",
    });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      /slippage/,
    );
  });

  it("preserves sealed agent mandates during normalization", () => {
    const instruction = hyperliquidFullTicketOrder({}, {
      mandate: {
        version: 1,
        strategy_profile: "breakout_retest",
        entry_trigger: "break_level",
        trigger_level: "67000",
        exit_rule: "manual_approval",
        time_horizon: "session_trade",
        strategy_note: "Wait for break and retest.",
      },
    });
    assert.deepEqual(instruction.mandate, {
      version: 1,
      strategy_profile: "breakout_retest",
      entry_trigger: "break_level",
      exit_rule: "manual_approval",
      time_horizon: "session_trade",
      enforcement: "fail_closed_without_condition_proof",
      trigger_level: "67000",
      strategy_note: "Wait for break and retest.",
    });
  });

  it("rejects live submit when a conditional agent mandate has no proof", async () => {
    const instruction = hyperliquidFullTicketOrder({}, {
      mandate: {
        version: 1,
        strategy_profile: "breakout_retest",
        entry_trigger: "break_level",
        trigger_level: "67000",
        exit_rule: "manual_approval",
        time_horizon: "session_trade",
      },
    });
    await assert.rejects(
      () => enforceInstructionPolicy({
        body: { policy_commitment: "policy_test" },
        instruction,
        session: null,
        state: policyState(),
      }),
      /mandate proof/,
    );
  });

  it("allows no-submit checks for conditional agent mandates before proof exists", async () => {
    const instruction = hyperliquidFullTicketOrder({}, {
      mandate: {
        version: 1,
        strategy_profile: "breakout_retest",
        entry_trigger: "break_level",
        trigger_level: "67000",
        exit_rule: "manual_approval",
        time_horizon: "session_trade",
      },
    });
    await enforceInstructionPolicy({
      body: { policy_commitment: "policy_test" },
      instruction,
      session: null,
      state: null,
    });
  });

  it("allows live submit when the sealed mandate has a satisfied condition proof", async () => {
    const instruction = hyperliquidFullTicketOrder({}, {
      mandate: {
        version: 1,
        strategy_profile: "breakout_retest",
        entry_trigger: "break_level",
        trigger_level: "67000",
        exit_rule: "manual_approval",
        time_horizon: "session_trade",
        condition_proof: {
          status: "satisfied",
          strategy_profile: "breakout_retest",
          entry_trigger: "break_level",
          venue_id: "hyperliquid",
          market: "BTC",
          expires_at: "2999-01-01T00:00:00.000Z",
          evidence_commitment: "mandate_evidence_test",
        },
      },
    });
    await enforceInstructionPolicy({
      body: { policy_commitment: "policy_test" },
      instruction,
      session: null,
      state: policyState(),
    });
  });
});

function hyperliquidFullTicketOrder(overrides = {}, instructionOverrides = {}) {
  return normalizeInstruction({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: {
      market: "BTC",
      side: "buy",
      quote_size: "10",
      limit_price: "67000",
      order_type: "limit",
      max_slippage_bps: "50",
      ...overrides,
    },
    ...instructionOverrides,
  }, {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
  });
}

function policyState() {
  return {
    async incrementPolicyAmount() {
      return { ok: true };
    },
    async incrementPolicyCount() {
      return { ok: true };
    },
  };
}
