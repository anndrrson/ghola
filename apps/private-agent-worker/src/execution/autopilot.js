import { createHash, randomUUID } from "node:crypto";
import {
  isArbitrageSession,
  runGuardedArbitrageTick,
} from "./arbitrage.js";
import { decideAiDirectOrder, publicDecisionRecord } from "./ai-direct-order.js";
import { executeAutopilotOrder, verifyAutopilotOrder } from "./private-execution.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SUPPORTED_VENUES = new Set(["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"]);
const SUPPORTED_MARKETS = new Set(["SOL-USD", "BTC-USD", "ETH-USD", "SOL/USDC", "SOL", "BTC", "ETH", "HYPE"]);
const DEFAULT_VENUES = ["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"];
const DEFAULT_MARKETS = ["SOL-USD", "BTC-USD", "ETH-USD"];
const LOOP_TIMERS = new Map();

export async function createAutopilotSession({ body, recipient, state, provider, startLoop = true, now = new Date() }) {
  const policy = normalizeAutopilotPolicy(body?.session_policy || body || {}, now);
  const venueAccess = normalizeVenueAccess(body?.venue_access || body?.venue_vaults || {}, policy);
  const readyVenues = policy.venue_allowlist.filter((venue) => venueAccess[venue]?.status === "ready");
  const status = policy.kill_switch
    ? "killed"
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
    worker_session_commitment: `worker_autopilot_${digest({ id, recipient: recipient.recipient_id })}`,
    owner_commitment: stringValue(body?.owner_commitment) || "owner_redacted",
    provider,
    status,
    strategy: strategyForPolicy(policy),
    session_policy: policy,
    venue_access: venueAccess,
    order_count: 0,
    daily_notional_used_bucket: "0",
    last_tick_at: null,
    last_execution_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: policy.expires_at,
    next_step: status === "running"
      ? "Autonomous worker is running. Trades require fresh market data, AI score, and policy guardrails."
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
    refreshed.next_step = "Kill switch active. No autonomous execution is allowed.";
    stopAutopilotLoop(sessionId);
  } else if (refreshed.status === "expired") {
    refreshed.execution_enabled = false;
    refreshed.next_step = "Session expired. Create a new autonomous session.";
    stopAutopilotLoop(sessionId);
  } else if (action === "pause") {
    refreshed.status = "paused";
    refreshed.execution_enabled = false;
    refreshed.next_step = "Autopilot paused.";
    stopAutopilotLoop(sessionId);
  } else if (action === "resume") {
    const ready = readyVenues(refreshed);
    refreshed.status = ready.length ? "running" : "pending_funding";
    refreshed.execution_enabled = ready.length > 0;
    refreshed.next_step = ready.length
      ? "Autonomous worker is running."
      : "Fund an isolated venue vault before live execution.";
    if (recipient && ready.length) startAutopilotLoop({ sessionId, state, recipient });
  }
  refreshed.updated_at = now.toISOString();
  await state.putAutopilotSession(refreshed);
  const event = await appendEvent(state, refreshed, "session_state", `Autopilot ${action}.`, { action }, now);
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

export async function runAutopilotTick({
  sessionId,
  state,
  recipient,
  now = new Date(),
  fetchImpl = fetch,
  env = process.env,
}) {
  const stored = await state.getAutopilotSession(sessionId);
  if (!stored) return { ok: false, error: "autopilot_session_not_found" };
  const session = refreshSession(stored, now);
  if (session.status !== "running" || !session.execution_enabled) {
    await state.putAutopilotSession(session);
    return { ok: false, error: "autopilot_not_running" };
  }
  if (session.last_execution_at) {
    const elapsed = now.getTime() - new Date(session.last_execution_at).getTime();
    if (elapsed < session.session_policy.cooldown_ms) {
      session.last_tick_at = now.toISOString();
      await state.putAutopilotSession(session);
      await appendEvent(state, session, "guardrail", "Cooldown active; no trade attempted.", {
        cooldown_ms: session.session_policy.cooldown_ms,
        elapsed_ms: elapsed,
      }, now);
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

  let proposal;
  if (session.session_policy.ai_direct_enabled) {
    if (!aiDirectRuntimeEnabled(env)) {
      await appendEvent(state, session, "risk_reject", "AI-direct execution is disabled in worker configuration.", {
        required_env: "PRIVATE_AGENT_AI_DIRECT_ENABLED=true",
      }, now);
      return { ok: false, error: "ai_direct_disabled" };
    }
    const budget = await reserveAiDecisionBudget({ state, session, env, now });
    if (!budget.ok) {
      await appendEvent(state, session, "risk_reject", "AI decision budget is exhausted for this hour.", {
        max_decisions_per_hour: budget.max,
      }, now);
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
      ? "AI direct order decision accepted by schema and confidence checks."
      : "AI direct order decision rejected before policy execution.", publicDecisionRecord(decision.record), now);
    if (!decision.ok) {
      await appendEvent(state, session, "risk_reject", "AI direct order was rejected before execution.", {
        error: decision.error,
        decision_id: decision.record.decision_id,
      }, now);
      return { ok: false, error: decision.error };
    }
    const built = buildAiDirectProposal(session, market, decision.decision, { now, positions });
    if (!built.ok) {
      await appendEvent(state, session, "risk_reject", built.message, {
        ...built.data,
        decision_id: decision.record.decision_id,
      }, now);
      return { ok: false, error: built.error };
    }
    proposal = { ...built, decision_id: decision.record.decision_id };
    await appendEvent(state, session, "proposal", "AI direct order decision validated into a bounded proposal.", publicProposal(proposal), now);
    await appendEvent(state, session, "ai_score", "AI direct decision met the session confidence threshold.", {
      score_bps: decision.decision.confidence_bps,
      threshold_bps: session.session_policy.ai_min_confidence_bps,
      model: decision.record.model_id,
      decision_id: decision.record.decision_id,
    }, now);
  } else {
    proposal = buildMomentumProposal(session, market, { env, now });
    if (!proposal.ok) {
      await appendEvent(state, session, "guardrail", proposal.message, proposal.data, now);
      return { ok: false, error: proposal.error };
    }
    await appendEvent(state, session, "proposal", "Momentum micro-trader proposed a bounded order.", publicProposal(proposal), now);

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
      return { ok: false, error: "ai_score_below_threshold" };
    }
  }
  if (env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await appendEvent(state, session, "guardrail", "Live submit gate is disabled.", {
      required_env: "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=true",
    }, now);
    return { ok: false, error: "live_submit_disabled" };
  }

  const workOrderCommitment = `autopilot_work_order_${digest({
    session: session.autopilot_session_id,
    proposal: proposal.proposal_commitment,
    tick: now.toISOString(),
  })}`;
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
  const updated = await state.getAutopilotSession(sessionId) || session;
  updated.order_count = Number(updated.order_count || 0) + 1;
  updated.last_execution_at = now.toISOString();
  updated.daily_notional_used_bucket = String(
    Math.min(bucketToUsd(updated.session_policy.max_daily_notional_bucket), (
      Number(updated.daily_notional_used_bucket || 0) + proposal.notional_usd
    )),
  );
  updated.updated_at = now.toISOString();
  await state.putAutopilotSession(updated);
  await appendEvent(state, updated, "execution", "Autopilot submitted a bounded live order.", {
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    work_order_commitment: workOrderCommitment,
  }, now);
  await appendEvent(state, updated, "live_order_submitted", "Worker submitted a bounded venue order.", {
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    decision_id: proposal.decision_id || null,
    work_order_commitment: workOrderCommitment,
  }, now);
  await appendEvent(state, updated, "receipt", "Venue receipt recorded.", {
    venue_id: proposal.venue_id,
    status: receipt.status,
    work_order_commitment: receipt.work_order_commitment,
    provider_ref_commitment: receipt.provider_ref_commitment,
    result_commitment: receipt.result_commitment,
    final_proof: receipt.final_proof || null,
  }, now);
  const position = await state.putAutopilotPosition(sessionId, {
    venue_id: proposal.venue_id,
    market: proposal.market,
    side: proposal.side,
    estimated_exposure_notional_usd: proposal.notional_usd,
    last_order_notional_usd: proposal.notional_usd,
    last_work_order_commitment: workOrderCommitment,
    source: "autopilot_execution_receipt",
  });
  await appendEvent(state, updated, "venue_reconcile", "Venue receipt reconciled into native autopilot state.", {
    venue_id: proposal.venue_id,
    status: receipt.status,
    work_order_commitment: receipt.work_order_commitment,
    position: publicPosition(position),
  }, now);
  return { ok: true, receipt, proposal };
}

function normalizeAutopilotPolicy(raw, now) {
  const venues = unique(array(raw.venue_allowlist)
    .map((venue) => stringValue(venue).toLowerCase())
    .filter((venue) => SUPPORTED_VENUES.has(venue)));
  const markets = unique(array(raw.market_allowlist)
    .map(normalizeMarket)
    .filter((market) => SUPPORTED_MARKETS.has(market)));
  const ttlMs = clampInt(raw.ttl_ms, 5 * 60_000, 4 * 60 * 60_000, 2 * 60 * 60_000);
  const strategyId = stringValue(raw.strategy_id) === "hedged_spread_arbitrage_v1"
    ? "hedged_spread_arbitrage_v1"
    : "momentum_micro_trader";
  const aiDirectEnabled = strategyId !== "hedged_spread_arbitrage_v1" &&
    (raw.ai_direct_enabled === true || stringValue(raw.decision_model) === "ai_direct_order_v1");
  const policy = {
    version: 2,
    strategy_id: strategyId,
    decision_model: aiDirectEnabled ? "ai_direct_order_v1" : "rules_plus_ai_score",
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
    allowed_order_types: ["swap", "spot_market_order", "spot_limit_order", "perp_limit_order", "limit_order", "cancel"],
    kill_switch: raw.kill_switch === true,
    reduce_only_on_reconcile_failure: raw.reduce_only_on_reconcile_failure !== false,
    locale_hint: localeHint(raw.locale_hint),
    timezone: stringValue(raw.timezone) || null,
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return {
    ...policy,
    policy_commitment: `autopilot_policy_${digest(policy)}`,
  };
}

function strategyForPolicy(policy) {
  if (policy.strategy_id === "hedged_spread_arbitrage_v1") {
    return {
      version: 1,
      strategy_id: "hedged_spread_arbitrage_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_arb_planner",
      ai_can_execute_directly: true,
    };
  }
  if (policy.ai_direct_enabled) {
    return {
      version: 1,
      strategy_id: "momentum_micro_trader",
      decision_model: "ai_direct_order_v1",
      executable_order_source: "ai_structured_decision_validated_by_policy",
      ai_can_execute_directly: true,
    };
  }
  return {
    version: 1,
    strategy_id: "momentum_micro_trader",
    decision_model: "rules_plus_ai_score",
    executable_order_source: "deterministic_guarded_strategy",
    ai_can_execute_directly: false,
  };
}

function normalizeVenueAccess(raw, policy) {
  const dryRunReady = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" ||
    process.env.PRIVATE_AGENT_AUTOPILOT_ASSUME_FUNDED === "true";
  const out = {};
  for (const venue of policy.venue_allowlist) {
    const value = raw?.[venue] || raw?.[venue.replace("_advanced", "")] || null;
    if (value && typeof value === "object") {
      out[venue] = {
        status: value.status === "ready" || value.encrypted_execution_vault || value.execution_mode === "ghola_pooled"
          ? "ready"
          : value.status || "needs_funds",
        execution_mode: value.execution_mode || defaultExecutionMode(venue),
        vault_commitment: value.vault_commitment || null,
        encrypted_vault_commitment: value.encrypted_vault_commitment || null,
        encrypted_execution_vault: value.encrypted_execution_vault || null,
        allocation_commitment: value.allocation_commitment || value.managed_allocation_commitment || null,
        managed_allocation_commitment: value.managed_allocation_commitment || null,
        omnibus_allocation: value.omnibus_allocation || null,
        reason: value.reason || null,
      };
    } else {
      out[venue] = {
        status: dryRunReady ? "ready" : "needs_funds",
        execution_mode: dryRunReady ? defaultExecutionMode(venue) : null,
        reason: dryRunReady ? "dry_run_ready" : "isolated_vault_required",
      };
    }
  }
  return out;
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
  const venue = selectVenue(session, market);
  if (!venue) {
    return {
      ok: false,
      error: "venue_not_ready",
      message: "No venue is funded and ready for this market.",
      data: { venues: session.venue_access },
    };
  }
  const side = changeBps >= 0 ? "buy" : "sell";
  const price = Number(market.price || market.mid || 0);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "price_unavailable", message: "Price is unavailable; no trade attempted.", data: market };
  }
  const notional = Math.min(
    bucketToUsd(session.session_policy.max_notional_bucket),
    remainingDailyNotional(session),
  );
  if (notional <= 0) {
    return {
      ok: false,
      error: "daily_cap_exhausted",
      message: "Daily notional cap is exhausted; no trade attempted.",
      data: { max_daily_notional_bucket: session.session_policy.max_daily_notional_bucket },
    };
  }
  const instruction = instructionForVenue({ venue, market, side, price, notional, policy: session.session_policy, now });
  return {
    ok: true,
    proposal_commitment: `autopilot_proposal_${digest({ session: session.autopilot_session_id, venue, market, side, notional, now: now.toISOString() })}`,
    venue_id: venue,
    operation_class: instruction.operation_class,
    market: market.product_id,
    side,
    notional_usd: notional,
    signal_bps: changeBps,
    instruction,
  };
}

function buildAiDirectProposal(session, market, decision, { now, positions = [] }) {
  if (decision.action !== "trade") {
    return {
      ok: false,
      error: `ai_decision_${decision.action}`,
      message: "AI direct decision did not request a trade.",
      data: { action: decision.action, reason_codes: decision.reason_codes },
    };
  }
  const venue = stringValue(decision.venue_id).toLowerCase();
  if (!readyVenues(session).includes(venue)) {
    return {
      ok: false,
      error: "venue_not_ready",
      message: "AI selected a venue that is not ready.",
      data: { venue_id: venue },
    };
  }
  const operationClass = stringValue(decision.operation_class);
  if (!operationAllowedForVenue(venue, operationClass)) {
    return {
      ok: false,
      error: "ai_operation_not_allowed",
      message: "AI selected an operation that is not allowed for the venue.",
      data: { venue_id: venue, operation_class: operationClass },
    };
  }
  if (!session.session_policy.allowed_order_types.includes(operationClass)) {
    return {
      ok: false,
      error: "ai_operation_outside_policy",
      message: "AI selected an operation outside the session policy.",
      data: { operation_class: operationClass },
    };
  }
  const side = decision.side === "buy" || decision.side === "sell" ? decision.side : null;
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
  if (venue === "jupiter" && decisionMarket !== "SOL-USD" && decisionMarket !== "SOL/USDC") {
    return {
      ok: false,
      error: "ai_jupiter_market_unsupported",
      message: "Jupiter autonomous swaps are limited to SOL markets in this release.",
      data: { market: decisionMarket },
    };
  }
  const price = Number(decision.limit_price || market.price || market.mid || 0);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      error: "price_unavailable",
      message: "AI trade decision could not be priced.",
      data: { market: decisionMarket },
    };
  }
  const notional = Number(decision.quote_size_usd);
  if (!Number.isFinite(notional) || notional <= 0) {
    return {
      ok: false,
      error: "ai_trade_quote_size_required",
      message: "AI trade decision did not include a positive quote size.",
      data: {},
    };
  }
  const maxOrderNotional = bucketToUsd(session.session_policy.max_notional_bucket);
  if (maxOrderNotional > 0 && notional > maxOrderNotional) {
    return {
      ok: false,
      error: "ai_notional_exceeds_order_cap",
      message: "AI trade decision exceeded the per-order notional cap.",
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
    const nextExposure = side === "sell"
      ? Math.max(0, currentExposure - notional)
      : currentExposure + notional;
    if (nextExposure > maxPositionNotional) {
      return {
        ok: false,
        error: "ai_position_cap_exceeded",
        message: "AI trade decision exceeded the position notional cap.",
        data: {
          quote_size_usd: notional,
          current_exposure_notional_usd: currentExposure,
          max_position_notional_bucket: session.session_policy.max_position_notional_bucket,
        },
      };
    }
  }
  if (
    Number.isInteger(decision.max_slippage_bps) &&
    decision.max_slippage_bps > session.session_policy.max_slippage_bps
  ) {
    return {
      ok: false,
      error: "ai_slippage_exceeds_policy",
      message: "AI trade decision exceeded the session slippage policy.",
      data: {
        max_slippage_bps: decision.max_slippage_bps,
        policy_max_slippage_bps: session.session_policy.max_slippage_bps,
      },
    };
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
    now,
  });
  instruction.operation_class = operationClass;
  if (instruction.order) {
    if (Number.isInteger(decision.max_slippage_bps)) {
      instruction.order.max_slippage_bps = String(decision.max_slippage_bps);
    }
    if (operationClass === "spot_limit_order") {
      if (!decision.limit_price) {
        return {
          ok: false,
          error: "ai_limit_price_required",
          message: "AI spot limit order requires a limit price.",
          data: { venue_id: venue, operation_class: operationClass },
        };
      }
      instruction.order.order_type = "limit";
      instruction.order.limit_price = trim(decision.limit_price);
      instruction.order.tif = timeInForceForVenue(decision.time_in_force, venue);
    } else if (operationClass === "spot_market_order") {
      instruction.order.order_type = "market";
      instruction.order.tif = timeInForceForVenue(decision.time_in_force, venue);
      delete instruction.order.limit_price;
    } else if ((operationClass === "limit_order" || operationClass === "perp_limit_order") && decision.limit_price) {
      instruction.order.limit_price = trim(decision.limit_price);
      instruction.order.tif = timeInForceForVenue(decision.time_in_force, venue);
    }
  }
  return {
    ok: true,
    proposal_commitment: `autopilot_proposal_${digest({
      session: session.autopilot_session_id,
      decision,
      venue,
      market: productId,
      now: now.toISOString(),
    })}`,
    decision_id: decision.decision_id || null,
    decision_source: "ai_direct_order_v1",
    venue_id: venue,
    operation_class: operationClass,
    market: productId,
    side,
    notional_usd: notional,
    signal_bps: 0,
    confidence_bps: decision.confidence_bps,
    instruction,
  };
}

function instructionForVenue({ venue, market, side, price, notional, policy, now }) {
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
        routing_mode: "meta_aggregator",
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
      market: baseMarket(market.product_id),
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
  if (ready.includes("hyperliquid")) return "hyperliquid";
  return ready[0] || null;
}

function operationAllowedForVenue(venue, operationClass) {
  if (venue === "jupiter") return operationClass === "swap";
  if (venue === "coinbase_advanced") {
    return operationClass === "spot_market_order" || operationClass === "spot_limit_order";
  }
  if (venue === "phoenix") return operationClass === "perp_limit_order";
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
  const max = Number.parseInt(String(env.PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR ?? "12"), 10);
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
      ? "AI scorer accepted the deterministic momentum proposal."
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

function readyVenues(session) {
  return session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
}

function primaryProduct(session) {
  const markets = session.session_policy.market_allowlist;
  const product = markets.find((market) => market.endsWith("-USD")) || "SOL-USD";
  return ["BTC-USD", "ETH-USD", "SOL-USD"].includes(product) ? product : "SOL-USD";
}

function publicSession(session) {
  return JSON.parse(JSON.stringify(session));
}

function publicProposal(proposal) {
  return {
    proposal_commitment: proposal.proposal_commitment,
    decision_id: proposal.decision_id || null,
    decision_source: proposal.decision_source || "deterministic_guarded_strategy",
    venue_id: proposal.venue_id,
    operation_class: proposal.operation_class,
    market: proposal.market,
    side: proposal.side,
    notional_bucket: String(proposal.notional_usd),
    signal_bps: proposal.signal_bps,
    confidence_bps: proposal.confidence_bps || null,
  };
}

function publicPosition(position) {
  return {
    venue_id: position.venue_id || null,
    market: position.market || null,
    side: position.side || null,
    estimated_exposure_notional_bucket: String(position.estimated_exposure_notional_usd ?? position.notional_usd ?? "0"),
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

function defaultExecutionMode(venue) {
  if (venue === "coinbase_advanced") return "partner_omnibus";
  if (venue === "hyperliquid") return "ghola_pooled";
  return "ghola_pooled";
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
