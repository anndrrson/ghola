#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const WORKER_ROOT = path.join(REPO_ROOT, "apps/private-agent-worker");
const workerModules = path.join(WORKER_ROOT, "node_modules");
const stateStore = process.env.GHOLA_TRADER_E2E_STATE_STORE === "postgres" ? "postgres" : "sqlite";
const postgresUrl = process.env.PRIVATE_AGENT_TEST_POSTGRES_URL || process.env.PRIVATE_AGENT_STATE_POSTGRES_URL || "";
if (stateStore === "postgres" && !postgresUrl) {
  throw new Error("PRIVATE_AGENT_TEST_POSTGRES_URL is required for the Postgres staging smoke");
}
const temp = await mkdtemp(path.join(tmpdir(), "ghola-trader-e2e."));
const children = [];
let createdModulesLink = false;
let browser;
let page;

try {
  const existingModules = await lstat(workerModules).catch(() => null);
  if (!existingModules) {
    await symlink("../web/node_modules", workerModules, "dir");
    createdModulesLink = true;
  }

  const [workerPort, webPort] = await Promise.all([freePort(), freePort()]);
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const webUrl = `http://localhost:${webPort}`;
  const worker = start(process.execPath, ["src/server.js"], WORKER_ROOT, {
    PORT: String(workerPort),
    PRIVATE_AGENT_DATA_DIR: temp,
    PRIVATE_AGENT_STATE_STORE: stateStore,
    PRIVATE_AGENT_STATE_SQLITE_PATH: path.join(temp, "state.sqlite"),
    PRIVATE_AGENT_STATE_POSTGRES_URL: postgresUrl,
    PRIVATE_AGENT_POSTGRES_DRIVER: stateStore === "postgres" ? "pg" : "auto",
    PRIVATE_AGENT_EXECUTION_TOKEN: "local-e2e-token",
    PRIVATE_AGENT_ALLOW_UNATTESTED_DEV: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "true",
    PRIVATE_AGENT_AUTOPILOT_ASSUME_FUNDED: "true",
    PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE: "force",
    PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE: "101",
    PRIVATE_AGENT_AUTOPILOT_INITIAL_DELAY_MS: "250",
    PRIVATE_AGENT_AUTOPILOT_TICK_MS: "1000",
    PRIVATE_AGENT_CONSUMER_RUNTIME_ENABLED: "false",
  });
  children.push(worker);
  await waitFor(`${workerUrl}/ready`, true);

  children.push(start(process.execPath, [path.join(WEB_ROOT, "node_modules/next/dist/bin/next"), "dev", "-p", String(webPort)], WEB_ROOT, {
    GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS: "true",
    GHOLA_PRIVATE_AGENT_LOCAL_E2E_ENABLED: "true",
    GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN: "true",
    GHOLA_PRIVATE_AGENT_LOCAL_E2E_CLAIM_STORE: stateStore,
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: workerUrl,
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "local-e2e-token",
    GHOLA_PRIVATE_AGENT_ALLOW_UNATTESTED_DEV: "true",
    GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "false",
    GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "false",
    GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
    GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED: "false",
    GHOLA_PUBLIC_AGENT_WAKE_ENABLED: "false",
  }));
  await waitFor(`${webUrl}/trade/local-e2e`);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`);
  });
  await page.goto(`${webUrl}/trade/local-e2e`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Arm and prove" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=e2e-state]")?.textContent === "executed", null, { timeout: 15_000 });
  await page.waitForTimeout(6_000);
  const localText = await page.getByText(/^Local session:/).textContent();
  const localSessionId = localText?.replace(/^Local session:\s*/, "") || "";
  const healthResponse = await page.request.get(`${webUrl}/v1/private-account/autopilot/sessions/${encodeURIComponent(localSessionId)}`, {
    headers: { authorization: "Bearer ghola-local-e2e" },
  });
  const health = await healthResponse.json();
  if (health.session?.status !== "running" || health.session?.risk_summary?.complete !== true) {
    throw new Error(`post_expiry_risk_check_failed:${JSON.stringify(health.session?.risk_summary || null)}`);
  }
  const receipt = (await page.getByText(/^Receipt:/).textContent())?.replace(/^Receipt:\s*/, "") || "";
  const requiredOperatorEvents = ["execution_claim_acquired", "execution_claim_completed"];
  const observedOperatorEvents = operatorEvents(worker.logs);
  for (const required of requiredOperatorEvents) {
    if (!observedOperatorEvents.includes(required)) {
      throw new Error(`operator_event_missing:${required}:${worker.logs}`);
    }
  }
  await page.screenshot({ path: "/tmp/ghola-trader-e2e-executed.png", fullPage: true });
  await page.getByRole("button", { name: "Kill and require ACK" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=e2e-state]")?.textContent === "killed", null, { timeout: 15_000 });
  await page.screenshot({ path: "/tmp/ghola-trader-e2e-killed.png", fullPage: true });
  if (consoleErrors.length || failedRequests.length) {
    throw new Error(`browser_errors:${JSON.stringify({ consoleErrors, failedRequests })}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    path: `UI -> Next guard -> worker -> ${stateStore === "postgres" ? "Postgres" : "SQLite"} claim -> Hyperliquid dry-run -> receipt -> kill ACK`,
    claim_store: stateStore,
    operator_events: requiredOperatorEvents,
    local_session_id: localSessionId,
    receipt,
    risk_complete_after_expiry: true,
    final_state: "killed",
    screenshots: ["/tmp/ghola-trader-e2e-executed.png", "/tmp/ghola-trader-e2e-killed.png"],
  }, null, 2)}\n`);
} catch (error) {
  await page?.screenshot({ path: "/tmp/ghola-trader-e2e-failed.png", fullPage: true }).catch(() => {});
  for (const [index, child] of children.entries()) {
    process.stderr.write(`\n--- child ${index + 1} logs ---\n${child.logs}\n`);
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await Promise.all(children.map(stop));
  if (createdModulesLink) await rm(workerModules, { force: true });
  await rm(temp, { recursive: true, force: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.logs = "";
  child.stdout.on("data", (chunk) => { child.logs = `${child.logs}${chunk}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { child.logs = `${child.logs}${chunk}`.slice(-8_000); });
  return child;
}

function operatorEvents(logs) {
  return logs
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line)?.event || null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function waitFor(url, acceptFailure = false) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    if (response && (acceptFailure || response.ok)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service_start_timeout:${url}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
