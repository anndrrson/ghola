import { createHash, generateKeyPairSync, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertRecipientSecretMatches } from "./crypto/envelope.js";
import {
  capabilityRequired,
  verifyWorkerCapability,
} from "./auth/capability.js";
import {
  controlAutopilotSession,
  createAutopilotSession,
  listAutopilotEvents,
  runAutopilotTick,
  startAutopilotLoop,
} from "./execution/autopilot.js";
import {
  createHyperliquidManagedAllocation,
  executeCoinbaseOrder,
  executeHyperliquidOrder,
  executeJupiterSwapOrder,
  executeSolanaPerpsOrder,
  readHyperliquidSnapshot,
  reconcileStoredExecution,
  streamHyperliquidAccountState,
  storeCoinbaseSession,
  storeHyperliquidSession,
  storePrivateAgentSession,
  verifyCoinbaseOrderNoSubmit,
  verifyVenueCredential,
  verifyHyperliquidOrderNoSubmit,
  verifyJupiterSwapNoSubmit,
  verifySolanaPerpsOrderNoSubmit,
} from "./execution/private-execution.js";
import { createConfiguredWorkerState } from "./state/private-state.js";
import {
  attestFreshCredentialFunded,
  FundingAttestationError,
  fundingSigningIdentity,
} from "./venues/shielded_funding_attestation.js";
import {
  hyperliquidManagedAccountRefs,
  loadManagedHyperliquidCredential,
} from "./venues/hyperliquid.js";
import { loadPooledSolanaPerpsCredential } from "./venues/solana_perps.js";
import { loadPooledJupiterCredential } from "./venues/jupiter.js";
import { loadPartnerCoinbaseCredential } from "./venues/coinbase.js";
import {
  createConsumerRuntime,
  verifyVercelSpendWebhookSignature,
} from "./consumer/runtime.js";

const MAX_BODY_BYTES = 256 * 1024;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const PLAINTEXT_LEAK_KEYS = new Set([
  "account_id",
  "api_key",
  "api_key_id",
  "api_key_name",
  "api_secret",
  "api_wallet",
  "api_wallet_private_key",
  "cdp_api_key",
  "coinbase_api_key",
  "coinbase_api_key_name",
  "coinbase_key_name",
  "coinbase_private_key",
  "coinbase_signing_key",
  "hyperliquid_account_id",
  "key_secret",
  "leverage",
  "leverage_update",
  "messages",
  "mnemonic",
  "order_payload",
  "order_params",
  "orders",
  "plaintext",
  "policy",
  "policy_text",
  "prompt",
  "raw_order",
  "raw_private_key",
  "secret_key",
  "seed_phrase",
  "source",
  "strategy",
  "strategy_text",
  "system_prompt",
  "vault_transfer",
  "wallet_private_key",
]);
const RECIPIENT_REPORT_DOMAIN = "ghola-private-agent-recipient-v1";
const DSTACK_QUOTE_PATHS = [
  {
    socketPath: "/var/run/dstack.sock",
    path: "/GetQuote",
    bodyKey: "reportData",
  },
  {
    socketPath: "/var/run/tappd.sock",
    path: "/prpc/Tappd.TdxQuote?json",
    bodyKey: "report_data",
  },
];
let attestationCache = null;

function json(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": encoded.length,
    "content-type": "application/json",
  });
  res.end(encoded);
}

function sseHeaders(res) {
  res.writeHead(200, {
    "cache-control": "no-store, no-cache, must-revalidate",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function boolEnv(name) {
  return env(name).toLowerCase() === "true";
}

function dataDir() {
  return env("PRIVATE_AGENT_DATA_DIR", "/data");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function recipientReportDataHex(recipient, fundingSignerPublicKeyB64 = "") {
  const fields = [RECIPIENT_REPORT_DOMAIN, recipient.recipient_id, recipient.x25519_pub_hex];
  if (String(fundingSignerPublicKeyB64 || "").trim()) {
    fields.push(String(fundingSignerPublicKeyB64).trim());
  }
  return `0x${sha256Hex(fields.join("\0"))}`;
}

function derivePublicHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function generatedRecipient() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "private-agent-recipient-x25519.json");
  try {
    const parsed = JSON.parse(readFileSync(keyPath, "utf8"));
    if (
      typeof parsed.recipient_id === "string" &&
      typeof parsed.x25519_pub_hex === "string" &&
      PUBLIC_KEY_HEX_RE.test(parsed.x25519_pub_hex)
    ) {
      return parsed;
    }
  } catch {
    // First boot in a new sealed volume.
  }

  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const x25519PubHex = derivePublicHex(publicKey);
  const recipient = {
    recipient_id: `phala:cvm:${sha256Hex(x25519PubHex).slice(0, 16)}`,
    x25519_pub_hex: x25519PubHex,
    private_key_pkcs8_pem: privateKey.export({ format: "pem", type: "pkcs8" }),
    created_at: new Date().toISOString(),
  };
  writeFileSync(keyPath, JSON.stringify(recipient, null, 2), { mode: 0o600 });
  return recipient;
}

export function loadRecipient() {
  const configuredPublicKey = env("PRIVATE_AGENT_X25519_PUB_HEX");
  const configuredRecipientId = env("PRIVATE_AGENT_RECIPIENT_ID");
  if (configuredPublicKey || configuredRecipientId) {
    if (!PUBLIC_KEY_HEX_RE.test(configuredPublicKey)) {
      throw Object.assign(new Error("PRIVATE_AGENT_X25519_PUB_HEX must be 32-byte hex"), {
        status: 500,
      });
    }
    if (!configuredRecipientId) {
      throw Object.assign(new Error("PRIVATE_AGENT_RECIPIENT_ID is required with configured public key"), {
        status: 500,
      });
    }
    return {
      recipient_id: configuredRecipientId,
      x25519_pub_hex: configuredPublicKey.toLowerCase(),
      x25519_secret_hex: env("PRIVATE_AGENT_X25519_SECRET_HEX") || null,
      private_key_pkcs8_pem: env("PRIVATE_AGENT_X25519_PRIVATE_KEY_PKCS8_PEM") || null,
      created_at: null,
    };
  }
  return generatedRecipient();
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function gholaCommitment(prefix, value) {
  return `${prefix}_${sha256Hex(stableJson(value)).slice(0, 48)}`;
}

function postUnixJson({ socketPath, path, body }) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-length": encoded.length,
          "content-type": "application/json",
        },
        timeout: 2500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`dstack quote returned ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("dstack quote timed out")));
    req.on("error", reject);
    req.write(encoded);
    req.end();
  });
}

function extractMeasurementHex(quote) {
  if (!isObject(quote)) return null;
  const candidates = [
    quote.mr_aggregated,
    quote.mrAggregated,
    quote.measurement,
    quote.app_compose_hash,
    quote.tcb_info?.app_compose,
    quote.tcbInfo?.appCompose,
    quote.quote?.mr_aggregated,
    quote.quote?.mrAggregated,
  ];
  return (
    candidates.find((value) => typeof value === "string" && value.trim().length > 0) ??
    null
  );
}

async function loadDstackAttestation(recipient, fundingSignerPublicKeyB64 = "") {
  const reportDataHex = recipientReportDataHex(recipient, fundingSignerPublicKeyB64);
  if (attestationCache?.report_data_hex === reportDataHex) return attestationCache;

  const staticQuoteJson = env("PRIVATE_AGENT_DSTACK_QUOTE_JSON");
  if (staticQuoteJson) {
    const quote = JSON.parse(staticQuoteJson);
    attestationCache = {
      attestation_hash: sha256Hex(canonicalJson(quote)),
      measurement_hex: extractMeasurementHex(quote),
      quote,
      report_data_hex: reportDataHex,
    };
    return attestationCache;
  }

  for (const candidate of DSTACK_QUOTE_PATHS) {
    try {
      const quote = await postUnixJson({
        socketPath: candidate.socketPath,
        path: candidate.path,
        body: { [candidate.bodyKey]: reportDataHex },
      });
      attestationCache = {
        attestation_hash: sha256Hex(canonicalJson(quote)),
        measurement_hex: extractMeasurementHex(quote),
        quote,
        report_data_hex: reportDataHex,
      };
      return attestationCache;
    } catch {
      // Try the next dstack socket shape.
    }
  }
  return null;
}

async function attestationMetadata(recipient, fundingSignerPublicKeyB64 = "") {
  const dynamic = boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE")
    ? await loadDstackAttestation(recipient, fundingSignerPublicKeyB64)
    : null;
  return {
    attestation_hash:
      env("PHALA_ATTESTATION_HASH", env("PRIVATE_AGENT_ATTESTATION_HASH", "")) ||
      dynamic?.attestation_hash ||
      null,
    measurement_hex:
      env("PHALA_CVM_MEASUREMENT_HEX", env("PRIVATE_AGENT_MEASUREMENT_HEX", "")) ||
      dynamic?.measurement_hex ||
      null,
    quote_hash: dynamic?.attestation_hash ?? null,
    report_data_hex: dynamic?.report_data_hex ?? recipientReportDataHex(recipient, fundingSignerPublicKeyB64),
  };
}

async function publicRecipient(recipient) {
  const fundingSigner = fundingSigningIdentity();
  const attestation = await attestationMetadata(recipient, fundingSigner.public_key_b64);
  return {
    recipient_id: recipient.recipient_id,
    x25519_pub_hex: recipient.x25519_pub_hex,
    funding_signer_public_key_b64: fundingSigner.public_key_b64,
    tee_kind: env("PRIVATE_AGENT_TEE_KIND", "phala"),
    measurement_hex: attestation.measurement_hex,
    attestation_hash: attestation.attestation_hash,
    image_digest: env("PHALA_CVM_IMAGE_DIGEST", env("PRIVATE_AGENT_IMAGE_DIGEST", null)),
    report_data_hex: attestation.report_data_hex,
    quote_hash: attestation.quote_hash,
    attested_ready:
      boolEnv("PRIVATE_AGENT_ATTESTED_READY") ||
      (boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE") &&
        Boolean(attestation.attestation_hash)),
    expires_at_unix: null,
  };
}

async function runtimeHealthEvidence(recipient, ready, observedAt = new Date()) {
  const fundingSigner = fundingSigningIdentity();
  const attestation = await attestationMetadata(recipient, fundingSigner.public_key_b64);
  const imageDigest = env("PHALA_CVM_IMAGE_DIGEST", env("PRIVATE_AGENT_IMAGE_DIGEST", null));
  const provider = env("PRIVATE_AGENT_PROVIDER_ID", "phala");
  const teeKind = env("PRIVATE_AGENT_TEE_KIND", "phala");
  const attestedReady =
    boolEnv("PRIVATE_AGENT_ATTESTED_READY") ||
    (boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE") &&
      Boolean(attestation.attestation_hash));
  const measurement = attestation.measurement_hex ||
    imageDigest ||
    attestation.quote_hash ||
    attestation.attestation_hash ||
    null;
  const policy = {
    sealed_execution_required: true,
    plaintext_rejected: true,
    provider,
    tee_kind: teeKind,
    recipient_id: recipient.recipient_id,
    report_data_hex: attestation.report_data_hex,
    funding_signer_public_key_b64: fundingSigner.public_key_b64 || null,
  };
  const runtimeAttestationCommitment = attestation.attestation_hash
    ? gholaCommitment("runtime_attestation", {
        attestation_hash: attestation.attestation_hash,
        quote_hash: attestation.quote_hash,
        report_data_hex: attestation.report_data_hex,
        recipient_id: recipient.recipient_id,
        funding_signer_public_key_b64: fundingSigner.public_key_b64 || null,
      })
    : null;
  const runtimeMeasurementCommitment = measurement
    ? gholaCommitment("runtime_measurement", measurement)
    : null;
  const runtimePolicyCommitment = gholaCommitment("runtime_policy", policy);
  const status = ready.ready && runtimeAttestationCommitment && runtimeMeasurementCommitment
    ? "green"
    : "red";
  return {
    service: "ghola-private-agent-worker",
    status,
    ok: status === "green",
    ready: ready.ready,
    attested: attestedReady,
    attested_ready: attestedReady,
    sealed_execution_required: true,
    plaintext_rejected: true,
    provider,
    tee_kind: teeKind,
    observed_at: observedAt.toISOString(),
    checked_at: observedAt.toISOString(),
    runtime_health_commitment: gholaCommitment("runtime_health", {
      status,
      recipient_id: recipient.recipient_id,
      report_data_hex: attestation.report_data_hex,
      runtime_attestation_commitment: runtimeAttestationCommitment,
      runtime_measurement_commitment: runtimeMeasurementCommitment,
      runtime_policy_commitment: runtimePolicyCommitment,
      observed_at: observedAt.toISOString(),
    }),
    runtime_attestation_commitment: runtimeAttestationCommitment,
    runtime_measurement_commitment: runtimeMeasurementCommitment,
    runtime_policy_commitment: runtimePolicyCommitment,
    runtime_measurement: measurement,
    measurement_hex: attestation.measurement_hex,
    attestation_hash: attestation.attestation_hash,
    image_digest: imageDigest,
    report_data_hex: attestation.report_data_hex,
    quote_hash: attestation.quote_hash,
    missing: ready.missing,
    reason: status === "green"
      ? null
      : ready.missing[0] || "sealed runtime health evidence is incomplete",
  };
}

async function readiness(recipient) {
  const fundingSigner = fundingSigningIdentity();
  const attestation = await attestationMetadata(recipient, fundingSigner.public_key_b64);
  const missing = [];
  if (!recipient?.recipient_id || !PUBLIC_KEY_HEX_RE.test(recipient.x25519_pub_hex || "")) {
    missing.push("recipient_key");
  }
  try {
    assertRecipientSecretMatches(recipient);
  } catch {
    missing.push("recipient_secret");
  }
  const attestedReady =
    boolEnv("PRIVATE_AGENT_ATTESTED_READY") ||
    (boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE") &&
      Boolean(attestation.attestation_hash));
  if (!attestedReady) missing.push("attestation");
  if (!env("PHALA_CVM_IMAGE_DIGEST", env("PRIVATE_AGENT_IMAGE_DIGEST"))) missing.push("image_digest");
  const dstackQuoteReady =
    boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE") &&
    Boolean(attestation.attestation_hash);
  if (!attestation.measurement_hex && !dstackQuoteReady) {
    missing.push("measurement");
  }
  if (!attestation.attestation_hash) {
    missing.push("attestation_hash");
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && !env("PRIVATE_AGENT_FUNDING_SIGNING_KEY")) {
    missing.push("funding_signer");
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

function authToken() {
  return env("PRIVATE_AGENT_EXECUTION_TOKEN", env("PHALA_CLOUD_API_KEY"));
}

/// Resolve the execution token, requiring it to be present. Fails closed: a
/// worker started without `PRIVATE_AGENT_EXECUTION_TOKEN` (or
/// `PHALA_CLOUD_API_KEY`) must NOT expose the sealed-execution endpoint
/// unauthenticated. Throws a 503 so `/private-agent/sessions` rejects rather
/// than silently accepting any caller.
function requiredAuthToken() {
  const token = authToken();
  if (!token) {
    throw Object.assign(
      new Error(
        "PRIVATE_AGENT_EXECUTION_TOKEN (or PHALA_CLOUD_API_KEY) is required; refusing unauthenticated execution"
      ),
      { status: 503 }
    );
  }
  return token;
}

function bearer(req) {
  const raw = req.headers.authorization || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

/// Constant-time-ish string comparison for bearer tokens. Node's
/// `crypto.timingSafeEqual` requires equal-length buffers; length leakage of a
/// high-entropy token is negligible, so we short-circuit on length and only
/// compare contents when lengths match.
function tokensEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function authorizeWorkerRequest(req, { path, scope, body = {}, state, expected = {} }) {
  const rawBearer = bearer(req);
  if (rawBearer.startsWith("ghcap_v1.")) {
    await verifyWorkerCapability({
      token: rawBearer,
      req,
      path,
      scope,
      body,
      state,
      expected,
    });
    return null;
  }
  if (capabilityRequired()) {
    return {
      status: 401,
      body: {
        error: "worker_capability_required",
        error_code: "worker_capability_required",
      },
    };
  }
  const token = requiredAuthToken();
  if (!tokensEqual(rawBearer, token)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return null;
}

function authJson(res, rejected) {
  if (!rejected) return false;
  json(res, rejected.status, rejected.body);
  return true;
}

function capabilityExpectedFromBody(body = {}, overrides = {}) {
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

async function readAuthorizedJson(req, res, { path, scope, state, expected = {} }) {
  const body = await readJson(req);
  const rejected = await authorizeWorkerRequest(req, {
    path,
    scope,
    body,
    state,
    expected: typeof expected === "function" ? expected(body) : expected,
  });
  if (authJson(res, rejected)) return { rejected: true, body: null };
  return { rejected: false, body };
}

async function readJson(req) {
  return JSON.parse(await readRaw(req) || "{}");
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function constantTimeBearer(header, expectedToken) {
  if (!expectedToken || expectedToken.length < 32 || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsPlaintextLeakKey(value) {
  if (Array.isArray(value)) return value.some(containsPlaintextLeakKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (PLAINTEXT_LEAK_KEYS.has(key)) return true;
    return containsPlaintextLeakKey(child);
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isEvmAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

const POOLED_READINESS_VENUES = ["hyperliquid", "phoenix", "backpack", "jupiter", "coinbase"];
const BACKPACK_SOL_PERP_SYMBOL = "SOL_USDC_PERP";

function validatePooledReadinessRequest(body) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (body.operation_class !== "pooled_readiness") {
    errors.push("operation_class must be pooled_readiness");
  }
  if (body.venues !== undefined) {
    if (!Array.isArray(body.venues)) {
      errors.push("venues must be an array");
    } else {
      for (const venue of body.venues) {
        if (!POOLED_READINESS_VENUES.includes(String(venue))) {
          errors.push(`venue ${String(venue)} is unsupported`);
        }
      }
    }
  }
  return errors;
}

function pooledReadinessVenueIds(body = {}) {
  if (!Array.isArray(body.venues) || body.venues.length === 0) return POOLED_READINESS_VENUES;
  return [...new Set(body.venues.map((venue) => String(venue)).filter((venue) =>
    POOLED_READINESS_VENUES.includes(venue)
  ))];
}

function stateStoreMode() {
  return String(process.env.PRIVATE_AGENT_STATE_STORE || process.env.GHOLA_PRIVATE_AGENT_STATE_STORE || "json")
    .trim()
    .toLowerCase();
}

function sharedStateReady() {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return { ready: true, mode: stateStoreMode(), reason_codes: [] };
  }
  const mode = stateStoreMode();
  const singleCvmPersistentStateOk =
    process.env.PRIVATE_AGENT_STATE_SINGLE_CVM_OK === "true" &&
    ["json", "file"].includes(mode);
  const ready = ["postgres", "postgresql", "neon"].includes(mode) || singleCvmPersistentStateOk;
  return {
    ready,
    mode,
    reason_codes: ready ? [] : ["worker_state_store_not_shared"],
  };
}

function positiveCap(name, fallbackName = null) {
  const raw = process.env[name] || (fallbackName ? process.env[fallbackName] : "") || "";
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function bpsCap(name, fallbackName = null) {
  const raw = process.env[name] || (fallbackName ? process.env[fallbackName] : "") || "";
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function commaListEnv(...names) {
  for (const name of names) {
    const raw = process.env[name] || "";
    const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length) return values;
  }
  return [];
}

function pooledVenueReadiness(venueId, sharedState) {
  const reasonCodes = [];
  const dryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true";
  if (!sharedState.ready) reasonCodes.push(...sharedState.reason_codes);
  try {
    if (venueId === "hyperliquid") {
      if (process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") {
        reasonCodes.push("hyperliquid_mainnet_worker_disabled");
      }
      if (process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "full_ticket") {
        reasonCodes.push("hyperliquid_live_mode_disabled");
      }
      if (positiveCap("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD") <= 0) {
        reasonCodes.push("hyperliquid_max_order_cap_missing");
      }
      if (positiveCap("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD") <= 0) {
        reasonCodes.push("hyperliquid_daily_cap_missing");
      }
      if (bpsCap("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS") <= 0) {
        reasonCodes.push("hyperliquid_slippage_cap_missing");
      }
      const refs = dryRun ? [{ network: "mainnet" }] : hyperliquidManagedAccountRefs();
      const mainnetRefs = refs.filter((ref) => ref.network === "mainnet");
      if (mainnetRefs.length === 0) reasonCodes.push("hyperliquid_pooled_account_pool_missing");
      if (!dryRun && mainnetRefs[0]) {
        loadManagedHyperliquidCredential({
          execution_mode: "ghola_pooled",
          network: "mainnet",
          credential_ref: mainnetRefs[0].credential_ref,
        });
      }
      return pooledVenueReadinessResult(venueId, reasonCodes, {
        credential_count: mainnetRefs.length,
      });
    }
    if (venueId === "phoenix") {
      if (process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET !== "true") {
        reasonCodes.push("phoenix_mainnet_worker_disabled");
      }
      if (process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE !== "full_ticket") {
        reasonCodes.push("phoenix_live_mode_disabled");
      }
      if (positiveCap("PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD") <= 0) {
        reasonCodes.push("phoenix_max_order_cap_missing");
      }
      if (bpsCap("PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", "GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS") <= 0) {
        reasonCodes.push("phoenix_slippage_cap_missing");
      }
      const credential = dryRun ? { authority: "dry-run" } : loadPooledSolanaPerpsCredential("phoenix");
      return pooledVenueReadinessResult(venueId, reasonCodes, {
        authority_commitment: commitment("phoenix_pooled_authority", credential.authority || "configured"),
      });
    }
    if (venueId === "backpack") {
      const liveMode = process.env.PRIVATE_AGENT_BACKPACK_LIVE_MODE || process.env.GHOLA_BACKPACK_LIVE_MODE || "disabled";
      const allowedSymbols = commaListEnv("PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS", "GHOLA_BACKPACK_ALLOWED_SYMBOLS")
        .map((symbol) => symbol.toUpperCase());
      const maxOrderNotional = positiveCap("PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD", "GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD");
      const dailyNotionalCap = positiveCap("PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD", "GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD");
      if (process.env.PRIVATE_AGENT_BACKPACK_POOLED_ENABLED !== "true" && process.env.GHOLA_BACKPACK_POOLED_ENABLED !== "true") {
        reasonCodes.push("backpack_pooled_disabled");
      }
      if (liveMode !== "tiny_live" && liveMode !== "full_ticket") reasonCodes.push("backpack_live_mode_disabled");
      if (!env("PRIVATE_AGENT_BACKPACK_API_KEY", env("GHOLA_BACKPACK_API_KEY"))) {
        reasonCodes.push("backpack_api_key_missing");
      }
      if (!env("PRIVATE_AGENT_BACKPACK_API_SECRET", env("PRIVATE_AGENT_BACKPACK_API_PRIVATE_KEY_B64", env("GHOLA_BACKPACK_API_SECRET", env("GHOLA_BACKPACK_API_PRIVATE_KEY_B64"))))) {
        reasonCodes.push("backpack_private_key_missing");
      }
      if (!allowedSymbols.includes(BACKPACK_SOL_PERP_SYMBOL)) reasonCodes.push("backpack_symbol_allowlist_missing");
      if (maxOrderNotional <= 0 || maxOrderNotional > 5) reasonCodes.push("backpack_max_order_cap_missing");
      if (dailyNotionalCap <= 0 || dailyNotionalCap > 25) reasonCodes.push("backpack_daily_cap_missing");
      if (process.env.PRIVATE_AGENT_BACKPACK_POST_ONLY_MM !== "true" && process.env.GHOLA_BACKPACK_POST_ONLY_MM !== "true") {
        reasonCodes.push("backpack_post_only_mm_required");
      }
      if (!dryRun && reasonCodes.length === 0) loadPooledSolanaPerpsCredential("backpack");
      return pooledVenueReadinessResult(venueId, reasonCodes, {
        credential_commitment: reasonCodes.includes("backpack_api_key_missing")
          ? null
          : commitment("backpack_pooled_api_key", "configured"),
        allowed_symbols: allowedSymbols,
        max_order_notional_usd: maxOrderNotional || null,
        daily_notional_cap_usd: dailyNotionalCap || null,
      });
    }
    if (venueId === "jupiter") {
      if (process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE !== "full") {
        reasonCodes.push("jupiter_live_mode_disabled");
      }
      if (!env("PRIVATE_AGENT_JUPITER_API_KEY", env("JUPITER_API_KEY", env("GHOLA_JUPITER_API_KEY")))) {
        reasonCodes.push("jupiter_api_key_missing");
      }
      if (commaListEnv("PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS", "GHOLA_JUPITER_ALLOWED_INPUT_MINTS").length === 0) {
        reasonCodes.push("jupiter_input_mint_allowlist_missing");
      }
      if (commaListEnv("PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS", "GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS").length === 0) {
        reasonCodes.push("jupiter_output_mint_allowlist_missing");
      }
      if (positiveCap("PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", "GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD") <= 0) {
        reasonCodes.push("jupiter_max_order_cap_missing");
      }
      if (bpsCap("PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", "GHOLA_JUPITER_MAX_SLIPPAGE_BPS") <= 0) {
        reasonCodes.push("jupiter_slippage_cap_missing");
      }
      const credential = dryRun ? { authority: "dry-run" } : loadPooledJupiterCredential();
      return pooledVenueReadinessResult(venueId, reasonCodes, {
        authority_commitment: commitment("jupiter_pooled_authority", credential.authority || "configured"),
      });
    }
    if (venueId === "coinbase") {
      if (process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE !== "full") {
        reasonCodes.push("coinbase_live_mode_disabled");
      }
      if (commaListEnv("PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS", "GHOLA_COINBASE_ALLOWED_PRODUCTS").length === 0) {
        reasonCodes.push("coinbase_product_allowlist_missing");
      }
      if (positiveCap("PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", "GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD") <= 0) {
        reasonCodes.push("coinbase_max_order_cap_missing");
      }
      const credential = dryRun ? { api_key_name: "dry-run" } : loadPartnerCoinbaseCredential();
      return pooledVenueReadinessResult(venueId, reasonCodes, {
        credential_commitment: commitment("coinbase_partner_pool_key", credential.api_key_name || "configured"),
      });
    }
  } catch (error) {
    reasonCodes.push(pooledCredentialErrorCode(venueId, error));
  }
  return pooledVenueReadinessResult(venueId, reasonCodes);
}

function pooledCredentialErrorCode(venueId, error) {
  if (venueId === "hyperliquid") return "hyperliquid_pooled_account_pool_missing";
  if (venueId === "phoenix") return "phoenix_pooled_authority_missing";
  if (venueId === "backpack") return "backpack_pooled_credentials_missing";
  if (venueId === "jupiter") return "jupiter_pooled_authority_missing";
  if (venueId === "coinbase") return "coinbase_omnibus_pool_not_ready";
  return error?.code || "pooled_credential_unavailable";
}

function pooledVenueReadinessResult(venueId, reasonCodes, extra = {}) {
  const uniqueReasons = [...new Set(reasonCodes)];
  return {
    venue_id: venueId,
    status: uniqueReasons.length === 0 ? "ready" : "blocked",
    ready: uniqueReasons.length === 0,
    reason_codes: uniqueReasons,
    ...extra,
  };
}

function pooledReadinessResponse(body) {
  const sharedState = sharedStateReady();
  const venues = pooledReadinessVenueIds(body).map((venueId) =>
    pooledVenueReadiness(venueId, sharedState)
  );
  const globalReasons = [...new Set(sharedState.reason_codes)];
  const venueReasons = venues.flatMap((venue) =>
    venue.reason_codes.map((reason) => `${venue.venue_id}:${reason}`)
  );
  const reasonCodes = [...new Set([...globalReasons, ...venueReasons])];
  return {
    version: 1,
    status: reasonCodes.length === 0 ? "ready" : "blocked",
    ready: reasonCodes.length === 0,
    operation_class: "pooled_readiness",
    state_store: {
      mode: sharedState.mode,
      shared: sharedState.ready,
    },
    venues,
    reason_codes: reasonCodes,
    checked_at: new Date().toISOString(),
  };
}

function validateSessionRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext strategy, prompt, policy, or messages");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.strategy_id)) errors.push("strategy_id is required");
  if (!isNonEmptyString(body.policy_hash)) errors.push("policy_hash is required");
  if (!isNonEmptyString(body.owner_did)) errors.push("owner_did is required");
  if (body.mode !== "capped_session_key") errors.push("mode must be capped_session_key");
  if (!isObject(body.encrypted_strategy_bundle)) {
    errors.push("encrypted_strategy_bundle is required");
    return errors;
  }

  const bundle = body.encrypted_strategy_bundle;
  if (bundle.alg !== "sealed-provider-v1" && bundle.alg !== "hpke-x25519-aes256gcm") {
    errors.push("encrypted_strategy_bundle.alg is unsupported");
  }
  if (!isNonEmptyString(bundle.ciphertext)) {
    errors.push("encrypted_strategy_bundle.ciphertext is required");
  }
  if (!isNonEmptyString(bundle.recipient)) {
    errors.push("encrypted_strategy_bundle.recipient is required");
  } else if (bundle.recipient !== recipient.recipient_id) {
    errors.push("encrypted_strategy_bundle.recipient must match worker recipient");
  }
  if (!isNonEmptyString(bundle.aad)) {
    errors.push("encrypted_strategy_bundle.aad is required");
  }
  if ("encapsulated_key" in bundle && !isNonEmptyString(bundle.encapsulated_key)) {
    errors.push("encrypted_strategy_bundle.encapsulated_key must be non-empty");
  }
  return errors;
}

function appendSessionAudit(body, receipt) {
  const auditPath = env("PRIVATE_AGENT_SESSION_AUDIT_PATH");
  if (!auditPath) return;
  const line = JSON.stringify({
    accepted_at: receipt.accepted_at,
    owner_hash: sha256Hex(body.owner_did).slice(0, 24),
    policy_hash: body.policy_hash,
    recipient: body.encrypted_strategy_bundle.recipient,
    session_id: receipt.session_id,
    strategy_id: body.strategy_id,
  });
  writeFileSync(auditPath, `${line}\n`, { flag: "a", mode: 0o600 });
}

function buildReceipt(body) {
  return {
    version: 1,
    session_id: `pas_${randomUUID()}`,
    provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
    strategy_id: body.strategy_id,
    policy_hash: body.policy_hash,
    accepted_at: new Date().toISOString(),
    sealed_execution_required: true,
  };
}

function commitment(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 48)}`;
}

function validateEncryptedBundle(bundle, recipient, fieldName) {
  const errors = [];
  if (!isObject(bundle)) {
    errors.push(`${fieldName} is required`);
    return errors;
  }
  if (bundle.alg !== "sealed-provider-v1" && bundle.alg !== "hpke-x25519-aes256gcm") {
    errors.push(`${fieldName}.alg is unsupported`);
  }
  if (!isNonEmptyString(bundle.ciphertext)) {
    errors.push(`${fieldName}.ciphertext is required`);
  }
  if (!isNonEmptyString(bundle.recipient)) {
    errors.push(`${fieldName}.recipient is required`);
  } else if (bundle.recipient !== recipient.recipient_id) {
    errors.push(`${fieldName}.recipient must match worker recipient`);
  }
  if (!isNonEmptyString(bundle.aad)) {
    errors.push(`${fieldName}.aad is required`);
  }
  if ("encapsulated_key" in bundle && !isNonEmptyString(bundle.encapsulated_key)) {
    errors.push(`${fieldName}.encapsulated_key must be non-empty`);
  }
  return errors;
}

function platformFeePolicyMode() {
  const configured = env("PRIVATE_AGENT_PLATFORM_FEE_POLICY_MODE", "").trim().toLowerCase();
  if (configured === "enforce") return "enforce";
  if (configured === "report_only" || configured === "off") return "report_only";
  if (boolEnv("PRIVATE_AGENT_REQUIRE_PLATFORM_FEE_POLICY")) return "enforce";
  return "report_only";
}

function validatePlatformFeePolicy(body, options = {}) {
  if (options.requirePlatformFeePolicy === false || platformFeePolicyMode() !== "enforce") return [];
  const errors = [];
  const policy = body.platform_fee_policy;
  if (!isObject(policy)) {
    errors.push("platform_fee_policy is required");
    return errors;
  }
  if (policy.version !== 1) errors.push("platform_fee_policy.version must be 1");
  if (policy.policy_kind !== "ghola_connector_platform_fee_policy_v1") {
    errors.push("platform_fee_policy.policy_kind is unsupported");
  }
  if (!isNonEmptyString(policy.fee_policy_commitment)) {
    errors.push("platform_fee_policy.fee_policy_commitment is required");
  }
  if (body.platform_fee_policy_commitment !== policy.fee_policy_commitment) {
    errors.push("platform_fee_policy_commitment must match platform_fee_policy.fee_policy_commitment");
  }
  if (!isNonEmptyString(policy.fee_recipient)) errors.push("platform_fee_policy.fee_recipient is required");
  if (!Number.isInteger(policy.fee_bps) || policy.fee_bps <= 0) {
    errors.push("platform_fee_policy.fee_bps must be a positive integer");
  }
  if (!Number.isInteger(policy.min_fee_micro_usdc) || policy.min_fee_micro_usdc < 0) {
    errors.push("platform_fee_policy.min_fee_micro_usdc must be a non-negative integer");
  }
  if (!Number.isInteger(policy.estimated_notional_micro_usdc) || policy.estimated_notional_micro_usdc < 0) {
    errors.push("platform_fee_policy.estimated_notional_micro_usdc must be a non-negative integer");
  }
  if (!Number.isInteger(policy.fee_micro_usdc) || policy.fee_micro_usdc <= 0) {
    errors.push("platform_fee_policy.fee_micro_usdc must be a positive integer");
  }
  if (policy.quote_asset !== "USDC") errors.push("platform_fee_policy.quote_asset must be USDC");
  if (policy.collection_mode !== "paid_private_agent_plan_and_worker_bound_fee") {
    errors.push("platform_fee_policy.collection_mode is unsupported");
  }
  return errors;
}

function validateHyperliquidSessionRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Hyperliquid credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  const executionMode = hyperliquidExecutionMode(body);
  if (!["byo_api_key", "managed_testnet", "ghola_pooled", "hyperliquid_native_vault"].includes(executionMode)) {
    errors.push("execution_mode is unsupported");
  }
  if (!isNonEmptyString(body.account_commitment)) errors.push("account_commitment is required");
  if (!isNonEmptyString(body.policy_commitment)) errors.push("policy_commitment is required");
  if (executionMode === "byo_api_key") {
    if (!isNonEmptyString(body.vault_commitment)) errors.push("vault_commitment is required");
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  } else if (!isNonEmptyString(body.managed_allocation_commitment) && !isNonEmptyString(body.allocation_commitment)) {
    errors.push("managed_allocation_commitment is required");
  }
  if ("encrypted_strategy_bundle" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_strategy_bundle, recipient, "encrypted_strategy_bundle"));
  }
  const capped = body.session_policy;
  if (capped !== undefined) {
    if (!isObject(capped)) errors.push("session_policy must be an object");
    else {
      if (!Array.isArray(capped.market_allowlist)) errors.push("session_policy.market_allowlist is required");
      if (!isNonEmptyString(capped.max_notional_bucket)) errors.push("session_policy.max_notional_bucket is required");
      if (!Number.isInteger(capped.max_order_count) || capped.max_order_count < 0) {
        errors.push("session_policy.max_order_count must be a non-negative integer");
      }
      if (capped.kill_switch === true) errors.push("session_policy kill switch is active");
    }
  }
  return errors;
}

function validateHyperliquidOrderRequest(body, recipient, options = {}) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Hyperliquid credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if (!isNonEmptyString(body.policy_commitment)) errors.push("policy_commitment is required");
  const executionMode = hyperliquidExecutionMode(body);
  if (!["byo_api_key", "managed_testnet", "ghola_pooled", "hyperliquid_native_vault"].includes(executionMode)) {
    errors.push("execution_mode is unsupported");
  }
  if (body.encrypted_execution_vault && (body.managed_allocation_commitment || body.allocation_commitment)) {
    errors.push("encrypted_execution_vault and managed_allocation_commitment cannot both be set");
  }
  const operation = body.operation_class;
  if (!["read", "limit_order", "cancel", "reconcile"].includes(operation)) {
    errors.push("operation_class is unsupported");
  }
  if (executionMode === "byo_api_key") {
    if (!isNonEmptyString(body.vault_commitment)) errors.push("vault_commitment is required");
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  } else if (!isNonEmptyString(body.managed_allocation_commitment) && !isNonEmptyString(body.allocation_commitment)) {
    errors.push("managed_allocation_commitment is required");
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(
      body.encrypted_execution_instruction_bundle,
      recipient,
      "encrypted_execution_instruction_bundle",
    ));
  }
  errors.push(...validatePlatformFeePolicy(body, options));
  return errors;
}

function validateHyperliquidAccountSnapshotRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Hyperliquid credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.account_commitment)) errors.push("account_commitment is required");
  const executionMode = hyperliquidExecutionMode(body);
  if (!["byo_api_key", "managed_testnet", "ghola_pooled", "hyperliquid_native_vault"].includes(executionMode)) {
    errors.push("execution_mode is unsupported");
  }
  if (executionMode === "byo_api_key") {
    if (!isNonEmptyString(body.vault_commitment)) errors.push("vault_commitment is required");
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  } else if (!isNonEmptyString(body.managed_allocation_commitment) && !isNonEmptyString(body.allocation_commitment)) {
    errors.push("managed_allocation_commitment is required");
  }
  return errors;
}

function validateHyperliquidReconcileRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Hyperliquid credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  const executionMode = hyperliquidExecutionMode(body);
  if (!["byo_api_key", "managed_testnet", "ghola_pooled", "hyperliquid_native_vault"].includes(executionMode)) {
    errors.push("execution_mode is unsupported");
  }
  if (body.encrypted_execution_vault && (body.managed_allocation_commitment || body.allocation_commitment)) {
    errors.push("encrypted_execution_vault and managed_allocation_commitment cannot both be set");
  }
  if ("encrypted_execution_vault" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  }
  if ((executionMode === "managed_testnet" || executionMode === "ghola_pooled" || executionMode === "hyperliquid_native_vault") &&
    !isNonEmptyString(body.managed_allocation_commitment) &&
    !isNonEmptyString(body.allocation_commitment)) {
    errors.push("managed_allocation_commitment is required");
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_instruction_bundle, recipient, "encrypted_execution_instruction_bundle"));
  }
  return errors;
}

function validateHyperliquidManagedAllocationRequest(body) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Hyperliquid credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.account_commitment)) errors.push("account_commitment is required");
  if (!isNonEmptyString(body.policy_commitment)) errors.push("policy_commitment is required");
  const executionMode = body.execution_mode === "hyperliquid_native_vault"
    ? "hyperliquid_native_vault"
    : body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "managed_testnet";
  if (executionMode === "managed_testnet" && body.network && body.network !== "testnet") {
    errors.push("network must be testnet for the Hyperliquid managed pilot");
  }
  if (executionMode === "hyperliquid_native_vault") {
    if (body.network && body.network !== "mainnet") {
      errors.push("network must be mainnet for Hyperliquid native vault mode");
    }
    if (!isEvmAddress(body.vault_address)) {
      errors.push("vault_address is required for Hyperliquid native vault mode");
    }
  }
  if (executionMode === "ghola_pooled") {
    if (body.network && body.network !== "mainnet") {
      errors.push("network must be mainnet for Hyperliquid Vault Mode");
    }
    if (!isNonEmptyString(body.eligibility_commitment)) {
      errors.push("eligibility_commitment is required for Hyperliquid Vault Mode");
    }
  }
  const capped = body.session_policy;
  if (capped !== undefined) {
    if (!isObject(capped)) errors.push("session_policy must be an object");
    else {
      if (!Array.isArray(capped.market_allowlist)) errors.push("session_policy.market_allowlist is required");
      if (!isNonEmptyString(capped.max_notional_bucket)) errors.push("session_policy.max_notional_bucket is required");
      if (!Number.isInteger(capped.max_order_count) || capped.max_order_count < 0) {
        errors.push("session_policy.max_order_count must be a non-negative integer");
      }
      if (capped.kill_switch === true) errors.push("session_policy kill switch is active");
    }
  }
  return errors;
}

function hyperliquidValidationErrorCode(errors) {
  return errors.some((error) =>
    /encrypted_execution_vault|vault_commitment|execution credentials|API wallet/i.test(error)
  )
    ? "venue_access_required"
    : "connector_submit_failed";
}

function hyperliquidSessionReceipt(body) {
  const executionMode = hyperliquidExecutionMode(body);
  const sessionCommitment = commitment("hyperliquid_session", {
    account_commitment: body.account_commitment,
    execution_mode: executionMode,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.managed_allocation_commitment || body.allocation_commitment || null,
    policy_commitment: body.policy_commitment,
  });
  return {
    version: 1,
    status: "armed",
    provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    hyperliquid_session_commitment: sessionCommitment,
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.managed_allocation_commitment || body.allocation_commitment || null,
    policy_commitment: body.policy_commitment,
    venue_access_source: hyperliquidVenueAccessSource(executionMode),
    ghola_access_role: "private_execution_router",
    venue_gate: "venue_accepts_or_rejects_credentials",
    accepted_at: new Date().toISOString(),
    sealed_execution_required: true,
  };
}

function hyperliquidOrderReceipt(body, status = "submitted") {
  const executionMode = hyperliquidExecutionMode(body);
  const providerRefCommitment = commitment("hyperliquid_provider_ref", {
    work_order_commitment: body.work_order_commitment,
    operation_class: body.operation_class,
    execution_mode: executionMode,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.managed_allocation_commitment || body.allocation_commitment || null,
  });
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    status,
    work_order_commitment: body.work_order_commitment,
    platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.managed_allocation_commitment || body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("hyperliquid_result", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
      status,
    }),
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "execution_account_and_order_activity",
      venue_access_source: hyperliquidVenueAccessSource(executionMode),
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
    },
    updated_at: new Date().toISOString(),
  };
}

function hyperliquidExecutionMode(body) {
  if (body?.execution_mode === "hyperliquid_native_vault" ||
    body?.managed_allocation?.execution_mode === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  if (body?.execution_mode === "ghola_pooled") return "ghola_pooled";
  if (body?.execution_mode === "managed_testnet" || body?.managed_allocation_commitment || (
    body?.allocation_commitment && body?.execution_mode !== "byo_api_key"
  )) {
    return "managed_testnet";
  }
  if (body?.execution_mode === "byo_api_key" || !body?.execution_mode) return "byo_api_key";
  return String(body.execution_mode);
}

function hyperliquidVenueAccessSource(executionMode) {
  if (executionMode === "ghola_pooled") return "ghola_pooled_venue_account";
  if (executionMode === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  if (executionMode === "managed_testnet") return "ghola_managed_testnet";
  return "user_provided_credentials";
}

function validateCoinbaseSessionRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Coinbase credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (body.venue_id !== "coinbase_advanced") errors.push("venue_id must be coinbase_advanced");
  if (body.platform_class !== "coinbase_style_provider") errors.push("platform_class must be coinbase_style_provider");
  if (!["byo_api_key", "partner_omnibus"].includes(body.execution_mode)) {
    errors.push("execution_mode is unsupported");
  }
  if (!isNonEmptyString(body.account_commitment)) errors.push("account_commitment is required");
  if (!isNonEmptyString(body.policy_commitment)) errors.push("policy_commitment is required");
  if (body.execution_mode === "byo_api_key") {
    if (!isNonEmptyString(body.vault_commitment)) errors.push("vault_commitment is required");
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  }
  if (body.execution_mode === "partner_omnibus") {
    errors.push(...validateOmnibusAllocation(body.omnibus_allocation));
  }
  const capped = body.session_policy;
  if (capped !== undefined) {
    if (!isObject(capped)) errors.push("session_policy must be an object");
    else {
      if (!Array.isArray(capped.market_allowlist)) errors.push("session_policy.market_allowlist is required");
      if (!isNonEmptyString(capped.max_notional_bucket)) errors.push("session_policy.max_notional_bucket is required");
      if (!Number.isInteger(capped.max_order_count) || capped.max_order_count < 0) {
        errors.push("session_policy.max_order_count must be a non-negative integer");
      }
      if (capped.kill_switch === true) errors.push("session_policy kill switch is active");
    }
  }
  return errors;
}

function validateCoinbaseOrderRequest(body, recipient, options = {}) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Coinbase credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (body.venue_id !== "coinbase_advanced") errors.push("venue_id must be coinbase_advanced");
  if (body.platform_class !== "coinbase_style_provider") errors.push("platform_class must be coinbase_style_provider");
  if (!["byo_api_key", "partner_omnibus"].includes(body.execution_mode)) {
    errors.push("execution_mode is unsupported");
  }
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if (!["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"].includes(body.operation_class)) {
    errors.push("operation_class is unsupported");
  }
  if (body.execution_mode === "byo_api_key") {
    if (!isNonEmptyString(body.vault_commitment)) errors.push("vault_commitment is required");
    if (!isNonEmptyString(body.policy_commitment)) errors.push("policy_commitment is required");
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(
      body.encrypted_execution_instruction_bundle,
      recipient,
      "encrypted_execution_instruction_bundle",
    ));
  }
  if (body.execution_mode === "partner_omnibus") {
    errors.push(...validateOmnibusAllocation(body.omnibus_allocation));
  }
  errors.push(...validatePlatformFeePolicy(body, options));
  return errors;
}

function validateCoinbaseReconcileRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Coinbase credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if ("encrypted_execution_vault" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_instruction_bundle, recipient, "encrypted_execution_instruction_bundle"));
  }
  return errors;
}

function validateSolanaPerpsOrderRequest(body, recipient, options = {}) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Solana perps credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (body.platform_class !== "solana_perps_market") errors.push("platform_class must be solana_perps_market");
  if (body.venue_id && !["phoenix", "drift", "backpack", "solana_perps"].includes(body.venue_id)) {
    errors.push("venue_id is unsupported");
  }
  if (!["user_stealth", "ghola_pooled", undefined, null].includes(body.execution_mode)) {
    errors.push("execution_mode is unsupported");
  }
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if (!["read", "perp_limit_order", "cancel", "fills", "reconcile"].includes(body.operation_class)) {
    errors.push("operation_class is unsupported");
  }
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  if ("encrypted_execution_vault" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  } else if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && executionMode !== "ghola_pooled") {
    errors.push("encrypted_execution_vault is required for live Solana perps submit");
  }
  if (executionMode === "ghola_pooled" && !isNonEmptyString(body.allocation_commitment)) {
    errors.push("allocation_commitment is required for pooled Solana perps submit");
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(
      body.encrypted_execution_instruction_bundle,
      recipient,
      "encrypted_execution_instruction_bundle",
    ));
  } else {
    errors.push("encrypted_execution_instruction_bundle is required");
  }
  errors.push(...validatePlatformFeePolicy(body, options));
  return errors;
}

function validateSolanaPerpsReconcileRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Solana perps credentials, strategy, prompt, policy, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if (body.venue_id && !["phoenix", "drift", "backpack", "solana_perps"].includes(body.venue_id)) {
    errors.push("venue_id is unsupported");
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_instruction_bundle, recipient, "encrypted_execution_instruction_bundle"));
  }
  return errors;
}

function validateSolanaSwapOrderRequest(body, recipient, options = {}) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Jupiter credentials, strategy, prompt, policy, or swap payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (body.platform_class !== "solana_swap_aggregator") errors.push("platform_class must be solana_swap_aggregator");
  if (body.venue_id && body.venue_id !== "jupiter") errors.push("venue_id must be jupiter");
  if (!["user_stealth", "ghola_pooled", undefined, null].includes(body.execution_mode)) {
    errors.push("execution_mode is unsupported");
  }
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if (!["read", "preview_order", "swap", "reconcile"].includes(body.operation_class)) {
    errors.push("operation_class is unsupported");
  }
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  if ("encrypted_execution_vault" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  } else if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && executionMode !== "ghola_pooled") {
    errors.push("encrypted_execution_vault is required for live Jupiter submit");
  }
  if (executionMode === "ghola_pooled" && !isNonEmptyString(body.allocation_commitment)) {
    errors.push("allocation_commitment is required for pooled Jupiter submit");
  }
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(
      body.encrypted_execution_instruction_bundle,
      recipient,
      "encrypted_execution_instruction_bundle",
    ));
  } else {
    errors.push("encrypted_execution_instruction_bundle is required");
  }
  errors.push(...validatePlatformFeePolicy(body, options));
  return errors;
}

function validateSolanaSwapReconcileRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext Jupiter credentials, strategy, prompt, policy, or swap payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.work_order_commitment)) errors.push("work_order_commitment is required");
  if ("encrypted_execution_instruction_bundle" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_instruction_bundle, recipient, "encrypted_execution_instruction_bundle"));
  }
  if ("encrypted_execution_vault" in body) {
    errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  }
  return errors;
}

function validateOmnibusAllocation(allocation) {
  const errors = [];
  if (!isObject(allocation)) {
    errors.push("omnibus_allocation is required");
    return errors;
  }
  for (const key of [
    "allocation_commitment",
    "pool_commitment",
    "partner_commitment",
    "subledger_account_commitment",
  ]) {
    if (!isNonEmptyString(allocation[key])) errors.push(`omnibus_allocation.${key} is required`);
  }
  if (allocation.status && !["allocated", "pending_funding", "paused", "revoked"].includes(allocation.status)) {
    errors.push("omnibus_allocation.status is unsupported");
  }
  if (allocation.status === "paused" || allocation.status === "revoked") {
    errors.push("omnibus_allocation is not active");
  }
  return errors;
}

function coinbaseSessionReceipt(body) {
  const sessionCommitment = commitment("coinbase_session", {
    account_commitment: body.account_commitment,
    execution_mode: body.execution_mode,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || null,
    policy_commitment: body.policy_commitment,
  });
  return {
    version: 1,
    status: "armed",
    provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode,
    coinbase_session_commitment: sessionCommitment,
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || null,
    policy_commitment: body.policy_commitment,
    accepted_at: new Date().toISOString(),
    sealed_execution_required: true,
  };
}

function coinbaseOrderReceipt(body, status = "submitted") {
  const providerRefCommitment = commitment("coinbase_provider_ref", {
    work_order_commitment: body.work_order_commitment,
    operation_class: body.operation_class,
    execution_mode: body.execution_mode,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || null,
  });
  return {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode || "partner_omnibus",
    status,
    work_order_commitment: body.work_order_commitment,
    platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("coinbase_result", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
      status,
    }),
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      coinbase_sees: body.execution_mode === "partner_omnibus"
        ? "partner_pooled_account_and_order_activity"
        : "byo_account_and_order_activity",
    },
    updated_at: new Date().toISOString(),
  };
}

function solanaPerpsOrderReceipt(body, status = "submitted") {
  const venueId = ["phoenix", "drift", "backpack"].includes(body.venue_id) ? body.venue_id : "phoenix";
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const providerRefCommitment = commitment(`${venueId}_provider_ref`, {
    work_order_commitment: body.work_order_commitment,
    operation_class: body.operation_class,
    execution_mode: executionMode,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.allocation_commitment || null,
  });
  return {
    version: 1,
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
    status,
    work_order_commitment: body.work_order_commitment,
    platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment(`${venueId}_result`, {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      platform_fee_policy_commitment: body.platform_fee_policy_commitment || null,
      status,
    }),
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      solana_perps_sees: executionMode === "ghola_pooled"
        ? "pooled_venue_account_and_order_activity"
        : "stealth_venue_account_and_order_activity",
      venue_access_source: executionMode,
      venue_gate: "venue_accepts_or_rejects_account_and_order",
      public_chain_sees: "venue_account_activity_visible_if_public_settlement",
    },
    updated_at: new Date().toISOString(),
  };
}

function omnibusAllocationReceipt(body, status = "allocated") {
  const allocation = body.omnibus_allocation || body;
  const allocationCommitment = allocation.allocation_commitment || commitment("omnibus_allocation", allocation);
  return {
    version: 1,
    status,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "partner_omnibus",
    allocation_commitment: allocationCommitment,
    pool_commitment: allocation.pool_commitment,
    partner_commitment: allocation.partner_commitment,
    subledger_account_commitment: allocation.subledger_account_commitment,
    result_commitment: commitment("omnibus_allocation_result", {
      allocation_commitment: allocationCommitment,
      status,
    }),
    updated_at: new Date().toISOString(),
  };
}

function validateShieldedFundingAttestRequest(body) {
  const errors = [];
  if (!isObject(body)) {
    errors.push("request body must be an object");
    return errors;
  }
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext secret fields");
  }
  const bundle = body.withdraw_bundle;
  if (!isObject(bundle)) {
    errors.push("withdraw_bundle is required");
  } else {
    if (!isNonEmptyString(bundle.instruction_data_hex)) {
      errors.push("withdraw_bundle.instruction_data_hex is required");
    }
    if (!Array.isArray(bundle.accounts)) {
      errors.push("withdraw_bundle.accounts must be an array");
    }
  }
  if (!isNonEmptyString(body.destination_commitment)) {
    errors.push("destination_commitment is required");
  }
  if (!isNonEmptyString(body.amount_bucket)) {
    errors.push("amount_bucket is required");
  }
  if (
    body.min_confirmations !== undefined &&
    !(Number.isInteger(body.min_confirmations) && body.min_confirmations > 0)
  ) {
    errors.push("min_confirmations must be a positive integer when provided");
  }
  return errors;
}

function validateCredentialVerifyRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) {
    errors.push("request body must be an object");
    return errors;
  }
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext credentials, strategy, prompt, policy text, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.venue_id)) errors.push("venue_id is required");
  if (!isNonEmptyString(body.account_commitment)) errors.push("account_commitment is required");
  errors.push(...validateEncryptedBundle(body.encrypted_execution_vault, recipient, "encrypted_execution_vault"));
  return errors;
}

function validateAutopilotSessionRequest(body, recipient) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext credentials, strategy, prompt, policy text, or order payloads");
  }
  if (body.version !== 1 && body.version !== 2 && body.version !== undefined) {
    errors.push("version must be 1 or 2");
  }
  if (!isNonEmptyString(body.owner_commitment)) errors.push("owner_commitment is required");
  const policy = body.session_policy;
  if (policy !== undefined && !isObject(policy)) errors.push("session_policy must be an object");
  if (isObject(policy)) {
    if (policy.venue_allowlist !== undefined && !Array.isArray(policy.venue_allowlist)) {
      errors.push("session_policy.venue_allowlist must be an array");
    }
    if (policy.market_allowlist !== undefined && !Array.isArray(policy.market_allowlist)) {
      errors.push("session_policy.market_allowlist must be an array");
    }
    if (policy.kill_switch === true) errors.push("session_policy kill switch is active");
  }
  const access = body.venue_access || body.venue_vaults;
  if (access !== undefined && !isObject(access)) errors.push("venue_access must be an object");
  if (isObject(access)) {
    for (const [venue, value] of Object.entries(access)) {
      if (!isObject(value)) {
        errors.push(`venue_access.${venue} must be an object`);
        continue;
      }
      if ("encrypted_execution_vault" in value && value.encrypted_execution_vault !== null) {
        errors.push(...validateEncryptedBundle(
          value.encrypted_execution_vault,
          recipient,
          `venue_access.${venue}.encrypted_execution_vault`,
        ));
      }
    }
  }
  return errors;
}

function validateTriVenueCommandRequest(body) {
  const errors = [];
  if (!isObject(body)) return ["request body must be an object"];
  if (containsPlaintextLeakKey(body)) {
    errors.push("request must not contain plaintext credentials, strategy, prompt, policy text, or order payloads");
  }
  if (body.version !== 1) errors.push("version must be 1");
  if (!isNonEmptyString(body.owner_commitment)) errors.push("owner_commitment is required");
  if (body.market !== undefined && String(body.market).toUpperCase() !== "SOL-USD") {
    errors.push("market must be SOL-USD");
  }
  if (body.caps !== undefined && !isObject(body.caps)) errors.push("caps must be an object");
  return errors;
}

function triVenueSessionBody(body, strategy = "arb", hyperliquidAllocation = null) {
  const caps = isObject(body.caps) ? body.caps : {};
  const policy = {
    version: 2,
    strategy_id: strategy === "maker" ? "tri_venue_market_maker_v1" : "hedged_spread_arbitrage_v1",
    decision_model: "rules_plus_ai_score",
    ai_direct_enabled: false,
    venue_allowlist: ["phoenix", "hyperliquid", "backpack"],
    market_allowlist: ["SOL-USD"],
    max_notional_bucket: "5",
    max_position_notional_bucket: "50",
    max_loss_bucket: "25",
    max_daily_notional_bucket: "25",
    max_order_count: strategy === "maker" ? 2 : 4,
    ttl_ms: strategy === "maker" ? 10 * 60_000 : 60 * 60_000,
    max_slippage_bps: Math.min(25, Number.parseInt(String(caps.max_slippage_bps || "25"), 10) || 25),
    cooldown_ms: 60_000,
    data_max_age_ms: Math.min(2_000, Number.parseInt(String(caps.max_market_data_skew_ms || "2000"), 10) || 2_000),
    min_net_edge_bps: 25,
    max_execution_skew_ms: Math.min(2_000, Number.parseInt(String(caps.max_execution_skew_ms || "2000"), 10) || 2_000),
    min_ai_score_bps: 6_500,
    ai_min_confidence_bps: 6_500,
    min_signal_bps: 25,
    max_spread_bps: 150,
    allowed_order_types: ["perp_limit_order", "limit_order", "cancel"],
    kill_switch: false,
    reduce_only_on_reconcile_failure: true,
  };
  return {
    version: 1,
    owner_commitment: body.owner_commitment,
    session_policy: policy,
    venue_access: {
      phoenix: {
        status: "ready",
        execution_mode: "ghola_pooled",
        reason: "tri_venue_pooled_worker_owns_credentials",
      },
      hyperliquid: {
        status: "ready",
        execution_mode: "ghola_pooled",
        allocation_commitment: hyperliquidAllocation?.allocation_commitment || null,
        managed_allocation_commitment: hyperliquidAllocation?.allocation_commitment || null,
        reason: "tri_venue_pooled_worker_owns_credentials",
      },
      backpack: {
        status: "ready",
        execution_mode: "ghola_pooled",
        reason: "tri_venue_pooled_worker_owns_credentials",
      },
    },
  };
}

export function createPrivateAgentWorkerServer(options = {}) {
  const recipient = options.recipient || loadRecipient();
  const state = options.state || createConfiguredWorkerState(dataDir());
  const consumerRuntime = options.consumerRuntime || createConsumerRuntime();
  if (options.startConsumerRuntime !== false) consumerRuntime.start();
  if (options.resumeAutopilotLoops !== false) {
    queueMicrotask(() => {
      resumeAutopilotLoops({ state, recipient }).catch((error) => {
        console.error("autopilot resume failed", error?.message || error);
      });
    });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const ready = await readiness(recipient);

      if (req.method === "GET" && url.pathname === "/consumer/ready") {
        const status = await consumerRuntime.ready();
        return json(res, status.ready ? 200 : 503, status);
      }

      if (url.pathname === "/consumer/circuit") {
        const token = env("PRIVATE_AGENT_TRADING_CONTROL_TOKEN", env("GHOLA_TRADING_CONTROL_TOKEN"));
        if (!constantTimeBearer(req.headers.authorization, token)) {
          return json(res, 401, { error: "trading_control_auth_required" });
        }
        if (req.method === "GET") return json(res, 200, await consumerRuntime.circuit());
        if (req.method === "POST") {
          const body = await readJson(req);
          if (body.action === "halt") return json(res, 200, await consumerRuntime.halt(["operator_halt"], String(body.acknowledged_by || "operator")));
          if (body.action === "resume") {
            try {
              return json(res, 200, await consumerRuntime.resume(body));
            } catch (error) {
              return json(res, 409, { error: error?.code || "circuit_resume_requirements_not_met" });
            }
          }
          return json(res, 400, { error: "supported_action_required" });
        }
      }

      if (req.method === "POST" && url.pathname === "/consumer/reconciliation") {
        const token = env("PRIVATE_AGENT_RECONCILIATION_INGEST_TOKEN", env("GHOLA_RECONCILIATION_INGEST_TOKEN"));
        if (!constantTimeBearer(req.headers.authorization, token)) {
          return json(res, 401, { error: "reconciliation_ingest_auth_required" });
        }
        const body = await readJson(req);
        try {
          return json(res, 200, await consumerRuntime.reconcile(body));
        } catch (error) {
          const code = error?.code || "consumer_reconciliation_failed";
          return json(res, code === "venue_order_not_found" ? 404 : 409, { error: code });
        }
      }

      if (req.method === "POST" && url.pathname === "/consumer/vercel-spend-webhook") {
        const raw = await readRaw(req);
        const valid = verifyVercelSpendWebhookSignature({
          body: raw,
          signature: req.headers["x-vercel-signature"],
          secret: env("PRIVATE_AGENT_VERCEL_SPEND_WEBHOOK_SECRET"),
        });
        if (!valid) return json(res, 401, { error: "spend_webhook_signature_invalid" });
        const body = JSON.parse(raw || "{}");
        const threshold = Number(body.thresholdPercent ?? body.threshold_percent ?? body.percent ?? 0);
        if (threshold >= 100) {
          await consumerRuntime.halt(["operator_halt"], "system:vercel_spend_threshold");
        }
        return json(res, 202, { accepted: true, trading_halted: threshold >= 100 });
      }

      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
        return json(res, ready.ready ? 200 : 503, await runtimeHealthEvidence(recipient, ready));
      }

      if (req.method === "GET" && url.pathname === "/ready") {
        return json(res, ready.ready ? 200 : 503, {
          ready: ready.ready,
          missing: ready.missing,
        });
      }

      if (
        req.method === "GET" &&
        url.pathname === "/.well-known/private-agent-recipient"
      ) {
        return json(res, 200, await publicRecipient(recipient));
      }

      if (req.method === "POST" && url.pathname === "/venues/pools/readiness") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "credential:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            operation_class: "pooled_readiness",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validatePooledReadinessRequest(body);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid pooled readiness request",
            details: errors,
          });
        }
        return json(res, 200, pooledReadinessResponse(body));
      }

      if (req.method === "POST" && url.pathname === "/autopilot/sessions") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "autopilot:control",
          state,
          expected: (body) => capabilityExpectedFromBody(body),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateAutopilotSessionRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid autopilot session request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const session = await createAutopilotSession({
          body,
          recipient,
          state,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
        });
        return json(res, 201, {
          version: 1,
          session,
          events: await state.listAutopilotEvents(session.autopilot_session_id),
        });
      }

      const triVenueCommand = url.pathname.match(/^\/autopilot\/tri-venue\/(run|market-maker\/start|kill)$/);
      if (req.method === "POST" && triVenueCommand) {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const action = triVenueCommand[1];
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: action === "kill" ? "autopilot:control" : "order:submit",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            operation_class: "tri_venue_live",
            owner_commitment: body?.owner_commitment,
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateTriVenueCommandRequest(body);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid tri-venue command request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        if (action === "kill") {
          const sessionId = isNonEmptyString(body.autopilot_session_id) ? body.autopilot_session_id : null;
          if (sessionId) {
            const result = await controlAutopilotSession({
              sessionId,
              action: "kill",
              state,
              recipient,
            });
            if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
            return json(res, 200, { version: 1, action, ...result });
          }
          return json(res, 200, {
            version: 1,
            action,
            status: "accepted",
            result_commitment: commitment("tri_venue_kill_all", {
              owner_commitment: body.owner_commitment,
              requested_at: new Date().toISOString(),
            }),
            next_step: "Kill command accepted; no worker session id was provided.",
          });
        }

        const sessionBody = triVenueSessionBody(body, action === "market-maker/start" ? "maker" : "arb");
        sessionBody.session_policy.policy_commitment = commitment("tri_venue_worker_policy", sessionBody.session_policy);
        const hyperliquidAllocation = await createHyperliquidManagedAllocation({
          body: {
            version: 1,
            execution_mode: "ghola_pooled",
            account_commitment: body.owner_commitment,
            policy_commitment: sessionBody.session_policy.policy_commitment,
            eligibility_commitment: body.eligibility_commitment || null,
            session_policy: sessionBody.session_policy,
          },
          state,
        });
        const session = await createAutopilotSession({
          body: triVenueSessionBody(
            body,
            action === "market-maker/start" ? "maker" : "arb",
            hyperliquidAllocation,
          ),
          recipient,
          state,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
          startLoop: false,
        });
        const tick = action === "market-maker/start"
          ? { ok: true, status: "maker_session_armed", mode: "post_only_quotes_deferred_to_policy_loop" }
          : await runAutopilotTick({
              sessionId: session.autopilot_session_id,
              state,
              recipient,
            });
        return json(res, tick.ok === false ? 202 : 200, {
          version: 1,
          action,
          session,
          tick,
          events: await state.listAutopilotEvents(session.autopilot_session_id),
        });
      }

      const autopilotControl = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)\/(pause|resume|kill)$/);
      if (req.method === "POST" && autopilotControl) {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:control",
          body: {},
          state,
          expected: {
            autopilot_session_id: autopilotControl[1],
            action: autopilotControl[2],
          },
        });
        if (authJson(res, rejected)) return;
        const result = await controlAutopilotSession({
          sessionId: autopilotControl[1],
          action: autopilotControl[2],
          state,
          recipient,
        });
        if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
        return json(res, 200, { version: 1, ...result });
      }

      const autopilotSession = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)$/);
      if (req.method === "GET" && autopilotSession) {
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:read",
          body: {},
          state,
          expected: { autopilot_session_id: autopilotSession[1] },
        });
        if (authJson(res, rejected)) return;
        const result = await listAutopilotEvents({
          sessionId: autopilotSession[1],
          state,
        });
        if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
        return json(res, 200, { version: 1, ...result });
      }

      const autopilotDecisions = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)\/decisions$/);
      if (req.method === "GET" && autopilotDecisions) {
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:read",
          body: {},
          state,
          expected: { autopilot_session_id: autopilotDecisions[1] },
        });
        if (authJson(res, rejected)) return;
        const result = await listAutopilotEvents({
          sessionId: autopilotDecisions[1],
          state,
        });
        if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
        return json(res, 200, {
          version: 1,
          session: result.session,
          decisions: await state.listAutopilotDecisions(autopilotDecisions[1]),
        });
      }

      const autopilotPositions = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)\/positions$/);
      if (req.method === "GET" && autopilotPositions) {
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:read",
          body: {},
          state,
          expected: { autopilot_session_id: autopilotPositions[1] },
        });
        if (authJson(res, rejected)) return;
        const result = await listAutopilotEvents({
          sessionId: autopilotPositions[1],
          state,
        });
        if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
        return json(res, 200, {
          version: 1,
          session: result.session,
          positions: await state.listAutopilotPositions(autopilotPositions[1]),
        });
      }

      const autopilotOpportunities = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)\/opportunities$/);
      if (req.method === "GET" && autopilotOpportunities) {
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:read",
          body: {},
          state,
          expected: { autopilot_session_id: autopilotOpportunities[1] },
        });
        if (authJson(res, rejected)) return;
        const result = await listAutopilotEvents({
          sessionId: autopilotOpportunities[1],
          state,
        });
        if (!result) return json(res, 404, { error: "autopilot_session_not_found" });
        return json(res, 200, {
          version: 1,
          session: result.session,
          opportunities: await state.listAutopilotOpportunities(autopilotOpportunities[1]),
        });
      }

      const autopilotEvents = url.pathname.match(/^\/autopilot\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && autopilotEvents) {
        const rejected = await authorizeWorkerRequest(req, {
          path: url.pathname,
          scope: "autopilot:read",
          body: {},
          state,
          expected: { autopilot_session_id: autopilotEvents[1] },
        });
        if (authJson(res, rejected)) return;
        const initial = await listAutopilotEvents({
          sessionId: autopilotEvents[1],
          state,
        });
        if (!initial) return json(res, 404, { error: "autopilot_session_not_found" });
        if (initial.session.status === "running" || initial.session.status === "risk_halted") {
          startAutopilotLoop({ sessionId: initial.session.autopilot_session_id, state, recipient });
        }
        sseHeaders(res);
        let closed = false;
        const seen = new Set();
        const emitCurrent = async () => {
          const current = await listAutopilotEvents({
            sessionId: autopilotEvents[1],
            state,
          });
          if (!current) {
            writeSse(res, "stream_status", {
              version: 1,
              stream_status: "closed",
              error: "autopilot_session_not_found",
              updated_at: new Date().toISOString(),
            });
            res.end();
            return false;
          }
          writeSse(res, "session_state", current.session);
          for (const event of current.events) {
            if (seen.has(event.event_id)) continue;
            seen.add(event.event_id);
            writeSse(res, event.type, event);
          }
          writeSse(res, "stream_status", {
            version: 1,
            stream_status: "live",
            updated_at: new Date().toISOString(),
          });
          return true;
        };
        await emitCurrent();
        const timer = setInterval(async () => {
          if (closed || !(await emitCurrent())) {
            clearInterval(timer);
          }
        }, 5_000);
        timer.unref?.();
        req.on("close", () => {
          closed = true;
          clearInterval(timer);
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/managed/allocations") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "session:create",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
            operation_class: "managed_allocation",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidManagedAllocationRequest(body);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid managed allocation request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const allocation = await createHyperliquidManagedAllocation({ body, state });
        return json(res, 201, allocation);
      }

      if (req.method === "POST" && url.pathname === "/private-agent/sessions") {
        // Fail closed: a missing execution token throws a 503 (handled by the
        // outer catch) rather than allowing unauthenticated sealed execution.
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }

        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "session:create",
          state,
          expected: (body) => capabilityExpectedFromBody(body),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSessionRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid private-agent session request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }

        await storePrivateAgentSession({
          body,
          recipient,
          state,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
        });
        const receipt = buildReceipt(body);
        appendSessionAudit(body, receipt);
        return json(res, 201, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/credentials/verify") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "credential:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateCredentialVerifyRequest(body, recipient);
        if (errors.length) {
          return json(res, 400, {
            error: "invalid credential verification request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const verification = await verifyVenueCredential({ body, recipient, state });
        return json(res, 200, verification);
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/sessions") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "session:create",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidSessionRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid private session request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        await storeHyperliquidSession({
          body,
          recipient,
          state,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
        });
        return json(res, 201, hyperliquidSessionReceipt(body));
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/account-snapshot") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidAccountSnapshotRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid account snapshot request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const snapshot = await readHyperliquidSnapshot({ body, recipient, state });
        return json(res, 200, snapshot);
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/account-stream") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidAccountSnapshotRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid account stream request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        sseHeaders(res);
        let stop = null;
        let closed = false;
        req.on("close", () => {
          closed = true;
          if (stop) stop();
        });
        try {
          stop = await streamHyperliquidAccountState({
            body,
            recipient,
            state,
            onEvent: ({ event, data }) => {
              if (!closed) writeSse(res, event, data);
            },
          });
          if (closed && stop) stop();
        } catch (error) {
          if (!closed) {
            writeSse(res, "error", {
              version: 1,
              stream_status: "worker_unavailable",
              error: error.code === "venue_access_required" ? "venue_access_required" : "stream_unavailable",
              next_step: error.code === "venue_access_required"
                ? "Connect a Hyperliquid API wallet."
                : "Wait for the private worker to reconnect.",
              updated_at: new Date().toISOString(),
            });
            res.end();
          }
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/orders") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:submit",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidOrderRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid private order request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await executeHyperliquidOrder({ body, recipient, state });
        return json(res, 202, receipt);
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/verify") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        if (req.headers["x-ghola-no-submit-verify"] !== "true") {
          return json(res, 400, { error: "no-submit verification header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidOrderRequest(body, recipient, { requirePlatformFeePolicy: false });
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid private verification request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await verifyHyperliquidOrderNoSubmit({ body, recipient, state });
        return json(res, 200, receipt);
      }

      if (req.method === "POST" && url.pathname === "/hyperliquid/reconcile") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "hyperliquid",
            platform_class: "hyperliquid_style_market",
            operation_class: "reconcile",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateHyperliquidReconcileRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid hyperliquid reconcile request",
            details: errors,
            error_code: hyperliquidValidationErrorCode(errors),
          });
        }
        return json(res, 200, await reconcileStoredExecution({
          body: {
            ...body,
            vault_commitment: body.vault_commitment || "vault_commitment_redacted",
            policy_commitment: body.policy_commitment || "policy_commitment_redacted",
            operation_class: "reconcile",
          },
          state,
          venue_id: "hyperliquid",
          platform_class: "hyperliquid_style_market",
        }));
      }

      if (req.method === "POST" && url.pathname === "/venues/coinbase/sessions") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "session:create",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "coinbase_advanced",
            platform_class: "coinbase_style_provider",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateCoinbaseSessionRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid coinbase private session request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        await storeCoinbaseSession({
          body,
          recipient,
          state,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
        });
        return json(res, 201, coinbaseSessionReceipt(body));
      }

      if (req.method === "POST" && url.pathname === "/venues/coinbase/orders") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:submit",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "coinbase_advanced",
            platform_class: "coinbase_style_provider",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateCoinbaseOrderRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid coinbase private order request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await executeCoinbaseOrder({ body, recipient, state });
        return json(res, 202, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/coinbase/verify") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        if (req.headers["x-ghola-no-submit-verify"] !== "true") {
          return json(res, 400, { error: "no-submit verification header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "coinbase_advanced",
            platform_class: "coinbase_style_provider",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateCoinbaseOrderRequest(body, recipient, { requirePlatformFeePolicy: false });
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid coinbase private verification request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await verifyCoinbaseOrderNoSubmit({ body, recipient, state });
        return json(res, 200, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/coinbase/reconcile") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "coinbase_advanced",
            platform_class: "coinbase_style_provider",
            execution_mode: body.execution_mode || "partner_omnibus",
            operation_class: "reconcile",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateCoinbaseReconcileRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid coinbase reconcile request",
            details: errors,
          });
        }
        return json(res, 200, coinbaseOrderReceipt({
          ...body,
          venue_id: "coinbase_advanced",
          platform_class: "coinbase_style_provider",
          execution_mode: body.execution_mode || "partner_omnibus",
          operation_class: "reconcile",
        }, "reconciled"));
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-perps/orders") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:submit",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: body.venue_id || "phoenix",
            platform_class: "solana_perps_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaPerpsOrderRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid solana perps private order request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        if (body.execution_mode === "ghola_pooled" && body.reconciliation) {
          const consumerReady = await consumerRuntime.ready();
          if (!consumerReady.ready) {
            return json(res, 503, { error: "consumer_reconciliation_unavailable", missing: consumerReady.missing || [] });
          }
          try {
            await consumerRuntime.prepareReconciliation({
              context: body.reconciliation,
              work_order_commitment: body.work_order_commitment,
            });
          } catch (error) {
            return json(res, 503, { error: error?.code || "consumer_reconciliation_prepare_failed" });
          }
        }
        const receipt = await executeSolanaPerpsOrder({ body, recipient, state });
        if (body.execution_mode === "ghola_pooled" && body.reconciliation) {
          const attempt = await state.getExecutionAttempt(body.work_order_commitment);
          const signature = attempt?.provider_ref_seed?.transaction_signature;
          try {
            await consumerRuntime.enqueueReconciliation({
              context: body.reconciliation,
              work_order_commitment: body.work_order_commitment,
              transaction_signature: signature,
            });
          } catch (error) {
            await consumerRuntime.halt(["reconciliation_stale"], "system:reconciliation_job_enqueue_failed");
            // The live transaction may already exist. Return the receipt so the web tier records
            // the submitted order and never releases its reservation after an ambiguous result.
            return json(res, 202, {
              ...receipt,
              reconciliation_status: "failed_review",
              reconciliation_error_code: error?.code || "consumer_reconciliation_enqueue_failed",
            });
          }
        }
        return json(res, 202, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-perps/verify") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        if (req.headers["x-ghola-no-submit-verify"] !== "true") {
          return json(res, 400, { error: "no-submit verification header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: body.venue_id || "phoenix",
            platform_class: "solana_perps_market",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaPerpsOrderRequest(body, recipient, { requirePlatformFeePolicy: false });
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid solana perps private verification request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await verifySolanaPerpsOrderNoSubmit({ body, recipient, state });
        return json(res, 200, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-perps/reconcile") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: body.venue_id || "phoenix",
            platform_class: "solana_perps_market",
            execution_mode: body.execution_mode || "user_stealth",
            operation_class: "reconcile",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaPerpsReconcileRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid solana perps reconcile request",
            details: errors,
          });
        }
        return json(res, 200, await reconcileStoredExecution({
          body: {
            ...body,
            venue_id: body.venue_id || "phoenix",
            platform_class: "solana_perps_market",
            execution_mode: body.execution_mode || "user_stealth",
            operation_class: "reconcile",
          },
          state,
          venue_id: body.venue_id || "phoenix",
          platform_class: "solana_perps_market",
        }));
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-swap/orders") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:submit",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "jupiter",
            platform_class: "solana_swap_aggregator",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaSwapOrderRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid jupiter private swap request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await executeJupiterSwapOrder({ body, recipient, state });
        return json(res, 202, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-swap/verify") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        if (req.headers["x-ghola-no-submit-verify"] !== "true") {
          return json(res, 400, { error: "no-submit verification header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "jupiter",
            platform_class: "solana_swap_aggregator",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaSwapOrderRequest(body, recipient, { requirePlatformFeePolicy: false });
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid jupiter private verification request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        const receipt = await verifyJupiterSwapNoSubmit({ body, recipient, state });
        return json(res, 200, receipt);
      }

      if (req.method === "POST" && url.pathname === "/venues/solana-swap/reconcile") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "jupiter",
            platform_class: "solana_swap_aggregator",
            execution_mode: body.execution_mode || "user_stealth",
            operation_class: "reconcile",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateSolanaSwapReconcileRequest(body, recipient);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid jupiter reconcile request",
            details: errors,
          });
        }
        return json(res, 200, await reconcileStoredExecution({
          body: {
            ...body,
            venue_id: "jupiter",
            platform_class: "solana_swap_aggregator",
            execution_mode: body.execution_mode || "user_stealth",
          },
          state,
          venue_id: "jupiter",
          platform_class: "solana_swap_aggregator",
        }));
      }

      if (req.method === "POST" && url.pathname === "/omnibus/allocations") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "session:create",
          state,
          expected: (body) => capabilityExpectedFromBody(body.omnibus_allocation || body, {
            operation_class: "omnibus_allocation",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        if (!isObject(body) || containsPlaintextLeakKey(body)) {
          return json(res, 400, {
            error: "invalid omnibus allocation request",
            details: ["request must contain only omnibus commitments"],
          });
        }
        const errors = validateOmnibusAllocation(body.omnibus_allocation || body);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid omnibus allocation request",
            details: errors,
          });
        }
        return json(res, 201, omnibusAllocationReceipt(body));
      }

      if (req.method === "POST" && url.pathname === "/omnibus/reconcile") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "reconcile:read",
          state,
          expected: (body) => capabilityExpectedFromBody(body.omnibus_allocation || body, {
            operation_class: "reconcile",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        if (!isObject(body) || containsPlaintextLeakKey(body)) {
          return json(res, 400, {
            error: "invalid omnibus reconcile request",
            details: ["request must contain only omnibus commitments"],
          });
        }
        return json(res, 200, omnibusAllocationReceipt(body, "reconciled"));
      }

      if (req.method === "POST" && url.pathname === "/venues/shielded-funding/attest") {
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }
        const authorized = await readAuthorizedJson(req, res, {
          path: url.pathname,
          scope: "order:verify",
          state,
          expected: (body) => capabilityExpectedFromBody(body, {
            venue_id: "shielded_funding",
            operation_class: "funding_attestation",
          }),
        });
        if (authorized.rejected) return;
        const { body } = authorized;
        const errors = validateShieldedFundingAttestRequest(body);
        if (errors.length > 0) {
          return json(res, 400, {
            error: "invalid shielded funding attestation request",
            details: errors,
          });
        }
        if (!ready.ready && !boolEnv("PRIVATE_AGENT_ALLOW_UNATTESTED_DEV")) {
          return json(res, 503, {
            error: "attested sealed execution is unavailable",
            missing: ready.missing,
          });
        }
        try {
          const signed = await attestFreshCredentialFunded({
            withdraw_bundle: body.withdraw_bundle,
            destination_commitment: body.destination_commitment,
            amount_bucket: body.amount_bucket,
            minConfirmations: Number.isInteger(body.min_confirmations)
              ? body.min_confirmations
              : undefined,
          });
          return json(res, 200, signed);
        } catch (err) {
          if (err instanceof FundingAttestationError) {
            return json(res, err.status, { error: err.message, code: err.code });
          }
          throw err;
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, error.status || 500, {
        error: error.message || "internal error",
        error_code: error.code || error.error_code || undefined,
      });
    }
  });
}

export async function resumeAutopilotLoops({ state, recipient, now = new Date() }) {
  const sessions = typeof state.listAutopilotSessions === "function"
    ? await state.listAutopilotSessions()
    : [];
  let resumed = 0;
  for (const session of sessions) {
    const shouldResume = (session?.status === "running" && session.execution_enabled === true) ||
      session?.status === "risk_halted";
    if (!shouldResume) continue;
    startAutopilotLoop({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
    });
    resumed += 1;
    await state.appendAutopilotEvent?.(session.autopilot_session_id, {
      version: 1,
      autopilot_session_id: session.autopilot_session_id,
      event_id: `autoevt_${createHash("sha256")
        .update(`${session.autopilot_session_id}:${now.toISOString()}:${randomUUID()}`)
        .digest("hex")
        .slice(0, 24)}`,
      type: "session_state",
      status: session.status,
      message: "Autopilot worker loop resumed after restart.",
      data: { reason: "worker_startup_resume" },
      created_at: now.toISOString(),
    });
  }
  return { resumed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(env("PORT", "8787"), 10);
  createPrivateAgentWorkerServer().listen(port, () => {
    console.log(`ghola-private-agent-worker listening on :${port}`);
  });
}
