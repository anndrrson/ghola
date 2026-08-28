import assert from "node:assert/strict";
import test from "node:test";
import { CORE_PERP_VENUES } from "@ghola/execution-core";
import {
  carryShadowQualificationKey,
  observeCarryShadowQualification,
  readCarryShadowQualification,
  verifyCarryShadowQualification,
} from "../src/execution/carry-shadow-qualification.js";
import { carryShadowFixture } from "./carry-shadow-fixture.js";
import { DEFAULT_CARRY_SHADOW_ASSETS } from "../src/execution/perp-shadow-readiness.js";

const NOW = 1_800_000_000_000;
const IMAGE = "sha256:abcdef1234567890";
const ENV = Object.freeze({
  PHALA_CVM_IMAGE_DIGEST: IMAGE,
  PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES: "3",
  PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS: "600000",
});

test("persists three consecutive complete five-venue samples without broadcasting", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW + index * 60_000;
    result = await observeCarryShadowQualification({
      state,
      venues: carryShadowFixture(nowMs),
      now_ms: nowMs,
      env: ENV,
    });
  }
  assert.equal(result.ready, true);
  assert.equal(result.release_bound, true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.venues, CORE_PERP_VENUES.length);
  assert.equal(result.assets, DEFAULT_CARRY_SHADOW_ASSETS.length);
  assert.equal(
    result.expected_snapshots_per_sample,
    CORE_PERP_VENUES.length * DEFAULT_CARRY_SHADOW_ASSETS.length,
  );
  assert.equal(result.completed_samples, 3);
  assert.equal(result.minimum_span_ms, 120_000);
  assert.equal(result.duration_ms, 120_000);
  assert.equal(new Set(result.sample_commitments).size, 3);
  assert.equal(new Set(result.source_observation_commitments).size, 3);
  assert.match(result.evidence_commitment, /^carry:shadow:qualification:[0-9a-f]{64}$/);
  assert.equal(state.rows.size, 1);

  const recovered = await readCarryShadowQualification({
    state,
    now_ms: NOW + 2 * 60_000,
    env: ENV,
  });
  assert.equal(recovered.ready, true);
  assert.deepEqual(recovered.sample_commitments, result.sample_commitments);
  assert.deepEqual(recovered.source_observation_commitments, result.source_observation_commitments);
  assert.equal(verifyCarryShadowQualification(recovered, {
    image_digest: IMAGE,
    now_ms: NOW + 2 * 60_000,
    max_age_ms: 600_000,
  }).ok, true);
});

test("does not qualify rapid source updates before the two-minute observation floor", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW + index * 1_000;
    result = await observeCarryShadowQualification({
      state,
      venues: carryShadowFixture(nowMs),
      now_ms: nowMs,
      env: ENV,
    });
  }
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("shadow_soak_duration_insufficient:2000:120000"));
});

test("does not persist wrapper-only samples when venue source observations are unchanged", async () => {
  const state = stateStore();
  const venues = carryShadowFixture(NOW);
  let result;
  for (let index = 0; index < 3; index += 1) {
    result = await observeCarryShadowQualification({
      state,
      venues,
      now_ms: NOW + index * 1_000,
      env: ENV,
    });
  }
  assert.equal(result.ready, false);
  assert.equal(result.completed_samples, 1);
  assert.ok(result.failures.includes("shadow_soak_samples_insufficient:1:3"));
});

test("rejects tampered qualification summaries", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW + index * 60_000;
    result = await observeCarryShadowQualification({
      state,
      venues: carryShadowFixture(nowMs),
      now_ms: nowMs,
      env: ENV,
    });
  }
  const tampered = structuredClone(result);
  tampered.duration_ms += 1;
  assert.equal(verifyCarryShadowQualification(tampered, {
    image_digest: IMAGE,
    now_ms: NOW + 2 * 60_000,
    max_age_ms: 600_000,
  }).ok, false);
});

test("resets consecutive qualification after one failed venue sample", async () => {
  const state = stateStore();
  for (let index = 0; index < 2; index += 1) {
    const nowMs = NOW + index * 60_000;
    await observeCarryShadowQualification({ state, venues: carryShadowFixture(nowMs), now_ms: nowMs, env: ENV });
  }
  const failed = carryShadowFixture(NOW + 2 * 60_000);
  failed.find((venue) => venue.venue_id === "lighter").ok = false;
  const result = await observeCarryShadowQualification({
    state,
    venues: failed,
    now_ms: NOW + 2 * 60_000,
    env: ENV,
  });
  assert.equal(result.ready, false);
  assert.equal(result.completed_samples, 0);
  assert.ok(result.failures.some((failure) => failure.startsWith("venue_fetch_failed:lighter")));
});

test("does not qualify complete-looking samples with degraded venue economics", async () => {
  const state = stateStore();
  let result;
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW + index * 60_000;
    const venues = carryShadowFixture(nowMs);
    const snapshot = venues.find((venue) => venue.venue_id === "hyperliquid").snapshots[0];
    snapshot.maker_fee_bps = null;
    snapshot.missing_fields = ["maker_fee_bps"];
    snapshot.quality_flags = ["fees_account_specific"];
    snapshot.status = "degraded";
    result = await observeCarryShadowQualification({ state, venues, now_ms: nowMs, env: ENV });
  }
  assert.equal(result.ready, false);
  assert.equal(result.degraded_snapshots, 3);
  assert.ok(result.failures.some((failure) => failure.startsWith("shadow_soak_snapshot_not_ready:")));
});

test("fails closed for stale, tampered, or differently pinned qualification", async () => {
  const state = stateStore();
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW + index * 60_000;
    await observeCarryShadowQualification({ state, venues: carryShadowFixture(nowMs), now_ms: nowMs, env: ENV });
  }
  const imageMismatch = await readCarryShadowQualification({
    state,
    now_ms: NOW + 2 * 60_000,
    env: { ...ENV, PHALA_CVM_IMAGE_DIGEST: "sha256:1111111111111111" },
  });
  assert.equal(imageMismatch.ready, false);
  assert.ok(imageMismatch.failures.includes("shadow_qualification_image_mismatch"));

  const stale = await readCarryShadowQualification({
    state,
    now_ms: NOW + 20 * 60_000,
    env: ENV,
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.failures.includes("shadow_qualification_stale"));

  const key = carryShadowQualificationKey();
  state.rows.get(key).receipt.updated_at_ms += 1;
  const tampered = await readCarryShadowQualification({ state, now_ms: NOW + 2 * 60_000, env: ENV });
  assert.equal(tampered.ready, false);
  assert.ok(tampered.failures.includes("shadow_qualification_evidence_invalid"));
});

function stateStore() {
  const rows = new Map();
  return {
    rows,
    getIdempotency: async (key) => rows.get(key) || null,
    putIdempotency: async (key, receipt) => {
      rows.set(key, { receipt: structuredClone(receipt) });
      return receipt;
    },
  };
}
