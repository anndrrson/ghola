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

test("paginates more than 500 Hyperliquid funding blocks with inclusive-boundary dedupe", async () => {
  const start = 1_800_000_000_000;
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    time: start + (index % 500),
    hash: `0xfunding${index}`,
    delta: { coin: "BTC", usdc: index % 2 === 0 ? "0.001" : "-0.001" },
  }));
  const requests = [];
  const rows = await readHyperliquidFundingSettlements({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    asset: "BTC",
    start_time_ms: start,
    end_time_ms: start + 1_000,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const body = requests.length === 1
        ? firstPage
        : [firstPage.at(-1), {
            time: start + 500,
            hash: "0xfunding-next",
            delta: { coin: "BTC", usdc: "0.002" },
          }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].startTime, start + 499);
  assert.equal(rows.length, 1_001);
  assert.equal(rows[0].settlement_id, "0xfunding0");
  assert.equal(rows.at(-1).settlement_id, "0xfunding-next");
});

test("fails closed when Hyperliquid funding pagination does not advance", async () => {
  const start = 1_800_000_000_000;
  const fullPage = Array.from({ length: 500 }, (_, index) => ({
    time: start + index,
    hash: `0xstuck${index}`,
    delta: { coin: "BTC", usdc: "0.001" },
  }));
  await assert.rejects(readHyperliquidFundingSettlements({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    asset: "BTC",
    start_time_ms: start,
    end_time_ms: start + 1_000,
    fetchImpl: async () => new Response(JSON.stringify(fullPage), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  }), (error) => error.code === "connector_submit_failed"
    && error.message === "hyperliquid funding history pagination did not advance");
});

test("does not mistake a full cross-coin shared-timestamp page for complete funding", async () => {
  const start = 1_800_000_000_000;
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    time: start + (index % 10),
    hash: `0xother${index}`,
    delta: { coin: index % 2 === 0 ? "ETH" : "SOL", usdc: "0.001" },
  }));
  const requests = [];
  const rows = await readHyperliquidFundingSettlements({
    credential: {
      network: "testnet",
      base_url: "https://api.hyperliquid-testnet.xyz",
      account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    },
    asset: "BTC",
    start_time_ms: start,
    end_time_ms: start + 100,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const body = requests.length === 1
        ? firstPage
        : [{ time: start + 10, hash: "0xtarget-debit", delta: { coin: "BTC", usdc: "-0.5" } }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].startTime, start + 9);
  assert.deepEqual(rows, [{
    venue_id: "hyperliquid",
    asset: "BTC",
    occurred_at_ms: start + 10,
    amount_quote: "-0.5",
    quote_asset: "USDC",
    settlement_id: "0xtarget-debit",
  }]);
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

test("rejects a malformed in-window Hyperliquid target settlement instead of omitting a debit", async () => {
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
    fetchImpl: async () => new Response(JSON.stringify([
      { time: 1_800_003_600_000, hash: "0xcredit", delta: { coin: "BTC", usdc: "0.021" } },
      { time: 1_800_003_600_000, hash: "0xdebit", delta: { coin: "BTC", usdc: "not-a-number" } },
    ]), { status: 200, headers: { "content-type": "application/json" } }),
  }), (error) => error.code === "connector_submit_failed"
    && error.message === "hyperliquid funding history row is invalid");
});
