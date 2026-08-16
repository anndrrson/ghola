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
    process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = "100";
    process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = "500";
    process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD = "100";
    process.env.PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD = "500";
    process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = "100";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("blocks Hyperliquid full-ticket orders over the launch notional cap", async () => {
    const instruction = hyperliquidFullTicketOrder({ quote_size: "101", max_slippage_bps: "50" });
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

  it("allows an exact base-sized Hyperliquid market exit without inventing quote notional", async () => {
    const instruction = hyperliquidFullTicketOrder({
      market: "HYPE",
      side: "sell",
      size_mode: "base",
      base_size: "0.18",
      quote_size: undefined,
      limit_price: undefined,
      order_type: "market",
      live_order_mode: "tiny_fill",
      tif: "Ioc",
      reduce_only: true,
      max_slippage_bps: "100",
    });
    assert.equal(instruction.order.base_size, "0.18");
    assert.equal(instruction.order.quote_size, null);
    assert.equal(instruction.order.reduce_only, true);
    await enforceInstructionPolicy({
      body: {
        policy_commitment: "policy_market_exit_test",
        session_policy: {
          policy_commitment: "policy_market_exit_test",
          max_notional_bucket: "0",
          max_daily_notional_bucket: "0",
          max_order_count: 0,
        },
      },
      instruction,
      session: null,
      state: {
        async incrementPolicyAmount() { return { ok: false }; },
        async incrementPolicyCount() { return { ok: false }; },
      },
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

  it("keeps reduce-only exits available while global and session kill switches block entries", async () => {
    process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH = "true";
    const entry = hyperliquidFullTicketOrder({ quote_size: "10" });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: {}, instruction: entry, session: null, state: null }),
      /kill switch/,
    );
    const exit = hyperliquidFullTicketOrder({
      base_size: "0.001",
      quote_size: undefined,
      reduce_only: true,
    });
    await enforceInstructionPolicy({
      body: { session_policy: { kill_switch: true, max_notional_bucket: "0" } },
      instruction: exit,
      session: null,
      state: null,
    });
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

  it("keeps only the authoritative size field after normalization", () => {
    const quoteSized = hyperliquidFullTicketOrder({
      size_mode: "quote",
      quote_size: "10",
      base_size: "0.5",
    });
    const baseSized = hyperliquidFullTicketOrder({
      size_mode: "base",
      quote_size: "10",
      base_size: "0.5",
    });

    assert.equal(quoteSized.order.quote_size, "10");
    assert.equal(quoteSized.order.base_size, null);
    assert.equal(baseSized.order.base_size, "0.5");
    assert.equal(baseSized.order.quote_size, null);
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

  it("normalizes exact OCO protection and keeps it behind an explicit worker gate", async () => {
    const instruction = hyperliquidFullTicketOrder({
      size_mode: "base",
      base_size: "0.001",
      quote_size: undefined,
      tif: "Ioc",
    }, {
      position_protection: {
        mode: "normal_tpsl",
        trigger_source: "mark",
        take_profit_trigger_price: "68000",
        stop_loss_trigger_price: "66000",
        max_slippage_bps: "50",
      },
    });
    assert.deepEqual(instruction.position_protection, {
      mode: "normal_tpsl",
      trigger_source: "mark",
      take_profit_trigger_price: "68000",
      stop_loss_trigger_price: "66000",
      max_slippage_bps: "50",
    });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      /position protection is not enabled/,
    );
    process.env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED = "true";
    await enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null });
  });

  it("binds market-entry protection to a reference that covers adverse entry slippage", () => {
    const instruction = hyperliquidFullTicketOrder({
      limit_price: undefined,
      order_type: "market",
      tif: "Ioc",
    }, {
      position_protection: {
        mode: "normal_tpsl",
        trigger_source: "mark",
        take_profit_trigger_price: "68000",
        stop_loss_trigger_price: "66000",
        entry_reference_price: "67000",
        max_slippage_bps: "50",
      },
    });
    assert.equal(instruction.position_protection.entry_reference_price, "67000");

    assert.throws(() => hyperliquidFullTicketOrder({
      limit_price: undefined,
      order_type: "market",
      tif: "Ioc",
    }, {
      position_protection: {
        mode: "normal_tpsl",
        trigger_source: "mark",
        take_profit_trigger_price: "67020",
        stop_loss_trigger_price: "66000",
        entry_reference_price: "67000",
        max_slippage_bps: "50",
      },
    }), /outside the bound order/);
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
