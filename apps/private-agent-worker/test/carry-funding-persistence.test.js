import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  observeCarryFundingPersistence,
  observeCarryFundingUniverse,
  runCarryFundingObservationTick,
  startCarryFundingObservationLoop,
} from "../src/execution/carry-funding-persistence.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;
const FIVE_MINUTES = 5 * 60_000;

function stateStore(initial = new Map()) {
  const state = {
    rows: initial,
    writes: 0,
    getIdempotency: async (key) => initial.get(key) || null,
    putIdempotency: async (key, receipt) => {
      state.writes += 1;
      initial.set(key, { receipt });
      return receipt;
    },
  };
  return state;
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

function shadowSnapshot(venueId, overrides = {}) {
  const venueRates = { hyperliquid: 10_000, lighter: 30_000, aster: -20_000 };
  return {
    version: 1,
    venue_id: venueId,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    contract_type: "linear_perp",
    quote_asset: "USDC",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    funding_rate_e12_per_interval: venueRates[venueId] ?? 10_000,
    funding_interval_ms: 3_600_000,
    as_of_ms: NOW,
    source_observed_at_ms: { funding: NOW },
    source_max_age_ms: { funding: 60_000 },
    stale_sources: [],
    status: "ready",
    stale: false,
    ...overrides,
  };
}

test("supervises five-venue observation failures and stalls", async (t) => {
  const state = stateStore();
  let nowMs = NOW;
  let fail = true;
  const loop = startCarryFundingObservationLoop({
    state,
    now: () => nowMs,
    fetchPerpShadowSet: async () => {
      if (fail) throw new Error("provider secret");
      return ["hyperliquid", "lighter", "aster", "edgex", "dydx"].map((venueId) => ({
        venue_id: venueId,
        ok: true,
        snapshots: [shadowSnapshot(venueId, {
          as_of_ms: nowMs,
          source_observed_at_ms: { funding: nowMs },
        })],
      }));
    },
    env: {
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED: "true",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS: "60000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS: "15000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_STALL_MS: "30000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS: "BTC",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES: "1",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS: "0",
    },
  });
  t.after(() => loop.stop());

  assert.equal((await loop.runNow()).error, "carry_shadow_observer_threw");
  assert.equal(loop.health().status, "failed");
  assert.doesNotMatch(JSON.stringify(loop.health()), /provider secret/);
  fail = false;
  assert.equal((await loop.runNow()).ok, true);
  assert.equal(loop.health().status, "healthy");
  nowMs += 30_001;
  assert.equal(loop.health().status, "stalled");
  assert.equal(loop.health().last_error_code, "carry_shadow_observer_stalled");
});

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
  assert.equal(state.writes, 1);
  assert.ok(duplicate.reasons.includes("funding_history_insufficient"));
});

test("resumes durable funding history after a worker restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES: "3",
    PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS: "60000",
  };
  let state = createWorkerState(dir);
  await observeCarryFundingPersistence({ state, evidence: evidence(), now_ms: NOW, env });
  const beforeRestart = await observeCarryFundingPersistence({
    state,
    evidence: evidence(),
    now_ms: NOW + 30_000,
    env,
  });
  assert.equal(beforeRestart.sample_count, 2);
  assert.equal(beforeRestart.ready, false);

  state = createWorkerState(dir);
  const afterRestart = await observeCarryFundingPersistence({
    state,
    evidence: evidence(),
    now_ms: NOW + 60_000,
    env,
  });
  assert.equal(afterRestart.ready, true);
  assert.equal(afterRestart.sample_count, 3);
  assert.equal(afterRestart.observed_span_ms, 60_000);
  assert.match(afterRestart.evidence_commitment, /^carry:funding:[a-f0-9]{64}$/);
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

test("collects every trusted executable route during the normal shadow cycle", async () => {
  const state = stateStore();
  const venues = ["hyperliquid", "lighter", "aster", "edgex"].map((venueId) => ({
    venue_id: venueId,
    ok: true,
    snapshots: [shadowSnapshot(venueId)],
  }));
  const result = await observeCarryFundingUniverse({
    state,
    venues,
    assets: ["BTC"],
    now_ms: NOW,
    env: {
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES: "1",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS: "0",
    },
  });

  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.observed_route_count, 6);
  assert.equal(result.ready_route_count, 3);
  assert.equal(result.routes.filter((route) => route.ready).every((route) =>
    Number.isSafeInteger(route.conservative_funding_rate_e12_by_venue[route.long_venue_id])
    && Number.isSafeInteger(route.conservative_funding_rate_e12_by_venue[route.short_venue_id])
  ), true);
  assert.equal(state.rows.size, 6);
  assert.equal(result.routes.some((route) => route.long_venue_id === "edgex"), false);
});

test("ignores stale funding during automatic shadow observation", async () => {
  const state = stateStore();
  const result = await observeCarryFundingUniverse({
    state,
    venues: [
      { venue_id: "hyperliquid", ok: true, snapshots: [shadowSnapshot("hyperliquid")] },
      { venue_id: "lighter", ok: true, snapshots: [shadowSnapshot("lighter", { stale_sources: ["funding"] })] },
      { venue_id: "aster", ok: true, snapshots: [shadowSnapshot("aster")] },
    ],
    assets: ["BTC"],
    now_ms: NOW,
  });
  assert.equal(result.observed_route_count, 2);
  assert.equal(result.routes.every((route) => ![route.long_venue_id, route.short_venue_id].includes("lighter")), true);
});

test("collects funding history without an open browser", async () => {
  const state = stateStore();
  let request;
  const result = await runCarryFundingObservationTick({
    state,
    fetchPerpShadowSet: async (options) => {
      request = options;
      return ["hyperliquid", "lighter", "aster", "edgex", "dydx"].map((venueId) => ({
        venue_id: venueId,
        ok: true,
        snapshots: [shadowSnapshot(venueId)],
      }));
    },
    assets: ["btc", "BTC"],
    now_ms: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.current_feed_set_complete, true);
  assert.equal(result.error, null);
  assert.equal(result.transaction_broadcast, false);
  assert.deepEqual(result.assets, ["BTC"]);
  assert.deepEqual(request.assets, ["BTC"]);
  assert.equal(result.funding_persistence.observed_route_count, 6);
  assert.equal(result.shadow_qualification.transaction_broadcast, false);
  assert.equal(result.routing_advantage.transaction_broadcast, false);
  assert.equal(result.routing_advantage.realized, false);
  assert.equal(result.routing_advantage.execution_ready, false);
  assert.equal(result.shadow_snapshot.stored, true);
  assert.equal(result.shadow_snapshot.ready, false);
  assert.equal(state.rows.size, 8);
});

test("degrades observer health when any core venue feed is missing", async (t) => {
  const state = stateStore();
  const loop = startCarryFundingObservationLoop({
    state,
    now: () => NOW,
    fetchPerpShadowSet: async () => ["hyperliquid", "lighter", "aster", "edgex"].map((venueId) => ({
      venue_id: venueId,
      ok: true,
      snapshots: [shadowSnapshot(venueId)],
    })),
    env: {
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED: "true",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS: "60000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS: "15000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_STALL_MS: "30000",
      PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS: "BTC",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES: "1",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS: "0",
    },
  });
  t.after(() => loop.stop());

  const result = await loop.runNow();
  assert.equal(result.ok, false);
  assert.equal(result.current_feed_set_complete, false);
  assert.equal(result.error, "carry_shadow_feed_set_incomplete");
  assert.equal(result.funding_persistence.observed_route_count, 6);
  assert.equal(loop.health().status, "degraded");
  assert.equal(loop.health().last_error_code, "carry_shadow_feed_set_incomplete");
});
