import {
  containsForbiddenPublicPrivateAccountField,
  type GholaVenueId,
} from "./private-account";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "./private-agent-capability";
import { discoverPhalaPrivateAgentExecutionUrl } from "./private-agent-phala";

const POOLED_VENUES = ["hyperliquid", "phoenix", "backpack", "jupiter", "coinbase"] as const;

type PooledWorkerVenueId = (typeof POOLED_VENUES)[number];

export type PooledWorkerVenueReadiness = {
  venue_id: PooledWorkerVenueId;
  status: "ready" | "blocked" | "unavailable";
  ready: boolean;
  reason_codes: string[];
};

export type PooledWorkerReadiness = {
  status: "ready" | "blocked" | "unavailable";
  ready: boolean;
  endpoint_configured: boolean;
  reason_codes: string[];
  venues: Record<PooledWorkerVenueId, PooledWorkerVenueReadiness>;
  checked_at: string;
};

export async function getPooledWorkerReadiness(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PooledWorkerReadiness> {
  const cfg = await pooledWorkerConfig(env);
  if (!cfg.url) return unavailableReadiness(["pooled_worker_endpoint_missing"], false);

  return pooledWorkerReadinessProbe(env, fetchImpl, cfg, [...POOLED_VENUES]);
}

async function pooledWorkerReadinessProbe(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  cfg: Awaited<ReturnType<typeof pooledWorkerConfig>>,
  venues: PooledWorkerVenueId[],
  unsupportedVenues: PooledWorkerVenueId[] = [],
): Promise<PooledWorkerReadiness> {
  const workerPath = "/venues/pools/readiness";
  const payload = {
    version: 1,
    operation_class: "pooled_readiness",
    venues,
  };
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "POST",
    path: workerPath,
    scope: "credential:verify",
    body: payload,
    expected: workerCapabilityExpectedFromBody(payload, {
      operation_class: "pooled_readiness",
    }),
  });
  if (!authorization) return unavailableReadiness(["pooled_worker_auth_missing"], true);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), pooledWorkerTimeoutMs(env));
  try {
    const res = await fetchImpl(new URL(workerPath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        authorization,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body !== "object" || Array.isArray(body)) {
      const nextUnsupportedVenues = unsupportedVenueIds(body);
      const retryVenues = venues.filter((venue) => !nextUnsupportedVenues.includes(venue));
      if (retryVenues.length > 0 && retryVenues.length < venues.length) {
        return pooledWorkerReadinessProbe(
          env,
          fetchImpl,
          cfg,
          retryVenues,
          uniqueVenueIds(unsupportedVenues.concat(nextUnsupportedVenues)),
        );
      }
      return unavailableReadiness(["pooled_worker_probe_failed"], true);
    }
    if (containsForbiddenPublicPrivateAccountField(body)) {
      return unavailableReadiness(["pooled_worker_forbidden_public_field"], true);
    }
    return withUnsupportedVenues(
      normalizePooledWorkerReadiness(body as Record<string, unknown>),
      unsupportedVenues,
    );
  } catch {
    return unavailableReadiness(["pooled_worker_probe_failed"], true);
  } finally {
    clearTimeout(timeout);
  }
}

export function pooledWorkerVenueId(venueId: GholaVenueId | "coinbase"): PooledWorkerVenueId | null {
  if (venueId === "coinbase_advanced") return "coinbase";
  return POOLED_VENUES.includes(venueId as PooledWorkerVenueId)
    ? venueId as PooledWorkerVenueId
    : null;
}

export function pooledWorkerVenueGateFromReadiness(
  venueId: GholaVenueId | "coinbase",
  readiness: PooledWorkerReadiness,
):
  | { ok: true; reason_codes: string[] }
  | {
      ok: false;
      error: "pooled_mode_not_supported" | "pooled_worker_not_ready";
      reason_codes: string[];
    } {
  const workerVenueId = pooledWorkerVenueId(venueId);
  if (!workerVenueId) {
    return {
      ok: false,
      error: "pooled_mode_not_supported",
      reason_codes: ["pooled_mode_not_supported"],
    };
  }
  const venue = readiness.venues[workerVenueId];
  const reasonCodes = [...new Set(readiness.reason_codes.concat(venue?.reason_codes ?? []))];
  if (readiness.status === "unavailable" || reasonCodes.length > 0 || !venue?.ready) {
    return {
      ok: false,
      error: "pooled_worker_not_ready",
      reason_codes: reasonCodes,
    };
  }
  return { ok: true, reason_codes: [] };
}

async function pooledWorkerConfig(env: Record<string, string | undefined>) {
  const discoveredUrl = await discoverCurrentPhalaWorkerUrl(env);
  const url = discoveredUrl || firstEnv(env, [
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_WORKER_URL",
    "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
    "GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_URL",
    "GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_URL",
    "GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_URL",
  ]);
  const token = firstEnv(env, [
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "PRIVATE_AGENT_EXECUTION_TOKEN",
    "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN",
    "GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_TOKEN",
    "GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_TOKEN",
    "GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_TOKEN",
  ]);
  return { url, token };
}

async function discoverCurrentPhalaWorkerUrl(env: Record<string, string | undefined>) {
  if (env.NODE_ENV === "test") return "";
  const provider = env.GHOLA_PRIVATE_AGENT_PROVIDER?.trim();
  const phalaConfigured = Boolean(
    firstEnv(env, ["PHALA_CLOUD_API_KEY", "PHALA_API_KEY"]),
  );
  if (provider !== "phala" && !phalaConfigured) return "";
  return (await discoverPhalaPrivateAgentExecutionUrl().catch(() => null)) ?? "";
}

function firstEnv(env: Record<string, string | undefined>, names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function pooledWorkerTimeoutMs(env: Record<string, string | undefined>) {
  const value = Number.parseInt(env.GHOLA_POOLED_WORKER_READINESS_TIMEOUT_MS || "", 10);
  return Number.isInteger(value) && value > 0 ? value : 2_500;
}

function normalizePooledWorkerReadiness(body: Record<string, unknown>): PooledWorkerReadiness {
  const venues = unavailableVenues([]);
  const rawVenues = Array.isArray(body.venues) ? body.venues : [];
  for (const rawVenue of rawVenues) {
    if (!rawVenue || typeof rawVenue !== "object" || Array.isArray(rawVenue)) continue;
    const record = rawVenue as Record<string, unknown>;
    const id = String(record.venue_id || "");
    if (!POOLED_VENUES.includes(id as PooledWorkerVenueId)) continue;
    const reasonCodes = arrayOfStrings(record.reason_codes);
    venues[id as PooledWorkerVenueId] = {
      venue_id: id as PooledWorkerVenueId,
      status: record.status === "ready" && reasonCodes.length === 0 ? "ready" : "blocked",
      ready: record.ready === true && reasonCodes.length === 0,
      reason_codes: reasonCodes,
    };
  }
  const reasonCodes = arrayOfStrings(body.reason_codes).filter((reason) => !reason.includes(":"));
  const ready = body.ready === true &&
    reasonCodes.length === 0 &&
    Object.values(venues).every((venue) => venue.ready);
  return {
    status: ready ? "ready" : "blocked",
    ready,
    endpoint_configured: true,
    reason_codes: reasonCodes,
    venues,
    checked_at: typeof body.checked_at === "string" ? body.checked_at : new Date().toISOString(),
  };
}

function withUnsupportedVenues(
  readiness: PooledWorkerReadiness,
  unsupportedVenues: PooledWorkerVenueId[],
): PooledWorkerReadiness {
  if (unsupportedVenues.length === 0) return readiness;
  const venues = { ...readiness.venues };
  for (const venueId of unsupportedVenues) {
    venues[venueId] = {
      venue_id: venueId,
      status: "blocked",
      ready: false,
      reason_codes: ["pooled_worker_venue_unsupported"],
    };
  }
  return {
    ...readiness,
    status: readiness.status === "unavailable" ? "unavailable" : "blocked",
    ready: false,
    venues,
  };
}

function unsupportedVenueIds(body: unknown): PooledWorkerVenueId[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const details = (body as { details?: unknown }).details;
  const candidates = Array.isArray(details) ? details : [(body as { error?: unknown }).error];
  const unsupported = new Set<PooledWorkerVenueId>();
  for (const item of candidates) {
    const text = String(item ?? "").toLowerCase();
    if (!text.includes("unsupported")) continue;
    for (const venueId of POOLED_VENUES) {
      if (text.includes(venueId)) unsupported.add(venueId);
    }
  }
  return [...unsupported];
}

function uniqueVenueIds(value: PooledWorkerVenueId[]): PooledWorkerVenueId[] {
  return [...new Set(value)];
}

function unavailableReadiness(reasonCodes: string[], endpointConfigured: boolean): PooledWorkerReadiness {
  return {
    status: "unavailable",
    ready: false,
    endpoint_configured: endpointConfigured,
    reason_codes: reasonCodes,
    venues: unavailableVenues(reasonCodes),
    checked_at: new Date().toISOString(),
  };
}

function unavailableVenues(reasonCodes: string[]) {
  return Object.fromEntries(POOLED_VENUES.map((venueId) => [
    venueId,
    {
      venue_id: venueId,
      status: reasonCodes.length ? "unavailable" : "blocked",
      ready: false,
      reason_codes: [...reasonCodes],
    },
  ])) as Record<PooledWorkerVenueId, PooledWorkerVenueReadiness>;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item)).filter(Boolean))]
    : [];
}
