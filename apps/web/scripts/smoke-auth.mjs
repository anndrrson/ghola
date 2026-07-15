#!/usr/bin/env node

import process from "node:process";

const DEFAULT_BASE_URL = "https://ghola.xyz";
const TIMEOUT_MS = Number.parseInt(process.env.AUTH_SMOKE_TIMEOUT_MS || "15000", 10);

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function normalizeBaseUrl(value) {
  const base = value || DEFAULT_BASE_URL;
  try {
    const url = new URL(base);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid AUTH_SMOKE_BASE_URL: ${base}`);
  }
}

const baseUrl = normalizeBaseUrl(
  argValue("--base-url") ||
    process.env.AUTH_SMOKE_BASE_URL ||
    process.env.GHOLA_WEB_BASE_URL ||
    process.env.GHOLA_WEB_URL,
);
const canaryEmail = process.env.AUTH_SMOKE_EMAIL || "";
const canaryPassword = process.env.AUTH_SMOKE_PASSWORD || "";
const createProbe = process.env.AUTH_SMOKE_CREATE_PROBE === "1" || process.argv.includes("--create-probe");
const protectionBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";

function log(message) {
  console.log(`[auth-smoke] ${message}`);
}

function fail(message) {
  console.error(`[auth-smoke] ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = new URL(path, baseUrl);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(protectionBypass ? {
          "x-vercel-protection-bypass": protectionBypass,
          "x-vercel-set-bypass-cookie": "true",
        } : {}),
        ...(init.body ? { "content-type": "application/json", origin: baseUrl } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, text, json };
  } catch (error) {
    fail(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function requireStatus(name, status, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(status)) {
    fail(`${name} returned ${status}; expected ${allowed.join(" or ")}`);
  }
}

function sessionCookieFrom(res) {
  const getSetCookie = res.headers.getSetCookie?.bind(res.headers);
  const cookies = getSetCookie ? getSetCookie() : [res.headers.get("set-cookie") || ""];
  const combined = cookies.join("\n");
  const match = combined.match(/ghola_thumper_session=([^;\s]+)/);
  return match ? `ghola_thumper_session=${match[1]}` : "";
}

async function checkAnonymousSession() {
  const { res, json, text } = await request("/api/auth/session/me", {
    headers: { "cache-control": "no-store" },
  });
  requireStatus("GET /api/auth/session/me", res.status, 200);
  if (!json || typeof json.authenticated !== "boolean" || !("user" in json)) {
    fail(`/api/auth/session/me returned an invalid contract: ${text.slice(0, 240)}`);
  }
  log("/api/auth/session/me contract ok");
}

async function checkInvalidSigninDoesNot404() {
  const { res, text } = await request("/api/auth/session/email/signin", {
    method: "POST",
    body: JSON.stringify({
      email: `auth-smoke-${Date.now()}@example.invalid`,
      password: "not-a-real-password",
    }),
  });

  if (res.status === 404) {
    fail("/api/auth/session/email/signin returned 404; session auth route is broken");
  }
  if (res.status >= 500) {
    fail(`/api/auth/session/email/signin returned ${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status < 400) {
    fail("/api/auth/session/email/signin accepted invalid credentials");
  }
  log(`/api/auth/session/email/signin route ok (${res.status} for invalid credentials)`);
}

async function checkInvalidSignupDoesNot404() {
  const { res, text } = await request("/api/auth/session/email/signup", {
    method: "POST",
    body: JSON.stringify({}),
  });

  if (res.status === 404) {
    fail("/api/auth/session/email/signup returned 404; session auth route is broken");
  }
  if (res.status >= 500) {
    fail(`/api/auth/session/email/signup returned ${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status < 400) {
    fail("/api/auth/session/email/signup accepted an empty signup payload");
  }
  log(`/api/auth/session/email/signup route ok (${res.status} for invalid payload)`);
}

async function checkRealSignin() {
  const { res, json, text } = await request("/api/auth/session/email/signin", {
    method: "POST",
    body: JSON.stringify({
      email: canaryEmail,
      password: canaryPassword,
    }),
  });
  requireStatus("POST /api/auth/session/email/signin", res.status, 200);
  if (!json?.user?.email || json.user.email !== canaryEmail) {
    fail(`signin returned an invalid user contract: ${text.slice(0, 240)}`);
  }
  const cookie = sessionCookieFrom(res);
  if (!cookie) fail("signin did not set ghola_thumper_session");

  const session = await request("/api/auth/session/me", {
    headers: { cookie, "cache-control": "no-store" },
  });
  requireStatus("authenticated GET /api/auth/session/me", session.res.status, 200);
  if (!session.json?.authenticated || session.json?.user?.email !== canaryEmail) {
    fail(`authenticated session contract invalid: ${session.text.slice(0, 240)}`);
  }
  log("real canary signin and cookie session ok");
}

async function checkProbeSignup() {
  const email = `auth-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const { res, json, text } = await request("/api/auth/session/email/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: `Smoke-${Date.now()}-Strong!`,
      display_name: "Auth Smoke",
    }),
  });
  requireStatus("POST /api/auth/session/email/signup", res.status, 200);
  if (!json?.user?.email || json.user.email !== email) {
    fail(`signup returned an invalid user contract: ${text.slice(0, 240)}`);
  }
  const cookie = sessionCookieFrom(res);
  if (!cookie) fail("signup did not set ghola_thumper_session");
  log("probe signup and session cookie ok");
}

log(`checking ${baseUrl}`);
await checkAnonymousSession();
await checkInvalidSigninDoesNot404();
await checkInvalidSignupDoesNot404();

if (canaryEmail && canaryPassword) {
  await checkRealSignin();
} else if (createProbe) {
  await checkProbeSignup();
} else {
  log("set AUTH_SMOKE_EMAIL and AUTH_SMOKE_PASSWORD for full canary signin");
}

log("passed");
