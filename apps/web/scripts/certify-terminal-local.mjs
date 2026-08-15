#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const WORKER_ROOT = resolve(REPO_ROOT, "apps/private-agent-worker");
const BASE_URL = new URL(process.env.GHOLA_TERMINAL_CERT_BASE_URL || "http://localhost:3022");
const REPORT_PATH = resolve(REPO_ROOT, ".dev/ghola-terminal-local-certification.json");
const QUICK = process.argv.includes("--quick");

if (!["localhost", "127.0.0.1", "::1"].includes(BASE_URL.hostname)) {
  throw new Error("terminal certification refuses non-local application URLs");
}

const safeEnv = {
  ...process.env,
  GHOLA_CHART_CERT_BASE_URL: BASE_URL.origin,
  GHOLA_VERIFY_LIVE_SUBMIT: "false",
  GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "true",
  PRIVATE_AGENT_VENUE_DRY_RUN: "true",
};
const report = {
  version: 1,
  status: "running",
  mode: QUICK ? "quick" : "full",
  started_at: new Date().toISOString(),
  completed_at: null,
  base_url: BASE_URL.origin,
  cost_guard: {
    paid_runtime_calls: 0,
    funded_actions: 0,
    phala_contacted: false,
    render_contacted: false,
  },
  steps: [],
};

try {
  run("web_execution_and_recovery", WEB_ROOT, [
    resolve(WEB_ROOT, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/lib/terminal-live-market-context.test.ts",
    "src/lib/terminal-live-readiness.test.ts",
    "src/lib/live-trading-contract.test.ts",
    "src/lib/live-trading-authorization.server.test.ts",
    "src/lib/live-trading-worker-dispatch.server.test.ts",
    "src/app/v1/[...path]/route.test.ts",
    "src/lib/hyperliquid-market-data.test.ts",
    "src/lib/hyperliquid-order-precision.test.ts",
    "src/lib/trade-order-plan.test.ts",
    "src/lib/terminal-live-execution-journal.test.ts",
    "src/lib/terminal-live-execution-recovery.test.ts",
    "src/lib/terminal-live-account.test.ts",
    "src/lib/terminal-live-account-stream.test.ts",
  ]);
  run("worker_fault_and_reconciliation", WORKER_ROOT, [
    "--test",
    "test/hyperliquid-runner.test.js",
    "test/hyperliquid-account.test.js",
    "test/hyperliquid-mainnet-readiness.test.js",
    "test/hyperliquid-mainnet-roundtrip.test.js",
    "test/hyperliquid-reconciliation.test.js",
    "test/policy.test.js",
    "test/live-trading-readiness.test.js",
    "test/private-execution-claim.test.js",
  ]);
  run("typecheck", WEB_ROOT, [
    resolve(WEB_ROOT, "node_modules/typescript/bin/tsc"),
    "--noEmit",
  ]);
  run("direct_market_and_browser", WEB_ROOT, [
    resolve(WEB_ROOT, "scripts/certify-hyperliquid-charts.mjs"),
    ...(QUICK ? ["--browser-only"] : []),
  ]);

  const chartReport = JSON.parse(readFileSync(resolve(REPO_ROOT, ".dev/ghola-chart-certification.json"), "utf8"));
  if (
    chartReport.status !== "certified" ||
    chartReport.cost_guard?.paid_runtime_calls !== 0 ||
    chartReport.cost_guard?.funded_actions !== 0 ||
    chartReport.cost_guard?.phala_contacted !== false ||
    chartReport.cost_guard?.render_contacted !== false
  ) {
    throw new Error("chart certification did not preserve the zero-cost safety guard");
  }
  report.chart_certificate = {
    status: chartReport.status,
    completed_at: chartReport.completed_at,
    checks: chartReport.checks?.length || 0,
    browser_ok: chartReport.browser?.ok === true,
  };
  report.status = "certified";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[certify-terminal] ${report.status} · report=${REPORT_PATH}\n`);
}

function run(name, cwd, args) {
  const startedAt = Date.now();
  process.stdout.write(`[certify-terminal] ${name}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: safeEnv,
    stdio: "inherit",
  });
  const step = {
    name,
    ok: result.status === 0,
    exit_code: result.status,
    duration_ms: Date.now() - startedAt,
  };
  report.steps.push(step);
  if (!step.ok) throw new Error(`${name} failed`);
}
