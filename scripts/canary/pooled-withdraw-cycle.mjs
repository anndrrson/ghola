#!/usr/bin/env node
// Live-path canary for the pooled vault lifecycle: allocate from the Ghola
// balance, audit the pool ledger, withdraw, and prove the balance round-trips.
// Runs against a real deployment (no mocks). Read-only by default; the
// mutating allocate/withdraw cycle requires an explicit confirmation env.
//
// Required:
//   GHOLA_VERIFY_EMAIL / GHOLA_VERIFY_PASSWORD   session credentials
// Optional:
//   GHOLA_VERIFY_BASE_URL                        default https://ghola.xyz
//   GHOLA_VERIFY_POOLED_VENUE                    default phoenix
//   GHOLA_VERIFY_POOLED_AMOUNT_BUCKET            default 5 (USDC)
//   GHOLA_VERIFY_POOLED_CYCLE_CONFIRM            set to I_UNDERSTAND_THIS_MOVES_BALANCE
//                                                to run the mutating cycle
//   GHOLA_VERIFY_REPORT_PATH                     default .dev/ghola-pooled-withdraw-cycle.json

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = (process.env.GHOLA_VERIFY_BASE_URL || "https://ghola.xyz").replace(/\/+$/, "");
const email = required("GHOLA_VERIFY_EMAIL");
const password = required("GHOLA_VERIFY_PASSWORD");
const venue = process.env.GHOLA_VERIFY_POOLED_VENUE || "phoenix";
const amountBucket = process.env.GHOLA_VERIFY_POOLED_AMOUNT_BUCKET || "5";
const confirmed = process.env.GHOLA_VERIFY_POOLED_CYCLE_CONFIRM === "I_UNDERSTAND_THIS_MOVES_BALANCE";
const reportPath = resolve(ROOT, process.env.GHOLA_VERIFY_REPORT_PATH || ".dev/ghola-pooled-withdraw-cycle.json");

const cookies = new Map();
const report = {
  version: 1,
  base_url: baseUrl,
  venue,
  amount_bucket: amountBucket,
  mutating_cycle_requested: confirmed,
  started_at: new Date().toISOString(),
  completed_at: null,
  status: "running",
  checks: [],
};

try {
  await signIn();

  const balanceBefore = await getJson(`/v1/private-account/balance`);
  record("balance_read", typeof balanceBefore.balance?.available_micro_usdc === "number", {
    available_micro_usdc: balanceBefore.balance?.available_micro_usdc ?? null,
  });

  const auditBefore = await getJson(`/v1/private-account/venues/${venue}/pool/audit`);
  record("pool_audit_read", auditBefore.status !== undefined, {
    status: auditBefore.status,
    checks: auditBefore.checks,
    unbalanced_entry_count: auditBefore.unbalanced_entry_count,
  });
  if (auditBefore.status === "discrepancy") {
    throw new Error("pool audit reports a discrepancy; refusing to run the cycle");
  }

  if (!confirmed) {
    report.status = "read_only_ok";
    report.note = "Set GHOLA_VERIFY_POOLED_CYCLE_CONFIRM=I_UNDERSTAND_THIS_MOVES_BALANCE to run the allocate/withdraw cycle.";
  } else {
    const amountMicro = Number.parseInt(amountBucket, 10) * 1_000_000;
    if ((balanceBefore.balance?.available_micro_usdc ?? 0) < amountMicro) {
      throw new Error(`insufficient Ghola balance for a ${amountBucket} USDC cycle; fund the account first`);
    }

    const eligibility = await postJson(`/v1/private-account/venues/${venue}/eligibility`, {
      credential_type: "self_attested_eligible_user",
    });
    record("eligibility_verified", Boolean(eligibility.eligibility?.eligibility_commitment), {
      status: eligibility.eligibility?.status ?? eligibility.error ?? null,
    });

    const allocation = await postJson(`/v1/private-account/venues/${venue}/pool/allocate`, {
      utilization_bucket: amountBucket,
      fund_from_ghola_balance: true,
    });
    record("pool_allocated", Boolean(allocation.pool_position), {
      shares_micro: allocation.pool_position?.shares_micro ?? null,
      error: allocation.error ?? null,
    });
    if (!allocation.pool_position) throw new Error(`allocation failed: ${allocation.error}`);

    const withdrawal = await postJson(`/v1/private-account/venues/${venue}/pool/withdraw`, {
      redemption_percent_bucket: "100",
      client_redemption_id: `pooled_cycle_canary_${randomUUID()}`,
    });
    record("pool_withdrawn", withdrawal.pooled_redemption?.full_redemption === true, {
      redeemed_micro_usdc: withdrawal.pooled_redemption?.redeemed_micro_usdc ?? null,
      error: withdrawal.error ?? null,
    });
    if (!withdrawal.pooled_redemption) throw new Error(`withdrawal failed: ${withdrawal.error}`);

    const balanceAfter = await getJson(`/v1/private-account/balance`);
    const before = balanceBefore.balance?.available_micro_usdc ?? 0;
    const after = balanceAfter.balance?.available_micro_usdc ?? 0;
    // Floor rounding may strand at most 1 micro-USDC in the pool per cycle.
    record("balance_round_trip", after >= before - 1 && after <= before, {
      available_before_micro_usdc: before,
      available_after_micro_usdc: after,
    });

    const auditAfter = await getJson(`/v1/private-account/venues/${venue}/pool/audit`);
    record("pool_audit_balanced_after_cycle", auditAfter.status !== "discrepancy" &&
      auditAfter.checks?.double_entry_balanced === true, {
      status: auditAfter.status,
      unbalanced_entry_count: auditAfter.unbalanced_entry_count,
    });

    report.status = report.checks.every((check) => check.ok) ? "cycle_ok" : "cycle_failed";
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error?.message || error);
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "read_only_ok" && report.status !== "cycle_ok") process.exit(1);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function record(name, ok, detail = {}) {
  report.checks.push({ name, ok: Boolean(ok), ...detail });
}

async function signIn() {
  const res = await request("/api/auth/session/email/signin", {
    method: "POST",
    body: { email, password },
  });
  if (!res.ok) throw new Error(`signin failed with status ${res.status}`);
  const session = await getJson("/api/auth/session/me");
  record("auth_session", session.authenticated === true);
  if (session.authenticated !== true) throw new Error("session not authenticated after signin");
}

async function getJson(path) {
  const res = await request(path, { method: "GET" });
  return res.json().catch(() => ({}));
}

async function postJson(path, body) {
  const res = await request(path, { method: "POST", body });
  return res.json().catch(() => ({}));
}

async function request(path, { method, body }) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookies.size > 0) {
    headers.cookie = Array.from(cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const header of res.headers.getSetCookie?.() ?? []) {
    const [pair] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
}
