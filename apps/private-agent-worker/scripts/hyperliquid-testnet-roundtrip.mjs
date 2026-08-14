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
import { hyperliquidTestnetCloid } from "./hyperliquid-testnet-lifecycle.mjs";

const CONFIRMATION = "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_FUNDED_TESTNET_POSITION";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export function testnetRoundTripConfig(env = process.env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") throw new Error("testnet round trip refuses dry-run mode");
  if (env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM !== CONFIRMATION) {
    throw new Error(`GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM must equal ${CONFIRMATION}`);
  }
  const databaseUrl = required(env, "PRIVATE_AGENT_TEST_POSTGRES_URL");
  const accountAddress = required(env, "GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS").toLowerCase();
  const privateKey = required(env, "GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(accountAddress)) throw new Error("testnet account address is invalid");
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) throw new Error("testnet API wallet key is invalid");
  const market = String(env.GHOLA_HYPERLIQUID_TESTNET_MARKET || "HYPE").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(market)) throw new Error("testnet market is invalid");
  const notionalUsd = Number(env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_NOTIONAL_USD || "11");
  if (!Number.isFinite(notionalUsd) || notionalUsd < 10 || notionalUsd > 15) {
    throw new Error("testnet round-trip notional must be between 10 and 15 USD");
  }
  const slippageBps = Number(env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_SLIPPAGE_BPS || "200");
  if (!Number.isInteger(slippageBps) || slippageBps < 25 || slippageBps > 250) {
    throw new Error("testnet round-trip slippage must be between 25 and 250 bps");
  }
  return { databaseUrl, accountAddress, privateKey, market, notionalUsd, slippageBps };
}

export function positionSizeForMarket(state, market) {
  const row = Array.isArray(state?.assetPositions)
    ? state.assetPositions.find((item) => item?.position?.coin === market)
    : null;
  if (!row) return "0";
  const size = String(row.position?.szi ?? "");
  if (!size || !Number.isFinite(Number(size))) throw new Error("testnet position size is invalid");
  return size;
}

export async function runHyperliquidTestnetRoundTrip({ env = process.env, fetchImpl = fetch } = {}) {
  const config = testnetRoundTripConfig(env);
  const state = createPostgresWorkerState(config.databaseUrl, { driver: "pg" });
  const credential = hyperliquidCredentialFromVault({
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: "testnet",
    hyperliquid_account_address: config.accountAddress,
    api_wallet_private_key: config.privateKey,
  });
  const runId = `${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
  const entryWorkOrder = `hl_testnet_roundtrip_entry_${runId}`;
  const exitWorkOrder = `hl_testnet_roundtrip_exit_${runId}`;
  let flatConfirmed = false;

  try {
    const account = await readHyperliquidAccountSnapshot({ credential, fetchImpl });
    if (account.status !== "ready_to_trade") throw new Error(`testnet account is not funded: ${account.status}`);
    const initial = await exactMarketState(fetchImpl, credential.base_url, config.accountAddress, config.market);
    if (Number(initial.positionSize) !== 0) throw new Error("testnet round trip requires an initially flat market position");
    if (initial.openOrderCount !== 0) throw new Error("testnet round trip requires no open orders in the target market");

    const entryInstruction = marketInstruction({
      market: config.market,
      side: "buy",
      quoteSize: String(config.notionalUsd),
      slippageBps: config.slippageBps,
      reduceOnly: false,
    });
    const entryContext = claimContext(entryWorkOrder, entryInstruction);
    const entry = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: entryWorkOrder,
      claim_context: entryContext,
      submit: () => submitHyperliquidExecution({
        credential,
        instruction: entryInstruction,
        cloid: hyperliquidTestnetCloid(entryWorkOrder),
      }),
      evidence: (result) => executionEvidence(entryWorkOrder, entryContext.request_digest, result),
    });
    assertFilled(entry, "entry");

    const replay = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: entryWorkOrder,
      claim_context: entryContext,
      submit: async () => { throw new Error("duplicate_entry_submit_attempted"); },
      evidence: async () => { throw new Error("duplicate_entry_evidence_attempted"); },
    });
    if (JSON.stringify(replay) !== JSON.stringify(entry)) throw new Error("entry claim did not replay exactly");

    const opened = await waitForMarketState(
      fetchImpl,
      credential.base_url,
      config.accountAddress,
      config.market,
      (snapshot) => Number(snapshot.positionSize) > 0,
      "testnet long position was not observed",
    );
    const exitInstruction = marketInstruction({
      market: config.market,
      side: "sell",
      baseSize: opened.positionSize,
      slippageBps: config.slippageBps,
      reduceOnly: true,
    });
    const exitContext = claimContext(exitWorkOrder, exitInstruction);
    const exited = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: exitWorkOrder,
      claim_context: exitContext,
      submit: () => submitHyperliquidExecution({
        credential,
        instruction: exitInstruction,
        cloid: hyperliquidTestnetCloid(exitWorkOrder),
      }),
      evidence: (result) => executionEvidence(exitWorkOrder, exitContext.request_digest, result),
    });
    assertFilled(exited, "exit");

    const exitReplay = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: exitWorkOrder,
      claim_context: exitContext,
      submit: async () => { throw new Error("duplicate_exit_submit_attempted"); },
      evidence: async () => { throw new Error("duplicate_exit_evidence_attempted"); },
    });
    if (JSON.stringify(exitReplay) !== JSON.stringify(exited)) throw new Error("exit claim did not replay exactly");

    const finalState = await waitForMarketState(
      fetchImpl,
      credential.base_url,
      config.accountAddress,
      config.market,
      (snapshot) => Number(snapshot.positionSize) === 0 && snapshot.openOrderCount === 0,
      "testnet account did not return flat",
    );
    flatConfirmed = true;

    const storedReconcile = await reconcileStoredExecution({
      body: { work_order_commitment: entryWorkOrder, execution_mode: "byo_api_key" },
      state,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
    });
    if (JSON.stringify(storedReconcile) !== JSON.stringify(entry)) {
      throw new Error("stored entry reconciliation did not replay the exact receipt");
    }

    return {
      ok: true,
      network: "testnet",
      market: config.market,
      notional_usd: config.notionalUsd,
      claim_store: "postgres",
      entry_status: entry.status,
      entry_fill_proven: entry.final_proof?.final_fill_proven === true,
      duplicate_entry_prevented: true,
      opened_position_verified: true,
      exit_status: exited.status,
      exit_fill_proven: exited.final_proof?.final_fill_proven === true,
      duplicate_exit_prevented: true,
      flat_after_exit: Number(finalState.positionSize) === 0,
      open_orders_after_exit: finalState.openOrderCount,
      stored_receipt_replayed: true,
      entry_work_order_commitment: entryWorkOrder,
      exit_work_order_commitment: exitWorkOrder,
      completed_at: new Date().toISOString(),
    };
  } finally {
    if (!flatConfirmed) {
      await emergencyFlatten({ config, credential, fetchImpl, runId });
    }
    await state.close?.();
  }
}

function marketInstruction({ market, side, quoteSize, baseSize, slippageBps, reduceOnly }) {
  return {
    version: 1,
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    order: {
      market,
      side,
      ...(quoteSize ? { quote_size: quoteSize, size_mode: "quote" } : {}),
      ...(baseSize ? { base_size: baseSize, size_mode: "base" } : {}),
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: reduceOnly,
      max_slippage_bps: String(slippageBps),
    },
  };
}

function claimContext(workOrder, instruction) {
  return {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
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
    final_proof: result.final_proof || null,
    execution_request_digest: requestDigest,
    updated_at: new Date().toISOString(),
  };
  return {
    attempt: {
      status: result.status,
      provider_ref_seed: result.provider_ref_seed || null,
      result_seed: result.result_seed || null,
      fills: Array.isArray(result.fills) ? result.fills : [],
      final_proof: result.final_proof || null,
      execution_request_digest: requestDigest,
      created_at: new Date().toISOString(),
    },
    receipt,
  };
}

function assertFilled(receipt, phase) {
  if (receipt?.status !== "filled") throw new Error(`testnet ${phase} was not filled: ${receipt?.status || "unknown"}`);
  if (receipt?.final_proof?.broadcast_performed !== true ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.final_fill_proven !== true) {
    throw new Error(`testnet ${phase} lacks final venue fill proof`);
  }
}

async function exactMarketState(fetchImpl, baseUrl, accountAddress, market) {
  const [stateResponse, ordersResponse] = await Promise.all([
    infoRequest(fetchImpl, baseUrl, { type: "clearinghouseState", user: accountAddress }),
    infoRequest(fetchImpl, baseUrl, { type: "openOrders", user: accountAddress }),
  ]);
  if (!Array.isArray(stateResponse?.assetPositions)) throw new Error("testnet position state is invalid");
  if (!Array.isArray(ordersResponse)) throw new Error("testnet open-order state is invalid");
  return {
    positionSize: positionSizeForMarket(stateResponse, market),
    openOrderCount: ordersResponse.filter((order) => order?.coin === market).length,
  };
}

async function infoRequest(fetchImpl, baseUrl, body) {
  const response = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("testnet account state request failed");
  return response.json();
}

async function waitForMarketState(fetchImpl, baseUrl, accountAddress, market, predicate, errorMessage) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const snapshot = await exactMarketState(fetchImpl, baseUrl, accountAddress, market);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(errorMessage);
}

async function emergencyFlatten({ config, credential, fetchImpl, runId }) {
  const current = await exactMarketState(fetchImpl, credential.base_url, config.accountAddress, config.market);
  const size = Number(current.positionSize);
  if (!Number.isFinite(size) || size === 0) return;
  const absoluteSize = current.positionSize.startsWith("-")
    ? current.positionSize.slice(1)
    : current.positionSize;
  await submitHyperliquidExecution({
    credential,
    instruction: marketInstruction({
      market: config.market,
      side: size > 0 ? "sell" : "buy",
      baseSize: absoluteSize,
      slippageBps: Math.max(config.slippageBps, 250),
      reduceOnly: true,
    }),
    cloid: hyperliquidTestnetCloid(`emergency_flatten_${runId}`),
  });
  await waitForMarketState(
    fetchImpl,
    credential.base_url,
    config.accountAddress,
    config.market,
    (snapshot) => Number(snapshot.positionSize) === 0,
    "emergency flatten did not return the testnet account flat",
  );
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
  const reportPath = resolve(SCRIPT_DIR, "../../../.dev/hyperliquid-testnet-roundtrip.json");
  let report;
  try {
    report = await runHyperliquidTestnetRoundTrip();
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
