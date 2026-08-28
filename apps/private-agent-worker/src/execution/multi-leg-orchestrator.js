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
    const remainingBase = evidence.filledBase > 0 && leg.filled_micro_usdc > 0
      ? evidence.filledBase * (remainingMicro / leg.filled_micro_usdc)
      : 0;
    if (!(remainingBase > 0)) {
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
      if (typeof verifyOrder === "function") {
        await verifyOrder(recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg,
          context,
          recipient,
          operationClass: unwindInstruction.operation_class,
          workOrderCommitment: `${workOrderCommitment}:preflight`,
          instruction: unwindInstruction,
        }));
      }
      await storeRecoveryAccounting({
        state,
        saga: current,
        leg,
        action: "unwind",
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
        receipt,
        nowMs,
      });
      const progressed = await applyRecoveryExecutionProgress({
        state,
        saga: current,
        leg,
        action: "unwind",
        execution: {
          work_order_commitment: workOrderCommitment,
          reference_mark_price_e8: Math.round(price * 100_000_000),
          requested_base_size: trim(remainingBase),
          requested_micro_usdc: remainingMicro,
          applied_filled_micro_usdc: 0,
          receipt: accountingReceipt(receipt),
        },
        env,
        nowMs,
      });
      if (!progressed.ok) return progressed;
      current = progressed.saga;
      if (progressed.progress.filledMicro > 0) {
        const refreshedLeg = current.legs.find((item) => item.leg_id === leg.leg_id);
        await putRecoveryPosition({
          state,
          session,
          saga: current,
          leg: refreshedLeg,
          filledBase: evidence.filledBase,
          nowMs,
        });
      }
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
    const requestedBase = positiveNumber(context.instruction?.order?.base_size);
    const remainingBase = requestedBase * (remainingMicro / leg.notional_micro_usdc);
    if (!(remainingBase > 0)) {
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
      if (typeof verifyOrder === "function") {
        await verifyOrder(recoveryOrderArgs({
          state,
          session,
          saga: current,
          leg,
          context,
          recipient,
          operationClass: instruction.operation_class,
          workOrderCommitment: `${workOrderCommitment}:preflight`,
          instruction,
        }));
      }
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
        execution: {
          work_order_commitment: workOrderCommitment,
          reference_mark_price_e8: Math.round(price * 100_000_000),
          requested_base_size: trim(remainingBase),
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
      const requestedBase = positiveNumber(storedExecution.requested_base_size);
      const requestedMicro = Number(storedExecution.requested_micro_usdc);
      if (!(requestedBase > 0) || !Number.isSafeInteger(requestedMicro) || requestedMicro <= 0) {
        return { ok: false, error: "recovery_accounting_quantity_unavailable", saga: current };
      }
      let execution = storedExecution;
      let progress = unwindProgress({
        receipt: execution.receipt,
        requestedBase,
        remainingMicro: requestedMicro,
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
        progress = unwindProgress({ receipt: reconcileReceipt, requestedBase, remainingMicro: requestedMicro, env });
      }
      const progressed = await applyRecoveryExecutionProgress({
        state,
        saga: current,
        leg: current.legs.find((item) => item.leg_id === leg.leg_id),
        action,
        execution,
        env,
        nowMs,
      });
      if (!progressed.ok) return progressed;
      current = progressed.saga;
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

async function applyRecoveryExecutionProgress({ state, saga, leg, action, execution, env, nowMs }) {
  const requestedBase = positiveNumber(execution.requested_base_size);
  const requestedMicro = Number(execution.requested_micro_usdc);
  const appliedMicro = Number(execution.applied_filled_micro_usdc || 0);
  if (!(requestedBase > 0) || !Number.isSafeInteger(requestedMicro) || requestedMicro <= 0 || !Number.isSafeInteger(appliedMicro)) {
    return { ok: false, error: "recovery_accounting_quantity_unavailable", saga };
  }
  const progress = unwindProgress({
    receipt: execution.receipt,
    requestedBase,
    remainingMicro: requestedMicro,
    env,
  });
  if (progress.filledMicro < appliedMicro) {
    return { ok: false, error: "recovery_fill_evidence_regressed", saga };
  }
  let current = await state.getMultiLegSaga(saga.saga_id) || saga;
  const delta = progress.filledMicro - appliedMicro;
  if (delta > 0) {
    const currentLeg = current.legs.find((item) => item.leg_id === leg.leg_id);
    const cumulative = action === "unwind"
      ? Math.min(currentLeg.filled_micro_usdc, currentLeg.unwind_filled_micro_usdc + delta)
      : Math.min(currentLeg.notional_micro_usdc, currentLeg.filled_micro_usdc + delta);
    const result = await applyDurableMultiLegEvent({
      state,
      saga_id: current.saga_id,
      now_ms: Math.max(nowMs, current.updated_at_ms),
      event: {
        version: 1,
        event_id: `recovery:${hash(`${current.saga_id}:${leg.leg_id}:${action}:${execution.work_order_commitment}:${progress.filledMicro}`).slice(0, 40)}`,
        sequence: current.last_event_sequence + 1,
        type: action === "unwind" ? "unwind_fill" : "completion_fill",
        leg_id: leg.leg_id,
        cumulative_filled_micro_usdc: cumulative,
      },
    });
    if (!result.ok) return { ok: false, error: result.error || "saga_recovery_event_failed", saga: result.saga || current };
    current = result.saga;
    await storeRecoveryAccounting({
      state,
      saga: current,
      leg,
      action,
      workOrderCommitment: execution.work_order_commitment,
      referenceMarkPrice: execution.reference_mark_price_e8 / 100_000_000,
      requestedBase,
      requestedMicro,
      appliedFilledMicro: progress.filledMicro,
      receipt: execution.receipt,
      nowMs,
    });
  }
  return { ok: true, saga: current, progress };
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
  const cached = await state.getIdempotency?.(context.work_order_commitment);
  const attempt = await state.getExecutionAttempt?.(context.work_order_commitment);
  const records = [cached?.receipt, attempt, ...extraReceipts].filter(Boolean);
  let filledMicro = leg.filled_micro_usdc;
  let filledBase = 0;
  let terminal = false;
  for (const record of records) {
    const proof = record.final_proof;
    const proofMicro = Number(proof?.cumulative_filled_micro_usdc);
    const fillTotals = fillTotalsForRecord(record);
    const candidateMicro = Number.isSafeInteger(proofMicro) ? proofMicro : fillTotals.micro;
    const candidateBase = positiveNumber(proof?.filled_base_size) || fillTotals.base;
    if (candidateMicro >= filledMicro) {
      filledMicro = Math.min(leg.notional_micro_usdc, candidateMicro);
      if (candidateBase > 0) filledBase = candidateBase;
    }
    terminal ||= proof?.final_venue_execution_proven === true;
  }
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && filledMicro > 0 && !(filledBase > 0)) {
    const requestedBase = positiveNumber(context.instruction?.order?.base_size);
    if (requestedBase > 0) filledBase = requestedBase * (filledMicro / leg.notional_micro_usdc);
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

function unwindProgress({ receipt, requestedBase, remainingMicro, env }) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return { terminal: Boolean(receipt), filledMicro: receipt ? remainingMicro : 0 };
  }
  const proof = receipt?.final_proof;
  const filledBase = positiveNumber(proof?.filled_base_size) || fillTotalsForRecord(receipt).base;
  const ratio = requestedBase > 0 ? Math.max(0, Math.min(1, filledBase / requestedBase)) : 0;
  return {
    terminal: proof?.final_venue_execution_proven === true,
    filledMicro: Math.round(remainingMicro * ratio),
  };
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
      base_size: trim(remainingBase),
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
      base_size: trim(remainingBase),
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

function executionForRecovery(session, venue) {
  const access = session.venue_access?.[venue] || {};
  return {
    execution_mode: access.execution_mode || "byo_api_key",
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
  const remainingBase = leg.filled_micro_usdc > 0 ? filledBase * (remainingMicro / leg.filled_micro_usdc) : 0;
  const positions = await state.listAutopilotPositions(session.autopilot_session_id);
  const prior = positions.find((position) =>
    position.venue_id === leg.venue_id && String(position.market).toUpperCase() === String(leg.market).toUpperCase()
  );
  const priorComponentNotional = prior?.recovery_saga_id === saga.saga_id
    ? Number(prior.recovery_component_signed_notional_micro_usdc || 0)
    : 0;
  const priorComponentBase = prior?.recovery_saga_id === saga.saga_id
    ? Number(prior.recovery_component_signed_base_size || 0)
    : 0;
  const direction = leg.side === "sell" ? -1 : 1;
  const componentNotional = direction * remainingMicro;
  const componentBase = direction * remainingBase;
  const signedNotional = Number(prior?.signed_notional_micro_usdc || 0) - priorComponentNotional + componentNotional;
  const signedBase = Number(prior?.signed_base_size || 0) - priorComponentBase + componentBase;
  await state.putAutopilotPosition(session.autopilot_session_id, {
    ...prior,
    venue_id: leg.venue_id,
    asset: leg.asset,
    market: leg.market,
    product_type: leg.product_type,
    side: signedNotional < 0 ? "sell" : "buy",
    signed_notional_micro_usdc: signedNotional,
    signed_base_size: Math.abs(signedBase) < 1e-12 ? 0 : signedBase,
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
  if (!(positiveNumber(requestedBase) > 0) || !Number.isSafeInteger(requestedMicroUsdc) || requestedMicroUsdc <= 0) return;
  if (!Number.isSafeInteger(appliedMicroUsdc) || appliedMicroUsdc < 0 || appliedMicroUsdc > requestedMicroUsdc) return;
  const existing = executions.find((item) => item.work_order_commitment === workOrderCommitment);
  const updatedExecution = {
    version: 1,
    work_order_commitment: workOrderCommitment,
    reference_mark_price_e8: referenceMarkPriceE8,
    requested_base_size: trim(requestedBase),
    requested_micro_usdc: requestedMicroUsdc,
    applied_filled_micro_usdc: Math.max(Number(existing?.applied_filled_micro_usdc || 0), appliedMicroUsdc),
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
