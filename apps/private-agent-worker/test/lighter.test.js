import assert from "node:assert/strict";
import test from "node:test";
import {
  lighterClientOrderIndex,
  lighterCredentialFromVault,
  readLighterFundingSettlements,
  reconcileLighterExecution,
  submitAndReconcileLighterExecution,
  submitLighterExecution,
  verifyLighterCredential,
  verifyLighterNoSubmit,
} from "../src/venues/lighter.js";

function credential() {
  return lighterCredentialFromVault({
    version: 1,
    kind: "ghola_lighter_execution_vault",
    network: "mainnet",
    account_commitment: "private_account_lighter_test",
    owner_address: `0x${"33".repeat(20)}`,
    account_index: 123,
    api_key_index: 4,
    api_private_key: "11".repeat(32),
    api_public_key: "22".repeat(40),
    provisioning_status: "owner_association_verified",
    permissions: { can_read: true, can_trade: true, can_withdraw: false, can_transfer: false },
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
    owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
  });
}

function instruction(overrides = {}) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "lighter",
    operation_class: "limit_order",
    order: {
      market: "BTC",
      side: "buy",
      base_size: "0.001",
      limit_price: "100000",
      tif: "Ioc",
      reduce_only: false,
      ...overrides,
    },
  };
}

test("keeps Lighter fund operations owner-only inside the attested worker boundary", () => {
  const result = credential();
  assert.equal(result.authority_boundary.venue_native_trade_only, false);
  assert.ok(result.authority_boundary.owner_only.includes("withdraw"));
  assert.ok(result.authority_boundary.owner_only.includes("transfer"));
  assert.equal(JSON.stringify(result).includes("can_withdraw\":true"), false);
});

test("rejects a Lighter execution vault outside its exact active account binding", () => {
  const base = {
    version: 1,
    kind: "ghola_lighter_execution_vault",
    network: "mainnet",
    account_commitment: "private_account_lighter_test",
    owner_address: `0x${"33".repeat(20)}`,
    account_index: 123,
    api_key_index: 4,
    api_private_key: "11".repeat(32),
    api_public_key: "22".repeat(40),
    provisioning_status: "owner_association_verified",
    permissions: { can_read: true, can_trade: true, can_withdraw: false, can_transfer: false },
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
    owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
  };
  assert.throws(
    () => lighterCredentialFromVault(base, { accountCommitment: "private_account_wrong" }),
    (error) => error.code === "venue_access_required",
  );
  assert.throws(
    () => lighterCredentialFromVault({ ...base, provisioning_status: "pending_owner_association" }),
    (error) => error.code === "venue_access_required",
  );
  assert.throws(
    () => lighterCredentialFromVault({ ...base, allowed_operations: ["read"] }),
    (error) => error.code === "venue_access_required",
  );
});

test("authenticates a Lighter key and account without broadcasting", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const result = await verifyLighterCredential({
      credential: credential(),
      runner: async (payload) => {
        assert.equal(payload.action, "credential");
        return {
          credential_verified: true,
          account_read: true,
          transaction_broadcast: false,
          account: { status: 1, available_balance: "50", collateral: "50", pending_order_count: 0 },
        };
      },
    });
    assert.equal(result.can_read, true);
    assert.equal(result.can_trade, true);
    assert.equal(result.venue_native_trade_only, false);
    assert.equal(result.secure_withdrawal_to_owner_possible, true);
    assert.equal(result.non_owner_fund_movement_possible, false);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("builds a Lighter order packet without broadcast", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const result = await verifyLighterNoSubmit({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: lighterClientOrderIndex("lighter_work_order_0001"),
      runner: async () => ({
        credential_verified: true,
        order_packet_built: true,
        transaction_broadcast: false,
        account: {
          status: 1,
          available_balance: "500",
          total_asset_value: "500",
          cross_initial_margin_requirement: "0",
          cross_maintenance_margin_requirement: "0",
          pending_order_count: 0,
          positions: [],
        },
        market: { maker_fee: "0.00010", taker_fee: "0.00045" },
        order_shape: { base_size: "0.0010", limit_price: "100000.00", quantity_step_e8: 10_000, price_tick_e8: 1_000_000 },
      }),
    });
    assert.equal(result.status, "verified_ready");
    assert.equal(result.checks.transaction_broadcast, false);
    assert.equal(result.account.taker_fee_bps, 4.5);
    assert.equal(result.account.fees_conservative_upper_bound, true);
    assert.equal(result.authority_boundary.secure_withdrawal_destination, "owner_l1_only");
    assert.equal(result.authority_boundary.non_owner_fund_movement_possible, false);
    assert.equal(result.order_shape.notional_micro_usdc, 100_000_000);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("never retries an ambiguous Lighter submission", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  let calls = 0;
  try {
    await assert.rejects(submitLighterExecution({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 77,
      runner: async () => {
        calls += 1;
        throw new Error("timeout");
      },
    }), (error) => error.code === "submission_ambiguous");
    assert.equal(calls, 1);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("submits once and polls the exact client order until terminal fill", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  let submitCalls = 0;
  let reconcileCalls = 0;
  try {
    const result = await submitAndReconcileLighterExecution({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 77,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      runner: async (payload) => {
        if (payload.action === "submit") {
          submitCalls += 1;
          return { accepted: true, status: "submitted", tx_hash: "0xsubmit" };
        }
        assert.equal(payload.action, "reconcile");
        assert.equal(payload.client_order_index, 77);
        reconcileCalls += 1;
        return reconcileCalls === 1
          ? { order: { status: "open", market_index: 1, remaining_base_amount: "0.001" } }
          : { order: { status: "filled", market_index: 1, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.equal(submitCalls, 1);
    assert.equal(reconcileCalls, 2);
    assert.equal(result.status, "filled");
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.provider_ref_seed.submission_tx_hash, "0xsubmit");
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("normalizes only user funding payments from the authenticated Lighter export", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const rows = await readLighterFundingSettlements({
      credential: credential(),
      market: "BTC",
      start_time_ms: 1_800_000_000_000,
      end_time_ms: 1_800_003_600_000,
      runner: async (payload) => {
        assert.equal(payload.action, "funding");
        return {
          symbol: "BTC",
          funding_rows: [
            { funding_id: "funding-1", timestamp: "1800003600", change: "-0.0105", quote_asset: "USDC" },
            { funding_id: "rate-only", timestamp: "1800003600", value: "0.0001" },
          ],
        };
      },
    });
    assert.deepEqual(rows, [{ venue_id: "lighter", asset: "BTC", occurred_at_ms: 1_800_003_600_000, amount_quote: "-0.0105", quote_asset: "USDC", settlement_id: "funding-1" }]);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("reconciles the exact Lighter client order index", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const result = await reconcileLighterExecution({
      credential: credential(),
      clientOrderIndex: 77,
      market: "BTC",
      runner: async (payload) => {
        assert.equal(payload.client_order_index, 77);
        assert.equal(payload.market, "BTC");
        return { order: { status: "filled", order_index: 88, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.equal(result.status, "filled");
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.fills[0].price, "100000");
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});
