import { createHash, randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";

const VENUES = ["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"];
const ACTIONS = ["trade", "hold", "cancel", "reduce"];
const SIDES = ["buy", "sell"];
const OPS = ["swap", "spot_market_order", "spot_limit_order", "perp_limit_order", "limit_order", "cancel"];

export const aiDirectDecisionSchema = z.object({
  action: z.enum(ACTIONS),
  venue_id: z.enum(VENUES),
  market: z.string().min(2).max(32),
  side: z.enum(SIDES).nullable().optional(),
  operation_class: z.enum(OPS),
  quote_size_usd: z.number().finite().min(0).max(100_000),
  limit_price: z.number().finite().positive().nullable().optional(),
  max_slippage_bps: z.number().int().min(1).max(1_000).nullable().optional(),
  time_in_force: z.string().min(2).max(16).nullable().optional(),
  confidence_bps: z.number().int().min(0).max(10_000),
  reason_codes: z.array(z.string().min(1).max(64)).max(10),
  user_intent_alignment: z.string().min(1).max(500),
  risk_summary: z.string().min(1).max(700),
});

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
  const model = stringValue(env.PRIVATE_AGENT_AI_MODEL || env.GHOLA_PRIVATE_AGENT_AI_MODEL);
  const mode = stringValue(env.PRIVATE_AGENT_AI_DIRECT_MODE).toLowerCase();
  const modelId = model || (mode === "mock" ? "mock/ai-direct-order-v1" : null);
  if (!modelId) {
    return decisionFailure({
      error: "ai_model_unconfigured",
      model_id: null,
      prompt_hash: promptHash,
      now,
    });
  }

  if (mode === "mock") {
    return decisionSuccess({
      decision: mockDecision({ session, market, env }),
      model_id: modelId,
      prompt_hash: promptHash,
      raw_provider_metadata: { mode: "mock" },
      min_confidence_bps: minConfidenceBps,
      now,
    });
  }

  try {
    const { output, usage, response } = await generateText({
      model: modelId,
      output: Output.object({ schema: aiDirectDecisionSchema }),
      prompt: [
        "You are Ghola's autonomous trading decision engine.",
        "Return exactly one structured decision. You may originate an order, but every decision is validated by hard policy before submit.",
        "Prefer hold unless the market data, user intent, and policy allow a small bounded trade.",
        JSON.stringify(promptContext),
      ].join("\n\n"),
    });
    return decisionSuccess({
      decision: output,
      model_id: modelId,
      prompt_hash: promptHash,
      raw_provider_metadata: {
        usage: usage || null,
        response_id: response?.id || null,
      },
      min_confidence_bps: minConfidenceBps,
      now,
    });
  } catch (error) {
    return decisionFailure({
      error: "ai_decision_failed",
      model_id: modelId,
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
  if (decision.action === "trade" && decision.quote_size_usd <= 0) {
    return { ok: false, error: "ai_trade_quote_size_required", details: [] };
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
    version: 1,
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
    version: 1,
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
      version: 1,
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
  const venue = selectMockVenue(session, market);
  const operationClass = operationForVenue(venue);
  const quote = Math.min(
    bucketToUsd(session.session_policy.max_notional_bucket),
    Math.max(0, bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0)),
  );
  const forceHold = env.PRIVATE_AGENT_AI_DIRECT_MOCK_ACTION === "hold" || quote <= 0;
  return {
    action: forceHold ? "hold" : "trade",
    venue_id: venue,
    market: market.product_id,
    side: forceHold ? null : side,
    operation_class: forceHold ? operationClass : operationClass,
    quote_size_usd: forceHold ? 0 : quote,
    limit_price: Number(market.price || market.mid || 0) || null,
    max_slippage_bps: session.session_policy.max_slippage_bps,
    time_in_force: venue === "hyperliquid" ? "Ioc" : "ioc",
    confidence_bps: forceHold ? 7_000 : 7_200 + Math.min(1_000, Math.abs(changeBps)),
    reason_codes: forceHold ? ["mock_hold"] : ["mock_ai_direct", "bounded_policy"],
    user_intent_alignment: "Mock AI direct decision follows the active autonomous trading policy.",
    risk_summary: "Decision remains subject to deterministic policy, venue readiness, and notional caps.",
  };
}

function normalizeDecision(value) {
  return {
    action: value.action,
    venue_id: value.venue_id,
    market: normalizeMarket(value.market),
    side: value.side || null,
    operation_class: value.operation_class,
    quote_size_usd: Number(value.quote_size_usd || 0),
    limit_price: numberOrNull(value.limit_price),
    max_slippage_bps: Number.isInteger(value.max_slippage_bps) ? value.max_slippage_bps : null,
    time_in_force: value.time_in_force || null,
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
    venue_id: stringValue(value.venue_id) || "unknown",
    market: stringValue(value.market) || "unknown",
    operation_class: stringValue(value.operation_class) || "unknown",
    confidence_bps: Number(value.confidence_bps || 0),
  };
}

function publicDecision(decision) {
  return {
    action: decision.action,
    venue_id: decision.venue_id,
    market: decision.market,
    side: decision.side,
    operation_class: decision.operation_class,
    quote_size_bucket: String(decision.quote_size_usd),
    limit_price: decision.limit_price,
    max_slippage_bps: decision.max_slippage_bps,
    confidence_bps: decision.confidence_bps,
    reason_codes: decision.reason_codes,
    user_intent_alignment: decision.user_intent_alignment,
    risk_summary: decision.risk_summary,
  };
}

function selectMockVenue(session, market) {
  const ready = session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
  if (market.product_id === "SOL-USD" && ready.includes("jupiter")) return "jupiter";
  if (ready.includes("coinbase_advanced")) return "coinbase_advanced";
  if (ready.includes("phoenix")) return "phoenix";
  if (ready.includes("hyperliquid")) return "hyperliquid";
  return ready[0] || session.session_policy.venue_allowlist[0] || "jupiter";
}

function operationForVenue(venue) {
  if (venue === "jupiter") return "swap";
  if (venue === "coinbase_advanced") return "spot_market_order";
  if (venue === "phoenix") return "perp_limit_order";
  return "limit_order";
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

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
