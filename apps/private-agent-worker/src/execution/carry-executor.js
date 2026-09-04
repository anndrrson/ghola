import { createHash } from "node:crypto";
import {
  cashflowValuationEvidenceMessage,
  convertSignedCashflowToMicroUsdc,
  exactQuantityRecoveryAdapter,
  normalizeCashflowValuation,
} from "@ghola/execution-core";
import {
  advanceStoredCarryPosition,
  appendStoredCarryValueEntry,
  collectStoredCarryFundingEvidence,
  finalizeStoredCarryValueLedger,
  verifyStoredCarryOpportunityBinding,
} from "./carry-positions.js";
import { preflightCarryPair } from "./carry-preflight.js";
import { verifyCarryRiskMandateAuthorization } from "./carry-mandate.js";
import { hasExactCarryFlatReconciliation } from "./carry-reconciliation.js";
import { listAllCarryPositionRecords } from "./carry-record-scan.js";
import { createCarryLoopSupervisor, disabledCarryLoopHealth } from "./carry-loop-supervisor.js";
import {
  readCarryVenueQualification,
  recordCompletedCarryVenueQualifications,
  runtimeCarryQualificationImageDigest,
} from "./carry-qualification.js";
import { readCarryExecutionReadiness } from "./carry-readiness.js";
import { readCarryShadowQualification } from "./carry-shadow-qualification.js";
import { buildCarryPrivatePrimeReadiness } from "./carry-private-prime-readiness.js";
import { verifyCashflowValuationEvidence } from "./carry-stablecoin-conversion.js";
import { loadCarryTransferRouteEvidence } from "./carry-transfer-routes.js";
import { recordCompletedCarryLifecycleProof } from "./carry-release-evidence.js";
import {
  applyDurableMultiLegEvent,
  createDurableMultiLegSaga,
  readDurableRecoveryAccounting,
} from "./multi-leg-orchestrator.js";

export async function executeStoredCarryEntry({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  recipient,
  verifyOrder,
  executeOrder,
  qualification_confirmed: qualificationConfirmed = false,
  carry_supervision: carrySupervision = null,
  preflight = preflightCarryPair,
  env = process.env,
  now = () => Date.now(),
}) {
  let record = await state.getCarryPositionRecord(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  if (record.position.status !== "draft") return denied("carry_entry_already_started");
  if (record.entry_saga_id) return denied("carry_entry_already_started");
  if (!record.monitoring_context?.venue_access) return denied("carry_monitor_context_missing");
  const storedOpportunity = verifyStoredCarryOpportunityBinding({ record });
  if (!storedOpportunity.ok) return storedOpportunity;
  const mandate = await verifyCarryRiskMandateAuthorization({
    owner_commitment: ownerCommitment,
    position_input: record.position,
    now_ms: now(),
  });
  if (!mandate.ok) return denied(mandate.error);
  const live = env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true";
  const pilotRecord = record.qualification_pilot?.status === "pending";
  if (live && env.PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT !== "true") return denied("carry_position_live_submit_disabled");
  if (live && pilotRecord && qualificationConfirmed !== true) return denied("carry_qualification_pilot_confirmation_required");
  let pilotBootstrap = false;
  if (live) {
    if (!pilotRecord) {
      const privatePrimeReadiness = await readCarryEntryPrivatePrimeReadiness({
        state,
        record,
        owner_commitment: ownerCommitment,
        carry_supervision: carrySupervision,
        now_ms: now(),
        env,
      });
      if (privatePrimeReadiness.no_submit_ready !== true) {
        return {
          ...denied("carry_entry_private_prime_readiness_unproven"),
          private_prime_readiness: privatePrimeReadiness,
        };
      }
    }
    const qualifications = await Promise.all([record.position.long_venue_id, record.position.short_venue_id].map((venueId) =>
      readCarryVenueQualification({ state, venue_id: venueId, now_ms: now(), env })
    ));
    pilotBootstrap = qualificationPilotBootstrapAllowed({ record, qualifications, env });
    if (!qualifications.every((item) => item.proven) && !pilotBootstrap) return denied("exact_quantity_recovery_unproven");
  }

  const startedAt = now();
  let proof;
  try {
    proof = await preflight({
      body: preflightBody(record, startedAt),
      recipient,
      state,
      verifyOrder,
      env,
      now: () => startedAt,
    });
  } catch (error) {
    return denied(errorCode(error, "carry_entry_preflight_failed"));
  }
  const qualifiedProof = pilotBootstrap
    ? proof?.qualification_pilot_ready === true
      && proof?.qualification_pilot_candidate_venue_id === record.qualification_pilot.candidate_venue_id
    : proof?.live_creation_ready === true;
  if (!qualifiedProof || proof?.no_submit_ready !== true || proof?.transaction_broadcast !== false) {
    return denied("carry_entry_preflight_not_qualified");
  }
  const legs = buildLegs(record, proof, startedAt);
  if (!legs.ok) return legs;
  const sagaId = `saga:carry:${digest(`${positionId}:${startedAt}`).slice(0, 40)}`;
  const policy = carrySessionPolicy(record, legs.legs, startedAt);
  const created = await createDurableMultiLegSaga({
    state,
    definition: {
      version: 1,
      saga_id: sagaId,
      idempotency_key: `idem:carry:${digest(`${positionId}:entry`).slice(0, 40)}`,
      plan_commitment: `plan:carry:${digest(JSON.stringify(legs.legs)).slice(0, 40)}`,
      strategy_id: "delta_neutral_carry",
      max_unhedged_ms: boundedMs(env.PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS, 250, 60_000, 2_000),
      max_hedge_error_micro_usdc: record.position.risk_mandate.max_hedge_error_micro_usdc,
      now_ms: startedAt,
      legs: legs.legs.map((leg) => ({
        leg_id: leg.leg_id,
        venue_id: leg.venue_id,
        asset: record.position.asset,
        market: leg.market,
        product_type: "perp",
        operation_class: "limit_order",
        side: leg.side,
        notional_micro_usdc: record.position.target_notional_micro_usdc,
      })),
    },
    execution_context: {
      version: 1,
      carry_position_id: positionId,
      owner_commitment: ownerCommitment,
      policy_commitment: policy.policy_commitment,
      session_policy: policy,
      venue_access: record.monitoring_context.venue_access,
      legs: legs.legs.map((leg) => ({
        leg_id: leg.leg_id,
        work_order_commitment: leg.work_order_commitment,
        instruction: leg.instruction,
        accounting_reference_mark_price_e8: leg.reference_mark_price_e8,
        accounting_quote_asset: leg.quote_asset,
        accounting_fee_settlement_asset: leg.fee_settlement_asset,
        accounting_asset_valuations: leg.asset_valuations,
      })),
    },
  });
  if (!created.ok) return denied(created.error || "carry_entry_saga_create_failed");
  if (created.duplicate) return denied("carry_entry_already_started");
  const linked = await state.putCarryPositionRecord({
    ...record,
    entry_saga_id: sagaId,
    qualification_context: qualificationContext(proof, startedAt),
    ...(pilotRecord ? { qualification_pilot: { ...record.qualification_pilot, status: "entry_started" } } : {}),
  }, { expected_version: record.record_version });
  if (!linked.ok) return denied(linked.error || "carry_record_version_conflict");
  record = linked.record;

  for (const leg of legs.legs) await sagaEvent(state, sagaId, "preflight_passed", { leg_id: leg.leg_id }, now());
  const opened = await advanceStoredCarryPosition({
    state,
    owner_commitment: ownerCommitment,
    position_id: positionId,
    event: carryEvent(record.position, "preflight_passed", {
      opportunity_eligible: true,
      all_venues_ready: true,
    }),
    now_ms: now(),
  });
  if (!opened.ok) return denied(opened.error || "carry_entry_lifecycle_failed");
  await sagaEvent(state, sagaId, "submission_started", {}, now());

  let outcomes;
  try {
    outcomes = await withTimeout(Promise.allSettled(legs.legs.map((leg) => executeOrder(orderArgs({
      state,
      record,
      policy,
      leg,
      recipient,
    })))), boundedMs(env.PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS, 250, 60_000, 2_000));
  } catch {
    return freezeAmbiguous({ state, record, positionId, ownerCommitment, sagaId, nowMs: now() });
  }

  let ambiguous = false;
  const receiptByLeg = {};
  for (let index = 0; index < legs.legs.length; index += 1) {
    const leg = legs.legs[index];
    const outcome = outcomes[index];
    if (outcome.status === "rejected") {
      if (isAmbiguous(outcome.reason)) {
        ambiguous = true;
      } else {
        await sagaEvent(state, sagaId, "leg_failed", { leg_id: leg.leg_id, failure_code: "venue_submit_failed" }, now());
      }
      continue;
    }
    const receipt = outcome.value;
    const receiptAssessment = assessCarryTerminalExecutionReceipt({
      receipt,
      venue_id: leg.venue_id,
      work_order_commitment: leg.work_order_commitment,
      account_commitment: record.monitoring_context.venue_access[leg.venue_id]?.account_commitment,
      dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
    });
    if (!receiptAssessment.verified) {
      ambiguous = true;
      continue;
    }
    receiptByLeg[leg.leg_id] = receipt;
    await sagaEvent(state, sagaId, "leg_acknowledged", {
      leg_id: leg.leg_id,
      provider_ref_commitment: receipt?.provider_ref_commitment || null,
    }, now());
    const progress = fillProgress(receipt, leg, record.position.target_notional_micro_usdc, env);
    if (progress.filled_micro_usdc > 0) {
      await sagaEvent(state, sagaId, "leg_fill", {
        leg_id: leg.leg_id,
        cumulative_filled_micro_usdc: progress.filled_micro_usdc,
      }, now());
    }
    if (progress.terminal && progress.filled_micro_usdc < record.position.target_notional_micro_usdc) {
      await sagaEvent(state, sagaId, "leg_finalized", {
        leg_id: leg.leg_id,
        cumulative_filled_micro_usdc: progress.filled_micro_usdc,
      }, now());
    } else if (!progress.terminal) {
      ambiguous = true;
    }
  }
  if (ambiguous) return freezeAmbiguous({ state, record, positionId, ownerCommitment, sagaId, nowMs: now() });

  let saga = await state.getMultiLegSaga(sagaId);
  if (saga.status === "reconciling") {
    for (const leg of saga.legs) await sagaEvent(state, sagaId, "leg_reconciled", { leg_id: leg.leg_id }, now());
    saga = await state.getMultiLegSaga(sagaId);
  }
  if (saga.legs.every((leg) => leg.filled_micro_usdc === 0)) {
    const result = await advanceStoredCarryPosition({
      state,
      owner_commitment: ownerCommitment,
      position_id: positionId,
      event: carryEvent(opened.record.position, "entry_failed_no_fill"),
      now_ms: now(),
    });
    return { ok: false, error: "carry_entry_failed_no_fill", saga, record: result.record };
  }
  const completed = await completeReconciledCarryEntry({
    state,
    record: await state.getCarryPositionRecord(positionId),
    saga,
    env,
    liveLegs: legs.legs,
    receiptByLeg,
  });
  if (!completed.ok) {
    let failureRecord = completed.record || null;
    if (completed.completion_proven === false) {
      const current = await state.getCarryPositionRecord(positionId);
      if (current?.position?.status === "opening") {
        const frozen = await advanceStoredCarryPosition({
          state,
          owner_commitment: ownerCommitment,
          position_id: positionId,
          event: carryEvent(current.position, "recovery_failed"),
          now_ms: saga.updated_at_ms,
        });
        failureRecord = frozen.record || failureRecord;
      }
    }
    return { ...completed, ok: false, error: completed.error || "carry_entry_requires_recovery", saga, record: failureRecord };
  }
  return completed.record?.position?.status === "active"
    ? { ok: true, saga, record: completed.record, accounting: completed.accounting }
    : { ok: false, error: "carry_entry_requires_recovery", saga, record: completed.record, accounting: completed.accounting };
}

export async function readCarryEntryPrivatePrimeReadiness({
  state,
  record,
  owner_commitment: ownerCommitment,
  carry_supervision: carrySupervision,
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const notionalUsd = String(record?.position?.target_notional_micro_usdc / 1_000_000);
  const horizonDays = String(Math.max(
    1,
    Math.ceil(Number(record?.opportunity?.horizon_ms || 86_400_000) / 86_400_000),
  ));
  const venueAccess = record?.monitoring_context?.venue_access;
  const readiness = await readCarryExecutionReadiness({
    state,
    owner_commitment: ownerCommitment,
    venue_access: venueAccess,
    asset: record?.position?.asset,
    notional_usd: notionalUsd,
    horizon_days: horizonDays,
    now_ms: nowMs,
    env,
  });
  const [shadowQualification, routeEvidence] = await Promise.all([
    readCarryShadowQualification({ state, now_ms: nowMs, env }),
    loadCarryTransferRouteEvidence({
      state,
      owner_commitment: ownerCommitment,
      now_ms: nowMs,
      max_data_age_ms: 30_000,
      expected_worker_image_digest: runtimeCarryQualificationImageDigest(env) || "",
    }).catch(() => ({ ok: false, error: "carry_transfer_route_evidence_unavailable" })),
  ]);
  return buildCarryPrivatePrimeReadiness({
    readiness,
    diagnostic: null,
    shadow_qualification: shadowQualification,
    carry_supervision: carrySupervision,
    route_observation_configured: true,
    route_evidence: routeEvidence,
    lifecycle_proof: null,
    now_ms: nowMs,
  });
}

export async function executeStoredCarryExit({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  recipient,
  verifyOrder,
  executeOrder,
  readFundingSettlements,
  preflight = preflightCarryPair,
  env = process.env,
  now = () => Date.now(),
}) {
  let record = await state.getCarryPositionRecord(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  if (record.position.status !== "exiting") return denied("carry_position_not_exiting");
  if (record.exit_saga_id) return denied("carry_exit_already_started");
  if (![record.position.long_venue_id, record.position.short_venue_id].every((venueId) => exactQuantityRecoveryAdapter(venueId) !== null)) {
    return denied("exact_quantity_recovery_unavailable");
  }
  const entrySaga = record.entry_saga_id ? await state.getMultiLegSaga(record.entry_saga_id) : null;
  if (!entrySaga || entrySaga.status !== "reconciled") return denied("carry_entry_reconciliation_missing");
  const exactBases = await exactEntryBases(state, entrySaga, env);
  if (!exactBases.ok) return exactBases;

  const startedAt = now();
  let proof;
  try {
    proof = await preflight({
      body: {
        ...preflightBody(record, startedAt),
        phase: "exit",
        exit_base_size_by_venue: { ...exactBases.byVenue },
      },
      recipient,
      state,
      verifyOrder,
      env,
      now: () => startedAt,
    });
  } catch (error) {
    return denied(errorCode(error, "carry_exit_preflight_failed"));
  }
  if (proof?.no_submit_ready !== true || proof?.transaction_broadcast !== false) return denied("carry_exit_preflight_not_ready");
  const legs = buildExitLegs(record, proof, entrySaga, exactBases.byVenue, startedAt);
  if (!legs.ok) return legs;
  const sagaId = `saga:carry:exit:${digest(`${positionId}:${startedAt}`).slice(0, 36)}`;
  const policy = carrySessionPolicy(record, legs.legs, startedAt);
  const created = await createDurableMultiLegSaga({
    state,
    definition: {
      version: 1,
      saga_id: sagaId,
      idempotency_key: `idem:carry:exit:${digest(positionId).slice(0, 36)}`,
      plan_commitment: `plan:carry:exit:${digest(JSON.stringify(legs.legs)).slice(0, 36)}`,
      strategy_id: "exposure_rebalance",
      recovery_mode: "complete_reduce_only",
      max_unhedged_ms: boundedMs(env.PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS, 250, 60_000, 2_000),
      max_hedge_error_micro_usdc: record.position.risk_mandate.max_hedge_error_micro_usdc,
      now_ms: startedAt,
      legs: legs.legs.map((leg) => ({
        leg_id: leg.leg_id,
        venue_id: leg.venue_id,
        asset: record.position.asset,
        market: leg.market,
        product_type: "perp",
        operation_class: "limit_order",
        side: leg.side,
        notional_micro_usdc: record.position.target_notional_micro_usdc,
      })),
    },
    execution_context: {
      version: 1,
      carry_position_id: positionId,
      owner_commitment: ownerCommitment,
      policy_commitment: policy.policy_commitment,
      session_policy: policy,
      venue_access: record.monitoring_context.venue_access,
      legs: legs.legs.map((leg) => ({
        leg_id: leg.leg_id,
        work_order_commitment: leg.work_order_commitment,
        instruction: leg.instruction,
        accounting_reference_mark_price_e8: leg.reference_mark_price_e8,
        accounting_quote_asset: leg.quote_asset,
        accounting_fee_settlement_asset: leg.fee_settlement_asset,
        accounting_asset_valuations: leg.asset_valuations,
      })),
    },
  });
  if (!created.ok) return denied(created.error || "carry_exit_saga_create_failed");
  if (created.duplicate) return denied("carry_exit_already_started");
  const linked = await state.putCarryPositionRecord({ ...record, exit_saga_id: sagaId }, { expected_version: record.record_version });
  if (!linked.ok) return denied(linked.error || "carry_record_version_conflict");
  record = linked.record;
  for (const leg of legs.legs) await sagaEvent(state, sagaId, "preflight_passed", { leg_id: leg.leg_id }, now());
  await sagaEvent(state, sagaId, "submission_started", {}, now());

  let outcomes;
  try {
    outcomes = await withTimeout(Promise.allSettled(legs.legs.map((leg) => executeOrder(orderArgs({ state, record, policy, leg, recipient })))), boundedMs(env.PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS, 250, 60_000, 2_000));
  } catch {
    return freezeAmbiguous({ state, record, positionId, ownerCommitment, sagaId, nowMs: now() });
  }
  let ambiguous = false;
  const receipts = [];
  const receiptByLeg = {};
  for (let index = 0; index < legs.legs.length; index += 1) {
    const leg = legs.legs[index];
    const outcome = outcomes[index];
    if (outcome.status === "rejected") {
      if (isAmbiguous(outcome.reason)) ambiguous = true;
      else await sagaEvent(state, sagaId, "leg_failed", { leg_id: leg.leg_id, failure_code: "venue_submit_failed" }, now());
      continue;
    }
    const receipt = outcome.value;
    const receiptAssessment = assessCarryTerminalExecutionReceipt({
      receipt,
      venue_id: leg.venue_id,
      work_order_commitment: leg.work_order_commitment,
      account_commitment: record.monitoring_context.venue_access[leg.venue_id]?.account_commitment,
      dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
    });
    if (!receiptAssessment.verified) {
      ambiguous = true;
      continue;
    }
    receipts.push(receipt);
    receiptByLeg[leg.leg_id] = receipt;
    await sagaEvent(state, sagaId, "leg_acknowledged", { leg_id: leg.leg_id, provider_ref_commitment: receipt?.provider_ref_commitment || null }, now());
    const progress = fillProgress(receipt, leg, record.position.target_notional_micro_usdc, env);
    if (progress.filled_micro_usdc > 0) await sagaEvent(state, sagaId, "leg_fill", { leg_id: leg.leg_id, cumulative_filled_micro_usdc: progress.filled_micro_usdc }, now());
    if (progress.terminal && progress.filled_micro_usdc < record.position.target_notional_micro_usdc) {
      await sagaEvent(state, sagaId, "leg_finalized", { leg_id: leg.leg_id, cumulative_filled_micro_usdc: progress.filled_micro_usdc }, now());
    } else if (!progress.terminal) ambiguous = true;
  }
  if (ambiguous) return freezeAmbiguous({ state, record, positionId, ownerCommitment, sagaId, nowMs: now() });
  let saga = await state.getMultiLegSaga(sagaId);
  if (saga.status === "reconciling") {
    for (const leg of saga.legs) await sagaEvent(state, sagaId, "leg_reconciled", { leg_id: leg.leg_id }, now());
    saga = await state.getMultiLegSaga(sagaId);
  }
  if (saga.status !== "reconciled") return { ok: false, error: "carry_exit_requires_recovery", saga, record: publicCarryRecord(record) };
  const openOrders = receipts.reduce((sum, receipt) => sum + Math.max(0, Number(receipt?.final_proof?.open_order_count || 0)), 0);
  if (openOrders !== 0) return { ok: false, error: "carry_exit_open_orders_nonzero", saga, record: publicCarryRecord(record) };
  const current = await state.getCarryPositionRecord(positionId);
  const flatProof = await verifyFlatExitProof({
    state,
    record: current,
    saga,
    recipient,
    verifyOrder,
    preflight,
    env,
    nowMs: now(),
  });
  if (!flatProof.ok) {
    const pending = await storeExitVerificationPending({ state, record: current, error: flatProof.error, env, nowMs: now() });
    return { ok: false, error: flatProof.error, saga, record: publicCarryRecord(pending || current) };
  }
  const advanced = await advanceStoredCarryPosition({
    state,
    owner_commitment: ownerCommitment,
    position_id: positionId,
    event: carryEvent(current.position, "exit_reconciled", flatProof.evidence),
    now_ms: now(),
  });
  if (!advanced.ok) return { ok: false, error: advanced.error, saga, record: advanced.record };
  const accounting = await recordExecutionValueEvidence({
    state,
    ownerCommitment,
    positionId,
    phase: "exit",
    legs: legs.legs,
    receiptByLeg,
    nowMs: now(),
  });
  const finalized = await finalizeCarryValueEvidenceIfComplete({
    state,
    ownerCommitment,
    positionId,
    venueAccess: current.monitoring_context.venue_access,
    recipient,
    readFundingSettlements,
    nowMs: now(),
  });
  const qualification = await recordCompletedCarryVenueQualifications({ state, position_id: positionId, now_ms: now(), env });
  const lifecycleProof = await recordLifecycleProofAfterExit({
    state,
    ownerCommitment,
    positionId,
    qualification,
    env,
    nowMs: now(),
  });
  return { ok: true, saga, record: finalized.record || accounting.record || advanced.record, accounting: accounting.summary, value_finalized: finalized.finalized, qualification, lifecycle_proof: lifecycleProof };
}

export async function runCarryExecutionTick({
  state,
  recipient,
  verifyOrder,
  executeOrder,
  readFundingSettlements,
  preflight = preflightCarryPair,
  env = process.env,
  now = () => Date.now(),
}) {
  const [records, frozenRecords, reconciledRecords] = await Promise.all([
    listAllCarryPositionRecords({ state, status: "exiting" }),
    listAllCarryPositionRecords({ state, status: "frozen" }),
    listAllCarryPositionRecords({ state, status: "reconciled" }),
  ]);
  const pendingAbortedFinalization = reconciledRecords.filter((record) =>
    record.value_ledger?.status === "open"
    && record.value_evidence?.aborted_entry_recovery?.status === "complete"
  );
  const tasks = [
    ...records.map((record) => ({
      position_id: record.position?.position_id,
      run: () => processExitingCarryRecord({
        state,
        record,
        recipient,
        verifyOrder,
        executeOrder,
        readFundingSettlements,
        preflight,
        env,
        now,
      }),
    })),
    ...frozenRecords.map((record) => ({
      position_id: record.position?.position_id,
      run: () => synchronizeFrozenCarryRecovery({
        state,
        record,
        recipient,
        verifyOrder,
        readFundingSettlements,
        preflight,
        env,
        now,
      }),
    })),
    ...pendingAbortedFinalization.map((record) => ({
      position_id: record.position?.position_id,
      run: () => finalizeAbortedCarryValueEvidenceIfComplete({
        state,
        record,
        recipient,
        readFundingSettlements,
        nowMs: now(),
      }),
    })),
  ];
  const concurrency = boundedMs(env.PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY, 1, 32, 8);
  const results = await mapConcurrentOrdered(tasks, concurrency, async (task) => {
    const positionId = String(task.position_id || "unknown");
    try {
      const result = await task.run();
      return { position_id: positionId, ...result };
    } catch (error) {
      return { position_id: positionId, ok: false, error: errorCode(error, "carry_execution_task_failed") };
    }
  });
  return {
    ok: results.every((result) => result.ok),
    checked: tasks.length,
    results,
  };
}

async function processExitingCarryRecord({
  state,
  record,
  recipient,
  verifyOrder,
  executeOrder,
  readFundingSettlements,
  preflight,
  env,
  now,
}) {
  if (!record.exit_saga_id) {
    return executeStoredCarryExit({
      state,
      owner_commitment: record.owner_commitment,
      position_id: record.position.position_id,
      recipient,
      verifyOrder,
      executeOrder,
      readFundingSettlements,
      preflight,
      env,
      now,
    });
  }
  const saga = await state.getMultiLegSaga(record.exit_saga_id);
  if (saga?.status !== "reconciled" && saga?.status !== "manual_intervention") {
    return { ok: true, pending: true, error: "carry_exit_recovery_in_progress", saga_status: saga?.status || "missing" };
  }
  const current = await state.getCarryPositionRecord(record.position.position_id);
  if (saga.status === "manual_intervention") {
    return advanceStoredCarryPosition({
      state,
      owner_commitment: record.owner_commitment,
      position_id: record.position.position_id,
      event: carryEvent(current.position, "recovery_failed"),
      now_ms: now(),
    });
  }
  if (Number(current.exit_verification?.next_check_at_ms || 0) > now()) {
    return { ok: true, pending: true, error: current.exit_verification?.error || "carry_exit_final_account_proof_pending" };
  }
  const flatProof = await verifyFlatExitProof({
    state,
    record: current,
    saga,
    recipient,
    verifyOrder,
    preflight,
    env,
    nowMs: now(),
  });
  if (!flatProof.ok) {
    const pending = await storeExitVerificationPending({ state, record: current, error: flatProof.error, env, nowMs: now() });
    return { ok: false, error: flatProof.error, record: publicCarryRecord(pending || current) };
  }
  const advanced = await advanceStoredCarryPosition({
    state,
    owner_commitment: record.owner_commitment,
    position_id: record.position.position_id,
    event: carryEvent(current.position, "exit_reconciled", flatProof.evidence),
    now_ms: now(),
  });
  if (!advanced.ok) return advanced;
  const accounting = await recordRecoveredExitValueEvidence({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    saga,
    env,
    nowMs: now(),
  });
  const finalized = await finalizeCarryValueEvidenceIfComplete({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    venueAccess: current.monitoring_context.venue_access,
    recipient,
    readFundingSettlements,
    nowMs: now(),
  });
  const qualification = await recordCompletedCarryVenueQualifications({
    state,
    position_id: record.position.position_id,
    now_ms: now(),
    env,
  });
  const lifecycleProof = await recordLifecycleProofAfterExit({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    qualification,
    env,
    nowMs: now(),
  });
  return { ...advanced, record: finalized.record || accounting.record || advanced.record, accounting: accounting.summary, value_finalized: finalized.finalized, qualification, lifecycle_proof: lifecycleProof };
}

async function recordLifecycleProofAfterExit({ state, ownerCommitment, positionId, qualification, env, nowMs }) {
  if (qualification?.ok !== true) return denied(qualification?.error || "carry_lifecycle_qualification_unproven");
  try {
    return await recordCompletedCarryLifecycleProof({
      state,
      owner_commitment: ownerCommitment,
      position_id: positionId,
      env,
      now_ms: nowMs,
    });
  } catch (error) {
    return denied(errorCode(error, "carry_lifecycle_proof_record_failed"));
  }
}

export async function auditCarryPositionsAfterRestart({ state, now_ms: nowMs = Date.now(), env = process.env }) {
  const [draftRecords, openingRecords, exitingRecords] = await Promise.all([
    listAllCarryPositionRecords({ state, status: "draft" }),
    listAllCarryPositionRecords({ state, status: "opening" }),
    listAllCarryPositionRecords({ state, status: "exiting" }),
  ]);
  const records = [...draftRecords, ...openingRecords, ...exitingRecords];
  const cutoff = new Date(nowMs).getTime();
  const results = [];
  for (const record of records) {
    const updatedAt = new Date(record.updated_at || record.created_at || 0).getTime();
    const phase = ["draft", "opening"].includes(record.position.status) && record.entry_saga_id
      ? "entry"
      : record.position.status === "exiting" && record.exit_saga_id ? "exit" : null;
    const sagaId = phase === "entry" ? record.entry_saga_id : phase === "exit" ? record.exit_saga_id : null;
    const saga = sagaId ? await state.getMultiLegSaga(sagaId) : null;
    const sagaAt = Number(saga?.updated_at_ms);
    const reconciledEntryPredatesCutoff = phase === "entry" && record.position.status === "opening"
      && saga?.terminal === true && saga.status === "reconciled"
      && Number.isSafeInteger(sagaAt) && sagaAt <= cutoff
      && saga?.execution_context?.carry_position_id === record.position.position_id
      && saga.execution_context?.owner_commitment === record.owner_commitment;
    if (Number.isFinite(updatedAt) && updatedAt > cutoff && !reconciledEntryPredatesCutoff) continue;
    if (phase && provablyPreSubmitCarrySaga(saga, record, phase)) {
      let cancelled = saga;
      if (saga.terminal !== true) {
        try {
          cancelled = await sagaEvent(state, sagaId, "cancel_before_submit", {}, nowMs);
        } catch (error) {
          results.push(denied(errorCode(error, "carry_restart_pre_submit_cancel_failed")));
          continue;
        }
      }
      if (phase === "entry" && record.position.status === "opening") {
        const reconciled = await advanceStoredCarryPosition({
          state,
          owner_commitment: record.owner_commitment,
          position_id: record.position.position_id,
          event: carryEvent(record.position, "entry_failed_no_fill"),
          now_ms: nowMs,
        });
        results.push({ ...reconciled, restart_action: "entry_cancelled_before_submit", saga: cancelled });
      } else {
        results.push(await detachPreSubmitCarrySaga({ state, record, phase, saga: cancelled, nowMs }));
      }
      continue;
    }
    if (phase === "entry" && record.position.status === "opening" && saga?.terminal === true && saga.status === "reconciled") {
      const completed = await completeReconciledCarryEntry({ state, record, saga, env });
      if (completed.ok) {
        results.push({ ...completed, restart_action: "entry_reconciled_completed", saga });
        continue;
      }
      if (completed.completion_proven === true) {
        results.push(completed);
        continue;
      }
    }
    if (record.position.status !== "opening") continue;
    results.push(await advanceStoredCarryPosition({
      state,
      owner_commitment: record.owner_commitment,
      position_id: record.position.position_id,
      event: carryEvent(record.position, "restart_detected"),
      now_ms: nowMs,
    }));
  }
  return {
    ok: results.every((result) => result.ok),
    checked: records.length,
    recovered: results.filter((result) => result.restart_action).length,
    frozen: results.filter((result) => result.ok && !result.restart_action).length,
    results,
  };
}

async function completeReconciledCarryEntry({ state, record, saga, env, liveLegs = null, receiptByLeg = null }) {
  const material = await reconciledCarryEntryMaterial({ state, record, saga, env, liveLegs, receiptByLeg });
  if (!material.ok) return { ...material, completion_proven: false };
  const evidenceAt = saga.updated_at_ms;
  const accounting = await recordExecutionValueEvidence({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    phase: "entry",
    legs: material.legs,
    receiptByLeg: material.receiptByLeg,
    nowMs: evidenceAt,
  });
  if (!accounting.record || (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && accounting.summary.complete !== true)) {
    return {
      ok: false,
      error: "carry_entry_accounting_persistence_failed",
      completion_proven: true,
      accounting: accounting.summary,
    };
  }
  const current = await state.getCarryPositionRecord(record.position.position_id);
  if (!current || current.owner_commitment !== record.owner_commitment || current.position.status !== "opening") {
    return {
      ok: false,
      error: "carry_entry_parent_state_changed",
      completion_proven: true,
      accounting: accounting.summary,
      record: current ? publicCarryRecord(current) : null,
    };
  }
  const advanced = await advanceStoredCarryPosition({
    state,
    owner_commitment: current.owner_commitment,
    position_id: current.position.position_id,
    event: carryEvent(current.position, "entry_reconciled", {
      long_filled_micro_usdc: material.longLeg.filled_micro_usdc,
      short_filled_micro_usdc: material.shortLeg.filled_micro_usdc,
      hedge_error_micro_usdc: saga.hedge_error_micro_usdc,
    }),
    now_ms: evidenceAt,
  });
  return { ...advanced, completion_proven: true, accounting: accounting.summary };
}

async function reconciledCarryEntryMaterial({ state, record, saga, env, liveLegs, receiptByLeg }) {
  if (!record || record.position?.status !== "opening" || record.entry_saga_id !== saga?.saga_id
    || saga?.terminal !== true || saga.status !== "reconciled" || saga.terminal_reason !== "all_legs_reconciled"
    || saga.recovery_mode !== "unwind" || saga.execution_context?.carry_position_id !== record.position.position_id
    || saga.execution_context?.owner_commitment !== record.owner_commitment
    || !Number.isSafeInteger(saga.updated_at_ms) || saga.updated_at_ms <= 0
    || !Number.isSafeInteger(saga.hedge_error_micro_usdc) || saga.hedge_error_micro_usdc < 0
    || !Array.isArray(saga.legs) || saga.legs.length !== 2
    || !Array.isArray(saga.execution_context?.legs) || saga.execution_context.legs.length !== 2) {
    return denied("carry_entry_reconciled_binding_unproven");
  }
  const expected = [
    { venue_id: record.position.long_venue_id, side: "buy" },
    { venue_id: record.position.short_venue_id, side: "sell" },
  ];
  const legs = [];
  const recoveredReceipts = {};
  for (const binding of expected) {
    const sagaLeg = saga.legs.find((leg) => leg.venue_id === binding.venue_id && leg.side === binding.side);
    const context = saga.execution_context.legs.find((item) => item.leg_id === sagaLeg?.leg_id);
    const instruction = context?.instruction;
    const accountCommitment = record.monitoring_context?.venue_access?.[binding.venue_id]?.account_commitment;
    const sagaAccountCommitment = saga.execution_context?.venue_access?.[binding.venue_id]?.account_commitment;
    const providedLeg = Array.isArray(liveLegs) ? liveLegs.find((leg) => leg.leg_id === sagaLeg?.leg_id) : null;
    if (!sagaLeg || !context || sagaLeg.reconciled !== true
      || !["filled", "finalized"].includes(sagaLeg.submission_status)
      || sagaLeg.notional_micro_usdc !== record.position.target_notional_micro_usdc
      || instruction?.venue_id !== binding.venue_id || instruction?.order?.side !== binding.side
      || instruction?.order?.market !== sagaLeg.market || instruction?.order?.reduce_only !== false
      || sagaAccountCommitment !== accountCommitment || !commitmentValue(context.work_order_commitment)
      || (providedLeg && (providedLeg.venue_id !== binding.venue_id
        || providedLeg.side !== binding.side
        || providedLeg.work_order_commitment !== context.work_order_commitment
        || providedLeg.reference_mark_price_e8 !== context.accounting_reference_mark_price_e8))) {
      return denied(`carry_entry_reconciled_leg_binding_unproven:${binding.venue_id}`);
    }
    const accountingLeg = {
      leg_id: sagaLeg.leg_id,
      venue_id: sagaLeg.venue_id,
      side: sagaLeg.side,
      market: sagaLeg.market,
      work_order_commitment: context.work_order_commitment,
      instruction,
      reference_mark_price_e8: context.accounting_reference_mark_price_e8,
      quote_asset: context.accounting_quote_asset,
      fee_settlement_asset: context.accounting_fee_settlement_asset,
      asset_valuations: context.accounting_asset_valuations,
    };
    const durableReceipt = await receiptForWorkOrder(state, context.work_order_commitment);
    const receipt = env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? receiptByLeg?.[sagaLeg.leg_id] || durableReceipt
      : durableReceipt;
    const assessed = assessCarryTerminalExecutionReceipt({
      receipt,
      venue_id: binding.venue_id,
      work_order_commitment: context.work_order_commitment,
      account_commitment: accountCommitment,
      dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
    });
    const progress = fillProgress(receipt, { instruction }, sagaLeg.notional_micro_usdc, env);
    const valueEvidence = executionValueEvidence({ leg: accountingLeg, receipt, nowMs: saga.updated_at_ms });
    const exactValueProven = valueEvidence.fill.complete === true
      && valueEvidence.fill.baseE8 > 0
      && valueEvidence.fee.complete === true
      && valueEvidence.slippage.complete === true;
    if (!assessed.verified || receipt.provider_ref_commitment !== sagaLeg.provider_ref_commitment
      || progress.terminal !== true || progress.filled_micro_usdc !== sagaLeg.filled_micro_usdc
      || sagaLeg.filled_micro_usdc <= 0
      || (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && !exactValueProven)) {
      return denied(`carry_entry_reconciled_receipt_unproven:${binding.venue_id}`);
    }
    legs.push(accountingLeg);
    recoveredReceipts[sagaLeg.leg_id] = receipt;
  }
  if (new Set(legs.map((leg) => leg.leg_id)).size !== 2 || new Set(legs.map((leg) => leg.venue_id)).size !== 2) {
    return denied("carry_entry_reconciled_legs_not_unique");
  }
  const longLeg = saga.legs.find((leg) => leg.venue_id === record.position.long_venue_id && leg.side === "buy");
  const shortLeg = saga.legs.find((leg) => leg.venue_id === record.position.short_venue_id && leg.side === "sell");
  return { ok: true, legs, receiptByLeg: recoveredReceipts, longLeg, shortLeg };
}

function provablyPreSubmitCarrySaga(saga, record, phase) {
  const prefix = phase === "entry" ? "saga:carry:" : "saga:carry:exit:";
  const recoveryMode = phase === "entry" ? "unwind" : "complete_reduce_only";
  const cancellable = saga?.terminal !== true && ["preflighting", "ready"].includes(saga?.status);
  const alreadyCancelled = saga?.terminal === true
    && saga?.status === "failed_no_submit"
    && saga?.terminal_reason === "cancelled_before_submit";
  return Boolean(saga)
    && (cancellable || alreadyCancelled)
    && saga.saga_id.startsWith(prefix)
    && saga.recovery_mode === recoveryMode
    && saga.unhedged_deadline_ms === null
    && saga.execution_context?.carry_position_id === record.position.position_id
    && saga.execution_context?.owner_commitment === record.owner_commitment
    && Array.isArray(saga.legs)
    && saga.legs.length === 2
    && saga.legs.every((leg) => leg.submission_status === "pending"
      && leg.provider_ref_commitment === null
      && leg.filled_micro_usdc === 0);
}

async function detachPreSubmitCarrySaga({ state, record, phase, saga, nowMs }) {
  const field = phase === "entry" ? "entry_saga_id" : "exit_saga_id";
  const stored = await state.putCarryPositionRecord({
    ...record,
    [field]: null,
    restart_recovery: {
      version: 1,
      phase,
      status: "cancelled_before_submit",
      saga_id: saga.saga_id,
      transaction_broadcast: false,
      retry_permitted: true,
      checked_at_ms: nowMs,
    },
  }, { expected_version: record.record_version });
  return stored.ok
    ? { ok: true, restart_action: `${phase}_cancelled_before_submit`, saga, record: publicCarryRecord(stored.record) }
    : { ok: false, error: stored.error || "carry_restart_record_conflict", saga };
}

async function synchronizeFrozenCarryRecovery({ state, record, recipient, verifyOrder, readFundingSettlements, preflight, env, now }) {
  const sagaId = record.exit_saga_id || record.entry_saga_id;
  if (!sagaId) return denied("carry_frozen_recovery_saga_missing");
  const saga = await state.getMultiLegSaga(sagaId);
  if (!saga) return denied("carry_frozen_recovery_saga_missing");
  if (!saga.terminal) return { ok: true, pending: true, error: "carry_recovery_in_progress", saga_status: saga.status };
  if (saga.status === "manual_intervention") {
    return { ok: false, error: "carry_recovery_requires_owner_review", saga_status: saga.status };
  }
  if (!["reconciled", "unwound", "failed_no_fill", "failed_no_submit"].includes(saga.status)) {
    return { ok: false, error: "carry_recovery_terminal_state_unrecognized", saga_status: saga.status };
  }
  const checkedAt = now();
  const accountState = await inspectCarryAccountState({
    state,
    record,
    saga,
    recipient,
    verifyOrder,
    preflight,
    env,
    nowMs: checkedAt,
  });
  if (!accountState.ok) return accountState;
  if (!accountState.known_flat) {
    return {
      ok: false,
      error: "carry_recovery_exposure_requires_owner_review",
      saga_status: saga.status,
      transaction_broadcast: false,
    };
  }
  let abortedAccounting = null;
  if (!record.exit_saga_id && ["unwound", "failed_no_fill", "failed_no_submit"].includes(saga.status)) {
    abortedAccounting = await recordRecoveredEntryUnwindValueEvidence({
      state,
      ownerCommitment: record.owner_commitment,
      positionId: record.position.position_id,
      saga,
      nowMs: checkedAt,
    });
  }
  const advanced = await advanceStoredCarryPosition({
    state,
    owner_commitment: record.owner_commitment,
    position_id: record.position.position_id,
    event: carryEvent(record.position, "reconciliation_complete", {
      known_flat: true,
      ...accountState.evidence,
    }),
    now_ms: checkedAt,
  });
  if (!advanced.ok) return advanced;
  if (!record.exit_saga_id) {
    const finalized = await finalizeAbortedCarryValueEvidenceIfComplete({
      state,
      record: await state.getCarryPositionRecord(record.position.position_id),
      recipient,
      readFundingSettlements,
      nowMs: checkedAt,
    });
    return {
      ...advanced,
      record: finalized.record || abortedAccounting?.record || advanced.record,
      accounting: abortedAccounting?.summary || null,
      value_finalized: finalized.finalized === true,
    };
  }
  const accounting = await recordRecoveredExitValueEvidence({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    saga,
    env,
    nowMs: checkedAt,
  });
  const finalized = await finalizeCarryValueEvidenceIfComplete({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    venueAccess: record.monitoring_context.venue_access,
    recipient,
    readFundingSettlements,
    nowMs: checkedAt,
  });
  return { ...advanced, record: finalized.record || accounting.record || advanced.record, accounting: accounting.summary, value_finalized: finalized.finalized };
}

async function verifyFlatExitProof({ state, record, saga, recipient, verifyOrder, preflight, env, nowMs }) {
  const accountState = await inspectCarryAccountState({ state, record, saga, recipient, verifyOrder, preflight, env, nowMs });
  if (!accountState.ok) return accountState;
  if (!accountState.known_flat) return denied("carry_exit_not_flat_or_open_orders_nonzero");
  return { ok: true, evidence: accountState.evidence };
}

async function inspectCarryAccountState({ state, record, saga, recipient, verifyOrder, preflight, env, nowMs }) {
  let proof;
  try {
    proof = await preflight({
      body: { ...preflightBody(record, nowMs), phase: "monitoring" },
      recipient,
      state,
      verifyOrder,
      env,
      now: () => nowMs,
    });
  } catch (error) {
    return denied(errorCode(error, "carry_exit_final_account_proof_unavailable"));
  }
  if (proof?.transaction_broadcast !== false) {
    return denied("carry_exit_final_account_proof_unavailable");
  }
  const readiness = Array.isArray(proof.account_readiness) ? proof.account_readiness : [];
  const venues = [record.position.long_venue_id, record.position.short_venue_id];
  const venueProof = venues.map((venueId) => {
    const matches = readiness.filter((item) => item?.venue_id === venueId);
    if (matches.length !== 1) return null;
    const item = matches[0];
    const expectedAccountCommitment = record.monitoring_context?.venue_access?.[venueId]?.account_commitment;
    const positionCount = item.position_count;
    const openOrderCount = item.open_order_count;
    if (item.authorized !== true
      || item.account_commitment !== expectedAccountCommitment
      || !Number.isSafeInteger(positionCount)
      || positionCount < 0
      || !Number.isSafeInteger(openOrderCount)
      || openOrderCount < 0) {
      return null;
    }
    const flatZeroOrders = positionCount === 0 && openOrderCount === 0;
    if (item.flat_zero_orders !== flatZeroOrders) return null;
    return Object.freeze({
      venue_id: venueId,
      account_commitment: expectedAccountCommitment,
      authorized: true,
      flat_zero_orders: flatZeroOrders,
      position_count: positionCount,
      open_order_count: openOrderCount,
      account_state_checked: true,
    });
  });
  if (venueProof.some((item) => item === null)) {
    return denied("carry_exit_final_account_proof_unavailable");
  }
  const knownFlat = venueProof.every((item) => item.flat_zero_orders === true);
  const openOrderCount = venueProof.reduce((sum, item) => sum + item.open_order_count, 0);
  return {
    ok: true,
    known_flat: knownFlat,
    evidence: {
      owner_commitment: record.owner_commitment,
      carry_position_id: record.position.position_id,
      gross_exposure_micro_usdc: knownFlat ? 0 : record.position.target_notional_micro_usdc,
      open_order_count: openOrderCount,
      account_state_checked: true,
      transaction_broadcast: false,
      checked_at_ms: nowMs,
      venues: venueProof,
      reconciliation_commitment: `carry:reconciliation:${digest(JSON.stringify({
        owner_commitment: record.owner_commitment,
        position_id: record.position.position_id,
        saga_id: saga.saga_id,
        checked_at_ms: nowMs,
        venue_readiness: venueProof,
      })).slice(0, 40)}`,
    },
  };
}

async function storeExitVerificationPending({ state, record, error, env, nowMs }) {
  const retryMs = boundedMs(env.PRIVATE_AGENT_CARRY_EXIT_VERIFY_RETRY_MS, 5_000, 300_000, 30_000);
  const stored = await state.putCarryPositionRecord({
    ...record,
    exit_verification: {
      status: "pending",
      error: String(error || "carry_exit_final_account_proof_unavailable").slice(0, 120),
      checked_at_ms: nowMs,
      next_check_at_ms: nowMs + retryMs,
      transaction_broadcast: false,
    },
  }, { expected_version: record.record_version });
  return stored.ok ? stored.record : null;
}

async function recordExecutionValueEvidence({ state, ownerCommitment, positionId, phase, legs, receiptByLeg, nowMs }) {
  const venues = {};
  let entriesPersisted = true;
  for (const leg of legs) {
    const receipt = receiptByLeg[leg.leg_id];
    const evidence = executionValueEvidence({ leg, receipt, nowMs });
    venues[leg.venue_id] = {
      fee_exact: evidence.fee.complete,
      slippage_exact: evidence.slippage.complete,
      fill_exact: evidence.fill.complete,
      fee_source_asset: evidence.fee.sourceAsset,
      fee_source_amount_micro: evidence.fee.sourceAmountMicro,
      fee_valuation_commitment: evidence.fee.cashflowValuation?.evidence_commitment || null,
      slippage_source_asset: evidence.slippage.sourceAsset,
      slippage_source_amount_micro: evidence.slippage.sourceAmountMicro,
      slippage_valuation_commitment: evidence.slippage.cashflowValuation?.evidence_commitment || null,
      filled_base_e8: evidence.fill.baseE8,
      average_fill_price_e8: evidence.fill.averagePriceE8,
      reference_mark_price_e8: Number.isSafeInteger(leg.reference_mark_price_e8) ? leg.reference_mark_price_e8 : null,
      side: leg.side,
      evidence_commitment: evidence.evidenceCommitment,
    };
    const entries = [];
    if (evidence.fee.complete) {
      entries.push({
        entry_type: evidence.fee.amountMicro < 0 ? "rebate" : "trading_fee",
        direction: evidence.fee.amountMicro < 0 ? "credit" : "debit",
        amount_micro_usdc: Math.abs(evidence.fee.amountMicro),
        suffix: "fee",
      });
    }
    if (evidence.slippage.complete) {
      entries.push({
        entry_type: "slippage",
        direction: "debit",
        amount_micro_usdc: evidence.slippage.amountMicro,
        suffix: "slippage",
      });
    }
    for (const entry of entries) {
      const persisted = await appendValueEntryWithRetry({
        state,
        ownerCommitment,
        positionId,
        entry: {
          version: 1,
          entry_id: `carry:value:${phase}:${leg.venue_id}:${entry.suffix}`,
          entry_type: entry.entry_type,
          direction: entry.direction,
          amount_micro_usdc: entry.amount_micro_usdc,
          venue_id: leg.venue_id,
          leg_id: leg.leg_id,
          occurred_at_ms: nowMs,
          evidence_commitment: evidence.evidenceCommitment,
        },
        nowMs,
      });
      entriesPersisted &&= persisted;
    }
  }
  const complete = entriesPersisted && legs.length === 2 && legs.every((leg) => venues[leg.venue_id]?.fee_exact && venues[leg.venue_id]?.slippage_exact && venues[leg.venue_id]?.fill_exact);
  let storedRecord = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) break;
    const nextEvidence = {
      ...(current.value_evidence || {}),
      [phase]: { status: complete ? "complete" : "pending_exact_receipts", checked_at_ms: nowMs, venues },
      funding: current.value_evidence?.funding || { status: "pending_authoritative_settlement_history" },
      costs_complete: false,
    };
    const stored = await state.putCarryPositionRecord({ ...current, value_evidence: nextEvidence }, { expected_version: current.record_version });
    if (stored.ok) { storedRecord = stored.record; break; }
  }
  return { record: storedRecord ? publicCarryRecord(storedRecord) : null, summary: { phase, complete, venues } };
}

async function recordRecoveredExitValueEvidence({ state, ownerCommitment, positionId, saga, env, nowMs }) {
  const legs = [];
  const receiptByLeg = {};
  for (const sagaLeg of saga.legs) {
    const context = saga.execution_context?.legs?.find((item) => item.leg_id === sagaLeg.leg_id);
    if (!context) continue;
    const cached = await state.getIdempotency?.(context.work_order_commitment);
    const attempt = await state.getExecutionAttempt?.(context.work_order_commitment);
    const initialReceipt = cached?.receipt || attempt || null;
    const initialProgress = fillProgress(initialReceipt, { instruction: context.instruction }, sagaLeg.notional_micro_usdc, env);
    const remainingMicro = Math.max(0, sagaLeg.notional_micro_usdc - initialProgress.filled_micro_usdc);
    const completionAccounting = await readDurableRecoveryAccounting({
      state,
      saga_id: saga.saga_id,
      leg_id: sagaLeg.leg_id,
      action: "completion",
    });
    const components = initialReceipt ? [{
      receipt: initialReceipt,
      reference_mark_price_e8: context.accounting_reference_mark_price_e8,
    }] : [];
    for (const execution of Array.isArray(completionAccounting?.executions) ? completionAccounting.executions : []) {
      if (!execution?.receipt) continue;
      components.push({
        receipt: execution.receipt,
        reference_mark_price_e8: execution.reference_mark_price_e8,
      });
    }
    if (remainingMicro > 0 && components.length === (initialReceipt ? 1 : 0)) {
      const completionWork = `work:recovery:${digest(`${saga.saga_id}:${sagaLeg.leg_id}:completion:${remainingMicro}`).slice(0, 40)}`;
      const completion = await state.getIdempotency?.(completionWork);
      const completionAttempt = await state.getExecutionAttempt?.(completionWork);
      const completionReceipt = completion?.receipt || completionAttempt || null;
      if (completionReceipt) components.push({ receipt: completionReceipt, reference_mark_price_e8: null });
    }
    const receipts = components.map((component) => component.receipt);
    receiptByLeg[sagaLeg.leg_id] = {
      provider_ref_commitment: receipts.map((item) => item.provider_ref_commitment).filter(Boolean).join(":") || null,
      result_commitment: `carry:recovered-exit:${digest(JSON.stringify(components.map((component) => ({
        result_commitment: component.receipt.result_commitment || null,
        final_proof: component.receipt.final_proof || null,
        reference_mark_price_e8: component.reference_mark_price_e8 || null,
      })))).slice(0, 40)}`,
      fills: components.flatMap((component) => normalizedReceiptFills(component.receipt).map((fill) => ({
        ...fill,
        ...(Number.isSafeInteger(component.reference_mark_price_e8) && component.reference_mark_price_e8 > 0
          ? { reference_mark_price_e8: component.reference_mark_price_e8 }
          : {}),
      }))),
    };
    legs.push({
      leg_id: sagaLeg.leg_id,
      venue_id: sagaLeg.venue_id,
      side: sagaLeg.side,
      work_order_commitment: context.work_order_commitment,
      instruction: context.instruction,
      reference_mark_price_e8: context.accounting_reference_mark_price_e8,
      quote_asset: context.accounting_quote_asset,
      fee_settlement_asset: context.accounting_fee_settlement_asset,
      asset_valuations: context.accounting_asset_valuations,
    });
  }
  return recordExecutionValueEvidence({
    state,
    ownerCommitment,
    positionId,
    phase: "exit",
    legs,
    receiptByLeg,
    nowMs,
  });
}

async function recordRecoveredEntryUnwindValueEvidence({ state, ownerCommitment, positionId, saga, nowMs }) {
  const venues = {};
  let complete = true;
  let totalContractPnlE16 = 0n;
  let totalSlippageMicro = 0n;
  for (const sagaLeg of saga.legs) {
    if (sagaLeg.filled_micro_usdc === 0) {
      venues[sagaLeg.venue_id] = { status: "no_fill", filled_base_e8: "0", contract_pnl_micro_usdc: 0 };
      continue;
    }
    const context = saga.execution_context?.legs?.find((item) => item.leg_id === sagaLeg.leg_id);
    const openingReceipt = context ? await receiptForWorkOrder(state, context.work_order_commitment) : null;
    const recovery = await readDurableRecoveryAccounting({
      state,
      saga_id: saga.saga_id,
      leg_id: sagaLeg.leg_id,
      action: "unwind",
    });
    const openingFills = normalizedReceiptFills(openingReceipt);
    const unwindExecutions = Array.isArray(recovery?.executions) ? recovery.executions : [];
    const unwindFills = unwindExecutions.flatMap((item) => normalizedReceiptFills(item.receipt));
    const openingSummary = exactFillSummary(openingFills);
    const unwindSummary = exactFillSummary(unwindFills);
    const exactBases = openingSummary.complete
      && unwindSummary.complete
      && openingSummary.baseE8 === unwindSummary.baseE8;
    const executionEvidence = [];
    if (context && openingReceipt) {
      executionEvidence.push({
        label: "opening",
        leg: {
          leg_id: sagaLeg.leg_id,
          venue_id: sagaLeg.venue_id,
          side: sagaLeg.side,
          work_order_commitment: context.work_order_commitment,
          reference_mark_price_e8: context.accounting_reference_mark_price_e8,
          quote_asset: context.accounting_quote_asset,
          fee_settlement_asset: context.accounting_fee_settlement_asset,
          asset_valuations: context.accounting_asset_valuations,
        },
        receipt: openingReceipt,
      });
    }
    for (const [index, execution] of unwindExecutions.entries()) {
      executionEvidence.push({
        label: `unwind:${index}`,
        leg: {
          leg_id: sagaLeg.leg_id,
          venue_id: sagaLeg.venue_id,
          side: sagaLeg.side === "buy" ? "sell" : "buy",
          work_order_commitment: execution.work_order_commitment,
          reference_mark_price_e8: execution.reference_mark_price_e8,
          quote_asset: context?.accounting_quote_asset,
          fee_settlement_asset: context?.accounting_fee_settlement_asset,
          asset_valuations: context?.accounting_asset_valuations,
        },
        receipt: execution.receipt,
      });
    }
    let exactCosts = exactBases && executionEvidence.length === 1 + unwindExecutions.length && unwindExecutions.length > 0;
    for (const execution of executionEvidence) {
      const evidence = executionValueEvidence({ ...execution, nowMs });
      exactCosts &&= evidence.fill.complete && evidence.fee.complete && evidence.slippage.complete;
      if (evidence.slippage.complete) totalSlippageMicro += BigInt(evidence.slippage.amountMicro);
      const persisted = await appendExecutionCostEvidence({
        state,
        ownerCommitment,
        positionId,
        venueId: sagaLeg.venue_id,
        legId: sagaLeg.leg_id,
        label: execution.label,
        evidence,
        nowMs,
      });
      exactCosts &&= persisted;
    }
    let contractPnlMicro = null;
    if (exactBases) {
      const base = BigInt(openingSummary.baseE8);
      const openingPrice = BigInt(openingSummary.averagePriceE8);
      const unwindPrice = BigInt(unwindSummary.averagePriceE8);
      const pnlE16 = sagaLeg.side === "buy"
        ? (unwindPrice - openingPrice) * base
        : (openingPrice - unwindPrice) * base;
      totalContractPnlE16 += pnlE16;
      const pnl = signedRoundedDiv(pnlE16, 10_000_000_000n);
      if (pnl <= BigInt(Number.MAX_SAFE_INTEGER) && pnl >= BigInt(Number.MIN_SAFE_INTEGER)) contractPnlMicro = Number(pnl);
      else exactCosts = false;
    }
    complete &&= exactCosts;
    venues[sagaLeg.venue_id] = {
      status: exactCosts ? "complete" : "pending_exact_receipts",
      filled_base_e8: openingSummary.baseE8,
      unwind_base_e8: unwindSummary.baseE8,
      opening_average_price_e8: openingSummary.averagePriceE8,
      unwind_average_price_e8: unwindSummary.averagePriceE8,
      contract_pnl_micro_usdc: contractPnlMicro,
      executions: executionEvidence.length,
    };
  }
  let contractPnlMicro = null;
  if (complete) {
    const pnl = signedRoundedDiv(totalContractPnlE16, 10_000_000_000n);
    const adjustment = pnl + totalSlippageMicro;
    if (pnl <= BigInt(Number.MAX_SAFE_INTEGER)
      && pnl >= BigInt(Number.MIN_SAFE_INTEGER)
      && adjustment <= BigInt(Number.MAX_SAFE_INTEGER)
      && adjustment >= BigInt(Number.MIN_SAFE_INTEGER)) {
      contractPnlMicro = Number(pnl);
      complete = await appendValueEntryWithRetry({
        state,
        ownerCommitment,
        positionId,
        entry: {
          version: 1,
          entry_id: "carry:value:aborted-entry:round-trip-pnl",
          entry_type: "settlement_adjustment",
          direction: adjustment < 0n ? "debit" : "credit",
          amount_micro_usdc: Number(adjustment < 0n ? -adjustment : adjustment),
          venue_id: null,
          leg_id: null,
          occurred_at_ms: nowMs,
          evidence_commitment: `carry:value:aborted-entry:${digest(JSON.stringify({ saga_id: saga.saga_id, venues })).slice(0, 40)}`,
        },
        nowMs,
      });
    } else complete = false;
  }
  let storedRecord = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) break;
    const stored = await state.putCarryPositionRecord({
      ...current,
      value_evidence: {
        ...(current.value_evidence || {}),
        aborted_entry_recovery: {
          status: complete ? "complete" : "pending_exact_receipts",
          saga_id: saga.saga_id,
          contract_pnl_micro_usdc: contractPnlMicro,
          attributed_slippage_micro_usdc: totalSlippageMicro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totalSlippageMicro) : null,
          venues,
          checked_at_ms: nowMs,
        },
        costs_complete: false,
      },
    }, { expected_version: current.record_version });
    if (stored.ok) { storedRecord = stored.record; break; }
  }
  return {
    record: storedRecord ? publicCarryRecord(storedRecord) : null,
    summary: { phase: "aborted_entry_recovery", complete, contract_pnl_micro_usdc: contractPnlMicro, venues },
  };
}

async function appendExecutionCostEvidence({ state, ownerCommitment, positionId, venueId, legId, label, evidence, nowMs }) {
  if (!evidence.fee.complete || !evidence.slippage.complete || !evidence.fill.complete) return false;
  const entries = [];
  if (evidence.fee.amountMicro !== 0) {
    entries.push({
      entry_id: `carry:value:aborted-entry:${venueId}:${label}:fee`,
      entry_type: evidence.fee.amountMicro < 0 ? "rebate" : "trading_fee",
      direction: evidence.fee.amountMicro < 0 ? "credit" : "debit",
      amount_micro_usdc: Math.abs(evidence.fee.amountMicro),
      evidence_commitment: evidence.evidenceCommitment,
    });
  }
  if (evidence.slippage.amountMicro > 0) {
    entries.push({
      entry_id: `carry:value:aborted-entry:${venueId}:${label}:slippage`,
      entry_type: "slippage",
      direction: "debit",
      amount_micro_usdc: evidence.slippage.amountMicro,
      evidence_commitment: evidence.evidenceCommitment,
    });
  }
  for (const entry of entries) {
    const persisted = await appendValueEntryWithRetry({
      state,
      ownerCommitment,
      positionId,
      entry: {
        version: 1,
        ...entry,
        venue_id: venueId,
        leg_id: legId,
        occurred_at_ms: nowMs,
      },
      nowMs,
    });
    if (!persisted) return false;
  }
  return true;
}

async function finalizeAbortedCarryValueEvidenceIfComplete({ state, record, recipient, readFundingSettlements, nowMs }) {
  if (!record || record.value_ledger?.status === "finalized") return { ok: true, finalized: true, record: record ? publicCarryRecord(record) : null };
  if (record.value_evidence?.aborted_entry_recovery?.status !== "complete") {
    return { ok: true, pending: true, finalized: false, record: publicCarryRecord(record) };
  }
  if (typeof readFundingSettlements !== "function") {
    return { ok: true, pending: true, error: "carry_aborted_funding_evidence_pending", finalized: false, record: publicCarryRecord(record) };
  }
  const reconciliation = record.final_reconciliation_evidence;
  const exitAtMs = Number(reconciliation?.checked_at_ms);
  if (!hasExactCarryFlatReconciliation(
    reconciliation,
    [record.position.long_venue_id, record.position.short_venue_id],
    carryReconciliationBinding(record),
  )
    || !Number.isSafeInteger(exitAtMs)
    || exitAtMs <= 0) {
    return { ok: false, error: "carry_aborted_flat_proof_invalid", finalized: false, record: publicCarryRecord(record) };
  }
  await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment: record.owner_commitment,
    positionId: record.position.position_id,
    venueAccess: record.monitoring_context.venue_access,
    recipient,
    readFundingSettlements,
    nowMs: exitAtMs,
    final: true,
  });
  let current = await state.getCarryPositionRecord(record.position.position_id);
  if (current?.value_evidence?.funding?.status !== "complete_through_exit") {
    return { ok: true, pending: true, error: "carry_aborted_funding_evidence_pending", finalized: false, record: publicCarryRecord(current) };
  }
  const elapsedMs = Math.max(0, exitAtMs - Number(current.position.created_at_ms));
  const capitalCostBig = roundedDiv(
    BigInt(current.opportunity.projected_capital_cost_micro_usdc) * BigInt(elapsedMs),
    BigInt(current.opportunity.horizon_ms),
  );
  if (capitalCostBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "carry_aborted_capital_cost_overflow", finalized: false, record: publicCarryRecord(current) };
  }
  const capitalCost = Number(capitalCostBig);
  const capitalStored = await appendValueEntryWithRetry({
    state,
    ownerCommitment: current.owner_commitment,
    positionId: current.position.position_id,
    entry: {
      version: 1,
      entry_id: "carry:value:aborted-entry:capital-cost",
      entry_type: "capital_cost",
      direction: "debit",
      amount_micro_usdc: capitalCost,
      venue_id: null,
      leg_id: null,
      occurred_at_ms: exitAtMs,
      evidence_commitment: `carry:value:aborted-entry:capital:${digest(`${current.position.position_id}:${elapsedMs}:${capitalCost}`).slice(0, 40)}`,
    },
    nowMs: exitAtMs,
  });
  if (!capitalStored) return { ok: false, error: "carry_aborted_capital_cost_persistence_failed", finalized: false, record: publicCarryRecord(current) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = await state.getCarryPositionRecord(current.position.position_id);
    const stored = await state.putCarryPositionRecord({
      ...current,
      value_evidence: {
        ...current.value_evidence,
        realized_economics: {
          status: "complete",
          mode: "aborted_entry_unwind",
          contract_pnl_micro_usdc: current.value_evidence.aborted_entry_recovery.contract_pnl_micro_usdc,
          capital_cost_micro_usdc: capitalCost,
          checked_at_ms: exitAtMs,
        },
        costs_complete: true,
      },
    }, { expected_version: current.record_version });
    if (stored.ok) { current = stored.record; break; }
  }
  if (current.value_evidence?.costs_complete !== true) {
    return { ok: false, error: "carry_aborted_cost_evidence_persistence_failed", finalized: false, record: publicCarryRecord(current) };
  }
  const finalized = await finalizeStoredCarryValueLedger({
    state,
    position_id: current.position.position_id,
    owner_commitment: current.owner_commitment,
    evidence: {
      gross_exposure_micro_usdc: reconciliation?.gross_exposure_micro_usdc,
      open_order_count: reconciliation?.open_order_count,
      costs_complete: true,
      reconciliation_commitment: reconciliation?.reconciliation_commitment,
    },
    now_ms: exitAtMs,
  });
  return { ok: finalized.ok, finalized: finalized.ok, record: finalized.record || publicCarryRecord(current), error: finalized.error };
}

async function receiptForWorkOrder(state, workOrderCommitment) {
  const cached = await state.getIdempotency?.(workOrderCommitment);
  const attempt = await state.getExecutionAttempt?.(workOrderCommitment);
  return cached?.receipt || attempt || null;
}

async function finalizeCarryValueEvidenceIfComplete({ state, ownerCommitment, positionId, venueAccess, recipient, readFundingSettlements, nowMs }) {
  if (typeof readFundingSettlements !== "function") return { finalized: false, record: null };
  await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment,
    positionId,
    venueAccess,
    recipient,
    readFundingSettlements,
    nowMs,
    final: true,
  });
  let current = await state.getCarryPositionRecord(positionId);
  const evidence = current?.value_evidence;
  if (!current || evidence?.entry?.status !== "complete" || evidence?.exit?.status !== "complete" || evidence?.funding?.status !== "complete_through_exit") {
    return { finalized: false, record: current ? publicCarryRecord(current) : null };
  }
  const economics = realizedCarryEconomics(current);
  if (!economics.ok) return { finalized: false, record: publicCarryRecord(current) };
  const economicCommitment = `carry:value:economics:${digest(JSON.stringify(economics.evidence)).slice(0, 40)}`;
  const pnlStored = await appendValueEntryWithRetry({
    state,
    ownerCommitment,
    positionId,
    entry: {
      version: 1,
      entry_id: "carry:value:realized:contract-pnl",
      entry_type: "settlement_adjustment",
      direction: economics.settlementAdjustmentMicro < 0 ? "debit" : "credit",
      amount_micro_usdc: Math.abs(economics.settlementAdjustmentMicro),
      venue_id: null,
      leg_id: null,
      occurred_at_ms: nowMs,
      evidence_commitment: economicCommitment,
    },
    nowMs,
  });
  const capitalStored = await appendValueEntryWithRetry({
    state,
    ownerCommitment,
    positionId,
    entry: {
      version: 1,
      entry_id: "carry:value:realized:capital-cost",
      entry_type: "capital_cost",
      direction: "debit",
      amount_micro_usdc: economics.capitalCostMicro,
      venue_id: null,
      leg_id: null,
      occurred_at_ms: nowMs,
      evidence_commitment: economicCommitment,
    },
    nowMs,
  });
  if (!pnlStored || !capitalStored) return { finalized: false, record: publicCarryRecord(await state.getCarryPositionRecord(positionId) || current) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = await state.getCarryPositionRecord(positionId);
    const stored = await state.putCarryPositionRecord({
      ...current,
      value_evidence: {
        ...current.value_evidence,
        realized_economics: {
          status: "complete",
          contract_pnl_micro_usdc: economics.contractPnlMicro,
          capital_cost_micro_usdc: economics.capitalCostMicro,
          evidence_commitment: economicCommitment,
          checked_at_ms: nowMs,
        },
        costs_complete: true,
      },
    }, { expected_version: current.record_version });
    if (stored.ok) { current = stored.record; break; }
  }
  if (current.value_evidence?.costs_complete !== true) return { finalized: false, record: publicCarryRecord(current) };
  const reconciliation = current.final_reconciliation_evidence;
  if (!hasExactCarryFlatReconciliation(
    reconciliation,
    [current.position.long_venue_id, current.position.short_venue_id],
    carryReconciliationBinding(current),
  )) {
    return { finalized: false, record: publicCarryRecord(current) };
  }
  const finalized = await finalizeStoredCarryValueLedger({
    state,
    position_id: positionId,
    owner_commitment: ownerCommitment,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      reconciliation_commitment: reconciliation.reconciliation_commitment,
    },
    now_ms: nowMs,
  });
  return { finalized: finalized.ok, record: finalized.record || publicCarryRecord(current) };
}

function realizedCarryEconomics(record) {
  try {
    const venues = [record.position.long_venue_id, record.position.short_venue_id];
    let pnlE16 = 0n;
    const pairs = [];
    for (const venueId of venues) {
      const entry = record.value_evidence.entry.venues[venueId];
      const exit = record.value_evidence.exit.venues[venueId];
      const entryBase = BigInt(entry.filled_base_e8);
      const exitBase = BigInt(exit.filled_base_e8);
      const entryPrice = BigInt(entry.average_fill_price_e8);
      const exitPrice = BigInt(exit.average_fill_price_e8);
      if (entryBase <= 0n || entryBase !== exitBase || entryPrice <= 0n || exitPrice <= 0n) return { ok: false };
      const venuePnl = entry.side === "buy"
        ? (exitPrice - entryPrice) * entryBase
        : (entryPrice - exitPrice) * entryBase;
      pnlE16 += venuePnl;
      pairs.push({ venue_id: venueId, side: entry.side, base_e8: entry.filled_base_e8, entry_price_e8: entry.average_fill_price_e8, exit_price_e8: exit.average_fill_price_e8 });
    }
    const contractPnl = signedRoundedDiv(pnlE16, 10_000_000_000n);
    if (contractPnl > BigInt(Number.MAX_SAFE_INTEGER) || contractPnl < BigInt(Number.MIN_SAFE_INTEGER)) return { ok: false };
    const elapsedMs = Math.max(0, Number(record.final_reconciliation_evidence.checked_at_ms) - Number(record.position.created_at_ms));
    const modeledCapital = BigInt(record.opportunity.projected_capital_cost_micro_usdc);
    const horizon = BigInt(record.opportunity.horizon_ms);
    const capitalCost = horizon > 0n ? roundedDiv(modeledCapital * BigInt(elapsedMs), horizon) : 0n;
    if (capitalCost > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false };
    const contractPnlMicro = Number(contractPnl);
    const slippageMicro = Number(record.value_ledger.realized.slippage_micro_usdc || 0);
    return {
      ok: true,
      contractPnlMicro,
      settlementAdjustmentMicro: contractPnlMicro + slippageMicro,
      capitalCostMicro: Number(capitalCost),
      evidence: { position_id: record.position.position_id, pairs, contract_pnl_micro_usdc: contractPnlMicro, attributed_slippage_micro_usdc: slippageMicro, capital_cost_micro_usdc: Number(capitalCost), elapsed_ms: elapsedMs },
    };
  } catch {
    return { ok: false };
  }
}

async function appendValueEntryWithRetry({ state, ownerCommitment, positionId, entry, nowMs }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) return false;
    const result = await appendStoredCarryValueEntry({
      state,
      owner_commitment: ownerCommitment,
      position_id: positionId,
      entry: { ...entry, sequence: current.value_ledger.last_sequence + 1 },
      now_ms: nowMs,
    });
    if (result.ok) return true;
    if (result.error !== "carry_record_version_conflict") return false;
  }
  return false;
}

function executionValueEvidence({ leg, receipt, nowMs }) {
  const fills = normalizedReceiptFills(receipt);
  const fill = exactFillSummary(fills);
  const evidenceCommitment = `carry:value:evidence:${digest(JSON.stringify({
    leg_id: leg.leg_id,
    work_order_commitment: leg.work_order_commitment,
    provider_ref_commitment: receipt?.provider_ref_commitment || null,
    result_commitment: receipt?.result_commitment || null,
    final_proof: receipt?.final_proof || null,
    accounting_quote_asset: leg.quote_asset || null,
    accounting_fee_settlement_asset: leg.fee_settlement_asset || null,
    accounting_valuation_commitments: Array.isArray(leg.asset_valuations)
      ? leg.asset_valuations.map((row) => row?.evidence_commitment || null).sort()
      : null,
    fills,
  })).slice(0, 40)}`;
  const sourceFee = exactQuoteFee(leg.venue_id, fills);
  const feeSourceMatches = sourceFee.complete
    && sourceFee.sourceAsset === accountingAsset(leg.fee_settlement_asset);
  const fee = valuedExecutionCashflow({
    leg,
    sourceAsset: sourceFee.sourceAsset,
    sourceAmountMicro: feeSourceMatches ? -sourceFee.sourceAmountMicro : null,
    nowMs,
    outputSign: -1,
  });
  const reference = Number.isSafeInteger(leg.reference_mark_price_e8) && leg.reference_mark_price_e8 > 0
    ? BigInt(leg.reference_mark_price_e8)
    : null;
  let slippageMicro = 0n;
  let slippageComplete = fills.length > 0;
  for (const fill of fills) {
    const fillReference = Number.isSafeInteger(fill.reference_mark_price_e8) && fill.reference_mark_price_e8 > 0
      ? BigInt(fill.reference_mark_price_e8)
      : reference;
    const sizeE8 = decimalToScaled(fill.size, 8);
    const priceE8 = decimalToScaled(fill.price, 8);
    if (fillReference === null || sizeE8 === null || priceE8 === null || sizeE8 <= 0n || priceE8 <= 0n) {
      slippageComplete = false;
      break;
    }
    const difference = leg.side === "buy" ? priceE8 - fillReference : fillReference - priceE8;
    if (difference > 0n) slippageMicro += roundedDiv(difference * sizeE8, 10_000_000_000n);
  }
  const slippageSourceAmountMicro = slippageMicro <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(slippageMicro)
    : null;
  const slippage = valuedExecutionCashflow({
    leg,
    sourceAsset: leg.quote_asset,
    sourceAmountMicro: slippageComplete && slippageSourceAmountMicro !== null
      ? -slippageSourceAmountMicro
      : null,
    nowMs,
    outputSign: -1,
  });
  return {
    evidenceCommitment,
    fill,
    fee: feeSourceMatches ? fee : incompleteValuedCashflow(sourceFee.sourceAsset),
    slippage: slippageComplete ? slippage : incompleteValuedCashflow(leg.quote_asset),
  };
}

function valuedExecutionCashflow({ leg, sourceAsset, sourceAmountMicro, nowMs, outputSign }) {
  if (!Number.isSafeInteger(sourceAmountMicro) || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return incompleteValuedCashflow(sourceAsset);
  }
  try {
    const valuation = executionCashflowValuation({ leg, sourceAsset, sourceAmountMicro, nowMs });
    const converted = convertSignedCashflowToMicroUsdc({ amount_micro: sourceAmountMicro, valuation });
    const amountMicro = outputSign * converted;
    if (!Number.isSafeInteger(amountMicro)) return incompleteValuedCashflow(sourceAsset);
    return {
      complete: true,
      amountMicro,
      sourceAmountMicro: outputSign * sourceAmountMicro,
      sourceAsset,
      valuedAtMs: nowMs,
      cashflowValuation: valuation,
    };
  } catch {
    return incompleteValuedCashflow(sourceAsset);
  }
}

function incompleteValuedCashflow(sourceAsset) {
  return {
    complete: false,
    amountMicro: 0,
    sourceAmountMicro: null,
    sourceAsset: accountingAsset(sourceAsset),
    valuedAtMs: null,
    cashflowValuation: null,
  };
}

function executionCashflowValuation({ leg, sourceAsset, sourceAmountMicro, nowMs }) {
  const asset = accountingAsset(sourceAsset);
  if (!asset) throw new Error("carry_execution_valuation_asset_invalid");
  if (asset === "USDC") {
    const valuation = {
      version: 1,
      source_asset: "USDC",
      valuation_asset: "USDC",
      verified: true,
      credit_rate_e8: 100_000_000,
      debit_rate_e8: 100_000_000,
      observed_at_ms: nowMs,
      expires_at_ms: nowMs + 300_000,
      evidence_source: "identity:usdc:v1",
      evidence_commitment: `carry:cashflow-valuation:evidence:${"0".repeat(64)}`,
    };
    return normalizeCashflowValuation({
      ...valuation,
      evidence_message: cashflowValuationEvidenceMessage(valuation),
    });
  }
  const row = accountingValuations(leg.asset_valuations)?.find((item) => item?.source_asset === asset);
  if (!row) throw new Error("carry_execution_valuation_missing");
  const valuation = verifyCashflowValuationEvidence(row);
  if (valuation.observed_at_ms > nowMs + 5_000 || valuation.expires_at_ms <= nowMs) {
    throw new Error("carry_execution_valuation_stale");
  }
  if (valuation.bound_source_amount_micro != null && valuation.bound_source_amount_micro !== sourceAmountMicro) {
    throw new Error("carry_execution_valuation_amount_mismatch");
  }
  return valuation;
}

function exactFillSummary(fills) {
  if (fills.length === 0) return { complete: false, baseE8: null, averagePriceE8: null };
  let baseE8 = 0n;
  let notionalE16 = 0n;
  for (const fill of fills) {
    const size = decimalToScaled(fill.size, 8);
    const price = decimalToScaled(fill.price, 8);
    if (size === null || price === null || size <= 0n || price <= 0n) return { complete: false, baseE8: null, averagePriceE8: null };
    baseE8 += size;
    notionalE16 += size * price;
  }
  const averagePriceE8 = roundedDiv(notionalE16, baseE8);
  return {
    complete: baseE8 > 0n,
    baseE8: baseE8.toString(),
    averagePriceE8: averagePriceE8.toString(),
  };
}

function normalizedReceiptFills(receipt) {
  const raw = Array.isArray(receipt?.fills) ? receipt.fills : [];
  const normalized = raw.map((fill) => ({
    size: fill?.size ?? fill?.sz ?? fill?.totalSz ?? null,
    price: fill?.price ?? fill?.px ?? fill?.avgPx ?? null,
    fee: fill?.fee ?? fill?.commission ?? null,
    fee_asset: fill?.fee_asset ?? fill?.feeAsset ?? fill?.feeToken ?? fill?.commissionAsset ?? null,
    ...(Number.isSafeInteger(fill?.reference_mark_price_e8) && fill.reference_mark_price_e8 > 0
      ? { reference_mark_price_e8: fill.reference_mark_price_e8 }
      : {}),
  })).filter((fill) => fill.size != null && fill.price != null);
  if (normalized.length > 0) return normalized;
  const proof = receipt?.final_proof;
  if (proof?.filled_base_size && proof?.average_fill_price) {
    return [{
      size: proof.filled_base_size,
      price: proof.average_fill_price,
      fee: proof.fee_quote_amount ?? null,
      fee_asset: proof.fee_asset ?? null,
    }];
  }
  return [];
}

function exactQuoteFee(venueId, fills) {
  if (fills.length === 0) return { complete: false, sourceAmountMicro: 0, sourceAsset: null };
  let total = 0n;
  let sourceAsset = null;
  for (const fill of fills) {
    const fee = decimalToScaled(fill.fee, 6, true);
    const asset = String(fill.fee_asset || (venueId === "hyperliquid" ? "USDC" : "")).toUpperCase();
    if (fee === null || !accountingAsset(asset) || (sourceAsset && sourceAsset !== asset)) {
      return { complete: false, sourceAmountMicro: 0, sourceAsset: null };
    }
    sourceAsset = asset;
    total += fee;
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { complete: false, sourceAmountMicro: 0, sourceAsset };
  }
  return { complete: true, sourceAmountMicro: Number(total), sourceAsset };
}

function decimalToScaled(value, scale, signed = false) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (!signed && match[1] === "-")) return null;
  const fraction = String(match[3] || "").padEnd(scale, "0");
  const rounded = fraction.slice(0, scale);
  const discarded = fraction.slice(scale);
  let result = BigInt(match[2]) * (10n ** BigInt(scale)) + BigInt(rounded || "0");
  if (discarded[0] >= "5") result += 1n;
  return match[1] === "-" ? -result : result;
}

function roundedDiv(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function signedRoundedDiv(numerator, denominator) {
  return numerator < 0n
    ? -roundedDiv(-numerator, denominator)
    : roundedDiv(numerator, denominator);
}

export function startCarryExecutionLoop({ state, recipient, verifyOrder, executeOrder, readFundingSettlements, preflight = preflightCarryPair, env = process.env, now = () => Date.now() } = {}) {
  if (String(env.PRIVATE_AGENT_CARRY_AUTO_EXIT_ENABLED ?? "true").toLowerCase() === "false") {
    const health = disabledCarryLoopHealth("carry_execution");
    return {
      ready: Promise.resolve({ ok: false, error: "carry_execution_disabled" }),
      runNow: async () => ({ ok: false, error: "carry_execution_disabled" }),
      health: () => health,
      stop() {},
    };
  }
  const intervalMs = boundedMs(env.PRIVATE_AGENT_CARRY_EXECUTION_SWEEP_MS, 1_000, 60_000, 2_000);
  const stallAfterMs = boundedMs(
    env.PRIVATE_AGENT_CARRY_EXECUTION_STALL_MS,
    intervalMs * 2,
    1_800_000,
    intervalMs * 3,
  );
  let timer = null;
  let stopped = false;
  const startupAt = now();
  let restartAuditComplete = false;
  let activeRestartAudit = null;
  const ensureRestartAudit = () => {
    if (restartAuditComplete) return Promise.resolve({ ok: true, already_complete: true });
    if (activeRestartAudit) return activeRestartAudit;
    activeRestartAudit = auditCarryPositionsAfterRestart({ state, now_ms: startupAt, env })
      .catch(() => ({ ok: false, error: "carry_restart_audit_threw" }))
      .then((result) => {
        if (result?.ok === true) restartAuditComplete = true;
        return result;
      })
      .finally(() => {
        activeRestartAudit = null;
      });
    return activeRestartAudit;
  };
  const ready = ensureRestartAudit();
  const supervisor = createCarryLoopSupervisor({
    name: "carry_execution",
    now,
    maxSilenceMs: stallAfterMs,
    run: async () => {
      const audit = await ensureRestartAudit();
      if (audit?.ok !== true) return { ok: false, error: audit?.error || "carry_restart_audit_failed" };
      return runCarryExecutionTick({ state, recipient, verifyOrder, executeOrder, readFundingSettlements, preflight, env, now });
    },
  });
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await supervisor.runOnce();
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  schedule(intervalMs);
  return {
    ready,
    runNow: supervisor.runOnce,
    health: supervisor.health,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      supervisor.stop();
    },
  };
}

async function exactEntryBases(state, saga, env) {
  const byVenue = {};
  for (const leg of saga.legs) {
    const context = saga.execution_context?.legs?.find((item) => item.leg_id === leg.leg_id);
    const cached = context ? await state.getIdempotency?.(context.work_order_commitment) : null;
    const receipt = cached?.receipt;
    const assessment = assessCarryTerminalExecutionReceipt({
      receipt,
      venue_id: leg.venue_id,
      work_order_commitment: context?.work_order_commitment,
      account_commitment: saga.execution_context?.venue_access?.[leg.venue_id]?.account_commitment,
      dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
    });
    if (!assessment.verified) return denied(`carry_exact_entry_receipt_unverified:${leg.venue_id}`);
    const proof = receipt.final_proof;
    const base = canonicalPositiveDecimal(proof?.filled_base_size);
    if (!base || proof?.final_venue_execution_proven !== true) return denied(`carry_exact_entry_quantity_missing:${leg.venue_id}`);
    byVenue[leg.venue_id] = base;
  }
  return { ok: true, byVenue };
}

function buildExitLegs(record, proof, entrySaga, bases, nowMs) {
  const evidence = Array.isArray(proof.evidence) ? proof.evidence : [];
  const legs = [];
  for (const entryLeg of entrySaga.legs) {
    const side = entryLeg.side === "buy" ? "sell" : "buy";
    const verified = evidence.find((item) => item.venue_id === entryLeg.venue_id);
    const shape = verified?.order_shape;
    const quoteAsset = accountingAsset(verified?.quote_asset);
    const feeSettlementAsset = accountingAsset(verified?.fee_settlement_asset);
    const assetValuations = accountingValuations(verified?.asset_valuations);
    const base = bases[entryLeg.venue_id];
    if (!shape?.market || !shape?.limit_price || shape.side !== side || shape.reduce_only !== true
      || !base || canonicalPositiveDecimal(shape.base_size) !== base
      || verified.transaction_broadcast !== false || !quoteAsset || !feeSettlementAsset || !assetValuations) {
      return denied(`carry_exit_order_shape_missing:${entryLeg.venue_id}`);
    }
    const legId = `leg:carry:exit:${digest(`${record.position.position_id}:${entryLeg.venue_id}`).slice(0, 28)}`;
    legs.push({
      leg_id: legId,
      venue_id: entryLeg.venue_id,
      side,
      market: String(shape.market),
      reference_mark_price_e8: verified.reference_mark_price_e8,
      quote_asset: quoteAsset,
      fee_settlement_asset: feeSettlementAsset,
      asset_valuations: assetValuations,
      work_order_commitment: `work:carry:exit:${digest(`${record.position.position_id}:${entryLeg.venue_id}`).slice(0, 32)}`,
      instruction: {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id: entryLeg.venue_id,
        operation_class: "limit_order",
        expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
        order: {
          market: String(shape.market), side, base_size: base,
          quote_size: String(record.position.target_notional_micro_usdc / 1_000_000), limit_price: String(shape.limit_price),
          order_type: "limit", size_mode: "base", reduce_only: true,
          tif: "Ioc", leverage: 1, margin_mode: "cross",
        },
      },
    });
  }
  return { ok: true, legs };
}

function canonicalPositiveDecimal(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [rawInteger, rawFraction = ""] = value.split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  if (!/[1-9]/.test(`${integer}${fraction}`)) return null;
  return fraction ? `${integer}.${fraction}` : integer;
}

function publicCarryRecord(record) {
  const { monitoring_context: _context, ...safe } = record;
  return structuredClone(safe);
}

function preflightBody(record, nowMs) {
  return {
    version: 1,
    phase: "opening",
    owner_commitment: record.owner_commitment,
    work_order_commitment: `carry_entry_preflight_${digest(`${record.position.position_id}:${nowMs}`).slice(0, 32)}`,
    asset: record.position.asset,
    long_venue_id: record.position.long_venue_id,
    short_venue_id: record.position.short_venue_id,
    notional_usd: String(record.position.target_notional_micro_usdc / 1_000_000),
    horizon_days: String(Math.max(1, Math.ceil(record.opportunity.horizon_ms / 86_400_000))),
    risk_mandate: record.position.risk_mandate,
    venue_access: record.monitoring_context.venue_access,
  };
}

function carryReconciliationBinding(record) {
  const venueIds = [record.position.long_venue_id, record.position.short_venue_id];
  return {
    owner_commitment: record.owner_commitment,
    carry_position_id: record.position.position_id,
    account_commitments: Object.fromEntries(venueIds.map((venueId) => [
      venueId,
      record.monitoring_context?.venue_access?.[venueId]?.account_commitment,
    ])),
  };
}

function qualificationContext(proof, checkedAtMs) {
  const venues = {};
  for (const item of Array.isArray(proof?.evidence) ? proof.evidence : []) {
    const checks = item?.checks || {};
    venues[item.venue_id] = {
      account_commitment: String(item.account_commitment || ""),
      transaction_broadcast: item.transaction_broadcast === false ? false : null,
      account_state_checked: checks.account_state_checked === true,
      order_request_checked: checks.order_request_checked === true || checks.order_request_built === true,
      evidence_commitment: String(item.verification_commitment || ""),
      authority_boundary: item.authority_boundary ? structuredClone(item.authority_boundary) : null,
    };
  }
  return { version: 1, checked_at_ms: checkedAtMs, venues };
}

function qualificationPilotBootstrapAllowed({ record, qualifications, env }) {
  const pilot = record.qualification_pilot;
  if (pilot?.status !== "pending" || env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED !== "true") return false;
  if (!runtimeCarryQualificationImageDigest(env)) return false;
  if (record.position.target_notional_micro_usdc > pilot.max_notional_micro_usdc) return false;
  const candidate = qualifications.find((item) => item.venue_id === pilot.candidate_venue_id);
  const peers = qualifications.filter((item) => item.venue_id !== pilot.candidate_venue_id);
  return candidate?.proven !== true && peers.length === 1 && peers.every((item) => item.proven === true);
}

function buildLegs(record, proof, nowMs) {
  const evidence = Array.isArray(proof.evidence) ? proof.evidence : [];
  const specs = [
    { id: "long", venue_id: record.position.long_venue_id, side: "buy" },
    { id: "short", venue_id: record.position.short_venue_id, side: "sell" },
  ];
  const legs = [];
  for (const spec of specs) {
    const verified = evidence.find((item) => item.venue_id === spec.venue_id && item.side === spec.side);
    const shape = verified?.order_shape;
    const quoteAsset = accountingAsset(verified?.quote_asset);
    const feeSettlementAsset = accountingAsset(verified?.fee_settlement_asset);
    const assetValuations = accountingValuations(verified?.asset_valuations);
    if (!shape?.market || !shape?.base_size || !shape?.limit_price || verified.transaction_broadcast !== false
      || !quoteAsset || !feeSettlementAsset || !assetValuations) {
      return denied(`carry_entry_order_shape_missing:${spec.venue_id}`);
    }
    const legId = `leg:carry:${digest(`${record.position.position_id}:${spec.id}`).slice(0, 32)}`;
    const workOrder = `work:carry:${digest(`${record.position.position_id}:${spec.id}:entry`).slice(0, 40)}`;
    legs.push({
      leg_id: legId,
      venue_id: spec.venue_id,
      side: spec.side,
      market: String(shape.market),
      reference_mark_price_e8: verified.reference_mark_price_e8,
      quote_asset: quoteAsset,
      fee_settlement_asset: feeSettlementAsset,
      asset_valuations: assetValuations,
      work_order_commitment: workOrder,
      instruction: {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id: spec.venue_id,
        operation_class: "limit_order",
        expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
        order: {
          market: String(shape.market),
          side: spec.side,
          base_size: String(shape.base_size),
          quote_size: String(record.position.target_notional_micro_usdc / 1_000_000),
          limit_price: String(shape.limit_price),
          order_type: "limit",
          size_mode: "base",
          reduce_only: false,
          tif: "Ioc",
          leverage: 1,
          margin_mode: "cross",
        },
      },
    });
  }
  return { ok: true, legs };
}

function accountingAsset(value) {
  const asset = String(value || "").toUpperCase();
  return new Set(["USD", "USDC", "USDT"]).has(asset) ? asset : null;
}

function accountingValuations(value) {
  if (!Array.isArray(value) || value.length > 3
    || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    return null;
  }
  return structuredClone(value);
}

function carrySessionPolicy(record, legs, nowMs) {
  const notionalUsd = record.position.target_notional_micro_usdc / 1_000_000;
  return {
    version: 2,
    strategy_id: "delta_neutral_carry_v1",
    policy_commitment: record.position.mandate_authorization?.mandate_commitment || record.position.mandate_id,
    market_allowlist: [...new Set(legs.map((leg) => leg.market))],
    max_notional_bucket: notionalBucket(notionalUsd),
    max_daily_notional_bucket: notionalBucket(notionalUsd * 2),
    max_order_count: 2,
    max_slippage_bps: 50,
    kill_switch: false,
    expires_at: new Date(nowMs + 10 * 60_000).toISOString(),
  };
}

function orderArgs({ state, record, policy, leg, recipient }) {
  const access = record.monitoring_context.venue_access[leg.venue_id];
  return {
    venue_id: leg.venue_id,
    operation_class: "limit_order",
    work_order_commitment: leg.work_order_commitment,
    policy_commitment: policy.policy_commitment,
    session_policy: policy,
    instruction: leg.instruction,
    execution: {
      execution_mode: "byo_api_key",
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
      account_commitment: access.account_commitment,
      owner_commitment: record.owner_commitment,
      carry_position_id: record.position.position_id,
    },
    recipient,
    state,
  };
}

async function sagaEvent(state, sagaId, type, values, nowMs) {
  const saga = await state.getMultiLegSaga(sagaId);
  const result = await applyDurableMultiLegEvent({
    state,
    saga_id: sagaId,
    now_ms: Math.max(nowMs, saga.updated_at_ms),
    event: {
      version: 1,
      event_id: `event:carry:${digest(`${sagaId}:${saga.last_event_sequence + 1}:${type}:${values.leg_id || "pair"}`).slice(0, 40)}`,
      sequence: saga.last_event_sequence + 1,
      type,
      ...values,
    },
  });
  if (!result.ok) throw new Error(result.error || "carry_saga_event_failed");
  return result.saga;
}

async function freezeAmbiguous({ state, record, positionId, ownerCommitment, sagaId, nowMs }) {
  const current = await state.getCarryPositionRecord(positionId);
  const result = await advanceStoredCarryPosition({
    state,
    owner_commitment: ownerCommitment,
    position_id: positionId,
    event: carryEvent(current.position, "submission_ambiguous"),
    now_ms: nowMs,
  });
  return { ok: false, error: "carry_entry_outcome_ambiguous", saga: await state.getMultiLegSaga(sagaId), record: result.record };
}

function carryEvent(position, type, values = {}) {
  const sequence = position.last_event_sequence + 1;
  return {
    version: 1,
    event_id: `carry:entry:${digest(`${position.position_id}:${sequence}:${type}`).slice(0, 40)}`,
    sequence,
    type,
    ...values,
  };
}

function fillProgress(receipt, leg, expectedMicro, env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !receipt?.final_proof) return { terminal: true, filled_micro_usdc: expectedMicro };
  const proof = receipt?.final_proof;
  const reported = Number(proof?.cumulative_filled_micro_usdc);
  const targetBase = Number(leg.instruction?.order?.base_size);
  const filledBase = Number(proof?.filled_base_size);
  const proportional = Number.isFinite(targetBase) && targetBase > 0 && Number.isFinite(filledBase) && filledBase >= 0
    ? Math.round(expectedMicro * Math.max(0, Math.min(1, filledBase / targetBase)))
    : 0;
  return {
    terminal: proof?.final_venue_execution_proven === true,
    filled_micro_usdc: Number.isSafeInteger(reported) && reported >= 0
      ? Math.min(expectedMicro, reported)
      : proof?.final_fill_proven === true ? proportional : 0,
  };
}

export function assessCarryTerminalExecutionReceipt({
  receipt,
  venue_id: venueId,
  work_order_commitment: workOrderCommitment,
  account_commitment: accountCommitment,
  dry_run: dryRun = false,
}) {
  const reasons = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return Object.freeze({ verified: false, reasons: Object.freeze(["carry_execution_receipt_missing"]) });
  }
  if (dryRun === true) return Object.freeze({ verified: true, reasons: Object.freeze([]) });
  const proof = receipt.final_proof;
  if (!commitmentValue(workOrderCommitment) || receipt.work_order_commitment !== workOrderCommitment) {
    reasons.push("carry_execution_receipt_work_order_mismatch");
  }
  if (!commitmentValue(accountCommitment) || receipt.account_commitment !== accountCommitment) {
    reasons.push("carry_execution_receipt_account_mismatch");
  }
  if (!commitmentValue(receipt.provider_ref_commitment) || !commitmentValue(receipt.result_commitment)) {
    reasons.push("carry_execution_receipt_commitment_missing");
  }
  const venueBound = receipt.venue_id === venueId
    || (venueId === "hyperliquid" && receipt.execution_protocol === "ghola-hyperliquid-proof-v2");
  if (!venueBound) reasons.push("carry_execution_receipt_venue_mismatch");
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || proof.target_client_order_matched !== true
    || proof.broadcast_performed !== true
    || proof.final_venue_execution_proven !== true) {
    reasons.push("carry_execution_receipt_terminal_proof_unverified");
  }
  return Object.freeze({ verified: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function commitmentValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,240}$/.test(value);
}

function isAmbiguous(error) {
  return /ambiguous|outcome_unknown|timeout/i.test(String(error?.code || error?.message || ""));
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("carry_entry_timeout")), timeoutMs);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function notionalBucket(value) {
  for (const bucket of [5, 10, 25, 50, 100, 250, 500, 1_000]) if (value <= bucket) return String(bucket);
  return "1000";
}

function boundedMs(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

async function mapConcurrentOrdered(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function errorCode(error, fallback) {
  return String(error?.code || error?.message || fallback).slice(0, 120);
}

function denied(error) {
  return { ok: false, error };
}
