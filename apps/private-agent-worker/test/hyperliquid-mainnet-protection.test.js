import assert from "node:assert/strict";
import test from "node:test";
import { buildHyperliquidMainnetProtection } from "../src/execution/hyperliquid-mainnet-protection.js";

const NOW = 1_786_800_000_000;

test("builds fresh venue-valid HYPE mark-trigger protection", async () => {
  const result = await buildHyperliquidMainnetProtection({
    fetchImpl: protectionFetch({ time: NOW - 350 }),
    now: NOW,
  });
  assert.deepEqual(result.position_protection, {
    mode: "normal_tpsl",
    trigger_source: "mark",
    take_profit_trigger_price: "58.103",
    stop_loss_trigger_price: "55.836",
    entry_reference_price: "56.405",
    max_slippage_bps: "100",
  });
  assert.equal(result.reference.source_age_ms, 350);
  assert.equal(result.reference.modeled_max_loss_bps_before_gap_risk, 200);
});

test("fails closed on stale, crossed, or incomplete protection inputs", async () => {
  await assert.rejects(() => buildHyperliquidMainnetProtection({
    fetchImpl: protectionFetch({ time: NOW - 2_001 }),
    now: NOW,
  }), /fresh executable protection inputs are unavailable/);
  await assert.rejects(() => buildHyperliquidMainnetProtection({
    fetchImpl: protectionFetch({ time: NOW, bid: "56.42", ask: "56.41" }),
    now: NOW,
  }), /fresh executable protection inputs are unavailable/);
  await assert.rejects(() => buildHyperliquidMainnetProtection({
    fetchImpl: protectionFetch({ time: NOW, includeMarket: false }),
    now: NOW,
  }), /fresh executable protection inputs are unavailable/);
});

function protectionFetch({ time, bid = "56.4", ask = "56.41", includeMarket = true }) {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.type === "l2Book") {
      return Response.json({
        time,
        levels: [[{ px: bid, sz: "1" }], [{ px: ask, sz: "1" }]],
      });
    }
    return Response.json({ universe: includeMarket ? [{ name: "HYPE", szDecimals: 2 }] : [] });
  };
}
