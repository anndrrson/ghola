import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createHyperliquidAccountStateStream,
  hyperliquidCollateralValue,
  hyperliquidCredentialFromVault,
  hyperliquidRunnerTimeoutMs,
  assertHyperliquidPilotNetwork,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
} from "../src/venues/hyperliquid.js";

describe("Hyperliquid credential isolation", () => {
  it("rejects the master wallet private key after opening the sealed vault", () => {
    assert.throws(() => hyperliquidCredentialFromVault({
      kind: "ghola_hyperliquid_execution_vault",
      network: "mainnet",
      hyperliquid_account_address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      api_wallet_private_key: `0x${"0".repeat(63)}1`,
    }), /master wallet key is forbidden/);
  });
});

describe("Hyperliquid immediate execution proof", () => {
  it("preserves a venue-proven fill instead of reducing it to submitted", async () => {
    const result = await submitHyperliquidExecution({
      credential: { network: "testnet" },
      instruction: { operation_class: "limit_order", order: { market: "BTC" } },
      cloid: "0x" + "1".repeat(32),
      runner: async () => ({
        status: "filled",
        oid: 7,
        fills: [{ oid: 7, px: "64000", sz: "0.0002" }],
      }),
    });

    assert.equal(result.status, "filled");
    assert.equal(result.fills.length, 1);
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.final_fill_proven, true);
  });

  it("proves an IOC completed without claiming a fill", async () => {
    const result = await submitHyperliquidExecution({
      credential: { network: "testnet" },
      instruction: { operation_class: "limit_order", order: { market: "BTC" } },
      cloid: "0x" + "2".repeat(32),
      runner: async () => ({ status: "unfilled", oid: null, fills: [] }),
    });

    assert.equal(result.status, "unfilled");
    assert.equal(result.final_proof.final_venue_execution_proven, true);
    assert.equal(result.final_proof.final_fill_proven, false);
  });

  it("separates a filled exact close from proof that the account is flat", async () => {
    const instruction = {
      operation_class: "limit_order",
      order: { market: "BTC", reduce_only: true, close_position: true },
    };
    const flat = await submitHyperliquidExecution({
      credential: { network: "testnet" },
      instruction,
      cloid: "0x" + "3".repeat(32),
      runner: async () => ({
        status: "filled",
        fills: [{ oid: 9, px: "64000", sz: "0.0002" }],
        final_position_state_checked: true,
        final_position_flat_proven: true,
      }),
    });
    const residual = await submitHyperliquidExecution({
      credential: { network: "testnet" },
      instruction,
      cloid: "0x" + "4".repeat(32),
      runner: async () => ({
        status: "filled",
        fills: [{ oid: 10, px: "64000", sz: "0.0001" }],
        final_position_state_checked: true,
        final_position_flat_proven: false,
      }),
    });

    assert.equal(flat.final_proof.final_fill_proven, true);
    assert.equal(flat.final_proof.final_position_state_checked, true);
    assert.equal(flat.final_proof.final_position_flat_proven, true);
    assert.equal(residual.final_proof.final_fill_proven, true);
    assert.equal(residual.final_proof.final_position_state_checked, true);
    assert.equal(residual.final_proof.final_position_flat_proven, false);
  });
});

describe("Hyperliquid deployment configuration", () => {
  it("accepts newline-terminated mainnet policy values", () => {
    const previousAllow = process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
    const previousMode = process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true\n";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket\n";
    try {
      assert.doesNotThrow(() => assertHyperliquidPilotNetwork(
        { network: "mainnet" },
        { operation_class: "limit_order", order: { market: "BTC" } },
      ));
    } finally {
      if (previousAllow == null) delete process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
      else process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = previousAllow;
      if (previousMode == null) delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
      else process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = previousMode;
    }
  });

  it("accepts an exact close without an unrelated quote amount", () => {
    const previousAllow = process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
    const previousMode = process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    try {
      assert.doesNotThrow(() => assertHyperliquidPilotNetwork(
        { network: "mainnet" },
        {
          operation_class: "limit_order",
          order: {
            market: "BTC",
            live_order_mode: "tiny_fill",
            tif: "Ioc",
            reduce_only: true,
            close_position: true,
          },
        },
      ));
    } finally {
      if (previousAllow == null) delete process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
      else process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = previousAllow;
      if (previousMode == null) delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
      else process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = previousMode;
    }
  });
});

describe("Hyperliquid SDK runner timeout", () => {
  it("allows signed venue submission to finish inside the web proxy bound", () => {
    assert.equal(hyperliquidRunnerTimeoutMs({}), 30_000);
    assert.equal(hyperliquidRunnerTimeoutMs({ PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "invalid" }), 30_000);
    assert.equal(hyperliquidRunnerTimeoutMs({ PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "40000" }), 40_000);
  });

  it("fails closed before the outer 55 second proxy deadline", () => {
    assert.equal(hyperliquidRunnerTimeoutMs({ PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "90000" }), 45_000);
    assert.equal(hyperliquidRunnerTimeoutMs({ PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "1000" }), 30_000);
  });
});

describe("Hyperliquid venue minimum", () => {
  it("rejects a $10 SOL quote that floors below the venue minimum", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def all_mids(self): return {"SOL": "70"}
    def meta(self): return {"universe": [{"name": "SOL", "szDecimals": 2}]}
    def post(self, *_args): return "unifiedAccount"
    def spot_user_state(self, *_args): return {"tokenToAvailableAfterMaintenance": [[0, "25"]]}
try:
    runner.resolve_market_ioc_order(Info(), {
        "market": "SOL", "side": "buy", "quote_size": "10", "max_slippage_bps": "50"
    }, "0x" + "1" * 40, require_funds=False)
except SystemExit:
    pass
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const failure = JSON.parse(result.stdout.trim());
    assert.equal(failure.error_code, "order_below_venue_minimum");
    assert.equal(failure.submission_state, "not_submitted");
  });

  it("classifies venue result envelopes instead of assuming submission", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
print(json.dumps([
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"filled": {"oid": 7, "avgPx": "64000", "totalSz": "0.0002"}}]}}}),
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"resting": {"oid": 8}}]}}}),
    runner.redact_result("unfilled", {"response": {"data": {"statuses": [{"resting": {"oid": 9}}]}}}),
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"error": "Order could not immediately match against any resting orders."}]}}}),
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"error": "Order must have minimum value of $10."}]}}}),
    runner.redact_result("submitted", {}),
]))
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const [filled, resting, iocResting, unfilled, rejected, unknown] = JSON.parse(result.stdout.trim());
    assert.deepEqual(filled, {
      status: "filled",
      oid: 7,
      fills: [{ oid: 7, px: "64000", sz: "0.0002" }],
    });
    assert.deepEqual(resting, { status: "resting", oid: 8, fills: [] });
    assert.deepEqual(iocResting, { status: "unfilled", oid: 9, fills: [] });
    assert.deepEqual(unfilled, { status: "unfilled", oid: null, fills: [] });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.error_code, "order_below_venue_minimum");
    assert.equal(unknown.status, "outcome_unknown");
  });
});

describe("Hyperliquid leverage application", () => {
  it("applies the reviewed cross leverage before an opening order and skips closes", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def meta(self): return {"universe": [{"name": "SOL", "maxLeverage": 20}]}
class Exchange:
    def __init__(self): self.calls = []
    def update_leverage(self, leverage, market, is_cross=True):
        self.calls.append([leverage, market, is_cross])
        return {"status": "ok", "response": {"type": "default"}}
exchange = Exchange()
runner.apply_order_leverage(exchange, Info(), {"market": "SOL", "leverage": 1, "margin_mode": "cross"})
runner.apply_order_leverage(exchange, Info(), {"market": "SOL", "leverage": 5, "margin_mode": "isolated", "reduce_only": True})
print(json.dumps(exchange.calls))
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [[1, "SOL", true]]);
  });

  it("fails closed before order submission when leverage is rejected", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def meta(self): return {"universe": [{"name": "SOL", "maxLeverage": 20}]}
class Exchange:
    def update_leverage(self, *_args, **_kwargs): return {"status": "err"}
try:
    runner.apply_order_leverage(Exchange(), Info(), {"market": "SOL", "leverage": 1})
except SystemExit:
    pass
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const failure = JSON.parse(result.stdout.trim());
    assert.equal(failure.error_code, "venue_rejected");
    assert.equal(failure.submission_state, "not_submitted");
  });
});

describe("Hyperliquid exact position close", () => {
  it("derives the full base size and opposite side from venue position state", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def __init__(self, size): self.size = size
    def user_state(self, _account):
        return {"assetPositions": [{"position": {"coin": "BTC", "szi": self.size}}]}
    def all_mids(self): return {"BTC": "100"}
def order(side):
    return {"market": "BTC", "side": side, "reduce_only": True, "close_position": True, "max_slippage_bps": "50"}
print(json.dumps([
    runner.resolve_limit_order(Info("0.125"), order("sell"), "0xaccount"),
    runner.resolve_limit_order(Info("-0.375"), order("buy"), "0xaccount"),
]))
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      {
        base_size: "0.125",
        limit_price: "99.5",
        tif: "Ioc",
        account_state_checked: true,
        source_position_size: "0.125",
      },
      {
        base_size: "0.375",
        limit_price: "100.5",
        tif: "Ioc",
        account_state_checked: true,
        source_position_size: "-0.375",
      },
    ]);
  });

  it("fails closed when the requested side would not reduce the live position", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def user_state(self, _account):
        return {"assetPositions": [{"position": {"coin": "BTC", "szi": "0.125"}}]}
    def all_mids(self): return {"BTC": "100"}
try:
    runner.resolve_limit_order(Info(), {"market": "BTC", "side": "buy", "reduce_only": True, "close_position": True}, "0xaccount")
except SystemExit:
    pass
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const failure = JSON.parse(result.stdout.trim());
    assert.equal(failure.error_code, "venue_rejected");
    assert.match(failure.error, /does not reduce/);
  });

  it("proves flat only from a successful post-order venue account read", () => {
    const runnerPath = fileURLToPath(new URL("../src/venues/hyperliquid_runner.py", import.meta.url));
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ghola_hl_runner", ${JSON.stringify(runnerPath)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Info:
    def __init__(self, state): self.state = state
    def user_state(self, _account):
        if self.state == "error": raise RuntimeError("unavailable")
        if self.state == "flat": return {"assetPositions": []}
        return {"assetPositions": [{"position": {"coin": "BTC", "szi": "0.025"}}]}
order = {"market": "BTC", "reduce_only": True, "close_position": True}
print(json.dumps([
    runner.reconcile_exact_position_close(Info("flat"), order, "0xaccount"),
    runner.reconcile_exact_position_close(Info("residual"), order, "0xaccount"),
    runner.reconcile_exact_position_close(Info("error"), order, "0xaccount"),
]))
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      { final_position_state_checked: true, final_position_flat_proven: true },
      { final_position_state_checked: true, final_position_flat_proven: false },
      { final_position_state_checked: false, final_position_flat_proven: false },
    ]);
  });
});

describe("Hyperliquid collateral readiness", () => {
  it("uses spot USDC for unified accounts when the legacy perp state is empty", () => {
    assert.equal(hyperliquidCollateralValue({
      accountAbstraction: "unifiedAccount",
      state: { marginSummary: { accountValue: "0.0" } },
      spotState: {
        balances: [{ coin: "USDC", token: 0, total: "998.978383", hold: "0.0" }],
        tokenToAvailableAfterMaintenance: [[0, "998.978383"]],
      },
    }), 998.978383);
  });

  it("continues to use the perp account value for standard accounts", () => {
    assert.equal(hyperliquidCollateralValue({
      accountAbstraction: "disabled",
      state: { marginSummary: { accountValue: "25.0" } },
      spotState: { balances: [{ coin: "USDC", token: 0, total: "1000.0", hold: "0.0" }] },
    }), 25);
  });

  it("subtracts held spot USDC when maintenance availability is absent", () => {
    assert.equal(hyperliquidCollateralValue({
      accountAbstraction: "portfolioMargin",
      state: { marginSummary: { accountValue: "0.0" } },
      spotState: { balances: [{ coin: "USDC", token: 0, total: "10.0", hold: "3.5" }] },
    }), 6.5);
  });

  it("retries abstraction reads instead of misclassifying a funded unified account", async () => {
    const previousRetryMs = process.env.PRIVATE_AGENT_HYPERLIQUID_INFO_RETRY_MS;
    process.env.PRIVATE_AGENT_HYPERLIQUID_INFO_RETRY_MS = "0";
    let abstractionAttempts = 0;
    const fetchImpl = async (_url, init) => {
      const { type } = JSON.parse(init.body);
      if (type === "userAbstraction") {
        abstractionAttempts += 1;
        if (abstractionAttempts === 1) return new Response("rate limited", { status: 429 });
        return Response.json("unifiedAccount");
      }
      if (type === "spotClearinghouseState") {
        return Response.json({
          balances: [{ coin: "USDC", token: 0, total: "11.50857836", hold: "0.0" }],
          tokenToAvailableAfterMaintenance: [[0, "11.50857836"]],
        });
      }
      if (type === "clearinghouseState") {
        return Response.json({ marginSummary: { accountValue: "0.0" }, assetPositions: [] });
      }
      return Response.json([]);
    };

    try {
      const snapshot = await readHyperliquidAccountSnapshot({
        credential: {
          network: "testnet",
          base_url: "https://api.hyperliquid-testnet.xyz",
          account_address: "0x1111111111111111111111111111111111111111",
          api_wallet_private_key: "0x" + "22".repeat(32),
        },
        fetchImpl,
      });
      assert.equal(abstractionAttempts, 2);
      assert.equal(snapshot.status, "ready_to_trade");
      assert.equal(snapshot.equity_bucket, "ready");
    } finally {
      if (previousRetryMs == null) delete process.env.PRIVATE_AGENT_HYPERLIQUID_INFO_RETRY_MS;
      else process.env.PRIVATE_AGENT_HYPERLIQUID_INFO_RETRY_MS = previousRetryMs;
    }
  });

  it("refreshes clearinghouse positions after a websocket fill", async () => {
    let clearinghouseReads = 0;
    const fetchImpl = async (_url, init) => {
      const { type } = JSON.parse(init.body);
      if (type === "userAbstraction") return Response.json("unifiedAccount");
      if (type === "spotClearinghouseState") {
        return Response.json({
          balances: [{ coin: "USDC", token: 0, total: "11.5", hold: "0" }],
          tokenToAvailableAfterMaintenance: [[0, "11.5"]],
        });
      }
      if (type === "clearinghouseState") {
        clearinghouseReads += 1;
        return Response.json({
          marginSummary: { accountValue: "0" },
          assetPositions: clearinghouseReads > 1
            ? [{ position: { coin: "SOL", szi: "0.14", entryPx: "73.4", unrealizedPnl: "0.01" } }]
            : [],
        });
      }
      return Response.json([]);
    };
    class FakeWebSocket {
      static instance;
      constructor() { FakeWebSocket.instance = this; }
      send() {}
      close() { this.onclose?.(); }
      open() { this.onopen?.(); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const states = [];
    const stop = await createHyperliquidAccountStateStream({
      credential: {
        network: "testnet",
        base_url: "https://api.hyperliquid-testnet.xyz",
        account_address: "0x1111111111111111111111111111111111111111",
        api_wallet_private_key: "0x" + "22".repeat(32),
      },
      fetchImpl,
      webSocketCtor: FakeWebSocket,
      onEvent(event) {
        if (event.event === "account_state") states.push(event.data);
      },
    });
    FakeWebSocket.instance.open();
    FakeWebSocket.instance.message({ channel: "userEvents", data: { fills: [{ coin: "SOL", side: "B", px: "73.4", sz: "0.14", time: Date.now(), fee: "0.005" }] } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    assert.ok(clearinghouseReads >= 2);
    assert.equal(states.at(-1)?.position_count, 1);
    assert.equal(states.at(-1)?.positions?.[0]?.market, "SOL");
  });
});
