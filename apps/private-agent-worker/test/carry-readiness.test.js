import assert from "node:assert/strict";
import test from "node:test";
import { CARRY_EXECUTION_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import {
  assessCarryExecutionReadiness,
  readCarryExecutionReadiness,
  storeCarryExecutionReadiness,
} from "../src/execution/carry-readiness.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner_commitment_readiness_0001";
const ENV = { PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456" };

function access(venueId) {
  return {
    account_commitment: `account_commitment_${venueId}`,
    vault_commitment: `vault_commitment_${venueId}`,
    policy_commitment: `policy_commitment_${venueId}`,
  };
}

function request() {
  return {
    owner_commitment: OWNER,
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_readiness_0001",
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    venue_access: Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [venueId, access(venueId)])),
  };
}

function matrix() {
  return {
    transaction_broadcast: false,
    venues: CARRY_EXECUTION_VENUES.map((venueId) => ({
      venue_id: venueId,
      transaction_broadcast: false,
      verification_commitment: `verification_commitment_${venueId}`,
      checks: {
        transaction_broadcast: false,
        account_state_checked: true,
        order_request_checked: true,
      },
    })),
    pairs: CARRY_EXECUTION_VENUES.slice(1).map((venueId) => ({
      long_venue_id: CARRY_EXECUTION_VENUES[0],
      short_venue_id: venueId,
      no_submit_ready: true,
      transaction_broadcast: false,
    })),
  };
}

function memoryState() {
  const rows = new Map();
  return {
    rows,
    async putIdempotency(key, receipt) { rows.set(key, { receipt }); return receipt; },
    async getIdempotency(key) { return rows.get(key) || null; },
  };
}

test("persists deployment-, owner-, account-, and registry-bound three-venue readiness", async () => {
  const state = memoryState();
  const stored = await storeCarryExecutionReadiness({ state, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  assert.equal(stored.ok, true);
  assert.equal(stored.readiness.ready, true);
  assert.deepEqual(stored.readiness.registry_venue_ids, [...CARRY_EXECUTION_VENUES]);
  assert.equal(state.rows.size, 1);

  const read = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: request().venue_access, now_ms: NOW + 1_000, env: ENV });
  assert.equal(read.ready, true);
  assert.equal(read.image_digest, ENV.PHALA_CVM_IMAGE_DIGEST);
  assert.ok(read.evidence_commitment.startsWith("carry:readiness:evidence:"));
});

test("rejects stale or tampered readiness instead of reusing transient UI state", async () => {
  const state = memoryState();
  await storeCarryExecutionReadiness({ state, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  const stale = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: request().venue_access, now_ms: NOW + 16 * 60_000, env: ENV });
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.includes("carry_readiness_stale"));

  const evidence = structuredClone([...state.rows.values()][0].receipt);
  const aster = evidence.venues.find((item) => item.venue_id === "aster");
  aster.adapter_id = `${venueAdapterCapability("aster", "carry_execution").adapter_id}_tampered`;
  const tampered = assessCarryExecutionReadiness({ evidence, owner_commitment: OWNER, now_ms: NOW, env: ENV });
  assert.equal(tampered.ready, false);
  assert.ok(tampered.reasons.includes("carry_readiness_adapter_mismatch:aster"));
  assert.ok(tampered.reasons.includes("carry_readiness_commitment_invalid"));
});

test("fails closed when durable state or a deployment digest is unavailable", async () => {
  const noState = await storeCarryExecutionReadiness({ state: {}, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  assert.equal(noState.ok, false);
  assert.equal(noState.error, "carry_readiness_state_unavailable");

  const noDigest = await storeCarryExecutionReadiness({ state: memoryState(), request: request(), matrix: matrix(), now_ms: NOW, env: {} });
  assert.equal(noDigest.ok, false);
  assert.equal(noDigest.error, "carry_readiness_image_mismatch");
});

test("rejects readiness after any sealed venue binding rotates", async () => {
  const state = memoryState();
  const original = request();
  await storeCarryExecutionReadiness({ state, request: original, matrix: matrix(), now_ms: NOW, env: ENV });
  const rotated = structuredClone(original.venue_access);
  rotated.lighter.vault_commitment = "vault_commitment_lighter_rotated";
  const read = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: rotated, now_ms: NOW + 1_000, env: ENV });
  assert.equal(read.ready, false);
  assert.ok(read.reasons.includes("carry_readiness_access_rotated:lighter"));
});
