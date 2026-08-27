import assert from "node:assert/strict";
import test from "node:test";
import { createAsterStablecoinConversionQuoteReader } from "../src/execution/carry-stablecoin-conversion.js";

const NOW = 1_800_000_000_000;

test("bounds USDC to USDT conversion from fresh Aster depth without submitting", async () => {
  const readQuote = createAsterStablecoinConversionQuoteReader(dependencies({
    book: {
      symbol: "USDCUSDT",
      T: NOW - 100,
      bids: [["0.9998", "100"], ["0.9990", "100"]],
      asks: [["1.0002", "100"]],
    },
  }));
  const quote = await readQuote(request());
  assert.equal(quote.source_asset, "USDC");
  assert.equal(quote.destination_asset, "USDT");
  assert.equal(quote.maximum_transfer_micro_usdc, 50_000_000);
  assert.equal(quote.rate_floor_e8, 99_980_000);
  assert.equal(quote.fee_upper_bound_micro_usdc, 75_000);
  assert.equal(quote.slippage_upper_bound_micro_usdc, 10_000);
  assert.equal(quote.fund_movement_authorized, false);
  assert.equal(quote.transaction_broadcast, false);
});

test("prices the reverse USDT to USDC direction from asks", async () => {
  const readQuote = createAsterStablecoinConversionQuoteReader(dependencies({
    book: {
      symbol: "USDCUSDT",
      T: NOW,
      bids: [["0.9998", "100"]],
      asks: [["1.000200001", "100"], ["1.0010", "100"]],
    },
  }));
  const quote = await readQuote(request({
    source_collateral_asset: "USDT",
    destination_collateral_asset: "USDC",
  }));
  assert.equal(quote.rate_floor_e8, 99_980_002);
  assert.equal(quote.maximum_transfer_micro_usdc, 50_000_000);
  assert.equal(quote.slippage_upper_bound_micro_usdc, 9_999);
});

test("fails closed for stale books, stale policy, and unsupported pairs", async () => {
  const staleBook = createAsterStablecoinConversionQuoteReader(dependencies({
    book: {
      symbol: "USDCUSDT",
      T: NOW - 5_001,
      bids: [["0.9998", "100"]],
      asks: [["1.0002", "100"]],
    },
  }));
  await assert.rejects(() => staleBook(request()), /carry_conversion_book_stale/);

  const stalePolicy = dependencies();
  stalePolicy.policy.expires_at_ms = NOW;
  await assert.rejects(
    () => createAsterStablecoinConversionQuoteReader(stalePolicy)(request()),
    /carry_conversion_policy_stale/,
  );

  const reader = createAsterStablecoinConversionQuoteReader(dependencies());
  await assert.rejects(() => reader(request({
    source_collateral_asset: "DAI",
    destination_collateral_asset: "USDT",
  })), /carry_conversion_pair_unsupported/);
});

function dependencies({ book } = {}) {
  return {
    now: () => NOW,
    policy: {
      version: 1,
      venue_id: "aster",
      market: "USDCUSDT",
      verified: true,
      read_only: true,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      observed_at_ms: NOW - 1_000,
      expires_at_ms: NOW + 60_000,
      minimum_transfer_micro_usdc: 1_000_000,
      maximum_transfer_micro_usdc: 50_000_000,
      fee_ceiling_bps: 15,
      max_slippage_bps: 5,
      latency_ceiling_ms: 30_000,
    },
    fetchImpl: async (url, options) => {
      assert.match(url, /USDCUSDT/);
      assert.equal(options.method, "GET");
      return {
        ok: true,
        json: async () => book || {
          symbol: "USDCUSDT",
          T: NOW,
          bids: [["0.9998", "100"]],
          asks: [["1.0002", "100"]],
        },
      };
    },
  };
}

function request(overrides = {}) {
  return {
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDT",
    checked_at_ms: NOW,
    ...overrides,
  };
}
