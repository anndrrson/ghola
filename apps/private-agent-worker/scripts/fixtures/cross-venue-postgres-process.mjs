import { createHash } from "node:crypto";
import { createCrossVenueCoordinator } from "../../src/execution/cross-venue.js";
import { createLiveCrossVenueAdapter } from "../../src/execution/cross-venue-live.js";
import { createPostgresWorkerState } from "../../src/state/private-state.js";

const [, , databaseUrl, seed, mode = "normal"] = process.argv;
if (!databaseUrl || !seed) process.exit(2);

const state = createPostgresWorkerState(databaseUrl, { driver: "pg" });
let submitCalls = 0;
let closeSubmitCalls = 0;
let scheduled = null;
const closing = mode.includes("close");
const terminal = !mode.startsWith("crash");
const plan = execution(seed);
const closeIds = Object.fromEntries(plan.legs.map((leg) => [leg.venue_id, closeLegId(plan, leg.venue_id)]));
const closeHyperliquidCloid = await state.deriveHyperliquidCloid(closeIds.hyperliquid);
const venues = {
  hyperliquidAccountRefs: () => [{ credential_ref: "hl-mainnet", network: "mainnet", market_allowlist: ["SOL"] }],
  loadHyperliquidCredential: () => ({ network: "mainnet" }),
  loadBackpackCredential: () => ({ maxOrderNotionalUsd: 11 }),
  verifyHyperliquid: async () => ({ status: "verified_no_funds" }),
  verifyBackpack: async () => ({ status: "verified_no_funds" }),
  readHyperliquidState: async () => account(await positionFor("hyperliquid")),
  readBackpackState: async () => account(await positionFor("backpack")),
  submitHyperliquid: async ({ cloid, instruction }) => {
    if (instruction.order.reduce_only === true) {
      if (mode === "recover_close") throw new Error("duplicate_hyperliquid_close");
      closeSubmitCalls += 1;
      return terminal
        ? { status: "filled", provider_ref_seed: { cloid, oid: 91 }, fills: [{ oid: 91, px: "75.74", sz: "0.14" }], final_proof: fillProof("hyperliquid") }
        : { status: "submitted", provider_ref_seed: { cloid }, fills: [] };
    }
    if (mode === "recover") throw new Error("duplicate_hyperliquid_submit");
    submitCalls += 1;
    return terminal
      ? { status: "filled", provider_ref_seed: { cloid, oid: 71 }, fills: [{ oid: 71, px: "75.76", sz: "0.14" }], final_proof: fillProof("hyperliquid") }
      : { status: "submitted", provider_ref_seed: { cloid }, fills: [] };
  },
  submitBackpack: async ({ clientOrderId, instruction }) => {
    if (instruction.order.reduce_only === true) {
      if (mode === "recover_close") throw new Error("duplicate_backpack_close");
      closeSubmitCalls += 1;
      return { status: "submitted", provider_ref_seed: { client_order_id: clientOrderId }, fills: [] };
    }
    if (mode === "recover") throw new Error("duplicate_backpack_submit");
    submitCalls += 1;
    return { status: "submitted", provider_ref_seed: { client_order_id: clientOrderId }, fills: [] };
  },
  reconcileHyperliquid: async ({ cloid }) => terminal
    ? terminalFill("hyperliquid", cloid === closeHyperliquidCloid ? 10_603_600 : 10_606_400)
    : pending("hyperliquid"),
  reconcileBackpack: async ({ instruction }) => terminal
    ? terminalFill("backpack", instruction.order.reduce_only === true ? 10_603_600 : 10_599_400)
    : pending("backpack"),
};
const env = {
  PRIVATE_AGENT_VENUE_DRY_RUN: "false",
  PRIVATE_AGENT_CROSS_VENUE_PAIR: "hyperliquid:backpack",
  PRIVATE_AGENT_CROSS_VENUE_MAX_NOTIONAL_USD: "11",
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill",
  PRIVATE_AGENT_BACKPACK_LIVE_MODE: "tiny_live",
};

try {
  const adapter = createLiveCrossVenueAdapter({ state, venues, env, sleep: async () => {} });
  const coordinator = createCrossVenueCoordinator({
    state,
    adapter,
    callback: async () => {},
    schedule: (task) => { scheduled = Promise.resolve().then(task); },
  });
  const result = closing ? await coordinator.close(plan) : await coordinator.submit(plan);
  if (!closing && scheduled) await scheduled.catch(() => null);
  const parentWorkOrder = closing ? `${plan.execution_id}:close_v1` : plan.execution_id;
  const parent = await state.getExecutionClaimEvidence(parentWorkOrder);
  process.stdout.write(`CROSS_VENUE_RESULT ${JSON.stringify({
    status: result.status,
    ok: result.ok,
    replayed: result.replayed === true,
    submit_calls: submitCalls,
    close_submit_calls: closeSubmitCalls,
    parent_status: parent?.status || null,
  })}\n`);
} finally {
  await state.close();
}

async function positionFor(venueId) {
  if (!closing) return "0";
  const closeEvidence = await state.getExecutionClaimEvidence(closeIds[venueId]);
  if (closeEvidence) return "0";
  return venueId === "hyperliquid" ? "0.14" : "-0.14";
}

function account(position_size) {
  return { status: "ready_to_trade", position_size, open_order_count: 0 };
}

function closeLegId(planValue, venueId) {
  return `cross_venue_close_${hash48({ execution_id: planValue.execution_id, venue_id: venueId, kind: "matched_pair_close_v1" })}`;
}

function execution(value) {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 48);
  return {
    version: 1,
    execution_id: `consumer_cross_venue_execution_${suffix}`,
    owner_commitment: `owner_cross_${suffix}`,
    opportunity_commitment: `opportunity_cross_${suffix}`,
    market: "SOL-USD",
    matched_notional_micro_usdc: 11_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 11_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 11_000_000,
    },
    legs: [
      { leg_id: `cross_hl_${suffix}`, venue_id: "hyperliquid", side: "buy", symbol: "SOL", limit_price: "75.76", target_notional_micro_usdc: 11_000_000, target_base_size: "0.14", order_type: "ioc_limit" },
      { leg_id: `cross_bp_${suffix}`, venue_id: "backpack", side: "sell", symbol: "SOL_USDC_PERP", limit_price: "75.71", target_notional_micro_usdc: 11_000_000, target_base_size: "0.14", order_type: "ioc_limit" },
    ],
  };
}

function terminalFill(venueId, notional) {
  return {
    terminal: true,
    status: "filled",
    filled_notional_micro_usdc: notional,
    filled_base_size: "0.14",
    venue_order_reference: `${venueId}:recovered`,
    fills: [],
    final_proof: fillProof(venueId),
  };
}

function pending(venueId) {
  return { terminal: false, status: "unknown", filled_notional_micro_usdc: 0, filled_base_size: "0", venue_order_reference: `${venueId}:pending`, fills: [], final_proof: null };
}

function fillProof(venueId) {
  return {
    version: 1,
    proof_kind: `${venueId}_execution_proof_v1`,
    terminal_status: "filled",
    venue_id: venueId,
    network: "mainnet",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: true,
    checked_at: new Date().toISOString(),
  };
}

function hash48(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
