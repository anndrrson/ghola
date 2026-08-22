import { createHash, randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveDecisionModel } from "./decision-provider.js";

const ACTIONS = ["trade", "hold"];
const OBJECTIVES = ["best_execution", "spot_perp_hedge", "delta_neutral_carry", "exposure_rebalance"];
const SIDES = ["buy", "sell"];

export const aiDirectDecisionSchema = z.object({
  version: z.literal(2),
  action: z.enum(ACTIONS),
  objective: z.enum(OBJECTIVES),
  market: z.string().min(2).max(32),
  side: z.enum(SIDES).nullable().optional(),
  confidence_bps: z.number().int().min(0).max(10_000),
  reason_codes: z.array(z.string().min(1).max(64)).max(10),
  user_intent_alignment: z.string().min(1).max(500),
  risk_summary: z.string().min(1).max(700),
}).strict();

export async function decideAiDirectOrder({
  session,
  market,
  positions = [],
  env = process.env,
  now = new Date(),
  minConfidenceBps = 6_500,
}) {
  const promptContext = promptContextFor({ session, market, positions, now });
  const promptHash = digest(promptContext);
  const mode = stringValue(env.PRIVATE_AGENT_AI_DIRECT_MODE).toLowerCase();

  if (mode === "mock") {
    return decisionSuccess({
      decision: mockDecision({ session, market, env }),
      model_id: stringValue(env.PRIVATE_AGENT_AI_MODEL) || "mock/structured-proposal-v2",
      prompt_hash: promptHash,
      raw_provider_metadata: { provider_kind: "mock", mode: "mock" },
      min_confidence_bps: minConfidenceBps,
      now,
    });
  }
  const provider = resolveDecisionModel({ env });
  if (!provider.ok) {
    return decisionFailure({
      error: provider.error,
      model_id: stringValue(env.PRIVATE_AGENT_AI_MODEL || env.GHOLA_PRIVATE_AGENT_AI_MODEL) || null,
      prompt_hash: promptHash,
      now,
    });
  }

  try {
    const { output, usage, response } = await generateText({
      model: provider.model,
      output: Output.object({ schema: aiDirectDecisionSchema }),
      abortSignal: AbortSignal.timeout(provider.timeout_ms),
      prompt: [
        "You are Ghola's proposal-only market decision engine.",
        "Return one version-2 structured proposal. Never choose a venue, order type, price, size, leverage, wallet action, or credential use; deterministic routing and risk code owns those decisions.",
        "Prefer hold unless fresh market state and the signed objective support action. Hedge and carry objectives may only express intent; a protected multi-leg executor decides whether they are executable.",
        "session.mandate is the user's authored trade plan. When mandate.side is 'buy' or 'sell' you MUST trade that side (it is enforced downstream regardless); honor mandate.strategy_profile, entry_trigger, and time_horizon when deciding whether to trade now or hold.",
        JSON.stringify(promptContext),
      ].join("\n\n"),
    });
    return decisionSuccess({
      decision: output,
      model_id: provider.metadata.model_id,
      prompt_hash: promptHash,
      raw_provider_metadata: {
        ...provider.metadata,
        usage: usage || null,
        response_id: response?.id || null,
      },
      min_confidence_bps: minConfidenceBps,
      now,
    });
  } catch (error) {
    return decisionFailure({
      error: "ai_decision_failed",
      model_id: provider.metadata.model_id,
      prompt_hash: promptHash,
      details: String(error?.message || error || "generation_failed"),
      now,
    });
  }
}

export function validateAiDirectDecision(value, { minConfidenceBps = 6_500 } = {}) {
  const parsed = aiDirectDecisionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: "ai_decision_schema_invalid",
      details: parsed.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`),
    };
  }
  const decision = normalizeDecision(parsed.data);
  if (decision.action === "trade" && !decision.side) {
    return { ok: false, error: "ai_trade_side_required", details: [] };
  }
  if (decision.confidence_bps < minConfidenceBps) {
    return {
      ok: false,
      error: "ai_confidence_below_threshold",
      details: [`${decision.confidence_bps}<${minConfidenceBps}`],
      decision,
    };
  }
  return { ok: true, decision };
}

export function publicDecisionRecord(record) {
  return {
    version: record.version,
    decision_id: record.decision_id,
    status: record.status,
    model_id: record.model_id,
    prompt_hash: record.prompt_hash,
    decision_commitment: record.decision_commitment || null,
    validation_error: record.validation_error || null,
    decision: record.decision ? publicDecision(record.decision) : null,
    created_at: record.created_at,
  };
}

function decisionSuccess({ decision, model_id, prompt_hash, raw_provider_metadata, min_confidence_bps, now }) {
  const validation = validateAiDirectDecision(decision, {
    minConfidenceBps: min_confidence_bps,
  });
  const record = {
    version: 2,
    decision_id: `aidec_${digest({ decision, now: now.toISOString(), nonce: randomUUID() }).slice(0, 24)}`,
    status: validation.ok ? "accepted" : "rejected",
    model_id,
    prompt_hash,
    decision_commitment: validation.ok ? `ai_decision_${digest(validation.decision)}` : null,
    validation_error: validation.ok ? null : validation.error,
    validation_details: validation.ok ? [] : validation.details || [],
    decision: validation.ok ? validation.decision : validation.decision || normalizeBestEffort(decision),
    provider_metadata: raw_provider_metadata,
    created_at: now.toISOString(),
  };
  return validation.ok
    ? { ok: true, record, decision: validation.decision }
    : { ok: false, error: validation.error, record };
}

function decisionFailure({ error, model_id, prompt_hash, details = null, now }) {
  return {
    ok: false,
    error,
    record: {
      version: 2,
      decision_id: `aidec_${digest({ error, now: now.toISOString(), nonce: randomUUID() }).slice(0, 24)}`,
      status: "rejected",
      model_id,
      prompt_hash,
      decision_commitment: null,
      validation_error: error,
      validation_details: details ? [details] : [],
      decision: null,
      provider_metadata: null,
      created_at: now.toISOString(),
    },
  };
}

function promptContextFor({ session, market, positions, now }) {
  return {
    version: 1,
    now: now.toISOString(),
    session: {
      autopilot_session_id: session.autopilot_session_id,
      policy_commitment: session.session_policy.policy_commitment,
      market_allowlist: session.session_policy.market_allowlist,
      venue_allowlist: session.session_policy.venue_allowlist,
      max_notional_bucket: session.session_policy.max_notional_bucket,
      max_daily_notional_bucket: session.session_policy.max_daily_notional_bucket,
      max_slippage_bps: session.session_policy.max_slippage_bps,
      remaining_daily_notional: Math.max(
        0,
        bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0),
      ),
      mandate: session.session_policy.agent_mandate || null,
    },
    market: {
      product_id: market.product_id,
      price: market.price,
      change_24h: market.change_24h,
      spread_bps: market.spread_bps,
      live_status: market.live_status,
      stale: market.stale === true,
    },
    positions: positions.map((position) => ({
      venue_id: position.venue_id,
      market: position.market,
      side: position.side,
      notional_usd: position.notional_usd,
      updated_at: position.updated_at,
    })),
  };
}

function mockDecision({ session, market, env }) {
  const changeBps = Math.round(Number(market.change_24h || 0) * 100);
  const side = changeBps >= 0 ? "buy" : "sell";
  const forceHold = env.PRIVATE_AGENT_AI_DIRECT_MOCK_ACTION === "hold";
  return {
    version: 2,
    action: forceHold ? "hold" : "trade",
    objective: "best_execution",
    market: market.product_id,
    side: forceHold ? null : side,
    confidence_bps: forceHold ? 7_000 : 7_200 + Math.min(1_000, Math.abs(changeBps)),
    reason_codes: forceHold ? ["mock_hold"] : ["mock_proposal", "bounded_policy"],
    user_intent_alignment: "Mock proposal follows the active objective and signed policy.",
    risk_summary: "Deterministic code still owns venue, size, costs, readiness, and execution veto.",
  };
}

function normalizeDecision(value) {
  return {
    version: 2,
    action: value.action,
    objective: value.objective,
    market: normalizeMarket(value.market),
    side: value.side || null,
    confidence_bps: Number(value.confidence_bps || 0),
    reason_codes: value.reason_codes,
    user_intent_alignment: value.user_intent_alignment,
    risk_summary: value.risk_summary,
  };
}

function normalizeBestEffort(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: stringValue(value.action) || "hold",
    objective: stringValue(value.objective) || "unknown",
    market: stringValue(value.market) || "unknown",
    confidence_bps: Number(value.confidence_bps || 0),
  };
}

function publicDecision(decision) {
  return {
    version: decision.version,
    action: decision.action,
    objective: decision.objective,
    market: decision.market,
    side: decision.side,
    confidence_bps: decision.confidence_bps,
    reason_codes: decision.reason_codes,
    user_intent_alignment: decision.user_intent_alignment,
    risk_summary: decision.risk_summary,
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

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 48);
}
