import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  advanceStoredCarryPosition,
  appendStoredCarryValueEntry,
  approveStoredCarryCollateralReview,
  compileStoredCarryCollateralReview,
  compileStoredCarryPortfolioCapitalPlan,
  compileStoredCarryPortfolioValueReport,
  createStoredCarryPosition,
  finalizeStoredCarryValueLedger,
  observeStoredCarryPosition,
  requestStoredCarryPositionExit,
  runCarryMonitoringTick,
  verifyStoredCarryOpportunityBinding,
} from "../src/execution/carry-positions.js";
import { storeCarryTransferRouteEvidence } from "../src/execution/carry-transfer-routes.js";
import { authenticateCarryCreationOpportunity } from "../src/execution/carry-opportunity-authentication.js";
import { createWorkerState } from "../src/state/private-state.js";
import {
  signedCarryCollateralReviewAuthorization,
  signedCarryPositionInput,
  TEST_CARRY_OWNER_WALLET_ADDRESS,
} from "./carry-mandate-fixture.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:commitment:0001";
const ROUTE_ENV = { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"a".repeat(64)}` };

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
      venue_id: "lighter",
      leg_id: "carry:leg:short",
      occurred_at_ms: NOW + 10,
      evidence_commitment: "carry:value:evidence:0001",
    },
    now_ms: NOW + 10,
  });
  assert.equal(valued.ok, true);
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

  state = createWorkerState(dir);
  const reloaded = await state.getCarryPositionRecord(record.position.position_id);
  assert.equal(reloaded.position.status, "reconciled");
  assert.equal(reloaded.value_ledger.realized.net_value_micro_usdc, 21_000);
  assert.equal(reloaded.value_ledger.realized.attribution.status, "finalized");
  assert.equal(reloaded.value_ledger.finalization_evidence.open_order_count, 0);
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
  const preflight = async ({ body }) => {
    assert.equal(body.risk_mandate.max_contract_data_skew_ms, 2_000);
    return {
      version: 1,
      mode: "paired_monitoring_no_submit",
      no_submit_ready: true,
      transaction_broadcast: false,
      economic_opportunity: monitoringOpportunity(NOW + body.work_order_commitment.length, -1),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    };
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
  const preflight = async ({ body }) => {
    phases.push(body.phase);
    if (body.phase === "monitoring") {
      return {
        version: 1,
        mode: "paired_monitoring_no_submit",
        no_submit_ready: true,
        transaction_broadcast: false,
        economic_opportunity: monitoringOpportunity(NOW + phases.length, -1),
        margin_runways: [
          monitoringRunway("hyperliquid"),
          monitoringRunway("lighter"),
        ],
        qualification_reasons: [],
      };
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
    const advanced = await advanceStoredCarryPosition({
      state,
      position_id: parent.position.position_id,
      owner_commitment: OWNER,
      event: event(sequence, "observation", {
        ...monitoringOpportunity(NOW + sequence, -1),
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
  const reconciled = await advanceStoredCarryPosition({
    state,
    position_id: parent.position.position_id,
    owner_commitment: OWNER,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 5,
  });
  assert.equal(reconciled.record.position.pending_migration.status, "owner_signature_required");
  const storedParent = await state.getCarryPositionRecord(parent.position.position_id);
  const finalizedParent = await state.putCarryPositionRecord({
    ...storedParent,
    final_reconciliation_evidence: {
      owner_commitment: OWNER,
      carry_position_id: parent.position.position_id,
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: NOW + 5,
      reconciliation_commitment: "carry:reconciliation:migration-parent:0001",
      venues: [
        { venue_id: "hyperliquid", account_commitment: "account:hyperliquid:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "lighter", account_commitment: "account:lighter:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
      ],
    },
  }, { expected_version: storedParent.record_version });
  assert.equal(finalizedParent.ok, true);

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
    preflight: async () => ({
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
    preflight: async () => ({
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

test("monitor failure freezes an active position without retry", async (t) => {
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
});

test("worker monitoring survives without an open browser", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-background-monitor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const active = await activePosition(state);
  const tick = await runCarryMonitoringTick({
    state,
    preflight: async () => ({
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
    preflight: async () => ({
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
      return {
        economic_opportunity: monitoringOpportunity(NOW + 100, 9),
        margin_runways: [
          monitoringRunway("hyperliquid"),
          monitoringRunway("lighter"),
        ],
        qualification_reasons: [],
      };
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
    preflight: async () => ({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [
        monitoringRunway("hyperliquid"),
        monitoringRunway("lighter"),
      ],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => [{
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
    preflight: async () => ({
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
    preflight: async () => ({
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
  assert.equal(first.record.value_evidence.funding.cursor_ms_by_venue.hyperliquid, NOW + (112 * day));
  assert.equal(first.record.value_evidence.funding.cursor_ms_by_venue.lighter, NOW + (112 * day));
  assert.equal(reads.filter((item) => item.venue_id === "hyperliquid").length, 16);
  assert.equal(reads.filter((item) => item.venue_id === "lighter").length, 16);

  reads.length = 0;
  const second = await observe(firstNow + 1);
  assert.equal(second.ok, true);
  assert.equal(second.funding.status, "current");
  assert.equal(second.record.value_evidence.funding.cursor_ms_by_venue.hyperliquid, firstNow + 1);
  assert.equal(second.record.value_evidence.funding.cursor_ms_by_venue.lighter, firstNow + 1);
  assert.equal(reads.find((item) => item.venue_id === "hyperliquid")?.start_time_ms, NOW + (112 * day));
  assert.equal(reads.find((item) => item.venue_id === "lighter")?.start_time_ms, NOW + (112 * day));
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
    preflight: async () => ({
      economic_opportunity: monitoringOpportunity(NOW + 100, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "hyperliquid" ? [
      { settlement_id: "hl:later", occurred_at_ms: NOW + 20, amount_quote: "0.002", quote_asset: "USDC" },
      { settlement_id: "hl:earlier", occurred_at_ms: NOW + 10, amount_quote: "0.001", quote_asset: "USDC" },
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
    preflight: async () => ({
      economic_opportunity: monitoringOpportunity(NOW + 200, 9),
      margin_runways: [monitoringRunway("hyperliquid"), monitoringRunway("lighter")],
      qualification_reasons: [],
    }),
    readFundingSettlements: async ({ body }) => body.venue_id === "hyperliquid" ? [{
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
    preflight: async () => ({
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
    preflight: async () => ({
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
    ...overrides,
  };
}

function monitoringRunway(venueId, overrides = {}) {
  return {
    version: 1,
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    account_state_commitment: `carry:account-state:${venueId}:0001`,
    as_of_ms: NOW,
    status: "healthy",
    margin_headroom_micro_usdc: 20_000_000,
    stress_burn_micro_usdc_per_hour: 10_000_000,
    runway_ms: 7_200_000,
    required_owner_response_ms: 1_800_000,
    owner_action_required: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
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
    source_account_state_commitment: "carry:account-state:lighter:0001",
    destination_account_state_commitment: "carry:account-state:hyperliquid:0001",
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
    }),
    event(3, "manual_exit_requested"),
    event(4, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
  ];
}

function event(sequence, type, overrides = {}) {
  return { version: 1, event_id: `carry:event:stored:${sequence}`, sequence, type, ...overrides };
}
