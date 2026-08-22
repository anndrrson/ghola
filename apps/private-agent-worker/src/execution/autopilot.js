import { createHash, randomUUID } from "node:crypto";
import {
  isArbitrageSession,
  isCarrySession,
  runGuardedArbitrageTick,
} from "./arbitrage.js";
import { decideAiDirectOrder, publicDecisionRecord } from "./ai-direct-order.js";
import { routeModelProposal } from "./autopilot-router.js";
import { executeAutopilotOrder, verifyAutopilotOrder } from "./private-execution.js";
import { jupiterPlatformFeeQuote } from "../venues/jupiter.js";
import {
  agentControllerId,
  executorRecord,
  replayBundle,
  tickSnapshot,
} from "./replay.js";
import { revenueEvidenceEvent } from "./revenue-evidence.js";
import {
  evaluateAutopilotPortfolioProposal,
  portfolioMandateForSession,
  reconcileSessionPortfolio,
} from "./portfolio-risk.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SUPPORTED_VENUES = new Set(["jupiter", "phoenix", "backpack", "hyperliquid", "drift", "coinbase_advanced"]);
const SUPPORTED_MARKETS = new Set(["SOL-USD", "BTC-USD", "ETH-USD", "SOL/USDC", "SOL", "BTC", "ETH", "HYPE"]);
const BOUNDED_INTENT_STRATEGY = "bounded_intent_executor_v1";
const DEFAULT_VENUES = ["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"];
const DEFAULT_MARKETS = ["SOL-USD", "BTC-USD", "ETH-USD"];
const LOOP_TIMERS = new Map();

export async function createAutopilotSession({ body, recipient, state, provider, startLoop = true, now = new Date() }) {
  const policy = normalizeAutopilotPolicy(body?.session_policy || body || {}, now);
  const venueAccess = normalizeVenueAccess(body?.venue_access || body?.venue_vaults || {}, policy);
  const readyVenues = policy.venue_allowlist.filter((venue) => venueAccess[venue]?.status === "ready");
  const activationReady = policy.execution_network !== "mainnet" || (
    Boolean(policy.mainnet_activation_id) && Boolean(policy.owner_authorization_commitment)
  );
  const status = policy.kill_switch
    ? "killed"
    : !activationReady ? "pending_activation"
      : readyVenues.length > 0 ? "running" : "pending_funding";
  const id = `autopilot_${digest({
    owner_commitment: stringValue(body?.owner_commitment) || "owner_redacted",
    policy,
    recipient: recipient.recipient_id,
    nonce: randomUUID(),
  })}`;
  const session = {
    version: 2,
    autopilot_session_id: id,
    agent_controller_id: `agentctl_${digest({
      owner_commitment: stringValue(body?.owner_commitment) || "owner_redacted",
      policy_commitment: policy.policy_commitment,
      recipient: recipient.recipient_id,
    }).slice(0, 32)}`,
    worker_session_commitment: `worker_autopilot_${digest({ id, recipient: recipient.recipient_id })}`,
    owner_commitment: stringValue(body?.owner_commitment) || "owner_redacted",
    provider,
    status,
    strategy: strategyForPolicy(policy),
    session_policy: policy,
    portfolio_mandate: null,
    portfolio_accounting: null,
    billing_metering: normalizeBillingMetering(body?.billing_metering),
    venue_access: venueAccess,
    order_count: 0,
    tick_count: 0,
    daily_notional_used_bucket: "0",
    last_tick_at: null,
    last_execution_at: null,
    pending_execution: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: policy.expires_at,
    next_step: status === "running"
      ? "Bounded intent executor is running. Trades require fresh market data, policy caps, and submit-time guardrails."
      : status === "pending_activation"
        ? "Owner authorization and explicit mainnet activation are required."
      : status === "pending_funding"
        ? "Fund an isolated venue vault or connect a trade-only venue vault before live execution."
        : "Kill switch is active.",
    execution_enabled: status === "running",
    control_plane: "worker",
    visibility_summary: {
      main_wallet_prompts_per_trade: false,
      execution_boundary: "bounded_delegated_worker_policy",
      user_can_kill_anytime: true,
    },
  };
  session.portfolio_mandate = portfolioMandateForSession({
    session_id: id,
    owner_commitment: session.owner_commitment,
    policy,
    now,
  });
  await state.putAutopilotSession(session);
  await appendEvent(state, session, "session_created", "Autonomous trading session created.", {
    strategy: session.strategy,
    policy,
  }, now);
  await appendEvent(state, session, "venue_readiness", readyVenues.length
    ? "At least one venue is ready for autonomous execution."
    : "No isolated execution vault is funded yet.", {
      venues: policy.venue_allowlist.map((venue) => ({
        venue_id: venue,
        status: venueAccess[venue]?.status || "needs_funds",
        reason: venueAccess[venue]?.reason || null,
      })),
    }, now);
  await appendEvent(state, session, "guardrail", "Moderate retail guardrails are active.", {
    ai_direct_enabled: policy.ai_direct_enabled,
    decision_model: policy.decision_model,
    max_notional_bucket: policy.max_notional_bucket,
    max_position_notional_bucket: policy.max_position_notional_bucket,
    max_daily_notional_bucket: policy.max_daily_notional_bucket,
    max_order_count: policy.max_order_count,
    cooldown_ms: policy.cooldown_ms,
    data_max_age_ms: policy.data_max_age_ms,
    execution_network: policy.execution_network,
    portfolio_mandate_id: session.portfolio_mandate.mandate_id,
  }, now);
  if (status === "pending_funding") {
    await appendEvent(state, session, "funding_required", "Isolated venue funding is required before autonomous live trading.", {
      funding_model: "isolated_user_vault",
      ready_venues: readyVenues,
    }, now);
  }
  if (startLoop && status === "running") startAutopilotLoop({ sessionId: id, state, recipient });
  return publicSession(session);
}

export async function controlAutopilotSession({ sessionId, action, state, recipient = null, now = new Date() }) {
  const session = await state.getAutopilotSession(sessionId);
  if (!session) return null;
  const refreshed = refreshSession(session, now);
  if (action === "kill") {
    refreshed.status = "killed";
    refreshed.execution_enabled = false;
    refreshed.session_policy = {
      ...refreshed.session_policy,
      kill_switch: true,
    };
    if (refreshed.pending_execution) {
      refreshed.pending_execution = {
        ...refreshed.pending_execution,
        status: "cancelled_by_kill",
        updated_at: now.toISOString(),
      };
    }
    refreshed.next_step = "Kill switch active. No autonomous execution is allowed.";
    stopAutopilotLoop(sessionId);
  } else if (refreshed.status === "expired") {
    refreshed.execution_enabled = false;
    refreshed.next_step = "Session expired. Create a new autonomous session.";
    stopAutopilotLoop(sessionId);
  } else if (action === "pause") {
    refreshed.status = "paused";
    refreshed.execution_enabled = false;
    if (refreshed.pending_execution) {
      refreshed.pending_execution = {
        ...refreshed.pending_execution,
        status: "paused",
        updated_at: now.toISOString(),
      };
    }
    refreshed.next_step = "Autopilot paused.";
    stopAutopilotLoop(sessionId);
  } else if (action === "resume") {
    if (refreshed.status === "killed" || refreshed.session_policy?.kill_switch === true) {
      refreshed.status = "killed";
      refreshed.execution_enabled = false;
      refreshed.next_step = "Kill switch active. Create a new autonomous session to trade again.";
      stopAutopilotLoop(sessionId);
    } else {
      const ready = readyVenues(refreshed);
      const activationReady = refreshed.session_policy.execution_network !== "mainnet" || (
        Boolean(refreshed.session_policy.mainnet_activation_id) &&
        Boolean(refreshed.session_policy.owner_authorization_commitment)
      );
      refreshed.status = !activationReady ? "pending_activation" : ready.length ? "running" : "pending_funding";
      refreshed.execution_enabled = activationReady && ready.length > 0;
      refreshed.next_step = !activationReady
        ? "Owner authorization and explicit mainnet activation are required."
        : ready.length
          ? "Bounded intent executor is running."
          : "Fund an isolated venue vault before live execution.";
      if (recipient && activationReady && ready.length) startAutopilotLoop({ sessionId, state, recipient });
    }
  }
  refreshed.updated_at = now.toISOString();
  await state.putAutopilotSession(refreshed);
  const event = await appendEvent(state, refreshed, "session_state", `Autopilot ${action}.`, { action }, now);
  if (action === "pause" || action === "kill") {
    await meterAutopilotCompute({
      session: refreshed,
      status: action === "kill" ? "completed" : "paused",
      now,
      env: process.env,
      fetchImpl: fetch,
    }).catch(() => null);
  }
  return { session: publicSession(refreshed), event };
}

export async function listAutopilotEvents({ sessionId, state, now = new Date() }) {
  const session = await state.getAutopilotSession(sessionId);
  if (!session) return null;
  const refreshed = refreshSession(session, now);
  if (refreshed.status !== session.status) await state.putAutopilotSession(refreshed);
  return {
    session: publicSession(refreshed),
    events: await state.listAutopilotEvents(sessionId),
  };
}

export async function listAutopilotReplay({ sessionId, state, now = new Date() }) {
  const session = await state.getAutopilotSession(sessionId);
  if (!session) return null;
  const refreshed = refreshSession(session, now);
  if (refreshed.status !== session.status) await state.putAutopilotSession(refreshed);
  const [events, executors, tickSnapshots, positions] = await Promise.all([
    state.listAutopilotEvents(sessionId),
    state.listExecutorRecords?.(sessionId) || [],
    state.listTickSnapshots?.(sessionId) || [],
    state.listAutopilotPositions(sessionId),
  ]);
  return replayBundle({
    session: publicSession(refreshed),
    events,
    executors,
    tick_snapshots: tickSnapshots,
    positions: positions.map(publicPosition),
    now,
  });
}

export async function updateAutopilotAccounting({
  sessionId,
  state,
  expected_snapshots,
  observed_snapshots,
  now = new Date(),
}) {
  const session = await state.getAutopilotSession(sessionId);
  if (!session) return { ok: false, error: "autopilot_session_not_found" };
  try {
    const portfolioAccounting = reconcileSessionPortfolio({
      session,
      expected_snapshots,
      observed_snapshots,
      now,
    });
    const next = {
      ...session,
      portfolio_accounting: portfolioAccounting,
      updated_at: now.toISOString(),
    };
    if (portfolioAccounting.status !== "reconciled" && next.status === "running") {
      next.status = "paused";
      next.execution_enabled = false;
      next.next_step = "Portfolio reconciliation is required; only cancel and reduce-only recovery remain permitted.";
    }
    await state.putAutopilotSession(next);
    await appendEvent(state, next, "portfolio_reconciliation", portfolioAccounting.status === "reconciled"
      ? "Portfolio accounting reconciled across configured venues."
      : "Portfolio accounting mismatch froze risk increases.", {
        status: portfolioAccounting.status,
        stale_venues: portfolioAccounting.aggregate.stale_venues,
        mismatches: portfolioAccounting.reconciliation.mismatches,
      }, now);
    return { ok: true, session: publicSession(next), portfolio_accounting: portfolioAccounting };
  } catch (error) {
    return {
      ok: false,
      error: typeof error?.code === "string" ? error.code : "portfolio_accounting_invalid",
    };
  }
}

export function startAutopilotLoop({ sessionId, state, recipient }) {
  stopAutopilotLoop(sessionId);
  const initialDelay = integerEnv("PRIVATE_AGENT_AUTOPILOT_INITIAL_DELAY_MS", 1_000);
  const timer = setTimeout(async function tick() {
    await runAutopilotTick({ sessionId, state, recipient }).catch((error) => {
      state.getAutopilotSession(sessionId).then((session) => {
        if (session) return appendEvent(state, session, "guardrail", "Autopilot tick failed closed.", {
          error: String(error?.message || "tick_failed"),
        });
        return null;
      }).catch(() => null);
    });
    const session = await state.getAutopilotSession(sessionId);
    if (session?.status === "running") {
      const next = setTimeout(tick, integerEnv("PRIVATE_AGENT_AUTOPILOT_TICK_MS", 30_000));
      next.unref?.();
      LOOP_TIMERS.set(sessionId, next);
    } else {
      LOOP_TIMERS.delete(sessionId);
    }
  }, initialDelay);
  timer.unref?.();
  LOOP_TIMERS.set(sessionId, timer);
}

export function stopAutopilotLoop(sessionId) {
  const timer = LOOP_TIMERS.get(sessionId);
  if (timer) clearTimeout(timer);
  LOOP_TIMERS.delete(sessionId);
}

export async function runDueAutopilotSessions({
  state,
  recipient,
  now = new Date(),
  fetchImpl = fetch,
  env = process.env,
  maxSessions = 25,
} = {}) {
  const sessions = typeof state?.listAutopilotSessions === "function"
    ? await state.listAutopilotSessions()
    : [];
  const limit = Math.max(1, Math.min(
    Number.parseInt(String(maxSessions ?? ""), 10) || 25,
    100,
  ));
  const due = sessions
    .map((session) => refreshSession(session, now))
    .filter((session) => isSessionDueForTick(session, now, env))
    .slice(0, limit);
  const results = [];
  for (const session of due) {
    const result = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now,
      fetchImpl,
      env,
    });
    results.push({
      autopilot_session_id: session.autopilot_session_id,
      ok: result.ok === true,
      status: result.status || null,
      error: result.error || null,
      tick_id: result.tick_id || null,
      receipt_commitment: result.receipt?.result_commitment || null,
    });
  }
  return {
    version: 1,
    checked_count: sessions.length,
    due_count: due.length,
    ran_count: results.length,
    results,
    updated_at: now.toISOString(),
  };
}

export function startAutopilotDueLoop({
  state,
  recipient,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (String(env.PRIVATE_AGENT_AUTOPILOT_SWEEP_ENABLED ?? "true").toLowerCase() === "false") {
    return { stop() {} };
  }
  const intervalMs = integerEnvFrom(env, "PRIVATE_AGENT_AUTOPILOT_SWEEP_MS", 30_000);
  const initialDelayMs = integerEnvFrom(env, "PRIVATE_AGENT_AUTOPILOT_SWEEP_INITIAL_DELAY_MS", 2_500);
  let timer = null;
  let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runDueAutopilotSessions({ state, recipient, env, fetchImpl }).catch(() => null);
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  schedule(initialDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function runAutopilotTick({
  sessionId,
  state,
  recipient,
  now = new Date(),
  fetchImpl = fetch,
  env = process.env,
  claimLease = true,
  leaseId = null,
}) {
  const stored = await state.getAutopilotSession(sessionId);
  if (!stored) return { ok: false, error: "autopilot_session_not_found" };
  let lease = null;
  const tickLeaseId = leaseId || `ticklease_${digest({
    session: sessionId,
    now: now.toISOString(),
    nonce: randomUUID(),
  }).slice(0, 32)}`;
  if (claimLease && state.claimAutopilotTickLease) {
    lease = await state.claimAutopilotTickLease(sessionId, {
      lease_id: tickLeaseId,
      lease_ms: integerEnvFrom(env, "PRIVATE_AGENT_AUTOPILOT_TICK_LEASE_MS", 120_000),
      now,
    });
    if (!lease.ok) {
      return {
        ok: false,
        error: lease.error || "tick_lease_active",
        lease_id: lease.lease_id || null,
        lease_until: lease.lease_until || null,
      };
    }
  }
  try {
    return await runAutopilotTickUnlocked({
      sessionId,
      state,
      recipient,
      now,
      fetchImpl,
      env,
      initialSession: lease?.session || stored,
    });
  } finally {
    if (lease?.ok && state.releaseAutopilotTickLease) {
      await state.releaseAutopilotTickLease(sessionId, lease.lease_id, { now }).catch(() => null);
    }
  }
}

async function runAutopilotTickUnlocked({
  sessionId,
  state,
  recipient,
  now,
  fetchImpl,
  env,
  initialSession = null,
}) {
  const stored = initialSession || await state.getAutopilotSession(sessionId);
  if (!stored) return { ok: false, error: "autopilot_session_not_found" };
  const session = refreshSession(stored, now);
  const tickId = tickIdForSession(session);
  const executionSlot = nextExecutionSlot(session);
  if (session.status !== "running" || !session.execution_enabled) {
    await state.putAutopilotSession(session);
    await putTick(state, session, {
      tick_id: tickId,
      status: "rejected",
      risk_result: { ok: false, reason: "autopilot_not_running" },
      now,
    });
    return { ok: false, error: "autopilot_not_running" };
  }
  const metered = await meterAutopilotCompute({
    session,
    status: "active",
    now,
    env,
    fetchImpl,
  });
  if (!metered.ok) {
    session.status = "paused";
    session.execution_enabled = false;
    session.next_step = "Autopilot paused because private-agent compute allowance is unavailable.";
    session.updated_at = now.toISOString();
    await state.putAutopilotSession(session);
    await appendEvent(state, session, "guardrail", "Compute metering rejected this agent tick.", {
      error: metered.error,
    }, now);
    await putTick(state, session, {
      tick_id: tickId,
      status: "rejected",
      risk_result: { ok: false, reason: metered.error || "compute_metering_rejected" },
      now,
    });
    return { ok: false, error: metered.error || "compute_metering_rejected" };
  }
  const carryExitDue = isCarrySession(session) && (await state.listAutopilotPositions(sessionId)).some((position) =>
    position.strategy_id === "delta_neutral_carry_v1" &&
    Math.abs(Number(position.signed_notional_micro_usdc || 0)) > 0 &&
    (!Number.isFinite(Date.parse(position.exit_due_at || "")) || Date.parse(position.exit_due_at) <= now.getTime())
  );
  if (session.last_execution_at && !carryExitDue) {
    const elapsed = now.getTime() - new Date(session.last_execution_at).getTime();
    if (elapsed < session.session_policy.cooldown_ms) {
      session.last_tick_at = now.toISOString();
      await state.putAutopilotSession(session);
      await appendEvent(state, session, "guardrail", "Cooldown active; no trade attempted.", {
        cooldown_ms: session.session_policy.cooldown_ms,
        elapsed_ms: elapsed,
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        risk_result: { ok: false, reason: "cooldown_active", elapsed_ms: elapsed },
        now,
      });
      return { ok: false, error: "cooldown_active" };
    }
  }

  if (isArbitrageSession(session)) {
    session.last_tick_at = now.toISOString();
    await state.putAutopilotSession(session);
    return runGuardedArbitrageTick({
      session,
      state,
      recipient,
      now,
      env,
      fetchImpl,
      appendEvent,
      executeOrder: executeAutopilotOrder,
      verifyOrder: verifyAutopilotOrder,
    });
  }

  if (isPrivateLiquiditySession(session)) {
    return runPrivateLiquidityTick({
      session,
      state,
      now,
      fetchImpl,
      env,
      tickId,
    });
  }

  const market = await marketSnapshotForSession(session, { fetchImpl, env, now });
  session.last_tick_at = now.toISOString();
  await state.putAutopilotSession(session);
  await appendEvent(state, session, "agent_tick", "Autopilot evaluated market data.", {
    product_id: market.product_id,
    live_status: market.live_status,
    price: market.price,
    change_24h: market.change_24h,
    spread_bps: market.spread_bps,
  }, now);

  const positions = await state.listAutopilotPositions(sessionId);
  await appendEvent(state, session, "position_update", "Native position state loaded for policy evaluation.", {
    positions: positions.map(publicPosition),
  }, now);
  await putTick(state, session, {
    tick_id: tickId,
    status: "evaluating",
    market,
    positions,
    now,
  });

  let proposal;
  if (session.session_policy.ai_direct_enabled) {
    const actionability = buildMomentumProposal(session, market, { env, now });
    if (!actionability.ok) {
      return recordNonActionableTick({
        state,
        session,
        tickId,
        market,
        positions,
        reason: actionability.error,
        message: actionability.message,
        data: actionability.data,
        now,
        env,
      });
    }
    session.non_actionable_tick_count = 0;
    await state.putAutopilotSession(session);
    if (!aiDirectRuntimeEnabled(env)) {
      await appendEvent(state, session, "risk_reject", "Model proposals are disabled in worker configuration.", {
        required_env: "PRIVATE_AGENT_AI_DIRECT_ENABLED=true",
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        market,
        positions,
        risk_result: { ok: false, reason: "ai_direct_disabled" },
        now,
      });
      return { ok: false, error: "ai_direct_disabled" };
    }
    const budget = await reserveAiDecisionBudget({ state, session, env, now });
    if (!budget.ok) {
      await appendEvent(state, session, "risk_reject", "AI decision budget is exhausted for this hour.", {
        max_decisions_per_hour: budget.max,
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        market,
        positions,
        risk_result: { ok: false, reason: "ai_decision_budget_exhausted" },
        now,
      });
      return { ok: false, error: "ai_decision_budget_exhausted" };
    }
    const decision = await decideAiDirectOrder({
      session,
      market,
      positions,
      env,
      now,
      minConfidenceBps: session.session_policy.ai_min_confidence_bps,
    });
    await state.appendAutopilotDecision(sessionId, decision.record);
    await appendEvent(state, session, "ai_decision", decision.ok
      ? "Typed model proposal accepted by schema and confidence checks."
      : "Typed model proposal rejected before deterministic routing.", publicDecisionRecord(decision.record), now);
    if (!decision.ok) {
      await appendEvent(state, session, "risk_reject", "Model proposal was rejected before deterministic routing.", {
        error: decision.error,
        decision_id: decision.record.decision_id,
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        market,
        positions,
        decision: decision.record,
        risk_result: { ok: false, reason: decision.error },
        now,
      });
      return { ok: false, error: decision.error };
    }
    const built = buildAiDirectProposal(session, market, decision.decision, {
      env,
      now,
      positions,
      signalBps: Math.abs(Number(actionability.signal_bps || 0)),
    });
    if (!built.ok) {
      await appendEvent(state, session, "risk_reject", built.message, {
        ...built.data,
        decision_id: decision.record.decision_id,
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        market,
        positions,
        decision: decision.record,
        risk_result: { ok: false, reason: built.error },
        now,
      });
      return { ok: false, error: built.error };
    }
    proposal = { ...built, decision_id: decision.record.decision_id };
    await appendEvent(state, session, "proposal", "Typed model output was routed into a bounded deterministic proposal.", publicProposal(proposal), now);
    await appendEvent(state, session, "ai_score", "Model proposal met the session confidence threshold.", {
      score_bps: decision.decision.confidence_bps,
      threshold_bps: session.session_policy.ai_min_confidence_bps,
      model: decision.record.model_id,
      decision_id: decision.record.decision_id,
    }, now);
  } else {
    proposal = buildMomentumProposal(session, market, { env, now });
    if (!proposal.ok) {
      return recordNonActionableTick({
        state,
        session,
        tickId,
        market,
        positions,
        reason: proposal.error,
        message: proposal.message,
        data: proposal.data,
        now,
        env,
      });
    }
    session.non_actionable_tick_count = 0;
    await state.putAutopilotSession(session);
    await appendEvent(state, session, "proposal", "Bounded intent executor proposed a capped order.", publicProposal(proposal), now);

    const score = scoreProposal(proposal, { env });
    await appendEvent(state, session, "ai_score", score.message, {
      score_bps: score.score_bps,
      threshold_bps: session.session_policy.min_ai_score_bps,
      model: "rules_plus_ai_score_v1",
    }, now);
    if (!score.ok) {
      await appendEvent(state, session, "guardrail", "AI score below execution threshold.", {
        score_bps: score.score_bps,
        threshold_bps: session.session_policy.min_ai_score_bps,
      }, now);
      await putTick(state, session, {
        tick_id: tickId,
        status: "rejected",
        market,
        positions,
        proposal,
        risk_result: { ok: false, reason: "ai_score_below_threshold" },
        now,
      });
      return { ok: false, error: "ai_score_below_threshold" };
    }
  }
  const recentDecisions = state.listAutopilotDecisions
    ? (await state.listAutopilotDecisions(sessionId)).filter((decision) => {
        const createdAt = Date.parse(String(decision.created_at || ""));
        return Number.isFinite(createdAt) && createdAt >= now.getTime() - 60 * 60_000;
      }).length
    : 0;
  const portfolioRisk = evaluateAutopilotPortfolioProposal({
    session,
    positions,
    proposal,
    market,
    model_decisions_last_hour: recentDecisions,
    now,
    env,
  });
  if (!portfolioRisk.allowed) {
    await appendEvent(state, session, "risk_reject", "Portfolio-wide mandate rejected the proposed order.", {
      reasons: portfolioRisk.reasons,
      action_class: portfolioRisk.action_class,
    }, now);
    await putTick(state, session, {
      tick_id: tickId,
      status: "rejected",
      market,
      positions,
      proposal,
      risk_result: portfolioRisk,
      now,
    });
    return { ok: false, error: portfolioRisk.reasons[0] || "portfolio_risk_rejected" };
  }
  if (env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await appendEvent(state, session, "guardrail", "Live submit gate is disabled.", {
      required_env: "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=true",
    }, now);
    await putTick(state, session, {
      tick_id: tickId,
      status: "rejected",
      market,
      positions,
      proposal,
      risk_result: { ok: false, reason: "live_submit_disabled" },
      now,
    });
    return { ok: false, error: "live_submit_disabled" };
  }

  const pending = await ensurePendingExecution(state, session, {
    executionSlot,
    proposal,
    tickId,
    now,
  });
  proposal = pending.proposal;
  const workOrderCommitment = pending.work_order_commitment;
  const executionTickId = pending.tick_id;
  let revenueQuote = null;
  try {
    revenueQuote = autopilotRevenueQuote(proposal, { env });
  } catch (error) {
    await appendEvent(state, session, "guardrail", "Autopilot revenue configuration rejected execution before venue submission.", {
      error: String(error?.message || "autopilot_revenue_config_invalid"),
      work_order_commitment: workOrderCommitment,
    }, now);
    await putTick(state, session, {
      tick_id: executionTickId,
      status: "rejected",
      market,
      positions,
      proposal,
      risk_result: { ok: false, reason: "autopilot_revenue_config_invalid" },
      now,
    });
    return { ok: false, error: "autopilot_revenue_config_invalid", work_order_commitment: workOrderCommitment };
  }
  const submitGate = await currentSubmitGate(state, sessionId, now);
  if (!submitGate.ok) {
    if (submitGate.session) {
      await state.putAutopilotSession({
        ...submitGate.session,
        pending_execution: submitGate.session.pending_execution
          ? {
              ...submitGate.session.pending_execution,
              status: submitGate.reason,
              updated_at: now.toISOString(),
            }
          : submitGate.session.pending_execution,
        updated_at: now.toISOString(),
      });
    }
    await appendEvent(state, submitGate.session || session, "guardrail", "Autopilot submit gate closed before venue submission.", {
      reason: submitGate.reason,
      work_order_commitment: workOrderCommitment,
    }, now);
    await putTick(state, submitGate.session || session, {
      tick_id: executionTickId,
      status: "rejected",
      market,
      positions,
      proposal,
      risk_result: { ok: false, reason: submitGate.reason },
      now,
    });
    return { ok: false, error: submitGate.reason, work_order_commitment: workOrderCommitment };
  }
  const createdExecutor = await putExecutor(state, session, executorRecord({
    session,
    kind: "order",
    tick_id: executionTickId,
    status: "created",
    proposal,
    work_order_commitment: workOrderCommitment,
    now,
    extra: {
      fee_quote_bucket: revenueQuote?.fee_bucket || "0",
      metadata: {
        execution_slot: executionSlot,
        ...revenueMetadata(revenueQuote, env),
      },
    },
  }));
  await appendEvent(state, session, "executor_created", "Durable executor created for bounded order.", {
    executor_id: createdExecutor.executor_id,
    agent_controller_id: createdExecutor.agent_controller_id,
    kind: createdExecutor.kind,
    venue_id: createdExecutor.venue_id,
    notional_bucket: createdExecutor.notional_bucket,
    work_order_commitment: workOrderCommitment,
    execution_slot: executionSlot,
    revenue_quote: publicRevenueQuote(revenueQuote, env),
  }, now);
  const receipt = await executeAutopilotOrder({
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    work_order_commitment: workOrderCommitment,
    policy_commitment: session.session_policy.policy_commitment,
    session_policy: workerSessionPolicy(session),
    instruction: proposal.instruction,
    execution: executionForVenue(session, proposal.venue_id),
    recipient,
    state,
  });
  const submittedExecutor = await putExecutor(state, session, executorRecord({
    session,
    kind: "order",
    tick_id: executionTickId,
    status: "submitted",
    proposal,
    work_order_commitment: workOrderCommitment,
    receipt,
    now,
    extra: {
      executor_id: createdExecutor.executor_id,
      created_at: createdExecutor.created_at,
      fee_quote_bucket: revenueQuote?.fee_bucket || "0",
      metadata: revenueMetadata(revenueQuote, env),
    },
  }));
  const revenueEvidence = state.appendRevenueEvidence
    ? await state.appendRevenueEvidence(revenueEvidenceEvent({
        session,
        proposal,
        receipt,
        revenueQuote,
        executorId: submittedExecutor.executor_id,
        tickId: executionTickId,
        workOrderCommitment,
        now,
      }))
    : null;
  const updated = await state.getAutopilotSession(sessionId) || session;
  updated.order_count = Number(updated.order_count || 0) + 1;
  updated.tick_count = Number(updated.tick_count || 0) + 1;
  updated.last_execution_at = now.toISOString();
  updated.daily_notional_used_bucket = String(
    Math.min(bucketToUsd(updated.session_policy.max_daily_notional_bucket), (
      Number(updated.daily_notional_used_bucket || 0) + proposal.notional_usd
    )),
  );
  updated.pending_execution = null;
  updated.last_completed_execution = {
    version: 1,
    execution_slot: executionSlot,
    tick_id: executionTickId,
    work_order_commitment: workOrderCommitment,
    result_commitment: receipt.result_commitment || null,
    final_proof: receipt.final_proof || null,
    revenue_receipt: publicRevenueQuote(revenueQuote, env),
    revenue_evidence_event_id: revenueEvidence?.revenue_event_id || null,
    revenue_evidence_hash: revenueEvidence?.event_hash || null,
    completed_at: now.toISOString(),
  };
  updated.updated_at = now.toISOString();
  await state.putAutopilotSession(updated);
  await appendEvent(state, updated, "execution", "Autopilot submitted a bounded live order.", {
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    work_order_commitment: workOrderCommitment,
    revenue_quote: publicRevenueQuote(revenueQuote, env),
  }, now);
  await appendEvent(state, updated, "live_order_submitted", "Worker submitted a bounded venue order.", {
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    decision_id: proposal.decision_id || null,
    work_order_commitment: workOrderCommitment,
    revenue_quote: publicRevenueQuote(revenueQuote, env),
  }, now);
  await appendEvent(state, updated, "receipt", "Venue receipt recorded.", {
    venue_id: proposal.venue_id,
    status: receipt.status,
    work_order_commitment: receipt.work_order_commitment,
    executor_id: submittedExecutor.executor_id,
    provider_ref_commitment: receipt.provider_ref_commitment,
    result_commitment: receipt.result_commitment,
    final_proof: receipt.final_proof || null,
    revenue_receipt: publicRevenueQuote(revenueQuote, env),
    revenue_evidence_event_id: revenueEvidence?.revenue_event_id || null,
    revenue_evidence_hash: revenueEvidence?.event_hash || null,
  }, now);
  const priorPosition = positions.find((position) =>
    position.venue_id === proposal.venue_id && normalizeMarket(position.market) === normalizeMarket(proposal.market)
  );
  const priorSignedMicro = Number.isSafeInteger(priorPosition?.signed_notional_micro_usdc)
    ? priorPosition.signed_notional_micro_usdc
    : Math.round(Number(priorPosition?.estimated_exposure_notional_usd || 0) * 1_000_000) *
      (priorPosition?.side === "sell" ? -1 : 1);
  const signedNotionalMicro = priorSignedMicro + Math.round(proposal.notional_usd * 1_000_000) *
    (proposal.side === "sell" ? -1 : 1);
  const position = await state.putAutopilotPosition(sessionId, {
    venue_id: proposal.venue_id,
    asset: baseMarket(proposal.market),
    market: proposal.market,
    product_type: proposal.product_type || (proposal.venue_id === "hyperliquid" || proposal.venue_id === "drift" ? "perp" : "spot"),
    side: signedNotionalMicro < 0 ? "sell" : "buy",
    signed_notional_micro_usdc: signedNotionalMicro,
    estimated_exposure_notional_usd: Math.abs(signedNotionalMicro) / 1_000_000,
    leverage_x100: proposal.product_type === "perp" ? session.portfolio_mandate.configured_leverage_x100 : 100,
    liquidation_distance_bps: proposal.product_type === "perp"
      ? Number(market.projected_liquidation_distance_bps || 100_000)
      : 100_000,
    last_order_notional_usd: proposal.notional_usd,
    last_work_order_commitment: workOrderCommitment,
    source: "autopilot_execution_receipt",
  });
  await appendEvent(state, updated, "venue_reconcile", "Venue receipt reconciled into native autopilot state.", {
    venue_id: proposal.venue_id,
    status: receipt.status,
    work_order_commitment: receipt.work_order_commitment,
    executor_id: submittedExecutor.executor_id,
    position: publicPosition(position),
  }, now);
  await putExecutor(state, updated, executorRecord({
    session: updated,
    kind: "order",
    tick_id: executionTickId,
    status: "reconciled",
    proposal,
    work_order_commitment: workOrderCommitment,
    receipt,
    now,
    extra: {
      executor_id: submittedExecutor.executor_id,
      created_at: submittedExecutor.created_at,
      fee_quote_bucket: revenueQuote?.fee_bucket || "0",
      metadata: revenueMetadata(revenueQuote, env),
    },
  }));
  await putTick(state, updated, {
    tick_id: executionTickId,
    status: "submitted",
    market,
    positions: [position],
    proposal,
    risk_result: portfolioRisk,
    executor_ids: [submittedExecutor.executor_id],
    receipt_commitments: [receipt.result_commitment, receipt.final_proof].filter(Boolean),
    now,
  });
  await appendEvent(state, updated, "tick_snapshot", "Replay snapshot recorded for this agent tick.", {
    tick_id: executionTickId,
    executor_ids: [submittedExecutor.executor_id],
    status: "submitted",
  }, now);
  return {
    ok: true,
    receipt,
    proposal,
    tick_id: executionTickId,
    work_order_commitment: workOrderCommitment,
    revenue_quote: publicRevenueQuote(revenueQuote, env),
    revenue_evidence: publicRevenueEvidence(revenueEvidence),
  };
}

async function runPrivateLiquidityTick({
  session,
  state,
  now,
  fetchImpl,
  env,
  tickId,
}) {
  const market = await marketSnapshotForSession(session, { fetchImpl, env, now });
  session.last_tick_at = now.toISOString();
  await state.putAutopilotSession(session);
  await appendEvent(state, session, "agent_tick", "Private liquidity agent evaluated market data.", {
    product_id: market.product_id,
    live_status: market.live_status,
    price: market.price,
    spread_bps: market.spread_bps,
  }, now);
  const positions = await state.listAutopilotPositions(session.autopilot_session_id);
  await appendEvent(state, session, "position_update", "Liquidity inventory state loaded for quote simulation.", {
    positions: positions.map(publicPosition),
  }, now);

  const venue = selectMakerVenue(session);
  const price = Number(market.price || market.mid || 0);
  const notional = Math.min(
    bucketToUsd(session.session_policy.max_notional_bucket),
    remainingDailyNotional(session),
  );
  if (!venue || market.stale || !Number.isFinite(price) || price <= 0 || notional <= 0) {
    const reason = !venue
      ? "maker_venue_not_ready"
      : market.stale
        ? "market_data_stale"
        : !Number.isFinite(price) || price <= 0
          ? "price_unavailable"
          : "notional_cap_exhausted";
    await appendEvent(state, session, "risk_reject", "Private liquidity quote simulation failed closed.", {
      reason,
      venue_allowlist: session.session_policy.venue_allowlist,
    }, now);
    await putTick(state, session, {
      tick_id: tickId,
      status: "rejected",
      market,
      positions,
      risk_result: { ok: false, reason },
      now,
    });
    return { ok: false, error: reason };
  }

  const quoteSpreadBps = Math.max(10, Math.min(
    Number.parseInt(String(env.PRIVATE_AGENT_MARKET_MAKER_QUOTE_SPREAD_BPS || ""), 10) || 25,
    session.session_policy.max_spread_bps,
  ));
  const halfSpread = quoteSpreadBps / 20_000;
  const quoteNotional = Math.max(1, notional / 2);
  const proposals = [
    makerProposal({ session, venue, market, side: "buy", price: price * (1 - halfSpread), notional: quoteNotional, quoteSpreadBps, now }),
    makerProposal({ session, venue, market, side: "sell", price: price * (1 + halfSpread), notional: quoteNotional, quoteSpreadBps, now }),
  ];
  const executors = [];
  for (const proposal of proposals) {
    const record = await putExecutor(state, session, executorRecord({
      session,
      kind: "quote",
      tick_id: tickId,
      status: "simulated",
      proposal,
      work_order_commitment: `${proposal.proposal_commitment}_no_submit`,
      close_reason: "no_submit_private_liquidity_simulation",
      now,
      extra: {
        metadata: {
          quote_spread_bps: quoteSpreadBps,
          post_only: true,
          no_submit: true,
        },
      },
    }));
    executors.push(record);
  }
  await appendEvent(state, session, "proposal", "Private liquidity agent simulated a bounded post-only quote pair.", {
    venue_id: venue,
    market: market.product_id,
    quote_spread_bps: quoteSpreadBps,
    quote_notional_bucket: String(quoteNotional),
    executor_ids: executors.map((item) => item.executor_id),
  }, now);
  await appendEvent(state, session, "executor_created", "No-submit private liquidity executors recorded.", {
    agent_controller_id: agentControllerId(session),
    kind: "quote_pair",
    executor_ids: executors.map((item) => item.executor_id),
    no_submit: true,
  }, now);
  await appendEvent(state, session, "guardrail", "Market-maker live submit is disabled; quote pair stayed in simulation.", {
    required_env: "PRIVATE_AGENT_MARKET_MAKER_LIVE_SUBMIT=true",
    no_submit: true,
  }, now);
  await putTick(state, session, {
    tick_id: tickId,
    status: "simulated",
    market,
    positions,
    proposal: {
      proposal_commitment: `maker_quote_pair_${digest({ tickId, venue, market: market.product_id, quoteSpreadBps }).slice(0, 32)}`,
      venue_id: venue,
      operation_class: operationClassForMakerVenue(venue),
      market: market.product_id,
      side: "both",
      notional_usd: quoteNotional * 2,
    },
    risk_result: { ok: true, reason: "no_submit_private_liquidity_simulation" },
    executor_ids: executors.map((item) => item.executor_id),
    now,
  });
  await appendEvent(state, session, "tick_snapshot", "Private liquidity replay snapshot recorded.", {
    tick_id: tickId,
    executor_ids: executors.map((item) => item.executor_id),
    status: "simulated",
  }, now);
  const updated = await state.getAutopilotSession(session.autopilot_session_id) || session;
  updated.tick_count = Number(updated.tick_count || 0) + 1;
  updated.last_tick_at = now.toISOString();
  updated.updated_at = now.toISOString();
  await state.putAutopilotSession(updated);
  return { ok: true, status: "simulated", tick_id: tickId, executors };
}

function tickIdForSession(session) {
  if (session?.pending_execution?.tick_id) return session.pending_execution.tick_id;
  return `tick_${digest({
    session: session.autopilot_session_id,
    policy_commitment: session.session_policy?.policy_commitment || null,
    tick_anchor: session.last_tick_at || session.created_at || session.updated_at || null,
    order_count: Number(session.order_count || 0),
    tick_count: Number(session.tick_count || 0),
  }).slice(0, 32)}`;
}

function nextExecutionSlot(session) {
  const count = Number.parseInt(String(session?.order_count ?? "0"), 10);
  return (Number.isInteger(count) && count >= 0 ? count : 0) + 1;
}

async function ensurePendingExecution(state, session, { executionSlot, proposal, tickId, now }) {
  const current = await state.getAutopilotSession(session.autopilot_session_id) || session;
  const pending = current.pending_execution;
  if (
    pending &&
    Number(pending.execution_slot) === executionSlot &&
    pending.work_order_commitment &&
    pending.proposal
  ) {
    return {
      session: current,
      proposal: pending.proposal,
      tick_id: pending.tick_id || tickId,
      work_order_commitment: pending.work_order_commitment,
      reused: true,
    };
  }
  const workOrderCommitment = workOrderCommitmentForExecutionSlot(current, executionSlot);
  const next = {
    ...current,
    pending_execution: {
      version: 1,
      execution_slot: executionSlot,
      tick_id: tickId,
      status: "created",
      proposal,
      proposal_commitment: proposal.proposal_commitment,
      work_order_commitment: workOrderCommitment,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    updated_at: now.toISOString(),
  };
  await state.putAutopilotSession(next);
  return {
    session: next,
    proposal,
    tick_id: tickId,
    work_order_commitment: workOrderCommitment,
    reused: false,
  };
}

async function currentSubmitGate(state, sessionId, now) {
  const session = await state.getAutopilotSession(sessionId);
  if (!session) {
    return { ok: false, reason: "autopilot_session_not_found", session: null };
  }
  const refreshed = refreshSession(session, now);
  if (refreshed.status !== session.status) {
    await state.putAutopilotSession(refreshed);
  }
  if (refreshed.session_policy?.kill_switch === true || refreshed.status === "killed") {
    return { ok: false, reason: "kill_switch_active", session: refreshed };
  }
  if (refreshed.status !== "running" || !refreshed.execution_enabled) {
    return { ok: false, reason: "autopilot_not_running", session: refreshed };
  }
  return { ok: true, session: refreshed };
}

function workOrderCommitmentForExecutionSlot(session, executionSlot) {
  return `autopilot_work_order_${digest({
    session: session.autopilot_session_id,
    policy_commitment: session.session_policy?.policy_commitment || null,
    execution_slot: executionSlot,
  })}`;
}

function isSessionDueForTick(session, now, env) {
  if (!session || session.status !== "running" || !session.execution_enabled) return false;
  if (session.session_policy?.kill_switch === true) return false;
  if (leaseActive(session, now)) return false;
  if (session.last_execution_at) {
    const lastExecutionAt = new Date(session.last_execution_at).getTime();
    const cooldownMs = Number(session.session_policy?.cooldown_ms || 0);
    if (Number.isFinite(lastExecutionAt) && cooldownMs > 0 && now.getTime() - lastExecutionAt < cooldownMs) {
      return false;
    }
  }
  const intervalMs = integerEnvFrom(env, "PRIVATE_AGENT_AUTOPILOT_TICK_MS", 30_000);
  if (!session.last_tick_at) return true;
  const lastTickAt = new Date(session.last_tick_at).getTime();
  if (!Number.isFinite(lastTickAt)) return true;
  return now.getTime() - lastTickAt >= intervalMs;
}

function leaseActive(session, now) {
  if (!session?.tick_lease_id || !session.tick_lease_until) return false;
  const until = new Date(session.tick_lease_until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

function normalizeBillingMetering(value) {
  const raw = value && typeof value === "object" ? value : null;
  if (!raw) return null;
  const reservationId = stringValue(raw.reservation_id);
  const reservedSeconds = Number(raw.reserved_seconds);
  const leaseStartedAt = stringValue(raw.lease_started_at);
  const leaseExpiresAt = stringValue(raw.lease_expires_at);
  if (!reservationId || !Number.isFinite(reservedSeconds) || reservedSeconds < 60 || !leaseStartedAt || !leaseExpiresAt) {
    return null;
  }
  return {
    version: 1,
    reservation_id: reservationId,
    metering_mode: "sparse_metered_v1",
    reserved_seconds: Math.floor(reservedSeconds),
    lease_started_at: leaseStartedAt,
    lease_expires_at: leaseExpiresAt,
  };
}

async function meterAutopilotCompute({
  session,
  status = "active",
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
}) {
  const billing = normalizeBillingMetering(session?.billing_metering);
  if (!billing) return { ok: true, skipped: "billing_metering_not_configured" };
  const token = env.GHOLA_PRIVATE_AGENT_METER_TOKEN || env.PRIVATE_AGENT_METER_TOKEN;
  const base = env.GHOLA_CLOUD_API_BASE || env.THUMPER_API_BASE || env.NEXT_PUBLIC_THUMPER_API_URL;
  if (!token || !base) return { ok: true, skipped: "meter_endpoint_not_configured" };
  const startedAt = new Date(billing.lease_started_at).getTime();
  const secondsUsed = Number.isFinite(startedAt)
    ? Math.max(0, Math.ceil((now.getTime() - startedAt) / 1000))
    : 0;
  const bucket = status === "active" ? Math.floor(secondsUsed / 60) : secondsUsed;
  const idempotencyKey = `meter_${digest({
    reservation: billing.reservation_id,
    worker_session: session.autopilot_session_id,
    status,
    bucket,
  }).slice(0, 32)}`;
  const response = await fetchImpl(new URL("/api/billing/private-agent/compute/meter", base), {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-ghola-private-agent-meter-token": token,
    },
    body: JSON.stringify({
      session_id: billing.reservation_id,
      worker_session_id: session.autopilot_session_id,
      idempotency_key: idempotencyKey,
      seconds_used: secondsUsed,
      status,
      lease_seconds: billing.reserved_seconds,
    }),
  }).catch((error) => ({ ok: false, status: 0, error }));
  if (!response || !response.ok) {
    return { ok: false, error: response?.status ? `compute_meter_${response.status}` : "compute_meter_unavailable" };
  }
  return { ok: true };
}

function normalizeAutopilotPolicy(raw, now) {
  const venues = unique(array(raw.venue_allowlist)
    .map((venue) => stringValue(venue).toLowerCase())
    .filter((venue) => SUPPORTED_VENUES.has(venue)));
  const markets = unique(array(raw.market_allowlist)
    .map(normalizeMarket)
    .filter((market) => SUPPORTED_MARKETS.has(market)));
  const strategyId = normalizeStrategyId(raw.strategy_id);
  const carryStrategy = strategyId === "delta_neutral_carry_v1";
  const ttlMs = clampInt(
    raw.ttl_ms,
    5 * 60_000,
    carryStrategy ? 8 * 24 * 60 * 60_000 : 4 * 60 * 60_000,
    carryStrategy ? 26 * 60 * 60_000 : 2 * 60 * 60_000,
  );
  const aiDirectEnabled = strategyId !== "delta_neutral_carry_v1" &&
    strategyId !== "hedged_spread_arbitrage_v1" &&
    strategyId !== "tri_venue_market_maker_v1" &&
    (raw.ai_direct_enabled === true || stringValue(raw.decision_model) === "ai_direct_order_v1");
  const agentMandate = normalizeSessionMandate(raw.agent_mandate);
  const executionNetwork = normalizeExecutionNetwork(raw.execution_network || raw.network);
  const configuredLeverageX100 = clampInt(raw.configured_leverage_x100, 100, 500, 100);
  const policy = {
    version: 2,
    strategy_id: strategyId,
    decision_model: aiDirectEnabled ? "ai_direct_order_v1" : "rules_plus_ai_score",
    decision_contract: aiDirectEnabled ? "structured_proposal_v2" : "deterministic_proposal_v1",
    model_role: aiDirectEnabled ? "proposal_only" : "score_only",
    ai_direct_enabled: aiDirectEnabled,
    venue_allowlist: venues.length ? venues : DEFAULT_VENUES,
    market_allowlist: markets.length ? markets : DEFAULT_MARKETS,
    max_notional_bucket: bucket(raw.max_notional_bucket, ["5", "10", "25", "50", "100"], "50"),
    max_position_notional_bucket: bucket(raw.max_position_notional_bucket, ["50", "100", "250", "500"], "100"),
    max_daily_notional_bucket: bucket(raw.max_daily_notional_bucket, ["25", "50", "100", "250"], "250"),
    max_order_count: clampInt(raw.max_order_count, 1, 25, 10),
    ttl_ms: ttlMs,
    max_slippage_bps: clampInt(raw.max_slippage_bps, 1, 100, 50),
    cooldown_ms: clampInt(raw.cooldown_ms, 60_000, 30 * 60_000, 5 * 60_000),
    data_max_age_ms: clampInt(raw.data_max_age_ms, 5_000, 5 * 60_000, 30_000),
    min_net_edge_bps: clampInt(raw.min_net_edge_bps, 1, 5_000, 25),
    max_execution_skew_ms: clampInt(raw.max_execution_skew_ms, 50, 60_000, 2_000),
    min_ai_score_bps: clampInt(raw.min_ai_score_bps, 5_000, 9_900, 6_500),
    ai_min_confidence_bps: clampInt(raw.ai_min_confidence_bps ?? raw.min_ai_score_bps, 5_000, 9_900, 6_500),
    min_signal_bps: clampInt(raw.min_signal_bps, 5, 2_000, 25),
    max_spread_bps: clampInt(raw.max_spread_bps, 1, 1_000, 150),
    execution_network: executionNetwork,
    configured_leverage_x100: configuredLeverageX100,
    max_leverage_x100: Math.max(configuredLeverageX100, clampInt(raw.max_leverage_x100, 100, 500, configuredLeverageX100)),
    min_liquidation_distance_bps: clampInt(raw.min_liquidation_distance_bps, 500, 10_000, 2_500),
    max_asset_concentration_bps: clampInt(raw.max_asset_concentration_bps, 1_000, 10_000, 10_000),
    daily_loss_limit_bucket: bucket(raw.daily_loss_limit_bucket, ["5", "10", "25", "50", "100"], "50"),
    max_drawdown_bucket: bucket(raw.max_drawdown_bucket, ["5", "10", "25", "50", "100", "250"], "100"),
    max_drawdown_bps: clampInt(raw.max_drawdown_bps, 100, 5_000, 1_500),
    max_funding_bps_8h: clampInt(raw.max_funding_bps_8h, 0, 1_000, 100),
    max_basis_bps: clampInt(raw.max_basis_bps, 0, 5_000, 500),
    max_fee_bps: clampInt(raw.max_fee_bps, 0, 1_000, 100),
    max_gas_micro_usdc: clampInt(raw.max_gas_micro_usdc, 0, 100_000_000, 1_000_000),
    max_open_orders: clampInt(raw.max_open_orders, 0, 100, 10),
    max_model_decisions_per_hour: clampInt(raw.max_model_decisions_per_hour, 0, 1_000, 20),
    max_model_cost_micro_usdc_per_day: clampInt(raw.max_model_cost_micro_usdc_per_day, 0, 100_000_000, 5_000_000),
    reduce_only: raw.reduce_only === true,
    mainnet_activation_id: boundedIdentifier(raw.mainnet_activation_id),
    owner_authorization_commitment: boundedIdentifier(raw.owner_authorization_commitment),
    allowed_order_types: ["swap", "spot_market_order", "spot_limit_order", "perp_limit_order", "limit_order", "cancel"],
    kill_switch: raw.kill_switch === true,
    reduce_only_on_reconcile_failure: raw.reduce_only_on_reconcile_failure !== false,
    locale_hint: localeHint(raw.locale_hint),
    timezone: stringValue(raw.timezone) || null,
    ...(agentMandate ? { agent_mandate: agentMandate } : {}),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return {
    ...policy,
    policy_commitment: `autopilot_policy_${digest(policy)}`,
  };
}

// The user-authored trade plan ("mandate") attached to a session. Side, when
// set to buy/sell, is enforced deterministically on every proposal; the rest
// steers the model proposal via prompt context. Absent means model-selected direction.
function normalizeSessionMandate(value) {
  if (!value || typeof value !== "object") return null;
  const side = stringValue(value.side).toLowerCase();
  const mandate = {
    version: 1,
    side: side === "buy" || side === "sell" ? side : "auto",
    strategy_profile: stringValue(value.strategy_profile) || "momentum_continuation",
    entry_trigger: stringValue(value.entry_trigger) || "preview_now",
    exit_rule: stringValue(value.exit_rule) || "manual_approval",
    time_horizon: stringValue(value.time_horizon) || "scalp",
  };
  const note = stringValue(value.strategy_note);
  if (note) mandate.strategy_note = note.slice(0, 240);
  return mandate;
}

// The binding direction from the mandate, or null when the user left it on
// "auto" (or no mandate at all) and the agent is free to choose.
function mandateSide(session) {
  const side = session?.session_policy?.agent_mandate?.side;
  return side === "buy" || side === "sell" ? side : null;
}

function strategyForPolicy(policy) {
  if (policy.strategy_id === "delta_neutral_carry_v1") {
    return {
      version: 1,
      strategy_id: "delta_neutral_carry_v1",
      decision_model: "rules_plus_ai_score",
      model_role: "proposal_only",
      executable_order_source: "deterministic_funding_carry_planner",
      ai_can_execute_directly: false,
      deterministic_router: true,
      protected_multi_leg: true,
    };
  }
  if (policy.strategy_id === "hedged_spread_arbitrage_v1") {
    return {
      version: 1,
      strategy_id: "hedged_spread_arbitrage_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_arb_planner",
      ai_can_execute_directly: false,
      deterministic_router: true,
    };
  }
  if (policy.strategy_id === "tri_venue_market_maker_v1") {
    return {
      version: 1,
      strategy_id: "tri_venue_market_maker_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_market_maker",
      ai_can_execute_directly: false,
      deterministic_router: true,
    };
  }
  if (policy.ai_direct_enabled) {
    return {
      version: 1,
      strategy_id: BOUNDED_INTENT_STRATEGY,
      decision_model: "ai_direct_order_v1",
      decision_contract: "structured_proposal_v2",
      model_role: "proposal_only",
      executable_order_source: "deterministic_cost_router_after_typed_model_proposal",
      ai_can_execute_directly: false,
      deterministic_router: true,
    };
  }
  return {
    version: 1,
    strategy_id: BOUNDED_INTENT_STRATEGY,
    decision_model: "rules_plus_ai_score",
    executable_order_source: "deterministic_bounded_intent_executor",
    ai_can_execute_directly: false,
  };
}

function normalizeStrategyId(value) {
  const raw = stringValue(value);
  if (
    raw === "delta_neutral_carry_v1" ||
    raw === "hedged_spread_arbitrage_v1" ||
    raw === "tri_venue_market_maker_v1"
  ) return raw;
  return BOUNDED_INTENT_STRATEGY;
}

function normalizeVenueAccess(raw, policy) {
  const dryRunReady = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" ||
    process.env.PRIVATE_AGENT_AUTOPILOT_ASSUME_FUNDED === "true";
  const out = {};
  for (const venue of policy.venue_allowlist) {
    const value = raw?.[venue] || raw?.[venue.replace("_advanced", "")] || null;
    if (value && typeof value === "object") {
      const requestedStatus = value.status === "ready" || value.encrypted_execution_vault || value.execution_mode === "ghola_pooled"
        ? "ready"
        : value.status || "needs_funds";
      out[venue] = {
        status: venue === "drift" ? "quarantined" : requestedStatus,
        execution_mode: value.execution_mode || defaultExecutionMode(venue),
        vault_commitment: value.vault_commitment || null,
        encrypted_vault_commitment: value.encrypted_vault_commitment || null,
        encrypted_execution_vault: value.encrypted_execution_vault || null,
        allocation_commitment: value.allocation_commitment || value.managed_allocation_commitment || null,
        managed_allocation_commitment: value.managed_allocation_commitment || null,
        omnibus_allocation: value.omnibus_allocation || null,
        adapter_id: stringValue(value.adapter_id).slice(0, 80) || null,
        custody_type: stringValue(value.custody_type).slice(0, 80) || null,
        readiness_checked_at_ms: Number.isSafeInteger(value.readiness_checked_at_ms) ? value.readiness_checked_at_ms : null,
        latency_ms: Number.isInteger(value.latency_ms) && value.latency_ms >= 0 ? value.latency_ms : null,
        capabilities: normalizeCapabilityEvidence(value.capabilities),
        no_submit_proof: normalizeNoSubmitProof(value.no_submit_proof),
        reason: venue === "drift" ? "drift_runtime_quarantined" : value.reason || null,
      };
    } else {
      out[venue] = {
        status: venue === "drift" ? "quarantined" : dryRunReady ? "ready" : "needs_funds",
        execution_mode: dryRunReady ? defaultExecutionMode(venue) : null,
        reason: venue === "drift"
          ? "drift_runtime_quarantined"
          : dryRunReady ? "dry_run_ready" : "isolated_vault_required",
      };
    }
  }
  return out;
}

function normalizeCapabilityEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => /^[a-z0-9_]{2,60}$/.test(key) && typeof item === "boolean")
      .slice(0, 32),
  );
}

function normalizeNoSubmitProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    status: value.status === "verified_no_funds" ? value.status : "unverified",
    transaction_broadcast: value.transaction_broadcast === false
      ? false
      : value.transaction_broadcast === true ? true : null,
    turnkey_policy_checked: value.turnkey_policy_checked === true,
    account_state_checked: value.account_state_checked === true,
    order_request_checked: value.order_request_checked === true,
    dependency_audit: value.dependency_audit === "pass" ? "pass" : "fail",
    verified_at_ms: Number.isSafeInteger(value.verified_at_ms) ? value.verified_at_ms : null,
    capabilities: normalizeCapabilityEvidence(value.capabilities),
  };
}

function buildMomentumProposal(session, market, { env, now }) {
  if (market.stale) {
    return { ok: false, error: "market_data_stale", message: "Market data is stale; no trade attempted.", data: market };
  }
  if (Number.isFinite(market.spread_bps) && market.spread_bps > session.session_policy.max_spread_bps) {
    return { ok: false, error: "spread_too_wide", message: "Spread is too wide; no trade attempted.", data: market };
  }
  const changeBps = Math.round(Number(market.change_24h || 0) * 100);
  const force = env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE === "force";
  if (!force && Math.abs(changeBps) < session.session_policy.min_signal_bps) {
    return {
      ok: false,
      error: "signal_too_weak",
      message: "Momentum signal is below threshold; no trade attempted.",
      data: { change_bps: changeBps, threshold_bps: session.session_policy.min_signal_bps },
    };
  }
  // A buy/sell mandate is binding; otherwise follow the momentum signal.
  const side = mandateSide(session) ?? (changeBps >= 0 ? "buy" : "sell");
  const price = Number(market.price || market.mid || 0);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "price_unavailable", message: "Price is unavailable; no trade attempted.", data: market };
  }
  const routed = routeModelProposal({
    session,
    market,
    decision: {
      version: 2,
      action: "trade",
      objective: "best_execution",
      market: market.product_id,
      side,
      confidence_bps: 10_000,
    },
    signal_bps: Math.abs(changeBps),
    env,
    now,
  });
  if (!routed.ok) {
    return {
      ok: false,
      error: routed.error,
      message: routed.message,
      data: { routing: routed.routing || null },
    };
  }
  const venue = routed.venue_id;
  const notional = routed.notional_usd;
  const instruction = instructionForVenue({ venue, market, side, price, notional, policy: session.session_policy, env, now });
  instruction.operation_class = routed.operation_class;
  return {
    ok: true,
    proposal_commitment: `autopilot_proposal_${digest({ session: session.autopilot_session_id, venue, market, side, notional, now: now.toISOString() })}`,
    venue_id: venue,
    operation_class: routed.operation_class,
    market: market.product_id,
    objective: "best_execution",
    product_type: routed.product_type,
    side,
    notional_usd: notional,
    signal_bps: changeBps,
    routing: routeSummary(routed.routing),
    instruction,
  };
}

async function recordNonActionableTick({
  state,
  session,
  tickId,
  market,
  positions,
  reason,
  message,
  data,
  now,
  env,
}) {
  const nextCount = Number(session.non_actionable_tick_count || 0) + 1;
  const maxNoopTicks = integerEnvFrom(env, "PRIVATE_AGENT_AUTOPILOT_AUTO_PAUSE_NOOP_TICKS", 10);
  const hasOpenPosition = positions.some((position) => Number(position?.notional_usd || position?.notional || 0) > 0);
  session.non_actionable_tick_count = nextCount;
  if (!hasOpenPosition && maxNoopTicks > 0 && nextCount >= maxNoopTicks) {
    session.status = "paused";
    session.execution_enabled = false;
    session.next_step = "Autopilot auto-paused after repeated non-actionable market ticks.";
    await meterAutopilotCompute({ session, status: "paused", now, env }).catch(() => null);
  }
  session.last_tick_at = now.toISOString();
  session.updated_at = now.toISOString();
  await state.putAutopilotSession(session);
  await appendEvent(state, session, "guardrail", message, {
    ...data,
    non_actionable_tick_count: nextCount,
    auto_paused: session.status === "paused",
  }, now);
  await putTick(state, session, {
    tick_id: tickId,
    status: "rejected",
    market,
    positions,
    risk_result: { ok: false, reason },
    now,
  });
  return { ok: false, error: reason };
}

function buildAiDirectProposal(session, market, decision, {
  env = process.env,
  now,
  positions = [],
  signalBps = 0,
}) {
  if (decision.action !== "trade") {
    return {
      ok: false,
      error: `ai_decision_${decision.action}`,
      message: "Model proposal did not request a trade.",
      data: { action: decision.action, reason_codes: decision.reason_codes },
    };
  }
  // A buy/sell mandate overrides the model's chosen direction; on "auto" the
  // model's proposal stands. Venue, operation, size, and price are never model-owned.
  const aiSide = decision.side === "buy" || decision.side === "sell" ? decision.side : null;
  const side = mandateSide(session) ?? aiSide;
  if (!side) {
    return {
      ok: false,
      error: "ai_trade_side_required",
      message: "AI trade decision did not include a side.",
      data: {},
    };
  }
  const decisionMarket = normalizeMarket(decision.market);
  const allowedMarkets = session.session_policy.market_allowlist.map(normalizeMarket);
  if (!allowedMarkets.includes(decisionMarket)) {
    return {
      ok: false,
      error: "ai_market_outside_policy",
      message: "AI selected a market outside the session policy.",
      data: { market: decisionMarket, market_allowlist: allowedMarkets },
    };
  }
  const routed = routeModelProposal({
    session,
    market,
    decision: { ...decision, side, market: decisionMarket },
    signal_bps: signalBps,
    env,
    now,
  });
  if (!routed.ok) {
    return {
      ok: false,
      error: routed.error,
      message: routed.message,
      data: { routing: routed.routing || null },
    };
  }
  const venue = routed.venue_id;
  const operationClass = routed.operation_class;
  if (!operationAllowedForVenue(venue, operationClass)) {
    return {
      ok: false,
      error: "router_operation_not_allowed",
      message: "The deterministic router produced an unsupported venue operation.",
      data: { venue_id: venue, operation_class: operationClass },
    };
  }
  if (!session.session_policy.allowed_order_types.includes(operationClass)) {
    return {
      ok: false,
      error: "router_operation_outside_policy",
      message: "The deterministic route is outside the signed order-type policy.",
      data: { operation_class: operationClass },
    };
  }
  const price = routed.reference_price;
  const notional = routed.notional_usd;
  const maxOrderNotional = bucketToUsd(session.session_policy.max_notional_bucket);
  if (maxOrderNotional > 0 && notional > maxOrderNotional) {
    return {
      ok: false,
      error: "router_notional_exceeds_order_cap",
      message: "The deterministic route exceeded the per-order notional cap.",
      data: { quote_size_usd: notional, max_notional_bucket: session.session_policy.max_notional_bucket },
    };
  }
  if (notional > remainingDailyNotional(session)) {
    return {
      ok: false,
      error: "daily_cap_exhausted",
      message: "AI trade decision exceeded remaining daily notional.",
      data: { quote_size_usd: notional, remaining_daily_notional: remainingDailyNotional(session) },
    };
  }
  const maxPositionNotional = bucketToUsd(session.session_policy.max_position_notional_bucket);
  if (maxPositionNotional > 0) {
    const currentExposure = positionExposureFor(positions, venue, decisionMarket);
    const nextExposure = currentExposure + notional;
    if (nextExposure > maxPositionNotional) {
      return {
        ok: false,
        error: "router_position_cap_exceeded",
        message: "The deterministic route exceeded the position notional cap.",
        data: {
          quote_size_usd: notional,
          current_exposure_notional_usd: currentExposure,
          max_position_notional_bucket: session.session_policy.max_position_notional_bucket,
        },
      };
    }
  }
  const productId = decisionMarket === "SOL/USDC" ? "SOL-USD" : decisionMarket;
  const proposalMarket = { ...market, product_id: productId, price, mid: price };
  const instruction = instructionForVenue({
    venue,
    market: proposalMarket,
    side,
    price,
    notional,
    policy: session.session_policy,
    env,
    now,
  });
  instruction.operation_class = operationClass;
  return {
    ok: true,
    proposal_commitment: `autopilot_proposal_${digest({
      session: session.autopilot_session_id,
      decision,
      venue,
      market: productId,
      route_cost_bps: routed.routing.selected.costs.total_bps,
      now: now.toISOString(),
    })}`,
    decision_id: decision.decision_id || null,
    decision_source: "ai_structured_proposal_v2",
    objective: decision.objective,
    venue_id: venue,
    operation_class: operationClass,
    market: productId,
    product_type: routed.product_type,
    side,
    notional_usd: notional,
    signal_bps: signalBps,
    confidence_bps: decision.confidence_bps,
    routing: routeSummary(routed.routing),
    instruction,
  };
}

function routeSummary(routing) {
  return {
    version: 1,
    selected_venue_id: routing.selected.venue_id,
    modeled_cost_bps: routing.selected.costs.total_bps,
    expected_gross_benefit_bps: routing.selected.expected_gross_benefit_bps,
    expected_net_benefit_bps: routing.selected.expected_net_benefit_bps,
    selected_costs: routing.selected.costs,
    selected_quote: {
      gas_micro_usdc: routing.selected.quote.gas_micro_usdc,
    },
    candidates: routing.candidates.map((candidate) => ({
      venue_id: candidate.venue_id,
      status: candidate.status,
      reasons: candidate.reasons,
      modeled_cost_bps: candidate.costs?.total_bps ?? null,
    })),
  };
}

function instructionForVenue({ venue, market, side, price, notional, policy, env = process.env, now }) {
  const expiresAt = new Date(now.getTime() + Math.min(5 * 60_000, policy.ttl_ms)).toISOString();
  if (venue === "jupiter") {
    const inputMint = side === "buy" ? USDC_MINT : SOL_MINT;
    const outputMint = side === "buy" ? SOL_MINT : USDC_MINT;
    const amount = side === "buy"
      ? String(Math.max(1, Math.floor(notional * 1_000_000)))
      : String(Math.max(1, Math.floor((notional / price) * 1_000_000_000)));
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "jupiter",
      operation_class: "swap",
      expires_at: expiresAt,
      order: {
        input_mint: inputMint,
        output_mint: outputMint,
        amount,
        quote_size: String(notional),
        max_slippage_bps: String(policy.max_slippage_bps),
        routing_mode: jupiterPlatformFeeRequested(env) ? "router" : "meta_aggregator",
      },
    };
  }
  if (venue === "coinbase_advanced") {
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: "spot_market_order",
      expires_at: expiresAt,
      order: {
        market: market.product_id,
        side,
        quote_size: String(notional),
        order_type: "market",
        size_mode: "quote",
        tif: "ioc",
      },
    };
  }
  const limit = side === "buy"
    ? price * (1 + policy.max_slippage_bps / 10_000)
    : price * (1 - policy.max_slippage_bps / 10_000);
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: venue === "hyperliquid" ? "limit_order" : "perp_limit_order",
    expires_at: expiresAt,
    order: {
      market: venueMarketSymbol(venue, market.product_id),
      side,
      quote_size: String(notional),
      limit_price: trim(limit),
      order_type: "market",
      size_mode: "quote",
      live_order_mode: "tiny_fill",
      max_slippage_bps: String(policy.max_slippage_bps),
      tif: "Ioc",
    },
  };
}

async function marketSnapshotForSession(session, { fetchImpl, env, now }) {
  const productId = primaryProduct(session);
  if (env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE === "force") {
    return {
      product_id: productId,
      price: Number(env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE || "100"),
      mid: Number(env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE || "100"),
      change_24h: Number(env.PRIVATE_AGENT_AUTOPILOT_FORCE_CHANGE_PCT || "1"),
      spread_bps: 10,
      fetched_at: now.toISOString(),
      live_status: "forced",
      stale: false,
    };
  }
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(productId)}`;
  const response = await fetchImpl(url, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`market_snapshot_${response.status}`);
  const body = await response.json();
  const price = numberValue(body.price || body.mid_market_price || body.pricebook?.best_bid);
  return {
    product_id: productId,
    price,
    mid: price,
    change_24h: numberValue(body.price_percentage_change_24h),
    spread_bps: spreadBps(body, price),
    fetched_at: now.toISOString(),
    live_status: "live",
    stale: !price,
  };
}

function selectVenue(session, market) {
  const product = market.product_id;
  const ready = readyVenues(session);
  if (product === "SOL-USD" && ready.includes("jupiter")) return "jupiter";
  if (ready.includes("coinbase_advanced")) return "coinbase_advanced";
  if (ready.includes("phoenix") && product === "SOL-USD") return "phoenix";
  if (ready.includes("backpack") && product === "SOL-USD") return "backpack";
  if (ready.includes("hyperliquid")) return "hyperliquid";
  return ready[0] || null;
}

function operationAllowedForVenue(venue, operationClass) {
  if (venue === "jupiter") return operationClass === "swap";
  if (venue === "coinbase_advanced") {
    return operationClass === "spot_market_order" || operationClass === "spot_limit_order";
  }
  if (venue === "phoenix" || venue === "backpack") return operationClass === "perp_limit_order";
  if (venue === "hyperliquid") return operationClass === "limit_order";
  return false;
}

function positionExposureFor(positions, venue, market) {
  const normalizedMarket = normalizeMarket(market);
  return positions
    .filter((position) =>
      stringValue(position.venue_id).toLowerCase() === venue &&
      normalizeMarket(position.market) === normalizedMarket
    )
    .reduce((total, position) => {
      const exposure = Number(position.estimated_exposure_notional_usd ?? position.notional_usd ?? 0);
      return total + (Number.isFinite(exposure) ? Math.abs(exposure) : 0);
    }, 0);
}

function timeInForceForVenue(value, venue) {
  const raw = stringValue(value).toLowerCase();
  if (venue === "coinbase_advanced") {
    if (raw === "gtc" || raw === "good_til_cancelled") return "gtc";
    if (raw === "fok" || raw === "fill_or_kill") return "fok";
    return "ioc";
  }
  if (raw === "gtc") return "Gtc";
  if (raw === "alo" || raw === "post_only") return "Alo";
  return "Ioc";
}

function aiDirectRuntimeEnabled(env) {
  return env.PRIVATE_AGENT_AI_DIRECT_ENABLED === "true";
}

async function reserveAiDecisionBudget({ state, session, env, now }) {
  const max = Number.parseInt(String(env.PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR ?? "4"), 10);
  if (!Number.isInteger(max) || max <= 0) return { ok: true, max: 0 };
  const hour = now.toISOString().slice(0, 13);
  const result = await state.incrementPolicyCount(
    `ai_direct_decision:${session.autopilot_session_id}:${hour}`,
    max,
  );
  return { ok: result.ok, max };
}

function scoreProposal(proposal, { env }) {
  if (env.PRIVATE_AGENT_AUTOPILOT_AI_MODE === "unavailable") {
    return { ok: false, score_bps: 0, message: "AI scorer unavailable; execution blocked." };
  }
  const score = Math.min(9_500, Math.max(5_000, 6_500 + Math.abs(proposal.signal_bps) * 4));
  return {
    ok: score >= 6_500,
    score_bps: score,
    message: score >= 6_500
      ? "AI scorer accepted the deterministic bounded order."
      : "AI scorer rejected the proposal.",
  };
}

function executionForVenue(session, venue) {
  const access = session.venue_access?.[venue] || {};
  const execution = {
    execution_mode: access.execution_mode || defaultExecutionMode(venue),
    vault_commitment: access.vault_commitment || undefined,
    encrypted_vault_commitment: access.encrypted_vault_commitment || undefined,
    encrypted_execution_vault: access.encrypted_execution_vault || undefined,
    allocation_commitment: access.allocation_commitment || undefined,
    managed_allocation_commitment: access.managed_allocation_commitment || undefined,
    omnibus_allocation: access.omnibus_allocation || undefined,
    autopilot_session_id: session.autopilot_session_id,
  };
  if (venue === "hyperliquid" && access.allocation_commitment && !execution.managed_allocation_commitment) {
    execution.managed_allocation_commitment = access.allocation_commitment;
  }
  return execution;
}

function workerSessionPolicy(session) {
  const policy = session.session_policy;
  return {
    policy_commitment: policy.policy_commitment,
    venue_allowlist: policy.venue_allowlist,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_position_notional_bucket: policy.max_position_notional_bucket,
    max_daily_notional_bucket: policy.max_daily_notional_bucket,
    max_order_count: policy.max_order_count,
    max_slippage_bps: policy.max_slippage_bps,
    allowed_order_types: policy.allowed_order_types,
    kill_switch: policy.kill_switch === true || session.status === "killed",
    expires_at: session.expires_at,
  };
}

function refreshSession(session, now) {
  if (
    session.status !== "killed" &&
    session.status !== "blocked" &&
    new Date(session.expires_at).getTime() <= now.getTime()
  ) {
    return {
      ...session,
      status: "expired",
      execution_enabled: false,
      updated_at: now.toISOString(),
      next_step: "Session expired. Create a new autonomous session.",
    };
  }
  return session;
}

async function appendEvent(state, session, type, message, data = {}, now = new Date()) {
  return state.appendAutopilotEvent(session.autopilot_session_id, {
    version: 1,
    autopilot_session_id: session.autopilot_session_id,
    event_id: `autoevt_${digest({ session: session.autopilot_session_id, type, message, now: now.toISOString(), nonce: randomUUID() }).slice(0, 24)}`,
    type,
    status: session.status,
    message,
    data,
    created_at: now.toISOString(),
  });
}

async function putExecutor(state, session, record) {
  if (!state.putExecutorRecord) return record;
  return state.putExecutorRecord(session.autopilot_session_id, record);
}

async function putTick(state, session, input) {
  const snapshot = tickSnapshot({
    session,
    ...input,
  });
  if (!state.putTickSnapshot) return snapshot;
  return state.putTickSnapshot(session.autopilot_session_id, snapshot);
}

function isPrivateLiquiditySession(session) {
  return session?.session_policy?.strategy_id === "tri_venue_market_maker_v1" ||
    session?.strategy?.strategy_id === "tri_venue_market_maker_v1";
}

function readyVenues(session) {
  return session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
}

function selectMakerVenue(session) {
  const ready = readyVenues(session);
  if (ready.includes("phoenix")) return "phoenix";
  if (ready.includes("backpack")) return "backpack";
  if (ready.includes("hyperliquid")) return "hyperliquid";
  if (ready.includes("coinbase_advanced")) return "coinbase_advanced";
  return null;
}

function makerProposal({ session, venue, market, side, price, notional, quoteSpreadBps, now }) {
  const operationClass = operationClassForMakerVenue(venue);
  const proposal = {
    proposal_commitment: `maker_quote_${digest({
      session: session.autopilot_session_id,
      venue,
      market: market.product_id,
      side,
      price,
      notional,
      now: now.toISOString(),
    }).slice(0, 32)}`,
    decision_source: "deterministic_private_liquidity_v1",
    venue_id: venue,
    operation_class: operationClass,
    market: market.product_id,
    side,
    notional_usd: notional,
    signal_bps: 0,
    confidence_bps: 10_000,
    policy_commitment: session.session_policy.policy_commitment,
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: operationClass,
      expires_at: new Date(now.getTime() + Math.min(10_000, session.session_policy.ttl_ms)).toISOString(),
      order: {
        market: venueMarketSymbol(venue, market.product_id),
        side,
        quote_size: String(notional),
        limit_price: trim(price),
        order_type: "limit",
        size_mode: "quote",
        live_order_mode: "post_only_quote",
        max_slippage_bps: "1",
        tif: timeInForceForVenue("post_only", venue),
        post_only: true,
      },
    },
  };
  proposal.instruction.order.quote_spread_bps = String(quoteSpreadBps);
  return proposal;
}

function operationClassForMakerVenue(venue) {
  if (venue === "coinbase_advanced") return "spot_limit_order";
  if (venue === "hyperliquid") return "limit_order";
  return "perp_limit_order";
}

function primaryProduct(session) {
  const markets = session.session_policy.market_allowlist;
  const product = markets.find((market) => market.endsWith("-USD")) || "SOL-USD";
  return ["BTC-USD", "ETH-USD", "SOL-USD"].includes(product) ? product : "SOL-USD";
}

function publicSession(session) {
  const out = JSON.parse(JSON.stringify(session));
  for (const access of Object.values(out.venue_access || {})) {
    if (!access || typeof access !== "object") continue;
    delete access.encrypted_execution_vault;
    delete access.omnibus_allocation;
  }
  if (out.pending_execution) {
    out.pending_execution = publicPendingExecution(out.pending_execution);
  }
  return out;
}

function publicPendingExecution(pending) {
  return {
    version: pending.version || 1,
    execution_slot: pending.execution_slot || null,
    tick_id: pending.tick_id || null,
    status: pending.status || null,
    proposal_commitment: pending.proposal_commitment || pending.proposal?.proposal_commitment || null,
    work_order_commitment: pending.work_order_commitment || null,
    created_at: pending.created_at || null,
    updated_at: pending.updated_at || null,
  };
}

function publicProposal(proposal) {
  return {
    proposal_commitment: proposal.proposal_commitment,
    decision_id: proposal.decision_id || null,
    decision_source: proposal.decision_source || "deterministic_bounded_intent_executor",
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    signal_bps: proposal.signal_bps,
    confidence_bps: proposal.confidence_bps || null,
  };
}

function autopilotRevenueQuote(proposal, { env = process.env } = {}) {
  if (proposal?.venue_id !== "jupiter") return null;
  const quote = jupiterPlatformFeeQuote({ notionalUsd: proposal.notional_usd, env });
  if (!quote) return null;
  const feeBucket = trim(quote.fee_usd);
  return {
    ...quote,
    fee_bucket: feeBucket,
    collection_status: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? "dry_run_quoted"
      : "routed_in_jupiter_order",
  };
}

function publicRevenueQuote(quote, env = process.env) {
  if (!quote) return null;
  return {
    version: 1,
    revenue_model: quote.revenue_model,
    venue_id: quote.venue_id,
    fee_bps: quote.fee_bps,
    notional_bucket: trim(quote.notional_usd),
    fee_bucket: quote.fee_bucket,
    fee_recipient: quote.fee_recipient,
    fee_recipient_commitment: quote.fee_recipient_commitment,
    collection_status: quote.collection_status,
    dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
  };
}

function publicRevenueEvidence(event) {
  if (!event) return null;
  return {
    version: 1,
    revenue_event_id: event.revenue_event_id,
    event_hash: event.event_hash,
    previous_event_hash: event.previous_event_hash || null,
    ledger_sequence: event.ledger_sequence || null,
    revenue_status: event.revenue_status,
    collection_status: event.collection_status,
    revenue_model: event.revenue_model,
    venue_id: event.venue_id,
    expected_fee_bucket: event.expected_fee_bucket,
    fee_recipient_commitment: event.fee_recipient_commitment || null,
  };
}

function revenueMetadata(quote, env = process.env) {
  if (!quote) return {
    revenue_model: "none",
    fee_collection_status: "not_configured",
  };
  return {
    revenue_model: quote.revenue_model,
    fee_bps: quote.fee_bps,
    fee_usd: quote.fee_bucket,
    fee_recipient: quote.fee_recipient,
    fee_recipient_commitment: quote.fee_recipient_commitment,
    fee_collection_status: quote.collection_status,
    fee_dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
  };
}

function jupiterPlatformFeeRequested(env = process.env) {
  return [
    "PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS",
    "GHOLA_JUPITER_PLATFORM_FEE_BPS",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_BPS",
    "GHOLA_AUTOPILOT_JUPITER_FEE_BPS",
  ].some((name) => {
    const value = Number.parseInt(String(env?.[name] ?? ""), 10);
    return Number.isInteger(value) && value > 0;
  });
}

function publicPosition(position) {
  return {
    venue_id: position.venue_id || null,
    asset: position.asset || baseMarket(position.market),
    market: position.market || null,
    product_type: position.product_type || null,
    side: position.side || null,
    estimated_exposure_notional_bucket: String(position.estimated_exposure_notional_usd ?? position.notional_usd ?? "0"),
    signed_exposure_notional_bucket: String(
      Number(position.signed_notional_micro_usdc || 0) / 1_000_000,
    ),
    signed_base_size: Number.isFinite(Number(position.signed_base_size))
      ? String(position.signed_base_size)
      : null,
    strategy_id: position.strategy_id || null,
    protected_pair_id: position.protected_pair_id || null,
    exit_due_at: position.exit_due_at || null,
    liquidation_distance_bps: Number.isInteger(position.liquidation_distance_bps)
      ? position.liquidation_distance_bps
      : null,
    last_order_notional_bucket: String(position.last_order_notional_usd ?? "0"),
    last_work_order_commitment: position.last_work_order_commitment || null,
    source: position.source || "native_autopilot_state",
    updated_at: position.updated_at || null,
  };
}

function normalizeMarket(value) {
  const upper = stringValue(value).toUpperCase();
  if (upper === "SOL" || upper === "SOLANA") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  if (upper === "SOL/USDC" || upper === "SOL-USDC") return "SOL/USDC";
  return upper;
}

function baseMarket(productId) {
  return String(productId || "SOL-USD").split("-")[0].split("/")[0].toUpperCase();
}

function venueMarketSymbol(venue, productId) {
  const base = baseMarket(productId);
  if (venue === "phoenix") return `${base}-PERP`;
  if (venue === "backpack") return `${base}_USDC_PERP`;
  return base;
}

function defaultExecutionMode(venue) {
  if (venue === "jupiter") return "user_stealth";
  return "byo_api_key";
}

function remainingDailyNotional(session) {
  return Math.max(0, bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0));
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function bucket(value, allowed, fallback) {
  const raw = stringValue(value).replace(/[^0-9.]/g, "");
  return allowed.includes(raw) ? raw : fallback;
}

function localeHint(value) {
  const raw = stringValue(value).toLowerCase();
  if (raw === "zh" || raw === "zh-cn" || raw === "zh_hans") return "zh-CN";
  if (raw === "id" || raw === "in" || raw === "id-id") return "id";
  return "en";
}

function normalizeExecutionNetwork(value) {
  const network = stringValue(value).toLowerCase();
  return network === "mainnet" || network === "testnet" ? network : "paper";
}

function boundedIdentifier(value) {
  const normalized = stringValue(value);
  return /^[A-Za-z0-9:_-]{8,160}$/.test(normalized) ? normalized : null;
}

function spreadBps(body, price) {
  const bid = numberValue(body.best_bid || body.pricebook?.bids?.[0]?.price);
  const ask = numberValue(body.best_ask || body.pricebook?.asks?.[0]?.price);
  if (!bid || !ask || !price) return null;
  return Math.abs((ask - bid) / price) * 10_000;
}

function numberValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function integerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function integerEnvFrom(env, name, fallback) {
  const parsed = Number.parseInt(String(env?.[name] ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(values));
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function trim(value) {
  return Number(value).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 48);
}
