#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  executeClaimedPrivateSubmission,
  reconcileStoredExecution,
} from "../src/execution/private-execution.js";
import { createPostgresWorkerState } from "../src/state/private-state.js";
import {
  hyperliquidCredentialFromVault,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
} from "../src/venues/hyperliquid.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_BROADCASTS_AND_CANCELS_TESTNET_ONLY";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export function testnetCanaryConfig(env = process.env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") throw new Error("testnet canary refuses dry-run mode");
  if (env.GHOLA_HYPERLIQUID_TESTNET_CANARY_CONFIRM !== CONFIRMATION) {
    throw new Error(`GHOLA_HYPERLIQUID_TESTNET_CANARY_CONFIRM must equal ${CONFIRMATION}`);
  }
  const databaseUrl = required(env, "PRIVATE_AGENT_TEST_POSTGRES_URL");
  const accountAddress = required(env, "GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS").toLowerCase();
  const privateKey = required(env, "GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(accountAddress)) throw new Error("testnet account address is invalid");
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) throw new Error("testnet API wallet key is invalid");
  const market = String(env.GHOLA_HYPERLIQUID_TESTNET_MARKET || "HYPE").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(market)) throw new Error("testnet market is invalid");
  const notionalUsd = Number(env.GHOLA_HYPERLIQUID_TESTNET_CANARY_NOTIONAL_USD || "11");
  if (!Number.isFinite(notionalUsd) || notionalUsd < 10 || notionalUsd > 25) {
    throw new Error("testnet canary notional must be between 10 and 25 USD");
  }
  return { databaseUrl, accountAddress, privateKey, market, notionalUsd };
}

export async function runHyperliquidTestnetLifecycle({ env = process.env, fetchImpl = fetch } = {}) {
  const config = testnetCanaryConfig(env);
  const state = createPostgresWorkerState(config.databaseUrl, { driver: "pg" });
  const credential = hyperliquidCredentialFromVault({
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: "testnet",
    hyperliquid_account_address: config.accountAddress,
    api_wallet_private_key: config.privateKey,
  });
  const runId = `${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
  const placeWorkOrder = `hl_testnet_place_${runId}`;
  const cancelWorkOrder = `hl_testnet_cancel_${runId}`;
  const placeCloid = cloid(placeWorkOrder);
  let placementStarted = false;
  let cancellationConfirmed = false;

  try {
    const account = await readHyperliquidAccountSnapshot({ credential, fetchImpl });
    if (account.status !== "ready_to_trade") throw new Error(`testnet account is not funded: ${account.status}`);
    const mid = await marketMid(fetchImpl, credential.base_url, config.market);
    const limitPrice = fiveSignificant(mid * 0.98);
    const placeInstruction = {
      version: 1,
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      order: {
        market: config.market,
        side: "buy",
        quote_size: String(config.notionalUsd),
        limit_price: limitPrice,
        order_type: "limit",
        size_mode: "quote",
        tif: "Alo",
        post_only: true,
        reduce_only: false,
      },
    };
    const placeContext = claimContext(placeWorkOrder, "limit_order", placeInstruction);
    placementStarted = true;
    const placed = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: placeWorkOrder,
      claim_context: placeContext,
      submit: () => submitHyperliquidExecution({ credential, instruction: placeInstruction, cloid: placeCloid }),
      evidence: (result) => executionEvidence(placeWorkOrder, placeContext.request_digest, result),
    });
    if (placed.status !== "submitted") throw new Error(`testnet placement was not resting: ${placed.status}`);

    const replay = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: placeWorkOrder,
      claim_context: placeContext,
      submit: async () => { throw new Error("duplicate_submit_attempted"); },
      evidence: async () => { throw new Error("duplicate_evidence_attempted"); },
    });
    if (JSON.stringify(replay) !== JSON.stringify(placed)) throw new Error("completed claim did not replay exactly");
    await waitForOpenOrder(fetchImpl, credential.base_url, config.accountAddress, placeCloid, true);

    const cancelInstruction = {
      version: 1,
      venue_id: "hyperliquid",
      operation_class: "cancel",
      cancel: { market: config.market, client_order_id: placeCloid },
    };
    const cancelContext = claimContext(cancelWorkOrder, "cancel", cancelInstruction);
    const cancelled = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: cancelWorkOrder,
      claim_context: cancelContext,
      submit: () => submitHyperliquidExecution({ credential, instruction: cancelInstruction, cloid: cloid(cancelWorkOrder) }),
      evidence: (result) => executionEvidence(cancelWorkOrder, cancelContext.request_digest, result),
    });
    if (cancelled.status !== "cancelled") throw new Error(`testnet cancellation was not acknowledged: ${cancelled.status}`);
    await waitForOpenOrder(fetchImpl, credential.base_url, config.accountAddress, placeCloid, false);
    cancellationConfirmed = true;

    const venueReconcile = await submitHyperliquidExecution({
      credential,
      instruction: { version: 1, venue_id: "hyperliquid", operation_class: "reconcile", reconcile: {} },
      cloid: cloid(`reconcile_${runId}`),
    });
    if (venueReconcile.status !== "reconciled") throw new Error("testnet venue reconciliation failed");
    const storedReconcile = await reconcileStoredExecution({
      body: { work_order_commitment: placeWorkOrder, execution_mode: "byo_api_key" },
      state,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
    });
    if (JSON.stringify(storedReconcile) !== JSON.stringify(placed)) throw new Error("stored reconciliation did not replay the exact receipt");

    return {
      ok: true,
      network: "testnet",
      market: config.market,
      notional_usd: config.notionalUsd,
      claim_store: "postgres",
      placement_status: placed.status,
      duplicate_submit_prevented: true,
      cancellation_status: cancelled.status,
      open_order_absent_after_cancel: true,
      venue_reconcile_status: venueReconcile.status,
      stored_receipt_replayed: true,
      place_work_order_commitment: placeWorkOrder,
      cancel_work_order_commitment: cancelWorkOrder,
      completed_at: new Date().toISOString(),
    };
  } finally {
    if (placementStarted && !cancellationConfirmed) {
      await submitHyperliquidExecution({
        credential,
        instruction: {
          version: 1,
          venue_id: "hyperliquid",
          operation_class: "cancel",
          cancel: { market: config.market, client_order_id: placeCloid },
        },
        cloid: cloid(`cleanup_${runId}`),
      }).catch(() => {});
    }
    await state.close?.();
  }
}

function claimContext(workOrder, operationClass, instruction) {
  return {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: operationClass,
    request_digest: sha256(JSON.stringify({ workOrder, instruction })),
  };
}

function executionEvidence(workOrder, requestDigest, result) {
  const receipt = {
    version: 1,
    status: result.status,
    work_order_commitment: workOrder,
    provider_ref_commitment: `hyperliquid_provider_${sha256(JSON.stringify(result.provider_ref_seed || {})).slice(0, 48)}`,
    result_commitment: `hyperliquid_result_${sha256(JSON.stringify(result.result_seed || {})).slice(0, 48)}`,
    fill_count: Array.isArray(result.fills) ? result.fills.length : 0,
    execution_request_digest: requestDigest,
    updated_at: new Date().toISOString(),
  };
  return {
    attempt: {
      status: result.status,
      provider_ref_seed: result.provider_ref_seed || null,
      result_seed: result.result_seed || null,
      fills: Array.isArray(result.fills) ? result.fills : [],
      execution_request_digest: requestDigest,
      created_at: new Date().toISOString(),
    },
    receipt,
  };
}

async function marketMid(fetchImpl, baseUrl, market) {
  const response = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
    signal: AbortSignal.timeout(10_000),
  });
  const mids = response.ok ? await response.json() : null;
  const mid = Number(mids?.[market]);
  if (!Number.isFinite(mid) || mid <= 0) throw new Error("testnet market midpoint is unavailable");
  return mid;
}

async function waitForOpenOrder(fetchImpl, baseUrl, accountAddress, targetCloid, expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetchImpl(`${baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openOrders", user: accountAddress }),
      signal: AbortSignal.timeout(10_000),
    });
    const orders = response.ok ? await response.json() : [];
    const present = Array.isArray(orders) && orders.some((order) => String(order?.cloid || "").toLowerCase() === targetCloid);
    if (present === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(expected ? "testnet resting order was not observed" : "testnet order remained open after cancel");
}

export function fiveSignificant(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("price is invalid");
  return Number(value.toPrecision(5)).toString();
}

function cloid(value) {
  return `0x${sha256(value)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function main() {
  const reportPath = resolve(SCRIPT_DIR, "../../../.dev/hyperliquid-testnet-lifecycle.json");
  let report;
  try {
    report = await runHyperliquidTestnetLifecycle();
  } catch (error) {
    report = {
      ok: false,
      network: "testnet",
      error: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    };
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
