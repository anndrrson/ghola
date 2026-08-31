import test from "node:test";
import assert from "node:assert/strict";
import { readHyperliquidCarryAccountMetrics, readHyperliquidFundingSettlements } from "../src/venues/hyperliquid.js";

test("loads exact Hyperliquid margin and account fee inputs for Carry", async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    seen.push(request.type);
    const payload = request.type === "userFees"
      ? { userAddRate: "0.000105", userCrossRate: "0.000315" }
      : {
          marginSummary: { accountValue: "125.50", totalMarginUsed: "20.25" },
          crossMaintenanceMarginUsed: "9.75",
          withdrawable: "105.25",
          assetPositions: [{ position: { szi: "0.5", positionValue: "50000", liquidationPx: "80000" } }],
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const metrics = await readHyperliquidCarryAccountMetrics({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    fetchImpl,
  });
  assert.deepEqual(seen.sort(), ["clearinghouseState", "userFees"]);
  assert.deepEqual(metrics, {
    can_trade: true,
    available_balance: 105.25,
    margin_balance: 125.5,
    initial_margin: 20.25,
    maintenance_margin: 9.75,
    maker_fee_bps: 1.05,
    taker_fee_bps: 3.15,
    fee_source: "hyperliquid_user_fees",
    fees_exact_for_account: true,
    fees_conservative_upper_bound: false,
    position_count: 1,
    liquidation_distance_bps: 2_000,
    liquidation_distance_verified: true,
    liquidation_distance_source: "hyperliquid_clearinghouse_state_asset_positions_v1",
  });
});

test("reads exact Hyperliquid user funding settlements for the Carry asset", async () => {
  let request;
  const rows = await readHyperliquidFundingSettlements({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    asset: "BTC",
    start_time_ms: 1_800_000_000_000,
    end_time_ms: 1_800_003_600_000,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify([
        { time: 1_800_003_600_000, hash: "0xabc", delta: { coin: "BTC", usdc: "0.021" } },
        { time: 1_800_003_600_000, hash: "0xdef", delta: { coin: "ETH", usdc: "0.5" } },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(request, { type: "userFunding", user: "0x1111111111111111111111111111111111111111", startTime: 1_800_000_000_000, endTime: 1_800_003_600_000 });
  assert.deepEqual(rows, [{ venue_id: "hyperliquid", asset: "BTC", occurred_at_ms: 1_800_003_600_000, amount_quote: "0.021", quote_asset: "USDC", settlement_id: "0xabc" }]);
});

test("rejects a malformed Hyperliquid funding history response", async () => {
  await assert.rejects(readHyperliquidFundingSettlements({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    asset: "BTC",
    start_time_ms: 1_800_000_000_000,
    end_time_ms: 1_800_003_600_000,
    fetchImpl: async () => new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } }),
  }), (error) => error.code === "connector_submit_failed");
});
