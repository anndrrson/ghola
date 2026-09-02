import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalCarryCommitmentJson, cashflowValuationEvidenceMessage } from "@ghola/execution-core";
import {
  advanceStoredCarryPosition,
  appendStoredCarryValueEntry,
  approveStoredCarryCollateralReview,
  compileStoredCarryCollateralReview,
  compileStoredCarryPortfolioCapitalPlan,
  compileStoredCarryPortfolioValueReport,
  collectStoredCarryFundingEvidence,
  createStoredCarryPosition,
  finalizeStoredCarryValueLedger,
  observeStoredCarryPosition,
  requestStoredCarryPositionExit,
  runCarryMonitoringTick,
  verifyStoredCarryOpportunityBinding,
} from "../src/execution/carry-positions.js";
import { storeCarryTransferRouteEvidence } from "../src/execution/carry-transfer-routes.js";
import { authenticateCarryCreationOpportunity } from "../src/execution/carry-opportunity-authentication.js";
import { carryAccountStateCommitment } from "../src/execution/carry-readiness.js";
import {
  carryInventoryClientOrderIdentityCommitment,
  carryInventoryExpectation,
  carryInventoryPositionIdentityCommitment,
  carryInventoryProviderOrderIdentityCommitment,
} from "../src/execution/carry-inventory.js";
import { carryReconciliationCommitment } from "../src/execution/carry-reconciliation.js";
import { createWorkerState, createWorkerStateAdapter } from "../src/state/private-state.js";
import { liquidationDistanceSourceForVenue } from "../src/venues/liquidation-distance.js";
import {
  carryOpportunityInputEvidence,
  signedCarryCollateralReviewAuthorization,
  signedCarryPositionInput,
  TEST_CARRY_OWNER_WALLET_ADDRESS,
} from "./carry-mandate-fixture.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:commitment:0001";
const ROUTE_ENV = { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"a".repeat(64)}` };

function cashflowValuation(sourceAsset, observedAtMs, overrides = {}) {
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: 100_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + 300_000,
    evidence_source: sourceAsset === "USDC" ? "identity:usdc:v1" : "test:stablecoin-book:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${(sourceAsset === "USDC" ? "0" : "a").repeat(64)}`,
    ...overrides,
  };
  return {
    ...valuation,
    evidence_message: cashflowValuationEvidenceMessage(valuation),
  };
}

function boundCashflowValuation({ decimal, micro, observedAtMs, creditRateE8, debitRateE8 }) {
  const scale = decimal.split(".")[1]?.length || 0;
  const magnitude = BigInt(Math.abs(micro));
  const effectiveCreditRateE8 = Number(
    (magnitude * BigInt(creditRateE8) / 100_000_000n) * 100_000_000n / magnitude,
  );
  const effectiveDebitRateE8 = Number(
    (((magnitude * BigInt(debitRateE8) + 99_999_999n) / 100_000_000n) * 100_000_000n + magnitude - 1n)
      / magnitude,
  );
  const boundValueMicroUsdc = micro > 0
    ? Number(magnitude * BigInt(creditRateE8) / 100_000_000n)
    : -Number((magnitude * BigInt(debitRateE8) + 99_999_999n) / 100_000_000n);
  const valuation = {
    version: 1,
    source_asset: "USDT",
    valuation_asset: "USDC",
    verified: true,
    bound_source_amount_micro: micro,
    bound_value_micro_usdc: boundValueMicroUsdc,
    credit_rate_e8: effectiveCreditRateE8,
    debit_rate_e8: effectiveDebitRateE8,
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + 30_000,
    evidence_source: "coinbase-exchange:USDT-USDC:book:v1",
  };
  const evidenceMessage = cashflowValuationEvidenceMessage(valuation);
  const evidencePayload = {
    venue_id: "coinbase_exchange",
    markets: ["USDT-USDC"],
    source_observed_at_ms: { "USDT-USDC": observedAtMs },
    source_amount_micro: micro,
    source_amount_decimal: decimal,
    source_amount_scale: scale,
    books: [{
      market: "USDT-USDC",
      sequence: "test",
      observed_at_ms: observedAtMs,
      provider_book_time_ms: null,
      bids: [{ price_e8: creditRateE8, size_micro: 10_000_000 }],
      asks: [{ price_e8: debitRateE8, size_micro: 10_000_000 }],
    }],
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

test("persists a Carry Position, lifecycle, and final value proof across state reload", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let state = createWorkerState(dir);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  assert.equal(created.record.record_version, 1);
  assert.equal(created.record.value_boundary_authoritative, false);
  assert.match(created.record.opportunity_provenance.evidence_commitment, /^carry:creation-opportunity:evidence:[0-9a-f]{64}$/);
  assert.equal("opportunity_authentication_material" in created.record, false);
  const storedCreation = await state.getCarryPositionRecord(created.record.position.position_id);
  assert.equal(verifyStoredCarryOpportunityBinding({ record: storedCreation }).ok, true);
  assert.equal(created.record.value_ledger.modeled.breakdown_complete, true);
  assert.equal(created.record.value_ledger.modeled.trading_fee_micro_usdc, 2_000);

  let record = created.record;
  for (const event of lifecycle()) {
    const advanced = event.type === "manual_exit_requested"
      ? await requestStoredCarryPositionExit({
        state,
        position_id: record.position.position_id,
        owner_commitment: OWNER,
        event_id: event.event_id,
        sequence: event.sequence,
        now_ms: NOW + event.sequence,
      })
      : await advanceStoredCarryPosition({
        state,
        position_id: record.position.position_id,
        owner_commitment: OWNER,
        event,
        now_ms: NOW + event.sequence,
      });
    assert.equal(advanced.ok, true, advanced.error);
    record = advanced.record;
  }
  assert.equal(record.position.status, "reconciled");
  assert.equal(record.position.active_observed_at_ms, NOW + 1);
  assert.equal(record.position.active_boundary_provenance, "worker_observed_positive_fill");
  assert.deepEqual(
    record.lifecycle_events.map((event) => event.recorded_at_ms),
    lifecycle().map((event) => NOW + event.sequence),
  );

  const valued = await appendStoredCarryValueEntry({
    state,
    position_id: record.position.position_id,
    owner_commitment: OWNER,
    entry: {
      version: 1,
      entry_id: "carry:value:entry:0001",
      sequence: 1,
      entry_type: "funding",
      direction: "credit",
      amount_micro_usdc: 21_000,
      source_amount_micro: 21_000,
      source_amount_decimal: "0.021",
      source_amount_scale: 3,
      source_asset: "USDC",
      valued_at_ms: NOW + 10,
      cashflow_valuation: cashflowValuation("USDC", NOW + 10),
      venue_id: "lighter",
      leg_id: "carry:leg:short",
      occurred_at_ms: NOW + 10,
      evidence_commitment: "carry:value:evidence:0001",
    },
    now_ms: NOW + 10,
  });
  assert.equal(valued.ok, true);
  const completedEvidence = await state.putCarryPositionRecord({
    ...(await state.getCarryPositionRecord(record.position.position_id)),
    value_evidence: completeValueEvidence(),
  }, { expected_version: valued.record.record_version });
  assert.equal(completedEvidence.ok, true);
  const finalized = await finalizeStoredCarryValueLedger({
    state,
    position_id: record.position.position_id,
    owner_commitment: OWNER,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      reconciliation_commitment: "carry:reconciliation:0001",
    },
    now_ms: NOW + 11,
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.record.value_ledger.status, "finalized");
  assert.equal(finalized.record.value_boundary_authoritative, false);

  state = createWorkerState(dir);
  const reloaded = await state.getCarryPositionRecord(record.position.position_id);
  const reloadedLifecycle = await state.listCarryLifecycleEvents({
    position_id: record.position.position_id,
  });
  assert.equal(reloaded.position.status, "reconciled");
  assert.equal(reloadedLifecycle.length, lifecycle().length);
  assert.deepEqual(reloadedLifecycle.map((item) => item.event), reloaded.lifecycle_events);
  assert.equal(reloaded.value_ledger.realized.net_value_micro_usdc, 21_000);
  assert.equal(reloaded.value_ledger.realized.attribution.status, "finalized");
  assert.equal(reloaded.value_ledger.finalization_evidence.open_order_count, 0);
});

test("persists an append-only Carry lifecycle journal beyond the 256-event UI tail and rejects stale CAS appends", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-lifecycle-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let state = createWorkerState(dir);
  const positionId = "carry:position:journal:0001";
  let record = {
    owner_commitment: OWNER,
    position: {
      position_id: positionId,
      status: "active",
      last_event_sequence: 0,
    },
    lifecycle_events: [],
  };
  let stored = await state.putCarryPositionRecord(record, { expected_version: null });
  assert.equal(stored.ok, true);
  record = stored.record;

  for (let sequence = 1; sequence <= 300; sequence += 1) {
    const event = {
      version: 1,
      event_id: `carry:event:journal:${sequence}`,
      sequence,
      type: "observation",
      recorded_at_ms: NOW + sequence,
    };
    const next = {
      ...record,
      position: { ...record.position, last_event_sequence: sequence },
      lifecycle_events: [...record.lifecycle_events, event].slice(-256),
    };
    stored = await state.putCarryPositionRecord(next, {
      expected_version: record.record_version,
      lifecycle_event: event,
    });
    assert.equal(stored.ok, true, stored.error);
    record = stored.record;
  }

  assert.equal(record.lifecycle_events.length, 256);
  let journal = await state.listCarryLifecycleEvents({ position_id: positionId, limit: 1_000 });
  assert.equal(journal.length, 300);
  assert.equal(journal[0].sequence, 1);
  assert.equal(journal.at(-1).sequence, 300);
  assert.equal(journal.at(-1).previous_event_commitment, journal.at(-2).event_commitment);

  const projectionMutation = await state.putCarryPositionRecord({
    ...record,
    position: { ...record.position, status: "reconciled" },
    final_reconciliation_evidence: { known_flat: true, open_order_count: 0 },
  }, { expected_version: record.record_version });
  assert.equal(projectionMutation.error, "carry_lifecycle_projection_write_requires_event");

  const event = {
    version: 1,
    event_id: "carry:event:journal:1",
    sequence: 301,
    type: "observation",
    recorded_at_ms: NOW + 301,
  };
  const next = {
    ...record,
    position: { ...record.position, last_event_sequence: 301 },
    lifecycle_events: [...record.lifecycle_events, event].slice(-256),
  };
  const freshEvent = { ...event, event_id: "carry:event:journal:301" };
  const tamperedPrefix = {
    ...next,
    lifecycle_events: [
      { ...record.lifecycle_events[1], type: "tampered_observation" },
      ...record.lifecycle_events.slice(2),
      freshEvent,
    ],
  };
  const tampered = await state.putCarryPositionRecord(tamperedPrefix, {
    expected_version: record.record_version,
    lifecycle_event: freshEvent,
  });
  assert.equal(tampered.error, "carry_lifecycle_snapshot_binding_mismatch");
  const detached = await state.putCarryPositionRecord(next, {
    expected_version: record.record_version,
  });
  assert.equal(detached.error, "carry_lifecycle_projection_write_requires_event");
  const duplicate = await state.putCarryPositionRecord(next, {
    expected_version: record.record_version,
    lifecycle_event: event,
  });
  assert.equal(duplicate.error, "carry_lifecycle_event_conflict");
  const stale = await state.putCarryPositionRecord(next, {
    expected_version: record.record_version - 1,
    lifecycle_event: { ...event, event_id: "carry:event:journal:301" },
  });
  assert.equal(stale.error, "carry_record_version_conflict");

  state = createWorkerState(dir);
  journal = await state.listCarryLifecycleEvents({ position_id: positionId, limit: 1_000 });
  assert.equal(journal.length, 300);
  assert.equal((await state.getCarryPositionRecord(positionId)).position.last_event_sequence, 300);
});

test("anchors legacy Carry journals without freezing positions or qualifying missing history", async () => {
  const positionId = "carry:position:legacy-journal:0001";
  const priorEvents = [1, 2, 3].map((sequence) => ({
    version: 1,
    event_id: `carry:event:legacy:${sequence}`,
    sequence,
    type: "observation",
    recorded_at_ms: NOW + sequence,
  }));
  let snapshot = {
    carry_positions: {
      [positionId]: {
        record_version: 7,
        owner_commitment: OWNER,
        position: { position_id: positionId, status: "active", last_event_sequence: 3 },
        lifecycle_events: priorEvents,
      },
    },
    carry_lifecycle_events: {},
  };
  const state = createWorkerStateAdapter({
    path: "memory://legacy-carry-journal",
    hmacSecret: "11".repeat(32),
    load: async () => structuredClone(snapshot),
    save: async (next) => { snapshot = structuredClone(next); },
  });
  const legacy = await state.getCarryPositionRecord(positionId);
  const ordinary = await state.putCarryPositionRecord({ ...legacy, marker: "still-managed" }, {
    expected_version: legacy.record_version,
  });
  assert.equal(ordinary.ok, true, ordinary.error);
  assert.deepEqual(ordinary.record.lifecycle_journal, { version: 1, origin_sequence: 4 });

  const event = {
    version: 1,
    event_id: "carry:event:legacy:4",
    sequence: 4,
    type: "exit_requested",
    recorded_at_ms: NOW + 4,
  };
  const appended = await state.putCarryPositionRecord({
    ...ordinary.record,
    position: { ...ordinary.record.position, last_event_sequence: 4 },
    lifecycle_events: ordinary.record.lifecycle_events.concat(event),
  }, {
    expected_version: ordinary.record.record_version,
    lifecycle_event: event,
  });
  assert.equal(appended.ok, true, appended.error);
  const journal = await state.listCarryLifecycleEvents({ position_id: positionId });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].sequence, 4);
  assert.equal(journal[0].previous_event_commitment, null);

  const mutated = await state.putCarryPositionRecord({
    ...appended.record,
    lifecycle_journal: { version: 1, origin_sequence: 1 },
  }, { expected_version: appended.record.record_version });
  assert.equal(mutated.error, "carry_lifecycle_journal_metadata_immutable");
});

test("refuses caller-claimed final value before durable cost evidence is complete", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-value-finalization-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("value-proof"),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  let record = created.record;
  for (const item of lifecycle()) {
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: record.position.position_id,
      owner_commitment: OWNER,
      event: item,
      now_ms: NOW + item.sequence,
    });
    record = advanced.record;
  }

  const rejected = await finalizeStoredCarryValueLedger({
    state,
    position_id: record.position.position_id,
    owner_commitment: OWNER,
    evidence: finalizationEvidence(),
    now_ms: NOW + 10,
  });

  assert.deepEqual(rejected, { ok: false, error: "carry_value_evidence_incomplete" });
  assert.equal((await state.getCarryPositionRecord(record.position.position_id)).value_ledger.status, "open");
});

test("refuses final value claims that do not match durable flat reconciliation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-value-finalization-match-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("value-match"),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  let record = created.record;
  for (const item of lifecycle()) {
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: record.position.position_id,
      owner_commitment: OWNER,
      event: item,
      now_ms: NOW + item.sequence,
    });
    record = advanced.record;
  }
  const completed = await state.putCarryPositionRecord({
    ...(await state.getCarryPositionRecord(record.position.position_id)),
    value_evidence: completeValueEvidence(),
  }, { expected_version: record.record_version });
  assert.equal(completed.ok, true);

  const rejected = await finalizeStoredCarryValueLedger({
    state,
    position_id: record.position.position_id,
    owner_commitment: OWNER,
    evidence: { ...finalizationEvidence(), reconciliation_commitment: "carry:reconciliation:wrong" },
    now_ms: NOW + 10,
  });

  assert.deepEqual(rejected, { ok: false, error: "carry_value_finalization_evidence_mismatch" });
  assert.equal((await state.getCarryPositionRecord(record.position.position_id)).value_ledger.status, "open");
});

test("finalizes an aborted entry only from complete recovery and flat evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-value-aborted-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("value-aborted-entry"),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  let record = created.record;
  for (const item of lifecycle()) {
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: record.position.position_id,
      owner_commitment: OWNER,
      event: item,
      now_ms: NOW + item.sequence,
    });
    record = advanced.record;
  }
  const completed = await state.putCarryPositionRecord({
    ...(await state.getCarryPositionRecord(record.position.position_id)),
    value_evidence: {
      aborted_entry_recovery: { status: "complete" },
      funding: { status: "complete_through_exit" },
      realized_economics: { status: "complete" },
      costs_complete: true,
    },
  }, { expected_version: record.record_version });
  assert.equal(completed.ok, true);

  const finalized = await finalizeStoredCarryValueLedger({
    state,
    position_id: record.position.position_id,
    owner_commitment: OWNER,
    evidence: finalizationEvidence(),
    now_ms: NOW + 10,
  });

  assert.equal(finalized.ok, true);
  assert.equal(finalized.record.value_ledger.status, "finalized");
});

test("rejects stale concurrent Carry Position writers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-cas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  const first = await state.putCarryPositionRecord(created.record, { expected_version: 1 });
  assert.equal(first.ok, true);
  const stale = await state.putCarryPositionRecord(created.record, { expected_version: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "carry_record_version_conflict");
});

test("refuses storage until venue accounts, synchronized equivalent contracts, and margin runways pass", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-readiness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const notReady = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity({ all_venues_ready: false }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(notReady, { ok: false, error: "carry_venue_accounts_not_ready" });
  const lowRunway = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity({ long_margin_runway_ms: 1 }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(lowRunway, { ok: false, error: "carry_margin_runway_insufficient" });
  const skewed = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity({ contract_data_skew_ms: 2_001 }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(skewed, { ok: false, error: "carry_market_data_skew_exceeded" });
  const divergent = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: opportunity({ index_price_divergence_bps: 26 }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(divergent, { ok: false, error: "carry_contract_basis_exceeded" });
  const mismatchedSignedLimit = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("signed-limit", { max_index_price_divergence_bps: 26 }),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(mismatchedSignedLimit, { ok: false, error: "carry_unsigned_contract_basis_limit" });
  const incompleteValueBreakdown = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("incomplete-value"),
    opportunity: opportunity({ projected_slippage_micro_usdc: undefined }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(incompleteValueBreakdown, { ok: false, error: "carry_value_breakdown_incomplete" });
  const mismatchedValueBreakdown = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("mismatched-value"),
    opportunity: opportunity({ projected_trading_fee_micro_usdc: 1 }),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(mismatchedValueBreakdown, { ok: false, error: "carry_value_breakdown_invalid" });
});

test("refuses a worker-signed opportunity detached from its exact route inputs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-input-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const validEvidence = carryOpportunityInputEvidence("hyperliquid", "lighter");
  const detached = opportunity({
    input_evidence: {
      ...validEvidence,
      legs: [
        { ...validEvidence.legs[0], margin_model: "detached_margin_model" },
        validEvidence.legs[1],
      ],
    },
  });
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("detached-input", {}, NOW + 30 * 86_400_000, {
      opportunity_evidence_commitment: detached.worker_authentication.evidence_commitment,
    }),
    opportunity: detached,
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.deepEqual(created, { ok: false, error: "carry_opportunity_input_evidence_invalid" });
});

test("refuses unsigned or client-modified Carry creation economics", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-worker-opportunity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const signed = opportunity();
  const { worker_authentication: _authentication, ...unsigned } = signed;
  const missing = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("unsigned-opportunity"),
    opportunity: unsigned,
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.equal(missing.error, "carry_opportunity_worker_authentication_missing");
  const tampered = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("tampered-opportunity"),
    opportunity: { ...signed, projected_net_value_micro_usdc: signed.projected_net_value_micro_usdc + 1 },
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.equal(tampered.error, "carry_opportunity_worker_authentication_invalid");

  const rebound = await positionInput("rebound-opportunity");
  const reboundInput = await signedCarryPositionInput({
    ...rebound,
    mandate_authorization: undefined,
    opportunity_evidence_commitment: `carry:creation-opportunity:evidence:${"b".repeat(64)}`,
  }, { ownerCommitment: OWNER, nowMs: NOW });
  const substituted = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: reboundInput,
    opportunity: signed,
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.equal(substituted.error, "carry_opportunity_mandate_mismatch");
});

test("creates only a capped, explicitly enabled qualification pilot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-qualification-pilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const pilotOpportunity = opportunity({
    live_creation_ready: false,
    qualification_pilot_ready: true,
    qualification_pilot_candidate_venue_id: "lighter",
  });
  const pilot = { enabled: true, candidate_venue_id: "lighter" };
  const disabled = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(),
    opportunity: pilotOpportunity,
    monitoring_context: monitoringContext(),
    qualification_pilot: pilot,
    env: {},
    now_ms: NOW,
  });
  assert.equal(disabled.error, "carry_qualification_pilot_disabled");
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput("pilot", {}, NOW + (30 * 86_400_000), {
      opportunity_evidence_commitment: pilotOpportunity.worker_authentication.evidence_commitment,
    }),
    opportunity: pilotOpportunity,
    monitoring_context: monitoringContext(),
    qualification_pilot: pilot,
    env: {
      PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "true",
      PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC: "11000000",
    },
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  assert.equal(created.record.qualification_pilot.candidate_venue_id, "lighter");
  assert.equal(created.record.qualification_pilot.max_notional_micro_usdc, 11_000_000);
  assert.equal(created.record.qualification_pilot.requires_separate_live_confirmation, true);
});

test("monitoring records funding flips and deterministically requests exit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const preflight = async ({ body, now }) => {
    assert.equal(body.risk_mandate.max_contract_data_skew_ms, 2_000);
    return monitoringObservation({
      version: 1,
      mode: "paired_monitoring_no_submit",
      no_submit_ready: true,
      transaction_broadcast: false,
      economic_opportunity: monitoringOpportunity(now(), -1),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    });
  };
  const dependencies = {
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: { hyperliquid: { status: "ready" }, lighter: { status: "ready" } },
    preflight,
  };
  const first = await observeStoredCarryPosition({ ...dependencies, now_ms: NOW + 100 });
  assert.equal(first.ok, true);
  assert.equal(first.observation_ok, true);
  assert.equal(first.record.position.status, "active");
  assert.equal(first.record.position.consecutive_exit_observations, 1);
  assert.equal(first.record.latest_observation.expected_net_value_bps, -1);
  assert.equal(first.record.latest_observation.margin_runway_ms_by_venue.hyperliquid, 7_200_000);
  assert.equal(first.record.latest_observation.margin_runway_status_by_venue.hyperliquid, "healthy");
  const second = await observeStoredCarryPosition({ ...dependencies, now_ms: NOW + 200 });
  assert.equal(second.ok, true);
  assert.equal(second.record.position.status, "exiting");
  assert.deepEqual(second.record.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("monitoring exits without venue reads when durable opportunity evidence was altered", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-tampered-opportunity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state, "tampered-opportunity");
  const record = await state.getCarryPositionRecord(active.position.position_id);
  const stored = await state.putCarryPositionRecord({
    ...record,
    opportunity: {
      ...record.opportunity,
      horizon_ms: record.opportunity.horizon_ms + 1,
    },
  }, { expected_version: record.record_version });
  assert.equal(stored.ok, true);

  let preflightCalls = 0;
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => {
      preflightCalls += 1;
      return {};
    },
    now_ms: NOW + 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "exiting");
  assert.equal(result.record.lifecycle_events.at(-1).type, "mandate_invalid");
  assert.equal(preflightCalls, 0);
});

test("monitoring preserves signed migration venues and proposes the best no-submit route only after the exit threshold", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const risk = {
    allow_migration: true,
    min_migration_improvement_bps: 1,
    migration_venue_allowlist: ["hyperliquid", "lighter", "aster"],
  };
  const context = monitoringContext(["hyperliquid", "lighter", "aster"]);
  const active = await activePosition(state, "migration", risk, context);
  const stored = await state.getCarryPositionRecord(active.position.position_id);
  assert.deepEqual(Object.keys(stored.monitoring_context.venue_access).sort(), ["aster", "hyperliquid", "lighter"]);

  const phases = [];
  const preflight = async ({ body, now }) => {
    phases.push(body.phase);
    if (body.phase === "monitoring") {
      return monitoringObservation({
        version: 1,
        mode: "paired_monitoring_no_submit",
        no_submit_ready: true,
        transaction_broadcast: false,
        economic_opportunity: monitoringOpportunity(now(), -1),
        margin_runways: [
          monitoringRunway("hyperliquid"),
          monitoringRunway("lighter"),
        ],
        qualification_reasons: [],
      });
    }
    const best = body.long_venue_id === "aster" && body.short_venue_id === "lighter";
    return {
      version: 1,
      mode: "paired_migration_no_submit",
      no_submit_ready: true,
      transaction_broadcast: false,
      live_creation_ready: true,
      economic_opportunity: monitoringOpportunity(NOW + 200, best ? 30 : 10, { eligible: true }),
      qualification_reasons: [],
    };
  };
  const dependencies = {
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: context.venue_access,
    preflight,
  };
  const first = await observeStoredCarryPosition({ ...dependencies, now_ms: NOW + 100 });
  assert.equal(first.record.position.status, "active");
  assert.deepEqual(phases, ["monitoring"]);
  const second = await observeStoredCarryPosition({ ...dependencies, now_ms: NOW + 200 });
  assert.equal(second.record.position.status, "exiting");
  assert.deepEqual(second.record.position.next_actions, ["reduce_only_close_both_legs"]);
  assert.ok(second.record.position.pending_migration, JSON.stringify(second.record.lifecycle_events.at(-1)));
  assert.equal(second.record.position.pending_migration.status, "awaiting_flat_exit");
  assert.equal(second.record.position.pending_migration.transaction_broadcast, false);
  assert.equal(second.record.position.pending_migration.selected_candidate.long_venue_id, "aster");
  assert.equal(second.record.position.pending_migration.selected_candidate.short_venue_id, "lighter");
  assert.equal(phases.filter((phase) => phase === "migration").length, 5);
});

test("creates an owner-signed migration replacement only from the selected flat parent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-migration-replacement-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const risk = {
    allow_migration: true,
    min_migration_improvement_bps: 1,
    migration_venue_allowlist: ["hyperliquid", "lighter", "aster"],
  };
  let parent = await activePosition(state, "migration-parent", risk, monitoringContext(["hyperliquid", "lighter", "aster"]));
  const candidate = {
    candidate_id: "carry:migration:replacement:0001",
    asset: "BTC",
    economic_equivalence_id: "carry:BTC-usd-linear",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    expected_net_value_bps: 30,
    transition_cost_bps: 3,
    eligible: true,
    no_submit_ready: true,
    transaction_broadcast: false,
    qualification_reasons: [],
    checked_at_ms: NOW + 4,
  };
  for (const [sequence, candidates] of [[3, []], [4, [candidate]]]) {
    const funding = monitoringFundingObservation(NOW + sequence);
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: parent.position.position_id,
      owner_commitment: OWNER,
      event: event(sequence, "observation", {
        ...monitoringOpportunity(NOW + sequence, -1),
        funding_observation_commitment: funding.evidence_commitment,
        funding_source_observed_at_ms_by_venue: funding.source_observed_at_ms_by_venue,
        as_of_ms: NOW + sequence,
        expected_net_value_bps: -1,
        migration_candidates: candidates,
        margin_runway_ms_by_venue: { hyperliquid: 7_200_000, lighter: 7_200_000 },
        margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "healthy" },
        qualification_reasons: [],
        transaction_broadcast: false,
      }),
      now_ms: NOW + sequence,
    });
    assert.equal(advanced.ok, true, advanced.error);
    parent = advanced.record;
  }
  const finalReconciliation = exactFlatReconciliation(
    parent.position.position_id,
    ["hyperliquid", "lighter"],
    NOW + 5,
  );
  const reconciled = await advanceStoredCarryPosition({
    state,
    position_id: parent.position.position_id,
    owner_commitment: OWNER,
    event: event(5, "exit_reconciled", finalReconciliation),
    now_ms: NOW + 5,
  });
  assert.equal(reconciled.record.position.pending_migration.status, "owner_signature_required");
  assert.equal(
    reconciled.record.final_reconciliation_evidence.reconciliation_commitment,
    finalReconciliation.reconciliation_commitment,
  );

  const replacementBase = {
    version: 1,
    position_id: "carry:position:migration-replacement:0001",
    mandate_id: "carry:mandate:migration-replacement:0001",
    migration_parent_position_id: parent.position.position_id,
    migration_candidate_id: candidate.candidate_id,
    asset: "BTC",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    opportunity_evidence_commitment: opportunity({
      long_venue_id: "aster",
      short_venue_id: "lighter",
    }).worker_authentication.evidence_commitment,
    risk_mandate: { ...parent.position.risk_mandate },
  };
  const replacement = await signedCarryPositionInput(replacementBase, { ownerCommitment: OWNER, nowMs: NOW + 6 });
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: replacement,
    opportunity: opportunity({ long_venue_id: "aster", short_venue_id: "lighter" }),
    monitoring_context: monitoringContext(["aster", "lighter"]),
    now_ms: NOW + 6,
  });
  assert.equal(created.ok, true);
  assert.equal(created.record.position.migration_parent_position_id, parent.position.position_id);
  assert.equal(created.record.position.migration_candidate_id, candidate.candidate_id);

  const tamperedBase = {
    ...replacementBase,
    position_id: "carry:position:migration-replacement:tampered",
    mandate_id: "carry:mandate:migration-replacement:tampered",
    migration_candidate_id: "carry:migration:wrong:0001",
  };
  const tampered = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await signedCarryPositionInput(tamperedBase, { ownerCommitment: OWNER, nowMs: NOW + 7 }),
    opportunity: opportunity({ long_venue_id: "aster", short_venue_id: "lighter" }),
    monitoring_context: monitoringContext(["aster", "lighter"]),
    now_ms: NOW + 7,
  });
  assert.equal(tampered.error, "carry_migration_candidate_mismatch");
});

test("monitoring records a basis breach and immediately requests a reduce-only exit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-basis-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9, { index_price_divergence_bps: 26 }),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: ["index_price_divergence_exceeded"],
    }),
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "exiting");
  assert.equal(result.record.position.terminal_reason, "contract_basis_outside_mandate");
  assert.equal(result.record.latest_observation.index_price_divergence_bps, 26);
  assert.deepEqual(result.record.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("monitoring exits when verified liquidation distance breaches the floor", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-liquidation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid", {
          status: "breached",
          liquidation_distance_bps: 900,
        }),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: ["margin_runway_insufficient:hyperliquid"],
    }),
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "exiting");
  assert.equal(result.record.position.terminal_reason, "margin_runway_below_mandate");
  assert.equal(result.record.latest_observation.capital_action_plan.legs[0].liquidation_distance_bps, 900);
  assert.equal(result.record.latest_observation.capital_action_plan.automatic_transfer_permitted, false);
});

test("monitoring durably preserves only self-contained account-state evidence bound to its capital plan", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-account-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state, "account-state");
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => {
      const observed = monitoringObservation({
        economic_opportunity: monitoringOpportunity(NOW + 100, 9),
        margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
        qualification_reasons: [],
      });
      observed.evidence[0].credential = "must-not-persist";
      observed.evidence[0].account_state.private_key = "must-not-persist";
      return observed;
    },
    now_ms: NOW + 100,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.observation_ok, true);
  const restored = await createWorkerState(dir).getCarryPositionRecord(active.position.position_id);
  const evidence = restored.latest_observation.account_state_evidence;
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((item) => Object.keys(item)), [
    [
      "venue_id",
      "account_commitment",
      "verification_commitment",
      "checked_at_ms",
      "position_count",
      "open_order_count",
      "flat_zero_orders",
      "liquidation_distance_bps",
      "liquidation_distance_verified",
      "liquidation_distance_source",
      "inventory",
      "account_state_commitment",
    ],
    [
      "venue_id",
      "account_commitment",
      "verification_commitment",
      "checked_at_ms",
      "position_count",
      "open_order_count",
      "flat_zero_orders",
      "liquidation_distance_bps",
      "liquidation_distance_verified",
      "liquidation_distance_source",
      "inventory",
      "account_state_commitment",
    ],
  ]);
  const planByVenue = new Map(restored.latest_observation.capital_action_plan.legs.map((leg) => [leg.venue_id, leg]));
  for (const item of evidence) {
    const leg = planByVenue.get(item.venue_id);
    assert.equal(item.checked_at_ms, restored.latest_observation.recorded_at_ms);
    assert.equal(item.position_count, 1);
    assert.equal(item.flat_zero_orders, false);
    assert.match(item.account_state_commitment, /^carry:account-state:[0-9a-f]{40}$/);
    assert.equal(item.account_state_commitment, carryAccountStateCommitment(item));
    assert.equal(item.account_state_commitment, leg.account_state_commitment);
    assert.equal(item.liquidation_distance_bps, leg.liquidation_distance_bps);
    assert.equal(item.liquidation_distance_source, leg.liquidation_distance_source);
  }
  assert.equal(JSON.stringify(restored).includes("must-not-persist"), false);
  assert.deepEqual(
    restored.lifecycle_events.at(-1).account_state_evidence,
    restored.latest_observation.account_state_evidence,
  );
});

test("monitoring fails closed before persisting unbound account-state evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-account-state-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const cases = [
    ["missing", (observed) => { delete observed.evidence; }],
    ["bad-commitment", (observed) => { observed.evidence[0].account_state.account_state_commitment += "a"; }],
    ["closed-position", (observed) => {
      observed.evidence[0].account_state.position_count = 0;
      observed.evidence[0].account_state.flat_zero_orders = true;
    }],
    ["missing-flat-field", (observed) => { delete observed.evidence[0].account_state.flat_zero_orders; }],
    ["wrong-source", (observed) => {
      observed.evidence[0].account_state.liquidation_distance_source = liquidationDistanceSourceForVenue("lighter");
    }],
    ["wrong-account", (observed) => {
      const stateEvidence = observed.evidence[0].account_state;
      stateEvidence.account_commitment = "account:hyperliquid:other";
      stateEvidence.account_state_commitment = carryAccountStateCommitment(stateEvidence);
      observed.margin_runways[0].account_commitment = stateEvidence.account_commitment;
      observed.margin_runways[0].account_state_commitment = stateEvidence.account_state_commitment;
    }],
    ["plan-mismatch", (observed) => {
      observed.margin_runways[0].account_state_commitment = `carry:account-state:${"f".repeat(40)}`;
    }],
  ];
  for (const [suffix, mutate] of cases) {
    const active = await activePosition(state, `account-state-${suffix}`);
    const result = await observeStoredCarryPosition({
      state,
      owner_commitment: OWNER,
      position_id: active.position.position_id,
      venue_access: monitoringContext().venue_access,
      preflight: async () => {
        const observed = monitoringObservation({
          economic_opportunity: monitoringOpportunity(NOW + 100, 9),
          margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
          qualification_reasons: [],
        });
        mutate(observed);
        return observed;
      },
      now_ms: NOW + 100,
    });
    assert.equal(result.ok, true, suffix);
    assert.equal(result.observation_ok, false, suffix);
    assert.equal(result.record.position.status, "frozen", suffix);
    assert.equal(result.record.latest_observation, undefined, suffix);
    assert.equal(result.record.lifecycle_events.at(-1).type, "observation_unavailable", suffix);
    assert.match(result.record.lifecycle_events.at(-1).reason, /^account_state_evidence:/, suffix);
    assert.equal("account_state_evidence" in result.record.lifecycle_events.at(-1), false, suffix);
  }
});

test("monitoring reduces risk for proven target-leg drift and ignores unrelated position counts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-inventory-drift-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ["missing", (inventory) => { inventory.target_positions = []; }],
    ["wrong-side", (inventory) => { inventory.target_positions[0].side = "short"; }],
    ["size-drift", (inventory) => { inventory.target_positions[0].base_size = "0.0005"; }],
    ["carry-order-open", (inventory) => {
      inventory.target_open_orders = [{
        market: "BTC",
        side: "buy",
        base_size: "0.001",
        reduce_only: false,
        order_identity_commitment: "order:carry:btc:0001",
        client_order_identity_commitment: carryInventoryClientOrderIdentityCommitment({
          venue_id: "hyperliquid",
          client_order_id: "entry-hyperliquid-0001",
        }),
        provider_order_identity_commitment: carryInventoryProviderOrderIdentityCommitment({
          venue_id: "hyperliquid",
          provider_order_id: "provider-order-hyperliquid-0001",
        }),
        carry_work_order_commitment: null,
        carry_provider_ref_commitment: null,
      }];
    }],
  ];
  for (const [suffix, mutate] of cases) {
    const state = createWorkerState(dir);
    const active = await activePosition(state, `inventory-${suffix}`);
    const result = await observeStoredCarryPosition({
      state,
      owner_commitment: OWNER,
      position_id: active.position.position_id,
      venue_access: monitoringContext().venue_access,
      preflight: async () => {
        const observed = monitoringObservation({
          economic_opportunity: monitoringOpportunity(NOW + 100, 9),
          margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
          qualification_reasons: [],
        });
        const account = observed.evidence[0].account_state;
        mutate(account.inventory);
        account.account_state_commitment = carryAccountStateCommitment(account);
        observed.margin_runways[0].account_state_commitment = account.account_state_commitment;
        return observed;
      },
      now_ms: NOW + 100,
    });
    assert.equal(result.ok, true, suffix);
    assert.equal(result.observation_ok, false, suffix);
    assert.equal(result.record.position.status, "exiting", suffix);
    assert.equal(result.record.position.terminal_reason, "inventory_drift", suffix);
    assert.deepEqual(result.record.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"], suffix);
    assert.equal(result.record.lifecycle_events.at(-1).type, "inventory_drift", suffix);
  }
});

test("monitoring freezes on unverified or foreign target-market orders", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-inventory-ambiguous-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ["unverified", (inventory) => { inventory.position_inventory_verified = false; }],
    ["foreign-order", (inventory) => {
      inventory.target_open_orders = [{
        market: "BTC",
        side: "sell",
        base_size: "0.001",
        reduce_only: true,
        order_identity_commitment: "order:foreign:btc:0001",
        carry_work_order_commitment: null,
        carry_provider_ref_commitment: null,
      }];
    }],
    ["client-id-collision", (inventory) => {
      inventory.target_open_orders = [{
        market: "BTC",
        side: "buy",
        base_size: "0.001",
        reduce_only: false,
        order_identity_commitment: "order:collision:btc:0001",
        client_order_identity_commitment: carryInventoryClientOrderIdentityCommitment({
          venue_id: "hyperliquid",
          client_order_id: "entry-hyperliquid-0001",
        }),
        provider_order_identity_commitment: carryInventoryProviderOrderIdentityCommitment({
          venue_id: "hyperliquid",
          provider_order_id: "provider-order-foreign-0001",
        }),
        carry_work_order_commitment: null,
        carry_provider_ref_commitment: null,
      }];
    }],
  ];
  for (const [suffix, mutate] of cases) {
    const state = createWorkerState(dir);
    const active = await activePosition(state, `inventory-ambiguous-${suffix}`);
    const result = await observeStoredCarryPosition({
      state,
      owner_commitment: OWNER,
      position_id: active.position.position_id,
      venue_access: monitoringContext().venue_access,
      preflight: async () => {
        const observed = monitoringObservation({
          economic_opportunity: monitoringOpportunity(NOW + 100, 9),
          margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
          qualification_reasons: [],
        });
        const account = observed.evidence[0].account_state;
        mutate(account.inventory);
        account.account_state_commitment = carryAccountStateCommitment(account);
        observed.margin_runways[0].account_state_commitment = account.account_state_commitment;
        return observed;
      },
      now_ms: NOW + 100,
    });
    assert.equal(result.ok, true, suffix);
    assert.equal(result.observation_ok, false, suffix);
    assert.equal(result.record.position.status, "frozen", suffix);
    assert.deepEqual(result.record.position.next_actions, ["reconcile_only"], suffix);
    assert.equal(result.record.lifecycle_events.at(-1).type, "observation_unavailable", suffix);
  }
});

test("monitoring stores an exact owner-only collateral recommendation without transferring", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-capital-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid", {
          status: "warning",
          margin_headroom_micro_usdc: 70_000_000,
          runway_ms: 7 * 3_600_000,
          required_owner_response_ms: 4 * 3_600_000,
        }),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "active");
  const plan = result.record.latest_observation.capital_action_plan;
  assert.equal(plan.status, "owner_action_required");
  assert.equal(plan.minimum_additional_collateral_micro_usdc, 10_000_003);
  assert.equal(plan.legs[0].recommended_action, "owner_fund_venue");
  assert.equal(plan.proposal_only, true);
  assert.equal(plan.transaction_broadcast, false);
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("monitor failure quarantines an active position until fresh evidence recovers it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: { hyperliquid: { status: "ready" }, lighter: { status: "ready" } },
    preflight: async () => { throw new Error("venue_read_unavailable"); },
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.observation_ok, false);
  assert.equal(result.record.position.status, "frozen");
  assert.equal(result.record.position.retry_permitted, false);

  const recovered = await runCarryMonitoringTick({
    state,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 200, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    now_ms: NOW + 200,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.checked, 1);
  assert.equal(recovered.results[0].observation_ok, true);
  assert.equal(recovered.results[0].record.position.status, "active");
  assert.equal(recovered.results[0].record.position.terminal_reason, null);
});

test("worker monitoring survives without an open browser", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-background-monitor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const tick = await runCarryMonitoringTick({
    state,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    now_ms: NOW + 100,
  });
  assert.equal(tick.ok, true);
  assert.equal(tick.checked, 1);
  assert.equal(tick.results[0].position_id, active.position.position_id);
  const stored = await state.getCarryPositionRecord(active.position.position_id);
  assert.equal(stored.position.last_event_sequence, 3);
  assert.equal(stored.position.status, "active");
  assert.equal(stored.lifecycle_events.at(-1).observation_source, "supervised_loop");
});

test("worker monitoring refreshes owner-scoped collateral routes from exact account state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-background-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  await activePosition(state);
  const tick = await runCarryMonitoringTick({
    state,
    env: ROUTE_ENV,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    probeTransferRoute: async (request, probeContext) => {
      assert.equal(
        probeContext.venue_access_by_account[request.from_account_commitment].encrypted_vault_commitment,
        `encrypted:${request.from_venue_id}:0001`,
      );
      assert.deepEqual(
        Object.keys(probeContext.venue_access_by_account).sort(),
        [request.from_account_commitment, request.to_account_commitment].sort(),
      );
      return {
        valuation_asset: "USD",
      source_collateral_asset: request.source_collateral_asset,
      destination_collateral_asset: request.destination_collateral_asset,
      conversion_required: request.conversion_required,
      status: "available",
      quote_verified: true,
      all_in_fee_verified: true,
      valuation_basis_verified: true,
      conversion_quote_verified: true,
      conversion_rate_e8: 100_000_000,
      minimum_transfer_micro_usdc: 5_000_000,
      maximum_transfer_micro_usdc: 100_000_000,
      withdrawal_fee_micro_usdc: 10_000,
      deposit_fee_micro_usdc: 0,
      conversion_fee_micro_usdc: 0,
      conversion_slippage_micro_usdc: 0,
      fee_micro_usdc: 10_000,
      estimated_latency_ms: 60_000,
      as_of_ms: request.checked_at_ms,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
        automatic_transfer_permitted: false,
      };
    },
    now_ms: NOW + 100,
  });
  assert.equal(tick.ok, true, JSON.stringify(tick));
  assert.equal(tick.route_observations.length, 1);
  assert.equal(tick.route_observations[0].ok, true);
  assert.equal(tick.route_observations[0].observed_route_count, 2);
  assert.equal(tick.route_observations[0].available_route_count, 2);
  assert.equal(tick.route_observations[0].transaction_broadcast, false);
  const capital = await compileStoredCarryPortfolioCapitalPlan({
    state,
    owner_commitment: OWNER,
    env: ROUTE_ENV,
    now_ms: NOW + 101,
  });
  assert.equal(capital.ok, true, JSON.stringify(capital));
  assert.equal(capital.transfer_route_evidence_status, "verified");
});

test("monitoring checks independent Carry Positions with bounded concurrency", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-monitor-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  await activePosition(state, "0001");
  await activePosition(state, "0002");
  let started = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const tick = await runCarryMonitoringTick({
    state,
    env: { PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY: "2" },
    preflight: async () => {
      started += 1;
      if (started === 2) release();
      await bothStarted;
      return monitoringObservation({
        economic_opportunity: monitoringOpportunity(NOW + 100, 9),
        margin_runways: [
          monitoringRunway("hyperliquid"),
          monitoringRunway("lighter"),
        ],
        qualification_reasons: [],
      });
    },
    now_ms: NOW + 100,
  });
  assert.equal(started, 2);
  assert.equal(tick.ok, true);
  assert.equal(tick.checked, 2);
});

test("monitoring appends only authoritative venue funding settlements", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => [{
      venue_id: body.venue_id,
      asset: "BTC",
      settlement_id: `${body.venue_id}:settlement:1`,
      occurred_at_ms: NOW + 50,
      amount_quote: body.venue_id === "hyperliquid" ? "0.020" : "-0.005",
      quote_asset: "USDC",
    }],
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.funding.status, "current");
  assert.equal(result.record.value_ledger.entries.length, 2);
  assert.equal(result.record.value_ledger.realized.funding_credit_micro_usdc, 20_000);
  assert.equal(result.record.value_ledger.realized.funding_debit_micro_usdc, 5_000);
  assert.equal(result.record.value_evidence.funding.status, "current");
  assert.deepEqual(result.record.value_ledger.entries.map((entry) => entry.source_amount_micro), [20_000, -5_000]);
  assert.ok(result.record.value_ledger.entries.every((entry) => entry.source_asset === "USDC"));
  assert.ok(result.record.value_ledger.entries.every((entry) => entry.cashflow_valuation.verified === true));
});

test("monitoring values native USDT funding with signed conservative rates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-usdt-valuation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "lighter" ? [
      {
        venue_id: body.venue_id,
        asset: "BTC",
        settlement_id: "lighter:usdt:credit",
        occurred_at_ms: NOW + 50,
        amount_quote: "1.0000009",
        quote_asset: "USDT",
        cashflow_valuation: boundCashflowValuation({
          decimal: "1.0000009",
          micro: 1_000_000,
          observedAtMs: NOW + 100,
          creditRateE8: 99_000_000,
          debitRateE8: 101_000_000,
        }),
      },
      {
        venue_id: body.venue_id,
        asset: "BTC",
        settlement_id: "lighter:usdt:debit",
        occurred_at_ms: NOW + 60,
        amount_quote: "-1.0000001",
        quote_asset: "USDT",
        cashflow_valuation: boundCashflowValuation({
          decimal: "-1.0000001",
          micro: -1_000_001,
          observedAtMs: NOW + 100,
          creditRateE8: 99_000_000,
          debitRateE8: 101_000_000,
        }),
      },
    ] : [],
    now_ms: NOW + 100,
  });
  assert.equal(result.funding.status, "current");
  assert.deepEqual(
    result.record.value_ledger.entries.map((entry) => entry.amount_micro_usdc),
    [990_000, 1_010_002],
  );
  assert.deepEqual(
    result.record.value_ledger.entries.map((entry) => entry.source_amount_micro),
    [1_000_000, -1_000_001],
  );
  assert.equal(result.record.value_ledger.realized.funding_credit_micro_usdc, 990_000);
  assert.equal(result.record.value_ledger.realized.funding_debit_micro_usdc, 1_010_002);
});

test("funding valuation uses append time after a delayed historical cutoff", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-delayed-cutoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const appendTime = NOW + 10_000;
  const funding = await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment: OWNER,
    positionId: active.position.position_id,
    venueAccess: monitoringContext().venue_access,
    readFundingSettlements: async ({ body }) => body.venue_id === "lighter" ? [{
      venue_id: "lighter",
      asset: "BTC",
      settlement_id: "lighter:delayed:1",
      occurred_at_ms: NOW + 50,
      amount_quote: "1.000000",
      quote_asset: "USDT",
      cashflow_valuation: boundCashflowValuation({
        decimal: "1.000000",
        micro: 1_000_000,
        observedAtMs: appendTime,
        creditRateE8: 99_000_000,
        debitRateE8: 101_000_000,
      }),
    }] : [],
    nowMs: NOW + 100,
    final: true,
    clock: () => appendTime,
  });
  assert.equal(funding.summary.status, "current");
  assert.equal(funding.record.value_ledger.entries[0].occurred_at_ms, NOW + 50);
  assert.equal(funding.record.value_ledger.entries[0].valued_at_ms, appendTime);
  assert.equal(funding.record.value_evidence.funding.settlement_cutoff_ms, NOW + 100);
  assert.equal(funding.record.value_evidence.funding.valuation_basis, "usdc_equivalent_at_ledger_ingestion");
});

test("funding begins at first observed exposure, excluding pre-fill settlements", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-entry-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const starts = [];
  const funding = await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment: OWNER,
    positionId: active.position.position_id,
    venueAccess: monitoringContext().venue_access,
    readFundingSettlements: async ({ body }) => {
      starts.push(body.start_time_ms);
      return [];
    },
    nowMs: NOW + 100,
  });
  assert.equal(active.position.active_observed_at_ms, NOW + 1);
  assert.deepEqual(starts, [NOW + 1, NOW + 1]);
  assert.equal(funding.record.value_ledger.entries.length, 0);

  const restarted = createWorkerState(dir);
  const replay = await advanceStoredCarryPosition({
    state: restarted,
    position_id: active.position.position_id,
    owner_commitment: OWNER,
    event: lifecycle()[1],
    now_ms: NOW + 1_000,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.position.active_observed_at_ms, NOW + 1);
});

test("inclusive funding boundary replay dedupes before fresh revaluation changes commitment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-boundary-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const collect = (cutoff, valuationTime) => collectStoredCarryFundingEvidence({
    state,
    ownerCommitment: OWNER,
    positionId: active.position.position_id,
    venueAccess: monitoringContext().venue_access,
    readFundingSettlements: async ({ body }) => body.venue_id === "lighter" ? [{
      venue_id: "lighter",
      asset: "BTC",
      settlement_id: "lighter:boundary:stable",
      occurred_at_ms: NOW + 100,
      amount_quote: "1.000000",
      quote_asset: "USDT",
      cashflow_valuation: boundCashflowValuation({
        decimal: "1.000000",
        micro: 1_000_000,
        observedAtMs: valuationTime,
        creditRateE8: valuationTime === NOW + 100 ? 99_000_000 : 98_000_000,
        debitRateE8: 101_000_000,
      }),
    }] : [],
    nowMs: cutoff,
    clock: () => valuationTime,
  });
  const first = await collect(NOW + 100, NOW + 100);
  assert.equal(first.summary.status, "current");
  const replay = await collect(NOW + 200, NOW + 200);
  assert.equal(replay.summary.status, "current");
  assert.equal(replay.record.value_ledger.entries.length, 1);
  assert.equal(replay.record.value_ledger.entries[0].amount_micro_usdc, 990_000);
});

test("non-USDC funding without verified conversion evidence cannot become complete", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-valuation-required-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "lighter" ? [{
      venue_id: body.venue_id,
      asset: "BTC",
      settlement_id: "lighter:usdt:unvalued",
      occurred_at_ms: NOW + 50,
      amount_quote: "1.000000",
      quote_asset: "USDT",
    }] : [],
    now_ms: NOW + 100,
  });
  assert.equal(result.funding.status, "pending");
  assert.equal(result.funding.venue_status.lighter, "funding_cashflow_valuation_required");
  assert.equal(result.record.value_evidence.funding.status, "pending_authoritative_settlement_history");
  assert.equal(result.record.value_evidence.funding.cursor_ms_by_venue.lighter, NOW + 1);
  assert.equal(result.record.value_ledger.entries.length, 0);
});

test("malformed funding history fails closed without advancing venue completeness", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-malformed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "hyperliquid" ? { rows: [] } : [],
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.funding.status, "pending");
  assert.equal(result.funding.venue_status.hyperliquid, "funding_settlement_history_invalid");
  assert.equal(result.record.value_evidence.funding.status, "pending_authoritative_settlement_history");
  assert.equal(result.record.value_evidence.funding.cursor_ms_by_venue.hyperliquid, NOW + 1);
  assert.equal(result.record.value_evidence.funding.cursor_ms_by_venue.lighter, NOW + 100);
  assert.equal(result.record.value_ledger.status, "open");
});

test("monitoring reads both venue funding ledgers concurrently and commits them deterministically", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  let activeReads = 0;
  let maxActiveReads = 0;
  const result = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setImmediate(resolve));
      activeReads -= 1;
      return [{
        venue_id: body.venue_id,
        asset: "BTC",
        settlement_id: `${body.venue_id}:settlement:parallel`,
        occurred_at_ms: NOW + 50,
        amount_quote: body.venue_id === "hyperliquid" ? "0.020" : "-0.005",
        quote_asset: "USDC",
      }];
    },
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.funding.status, "current");
  assert.equal(maxActiveReads, 2);
  assert.deepEqual(result.record.value_ledger.entries.map((entry) => entry.venue_id), ["hyperliquid", "lighter"]);
  assert.deepEqual(result.record.value_ledger.entries.map((entry) => entry.sequence), [1, 2]);
});

test("authoritative funding backfill resumes across ticks for a year-long Carry Position", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-backfill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(
    state,
    "0001",
    {},
    monitoringContext(),
    NOW + (366 * 86_400_000),
  );
  const day = 86_400_000;
  const firstNow = NOW + (200 * day);
  const reads = [];
  const observe = (nowMs) => observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(nowMs, 9),
      margin_runways: [
        monitoringRunway("hyperliquid", { as_of_ms: nowMs }),
        monitoringRunway("lighter", { as_of_ms: nowMs }),
      ],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => {
      reads.push({ venue_id: body.venue_id, start_time_ms: body.start_time_ms, end_time_ms: body.end_time_ms });
      return [];
    },
    now_ms: nowMs,
  });

  const first = await observe(firstNow);
  assert.equal(first.ok, true);
  assert.equal(first.funding.status, "pending");
  assert.deepEqual(first.funding.venue_status, {
    hyperliquid: "history_backfill_pending",
    lighter: "history_backfill_pending",
  });
  assert.equal(first.record.value_evidence.funding.cursor_ms_by_venue.hyperliquid, NOW + 1 + (112 * day));
  assert.equal(first.record.value_evidence.funding.cursor_ms_by_venue.lighter, NOW + 1 + (112 * day));
  assert.equal(reads.filter((item) => item.venue_id === "hyperliquid").length, 16);
  assert.equal(reads.filter((item) => item.venue_id === "lighter").length, 16);

  reads.length = 0;
  const second = await observe(firstNow + 1);
  assert.equal(second.ok, true);
  assert.equal(second.funding.status, "current");
  assert.equal(second.record.value_evidence.funding.cursor_ms_by_venue.hyperliquid, firstNow + 1);
  assert.equal(second.record.value_evidence.funding.cursor_ms_by_venue.lighter, firstNow + 1);
  assert.equal(reads.find((item) => item.venue_id === "hyperliquid")?.start_time_ms, NOW + 1 + (112 * day));
  assert.equal(reads.find((item) => item.venue_id === "lighter")?.start_time_ms, NOW + 1 + (112 * day));
});

test("monitoring canonicalizes settlement order and rejects a changed replay", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-funding-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const first = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "hyperliquid" ? [
      { venue_id: body.venue_id, asset: "BTC", settlement_id: "hl:later", occurred_at_ms: NOW + 20, amount_quote: "0.002", quote_asset: "USDC" },
      { venue_id: body.venue_id, asset: "BTC", settlement_id: "hl:earlier", occurred_at_ms: NOW + 10, amount_quote: "0.001", quote_asset: "USDC" },
    ] : [],
    now_ms: NOW + 100,
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.record.value_ledger.entries.map((entry) => entry.amount_micro_usdc), [1_000, 2_000]);

  const replay = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 200, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "hyperliquid" ? [{
      venue_id: body.venue_id,
      asset: "BTC",
      settlement_id: "hl:later",
      occurred_at_ms: NOW + 150,
      amount_quote: "9.999",
      quote_asset: "USDC",
    }] : [],
    now_ms: NOW + 200,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.funding.status, "pending");
  assert.equal(replay.funding.venue_status.hyperliquid, "funding_settlement_persistence_failed");
  assert.equal(replay.record.value_ledger.entries.length, 2);
  assert.equal(replay.record.value_ledger.realized.funding_credit_micro_usdc, 3_000);
});

test("compiles an owner-only portfolio capital plan from stored monitoring evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-portfolio-capital-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const observed = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid", {
          status: "warning",
          margin_headroom_micro_usdc: 70_000_000,
          runway_ms: 7 * 3_600_000,
          required_owner_response_ms: 4 * 3_600_000,
        }),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    now_ms: NOW + 100,
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.observation_ok, true, JSON.stringify(observed));
  const unrouted = await compileStoredCarryPortfolioCapitalPlan({
    state,
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    now_ms: NOW + 100,
  });
  assert.equal(unrouted.ok, true, JSON.stringify(unrouted));
  assert.equal(unrouted.plan.total_proposed_internal_reallocation_micro_usdc, 0);
  assert.equal(unrouted.plan.net_new_owner_capital_requested_micro_usdc, 10_000_003);
  assert.ok(unrouted.plan.transfer_route_failures.some((reason) => reason.startsWith("transfer_route_missing:")));
  assert.equal(unrouted.transfer_route_evidence_status, "unavailable");
  await storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: ROUTE_ENV.PRIVATE_AGENT_IMAGE_DIGEST,
    routes: [transferRoute()],
    checked_at_ms: NOW + 100,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW + 100,
  });
  const result = await compileStoredCarryPortfolioCapitalPlan({
    state,
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    env: ROUTE_ENV,
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transfer_route_evidence_status, "verified");
  assert.match(result.transfer_route_evidence_commitment, /^carry:transfer-routes:evidence:/);
  assert.equal(result.plan.status, "owner_action_required");
  assert.equal(result.plan.total_requested_micro_usdc, 10_000_003);
  assert.equal(result.plan.total_potential_releasable_micro_usdc, 9_999_997);
  assert.equal(result.plan.total_proposed_internal_reallocation_micro_usdc, 9_999_997);
  assert.equal(result.plan.net_new_owner_capital_requested_micro_usdc, 6);
  assert.equal(result.plan.total_proposed_allocation_micro_usdc, 6);
  assert.equal(result.plan.total_uncovered_shortfall_micro_usdc, 0);
  assert.equal(result.plan.allocations[0].venue_id, "hyperliquid");
  assert.equal(result.plan.proposed_reallocations[0].from_venue_id, "lighter");
  assert.equal(result.plan.proposed_reallocations[0].to_venue_id, "hyperliquid");
  assert.equal(result.plan.owner_transfer_approval_required, true);
  assert.equal(result.plan.owner_approval_required, true);
  assert.equal(result.plan.proposal_only, true);
  assert.equal(result.plan.transaction_broadcast, false);
  assert.equal(result.plan.automatic_transfer_permitted, false);
  const review = await compileStoredCarryCollateralReview({
    state,
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    env: ROUTE_ENV,
    now_ms: NOW + 100,
  });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.review.status, "signature_required");
  assert.equal(review.review.owner_commitment, OWNER);
  assert.equal(review.review.owner_wallet_address, TEST_CARRY_OWNER_WALLET_ADDRESS);
  assert.equal(review.review.transfer_instructions.length, 1);
  assert.equal(review.review.funding_instructions.length, 1);
  assert.equal(review.review.execution_authorized, false);
  assert.equal(review.review.fund_movement_authorized, false);
  assert.equal(review.review.transaction_broadcast, false);
  const reviewAuthorization = await signedCarryCollateralReviewAuthorization(review.review);
  const concurrentApprovals = await Promise.all([1, 2].map(() => approveStoredCarryCollateralReview({
    state,
    owner_commitment: OWNER,
    authorization: reviewAuthorization,
    env: ROUTE_ENV,
    now_ms: NOW + 101,
  })));
  const approval = concurrentApprovals.find((result) => result.ok === true);
  const concurrentReplay = concurrentApprovals.find((result) => result.ok === false);
  assert.deepEqual(concurrentReplay, { ok: false, error: "carry_collateral_review_replayed" });
  assert.equal(approval.ok, true, JSON.stringify(approval));
  assert.equal(approval.receipt.status, "owner_signature_verified");
  assert.equal(approval.receipt.instruction_count, 2);
  assert.equal(approval.receipt.approved_target_accounts.length, 1);
  assert.equal(approval.receipt.approved_target_accounts[0].venue_id, "hyperliquid");
  assert.equal(approval.receipt.execution_authorized, false);
  assert.equal(approval.receipt.fund_movement_authorized, false);
  assert.equal(approval.receipt.transaction_broadcast, false);
  const persistedApproval = await compileStoredCarryCollateralReview({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    env: ROUTE_ENV,
    now_ms: NOW + 103,
  });
  assert.equal(persistedApproval.ok, true, JSON.stringify(persistedApproval));
  assert.equal(persistedApproval.approval_receipt.status, "owner_signature_verified");
  assert.equal(persistedApproval.approval_receipt.plan_commitment, persistedApproval.plan_commitment);
  assert.equal(persistedApproval.approval_receipt.transaction_broadcast, false);
  assert.equal(persistedApproval.outcome_receipt.status, "owner_action_pending");
  assert.equal(persistedApproval.outcome_receipt.capital_outcome_verified, false);
  const replay = await approveStoredCarryCollateralReview({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    authorization: reviewAuthorization,
    env: ROUTE_ENV,
    now_ms: NOW + 102,
  });
  assert.deepEqual(replay, { ok: false, error: "carry_collateral_review_replayed" });
  const value = await compileStoredCarryPortfolioValueReport({
    state,
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    env: ROUTE_ENV,
    now_ms: NOW + 100,
  });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.report.value_proof_status, "accruing");
  assert.equal(value.report.position_count, 1);
  assert.equal(value.report.modeled.net_value_micro_usdc, 20_000);
  assert.equal(value.report.finalized_after_costs.position_count, 0);
  assert.equal(value.report.capital_efficiency.status, "ready");
  assert.equal(value.report.capital_efficiency.potential_new_cash_avoided_micro_usdc, 9_999_997);
  assert.equal(value.report.capital_efficiency.new_owner_cash_requested_micro_usdc, 6);
  assert.equal(value.report.transaction_broadcast, false);
  const restored = await observeStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: active.position.position_id,
    venue_access: monitoringContext().venue_access,
    preflight: async () => monitoringObservation({
      economic_opportunity: monitoringOpportunity(NOW + 200, 9),
      margin_runways: [
        monitoringRunway("hyperliquid", {
          as_of_ms: NOW + 200,
          status: "healthy",
          margin_headroom_micro_usdc: 90_000_000,
          runway_ms: 9 * 3_600_000,
          required_owner_response_ms: 4 * 3_600_000,
        }),
        monitoringRunway("lighter", { as_of_ms: NOW + 200 }),
      ],
      qualification_reasons: [],
    }),
    now_ms: NOW + 200,
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const verifiedOutcome = await compileStoredCarryCollateralReview({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 5_000_000,
    max_data_age_ms: 30_000,
    env: ROUTE_ENV,
    now_ms: NOW + 201,
  });
  assert.equal(verifiedOutcome.ok, true, JSON.stringify(verifiedOutcome));
  assert.equal(verifiedOutcome.review.status, "no_action");
  assert.equal(verifiedOutcome.outcome_receipt.status, "safe_runway_verified");
  assert.equal(verifiedOutcome.outcome_receipt.capital_outcome_verified, true);
  assert.equal(verifiedOutcome.outcome_receipt.account_state_checked, true);
  assert.equal(verifiedOutcome.outcome_receipt.fund_movement_verified, false);
  assert.equal(verifiedOutcome.outcome_receipt.transaction_broadcast, false);
  assert.equal(verifiedOutcome.outcome_receipt.accounts[0].status, "safe_runway_verified");
  const durableOutcome = await createWorkerState(dir).getIdempotency(
    `carry-collateral-outcome:${approval.receipt.plan_commitment}`,
  );
  assert.equal(durableOutcome.receipt.status, "safe_runway_verified");
  assert.equal(durableOutcome.receipt.capital_outcome_verified, true);
});

test("portfolio capital endpoint fails closed when an active position lacks monitoring evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-portfolio-capital-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const result = await compileStoredCarryPortfolioCapitalPlan({
    state,
    owner_commitment: OWNER,
    owner_capital_budget_micro_usdc: 0,
    now_ms: NOW + 100,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_portfolio_capital_evidence_incomplete");
  assert.deepEqual(result.missing_position_ids, [active.position.position_id]);
  assert.equal(result.transaction_broadcast, false);
  const review = await compileStoredCarryCollateralReview({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 100,
  });
  assert.equal(review.ok, false);
  assert.equal(review.error, "carry_portfolio_capital_evidence_incomplete");
  assert.equal(review.review_only, true);
  assert.equal(review.execution_authorized, false);
  const value = await compileStoredCarryPortfolioValueReport({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 100,
  });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.report.value_proof_status, "accruing");
  assert.equal(value.report.capital_efficiency.status, "incomplete");
  assert.deepEqual(value.report.capital_efficiency.missing_position_ids, [active.position.position_id]);
  assert.equal(value.report.capital_efficiency.potential_new_cash_avoided_micro_usdc, null);
});

async function activePosition(
  state,
  suffix = "0001",
  riskOverrides = {},
  context = monitoringContext(),
  expiresAtMs = NOW + (30 * 86_400_000),
) {
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: await positionInput(suffix, riskOverrides, expiresAtMs),
    opportunity: opportunity(),
    monitoring_context: context,
    now_ms: NOW,
  });
  let record = created.record;
  for (const item of lifecycle().slice(0, 2)) {
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: record.position.position_id,
      owner_commitment: OWNER,
      event: item,
      now_ms: NOW + item.sequence,
    });
    record = advanced.record;
  }
  return record;
}

async function positionInput(
  suffix = "0001",
  riskOverrides = {},
  expiresAtMs = NOW + (30 * 86_400_000),
  positionOverrides = {},
) {
  return signedCarryPositionInput({
    version: 1,
    position_id: `carry:position:stored:${suffix}`,
    mandate_id: `carry:mandate:stored:${suffix}`,
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    opportunity_evidence_commitment: opportunity().worker_authentication.evidence_commitment,
    risk_mandate: {
      min_expected_net_benefit_bps: 1,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 3_600_000,
      max_hedge_error_micro_usdc: 0,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: false,
      ...riskOverrides,
    },
    ...positionOverrides,
  }, { ownerCommitment: OWNER, nowMs: NOW, expiresAtMs });
}

function opportunity(overrides = {}) {
  const inputEvidence = carryOpportunityInputEvidence("hyperliquid", "lighter");
  const value = {
    version: 1,
    eligible: true,
    reasons: [],
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
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
    long_quote_asset: "USD",
    short_quote_asset: "USD",
    checked_at_ms: NOW,
    all_venues_ready: true,
    live_creation_ready: true,
    long_margin_runway_ms: 7_200_000,
    short_margin_runway_ms: 7_200_000,
    ...overrides,
  };
  value.input_evidence ??= carryOpportunityInputEvidence(value.long_venue_id, value.short_venue_id);
  const [longRisk, shortRisk] = value.input_evidence.legs;
  value.long_initial_margin_bps = overrides.long_initial_margin_bps ?? longRisk.initial_margin_bps;
  value.short_initial_margin_bps = overrides.short_initial_margin_bps ?? shortRisk.initial_margin_bps;
  value.long_maintenance_margin_bps = overrides.long_maintenance_margin_bps ?? longRisk.maintenance_margin_bps;
  value.short_maintenance_margin_bps = overrides.short_maintenance_margin_bps ?? shortRisk.maintenance_margin_bps;
  value.long_liquidation_fee_bps = overrides.long_liquidation_fee_bps ?? longRisk.liquidation_fee_bps;
  value.short_liquidation_fee_bps = overrides.short_liquidation_fee_bps ?? shortRisk.liquidation_fee_bps;
  value.long_margin_model = overrides.long_margin_model ?? longRisk.margin_model;
  value.short_margin_model = overrides.short_margin_model ?? shortRisk.margin_model;
  value.long_liquidation_model = overrides.long_liquidation_model ?? longRisk.liquidation_model;
  value.short_liquidation_model = overrides.short_liquidation_model ?? shortRisk.liquidation_model;
  return {
    ...value,
    worker_authentication: authenticateCarryCreationOpportunity({
      owner_commitment: OWNER,
      opportunity: value,
    }),
  };
}

function monitoringOpportunity(checkedAtMs, projectedNetValueBps, overrides = {}) {
  return {
    checked_at_ms: checkedAtMs,
    projected_net_value_bps: projectedNetValueBps,
    economic_equivalence_id: "carry:BTC-usd-linear",
    contract_data_skew_ms: 0,
    max_contract_data_skew_ms: 2_000,
    index_price_divergence_bps: 0,
    mark_price_divergence_bps: 0,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    funding_observation: monitoringFundingObservation(checkedAtMs),
    ...overrides,
  };
}

function monitoringFundingObservation(checkedAtMs) {
  return {
    evidence_commitment: `carry:funding:current:${checkedAtMs.toString(16).padStart(64, "0")}`,
    source_observed_at_ms_by_venue: {
      hyperliquid: checkedAtMs,
      lighter: checkedAtMs,
    },
  };
}

function monitoringRunway(venueId, overrides = {}) {
  return {
    version: 1,
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    as_of_ms: NOW,
    status: "healthy",
    margin_headroom_micro_usdc: 20_000_000,
    stress_burn_micro_usdc_per_hour: 10_000_000,
    runway_ms: 7_200_000,
    required_owner_response_ms: 1_800_000,
    owner_action_required: false,
    automatic_transfer_permitted: false,
    position_open: true,
    liquidation_distance_bps: 2_500,
    minimum_liquidation_distance_bps: 1_000,
    liquidation_distance_verified: true,
    liquidation_distance_source: liquidationDistanceSourceForVenue(venueId),
    ...overrides,
  };
}

function monitoringObservation(value, evidenceOverrides = {}) {
  const checkedAtMs = value.economic_opportunity.checked_at_ms;
  const runways = value.margin_runways.map((runway) => {
    const timedRunway = { ...runway, as_of_ms: checkedAtMs };
    return {
      ...timedRunway,
      account_state_commitment: monitoringAccountState(
        timedRunway,
        evidenceOverrides[runway.venue_id],
      ).account_state_commitment,
    };
  });
  return {
    ...value,
    margin_runways: runways,
    evidence: runways.map((runway) => ({
      venue_id: runway.venue_id,
      account_state: monitoringAccountState(runway, evidenceOverrides[runway.venue_id]),
    })),
  };
}

function monitoringAccountState(runway, overrides = {}) {
  const material = {
    venue_id: runway.venue_id,
    account_commitment: runway.account_commitment,
    verification_commitment: `verify:${runway.venue_id}:0001`,
    checked_at_ms: runway.as_of_ms,
    position_count: runway.position_open === false ? 0 : 1,
    open_order_count: 0,
    flat_zero_orders: runway.position_open === false,
    liquidation_distance_bps: runway.liquidation_distance_bps,
    liquidation_distance_verified: runway.liquidation_distance_verified,
    liquidation_distance_source: runway.liquidation_distance_source,
    inventory: monitoringInventory(runway.venue_id, runway.position_open !== false),
    ...overrides,
  };
  return {
    ...material,
    account_state_commitment: overrides.account_state_commitment
      ?? carryAccountStateCommitment(material),
  };
}

function monitoringInventory(venueId, positionOpen = true) {
  const accountCommitment = `account:${venueId}:0001`;
  return {
    version: 1,
    target_market: "BTC",
    position_inventory_verified: true,
    open_order_inventory_verified: true,
    target_positions: positionOpen ? [{
      market: "BTC",
      side: venueId === "hyperliquid" ? "long" : "short",
      base_size: "0.001",
      position_identity_commitment: carryInventoryPositionIdentityCommitment({
        venue_id: venueId,
        account_commitment: accountCommitment,
        market: "BTC",
      }),
    }] : [],
    target_open_orders: [],
  };
}

function exactFlatReconciliation(positionId, venueIds, checkedAtMs) {
  const evidence = {
    owner_commitment: OWNER,
    carry_position_id: positionId,
    account_state_checked: true,
    transaction_broadcast: false,
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    checked_at_ms: checkedAtMs,
    reconciliation_commitment: null,
    venues: venueIds.map((venueId) => ({
      venue_id: venueId,
      account_commitment: `account:${venueId}:0001`,
      authorized: true,
      flat_zero_orders: true,
      position_count: 0,
      open_order_count: 0,
      account_state_checked: true,
      position_identity_commitment: carryInventoryPositionIdentityCommitment({
        venue_id: venueId,
        account_commitment: `account:${venueId}:0001`,
        market: "BTC",
      }),
      inventory: monitoringInventory(venueId, false),
    })),
  };
  evidence.reconciliation_commitment = carryReconciliationCommitment(evidence);
  return evidence;
}

function transferRoute(overrides = {}) {
  return {
    version: 1,
    route_id: "carry:transfer-route:lighter-hyperliquid:0001",
    from_account_commitment: "account:lighter:0001",
    from_venue_id: "lighter",
    to_account_commitment: "account:hyperliquid:0001",
    to_venue_id: "hyperliquid",
    source_adapter_id: "lighter_arbitrum_usdc_v1",
    destination_adapter_id: "hyperliquid_arbitrum_usdc_v1",
    source_account_state_commitment: monitoringAccountState({
      ...monitoringRunway("lighter"),
      as_of_ms: NOW + 100,
    }).account_state_commitment,
    destination_account_state_commitment: monitoringAccountState({
      ...monitoringRunway("hyperliquid"),
      as_of_ms: NOW + 100,
    }).account_state_commitment,
    quote_commitment: "carry:transfer-quote:0001",
    valuation_asset: "USD",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    status: "available",
    quote_verified: true,
    all_in_fee_verified: true,
    valuation_basis_verified: true,
    conversion_quote_verified: true,
    conversion_rate_e8: 100_000_000,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 100_000_000,
    withdrawal_fee_micro_usdc: 0,
    deposit_fee_micro_usdc: 0,
    conversion_fee_micro_usdc: 0,
    conversion_slippage_micro_usdc: 0,
    fee_micro_usdc: 0,
    estimated_latency_ms: 60_000,
    as_of_ms: NOW + 100,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}

function monitoringContext(venueIds = ["hyperliquid", "lighter"]) {
  const access = (venueId) => ({
    status: "ready",
    owner_commitment: OWNER,
    account_commitment: `account:${venueId}:0001`,
    vault_commitment: `vault:${venueId}:0001`,
    encrypted_vault_commitment: `encrypted:${venueId}:0001`,
    policy_commitment: `policy:${venueId}:0001`,
    encrypted_execution_vault: { version: 1, ciphertext: `sealed:${venueId}` },
  });
  return {
    version: 1,
    venue_access: Object.fromEntries(venueIds.map((venueId) => [venueId, access(venueId)])),
  };
}

function lifecycle() {
  return [
    event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000,
      short_filled_micro_usdc: 10_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_observed_at_ms: NOW + 1,
      exposure_boundary_provenance: "worker_observed_positive_fill",
      inventory_expectation_by_venue: monitoringInventoryExpectations(),
    }),
    event(3, "manual_exit_requested"),
    event(4, "exit_reconciled", {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      account_state_checked: true,
      reconciliation_commitment: "carry:reconciliation:0001",
    }),
  ];
}

function monitoringInventoryExpectations() {
  return Object.fromEntries(["hyperliquid", "lighter"].map((venueId) => [
    venueId,
    carryInventoryExpectation({
      venue_id: venueId,
      account_commitment: `account:${venueId}:0001`,
      market: "BTC",
      side: venueId === "hyperliquid" ? "buy" : "sell",
      base_size: "0.001",
      entry_work_order_commitment: `work:carry:entry:${venueId}`,
      entry_provider_ref_commitment: `provider:carry:entry:${venueId}`,
      entry_client_order_identity_commitment: carryInventoryClientOrderIdentityCommitment({
        venue_id: venueId,
        client_order_id: `entry-${venueId}-0001`,
      }),
      entry_provider_order_identity_commitment: carryInventoryProviderOrderIdentityCommitment({
        venue_id: venueId,
        provider_order_id: `provider-order-${venueId}-0001`,
      }),
    }),
  ]));
}

function completeValueEvidence() {
  return {
    entry: { status: "complete" },
    exit: { status: "complete" },
    funding: { status: "complete_through_exit" },
    realized_economics: { status: "complete" },
    costs_complete: true,
  };
}

function finalizationEvidence() {
  return {
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    costs_complete: true,
    reconciliation_commitment: "carry:reconciliation:0001",
  };
}

function event(sequence, type, overrides = {}) {
  return { version: 1, event_id: `carry:event:stored:${sequence}`, sequence, type, ...overrides };
}
