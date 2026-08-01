#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const baseUrl = trimUrl(env("GHOLA_VERIFY_BASE_URL", "https://ghola.xyz"));
const email = env("GHOLA_VERIFY_EMAIL");
const password = env("GHOLA_VERIFY_PASSWORD");
const requireReady = boolEnv("GHOLA_VERIFY_REQUIRE_COINBASE_PUBLIC_LIVE", true);
const requirePrepare = boolEnv("GHOLA_VERIFY_REQUIRE_COINBASE_PREPARE", false);
const reportPath = resolve(REPO_ROOT, env("GHOLA_VERIFY_REPORT_PATH", ".dev/ghola-prod-coinbase-public-live-verify.json"));

const cookies = new Map();
const report = {
  version: 1,
  base_url: baseUrl,
  started_at: new Date().toISOString(),
  completed_at: null,
  status: "running",
  checks: [],
  live_trading_status: null,
  market: null,
  prepare: null,
  note: "No live order is sent. This verifies the Coinbase public-live launch path, worker readiness surface, market data, auth, and prepare route.",
};

try {
  await checkPage("trade_page", "/trade");
  const market = await requestJson("/v1/private-account/coinbase/market-snapshot?product_id=SOL-USD&interval=1m", { method: "GET" });
  report.market = summarizeMarket(market);
  record("coinbase_market_data", market.ok && Boolean(market.body?.product_id), report.market);
  assertSafeArtifact("coinbase_market", market.body);

  const status = await requestJson("/v1/private-account/live-trading/status", { method: "GET" });
  report.live_trading_status = summarizeLiveStatus(status);
  const coinbaseReady = status.ok &&
    status.body?.no_key_primary_venue === "coinbase" &&
    status.body?.coinbase_public_live_ready === true &&
    status.body?.no_key_live_trading_enabled === true;
  record("coinbase_public_live_status", requireReady ? coinbaseReady : status.ok, report.live_trading_status);
  assertSafeArtifact("live_trading_status", status.body);
  if (requireReady && !coinbaseReady) {
    throw new Error("Coinbase public-live status is not ready.");
  }

  if (!email || !password) {
    record("auth_credentials_pending", !requirePrepare, {
      next_step: "Set GHOLA_VERIFY_EMAIL and GHOLA_VERIFY_PASSWORD to run signed-in Coinbase public-live prepare.",
    });
    if (requirePrepare) throw new Error("GHOLA_VERIFY_EMAIL and GHOLA_VERIFY_PASSWORD are required for prepare verification.");
  } else {
    await postJson("/api/auth/session/email/signin", { email, password }, { sameOrigin: true });
    const session = await requestJson("/api/auth/session/me", { method: "GET" });
    record("auth_session", session.ok && session.body?.authenticated === true, {
      authenticated: session.body?.authenticated === true,
      user_id_present: Boolean(session.body?.user?.id),
    });
    assertSafeArtifact("auth_session", session.body);

    const prepare = await requestJson("/v1/private-account/public-live/coinbase/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accepted_terms: true,
        accepted_risk: true,
        not_prohibited_person: true,
        jurisdiction_assertion: "self_attested_eligible_us",
        country_code: "US",
        utilization_bucket: "5",
      }),
    }, { allowError: true });
    report.prepare = summarizePrepare(prepare);
    const prepareAccepted = prepare.ok ||
      prepare.body?.error === "ghola_balance_insufficient" ||
      Array.isArray(prepare.body?.blocking_reason_codes);
    record("coinbase_public_live_prepare", prepareAccepted, report.prepare);
    assertSafeArtifact("coinbase_prepare", prepare.body);
  }

  report.status = report.checks.every((check) => check.ok) ? "verified_coinbase_public_live" : "failed";
} catch (error) {
  report.status = "failed";
  record("fatal", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[verify-prod-coinbase-public-live] ${report.status}`);
  console.log(`[verify-prod-coinbase-public-live] report=${reportPath}`);
  for (const check of report.checks) {
    console.log(`[verify-prod-coinbase-public-live] ${check.ok ? "ok" : "fail"} ${check.name}`);
  }
  if (report.status === "failed") process.exit(1);
}

async function checkPage(name, path) {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET", redirect: "manual" });
  record(name, response.status >= 200 && response.status < 400, { status: response.status });
}

async function postJson(path, body, options = {}) {
  const result = await requestJson(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.sameOrigin ? { origin: baseUrl } : {}),
    },
    body: JSON.stringify(body),
  });
  return result.body;
}

async function requestJson(path, init, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      cookie: cookieHeader(),
      ...(init.headers || {}),
    },
  });
  captureCookies(response);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok && !options.allowError) {
    throw new Error(`${path} returned ${response.status}: ${body.error || text.slice(0, 200)}`);
  }
  return { ok: response.ok, status: response.status, body };
}

function summarizeMarket(result) {
  if (!result.ok) return { status: result.status, error: result.body?.error || null };
  return {
    status: result.status,
    product_id: result.body?.product_id || null,
    source: result.body?.source || null,
    stale: result.body?.stale ?? null,
    fetched_at: result.body?.fetched_at || null,
    candle_count: Array.isArray(result.body?.candles) ? result.body.candles.length : 0,
  };
}

function summarizeLiveStatus(result) {
  if (!result.ok) return { status: result.status, error: result.body?.error || null };
  return {
    status: result.status,
    live_trading_enabled: result.body?.live_trading_enabled === true,
    live_submit_mode: result.body?.live_submit_mode || null,
    no_key_primary_venue: result.body?.no_key_primary_venue || null,
    no_key_live_trading_enabled: result.body?.no_key_live_trading_enabled === true,
    coinbase_public_live_ready: result.body?.coinbase_public_live_ready === true,
    no_key_blocking_reason_codes: result.body?.no_key_blocking_reason_codes || [],
    pooled_live_venues: result.body?.pooled_live_venues || [],
    pooled_worker_readiness: result.body?.pooled_worker_readiness || null,
  };
}

function summarizePrepare(result) {
  if (!result.ok) {
    return {
      status: result.status,
      error: result.body?.error || null,
      blocking_reason_codes: result.body?.blocking_reason_codes || [],
      required_margin_micro_usdc: result.body?.required_margin_micro_usdc ?? null,
    };
  }
  return {
    status: result.status,
    body_status: result.body?.status || null,
    venue_id: result.body?.venue_id || null,
    execution_mode: result.body?.execution_mode || null,
    can_submit_live: result.body?.can_submit_live === true,
    blocking_reason_codes: result.body?.blocking_reason_codes || [],
    required_margin_micro_usdc: result.body?.required_margin_micro_usdc ?? null,
    account_commitment_present: Boolean(result.body?.account_commitment),
    allocation_commitment_present: Boolean(result.body?.allocation?.allocation?.allocation_commitment),
    policy_commitment_present: Boolean(result.body?.agent?.session_policy?.policy_commitment),
  };
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok: Boolean(ok), details });
}

function captureCookies(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return;
  for (const raw of splitSetCookie(setCookie)) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value) cookies.set(key, value);
    else cookies.delete(key);
  }
}

function cookieHeader() {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function splitSetCookie(value) {
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function assertSafeArtifact(name, value) {
  const forbidden = [
    "api_private_key",
    "api_private_key_pem",
    "coinbase_private_key",
    "private_key",
    "raw_private_key",
    "signing_key",
  ].find((term) => objectHasForbiddenKey(value, term));
  if (forbidden) throw new Error(`${name} leaked forbidden field ${forbidden}`);
}

function objectHasForbiddenKey(value, forbidden) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => objectHasForbiddenKey(item, forbidden));
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase() === forbidden || objectHasForbiddenKey(nested, forbidden)
  );
}

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value === "true" || value === "1";
}

function trimUrl(value) {
  return value.replace(/\/+$/, "");
}
