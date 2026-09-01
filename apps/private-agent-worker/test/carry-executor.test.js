import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalCarryCommitmentJson, cashflowValuationEvidenceMessage } from "@ghola/execution-core";
import {
  assessCarryTerminalExecutionReceipt,
  auditCarryPositionsAfterRestart,
  executeStoredCarryEntry,
  executeStoredCarryExit,
  runCarryExecutionTick,
  startCarryExecutionLoop,
} from "../src/execution/carry-executor.js";
import { advanceStoredCarryPosition, createStoredCarryPosition, runCarryMonitoringTick } from "../src/execution/carry-positions.js";
import { readCarryVenueQualification } from "../src/execution/carry-qualification.js";
import { carryAccountStateCommitment } from "../src/execution/carry-readiness.js";
import { applyDurableMultiLegEvent, recoverDueMultiLegSagas } from "../src/execution/multi-leg-orchestrator.js";
import { createWorkerState } from "../src/state/private-state.js";
import { authenticateCarryCreationOpportunity } from "../src/execution/carry-opportunity-authentication.js";
import { liquidationDistanceSourceForVenue } from "../src/venues/liquidation-distance.js";
import {
  carryOpportunityInputEvidence,
  signedCarryPositionInput,
} from "./carry-mandate-fixture.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:carry:executor:0001";

test("live Carry receipts are bound to the exact venue, account, work order, and terminal venue proof", () => {
  const args = {
    venue_id: "aster",
    work_order_commitment: "work:carry:receipt:aster:0001",
    execution: { account_commitment: "account:aster:receipt:0001" },
  };
  const receipt = qualificationReceipt(args);
  assert.deepEqual(assessCarryTerminalExecutionReceipt({
    receipt,
    venue_id: args.venue_id,
    work_order_commitment: args.work_order_commitment,
    account_commitment: args.execution.account_commitment,
  }), { verified: true, reasons: [] });

  for (const [reason, mutate] of [
    ["carry_execution_receipt_work_order_mismatch", (value) => { value.work_order_commitment = "work:carry:receipt:wrong:0001"; }],
    ["carry_execution_receipt_account_mismatch", (value) => { value.account_commitment = "account:aster:wrong:0001"; }],
    ["carry_execution_receipt_venue_mismatch", (value) => { value.venue_id = "lighter"; }],
    ["carry_execution_receipt_commitment_missing", (value) => { value.result_commitment = null; }],
    ["carry_execution_receipt_terminal_proof_unverified", (value) => { value.final_proof.broadcast_performed = false; }],
  ]) {
    const forged = structuredClone(receipt);
    mutate(forged);
    const assessed = assessCarryTerminalExecutionReceipt({
      receipt: forged,
      venue_id: args.venue_id,
      work_order_commitment: args.work_order_commitment,
      account_commitment: args.execution.account_commitment,
    });
    assert.equal(assessed.verified, false);
    assert.ok(assessed.reasons.includes(reason));
  }
});

test("Hyperliquid protocol binding substitutes for its intentionally omitted venue field", () => {
  const args = {
    venue_id: "hyperliquid",
    work_order_commitment: "work:carry:receipt:hyperliquid:0001",
    execution: { account_commitment: "account:hyperliquid:receipt:0001" },
  };
  const receipt = qualificationReceipt(args);
  delete receipt.venue_id;
  receipt.execution_protocol = "ghola-hyperliquid-proof-v2";
  assert.equal(assessCarryTerminalExecutionReceipt({
    receipt,
    venue_id: args.venue_id,
    work_order_commitment: args.work_order_commitment,
    account_commitment: args.execution.account_commitment,
  }).verified, true);
});

test("automatic exit retries a failed restart audit before any execution sweep", async (t) => {
  let storageReady = false;
  let listCalls = 0;
  const state = {
    listCarryPositionRecords: async () => {
      listCalls += 1;
      if (!storageReady) throw new Error("transient storage outage");
      return [];
    },
  };
  const loop = startCarryExecutionLoop({
    state,
    env: {
      PRIVATE_AGENT_CARRY_EXECUTION_SWEEP_MS: "60000",
      PRIVATE_AGENT_CARRY_AUTO_EXIT_ENABLED: "true",
    },
    now: () => NOW,
  });
  t.after(() => loop.stop());

  const firstAudit = await loop.ready;
  assert.equal(firstAudit.ok, false);
  storageReady = true;
  const recovered = await loop.runNow();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.checked, 0);
  assert.equal(loop.health().status, "healthy");
  assert.ok(listCalls >= 9);
});

test("executes and reconciles a qualified protected perp pair", async (t) => {
  const fixture = await setup(t, "success");
  const calls = [];
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      calls.push(args);
      return {
        status: "filled",
        provider_ref_commitment: `provider:${args.venue_id}:0001`,
        final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "active");
  assert.equal(result.saga.status, "reconciled");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.instruction.order.reduce_only === false), true);
  assert.equal(calls.every((call) => call.execution.carry_position_id === fixture.position_id), true);
});

test("refuses entry when durable opportunity evidence was altered after owner approval", async (t) => {
  const fixture = await setup(t, "tampered-opportunity");
  const record = await fixture.state.getCarryPositionRecord(fixture.position_id);
  const stored = await fixture.state.putCarryPositionRecord({
    ...record,
    opportunity: {
      ...record.opportunity,
      horizon_ms: record.opportunity.horizon_ms + 1,
    },
  }, { expected_version: record.record_version });
  assert.equal(stored.ok, true);

  let preflightCalls = 0;
  let submitCalls = 0;
  const result = await executeStoredCarryEntry({
    ...fixture,
    preflight: async () => {
      preflightCalls += 1;
      return preflightProof();
    },
    executeOrder: async () => {
      submitCalls += 1;
      return {};
    },
  });

  assert.equal(result.error, "carry_stored_opportunity_projection_mismatch");
  assert.equal(preflightCalls, 0);
  assert.equal(submitCalls, 0);
});

test("refuses live entry before preflight when private-prime readiness is not current", async (t) => {
  const fixture = await setup(t, "private-prime-readiness-unproven");
  let preflightCalls = 0;
  let submitCalls = 0;
  const result = await executeStoredCarryEntry({
    ...fixture,
    env: {
      PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: "true",
      PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456",
    },
    carry_supervision: null,
    preflight: async () => {
      preflightCalls += 1;
      return preflightProof();
    },
    executeOrder: async () => {
      submitCalls += 1;
      return {};
    },
  });

  assert.equal(result.error, "carry_entry_private_prime_readiness_unproven");
  assert.equal(result.private_prime_readiness.no_submit_ready, false);
  assert.equal(preflightCalls, 0);
  assert.equal(submitCalls, 0);
});

test("executes every qualified Hyperliquid, Lighter, and Aster pair through one contract", async (t) => {
  const pairs = [
    { long: "hyperliquid", short: "lighter" },
    { long: "hyperliquid", short: "aster" },
    { long: "lighter", short: "aster" },
  ];
  for (const pair of pairs) {
    const fixture = await setup(t, `pair-${pair.long}-${pair.short}`, pair);
    const calls = [];
    const result = await executeStoredCarryEntry({
      ...fixture,
      executeOrder: async (args) => { calls.push(args); return filledReceipt(args); },
    });
    assert.equal(result.ok, true, `${pair.long}/${pair.short}: ${result.error || "unknown"}`);
    assert.equal(result.saga.status, "reconciled");
    assert.deepEqual(calls.map((call) => call.venue_id), [pair.long, pair.short]);
    assert.equal(calls.every((call) => call.execution.owner_commitment === OWNER), true);
    assert.equal(calls.every((call) => call.execution.encrypted_execution_vault?.ciphertext === `sealed:${call.venue_id}`), true);
  }
});

test("recovery work is bounded-concurrent and failure-isolated", async () => {
  const exiting = ["alpha", "bravo", "charlie"].map((name) => ({
    owner_commitment: OWNER,
    exit_saga_id: `saga:carry:exit:${name}`,
    position: { position_id: `carry:position:${name}`, status: "exiting" },
  }));
  let active = 0;
  let maximumActive = 0;
  const state = {
    listCarryPositionRecords: async ({ status }) => status === "exiting" ? exiting : [],
    getMultiLegSaga: async (sagaId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (sagaId.endsWith(":bravo")) throw Object.assign(new Error("venue_timeout"), { code: "venue_timeout" });
        return { status: "recovering" };
      } finally {
        active -= 1;
      }
    },
  };

  const result = await runCarryExecutionTick({
    state,
    env: { PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY: "2" },
  });

  assert.equal(result.checked, 3);
  assert.equal(result.ok, false);
  assert.equal(maximumActive, 2);
  assert.deepEqual(result.results.map((item) => item.position_id), [
    "carry:position:alpha",
    "carry:position:bravo",
    "carry:position:charlie",
  ]);
  assert.equal(result.results[0].pending, true);
  assert.equal(result.results[1].error, "venue_timeout");
  assert.equal(result.results[2].pending, true);
});

test("bootstraps one capped candidate only after separate qualification confirmation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-executor-qualification-pilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const positionId = "carry:position:executor:qualification-pilot";
  const env = {
    PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: "true",
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "true",
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC: "11000000",
    PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456",
  };
  const access = (venueId) => ({
    status: "ready",
    owner_commitment: OWNER,
    account_commitment: `account:${venueId}:pilot`,
    vault_commitment: `vault:${venueId}:pilot`,
    encrypted_vault_commitment: `encrypted:${venueId}:pilot`,
    policy_commitment: `policy:${venueId}:pilot`,
    encrypted_execution_vault: { ciphertext: `sealed:${venueId}:pilot` },
  });
  const pilotInputEvidence = carryOpportunityInputEvidence("hyperliquid", "aster");
  const pilotOpportunity = authenticatedOpportunity({
    ...opportunity(),
    long_venue_id: "hyperliquid",
    short_venue_id: "aster",
    input_evidence: pilotInputEvidence,
    long_margin_model: pilotInputEvidence.legs[0].margin_model,
    short_margin_model: pilotInputEvidence.legs[1].margin_model,
    long_liquidation_model: pilotInputEvidence.legs[0].liquidation_model,
    short_liquidation_model: pilotInputEvidence.legs[1].liquidation_model,
    live_creation_ready: false,
    qualification_pilot_ready: true,
    qualification_pilot_candidate_venue_id: "aster",
  });
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await signedCarryPositionInput({
      ...positionInput(positionId),
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      opportunity_evidence_commitment: pilotOpportunity.worker_authentication.evidence_commitment,
    }, { ownerCommitment: OWNER, nowMs: NOW }),
    opportunity: pilotOpportunity,
    monitoring_context: { version: 1, venue_access: { hyperliquid: access("hyperliquid"), aster: access("aster") } },
    qualification_pilot: { enabled: true, candidate_venue_id: "aster" },
    env,
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  const proof = {
    version: 1,
    transaction_broadcast: false,
    no_submit_ready: true,
    live_creation_ready: false,
    qualification_pilot_ready: true,
    qualification_pilot_candidate_venue_id: "aster",
    evidence: [
      { ...preflightLeg("hyperliquid", "buy", false), account_commitment: "account:hyperliquid:pilot", verification_commitment: "verify_hyperliquid_pilot", checks: { account_state_checked: true, order_request_checked: true }, authority_boundary: { venue_native_trade_only: true } },
      { ...preflightLeg("aster", "sell", false), account_commitment: "account:aster:pilot", verification_commitment: "verify_aster_pilot", checks: { account_state_checked: true, order_request_checked: true }, authority_boundary: { venue_native_trade_only: true } },
    ],
  };
  const args = {
    state,
    owner_commitment: OWNER,
    position_id: positionId,
    recipient: {},
    verifyOrder: async () => ({}),
    preflight: async () => proof,
    executeOrder: async (order) => {
      const receipt = qualificationReceipt(order);
      await state.putIdempotency(order.work_order_commitment, receipt);
      await state.putExecutionAttempt(order.work_order_commitment, {
        venue_id: order.venue_id,
        account_commitment: receipt.account_commitment,
        submit_count: 1,
        ambiguity_retry_count: 0,
        status: receipt.status,
        provider_ref_seed: { provider_ref_commitment: receipt.provider_ref_commitment },
        result_seed: { result_commitment: receipt.result_commitment },
        final_proof: receipt.final_proof,
      });
      return receipt;
    },
    env,
    now: (() => { let value = NOW; return () => ++value; })(),
  };
  const unconfirmed = await executeStoredCarryEntry(args);
  assert.equal(unconfirmed.error, "carry_qualification_pilot_confirmation_required");
  const confirmed = await executeStoredCarryEntry({ ...args, qualification_confirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.record.qualification_pilot.status, "entry_started");
  const active = await state.getCarryPositionRecord(positionId);
  const exiting = await advanceStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: positionId,
    event: {
      version: 1,
      event_id: "carry:qualification:pilot:exit:0001",
      sequence: active.position.last_event_sequence + 1,
      type: "manual_exit_requested",
    },
    now_ms: args.now(),
  });
  assert.equal(exiting.ok, true);
  const closed = await executeStoredCarryExit({
    ...args,
    preflight: async ({ body }) => ({
      ...proof,
      evidence: proof.evidence.map((item) => {
        const exit = body?.phase === "exit";
        const side = exit ? (item.side === "buy" ? "sell" : "buy") : item.side;
        return {
          ...item,
          side,
          order_shape: { ...item.order_shape, side, reduce_only: exit },
        };
      }),
      account_readiness: [
        { venue_id: "hyperliquid", account_commitment: "account:hyperliquid:pilot", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
        { venue_id: "aster", account_commitment: "account:aster:pilot", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
      ],
    }),
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.record.position.status, "reconciled");
  assert.equal(closed.qualification.ok, true);
  assert.deepEqual(closed.record.final_reconciliation_evidence.venues.map((item) => ({
    venue_id: item.venue_id,
    position_count: item.position_count,
    open_order_count: item.open_order_count,
  })), [
    { venue_id: "hyperliquid", position_count: 0, open_order_count: 0 },
    { venue_id: "aster", position_count: 0, open_order_count: 0 },
  ]);
  const restarted = createWorkerState(dir);
  const restored = await readCarryVenueQualification({
    state: restarted,
    venue_id: "aster",
    now_ms: args.now(),
    env,
  });
  assert.equal(restored.proven, true);
});

test("freezes an ambiguous leg and never submits the entry again", async (t) => {
  const fixture = await setup(t, "ambiguous");
  let calls = 0;
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      calls += 1;
      if (args.venue_id === "lighter") {
        const error = new Error("submission outcome ambiguous");
        error.code = "submission_ambiguous";
        throw error;
      }
      return {
        status: "filled",
        provider_ref_commitment: "provider:aster:0001",
        final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_outcome_ambiguous");
  assert.equal(result.record.position.status, "frozen");
  assert.equal(result.record.position.retry_permitted, false);
  const retried = await executeStoredCarryEntry({ ...fixture, executeOrder: async () => { calls += 1; } });
  assert.equal(retried.error, "carry_entry_already_started");
  assert.equal(calls, 2);
});

test("restart audit freezes an in-flight opening without resubmission", async (t) => {
  const fixture = await setup(t, "restart-opening");
  const record = await fixture.state.getCarryPositionRecord(fixture.position_id);
  const opening = await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: {
      version: 1,
      event_id: "carry:restart:opening:preflight",
      sequence: record.position.last_event_sequence + 1,
      type: "preflight_passed",
      opportunity_eligible: true,
      all_venues_ready: true,
    },
    now_ms: NOW + 1,
  });
  assert.equal(opening.record.position.status, "opening");
  const restartedState = createWorkerState(fixture.state_dir);
  const audited = await auditCarryPositionsAfterRestart({ state: restartedState, now_ms: NOW + 2 });
  assert.equal(audited.ok, true);
  assert.equal(audited.frozen, 1);
  const frozen = await restartedState.getCarryPositionRecord(fixture.position_id);
  assert.equal(frozen.position.status, "frozen");
  assert.equal(frozen.position.retry_permitted, false);
  assert.deepEqual(frozen.position.next_actions, ["reconcile_only"]);
});

test("restart releases a linked entry only when its saga proves no submit occurred", async (t) => {
  const fixture = await setup(t, "restart-entry-before-submit");
  const putRecord = fixture.state.putCarryPositionRecord.bind(fixture.state);
  let crashed = false;
  fixture.state.putCarryPositionRecord = async (record, options) => {
    const stored = await putRecord(record, options);
    if (!crashed && stored.ok && record.entry_saga_id) {
      crashed = true;
      throw new Error("simulated worker crash after entry saga link");
    }
    return stored;
  };
  await assert.rejects(executeStoredCarryEntry({
    ...fixture,
    executeOrder: async () => { throw new Error("submit must not start"); },
  }), /simulated worker crash/);
  fixture.state.putCarryPositionRecord = putRecord;

  const linked = await fixture.state.getCarryPositionRecord(fixture.position_id);
  assert.equal(linked.position.status, "draft");
  assert.ok(linked.entry_saga_id);
  const linkedSaga = await fixture.state.getMultiLegSaga(linked.entry_saga_id);
  assert.equal(linkedSaga.status, "preflighting");

  fixture.state.putCarryPositionRecord = async (record, options) => record.restart_recovery
    ? { ok: false, error: "carry_record_version_conflict", record: await fixture.state.getCarryPositionRecord(fixture.position_id) }
    : putRecord(record, options);
  const conflictedAudit = await auditCarryPositionsAfterRestart({ state: fixture.state, now_ms: fixture.now() });
  assert.equal(conflictedAudit.ok, false);
  assert.equal((await fixture.state.getMultiLegSaga(linked.entry_saga_id)).status, "failed_no_submit");
  fixture.state.putCarryPositionRecord = putRecord;

  const audit = await auditCarryPositionsAfterRestart({ state: fixture.state, now_ms: fixture.now() });
  assert.equal(audit.ok, true);
  assert.equal(audit.recovered, 1, JSON.stringify(audit));
  assert.equal((await fixture.state.getMultiLegSaga(linked.entry_saga_id)).status, "failed_no_submit");
  const released = await fixture.state.getCarryPositionRecord(fixture.position_id);
  assert.equal(released.entry_saga_id, null);
  assert.equal(released.restart_recovery.transaction_broadcast, false);
  assert.equal(released.restart_recovery.retry_permitted, true);

  let submissions = 0;
  const retried = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => { submissions += 1; return filledReceipt(args); },
  });
  assert.equal(retried.ok, true);
  assert.equal(submissions, 2);
});

test("restart completes an exactly reconciled entry orphan without resubmission", async (t) => {
  const fixture = await setup(t, "restart-reconciled-entry");
  const orphan = await createReconciledEntryOrphan(fixture);
  assert.equal(orphan.record.position.status, "opening");
  assert.equal(orphan.saga.status, "reconciled");
  assert.equal(orphan.record.value_evidence.entry.status, "pending_exact_receipts");

  const restartedState = createWorkerState(fixture.state_dir);
  const audited = await auditCarryPositionsAfterRestart({
    state: restartedState,
    now_ms: fixture.now(),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(audited.ok, true, JSON.stringify(audited));
  assert.equal(audited.recovered, 1);
  assert.equal(audited.results[0].restart_action, "entry_reconciled_completed");
  assert.equal(orphan.submissions(), 2);
  const active = await restartedState.getCarryPositionRecord(fixture.position_id);
  assert.equal(active.position.status, "active");
  assert.equal(active.value_evidence.entry.status, "complete");
  assert.equal(active.lifecycle_events.filter((event) => event.type === "entry_reconciled").length, 1);
});

test("reconciled entry recovery retries after accounting without duplicating value", async (t) => {
  const fixture = await setup(t, "restart-reconciled-entry-retry");
  const orphan = await createReconciledEntryOrphan(fixture);
  const restartCutoff = orphan.saga.updated_at_ms;
  const putRecord = fixture.state.putCarryPositionRecord.bind(fixture.state);
  let parentConflict = true;
  fixture.state.putCarryPositionRecord = async (record, options) => {
    if (parentConflict && record.position.status === "active") {
      parentConflict = false;
      return { ok: false, error: "carry_record_version_conflict", record: await fixture.state.getCarryPositionRecord(fixture.position_id) };
    }
    return putRecord(record, options);
  };
  const first = await auditCarryPositionsAfterRestart({
    state: fixture.state,
    now_ms: restartCutoff,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(first.ok, false);
  assert.equal(first.results[0].error, "carry_record_version_conflict");
  const accounted = await fixture.state.getCarryPositionRecord(fixture.position_id);
  assert.equal(accounted.position.status, "opening");
  assert.equal(accounted.value_evidence.entry.status, "complete");
  const entryIds = accounted.value_ledger.entries.map((entry) => entry.entry_id);

  fixture.state.putCarryPositionRecord = putRecord;
  const listRecords = fixture.state.listCarryPositionRecords.bind(fixture.state);
  fixture.state.listCarryPositionRecords = async (input) => (await listRecords(input)).map((record) => record.position.status === "opening"
    ? { ...record, updated_at: new Date(restartCutoff + 1).toISOString() }
    : record);
  const second = await auditCarryPositionsAfterRestart({
    state: fixture.state,
    now_ms: restartCutoff,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.recovered, 1);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  assert.equal(active.position.status, "active");
  assert.deepEqual(active.value_ledger.entries.map((entry) => entry.entry_id), entryIds);
  assert.equal(new Set(entryIds).size, entryIds.length);
  assert.equal(active.lifecycle_events.filter((event) => event.type === "entry_reconciled").length, 1);

  fixture.state.listCarryPositionRecords = listRecords;
  const third = await auditCarryPositionsAfterRestart({
    state: fixture.state,
    now_ms: fixture.now() + 120_000,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(third.checked, 0);
  assert.deepEqual((await fixture.state.getCarryPositionRecord(fixture.position_id)).value_ledger.entries.map((entry) => entry.entry_id), entryIds);
});

test("reconciled entry recovery freezes when exact durable execution or value evidence is unproven", async (t) => {
  for (const scenario of ["missing", "wrong-account", "wrong-provider", "incomplete-value"]) {
    await t.test(scenario, async (t) => {
      const fixture = await setup(t, `restart-reconciled-${scenario}`);
      const orphan = await createReconciledEntryOrphan(fixture, {
        persist: scenario !== "missing",
        receiptFactory: (args) => {
          const receipt = scenario === "incomplete-value" ? incompleteLiveValueReceipt(args) : exactLiveValueReceipt(args);
          if (scenario === "wrong-account") receipt.account_commitment = "account:wrong:0001";
          return receipt;
        },
      });
      if (scenario === "wrong-provider") {
        const context = orphan.saga.execution_context.legs[0];
        const cached = await fixture.state.getIdempotency(context.work_order_commitment);
        await fixture.state.putIdempotency(context.work_order_commitment, {
          ...cached.receipt,
          provider_ref_commitment: "provider:overwritten:0001",
        });
      }
      const audited = await auditCarryPositionsAfterRestart({
        state: fixture.state,
        now_ms: fixture.now(),
        env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
      });
      assert.equal(audited.ok, true, JSON.stringify(audited));
      assert.equal(audited.recovered, 0);
      assert.equal(audited.frozen, 1);
      const frozen = await fixture.state.getCarryPositionRecord(fixture.position_id);
      assert.equal(frozen.position.status, "frozen");
      assert.equal(frozen.position.retry_permitted, false);
      assert.deepEqual(frozen.position.next_actions, ["reconcile_only"]);
      assert.equal(frozen.lifecycle_events.some((event) => event.type === "entry_reconciled"), false);
    });
  }
});

test("reconciled entry recovery freezes a one-sided partial that cannot use the paired exit", async (t) => {
  const fixture = await setup(t, "restart-reconciled-one-sided", undefined, { maxHedgeErrorMicroUsdc: 5_000_000 });
  const orphan = await createReconciledEntryOrphan(fixture, { receiptFactory: oneSidedLiveValueReceipt });
  assert.deepEqual(orphan.saga.legs.map((leg) => leg.filled_micro_usdc).sort((a, b) => a - b), [0, 5_000_000]);
  const audited = await auditCarryPositionsAfterRestart({
    state: fixture.state,
    now_ms: fixture.now(),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(audited.ok, true, JSON.stringify(audited));
  assert.equal(audited.recovered, 0);
  assert.equal((await fixture.state.getCarryPositionRecord(fixture.position_id)).position.status, "frozen");
  assert.equal(orphan.submissions(), 2);
});

test("restart routes an exactly reconciled symmetric partial entry to reduce-only exit", async (t) => {
  const fixture = await setup(t, "restart-reconciled-partial");
  const orphan = await createReconciledEntryOrphan(fixture, { receiptFactory: partialLiveValueReceipt });
  assert.equal(orphan.saga.legs.every((leg) => leg.filled_micro_usdc === 5_000_000), true);
  const audited = await auditCarryPositionsAfterRestart({
    state: fixture.state,
    now_ms: fixture.now(),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(audited.ok, true, JSON.stringify(audited));
  assert.equal(audited.recovered, 1);
  const exiting = await fixture.state.getCarryPositionRecord(fixture.position_id);
  assert.equal(exiting.position.status, "exiting");
  assert.deepEqual(exiting.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"]);
  assert.equal(orphan.submissions(), 2);
});

test("restart-frozen reconciled entry resumes active or exiting without resubmission", async (t) => {
  for (const scenario of [
    { name: "full", receiptFactory: exactLiveValueReceipt, filledMicroUsdc: 10_000_000, expectedStatus: "active" },
    { name: "symmetric-partial", receiptFactory: partialLiveValueReceipt, filledMicroUsdc: 5_000_000, expectedStatus: "exiting" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await setup(t, `restart-frozen-${scenario.name}`);
      const orphan = await createReconcilingEntryOrphan(fixture, scenario.receiptFactory);
      assert.equal(orphan.saga.status, "reconciling");
      assert.equal(orphan.submissions(), 2);

      const audited = await auditCarryPositionsAfterRestart({
        state: fixture.state,
        now_ms: fixture.now(),
        env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
      });
      assert.equal(audited.ok, true, JSON.stringify(audited));
      const frozen = await fixture.state.getCarryPositionRecord(fixture.position_id);
      assert.equal(frozen.position.status, "frozen");
      assert.equal(frozen.position.terminal_reason, "restart_detected");

      const reconciliationCalls = [];
      const recovered = await recoverDueMultiLegSagas({
        state: fixture.state,
        now_ms: fixture.now(),
        recipient: fixture.recipient,
        executeOrder: async (args) => {
          reconciliationCalls.push(args);
          return {
            status: "reconciled",
            final_proof: {
              final_venue_execution_proven: true,
              cumulative_filled_micro_usdc: scenario.filledMicroUsdc,
              broadcast_performed: true,
              target_client_order_matched: true,
            },
          };
        },
        verifyOrder: fixture.verifyOrder,
        env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
      });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(recovered.recovered[0].saga.status, "reconciled");
      assert.equal(reconciliationCalls.length, 2);
      assert.equal(reconciliationCalls.every((call) => call.operation_class === "reconcile"), true);

      const restartedState = createWorkerState(fixture.state_dir);
      const synchronized = await runCarryExecutionTick({
        ...fixture,
        state: restartedState,
        env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
        executeOrder: async () => {
          throw new Error("restart-frozen parent must not resubmit entry");
        },
      });
      assert.equal(synchronized.ok, true, JSON.stringify(synchronized));
      assert.equal(synchronized.results[0].restart_action, "entry_reconciled_completed");
      assert.equal(synchronized.results[0].record.position.status, scenario.expectedStatus);
      assert.equal(orphan.submissions(), 2);
      if (scenario.expectedStatus === "active") {
        assert.deepEqual(synchronized.results[0].record.position.next_actions, ["monitor_carry_and_margin"]);
        assert.equal(synchronized.results[0].record.position.terminal_reason, null);
      } else {
        assert.deepEqual(synchronized.results[0].record.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"]);
        assert.equal(synchronized.results[0].record.position.terminal_reason, "entry_hedge_mismatch");
      }
    });
  }
});

test("restart safely retries an exit linked before any submission", async (t) => {
  const fixture = await setup(t, "restart-exit-before-submit");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:restart-pre-submit", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: fixture.now(),
  });
  const putRecord = fixture.state.putCarryPositionRecord.bind(fixture.state);
  let crashed = false;
  fixture.state.putCarryPositionRecord = async (record, options) => {
    const stored = await putRecord(record, options);
    if (!crashed && stored.ok && record.exit_saga_id) {
      crashed = true;
      throw new Error("simulated worker crash after exit saga link");
    }
    return stored;
  };
  await assert.rejects(executeStoredCarryExit({
    ...fixture,
    executeOrder: async () => { throw new Error("submit must not start"); },
  }), /simulated worker crash/);
  fixture.state.putCarryPositionRecord = putRecord;

  const linked = await fixture.state.getCarryPositionRecord(fixture.position_id);
  const abandonedSagaId = linked.exit_saga_id;
  assert.equal(linked.position.status, "exiting");
  const audit = await auditCarryPositionsAfterRestart({ state: fixture.state, now_ms: fixture.now() });
  assert.equal(audit.ok, true);
  assert.equal(audit.recovered, 1);
  assert.equal((await fixture.state.getMultiLegSaga(abandonedSagaId)).status, "failed_no_submit");
  assert.equal((await fixture.state.getCarryPositionRecord(fixture.position_id)).exit_saga_id, null);

  let submissions = 0;
  const closed = await executeStoredCarryExit({
    ...fixture,
    executeOrder: async (args) => {
      submissions += 1;
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(closed.ok, true);
  assert.equal(submissions, 2);
  assert.equal(closed.record.position.status, "reconciled");
  assert.equal(closed.record.final_reconciliation_evidence.open_order_count, 0);
});

test("terminal entry recovery synchronizes flat parent after restart without resubmission", async (t) => {
  const fixture = await setup(t, "restart-recovered-flat");
  let submissions = 0;
  const started = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      submissions += 1;
      if (args.venue_id === "lighter") {
        const error = new Error("submission outcome ambiguous");
        error.code = "submission_ambiguous";
        throw error;
      }
      return filledReceipt(args);
    },
  });
  assert.equal(started.record.position.status, "frozen");
  let saga = await fixture.state.getMultiLegSaga(started.saga.saga_id);
  saga = (await applyDurableMultiLegEvent({
    state: fixture.state,
    saga_id: saga.saga_id,
    now_ms: saga.unhedged_deadline_ms,
    event: {
      version: 1,
      event_id: "carry:restart:recovery:timeout",
      sequence: saga.last_event_sequence + 1,
      type: "timeout",
    },
  })).saga;
  const filledLeg = saga.legs.find((leg) => leg.filled_micro_usdc > 0);
  const uncertainLeg = saga.legs.find((leg) => leg.filled_micro_usdc === 0);
  saga = (await applyDurableMultiLegEvent({
    state: fixture.state,
    saga_id: saga.saga_id,
    now_ms: saga.updated_at_ms + 1,
    event: {
      version: 1,
      event_id: "carry:restart:recovery:cancel",
      sequence: saga.last_event_sequence + 1,
      type: "cancel_confirmed",
      leg_id: uncertainLeg.leg_id,
      cumulative_filled_micro_usdc: 0,
    },
  })).saga;
  saga = (await applyDurableMultiLegEvent({
    state: fixture.state,
    saga_id: saga.saga_id,
    now_ms: saga.updated_at_ms + 1,
    event: {
      version: 1,
      event_id: "carry:restart:recovery:unwind",
      sequence: saga.last_event_sequence + 1,
      type: "unwind_fill",
      leg_id: filledLeg.leg_id,
      cumulative_filled_micro_usdc: filledLeg.filled_micro_usdc,
    },
  })).saga;
  assert.equal(saga.status, "unwound");
  const restartedState = createWorkerState(fixture.state_dir);
  const uncertain = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
    preflight: async () => ({
      ...preflightProof(),
      account_readiness: [
        { venue_id: "aster", account_commitment: "account:aster:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
        { venue_id: "lighter", account_commitment: "account:lighter:0001", authorized: true, flat_zero_orders: false, position_count: 1, open_order_count: 0 },
      ],
    }),
    executeOrder: async () => { submissions += 1; throw new Error("unexpected submit"); },
  });
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.results[0].error, "carry_recovery_exposure_requires_owner_review");
  assert.equal((await restartedState.getCarryPositionRecord(fixture.position_id)).position.status, "frozen");
  assert.equal(submissions, 2);
  const synced = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
    executeOrder: async () => { submissions += 1; throw new Error("unexpected submit"); },
  });
  assert.equal(synced.ok, true);
  assert.equal(submissions, 2);
  assert.equal(synced.results[0].record.position.status, "reconciled");
  assert.equal(synced.results[0].record.final_reconciliation_evidence.open_order_count, 0);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.account_state_checked, true);
});

test("aborted entry recovery finalizes exact fees, slippage, and round-trip value", async (t) => {
  const fixture = await setup(t, "aborted-entry-value");
  const started = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      if (args.venue_id === "lighter") {
        const error = new Error("submission outcome ambiguous");
        error.code = "submission_ambiguous";
        throw error;
      }
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(started.record.position.status, "frozen");
  const recovered = await recoverDueMultiLegSagas({
    state: fixture.state,
    now_ms: started.saga.unhedged_deadline_ms,
    recipient: fixture.recipient,
    verifyOrder: fixture.verifyOrder,
    fetchImpl: async () => ({ ok: true, json: async () => ({ markPrice: "10000" }) }),
    env: fixture.env,
    executeOrder: async (args) => {
      if (args.operation_class === "cancel") return { status: "cancelled" };
      if (args.operation_class === "reconcile") return { status: "reconciled", fills: [] };
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "unwound");
  const restartedState = createWorkerState(fixture.state_dir);
  const reconciled = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.results[0].record.position.status, "reconciled");
  assert.equal(reconciled.results[0].record.value_evidence.aborted_entry_recovery.status, "complete");
  assert.equal(reconciled.results[0].record.value_ledger.status, "open");
  const finalizedState = createWorkerState(fixture.state_dir);
  const synced = await runCarryExecutionTick({
    ...fixture,
    state: finalizedState,
    readFundingSettlements: async () => [],
  });
  assert.equal(synced.ok, true);
  const record = synced.results[0].record;
  assert.equal(record.position.status, "reconciled");
  assert.equal(record.value_evidence.aborted_entry_recovery.status, "complete");
  assert.equal(record.value_evidence.aborted_entry_recovery.contract_pnl_micro_usdc, 9_000);
  assert.equal(record.value_evidence.costs_complete, true);
  assert.equal(record.value_ledger.status, "finalized");
  assert.equal(record.value_ledger.realized.trading_fee_micro_usdc, 6_000);
  assert.equal(record.value_ledger.realized.slippage_micro_usdc, 1_000);
  assert.equal(record.value_ledger.realized.settlement_adjustment_micro_usdc, 10_000);
  assert.equal(record.value_ledger.realized.net_value_micro_usdc, 3_000);
});

test("records a fully rejected pair as flat with no recovery order", async (t) => {
  const fixture = await setup(t, "no-fill");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async () => { throw new Error("venue rejected order"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_failed_no_fill");
  assert.equal(result.record.position.status, "reconciled");
  assert.equal(result.record.position.terminal_reason, "entry_failed_no_fill");
});

test("records only receipt-proven fees and adverse slippage", async (t) => {
  const fixture = await setup(t, "exact-value-evidence");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => ({
      ...filledReceipt(args),
      fills: [{
        size: "0.001",
        price: args.venue_id === "aster" ? "10001" : "9999",
        fee: args.venue_id === "aster" ? "0.003" : "0.004",
        fee_asset: carryFeeSettlementAsset(args.venue_id),
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.record.value_ledger.entries.length, 4);
  assert.equal(result.record.value_ledger.realized.trading_fee_micro_usdc, 7_000);
  assert.equal(result.record.value_ledger.realized.slippage_micro_usdc, 2_000);
});

test("values non-USDC execution fees and slippage with verified conservative rates", async (t) => {
  const fixture = await setup(t, "stablecoin-execution-value");
  const proof = preflightProof();
  proof.evidence = proof.evidence.map((leg) => ({
    ...leg,
    asset_valuations: leg.asset_valuations.map((valuation) => executionCashflowValuation(
      valuation.source_asset,
      NOW,
      valuation.source_asset === "USDT"
        ? { credit_rate_e8: 99_000_000, debit_rate_e8: 101_000_000 }
        : { credit_rate_e8: 98_000_000, debit_rate_e8: 102_000_000 },
    )),
  }));
  const result = await executeStoredCarryEntry({
    ...fixture,
    preflight: async () => proof,
    executeOrder: async (args) => exactValueReceipt(args),
  });
  assert.equal(result.ok, true);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.record.value_ledger.realized.trading_fee_micro_usdc, 7_030);
  assert.equal(result.record.value_ledger.realized.slippage_micro_usdc, 2_030);
  assert.equal(result.record.value_evidence.entry.venues.aster.fee_source_asset, "USDT");
  assert.match(result.record.value_evidence.entry.venues.aster.fee_valuation_commitment, /^carry:cashflow-valuation:evidence:[0-9a-f]{64}$/);
});

test("routes equal partial IOC entry fills into a deterministic reduce-only exit", async (t) => {
  const fixture = await setup(t, "equal-partial-entry");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async () => ({
      status: "filled",
      provider_ref_commitment: "provider:partial:0001",
      final_proof: {
        final_venue_execution_proven: true,
        final_fill_proven: false,
        cumulative_filled_micro_usdc: 5_000_000,
        filled_base_size: "0.0005",
        open_order_count: 0,
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_requires_recovery");
  assert.equal(result.saga.status, "reconciled");
  assert.deepEqual(result.saga.legs.map((leg) => leg.filled_micro_usdc), [5_000_000, 5_000_000]);
  assert.equal(result.record.position.long_filled_micro_usdc, 5_000_000);
  assert.equal(result.record.position.short_filled_micro_usdc, 5_000_000);
  assert.equal(result.record.position.status, "exiting");
  assert.deepEqual(result.record.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"]);
});

test("restart closes a symmetric partial entry once and remains proven flat with zero orders", async (t) => {
  const pair = { long: "aster", short: "lighter" };
  const fixture = await setup(t, "restart-partial-to-flat", pair);
  const submissionCounts = new Map();
  const calls = [];
  const recordSubmission = (args) => {
    calls.push(args);
    const count = (submissionCounts.get(args.work_order_commitment) || 0) + 1;
    submissionCounts.set(args.work_order_commitment, count);
    assert.equal(count, 1, `duplicate submission: ${args.work_order_commitment}`);
  };
  const partialReceipt = (args) => {
    const receipt = exactLiveValueReceipt(args);
    return {
      ...receipt,
      fills: [{
        ...receipt.fills[0],
        size: "0.0005",
      }],
      final_proof: {
        ...receipt.final_proof,
        cumulative_filled_micro_usdc: 5_000_000,
        filled_base_size: "0.0005",
      },
    };
  };
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      recordSubmission(args);
      const receipt = partialReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "carry_entry_requires_recovery");
  assert.equal(entry.record.position.status, "exiting");

  const restartedState = createWorkerState(fixture.state_dir);
  const preflight = async ({ body }) => {
    const proof = preflightProof(pair, { phase: body?.phase });
    if (body?.phase !== "exit") return proof;
    return {
      ...proof,
      evidence: proof.evidence.map((item) => ({
        ...item,
        order_shape: {
          ...item.order_shape,
          base_size: body.exit_base_size_by_venue[item.venue_id],
        },
      })),
    };
  };
  const exited = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
    preflight,
    executeOrder: async (args) => {
      recordSubmission(args);
      const receipt = partialReceipt(args);
      await restartedState.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(exited.ok, true, JSON.stringify(exited));
  assert.equal(exited.checked, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls.slice(0, 2).every((call) => call.instruction.order.reduce_only === false), true);
  assert.equal(calls.slice(2).every((call) => call.instruction.order.reduce_only === true), true);
  assert.deepEqual(calls.slice(2).map((call) => call.instruction.order.base_size), ["0.0005", "0.0005"]);

  const terminal = exited.results[0].record;
  assert.equal(terminal.position.status, "reconciled");
  assert.equal(terminal.final_reconciliation_evidence.gross_exposure_micro_usdc, 0);
  assert.equal(terminal.final_reconciliation_evidence.open_order_count, 0);
  assert.equal(terminal.final_reconciliation_evidence.venues.length, 2);
  assert.equal(terminal.final_reconciliation_evidence.venues.every((venue) =>
    venue.position_count === 0 && venue.open_order_count === 0), true);

  const submissionsBeforeSecondRestart = calls.length;
  const secondRestart = createWorkerState(fixture.state_dir);
  const replay = await runCarryExecutionTick({
    ...fixture,
    state: secondRestart,
    preflight,
    executeOrder: async (args) => {
      recordSubmission(args);
      throw new Error("terminal Carry must not resubmit");
    },
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.checked, 0);
  assert.equal(calls.length, submissionsBeforeSecondRestart);
  assert.equal(submissionCounts.size, 4);
  assert.equal([...submissionCounts.values()].every((count) => count === 1), true);
});

test("restart recovery closes only the failed leg of a symmetric partial entry", async (t) => {
  const pair = { long: "aster", short: "lighter" };
  const fixture = await setup(t, "restart-partial-exit-recovery", pair);
  const partialReceipt = (args) => {
    const receipt = exactLiveValueReceipt(args);
    return {
      ...receipt,
      fills: [{ ...receipt.fills[0], size: "0.0005" }],
      final_proof: {
        ...receipt.final_proof,
        cumulative_filled_micro_usdc: 5_000_000,
        filled_base_size: "0.0005",
      },
    };
  };
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = partialReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "carry_entry_requires_recovery");
  assert.equal(entry.record.position.status, "exiting");

  const preflight = async ({ body }) => {
    const proof = preflightProof(pair, { phase: body?.phase });
    if (body?.phase !== "exit") return proof;
    return {
      ...proof,
      evidence: proof.evidence.map((item) => ({
        ...item,
        order_shape: {
          ...item.order_shape,
          base_size: body.exit_base_size_by_venue[item.venue_id],
        },
      })),
    };
  };
  const restartedState = createWorkerState(fixture.state_dir);
  const exitAttempts = [];
  const started = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
    preflight,
    executeOrder: async (args) => {
      exitAttempts.push(args);
      if (args.venue_id === "lighter") throw new Error("venue rejected order");
      const receipt = partialReceipt(args);
      await restartedState.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(started.ok, false);
  assert.equal(started.results[0].ok, false);
  assert.equal(started.results[0].error, "carry_exit_requires_recovery");
  assert.equal(exitAttempts.length, 2);
  assert.deepEqual(exitAttempts.map((call) => call.instruction.order.quote_size), ["5", "5"]);
  assert.deepEqual(exitAttempts.map((call) => call.instruction.order.base_size), ["0.0005", "0.0005"]);

  const recoveryCalls = [];
  const recovered = await recoverDueMultiLegSagas({
    state: restartedState,
    now_ms: started.results[0].saga.unhedged_deadline_ms - 1,
    recipient: fixture.recipient,
    executeOrder: async (args) => {
      recoveryCalls.push(args);
      return partialReceipt(args);
    },
    verifyOrder: fixture.verifyOrder,
    env: fixture.env,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "reconciled");
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].venue_id, "lighter");
  assert.equal(recoveryCalls[0].instruction.order.reduce_only, true);
  assert.equal(recoveryCalls[0].instruction.order.quote_size, "5");
  assert.equal(recoveryCalls[0].instruction.order.base_size, "0.0005");

  const finalState = createWorkerState(fixture.state_dir);
  const synced = await runCarryExecutionTick({
    ...fixture,
    state: finalState,
    preflight,
    readFundingSettlements: async () => [],
    executeOrder: async () => {
      throw new Error("reconciled partial exit must not resubmit");
    },
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.results[0].record.position.status, "reconciled");
  assert.equal(synced.results[0].record.final_reconciliation_evidence.gross_exposure_micro_usdc, 0);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.open_order_count, 0);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.venues.every((venue) =>
    venue.position_count === 0 && venue.open_order_count === 0), true);
});

test("closes both reconciled legs reduce-only and proves flat with zero orders", async (t) => {
  const fixture = await setup(t, "exit-success");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:success", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const calls = [];
  const result = await executeStoredCarryExit({
    ...fixture,
    executeOrder: async (args) => {
      calls.push(args);
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "reconciled");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.instruction.order.reduce_only === true), true);
  assert.deepEqual(calls.map((call) => call.instruction.order.side).sort(), ["buy", "sell"]);
  assert.equal(result.record.final_reconciliation_evidence.account_state_checked, true);
  assert.equal(result.record.final_reconciliation_evidence.open_order_count, 0);
});

test("preserves the exact high-precision entry quantity through reduce-only exit", async (t) => {
  const fixture = await setup(t, "exit-high-precision");
  const exactBase = "0.0010000000000000001";
  const exactPreflight = async ({ body }) => {
    if (body?.phase === "exit") {
      assert.deepEqual(body.exit_base_size_by_venue, {
        aster: exactBase,
        lighter: exactBase,
      });
    }
    const proof = preflightProof(undefined, { phase: body?.phase });
    return {
      ...proof,
      evidence: proof.evidence.map((item) => ({
        ...item,
        order_shape: { ...item.order_shape, base_size: exactBase },
      })),
    };
  };
  const receipt = async (args) => {
    const result = filledReceipt(args);
    result.final_proof.filled_base_size = exactBase;
    await fixture.state.putIdempotency(args.work_order_commitment, result);
    return result;
  };

  const entry = await executeStoredCarryEntry({
    ...fixture,
    preflight: exactPreflight,
    executeOrder: receipt,
  });
  assert.equal(entry.ok, true);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:high-precision", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });

  const calls = [];
  const result = await executeStoredCarryExit({
    ...fixture,
    preflight: exactPreflight,
    executeOrder: async (args) => {
      calls.push(args);
      return receipt(args);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "reconciled");
  assert.deepEqual(calls.map((call) => call.instruction.order.base_size), [exactBase, exactBase]);
});

test("a failed exit leg completes reduce-only after recovery, syncs flat, and finalizes realized value", async (t) => {
  const fixture = await setup(t, "exit-recovery");
  const submissionCounts = new Map();
  const submit = (args) => {
    const count = (submissionCounts.get(args.work_order_commitment) || 0) + 1;
    submissionCounts.set(args.work_order_commitment, count);
    assert.equal(count, 1, `duplicate submission: ${args.work_order_commitment}`);
  };
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      submit(args);
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.accounting.complete, true);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:recovery", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const started = await executeStoredCarryExit({
    ...fixture,
    executeOrder: async (args) => {
      submit(args);
      if (args.venue_id === "lighter") throw new Error("venue rejected order");
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(started.ok, false);
  assert.equal(started.error, "carry_exit_requires_recovery");
  assert.equal(started.saga.recovery_mode, "complete_reduce_only");
  const restartedState = createWorkerState(fixture.state_dir);
  const recovered = await recoverDueMultiLegSagas({
    state: restartedState,
    now_ms: started.saga.unhedged_deadline_ms - 1,
    recipient: fixture.recipient,
    executeOrder: async (args) => {
      submit(args);
      return exactValueReceipt(args);
    },
    verifyOrder: fixture.verifyOrder,
    env: fixture.env,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "reconciled");
  assert.equal([...submissionCounts.values()].every((count) => count === 1), true);

  const secondRestart = createWorkerState(fixture.state_dir);
  const recoveredAgain = await recoverDueMultiLegSagas({
    state: secondRestart,
    now_ms: started.saga.unhedged_deadline_ms + 1,
    recipient: fixture.recipient,
    executeOrder: async (args) => {
      submit(args);
      throw new Error("terminal recovery must not resubmit");
    },
    verifyOrder: fixture.verifyOrder,
    env: fixture.env,
  });
  assert.equal(recoveredAgain.ok, true);
  assert.equal(recoveredAgain.recovered.length, 0);

  const synced = await runCarryExecutionTick({
    ...fixture,
    state: secondRestart,
    readFundingSettlements: async () => [],
    executeOrder: async (args) => {
      submit(args);
      throw new Error("terminal Carry must not resubmit");
    },
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.results[0].record.position.status, "reconciled");
  assert.equal(synced.results[0].record.final_reconciliation_evidence.account_state_checked, true);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.gross_exposure_micro_usdc, 0);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.open_order_count, 0);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.venues.length, 2);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.venues.every((venue) =>
    venue.position_count === 0 && venue.open_order_count === 0), true);
  assert.equal(synced.results[0].accounting.complete, true);
  assert.equal(synced.results[0].value_finalized, true);
  assert.equal(synced.results[0].record.value_ledger.status, "finalized");
  assert.equal(synced.results[0].record.value_ledger.realized.net_value_micro_usdc, 4_000);
  assert.equal(submissionCounts.size, 5);
  assert.equal([...submissionCounts.values()].every((count) => count === 1), true);
});

test("does not claim a recovered exit is flat when a venue omits exact account counts", async (t) => {
  const fixture = await setup(t, "exit-proof-pending");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:proof-pending", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const preflight = async ({ body }) => ({
    ...preflightProof(undefined, { phase: body?.phase }),
    account_readiness: [
      { venue_id: "aster", account_commitment: "account:aster:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
      { venue_id: "lighter", account_commitment: "account:lighter:0001", authorized: true, flat_zero_orders: false, position_count: null, open_order_count: 0 },
    ],
  });
  const result = await executeStoredCarryExit({
    ...fixture,
    preflight,
    executeOrder: async (args) => {
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_exit_final_account_proof_unavailable");
  assert.equal(result.record.position.status, "exiting");
  assert.equal(result.record.exit_verification.status, "pending");
  assert.equal(result.record.final_reconciliation_evidence, undefined);
});

test("does not claim flat when account proof belongs to another venue account", async (t) => {
  const fixture = await setup(t, "exit-account-mismatch");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:account-mismatch", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const proof = preflightProof(undefined, { phase: "exit" });
  proof.account_readiness[1].account_commitment = "account:lighter:wrong:0001";
  const result = await executeStoredCarryExit({
    ...fixture,
    preflight: async () => proof,
    executeOrder: async (args) => {
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_exit_final_account_proof_unavailable");
  assert.equal(result.record.final_reconciliation_evidence, undefined);
});

test("finalizes modeled-versus-realized value only after exact costs, funding, and flat proof", async (t) => {
  const fixture = await setup(t, "final-value-ledger");
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.accounting.complete, true);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:final-ledger", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const result = await executeStoredCarryExit({
    ...fixture,
    readFundingSettlements: async ({ body }) => [fundingSettlement(
      body,
      body.venue_id === "aster" ? "0.020" : "-0.005",
      "final:1",
    )],
    executeOrder: async (args) => {
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value_finalized, true);
  assert.equal(result.record.value_ledger.status, "finalized");
  assert.equal(result.record.value_ledger.realized.funding_credit_micro_usdc, 20_000);
  assert.equal(result.record.value_ledger.realized.funding_debit_micro_usdc, 5_000);
  assert.equal(result.record.value_ledger.realized.trading_fee_micro_usdc, 14_000);
  assert.equal(result.record.value_ledger.realized.net_value_micro_usdc, 19_000);
  assert.equal(result.record.value_ledger.realized.attribution.status, "finalized");
  assert.equal(result.record.value_ledger.realized.attribution.trading_fee_micro_usdc, -12_000);
  assert.equal(result.record.value_ledger.realized.attribution.net_value_micro_usdc, -1_000);
  assert.equal(result.record.value_ledger.finalization_evidence.open_order_count, 0);
});

test("background monitoring triggers an automatic reduce-only exit and finalizes flat value evidence", async (t) => {
  const fixture = await setup(t, "automatic-monitored-exit");
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, true);

  const monitoringProof = async ({ body, now }) => exitAwareMonitoringProof(undefined, body, now());
  const firstMonitor = await runCarryMonitoringTick({
    state: fixture.state,
    preflight: monitoringProof,
    now_ms: NOW + 100,
  });
  assert.equal(firstMonitor.ok, true);
  assert.equal(firstMonitor.results[0].record.position.status, "active");
  assert.equal(firstMonitor.results[0].record.latest_observation.account_state_evidence.length, 2);
  assert.equal(firstMonitor.results[0].record.latest_observation.account_state_evidence.every((item) =>
    item.account_state_commitment === carryAccountStateCommitment(item)), true);
  const secondMonitor = await runCarryMonitoringTick({
    state: fixture.state,
    preflight: monitoringProof,
    now_ms: NOW + 200,
  });
  assert.equal(secondMonitor.ok, true);
  assert.equal(secondMonitor.results[0].record.position.status, "exiting");
  assert.equal(secondMonitor.results[0].record.exit_saga_id, undefined);

  const restartedState = createWorkerState(fixture.state_dir);
  const calls = [];
  const exit = await runCarryExecutionTick({
    ...fixture,
    state: restartedState,
    preflight: monitoringProof,
    now: (() => { let value = NOW + 1_000; return () => ++value; })(),
    readFundingSettlements: async ({ body }) => [fundingSettlement(
      body,
      body.venue_id === "aster" ? "0.020" : "-0.005",
      "automatic-exit:1",
    )],
    executeOrder: async (args) => {
      calls.push(args);
      const receipt = exactValueReceipt(args);
      await restartedState.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(exit.ok, true);
  assert.equal(exit.checked, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.instruction.order.reduce_only === true), true);
  const result = exit.results[0];
  assert.equal(result.record.position.status, "reconciled");
  assert.equal(result.record.final_reconciliation_evidence.account_state_checked, true);
  assert.equal(result.record.final_reconciliation_evidence.open_order_count, 0);
  assert.equal(result.value_finalized, true);
  assert.equal(result.record.value_ledger.status, "finalized");
  assert.equal(result.record.value_ledger.realized.net_value_micro_usdc, 19_000);
});

test("completes a supervised restart-to-flat lifecycle for every qualified venue pair", async (t) => {
  const pairs = [
    { long: "hyperliquid", short: "lighter" },
    { long: "hyperliquid", short: "aster" },
    { long: "lighter", short: "aster" },
  ];
  for (const pair of pairs) {
    const label = `${pair.long}-${pair.short}`;
    const fixture = await setup(t, `automatic-matrix-${label}`, pair);
    const entry = await executeStoredCarryEntry({
      ...fixture,
      executeOrder: async (args) => {
        const receipt = exactValueReceipt(args);
        await fixture.state.putIdempotency(args.work_order_commitment, receipt);
        return receipt;
      },
    });
    assert.equal(entry.ok, true, `${label}: entry ${entry.error || "failed"}`);

    const monitoringProof = async ({ body, now }) => exitAwareMonitoringProof(pair, body, now());
    const firstMonitor = await runCarryMonitoringTick({
      state: fixture.state,
      preflight: monitoringProof,
      now_ms: NOW + 100,
    });
    assert.equal(firstMonitor.results[0].record.position.status, "active", `${label}: first observation`);
    assert.deepEqual(
      firstMonitor.results[0].record.latest_observation.account_state_evidence.map((item) => item.venue_id),
      [pair.long, pair.short],
      `${label}: account-state lineage`,
    );
    const secondMonitor = await runCarryMonitoringTick({
      state: fixture.state,
      preflight: monitoringProof,
      now_ms: NOW + 200,
    });
    assert.equal(secondMonitor.results[0].record.position.status, "exiting", `${label}: signed exit trigger`);

    const restartedState = createWorkerState(fixture.state_dir);
    const calls = [];
    const exit = await runCarryExecutionTick({
      ...fixture,
      state: restartedState,
      preflight: monitoringProof,
      now: (() => { let value = NOW + 1_000; return () => ++value; })(),
      readFundingSettlements: async ({ body }) => [fundingSettlement(
        body,
        body.venue_id === pair.long ? "0.020" : "-0.005",
        "automatic-matrix:1",
      )],
      executeOrder: async (args) => {
        calls.push(args);
        const receipt = exactValueReceipt(args);
        await restartedState.putIdempotency(args.work_order_commitment, receipt);
        return receipt;
      },
    });
    assert.equal(exit.ok, true, `${label}: exit tick`);
    assert.deepEqual(calls.map((call) => call.venue_id), [pair.long, pair.short]);
    assert.equal(calls.every((call) => call.instruction.order.reduce_only === true), true);
    const result = exit.results[0];
    assert.equal(result.record.position.status, "reconciled", `${label}: reconciled`);
    assert.equal(result.record.final_reconciliation_evidence.gross_exposure_micro_usdc, 0);
    assert.equal(result.record.final_reconciliation_evidence.open_order_count, 0);
    assert.equal(result.record.final_reconciliation_evidence.venues.every((venue) =>
      venue.position_count === 0 && venue.open_order_count === 0), true);
    assert.equal(result.record.value_ledger.status, "finalized", `${label}: finalized value`);
  }
});

async function setup(t, suffix, pair = { long: "aster", short: "lighter" }, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ghola-carry-executor-${suffix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const positionId = `carry:position:executor:${suffix}`;
  const creationOpportunity = opportunity(pair);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await signedCarryPositionInput(positionInput(
      positionId,
      pair,
      creationOpportunity.worker_authentication.evidence_commitment,
      options,
    ), {
      ownerCommitment: OWNER,
      nowMs: NOW,
    }),
    opportunity: creationOpportunity,
    monitoring_context: monitoringContext(pair),
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  return {
    state,
    state_dir: dir,
    owner_commitment: OWNER,
    position_id: positionId,
    recipient: { recipient_id: "did:key:carry-executor" },
    verifyOrder: async (args) => recoveryVerification(args),
    preflight: async ({ body }) => preflightProof(pair, { phase: body?.phase }),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
    now: (() => { let value = NOW + 1; return () => value += 1; })(),
  };
}

function positionInput(
  positionId,
  pair = { long: "aster", short: "lighter" },
  opportunityEvidenceCommitment = null,
  { maxHedgeErrorMicroUsdc = 0 } = {},
) {
  return {
    version: 1,
    position_id: positionId,
    mandate_id: `carry:mandate:executor:${positionId.split(":").at(-1)}`,
    asset: "BTC",
    long_venue_id: pair.long,
    short_venue_id: pair.short,
    target_notional_micro_usdc: 10_000_000,
    ...(opportunityEvidenceCommitment ? {
      opportunity_evidence_commitment: opportunityEvidenceCommitment,
    } : {}),
    risk_mandate: {
      min_expected_net_benefit_bps: 1,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 3_600_000,
      max_hedge_error_micro_usdc: maxHedgeErrorMicroUsdc,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: false,
    },
  };
}

function opportunity(pair = { long: "aster", short: "lighter" }) {
  const inputEvidence = carryOpportunityInputEvidence(pair.long, pair.short);
  return authenticatedOpportunity({
    version: 1,
    eligible: true,
    reasons: [],
    asset: "BTC",
    long_venue_id: pair.long,
    short_venue_id: pair.short,
    notional_micro_usdc: 10_000_000,
    capital_committed_micro_usdc: 4_000_000,
    horizon_ms: 86_400_000,
    projected_gross_funding_micro_usdc: 25_000,
    projected_funding_credit_micro_usdc: 25_000,
    projected_funding_debit_micro_usdc: 0,
    projected_trading_fee_micro_usdc: 2_000,
    projected_slippage_micro_usdc: 1_000,
    projected_gas_micro_usdc: 0,
    projected_latency_buffer_micro_usdc: 0,
    projected_trading_cost_micro_usdc: 3_000,
    projected_capital_cost_micro_usdc: 1_000,
    liquidation_fee_risk_micro_usdc: 0,
    long_initial_margin_bps: inputEvidence.legs[0].initial_margin_bps,
    short_initial_margin_bps: inputEvidence.legs[1].initial_margin_bps,
    long_maintenance_margin_bps: inputEvidence.legs[0].maintenance_margin_bps,
    short_maintenance_margin_bps: inputEvidence.legs[1].maintenance_margin_bps,
    long_liquidation_fee_bps: inputEvidence.legs[0].liquidation_fee_bps,
    short_liquidation_fee_bps: inputEvidence.legs[1].liquidation_fee_bps,
    long_margin_model: inputEvidence.legs[0].margin_model,
    short_margin_model: inputEvidence.legs[1].margin_model,
    long_liquidation_model: inputEvidence.legs[0].liquidation_model,
    short_liquidation_model: inputEvidence.legs[1].liquidation_model,
    risk_buffer_micro_usdc: 1_000,
    projected_net_value_micro_usdc: 20_000,
    projected_net_value_bps: 20,
    break_even_ms: 3_600_000,
    contract_data_skew_ms: 0,
    max_contract_data_skew_ms: 2_000,
    index_price_divergence_bps: 0,
    mark_price_divergence_bps: 0,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    economic_equivalence_id: "carry:BTC-usd-linear",
    contract_type: "linear_perp",
    long_quote_asset: carryQuoteAsset(pair.long),
    short_quote_asset: carryQuoteAsset(pair.short),
    checked_at_ms: NOW,
    all_venues_ready: true,
    live_creation_ready: true,
    long_margin_runway_ms: 7_200_000,
    short_margin_runway_ms: 7_200_000,
    input_evidence: inputEvidence,
  });
}

function authenticatedOpportunity(value) {
  const { worker_authentication: _authentication, ...unsigned } = value;
  return {
    ...unsigned,
    worker_authentication: authenticateCarryCreationOpportunity({
      owner_commitment: OWNER,
      opportunity: unsigned,
    }),
  };
}

function monitoringContext(pair = { long: "aster", short: "lighter" }) {
  const access = (venue) => ({
    status: "ready",
    owner_commitment: OWNER,
    account_commitment: `account:${venue}:0001`,
    vault_commitment: `vault:${venue}:0001`,
    encrypted_vault_commitment: `encrypted:${venue}:0001`,
    policy_commitment: `policy:${venue}:0001`,
    encrypted_execution_vault: { ciphertext: `sealed:${venue}` },
  });
  return {
    version: 1,
    venue_access: {
      [pair.long]: access(pair.long),
      [pair.short]: access(pair.short),
    },
  };
}

function preflightProof(pair = { long: "aster", short: "lighter" }, { phase = "opening" } = {}) {
  const exit = phase === "exit";
  return {
    version: 1,
    transaction_broadcast: false,
    no_submit_ready: true,
    live_creation_ready: true,
    account_readiness: [
      { venue_id: pair.long, account_commitment: `account:${pair.long}:0001`, authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
      { venue_id: pair.short, account_commitment: `account:${pair.short}:0001`, authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0 },
    ],
    evidence: [
      preflightLeg(pair.long, exit ? "sell" : "buy", exit),
      preflightLeg(pair.short, exit ? "buy" : "sell", exit),
    ],
  };
}

function preflightLeg(venueId, side, reduceOnly) {
  const quoteAsset = carryQuoteAsset(venueId);
  const feeSettlementAsset = carryFeeSettlementAsset(venueId);
  const assets = [...new Set([quoteAsset, feeSettlementAsset])].filter((asset) => asset !== "USDC");
  return {
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    side,
    transaction_broadcast: false,
    reference_mark_price_e8: 1_000_000_000_000,
    quote_asset: quoteAsset,
    funding_settlement_asset: carryFundingSettlementAsset(venueId),
    fee_settlement_asset: feeSettlementAsset,
    asset_valuations: assets.map((asset) => executionCashflowValuation(asset, NOW)),
    order_shape: {
      market: carryMarket(venueId),
      side,
      base_size: "0.001",
      limit_price: "10000",
      reduce_only: reduceOnly,
    },
  };
}

function automaticMonitoringProof(pair = { long: "aster", short: "lighter" }, checkedAtMs = NOW + 100) {
  const base = preflightProof(pair);
  const marginRunways = [
    monitoringRunway(pair.long, checkedAtMs),
    monitoringRunway(pair.short, checkedAtMs),
  ];
  return {
    ...base,
    economic_opportunity: {
      checked_at_ms: checkedAtMs,
      projected_net_value_bps: -1,
      contract_data_skew_ms: 0,
      max_contract_data_skew_ms: 2_000,
      index_price_divergence_bps: 0,
      mark_price_divergence_bps: 0,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      funding_observation: {
        evidence_commitment: `carry:funding:current:${checkedAtMs.toString(16).padStart(64, "0")}`,
        source_observed_at_ms_by_venue: {
          [pair.long]: checkedAtMs,
          [pair.short]: checkedAtMs,
        },
      },
    },
    margin_runways: marginRunways,
    evidence: base.evidence.map((item, index) => ({
      ...item,
      account_state: monitoringAccountState(marginRunways[index]),
    })),
    qualification_reasons: [],
  };
}

function exitAwareMonitoringProof(pair, body, checkedAtMs) {
  const proof = automaticMonitoringProof(pair, checkedAtMs);
  if (body?.phase !== "exit") return proof;
  return {
    ...proof,
    evidence: preflightProof(pair, { phase: "exit" }).evidence.map((item, index) => ({
      ...item,
      account_state: proof.evidence[index].account_state,
    })),
  };
}

function carryMarket(venueId) {
  return venueId === "aster" ? "BTCUSDT" : "BTC";
}

function carryQuoteAsset(venueId) {
  return venueId === "lighter" ? "USD" : "USDT";
}

function carryFeeSettlementAsset(venueId) {
  return venueId === "aster" ? "USDT" : "USDC";
}

function carryFundingSettlementAsset(venueId) {
  return venueId === "aster" ? "USDT" : "USDC";
}

function executionCashflowValuation(sourceAsset, observedAtMs, overrides = {}) {
  const creditBookRateE8 = overrides.credit_rate_e8 ?? 100_000_000;
  const debitBookRateE8 = overrides.debit_rate_e8 ?? 100_000_000;
  const magnitude = overrides.bound_source_amount_micro == null
    ? null
    : BigInt(Math.abs(overrides.bound_source_amount_micro));
  const creditRateE8 = magnitude === null
    ? creditBookRateE8
    : Number((magnitude * BigInt(creditBookRateE8) / 100_000_000n) * 100_000_000n / magnitude);
  const debitRateE8 = magnitude === null
    ? debitBookRateE8
    : Number((((magnitude * BigInt(debitBookRateE8) + 99_999_999n) / 100_000_000n) * 100_000_000n + magnitude - 1n) / magnitude);
  const boundValueMicroUsdc = magnitude === null
    ? null
    : overrides.bound_source_amount_micro > 0
      ? Number(magnitude * BigInt(creditBookRateE8) / 100_000_000n)
      : -Number((magnitude * BigInt(debitBookRateE8) + 99_999_999n) / 100_000_000n);
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: creditRateE8,
    debit_rate_e8: debitRateE8,
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + 30_000,
    evidence_source: sourceAsset === "USDT"
      ? "coinbase-exchange:USDT-USDC:book:v1"
      : "coinbase-exchange:USDT-USD:USDT-USDC:cross-book:v1",
    ...(boundValueMicroUsdc === null ? {} : { bound_value_micro_usdc: boundValueMicroUsdc }),
    ...overrides,
  };
  const evidenceMessage = cashflowValuationEvidenceMessage(valuation);
  const book = (market, bid, ask) => ({
    market,
    sequence: `${market}:test`,
    observed_at_ms: observedAtMs,
    provider_book_time_ms: null,
    bids: [{ price_e8: bid, size_micro: 1_000_000_000 }],
    asks: [{ price_e8: ask, size_micro: 1_000_000_000 }],
  });
  const books = sourceAsset === "USDT"
    ? [book("USDT-USDC", creditBookRateE8, debitBookRateE8)]
    : [
        book("USDT-USDC", creditBookRateE8, debitBookRateE8),
        book("USDT-USD", 100_000_000, 100_000_000),
      ];
  const evidencePayload = {
    venue_id: "coinbase_exchange",
    markets: books.map((row) => row.market),
    source_observed_at_ms: Object.fromEntries(books.map((row) => [row.market, observedAtMs])),
    books,
    ...(valuation.bound_source_amount_micro == null ? {} : {
      source_amount_micro: valuation.bound_source_amount_micro,
      source_amount_decimal: overrides.source_amount_decimal,
      source_amount_scale: overrides.source_amount_scale,
    }),
  };
  return {
    ...valuation,
    evidence_message: evidenceMessage,
    evidence_payload: evidencePayload,
    evidence_commitment: `carry:cashflow-valuation:evidence:${createHash("sha256")
      .update(canonicalCarryCommitmentJson({ evidence_message: evidenceMessage, evidence_payload: evidencePayload }))
      .digest("hex")}`,
  };
}

function fundingSettlement(body, amountQuote, suffix) {
  const sourceAsset = carryFundingSettlementAsset(body.venue_id);
  const sourceAmountMicro = signedDecimalMicro(amountQuote);
  const sourceAmountScale = amountQuote.split(".")[1]?.length || 0;
  return {
    settlement_id: `${body.venue_id}:${suffix}`,
    venue_id: body.venue_id,
    asset: body.asset,
    occurred_at_ms: Math.min(body.end_time_ms, body.start_time_ms + 1),
    amount_quote: amountQuote,
    quote_asset: sourceAsset,
    ...(sourceAsset === "USDC" ? {} : {
      cashflow_valuation: executionCashflowValuation(sourceAsset, body.end_time_ms, {
        bound_source_amount_micro: sourceAmountMicro,
        source_amount_decimal: amountQuote,
        source_amount_scale: sourceAmountScale,
      }),
    }),
  };
}

function signedDecimalMicro(value) {
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = Number(integer) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
  return negative ? -amount : amount;
}

function monitoringRunway(venueId, checkedAtMs) {
  const runway = {
    version: 1,
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    as_of_ms: checkedAtMs,
    status: "healthy",
    margin_headroom_micro_usdc: 20_000_000,
    stress_burn_micro_usdc_per_hour: 10_000_000,
    runway_ms: 7_200_000,
    required_owner_response_ms: 1_800_000,
    position_open: true,
    liquidation_distance_bps: 2_500,
    minimum_liquidation_distance_bps: 1_000,
    liquidation_distance_verified: true,
    liquidation_distance_source: liquidationDistanceSourceForVenue(venueId),
    owner_action_required: false,
    automatic_transfer_permitted: false,
  };
  return {
    ...runway,
    account_state_commitment: monitoringAccountState(runway).account_state_commitment,
  };
}

function monitoringAccountState(runway) {
  const state = {
    venue_id: runway.venue_id,
    account_commitment: runway.account_commitment,
    verification_commitment: `verify:${runway.venue_id}:monitoring`,
    checked_at_ms: runway.as_of_ms,
    position_count: 1,
    open_order_count: 0,
    flat_zero_orders: false,
    liquidation_distance_bps: runway.liquidation_distance_bps,
    liquidation_distance_verified: runway.liquidation_distance_verified,
    liquidation_distance_source: runway.liquidation_distance_source,
  };
  return {
    ...state,
    account_state_commitment: carryAccountStateCommitment(state),
  };
}

async function openActive(fixture) {
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
}

async function createReconciledEntryOrphan(fixture, { receiptFactory = exactLiveValueReceipt, persist = true } = {}) {
  const getRecord = fixture.state.getCarryPositionRecord.bind(fixture.state);
  let crashed = false;
  let submissions = 0;
  fixture.state.getCarryPositionRecord = async (positionId) => {
    const record = await getRecord(positionId);
    if (!crashed && record?.entry_saga_id) {
      const saga = await fixture.state.getMultiLegSaga(record.entry_saga_id);
      if (saga?.status === "reconciled") {
        crashed = true;
        throw new Error("simulated worker crash after entry saga reconciliation");
      }
    }
    return record;
  };
  await assert.rejects(executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      submissions += 1;
      const receipt = receiptFactory(args);
      if (persist) await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  }), /simulated worker crash/);
  fixture.state.getCarryPositionRecord = getRecord;
  const record = await fixture.state.getCarryPositionRecord(fixture.position_id);
  const saga = await fixture.state.getMultiLegSaga(record.entry_saga_id);
  return { record, saga, submissions: () => submissions };
}

async function createReconcilingEntryOrphan(fixture, receiptFactory) {
  const putSaga = fixture.state.putMultiLegSaga.bind(fixture.state);
  let crashed = false;
  let submissions = 0;
  fixture.state.putMultiLegSaga = async (saga, options) => {
    const stored = await putSaga(saga, options);
    if (!crashed && stored.ok && stored.saga?.status === "reconciling") {
      crashed = true;
      throw new Error("simulated worker crash before entry reconciliation");
    }
    return stored;
  };
  await assert.rejects(executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      submissions += 1;
      const receipt = receiptFactory(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  }), /simulated worker crash before entry reconciliation/);
  fixture.state.putMultiLegSaga = putSaga;
  const record = await fixture.state.getCarryPositionRecord(fixture.position_id);
  const saga = await fixture.state.getMultiLegSaga(record.entry_saga_id);
  return { record, saga, submissions: () => submissions };
}

function filledReceipt(args) {
  return {
    version: 1,
    venue_id: args.venue_id,
    status: "filled",
    work_order_commitment: args.work_order_commitment,
    account_commitment: args.execution?.account_commitment,
    provider_ref_commitment: `provider:${args.venue_id}:filled`,
    final_proof: {
      final_venue_execution_proven: true,
      final_fill_proven: true,
      cumulative_filled_micro_usdc: 10_000_000,
      filled_base_size: "0.001",
      open_order_count: 0,
    },
  };
}

function qualificationReceipt(args) {
  const feeAsset = carryFeeSettlementAsset(args.venue_id);
  return {
    ...filledReceipt(args),
    result_commitment: `result:${args.venue_id}:qualification`,
    fills: [{ size: "0.001", price: "10000", fee: "0.001", fee_asset: feeAsset }],
    final_proof: {
      ...filledReceipt(args).final_proof,
      broadcast_performed: true,
      target_client_order_matched: true,
      average_fill_price: "10000",
      fee_quote_amount: "0.001",
      fee_asset: feeAsset,
    },
  };
}

function exactValueReceipt(args) {
  const exit = args.instruction.order.reduce_only === true;
  const price = exit
    ? args.venue_id === "aster" ? "10010" : "9990"
    : args.venue_id === "aster" ? "10001" : "9999";
  const fee = args.venue_id === "aster" ? "0.003" : "0.004";
  return {
    ...filledReceipt(args),
    fills: [{ size: "0.001", price, fee, fee_asset: carryFeeSettlementAsset(args.venue_id) }],
    final_proof: {
      ...filledReceipt(args).final_proof,
      average_fill_price: price,
      fee_quote_amount: fee,
      fee_asset: carryFeeSettlementAsset(args.venue_id),
    },
  };
}

function exactLiveValueReceipt(args) {
  const receipt = exactValueReceipt(args);
  return {
    ...receipt,
    result_commitment: `result:${args.venue_id}:entry:0001`,
    final_proof: {
      ...receipt.final_proof,
      broadcast_performed: true,
      target_client_order_matched: true,
    },
  };
}

function partialLiveValueReceipt(args) {
  const receipt = exactLiveValueReceipt(args);
  return {
    ...receipt,
    fills: [{ size: "0.0005", price: receipt.fills[0].price, fee: receipt.fills[0].fee, fee_asset: receipt.fills[0].fee_asset }],
    final_proof: {
      ...receipt.final_proof,
      cumulative_filled_micro_usdc: 5_000_000,
      filled_base_size: "0.0005",
    },
  };
}

function oneSidedLiveValueReceipt(args) {
  if (args.venue_id === "aster") return partialLiveValueReceipt(args);
  const receipt = exactLiveValueReceipt(args);
  return {
    ...receipt,
    fills: [],
    final_proof: {
      ...receipt.final_proof,
      cumulative_filled_micro_usdc: 0,
      filled_base_size: "0",
      average_fill_price: null,
      fee_quote_amount: null,
      fee_asset: null,
    },
  };
}

function incompleteLiveValueReceipt(args) {
  const receipt = exactLiveValueReceipt(args);
  return {
    ...receipt,
    fills: [],
    final_proof: {
      ...receipt.final_proof,
      average_fill_price: null,
      fee_quote_amount: null,
      fee_asset: null,
    },
  };
}

function recoveryVerification(args) {
  const order = args.instruction?.order || {};
  return {
    status: "verified_no_funds",
    account_commitment: args.account_commitment || null,
    checks: { order_request_checked: true, transaction_broadcast: false },
    order_shape: {
      market: order.market,
      side: order.side,
      base_size: order.base_size,
      limit_price: order.limit_price,
      reduce_only: order.reduce_only === true,
    },
  };
}
