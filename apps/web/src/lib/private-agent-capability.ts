import { createHash, createHmac, randomUUID } from "node:crypto";

const CAPABILITY_PREFIX = "ghcap_v1";
const DEFAULT_TTL_SECONDS = 300;

export type WorkerCapabilityScope =
  | "autopilot:control"
  | "autopilot:read"
  | "credential:verify"
  | "session:create"
  | "order:submit"
  | "order:verify"
  | "reconcile:read";

export interface WorkerAuthorizationInput {
  fallbackToken?: string | null;
  method: string;
  path: string;
  scope: WorkerCapabilityScope;
  body?: unknown;
  expected?: Record<string, unknown>;
  ttlSeconds?: number;
  env?: Record<string, string | undefined>;
}

export function workerAuthorizationHeader(input: WorkerAuthorizationInput): string | undefined {
  const env = input.env ?? process.env;
  const secret = workerCapabilitySecret(env);
  if (!secret) {
    return input.fallbackToken ? `Bearer ${input.fallbackToken}` : undefined;
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = typeof input.ttlSeconds === "number" &&
    Number.isInteger(input.ttlSeconds) &&
    input.ttlSeconds > 0
    ? input.ttlSeconds
    : DEFAULT_TTL_SECONDS;
  const payload = {
    version: 1,
    issuer: "ghola-web",
    method: input.method.toUpperCase(),
    path: input.path,
    scope: input.scope,
    body_hash: bodyHash(input.body ?? {}),
    jti: randomUUID(),
    iat: now,
    nbf: now - 5,
    exp: now + ttl,
    ...(input.expected ?? {}),
  };
  const payloadB64 = Buffer.from(stableJson(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `Bearer ${CAPABILITY_PREFIX}.${payloadB64}.${signature}`;
}

export function workerCapabilityExpectedFromBody(
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    owner_commitment: body.owner_commitment,
    account_commitment: body.account_commitment,
    session_commitment: body.session_commitment,
    autopilot_session_id: body.autopilot_session_id,
    venue_id: body.venue_id,
    platform_class: body.platform_class,
    execution_mode: body.execution_mode,
    operation_class: body.operation_class,
    work_order_commitment: body.work_order_commitment,
    policy_commitment: body.policy_commitment,
    allocation_commitment: body.allocation_commitment,
    vault_commitment: body.vault_commitment,
    ...overrides,
  };
}

function workerCapabilitySecret(env: Record<string, string | undefined>): string {
  return env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET?.trim() ||
    env.GHOLA_WORKER_CAPABILITY_SECRET?.trim() ||
    "";
}

function bodyHash(body: unknown): string {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
