import type { CrossVenueExecutionPlan } from "./cross-venue-execution";
import { workerAuthorizationHeader, workerCapabilityExpectedFromBody } from "./private-agent-capability";

export function crossVenueExecutionReadiness(env: Record<string, string | undefined> = process.env) {
  const config = workerConfig(env);
  const enabled = env.GHOLA_CROSS_VENUE_BYO_ENABLED === "true";
  const reasons = [
    ...(enabled ? [] : ["cross_venue_byo_flag_disabled"]),
    ...(config.url ? [] : ["execution_worker_url_missing"]),
    ...(config.token ? [] : ["execution_worker_auth_missing"]),
  ];
  return {
    version: 1 as const,
    enabled,
    ready: reasons.length === 0,
    execution_mode: "coordinated_byo" as const,
    atomic: false as const,
    max_legs: 2 as const,
    order_type: "ioc_limit" as const,
    reason_codes: reasons,
  };
}

export async function probeCrossVenueExecutionReadiness(input: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}) {
  const env = input.env ?? process.env;
  const base = crossVenueExecutionReadiness(env);
  if (!base.ready) return base;
  const config = workerConfig(env);
  const path = "/execution/cross-venue/ready";
  const body = { version: 1, operation_class: "cross_venue_byo_readiness" };
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: config.token,
    method: "POST",
    path,
    scope: "credential:verify",
    body,
    expected: { operation_class: "cross_venue_byo_readiness" },
  });
  const target = safeWorkerUrl(config.url, path);
  if (!authorization || !target) return { ...base, ready: false, reason_codes: ["execution_worker_probe_configuration_invalid"] };
  const response = await (input.fetchImpl ?? fetch)(target, {
    method: "POST",
    cache: "no-store",
    headers: { authorization, "content-type": "application/json", "x-ghola-sealed-execution-required": "true" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  const result = response ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
  if (!response?.ok || result?.ready !== true) {
    const reasons = Array.isArray(result?.reason_codes) ? result.reason_codes.map(String).filter(Boolean) : ["execution_worker_probe_failed"];
    return { ...base, ready: false, reason_codes: reasons.length ? reasons : ["execution_worker_probe_failed"] };
  }
  return { ...base, ready: true, reason_codes: [] };
}

export async function submitCrossVenueExecution(input: {
  plan: CrossVenueExecutionPlan;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; status: number; worker_receipt: unknown }
  | { ok: false; status: number; error: string }
> {
  return workerCommand("submit", input);
}

export async function cancelCrossVenueExecution(input: {
  plan: CrossVenueExecutionPlan;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; status: number; worker_receipt: unknown }
  | { ok: false; status: number; error: string }
> {
  return workerCommand("cancel", input);
}

async function workerCommand(
  action: "submit" | "cancel",
  input: {
    plan: CrossVenueExecutionPlan;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  },
) {
  const env = input.env ?? process.env;
  const config = workerConfig(env);
  const readiness = crossVenueExecutionReadiness(env);
  const commandReady = action === "cancel" ? Boolean(config.url && config.token) : readiness.ready;
  if (!commandReady) return { ok: false as const, status: 503, error: readiness.reason_codes[0] || "cross_venue_not_ready" };
  const path = `/execution/cross-venue/${action}`;
  const payload = {
    version: 1,
    execution_id: input.plan.execution_id,
    owner_commitment: input.plan.owner_commitment,
    opportunity_commitment: input.plan.opportunity_commitment,
    market: input.plan.market,
    matched_notional_micro_usdc: input.plan.matched_notional_micro_usdc,
    risk_budget: input.plan.risk_budget,
    hedge_deadline_at: input.plan.hedge_deadline_at,
    legs: input.plan.legs.map((leg) => ({
      leg_id: leg.leg_id,
      venue_id: leg.venue_id,
      side: leg.side,
      symbol: leg.symbol,
      limit_price: leg.limit_price,
      target_notional_micro_usdc: leg.target_notional_micro_usdc,
      order_type: leg.order_type,
    })),
  };
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: config.token,
    method: "POST",
    path,
    scope: action === "submit" ? "order:submit" : "autopilot:control",
    body: payload,
    expected: workerCapabilityExpectedFromBody(payload, {
      operation_class: "cross_venue_byo",
      owner_commitment: input.plan.owner_commitment,
    }),
  });
  if (!authorization) return { ok: false as const, status: 503, error: "execution_worker_auth_missing" };
  const target = safeWorkerUrl(config.url, path);
  if (!target) return { ok: false as const, status: 503, error: "execution_worker_url_invalid" };
  const response = await (input.fetchImpl ?? fetch)(target, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "idempotency-key": input.plan.execution_id,
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!response) return { ok: false as const, status: 503, error: "execution_worker_unavailable" };
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false as const, status: response.status, error: workerError(body, response.status) };
  return { ok: true as const, status: response.status, worker_receipt: body };
}

function workerConfig(env: Record<string, string | undefined>) {
  return {
    url: env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() || env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() || env.PHALA_AGENT_ENDPOINT?.trim() || "",
    token: env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() || env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() || env.PHALA_CLOUD_API_KEY?.trim() || "",
  };
}

function safeWorkerUrl(base: string, path: string) {
  try {
    const url = new URL(path, base);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    return url;
  } catch {
    return null;
  }
}

function workerError(value: unknown, status: number) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === "string" && /^[a-z0-9_:-]{1,120}$/i.test(error)) return error;
  }
  return `execution_worker_${status}`;
}
