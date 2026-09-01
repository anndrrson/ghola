import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LighterExecutionError,
  lighterClientOrderIndex,
  lighterCredentialFromVault,
  readLighterWithdrawalRouteQuote,
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

test("reads exact Lighter withdrawal capacity and delay without broadcasting", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    const quote = await readLighterWithdrawalRouteQuote({
      credential: credential(),
      account_state_commitment: "carry:account-state:lighter:0001",
      now: () => 1_800_000_000_000,
      runner: async (payload) => {
        assert.equal(payload.action, "route_terms");
        return {
          credential_verified: true,
          account_state_checked: true,
          withdrawal_terms_checked: true,
          normal_withdrawal_fee_usdc: "0",
          fee_source: "lighter_sdk_normal_withdrawal_v1",
          minimum_withdrawal_usdc: "3.0000001",
          maximum_withdrawal_usdc: "50.1234569",
          withdrawal_delay_seconds: 1069,
          transaction_broadcast: false,
        };
      },
    });
    assert.equal(quote.minimum_transfer_micro_usdc, 3_000_001);
    assert.equal(quote.maximum_transfer_micro_usdc, 50_123_456);
    assert.equal(quote.fee_upper_bound_micro_usdc, 0);
    assert.equal(quote.latency_upper_bound_ms, 1_069_000);
    assert.equal(quote.fund_movement_authorized, false);
    assert.equal(quote.transaction_broadcast, false);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

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

test("binds every signed Lighter order field to the requested packet", () => {
  const runnerPath = fileURLToPath(new URL("../src/venues/lighter_runner.py", import.meta.url));
  const check = String.raw`
import copy, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("lighter_runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def strict_fail(message, code="connector_submit_failed"):
    raise RuntimeError(code)
module.fail = strict_fail
expected = {
    "MarketIndex": 1, "ClientOrderIndex": 77, "BaseAmount": 100,
    "Price": 600000, "IsAsk": 0, "Type": 0, "TimeInForce": 1, "ReduceOnly": 0,
}
module.check_signed_order_fields(json.dumps(expected), expected)
for field in expected:
    mutated = copy.deepcopy(expected)
    mutated[field] += 1
    try:
        module.check_signed_order_fields(json.dumps(mutated), expected)
    except RuntimeError as error:
        assert str(error) == "venue_rejected"
    else:
        raise AssertionError(field)
print("checked")
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", check, runnerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "checked");
});

test("binds a Lighter cancel target to both client order index and market", () => {
  const runnerPath = fileURLToPath(new URL("../src/venues/lighter_runner.py", import.meta.url));
  const check = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("lighter_runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
orders = [
    {"client_order_index": 77, "market_index": 2, "order_index": 88},
    {"client_order_index": 77, "market_index": 1, "order_index": 89},
]
assert module.exact_market_order(orders, 77, 1)["order_index"] == 89
assert module.exact_market_order(orders[:1], 77, 1) is None
assert module.exact_market_order([{"client_order_index": 77, "market_id": 1, "order_index": 90}], 77, 1)["order_index"] == 90
print("checked")
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", check, runnerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "checked");
});

test("uses the pinned Lighter SDK active and inactive order APIs for exact reconciliation", () => {
  const runnerPath = fileURLToPath(new URL("../src/venues/lighter_runner.py", import.meta.url));
  const check = String.raw`
import asyncio, importlib.util, sys
spec = importlib.util.spec_from_file_location("lighter_runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.credential = {"api_key_index": 4}
def strict_fail(message, code="connector_submit_failed"):
    raise RuntimeError(code)
module.fail = strict_fail
class OrderApi:
    def __init__(self):
        self.active_calls = []
        self.inactive_calls = []
    async def account_active_orders(self, **kwargs):
        self.active_calls.append(kwargs)
        return {"orders": [{"client_order_index": 77, "market_index": 2, "order_index": 8}]}
    async def account_inactive_orders(self, **kwargs):
        self.inactive_calls.append(kwargs)
        if kwargs.get("cursor") == "page-2":
            return {"orders": [{"client_order_index": 77, "market_index": 1, "order_index": 9, "status": "filled"}]}
        return {"orders": [{"client_order_index": 66, "market_index": 1, "order_index": 7}], "next_cursor": "page-2"}
class Client:
    def __init__(self):
        self.order_api = OrderApi()
    def create_auth_token_with_expiry(self, api_key_index):
        assert api_key_index == 4
        return "signed-read-token", None
async def main():
    client = Client()
    found = await module.exact_account_order(client, 123, 1, 77, include_inactive=True)
    assert found["order_index"] == 9
    assert client.order_api.active_calls == [{"account_index": 123, "market_id": 1, "authorization": "signed-read-token"}]
    assert client.order_api.inactive_calls == [
        {"account_index": 123, "limit": 100, "authorization": "signed-read-token", "market_id": 1},
        {"account_index": 123, "limit": 100, "authorization": "signed-read-token", "market_id": 1, "cursor": "page-2"},
    ]
    client = Client()
    missing = await module.exact_account_order(client, 123, 1, 77, include_inactive=False)
    assert missing is None
    assert client.order_api.inactive_calls == []
    client = Client()
    async def looping_inactive(**kwargs):
        return {"orders": [], "next_cursor": "same"}
    client.order_api.account_inactive_orders = looping_inactive
    try:
        await module.exact_account_order(client, 123, 1, 77, include_inactive=True)
    except RuntimeError as error:
        assert str(error) == "connector_submit_failed"
    else:
        raise AssertionError("repeated cursor accepted")
asyncio.run(main())
print("checked")
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", check, runnerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "checked");
});

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
        account_state_checked: true,
        market_data_checked: true,
        order_packet_built: true,
        signed_order_fields_checked: true,
        transaction_broadcast: false,
        account: {
          status: 1,
          available_balance: "500",
          total_asset_value: "500",
          cross_initial_margin_requirement: "0",
          cross_maintenance_margin_requirement: "0",
          pending_order_count: 0,
          positions: [{
            market_id: 1,
            symbol: "BTC",
            sign: 1,
            position: "0.5",
            position_value: "50000",
            liquidation_price: "75000",
          }],
        },
        market: { maker_fee: "0.00010", taker_fee: "0.00045" },
        order_shape: { base_size: "0.0010", limit_price: "100000.00", quantity_step_e8: 10_000, price_tick_e8: 1_000_000 },
      }),
    });
    assert.equal(result.status, "verified_ready");
    assert.equal(result.checks.transaction_broadcast, false);
    assert.equal(result.account.taker_fee_bps, 4.5);
    assert.equal(result.account.fees_conservative_upper_bound, true);
    assert.equal(result.account.position_count, 1);
    assert.equal(result.account.liquidation_distance_bps, 2_500);
    assert.equal(result.account.liquidation_distance_verified, true);
    assert.equal(result.account.liquidation_distance_source, "lighter_account_positions_position_value_v1");
    assert.equal(result.account.flat_zero_orders, false);
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

test("fails closed when Lighter no-submit omits signed packet binding or account order counts", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  const verified = {
    credential_verified: true,
    account_state_checked: true,
    market_data_checked: true,
    order_packet_built: true,
    signed_order_fields_checked: true,
    transaction_broadcast: false,
    account: { available_balance: "50", collateral: "50", positions: [] },
    market: { maker_fee: "0.0001", taker_fee: "0.00045" },
    order_shape: { base_size: "0.001", limit_price: "100000" },
  };
  try {
    await assert.rejects(verifyLighterNoSubmit({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 77,
      runner: async () => ({ ...verified, signed_order_fields_checked: false }),
    }), (error) => error.code === "connector_submit_failed");
    const result = await verifyLighterNoSubmit({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 77,
      runner: async () => verified,
    });
    assert.equal(result.account.position_count, 0);
    assert.equal(result.account.open_order_count, null);
    assert.equal(result.account.flat_zero_orders, false);
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

test("recovers an ambiguous Lighter cancel against only its original target", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  let cancelCalls = 0;
  let reconcileCalls = 0;
  try {
    const result = await submitAndReconcileLighterExecution({
      credential: credential(),
      instruction: {
        operation_class: "cancel",
        cancel: { market: "BTC", client_order_index: 77 },
      },
      clientOrderIndex: 900,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      runner: async (payload) => {
        if (payload.action === "cancel") {
          cancelCalls += 1;
          assert.equal(payload.client_order_index, 77);
          assert.equal(payload.market, "BTC");
          throw new Error("cancel response lost after write");
        }
        reconcileCalls += 1;
        assert.equal(payload.action, "reconcile");
        assert.equal(payload.client_order_index, 77);
        assert.equal(payload.market, "BTC");
        return { target_market_checked: true, order: { status: "cancelled", client_order_index: 77, order_index: 88 } };
      },
    });
    assert.equal(cancelCalls, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(result.status, "cancelled");
    assert.equal(result.final_proof.open_order_count, 0);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.reconciliation.submissionResponseAmbiguous, true);
    assert.equal(result.reconciliation.submission_retry_count, 0);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("does not relabel a deterministic Lighter rejection as ambiguous", async () => {
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
        throw new LighterExecutionError("rejected", 422, "venue_rejected");
      },
    }), (error) => error.code === "venue_rejected");
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
          ? { target_market_checked: true, order: { status: "open", client_order_index: 77, market_index: 1, remaining_base_amount: "0.001" } }
          : { target_market_checked: true, order: { status: "filled", client_order_index: 77, market_index: 1, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.equal(submitCalls, 1);
    assert.equal(reconcileCalls, 2);
    assert.equal(result.status, "filled");
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.broadcast_performed, true);
    assert.equal(result.provider_ref_seed.submission_tx_hash, "0xsubmit");
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("recovers an ambiguous Lighter submit response by reading the exact order without resubmitting", async () => {
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
      clientOrderIndex: 78,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      runner: async (payload) => {
        if (payload.action === "submit") {
          submitCalls += 1;
          throw new Error("response lost after write");
        }
        assert.equal(payload.action, "reconcile");
        assert.equal(payload.client_order_index, 78);
        reconcileCalls += 1;
        if (reconcileCalls === 1) throw new Error("read replica lag");
        return { target_market_checked: true, order: { status: "filled", client_order_index: 78, order_index: 89, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.equal(submitCalls, 1);
    assert.equal(reconcileCalls, 2);
    assert.equal(result.status, "filled");
    assert.equal(result.reconciliation.submissionResponseAmbiguous, true);
    assert.equal(result.reconciliation.submission_retry_count, 0);
    assert.equal(result.reconciliation.target_client_order_only, true);
    assert.equal(result.reconciliation.readFailures, 1);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.original_order_target_matched, true);
    assert.equal(result.final_proof.original_order_broadcast_proven, true);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("bounds exact-order reconciliation when an ambiguous Lighter submit cannot be found", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  let submitCalls = 0;
  let reconcileCalls = 0;
  try {
    await assert.rejects(submitAndReconcileLighterExecution({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 79,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      env: {
        PRIVATE_AGENT_LIGHTER_RECONCILE_TIMEOUT_MS: "250",
        PRIVATE_AGENT_LIGHTER_RECONCILE_INTERVAL_MS: "100",
      },
      runner: async (payload) => {
        if (payload.action === "submit") {
          submitCalls += 1;
          throw new Error("response lost after write");
        }
        reconcileCalls += 1;
        throw new Error("not visible yet");
      },
    }), (error) => error.code === "submission_ambiguous");
    assert.equal(submitCalls, 1);
    assert.equal(reconcileCalls, 4);
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

test("rejects a malformed Lighter funding history response", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  try {
    await assert.rejects(readLighterFundingSettlements({
      credential: credential(),
      market: "BTC",
      start_time_ms: 1_800_000_000_000,
      end_time_ms: 1_800_003_600_000,
      runner: async () => ({ symbol: "BTC", funding_rows: null }),
    }), (error) => error.code === "connector_submit_failed");
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
        return { target_market_checked: true, order: { status: "filled", client_order_index: 77, order_index: 88, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.equal(result.status, "filled");
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.original_order_target_matched, true);
    assert.equal(result.final_proof.original_order_broadcast_proven, true);
    assert.equal(result.fills[0].price, "100000");
    const partial = await reconcileLighterExecution({
      credential: credential(),
      clientOrderIndex: 77,
      market: "BTC",
      runner: async () => ({
        target_market_checked: true,
        order: { status: "partial", client_order_index: 77, order_index: null, filled_base_amount: "0.0005", filled_quote_amount: "50" },
      }),
    });
    assert.equal(partial.status, "partially_filled");
    assert.equal(partial.final_proof.final_venue_execution_proven, false);
    assert.equal(partial.final_proof.open_order_count, 1);
    assert.equal(partial.final_proof.original_order_target_matched, false);
    assert.equal(partial.final_proof.original_order_broadcast_proven, false);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("rejects a mismatched Lighter reconciliation row after an ambiguous submission", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "full_ticket";
  let submitCalls = 0;
  let reconcileCalls = 0;
  try {
    await assert.rejects(submitAndReconcileLighterExecution({
      credential: credential(),
      instruction: instruction(),
      clientOrderIndex: 77,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      env: {
        PRIVATE_AGENT_LIGHTER_RECONCILE_TIMEOUT_MS: "250",
        PRIVATE_AGENT_LIGHTER_RECONCILE_INTERVAL_MS: "100",
      },
      runner: async (payload) => {
        if (payload.action === "submit") {
          submitCalls += 1;
          throw new Error("response lost after write");
        }
        reconcileCalls += 1;
        return {
          target_market_checked: true,
          order: {
            status: "filled",
            client_order_index: 999,
            order_index: 88,
            filled_base_amount: "0.001",
            filled_quote_amount: "100",
          },
        };
      },
    }), (error) => error.code === "submission_ambiguous");
    assert.equal(submitCalls, 1);
    assert.equal(reconcileCalls, 4);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});

test("keeps explicit Lighter reconciliation bound to the original order across read failures", async () => {
  const previousAllow = process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
  process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = "read_only";
  const targets = [];
  let reads = 0;
  try {
    const result = await submitAndReconcileLighterExecution({
      credential: credential(),
      instruction: {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id: "lighter",
        operation_class: "reconcile",
        reconcile: { market: "BTC", target_client_order_index: 77 },
      },
      clientOrderIndex: 91,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      runner: async (payload) => {
        assert.equal(payload.action, "reconcile");
        targets.push(payload.client_order_index);
        reads += 1;
        if (reads === 1) throw new Error("temporary read failure");
        return { target_market_checked: true, order: { status: "filled", client_order_index: 77, order_index: 88, filled_base_amount: "0.001", filled_quote_amount: "100" } };
      },
    });
    assert.deepEqual(targets, [77, 77]);
    assert.equal(result.status, "filled");
    assert.equal(result.reconciliation.reconcileOnly, true);
    assert.equal(result.reconciliation.submission_retry_count, 0);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.original_order_target_matched, true);
    assert.equal(result.final_proof.original_order_broadcast_proven, true);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE;
    else process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE = previousMode;
  }
});
