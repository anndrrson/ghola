import assert from "node:assert/strict";
import test from "node:test";
import { CARRY_EXECUTION_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import {
  assessCarryExecutionDiagnostic,
  assessCarryExecutionReadiness,
  carryAccountStateCommitment,
  readCarryExecutionDiagnostic,
  readCarryExecutionReadiness,
  storeCarryExecutionDiagnostic,
  storeCarryExecutionReadiness,
  verifyCarryExecutionReadinessResult,
} from "../src/execution/carry-readiness.js";
import { buildCarryInventoryEvidence } from "../src/execution/carry-inventory.js";

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
    qualification: qualification(venueId),
    account_commitment: access(venueId).account_commitment,
    transaction_broadcast: false,
    work_order_commitments: [],
    verification_commitments: [],
    account_state_commitments: [],
    checks: {
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
      mandatory_no_submit_checks_passed: true,
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
        const accountState = {
          venue_id: venueId,
          account_commitment: access(venueId).account_commitment,
          verification_commitment: verificationCommitment,
          checked_at_ms: NOW,
          position_count: 0,
          open_order_count: 0,
          flat_zero_orders: true,
          liquidation_distance_bps: null,
          liquidation_distance_verified: false,
          liquidation_distance_source: null,
          inventory: buildCarryInventoryEvidence({
            venue_id: venueId,
            account_commitment: access(venueId).account_commitment,
            target_market: venueId === "aster" ? "BTCUSDT" : "BTC",
            positions: [],
            open_orders: [],
            position_inventory_verified: true,
            open_order_inventory_verified: true,
          }),
        };
        accountState.account_state_commitment = carryAccountStateCommitment(accountState);
        venue.work_order_commitments.push(workOrderCommitment);
        venue.verification_commitments.push(verificationCommitment);
        venue.account_state_commitments.push(accountState.account_state_commitment);
        return {
          venue_id: venueId,
          account_commitment: access(venueId).account_commitment,
          work_order_commitment: workOrderCommitment,
          verification_commitment: verificationCommitment,
          account_state: accountState,
          transaction_broadcast: false,
          account_state_checked: true,
          order_request_checked: true,
          mandatory_no_submit_checks_passed: true,
        };
      });
      return {
        long_venue_id: left,
        short_venue_id: right,
        work_order_commitment: pairWorkOrder,
        no_submit_ready: true,
        capital_ready: true,
        transaction_broadcast: false,
        account_readiness: [left, right].map((venueId) => {
          const state = legEvidence.find((item) => item.venue_id === venueId).account_state;
          return {
            venue_id: venueId,
            account_commitment: access(venueId).account_commitment,
            authorized: true,
            flat_zero_orders: true,
            position_count: 0,
            open_order_count: 0,
            liquidation_distance_bps: null,
            liquidation_distance_verified: false,
            liquidation_distance_source: null,
            inventory: state.inventory,
            inventory_verified: true,
            account_state_checked_at_ms: NOW,
            account_state_commitment: state.account_state_commitment,
            capital_ready: true,
            available_balance_micro_usdc: 11_000_000,
            venue_minimum_margin_micro_usdc: 550_000,
            required_opening_collateral_micro_usdc: 11_000_000,
            opening_collateral_shortfall_micro_usdc: 0,
            execution_leverage: 1,
            owner_only_funding: true,
          };
        }),
        leg_evidence: legEvidence,
      };
    });
  return {
    transaction_broadcast: false,
    venues,
    pairs,
  };
}

function qualification(venueId) {
  const capability = venueAdapterCapability(venueId, "exact_quantity_recovery");
  return capability?.status === "proven"
    ? {
        proven: true,
        source: "registry_baseline",
        adapter_id: capability.adapter_id,
        image_digest: ENV.PHALA_CVM_IMAGE_DIGEST,
      }
    : {
        proven: true,
        source: "deployment_bound_lifecycle",
        adapter_id: capability?.adapter_id,
        image_digest: ENV.PHALA_CVM_IMAGE_DIGEST,
        verified_at_ms: NOW - 1_000,
        evidence_commitment: `carry:qualification:evidence:${venueId}:0001`,
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

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, child]) => [key, reorderObjectKeys(child)]));
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
  assert.equal(read.recovery_ready, true);
  assert.deepEqual(read.recovery_reasons, []);
  assert.deepEqual(read.recovery_venue_ids, [...CARRY_EXECUTION_VENUES]);
  assert.deepEqual(read.recovery_policy, {
    ambiguous_submission: "freeze_reconcile_never_retry",
    partial_fill: "exact_quantity_reduce_only",
    worker_restart: "reconcile_before_action",
  });
  assert.equal(read.capital_ready, true);
  assert.equal(read.capital_plan.length, CARRY_EXECUTION_VENUES.length);
  assert.equal(read.capital_plan.every((item) =>
    item.position_count === 0
    && item.open_order_count === 0
    && item.account_state_checked_at_ms === NOW
    && item.account_state_commitment.startsWith("carry:account-state:")
  ), true);
  assert.equal(verifyCarryExecutionReadinessResult(read, { now_ms: NOW + 1_000 }).ok, true);
});

test("accepts semantically identical inventory after JSONB key reordering", async () => {
  const candidate = matrix();
  const pair = candidate.pairs[0];
  const legState = pair.leg_evidence[0].account_state;
  const reorderedInventory = reorderObjectKeys(legState.inventory);
  assert.equal(carryAccountStateCommitment({
    ...legState,
    inventory: reorderedInventory,
  }), legState.account_state_commitment);
  pair.account_readiness[0].inventory = reorderedInventory;
  const stored = await storeCarryExecutionReadiness({
    state: memoryState(),
    request: request(),
    matrix: candidate,
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.readiness.ready, true);
});

test("does not promote registered recovery adapters without deployment-bound lifecycle qualification", async () => {
  const state = memoryState();
  const unproven = matrix();
  const lighter = unproven.venues.find((venue) => venue.venue_id === "lighter");
  lighter.qualification = {
    ...lighter.qualification,
    proven: false,
    source: null,
    verified_at_ms: null,
    evidence_commitment: null,
  };
  const stored = await storeCarryExecutionReadiness({ state, request: request(), matrix: unproven, now_ms: NOW, env: ENV });
  assert.equal(stored.ok, true);
  assert.equal(stored.readiness.ready, true);
  assert.equal(stored.readiness.recovery_ready, false);
  assert.deepEqual(stored.readiness.recovery_venue_ids, ["hyperliquid", "aster"]);
  assert.ok(stored.readiness.recovery_reasons.includes("carry_recovery_qualification_unproven:lighter"));
  assert.ok(stored.readiness.recovery_reasons.includes("carry_recovery_qualification_source_invalid:lighter"));
  assert.equal(verifyCarryExecutionReadinessResult(stored.readiness, { now_ms: NOW }).ok, true);
});

test("rejects tampered readiness summaries", async () => {
  const state = memoryState();
  await storeCarryExecutionReadiness({ state, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  const read = await readCarryExecutionReadiness({
    state,
    owner_commitment: OWNER,
    venue_access: request().venue_access,
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW + 1_000,
    env: ENV,
  });
  const tampered = structuredClone(read);
  tampered.notional_usd = "12";
  assert.equal(verifyCarryExecutionReadinessResult(tampered, { now_ms: NOW + 1_000 }).ok, false);
});

test("persists partial matrix diagnostics without creating reusable readiness", async () => {
  const state = memoryState();
  const partial = matrix();
  for (const pair of partial.pairs) {
    if ([pair.long_venue_id, pair.short_venue_id].includes("aster")) {
      pair.no_submit_ready = false;
      pair.capital_ready = false;
      pair.error_code = "carry_account_not_ready:aster";
      pair.account_readiness = [];
      pair.leg_evidence = [];
    }
  }
  partial.failures = [
    "pair_check_failed:2:carry_account_not_ready:aster",
    "pair_check_failed:3:carry_account_not_ready:aster",
  ];

  const stored = await storeCarryExecutionDiagnostic({
    state,
    request: request(),
    matrix: partial,
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.diagnostic.available, true);
  assert.equal(stored.diagnostic.diagnostic_only, true);
  assert.equal(stored.diagnostic.reusable_for_readiness, false);
  assert.equal(stored.diagnostic.pairs.filter((pair) => pair.no_submit_ready).length, 1);
  assert.equal(state.rows.size, 1);

  const diagnostic = await readCarryExecutionDiagnostic({
    state,
    owner_commitment: OWNER,
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW + 1_000,
    env: ENV,
  });
  assert.equal(diagnostic.available, true);
  assert.equal(diagnostic.reusable_for_readiness, false);
  assert.ok(diagnostic.diagnostic_commitment.startsWith("carry:diagnostic:evidence:"));

  const readiness = await readCarryExecutionReadiness({
    state,
    owner_commitment: OWNER,
    venue_access: request().venue_access,
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW + 1_000,
    env: ENV,
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes("carry_readiness_evidence_missing"));

  const evidence = structuredClone([...state.rows.values()][0].receipt);
  evidence.pairs[0].no_submit_ready = !evidence.pairs[0].no_submit_ready;
  const tampered = assessCarryExecutionDiagnostic({
    evidence,
    owner_commitment: OWNER,
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW + 1_000,
    env: ENV,
  });
  assert.equal(tampered.available, false);
  assert.ok(tampered.reasons.some((reason) => reason.startsWith("carry_diagnostic_pair_error_missing:")));
  assert.ok(tampered.reasons.includes("carry_diagnostic_commitment_invalid"));
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

test("rejects readiness detached from exact no-submit and recovery adapters", async () => {
  const state = memoryState();
  await storeCarryExecutionReadiness({ state, request: request(), matrix: matrix(), now_ms: NOW, env: ENV });
  const evidence = structuredClone([...state.rows.values()][0].receipt);
  const lighter = evidence.venues.find((item) => item.venue_id === "lighter");
  lighter.exact_quantity_recovery_adapter_id = "lighter_unsafe_retry_v0";
  evidence.recovery_policy.ambiguous_submission = "retry";
  const assessed = assessCarryExecutionReadiness({
    evidence,
    owner_commitment: OWNER,
    venue_access: request().venue_access,
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(assessed.ready, false);
  assert.equal(assessed.recovery_ready, false);
  assert.ok(assessed.reasons.includes("carry_readiness_recovery_policy_mismatch"));
  assert.ok(assessed.reasons.includes("carry_readiness_recovery_adapter_mismatch:lighter"));
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
    (value) => { value.pairs[0].leg_evidence[0].account_state.open_order_count = 1; },
    (value) => { value.pairs[0].leg_evidence[0].account_state.liquidation_distance_bps = 1_000; },
    (value) => { value.pairs[0].account_readiness[0].position_count = 1; },
    (value) => { value.venues[0].verification_commitments[1] = value.venues[0].verification_commitments[0]; },
    (value) => { value.venues[0].account_state_commitments.pop(); },
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

test("rejects readiness when mandatory venue or leg no-submit checks are unproven", async () => {
  for (const [mutate, expectedReason] of [
    [
      (value) => { value.venues[0].checks.mandatory_no_submit_checks_passed = false; },
      "carry_readiness_mandatory_checks_unproven:hyperliquid",
    ],
    [
      (value) => { value.pairs[0].leg_evidence[0].mandatory_no_submit_checks_passed = false; },
      "carry_readiness_leg_unproven:hyperliquid:lighter:hyperliquid",
    ],
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
    assert.ok(stored.readiness.reasons.includes(expectedReason));
  }
});

test("binds verified liquidation provenance into no-submit account-state commitments", () => {
  const flatState = matrix().pairs[0].leg_evidence[0].account_state;
  const openState = {
    ...flatState,
    position_count: 1,
    flat_zero_orders: false,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: true,
    liquidation_distance_source: "venue_position_snapshot_v1",
  };
  const openCommitment = carryAccountStateCommitment(openState);
  assert.notEqual(openCommitment, flatState.account_state_commitment);
  assert.notEqual(openCommitment, carryAccountStateCommitment({
    ...openState,
    liquidation_distance_bps: 2_499,
  }));
  assert.notEqual(openCommitment, carryAccountStateCommitment({
    ...openState,
    liquidation_distance_source: "swapped_position_snapshot_v1",
  }));
});

test("rejects capital-plan liquidation evidence detached from committed venue account state", async () => {
  for (const mutate of [
    (value) => { value.liquidation_distance_bps = 1; },
    (value) => { value.liquidation_distance_verified = true; },
    (value) => { value.liquidation_distance_source = "fabricated_position_snapshot_v1"; },
  ]) {
    const candidate = matrix();
    mutate(candidate.pairs[0].account_readiness[0]);
    const stored = await storeCarryExecutionReadiness({
      state: memoryState(),
      request: request(),
      matrix: candidate,
      now_ms: NOW,
      env: ENV,
    });
    assert.equal(stored.ok, false);
    assert.ok(stored.readiness.reasons.some((reason) =>
      reason.startsWith("carry_readiness_capital_state_binding_invalid:")));
  }
});

test("persists capital-free technical readiness while binding exact owner shortfalls", async () => {
  const candidate = matrix();
  for (const pair of candidate.pairs) {
    pair.capital_ready = false;
    for (const account of pair.account_readiness) {
      account.available_balance_micro_usdc = 0;
      account.capital_ready = false;
      account.opening_collateral_shortfall_micro_usdc = 11_000_000;
    }
  }
  const stored = await storeCarryExecutionReadiness({
    state: memoryState(),
    request: request(),
    matrix: candidate,
    now_ms: NOW,
    env: ENV,
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.readiness.ready, true);
  assert.equal(stored.readiness.capital_ready, false);
  assert.equal(stored.readiness.capital_plan.every((item) =>
    item.owner_only_funding === true && item.opening_collateral_shortfall_micro_usdc === 11_000_000
  ), true);
});

test("rejects inconsistent or mathematically false capital evidence", async () => {
  for (const mutate of [
    (value) => { value.pairs[0].account_readiness[0].opening_collateral_shortfall_micro_usdc = 1; },
    (value) => { value.pairs[0].account_readiness[0].owner_only_funding = false; },
    (value) => { value.pairs[0].account_readiness[0].available_balance_micro_usdc = 10_000_000; },
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
    assert.ok(stored.readiness.reasons.some((reason) => reason.includes("carry_readiness_capital_")));
  }
});
