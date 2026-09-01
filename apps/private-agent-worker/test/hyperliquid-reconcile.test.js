import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  reconcileHyperliquidOpenOrders,
  submitHyperliquidExecution,
} from "../src/venues/hyperliquid.js";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function credential() {
  return {
    network: "testnet",
    base_url: "https://api.hyperliquid-testnet.xyz",
    account_address: "0x0000000000000000000000000000000000000001",
    api_wallet_private_key: `0x${"11".repeat(32)}`,
  };
}

function instruction(cloid) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "reconcile",
    reconcile: { target_client_order_id: cloid },
  };
}

describe("Hyperliquid targeted reconciliation", () => {
  it("classifies only post-broadcast runner failures as submission ambiguous", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const check = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("hyperliquid_runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.request_failure_code(False) == "pre_submit_failed"
assert module.request_failure_code(True) == "submission_ambiguous"
def strict_fail(message, code="connector_submit_failed"):
    raise RuntimeError(code)
module.fail = strict_fail
expected_cloid = "0x11111111111111111111111111111111"
bad_acks = [
    {},
    {"status": "ok", "response": None},
    {"status": "ok", "response": {"data": {"statuses": []}}},
    {"status": "ok", "response": {"data": {"statuses": [{"error": "rejected"}]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": [{}]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": [None]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": ["waitingForFill"]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"resting": {"oid": 7, "cloid": "0x22222222222222222222222222222222"}}]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"filled": {"oid": 8, "totalSz": "9" * 400, "avgPx": "100"}}]}}},
    {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"resting": {"oid": 2 ** 60}}]}}},
]
for acknowledgement in bad_acks:
    try:
        module.assert_order_statuses_ok(acknowledgement, [expected_cloid])
    except RuntimeError as error:
        assert str(error) == "submission_ambiguous"
    else:
        raise AssertionError("post-broadcast acknowledgement accepted")
module.assert_order_statuses_ok({
    "status": "ok",
    "response": {"type": "order", "data": {"statuses": [{"resting": {"oid": 7, "cloid": expected_cloid}}]}},
}, [expected_cloid])
module.assert_order_statuses_ok({
    "status": "ok",
    "response": {"type": "order", "data": {"statuses": [{"filled": {"oid": 8, "totalSz": "0.1", "avgPx": "100"}}]}},
}, [expected_cloid])
for acknowledgement in [
    {"status": "ok", "response": {"type": "cancel", "data": {"statuses": [{}]}}},
    {"status": "ok", "response": {"type": "cancel", "data": {"statuses": [None]}}},
]:
    try:
        module.assert_cancel_statuses_ok(acknowledgement, 1)
    except RuntimeError as error:
        assert str(error) == "submission_ambiguous"
    else:
        raise AssertionError("malformed cancel acknowledgement accepted")
module.assert_cancel_statuses_ok({
    "status": "ok",
    "response": {"type": "cancel", "data": {"statuses": ["success"]}},
}, 1)
print("checked")
`;
    const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", check, runnerPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "checked");
  });

  it("keeps an unknown CLOID ambiguous and never invents venue proof", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"12".repeat(16)}`;
    const requests = [];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ status: "unknownOid" }), { status: 200 });
      },
    });

    assert.deepEqual(requests, [{
      type: "orderStatus",
      user: credential().account_address,
      oid: cloid,
    }]);
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.final_proof.final_venue_execution_proven, false);
    assert.equal(result.final_proof.target_client_order_matched, false);
    assert.equal(result.final_proof.final_fill_proven, false);
  });

  it("proves a fill only when orderStatus and the matching venue fill agree", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"34".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "filled", order: { oid: 4242, cloid } } },
      [{ oid: 4242, cloid, coin: "HYPE", px: "44", sz: "0.25", fee: "0.01", time: 1 }],
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(result.status, "reconciled");
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.target_client_order_matched, true);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.cumulative_filled_micro_usdc, 11_000_000);
    assert.equal(result.final_proof.filled_base_size, "0.25");
  });

  it("rejects an orderStatus row that does not match the requested CLOID", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"56".repeat(16)}`;
    let calls = 0;
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          status: "order",
          order: {
            status: "filled",
            order: { oid: 5151, cloid: `0x${"78".repeat(16)}` },
          },
        }), { status: 200 });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.final_proof.target_client_order_matched, false);
    assert.equal(result.final_proof.final_venue_execution_proven, false);
  });

  it("keeps a matching open order non-terminal", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"9a".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "open", order: { oid: 6161, cloid } } },
      [],
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.final_proof.target_client_order_matched, true);
    assert.equal(result.final_proof.broadcast_performed, true);
    assert.equal(result.final_proof.final_venue_execution_proven, false);
  });
});

describe("Hyperliquid open-order stream reconciliation", () => {
  const stop = {
    oid: 101,
    cloid: `0x${"ab".repeat(16)}`,
    coin: "HYPE",
    side: "A",
    sz: "0.13",
    limitPx: "77.35",
    reduceOnly: true,
  };

  it("removes a terminal stop update from the open-order snapshot", () => {
    const result = reconcileHyperliquidOpenOrders([stop], [{
      order: { ...stop },
      status: "reduceOnlyCanceled",
      statusTimestamp: 1,
    }]);

    assert.deepEqual(result, []);
  });

  it("does not remove another open order when a close fills", () => {
    const result = reconcileHyperliquidOpenOrders([stop], [{
      order: {
        oid: 202,
        cloid: `0x${"cd".repeat(16)}`,
        coin: "HYPE",
        side: "A",
        sz: "0.13",
        limitPx: "84",
        reduceOnly: true,
      },
      status: "filled",
      statusTimestamp: 2,
    }]);

    assert.deepEqual(result, [stop]);
  });

  it("upserts an open update and preserves snapshot-only fields", () => {
    const result = reconcileHyperliquidOpenOrders([{
      ...stop,
      triggerPx: "77.35",
      isTrigger: true,
    }], {
      orderUpdates: [{
        order: { ...stop, sz: "0.10" },
        status: "open",
        statusTimestamp: 3,
      }],
    });

    assert.deepEqual(result, [{
      ...stop,
      sz: "0.10",
      triggerPx: "77.35",
      isTrigger: true,
      status: "open",
    }]);
  });
});
