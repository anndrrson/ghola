#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const baseUrl = trimUrl(env("GHOLA_VERIFY_BASE_URL", "https://ghola.xyz"));
const email = env("GHOLA_VERIFY_EMAIL");
const password = env("GHOLA_VERIFY_PASSWORD");
const requireAuth = boolEnv("GHOLA_VERIFY_LIVE_ALL_REQUIRE_AUTH");
const requirePublicLive = boolEnv("GHOLA_VERIFY_REQUIRE_PUBLIC_LIVE");
const reportPath = resolve(REPO_ROOT, env("GHOLA_VERIFY_REPORT_PATH", ".dev/ghola-live-all-verify.json"));

const cookies = new Map();
const report = {
  version: 1,
  base_url: baseUrl,
  started_at: new Date().toISOString(),
  completed_at: null,
  status: "running",
  checks: [],
  venues: {},
  note: "No live order is sent. This verifies routes, auth when configured, readiness surfaces, and no-submit blockers/artifacts across all user-facing LIVE venues.",
};

const VENUES = [
  {
    id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    page: "/app/account?flow=hyperliquid-live",
    market: "/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=1m",
  },
  {
    id: "phoenix",
    platform_class: "solana_perps_market",
    page: "/app/account?flow=phoenix-live",
    market: "/v1/private-account/phoenix/market-snapshot?market=SOL&interval=1m",
  },
  {
    id: "jupiter",
    platform_class: "solana_swap_aggregator",
    page: "/app/account?flow=jupiter-live",
    market: null,
  },
  {
    id: "coinbase",
    platform_class: "coinbase_style_provider",
    page: "/app/account?flow=coinbase",
    market: "/v1/private-account/coinbase/market-snapshot?product_id=BTC-USD&interval=1m",
  },
];

try {
  await checkHead("landing", "/");
  await checkHead("trade_terminal", "/app/account?flow=trade");
  const liveTradingGate = await safeGetJson("/v1/private-account/live-trading/status");
  report.live_trading_gate = summarizeLiveTradingGate(liveTradingGate);
  record(
    "live_trading_launch_gate",
    liveTradingGate.ok && (!requirePublicLive || liveTradingGate.body?.live_trading_enabled === true),
    report.live_trading_gate,
  );
  record(
    "pooled_worker_readiness",
    liveTradingGate.ok &&
      (
        liveTradingGate.body?.pooled_live_trading_enabled !== true ||
        liveTradingGate.body?.pooled_worker_readiness?.ready === true
      ),
    liveTradingGate.body?.pooled_worker_readiness || { status: "not_reported" },
  );
  if (requirePublicLive && liveTradingGate.body?.live_trading_enabled !== true) {
    throw new Error("Public live trading gate is not green.");
  }

  for (const venue of VENUES) {
    report.venues[venue.id] = {};
    await checkHead(`${venue.id}_page`, venue.page);
    if (venue.market) {
      const market = await safeGetJson(venue.market);
      report.venues[venue.id].market = summarizeMarket(market);
      record(`${venue.id}_market_surface`, market.ok, report.venues[venue.id].market);
      if (market.ok) assertSafeArtifact(`${venue.id}_market`, market.body);
    } else {
      record(`${venue.id}_market_surface`, true, { status: "not_applicable" });
    }
  }

  if (!email || !password) {
    if (requireAuth) {
      record("auth_credentials_supplied", false, {
        next_step: "Set GHOLA_VERIFY_EMAIL and GHOLA_VERIFY_PASSWORD to run signed-in no-submit readiness probes.",
      });
      throw new Error("GHOLA_VERIFY_EMAIL and GHOLA_VERIFY_PASSWORD are required.");
    }
    record("auth_credentials_pending", true, {
      next_step: "Set GHOLA_VERIFY_EMAIL and GHOLA_VERIFY_PASSWORD to run signed-in no-submit readiness probes.",
    });
    report.status = "routes_ready_credentials_required";
  } else {
    await postJson("/api/auth/session/email/signin", { email, password }, { sameOrigin: true });
    const session = await getJson("/api/auth/session/me");
    record("auth_session", session.authenticated === true, {
      authenticated: session.authenticated === true,
      user_id_present: Boolean(session.user?.id),
    });
    assertSafeArtifact("auth_session", session);

    for (const venue of VENUES) {
      const readiness = await postJson("/v1/private-account/connectors/readiness", {
        platform_class: venue.platform_class,
      });
      report.venues[venue.id].readiness = summarizeReadiness(readiness);
      record(`${venue.id}_readiness_surface`, Array.isArray(readiness.readiness), report.venues[venue.id].readiness);
      assertSafeArtifact(`${venue.id}_readiness`, readiness);

      const access = await safeGetJson(accessPathForVenue(venue));
      report.venues[venue.id].access = summarizeAccess(access);
      record(`${venue.id}_access_surface`, access.ok, report.venues[venue.id].access);
      if (access.ok) assertSafeArtifact(`${venue.id}_access`, access.body);

      const noSubmit = await postNoSubmitProbe(venue);
      report.venues[venue.id].no_submit = summarizeNoSubmit(noSubmit);
      record(`${venue.id}_no_submit_or_blocker`, noSubmit.ok || Boolean(noSubmit.body?.error), report.venues[venue.id].no_submit);
      assertSafeArtifact(`${venue.id}_no_submit`, noSubmit.body);
    }

    report.status = report.checks.every((check) => check.ok) ? "verified_all_live_readiness" : "failed";
  }
} catch (error) {
  report.status = "failed";
  record("fatal", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[verify-live-all] ${report.status}`);
  console.log(`[verify-live-all] report=${reportPath}`);
  for (const check of report.checks) {
    console.log(`[verify-live-all] ${check.ok ? "ok" : "fail"} ${check.name}`);
  }
  if (report.status === "failed") process.exit(1);
}

async function postNoSubmitProbe(venue) {
  return requestJson("/v1/private-account/connectors/verify-no-submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform_class: venue.platform_class,
      work_order_commitment: `connector_work_order_${venue.id}_readiness_probe`,
      encrypted_execution_instruction_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: `sealed-${venue.id}-readiness-probe`,
        recipient: "probe:commitment-only",
        aad: [
          "ghola/private-execution-instruction-v1",
          `work_order:connector_work_order_${venue.id}_readiness_probe`,
          `venue:${venue.id === "coinbase" ? "coinbase_advanced" : venue.id}`,
          "recipient:probe:commitment-only",
        ].join("|"),
      },
    }),
  }, { allowError: true });
}

async function checkHead(name, path) {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET", redirect: "manual" });
  record(name, response.status >= 200 && response.status < 400, { status: response.status });
}

async function safeGetJson(path) {
  return requestJson(path, { method: "GET" }, { allowError: true });
}

async function getJson(path) {
  const result = await requestJson(path, { method: "GET" });
  return result.body;
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

function accessPathForVenue(venue) {
  if (venue.id === "hyperliquid") return "/v1/private-account/hyperliquid/vault";
  if (venue.id === "coinbase") return "/v1/private-account/venues/coinbase_style_provider/vault";
  return `/v1/private-account/venues/${venue.platform_class}/vault`;
}

function summarizeMarket(result) {
  if (!result.ok) return { status: result.status, error: result.body?.error || null };
  return {
    status: result.status,
    stale: result.body?.stale ?? null,
    fetched_at: result.body?.fetched_at || null,
    source: result.body?.source || null,
  };
}

function summarizeReadiness(body) {
  const first = body.readiness?.[0] || null;
  return {
    count: Array.isArray(body.readiness) ? body.readiness.length : 0,
    status: first?.status || null,
    live_submit_enabled: first?.live_submit_enabled ?? null,
    reason_codes: first?.reason_codes || [],
    readiness_commitment: first?.readiness_commitment || null,
  };
}

function summarizeAccess(result) {
  if (!result.ok) return { status: result.status, error: result.body?.error || null };
  return {
    status: result.status,
    ready: result.body?.ready ?? null,
    execution_mode: result.body?.execution_mode || result.body?.managed_allocation?.execution_mode || null,
    account_commitment_present: Boolean(result.body?.account_commitment),
  };
}

function summarizeLiveTradingGate(result) {
  if (!result.ok) return { status: result.status, error: result.body?.error || null };
  return {
    status: result.status,
    live_trading_enabled: result.body?.live_trading_enabled === true,
    live_submit_mode: result.body?.live_submit_mode || null,
    byo_live_trading_enabled: result.body?.byo_live_trading_enabled === true,
    pooled_live_trading_enabled: result.body?.pooled_live_trading_enabled === true,
    pooled_worker_readiness: result.body?.pooled_worker_readiness || null,
    public_live_copy_allowed: result.body?.public_live_copy_allowed === true,
    default_access_mode: result.body?.default_access_mode || null,
    byo_live_venues: Array.isArray(result.body?.byo_live_venues)
      ? result.body.byo_live_venues.map((venue) => ({
          id: venue.id,
          status: venue.status,
          reason_codes: venue.reason_codes || [],
        }))
      : [],
    required_venues: Array.isArray(result.body?.required_venues)
      ? result.body.required_venues.map((venue) => ({
          id: venue.id,
          status: venue.status,
          canary_status: venue.canary_status,
          canary_report: venue.canary_report ? {
            report_id: venue.canary_report.report_id || null,
            network: venue.canary_report.network || null,
            observed_at: venue.canary_report.observed_at || null,
            expires_at: venue.canary_report.expires_at || null,
            evidence_commitment: venue.canary_report.evidence_commitment || null,
          } : null,
          reason_codes: venue.reason_codes || [],
        }))
      : [],
    pooled_reason_codes: result.body?.pooled_reason_codes || [],
    reason_codes: result.body?.reason_codes || [],
    gate_commitment: result.body?.gate_commitment || null,
  };
}

function summarizeNoSubmit(result) {
  const verification = result.body?.verification || {};
  return {
    status: result.status,
    ok: result.ok,
    error: result.body?.error || null,
    verification_status: verification.status || null,
    blocker: verification.reason || result.body?.error || null,
    certificate_status: verification.live_readiness_certificate?.status || null,
    certificate_commitment: verification.live_readiness_certificate?.certificate_commitment || null,
    broadcast_performed: verification.live_readiness_certificate?.broadcast_performed ?? false,
  };
}

function assertSafeArtifact(name, value) {
  const text = JSON.stringify(value).toLowerCase();
  const forbidden = [
    "api_wallet_private_key",
    "authority_private_key",
    "coinbase_private_key",
    "raw_private_key",
    "hyperliquid_account_address",
    "wallet_private_key",
    "provider_payload",
    "raw_order",
    "endpoint_secret",
    "credential",
  ];
  const hit = forbidden.find((field) => text.includes(field));
  if (hit) throw new Error(`${name} exposed forbidden public field: ${hit}`);
}

function captureCookies(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of setCookies) {
    const first = String(value).split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
  }
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, details });
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boolEnv(name) {
  return env(name) === "true";
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}
