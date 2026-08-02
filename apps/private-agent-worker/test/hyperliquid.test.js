import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
