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
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.original_order_target_matched, false);
    assert.equal(result.final_proof.original_order_broadcast_proven, false);
    assert.equal(result.final_proof.final_fill_proven, false);
  });

  it("reconciles a direct live fill acknowledgement into authoritative timing without resubmission", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"23".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "filled", order: {
        oid: 2323,
        cloid,
        coin: "HYPE",
        origSz: "0.25",
        timestamp: 99,
      } } },
      [{ oid: 2323, cloid, tid: 23230, coin: "HYPE", px: "44", sz: "0.25", fee: "0.01", time: 100 }],
    ];
    let submissions = 0;
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        order: { market: "HYPE", side: "buy", base_size: "0.25", limit_price: "44", tif: "Ioc" },
      },
      cloid,
      runner: async () => {
        submissions += 1;
        return {
          status: "filled",
          oid: 2323,
          fills: [{ coin: "HYPE", px: "44", sz: "0.25", time: 100 }],
        };
      },
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(submissions, 1);
    assert.equal(result.status, "reconciled");
    assert.equal(result.final_proof.broadcast_performed, true);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.target_fill_set_complete, true);
    assert.equal(result.final_proof.fill_times_authoritative, true);
    assert.equal(result.final_proof.first_fill_at_ms, 100);
  });

  it("proves a fill only when orderStatus and the matching venue fill agree", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"34".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "filled", order: { oid: 4242, cloid, coin: "HYPE", origSz: "0.25", timestamp: 1 } } },
      [{ oid: 4242, cloid, tid: 1, coin: "HYPE", px: "44", sz: "0.25", fee: "0.01", time: 1 }],
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
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.original_order_target_matched, true);
    assert.equal(result.final_proof.original_order_broadcast_proven, true);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.target_fill_set_complete, true);
    assert.equal(result.final_proof.cumulative_filled_micro_usdc, 11_000_000);
    assert.equal(result.final_proof.filled_base_size, "0.25");
  });

  it("proves every fill for an order split across more than 25 trades", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"35".repeat(16)}`;
    const fills = Array.from({ length: 30 }, (_, index) => ({
      oid: 4343,
      cloid,
      tid: 10_000 + index,
      coin: "HYPE",
      px: "44",
      sz: "0.01",
      fee: "0.001",
      time: 100 + index,
    }));
    const responses = [
      { status: "order", order: { status: "filled", order: { oid: 4343, cloid, coin: "HYPE", origSz: "0.30", timestamp: 99 } } },
      fills,
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(result.status, "reconciled");
    assert.equal(result.fills.length, 30);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.fill_times_authoritative, true);
    assert.equal(result.final_proof.first_fill_at_ms, 100);
    assert.equal(result.final_proof.last_fill_at_ms, 129);
    assert.equal(result.final_proof.filled_base_size, "0.3");
  });

  it("paginates a capped Hyperliquid fill page without omitting boundary fills", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"36".repeat(16)}`;
    const firstPage = Array.from({ length: 2_000 }, (_, index) => ({
      oid: 4444,
      cloid,
      tid: 20_000 + index,
      coin: "HYPE",
      px: "44",
      sz: "0.01",
      fee: "0.001",
      time: 100 + index,
    }));
    const responses = [
      { status: "order", order: { status: "filled", order: { oid: 4444, cloid, coin: "HYPE", origSz: "20.01", timestamp: 99 } } },
      firstPage,
      [firstPage.at(-1), {
        oid: 4444,
        cloid,
        tid: 22_000,
        coin: "HYPE",
        px: "44",
        sz: "0.01",
        fee: "0.001",
        time: 2_100,
      }],
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(result.fills.length, 2_001);
    assert.equal(result.final_proof.final_fill_proven, true);
    assert.equal(result.final_proof.first_fill_at_ms, 100);
    assert.equal(result.final_proof.last_fill_at_ms, 2_100);
    assert.equal(result.final_proof.filled_base_size, "20.01");
  });

  it("never proves a capped Hyperliquid fill history that cannot advance", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"37".repeat(16)}`;
    const stuckPage = Array.from({ length: 2_000 }, (_, index) => ({
      oid: 4545,
      cloid,
      tid: 30_000 + index,
      coin: "HYPE",
      px: "44",
      sz: "0.01",
      fee: "0.001",
      time: 100 + index,
    }));
    let calls = 0;
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(cloid),
      cloid,
      fetchImpl: async () => {
        calls += 1;
        const body = calls === 1
          ? { status: "order", order: { status: "filled", order: { oid: 4545, cloid, coin: "HYPE", origSz: "20", timestamp: 99 } } }
          : stuckPage;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.final_proof.final_venue_execution_proven, false);
    assert.equal(result.final_proof.final_fill_proven, false);
    assert.equal(result.final_proof.fill_times_authoritative, false);
    assert.equal(result.provider_ref_seed.target_fill_set_complete, false);
  });

  it("proves terminal zero only from a complete exact-target fill history", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const target = `0x${"45".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "canceled", order: {
        oid: 4646,
        cloid: target,
        coin: "HYPE",
        origSz: "0.25",
        timestamp: 99,
      } } },
      [],
    ];
    let submissions = 0;
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id: "hyperliquid",
        operation_class: "cancel",
        cancel: { market: "HYPE", client_order_id: target },
      },
      cloid: `0x${"46".repeat(16)}`,
      runner: async () => {
        submissions += 1;
        return { status: "cancelled", oid: 4646, fills: [] };
      },
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(submissions, 1);
    assert.equal(result.status, "reconciled");
    assert.equal(result.final_proof.broadcast_performed, true);
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.final_fill_proven, false);
    assert.equal(result.final_proof.target_fill_set_complete, true);
    assert.equal(result.final_proof.cumulative_filled_micro_usdc, 0);
  });

  it("preserves authoritative timing for a complete terminal partial fill", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const target = `0x${"47".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "canceled", order: {
        oid: 4747,
        cloid: target,
        coin: "HYPE",
        origSz: "0.25",
        timestamp: 99,
      } } },
      [{ oid: 4747, cloid: target, tid: 47470, coin: "HYPE", px: "44", sz: "0.10", fee: "0.01", time: 100 }],
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(target),
      cloid: target,
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    assert.equal(result.status, "reconciled");
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.final_fill_proven, false);
    assert.equal(result.final_proof.target_fill_set_complete, true);
    assert.equal(result.final_proof.fill_times_authoritative, true);
    assert.equal(result.final_proof.fill_time_provenance, "hyperliquid_user_fills_time_v1");
    assert.equal(result.final_proof.first_fill_at_ms, 100);
    assert.equal(result.final_proof.last_fill_at_ms, 100);
    assert.equal(result.final_proof.filled_base_size, "0.1");
  });

  it("keeps cancelled and rejected targets ambiguous when fill history is unavailable", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    for (const [index, status] of ["canceled", "rejected"].entries()) {
      const target = `0x${String(48 + index).repeat(32).slice(0, 32)}`;
      let calls = 0;
      const result = await submitHyperliquidExecution({
        credential: credential(),
        instruction: instruction(target),
        cloid: target,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return new Response(JSON.stringify({
            status: "order",
            order: { status, order: { oid: 4800 + index, cloid: target, coin: "HYPE", origSz: "0.25", timestamp: 99 } },
          }), { status: 200 });
          return new Response("unavailable", { status: 503 });
        },
      });
      assert.equal(result.status, "outcome_unknown");
      assert.equal(result.final_proof.final_venue_execution_proven, false);
      assert.equal(result.final_proof.target_fill_set_complete, false);
      assert.equal(result.final_proof.cumulative_filled_micro_usdc, 0);
    }
  });

  it("binds complete fill proof to the requested account, order, CLOID, and market", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const target = `0x${"51".repeat(16)}`;
    const wrongCloid = `0x${"52".repeat(16)}`;
    const requests = [];
    const responses = [
      { status: "order", order: { status: "filled", order: {
        oid: 5151,
        cloid: target,
        coin: "HYPE",
        origSz: "0.25",
        timestamp: 99,
      } } },
      [
        { oid: 5151, cloid: target, tid: 51510, coin: "SOL", px: "44", sz: "0.25", time: 100 },
        { oid: 5151, cloid: wrongCloid, tid: 51511, coin: "HYPE", px: "44", sz: "0.25", time: 101 },
      ],
    ];
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: instruction(target),
      cloid: target,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      },
    });

    assert.ok(requests.every((request) => request.user === credential().account_address));
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.fills.length, 0);
    assert.equal(result.final_proof.final_venue_execution_proven, false);
    assert.equal(result.final_proof.target_fill_set_complete, false);
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

  it("rejects an orderStatus row when either supplied target identity conflicts", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"57".repeat(16)}`;
    let calls = 0;
    const result = await submitHyperliquidExecution({
      credential: credential(),
      instruction: {
        ...instruction(cloid),
        reconcile: {
          target_client_order_id: cloid,
          target_order_id: "5758",
          target_market: "HYPE",
        },
      },
      cloid,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          status: "order",
          order: {
            status: "filled",
            order: { oid: 5757, cloid, coin: "HYPE", origSz: "0.25", timestamp: 99 },
          },
        }), { status: 200 });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.final_proof.target_client_order_matched, false);
    assert.equal(result.final_proof.final_venue_execution_proven, false);
    assert.equal(result.final_proof.target_fill_set_complete, false);
  });

  it("keeps a matching open order non-terminal", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const cloid = `0x${"9a".repeat(16)}`;
    const responses = [
      { status: "order", order: { status: "open", order: { oid: 6161, cloid, coin: "HYPE" } } },
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
    assert.equal(result.final_proof.query_broadcast, false);
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.original_order_target_matched, true);
    assert.equal(result.final_proof.original_order_broadcast_proven, true);
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
