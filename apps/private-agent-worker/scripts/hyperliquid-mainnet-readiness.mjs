#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPostgresWorkerState } from "../src/state/private-state.js";
import {
  hyperliquidCredentialFromVault,
  readHyperliquidAccountSnapshot,
  verifyHyperliquidNoSubmit,
} from "../src/venues/hyperliquid.js";
import { buildHyperliquidMainnetProtection } from "../src/execution/hyperliquid-mainnet-protection.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const REPORT_PATH = resolve(REPO_ROOT, ".dev/hyperliquid-mainnet-readiness.json");

export function mainnetReadinessConfig(env = process.env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN !== "false") {
    throw new Error("PRIVATE_AGENT_VENUE_DRY_RUN must be false");
  }
  if (env.PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS === "true") {
    throw new Error("simulated Hyperliquid no-submit checks must be disabled");
  }
  if (env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") {
    throw new Error("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET must be true");
  }
  if (env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "full_ticket") {
    throw new Error("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE must be full_ticket");
  }
  const accountAddress = required(env, "GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS").toLowerCase();
  const privateKey = required(env, "GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY").toLowerCase();
  const databaseUrl = requiredEither(env, [
    "PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL",
    "PRIVATE_AGENT_STATE_POSTGRES_URL",
  ]);
  if (!/^0x[0-9a-f]{40}$/.test(accountAddress)) throw new Error("mainnet account address is invalid");
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) throw new Error("mainnet API wallet key is invalid");
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("mainnet readiness requires Postgres");
  return { accountAddress, privateKey, databaseUrl };
}

export async function certifyHyperliquidMainnetReadiness({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = mainnetReadinessConfig(env);
  usePinnedLocalPython(env);
  const credential = hyperliquidCredentialFromVault({
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: "mainnet",
    hyperliquid_account_address: config.accountAddress,
    api_wallet_private_key: config.privateKey,
  });
  const checkedAt = new Date();
  const workOrder = `hl_mainnet_readiness_${sha256(`${config.accountAddress}:${checkedAt.toISOString()}`).slice(0, 32)}`;
  const cloid = `0x${sha256(workOrder).slice(0, 32)}`;
  const exitCloid = `0x${sha256(`${workOrder}:reduce-only-exit`).slice(0, 32)}`;
  const protectionPlan = await buildHyperliquidMainnetProtection({
    fetchImpl,
    baseUrl: credential.base_url,
    market: "HYPE",
  });
  const instruction = {
    version: 1,
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: {
      market: "HYPE",
      side: "buy",
      quote_size: "11",
      size_mode: "quote",
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: false,
      max_slippage_bps: "100",
      live_order_mode: "tiny_fill",
      margin_mode: "isolated",
      leverage: 1,
    },
    expires_at: new Date(checkedAt.getTime() + 30_000).toISOString(),
    position_protection: protectionPlan.position_protection,
  };
  const exitInstruction = {
    version: 1,
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: {
      market: "HYPE",
      side: "sell",
      base_size: "0.01",
      size_mode: "base",
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: true,
      max_slippage_bps: "100",
      live_order_mode: "tiny_fill",
      margin_mode: "isolated",
      leverage: 1,
    },
    expires_at: new Date(checkedAt.getTime() + 30_000).toISOString(),
  };
  const [account, exactState] = await Promise.all([
    readHyperliquidAccountSnapshot({ credential, accountSource: "sealed_byo", fetchImpl }),
    exactHypeState(fetchImpl, credential.base_url, config.accountAddress),
  ]);
  if (account.status !== "ready_to_trade" || account.trading_enabled !== true) {
    throw new Error(`Hyperliquid account is not funded and ready: ${account.status || "unknown"}`);
  }
  if (Number(exactState.position_size) !== 0 || exactState.open_order_count !== 0) {
    throw new Error("readiness requires an initially flat HYPE account with zero HYPE orders");
  }
  const noSubmit = await verifyHyperliquidNoSubmit({
    credential,
    instruction,
    cloid,
    executionMode: "byo_api_key",
  });
  assertRealNoSubmit(noSubmit, instruction);
  const exitNoSubmit = await verifyHyperliquidNoSubmit({
    credential,
    instruction: exitInstruction,
    cloid: exitCloid,
    executionMode: "byo_api_key",
  });
  assertRealNoSubmit(exitNoSubmit, exitInstruction, { protectionRequired: false });
  const state = createPostgresWorkerState(config.databaseUrl, { driver: "pg" });
  try {
    await state.getIdempotency(`readiness_probe_${sha256(workOrder).slice(0, 24)}`);
  } finally {
    await state.close?.();
  }
  return {
    version: 1,
    ok: true,
    status: "ready_for_funded_canary",
    network: "mainnet",
    market: "HYPE",
    notional_usd: 11,
    max_slippage_bps: 100,
    account_commitment: `hyperliquid_account_${sha256(config.accountAddress).slice(0, 40)}`,
    account_ready: true,
    initially_flat: true,
    open_orders: 0,
    api_wallet_authorized: true,
    api_wallet_not_expired: true,
    api_wallet_address: noSubmit.checks.api_wallet_address,
    api_wallet_valid_until: new Date(noSubmit.checks.api_wallet_valid_until_ms).toISOString(),
    executable_book_fresh: true,
    order_packet_built: true,
    action_expiry_proven: true,
    position_protection_packet_built: true,
    reduce_only_exit_packet_built: true,
    reduce_only_exit_no_submit_verified: true,
    postgres_checked: true,
    transaction_broadcast: false,
    verification_commitment: `hyperliquid_readiness_${sha256(JSON.stringify({
      entry: noSubmit.checks,
      exit: exitNoSubmit.checks,
    })).slice(0, 48)}`,
    checked_at: new Date().toISOString(),
  };
}

async function exactHypeState(fetchImpl, baseUrl, accountAddress) {
  const [stateResponse, ordersResponse] = await Promise.all([
    info(fetchImpl, baseUrl, { type: "clearinghouseState", user: accountAddress }),
    info(fetchImpl, baseUrl, { type: "openOrders", user: accountAddress }),
  ]);
  if (!Array.isArray(stateResponse?.assetPositions) || !Array.isArray(ordersResponse)) {
    throw new Error("Hyperliquid account state is invalid");
  }
  const position = stateResponse.assetPositions.find((row) => row?.position?.coin === "HYPE")?.position;
  return {
    position_size: String(position?.szi ?? "0"),
    open_order_count: ordersResponse.filter((order) => order?.coin === "HYPE").length,
  };
}

async function info(fetchImpl, baseUrl, body) {
  const response = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Hyperliquid account state request failed");
  return response.json();
}

function assertRealNoSubmit(result, instruction, { protectionRequired = true } = {}) {
  const checks = result?.checks;
  const instructionExpiryMs = Date.parse(String(instruction?.expires_at || ""));
  if (result?.status !== "verified_no_funds" ||
      checks?.authority_derived !== true || checks?.api_wallet_authorized !== true ||
      checks?.api_wallet_not_expired !== true || checks?.hyperliquid_sdk_ready !== true ||
      !/^0x[0-9a-f]{40}$/u.test(String(checks?.api_wallet_address || "").toLowerCase()) ||
      !Number.isInteger(checks?.api_wallet_valid_until_ms) ||
      checks.api_wallet_valid_until_ms <= Date.now() + 5 * 60_000 ||
      checks?.hyperliquid_api_reachable !== true || checks?.account_read_checked !== true ||
      checks?.order_request_built !== true || checks?.position_protection_checked !== protectionRequired ||
      checks?.action_expiry_checked !== true ||
      !Number.isInteger(checks?.expires_after_ms) || !Number.isInteger(instructionExpiryMs) ||
      checks.expires_after_ms !== instructionExpiryMs || checks.expires_after_ms <= Date.now() ||
      checks.expires_after_ms > Date.now() + 5 * 60_000 || checks?.transaction_broadcast !== false ||
      checks?.verification_simulated === true) {
    throw new Error("real Hyperliquid no-submit readiness is incomplete");
  }
}

function usePinnedLocalPython(env) {
  if (env.PRIVATE_AGENT_PYTHON) return;
  const candidate = resolve(REPO_ROOT, ".dev/hyperliquid-venv/bin/python");
  if (existsSync(candidate)) process.env.PRIVATE_AGENT_PYTHON = candidate;
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredEither(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(`${names.join(" or ")} is required`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  let report;
  try {
    report = await certifyHyperliquidMainnetReadiness();
  } catch (error) {
    report = {
      version: 1,
      ok: false,
      status: "blocked",
      network: "mainnet",
      transaction_broadcast: false,
      error: error instanceof Error ? error.message : String(error),
      checked_at: new Date().toISOString(),
    };
  }
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
