import assert from "node:assert/strict";
import test from "node:test";
import {
  carryShadowQualificationKey,
  observeCarryShadowQualification,
  readCarryShadowQualification,
} from "../src/execution/carry-shadow-qualification.js";
import { carryShadowFixture } from "./carry-shadow-fixture.js";

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
  assert.equal(result.venues, 5);
  assert.equal(result.assets, 3);
  assert.equal(result.completed_samples, 3);
  assert.equal(new Set(result.sample_commitments).size, 3);
  assert.match(result.evidence_commitment, /^carry:shadow:qualification:[0-9a-f]{64}$/);
  assert.equal(state.rows.size, 1);

  const recovered = await readCarryShadowQualification({
    state,
    now_ms: NOW + 2 * 60_000,
    env: ENV,
  });
  assert.equal(recovered.ready, true);
  assert.deepEqual(recovered.sample_commitments, result.sample_commitments);
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
