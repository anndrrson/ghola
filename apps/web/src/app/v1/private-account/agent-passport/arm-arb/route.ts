import {
  json,
  privateAccountLiveGuard,
} from "../../_lib";
import {
  createAutonomousAutopilotSessionFromBody,
} from "@/lib/private-account-autopilot";
import {
  agentPassportReadinessForOwner,
} from "@/lib/private-agent-passport";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;

  const readiness = await agentPassportReadinessForOwner(guarded.owner);
  if (!readiness.can_arm) {
    return json({
      version: 1,
      error: "agent_passport_not_ready",
      blockers: readiness.blockers,
      readiness,
    }, 409);
  }

  const body = safeRecord(guarded.body);
  const mode = stringValue(body.mode) === "no_submit" ? "no_submit" : "tiny_live";
  if (mode === "tiny_live" && !readiness.can_live_submit) {
    return json({
      version: 1,
      error: "guarded_arb_live_not_ready",
      blockers: readiness.live_submit_blockers,
      readiness,
    }, 409);
  }

  const policy = guardedArbPolicy(body, readiness);
  const created = await createAutonomousAutopilotSessionFromBody({
    session_policy: policy,
  }, guarded.owner);
  if (!created.session.worker_autopilot_session_id || !created.session.execution_enabled) {
    return json({
      version: 1,
      error: "worker_arb_not_armed",
      mode,
      readiness,
      session: created.session,
      events: created.events,
    }, 502);
  }

  return json({
    version: 1,
    mode,
    readiness,
    ...created,
  }, 201);
}

function guardedArbPolicy(body: Record<string, unknown>, readiness: Awaited<ReturnType<typeof agentPassportReadinessForOwner>>) {
  const ready = new Set(readiness.ready_venues);
  const venues = [
    ...(ready.has("coinbase_advanced") ? ["coinbase_advanced"] : []),
    ...(ready.has("jupiter") ? ["jupiter"] : []),
    "hyperliquid",
  ];
  return {
    strategy_id: "hedged_spread_arbitrage_v1",
    decision_model: "rules_plus_ai_score",
    ai_direct_enabled: false,
    venue_allowlist: venues,
    market_allowlist: [market(body.market, readiness.supported_markets)],
    max_notional_bucket: notionalBucket(body.max_notional_bucket, "5"),
    max_daily_notional_bucket: notionalBucket(body.max_daily_notional_bucket, "25"),
    max_order_count: integer(body.max_order_count, 2, 10, 4),
    ttl_ms: integer(body.ttl_ms, 5 * 60_000, 4 * 60 * 60_000, 60 * 60_000),
    max_slippage_bps: integer(body.max_slippage_bps, 1, 100, 25),
    cooldown_ms: integer(body.cooldown_ms, 60_000, 30 * 60_000, 60_000),
    data_max_age_ms: integer(body.data_max_age_ms, 5_000, 5 * 60_000, 15_000),
    min_net_edge_bps: integer(body.min_net_edge_bps, 1, 5_000, envInteger("PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS", 25)),
    max_execution_skew_ms: integer(body.max_execution_skew_ms, 50, 60_000, envInteger("PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS", 2_000)),
    allowed_order_types: ["spot_market_order", "swap", "limit_order", "cancel"],
    kill_switch: body.kill_switch === true,
    reduce_only_on_reconcile_failure: true,
  };
}

function market(value: unknown, supported: string[]) {
  const normalized = String(value || "SOL-USD").trim().toUpperCase();
  if (supported.includes(normalized)) return normalized;
  if (normalized === "SOL" || normalized === "SOL/USDC") return "SOL-USD";
  if (normalized === "BTC") return "BTC-USD";
  if (normalized === "ETH") return "ETH-USD";
  return "SOL-USD";
}

function notionalBucket(value: unknown, fallback: "5" | "25") {
  const raw = String(value || "").trim();
  return raw === "5" || raw === "10" || raw === "25" ? raw : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function envInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
