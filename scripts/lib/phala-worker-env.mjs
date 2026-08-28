import { createHash, createPrivateKey } from "node:crypto";

export const REQUIRED_PHALA_WORKER_ENV_KEYS = Object.freeze([
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "PHALA_CVM_IMAGE_DIGEST",
  "PRIVATE_AGENT_VENUE_DRY_RUN",
  "PRIVATE_AGENT_GLOBAL_KILL_SWITCH",
  "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT",
  "PRIVATE_AGENT_STATE_STORE",
  "PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE",
  "PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
]);

const POSTGRES_MODES = new Set(["postgres", "postgresql", "neon"]);
const SINGLE_CVM_MODES = new Set(["json", "file", "sqlite"]);
const BOOLEAN_VALUES = new Set(["true", "false"]);
const PLACEHOLDER_RE = /(?:REPLACE|PLACEHOLDER|EXAMPLE|TODO|DUMMY|FAKE|TEST_ONLY|<[^>]+>)/i;

export function auditPhalaWorkerEnv(env = {}) {
  const missing = REQUIRED_PHALA_WORKER_ENV_KEYS.filter((key) => !nonEmpty(env[key]));
  const invalid = [];

  for (const key of REQUIRED_PHALA_WORKER_ENV_KEYS) {
    if (nonEmpty(env[key]) && PLACEHOLDER_RE.test(String(env[key]))) {
      invalid.push(`${key} contains a placeholder`);
    }
  }

  const workerImageDigest = normalizedDigest(env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST);
  const runtimeImageDigest = normalizedDigest(env.PHALA_CVM_IMAGE_DIGEST);
  if (nonEmpty(env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST) && !workerImageDigest) {
    invalid.push("GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST must be a sha256 digest");
  }
  if (nonEmpty(env.PHALA_CVM_IMAGE_DIGEST) && !runtimeImageDigest) {
    invalid.push("PHALA_CVM_IMAGE_DIGEST must be a sha256 digest");
  }
  if (workerImageDigest && runtimeImageDigest && workerImageDigest !== runtimeImageDigest) {
    invalid.push("worker image and runtime image digests do not match");
  }
  if (nonEmpty(env.PRIVATE_AGENT_FUNDING_SIGNING_KEY) && !validEd25519Pkcs8(env.PRIVATE_AGENT_FUNDING_SIGNING_KEY)) {
    invalid.push("PRIVATE_AGENT_FUNDING_SIGNING_KEY must be base64 PKCS8 Ed25519 material");
  }

  for (const key of [
    "PRIVATE_AGENT_VENUE_DRY_RUN",
    "PRIVATE_AGENT_GLOBAL_KILL_SWITCH",
    "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT",
    "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
  ]) {
    if (nonEmpty(env[key]) && !BOOLEAN_VALUES.has(normalized(env[key]))) {
      invalid.push(`${key} must be true or false`);
    }
  }

  if (nonEmpty(env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE)) {
    assertPositiveNumber(env, "PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", invalid);
  }
  if (nonEmpty(env.PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD)) {
    assertNonNegativeNumber(env, "PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", invalid);
  }
  for (const key of [
    "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
    "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
    "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  ]) {
    if (nonEmpty(env[key])) assertPositiveNumber(env, key, invalid);
  }

  const stateMode = normalized(env.PRIVATE_AGENT_STATE_STORE);
  if (nonEmpty(stateMode) && !POSTGRES_MODES.has(stateMode) && !SINGLE_CVM_MODES.has(stateMode)) {
    invalid.push("PRIVATE_AGENT_STATE_STORE is unsupported");
  }
  if (POSTGRES_MODES.has(stateMode) && !nonEmpty(env.PRIVATE_AGENT_STATE_POSTGRES_URL) && !nonEmpty(env.DATABASE_URL)) {
    invalid.push("postgres state requires PRIVATE_AGENT_STATE_POSTGRES_URL or DATABASE_URL");
  }
  if (SINGLE_CVM_MODES.has(stateMode) && normalized(env.PRIVATE_AGENT_STATE_SINGLE_CVM_OK) !== "true") {
    invalid.push("single-CVM state requires PRIVATE_AGENT_STATE_SINGLE_CVM_OK=true");
  }

  const liveMode = normalized(env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE);
  if (liveMode === "full_ticket") {
    for (const key of [
      "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
      "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
    ]) {
      if (!nonEmpty(env[key])) missing.push(key);
      else assertPositiveNumber(env, key, invalid);
    }
  }

  return {
    complete: missing.length === 0 && invalid.length === 0,
    missing: [...new Set(missing)].sort(),
    invalid: [...new Set(invalid)].sort(),
    state_mode: stateMode || null,
    worker_image_digest_fingerprint: fingerprint(workerImageDigest),
    capability_secret_fingerprint: fingerprint(env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET),
    execution_token_fingerprint: fingerprint(env.PRIVATE_AGENT_EXECUTION_TOKEN),
  };
}

export function auditWorkerWebAuthorization(workerEnv = {}, webEnv = {}) {
  const webCapabilitySecret = firstNonEmpty(webEnv, [
    "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
    "GHOLA_WORKER_CAPABILITY_SECRET",
  ]);
  const webExecutionToken = firstNonEmpty(webEnv, [
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "PRIVATE_AGENT_EXECUTION_TOKEN",
  ]);
  const missing = [];
  if (!webCapabilitySecret) missing.push("web capability secret");
  if (!webExecutionToken) missing.push("web execution token");

  const capabilityMatch = Boolean(webCapabilitySecret) &&
    safeFingerprint(webCapabilitySecret) === safeFingerprint(workerEnv.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET);
  const executionTokenMatch = Boolean(webExecutionToken) &&
    safeFingerprint(webExecutionToken) === safeFingerprint(workerEnv.PRIVATE_AGENT_EXECUTION_TOKEN);

  return {
    aligned: missing.length === 0 && capabilityMatch && executionTokenMatch,
    missing,
    capability_secret_match: capabilityMatch,
    execution_token_match: executionTokenMatch,
    web_capability_secret_fingerprint: fingerprint(webCapabilitySecret),
    web_execution_token_fingerprint: fingerprint(webExecutionToken),
  };
}

function firstNonEmpty(env, keys) {
  for (const key of keys) {
    if (nonEmpty(env[key])) return String(env[key]).trim();
  }
  return "";
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedDigest(value) {
  const digest = normalized(value);
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : "";
}

function assertPositiveNumber(env, key, invalid) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) invalid.push(`${key} must be positive`);
}

function assertNonNegativeNumber(env, key, invalid) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value < 0) invalid.push(`${key} must be non-negative`);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeFingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fingerprint(value) {
  if (!nonEmpty(value)) return null;
  return `sha256:${safeFingerprint(String(value).trim()).slice(0, 12)}`;
}

function validEd25519Pkcs8(value) {
  try {
    const key = createPrivateKey({
      key: Buffer.from(String(value).trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}
