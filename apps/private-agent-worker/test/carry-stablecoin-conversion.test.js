import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalCarryCommitmentJson, cashflowValuationEvidenceMessage } from "@ghola/execution-core";
import {
  createAsterCashflowValuationReader,
  createCoinbaseUsdtCashflowValuationReader,
  createCoinbaseUsdCashflowValuationReader,
  createAsterStablecoinConversionQuoteReader,
  verifyCashflowValuationEvidence,
} from "../src/execution/carry-stablecoin-conversion.js";

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

test("binds conservative USDT cashflow valuation to fresh Aster bid and ask evidence", async () => {
  const readValuation = createAsterCashflowValuationReader(dependencies({
    book: {
      symbol: "USDCUSDT",
      T: NOW,
      bids: [["0.9998", "100"]],
      asks: [["1.000200001", "100"]],
    },
  }));
  const valuation = await readValuation({
    source_asset: "USDT",
    source_amount_micro: 1_000_000,
    source_amount_decimal: "1.0000009",
    source_amount_scale: 7,
    checked_at_ms: NOW,
  });
  assert.equal(valuation.bound_source_amount_micro, 1_000_000);
  assert.equal(valuation.bound_value_micro_usdc, 999_800);
  assert.equal(valuation.credit_rate_e8, 99_980_000);
  assert.equal(valuation.debit_rate_e8, 100_020_100);
  assert.equal(valuation.observed_at_ms, NOW);
  assert.equal(valuation.expires_at_ms, NOW + 30_000);
  assert.equal(valuation.evidence_source, "aster:USDCUSDT:book:v1");
  assert.equal(valuation.evidence_payload.source_amount_decimal, "1.0000009");
  assert.equal(valuation.evidence_payload.asks[0].price_e8, 100_020_001);
  assert.match(valuation.evidence_commitment, /^carry:cashflow-valuation:evidence:[0-9a-f]{64}$/);
});

test("Aster cashflow valuation fails closed for stale or unbound book evidence", async () => {
  const stale = createAsterCashflowValuationReader(dependencies({
    book: {
      symbol: "USDCUSDT",
      T: NOW - 5_001,
      bids: [["0.9998", "100"]],
      asks: [["1.0002", "100"]],
    },
  }));
  await assert.rejects(
    () => stale({ source_asset: "USDT", checked_at_ms: NOW }),
    /cashflow_valuation_book_stale/,
  );
  const reader = createAsterCashflowValuationReader(dependencies());
  await assert.rejects(
    () => reader({ source_asset: "USD", checked_at_ms: NOW }),
    /cashflow_valuation_pair_unsupported/,
  );
});

test("values bound USDT cashflows from fresh liquid Coinbase depth", async () => {
  const readValuation = createCoinbaseUsdtCashflowValuationReader(coinbaseDependencies());
  const valuation = await readValuation({
    source_asset: "USDT",
    source_amount_micro: -1_000_000,
    source_amount_decimal: "-1.0000009",
    source_amount_scale: 7,
    checked_at_ms: NOW,
  });
  assert.equal(valuation.bound_source_amount_micro, -1_000_000);
  assert.equal(valuation.bound_value_micro_usdc, -1_000_200);
  assert.equal(valuation.credit_rate_e8, 99_980_000);
  assert.equal(valuation.debit_rate_e8, 100_020_000);
  assert.equal(valuation.evidence_source, "coinbase-exchange:USDT-USDC:book:v1");
  assert.equal(valuation.evidence_payload.source_amount_decimal, "-1.0000009");
  assert.deepEqual(valuation.evidence_payload.markets, ["USDT-USDC"]);
});

test("values bound USD cashflows through two fresh Coinbase books", async () => {
  const readValuation = createCoinbaseUsdCashflowValuationReader(coinbaseDependencies());
  const valuation = await readValuation({
    source_asset: "USD",
    source_amount_micro: 1_000_000,
    source_amount_decimal: "1.000000",
    source_amount_scale: 6,
    checked_at_ms: NOW,
  });
  assert.equal(valuation.credit_rate_e8, 99_989_900);
  assert.equal(valuation.debit_rate_e8, 100_050_200);
  assert.equal(valuation.evidence_source, "coinbase-exchange:USDT-USD:USDT-USDC:cross-book:v1");
  assert.deepEqual(valuation.evidence_payload.markets, ["USDT-USDC", "USDT-USD"]);
  assert.equal(valuation.evidence_payload.books.length, 2);
});

test("Coinbase cashflow valuation fails closed for stale or insufficient depth", async () => {
  const stale = createCoinbaseUsdtCashflowValuationReader(coinbaseDependencies({ observedAtMs: NOW - 5_001 }));
  await assert.rejects(
    () => stale({ source_asset: "USDT", checked_at_ms: NOW }),
    /cashflow_valuation_book_stale/,
  );
  const insufficient = createCoinbaseUsdtCashflowValuationReader(coinbaseDependencies({
    usdtUsdc: { bids: [["0.9998", "0.1", 1]], asks: [["1.0002", "0.1", 1]] },
  }));
  await assert.rejects(() => insufficient({
    source_asset: "USDT",
    source_amount_micro: 1_000_000,
    source_amount_decimal: "1",
    source_amount_scale: 0,
    checked_at_ms: NOW,
  }), /cashflow_valuation_depth_insufficient/);
});

test("replays committed depth and rejects self-consistent fabricated rates", async () => {
  const valuation = await createCoinbaseUsdtCashflowValuationReader(coinbaseDependencies())({
    source_asset: "USDT",
    source_amount_micro: -1_000_000,
    source_amount_decimal: "-1.0000009",
    source_amount_scale: 7,
    checked_at_ms: NOW,
  });
  assert.equal(verifyCashflowValuationEvidence(valuation).debit_rate_e8, 100_020_000);

  const fabricated = { ...valuation, debit_rate_e8: 100_030_000 };
  fabricated.evidence_message = cashflowValuationEvidenceMessage(fabricated);
  fabricated.evidence_commitment = `carry:cashflow-valuation:evidence:${createHash("sha256")
    .update(canonicalCarryCommitmentJson({
      evidence_message: fabricated.evidence_message,
      evidence_payload: fabricated.evidence_payload,
    }))
    .digest("hex")}`;
  assert.throws(
    () => verifyCashflowValuationEvidence(fabricated),
    /cashflow_valuation_evidence_rate_mismatch/,
  );
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

function coinbaseDependencies({ observedAtMs = NOW, usdtUsdc, usdtUsd } = {}) {
  return {
    now: () => NOW,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      const market = String(url).includes("USDT-USDC") ? "USDT-USDC" : "USDT-USD";
      const book = market === "USDT-USDC"
        ? usdtUsdc || { bids: [["0.9998", "100", 1]], asks: [["1.0002", "100", 1]] }
        : usdtUsd || { bids: [["0.9997", "100", 1]], asks: [["0.9999", "100", 1]] };
      return {
        ok: true,
        headers: { get: (name) => String(name).toLowerCase() === "date"
          ? new Date(observedAtMs).toUTCString()
          : null },
        json: async () => ({ sequence: market === "USDT-USDC" ? 1 : 2, ...book }),
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
