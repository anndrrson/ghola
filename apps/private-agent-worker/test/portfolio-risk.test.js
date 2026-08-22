import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAutopilotPortfolioProposal,
  portfolioMandateForSession,
  reconcileSessionPortfolio,
} from "../src/execution/portfolio-risk.js";

const NOW = new Date("2027-01-15T00:00:00.000Z");

function policy(overrides = {}) {
  return {
    policy_commitment: "autopilot_policy_portfolio_test",
    strategy_id: "bounded_intent_executor_v1",
    execution_network: "paper",
    venue_allowlist: ["jupiter", "hyperliquid"],
    market_allowlist: ["SOL-USD"],
    max_notional_bucket: "50",
    max_position_notional_bucket: "100",
    max_daily_notional_bucket: "250",
    daily_loss_limit_bucket: "50",
    max_drawdown_bucket: "100",
    configured_leverage_x100: 100,
    max_leverage_x100: 100,
    min_liquidation_distance_bps: 2_500,
    max_asset_concentration_bps: 10_000,
    max_drawdown_bps: 1_500,
    max_funding_bps_8h: 100,
    max_basis_bps: 500,
    max_fee_bps: 100,
    max_gas_micro_usdc: 1_000_000,
    max_open_orders: 10,
    max_model_decisions_per_hour: 20,
    max_model_cost_micro_usdc_per_day: 5_000_000,
    data_max_age_ms: 30_000,
    min_net_edge_bps: 5,
    kill_switch: false,
    reduce_only: false,
    mainnet_activation_id: null,
    owner_authorization_commitment: null,
    expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function session(policyOverrides = {}) {
  const sessionPolicy = policy(policyOverrides);
  const value = {
    autopilot_session_id: "autopilot_portfolio_test_session",
    owner_commitment: "owner_portfolio_test",
    session_policy: sessionPolicy,
    venue_access: {
      jupiter: { status: "ready", execution_mode: "user_stealth" },
      hyperliquid: { status: "ready", execution_mode: "byo_api_key" },
    },
    daily_notional_used_bucket: "0",
    pending_execution: null,
    portfolio_accounting: null,
  };
  value.portfolio_mandate = portfolioMandateForSession({
    session_id: value.autopilot_session_id,
    owner_commitment: value.owner_commitment,
    policy: sessionPolicy,
    now: NOW,
  });
  return value;
}

function proposal(overrides = {}) {
  return {
    proposal_commitment: "proposal_portfolio_test_0001",
    objective: "best_execution",
    venue_id: "jupiter",
    operation_class: "swap",
    market: "SOL-USD",
    product_type: "spot",
    side: "buy",
    notional_usd: 50,
    signal_bps: 50,
    routing: {
      expected_gross_benefit_bps: 50,
      selected_costs: {
        price_bps: 0,
        fee_bps: 5,
        slippage_bps: 2,
        funding_bps: 0,
        borrow_bps: 0,
        latency_bps: 0,
      },
      selected_quote: { gas_micro_usdc: 1_000 },
    },
    instruction: { order: { reduce_only: false } },
    ...overrides,
  };
}

function market() {
  return {
    product_id: "SOL-USD",
    price: 100,
    spread_bps: 4,
    fetched_at: NOW.toISOString(),
  };
}

test("session mandate binds self-custody, owner/agent separation, and policy caps", () => {
  const mandate = session().portfolio_mandate;
  assert.equal(mandate.custody_model, "self_custodial_turnkey");
  assert.notEqual(mandate.owner_wallet_id, mandate.agent_wallet_id);
  assert.deepEqual(mandate.allowed_venues, ["jupiter", "hyperliquid"]);
  assert.equal(mandate.max_net_exposure_micro_usdc, 100_000_000);
  assert.equal(mandate.authorization.kind, "body_bound_worker_capability");
});

test("portfolio gate rejects a route that breaches aggregate exposure", () => {
  const result = evaluateAutopilotPortfolioProposal({
    session: session(),
    positions: [{
      venue_id: "jupiter",
      asset: "SOL",
      market: "SOL-USD",
      product_type: "spot",
      side: "buy",
      signed_notional_micro_usdc: 75_000_000,
    }],
    proposal: proposal(),
    market: market(),
    now: NOW,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("net_exposure_limit"));
});

test("paper mandates can never reach a live venue adapter", () => {
  const result = evaluateAutopilotPortfolioProposal({
    session: session(),
    proposal: proposal(),
    market: market(),
    now: NOW,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.deepEqual(result.reasons, ["paper_network_requires_dry_run"]);
});

test("mainnet requires owner authorization and reconciled venue accounting", () => {
  const missingAuthorization = evaluateAutopilotPortfolioProposal({
    session: session({ execution_network: "mainnet", mainnet_activation_id: "activation:mainnet:1" }),
    proposal: proposal(),
    market: market(),
    now: NOW,
  });
  assert.deepEqual(missingAuthorization.reasons, ["owner_mandate_authorization_required"]);

  const authorized = session({
    execution_network: "mainnet",
    mainnet_activation_id: "activation:mainnet:1",
    owner_authorization_commitment: "owner:authorization:1",
  });
  const missingAccounting = evaluateAutopilotPortfolioProposal({
    session: authorized,
    proposal: proposal(),
    market: market(),
    now: NOW,
  });
  assert.deepEqual(missingAccounting.reasons, ["portfolio_reconciliation_required"]);
});

test("reconciled mainnet accounting unlocks only a mandate-compliant plan", () => {
  const value = session({
    execution_network: "mainnet",
    mainnet_activation_id: "activation:mainnet:1",
    owner_authorization_commitment: "owner:authorization:1",
  });
  const snapshot = {
    version: 1,
    snapshot_id: "snapshot:jupiter:0001",
    venue_id: "jupiter",
    account_commitment: "account:jupiter:0001",
    custody_type: "turnkey_wallet",
    as_of_ms: NOW.getTime(),
    sequence: 1,
    equity_micro_usdc: 250_000_000,
    collateral_micro_usdc: 250_000_000,
    balances: [{ asset: "USDC", value_micro_usdc: 250_000_000, available_value_micro_usdc: 250_000_000 }],
    positions: [],
    open_orders: [],
  };
  value.portfolio_accounting = reconcileSessionPortfolio({
    session: value,
    expected_snapshots: [snapshot],
    observed_snapshots: [snapshot],
    now: NOW,
  });
  const result = evaluateAutopilotPortfolioProposal({
    session: value,
    proposal: proposal(),
    market: market(),
    now: NOW,
  });
  assert.equal(value.portfolio_accounting.status, "reconciled");
  assert.equal(result.allowed, true);
  assert.equal(result.metrics.expected_net_benefit_bps, 42);
});
