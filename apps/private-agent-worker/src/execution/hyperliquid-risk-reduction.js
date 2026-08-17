import { createHash } from "node:crypto";
import { openSealedBundle } from "../crypto/envelope.js";
import { executeHyperliquidRiskReduction } from "./private-execution.js";
import {
  hyperliquidCredentialFromVault,
  loadManagedHyperliquidCredential,
  readHyperliquidRiskReductionState,
} from "../venues/hyperliquid.js";

export const HYPERLIQUID_CLOSE_CONFIRMATION =
  "I_UNDERSTAND_THIS_CLOSES_A_REAL_POSITION_REDUCE_ONLY";
export const HYPERLIQUID_KILL_AND_FLAT_CONFIRMATION =
  "I_UNDERSTAND_THIS_STOPS_EXECUTION_CANCELS_ORDERS_AND_CLOSES_POSITIONS";

const SUPPORTED_MARKETS = new Set(["BTC", "ETH", "SOL", "HYPE"]);
const MAX_CLOSE_ATTEMPTS = 3;

export function validateHyperliquidCloseRequest(body, recipient) {
  const errors = validateBaseRequest(body, recipient);
  if (body?.confirmation !== HYPERLIQUID_CLOSE_CONFIRMATION) {
    errors.push("reduce-only close confirmation is required");
  }
  if (!SUPPORTED_MARKETS.has(marketSymbol(body?.market))) errors.push("market is unsupported");
  return errors;
}

export async function closeSealedHyperliquidPosition({
  body,
  recipient,
  state,
  fetchImpl = fetch,
  readState = readHyperliquidRiskReductionState,
  executeRiskReduction = executeHyperliquidRiskReduction,
  resolveCredential = credentialForBody,
  sleep = defaultSleep,
}) {
  const credential = await resolveCredential({ body, recipient, state });
  assertNetwork(body, credential);
  const market = marketSymbol(body.market);
  const allowedMarkets = policyMarkets(body.session_policy);
  if (allowedMarkets.size && !allowedMarkets.has(market)) {
    throw riskError("hyperliquid close market is outside the session allowlist", 409);
  }
  const root = `hl_close_${digest({
    owner: body.owner_commitment,
    vault: body.vault_commitment || body.allocation_commitment,
    idempotency_key: body.idempotency_key,
    market,
  }).slice(0, 40)}`;
  const initial = await readState({ credential, fetchImpl });
  const position = initial.positions.find((row) => row.market === market);
  if (!position) throw riskError("hyperliquid position is already flat", 409);
  const closed = await closeMarket({
    body,
    recipient,
    state,
    credential,
    market,
    root,
    fetchImpl,
    readState,
    executeRiskReduction,
    sleep,
  });
  const finalState = await waitForState({
    credential,
    fetchImpl,
    readState,
    sleep,
    predicate: (snapshot) => !snapshot.positions.some((row) => row.market === market),
    message: "hyperliquid reduce-only close did not return the market flat",
  });
  return riskReductionReport({
    kind: "hyperliquid_position_close_v1",
    root,
    network: credential.network,
    markets: [market],
    cancellations: [],
    closes: closed,
    initial,
    finalState,
    accountFlatRequired: false,
  });
}

export async function killAndFlatHyperliquidSession({
  session,
  recipient,
  state,
  fetchImpl = fetch,
  readState = readHyperliquidRiskReductionState,
  executeRiskReduction = executeHyperliquidRiskReduction,
  resolveCredential = credentialForSession,
  sleep = defaultSleep,
}) {
  const body = riskReductionBodyForSession(session);
  const credential = await resolveCredential({ session, body, recipient, state });
  assertNetwork(body, credential);
  const allowedMarkets = policyMarkets(session.session_policy);
  const root = `hl_kill_flat_${digest({
    session: session.autopilot_session_id,
    control_epoch: session.control_epoch,
  }).slice(0, 40)}`;
  const initial = await readState({ credential, fetchImpl });
  const observedMarkets = new Set([
    ...initial.positions.map((row) => row.market),
    ...initial.open_orders.map((row) => row.market),
  ]);
  const outsidePolicy = [...observedMarkets].filter((market) => !allowedMarkets.has(market));
  if (outsidePolicy.length) {
    throw riskError("hyperliquid account has exposure outside the session allowlist", 409, {
      markets: outsidePolicy,
    });
  }

  const cancellations = [];
  for (const order of initial.open_orders) {
    const workOrder = `${root}_cancel_${digest({ market: order.market, oid: order.oid }).slice(0, 24)}`;
    const receipt = await executeRiskReduction({
      body: executionBody(body, session, workOrder, "cancel"),
      instruction: cancelInstruction(order, workOrder),
      recipient,
      state,
    });
    assertCancelReceipt(receipt, order);
    cancellations.push(publicCancellation(receipt, order, workOrder));
  }
  await waitForState({
    credential,
    fetchImpl,
    readState,
    sleep,
    predicate: (snapshot) => snapshot.open_orders.length === 0,
    message: "hyperliquid kill-and-flat cancellation readback is incomplete",
  });

  const closes = [];
  for (const market of [...allowedMarkets].sort()) {
    const current = await readState({ credential, fetchImpl });
    if (!current.positions.some((row) => row.market === market)) continue;
    closes.push(...await closeMarket({
      body,
      session,
      recipient,
      state,
      credential,
      market,
      root,
      fetchImpl,
      readState,
      executeRiskReduction,
      sleep,
    }));
  }
  const finalState = await waitForState({
    credential,
    fetchImpl,
    readState,
    sleep,
    predicate: (snapshot) => snapshot.positions.length === 0 && snapshot.open_orders.length === 0,
    message: "hyperliquid kill-and-flat did not reconcile final-flat with zero open orders",
  });
  return riskReductionReport({
    kind: "hyperliquid_kill_and_flat_v1",
    root,
    network: credential.network,
    markets: [...observedMarkets].sort(),
    cancellations,
    closes,
    initial,
    finalState,
    accountFlatRequired: true,
  });
}

async function closeMarket(input) {
  const receipts = [];
  for (let attempt = 1; attempt <= MAX_CLOSE_ATTEMPTS; attempt += 1) {
    const snapshot = await input.readState({ credential: input.credential, fetchImpl: input.fetchImpl });
    const position = snapshot.positions.find((row) => row.market === input.market);
    if (!position) return receipts;
    if (!/^-?\d+(?:\.\d+)?$/u.test(position.position_size) || position.position_size === "0") {
      throw riskError("hyperliquid position size is invalid", 502);
    }
    const short = position.position_size.startsWith("-");
    const baseSize = position.position_size.startsWith("-")
      ? position.position_size.slice(1)
      : position.position_size;
    const workOrder = `${input.root}_close_${input.market.toLowerCase()}_${attempt}`;
    const receipt = await input.executeRiskReduction({
      body: executionBody(input.body, input.session, workOrder, "limit_order"),
      instruction: closeInstruction({
        market: input.market,
        side: short ? "buy" : "sell",
        baseSize,
        maxSlippageBps: policySlippage(input.body.session_policy),
      }),
      recipient: input.recipient,
      state: input.state,
    });
    assertCloseReceipt(receipt);
    receipts.push(publicClose(receipt, input.market, workOrder));
    try {
      await waitForState({
        credential: input.credential,
        fetchImpl: input.fetchImpl,
        readState: input.readState,
        sleep: input.sleep,
        attempts: 6,
        predicate: (next) => !next.positions.some((row) => row.market === input.market),
        message: "hyperliquid reduce-only close remains open",
      });
      return receipts;
    } catch (error) {
      if (attempt === MAX_CLOSE_ATTEMPTS) throw error;
    }
  }
  return receipts;
}

function executionBody(body, session, workOrder, operationClass) {
  return {
    version: 1,
    execution_mode: body.execution_mode,
    owner_commitment: body.owner_commitment || session?.owner_commitment,
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment,
    encrypted_execution_vault: body.encrypted_execution_vault,
    allocation_commitment: body.allocation_commitment,
    managed_allocation_commitment: body.managed_allocation_commitment,
    policy_commitment: body.policy_commitment || session?.session_policy?.policy_commitment,
    session_policy: body.session_policy || session?.session_policy,
    autopilot_session_id: session?.autopilot_session_id,
    operation_class: operationClass,
    work_order_commitment: workOrder,
  };
}

function closeInstruction({ market, side, baseSize, maxSlippageBps }) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    expires_at: expiry(),
    order: {
      market,
      side,
      base_size: baseSize,
      size_mode: "base",
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: true,
      max_slippage_bps: String(maxSlippageBps),
      live_order_mode: "tiny_fill",
      margin_mode: "isolated",
      leverage: 1,
    },
  };
}

function cancelInstruction(order, workOrder) {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "cancel",
    expires_at: expiry(),
    cancel: {
      market: order.market,
      order_id: order.oid,
      target_work_order_commitment: `${workOrder}_observed`,
    },
  };
}

async function credentialForBody({ body, recipient, state }) {
  if (body.execution_mode === "byo_api_key") {
    const opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
    return hyperliquidCredentialFromVault(opened.json);
  }
  const commitment = body.managed_allocation_commitment || body.allocation_commitment;
  const record = await state.getHyperliquidManagedAllocation(commitment);
  if (!record?.allocation || record.allocation.status !== "allocated") {
    throw riskError("hyperliquid managed allocation is unavailable", 404);
  }
  return loadManagedHyperliquidCredential(record.allocation);
}

async function credentialForSession({ session, body, recipient, state }) {
  const access = session.venue_access?.hyperliquid;
  if (!access || access.status !== "ready") {
    throw riskError("hyperliquid session venue access is unavailable", 409);
  }
  return credentialForBody({ body: { ...body, ...access }, recipient, state });
}

function riskReductionBodyForSession(session) {
  const access = session.venue_access?.hyperliquid || {};
  const accountCommitment = access.account_commitment || accountCommitmentFromVaultAad(
    access.encrypted_execution_vault?.aad,
  );
  if (!accountCommitment) throw riskError("hyperliquid session account commitment is unavailable", 409);
  return {
    version: 1,
    execution_mode: access.execution_mode,
    owner_commitment: session.owner_commitment,
    account_commitment: accountCommitment,
    vault_commitment: access.vault_commitment,
    encrypted_execution_vault: access.encrypted_execution_vault,
    allocation_commitment: access.allocation_commitment,
    managed_allocation_commitment: access.managed_allocation_commitment,
    policy_commitment: session.session_policy?.policy_commitment,
    session_policy: session.session_policy,
  };
}

function accountCommitmentFromVaultAad(value) {
  const part = String(value || "").split("|").find((item) => item.startsWith("account:"));
  return part?.slice("account:".length) || null;
}

function validateBaseRequest(body, recipient) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["request body must be an object"];
  if (body.version !== 1) errors.push("version must be 1");
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(String(body.idempotency_key || ""))) {
    errors.push("idempotency_key is invalid");
  }
  if (!body.session_policy || typeof body.session_policy !== "object") errors.push("session_policy is required");
  if (!body.policy_commitment) errors.push("policy_commitment is required");
  if (body.execution_mode !== "byo_api_key") errors.push("execution_mode must be byo_api_key");
  const bundle = body.encrypted_execution_vault;
  if (!bundle || typeof bundle !== "object" || bundle.recipient !== recipient?.recipient_id) {
    errors.push("encrypted_execution_vault recipient is invalid");
  }
  return errors;
}

function assertNetwork(body, credential) {
  const expected = body.session_policy?.execution_network;
  if ((expected === "mainnet" || expected === "testnet") && credential.network !== expected) {
    throw riskError("hyperliquid execution network does not match session policy", 409);
  }
}

function policyMarkets(policy) {
  return new Set((Array.isArray(policy?.market_allowlist) ? policy.market_allowlist : [])
    .map(marketSymbol)
    .filter((market) => SUPPORTED_MARKETS.has(market)));
}

function policySlippage(policy) {
  const parsed = Number(policy?.max_slippage_bps);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw riskError("hyperliquid risk-reduction slippage is outside policy", 409);
  }
  return parsed;
}

function assertCancelReceipt(receipt, order) {
  if (receipt?.status !== "cancelled" ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.cancellation_readback_proven !== true ||
      receipt?.final_proof?.cancellation_terminal_status !== "canceled" ||
      String(receipt?.final_proof?.venue_order_oid || "") !== order.oid ||
      receipt?.final_proof?.action_expiry_proven !== true) {
    throw riskError("hyperliquid cancellation lacks terminal venue proof", 502);
  }
}

function assertCloseReceipt(receipt) {
  if (receipt?.status !== "filled" ||
      receipt?.final_proof?.broadcast_performed !== true ||
      receipt?.final_proof?.final_venue_execution_proven !== true ||
      receipt?.final_proof?.final_fill_proven !== true ||
      receipt?.final_proof?.venue_order_readback_proven !== true ||
      receipt?.final_proof?.market_data_freshness_proven !== true ||
      receipt?.final_proof?.market_slippage_bound_proven !== true ||
      receipt?.final_proof?.action_expiry_proven !== true) {
    throw riskError("hyperliquid close lacks terminal venue fill proof", 502);
  }
}

function publicCancellation(receipt, order, workOrder) {
  return {
    market: order.market,
    work_order_commitment: workOrder,
    venue_order_oid: String(receipt.final_proof.venue_order_oid),
    terminal_status: "canceled",
    venue_readback_proven: true,
    replay_protected: true,
  };
}

function publicClose(receipt, market, workOrder) {
  const venueOrderOid = String(receipt.final_proof.venue_order_oid || "");
  return {
    market,
    work_order_commitment: workOrder,
    venue_order_oid: venueOrderOid,
    venue_order_cloid: String(receipt.final_proof.venue_order_cloid || ""),
    terminal_status: "filled",
    reduce_only: true,
    fill_count_bucket: fillCountBucket(receipt.fill_summary?.fill_count),
    fill_evidence_commitment: `hl_fill_evidence_${digest({
      market,
      work_order_commitment: workOrder,
      venue_order_oid: venueOrderOid,
      fill_summary: receipt.fill_summary || null,
    })}`,
    venue_readback_proven: true,
    replay_protected: true,
  };
}

function fillCountBucket(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return "unknown";
  if (count === 1) return "1";
  return count <= 4 ? "2-4" : "5+";
}

function riskReductionReport({
  kind,
  root,
  network,
  markets,
  cancellations,
  closes,
  initial,
  finalState,
  accountFlatRequired,
}) {
  const accountFlat = finalState.positions.length === 0;
  const zeroOpenOrders = finalState.open_orders.length === 0;
  const marketFlat = markets.every((market) => !finalState.positions.some((row) => row.market === market));
  if (accountFlatRequired && (!accountFlat || !zeroOpenOrders)) {
    throw riskError("hyperliquid final-flat evidence is incomplete", 502);
  }
  const completedAt = new Date().toISOString();
  const evidence = {
    version: 1,
    proof_kind: kind,
    network,
    markets,
    initial_position_count: initial.positions.length,
    initial_open_order_count: initial.open_orders.length,
    cancellations,
    closes,
    reduce_only_exit_proven: closes.every((row) => row.reduce_only && row.venue_readback_proven),
    cancellations_terminal: cancellations.every((row) => row.terminal_status === "canceled"),
    market_flat: marketFlat,
    account_flat: accountFlat,
    open_order_count: finalState.open_orders.length,
    final_flat_proven: accountFlatRequired ? accountFlat && zeroOpenOrders : marketFlat,
    reconciled_at: finalState.checked_at,
    completed_at: completedAt,
  };
  return {
    ...evidence,
    status: "reconciled",
    root_work_order_commitment: root,
    evidence_commitment: `hl_risk_evidence_${digest(evidence)}`,
  };
}

async function waitForState({
  credential,
  fetchImpl,
  readState,
  sleep,
  predicate,
  message,
  attempts = 20,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await readState({ credential, fetchImpl });
    if (predicate(snapshot)) return snapshot;
    await sleep(250);
  }
  throw riskError(message, 502);
}

function marketSymbol(value) {
  return String(value || "").trim().toUpperCase().split("-")[0].split("/")[0];
}

function expiry() {
  return new Date(Date.now() + 60_000).toISOString();
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function riskError(message, status = 400, details = null) {
  const error = new Error(message);
  error.code = message.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
  error.status = status;
  if (details) error.details = details;
  return error;
}
