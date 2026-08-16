import { createHash } from "node:crypto";
import { executeClaimedPrivateSubmission } from "./private-execution.js";
import {
  hyperliquidManagedAccountRefs,
  loadManagedHyperliquidCredential,
  readHyperliquidExactMarketState,
  readHyperliquidTopOfBook,
  reconcileHyperliquidExecution,
  submitHyperliquidExecution,
  verifyHyperliquidNoSubmit,
} from "../venues/hyperliquid.js";
import {
  loadPooledSolanaPerpsCredential,
  readBackpackAccountSnapshot,
  readBackpackTopOfBook,
  reconcileBackpackExecution,
  submitSolanaPerpsExecution,
  verifySolanaPerpsNoSubmit,
} from "../venues/solana_perps.js";

const EXACT_PAIR = ["backpack", "hyperliquid"];
const MIN_NOTIONAL_MICRO_USDC = 10_000_000;
const HARD_MAX_NOTIONAL_MICRO_USDC = 11_000_000;
const SOL_BASE_STEP = 0.01;

export function createLiveCrossVenueAdapter({
  state,
  venues = defaultVenues(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
} = {}) {
  const adapter = {
    durable_claims: true,

    readiness() {
      const reasonCodes = [];
      if (env.PRIVATE_AGENT_CROSS_VENUE_PAIR !== "hyperliquid:backpack") {
        reasonCodes.push("cross_venue_pair_not_configured");
      }
      const cap = configuredCapMicroUsdc(env);
      if (cap < MIN_NOTIONAL_MICRO_USDC || cap > HARD_MAX_NOTIONAL_MICRO_USDC) {
        reasonCodes.push("cross_venue_notional_cap_invalid");
      }
      if (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
        if (env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true" || env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "tiny_fill") {
          reasonCodes.push("hyperliquid_cross_venue_tiny_fill_disabled");
        }
        if (!new Set(["tiny_live", "full_ticket"]).has(env.PRIVATE_AGENT_BACKPACK_LIVE_MODE || env.GHOLA_BACKPACK_LIVE_MODE)) {
          reasonCodes.push("backpack_cross_venue_ioc_disabled");
        }
      }
      for (const venueId of EXACT_PAIR) {
        try {
          const credential = credentialForVenue(venueId, venues);
          if (venueId === "backpack" && Number(credential?.maxOrderNotionalUsd) < cap / 1_000_000) {
            reasonCodes.push("backpack_cross_venue_notional_cap_too_low");
          }
        } catch {
          reasonCodes.push(`${venueId}_cross_venue_credential_unavailable`);
        }
      }
      return { ready: reasonCodes.length === 0, reason_codes: [...new Set(reasonCodes)] };
    },

    async preflight({ plan, leg }) {
      assertSupportedPlan(plan, env);
      const instruction = instructionForLeg(plan, leg);
      const credential = credentialForVenue(leg.venue_id, venues);
      const clientOrderId = await clientOrderIdForLeg(state, leg);
      if (leg.venue_id === "hyperliquid") {
        await venues.verifyHyperliquid({
          credential,
          instruction,
          cloid: clientOrderId,
          executionMode: "ghola_pooled",
        });
      } else {
        await venues.verifyBackpack({
          credential,
          instruction,
          clientOrderId,
          venueId: "backpack",
          executionMode: "ghola_pooled",
        });
      }
      const account = await exactVenueState({ venues, credential, venueId: leg.venue_id });
      if (account.status !== "ready_to_trade") throw coded("cross_venue_account_not_ready");
      if (!sameDecimal(account.position_size, "0")) throw coded("cross_venue_requires_initially_flat_accounts");
      if (account.open_order_count !== 0) throw coded("cross_venue_requires_no_open_target_orders");
      return { ok: true };
    },

    async submit({ plan, leg }) {
      assertSupportedPlan(plan, env);
      return executeDurableLeg({ state, venues, sleep, plan, leg });
    },

    async hedge() {
      const error = new Error("cross_venue_repair_requires_reduce_only_unwind");
      error.code = "cross_venue_repair_requires_reduce_only_unwind";
      throw error;
    },

    async unwind({ plan, venue_id, dominant_leg, legs, base_size, max_loss_micro_usdc }) {
      const residualBaseSize = Number(safeDecimal(base_size)) > 0
        ? safeDecimal(base_size)
        : baseResidual(legs || []).base_size;
      if (!dominant_leg?.filled_base_size || !(Number(residualBaseSize) > 0)) {
        const error = new Error("cross_venue_unwind_base_size_unavailable");
        error.code = "cross_venue_unwind_base_size_unavailable";
        throw error;
      }
      const original = plan.legs.find((leg) => leg.venue_id === venue_id);
      if (!original) throw new Error("cross_venue_unwind_venue_mismatch");
      const side = original.side === "buy" ? "sell" : "buy";
      const bps = Math.min(100, Math.max(1, Number(plan.risk_budget.max_hedge_slippage_bps || 25)));
      const reference = Number(original.limit_price);
      const limit = side === "buy" ? reference * (1 + bps / 10_000) : reference * (1 - bps / 10_000);
      const workOrder = `cross_venue_unwind_${hash48({ execution_id: plan.execution_id, venue_id })}`;
      const leg = {
        ...original,
        leg_id: workOrder,
        side,
        limit_price: trimDecimal(limit),
        target_notional_micro_usdc: Math.max(1, Math.round(Number(residualBaseSize) * reference * 1_000_000)),
        target_base_size: residualBaseSize,
      };
      const result = await executeDurableLeg({
        state,
        venues,
        sleep,
        plan,
        leg,
        reduceOnly: true,
        baseSize: residualBaseSize,
      });
      return {
        ...result,
        venue_id,
        realized_loss_micro_usdc: Math.min(
          Number(max_loss_micro_usdc || 0),
          Math.max(0, dominant_leg.filled_notional_micro_usdc - result.filled_notional_micro_usdc),
        ),
        daily_realized_loss_micro_usdc: 0,
        slippage_bps: bps,
      };
    },

    async reconcile({ plan, evidence: parentEvidence = null }) {
      assertSupportedPlan(plan, env);
      const childEvidence = await Promise.all(plan.legs.map((leg) => state.getExecutionClaimEvidence(leg.leg_id)));
      const parentUpdatedAt = Date.parse(parentEvidence?.attempt?.updated_at || parentEvidence?.attempt?.report?.observed_at || "");
      const recoveryDeadlinePassed = Number.isFinite(parentUpdatedAt) &&
        Date.now() - parentUpdatedAt > Number(plan.risk_budget.max_hedge_duration_ms || 5_000) + 1_000;
      const allowMissingNoBroadcast = childEvidence.some(Boolean) || recoveryDeadlinePassed;
      const legs = await Promise.all(plan.legs.map((leg, index) => reconcileDurableLeg({
        state,
        venues,
        plan,
        leg,
        evidence: childEvidence[index],
        allowMissingNoBroadcast,
      })));
      if (legs.some((leg) => !leg.terminal)) return { terminal: false };
      const residual = baseResidual(legs, plan.legs);
      if (Number(residual.base_size) === 0) return terminalParentResult(plan, legs);
      const dominantIndex = residual.dominant_index;
      const repair = await adapter.unwind({
        plan,
        venue_id: plan.legs[dominantIndex].venue_id,
        dominant_leg: legs[dominantIndex],
        legs,
        base_size: residual.base_size,
        max_loss_micro_usdc: plan.risk_budget.max_unwind_loss_micro_usdc,
      });
      if (!sameDecimal(repair.filled_base_size, residual.base_size)) return { terminal: false };
      return terminalParentResult(plan, legs, [{
        repair_id: `cross_repair_${hash48({ execution_id: plan.execution_id, kind: "restart_unwind" })}`,
        venue_id: repair.venue_id,
        side: plan.legs[dominantIndex].side === "buy" ? "sell" : "buy",
        filled_notional_micro_usdc: repair.filled_notional_micro_usdc,
        filled_base_size: repair.filled_base_size,
        venue_order_reference: repair.venue_order_reference,
      }]);
    },

    async close({ plan, evidence }) {
      assertSupportedPlan(plan, env);
      const opened = matchedOpenLegs(plan, evidence);
      const credentials = Object.fromEntries(plan.legs.map((leg) => [leg.venue_id, credentialForVenue(leg.venue_id, venues)]));
      const accounts = await Promise.all(plan.legs.map((leg) => exactVenueState({
        venues,
        credential: credentials[leg.venue_id],
        venueId: leg.venue_id,
      })));
      const closeLegs = plan.legs.map((leg, index) => closeLeg({
        plan,
        leg,
        baseSize: opened[index].filled_base_size,
      }));
      const closed = await Promise.all(closeLegs.map(async (leg, index) => {
        const expectedPosition = plan.legs[index].side === "buy"
          ? Number(leg.target_base_size)
          : -Number(leg.target_base_size);
        const currentPosition = Number(accounts[index].position_size);
        const childEvidence = await state.getExecutionClaimEvidence(leg.leg_id);
        if (childEvidence) {
          const result = await reconcileDurableLeg({
            state,
            venues,
            plan,
            leg,
            evidence: childEvidence,
            allowMissingNoBroadcast: false,
            reduceOnly: true,
            baseSize: leg.target_base_size,
          });
          if (!result.terminal) throw coded("cross_venue_close_reconciliation_required");
          return result;
        }
        if (Math.abs(currentPosition - expectedPosition) > 1e-9 || accounts[index].open_order_count !== 0) {
          throw coded("cross_venue_close_position_mismatch");
        }
        return executeDurableLeg({
          state,
          venues,
          sleep,
          plan,
          leg,
          reduceOnly: true,
          baseSize: leg.target_base_size,
        });
      }));
      if (closed.some((result, index) => !sameDecimal(result.filled_base_size, closeLegs[index].target_base_size))) {
        throw coded("cross_venue_close_incomplete");
      }
      const finalAccounts = await waitForFlatAccounts({ venues, credentials, plan, sleep });
      if (finalAccounts.some((account) => !sameDecimal(account.position_size, "0") || account.open_order_count !== 0)) {
        throw coded("cross_venue_close_reconciliation_required");
      }
      return {
        terminal: true,
        status: "closed",
        legs: closed,
        final_proof: {
          version: 1,
          proof_kind: "cross_venue_matched_pair_close_v1",
          terminal_status: "closed",
          atomic: false,
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_flat_proven: true,
          checked_at: new Date().toISOString(),
        },
      };
    },

    async cancel({ plan }) {
      const recovered = await adapter.reconcile({ plan });
      if (!recovered.terminal) {
        const error = new Error("cross_venue_cancellation_reconciliation_required");
        error.code = "cross_venue_cancellation_reconciliation_required";
        throw error;
      }
      return { ok: true, replayed: true, recovered };
    },
  };
  return adapter;
}

async function executeDurableLeg({ state, venues, sleep, plan, leg, reduceOnly = false, baseSize = null }) {
  const instruction = instructionForLeg(plan, leg, { reduceOnly, baseSize });
  const credential = credentialForVenue(leg.venue_id, venues);
  const clientOrderId = await clientOrderIdForLeg(state, leg);
  const claimContext = legClaimContext({ plan, leg, instruction, reduceOnly });
  const receipt = await executeClaimedPrivateSubmission({
    state,
    work_order_commitment: leg.leg_id,
    claim_context: claimContext,
    submit: async () => {
      const broadcast = leg.venue_id === "hyperliquid"
        ? await venues.submitHyperliquid({ credential, instruction, cloid: clientOrderId })
        : await venues.submitBackpack({ credential, instruction, clientOrderId, venueId: "backpack", executionMode: "ghola_pooled" });
      const immediate = immediateTerminalResult(leg.venue_id, broadcast);
      if (immediate?.terminal) return { ...immediate, broadcast };
      const reconciled = await pollTerminal({ venues, credential, instruction, clientOrderId, venueId: leg.venue_id, sleep });
      return { ...reconciled, broadcast };
    },
    evidence: async (result) => legCompletion({ plan, leg, claimContext, result, clientOrderId, reduceOnly }),
    finalize: async (result) => {
      if (!result.terminal) {
        const error = new Error("cross_venue_leg_reconciliation_required");
        error.code = "cross_venue_leg_reconciliation_required";
        throw error;
      }
    },
  });
  return publicLegResult(receipt);
}

async function reconcileDurableLeg({
  state,
  venues,
  plan,
  leg,
  evidence,
  allowMissingNoBroadcast,
  reduceOnly = false,
  baseSize = null,
}) {
  if (!evidence) {
    if (!allowMissingNoBroadcast) return { terminal: false, leg_id: leg.leg_id };
    return {
      terminal: true,
      leg_id: leg.leg_id,
      status: "rejected",
      filled_notional_micro_usdc: 0,
      filled_base_size: "0",
      venue_order_reference: null,
      final_proof: noBroadcastProof(leg.venue_id),
    };
  }
  const instruction = instructionForLeg(plan, leg, { reduceOnly, baseSize });
  const expectedContext = legClaimContext({ plan, leg, instruction, reduceOnly });
  if (evidence.context?.request_digest !== expectedContext.request_digest) {
    throw new Error("cross_venue_leg_context_mismatch");
  }
  if (evidence.status === "completed" && evidence.receipt) {
    return { terminal: true, ...publicLegResult(evidence.receipt), final_proof: evidence.receipt.final_proof };
  }
  const credential = credentialForVenue(leg.venue_id, venues);
  const clientOrderId = await clientOrderIdForLeg(state, leg);
  const result = await reconcileVenue({ venues, credential, instruction, clientOrderId, venueId: leg.venue_id });
  if (!result.terminal) return { terminal: false, leg_id: leg.leg_id };
  const completion = legCompletion({ plan, leg, claimContext: expectedContext, result, clientOrderId, reduceOnly });
  const receipt = await state.resolveExecutionClaim(leg.leg_id, completion);
  return { terminal: true, ...publicLegResult(receipt), final_proof: receipt.final_proof };
}

async function pollTerminal({ venues, credential, instruction, clientOrderId, venueId, sleep }) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await reconcileVenue({ venues, credential, instruction, clientOrderId, venueId });
    if (result.terminal) return result;
    await sleep(250);
  }
  return {
    terminal: false,
    status: "reconcile_required",
    filled_notional_micro_usdc: 0,
    filled_base_size: "0",
    venue_order_reference: `${venueId}:deterministic_id:${clientOrderId}`,
    fills: [],
    final_proof: null,
  };
}

function reconcileVenue({ venues, credential, instruction, clientOrderId, venueId }) {
  return venueId === "hyperliquid"
    ? venues.reconcileHyperliquid({ credential, cloid: clientOrderId, market: instruction.order.market })
    : venues.reconcileBackpack({ credential, instruction, clientOrderId });
}

function immediateTerminalResult(venueId, broadcast) {
  if (venueId !== "hyperliquid" || !Array.isArray(broadcast?.fills) || broadcast.fills.length === 0) return null;
  const base = broadcast.fills.reduce((sum, fill) => sum + finitePositive(fill?.sz), 0);
  const notional = broadcast.fills.reduce((sum, fill) => sum + finitePositive(fill?.sz) * finitePositive(fill?.px), 0);
  return {
    terminal: broadcast.status === "filled",
    status: broadcast.status === "filled" ? "filled" : "partially_filled",
    filled_notional_micro_usdc: Math.round(notional * 1_000_000),
    filled_base_size: trimDecimal(base),
    venue_order_reference: broadcast.provider_ref_seed?.oid
      ? `oid:${broadcast.provider_ref_seed.oid}`
      : `cloid:${broadcast.provider_ref_seed?.cloid || "unknown"}`,
    fills: broadcast.fills,
    final_proof: broadcast.final_proof,
  };
}

function legCompletion({ plan, leg, claimContext, result, clientOrderId, reduceOnly = false }) {
  const now = new Date().toISOString();
  const proof = result.final_proof || {
    version: 1,
    proof_kind: `${leg.venue_id}_execution_unknown_v1`,
    terminal_status: result.status || "reconcile_required",
    venue_id: leg.venue_id,
    network: "mainnet",
    broadcast_performed: true,
    final_venue_execution_proven: false,
    final_fill_proven: false,
    final_no_fill_proven: false,
    checked_at: now,
  };
  const receipt = {
    version: 1,
    status: result.status || "reconcile_required",
    execution_id: plan.execution_id,
    leg_id: leg.leg_id,
    venue_id: leg.venue_id,
    side: leg.side,
    filled_notional_micro_usdc: reduceOnly
      ? boundedMicro(result.filled_notional_micro_usdc, Number.MAX_SAFE_INTEGER)
      : boundedMicro(result.filled_notional_micro_usdc, leg.target_notional_micro_usdc),
    filled_base_size: safeDecimal(result.filled_base_size),
    venue_order_reference: safeReference(result.venue_order_reference),
    deterministic_client_order_id: clientOrderId,
    final_proof: proof,
    execution_request_digest: claimContext.request_digest,
    completed_at: now,
  };
  return {
    attempt: {
      ...receipt,
      status: result.terminal ? receipt.status : "reconcile_required",
      fills: Array.isArray(result.fills) ? result.fills.slice(0, 25) : [],
      execution_request_digest: claimContext.request_digest,
    },
    receipt,
  };
}

function publicLegResult(receipt) {
  return {
    leg_id: receipt.leg_id,
    status: receipt.filled_notional_micro_usdc > 0 ? "filled" : "rejected",
    filled_notional_micro_usdc: Number(receipt.filled_notional_micro_usdc || 0),
    filled_base_size: safeDecimal(receipt.filled_base_size),
    venue_order_reference: safeReference(receipt.venue_order_reference),
  };
}

function terminalParentResult(plan, legs, repairFills = []) {
  const anyFill = legs.some((leg) => leg.filled_notional_micro_usdc > 0) || repairFills.length > 0;
  const matched = Number(baseResidual([
    ...legs,
    ...repairFills.map((fill) => ({
      ...fill,
      filled_base_size: fill.filled_base_size || trimDecimal(fill.filled_notional_micro_usdc / 1_000_000 / Number(plan.legs.find((leg) => leg.venue_id === fill.venue_id)?.limit_price || 1)),
    })),
  ], [
    ...plan.legs,
    ...repairFills.map((fill) => ({ side: fill.side })),
  ]).base_size) === 0;
  const phase = matched && legs.every((leg) => leg.filled_notional_micro_usdc > 0) ? "complete" : repairFills.length ? "complete" : "failed";
  return {
    terminal: true,
    phase,
    legs,
    repair_fills: repairFills,
    failure_code: phase === "failed" ? "both_legs_unfilled" : null,
    final_proof: {
      version: 1,
      proof_kind: "cross_venue_reconciled_execution_v1",
      terminal_status: phase,
      atomic: false,
      broadcast_performed: anyFill,
      final_venue_execution_proven: true,
      final_fill_proven: anyFill,
      final_no_broadcast_proven: !anyFill,
      checked_at: new Date().toISOString(),
    },
  };
}

function instructionForLeg(plan, leg, { reduceOnly = false, baseSize = null } = {}) {
  const exactBaseSize = reduceOnly
    ? safeDecimal(baseSize)
    : crossVenueCommonBaseSize(plan);
  const order = {
    market: leg.venue_id === "backpack" ? "SOL_USDC_PERP" : "SOL",
    side: leg.side,
    order_type: reduceOnly || leg.venue_id === "hyperliquid" ? "market" : "limit",
    limit_price: String(leg.limit_price),
    tif: "Ioc",
    post_only: false,
    reduce_only: reduceOnly,
    live_order_mode: "tiny_fill",
    ...(leg.venue_id === "hyperliquid" && !reduceOnly ? { cross_venue_exact_base: true } : {}),
    max_slippage_bps: String(plan.risk_budget.max_hedge_slippage_bps),
    base_size: exactBaseSize,
  };
  return {
    version: 1,
    venue_id: leg.venue_id,
    operation_class: leg.venue_id === "hyperliquid" ? "limit_order" : "perp_limit_order",
    work_order_commitment: leg.leg_id,
    order,
  };
}

function legClaimContext({ plan, leg, instruction, reduceOnly }) {
  return {
    venue_id: leg.venue_id,
    platform_class: leg.venue_id === "hyperliquid" ? "hyperliquid_style_market" : "solana_perps_market",
    execution_mode: "ghola_pooled",
    operation_class: reduceOnly ? "cross_venue_reduce_only_unwind" : "cross_venue_ioc_leg",
    request_digest: sha256(stableJson({
      execution_id: plan.execution_id,
      opportunity_commitment: plan.opportunity_commitment,
      leg,
      instruction,
      reduce_only: reduceOnly,
    })),
  };
}

function assertSupportedPlan(plan, env) {
  const venues = plan.legs.map((leg) => leg.venue_id).sort();
  if (stableJson(venues) !== stableJson(EXACT_PAIR)) throw new Error("cross_venue_pair_unsupported");
  if (String(plan.market).toUpperCase() !== "SOL-USD") throw new Error("cross_venue_market_unsupported");
  const hyperliquid = plan.legs.find((leg) => leg.venue_id === "hyperliquid");
  const backpack = plan.legs.find((leg) => leg.venue_id === "backpack");
  if (String(hyperliquid?.symbol).toUpperCase() !== "SOL") throw new Error("cross_venue_hyperliquid_symbol_mismatch");
  if (String(backpack?.symbol).toUpperCase() !== "SOL_USDC_PERP") throw new Error("cross_venue_backpack_symbol_mismatch");
  const notional = Number(plan.matched_notional_micro_usdc);
  const cap = configuredCapMicroUsdc(env);
  if (!Number.isSafeInteger(notional) || notional < MIN_NOTIONAL_MICRO_USDC || notional > cap || cap > HARD_MAX_NOTIONAL_MICRO_USDC) {
    throw new Error("cross_venue_notional_outside_cap");
  }
  const expectedBase = crossVenueCommonBaseSize(plan);
  if (plan.legs.some((leg) => leg.target_base_size && !sameDecimal(leg.target_base_size, expectedBase))) {
    throw new Error("cross_venue_target_base_size_mismatch");
  }
}

export function crossVenueCommonBaseSize(plan) {
  const prices = plan?.legs?.map((leg) => Number(leg?.limit_price)) || [];
  if (prices.length !== 2 || prices.some((price) => !Number.isFinite(price) || price <= 0)) {
    throw new Error("cross_venue_limit_price_invalid");
  }
  const target = Number(plan.matched_notional_micro_usdc) / 1_000_000;
  const slippage = Math.max(0, Number(plan?.risk_budget?.max_hedge_slippage_bps || 0)) / 10_000;
  const minPrice = Math.min(...prices);
  const lots = Math.ceil((MIN_NOTIONAL_MICRO_USDC / 1_000_000) / minPrice / SOL_BASE_STEP - 1e-12);
  const base = lots * SOL_BASE_STEP;
  if (base <= 0 || prices.some((price) => base * price * (1 + slippage) > target + 1e-9 || base * price * (1 + slippage) > HARD_MAX_NOTIONAL_MICRO_USDC / 1_000_000 + 1e-9)) {
    throw new Error("cross_venue_no_common_base_size_within_cap");
  }
  return trimDecimal(base);
}

function baseResidual(fills, legs = null) {
  const rows = fills.map((fill, index) => ({
    side: legs?.[index]?.side || fill.side,
    base: Number(safeDecimal(fill?.filled_base_size)),
  }));
  if (!rows.length || rows.some((row) => !new Set(["buy", "sell"]).has(row.side) || !Number.isFinite(row.base) || row.base < 0)) {
    throw new Error("cross_venue_fill_base_size_invalid");
  }
  const signed = rows.reduce((total, row) => total + (row.side === "buy" ? row.base : -row.base), 0);
  const dominant = signed >= 0
    ? rows.findIndex((row) => row.side === "buy" && row.base > 0)
    : rows.findIndex((row) => row.side === "sell" && row.base > 0);
  return { base_size: Math.abs(signed) <= 1e-9 ? "0" : trimDecimal(Math.abs(signed)), dominant_index: Math.max(0, dominant) };
}

function matchedOpenLegs(plan, evidence) {
  const report = evidence?.receipt?.report;
  if (evidence?.status !== "completed" || evidence?.receipt?.status !== "complete" || !Array.isArray(report?.legs)) {
    throw coded("cross_venue_close_requires_completed_pair");
  }
  if (Array.isArray(report.repair_fills) && report.repair_fills.length > 0) {
    throw coded("cross_venue_close_requires_unrepaired_matched_pair");
  }
  return plan.legs.map((leg) => {
    const opened = report.legs.find((item) => item?.leg_id === leg.leg_id);
    if (!opened || opened.status !== "filled" || !(Number(safeDecimal(opened.filled_base_size)) > 0)) {
      throw coded("cross_venue_close_fill_evidence_invalid");
    }
    if (leg.target_base_size && !sameDecimal(opened.filled_base_size, leg.target_base_size)) {
      throw coded("cross_venue_close_fill_evidence_invalid");
    }
    return opened;
  });
}

function closeLeg({ plan, leg, baseSize }) {
  const side = leg.side === "buy" ? "sell" : "buy";
  const reference = Number(leg.limit_price);
  if (!(reference > 0)) throw coded("cross_venue_close_reference_invalid");
  return {
    ...leg,
    leg_id: `cross_venue_close_${hash48({ execution_id: plan.execution_id, venue_id: leg.venue_id, kind: "matched_pair_close_v1" })}`,
    side,
    limit_price: trimDecimal(reference),
    target_notional_micro_usdc: Math.max(1, Math.ceil(Number(baseSize) * reference * 1_000_000)),
    target_base_size: safeDecimal(baseSize),
  };
}

async function exactVenueState({ venues, credential, venueId }) {
  const result = venueId === "hyperliquid"
    ? await venues.readHyperliquidState({ credential, market: "SOL" })
    : await venues.readBackpackState({ credential, symbol: "SOL_USDC_PERP" });
  const position = Number(result?.position_size);
  const openOrders = Number(result?.open_order_count);
  if (!Number.isFinite(position) || !Number.isSafeInteger(openOrders) || openOrders < 0) {
    throw coded("cross_venue_account_state_invalid");
  }
  return { ...result, position_size: trimSignedDecimal(position), open_order_count: openOrders };
}

async function waitForFlatAccounts({ venues, credentials, plan, sleep }) {
  let accounts = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    accounts = await Promise.all(plan.legs.map((leg) => exactVenueState({
      venues,
      credential: credentials[leg.venue_id],
      venueId: leg.venue_id,
    })));
    if (accounts.every((account) => sameDecimal(account.position_size, "0") && account.open_order_count === 0)) return accounts;
    await sleep(250);
  }
  return accounts;
}

function sameDecimal(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 1e-9;
}

function configuredCapMicroUsdc(env) {
  const cap = Number.parseFloat(env.PRIVATE_AGENT_CROSS_VENUE_MAX_NOTIONAL_USD || "0");
  return Number.isFinite(cap) && cap > 0 ? Math.round(cap * 1_000_000) : 0;
}

function credentialForVenue(venueId, venues) {
  if (venueId === "backpack") return venues.loadBackpackCredential();
  if (venueId !== "hyperliquid") throw new Error("cross_venue_venue_unsupported");
  const ref = venues.hyperliquidAccountRefs().find((item) => item.network === "mainnet" &&
    (!Array.isArray(item.market_allowlist) || item.market_allowlist.length === 0 || item.market_allowlist.includes("SOL")));
  if (!ref) throw new Error("hyperliquid_cross_venue_credential_unavailable");
  return venues.loadHyperliquidCredential({
    execution_mode: "ghola_pooled",
    network: "mainnet",
    credential_ref: ref.credential_ref,
  });
}

async function clientOrderIdForLeg(state, leg) {
  return leg.venue_id === "hyperliquid"
    ? state.deriveHyperliquidCloid(leg.leg_id)
    : state.deriveClientOrderId("backpack", leg.leg_id);
}

function noBroadcastProof(venueId) {
  return {
    version: 1,
    proof_kind: "cross_venue_child_no_broadcast_v1",
    terminal_status: "no_submit",
    venue_id: venueId,
    network: "mainnet",
    broadcast_performed: false,
    final_venue_execution_proven: true,
    final_fill_proven: false,
    final_no_broadcast_proven: true,
    checked_at: new Date().toISOString(),
  };
}

function defaultVenues() {
  return {
    hyperliquidAccountRefs: hyperliquidManagedAccountRefs,
    loadHyperliquidCredential: loadManagedHyperliquidCredential,
    loadBackpackCredential: () => loadPooledSolanaPerpsCredential("backpack"),
    readHyperliquidState: readHyperliquidExactMarketState,
    readHyperliquidBook: readHyperliquidTopOfBook,
    readBackpackState: readBackpackAccountSnapshot,
    readBackpackBook: readBackpackTopOfBook,
    verifyHyperliquid: verifyHyperliquidNoSubmit,
    verifyBackpack: verifySolanaPerpsNoSubmit,
    submitHyperliquid: submitHyperliquidExecution,
    submitBackpack: submitSolanaPerpsExecution,
    reconcileHyperliquid: reconcileHyperliquidExecution,
    reconcileBackpack: reconcileBackpackExecution,
  };
}

function boundedMicro(value, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : 0;
}
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function safeDecimal(value) {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : "0";
}
function safeReference(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 180 ? value : null;
}
function trimDecimal(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
function trimSignedDecimal(value) {
  if (!Number.isFinite(value) || Math.abs(value) <= 1e-9) return "0";
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
function coded(code) { return Object.assign(new Error(code), { code }); }
function hash48(value) { return sha256(stableJson(value)).slice(0, 48); }
function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
