import { createHash, generateKeyPairSync, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY_BYTES = 256 * 1024;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const PLAINTEXT_LEAK_KEYS = new Set([
  "messages",
  "plaintext",
  "policy",
  "prompt",
  "source",
  "strategy",
  "strategy_text",
  "system_prompt",
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

export function recipientReportDataHex(recipient) {
  return `0x${sha256Hex(
    `${RECIPIENT_REPORT_DOMAIN}\0${recipient.recipient_id}\0${recipient.x25519_pub_hex}`,
  )}`;
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
      created_at: null,
    };
  }
  return generatedRecipient();
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
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

async function loadDstackAttestation(recipient) {
  const reportDataHex = recipientReportDataHex(recipient);
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

async function attestationMetadata(recipient) {
  const dynamic = boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE")
    ? await loadDstackAttestation(recipient)
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
    report_data_hex: dynamic?.report_data_hex ?? recipientReportDataHex(recipient),
  };
}

async function publicRecipient(recipient) {
  const attestation = await attestationMetadata(recipient);
  return {
    recipient_id: recipient.recipient_id,
    x25519_pub_hex: recipient.x25519_pub_hex,
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

async function readiness(recipient) {
  const attestation = await attestationMetadata(recipient);
  const missing = [];
  if (!recipient?.recipient_id || !PUBLIC_KEY_HEX_RE.test(recipient.x25519_pub_hex || "")) {
    missing.push("recipient_key");
  }
  const attestedReady =
    boolEnv("PRIVATE_AGENT_ATTESTED_READY") ||
    (boolEnv("PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE") &&
      Boolean(attestation.attestation_hash));
  if (!attestedReady) missing.push("attestation");
  if (!env("PHALA_CVM_IMAGE_DIGEST", env("PRIVATE_AGENT_IMAGE_DIGEST"))) missing.push("image_digest");
  if (!attestation.measurement_hex) {
    missing.push("measurement");
  }
  if (!attestation.attestation_hash) {
    missing.push("attestation_hash");
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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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

export function createPrivateAgentWorkerServer(options = {}) {
  const recipient = options.recipient || loadRecipient();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const ready = await readiness(recipient);

      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
        return json(res, ready.ready ? 200 : 503, {
          service: "ghola-private-agent-worker",
          ready: ready.ready,
          attested: boolEnv("PRIVATE_AGENT_ATTESTED_READY"),
          sealed_execution_required: true,
          plaintext_rejected: true,
          provider: env("PRIVATE_AGENT_PROVIDER_ID", "phala"),
          tee_kind: env("PRIVATE_AGENT_TEE_KIND", "phala"),
          missing: ready.missing,
        });
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

      if (req.method === "POST" && url.pathname === "/private-agent/sessions") {
        // Fail closed: a missing execution token throws a 503 (handled by the
        // outer catch) rather than allowing unauthenticated sealed execution.
        const token = requiredAuthToken();
        if (!tokensEqual(bearer(req), token)) {
          return json(res, 401, { error: "unauthorized" });
        }
        if (req.headers["x-ghola-sealed-execution-required"] !== "true") {
          return json(res, 400, { error: "sealed execution header is required" });
        }

        const body = await readJson(req);
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

        const receipt = buildReceipt(body);
        appendSessionAudit(body, receipt);
        return json(res, 201, receipt);
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, error.status || 500, {
        error: error.message || "internal error",
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(env("PORT", "8787"), 10);
  createPrivateAgentWorkerServer().listen(port, () => {
    console.log(`ghola-private-agent-worker listening on :${port}`);
  });
}
