import { createHash } from "node:crypto";
import {
  SUPPORTED_EXECUTION_VENUES,
  executionVenueSpec,
  supportsExactQuantityRecovery,
  venueSupportsProduct,
} from "@ghola/execution-core";
import {
  applyDurableMultiLegEvent,
  createDurableMultiLegSaga,
} from "./multi-leg-orchestrator.js";
import { evaluateAutopilotMultiLegPlan } from "./portfolio-risk.js";

const SUPPORTED_MARKETS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
const CARRY_STRATEGY = "delta_neutral_carry_v1";
const PORTFOLIO_CONTRACT_VENUES = new Set(SUPPORTED_EXECUTION_VENUES);
const DEFAULT_FEE_BPS = {
  coinbase_advanced: 60,
  hyperliquid: 5,
  phoenix: 5,
  backpack: 5,
  jupiter: 10,
};

export function isArbitrageSession(session) {
  return session?.session_policy?.strategy_id === "hedged_spread_arbitrage_v1" ||
    session?.strategy?.strategy_id === "hedged_spread_arbitrage_v1" ||
    session?.session_policy?.strategy_id === CARRY_STRATEGY ||
    session?.strategy?.strategy_id === CARRY_STRATEGY;
}

export function isCarrySession(session) {
  return session?.session_policy?.strategy_id === CARRY_STRATEGY ||
    session?.strategy?.strategy_id === CARRY_STRATEGY;
}

export async function runGuardedArbitrageTick({
  session,
  state,
  recipient,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  appendEvent,
  executeOrder,
  verifyOrder,
}) {
  const carryMode = isCarrySession(session);
  const markets = session.session_policy.market_allowlist.filter((market) => SUPPORTED_MARKETS.has(normalizeMarket(market)));
  await appendEvent(state, session, carryMode ? "carry_scan" : "arb_scan", carryMode
    ? "Delta-neutral funding carry scan started."
    : "Guarded hedged-spread scan started.", {
    markets,
    venue_allowlist: session.session_policy.venue_allowlist,
  }, now);

  const activeCarryPositions = carryMode
    ? (await state.listAutopilotPositions(session.autopilot_session_id)).filter((position) =>
        position.strategy_id === CARRY_STRATEGY && Math.abs(Number(position.signed_notional_micro_usdc || 0)) > 0
      )
    : [];
  if (activeCarryPositions.length > 0 && activeCarryPositions.every((position) => Date.parse(position.exit_due_at || "") > now.getTime())) {
    const exitDueAt = activeCarryPositions
      .map((position) => position.exit_due_at)
      .filter(Boolean)
      .sort()[0] || null;
    await appendEvent(state, session, "carry_hold", "Existing delta-neutral carry remains inside its signed holding window.", {
      protected_pair_id: activeCarryPositions[0].protected_pair_id || null,
      exit_due_at: exitDueAt,
    }, now);
    return { ok: true, action: "hold", reason: "carry_position_active", exit_due_at: exitDueAt };
  }
  const opportunity = carryMode && activeCarryPositions.length > 0
    ? await bestCarryExitOpportunity({ session, positions: activeCarryPositions, env, fetchImpl, now })
    : carryMode
      ? await bestCarryOpportunity({ session, env, fetchImpl, now })
      : await bestArbitrageOpportunity({ session, env, fetchImpl, now });
  await state.appendAutopilotOpportunity?.(session.autopilot_session_id, publicOpportunity(opportunity));

  if (!opportunity.ok) {
    const exitBlocked = carryMode && activeCarryPositions.length > 0;
    await appendEvent(state, session, exitBlocked ? "carry_exit_blocked" : "arb_reject", opportunity.message, opportunity.data, now);
    if (exitBlocked) {
      await state.putAutopilotSession({
        ...session,
        status: "paused",
        execution_enabled: false,
        next_step: "Carry exit requires reconciliation or exact-quantity recovery; risk increases remain paused.",
        updated_at: now.toISOString(),
      });
    }
    return { ok: false, error: opportunity.error };
  }
  const buyLegNotionalUsd = Number(opportunity.buy_leg_notional_usd || opportunity.leg_notional_usd);
  const sellLegNotionalUsd = Number(opportunity.sell_leg_notional_usd || opportunity.leg_notional_usd);
  const pairNotionalUsd = buyLegNotionalUsd + sellLegNotionalUsd;

  await appendEvent(state, session, opportunity.risk_reducing === true ? "carry_exit_ready" : "arb_opportunity",
    opportunity.risk_reducing === true
      ? "Exact-quantity carry exit passed deterministic screening."
      : "Protected-pair opportunity passed deterministic screening.", publicOpportunity(opportunity), now);

  const pairVenues = [opportunity.buy_venue, opportunity.sell_venue];
  const portfolioContractPair = pairVenues.every((venue) => PORTFOLIO_CONTRACT_VENUES.has(venue));
  const liveRecoveryPair = pairVenues.every(supportsExactQuantityRecovery);
  if ((!portfolioContractPair || !liveRecoveryPair) && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    const reason = !portfolioContractPair
      ? "portfolio_venue_contract_unavailable"
      : "exact_quantity_recovery_unavailable";
    await appendEvent(state, session, "arb_reject", "A live leg lacks the normalized accounting or exact-quantity recovery contract.", {
      reason_codes: [reason],
      venues: pairVenues,
    }, now);
    return { ok: false, error: reason };
  }
  if (portfolioContractPair) {
    const positions = await state.listAutopilotPositions(session.autopilot_session_id);
    const portfolioRisk = evaluateAutopilotMultiLegPlan({
      session,
      positions,
      strategy_id: carryMode ? "delta_neutral_carry" : "spot_perp_hedge",
      expected_gross_benefit_bps: opportunity.gross_edge_bps,
      plan_commitment: opportunity.opportunity_id,
      legs: [
        riskLeg({
          venue: opportunity.buy_venue,
          market: opportunity.market,
          side: "buy",
          notionalUsd: buyLegNotionalUsd,
          basisBps: opportunity.basis_bps ?? opportunity.gross_edge_bps,
          reduceOnly: opportunity.risk_reducing === true,
          session,
          env,
        }),
        riskLeg({
          venue: opportunity.sell_venue,
          market: opportunity.market,
          side: "sell",
          notionalUsd: sellLegNotionalUsd,
          basisBps: opportunity.basis_bps ?? opportunity.gross_edge_bps,
          reduceOnly: opportunity.risk_reducing === true,
          session,
          env,
        }),
      ],
      now,
      env,
    });
    if (!portfolioRisk.allowed) {
      await appendEvent(state, session, "arb_reject", "Portfolio-wide mandate rejected the protected pair.", {
        reason_codes: portfolioRisk.reasons,
        metrics: portfolioRisk.metrics,
      }, now);
      return { ok: false, error: portfolioRisk.reasons[0] || "portfolio_risk_rejected" };
    }
  }

  const config = carryMode
    ? opportunity.risk_reducing === true
      ? enforceProtectedExitConfig({ env })
      : enforceCarryLiveConfig({ session, env, requestedNotionalUsd: Math.max(buyLegNotionalUsd, sellLegNotionalUsd) })
    : enforceArbitrageLiveConfig({ session, env, requestedNotionalUsd: Math.max(buyLegNotionalUsd, sellLegNotionalUsd) });
  if (!config.ok) {
    await appendEvent(state, session, "arb_reject", "Protected-pair live config is not armed.", {
      reason_codes: config.reason_codes,
    }, now);
    return { ok: false, error: carryMode ? "carry_live_config_blocked" : "arb_live_config_blocked", reason_codes: config.reason_codes };
  }

  const dayKey = now.toISOString().slice(0, 10);
  const daily = opportunity.risk_reducing === true
    ? { ok: true }
    : await state.incrementPolicyAmount(
        `${carryMode ? "carry" : "arb"}_daily_notional:${session.session_policy.policy_commitment}:${dayKey}`,
        pairNotionalUsd,
        config.daily_cap_usd,
      );
  if (!daily.ok) {
    await appendEvent(state, session, "arb_reject", "Protected-pair daily notional cap exceeded.", {
      daily_cap_usd: config.daily_cap_usd,
    }, now);
    return { ok: false, error: carryMode ? "carry_daily_cap_exceeded" : "arb_daily_cap_exceeded" };
  }

  const liveSubmitEnabled = carryMode
    ? env.PRIVATE_AGENT_CARRY_LIVE_SUBMIT === "true"
    : env.PRIVATE_AGENT_ARB_LIVE_SUBMIT === "true";
  if (!liveSubmitEnabled && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await appendEvent(state, session, "arb_reject", "Protected-pair live submit gate is disabled.", {
      required_env: carryMode ? "PRIVATE_AGENT_CARRY_LIVE_SUBMIT=true" : "PRIVATE_AGENT_ARB_LIVE_SUBMIT=true",
    }, now);
    return { ok: false, error: "arb_live_submit_disabled" };
  }

  const pairCommitment = `arb_pair_${digest({ session: session.autopilot_session_id, opportunity: opportunity.opportunity_id, now: now.toISOString() })}`;
  const buyWorkOrder = `${pairCommitment}_buy`;
  const sellWorkOrder = `${pairCommitment}_sell`;
  const buyBaseSize = String(opportunity.buy_base_size || opportunity.paired_base_size ||
    trim(Math.min(buyLegNotionalUsd, sellLegNotionalUsd) / Math.max(opportunity.buy_price, opportunity.sell_price)));
  const sellBaseSize = String(opportunity.sell_base_size || opportunity.paired_base_size || buyBaseSize);
  const buyInstruction = instructionForLeg({
    venue: opportunity.buy_venue,
    market: opportunity.market,
    side: "buy",
    price: opportunity.buy_price,
    notional: buyLegNotionalUsd,
    baseSize: buyBaseSize,
    reduceOnly: opportunity.risk_reducing === true,
    policy: session.session_policy,
    now,
  });
  const sellInstruction = instructionForLeg({
    venue: opportunity.sell_venue,
    market: opportunity.market,
    side: "sell",
    price: opportunity.sell_price,
    notional: sellLegNotionalUsd,
    baseSize: sellBaseSize,
    reduceOnly: opportunity.risk_reducing === true,
    policy: session.session_policy,
    now,
  });
  const sagaId = `saga:arb:${digest({ pairCommitment }).slice(0, 40)}`;
  const sagaCreated = await createDurableMultiLegSaga({
    state,
    definition: {
      version: 1,
      saga_id: sagaId,
      idempotency_key: `idem:arb:${digest({ pairCommitment }).slice(0, 40)}`,
      plan_commitment: `plan:arb:${digest({ pairCommitment, opportunity: opportunity.opportunity_id }).slice(0, 40)}`,
      strategy_id: carryMode ? "delta_neutral_carry" : "hedged_spread_arbitrage",
      max_unhedged_ms: config.max_execution_skew_ms,
      max_hedge_error_micro_usdc: config.max_hedge_error_micro_usdc,
      now_ms: now.getTime(),
      legs: [
        sagaLeg({ sagaId, id: "buy", venue: opportunity.buy_venue, market: opportunity.market, side: "buy", notional: buyLegNotionalUsd }),
        sagaLeg({ sagaId, id: "sell", venue: opportunity.sell_venue, market: opportunity.market, side: "sell", notional: sellLegNotionalUsd }),
      ],
    },
    execution_context: {
      version: 1,
      autopilot_session_id: session.autopilot_session_id,
      policy_commitment: session.session_policy.policy_commitment,
      legs: [
        { leg_id: `${sagaId}:buy`, work_order_commitment: buyWorkOrder, instruction: buyInstruction },
        { leg_id: `${sagaId}:sell`, work_order_commitment: sellWorkOrder, instruction: sellInstruction },
      ],
    },
  });
  if (!sagaCreated.ok) {
    await appendEvent(state, session, "arb_reject", "Durable protected-leg state could not be created.", {
      pair_commitment: pairCommitment,
      error: sagaCreated.error,
    }, now);
    return { ok: false, error: "arb_saga_create_failed" };
  }
  let preflightReceipts;
  try {
    const started = Date.now();
    const preflight = Promise.all([
      verifyOrder({
        venue_id: opportunity.buy_venue,
        operation_class: operationForVenue(opportunity.buy_venue),
        work_order_commitment: `${buyWorkOrder}_preflight`,
        policy_commitment: session.session_policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction: buyInstruction,
        execution: executionForVenue(session, opportunity.buy_venue),
        recipient,
        state,
      }),
      verifyOrder({
        venue_id: opportunity.sell_venue,
        operation_class: operationForVenue(opportunity.sell_venue),
        work_order_commitment: `${sellWorkOrder}_preflight`,
        policy_commitment: session.session_policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction: sellInstruction,
        execution: executionForVenue(session, opportunity.sell_venue),
        recipient,
        state,
      }),
    ]);
    preflightReceipts = await withTimeout(preflight, config.max_execution_skew_ms, "arb_pair_preflight_timeout");
    const latencyMs = Date.now() - started;
    if (latencyMs > config.max_execution_skew_ms) throw new Error("arb_pair_preflight_skew_exceeded");
  } catch (error) {
    await applySagaEvent(state, sagaId, "preflight_failed", {
      leg_id: `${sagaId}:buy`,
      failure_code: "preflight_failed",
    }, now.getTime());
    await appendEvent(state, session, "arb_reject", "Arbitrage pair preflight failed before submit.", {
      pair_commitment: pairCommitment,
      error: String(error?.message || "preflight_failed"),
    }, now);
    return { ok: false, error: "arb_pair_preflight_failed" };
  }
  await applySagaEvent(state, sagaId, "preflight_passed", { leg_id: `${sagaId}:buy` }, now.getTime());
  await applySagaEvent(state, sagaId, "preflight_passed", { leg_id: `${sagaId}:sell` }, now.getTime());
  await appendEvent(state, session, "arb_pair_preflight", "Both arbitrage legs passed no-submit preflight.", {
    pair_commitment: pairCommitment,
    verifications: preflightReceipts.map((receipt) => ({
      venue_id: receipt.venue_id || (receipt.platform_class === "hyperliquid_style_market" ? "hyperliquid" : null),
      status: receipt.status,
      verification_commitment: receipt.verification_commitment,
      result_commitment: receipt.result_commitment,
    })),
    max_execution_skew_ms: config.max_execution_skew_ms,
  }, now);
  await applySagaEvent(state, sagaId, "submission_started", {}, now.getTime());
  const buyLeg = executeOrder({
    venue_id: opportunity.buy_venue,
    operation_class: operationForVenue(opportunity.buy_venue),
    work_order_commitment: buyWorkOrder,
    policy_commitment: session.session_policy.policy_commitment,
    session_policy: workerSessionPolicy(session),
    instruction: buyInstruction,
    execution: executionForVenue(session, opportunity.buy_venue),
    recipient,
    state,
  });
  const sellLeg = executeOrder({
    venue_id: opportunity.sell_venue,
    operation_class: operationForVenue(opportunity.sell_venue),
    work_order_commitment: sellWorkOrder,
    policy_commitment: session.session_policy.policy_commitment,
    session_policy: workerSessionPolicy(session),
    instruction: sellInstruction,
    execution: executionForVenue(session, opportunity.sell_venue),
    recipient,
    state,
  });

  let settled;
  try {
    const started = Date.now();
    settled = await withTimeout(Promise.allSettled([buyLeg, sellLeg]), config.max_execution_skew_ms, "arb_pair_submit_timeout");
    const latencyMs = Date.now() - started;
    if (latencyMs > config.max_execution_skew_ms) throw new Error("arb_pair_submit_skew_exceeded");
  } catch (error) {
    const activeSaga = await state.getMultiLegSaga(sagaId);
    await applySagaEvent(state, sagaId, "timeout", {}, activeSaga.unhedged_deadline_ms);
    await appendEvent(state, session, "arb_pair_compensating", "Pair outcome timed out; durable cancellation and unwind are required.", {
      pair_commitment: pairCommitment,
      saga_id: sagaId,
      error: String(error?.message || "leg_failed"),
    }, now);
    const paused = { ...session, status: "paused", execution_enabled: false, updated_at: now.toISOString() };
    await state.putAutopilotSession(paused);
    return { ok: false, error: "arb_pair_outcome_unknown", saga_id: sagaId };
  }

  const legOutcomes = [
    { leg_id: `${sagaId}:buy`, instruction: buyInstruction, result: settled[0] },
    { leg_id: `${sagaId}:sell`, instruction: sellInstruction, result: settled[1] },
  ];
  const receipts = [];
  for (const outcome of legOutcomes.filter((item) => item.result.status === "fulfilled")) {
    const receipt = outcome.result.value;
    receipts.push(receipt);
    await applySagaEvent(state, sagaId, "leg_acknowledged", {
      leg_id: outcome.leg_id,
      provider_ref_commitment: receipt.provider_ref_commitment || null,
    });
    const progress = receiptFillProgress({
      receipt,
      instruction: outcome.instruction,
      expectedMicroUsdc: outcome.leg_id.endsWith(":buy")
        ? Math.round(buyLegNotionalUsd * 1_000_000)
        : Math.round(sellLegNotionalUsd * 1_000_000),
      env,
    });
    if (progress.cumulative_filled_micro_usdc > 0) {
      await applySagaEvent(state, sagaId, "leg_fill", {
        leg_id: outcome.leg_id,
        cumulative_filled_micro_usdc: progress.cumulative_filled_micro_usdc,
      });
    }
    const expectedMicroUsdc = outcome.leg_id.endsWith(":buy")
      ? Math.round(buyLegNotionalUsd * 1_000_000)
      : Math.round(sellLegNotionalUsd * 1_000_000);
    if (progress.terminal && progress.cumulative_filled_micro_usdc < expectedMicroUsdc) {
      await applySagaEvent(state, sagaId, "cancel_confirmed", {
        leg_id: outcome.leg_id,
        cumulative_filled_micro_usdc: progress.cumulative_filled_micro_usdc,
      });
    }
  }
  for (const outcome of legOutcomes.filter((item) => item.result.status === "rejected")) {
    await applySagaEvent(state, sagaId, "leg_failed", {
      leg_id: outcome.leg_id,
      failure_code: "venue_submit_failed",
    });
  }

  let saga = await state.getMultiLegSaga(sagaId);
  if (saga.status === "reconciling") {
    for (const leg of saga.legs) await applySagaEvent(state, sagaId, "leg_reconciled", { leg_id: leg.leg_id });
    saga = await state.getMultiLegSaga(sagaId);
  }
  if (!saga.terminal || saga.status !== "reconciled") {
    await appendEvent(state, session, "arb_pair_compensating", "Pair was not proven fully hedged; execution paused for durable recovery.", {
      pair_commitment: pairCommitment,
      saga_id: sagaId,
      saga_status: saga.status,
      next_actions: saga.next_actions,
    }, now);
    const paused = { ...session, status: "paused", execution_enabled: false, updated_at: now.toISOString() };
    await state.putAutopilotSession(paused);
    return { ok: false, error: "arb_pair_not_reconciled", saga_id: sagaId, receipts };
  }

  await appendEvent(state, session, opportunity.risk_reducing === true ? "carry_exit_submitted" : "arb_pair_submitted",
    opportunity.risk_reducing === true
      ? "Worker submitted both exact-quantity carry exit legs."
      : "Worker submitted both bounded protected-pair legs.", {
    pair_commitment: pairCommitment,
    saga_id: sagaId,
    buy_venue: opportunity.buy_venue,
    sell_venue: opportunity.sell_venue,
    market: opportunity.market,
    pair_notional_bucket: String(pairNotionalUsd),
  }, now);

  await recordProtectedPairPositions({
    state,
    session,
    saga,
    receipts,
    carryMode,
    holdingHorizonHours: opportunity.holding_horizon_hours || 0,
    now,
  });

  const updated = await state.getAutopilotSession(session.autopilot_session_id) || session;
  updated.order_count = Number(updated.order_count || 0) + 2;
  updated.last_execution_at = now.toISOString();
  updated.daily_notional_used_bucket = String(
    Math.min(bucketToUsd(updated.session_policy.max_daily_notional_bucket), (
      Number(updated.daily_notional_used_bucket || 0) + (opportunity.risk_reducing === true ? 0 : pairNotionalUsd)
    )),
  );
  updated.updated_at = now.toISOString();
  await state.putAutopilotSession(updated);

  await appendEvent(state, updated, opportunity.risk_reducing === true ? "carry_exit_reconciled" : "arb_pair_reconciled",
    opportunity.risk_reducing === true
      ? "Both carry exit legs reconciled; protected exposure is closed."
      : "Both protected-pair legs reconciled into worker state.", {
    pair_commitment: pairCommitment,
    saga_id: sagaId,
    receipts: receipts.map((receipt) => ({
      venue_id: receipt.venue_id,
      status: receipt.status,
      work_order_commitment: receipt.work_order_commitment,
      provider_ref_commitment: receipt.provider_ref_commitment,
      result_commitment: receipt.result_commitment,
    })),
  }, now);

  return { ok: true, opportunity, receipts, saga_id: sagaId };
}

function sagaLeg({ sagaId, id, venue, market, side, notional }) {
  return {
    leg_id: `${sagaId}:${id}`,
    venue_id: venue,
    asset: baseMarket(market),
    market,
    product_type: executionVenueSpec(venue)?.primary_product || "perp",
    operation_class: operationForVenue(venue),
    side,
    notional_micro_usdc: Math.round(notional * 1_000_000),
  };
}

function riskLeg({ venue, market, side, notionalUsd, basisBps, reduceOnly = false, session, env }) {
  const productType = executionVenueSpec(venue)?.primary_product || "perp";
  return {
    venue_id: venue,
    asset: baseMarket(market),
    market,
    product_type: productType,
    operation_class: operationForVenue(venue),
    side,
    notional_micro_usdc: Math.round(notionalUsd * 1_000_000),
    leverage_x100: productType === "perp" ? session.portfolio_mandate?.configured_leverage_x100 || 100 : 100,
    liquidation_distance_bps: 100_000,
    reduce_only: reduceOnly,
    spread_bps: 0,
    slippage_bps: isCarrySession(session)
      ? boundedNonNegativeInt(env.PRIVATE_AGENT_CARRY_ESTIMATED_SLIPPAGE_BPS, 0, 1_000, 2)
      : Number(session.session_policy.max_slippage_bps || 0),
    fee_bps: isCarrySession(session) ? carryFeeBps(venue, env) : feeBps(venue, env),
    funding_bps_8h: 0,
    borrow_bps: 0,
    basis_bps: Math.abs(Number(basisBps || 0)),
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
}

async function recordProtectedPairPositions({ state, session, saga, receipts, carryMode, holdingHorizonHours, now }) {
  if (typeof state.putAutopilotPosition !== "function") return;
  const existing = await state.listAutopilotPositions(session.autopilot_session_id);
  for (const leg of saga.legs) {
    const receipt = receipts.find((item) => item.work_order_commitment ===
      saga.execution_context.legs.find((contextLeg) => contextLeg.leg_id === leg.leg_id)?.work_order_commitment);
    const prior = existing.find((position) =>
      position.venue_id === leg.venue_id && normalizeMarket(position.market) === normalizeMarket(leg.market)
    );
    const direction = leg.side === "sell" ? -1 : 1;
    const priorSigned = Number.isSafeInteger(prior?.signed_notional_micro_usdc)
      ? prior.signed_notional_micro_usdc
      : 0;
    const filledMicro = Number(leg.filled_micro_usdc || 0);
    const filledBase = Number.parseFloat(String(receipt?.final_proof?.filled_base_size || ""));
    const nextSigned = priorSigned + direction * filledMicro;
    const nextBase = Number.isFinite(filledBase)
      ? Number(prior?.signed_base_size || 0) + direction * filledBase
      : nextSigned === 0 ? 0 : prior?.signed_base_size ?? null;
    await state.putAutopilotPosition(session.autopilot_session_id, {
      venue_id: leg.venue_id,
      asset: leg.asset,
      market: leg.market,
      product_type: leg.product_type,
      side: direction < 0 ? "sell" : "buy",
      signed_notional_micro_usdc: nextSigned,
      estimated_exposure_notional_usd: Math.abs(nextSigned) / 1_000_000,
      signed_base_size: Math.abs(nextBase || 0) < 1e-12 ? 0 : nextBase,
      leverage_x100: leg.product_type === "perp" ? session.portfolio_mandate?.configured_leverage_x100 || 100 : 100,
      liquidation_distance_bps: leg.product_type === "perp" ? 100_000 : 100_000,
      strategy_id: carryMode ? CARRY_STRATEGY : "hedged_spread_arbitrage_v1",
      protected_pair_id: nextSigned === 0 ? prior?.protected_pair_id || saga.saga_id : saga.saga_id,
      closing_saga_id: nextSigned === 0 ? saga.saga_id : null,
      opened_at: prior?.opened_at || now.toISOString(),
      closed_at: nextSigned === 0 ? now.toISOString() : null,
      exit_due_at: carryMode && holdingHorizonHours > 0
        ? new Date(now.getTime() + holdingHorizonHours * 60 * 60_000).toISOString()
        : null,
      last_work_order_commitment: receipt?.work_order_commitment || null,
      source: "protected_pair_reconciliation",
    });
  }
}

async function applySagaEvent(state, sagaId, type, values = {}, nowMs = Date.now()) {
  const saga = await state.getMultiLegSaga(sagaId);
  if (!saga) throw new Error("arb_saga_missing");
  const result = await applyDurableMultiLegEvent({
    state,
    saga_id: sagaId,
    now_ms: Math.max(nowMs, saga.updated_at_ms),
    event: {
      version: 1,
      event_id: `event:arb:${sagaId.slice(-40)}:${saga.last_event_sequence + 1}:${type}:${values.leg_id || "pair"}`,
      sequence: saga.last_event_sequence + 1,
      type,
      ...values,
    },
  });
  if (!result.ok) throw new Error(result.error || "arb_saga_event_failed");
  return result.saga;
}

function receiptFillProgress({ receipt, instruction, expectedMicroUsdc, env }) {
  if (receipt?.status === "failed") return { terminal: true, cumulative_filled_micro_usdc: 0 };
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return { terminal: true, cumulative_filled_micro_usdc: expectedMicroUsdc };
  }
  const proof = receipt?.final_proof;
  const terminal = proof?.final_venue_execution_proven === true;
  const targetBase = Number.parseFloat(String(instruction?.order?.base_size || ""));
  const filledBase = Number.parseFloat(String(proof?.filled_base_size || ""));
  if (proof?.final_fill_proven === true) {
    if (Number.isFinite(targetBase) && targetBase > 0 && Number.isFinite(filledBase) && filledBase >= 0) {
      const ratio = Math.max(0, Math.min(1, filledBase / targetBase));
      return {
        terminal,
        cumulative_filled_micro_usdc: Math.round(expectedMicroUsdc * ratio),
      };
    }
    return { terminal, cumulative_filled_micro_usdc: expectedMicroUsdc };
  }
  const reported = Number(proof?.cumulative_filled_micro_usdc);
  const proportional = Number.isFinite(targetBase) && targetBase > 0 && Number.isFinite(filledBase) && filledBase >= 0
    ? Math.round(expectedMicroUsdc * Math.max(0, Math.min(1, filledBase / targetBase)))
    : 0;
  return {
    terminal,
    cumulative_filled_micro_usdc: Math.max(0, Math.min(expectedMicroUsdc, proportional || (Number.isSafeInteger(reported) ? reported : 0))),
  };
}

export async function bestArbitrageOpportunity({ session, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const snapshots = await marketSnapshots({ session, env, fetchImpl, now });
  const candidates = [];
  for (const market of session.session_policy.market_allowlist.map(normalizeMarket).filter((item) => SUPPORTED_MARKETS.has(item))) {
    for (const left of snapshots.filter((snap) => snap.market === market)) {
      for (const right of snapshots.filter((snap) => snap.market === market && snap.venue_id !== left.venue_id)) {
        if (!validPair(left.venue_id, right.venue_id)) continue;
        const buy = left.price <= right.price ? left : right;
        const sell = left.price <= right.price ? right : left;
        const grossEdgeBps = ((sell.price - buy.price) / buy.price) * 10_000;
        const costBps = feeBps(buy.venue_id, env) + feeBps(sell.venue_id, env) + Number(session.session_policy.max_slippage_bps || 0) * 2;
        const netEdgeBps = Math.round(grossEdgeBps - costBps);
        const marketDataSkewMs = Math.abs(new Date(left.fetched_at).getTime() - new Date(right.fetched_at).getTime());
        const reasonCodes = [
          ...(netEdgeBps >= minNetEdgeBps(session, env) ? [] : ["net_edge_below_threshold"]),
          ...(marketDataSkewMs <= maxMarketSkewMs(env) ? [] : ["market_data_skew_exceeded"]),
        ];
        const legNotionalUsd = Math.min(
          bucketToUsd(session.session_policy.max_notional_bucket),
          remainingDailyNotional(session),
          capUsd(env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD, Number.POSITIVE_INFINITY),
        );
        if (legNotionalUsd <= 0) reasonCodes.push("notional_cap_exhausted");
        candidates.push({
          version: 1,
          opportunity_id: `arbopp_${digest({ market, buy, sell, now: now.toISOString() }).slice(0, 24)}`,
          status: reasonCodes.length === 0 ? "ready" : "blocked",
          market,
          buy_venue: buy.venue_id,
          sell_venue: sell.venue_id,
          buy_price: buy.price,
          sell_price: sell.price,
          buy_fetched_at: buy.fetched_at,
          sell_fetched_at: sell.fetched_at,
          market_data_skew_ms: marketDataSkewMs,
          gross_edge_bps: Math.round(grossEdgeBps),
          estimated_cost_bps: Math.round(costBps),
          net_edge_bps: netEdgeBps,
          min_net_edge_bps: minNetEdgeBps(session, env),
          leg_notional_usd: legNotionalUsd,
          reason_codes: reasonCodes,
          created_at: now.toISOString(),
        });
      }
    }
  }
  const best = candidates.sort((a, b) => b.net_edge_bps - a.net_edge_bps)[0];
  if (!best) {
    return {
      ok: false,
      error: "arb_no_supported_pair",
      message: "No supported hedged venue pair is ready.",
      data: { snapshots: snapshots.map(publicSnapshot) },
    };
  }
  if (best.status !== "ready") {
    return {
      ok: false,
      error: best.reason_codes[0] || "arb_opportunity_blocked",
      message: "Best arbitrage opportunity did not pass policy.",
      data: publicOpportunity(best),
    };
  }
  return { ok: true, ...best };
}

export async function bestCarryOpportunity({ session, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const ready = readyVenues(session);
  const spotVenues = ready.filter((venue) =>
    venue === "coinbase_advanced" || (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && venue === "jupiter")
  );
  if (!ready.includes("hyperliquid") || spotVenues.length === 0) {
    return {
      ok: false,
      error: "carry_no_supported_pair",
      message: "Funding carry requires a ready user spot account and Hyperliquid execution wallet.",
      data: { ready_venues: ready },
    };
  }
  const markets = session.session_policy.market_allowlist
    .map(normalizeMarket)
    .filter((market) => SUPPORTED_MARKETS.has(market));
  const observations = env.PRIVATE_AGENT_CARRY_SIGNAL_MODE === "force"
    ? forcedCarryObservations({ markets, spotVenues, env, now })
    : await liveCarryObservations({ markets, spotVenues, env, fetchImpl, now });
  const horizonHours = boundedPositiveInt(env.PRIVATE_AGENT_CARRY_HORIZON_HOURS, 1, 168, 24);
  const minSamples = boundedPositiveInt(env.PRIVATE_AGENT_CARRY_MIN_FUNDING_SAMPLES, 1, 168, 8);
  const slippageBps = boundedNonNegativeInt(env.PRIVATE_AGENT_CARRY_ESTIMATED_SLIPPAGE_BPS, 0, 1_000, 2);
  const safetyBufferBps = boundedNonNegativeInt(env.PRIVATE_AGENT_CARRY_SAFETY_BUFFER_BPS, 0, 5_000, 5);
  const maxBasisBps = Math.min(
    Number(session.portfolio_mandate?.max_basis_bps ?? 500),
    boundedNonNegativeInt(env.PRIVATE_AGENT_CARRY_MAX_BASIS_BPS, 0, 10_000, 500),
  );
  const sessionExpiresAt = Date.parse(session.expires_at || session.session_policy.expires_at || "");
  const requiredExitBy = now.getTime() + horizonHours * 60 * 60_000 +
    capMs(env.PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS, 2_000);
  const candidates = observations.map((observation) => {
    const hourlyRates = observation.funding_history_hourly_bps.filter(Number.isFinite);
    const currentHourlyBps = observation.current_funding_hourly_bps;
    const conservativeHourlyBps = hourlyRates.length >= minSamples
      ? Math.min(currentHourlyBps, percentile(hourlyRates, 0.25))
      : Number.NEGATIVE_INFINITY;
    const projectedFundingBps = Number.isFinite(conservativeHourlyBps)
      ? Math.floor(conservativeHourlyBps * horizonHours)
      : 0;
    const basisBps = Math.round(((observation.perp_price - observation.spot_price) / observation.spot_price) * 10_000);
    const roundTripFeeBps = 2 * (carryFeeBps(observation.spot_venue, env) + carryFeeBps("hyperliquid", env));
    const roundTripSlippageBps = 4 * slippageBps;
    const estimatedCostBps = roundTripFeeBps + roundTripSlippageBps + safetyBufferBps;
    const netEdgeBps = projectedFundingBps - estimatedCostBps;
    const reasonCodes = [
      ...(currentHourlyBps > 0 ? [] : ["funding_not_positive"]),
      ...(hourlyRates.length >= minSamples ? [] : ["funding_history_insufficient"]),
      ...(conservativeHourlyBps > 0 ? [] : ["funding_not_persistent"]),
      ...(Math.abs(basisBps) <= maxBasisBps ? [] : ["basis_limit"]),
      ...(netEdgeBps >= carryMinNetEdgeBps(session, env) ? [] : ["net_edge_below_threshold"]),
      ...(!Number.isFinite(sessionExpiresAt) || sessionExpiresAt > requiredExitBy
        ? []
        : ["session_expiry_before_carry_exit"]),
    ];
    const legNotionalUsd = Math.min(
      bucketToUsd(session.session_policy.max_notional_bucket),
      remainingDailyNotional(session),
      capUsd(env.PRIVATE_AGENT_CARRY_MAX_LEG_NOTIONAL_USD, Number.POSITIVE_INFINITY),
    );
    if (legNotionalUsd <= 0) reasonCodes.push("notional_cap_exhausted");
    return {
      version: 1,
      opportunity_id: `carryopp_${digest({ observation, horizonHours, now: now.toISOString() }).slice(0, 24)}`,
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      strategy_id: CARRY_STRATEGY,
      market: observation.market,
      buy_venue: observation.spot_venue,
      sell_venue: "hyperliquid",
      buy_price: observation.spot_price,
      sell_price: observation.perp_price,
      buy_fetched_at: observation.fetched_at,
      sell_fetched_at: observation.fetched_at,
      market_data_skew_ms: 0,
      gross_edge_bps: projectedFundingBps,
      projected_funding_bps: projectedFundingBps,
      current_funding_hourly_bps: currentHourlyBps,
      conservative_funding_hourly_bps: Number.isFinite(conservativeHourlyBps) ? conservativeHourlyBps : null,
      funding_sample_count: hourlyRates.length,
      holding_horizon_hours: horizonHours,
      basis_bps: basisBps,
      estimated_cost_bps: estimatedCostBps,
      net_edge_bps: netEdgeBps,
      min_net_edge_bps: carryMinNetEdgeBps(session, env),
      leg_notional_usd: legNotionalUsd,
      reason_codes: [...new Set(reasonCodes)],
      created_at: now.toISOString(),
    };
  });
  const best = candidates.sort((left, right) => right.net_edge_bps - left.net_edge_bps)[0];
  if (!best) {
    return {
      ok: false,
      error: "carry_market_data_unavailable",
      message: "Fresh spot, perp, and funding history were not all available.",
      data: {},
    };
  }
  if (best.status !== "ready") {
    return {
      ok: false,
      error: best.reason_codes[0] || "carry_opportunity_blocked",
      message: "Funding carry was not positive after conservative round-trip costs and risk buffers.",
      data: publicOpportunity(best),
    };
  }
  return { ok: true, ...best };
}

export async function bestCarryExitOpportunity({
  session,
  positions,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
}) {
  const active = Array.isArray(positions)
    ? positions.filter((position) => Math.abs(Number(position?.signed_notional_micro_usdc || 0)) > 0)
    : [];
  const spot = active.filter((position) =>
    position.product_type === "spot" && Number(position.signed_notional_micro_usdc) > 0
  );
  const perp = active.filter((position) =>
    position.product_type === "perp" && Number(position.signed_notional_micro_usdc) < 0
  );
  if (spot.length !== 1 || perp.length !== 1) {
    return carryExitFailure("carry_position_structure_invalid", "Carry exit requires one reconciled long spot leg and one short perp leg.", {
      active_position_count: active.length,
    });
  }
  const spotPosition = spot[0];
  const perpPosition = perp[0];
  const market = normalizeMarket(spotPosition.market);
  if (
    market !== normalizeMarket(perpPosition.market) ||
    baseMarket(market) !== baseMarket(perpPosition.market) ||
    (spotPosition.protected_pair_id && perpPosition.protected_pair_id &&
      spotPosition.protected_pair_id !== perpPosition.protected_pair_id)
  ) {
    return carryExitFailure("carry_position_pair_mismatch", "Carry legs do not share one reconciled market and protected-pair identity.", {});
  }
  const dryRun = env.PRIVATE_AGENT_VENUE_DRY_RUN === "true";
  if (!dryRun && ![spotPosition.venue_id, perpPosition.venue_id].every(supportsExactQuantityRecovery)) {
    return carryExitFailure("exact_quantity_recovery_unavailable", "Live carry exit is limited to venues with proven exact-quantity recovery.", {
      venues: [spotPosition.venue_id, perpPosition.venue_id],
    });
  }
  const spotNotionalUsd = Math.abs(Number(spotPosition.signed_notional_micro_usdc)) / 1_000_000;
  const perpNotionalUsd = Math.abs(Number(perpPosition.signed_notional_micro_usdc)) / 1_000_000;
  if (!(spotNotionalUsd > 0) || !(perpNotionalUsd > 0)) {
    return carryExitFailure("carry_position_notional_invalid", "Carry position notionals are unavailable for exact exit.", {});
  }

  const force = env.PRIVATE_AGENT_CARRY_SIGNAL_MODE === "force";
  let spotPrice;
  let perpPrice;
  if (force) {
    spotPrice = capUsd(env.PRIVATE_AGENT_CARRY_FORCE_SPOT_PRICE, 100);
    perpPrice = capUsd(env.PRIVATE_AGENT_CARRY_FORCE_PERP_PRICE, spotPrice);
  } else {
    [spotPrice, perpPrice] = await Promise.all([
      fetchVenuePrice({ venue: spotPosition.venue_id, market, fetchImpl }),
      fetchCarryPerpMark({ market, env, fetchImpl }),
    ]).catch(() => [null, null]);
  }
  if (!(spotPrice > 0) || !(perpPrice > 0)) {
    return carryExitFailure("carry_exit_market_data_unavailable", "Fresh spot and perp marks are required before closing carry.", {});
  }

  const recordedSpotBase = Math.abs(Number(spotPosition.signed_base_size));
  const recordedPerpBase = Math.abs(Number(perpPosition.signed_base_size));
  if (!dryRun && (!(recordedSpotBase > 0) || !(recordedPerpBase > 0))) {
    return carryExitFailure("carry_exact_exit_quantity_unavailable", "Final venue fill proof did not preserve exact base quantities for live exit.", {});
  }
  const spotBase = recordedSpotBase > 0 ? recordedSpotBase : spotNotionalUsd / spotPrice;
  const perpBase = recordedPerpBase > 0 ? recordedPerpBase : perpNotionalUsd / perpPrice;
  const basisBps = Math.round(((perpPrice - spotPrice) / spotPrice) * 10_000);
  const estimatedCostBps = carryFeeBps(spotPosition.venue_id, env) + carryFeeBps(perpPosition.venue_id, env) +
    2 * boundedNonNegativeInt(env.PRIVATE_AGENT_CARRY_ESTIMATED_SLIPPAGE_BPS, 0, 1_000, 2);
  return {
    ok: true,
    version: 1,
    opportunity_id: `carryexit_${digest({
      session: session.autopilot_session_id,
      pair: spotPosition.protected_pair_id || perpPosition.protected_pair_id,
      market,
      now: now.toISOString(),
    }).slice(0, 24)}`,
    status: "ready",
    strategy_id: CARRY_STRATEGY,
    market,
    buy_venue: perpPosition.venue_id,
    sell_venue: spotPosition.venue_id,
    buy_price: perpPrice,
    sell_price: spotPrice,
    buy_leg_notional_usd: perpNotionalUsd,
    sell_leg_notional_usd: spotNotionalUsd,
    leg_notional_usd: Math.max(perpNotionalUsd, spotNotionalUsd),
    buy_base_size: trim(perpBase),
    sell_base_size: trim(spotBase),
    gross_edge_bps: 0,
    projected_funding_bps: 0,
    holding_horizon_hours: 0,
    basis_bps: basisBps,
    estimated_cost_bps: estimatedCostBps,
    net_edge_bps: -estimatedCostBps,
    min_net_edge_bps: 0,
    market_data_skew_ms: 0,
    risk_reducing: true,
    closing_protected_pair_id: spotPosition.protected_pair_id || perpPosition.protected_pair_id || null,
    reason_codes: [],
    created_at: now.toISOString(),
  };
}

function carryExitFailure(error, message, data) {
  return { ok: false, error, message, data };
}

async function fetchCarryPerpMark({ market, env, fetchImpl }) {
  const timeoutMs = Math.min(
    marketFetchTimeoutMs(env),
    capMs(env.PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS, 2_000),
  );
  const response = await withTimeout(fetchImpl("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  }), timeoutMs, "carry_exit_context_timeout").catch(() => null);
  if (!response?.ok) return null;
  const body = await withTimeout(response.json(), timeoutMs, "carry_exit_context_parse_timeout").catch(() => null);
  const universe = body?.[0]?.universe;
  const contexts = body?.[1];
  if (!Array.isArray(universe) || !Array.isArray(contexts)) return null;
  const index = universe.findIndex((asset) => String(asset?.name || "").toUpperCase() === baseMarket(market));
  return index >= 0
    ? numberValue(contexts[index]?.markPx || contexts[index]?.midPx || contexts[index]?.oraclePx)
    : null;
}

function enforceProtectedExitConfig({ env }) {
  const maxSkew = capMs(env.PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS, 0);
  return maxSkew > 0
    ? {
        ok: true,
        daily_cap_usd: Number.POSITIVE_INFINITY,
        max_execution_skew_ms: maxSkew,
        max_hedge_error_micro_usdc: Math.round(capUsd(env.PRIVATE_AGENT_CARRY_MAX_HEDGE_ERROR_USD, 0.05) * 1_000_000),
      }
    : { ok: false, reason_codes: ["max_execution_skew_required"] };
}

export function enforceCarryLiveConfig({ session, env = process.env, requestedNotionalUsd }) {
  const reasonCodes = [];
  const maxLeg = capUsd(env.PRIVATE_AGENT_CARRY_MAX_LEG_NOTIONAL_USD, 0);
  const daily = capUsd(env.PRIVATE_AGENT_CARRY_DAILY_NOTIONAL_CAP_USD, 0);
  const minEdge = capBps(env.PRIVATE_AGENT_CARRY_MIN_NET_EDGE_BPS, 0);
  const maxSkew = capMs(env.PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS, 0);
  if (env.PRIVATE_AGENT_CARRY_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    reasonCodes.push("carry_live_submit_disabled");
  }
  if (maxLeg <= 0) reasonCodes.push("max_leg_notional_required");
  if (daily <= 0) reasonCodes.push("daily_notional_cap_required");
  if (minEdge <= 0) reasonCodes.push("min_net_edge_required");
  if (maxSkew <= 0) reasonCodes.push("max_execution_skew_required");
  if (maxLeg > 0 && requestedNotionalUsd > maxLeg) reasonCodes.push("leg_notional_exceeds_env_cap");
  const policyMax = bucketToUsd(session.session_policy.max_notional_bucket);
  if (policyMax > 0 && requestedNotionalUsd > policyMax) reasonCodes.push("leg_notional_exceeds_session_cap");
  return reasonCodes.length
    ? { ok: false, reason_codes: reasonCodes }
    : {
        ok: true,
        max_leg_notional_usd: maxLeg,
        daily_cap_usd: daily,
        min_net_edge_bps: minEdge,
        max_execution_skew_ms: maxSkew,
        max_hedge_error_micro_usdc: Math.round(capUsd(env.PRIVATE_AGENT_CARRY_MAX_HEDGE_ERROR_USD, 0.05) * 1_000_000),
      };
}

export function enforceArbitrageLiveConfig({ session, env = process.env, requestedNotionalUsd }) {
  const reasonCodes = [];
  const maxLeg = capUsd(env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD, 0);
  const daily = capUsd(env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD, 0);
  const minEdge = capBps(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 0);
  const maxSkew = capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 0);
  if (env.PRIVATE_AGENT_ARB_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    reasonCodes.push("arb_live_submit_disabled");
  }
  if (maxLeg <= 0) reasonCodes.push("max_leg_notional_required");
  if (daily <= 0) reasonCodes.push("daily_notional_cap_required");
  if (minEdge <= 0) reasonCodes.push("min_net_edge_required");
  if (maxSkew <= 0) reasonCodes.push("max_execution_skew_required");
  if (maxLeg > 0 && requestedNotionalUsd > maxLeg) reasonCodes.push("leg_notional_exceeds_env_cap");
  const policyMax = bucketToUsd(session.session_policy.max_notional_bucket);
  if (policyMax > 0 && requestedNotionalUsd > policyMax) reasonCodes.push("leg_notional_exceeds_session_cap");
  return reasonCodes.length
    ? { ok: false, reason_codes: reasonCodes }
    : {
        ok: true,
        max_leg_notional_usd: maxLeg,
        daily_cap_usd: daily,
        min_net_edge_bps: minEdge,
        max_execution_skew_ms: maxSkew,
        max_hedge_error_micro_usdc: Math.round(capUsd(env.PRIVATE_AGENT_ARB_MAX_HEDGE_ERROR_USD, 0.05) * 1_000_000),
      };
}

function forcedCarryObservations({ markets, spotVenues, env, now }) {
  const market = markets[0] || "SOL-USD";
  const spotVenue = spotVenues.find((venue) => supportsSpotMarket(venue, market)) || spotVenues[0];
  const spotPrice = capUsd(env.PRIVATE_AGENT_CARRY_FORCE_SPOT_PRICE, 100);
  const perpPrice = capUsd(env.PRIVATE_AGENT_CARRY_FORCE_PERP_PRICE, spotPrice * 1.001);
  const hourlyBps = Number.parseFloat(String(env.PRIVATE_AGENT_CARRY_FORCE_HOURLY_FUNDING_BPS || "5"));
  const samples = boundedPositiveInt(env.PRIVATE_AGENT_CARRY_FORCE_FUNDING_SAMPLES, 1, 168, 24);
  return [{
    market,
    spot_venue: spotVenue,
    spot_price: spotPrice,
    perp_price: perpPrice,
    current_funding_hourly_bps: hourlyBps,
    funding_history_hourly_bps: Array.from({ length: samples }, () => hourlyBps),
    fetched_at: now.toISOString(),
  }];
}

async function liveCarryObservations({ markets, spotVenues, env, fetchImpl, now }) {
  const timeoutMs = Math.min(
    marketFetchTimeoutMs(env),
    capMs(env.PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS, 2_000),
  );
  const contextRequest = fetchImpl("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const contextResponse = await withTimeout(contextRequest, timeoutMs, "carry_context_timeout").catch(() => null);
  if (!contextResponse?.ok) return [];
  const contextBody = await withTimeout(contextResponse.json(), timeoutMs, "carry_context_parse_timeout").catch(() => null);
  const universe = contextBody?.[0]?.universe;
  const contexts = contextBody?.[1];
  if (!Array.isArray(universe) || !Array.isArray(contexts) || universe.length !== contexts.length) return [];
  const contextByCoin = new Map(universe.map((asset, index) => [String(asset?.name || "").toUpperCase(), contexts[index]]));
  const tasks = [];
  for (const market of markets) {
    const context = contextByCoin.get(baseMarket(market));
    const perpPrice = numberValue(context?.markPx || context?.midPx || context?.oraclePx);
    const funding = Number.parseFloat(String(context?.funding ?? ""));
    if (!perpPrice || !Number.isFinite(funding)) continue;
    for (const spotVenue of spotVenues.filter((venue) => supportsSpotMarket(venue, market))) {
      tasks.push((async () => {
        const [spotPrice, fundingHistory] = await Promise.all([
          withTimeout(fetchVenuePrice({ venue: spotVenue, market, fetchImpl }), timeoutMs, "carry_spot_timeout").catch(() => null),
          fetchFundingHistory({ coin: baseMarket(market), env, fetchImpl, now, timeoutMs }),
        ]);
        if (!spotPrice || !Array.isArray(fundingHistory)) return null;
        return {
          market,
          spot_venue: spotVenue,
          spot_price: spotPrice,
          perp_price: perpPrice,
          current_funding_hourly_bps: funding * 10_000,
          funding_history_hourly_bps: fundingHistory,
          fetched_at: now.toISOString(),
        };
      })());
    }
  }
  return (await Promise.all(tasks)).filter(Boolean);
}

async function fetchFundingHistory({ coin, env, fetchImpl, now, timeoutMs }) {
  const lookbackHours = boundedPositiveInt(env.PRIVATE_AGENT_CARRY_FUNDING_LOOKBACK_HOURS, 8, 168, 24);
  const response = await withTimeout(fetchImpl("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "fundingHistory",
      coin,
      startTime: now.getTime() - lookbackHours * 60 * 60_000,
      endTime: now.getTime(),
    }),
  }), timeoutMs, "carry_funding_history_timeout").catch(() => null);
  if (!response?.ok) return [];
  const rows = await withTimeout(response.json(), timeoutMs, "carry_funding_history_parse_timeout").catch(() => []);
  return Array.isArray(rows)
    ? rows.map((row) => Number.parseFloat(String(row?.fundingRate ?? "")) * 10_000).filter(Number.isFinite)
    : [];
}

function supportsSpotMarket(venue, market) {
  if (venue === "jupiter") return normalizeMarket(market) === "SOL-USD";
  return venue === "coinbase_advanced" && SUPPORTED_MARKETS.has(normalizeMarket(market));
}

function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile)));
  return sorted[index];
}

async function marketSnapshots({ session, env, fetchImpl, now }) {
  if (env.PRIVATE_AGENT_ARB_SIGNAL_MODE === "force" || env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE === "force") {
    const market = normalizeMarket(session.session_policy.market_allowlist[0] || "SOL-USD");
    const base = capUsd(env.PRIVATE_AGENT_ARB_FORCE_BUY_PRICE || env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE, 100);
    const sell = capUsd(env.PRIVATE_AGENT_ARB_FORCE_SELL_PRICE, base * 1.03);
    const ready = readyVenues(session);
    const hedgeVenue = ready.includes("hyperliquid") ? "hyperliquid" : ready.find((venue) => venueSupportsProduct(venue, "perp")) || "hyperliquid";
    const buyVenue = ready.find((venue) => venue !== hedgeVenue) ||
      (session.session_policy.venue_allowlist.includes("coinbase_advanced") ? "coinbase_advanced" : "jupiter");
    return [
      snapshot({ venue_id: buyVenue, market, price: base, now, source: "forced", latency_ms: 0 }),
      snapshot({ venue_id: hedgeVenue, market, price: sell, now, source: "forced", latency_ms: 0 }),
    ];
  }
  const timeoutMs = marketFetchTimeoutMs(env);
  const markets = session.session_policy.market_allowlist
    .map(normalizeMarket)
    .filter((item) => SUPPORTED_MARKETS.has(item));
  const tasks = [];
  for (const venue of readyVenues(session)) {
    if (venue === "hyperliquid") {
      tasks.push(fetchHyperliquidSnapshots({ markets, fetchImpl, timeoutMs }));
      continue;
    }
    for (const market of markets) {
      tasks.push(fetchTimedVenueSnapshot({ venue, market, fetchImpl, timeoutMs }));
    }
  }
  return (await Promise.all(tasks)).flat().filter(Boolean);
}

async function fetchTimedVenueSnapshot({ venue, market, fetchImpl, timeoutMs }) {
  const started = Date.now();
  const price = await withTimeout(
    fetchVenuePrice({ venue, market, fetchImpl }),
    timeoutMs,
    "market_fetch_timeout",
  ).catch(() => null);
  if (!price) return null;
  return snapshot({
    venue_id: venue,
    market,
    price,
    now: new Date(),
    source: "live",
    latency_ms: Date.now() - started,
  });
}

async function fetchHyperliquidSnapshots({ markets, fetchImpl, timeoutMs }) {
  const started = Date.now();
  const request = fetchImpl("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const response = await withTimeout(
    request,
    timeoutMs,
    "market_fetch_timeout",
  ).catch(() => null);
  if (!response?.ok) return [];
  const mids = await withTimeout(response.json(), timeoutMs, "market_parse_timeout").catch(() => null);
  if (!mids || typeof mids !== "object") return [];
  const fetchedAt = new Date();
  return markets
    .map((market) => {
      const price = numberValue(mids[baseMarket(market)]);
      return price
        ? snapshot({
            venue_id: "hyperliquid",
            market,
            price,
            now: fetchedAt,
            source: "live",
            latency_ms: Date.now() - started,
          })
        : null;
    })
    .filter(Boolean);
}

async function fetchVenuePrice({ venue, market, fetchImpl }) {
  if (venue === "coinbase_advanced") {
    const response = await fetchImpl(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(market)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return numberValue(body.price || body.mid_market_price || body.pricebook?.best_bid);
  }
  if (venue === "hyperliquid") {
    const response = await fetchImpl("https://api.hyperliquid.xyz/info", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!response.ok) return null;
    const mids = await response.json();
    return numberValue(mids[baseMarket(market)]);
  }
  if (venue === "backpack") {
    const symbol = `${baseMarket(market)}_USDC_PERP`;
    const response = await fetchImpl(`https://api.backpack.exchange/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return numberValue(body.lastPrice || body.markPrice || body.indexPrice);
  }
  if (venue === "phoenix") {
    const response = await fetchImpl("https://perp-api.phoenix.trade/markets", {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    return numberValue(body?.["SOL-PERP"]?.markPrice || body?.markets?.["SOL-PERP"]?.markPrice || body?.[0]?.markPrice);
  }
  return null;
}

function instructionForLeg({ venue, market, side, price, notional, baseSize, reduceOnly = false, policy, now }) {
  const expiresAt = new Date(now.getTime() + Math.min(5 * 60_000, policy.ttl_ms)).toISOString();
  if (venue === "jupiter") {
    const sol = "So11111111111111111111111111111111111111112";
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "jupiter",
      operation_class: "swap",
      expires_at: expiresAt,
      order: {
        input_mint: side === "buy" ? usdc : sol,
        output_mint: side === "buy" ? sol : usdc,
        amount: side === "buy" ? String(Math.floor(notional * 1_000_000)) : String(Math.floor((notional / price) * 1_000_000_000)),
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
        market,
        side,
        base_size: String(baseSize),
        limit_price: String(price),
        order_type: "market",
        size_mode: "base",
        reduce_only: reduceOnly,
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
    operation_class: operationForVenue(venue),
    expires_at: expiresAt,
    order: {
      market: venueMarketSymbol(venue, market),
      side,
      quote_size: String(notional),
      base_size: String(baseSize),
      limit_price: trim(limit),
      order_type: "market",
      size_mode: "base",
      live_order_mode: "tiny_fill",
      max_slippage_bps: String(policy.max_slippage_bps),
      reduce_only: reduceOnly && venueSupportsProduct(venue, "perp"),
      tif: "Ioc",
    },
  };
}

function executionForVenue(session, venue) {
  const access = session.venue_access?.[venue] || {};
  return {
    execution_mode: access.execution_mode || defaultExecutionMode(venue),
    vault_commitment: access.vault_commitment || undefined,
    encrypted_vault_commitment: access.encrypted_vault_commitment || undefined,
    encrypted_execution_vault: access.encrypted_execution_vault || undefined,
    allocation_commitment: access.allocation_commitment || undefined,
    managed_allocation_commitment: access.managed_allocation_commitment || undefined,
    omnibus_allocation: access.omnibus_allocation || undefined,
    autopilot_session_id: session.autopilot_session_id,
  };
}

function workerSessionPolicy(session) {
  const policy = session.session_policy;
  return {
    policy_commitment: policy.policy_commitment,
    strategy_id: policy.strategy_id,
    venue_allowlist: policy.venue_allowlist,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_position_notional_bucket: policy.max_position_notional_bucket,
    max_daily_notional_bucket: policy.max_daily_notional_bucket,
    max_order_count: policy.max_order_count,
    max_slippage_bps: policy.max_slippage_bps,
    min_net_edge_bps: policy.min_net_edge_bps,
    allowed_order_types: policy.allowed_order_types,
    kill_switch: policy.kill_switch === true || session.status === "killed",
    expires_at: session.expires_at,
  };
}

function validPair(left, right) {
  return (venueSupportsProduct(left, "spot") && venueSupportsProduct(right, "perp")) ||
    (venueSupportsProduct(right, "spot") && venueSupportsProduct(left, "perp")) ||
    (venueSupportsProduct(left, "perp") && venueSupportsProduct(right, "perp"));
}

function operationForVenue(venue) {
  if (venue === "jupiter") return "swap";
  if (venue === "coinbase_advanced") return "spot_market_order";
  if (venue === "phoenix" || venue === "backpack") return "perp_limit_order";
  return "limit_order";
}

function readyVenues(session) {
  return session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
}

function snapshot({ venue_id, market, price, now, source, latency_ms = 0 }) {
  return { venue_id, market, price, fetched_at: now.toISOString(), source, latency_ms };
}

function publicSnapshot(snapshot) {
  return {
    venue_id: snapshot.venue_id,
    market: snapshot.market,
    price: snapshot.price,
    source: snapshot.source,
    fetched_at: snapshot.fetched_at,
    latency_ms: snapshot.latency_ms,
  };
}

function publicOpportunity(value) {
  if (!value || !value.market) return value;
  return {
    version: 1,
    opportunity_id: value.opportunity_id,
    status: value.status || (value.ok ? "ready" : "blocked"),
    market: value.market,
    buy_venue: value.buy_venue,
    sell_venue: value.sell_venue,
    gross_edge_bps: value.gross_edge_bps,
    projected_funding_bps: value.projected_funding_bps ?? null,
    current_funding_hourly_bps: value.current_funding_hourly_bps ?? null,
    conservative_funding_hourly_bps: value.conservative_funding_hourly_bps ?? null,
    funding_sample_count: value.funding_sample_count ?? null,
    holding_horizon_hours: value.holding_horizon_hours ?? null,
    risk_reducing: value.risk_reducing === true,
    closing_protected_pair_id: value.closing_protected_pair_id ?? null,
    basis_bps: value.basis_bps ?? null,
    estimated_cost_bps: value.estimated_cost_bps,
    net_edge_bps: value.net_edge_bps,
    min_net_edge_bps: value.min_net_edge_bps,
    leg_notional_bucket: String(value.leg_notional_usd || "0"),
    buy_leg_notional_bucket: String(value.buy_leg_notional_usd || value.leg_notional_usd || "0"),
    sell_leg_notional_bucket: String(value.sell_leg_notional_usd || value.leg_notional_usd || "0"),
    market_data_skew_ms: value.market_data_skew_ms,
    reason_codes: value.reason_codes || [],
    created_at: value.created_at,
  };
}

function minNetEdgeBps(session, env) {
  return Math.max(
    Number(session.session_policy.min_net_edge_bps || 0),
    capBps(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 0),
  );
}

function carryMinNetEdgeBps(session, env) {
  return Math.max(
    Number(session.session_policy.min_net_edge_bps || 0),
    capBps(env.PRIVATE_AGENT_CARRY_MIN_NET_EDGE_BPS, 0),
  );
}

function feeBps(venue, env) {
  const key = `PRIVATE_AGENT_ARB_${String(venue).toUpperCase()}_FEE_BPS`;
  return capBps(env[key], DEFAULT_FEE_BPS[venue] || 10);
}

function carryFeeBps(venue, env) {
  const key = `PRIVATE_AGENT_CARRY_${String(venue).toUpperCase()}_FEE_BPS`;
  const value = Number.parseInt(String(env[key] ?? ""), 10);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_FEE_BPS[venue] || 10;
}

function defaultExecutionMode(venue) {
  if (venue === "coinbase_advanced" || venue === "hyperliquid") return "byo_api_key";
  return "user_stealth";
}

function remainingDailyNotional(session) {
  return Math.max(0, bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0));
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function capMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function boundedNonNegativeInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function marketFetchTimeoutMs(env) {
  return Math.min(
    capMs(env.PRIVATE_AGENT_ARB_MARKET_FETCH_TIMEOUT_MS, 1_200),
    capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 2_000),
  );
}

function maxMarketSkewMs(env) {
  return capMs(
    env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS,
    capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 2_000),
  );
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
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

function numberValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trim(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(8))) : String(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value, Object.keys(value || {}).sort())).digest("hex");
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
