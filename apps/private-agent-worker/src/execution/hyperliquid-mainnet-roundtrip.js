import { createHash } from "node:crypto";
import { openSealedBundle } from "../crypto/envelope.js";
import {
  executeClaimedPrivateSubmission,
  executeHyperliquidBoundInstruction,
  reconcileStoredExecution,
} from "./private-execution.js";
import {
  hyperliquidCredentialFromVault,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
} from "../venues/hyperliquid.js";

export const MAINNET_PROOF_CONFIRMATION =
  "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_REAL_MAINNET_POSITION";

export function validateHyperliquidMainnetRoundTripRequest(body, recipient) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["request body must be an object"];
  if (body.version !== 1) errors.push("version must be 1");
  if (body.confirmation !== MAINNET_PROOF_CONFIRMATION) errors.push("mainnet round-trip confirmation is required");
  if (body.execution_mode !== "byo_api_key") errors.push("execution_mode must be byo_api_key");
  for (const field of ["account_commitment", "vault_commitment", "policy_commitment"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) errors.push(`${field} is required`);
  }
  if (body.market !== "HYPE") errors.push("market must be HYPE");
  if (body.notional_usd !== 10.5) errors.push("notional_usd must be 10.5");
  if (body.slippage_bps !== 100) errors.push("slippage_bps must be 100");
  const bundle = body.encrypted_execution_vault;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    errors.push("encrypted_execution_vault is required");
  } else {
    if (bundle.alg !== "sealed-provider-v1") {
      errors.push("encrypted_execution_vault.alg is unsupported");
    }
    if (typeof bundle.recipient !== "string" || bundle.recipient !== recipient?.recipient_id) {
      errors.push("encrypted_execution_vault.recipient must match worker recipient");
    }
    for (const field of ["aad", "ciphertext"]) {
      if (typeof bundle[field] !== "string" || !bundle[field]) {
        errors.push(`encrypted_execution_vault.${field} is required`);
      }
    }
  }
  return errors;
}

export function hyperliquidMainnetRoundTripEnabled(env = process.env) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED !== "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") return false;
  if (env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "tiny_fill") return false;
  const perOrder = Number(env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD);
  const daily = Number(env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD);
  const slippage = Number(env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS);
  return Number.isFinite(perOrder) && perOrder >= 10.5 && perOrder <= 11 &&
    Number.isFinite(daily) && daily >= 10.5 && daily <= 25 &&
    Number.isInteger(slippage) && slippage === 100;
}

export async function runSealedHyperliquidMainnetRoundTrip({
  body,
  recipient,
  state,
  fetchImpl = fetch,
  executeOrder = executeHyperliquidBoundInstruction,
  readSnapshot = readHyperliquidAccountSnapshot,
  reconcile = reconcileStoredExecution,
  submitEmergency = submitHyperliquidExecution,
}) {
  const opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
    aadPrefix: "ghola/hyperliquid-execution-vault-v1",
    expectedKind: "ghola_hyperliquid_execution_vault",
  });
  const credential = hyperliquidCredentialFromVault(opened.json);
  if (credential.network !== "mainnet") throw proofError("sealed vault is not bound to Hyperliquid mainnet", 409);

  const proofWorkOrder = `hl_mainnet_investor_proof_${sha256(body.vault_commitment).slice(0, 32)}`;
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "mainnet_roundtrip_proof",
    request_digest: sha256(stableJson({
      version: 1,
      vault_commitment: body.vault_commitment,
      policy_commitment: body.policy_commitment,
      market: body.market,
      notional_usd: body.notional_usd,
      slippage_bps: body.slippage_bps,
    })),
  };

  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: proofWorkOrder,
    claim_context: claimContext,
    submit: () => performRoundTrip({
      body,
      recipient,
      state,
      credential,
      proofWorkOrder,
      fetchImpl,
      executeOrder,
      readSnapshot,
      reconcile,
      submitEmergency,
    }),
    evidence: async (report) => ({
      attempt: {
        status: "filled",
        entry_work_order_commitment: report.entry_work_order_commitment,
        exit_work_order_commitment: report.exit_work_order_commitment,
        final_proof: report.final_proof,
        created_at: report.completed_at,
      },
      receipt: report,
    }),
  });
}

async function performRoundTrip({
  body,
  recipient,
  state,
  credential,
  proofWorkOrder,
  fetchImpl,
  executeOrder,
  readSnapshot,
  reconcile,
  submitEmergency,
}) {
  const entryWorkOrder = `${proofWorkOrder}_entry`;
  const exitWorkOrder = `${proofWorkOrder}_exit`;
  let openedByRun = false;
  let flatConfirmed = false;
  try {
    const account = await readSnapshot({ credential, accountSource: "sealed_byo", fetchImpl });
    if (account.status !== "ready_to_trade" || account.trading_enabled !== true) {
      throw proofError(`Hyperliquid account is not ready: ${account.status || "unknown"}`, 409);
    }
    const initial = await exactMarketState(fetchImpl, credential, body.market);
    if (Number(initial.positionSize) !== 0) {
      throw proofError("proof trade requires an initially flat HYPE position", 409);
    }
    if (initial.openOrderCount !== 0) {
      throw proofError("proof trade requires no open HYPE orders", 409);
    }

    const entry = await executeOrder({
      body: orderBody(body, entryWorkOrder),
      instruction: marketInstruction({
        market: body.market,
        side: "buy",
        quoteSize: String(body.notional_usd),
        slippageBps: body.slippage_bps,
        reduceOnly: false,
      }),
      recipient,
      state,
    });
    assertFilled(entry, "entry");
    openedByRun = true;
    const entryReplay = await executeOrder({
      body: orderBody(body, entryWorkOrder),
      instruction: marketInstruction({
        market: body.market,
        side: "buy",
        quoteSize: String(body.notional_usd),
        slippageBps: body.slippage_bps,
        reduceOnly: false,
      }),
      recipient,
      state,
    });
    assertExactReplay(entry, entryReplay, "entry");

    const openedPosition = await waitForMarketState(
      fetchImpl,
      credential,
      body.market,
      (snapshot) => Number(snapshot.positionSize) > 0,
      "filled HYPE position was not observed",
    );
    const exit = await executeOrder({
      body: orderBody(body, exitWorkOrder),
      instruction: marketInstruction({
        market: body.market,
        side: "sell",
        baseSize: openedPosition.positionSize,
        slippageBps: body.slippage_bps,
        reduceOnly: true,
      }),
      recipient,
      state,
    });
    assertFilled(exit, "exit");
    const exitReplay = await executeOrder({
      body: orderBody(body, exitWorkOrder),
      instruction: marketInstruction({
        market: body.market,
        side: "sell",
        baseSize: openedPosition.positionSize,
        slippageBps: body.slippage_bps,
        reduceOnly: true,
      }),
      recipient,
      state,
    });
    assertExactReplay(exit, exitReplay, "exit");

    const finalState = await waitForMarketState(
      fetchImpl,
      credential,
      body.market,
      (snapshot) => Number(snapshot.positionSize) === 0 && snapshot.openOrderCount === 0,
      "Hyperliquid account did not return flat",
    );
    flatConfirmed = true;
    const stored = await reconcile({
      body: { work_order_commitment: entryWorkOrder, execution_mode: "byo_api_key" },
      state,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
    });
    assertExactReplay(entry, stored, "stored receipt");
    const completedAt = new Date().toISOString();
    return {
      version: 1,
      ok: true,
      status: "filled",
      network: "mainnet",
      market: body.market,
      notional_usd: body.notional_usd,
      max_slippage_bps: body.slippage_bps,
      claim_store: state.path === "postgres" ? "postgres" : "unverified",
      proof_work_order_commitment: proofWorkOrder,
      entry_work_order_commitment: entryWorkOrder,
      exit_work_order_commitment: exitWorkOrder,
      entry_status: "filled",
      entry_fill_proven: true,
      entry_fill_summary: entry.fill_summary,
      duplicate_entry_prevented: true,
      opened_position_verified: true,
      exit_status: "filled",
      exit_fill_proven: true,
      exit_fill_summary: exit.fill_summary,
      duplicate_exit_prevented: true,
      stored_receipt_replayed: true,
      flat_after_exit: Number(finalState.positionSize) === 0,
      open_orders_after_exit: finalState.openOrderCount,
      final_proof: {
        version: 1,
        proof_kind: "hyperliquid_mainnet_roundtrip_v1",
        broadcast_performed: true,
        final_venue_execution_proven: true,
        final_fill_proven: true,
        flat_after_exit: true,
        checked_at: completedAt,
      },
      completed_at: completedAt,
    };
  } finally {
    if (openedByRun && !flatConfirmed) {
      await emergencyFlatten({
        credential,
        market: body.market,
        slippageBps: body.slippage_bps,
        state,
        fetchImpl,
        submitEmergency,
        proofWorkOrder,
      });
    }
  }
}

function orderBody(body, workOrderCommitment) {
  return {
    version: 1,
    execution_mode: "byo_api_key",
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment,
    policy_commitment: body.policy_commitment,
    encrypted_execution_vault: body.encrypted_execution_vault,
    work_order_commitment: workOrderCommitment,
    operation_class: "limit_order",
    session_policy: {
      policy_commitment: body.policy_commitment,
      market_allowlist: [body.market],
      max_notional_bucket: "25",
      max_daily_notional_bucket: "25",
      max_order_count: 1,
      execution_network: "mainnet",
      kill_switch: false,
    },
  };
}

function marketInstruction({ market, side, quoteSize, baseSize, slippageBps, reduceOnly }) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
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
      live_order_mode: "tiny_fill",
    },
  };
}

async function exactMarketState(fetchImpl, credential, market) {
  const [state, orders] = await Promise.all([
    info(fetchImpl, credential, { type: "clearinghouseState", user: credential.account_address }),
    info(fetchImpl, credential, { type: "openOrders", user: credential.account_address }),
  ]);
  if (!Array.isArray(state?.assetPositions) || !Array.isArray(orders)) {
    throw proofError("Hyperliquid account state is invalid", 502);
  }
  const position = state.assetPositions.find((row) => row?.position?.coin === market)?.position;
  const positionSize = String(position?.szi ?? "0");
  if (!Number.isFinite(Number(positionSize))) throw proofError("Hyperliquid position size is invalid", 502);
  return {
    positionSize,
    openOrderCount: orders.filter((order) => order?.coin === market).length,
  };
}

async function info(fetchImpl, credential, payload) {
  const response = await fetchImpl(`${credential.base_url}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw proofError("Hyperliquid account state request failed", 502);
  return response.json();
}

async function waitForMarketState(fetchImpl, credential, market, predicate, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const snapshot = await exactMarketState(fetchImpl, credential, market);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw proofError(message, 502);
}

async function emergencyFlatten({
  credential,
  market,
  slippageBps,
  state,
  fetchImpl,
  submitEmergency,
  proofWorkOrder,
}) {
  const current = await exactMarketState(fetchImpl, credential, market);
  const size = Number(current.positionSize);
  if (!Number.isFinite(size) || size === 0) return;
  const absoluteSize = current.positionSize.startsWith("-")
    ? current.positionSize.slice(1)
    : current.positionSize;
  await submitEmergency({
    credential,
    instruction: marketInstruction({
      market,
      side: size > 0 ? "sell" : "buy",
      baseSize: absoluteSize,
      slippageBps,
      reduceOnly: true,
    }),
    cloid: await state.deriveHyperliquidCloid(`${proofWorkOrder}_emergency_flatten`),
  });
  await waitForMarketState(
    fetchImpl,
    credential,
    market,
    (snapshot) => Number(snapshot.positionSize) === 0,
    "emergency flatten did not return the Hyperliquid account flat",
  );
}

function assertFilled(receipt, phase) {
  if (receipt?.status !== "filled" ||
      receipt?.final_proof?.broadcast_performed !== true ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.final_fill_proven !== true) {
    throw proofError(`${phase} lacks final Hyperliquid fill proof`, 502);
  }
}

function assertExactReplay(expected, actual, phase) {
  if (stableJson(expected) !== stableJson(actual)) {
    throw proofError(`${phase} did not replay the exact durable receipt`, 502);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function proofError(message, status) {
  return Object.assign(new Error(message), { status });
}
