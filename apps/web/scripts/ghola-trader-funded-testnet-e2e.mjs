#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIRMATION = "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_FUNDED_TESTNET_POSITION";

required("PRIVATE_AGENT_TEST_POSTGRES_URL");
required("GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS");
required("GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY");
if (process.env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM !== CONFIRMATION) {
  throw new Error(`GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM must equal ${CONFIRMATION}`);
}
if (!/^postgres(?:ql)?:\/\//.test(process.env.PRIVATE_AGENT_TEST_POSTGRES_URL || "")) {
  throw new Error("PRIVATE_AGENT_TEST_POSTGRES_URL must use Postgres");
}

const port = await freePort();
const webUrl = `http://localhost:${port}`;
const nextBin = path.join(WEB_ROOT, "node_modules/next/dist/bin/next");
const server = start(process.execPath, [nextBin, "dev", "-p", String(port)], WEB_ROOT, {
  GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED: "true",
  NEXT_PUBLIC_GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED: "true",
});
let browser;
let page;

try {
  await waitFor(`${webUrl}/trade/testnet-e2e`);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`);
  });

  await page.goto(`${webUrl}/trade/testnet-e2e`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Run funded testnet round trip" }).click();
  await page.getByRole("button", { name: /Confirm \$\d+ testnet round trip/ }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=funded-testnet-state]")?.textContent?.includes("flat"),
    null,
    { timeout: 120_000 },
  );
  await page.screenshot({ path: "/tmp/ghola-funded-testnet-roundtrip.png", fullPage: true });

  const body = await page.locator("body").innerText();
  const requiredProofs = [
    "Filled round trip verified",
    "filled · venue/fill proof",
    "duplicate prevented",
    "filled · reduce-only fill proof",
    "exact receipt replayed",
    "flat · 0 open orders",
  ];
  for (const proof of requiredProofs) {
    if (!body.includes(proof)) throw new Error(`browser_proof_missing:${proof}`);
  }
  if (consoleErrors.length || failedRequests.length) {
    throw new Error(`browser_errors:${JSON.stringify({ consoleErrors, failedRequests })}`);
  }
  if (!server.logs.includes('"event":"funded_testnet_round_trip_completed"')) {
    throw new Error("operator_event_missing:funded_testnet_round_trip_completed");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    path: "Browser -> Next confirmation -> Postgres claims -> Hyperliquid testnet entry fill -> reduce-only exit fill -> receipt replay -> flat",
    claim_store: "postgres",
    final_state: "flat",
    operator_event: "funded_testnet_round_trip_completed",
    screenshot: "/tmp/ghola-funded-testnet-roundtrip.png",
  }, null, 2)}\n`);
} catch (error) {
  await page?.screenshot({ path: "/tmp/ghola-funded-testnet-roundtrip-failed.png", fullPage: true }).catch(() => {});
  process.stderr.write(`\n--- Next logs ---\n${server.logs}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stop(server);
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const free = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return free;
}

function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  const append = (chunk) => { child.logs = `${child.logs}${chunk}`.slice(-20_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return;
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
