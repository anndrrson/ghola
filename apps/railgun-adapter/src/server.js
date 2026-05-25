import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, readiness } from "./config.js";
import { verifyRailgunPayment } from "./verify.js";

const MAX_BODY_BYTES = 128 * 1024;

function json(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    "cache-control": "no-store"
  });
  res.end(encoded);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function bearer(req) {
  const raw = req.headers.authorization || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

/// Constant-time bearer-token comparison (L2). `timingSafeEqual` requires
/// equal-length buffers; the auth token is high-entropy, so short-circuiting
/// on length leaks nothing useful while avoiding the early-exit timing leak of
/// `===`.
function tokensEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createRailgunAdapterServer(config = loadConfig()) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
        const state = readiness(config);
        return json(res, state.ready ? 200 : 503, {
          service: "ghola-railgun-adapter",
          ready: state.ready,
          configured: state.ready,
          missing: state.missing,
          provider: "railgun",
          rail: "railgun_evm_shielded",
          network: config.network,
          asset: config.asset,
          broadcaster_configured: config.broadcasterReady,
          proof_of_innocence_required: config.proofOfInnocenceRequired,
          proof_of_innocence_configured: config.proofOfInnocenceConfigured,
          fallback_allowed: false
        });
      }

      if (req.method === "POST" && req.url === "/verify") {
        if (!tokensEqual(bearer(req), config.authToken)) {
          return json(res, 401, { settled: false, error: "unauthorized" });
        }
        const body = await readJson(req);
        const result = await verifyRailgunPayment(config, body);
        return json(res, 200, result);
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, error.status || 500, {
        settled: false,
        error: error.message || "internal error"
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT || "8787", 10);
  createRailgunAdapterServer().listen(port, () => {
    console.log(`ghola-railgun-adapter listening on :${port}`);
  });
}
