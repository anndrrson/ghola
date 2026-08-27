import assert from "node:assert/strict";
import test from "node:test";
import { observeCarryFundingPersistence } from "../src/execution/carry-funding-persistence.js";

const NOW = 1_800_000_000_000;
const FIVE_MINUTES = 5 * 60_000;

function stateStore(initial = new Map()) {
  return {
    rows: initial,
    getIdempotency: async (key) => initial.get(key) || null,
    putIdempotency: async (key, receipt) => {
      initial.set(key, { receipt });
      return receipt;
    },
  };
}

function evidence({ longRate = 0, shortRate = 100_000_000 } = {}) {
  const leg = (venueId, side, rate) => ({
    venue_id: venueId,
    side,
    snapshot: {
      economic_equivalence_id: "carry:BTC-usd-linear",
      asset: "BTC",
      funding_rate_e12_per_interval: rate,
      funding_interval_ms: 3_600_000,
    },
  });
  return [leg("hyperliquid", "buy", longRate), leg("lighter", "sell", shortRate)];
}

test("requires durable storage for opening funding evidence", async () => {
  const result = await observeCarryFundingPersistence({ state: {}, evidence: evidence(), now_ms: NOW });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["funding_persistence_state_unavailable"]);
});

test("rejects corrupt stored observation evidence", async () => {
  const state = {
    getIdempotency: async () => ({ receipt: { version: 1, kind: "carry_funding_persistence" } }),
    putIdempotency: async (_key, receipt) => receipt,
  };
  const result = await observeCarryFundingPersistence({ state, evidence: evidence(), now_ms: NOW });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("funding_persistence_evidence_invalid"));
});

test("qualifies only after distinct observations meet the sample and time-span floors", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 8; index += 1) {
    result = await observeCarryFundingPersistence({
      state,
      evidence: evidence(),
      now_ms: NOW + index * FIVE_MINUTES,
    });
  }
  assert.equal(result.ready, true);
  assert.equal(result.sample_count, 8);
  assert.equal(result.observed_span_ms, 35 * 60_000);
  assert.equal(result.conservative_hourly_spread_e12, 100_000_000);
  assert.match(result.evidence_commitment, /^carry:funding:[a-f0-9]{64}$/);
});

test("does not manufacture persistence from rapid duplicate checks", async () => {
  const state = stateStore();
  await observeCarryFundingPersistence({ state, evidence: evidence(), now_ms: NOW });
  const duplicate = await observeCarryFundingPersistence({ state, evidence: evidence(), now_ms: NOW + 10_000 });
  assert.equal(duplicate.ready, false);
  assert.equal(duplicate.sample_count, 1);
  assert.ok(duplicate.reasons.includes("funding_history_insufficient"));
});

test("clips a current funding spike to adverse historical quartiles", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 7; index += 1) {
    result = await observeCarryFundingPersistence({
      state,
      evidence: evidence({ shortRate: 100_000_000 }),
      now_ms: NOW + index * FIVE_MINUTES,
    });
  }
  result = await observeCarryFundingPersistence({
    state,
    evidence: evidence({ shortRate: 1_000_000_000 }),
    now_ms: NOW + 7 * FIVE_MINUTES,
  });
  assert.equal(result.ready, true);
  assert.equal(result.conservative_funding_rate_e12_by_venue.lighter, 100_000_000);
  assert.equal(result.conservative_hourly_spread_e12, 100_000_000);
});

test("rejects carry whose historical funding advantage is not persistent", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 8; index += 1) {
    result = await observeCarryFundingPersistence({
      state,
      evidence: evidence({ shortRate: index < 6 ? -100_000_000 : 1_000_000_000 }),
      now_ms: NOW + index * FIVE_MINUTES,
    });
  }
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("funding_not_persistent"));
  assert.equal(result.conservative_funding_rate_e12_by_venue.lighter, -100_000_000);
});
