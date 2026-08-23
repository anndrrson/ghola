import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "@/app/v1/private-account/_lib";

export const dynamic = "force-dynamic";

type ProxyBody = {
  path?: unknown;
  method?: unknown;
  body?: unknown;
};

const LIVE_MUTATION_PATHS = [
  /^\/v1\/private-account\/actions\/execute$/,
  /^\/v1\/private-account\/autopilot\/sessions$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+\/(?:pause|resume|kill)$/,
  /^\/v1\/private-account\/connectors\/(?:submit|verify-no-submit|reconcile)$/,
  /^\/v1\/private-account\/hyperliquid\/(?:account-snapshot|managed-allocation)$/,
  /^\/v1\/private-account\/hyperliquid\/agent\/session$/,
  /^\/v1\/private-account\/hyperliquid\/vault$/,
  /^\/v1\/private-account\/omnibus\/(?:allocate|reconcile)$/,
  /^\/v1\/private-account\/venues\/[^/]+\/(?:agent\/session|eligibility|pool\/allocate|preflight|reconcile|secret-handles\/create|stealth-account\/create|vault)$/,
];

export async function POST(req: Request) {
  const startedAt = Date.now();
  const correlationId = liveCorrelationId(req.headers.get("x-ghola-correlation-id"));
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();

  const proxyBody = readProxyBody(await readJson(req));
  if (!proxyBody) return json({ error: "invalid_live_proxy_request" }, 400);

  const target = safeLiveMutationTarget(proxyBody.path);
  if (!target) return json({ error: "live_proxy_path_not_allowed" }, 403);

  const forbidden = rejectForbiddenFields(proxyBody.body);
  if (forbidden) return forbidden;

  const proofHeaders = liveRequestProofHeaders({
    method: "POST",
    pathname: target.pathname,
    ownerCommitment: owner.owner_commitment,
    body: proxyBody.body ?? {},
  });
  if (!proofHeaders && privateAccountRequestProofRequired()) {
    return json({ error: "private_account_request_proof_unconfigured" }, 503);
  }

  console.info("[private-account-live-proxy] started", {
    correlation_id: correlationId,
    path: target.pathname,
  });
  try {
    const response = await fetch(new URL(`${target.pathname}${target.search}`, req.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        authorization: req.headers.get("authorization") ?? "",
        cookie: req.headers.get("cookie") ?? "",
        origin: new URL(req.url).origin,
        "x-ghola-correlation-id": correlationId,
        ...(proofHeaders ?? {}),
      },
      body: JSON.stringify(proxyBody.body ?? {}),
    });
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    console.info("[private-account-live-proxy] completed", {
      correlation_id: correlationId,
      path: target.pathname,
      status: response.status,
      duration_ms: durationMs,
    });
    const headers = new Headers({
      "cache-control": "no-store, max-age=0",
      "content-type": response.headers.get("content-type") || "application/json",
      "server-timing": `ghola-live-proxy;dur=${durationMs}`,
      "x-ghola-correlation-id": correlationId,
    });
    return new Response(text, {
      status: response.status,
      headers,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const ambiguous = target.pathname === "/v1/private-account/actions/execute" ||
      target.pathname === "/v1/private-account/connectors/submit";
    console.error("[private-account-live-proxy] failed", {
      correlation_id: correlationId,
      path: target.pathname,
      duration_ms: durationMs,
      error_name: error instanceof Error ? error.name : "unknown",
    });
    return new Response(JSON.stringify({
      error: ambiguous ? "connector_submit_ambiguous" : "private_account_live_proxy_unavailable",
      correlation_id: correlationId,
      retry_forbidden: ambiguous,
    }), {
      status: 502,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json",
        "server-timing": `ghola-live-proxy;dur=${durationMs}`,
        "x-ghola-correlation-id": correlationId,
      },
    });
  }
}

function liveCorrelationId(value: string | null): string {
  const normalized = value?.trim() ?? "";
  return /^[a-zA-Z0-9._:-]{12,96}$/.test(normalized)
    ? normalized
    : `ghola-${randomUUID()}`;
}

function readProxyBody(value: unknown): ProxyBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as ProxyBody;
  if (record.method !== undefined && String(record.method).toUpperCase() !== "POST") return null;
  return record;
}

function safeLiveMutationTarget(value: unknown): URL | null {
  if (typeof value !== "string" || !value.startsWith("/v1/private-account/")) return null;
  const target = new URL(value, "https://ghola.local");
  if (target.origin !== "https://ghola.local") return null;
  if (!LIVE_MUTATION_PATHS.some((pattern) => pattern.test(target.pathname))) return null;
  return target;
}

function liveRequestProofHeaders(input: {
  method: "POST";
  pathname: string;
  ownerCommitment: string;
  body: unknown;
}) {
  const secret = process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET?.trim() ?? "";
  if (!validLiveGuardProofSecret(secret)) return null;
  const timestamp = String(Date.now());
  const nonce = `web-${randomUUID()}`;
  const bodyHash = createHash("sha256").update(stableJson(input.body)).digest("hex");
  const message = [
    input.method,
    input.pathname,
    input.ownerCommitment,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  return {
    "x-ghola-request-timestamp": timestamp,
    "x-ghola-request-nonce": nonce,
    "x-ghola-request-proof": createHmac("sha256", secret).update(message).digest("hex"),
  };
}

function privateAccountRequestProofRequired() {
  const configured = (
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE ||
    process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_GUARD_MODE ||
    ""
  ).trim().toLowerCase();
  if (configured === "enforce") return true;
  if (configured === "report_only" || configured === "off") return false;
  return process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.SECURITY_PROFILE === "prod";
}

function validLiveGuardProofSecret(secret: string): boolean {
  if (!secret) return false;
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production" && process.env.SECURITY_PROFILE !== "prod") {
    return true;
  }
  const lowered = secret.toLowerCase();
  return secret.length >= 32 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder"].some((value) =>
      lowered === value || lowered.includes(value)
    );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
