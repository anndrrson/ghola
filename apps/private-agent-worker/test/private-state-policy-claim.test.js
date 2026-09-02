import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSqliteWorkerState,
  createWorkerState,
} from "../src/state/private-state.js";
import {
  buildCarryInventoryEvidence,
  carryInventoryExpectation,
  carryInventoryPositionIdentityCommitment,
} from "../src/execution/carry-inventory.js";
import { carryReconciliationCommitment } from "../src/execution/carry-reconciliation.js";

function attempt(status) {
  return { status, submit_count: status === "armed" ? 1 : 0 };
}

function usage(overrides = {}) {
  return {
    allowed_attempt: attempt("armed"),
    denied_attempt: attempt("failed_no_submit"),
    counts: [{ key: "orders:test", max_count: 10, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:test", amount: 5, max_amount: 100, error: "amount denied", status: 400 }],
    ...overrides,
  };
}

function readJsonState(dir) {
  return JSON.parse(readFileSync(join(dir, "private-agent-execution-state-v1.json"), "utf8"));
}

function carryReservationCandidate(suffix) {
  const positionId = `carry:position:reservation:${suffix}`;
  const sagaId = `saga:carry:reservation:${suffix}`;
  const ownerCommitment = "owner:reservation:test";
  const venueIds = ["hyperliquid", "lighter"];
  const accountsByVenue = {
    hyperliquid: "account:hyperliquid:test",
    lighter: "account:lighter:test",
  };
  const legs = venueIds.map((venueId, index) => ({
    venue_id: venueId,
    leg_id: `leg:carry:reservation:${suffix}:${index}`,
    work_order_commitment: `work:carry:reservation:${suffix}:${index}`,
  }));
  const saga = {
    version: 1,
    saga_id: sagaId,
    status: "ready",
    terminal: false,
    recovery_mode: "unwind",
    unhedged_deadline_ms: null,
    first_exposure_observed_at_ms: null,
    exposure_boundary_provenance: null,
    signed_filled_exposure_micro_usdc_by_asset: {},
    execution_context: {
      version: 1,
      carry_position_id: positionId,
      owner_commitment: ownerCommitment,
      legs: legs.map((leg) => ({
        leg_id: leg.leg_id,
        work_order_commitment: leg.work_order_commitment,
      })),
    },
    legs: legs.map((leg) => ({
      venue_id: leg.venue_id,
      leg_id: leg.leg_id,
      submission_status: "pending",
      provider_ref_commitment: null,
      filled_micro_usdc: 0,
      unwind_filled_micro_usdc: 0,
    })),
  };
  const record = {
    owner_commitment: ownerCommitment,
    entry_saga_id: sagaId,
    position: {
      position_id: positionId,
      status: "opening",
      asset: "BTC",
      long_venue_id: venueIds[0],
      short_venue_id: venueIds[1],
    },
    monitoring_context: {
      venue_access: Object.fromEntries(venueIds.map((venueId) => [
        venueId,
        { account_commitment: accountsByVenue[venueId] },
      ])),
    },
  };
  const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
  const bindingsCommitment = `carry:exposure-bindings:${digest(JSON.stringify({
    owner_commitment: ownerCommitment,
    asset: "BTC",
    venue_ids: venueIds,
    accounts_by_venue: accountsByVenue,
    legs,
  })).slice(0, 40)}`;
  return {
    positionId,
    record,
    saga,
    bindingsCommitment,
    reservations: [
      { reservation_key: `carry:exposure:owner:${digest(`${ownerCommitment}:BTC`).slice(0, 40)}` },
      ...Object.values(accountsByVenue).sort().map((accountCommitment) => ({
        reservation_key: `carry:exposure:account:${digest(`${accountCommitment}:BTC`).slice(0, 40)}`,
        account_commitment: accountCommitment,
      })),
    ],
  };
}

test("atomic policy claim rolls back every quota charge when a later quota denies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);

  const seeded = await state.claimExecutionAttemptWithPolicyUsage("work-seed", usage());
  assert.equal(seeded.ok, true);

  const denied = await state.claimExecutionAttemptWithPolicyUsage("work-denied", usage({
    counts: [{ key: "orders:test", max_count: 10, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:test", amount: 96, max_amount: 100, error: "amount denied", status: 400 }],
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "policy_denied");
  assert.equal(denied.denied.type, "amount");
  assert.equal(denied.denied.key, "notional:test");
  assert.equal(denied.denied.error, "amount denied");

  const persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:test"].count, 1);
  assert.equal(persisted.policy_amounts["notional:test"].amount, 5);
  assert.equal(persisted.execution_attempts["work-denied"].status, "failed_no_submit");
});

test("Carry exposure reservations are atomic, durable, replay-safe, and reusable only after release", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-exposure-reservation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = createWorkerState(dir);
  const candidates = ["first", "second", "third"].map(carryReservationCandidate);
  writeFileSync(join(dir, "private-agent-execution-state-v1.json"), JSON.stringify({
    carry_positions: Object.fromEntries(candidates.map((item) => [item.positionId, item.record])),
    multi_leg_sagas: Object.fromEntries(candidates.map((item) => [item.saga.saga_id, item.saga])),
    carry_exposure_reservations: {},
  }));
  const simultaneous = await Promise.all([
    first.claimCarryExposureReservations(candidates[0].positionId, candidates[0].bindingsCommitment, candidates[0].reservations),
    first.claimCarryExposureReservations(candidates[1].positionId, candidates[1].bindingsCommitment, candidates[1].reservations),
  ]);
  assert.equal(simultaneous.filter((item) => item.ok).length, 1);
  const winner = simultaneous[0].ok ? candidates[0] : candidates[1];
  const restarted = createWorkerState(dir);
  assert.equal((await restarted.claimCarryExposureReservations(
    winner.positionId, winner.bindingsCommitment, winner.reservations,
  )).ok, true);
  assert.equal((await restarted.claimCarryExposureReservations(
    candidates[2].positionId, candidates[2].bindingsCommitment, candidates[2].reservations,
  )).ok, false);
  assert.equal((await restarted.releaseCarryExposureReservations(
    winner.positionId, winner.bindingsCommitment,
    winner.reservations.map((item) => item.reservation_key), { owner_commitment: "wrong" },
  )).ok, false);
  const state = readJsonState(dir);
  const inventoryExpectations = Object.fromEntries(["hyperliquid", "lighter"].map((venueId) => [
    venueId,
    carryInventoryExpectation({
      venue_id: venueId,
      account_commitment: `account:${venueId}:test`,
      market: "BTC-PERP",
      side: venueId === "hyperliquid" ? "long" : "short",
      base_size: "0.001",
      entry_work_order_commitment: `work:carry:${venueId}:reservation:test`,
      entry_provider_ref_commitment: `provider:carry:${venueId}:reservation:test`,
    }),
  ]));
  const finalReconciliation = {
    account_state_checked: true, transaction_broadcast: false, gross_exposure_micro_usdc: 0, open_order_count: 0,
    owner_commitment: winner.record.owner_commitment, carry_position_id: winner.positionId,
    checked_at_ms: 1_800_000_000_001,
    venues: ["hyperliquid", "lighter"].map((venue_id) => ({
      venue_id, account_commitment: `account:${venue_id}:test`, authorized: true,
      account_state_checked: true, flat_zero_orders: true, position_count: 0, open_order_count: 0,
      position_identity_commitment: carryInventoryPositionIdentityCommitment({
        venue_id,
        account_commitment: `account:${venue_id}:test`,
        market: "BTC-PERP",
      }),
      inventory: buildCarryInventoryEvidence({
        venue_id,
        account_commitment: `account:${venue_id}:test`,
        target_market: "BTC-PERP",
        positions: [],
        open_orders: [],
        position_inventory_verified: true,
        open_order_inventory_verified: true,
      }),
    })),
  };
  finalReconciliation.reconciliation_commitment = carryReconciliationCommitment(finalReconciliation);
  state.carry_positions[winner.positionId] = {
    ...state.carry_positions[winner.positionId],
    position: {
      ...state.carry_positions[winner.positionId].position,
      status: "reconciled",
      inventory_expectation_by_venue: inventoryExpectations,
    },
    final_reconciliation_evidence: finalReconciliation,
  };
  writeFileSync(join(dir, "private-agent-execution-state-v1.json"), JSON.stringify(state));
  const afterFlat = createWorkerState(dir);
  assert.equal((await afterFlat.releaseCarryExposureReservations(
    winner.positionId,
    winner.bindingsCommitment,
    winner.reservations.map((item) => item.reservation_key),
    {
      owner_commitment: winner.record.owner_commitment, position_id: winner.positionId, venue_ids: ["hyperliquid", "lighter"],
      account_commitments: { hyperliquid: "account:hyperliquid:test", lighter: "account:lighter:test" },
      inventory_expectations: inventoryExpectations,
    },
  )).ok, true);
  assert.equal((await afterFlat.claimCarryExposureReservations(
    candidates[2].positionId, candidates[2].bindingsCommitment, candidates[2].reservations,
  )).ok, true);
  assert.equal(readJsonState(dir).carry_exposure_reservations[winner.reservations[0].reservation_key].generation, 2);
});

test("duplicate concurrent atomic claims charge quota exactly once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-duplicate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);

  const results = await Promise.all([
    state.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage()),
    state.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage()),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "attempt_exists").length, 1);

  const persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:test"].count, 1);
  assert.equal(persisted.policy_amounts["notional:test"].amount, 5);
});

test("a policy-proven no-submit attempt rearms once after quota permits and preserves lineage", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-rearm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const work = "work-policy-rearm";
  const deniedInput = usage({
    denied_attempt: {
      status: "failed_no_submit",
      submit_count: 0,
      ambiguity_retry_count: 0,
      final_proof: null,
      result_seed: { kind: "lighter_policy_failed_no_submit" },
    },
    counts: [{ key: "orders:rearm", max_count: 0, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:rearm", amount: 5, max_amount: 100 }],
  });
  const denied = await state.claimExecutionAttemptWithPolicyUsage(work, deniedInput);
  assert.equal(denied.reason, "policy_denied");
  assert.equal(denied.attempt.policy_denial.key, "orders:rearm");

  const stillDenied = await state.claimExecutionAttemptWithPolicyUsage(work, {
    ...deniedInput,
    rearm_failed_no_submit: true,
  });
  assert.equal(stillDenied.reason, "policy_denied");
  assert.equal(stillDenied.attempt.status, "failed_no_submit");
  let persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:rearm"], undefined);
  assert.equal(persisted.policy_amounts["notional:rearm"], undefined);

  const allowedInput = usage({
    allowed_attempt: {
      status: "pending",
      submit_count: 1,
      ambiguity_retry_count: 0,
      final_proof: null,
      result_seed: { kind: "lighter_submission_pending" },
    },
    counts: [{ key: "orders:rearm", max_count: 1 }],
    amounts: [{ key: "notional:rearm", amount: 5, max_amount: 100 }],
    rearm_failed_no_submit: true,
  });
  const results = await Promise.all([
    state.claimExecutionAttemptWithPolicyUsage(work, allowedInput),
    state.claimExecutionAttemptWithPolicyUsage(work, allowedInput),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "attempt_exists").length, 1);

  persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:rearm"].count, 1);
  assert.equal(persisted.policy_amounts["notional:rearm"].amount, 5);
  assert.equal(persisted.execution_attempts[work].status, "pending");
  assert.equal(persisted.execution_attempts[work].policy_rearm_count, 1);
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage.length, 1);
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage[0].status, "failed_no_submit");
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage[0].policy_denial.key, "orders:rearm");
});

test("ambiguous attempts can never use the policy no-submit rearm", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-no-ambiguity-rearm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const work = "work-ambiguous";
  await state.putExecutionAttempt(work, {
    status: "ambiguous",
    submit_count: 1,
    ambiguity_retry_count: 0,
    result_seed: { kind: "lighter_submission_ambiguous" },
  });

  const result = await state.claimExecutionAttemptWithPolicyUsage(work, usage({
    rearm_failed_no_submit: true,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "attempt_exists");
  const persisted = readJsonState(dir);
  assert.equal(persisted.execution_attempts[work].status, "ambiguous");
  assert.equal(persisted.policy_counts["orders:test"], undefined);
  assert.equal(persisted.policy_amounts["notional:test"], undefined);

  await state.putExecutionAttempt("work-prior-ambiguity", {
    status: "failed_no_submit",
    submit_count: 0,
    ambiguity_retry_count: 1,
    final_proof: null,
    result_seed: { kind: "lighter_policy_failed_no_submit" },
  });
  const disguisedAmbiguity = await state.claimExecutionAttemptWithPolicyUsage(
    "work-prior-ambiguity",
    usage({ rearm_failed_no_submit: true }),
  );
  assert.equal(disguisedAmbiguity.reason, "attempt_exists");
  assert.equal((await state.getExecutionAttempt("work-prior-ambiguity")).ambiguity_retry_count, 1);
});

test("SQLite serializes competing quota claims across adapter instances", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "worker.sqlite");
  const first = createSqliteWorkerState(dbPath);
  const second = createSqliteWorkerState(dbPath);
  const constrained = usage({
    counts: [{ key: "orders:shared", max_count: 1, error: "shared count denied", status: 429 }],
    amounts: [],
  });

  const results = await Promise.all([
    first.claimExecutionAttemptWithPolicyUsage("work-a", constrained),
    second.claimExecutionAttemptWithPolicyUsage("work-b", constrained),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "policy_denied").length, 1);
  const deniedWork = results[0].reason === "policy_denied" ? "work-a" : "work-b";
  assert.equal((await first.getExecutionAttempt(deniedWork)).status, "failed_no_submit");

  const duplicateResults = await Promise.all([
    first.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage({
      counts: [{ key: "orders:duplicate", max_count: 2 }],
      amounts: [],
    })),
    second.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage({
      counts: [{ key: "orders:duplicate", max_count: 2 }],
      amounts: [],
    })),
  ]);
  assert.equal(duplicateResults.filter((result) => result.ok).length, 1);
  assert.equal(duplicateResults.filter((result) => result.reason === "attempt_exists").length, 1);
});
