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

function request(overrides = {}) {
  return {
    owner_commitment: OWNER,
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_readiness_0001",
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    venue_access: Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [venueId, access(venueId)])),
    ...overrides,
  };
}

function matrix(workOrderCommitment = request().work_order_commitment) {
  const venues = CARRY_EXECUTION_VENUES.map((venueId) => ({
    venue_id: venueId,
    transaction_broadcast: false,
    work_order_commitments: [],
    verification_commitments: [],
    checks: {
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
    },
  }));
  const pairs = CARRY_EXECUTION_VENUES.flatMap((left, leftIndex) =>
    CARRY_EXECUTION_VENUES.slice(leftIndex + 1).map((right) => [left, right]))
    .map(([left, right], index) => {
      const pairWorkOrder = `${workOrderCommitment}_pair_${index + 1}`;
      const legEvidence = [left, right].map((venueId) => {
        const workOrderCommitment = `${pairWorkOrder}_${venueId}`;
        const verificationCommitment = `verification_commitment_${venueId}_${index + 1}`;
        const venue = venues.find((item) => item.venue_id === venueId);
        venue.work_order_commitments.push(workOrderCommitment);
        venue.verification_commitments.push(verificationCommitment);
        return {
          venue_id: venueId,
          work_order_commitment: workOrderCommitment,
          verification_commitment: verificationCommitment,
          transaction_broadcast: false,
          account_state_checked: true,
          order_request_checked: true,
        };
      });
      return {
        long_venue_id: left,
        short_venue_id: right,
        work_order_commitment: pairWorkOrder,
        no_submit_ready: true,
        transaction_broadcast: false,
        leg_evidence: legEvidence,
      };
    });
  return {
    transaction_broadcast: false,
    venues,
    pairs,
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

  const read = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: request().venue_access, asset: "BTC", notional_usd: "11", horizon_days: "30", now_ms: NOW + 1_000, env: ENV });
  assert.equal(read.ready, true);
  assert.equal(read.image_digest, ENV.PHALA_CVM_IMAGE_DIGEST);
  assert.ok(read.evidence_commitment.startsWith("carry:readiness:evidence:"));
});

test("preserves independent route readiness across assets and parameters", async () => {
  const state = memoryState();
  const btc = request();
  const eth = request({
    work_order_commitment: "carry_matrix_readiness_eth_0001",
    asset: "ETH",
    notional_usd: "25",
    horizon_days: "7",
  });
  assert.equal((await storeCarryExecutionReadiness({ state, request: btc, matrix: matrix(btc.work_order_commitment), now_ms: NOW, env: ENV })).ok, true);
  assert.equal((await storeCarryExecutionReadiness({ state, request: eth, matrix: matrix(eth.work_order_commitment), now_ms: NOW, env: ENV })).ok, true);
  assert.equal(state.rows.size, 2);

  const btcRead = await readCarryExecutionReadiness({
    state,
    owner_commitment: OWNER,
    venue_access: btc.venue_access,
    asset: btc.asset,
    notional_usd: btc.notional_usd,
    horizon_days: btc.horizon_days,
    now_ms: NOW + 1_000,
    env: ENV,
  });
  const ethRead = await readCarryExecutionReadiness({
    state,
    owner_commitment: OWNER,
    venue_access: eth.venue_access,
    asset: eth.asset,
    notional_usd: eth.notional_usd,
    horizon_days: eth.horizon_days,
    now_ms: NOW + 1_000,
    env: ENV,
  });
  assert.equal(btcRead.ready, true);
  assert.equal(btcRead.asset, "BTC");
  assert.equal(ethRead.ready, true);
  assert.equal(ethRead.asset, "ETH");
  assert.equal(ethRead.notional_usd, "25");
  assert.equal(ethRead.horizon_days, "7");
});

test("rejects stale or tampered readiness instead of reusing transient UI state", async () => {
  const state = memoryState();
  await storeCarryExecutionReadiness({ state, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  const stale = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: request().venue_access, asset: "BTC", notional_usd: "11", horizon_days: "30", now_ms: NOW + 16 * 60_000, env: ENV });
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.includes("carry_readiness_stale"));

  const evidence = structuredClone([...state.rows.values()][0].receipt);
  const aster = evidence.venues.find((item) => item.venue_id === "aster");
  aster.adapter_id = `${venueAdapterCapability("aster", "carry_execution").adapter_id}_tampered`;
  const tampered = assessCarryExecutionReadiness({ evidence, owner_commitment: OWNER, now_ms: NOW, env: ENV });
  assert.equal(tampered.ready, false);
  assert.ok(tampered.reasons.includes("carry_readiness_adapter_mismatch:aster"));
  assert.ok(tampered.reasons.includes("carry_readiness_commitment_invalid"));

  const wrongRoute = assessCarryExecutionReadiness({
    evidence: [...state.rows.values()][0].receipt,
    owner_commitment: OWNER,
    asset: "ETH",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(wrongRoute.ready, false);
  assert.ok(wrongRoute.reasons.includes("carry_readiness_route_mismatch"));
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
  const read = await readCarryExecutionReadiness({ state, owner_commitment: OWNER, venue_access: rotated, asset: "BTC", notional_usd: "11", horizon_days: "30", now_ms: NOW + 1_000, env: ENV });
  assert.equal(read.ready, false);
  assert.ok(read.reasons.includes("carry_readiness_access_rotated:lighter"));
});

test("requires every unique venue pair before three-venue readiness passes", async () => {
  const incomplete = matrix();
  incomplete.pairs = incomplete.pairs.filter((pair) =>
    ![pair.long_venue_id, pair.short_venue_id].includes("hyperliquid")
    || ![pair.long_venue_id, pair.short_venue_id].includes("aster"));
  const stored = await storeCarryExecutionReadiness({
    state: memoryState(),
    request: request(),
    matrix: incomplete,
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(stored.ok, false);
  assert.ok(stored.readiness.reasons.includes("carry_readiness_pair_count_invalid"));
  assert.ok(stored.readiness.reasons.includes("carry_readiness_pair_unproven:hyperliquid:aster"));
});

test("binds every pair to both exact no-submit leg receipts", async () => {
  for (const mutate of [
    (value) => { value.pairs[0].leg_evidence.pop(); },
    (value) => { value.pairs[0].leg_evidence[0].work_order_commitment = "wrong_work_order_0001"; },
    (value) => { value.pairs[0].leg_evidence[0].verification_commitment = "wrong_verification_0001"; },
    (value) => { value.venues[0].verification_commitments[1] = value.venues[0].verification_commitments[0]; },
  ]) {
    const candidate = matrix();
    mutate(candidate);
    const stored = await storeCarryExecutionReadiness({
      state: memoryState(),
      request: request(),
      matrix: candidate,
      now_ms: NOW,
      env: ENV,
    });
    assert.equal(stored.ok, false);
  }
});
