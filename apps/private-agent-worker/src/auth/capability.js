import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CAPABILITY_PREFIX = "ghcap_v1";

export class WorkerCapabilityError extends Error {
  constructor(message, status = 403, code = "worker_capability_invalid") {
    super(message);
    this.name = "WorkerCapabilityError";
    this.status = status;
    this.code = code;
  }
}

export function capabilityRequired() {
  return process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY === "true" ||
    process.env.SECURITY_PROFILE === "prod" ||
    (process.env.NODE_ENV === "production" &&
      process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY !== "false");
}

export function workerCapabilitySecret() {
  return process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET ||
    process.env.GHOLA_WORKER_CAPABILITY_SECRET ||
    "";
}

export function bodyHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export async function verifyWorkerCapability({
  token,
  req,
  path,
  scope,
  body,
  state,
  expected = {},
}) {
  const secret = workerCapabilitySecret();
  if (!secret) {
    throw new WorkerCapabilityError("worker capability secret is not configured", 503, "worker_capability_unconfigured");
  }
  const payload = decodeCapability(token, secret);
  const now = Math.floor(Date.now() / 1000);
  if (!payload.jti || typeof payload.jti !== "string") {
    throw new WorkerCapabilityError("worker capability jti is required");
  }
  if (!Number.isInteger(payload.exp) || payload.exp <= now) {
    throw new WorkerCapabilityError("worker capability is expired");
  }
  if (payload.nbf && Number.isInteger(payload.nbf) && payload.nbf > now + 30) {
    throw new WorkerCapabilityError("worker capability is not active yet");
  }
  if (payload.scope !== scope) {
    throw new WorkerCapabilityError("worker capability scope mismatch");
  }
  if (payload.method !== String(req.method || "").toUpperCase()) {
    throw new WorkerCapabilityError("worker capability method mismatch");
  }
  if (payload.path !== path) {
    throw new WorkerCapabilityError("worker capability path mismatch");
  }
  const expectedBodyHash = bodyHash(body);
  if (payload.body_hash !== expectedBodyHash) {
    throw new WorkerCapabilityError("worker capability body hash mismatch");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined || expectedValue === null || expectedValue === "") continue;
    if (String(payload[key] ?? "") !== String(expectedValue)) {
      throw new WorkerCapabilityError(`worker capability ${key} mismatch`);
    }
  }
  if (state?.consumeCapabilityJti) {
    const consumed = await state.consumeCapabilityJti(payload.jti, payload.exp);
    if (!consumed?.ok) {
      throw new WorkerCapabilityError("worker capability was already used", 403, "worker_capability_replayed");
    }
  }
  return payload;
}

function decodeCapability(token, secret) {
  if (typeof token !== "string" || !token.startsWith(`${CAPABILITY_PREFIX}.`)) {
    throw new WorkerCapabilityError("worker capability token is required");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new WorkerCapabilityError("worker capability token shape is invalid");
  }
  const [, payloadB64, signatureB64] = parts;
  const expectedSignature = sign(payloadB64, secret);
  if (!safeEqual(signatureB64, expectedSignature)) {
    throw new WorkerCapabilityError("worker capability signature is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new WorkerCapabilityError("worker capability payload is invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkerCapabilityError("worker capability payload is invalid");
  }
  return payload;
}

function sign(payloadB64, secret) {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
