import { createHash } from "node:crypto";
import {
  advanceMultiLegSaga,
  createMultiLegSaga,
  exactQuantityRecoveryAdapter,
} from "@ghola/execution-core";
import {
  createCarryLoopSupervisor,
  disabledCarryLoopHealth,
} from "./carry-loop-supervisor.js";

const MAX_EXACT_BASE_DIGITS = 80;
const MAX_EXACT_BASE_SCALE = 40;

export async function createDurableMultiLegSaga({ state, definition, execution_context = null }) {
  assertState(state);
  let saga;
  try {
    saga = createMultiLegSaga(definition);
    if (execution_context) saga = Object.freeze({
      ...saga,
      execution_context: normalizeExecutionContext(execution_context, saga),
    });
  } catch (error) {
    return { ok: false, error: errorCode(error), saga: null };
  }
  const stored = await state.putMultiLegSaga(saga, { expected_sequence: null });
  if (stored.ok) return { ok: true, duplicate: false, saga: stored.saga };
  const existing = stored.saga || await state.getMultiLegSaga(saga.saga_id);
  if (
    existing?.idempotency_key === saga.idempotency_key &&
    existing?.plan_commitment === saga.plan_commitment
  ) {
    return { ok: true, duplicate: true, saga: existing };
  }
  return { ok: false, error: stored.error || "saga_create_conflict", saga: existing || null };
}

function normalizeExecutionContext(value, saga) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw new Error("saga_execution_context_invalid");
  }
  const legs = Array.isArray(value.legs) ? value.legs : [];
  if (legs.length !== saga.legs.length) throw new Error("saga_execution_context_legs_invalid");
  const normalized = legs.map((leg) => {
    const expected = saga.legs.find((item) => item.leg_id === leg?.leg_id);
    if (!expected || typeof leg.work_order_commitment !== "string" || !leg.work_order_commitment.trim()) {
      throw new Error("saga_execution_context_leg_invalid");
    }
    if (!leg.instruction || typeof leg.instruction !== "object" || Array.isArray(leg.instruction)) {
      throw new Error("saga_execution_context_instruction_invalid");
    }
    return Object.freeze({
      leg_id: expected.leg_id,
      work_order_commitment: leg.work_order_commitment.trim(),
      instruction: structuredClone(leg.instruction),
      accounting_reference_mark_price_e8: Number.isSafeInteger(leg.accounting_reference_mark_price_e8) && leg.accounting_reference_mark_price_e8 > 0
        ? leg.accounting_reference_mark_price_e8
        : null,
      accounting_quote_asset: accountingAsset(leg.accounting_quote_asset),
      accounting_fee_settlement_asset: accountingAsset(leg.accounting_fee_settlement_asset),
      accounting_asset_valuations: accountingValuations(leg.accounting_asset_valuations),
    });
  });
  const autopilotSessionId = optionalText(value.autopilot_session_id);
  const carryPositionId = optionalText(value.carry_position_id);
  if (Boolean(autopilotSessionId) === Boolean(carryPositionId)) {
    throw new Error("saga_execution_parent_invalid");
  }
  const directCarry = carryPositionId
    ? {
        carry_position_id: carryPositionId,
        owner_commitment: requiredText(value.owner_commitment, "saga_owner_commitment_required"),
        session_policy: cloneObject(value.session_policy, "saga_session_policy_required"),
        venue_access: cloneObject(value.venue_access, "saga_venue_access_required"),
      }
    : {};
  return Object.freeze({
    version: 1,
    autopilot_session_id: autopilotSessionId,
    policy_commitment: requiredText(value.policy_commitment, "saga_policy_commitment_required"),
    ...directCarry,
    legs: Object.freeze(normalized),
  });
}

function accountingAsset(value) {
  if (value == null) return null;
  const asset = String(value || "").toUpperCase();
  if (!new Set(["USD", "USDC", "USDT"]).has(asset)) {
    throw new Error("saga_execution_context_accounting_asset_invalid");
  }
  return asset;
}

function accountingValuations(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 3 || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("saga_execution_context_accounting_valuations_invalid");
  }
  return structuredClone(value);
}

export async function applyDurableMultiLegEvent({ state, saga_id, event, now_ms = Date.now() }) {
  assertState(state);
  const saga = await state.getMultiLegSaga(saga_id);
  if (!saga) return { ok: false, error: "saga_not_found", saga: null };
  const advanced = advanceMultiLegSaga({ saga, event, now_ms });
  if (!advanced.ok || advanced.duplicate) return advanced;
  const stored = await state.putMultiLegSaga(advanced.saga, {
    expected_sequence: saga.last_event_sequence,
  });
  if (!stored.ok) {
    return {
      ok: false,
      error: stored.error || "saga_version_conflict",
      saga: stored.saga || await state.getMultiLegSaga(saga_id),
    };
  }
  return { ok: true, duplicate: false, saga: stored.saga };
}

export async function recoverDueMultiLegSagas({
  state,
  now_ms = Date.now(),
  limit = 200,
  recipient = null,
  executeOrder = null,
  verifyOrder = null,
  fetchImpl = fetch,
  env = process.env,
}) {
  assertState(state);
  const active = await state.listMultiLegSagas({ active_only: true, limit });
  const results = [];
  for (const initial of active) {
    let saga = initial;
    let result = null;
    if ((saga.status === "submitting" || saga.status === "partially_hedged") && deadlineDue(saga, now_ms)) {
      result = await applyTimeout(state, saga, now_ms);
      saga = result.saga || saga;
    } else if (saga.status === "reconciling") {
      await pauseParentSession(state, saga, now_ms);
      result = recipient && typeof executeOrder === "function"
        ? await executeReconcilingRecovery({
            state,
            saga,
            recipient,
            executeOrder,
            env,
            nowMs: now_ms,
          })
        : { ok: false, error: "saga_reconciliation_executor_unavailable", saga };
      results.push({ saga_id: initial.saga_id, ...result });
      continue;
    } else if (saga.status !== "compensating") {
      continue;
    }
    if (saga.status === "compensating" || saga.status === "manual_intervention") {
      await pauseParentSession(state, saga, now_ms);
    }
    if (saga.status === "compensating" && recipient && typeof executeOrder === "function") {
      result = await executeCompensatingRecovery({
        state,
        saga,
        recipient,
        executeOrder,
        verifyOrder,
        fetchImpl,
        env,
        nowMs: now_ms,
      });
      saga = result.saga || await state.getMultiLegSaga(saga.saga_id) || saga;
    }
    if (saga.status === "compensating" && deadlineDue(saga, now_ms)) {
      result = await applyTimeout(state, saga, now_ms);
      saga = result.saga || saga;
    }
    results.push({ saga_id: initial.saga_id, ...(result || { ok: true, saga }) });
  }
  return {
    ok: results.every((result) => result.ok || result.error === "saga_version_conflict"),
    checked: active.length,
    recovered: results,
  };
}

export async function readDurableRecoveryAccounting({ state, saga_id: sagaId, leg_id: legId, action }) {
  if (!state || typeof state.getIdempotency !== "function") return null;
  const stored = await state.getIdempotency(recoveryAccountingKey(sagaId, legId, action));
  const evidence = stored?.receipt;
  return evidence?.version === 1 && evidence?.kind === "multi_leg_recovery_accounting"
    ? structuredClone(evidence)
    : null;
}

export function startMultiLegRecoveryLoop({
  state,
  recipient = null,
  executeOrder = null,
  verifyOrder = null,
  fetchImpl = fetch,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  assertState(state);
  if (String(env.PRIVATE_AGENT_MULTI_LEG_RECOVERY_ENABLED ?? "true").toLowerCase() === "false") {
    const health = disabledCarryLoopHealth("multi_leg_recovery");
    return {
      runNow: async () => ({ ok: false, error: "multi_leg_recovery_disabled" }),
      health: () => health,
      stop() {},
    };
  }
  const intervalMs = boundedMs(env.PRIVATE_AGENT_MULTI_LEG_RECOVERY_SWEEP_MS, 250, 60_000, 2_000);
  const initialDelayMs = boundedMs(env.PRIVATE_AGENT_MULTI_LEG_RECOVERY_INITIAL_DELAY_MS, 0, 60_000, 1_000);
  const stallAfterMs = boundedMs(
    env.PRIVATE_AGENT_MULTI_LEG_RECOVERY_STALL_MS,
    intervalMs,
    1_800_000,
    intervalMs * 3,
  );
  const supervisor = createCarryLoopSupervisor({
    name: "multi_leg_recovery",
    now,
    maxSilenceMs: stallAfterMs,
    run: () => recoverDueMultiLegSagas({
      state,
      recipient,
      executeOrder,
      verifyOrder,
      fetchImpl,
      env,
      now_ms: now(),
    }),
  });
  let timer = null;
  let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await supervisor.runOnce();
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  schedule(initialDelayMs);
  return {
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

async function executeReconcilingRecovery({ state, saga, recipient, executeOrder, env, nowMs }) {
  if (saga.legs.some((leg) => !exactQuantityRecoveryAdapter(leg.venue_id))) {
    return { ok: false, error: "exact_quantity_recovery_unavailable", saga };
  }
  const session = await recoverySessionForSaga(state, saga);
  if (!session || !saga.execution_context) {
    return { ok: false, error: "saga_recovery_context_unavailable", saga };
  }

  let current = await state.getMultiLegSaga(saga.saga_id) || saga;
  for (const action of current.next_actions.filter((item) => item.type === "reconcile_leg")) {
    const leg = current.legs.find((item) => item.leg_id === action.leg_id);
    const context = executionLegContext(current, leg.leg_id);
    try {
      const receipt = await executeOrder(recoveryOrderArgs({
        state,
        session,
        saga: current,
        leg,
        context,
        recipient,
        operationClass: "reconcile",
        workOrderCommitment: recoveryWorkOrder(
          current,
          leg,
          "restart_reconcile_original",
          context.work_order_commitment,
        ),
        instruction: reconcileInstruction({ leg, context, nowMs }),
      }));
      const assessment = assessOriginalOrderReconciliation({ leg, context, receipt, env });
      if (!assessment.ok) {
        current = await recoveryEvent({
          state,
          saga: current,
          type: "reconciliation_failed",
          values: { leg_id: leg.leg_id, failure_code: assessment.error },
          nowMs,
        });
        return { ok: false, error: assessment.error, saga: current };
      }
      current = await recoveryEvent({
        state,
        saga: current,
        type: "leg_reconciled",
        values: { leg_id: leg.leg_id },
        nowMs,
      });
    } catch (error) {
      return {
        ok: false,
        error: errorCode(error),
        saga: await state.getMultiLegSaga(saga.saga_id) || current,
      };
    }
  }
  return current.terminal && current.status === "reconciled"
    ? { ok: true, saga: current }
    : { ok: false, error: "saga_reconciliation_incomplete", saga: current };
}

function assessOriginalOrderReconciliation({ leg, context, receipt, env }) {
  const proof = receipt?.final_proof;
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && !recoveryProofTargetsLeg(leg.venue_id, proof)) {
    return { ok: false, error: "original_order_target_unproven" };
  }
  if (proof?.final_venue_execution_proven !== true) {
    return { ok: false, error: "original_order_terminal_unproven" };
  }
  const baseModeReduceOnly = context.instruction?.order?.reduce_only === true
    && context.instruction?.order?.size_mode === "base";
  const proofMicro = Number(proof.cumulative_filled_micro_usdc);
  const fillMicro = fillTotalsForRecord(receipt).micro;
  const filledMicro = baseModeReduceOnly
    ? proportionalMicroForExactBase({
        requestedBase: context.instruction.order.base_size,
        filledBase: proof.filled_base_size,
        expectedMicro: leg.notional_micro_usdc,
      })
    : Number.isSafeInteger(proofMicro) ? proofMicro : fillMicro;
  if (!Number.isSafeInteger(filledMicro) || filledMicro < 0 || filledMicro > leg.notional_micro_usdc) {
    return { ok: false, error: "original_order_fill_invalid" };
  }
  if (filledMicro !== leg.filled_micro_usdc) {
    return { ok: false, error: "original_order_fill_mismatch" };
  }
  return { ok: true };
}

async function applyTimeout(state, saga, nowMs) {
  const sequence = saga.last_event_sequence + 1;
  return applyDurableMultiLegEvent({
    state,
    saga_id: saga.saga_id,
    now_ms: nowMs,
    event: {
      version: 1,
      event_id: timeoutEventId(saga, sequence),
      sequence,
      type: "timeout",
    },
  });
}

async function executeCompensatingRecovery({
  state,
  saga,
  recipient,
  executeOrder,
  verifyOrder,
  fetchImpl,
  env,
  nowMs,
}) {
  if (saga.legs.some((leg) => !exactQuantityRecoveryAdapter(leg.venue_id))) {
    return { ok: false, error: "exact_quantity_recovery_unavailable", saga };
  }
  const session = await recoverySessionForSaga(state, saga);
  if (!session || !saga.execution_context) {
    return { ok: false, error: "saga_recovery_context_unavailable", saga };
  }
  const evidenceByLeg = new Map();
  for (const leg of saga.legs) {
    evidenceByLeg.set(leg.leg_id, await recoveryEvidence({ state, saga, leg, env }));
  }

  let current = await state.getMultiLegSaga(saga.saga_id) || saga;
  for (const action of current.next_actions.filter((item) => item.type === "cancel_leg")) {
    const leg = current.legs.find((item) => item.leg_id === action.leg_id);
    const context = executionLegContext(current, leg.leg_id);
    try {
      const beforeCancelReceipt = await executeOrder(recoveryOrderArgs({
        state,
        session,
        saga: current,
        leg,
        context,
        recipient,
        operationClass: "reconcile",
        workOrderCommitment: recoveryWorkOrder(current, leg, "reconcile_before_cancel", leg.filled_micro_usdc),
        instruction: reconcileInstruction({ leg, context, nowMs }),
      }));
      let evidence = await recoveryEvidence({
        state,
        saga: current,
        leg,
        extraReceipts: [beforeCancelReceipt],
        env,
      });
      evidenceByLeg.set(leg.leg_id, evidence);
      current = await applyRecoveryFillIfNew({ state, saga: current, leg, evidence, nowMs });

      if (!evidence.terminal) {
        const currentLeg = current.legs.find((item) => item.leg_id === leg.leg_id);
        const cancelReceipt = await executeOrder(recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg: currentLeg,
          context,
          recipient,
          operationClass: "cancel",
          workOrderCommitment: recoveryWorkOrder(current, currentLeg, "cancel", currentLeg.filled_micro_usdc),
          instruction: cancelInstruction({ leg: currentLeg, context, nowMs }),
        }));
        if (cancelReceipt?.status !== "cancelled") {
          return { ok: false, error: "saga_cancel_not_confirmed", saga: current };
        }
        const afterCancelReceipt = await executeOrder(recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg: currentLeg,
          context,
          recipient,
          operationClass: "reconcile",
          workOrderCommitment: recoveryWorkOrder(current, currentLeg, "reconcile_after_cancel", currentLeg.filled_micro_usdc),
          instruction: reconcileInstruction({ leg: currentLeg, context, nowMs }),
        }));
        evidence = await recoveryEvidence({
          state,
          saga: current,
          leg: currentLeg,
          extraReceipts: [beforeCancelReceipt, afterCancelReceipt],
          env,
        });
        evidenceByLeg.set(leg.leg_id, evidence);
        current = await applyRecoveryFillIfNew({ state, saga: current, leg: currentLeg, evidence, nowMs });
        current = await recoveryEvent({
          state,
          saga: current,
          type: "cancel_confirmed",
          values: {
            leg_id: leg.leg_id,
            cumulative_filled_micro_usdc: evidence.filledMicro,
          },
          nowMs,
        });
        continue;
      }

      current = await recoveryEvent({
        state,
        saga: current,
        type: "leg_finalized",
        values: {
          leg_id: leg.leg_id,
          cumulative_filled_micro_usdc: evidence.filledMicro,
        },
        nowMs,
      });
    } catch (error) {
      return { ok: false, error: errorCode(error), saga: await state.getMultiLegSaga(saga.saga_id) || current };
    }
  }

  current = await state.getMultiLegSaga(saga.saga_id) || current;
  if (current.recovery_mode === "complete_reduce_only") {
    return executeRiskReducingCompletion({
      state,
      saga: current,
      session,
      recipient,
      executeOrder,
      verifyOrder,
      fetchImpl,
      env,
      nowMs,
    });
  }
  for (const action of current.next_actions.filter((item) => item.type === "submit_unwind")) {
    let leg = current.legs.find((item) => item.leg_id === action.leg_id);
    let context = executionLegContext(current, leg.leg_id);
    const settled = await settlePriorRecoveryExecutions({
      state,
      saga: current,
      leg,
      action: "unwind",
      context,
      session,
      recipient,
      executeOrder,
      env,
      nowMs,
    });
    if (!settled.ok) return settled;
    current = settled.saga;
    if (!current.next_actions.some((item) => item.type === "submit_unwind" && item.leg_id === action.leg_id)) continue;
    leg = current.legs.find((item) => item.leg_id === action.leg_id);
    context = executionLegContext(current, leg.leg_id);
    const evidence = evidenceByLeg.get(leg.leg_id) || await recoveryEvidence({ state, saga: current, leg, env });
    const remainingMicro = leg.filled_micro_usdc - leg.unwind_filled_micro_usdc;
    const remainingBase = proportionalExactBase({
      base: evidence.filledBase,
      numeratorMicro: remainingMicro,
      denominatorMicro: leg.filled_micro_usdc,
    });
    if (!remainingBase) {
      current = await recoveryEvent({
        state,
        saga: current,
        type: "unwind_failed",
        values: { leg_id: leg.leg_id, failure_code: "exact_base_quantity_unavailable" },
        nowMs,
      });
      await pauseParentSession(state, current, nowMs);
      return { ok: false, error: "exact_base_quantity_unavailable", saga: current };
    }
    await putRecoveryPosition({ state, session, saga: current, leg, filledBase: evidence.filledBase, nowMs });
    let price;
    try {
      price = await recoveryMark({ leg, context, fetchImpl, env });
    } catch (error) {
      return { ok: false, error: errorCode(error), saga: current };
    }
    const unwindInstruction = recoveryUnwindInstruction({
      leg,
      context,
      session,
      remainingMicro,
      remainingBase,
      price,
      nowMs,
    });
    const workOrderCommitment = recoveryWorkOrder(current, leg, "unwind", remainingMicro);
    try {
      if (await untrackedRecoveryAttemptExists(state, workOrderCommitment)) {
        return { ok: false, error: "unwind_outcome_requires_reconciliation", saga: current };
      }
      await verifyRecoveryOrderNoSubmit({
        verifyOrder,
        args: recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg,
          context,
          recipient,
          operationClass: unwindInstruction.operation_class,
          workOrderCommitment: `${workOrderCommitment}:preflight`,
          instruction: unwindInstruction,
        }),
      });
      await storeRecoveryAccounting({
        state,
        saga: current,
        leg,
        action: "unwind",
        workOrderCommitment,
        referenceMarkPrice: price,
        requestedBase: remainingBase,
        requestedMicro: remainingMicro,
        positionFilledBase: evidence.filledBase,
        receipt: null,
        nowMs,
      });
      const receipt = await executeOrder(recoveryOrderArgs({
        state,
        session,
        saga: current,
        leg,
        context,
        recipient,
        operationClass: unwindInstruction.operation_class,
        workOrderCommitment,
        instruction: unwindInstruction,
      }));
      await storeRecoveryAccounting({
        state,
        saga: current,
        leg,
        action: "unwind",
        workOrderCommitment,
        referenceMarkPrice: price,
        requestedBase: remainingBase,
        requestedMicro: remainingMicro,
        positionFilledBase: evidence.filledBase,
        receipt,
        nowMs,
      });
      const progressed = await applyRecoveryExecutionProgress({
        state,
        saga: current,
        leg,
        action: "unwind",
        session,
        execution: {
          work_order_commitment: workOrderCommitment,
          reference_mark_price_e8: Math.round(price * 100_000_000),
          requested_base_size: remainingBase,
          requested_micro_usdc: remainingMicro,
          applied_filled_micro_usdc: 0,
          position_filled_base_size: evidence.filledBase,
          receipt: accountingReceipt(receipt),
        },
        env,
        nowMs,
      });
      if (!progressed.ok) return progressed;
      current = progressed.saga;
      if (progressed.progress.terminal && progressed.progress.filledMicro === 0) {
        current = await recoveryEvent({
          state,
          saga: current,
          type: "unwind_failed",
          values: { leg_id: leg.leg_id, failure_code: "terminal_unwind_without_fill" },
          nowMs,
        });
        await pauseParentSession(state, current, nowMs);
        return { ok: false, error: "terminal_unwind_without_fill", saga: current };
      }
    } catch (error) {
      return { ok: false, error: errorCode(error), saga: await state.getMultiLegSaga(saga.saga_id) || current };
    }
    current = await state.getMultiLegSaga(saga.saga_id) || current;
  }
  return current.terminal && current.status === "unwound"
    ? { ok: true, saga: current }
    : { ok: false, error: "saga_recovery_incomplete", saga: current };
}

async function executeRiskReducingCompletion({
  state,
  saga,
  session,
  recipient,
  executeOrder,
  verifyOrder,
  fetchImpl,
  env,
  nowMs,
}) {
  let current = saga;
  for (const action of current.next_actions.filter((item) => item.type === "submit_completion")) {
    let leg = current.legs.find((item) => item.leg_id === action.leg_id);
    let context = executionLegContext(current, leg.leg_id);
    const settled = await settlePriorRecoveryExecutions({
      state,
      saga: current,
      leg,
      action: "completion",
      context,
      session,
      recipient,
      executeOrder,
      env,
      nowMs,
    });
    if (!settled.ok) return settled;
    current = settled.saga;
    if (!current.next_actions.some((item) => item.type === "submit_completion" && item.leg_id === action.leg_id)) continue;
    leg = current.legs.find((item) => item.leg_id === action.leg_id);
    context = executionLegContext(current, leg.leg_id);
    const remainingMicro = leg.notional_micro_usdc - leg.filled_micro_usdc;
    const requestedBase = canonicalExactPositiveDecimal(context.instruction?.order?.base_size);
    const remainingBase = proportionalExactBase({
      base: requestedBase,
      numeratorMicro: remainingMicro,
      denominatorMicro: leg.notional_micro_usdc,
    });
    if (!remainingBase) {
      current = await recoveryEvent({
        state,
        saga: current,
        type: "completion_failed",
        values: { leg_id: leg.leg_id, failure_code: "exact_base_quantity_unavailable" },
        nowMs,
      });
      return { ok: false, error: "exact_base_quantity_unavailable", saga: current };
    }
    const workOrderCommitment = recoveryWorkOrder(current, leg, "completion", remainingMicro);
    if (await untrackedRecoveryAttemptExists(state, workOrderCommitment)) {
      return { ok: false, error: "completion_outcome_requires_reconciliation", saga: current };
    }
    let price;
    try {
      price = await recoveryMark({ leg, context, fetchImpl, env });
    } catch (error) {
      return { ok: false, error: errorCode(error), saga: current };
    }
    const instruction = recoveryCompletionInstruction({
      leg,
      context,
      session,
      remainingMicro,
      remainingBase,
      price,
      nowMs,
    });
    try {
      await verifyRecoveryOrderNoSubmit({
        verifyOrder,
        args: recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg,
          context,
          recipient,
          operationClass: instruction.operation_class,
          workOrderCommitment: `${workOrderCommitment}:preflight`,
          instruction,
        }),
      });
      await storeRecoveryAccounting({
        state,
        saga: current,
        leg,
        action: "completion",
        workOrderCommitment,
        referenceMarkPrice: price,
        requestedBase: remainingBase,
        requestedMicro: remainingMicro,
        receipt: null,
        nowMs,
      });
      const receipt = await executeOrder(recoveryOrderArgs({
        state,
        session,
        saga: current,
        leg,
        context,
        recipient,
        operationClass: instruction.operation_class,
        workOrderCommitment,
        instruction,
      }));
      await storeRecoveryAccounting({
        state,
        saga: current,
        leg,
        action: "completion",
        workOrderCommitment,
        referenceMarkPrice: price,
        requestedBase: remainingBase,
        requestedMicro: remainingMicro,
        receipt,
        nowMs,
      });
      const progressed = await applyRecoveryExecutionProgress({
        state,
        saga: current,
        leg,
        action: "completion",
        session,
        execution: {
          work_order_commitment: workOrderCommitment,
          reference_mark_price_e8: Math.round(price * 100_000_000),
          requested_base_size: remainingBase,
          requested_micro_usdc: remainingMicro,
          applied_filled_micro_usdc: 0,
          receipt: accountingReceipt(receipt),
        },
        env,
        nowMs,
      });
      if (!progressed.ok) return progressed;
      current = progressed.saga;
      if (progressed.progress.terminal && progressed.progress.filledMicro === 0) {
        current = await recoveryEvent({
          state,
          saga: current,
          type: "completion_failed",
          values: { leg_id: leg.leg_id, failure_code: "terminal_completion_without_fill" },
          nowMs,
        });
        return { ok: false, error: "terminal_completion_without_fill", saga: current };
      }
    } catch (error) {
      return { ok: false, error: errorCode(error), saga: await state.getMultiLegSaga(saga.saga_id) || current };
    }
    current = await state.getMultiLegSaga(saga.saga_id) || current;
  }
  if (current.status === "reconciling") {
    for (const leg of current.legs.filter((item) => !item.reconciled)) {
      current = await recoveryEvent({ state, saga: current, type: "leg_reconciled", values: { leg_id: leg.leg_id }, nowMs });
    }
  }
  return current.terminal && current.status === "reconciled"
    ? { ok: true, saga: current }
    : { ok: false, error: "risk_reducing_completion_incomplete", saga: current };
}

async function settlePriorRecoveryExecutions({
  state,
  saga,
  leg,
  action,
  context,
  session,
  recipient,
  executeOrder,
  env,
  nowMs,
}) {
  let current = saga;
  try {
    const accounting = await readDurableRecoveryAccounting({
      state,
      saga_id: saga.saga_id,
      leg_id: leg.leg_id,
      action,
    });
    for (const storedExecution of accounting?.executions || []) {
      const requestedBase = canonicalExactPositiveDecimal(storedExecution.requested_base_size);
      const requestedMicro = Number(storedExecution.requested_micro_usdc);
      if (!requestedBase || !Number.isSafeInteger(requestedMicro) || requestedMicro <= 0) {
        return { ok: false, error: "recovery_accounting_quantity_unavailable", saga: current };
      }
      let execution = storedExecution;
      let progress = unwindProgress({
        receipt: execution.receipt,
        requestedBase,
        remainingMicro: requestedMicro,
        venueId: leg.venue_id,
        env,
      });
      if (!progress.terminal) {
        const reconcileReceipt = await executeOrder(recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg,
          context,
          recipient,
          operationClass: "reconcile",
          workOrderCommitment: recoveryWorkOrder(current, leg, `${action}_reconcile`, execution.work_order_commitment),
          instruction: recoveryChildReconcileInstruction({
            leg,
            context,
            targetWorkOrderCommitment: execution.work_order_commitment,
            nowMs,
          }),
        }));
        await storeRecoveryAccounting({
          state,
          saga: current,
          leg,
          action,
          workOrderCommitment: execution.work_order_commitment,
          referenceMarkPrice: execution.reference_mark_price_e8 / 100_000_000,
          requestedBase,
          requestedMicro,
          appliedFilledMicro: execution.applied_filled_micro_usdc,
          receipt: reconcileReceipt,
          nowMs,
        });
        execution = { ...execution, receipt: accountingReceipt(reconcileReceipt) };
        progress = unwindProgress({
          receipt: reconcileReceipt,
          requestedBase,
          remainingMicro: requestedMicro,
          venueId: leg.venue_id,
          env,
        });
      }
      const progressed = await applyRecoveryExecutionProgress({
        state,
        saga: current,
        leg: current.legs.find((item) => item.leg_id === leg.leg_id),
        action,
        session,
        execution,
        env,
        nowMs,
      });
      if (!progressed.ok) return progressed;
      current = progressed.saga;
      if (progress.terminal && progress.filledMicro === 0) {
        current = await recoveryEvent({
          state,
          saga: current,
          type: action === "unwind" ? "unwind_failed" : "completion_failed",
          values: {
            leg_id: leg.leg_id,
            failure_code: action === "unwind"
              ? "terminal_unwind_without_fill"
              : "terminal_completion_without_fill",
          },
          nowMs,
        });
        if (action === "unwind") await pauseParentSession(state, current, nowMs);
        return {
          ok: false,
          error: action === "unwind"
            ? "terminal_unwind_without_fill"
            : "terminal_completion_without_fill",
          saga: current,
        };
      }
      if (!progress.terminal) {
        return { ok: false, error: `${action}_outcome_requires_reconciliation`, saga: current };
      }
    }
  } catch (error) {
    return { ok: false, error: errorCode(error), saga: await state.getMultiLegSaga(saga.saga_id) || current };
  }
  return { ok: true, saga: current };
}

async function untrackedRecoveryAttemptExists(state, workOrderCommitment) {
  const [cached, attempt] = await Promise.all([
    state.getIdempotency?.(workOrderCommitment),
    state.getExecutionAttempt?.(workOrderCommitment),
  ]);
  return Boolean(cached?.receipt || attempt);
}

async function applyRecoveryExecutionProgress({ state, saga, leg, action, session, execution, env, nowMs }) {
  const requestedBase = canonicalExactPositiveDecimal(execution.requested_base_size);
  const requestedMicro = Number(execution.requested_micro_usdc);
  const appliedMicro = Number(execution.applied_filled_micro_usdc || 0);
  if (!requestedBase || !Number.isSafeInteger(requestedMicro) || requestedMicro <= 0
    || !Number.isSafeInteger(appliedMicro) || appliedMicro < 0 || appliedMicro > requestedMicro) {
    return { ok: false, error: "recovery_accounting_quantity_unavailable", saga };
  }
  const progress = unwindProgress({
    receipt: execution.receipt,
    requestedBase,
    remainingMicro: requestedMicro,
    venueId: leg.venue_id,
    env,
  });
  if (progress.filledMicro < appliedMicro) {
    return { ok: false, error: "recovery_fill_evidence_regressed", saga };
  }
  const applicableFilledMicro = !progress.terminal && progress.filledMicro === requestedMicro
    ? appliedMicro
    : progress.filledMicro;
  const applicableProgress = { ...progress, filledMicro: applicableFilledMicro };
  let current = await state.getMultiLegSaga(saga.saga_id) || saga;
  const currentLeg = current.legs.find((item) => item.leg_id === leg.leg_id);
  const startingCumulative = action === "unwind"
    ? currentLeg.filled_micro_usdc - requestedMicro
    : currentLeg.notional_micro_usdc - requestedMicro;
  if (!Number.isSafeInteger(startingCumulative) || startingCumulative < 0) {
    return { ok: false, error: "recovery_accounting_quantity_unavailable", saga: current };
  }
  const currentCumulative = action === "unwind"
    ? currentLeg.unwind_filled_micro_usdc
    : currentLeg.filled_micro_usdc;
  const cumulativeLimit = action === "unwind" ? currentLeg.filled_micro_usdc : currentLeg.notional_micro_usdc;
  const targetCumulative = Math.min(cumulativeLimit, startingCumulative + applicableFilledMicro);
  if (applicableFilledMicro > appliedMicro) {
    await storeRecoveryAccounting({
      state,
      saga: current,
      leg,
      action,
      workOrderCommitment: execution.work_order_commitment,
      referenceMarkPrice: execution.reference_mark_price_e8 / 100_000_000,
      requestedBase,
      requestedMicro,
      appliedFilledMicro: applicableFilledMicro,
      positionFilledBase: execution.position_filled_base_size,
      receipt: execution.receipt,
      nowMs,
    });
  }
  if (action === "unwind" && targetCumulative > currentCumulative) {
    const filledBase = canonicalExactPositiveDecimal(execution.position_filled_base_size);
    if (!filledBase) {
      return { ok: false, error: "recovery_position_base_unavailable", saga: current };
    }
    await putRecoveryPosition({
      state,
      session,
      saga: current,
      leg: { ...currentLeg, unwind_filled_micro_usdc: targetCumulative },
      filledBase,
      nowMs,
    });
  }
  if (targetCumulative > currentCumulative) {
    const result = await applyDurableMultiLegEvent({
      state,
      saga_id: current.saga_id,
      now_ms: Math.max(nowMs, current.updated_at_ms),
      event: {
        version: 1,
        event_id: `recovery:${hash(`${current.saga_id}:${leg.leg_id}:${action}:${execution.work_order_commitment}:${applicableFilledMicro}`).slice(0, 40)}`,
        sequence: current.last_event_sequence + 1,
        type: action === "unwind" ? "unwind_fill" : "completion_fill",
        leg_id: leg.leg_id,
        cumulative_filled_micro_usdc: targetCumulative,
      },
    });
    if (!result.ok) return { ok: false, error: result.error || "saga_recovery_event_failed", saga: result.saga || current };
    current = result.saga;
  }
  return { ok: true, saga: current, progress: applicableProgress };
}

async function applyRecoveryFillIfNew({ state, saga, leg, evidence, nowMs }) {
  if (evidence.filledMicro <= leg.filled_micro_usdc) return saga;
  return recoveryEvent({
    state,
    saga,
    type: "leg_fill",
    values: {
      leg_id: leg.leg_id,
      cumulative_filled_micro_usdc: evidence.filledMicro,
    },
    nowMs,
  });
}

async function recoveryEvent({ state, saga, type, values, nowMs }) {
  const current = await state.getMultiLegSaga(saga.saga_id) || saga;
  const sequence = current.last_event_sequence + 1;
  const result = await applyDurableMultiLegEvent({
    state,
    saga_id: current.saga_id,
    now_ms: Math.max(nowMs, current.updated_at_ms),
    event: {
      version: 1,
      event_id: `recovery:${hash(`${current.saga_id}:${sequence}:${type}:${values.leg_id || "pair"}`).slice(0, 40)}`,
      sequence,
      type,
      ...values,
    },
  });
  if (!result.ok) throw new Error(result.error || "saga_recovery_event_failed");
  return result.saga;
}

async function recoveryEvidence({ state, saga, leg, extraReceipts = [], env }) {
  const context = executionLegContext(saga, leg.leg_id);
  const baseModeReduceOnly = context.instruction?.order?.reduce_only === true
    && context.instruction?.order?.size_mode === "base";
  const cached = await state.getIdempotency?.(context.work_order_commitment);
  const attempt = await state.getExecutionAttempt?.(context.work_order_commitment);
  const records = [cached?.receipt, attempt, ...extraReceipts].filter(Boolean);
  let evidenceMicro = null;
  let evidenceBase = null;
  let terminal = false;
  let selectedEvidence = false;
  let terminalRegressed = false;
  for (const record of records) {
    const proof = record.final_proof;
    if (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && !recoveryProofTargetsLeg(leg.venue_id, proof)) continue;
    const proofMicro = Number(proof?.cumulative_filled_micro_usdc);
    const fillTotals = fillTotalsForRecord(record);
    const candidateMicro = baseModeReduceOnly
      ? proportionalMicroForExactBase({
          requestedBase: context.instruction.order.base_size,
          filledBase: proof?.filled_base_size,
          expectedMicro: leg.notional_micro_usdc,
        })
      : Number.isSafeInteger(proofMicro) ? proofMicro : fillTotals.micro;
    const candidateBase = canonicalExactPositiveDecimal(proof?.filled_base_size);
    if (!Number.isSafeInteger(candidateMicro) || candidateMicro < 0 || candidateMicro > leg.notional_micro_usdc) {
      continue;
    }
    if (evidenceMicro === null || candidateMicro > evidenceMicro) {
      evidenceMicro = candidateMicro;
      evidenceBase = candidateBase;
      terminal = proof?.final_venue_execution_proven === true;
      selectedEvidence = true;
      terminalRegressed = false;
    } else if (candidateMicro === evidenceMicro) {
      if (candidateBase && evidenceBase && evidenceBase !== candidateBase) {
        throw new Error("saga_recovery_fill_base_conflict");
      }
      if (candidateBase) evidenceBase = candidateBase;
      const candidateTerminal = proof?.final_venue_execution_proven === true;
      if (selectedEvidence && terminal && !candidateTerminal) {
        terminal = false;
        terminalRegressed = true;
      } else if (!terminalRegressed && candidateTerminal) {
        terminal = true;
      }
      selectedEvidence = true;
    }
  }
  const filledMicro = Math.max(leg.filled_micro_usdc, evidenceMicro ?? 0);
  let filledBase = evidenceMicro === filledMicro ? evidenceBase : null;
  if (evidenceMicro !== filledMicro) terminal = false;
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && filledMicro > 0 && !filledBase) {
    filledBase = proportionalExactBase({
      base: context.instruction?.order?.base_size,
      numeratorMicro: filledMicro,
      denominatorMicro: leg.notional_micro_usdc,
    });
  }
  return { filledMicro, filledBase, terminal };
}

function fillTotalsForRecord(record) {
  const fills = Array.isArray(record?.fills) ? record.fills : [];
  let base = 0;
  let notional = 0;
  for (const fill of fills) {
    const size = positiveNumber(fill?.size ?? fill?.sz ?? fill?.totalSz);
    const price = positiveNumber(fill?.price ?? fill?.px ?? fill?.avgPx);
    if (!size || !price) continue;
    base += size;
    notional += size * price;
  }
  return { base, micro: Math.max(0, Math.round(notional * 1_000_000)) };
}

function unwindProgress({ receipt, requestedBase, remainingMicro, venueId, env }) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return { terminal: Boolean(receipt), filledMicro: receipt ? remainingMicro : 0 };
  }
  const proof = receipt?.final_proof;
  if (!recoveryProofTargetsLeg(venueId, proof)) return { terminal: false, filledMicro: 0 };
  return {
    terminal: proof?.final_venue_execution_proven === true,
    filledMicro: proportionalMicroForExactBase({
      requestedBase,
      filledBase: proof?.filled_base_size,
      expectedMicro: remainingMicro,
    }),
  };
}

function recoveryProofTargetsLeg(venueId, proof) {
  return exactQuantityRecoveryAdapter(venueId) !== null
    && proof?.target_client_order_matched === true
    && proof?.broadcast_performed === true;
}

function cancelInstruction({ leg, context, nowMs }) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: "cancel",
    expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
    cancel: {
      market: originalVenueMarket(leg, context),
      target_work_order_commitment: context.work_order_commitment,
    },
  };
}

function reconcileInstruction({ leg, context, nowMs }) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: "reconcile",
    expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
    reconcile: {
      product_id: leg.market,
      market: originalVenueMarket(leg, context),
      target_work_order_commitment: context.work_order_commitment,
    },
  };
}

function recoveryChildReconcileInstruction({ leg, context, targetWorkOrderCommitment, nowMs }) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: "reconcile",
    expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
    reconcile: {
      product_id: leg.market,
      market: originalVenueMarket(leg, context),
      target_work_order_commitment: targetWorkOrderCommitment,
    },
  };
}

function recoveryUnwindInstruction({ leg, context, session, remainingMicro, remainingBase, price, nowMs }) {
  const recoveryAdapter = exactQuantityRecoveryAdapter(leg.venue_id);
  if (!recoveryAdapter) throw new Error("exact_quantity_recovery_unavailable");
  const side = leg.side === "buy" ? "sell" : "buy";
  const slippageBps = Math.max(1, Number(session.session_policy?.max_slippage_bps || 50));
  const limit = side === "buy"
    ? price * (1 + slippageBps / 10_000)
    : price * (1 - slippageBps / 10_000);
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: recoveryAdapter === "coinbase_advanced_v1" ? "spot_market_order" : "limit_order",
    expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
    order: {
      market: originalVenueMarket(leg, context),
      side,
      base_size: requiredExactPositiveDecimal(remainingBase, "exact_base_quantity_unavailable"),
      quote_size: trim(remainingMicro / 1_000_000),
      limit_price: trim(limit),
      order_type: "market",
      size_mode: "base",
      live_order_mode: "tiny_fill",
      max_slippage_bps: String(slippageBps),
      reduce_only: true,
      tif: recoveryAdapter === "coinbase_advanced_v1" ? "ioc" : "Ioc",
    },
  };
}

function recoveryCompletionInstruction({ leg, context, session, remainingMicro, remainingBase, price, nowMs }) {
  const recoveryAdapter = exactQuantityRecoveryAdapter(leg.venue_id);
  if (!recoveryAdapter) throw new Error("exact_quantity_recovery_unavailable");
  const side = leg.side;
  const slippageBps = Math.max(1, Number(session.session_policy?.max_slippage_bps || 50));
  const limit = side === "buy"
    ? price * (1 + slippageBps / 10_000)
    : price * (1 - slippageBps / 10_000);
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: recoveryAdapter === "coinbase_advanced_v1" ? "spot_market_order" : "limit_order",
    expires_at: new Date(nowMs + 5 * 60_000).toISOString(),
    order: {
      market: originalVenueMarket(leg, context),
      side,
      base_size: requiredExactPositiveDecimal(remainingBase, "exact_base_quantity_unavailable"),
      quote_size: trim(remainingMicro / 1_000_000),
      limit_price: trim(limit),
      order_type: "market",
      size_mode: "base",
      live_order_mode: "tiny_fill",
      max_slippage_bps: String(slippageBps),
      reduce_only: true,
      tif: recoveryAdapter === "coinbase_advanced_v1" ? "ioc" : "Ioc",
    },
  };
}

function recoveryOrderArgs({
  state,
  session,
  saga,
  leg,
  context,
  recipient,
  operationClass,
  workOrderCommitment,
  instruction,
}) {
  return {
    venue_id: leg.venue_id,
    account_commitment: session.venue_access?.[leg.venue_id]?.account_commitment || undefined,
    operation_class: operationClass,
    work_order_commitment: workOrderCommitment,
    policy_commitment: saga.execution_context.policy_commitment,
    session_policy: {
      ...session.session_policy,
      kill_switch: session.session_policy?.kill_switch === true || session.status === "killed",
    },
    instruction,
    execution: {
      ...executionForRecovery(session, leg.venue_id),
      autopilot_session_id: saga.execution_context.autopilot_session_id || undefined,
      carry_position_id: saga.execution_context.carry_position_id || undefined,
      owner_commitment: saga.execution_context.owner_commitment || undefined,
      recovery_saga_id: saga.saga_id,
      target_work_order_commitment: context.work_order_commitment,
    },
    recipient,
    state,
  };
}

async function verifyRecoveryOrderNoSubmit({ verifyOrder, args }) {
  if (typeof verifyOrder !== "function") throw new Error("saga_recovery_no_submit_verifier_unavailable");
  const receipt = await verifyOrder(args);
  const order = args.instruction?.order;
  const shape = receipt?.order_shape;
  const expectedAccount = args.account_commitment;
  const statusAccepted = receipt?.status === "verified_ready" || receipt?.status === "verified_no_funds";
  const orderChecked = receipt?.checks?.order_request_checked === true || receipt?.checks?.order_request_built === true;
  if (!statusAccepted || receipt?.checks?.transaction_broadcast !== false || !orderChecked
    || !shape || String(shape.market) !== String(order?.market) || shape.side !== order?.side
    || shape.reduce_only !== true || !samePositiveDecimal(shape.base_size, order?.base_size)
    || !samePositiveDecimal(shape.limit_price, order?.limit_price)
    || (expectedAccount && receipt?.account_commitment !== expectedAccount)) {
    throw new Error("saga_recovery_no_submit_mismatch");
  }
  return receipt;
}

function samePositiveDecimal(left, right) {
  const normalizedLeft = canonicalExactPositiveDecimal(left);
  return normalizedLeft !== null && normalizedLeft === canonicalExactPositiveDecimal(right);
}

function executionForRecovery(session, venue) {
  const access = session.venue_access?.[venue] || {};
  return {
    execution_mode: access.execution_mode || "byo_api_key",
    account_commitment: access.account_commitment || undefined,
    vault_commitment: access.vault_commitment || undefined,
    encrypted_vault_commitment: access.encrypted_vault_commitment || undefined,
    encrypted_execution_vault: access.encrypted_execution_vault || undefined,
    allocation_commitment: access.allocation_commitment || undefined,
    managed_allocation_commitment: access.managed_allocation_commitment || undefined,
    omnibus_allocation: access.omnibus_allocation || undefined,
  };
}

async function recoveryMark({ leg, context, fetchImpl, env }) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const price = positiveNumber(context.instruction?.order?.limit_price);
    if (price > 0) return price;
    throw new Error("saga_recovery_mark_unavailable");
  }
  const recoveryAdapter = exactQuantityRecoveryAdapter(leg.venue_id);
  if (recoveryAdapter === "coinbase_advanced_v1") {
    const response = await fetchImpl(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(leg.market)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) throw new Error("saga_recovery_mark_unavailable");
    const body = await response.json();
    const price = positiveNumber(body?.price || body?.mid_market_price || body?.pricebook?.best_bid);
    if (price > 0) return price;
  } else if (recoveryAdapter === "hyperliquid_v1") {
    const response = await fetchImpl("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!response.ok) throw new Error("saga_recovery_mark_unavailable");
    const mids = await response.json();
    const price = positiveNumber(mids?.[leg.asset]);
    if (price > 0) return price;
  } else if (recoveryAdapter === "aster_v1") {
    const market = originalVenueMarket(leg, context).toUpperCase().replace(/[-_/]/g, "").replace(/PERP$/, "");
    const symbol = /USDT$/.test(market) ? market : `${market}USDT`;
    const response = await fetchImpl(`https://fapi.asterdex.com/fapi/v3/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) throw new Error("saga_recovery_mark_unavailable");
    const body = await response.json();
    const price = positiveNumber(body?.markPrice || body?.indexPrice);
    if (price > 0) return price;
  } else if (recoveryAdapter === "lighter_v1") {
    const response = await fetchImpl("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) throw new Error("saga_recovery_mark_unavailable");
    const body = await response.json();
    const rows = body?.order_book_details || body?.order_books || body?.markets || [];
    const row = rows.find((item) => String(item?.symbol || item?.market_symbol || "").toUpperCase() === leg.asset);
    const price = positiveNumber(row?.mark_price || row?.index_price || row?.last_trade_price);
    if (price > 0) return price;
  } else throw new Error("exact_quantity_recovery_unavailable");
  throw new Error("saga_recovery_mark_unavailable");
}

async function putRecoveryPosition({ state, session, saga, leg, filledBase, nowMs }) {
  if (!session.autopilot_session_id || typeof state.putAutopilotPosition !== "function" || typeof state.listAutopilotPositions !== "function") return;
  const remainingMicro = leg.filled_micro_usdc - leg.unwind_filled_micro_usdc;
  const remainingBase = remainingMicro === 0
    ? "0"
    : proportionalExactBase({
        base: filledBase,
        numeratorMicro: remainingMicro,
        denominatorMicro: leg.filled_micro_usdc,
      });
  if (!remainingBase) throw new Error("recovery_position_base_unavailable");
  const positions = await state.listAutopilotPositions(session.autopilot_session_id);
  const prior = positions.find((position) =>
    position.venue_id === leg.venue_id && String(position.market).toUpperCase() === String(leg.market).toUpperCase()
  );
  const priorComponentNotional = prior?.recovery_saga_id === saga.saga_id
    ? Number(prior.recovery_component_signed_notional_micro_usdc || 0)
    : 0;
  const priorComponentBase = prior?.recovery_saga_id === saga.saga_id
    ? canonicalExactSignedDecimal(prior.recovery_component_signed_base_size ?? "0")
    : "0";
  const priorSignedBase = canonicalExactSignedDecimal(prior?.signed_base_size ?? "0");
  if (!priorComponentBase || !priorSignedBase) throw new Error("recovery_position_base_unavailable");
  const direction = leg.side === "sell" ? -1 : 1;
  const componentNotional = direction * remainingMicro;
  const componentBase = direction < 0 ? negateExactDecimal(remainingBase) : remainingBase;
  const signedNotional = Number(prior?.signed_notional_micro_usdc || 0) - priorComponentNotional + componentNotional;
  const signedBase = sumExactSignedDecimals(priorSignedBase, negateExactDecimal(priorComponentBase), componentBase);
  if (!signedBase) throw new Error("recovery_position_base_unavailable");
  await state.putAutopilotPosition(session.autopilot_session_id, {
    ...prior,
    venue_id: leg.venue_id,
    asset: leg.asset,
    market: leg.market,
    product_type: leg.product_type,
    side: signedNotional < 0 ? "sell" : "buy",
    signed_notional_micro_usdc: signedNotional,
    signed_base_size: signedBase,
    estimated_exposure_notional_usd: Math.abs(signedNotional) / 1_000_000,
    recovery_saga_id: saga.saga_id,
    recovery_component_signed_notional_micro_usdc: componentNotional,
    recovery_component_signed_base_size: componentBase,
    source: remainingMicro > 0 ? "durable_recovery_reconciliation" : "durable_recovery_unwind",
    closed_at: remainingMicro === 0 ? new Date(nowMs).toISOString() : null,
  });
}

function executionLegContext(saga, legId) {
  const context = saga.execution_context?.legs?.find((item) => item.leg_id === legId);
  if (!context) throw new Error("saga_recovery_leg_context_unavailable");
  return context;
}

function originalVenueMarket(leg, context) {
  return context.instruction?.order?.market || context.instruction?.cancel?.market ||
    (exactQuantityRecoveryAdapter(leg.venue_id) === "hyperliquid_v1" ? leg.asset : leg.market);
}

function recoveryWorkOrder(saga, leg, action, amount) {
  return `work:recovery:${hash(`${saga.saga_id}:${leg.leg_id}:${action}:${amount}`).slice(0, 40)}`;
}

function recoveryAccountingKey(sagaId, legId, action) {
  return `accounting:recovery:${hash(`${sagaId}:${legId}:${action}`).slice(0, 40)}`;
}

async function storeRecoveryAccounting({
  state,
  saga,
  leg,
  action,
  workOrderCommitment,
  referenceMarkPrice,
  requestedBase,
  requestedMicro,
  appliedFilledMicro = 0,
  positionFilledBase = null,
  receipt,
  nowMs,
}) {
  if (typeof state.getIdempotency !== "function" || typeof state.putIdempotency !== "function") return;
  const key = recoveryAccountingKey(saga.saga_id, leg.leg_id, action);
  const prior = await readDurableRecoveryAccounting({ state, saga_id: saga.saga_id, leg_id: leg.leg_id, action });
  const executions = Array.isArray(prior?.executions) ? prior.executions : [];
  const referenceMarkPriceE8 = Math.round(Number(referenceMarkPrice) * 100_000_000);
  if (!Number.isSafeInteger(referenceMarkPriceE8) || referenceMarkPriceE8 <= 0) return;
  const requestedMicroUsdc = Number(requestedMicro);
  const appliedMicroUsdc = Number(appliedFilledMicro || 0);
  const requestedBaseSize = canonicalExactPositiveDecimal(requestedBase);
  const existing = executions.find((item) => item.work_order_commitment === workOrderCommitment);
  const positionFilledBaseSize = canonicalExactPositiveDecimal(positionFilledBase)
    || canonicalExactPositiveDecimal(existing?.position_filled_base_size);
  if (!requestedBaseSize || !Number.isSafeInteger(requestedMicroUsdc) || requestedMicroUsdc <= 0) return;
  if (!Number.isSafeInteger(appliedMicroUsdc) || appliedMicroUsdc < 0 || appliedMicroUsdc > requestedMicroUsdc) return;
  const updatedExecution = {
    version: 1,
    work_order_commitment: workOrderCommitment,
    reference_mark_price_e8: referenceMarkPriceE8,
    requested_base_size: requestedBaseSize,
    requested_micro_usdc: requestedMicroUsdc,
    applied_filled_micro_usdc: Math.max(Number(existing?.applied_filled_micro_usdc || 0), appliedMicroUsdc),
    position_filled_base_size: positionFilledBaseSize,
    receipt: receipt === null ? existing?.receipt || null : accountingReceipt(receipt),
    recorded_at_ms: existing?.recorded_at_ms || nowMs,
    updated_at_ms: nowMs,
  };
  const nextExecutions = existing
    ? executions.map((item) => item.work_order_commitment === workOrderCommitment ? updatedExecution : item)
    : [...executions, updatedExecution];
  await state.putIdempotency(key, {
    version: 1,
    kind: "multi_leg_recovery_accounting",
    saga_id: saga.saga_id,
    leg_id: leg.leg_id,
    venue_id: leg.venue_id,
    action,
    executions: nextExecutions,
    updated_at_ms: nowMs,
  });
}

function accountingReceipt(receipt) {
  return {
    status: receipt?.status || null,
    provider_ref_commitment: receipt?.provider_ref_commitment || null,
    result_commitment: receipt?.result_commitment || null,
    fills: Array.isArray(receipt?.fills) ? structuredClone(receipt.fills) : [],
    final_proof: receipt?.final_proof ? structuredClone(receipt.final_proof) : null,
  };
}

function positiveNumber(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function proportionalMicroForExactBase({ requestedBase, filledBase, expectedMicro }) {
  if (!Number.isSafeInteger(expectedMicro) || expectedMicro <= 0) return 0;
  const requested = exactDecimalParts(requestedBase);
  const filled = exactDecimalParts(filledBase);
  if (!requested || requested.units <= 0n || !filled || filled.units <= 0n) return 0;
  const scale = Math.max(requested.scale, filled.scale);
  const requestedUnits = requested.units * (10n ** BigInt(scale - requested.scale));
  const filledUnits = filled.units * (10n ** BigInt(scale - filled.scale));
  if (filledUnits >= requestedUnits) return expectedMicro;
  if (expectedMicro === 1) return 0;
  const proportional = Number((BigInt(expectedMicro) * filledUnits) / requestedUnits);
  return Math.max(1, Math.min(expectedMicro - 1, proportional));
}

function proportionalExactBase({ base, numeratorMicro, denominatorMicro }) {
  const parsed = exactDecimalParts(base);
  if (!parsed || parsed.units <= 0n
    || !Number.isSafeInteger(numeratorMicro) || numeratorMicro <= 0
    || !Number.isSafeInteger(denominatorMicro) || denominatorMicro <= 0
    || numeratorMicro > denominatorMicro) return null;
  const targetScale = Math.min(
    MAX_EXACT_BASE_SCALE,
    MAX_EXACT_BASE_DIGITS - parsed.integerDigits,
    parsed.scale + String(denominatorMicro).length,
  );
  const scaleFactor = 10n ** BigInt(targetScale - parsed.scale);
  const numerator = parsed.units * BigInt(numeratorMicro) * scaleFactor;
  const denominator = BigInt(denominatorMicro);
  const units = (numerator + denominator - 1n) / denominator;
  return units > 0n ? exactDecimalString({ units, scale: targetScale }) : null;
}

function canonicalExactPositiveDecimal(value) {
  const parsed = exactDecimalParts(value);
  return parsed && parsed.units > 0n ? exactDecimalString(parsed) : null;
}

function canonicalExactSignedDecimal(value) {
  const parsed = exactSignedDecimalParts(value);
  return parsed ? exactSignedDecimalString(parsed) : null;
}

function negateExactDecimal(value) {
  const parsed = exactSignedDecimalParts(value);
  return parsed ? exactSignedDecimalString({ ...parsed, units: -parsed.units }) : null;
}

function sumExactSignedDecimals(...values) {
  const parsed = values.map(exactSignedDecimalParts);
  if (parsed.some((item) => !item)) return null;
  const scale = Math.max(...parsed.map((item) => item.scale));
  const units = parsed.reduce(
    (sum, item) => sum + item.units * (10n ** BigInt(scale - item.scale)),
    0n,
  );
  const result = exactSignedDecimalString({ units, scale });
  return exactSignedDecimalParts(result) ? result : null;
}

function requiredExactPositiveDecimal(value, code) {
  const canonical = canonicalExactPositiveDecimal(value);
  if (!canonical) throw new Error(code);
  return canonical;
}

function exactDecimalParts(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > MAX_EXACT_BASE_DIGITS + 1) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] || "";
  if (match[1].length + fraction.length > MAX_EXACT_BASE_DIGITS || fraction.length > MAX_EXACT_BASE_SCALE) return null;
  const integerDigits = match[1].replace(/^0+(?=\d)/, "").length;
  return { units: BigInt(`${match[1]}${fraction}`), scale: fraction.length, integerDigits };
}

function exactSignedDecimalParts(value) {
  const text = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!text || text.length > MAX_EXACT_BASE_DIGITS + 2) return null;
  const negative = text.startsWith("-");
  const unsigned = negative || text.startsWith("+") ? text.slice(1) : text;
  const parsed = exactDecimalParts(unsigned);
  if (!parsed) return null;
  return { ...parsed, units: negative ? -parsed.units : parsed.units };
}

function exactDecimalString({ units, scale }) {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function exactSignedDecimalString({ units, scale }) {
  const negative = units < 0n;
  const unsigned = exactDecimalString({ units: negative ? -units : units, scale });
  return negative && unsigned !== "0" ? `-${unsigned}` : unsigned;
}

function trim(value) {
  return Number(value).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function pauseParentSession(state, saga, nowMs) {
  const sessionId = saga.execution_context?.autopilot_session_id;
  if (!sessionId || typeof state.getAutopilotSession !== "function") return;
  const session = await state.getAutopilotSession(sessionId);
  if (!session || session.status === "killed" || session.status === "expired") return;
  await state.putAutopilotSession({
    ...session,
    status: "paused",
    execution_enabled: false,
    next_step: saga.status === "manual_intervention"
      ? "Protected multi-leg recovery requires owner review."
      : "Protected multi-leg cancellation, reconciliation, and unwind are required; risk increases remain paused.",
    updated_at: new Date(nowMs).toISOString(),
  });
}

async function recoverySessionForSaga(state, saga) {
  const context = saga.execution_context;
  if (!context) return null;
  if (context.autopilot_session_id) return state.getAutopilotSession?.(context.autopilot_session_id);
  if (!context.carry_position_id || !context.session_policy || !context.venue_access) return null;
  return {
    autopilot_session_id: null,
    status: "paused",
    execution_enabled: false,
    session_policy: context.session_policy,
    venue_access: context.venue_access,
  };
}

function deadlineDue(saga, nowMs) {
  return (
    (saga.status === "submitting" || saga.status === "partially_hedged" || saga.status === "compensating") &&
    Number.isSafeInteger(saga.unhedged_deadline_ms) &&
    nowMs >= saga.unhedged_deadline_ms
  );
}

function timeoutEventId(saga, sequence) {
  const hash = createHash("sha256")
    .update(`${saga.saga_id}\0${saga.unhedged_deadline_ms}\0${sequence}`)
    .digest("hex")
    .slice(0, 32);
  return `timeout:${hash}`;
}

function assertState(state) {
  if (
    !state ||
    typeof state.putMultiLegSaga !== "function" ||
    typeof state.getMultiLegSaga !== "function" ||
    typeof state.listMultiLegSagas !== "function"
  ) {
    throw new Error("durable_multi_leg_state_required");
  }
}

function errorCode(error) {
  if (typeof error?.code === "string") return error.code;
  return typeof error?.message === "string" && error.message.startsWith("saga_")
    ? error.message
    : "saga_invalid";
}

function requiredText(value, error) {
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 180) throw new Error(error);
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cloneObject(value, error) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return structuredClone(value);
}

function boundedMs(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
