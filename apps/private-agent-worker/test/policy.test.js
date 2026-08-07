import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enforceBillingExecutionPolicy,
  enforceInstructionPolicy,
  normalizeInstruction,
} from "../src/execution/policy.js";

const OLD_ENV = { ...process.env };

describe("trading subscription execution policy", () => {
  const openingOrder = {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: { market: "SOL", side: "buy", reduce_only: false },
  };

  it("allows an entitled opening order", () => {
    assert.doesNotThrow(() => enforceBillingExecutionPolicy({
      body: { billing_execution_policy: "all" },
      instruction: openingOrder,
    }));
  });

  it("blocks an unpaid opening order before venue submission", () => {
    assert.throws(
      () => enforceBillingExecutionPolicy({
        body: { billing_execution_policy: "risk_reducing_only" },
        instruction: openingOrder,
      }),
      (error) => error.status === 402 && error.code === "trading_subscription_required",
    );
  });

  it("allows a reduce-only close during billing failure", () => {
    assert.doesNotThrow(() => enforceBillingExecutionPolicy({
      body: { billing_execution_policy: "risk_reducing_only" },
      instruction: {
        ...openingOrder,
        order: { ...openingOrder.order, side: "sell", reduce_only: true },
      },
    }));
  });

  it("preserves exact-close intent only for reduce-only Hyperliquid orders", () => {
    const exactClose = hyperliquidTinyFillOrder({
      reduce_only: true,
      close_position: true,
      quote_size: "",
    });
    assert.equal(exactClose.order.reduce_only, true);
    assert.equal(exactClose.order.close_position, true);
    assert.equal(exactClose.order.quote_size, null);
    assert.throws(
      () => hyperliquidTinyFillOrder({ reduce_only: false, close_position: true }),
      /exact position close requires a reduce-only Hyperliquid order/,
    );
  });

  it("allows cancellation during billing failure", () => {
    assert.doesNotThrow(() => enforceBillingExecutionPolicy({
      body: { billing_execution_policy: "risk_reducing_only" },
      instruction: { venue_id: "hyperliquid", operation_class: "cancel", cancel: {} },
    }));
  });
});

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

  it("reports a disabled full-ticket cap as a live gate failure", async () => {
    delete process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD;
    const instruction = hyperliquidFullTicketOrder({ quote_size: "11", max_slippage_bps: "50" });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      (error) => error.status === 503 && error.code === "live_gate_disabled",
    );
  });

  it("reports disabled Hyperliquid submit mode before tiny-fill shape policy", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "disabled";
    const instruction = hyperliquidFullTicketOrder({ quote_size: "11", max_slippage_bps: "50" });
    await assert.rejects(
      () => enforceInstructionPolicy({ body: { policy_commitment: "policy_test" }, instruction, session: null, state: null }),
      (error) => error.status === 403 && error.code === "live_gate_disabled",
    );
  });

  it("applies full-ticket policy when the deployment value has a trailing newline", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket\n";
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

  it("isolates tenant limits while reserving weighted capacity for 100 trader orders", async () => {
    process.env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE = "1";
    process.env.PRIVATE_AGENT_MAX_GLOBAL_VENUE_WEIGHT_PER_MINUTE = "6000";
    const counts = new Map();
    const amounts = new Map();
    const rateKeys = [];
    const state = {
      async incrementPolicyAmount(key, amount, maxAmount) {
        const next = (amounts.get(key) || 0) + amount;
        if (next > maxAmount) return { ok: false, amount: next - amount };
        amounts.set(key, next);
        return { ok: true, amount: next };
      },
      async incrementPolicyCount(key, maxCount) {
        const next = (counts.get(key) || 0) + 1;
        if (next > maxCount) return { ok: false, count: next - 1 };
        counts.set(key, next);
        rateKeys.push(key);
        return { ok: true, count: next };
      },
    };

    await Promise.all(Array.from({ length: 100 }, (_, index) => enforceInstructionPolicy({
      body: {
        vault_commitment: `vault_trader_${index}`,
        policy_commitment: `policy_trader_${index}`,
      },
      instruction: hyperliquidFullTicketOrder({ quote_size: "10" }),
      session: null,
      state,
    })));

    const tenantRateKeys = rateKeys.filter((key) => key.startsWith("rate:v2:hyperliquid:"));
    assert.equal(new Set(tenantRateKeys).size, 100);
    assert.equal(
      [...amounts.entries()].find(([key]) => key.startsWith("venue_weight:v2:hyperliquid:"))?.[1],
      6000,
    );

    await assert.rejects(
      () => enforceInstructionPolicy({
        body: {
          vault_commitment: "vault_trader_0",
          policy_commitment: "policy_trader_0",
        },
        instruction: hyperliquidFullTicketOrder({ quote_size: "10" }),
        session: null,
        state,
      }),
      (error) => error.status === 429 && /rate limit/.test(error.message),
    );
  });

  it("rejects an order before exceeding the weighted Hyperliquid IP budget", async () => {
    process.env.PRIVATE_AGENT_MAX_GLOBAL_VENUE_WEIGHT_PER_MINUTE = "100";
    let used = 0;
    const state = {
      async incrementPolicyAmount(_key, amount, maxAmount) {
        if (used + amount > maxAmount) return { ok: false, amount: used };
        used += amount;
        return { ok: true, amount: used };
      },
    };
    await enforceInstructionPolicy({
      body: { policy_commitment: "weighted_one" },
      instruction: hyperliquidFullTicketOrder({ quote_size: "10" }),
      session: null,
      state,
    });
    await assert.rejects(
      () => enforceInstructionPolicy({
        body: { policy_commitment: "weighted_two" },
        instruction: hyperliquidFullTicketOrder({ quote_size: "10" }),
        session: null,
        state,
      }),
      (error) => error.status === 429 &&
        /weighted capacity/.test(error.message) &&
        /used 80, requested 60, limit 100/.test(error.message),
    );
  });

  it("uses versioned ledgers and returns reservations for a live tiny-fill submit", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "15";
    process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD = "25";
    const keys = [];
    const reservations = [];
    await enforceInstructionPolicy({
      body: {
        vault_commitment: "vault_policy_reservation_test",
        policy_commitment: "policy_reservation_test",
        session_policy: {
          policy_commitment: "policy_reservation_test",
          market_allowlist: ["SOL"],
          max_notional_bucket: "25",
          max_daily_notional_bucket: "25",
          max_order_count: 5,
        },
      },
      instruction: hyperliquidTinyFillOrder({ quote_size: "11" }),
      session: null,
      state: {
        async incrementPolicyAmount(key) {
          keys.push(key);
          return { ok: true };
        },
        async incrementPolicyCount(key) {
          keys.push(key);
          return { ok: true };
        },
      },
      reservations,
    });

    assert.equal(keys.every((key) => key.includes(":v2:")), true);
    assert.deepEqual(reservations.map((item) => item.kind).sort(), ["amount", "amount", "count"]);
  });

  it("checks existing policy capacity during no-submit without consuming it", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "15";
    process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD = "25";
    const instruction = hyperliquidTinyFillOrder({ quote_size: "11" });
    const state = {
      async getPolicyAmount(key) {
        return key.startsWith("hyperliquid_live_notional") ? 15 : 0;
      },
      async getPolicyCount() {
        return 0;
      },
      async incrementPolicyAmount() {
        throw new Error("no-submit must not mutate the amount ledger");
      },
      async incrementPolicyCount() {
        throw new Error("no-submit must not mutate the count ledger");
      },
    };

    await assert.rejects(
      () => enforceInstructionPolicy({
        body: {
          vault_commitment: "vault_policy_check_test",
          policy_commitment: "policy_check_test",
          session_policy: {
            policy_commitment: "policy_check_test",
            market_allowlist: ["SOL"],
            max_notional_bucket: "25",
            max_daily_notional_bucket: "25",
            max_order_count: 5,
          },
        },
        instruction,
        session: null,
        state,
        policyMode: "check",
      }),
      /daily notional cap/,
    );
  });

  it("allows a reduce-only close above the entry cap without consuming daily entry capacity", async () => {
    let increments = 0;
    const instruction = hyperliquidTinyFillOrder({
      quote_size: "11",
      reduce_only: true,
    });
    await enforceInstructionPolicy({
      body: { policy_commitment: "policy_test" },
      instruction,
      session: null,
      state: {
        async incrementPolicyAmount() {
          increments += 1;
          return { ok: false };
        },
        async incrementPolicyCount() {
          return { ok: true };
        },
      },
    });
    assert.equal(increments, 0);
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

  it("accepts every strategy profile emitted by the trading UI", () => {
    const profiles = [
      "trend_following",
      "breakout",
      "momentum_continuation",
      "breakout_retest",
      "mean_reversion",
    ];
    for (const strategy_profile of profiles) {
      const instruction = hyperliquidFullTicketOrder({}, {
        mandate: {
          version: 1,
          strategy_profile,
          entry_trigger: "preview_now",
          exit_rule: "manual_approval",
          time_horizon: "scalp",
        },
      });
      assert.equal(instruction.mandate.strategy_profile, strategy_profile);
    }
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

function hyperliquidTinyFillOrder(overrides = {}) {
  return normalizeInstruction({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: {
      market: "SOL",
      side: "sell",
      quote_size: "10",
      limit_price: "70",
      order_type: "market",
      size_mode: "quote",
      tif: "Ioc",
      max_slippage_bps: "50",
      live_order_mode: "tiny_fill",
      ...overrides,
    },
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
