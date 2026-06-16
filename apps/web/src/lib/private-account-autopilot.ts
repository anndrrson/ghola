import { createHash, randomUUID } from "node:crypto";
import {
  workerAuthorizationHeader,
} from "./private-agent-capability";
import {
  discoverPhalaPrivateAgentExecutionUrl,
  wakePhalaPrivateAgentForUse,
} from "./private-agent-phala";
import {
  agentPassportVenueAccessForWorker,
  storedVenueAccessForWorker,
} from "./private-agent-passport";
import type { PrivateAccountRequestOwner } from "@/app/v1/private-account/_lib";
import {
  getPrivateAutopilotSession,
  listPrivateAutopilotEvents,
  listPrivateAutopilotSessions,
  putPrivateAutopilotEvent,
  putPrivateAutopilotSession,
  resetPrivateAutopilotStoreForTests,
  type PrivateAutopilotEventRecordV1,
  type PrivateAutopilotSessionRecordV1,
} from "./private-account-store";

export type AutopilotVenueId = "jupiter" | "phoenix" | "hyperliquid" | "coinbase_advanced" | "backpack";
export type AutopilotStatus =
  | "armed"
  | "watching"
  | "running"
  | "pending_worker"
  | "pending_funding"
  | "paused"
  | "killed"
  | "blocked"
  | "expired";
export type AutopilotEventType =
  | "agent_tick"
  | "ai_decision"
  | "ai_score"
  | "funding_required"
  | "session_created"
  | "session_state"
  | "venue_readiness"
  | "proposal"
  | "execution"
  | "live_order_submitted"
  | "position_update"
  | "risk_reject"
  | "venue_reconcile"
  | "guardrail"
  | "receipt"
  | "arb_scan"
  | "arb_opportunity"
  | "arb_reject"
  | "arb_pair_preflight"
  | "arb_pair_submitted"
  | "arb_pair_reconciled"
  | "emergency_hedge"
  | "unhedged_leg_requires_human";

export interface AutopilotOwner {
  owner_commitment: string;
  user?: PrivateAccountRequestOwner["user"];
}

export type AutopilotStrategyId =
  | "momentum_micro_trader"
  | "hedged_spread_arbitrage_v1"
  | "tri_venue_market_maker_v1"
  | "level_trigger_v1";

// Directional plan drawn on /trade and executed by the worker level_trigger
// strategy. Field values use the worker mandate vocabulary (see
// private-agent-worker/src/execution/policy.js).
export interface AutopilotAgentMandate {
  strategy_profile: string;
  entry_trigger: string;
  exit_rule: string;
  time_horizon: string;
  trigger_level?: string;
  invalidation_level?: string;
  edge_threshold_bps?: string;
  time_window?: string;
  strategy_note?: string;
}

export interface AutopilotSessionPolicy {
  strategy_id: AutopilotStrategyId;
  decision_model: "rules_plus_ai_score" | "ai_direct_order_v1" | "deterministic_level_trigger";
  ai_direct_enabled: boolean;
  venue_allowlist: AutopilotVenueId[];
  market_allowlist: string[];
  max_notional_bucket: "5" | "10" | "25" | "50" | "100";
  max_position_notional_bucket: "50" | "100" | "250" | "500";
  max_daily_notional_bucket: "25" | "50" | "100" | "250";
  max_order_count: number;
  ttl_ms: number;
  max_slippage_bps: number;
  cooldown_ms: number;
  data_max_age_ms: number;
  min_net_edge_bps: number;
  max_execution_skew_ms: number;
  min_ai_score_bps: number;
  ai_min_confidence_bps: number;
  min_signal_bps: number;
  max_spread_bps: number;
  allowed_order_types: Array<
    "swap" | "spot_limit_order" | "spot_market_order" | "perp_limit_order" | "limit_order" | "cancel"
  >;
  kill_switch: boolean;
  reduce_only_on_reconcile_failure: boolean;
  locale_hint: "en" | "zh-CN" | "id";
  timezone: string | null;
  agent_mandate?: AutopilotAgentMandate | null;
  agent_side?: "buy" | "sell";
  policy_commitment: string;
}

export interface AutopilotSession {
  version: 2;
  autopilot_session_id: string;
  worker_autopilot_session_id: string | null;
  worker_session_commitment: string | null;
  owner_commitment: string;
  status: AutopilotStatus;
  strategy: {
    version: 1;
    strategy_id: AutopilotStrategyId;
    decision_model: "rules_plus_ai_score" | "ai_direct_order_v1" | "deterministic_level_trigger";
    executable_order_source:
      | "deterministic_guarded_strategy"
      | "ai_structured_decision_validated_by_policy"
      | "deterministic_guarded_arb_planner"
      | "deterministic_guarded_market_maker"
      | "deterministic_level_trigger";
    ai_can_execute_directly: boolean;
  };
  session_policy: AutopilotSessionPolicy;
  venue_access: Record<AutopilotVenueId, {
    status: "ready" | "needs_funds" | "venue_access_required" | "blocked";
    execution_mode: string | null;
    reason: string | null;
  }>;
  order_count: number;
  daily_notional_used_bucket: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  next_step: string;
  execution_enabled: boolean;
  control_plane: "android" | "worker";
  visibility_summary: {
    main_wallet_prompts_per_trade: false;
    execution_boundary: "bounded_session_policy" | "bounded_delegated_worker_policy";
    user_can_kill_anytime: true;
  };
}

export interface AutopilotEvent {
  version: 1;
  autopilot_session_id: string;
  event_id: string;
  type: AutopilotEventType;
  status: AutopilotStatus;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface AutopilotCreateResult {
  session: AutopilotSession;
  events: AutopilotEvent[];
}

export interface AutopilotVenueReadiness {
  venue_id: AutopilotVenueId;
  status: "ready" | "needs_funds" | "blocked";
  live_mode: string | null;
  reason_codes: string[];
}

export interface AutopilotReadiness {
  version: 1;
  product_id: string;
  can_arm: boolean;
  can_live_submit: boolean;
  worker_configured: boolean;
  seeker_required: boolean;
  wallet_binding_status: "active" | "missing" | "unknown";
  target_live_mode: "tiny_live_orders";
  blockers: string[];
  venue_readiness: AutopilotVenueReadiness[];
}

interface AutopilotWorkerRuntime {
  wakePhalaForUse?: typeof wakePhalaPrivateAgentForUse;
  discoverPhalaExecutionUrl?: typeof discoverPhalaPrivateAgentExecutionUrl;
}

const DEFAULT_VENUES: AutopilotVenueId[] = ["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"];
const SUPPORTED_VENUE_LIST: AutopilotVenueId[] = [
  "jupiter",
  "phoenix",
  "hyperliquid",
  "coinbase_advanced",
  "backpack",
];
const SUPPORTED_VENUES = new Set<AutopilotVenueId>(SUPPORTED_VENUE_LIST);
const DEFAULT_MARKETS = ["SOL-USD", "BTC-USD", "ETH-USD"];
const SUPPORTED_MARKETS = new Set([
  "SOL-USD",
  "BTC-USD",
  "ETH-USD",
  "SOL/USDC",
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
]);
const AUTOPILOT_STATUSES = new Set<AutopilotStatus>([
  "armed",
  "watching",
  "running",
  "pending_worker",
  "pending_funding",
  "paused",
  "killed",
  "blocked",
  "expired",
]);
const AUTOPILOT_EVENT_TYPES = new Set<AutopilotEventType>([
  "agent_tick",
  "ai_decision",
  "ai_score",
  "funding_required",
  "session_created",
  "session_state",
  "venue_readiness",
  "proposal",
  "execution",
  "live_order_submitted",
  "position_update",
  "risk_reject",
  "venue_reconcile",
  "guardrail",
  "receipt",
  "arb_scan",
  "arb_opportunity",
  "arb_reject",
  "arb_pair_preflight",
  "arb_pair_submitted",
  "arb_pair_reconciled",
  "emergency_hedge",
  "unhedged_leg_requires_human",
]);

export async function createAutopilotSessionFromBody(
  body: unknown,
  owner: AutopilotOwner,
  now: Date = new Date(),
): Promise<AutopilotCreateResult> {
  const value = record(body);
  const policy = normalizePolicy(value);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + policy.ttl_ms).toISOString();
  const id = `autopilot_${digest({
    owner_commitment: owner.owner_commitment,
    policy,
    nonce: randomUUID(),
  })}`;
  const session: AutopilotSession = {
    version: 2,
    autopilot_session_id: id,
    worker_autopilot_session_id: null,
    worker_session_commitment: null,
    owner_commitment: owner.owner_commitment,
    status: policy.kill_switch ? "killed" : "pending_worker",
    strategy: strategyForPolicy(policy),
    session_policy: policy,
    venue_access: defaultVenueAccess(policy),
    order_count: 0,
    daily_notional_used_bucket: "0",
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
    next_step: policy.kill_switch
      ? "Kill switch is active. Create a new session to resume autopilot."
      : "Waiting for the private worker to arm autonomous execution.",
    execution_enabled: false,
    control_plane: "android",
    visibility_summary: {
      main_wallet_prompts_per_trade: false,
      execution_boundary: "bounded_delegated_worker_policy",
      user_can_kill_anytime: true,
    },
  };
  await persistSession(session);
  const initialEvents = [
    makeEvent(session, "session_created", "Autonomous autopilot session requested.", {
      policy,
    }, now),
    makeEvent(session, "venue_readiness", "Venue rails selected for bounded autonomous execution.", {
      venues: policy.venue_allowlist.map((venue) => ({
        venue_id: venue,
        status: session.venue_access[venue].status,
        reason: session.venue_access[venue].reason,
      })),
    }, now),
    makeEvent(session, "guardrail", "Moderate APAC retail defaults are active.", {
      max_notional_bucket: policy.max_notional_bucket,
      max_daily_notional_bucket: policy.max_daily_notional_bucket,
      max_order_count: policy.max_order_count,
      max_slippage_bps: policy.max_slippage_bps,
    }, now),
  ];
  await Promise.all(initialEvents.map((event) => appendEvent(event, session.owner_commitment)));
  return { session: publicSession(session), events: initialEvents };
}

export async function createAutonomousAutopilotSessionFromBody(
  body: unknown,
  owner: AutopilotOwner,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  runtime: AutopilotWorkerRuntime = {},
): Promise<AutopilotCreateResult> {
  const created = await createAutopilotSessionFromBody(body, owner, now);
  const worker = await armWorkerAutopilotSession({
    body,
    owner,
    session: created.session,
    env,
    fetchImpl,
    runtime,
  });
  if (worker.ok) {
    const merged = await mergeWorkerSession(created.session.autopilot_session_id, worker.session, now);
    for (const event of worker.events) {
      await appendEvent(workerEventToLocal(merged, event, now), merged.owner_commitment);
    }
    return {
      session: publicSession(merged),
      events: await eventsForSession(merged.owner_commitment, created.session.autopilot_session_id, 200),
    };
  }
  const local = await loadSession(created.session.autopilot_session_id);
  if (local) {
    local.status = "pending_worker";
    local.execution_enabled = false;
    local.next_step = worker.error === "worker_not_configured"
      ? "Private worker is not configured. Set GHOLA_PRIVATE_AGENT_EXECUTION_URL and execution token."
      : "Private worker rejected or could not arm the autonomous session.";
    local.updated_at = now.toISOString();
    await persistSession(local);
    await appendEvent(makeEvent(local, "guardrail", "Autonomous worker is not armed.", {
      error: worker.error,
    }, now), local.owner_commitment);
    return {
      session: publicSession(local),
      events: await eventsForSession(local.owner_commitment, local.autopilot_session_id, 200),
    };
  }
  return created;
}

export async function getAutopilotSessionForOwner(
  sessionId: string,
  owner: AutopilotOwner,
  now: Date = new Date(),
): Promise<AutopilotSession | null> {
  const session = await loadSession(sessionId);
  if (!session || session.owner_commitment !== owner.owner_commitment) return null;
  const before = `${session.status}:${session.updated_at}`;
  const refreshed = refreshExpiry(session, now);
  if (`${refreshed.status}:${refreshed.updated_at}` !== before) {
    await persistSession(refreshed);
  }
  return publicSession(refreshed);
}

export async function listAutopilotSessionsForOwner(
  owner: AutopilotOwner,
  now: Date = new Date(),
): Promise<AutopilotSession[]> {
  const records = await listPrivateAutopilotSessions(owner.owner_commitment, 25);
  const sessions = records
    .map(sessionFromRecord)
    .filter((session): session is AutopilotSession => Boolean(session));
  const refreshed: AutopilotSession[] = [];
  for (const session of sessions) {
    const before = `${session.status}:${session.updated_at}`;
    const active = refreshExpiry(session, now);
    if (`${active.status}:${active.updated_at}` !== before) await persistSession(active);
    refreshed.push(publicSession(active));
  }
  return refreshed
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 25);
}

export async function controlAutopilotSessionFromBody(
  sessionId: string,
  action: "pause" | "resume" | "kill",
  owner: AutopilotOwner,
  now: Date = new Date(),
): Promise<{ session: AutopilotSession; event: AutopilotEvent } | { error: "autopilot_session_not_found" }> {
  const session = await loadSession(sessionId);
  if (!session || session.owner_commitment !== owner.owner_commitment) {
    return { error: "autopilot_session_not_found" };
  }
  const active = refreshExpiry(session, now);
  if (action === "kill") {
    active.status = "killed";
    active.execution_enabled = false;
    active.next_step = "Kill switch active. No further agent execution is allowed.";
  } else if (active.status === "expired") {
    active.execution_enabled = false;
    active.next_step = "Session expired. Create a new autopilot session.";
  } else if (action === "pause") {
    active.status = "paused";
    active.execution_enabled = false;
    active.next_step = "Autopilot paused. Resume or kill from the device.";
  } else {
    const ready = Object.values(active.venue_access).some((venue) => venue.status === "ready");
    active.status = ready ? "running" : active.worker_autopilot_session_id ? "pending_funding" : "pending_worker";
    active.execution_enabled = ready;
    active.next_step = ready
      ? "Autonomous worker is running."
      : active.worker_autopilot_session_id
        ? "Fund an isolated venue vault before live execution."
        : "Private worker is not armed.";
  }
  active.updated_at = now.toISOString();
  await persistSession(active);
  const event = makeEvent(active, "session_state", `Autopilot ${action}.`, { action }, now);
  await appendEvent(event, active.owner_commitment);
  return { session: publicSession(active), event };
}

export async function controlAutonomousAutopilotSessionFromBody(
  sessionId: string,
  action: "pause" | "resume" | "kill",
  owner: AutopilotOwner,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { session: AutopilotSession; event: AutopilotEvent }
  | { error: "autopilot_session_not_found" }
> {
  const local = await controlAutopilotSessionFromBody(sessionId, action, owner, now);
  if ("error" in local) return local;
  const workerSessionId = local.session.worker_autopilot_session_id;
  if (!workerSessionId) return local;

  const worker = await controlWorkerAutopilotSession(workerSessionId, action, env, fetchImpl);
  if (worker.ok) {
    const merged = await mergeWorkerSession(sessionId, worker.session, now);
    for (const event of worker.events) {
      await appendEvent(workerEventToLocal(merged, event, now), merged.owner_commitment);
    }
    return {
      session: publicSession(merged),
      event: local.event,
    };
  }

  const session = await loadSession(sessionId);
  if (session) {
    await appendEvent(makeEvent(session, "guardrail", "Worker control command could not be confirmed.", {
      action,
      error: worker.error,
      worker_autopilot_session_id: workerSessionId,
    }, now), session.owner_commitment);
  }
  return local;
}

export async function listAutopilotEventsForOwner(
  sessionId: string,
  owner: AutopilotOwner,
  now: Date = new Date(),
): Promise<{ session: AutopilotSession; events: AutopilotEvent[] } | { error: "autopilot_session_not_found" }> {
  const session = await getAutopilotSessionForOwner(sessionId, owner, now);
  if (!session) return { error: "autopilot_session_not_found" };
  return {
    session,
    events: await eventsForSession(owner.owner_commitment, sessionId, 100),
  };
}

export async function listAutopilotOpportunitiesForOwner(
  sessionId: string,
  owner: AutopilotOwner,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<
  | { session: AutopilotSession; opportunities: Record<string, unknown>[] }
  | { error: "autopilot_session_not_found" | "worker_not_configured" | "worker_unavailable" | string }
> {
  const session = await getAutopilotSessionForOwner(sessionId, owner, now);
  if (!session) return { error: "autopilot_session_not_found" };
  if (!session.worker_autopilot_session_id) return { session, opportunities: [] };
  const worker = await fetchWorkerAutopilotOpportunities(session.worker_autopilot_session_id, env, fetchImpl);
  if (!worker.ok) return { error: worker.error };
  const merged = await mergeWorkerSession(sessionId, worker.session, now);
  return {
    session: merged,
    opportunities: worker.opportunities,
  };
}

export function resetAutopilotSessionsForTests() {
  resetPrivateAutopilotStoreForTests();
}

export function autopilotReadinessForOwner(
  productId: string,
  env: Record<string, string | undefined> = process.env,
  walletBindingStatus: "active" | "missing" | "unknown" = "unknown",
): AutopilotReadiness {
  const product = normalizeMarket(productId || "BTC-USD");
  const worker = workerConfig(env);
  const workerConfigured = Boolean(worker.url && workerAuthConfigured(env, worker.token));
  const seekerRequired = env.GHOLA_SEEKER_AUTOPILOT_REQUIRED !== "false";
  const walletBound = !seekerRequired || walletBindingStatus === "active";
  const venueReadiness: AutopilotVenueReadiness[] = [
    hyperliquidAutopilotReadiness(env, workerConfigured),
    phoenixAutopilotReadiness(env, workerConfigured),
    jupiterAutopilotReadiness(env, workerConfigured),
    coinbaseAutopilotReadiness(env, workerConfigured),
  ];
  const liveVenueReady = venueReadiness.some((venue) => venue.status === "ready");
  const canLiveSubmit = liveVenueReady && walletBound;
  const blockers = [
    ...(workerConfigured ? [] : ["private_worker_not_configured"]),
    ...(walletBound ? [] : ["wallet_binding_required"]),
    ...(liveVenueReady ? [] : ["tiny_live_order_gate_not_ready"]),
    ...venueReadiness
      .filter((venue) => venue.status !== "ready")
      .flatMap((venue) => venue.reason_codes.map((reason) => `${venue.venue_id}:${reason}`)),
  ];
  return {
    version: 1,
    product_id: product,
    can_arm: workerConfigured && walletBound,
    can_live_submit: canLiveSubmit,
    worker_configured: workerConfigured,
    seeker_required: seekerRequired,
    wallet_binding_status: walletBindingStatus,
    target_live_mode: "tiny_live_orders",
    blockers: unique(blockers).slice(0, 20),
    venue_readiness: venueReadiness,
  };
}

export async function syncWorkerAutopilotSession(
  sessionId: string,
  owner: AutopilotOwner,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<{ session: AutopilotSession; events: AutopilotEvent[] } | { error: "autopilot_session_not_found" }> {
  const session = await loadSession(sessionId);
  if (!session || session.owner_commitment !== owner.owner_commitment) {
    return { error: "autopilot_session_not_found" };
  }
  if (!session.worker_autopilot_session_id) {
    const before = `${session.status}:${session.updated_at}`;
    const refreshed = refreshExpiry(session, now);
    if (`${refreshed.status}:${refreshed.updated_at}` !== before) await persistSession(refreshed);
    return {
      session: publicSession(refreshed),
      events: await eventsForSession(owner.owner_commitment, sessionId, 100),
    };
  }
  const worker = await fetchWorkerAutopilotSession(session.worker_autopilot_session_id, env, fetchImpl);
  if (worker.ok) {
    const merged = await mergeWorkerSession(sessionId, worker.session, now);
    const existingIds = new Set(
      (await eventsForSession(owner.owner_commitment, sessionId, 200)).map((event) => event.event_id),
    );
    for (const event of worker.events) {
      const eventId = stringValue(event.event_id);
      if (eventId && existingIds.has(eventId)) continue;
      await appendEvent(workerEventToLocal(merged, event, now), merged.owner_commitment);
      if (eventId) existingIds.add(eventId);
    }
    return {
      session: publicSession(merged),
      events: await eventsForSession(owner.owner_commitment, sessionId, 100),
    };
  }
  await appendEvent(makeEvent(session, "guardrail", "Worker event sync failed.", {
    error: worker.error,
  }, now), session.owner_commitment);
  const before = `${session.status}:${session.updated_at}`;
  const refreshed = refreshExpiry(session, now);
  if (`${refreshed.status}:${refreshed.updated_at}` !== before) await persistSession(refreshed);
  return {
    session: publicSession(refreshed),
    events: await eventsForSession(owner.owner_commitment, sessionId, 100),
  };
}

async function armWorkerAutopilotSession(input: {
  body: unknown;
  owner: AutopilotOwner;
  session: AutopilotSession;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  runtime?: AutopilotWorkerRuntime;
}): Promise<
  | { ok: true; session: Record<string, unknown>; events: Record<string, unknown>[] }
  | { ok: false; error: string }
> {
  let cfg = workerConfig(input.env);
  let wakeAttempted = false;
  if (phalaAutopilotWakeEnabled(input.env)) {
    const resolved = await wakeAndResolvePhalaWorker({
      cfg,
      env: input.env,
      runtime: input.runtime,
    });
    cfg = resolved.cfg;
    wakeAttempted = resolved.attempted;
  }
  if (!cfg.url) return { ok: false, error: "worker_not_configured" };
  const raw = record(input.body);
  const providedVenueAccess = optionalRecord(raw.venue_access) ?? optionalRecord(raw.venue_vaults);
  const venueAccess = hasRecordEntries(providedVenueAccess)
    ? providedVenueAccess
    : await autopilotVenueAccessForWorker(input.owner, input.session.session_policy);
  const workerPath = "/autopilot/sessions";
  const payload = {
    version: 2,
    owner_commitment: input.owner.owner_commitment,
    local_autopilot_session_id: input.session.autopilot_session_id,
    session_policy: input.session.session_policy,
    venue_access: venueAccess,
  };
  const authorization = workerAuthorizationHeader({
    env: input.env,
    fallbackToken: cfg.token,
    method: "POST",
    path: workerPath,
    scope: "autopilot:control",
    body: payload,
    expected: {
      owner_commitment: input.owner.owner_commitment,
    },
  });
  if (!authorization) return { ok: false, error: "worker_not_configured" };
  let response = await input.fetchImpl(new URL(workerPath, cfg.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response && phalaAutopilotWakeEnabled(input.env) && !wakeAttempted) {
    const resolved = await wakeAndResolvePhalaWorker({
      cfg,
      env: input.env,
      runtime: input.runtime,
    });
    cfg = resolved.cfg;
    wakeAttempted = resolved.attempted;
    if (cfg.url) {
      response = await input.fetchImpl(new URL(workerPath, cfg.url), {
        method: "POST",
        cache: "no-store",
        headers: {
          authorization,
          "content-type": "application/json",
          "x-ghola-sealed-execution-required": "true",
        },
        body: JSON.stringify(payload),
      }).catch(() => null);
    }
  }
  if (!response) return { ok: false, error: "worker_unavailable" };
  const body = record(await response.json().catch(() => null));
  if (!response.ok) return { ok: false, error: stringValue(body.error) ?? `worker_${response.status}` };
  const session = record(body.session);
  if (!session.autopilot_session_id) return { ok: false, error: "worker_session_missing" };
  return {
    ok: true,
    session,
    events: Array.isArray(body.events) ? body.events.map(optionalRecord).filter(Boolean) as Record<string, unknown>[] : [],
  };
}

async function wakeAndResolvePhalaWorker(input: {
  cfg: ReturnType<typeof workerConfig>;
  env: Record<string, string | undefined>;
  runtime?: AutopilotWorkerRuntime;
}): Promise<{ cfg: ReturnType<typeof workerConfig>; attempted: boolean }> {
  const wake = input.runtime?.wakePhalaForUse ?? wakePhalaPrivateAgentForUse;
  const discover = input.runtime?.discoverPhalaExecutionUrl ?? discoverPhalaPrivateAgentExecutionUrl;
  const result = await wake({
    reason: "autopilot_session_create",
    waitForReadyMs: boundedIntEnv(
      input.env,
      "GHOLA_PRIVATE_AGENT_AUTOPILOT_WAKE_WAIT_MS",
      55_000,
      0,
      120_000,
    ),
  });
  const rawUrl = result.execution_url || await discover();
  const url = parseWorkerUrl(rawUrl);
  return {
    attempted: result.attempted,
    cfg: url ? { ...input.cfg, url } : input.cfg,
  };
}

async function autopilotVenueAccessForWorker(
  owner: AutopilotOwner,
  policy: AutopilotSessionPolicy,
): Promise<Record<string, unknown>> {
  if (!isPrivateAccountRequestOwner(owner)) return {};
  const stored = await storedVenueAccessForWorker(owner, policy.venue_allowlist);
  if (policy.strategy_id !== "hedged_spread_arbitrage_v1") return stored;
  return {
    ...stored,
    ...await agentPassportVenueAccessForWorker(owner),
  };
}

function isPrivateAccountRequestOwner(owner: AutopilotOwner): owner is PrivateAccountRequestOwner {
  return Boolean(owner.user);
}

async function fetchWorkerAutopilotSession(
  workerSessionId: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; session: Record<string, unknown>; events: Record<string, unknown>[] }
  | { ok: false; error: string }
> {
  const cfg = workerConfig(env);
  if (!cfg.url) return { ok: false, error: "worker_not_configured" };
  const workerPath = `/autopilot/sessions/${encodeURIComponent(workerSessionId)}`;
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "GET",
    path: workerPath,
    scope: "autopilot:read",
    body: {},
    expected: { autopilot_session_id: workerSessionId },
  });
  if (!authorization) return { ok: false, error: "worker_not_configured" };
  const response = await fetchImpl(new URL(workerPath, cfg.url), {
    method: "GET",
    cache: "no-store",
    headers: {
      authorization,
      "cache-control": "no-cache",
    },
  }).catch(() => null);
  if (!response) return { ok: false, error: "worker_unavailable" };
  const body = record(await response.json().catch(() => null));
  if (!response.ok) return { ok: false, error: stringValue(body.error) ?? `worker_${response.status}` };
  const session = record(body.session);
  if (!session.autopilot_session_id) return { ok: false, error: "worker_session_missing" };
  return {
    ok: true,
    session,
    events: Array.isArray(body.events) ? body.events.map(optionalRecord).filter(Boolean) as Record<string, unknown>[] : [],
  };
}

async function fetchWorkerAutopilotOpportunities(
  workerSessionId: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; session: Record<string, unknown>; opportunities: Record<string, unknown>[] }
  | { ok: false; error: "worker_not_configured" | "worker_unavailable" | string }
> {
  const cfg = workerConfig(env);
  if (!cfg.url) return { ok: false, error: "worker_not_configured" };
  const workerPath = `/autopilot/sessions/${encodeURIComponent(workerSessionId)}/opportunities`;
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "GET",
    path: workerPath,
    scope: "autopilot:read",
    body: {},
    expected: { autopilot_session_id: workerSessionId },
  });
  if (!authorization) return { ok: false, error: "worker_not_configured" };
  const response = await fetchImpl(new URL(workerPath, cfg.url), {
    method: "GET",
    cache: "no-store",
    headers: {
      authorization,
      "cache-control": "no-cache",
    },
  }).catch(() => null);
  if (!response) return { ok: false, error: "worker_unavailable" };
  const body = record(await response.json().catch(() => null));
  if (!response.ok) return { ok: false, error: stringValue(body.error) ?? `worker_${response.status}` };
  const session = record(body.session);
  if (!session.autopilot_session_id) return { ok: false, error: "worker_session_missing" };
  return {
    ok: true,
    session,
    opportunities: Array.isArray(body.opportunities)
      ? body.opportunities.map(optionalRecord).filter(Boolean) as Record<string, unknown>[]
      : [],
  };
}

async function controlWorkerAutopilotSession(
  workerSessionId: string,
  action: "pause" | "resume" | "kill",
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; session: Record<string, unknown>; events: Record<string, unknown>[] }
  | { ok: false; error: string }
> {
  const cfg = workerConfig(env);
  if (!cfg.url) return { ok: false, error: "worker_not_configured" };
  const workerPath = `/autopilot/sessions/${encodeURIComponent(workerSessionId)}/${action}`;
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "POST",
    path: workerPath,
    scope: "autopilot:control",
    body: {},
    expected: {
      autopilot_session_id: workerSessionId,
      action,
    },
  });
  if (!authorization) return { ok: false, error: "worker_not_configured" };
  const response = await fetchImpl(
    new URL(workerPath, cfg.url),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: "{}",
    },
  ).catch(() => null);
  if (!response) return { ok: false, error: "worker_unavailable" };
  const body = record(await response.json().catch(() => null));
  if (!response.ok) return { ok: false, error: stringValue(body.error) ?? `worker_${response.status}` };
  const session = record(body.session);
  if (!session.autopilot_session_id) return { ok: false, error: "worker_session_missing" };
  const event = optionalRecord(body.event);
  return {
    ok: true,
    session,
    events: event ? [event] : [],
  };
}

async function mergeWorkerSession(
  localSessionId: string,
  workerSession: Record<string, unknown>,
  now: Date,
): Promise<AutopilotSession> {
  const local = await loadSession(localSessionId);
  if (!local) throw new Error("local autopilot session not found");
  const workerPolicy = record(workerSession.session_policy);
  const status = statusValue(workerSession.status) ?? local.status;
  const merged: AutopilotSession = {
    ...local,
    worker_autopilot_session_id: stringValue(workerSession.autopilot_session_id) ?? local.worker_autopilot_session_id,
    worker_session_commitment: stringValue(workerSession.worker_session_commitment) ?? local.worker_session_commitment,
    status,
    strategy: strategyValue(workerSession.strategy) ?? local.strategy,
    session_policy: {
      ...local.session_policy,
      ...publicPolicyPatch(workerPolicy),
    },
    venue_access: venueAccessValue(workerSession.venue_access) ?? local.venue_access,
    order_count: numberValue(workerSession.order_count) ?? local.order_count,
    daily_notional_used_bucket: stringValue(workerSession.daily_notional_used_bucket) ?? local.daily_notional_used_bucket,
    updated_at: stringValue(workerSession.updated_at) ?? now.toISOString(),
    expires_at: stringValue(workerSession.expires_at) ?? local.expires_at,
    next_step: stringValue(workerSession.next_step) ?? local.next_step,
    execution_enabled: workerSession.execution_enabled === true,
    control_plane: "worker",
  };
  await persistSession(merged);
  return merged;
}

function workerEventToLocal(session: AutopilotSession, value: Record<string, unknown>, now: Date): AutopilotEvent {
  return {
    version: 1,
    autopilot_session_id: session.autopilot_session_id,
    event_id: stringValue(value.event_id) ?? `autoevt_${digest({ session: session.autopilot_session_id, now: now.toISOString(), value }).slice(0, 24)}`,
    type: eventTypeValue(value.type) ?? "guardrail",
    status: statusValue(value.status) ?? session.status,
    message: stringValue(value.message) ?? "Worker event.",
    data: record(value.data),
    created_at: stringValue(value.created_at) ?? now.toISOString(),
  };
}

function statusValue(value: unknown): AutopilotStatus | null {
  const raw = stringValue(value);
  return raw && AUTOPILOT_STATUSES.has(raw as AutopilotStatus) ? raw as AutopilotStatus : null;
}

function eventTypeValue(value: unknown): AutopilotEventType | null {
  const raw = stringValue(value);
  return raw && AUTOPILOT_EVENT_TYPES.has(raw as AutopilotEventType) ? raw as AutopilotEventType : null;
}

function strategyValue(value: unknown): AutopilotSession["strategy"] | null {
  const raw = optionalRecord(value);
  if (!raw) return null;
  const strategyId = stringValue(raw.strategy_id);
  if (
    strategyId &&
    strategyId !== "momentum_micro_trader" &&
    strategyId !== "hedged_spread_arbitrage_v1" &&
    strategyId !== "tri_venue_market_maker_v1" &&
    strategyId !== "level_trigger_v1"
  ) return null;
  if (strategyId === "level_trigger_v1") {
    return {
      version: 1,
      strategy_id: "level_trigger_v1",
      decision_model: "deterministic_level_trigger",
      executable_order_source: "deterministic_level_trigger",
      ai_can_execute_directly: false,
    };
  }
  if (strategyId === "hedged_spread_arbitrage_v1") {
    return {
      version: 1,
      strategy_id: "hedged_spread_arbitrage_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_arb_planner",
      ai_can_execute_directly: true,
    };
  }
  if (strategyId === "tri_venue_market_maker_v1") {
    return {
      version: 1,
      strategy_id: "tri_venue_market_maker_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_market_maker",
      ai_can_execute_directly: false,
    };
  }
  const decisionModel = stringValue(raw.decision_model) === "ai_direct_order_v1"
    ? "ai_direct_order_v1"
    : "rules_plus_ai_score";
  const aiCanExecuteDirectly = raw.ai_can_execute_directly === true || decisionModel === "ai_direct_order_v1";
  return {
    version: 1,
    strategy_id: "momentum_micro_trader",
    decision_model: decisionModel,
    executable_order_source: aiCanExecuteDirectly
      ? "ai_structured_decision_validated_by_policy"
      : "deterministic_guarded_strategy",
    ai_can_execute_directly: aiCanExecuteDirectly,
  };
}

function strategyForPolicy(policy: AutopilotSessionPolicy): AutopilotSession["strategy"] {
  if (policy.strategy_id === "level_trigger_v1") {
    return {
      version: 1,
      strategy_id: "level_trigger_v1",
      decision_model: "deterministic_level_trigger",
      executable_order_source: "deterministic_level_trigger",
      ai_can_execute_directly: false,
    };
  }
  if (policy.strategy_id === "hedged_spread_arbitrage_v1") {
    return {
      version: 1,
      strategy_id: "hedged_spread_arbitrage_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_arb_planner",
      ai_can_execute_directly: true,
    };
  }
  if (policy.strategy_id === "tri_venue_market_maker_v1") {
    return {
      version: 1,
      strategy_id: "tri_venue_market_maker_v1",
      decision_model: "rules_plus_ai_score",
      executable_order_source: "deterministic_guarded_market_maker",
      ai_can_execute_directly: false,
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

function publicPolicyPatch(raw: Record<string, unknown>): Partial<AutopilotSessionPolicy> {
  const patch: Partial<AutopilotSessionPolicy> = {};
  const strategyId = stringValue(raw.strategy_id);
  if (strategyId === "hedged_spread_arbitrage_v1" || strategyId === "tri_venue_market_maker_v1") {
    patch.strategy_id = strategyId;
    patch.decision_model = "rules_plus_ai_score";
    patch.ai_direct_enabled = false;
  }
  const decisionModel = stringValue(raw.decision_model);
  if (
    patch.strategy_id !== "hedged_spread_arbitrage_v1" &&
    patch.strategy_id !== "tri_venue_market_maker_v1" &&
    (decisionModel === "ai_direct_order_v1" || raw.ai_direct_enabled === true)
  ) {
    patch.decision_model = "ai_direct_order_v1";
    patch.ai_direct_enabled = true;
  } else if (decisionModel === "rules_plus_ai_score" || raw.ai_direct_enabled === false) {
    patch.decision_model = "rules_plus_ai_score";
    patch.ai_direct_enabled = false;
  }
  const venues = stringArray(raw.venue_allowlist)
    .map((venue) => venue.toLowerCase())
    .filter((venue): venue is AutopilotVenueId => SUPPORTED_VENUES.has(venue as AutopilotVenueId));
  if (venues.length) patch.venue_allowlist = unique(venues);
  const markets = stringArray(raw.market_allowlist)
    .map(normalizeMarket)
    .filter((market) => SUPPORTED_MARKETS.has(market));
  if (markets.length) patch.market_allowlist = unique(markets);
  const maxNotional = optionalBucket<AutopilotSessionPolicy["max_notional_bucket"]>(
    raw.max_notional_bucket,
    ["5", "10", "25", "50", "100"],
  );
  if (maxNotional) patch.max_notional_bucket = maxNotional;
  const maxPositionNotional = optionalBucket<AutopilotSessionPolicy["max_position_notional_bucket"]>(
    raw.max_position_notional_bucket,
    ["50", "100", "250", "500"],
  );
  if (maxPositionNotional) patch.max_position_notional_bucket = maxPositionNotional;
  const dailyNotional = optionalBucket<AutopilotSessionPolicy["max_daily_notional_bucket"]>(
    raw.max_daily_notional_bucket,
    ["25", "50", "100", "250"],
  );
  if (dailyNotional) patch.max_daily_notional_bucket = dailyNotional;
  const maxOrderCount = optionalInteger(raw.max_order_count, 1, 25);
  if (maxOrderCount !== null) patch.max_order_count = maxOrderCount;
  const ttlMs = optionalInteger(raw.ttl_ms, 5 * 60_000, 4 * 60 * 60_000);
  if (ttlMs !== null) patch.ttl_ms = ttlMs;
  const slippage = optionalInteger(raw.max_slippage_bps, 1, 100);
  if (slippage !== null) patch.max_slippage_bps = slippage;
  const cooldown = optionalInteger(raw.cooldown_ms, 60_000, 30 * 60_000);
  if (cooldown !== null) patch.cooldown_ms = cooldown;
  const dataMaxAge = optionalInteger(raw.data_max_age_ms, 5_000, 5 * 60_000);
  if (dataMaxAge !== null) patch.data_max_age_ms = dataMaxAge;
  const minAiScore = optionalInteger(raw.min_ai_score_bps, 5_000, 9_900);
  if (minAiScore !== null) patch.min_ai_score_bps = minAiScore;
  const minAiConfidence = optionalInteger(raw.ai_min_confidence_bps, 5_000, 9_900);
  if (minAiConfidence !== null) patch.ai_min_confidence_bps = minAiConfidence;
  const minSignal = optionalInteger(raw.min_signal_bps, 5, 2_000);
  if (minSignal !== null) patch.min_signal_bps = minSignal;
  const maxSpread = optionalInteger(raw.max_spread_bps, 1, 1_000);
  if (maxSpread !== null) patch.max_spread_bps = maxSpread;
  if (typeof raw.kill_switch === "boolean") patch.kill_switch = raw.kill_switch;
  if (typeof raw.reduce_only_on_reconcile_failure === "boolean") {
    patch.reduce_only_on_reconcile_failure = raw.reduce_only_on_reconcile_failure;
  }
  const locale = stringValue(raw.locale_hint);
  if (locale) patch.locale_hint = localeHint(locale);
  if ("timezone" in raw) patch.timezone = stringValue(raw.timezone)?.slice(0, 64) ?? null;
  const commitment = stringValue(raw.policy_commitment);
  if (commitment) patch.policy_commitment = commitment;
  return patch;
}

function venueAccessValue(value: unknown): AutopilotSession["venue_access"] | null {
  const raw = optionalRecord(value);
  if (!raw) return null;
  const entries: Array<[AutopilotVenueId, AutopilotSession["venue_access"][AutopilotVenueId]]> = [];
  for (const venue of SUPPORTED_VENUE_LIST) {
    const item = optionalRecord(raw[venue]);
    if (!item) continue;
    const status = venueAccessStatusValue(item.status) ??
      (item.encrypted_execution_vault ? "ready" : "needs_funds");
    entries.push([venue, {
      status,
      execution_mode: stringValue(item.execution_mode),
      reason: stringValue(item.reason),
    }]);
  }
  return entries.length ? Object.fromEntries(entries) as AutopilotSession["venue_access"] : null;
}

function venueAccessStatusValue(value: unknown): AutopilotSession["venue_access"][AutopilotVenueId]["status"] | null {
  const raw = stringValue(value);
  if (
    raw === "ready" ||
    raw === "needs_funds" ||
    raw === "venue_access_required" ||
    raw === "blocked"
  ) {
    return raw;
  }
  return null;
}

function defaultVenueAccess(policy: AutopilotSessionPolicy): AutopilotSession["venue_access"] {
  return Object.fromEntries(policy.venue_allowlist.map((venue) => [
    venue,
    {
      status: "needs_funds",
      execution_mode: null,
      reason: "isolated_vault_required",
    },
  ])) as AutopilotSession["venue_access"];
}

function workerConfig(env: Record<string, string | undefined>) {
  const url = env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.PHALA_AGENT_ENDPOINT?.trim() ||
    "";
  const token = env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PHALA_CLOUD_API_KEY?.trim() ||
    "";
  let parsedUrl: URL | null = null;
  if (url) {
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = null;
    }
  }
  return {
    url: parsedUrl,
    token,
  };
}

function parseWorkerUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function phalaAutopilotWakeEnabled(env: Record<string, string | undefined>): boolean {
  return env.GHOLA_PRIVATE_AGENT_JIT_PROVISIONING?.trim().toLowerCase() === "true";
}

function boundedIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(env[key]?.trim() ?? "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function workerAuthConfigured(env: Record<string, string | undefined>, fallbackToken: string): boolean {
  return Boolean(
    fallbackToken ||
    env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET?.trim() ||
    env.GHOLA_WORKER_CAPABILITY_SECRET?.trim(),
  );
}

function hyperliquidAutopilotReadiness(
  env: Record<string, string | undefined>,
  workerConfigured: boolean,
): AutopilotVenueReadiness {
  const reasonCodes = [
    ...(workerConfigured ? [] : ["private_worker_not_configured"]),
    ...(env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true" ? [] : ["hyperliquid_pilot_disabled"]),
    ...(env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill" ? [] : ["hyperliquid_tiny_fill_disabled"]),
    ...(env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS === "ready" ||
      env.GHOLA_PRIVATE_AGENT_EXECUTION_URL ||
      env.GHOLA_PRIVATE_AGENT_WORKER_URL ||
      env.PHALA_AGENT_ENDPOINT
      ? []
      : ["hyperliquid_connector_unavailable"]),
    ...(env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY === "true" ||
      env.GHOLA_HYPERLIQUID_SHIELDED_FUNDING_READY === "true"
      ? []
      : ["venue_access_or_funding_required"]),
  ];
  return {
    venue_id: "hyperliquid",
    status: reasonCodes.length ? "blocked" : "ready",
    live_mode: env.GHOLA_HYPERLIQUID_LIVE_MODE || null,
    reason_codes: reasonCodes,
  };
}

function phoenixAutopilotReadiness(
  env: Record<string, string | undefined>,
  workerConfigured: boolean,
): AutopilotVenueReadiness {
  const liveMode = env.GHOLA_SOLANA_PERPS_LIVE_MODE || env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE || null;
  const reasonCodes = [
    ...(workerConfigured ? [] : ["private_worker_not_configured"]),
    ...(env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" ? [] : ["phoenix_pilot_disabled"]),
    ...(liveMode === "sdk_runner" || liveMode === "full_ticket" ? [] : ["phoenix_live_mode_disabled"]),
    ...(env.GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_READINESS === "ready" ? [] : ["phoenix_connector_unavailable"]),
    ...(env.GHOLA_SOLANA_PERPS_SHIELDED_FUNDING_READY === "true" ? [] : ["venue_access_or_funding_required"]),
  ];
  return {
    venue_id: "phoenix",
    status: reasonCodes.length ? "blocked" : "ready",
    live_mode: liveMode,
    reason_codes: reasonCodes,
  };
}

function jupiterAutopilotReadiness(
  env: Record<string, string | undefined>,
  workerConfigured: boolean,
): AutopilotVenueReadiness {
  const liveMode = env.GHOLA_JUPITER_LIVE_MODE || env.PRIVATE_AGENT_JUPITER_LIVE_MODE || null;
  const reasonCodes = [
    ...(workerConfigured ? [] : ["private_worker_not_configured"]),
    ...(env.GHOLA_VENUE_JUPITER_PILOT_ENABLED === "true" ? [] : ["jupiter_pilot_disabled"]),
    ...(liveMode === "full" ? [] : ["jupiter_live_mode_disabled"]),
    ...(env.GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_READINESS === "ready" ? [] : ["jupiter_connector_unavailable"]),
    ...(env.GHOLA_JUPITER_SHIELDED_FUNDING_READY === "true" ? [] : ["venue_access_or_funding_required"]),
  ];
  return {
    venue_id: "jupiter",
    status: reasonCodes.length ? "blocked" : "ready",
    live_mode: liveMode,
    reason_codes: reasonCodes,
  };
}

function coinbaseAutopilotReadiness(
  env: Record<string, string | undefined>,
  workerConfigured: boolean,
): AutopilotVenueReadiness {
  const reasonCodes = [
    ...(workerConfigured ? [] : ["private_worker_not_configured"]),
    ...(env.GHOLA_V6_COINBASE_PILOT_ENABLED === "true" ? [] : ["coinbase_pilot_disabled"]),
    ...(env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED === "true" ? [] : ["coinbase_omnibus_disabled"]),
    ...(env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY === "true" ? [] : ["coinbase_pool_not_ready"]),
    ...(env.GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_READINESS === "ready" ? [] : ["coinbase_connector_unavailable"]),
  ];
  return {
    venue_id: "coinbase_advanced",
    status: reasonCodes.length ? "blocked" : "ready",
    live_mode: env.GHOLA_COINBASE_LIVE_MODE || "partner_omnibus",
    reason_codes: reasonCodes,
  };
}

function normalizePolicy(value: Record<string, unknown>): AutopilotSessionPolicy {
  const rawPolicy = optionalRecord(value.session_policy) ?? value;
  const rawStrategyId = stringValue(rawPolicy.strategy_id);
  const strategyId: AutopilotStrategyId = rawStrategyId === "hedged_spread_arbitrage_v1" ||
    rawStrategyId === "tri_venue_market_maker_v1" ||
    rawStrategyId === "level_trigger_v1"
    ? rawStrategyId
    : "momentum_micro_trader";
  const aiDirectEnabled = rawPolicy.ai_direct_enabled !== false &&
    strategyId === "momentum_micro_trader" &&
    stringValue(rawPolicy.decision_model) !== "rules_plus_ai_score";
  const agentMandate = strategyId === "level_trigger_v1"
    ? sanitizeAgentMandate(rawPolicy.agent_mandate)
    : null;
  const agentSide: "buy" | "sell" = stringValue(rawPolicy.agent_side) === "sell" ? "sell" : "buy";
  const venues = stringArray(rawPolicy.venue_allowlist)
    .map((venue) => venue.toLowerCase())
    .filter((venue): venue is AutopilotVenueId => SUPPORTED_VENUES.has(venue as AutopilotVenueId));
  const markets = stringArray(rawPolicy.market_allowlist)
    .map(normalizeMarket)
    .filter((market) => SUPPORTED_MARKETS.has(market));
  const policy: Omit<AutopilotSessionPolicy, "policy_commitment"> = {
    strategy_id: strategyId,
    decision_model: aiDirectEnabled ? "ai_direct_order_v1" : "rules_plus_ai_score",
    ai_direct_enabled: aiDirectEnabled,
    venue_allowlist: unique(venues.length ? venues : DEFAULT_VENUES),
    market_allowlist: unique(markets.length ? markets : DEFAULT_MARKETS),
    max_notional_bucket: notionalBucket(rawPolicy.max_notional_bucket, ["5", "10", "25", "50", "100"], "50"),
    max_position_notional_bucket: notionalBucket(rawPolicy.max_position_notional_bucket, ["50", "100", "250", "500"], "100"),
    max_daily_notional_bucket: notionalBucket(rawPolicy.max_daily_notional_bucket, ["25", "50", "100", "250"], "250"),
    max_order_count: clampInteger(rawPolicy.max_order_count, 1, 25, 10),
    ttl_ms: clampInteger(rawPolicy.ttl_ms, 5 * 60_000, 4 * 60 * 60_000, 2 * 60 * 60_000),
    max_slippage_bps: clampInteger(rawPolicy.max_slippage_bps, 1, 100, 50),
    cooldown_ms: clampInteger(rawPolicy.cooldown_ms, 60_000, 30 * 60_000, 5 * 60_000),
    data_max_age_ms: clampInteger(rawPolicy.data_max_age_ms, 5_000, 5 * 60_000, 30_000),
    min_net_edge_bps: clampInteger(rawPolicy.min_net_edge_bps, 1, 5_000, 25),
    max_execution_skew_ms: clampInteger(rawPolicy.max_execution_skew_ms, 50, 60_000, 2_000),
    min_ai_score_bps: clampInteger(rawPolicy.min_ai_score_bps, 5_000, 9_900, 6_500),
    ai_min_confidence_bps: clampInteger(rawPolicy.ai_min_confidence_bps ?? rawPolicy.min_ai_score_bps, 5_000, 9_900, 6_500),
    min_signal_bps: clampInteger(rawPolicy.min_signal_bps, 5, 2_000, 25),
    max_spread_bps: clampInteger(rawPolicy.max_spread_bps, 1, 1_000, 150),
    allowed_order_types: [
      "swap",
      "spot_limit_order",
      "spot_market_order",
      "perp_limit_order",
      "limit_order",
      "cancel",
    ] as AutopilotSessionPolicy["allowed_order_types"],
    kill_switch: rawPolicy.kill_switch === true,
    reduce_only_on_reconcile_failure: rawPolicy.reduce_only_on_reconcile_failure !== false,
    locale_hint: localeHint(rawPolicy.locale_hint),
    timezone: stringValue(rawPolicy.timezone)?.slice(0, 64) ?? null,
    ...(strategyId === "level_trigger_v1"
      ? { agent_mandate: agentMandate, agent_side: agentSide }
      : {}),
  };
  return {
    ...policy,
    policy_commitment: `autopilot_policy_${digest(policy)}`,
  };
}

// Structural pass-through of a drawn directional mandate. The worker
// (normalizeAgentMandate in policy.js) is the authoritative validator and will
// reject anything that violates the mandate vocabulary, so this only trims
// known string fields and drops empties.
function sanitizeAgentMandate(value: unknown): AutopilotAgentMandate | null {
  const raw = optionalRecord(value);
  if (!raw) return null;
  const profile = stringValue(raw.strategy_profile);
  const entry = stringValue(raw.entry_trigger);
  if (!profile || !entry) return null;
  const optional = (key: keyof AutopilotAgentMandate): string | undefined => {
    const text = stringValue(raw[key]);
    return text ? text : undefined;
  };
  return {
    strategy_profile: profile,
    entry_trigger: entry,
    exit_rule: stringValue(raw.exit_rule) || "manual_approval",
    time_horizon: stringValue(raw.time_horizon) || "scalp",
    trigger_level: optional("trigger_level"),
    invalidation_level: optional("invalidation_level"),
    edge_threshold_bps: optional("edge_threshold_bps"),
    time_window: optional("time_window"),
    strategy_note: optional("strategy_note"),
  };
}

function refreshExpiry(session: AutopilotSession, now: Date): AutopilotSession {
  if (
    session.status !== "killed" &&
    session.status !== "blocked" &&
    new Date(session.expires_at).getTime() <= now.getTime()
  ) {
    session.status = "expired";
    session.execution_enabled = false;
    session.next_step = "Session expired. Create a new autopilot session.";
    session.updated_at = now.toISOString();
  }
  return session;
}

function publicSession(session: AutopilotSession): AutopilotSession {
  return JSON.parse(JSON.stringify(session)) as AutopilotSession;
}

function makeEvent(
  session: AutopilotSession,
  type: AutopilotEventType,
  message: string,
  data: Record<string, unknown>,
  now: Date,
): AutopilotEvent {
  return {
    version: 1,
    autopilot_session_id: session.autopilot_session_id,
    event_id: `autoevt_${digest({
      session: session.autopilot_session_id,
      type,
      message,
      now: now.toISOString(),
      nonce: randomUUID(),
    }).slice(0, 24)}`,
    type,
    status: session.status,
    message,
    data,
    created_at: now.toISOString(),
  };
}

async function persistSession(session: AutopilotSession): Promise<AutopilotSession> {
  await putPrivateAutopilotSession(sessionToRecord(session));
  return session;
}

async function loadSession(sessionId: string): Promise<AutopilotSession | null> {
  const stored = await getPrivateAutopilotSession(sessionId);
  return stored ? sessionFromRecord(stored) : null;
}

async function eventsForSession(
  ownerCommitment: string,
  sessionId: string,
  limit = 100,
): Promise<AutopilotEvent[]> {
  const stored = await listPrivateAutopilotEvents({
    owner_commitment: ownerCommitment,
    autopilot_session_id: sessionId,
    limit,
  });
  return stored.map(eventFromRecord);
}

async function appendEvent(event: AutopilotEvent, ownerCommitment: string) {
  await putPrivateAutopilotEvent(eventToRecord(event, ownerCommitment));
}

function sessionToRecord(session: AutopilotSession): PrivateAutopilotSessionRecordV1 {
  return {
    version: 1,
    owner_commitment: session.owner_commitment,
    autopilot_session_id: session.autopilot_session_id,
    status: session.status,
    session: publicSession(session) as unknown as Record<string, unknown>,
    created_at: session.created_at,
    updated_at: session.updated_at,
    expires_at: session.expires_at,
  };
}

function sessionFromRecord(stored: PrivateAutopilotSessionRecordV1): AutopilotSession | null {
  const raw = record(stored.session);
  const policyRaw = record(raw.session_policy);
  const normalizedPolicy = normalizePolicy({ session_policy: policyRaw });
  const policy = {
    ...normalizedPolicy,
    policy_commitment: stringValue(policyRaw.policy_commitment) ?? normalizedPolicy.policy_commitment,
  };
  const id = stringValue(raw.autopilot_session_id) ?? stored.autopilot_session_id;
  const owner = stringValue(raw.owner_commitment) ?? stored.owner_commitment;
  if (!id || !owner) return null;
  return {
    version: 2,
    autopilot_session_id: id,
    worker_autopilot_session_id: stringValue(raw.worker_autopilot_session_id),
    worker_session_commitment: stringValue(raw.worker_session_commitment),
    owner_commitment: owner,
    status: statusValue(raw.status) ?? statusValue(stored.status) ?? "blocked",
    strategy: strategyValue(raw.strategy) ?? strategyForPolicy(policy),
    session_policy: policy,
    venue_access: venueAccessValue(raw.venue_access) ?? defaultVenueAccess(policy),
    order_count: numberValue(raw.order_count) ?? 0,
    daily_notional_used_bucket: stringValue(raw.daily_notional_used_bucket) ?? "0",
    created_at: stringValue(raw.created_at) ?? stored.created_at,
    updated_at: stringValue(raw.updated_at) ?? stored.updated_at,
    expires_at: stringValue(raw.expires_at) ?? stored.expires_at,
    next_step: stringValue(raw.next_step) ?? "Autopilot session is awaiting review.",
    execution_enabled: raw.execution_enabled === true,
    control_plane: stringValue(raw.control_plane) === "worker" ? "worker" : "android",
    visibility_summary: {
      main_wallet_prompts_per_trade: false,
      execution_boundary: "bounded_delegated_worker_policy",
      user_can_kill_anytime: true,
    },
  };
}

function eventToRecord(
  event: AutopilotEvent,
  ownerCommitment: string,
): PrivateAutopilotEventRecordV1 {
  return {
    version: 1,
    owner_commitment: ownerCommitment,
    autopilot_session_id: event.autopilot_session_id,
    event_id: event.event_id,
    type: event.type,
    status: event.status,
    message: event.message,
    data: record(event.data),
    created_at: event.created_at,
  };
}

function eventFromRecord(stored: PrivateAutopilotEventRecordV1): AutopilotEvent {
  return {
    version: 1,
    autopilot_session_id: stored.autopilot_session_id,
    event_id: stored.event_id,
    type: eventTypeValue(stored.type) ?? "guardrail",
    status: statusValue(stored.status) ?? "blocked",
    message: stored.message,
    data: record(stored.data),
    created_at: stored.created_at,
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 48);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasRecordEntries(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return Boolean(value && Object.keys(value).length > 0);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMarket(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  if (upper === "SOL/USDC" || upper === "SOL-USDC") return "SOL/USDC";
  return upper;
}

function notionalBucket<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  const raw = stringValue(value)?.replace(/[^0-9.]/g, "") ?? "";
  return allowed.includes(raw as T) ? raw as T : fallback;
}

function optionalBucket<T extends string>(value: unknown, allowed: T[]): T | null {
  const raw = stringValue(value)?.replace(/[^0-9.]/g, "") ?? "";
  return allowed.includes(raw as T) ? raw as T : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function localeHint(value: unknown): AutopilotSessionPolicy["locale_hint"] {
  const raw = stringValue(value)?.toLowerCase();
  if (raw === "zh" || raw === "zh-cn" || raw === "zh_hans") return "zh-CN";
  if (raw === "id" || raw === "in" || raw === "id-id") return "id";
  return "en";
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
