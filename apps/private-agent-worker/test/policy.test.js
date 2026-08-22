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

  it("allows one $11 HYPE order inside a $25 session cap", async () => {
    const instruction = hyperliquidFullTicketOrder({
      market: "HYPE",
      quote_size: "11",
      max_slippage_bps: "50",
    });
    await enforceInstructionPolicy({
      body: {
        policy_commitment: "policy_hype_proof",
        session_policy: {
          policy_commitment: "policy_hype_proof",
          market_allowlist: ["BTC", "ETH", "SOL", "HYPE"],
          max_notional_bucket: "25",
          max_order_count: 10,
        },
      },
      instruction,
      session: null,
      state: null,
    });
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

  it("normalizes leverage, margin mode, and native protection", () => {
    const instruction = hyperliquidFullTicketOrder({
      leverage: 7,
      margin_mode: "isolated",
      protective_orders: { stop_loss: "65000", take_profit: "72000" },
    });
    assert.equal(instruction.order.leverage, 7);
    assert.equal(instruction.order.margin_mode, "isolated");
    assert.deepEqual(instruction.order.protective_orders, { stop_loss: "65000", take_profit: "72000" });
  });

  it("rejects reduce-only orders that attach new protection", () => {
    assert.throws(
      () => hyperliquidFullTicketOrder({ reduce_only: true, protective_orders: { stop_loss: "65000" } }),
      /reduce-only orders cannot attach protective orders/,
    );
  });

  it("allows a risk-reducing exit even when entry notional limits are exhausted", async () => {
    const instruction = hyperliquidFullTicketOrder({
      quote_size: "100000",
      reduce_only: true,
      max_slippage_bps: "50",
    });
    const state = {
      async incrementPolicyAmount() {
        return { ok: false };
      },
    };
    await enforceInstructionPolicy({
      body: { policy_commitment: "policy_test" },
      instruction,
      session: null,
      state,
    });
  });

  it("keeps cancel and reduce-only recovery open after a session kill", async () => {
    const reduceOnly = hyperliquidFullTicketOrder({ reduce_only: true });
    await enforceInstructionPolicy({
      body: { session_policy: { kill_switch: true } },
      instruction: reduceOnly,
      session: null,
      state: null,
    });
    const cancel = normalizeInstruction({
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "hyperliquid",
      operation_class: "cancel",
      cancel: {
        market: "BTC",
        target_work_order_commitment: "work_order_recovery_0001",
      },
    }, { venue_id: "hyperliquid", operation_class: "cancel" });
    await enforceInstructionPolicy({
      body: { session_policy: { kill_switch: true } },
      instruction: cancel,
      session: null,
      state: null,
    });
  });

  it("still blocks risk increases after a session kill", async () => {
    await assert.rejects(
      () => enforceInstructionPolicy({
        body: { session_policy: { kill_switch: true } },
        instruction: hyperliquidFullTicketOrder(),
        session: null,
        state: null,
      }),
      /kill switch/,
    );
  });

  it("still enforces slippage bounds on reduce-only exits", async () => {
    const instruction = hyperliquidFullTicketOrder({
      reduce_only: true,
      max_slippage_bps: "101",
    });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      /slippage/,
    );
  });

  it("rejects untrusted Coinbase logical reduce-only flags", async () => {
    await assert.rejects(
      () => enforceInstructionPolicy({
        body: coinbaseRecoveryBody(),
        instruction: coinbaseReduceOnlyOrder(),
        session: null,
        state: coinbaseRecoveryState(),
      }),
      /restricted to the protected recovery worker/,
    );
  });

  it("permits only state-bound Coinbase position reduction", async () => {
    await enforceInstructionPolicy({
      body: coinbaseRecoveryBody(),
      instruction: coinbaseReduceOnlyOrder(),
      session: null,
      state: coinbaseRecoveryState(),
      trusted_internal: true,
      account_usage: false,
    });
    await assert.rejects(
      () => enforceInstructionPolicy({
        body: coinbaseRecoveryBody(),
        instruction: coinbaseReduceOnlyOrder({ side: "buy" }),
        session: null,
        state: coinbaseRecoveryState(),
        trusted_internal: true,
        account_usage: false,
      }),
      /does not reduce a recorded position/,
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

function coinbaseReduceOnlyOrder(overrides = {}) {
  return normalizeInstruction({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "coinbase_advanced",
    operation_class: "spot_market_order",
    order: {
      market: "SOL-USD",
      side: "sell",
      base_size: "0.25",
      limit_price: "101",
      order_type: "market",
      size_mode: "base",
      reduce_only: true,
      ...overrides,
    },
  }, { venue_id: "coinbase_advanced", operation_class: "spot_market_order" });
}

function coinbaseRecoveryBody() {
  return {
    autopilot_session_id: "autopilot_recovery_test",
    policy_commitment: "policy_recovery_test",
    session_policy: {
      policy_commitment: "policy_recovery_test",
      market_allowlist: ["SOL-USD"],
      max_notional_bucket: "10",
    },
  };
}

function coinbaseRecoveryState() {
  return {
    async getAutopilotSession() {
      return { session_policy: { policy_commitment: "policy_recovery_test" } };
    },
    async listAutopilotPositions() {
      return [{
        venue_id: "coinbase_advanced",
        market: "SOL-USD",
        signed_notional_micro_usdc: 25_000_000,
        signed_base_size: 0.25,
      }];
    },
  };
}
