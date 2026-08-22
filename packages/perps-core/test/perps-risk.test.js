import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTurnkeyHyperliquidPolicies,
  evaluatePerpsIntent,
  normalizePerpsMandate,
  ownerMandateMessage,
} from "../index.js";

const NOW = 1_800_000_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";

function mandate(overrides = {}) {
  return {
    version: 1,
    mandate_id: "mandate:test:1",
    network: "testnet",
    owner_address: OWNER,
    agent_address: AGENT,
    execution_address: OWNER,
    allowed_markets: ["BTC", "ETH"],
    margin_mode: "isolated",
    configured_leverage: 3,
    max_leverage: 4,
    max_order_notional_micro_usdc: 50_000_000,
    max_gross_exposure_micro_usdc: 100_000_000,
    max_daily_notional_micro_usdc: 250_000_000,
    daily_loss_limit_micro_usdc: 25_000_000,
    max_drawdown_micro_usdc: 30_000_000,
    max_drawdown_bps: 2_000,
    max_slippage_bps: 50,
    stop_loss_bps: 500,
    max_open_orders: 5,
    max_orders_per_day: 20,
    data_max_age_ms: 30_000,
    expires_at_ms: NOW + 3_600_000,
    kill_switch: false,
    jurisdiction: {
      eligible: true,
      accepted_risk: true,
      attested_at_ms: NOW - 1_000,
      terms_version: "hyperliquid-terms-2026-08",
    },
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    as_of_ms: NOW - 500,
    equity_micro_usdc: 200_000_000,
    day_start_equity_micro_usdc: 205_000_000,
    peak_equity_micro_usdc: 210_000_000,
    gross_exposure_micro_usdc: 20_000_000,
    daily_notional_micro_usdc: 30_000_000,
    orders_today: 2,
    open_order_count: 1,
    managed_open_order_ids: ["managed-order-1"],
    position_notional_micro_usdc: { BTC: 20_000_000 },
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    version: 1,
    operation: "order",
    network: "testnet",
    owner_address: OWNER,
    agent_address: AGENT,
    execution_address: OWNER,
    market: "BTC",
    side: "buy",
    notional_micro_usdc: 25_000_000,
    reference_price_e8: 10_000_000_000,
    limit_price_e8: 10_020_000_000,
    stop_loss_price_e8: 9_600_000_000,
    slippage_bps: 20,
    leverage: 3,
    venue_max_leverage: 50,
    margin_mode: "isolated",
    reduce_only: false,
    ...overrides,
  };
}

test("accepts a bounded, protected order", () => {
  const decision = evaluatePerpsIntent({ mandate: mandate(), intent: order(), state: state(), now_ms: NOW });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
});

test("fails closed on leverage, exposure, slippage, loss, and missing stop", () => {
  const decision = evaluatePerpsIntent({
    mandate: mandate(),
    intent: order({ leverage: 5, slippage_bps: 70, stop_loss_price_e8: 0 }),
    state: state({ gross_exposure_micro_usdc: 95_000_000, equity_micro_usdc: 170_000_000 }),
    now_ms: NOW,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("leverage_changed"));
  assert.ok(decision.reasons.includes("leverage_limit"));
  assert.ok(decision.reasons.includes("slippage_limit"));
  assert.ok(decision.reasons.includes("gross_exposure_limit"));
  assert.ok(decision.reasons.includes("daily_loss_limit_reached"));
  assert.ok(decision.reasons.includes("stop_loss_required"));
});

test("kill switch blocks increases but permits exact reductions and managed cancels", () => {
  const killed = mandate({ kill_switch: true });
  assert.equal(evaluatePerpsIntent({ mandate: killed, intent: order(), state: state(), now_ms: NOW }).allowed, false);
  assert.equal(evaluatePerpsIntent({
    mandate: killed,
    intent: order({ operation: "reduce_only", reduce_only: true, notional_micro_usdc: 20_000_000, stop_loss_price_e8: 0 }),
    state: state(),
    now_ms: NOW,
  }).allowed, true);
  assert.equal(evaluatePerpsIntent({
    mandate: killed,
    intent: {
      version: 1,
      operation: "cancel",
      network: "testnet",
      owner_address: OWNER,
      agent_address: AGENT,
      execution_address: OWNER,
      order_id: "managed-order-1",
    },
    state: state(),
    now_ms: NOW,
  }).allowed, true);
});

test("rejects an oversized reduce-only order", () => {
  const decision = evaluatePerpsIntent({
    mandate: mandate(),
    intent: order({ operation: "reduce_only", reduce_only: true, notional_micro_usdc: 20_000_001, stop_loss_price_e8: 0 }),
    state: state(),
    now_ms: NOW,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("reduce_only_oversized"));
});

test("normalization separates owner and agent wallets", () => {
  assert.throws(() => normalizePerpsMandate(mandate({ agent_address: OWNER })), /must differ/);
});

test("Turnkey policies bind the delegated user to the agent account and Exchange domain", () => {
  const policies = buildTurnkeyHyperliquidPolicies({
    delegated_user_id: "user-agent-123",
    owner_address: OWNER,
    agent_address: AGENT,
  });
  assert.equal(policies.length, 4);
  assert.match(policies[0].condition, /wallet_account\.address/);
  assert.match(policies[0].condition, /domain\.name == 'Exchange'/);
  assert.match(policies[1].condition, new RegExp(OWNER));
  assert.equal(policies[2].effect, "EFFECT_DENY");
});

test("owner mandate messages are canonical", () => {
  const first = ownerMandateMessage(mandate());
  const second = ownerMandateMessage({ ...mandate(), allowed_markets: ["BTC", "ETH"] });
  assert.equal(first, second);
  assert.match(first, /^Ghola Hyperliquid mandate v1\n/);
});
