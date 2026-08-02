import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  hyperliquidCollateralValue,
  hyperliquidRunnerTimeoutMs,
  readHyperliquidAccountSnapshot,
} from "../src/venues/hyperliquid.js";

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
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"filled": {"oid": 7}}]}}}),
    runner.redact_result("submitted", {"response": {"data": {"statuses": [{"error": "Order must have minimum value of $10."}]}}}),
    runner.redact_result("submitted", {}),
]))
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const [filled, rejected, unknown] = JSON.parse(result.stdout.trim());
    assert.deepEqual(filled, { status: "submitted", oid: 7 });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.error_code, "order_below_venue_minimum");
    assert.equal(unknown.status, "outcome_unknown");
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
});
