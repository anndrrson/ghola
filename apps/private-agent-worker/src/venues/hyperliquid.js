import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  submitTurnkeyHyperliquidExecution,
  turnkeyHyperliquidCredentialFromVault,
  verifyTurnkeyHyperliquidNoSubmit,
} from "./hyperliquid-turnkey.js";

const MAINNET_API_URL = "https://api.hyperliquid.xyz";
const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";
const MAINNET_WS_URL = "wss://api.hyperliquid.xyz/ws";
const TESTNET_WS_URL = "wss://api.hyperliquid-testnet.xyz/ws";
const RECENT_FILL_WINDOW = 12;
const OPEN_ORDER_WINDOW = 12;
const POSITION_WINDOW = 12;

export class HyperliquidExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "HyperliquidExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function hyperliquidCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new HyperliquidExecutionError("hyperliquid execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_hyperliquid_execution_vault") {
    throw new HyperliquidExecutionError("hyperliquid execution vault kind is invalid", 400, "venue_access_required");
  }
  if (vault.signing_mode === "turnkey_delegated") {
    return turnkeyHyperliquidCredentialFromVault(vault);
  }
  if (!vault.hyperliquid_account_address || !vault.api_wallet_private_key) {
    throw new HyperliquidExecutionError("hyperliquid execution credentials are missing", 400, "venue_access_required");
  }
  return {
    network: vault.network === "testnet" ? "testnet" : "mainnet",
    base_url: vault.network === "testnet" ? TESTNET_API_URL : MAINNET_API_URL,
    account_address: String(vault.hyperliquid_account_address).toLowerCase(),
    api_wallet_private_key: String(vault.api_wallet_private_key).toLowerCase(),
    agent_name: vault.agent_name || null,
  };
}

export function assertHyperliquidPilotNetwork(credential, instruction = null) {
  const network = credential?.network === "testnet" ? "testnet" : "mainnet";
  if (network === "testnet") return;
  if (process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") {
    throw new HyperliquidExecutionError("hyperliquid pilot is testnet-only unless live mainnet is explicitly enabled", 400);
  }
  const liveMode = process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE || "disabled";
  const operationClass = instruction?.operation_class || "read";
  if (operationClass === "read" || operationClass === "reconcile") {
    if (liveMode === "read_only" || liveMode === "tiny_fill" || liveMode === "full_ticket") return;
    throw new HyperliquidExecutionError("hyperliquid mainnet read mode is disabled", 400);
  }
  if (operationClass === "cancel") {
    if (liveMode === "tiny_fill" || liveMode === "full_ticket") return;
    throw new HyperliquidExecutionError("hyperliquid mainnet cancel mode is disabled", 400);
  }
  if (liveMode === "full_ticket") {
    if (operationClass !== "limit_order") {
      throw new HyperliquidExecutionError("hyperliquid mainnet submit requires limit_order operation", 400);
    }
    return;
  }
  if (operationClass !== "limit_order" || liveMode !== "tiny_fill") {
    throw new HyperliquidExecutionError("hyperliquid mainnet submit requires tiny_fill live mode", 400);
  }
  const order = instruction?.order || {};
  if (order.live_order_mode !== "tiny_fill" || order.tif !== "Ioc" || !order.quote_size) {
    throw new HyperliquidExecutionError("hyperliquid mainnet order must use tiny_fill IOC quote sizing", 400);
  }
}

export function hyperliquidManagedAccountRefs() {
  return managedHyperliquidAccounts().map((account, index) => ({
    credential_ref: managedCredentialRef(account, index),
    network: account.network === "mainnet" ? "mainnet" : "testnet",
    market_allowlist: Array.isArray(account.market_allowlist)
      ? account.market_allowlist.map((market) => String(market).toUpperCase())
      : [],
  }));
}

export function loadManagedHyperliquidCredential(allocation) {
  if (allocation?.network !== "testnet" && allocation?.execution_mode !== "ghola_pooled") {
    throw new HyperliquidExecutionError("hyperliquid managed pilot is testnet-only", 400);
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const network = allocation?.execution_mode === "ghola_pooled" ? "mainnet" : "testnet";
    return {
      network,
      base_url: network === "testnet" ? TESTNET_API_URL : MAINNET_API_URL,
      account_address: "0x0000000000000000000000000000000000000001",
      api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      agent_name: allocation?.execution_mode === "ghola_pooled" ? "dry-run-ghola-pooled" : "dry-run-managed",
    };
  }
  const accounts = managedHyperliquidAccounts();
  const selected = accounts.find((account, index) =>
    managedCredentialRef(account, index) === allocation.credential_ref
  );
  if (!selected) {
    throw new HyperliquidExecutionError("hyperliquid managed allocation credential is unavailable", 503);
  }
  const credential = {
    network: selected.network === "testnet" ? "testnet" : "mainnet",
    base_url: selected.network === "testnet" ? TESTNET_API_URL : MAINNET_API_URL,
    account_address: String(selected.account_address || "").toLowerCase(),
    api_wallet_private_key: String(selected.api_wallet_private_key || "").toLowerCase(),
    agent_name: selected.agent_name || (allocation?.execution_mode === "ghola_pooled" ? "ghola-pooled" : "managed-testnet"),
  };
  if (!/^0x[0-9a-f]{40}$/i.test(credential.account_address)) {
    throw new HyperliquidExecutionError("hyperliquid managed account address is invalid", 503);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(credential.api_wallet_private_key)) {
    throw new HyperliquidExecutionError("hyperliquid managed API wallet key is invalid", 503);
  }
  assertHyperliquidPilotNetwork(credential);
  return credential;
}

export async function submitHyperliquidExecution({
  credential,
  instruction,
  cloid,
  runner = defaultRunner,
  turnkeySubmitter = submitTurnkeyHyperliquidExecution,
  fetchImpl = fetch,
}) {
  assertHyperliquidPilotNetwork(credential, instruction);
  if (instruction.operation_class === "reconcile") {
    return reconcileHyperliquidExecution({ credential, instruction, fetchImpl });
  }
  if (credential?.signing_mode === "turnkey_delegated") {
    const result = await turnkeySubmitter({ credential, instruction, cloid });
    const finalProof = hyperliquidFinalProof({ instruction, result });
    return {
      status: result.status || (instruction.operation_class === "cancel" ? "cancelled" : "submitted"),
      provider_ref_seed: {
        venue: "hyperliquid",
        signing_mode: "turnkey_delegated",
        cloid,
        oid: result.oid || null,
        fills_count: Array.isArray(result.fills) ? result.fills.length : 0,
        bracket_count: Number.isInteger(result.bracket_count) ? result.bracket_count : 0,
      },
      result_seed: {
        kind: "hyperliquid_turnkey_result",
        status: result.status || "submitted",
        market: instruction.order?.market || instruction.cancel?.market || null,
        protection_status: Number(result.bracket_count || 0) > 0 ? "submitted_with_entry" : "not_requested",
        risk_decision: result.risk_decision || null,
      },
      fills: Array.isArray(result.fills) ? result.fills.slice(0, 25) : [],
      final_proof: finalProof,
    };
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: instruction.operation_class === "cancel" ? "cancelled" : "submitted",
      provider_ref_seed: { venue: "hyperliquid", cloid, dry_run: true },
      result_seed: { kind: "hyperliquid_dry_run", market: instruction.order?.market || instruction.cancel?.market || null },
    };
  }
  const result = await runner({
    credential,
    instruction,
    cloid,
    timeout_ms: Number.parseInt(process.env.PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS || "12000", 10),
  });
  const finalProof = hyperliquidFinalProof({ instruction, result });
  return {
    status: result.status || (instruction.operation_class === "cancel" ? "cancelled" : "submitted"),
    provider_ref_seed: {
      venue: "hyperliquid",
      cloid,
      oid: result.oid || null,
      fills_count: Array.isArray(result.fills) ? result.fills.length : 0,
      bracket_count: Number.isInteger(result.bracket_count) ? result.bracket_count : 0,
    },
    result_seed: {
      kind: "hyperliquid_result",
      status: result.status || "submitted",
      market: instruction.order?.market || instruction.cancel?.market || null,
      protection_status: Number(result.bracket_count || 0) > 0 ? "submitted_with_entry" : "not_requested",
    },
    fills: Array.isArray(result.fills) ? result.fills.slice(0, 25) : [],
    final_proof: finalProof,
  };
}

async function reconcileHyperliquidExecution({ credential, instruction, fetchImpl }) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: "outcome_unknown",
      provider_ref_seed: { venue: "hyperliquid", dry_run: true, targeted: true },
      result_seed: { kind: "hyperliquid_targeted_reconcile", fills_count: 0 },
      fills: [],
      final_proof: {
        version: 1,
        proof_kind: "hyperliquid_order_status_reconciliation_v1",
        status: "outcome_unknown",
        venue_id: "hyperliquid",
        broadcast_performed: false,
        final_venue_execution_proven: false,
        final_fill_proven: false,
        cumulative_filled_micro_usdc: 0,
        filled_base_size: null,
        checked_at: new Date().toISOString(),
      },
    };
  }
  const targetCloid = String(instruction.reconcile?.target_client_order_id || "").toLowerCase();
  const targetOid = String(instruction.reconcile?.target_order_id || "");
  if (!targetCloid && !targetOid) {
    throw new HyperliquidExecutionError("hyperliquid targeted reconcile requires an order target", 400);
  }
  const orderStatusResponse = await fetchImpl(`${credential.base_url || MAINNET_API_URL}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "orderStatus",
      user: credential.account_address,
      oid: targetCloid || Number(targetOid),
    }),
  });
  if (!orderStatusResponse.ok) {
    throw new HyperliquidExecutionError("hyperliquid targeted reconcile failed", 502);
  }
  const orderStatusBody = await orderStatusResponse.json();
  if (orderStatusBody?.status !== "order") {
    return {
      status: "outcome_unknown",
      provider_ref_seed: { venue: "hyperliquid", targeted: true, cloid: targetCloid || null },
      result_seed: { kind: "hyperliquid_order_status_reconcile", status: "unknownOid" },
      fills: [],
      final_proof: {
        version: 1,
        proof_kind: "hyperliquid_order_status_reconciliation_v1",
        status: "outcome_unknown",
        venue_id: "hyperliquid",
        broadcast_performed: false,
        final_venue_execution_proven: false,
        final_fill_proven: false,
        cumulative_filled_micro_usdc: 0,
        filled_base_size: null,
        checked_at: new Date().toISOString(),
      },
    };
  }
  const venueOrder = orderStatusBody.order?.order || {};
  const venueOrderStatus = String(orderStatusBody.order?.status || "unknown");
  const venueOid = String(venueOrder.oid || targetOid || "");
  let rows = [];
  try {
    const fillsResponse = await fetchImpl(`${credential.base_url || MAINNET_API_URL}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "userFillsByTime",
        user: credential.account_address,
        startTime: Date.now() - 8 * 24 * 60 * 60_000,
        aggregateByTime: true,
      }),
    });
    if (fillsResponse.ok) {
      const fillsBody = await fillsResponse.json();
      rows = Array.isArray(fillsBody) ? fillsBody : [];
    }
  } catch {
    rows = [];
  }
  const matched = rows.filter((fill) => {
    const cloidMatches = targetCloid && String(fill?.cloid || fill?.cloidHex || "").toLowerCase() === targetCloid;
    const oidMatches = venueOid && String(fill?.oid || fill?.orderId || "") === venueOid;
    return cloidMatches || oidMatches;
  });
  const fills = matched.slice(0, 25).map((fill) => ({
    coin: fill?.coin || null,
    px: fill?.px || null,
    sz: fill?.sz || null,
    fee: fill?.fee || null,
    time: fill?.time || null,
  }));
  const filledBase = fills.reduce((sum, fill) => sum + positiveDecimal(fill.sz), 0);
  const filledNotional = fills.reduce((sum, fill) => sum + positiveDecimal(fill.sz) * positiveDecimal(fill.px), 0);
  const finalFillProven = venueOrderStatus === "filled" && filledBase > 0;
  return {
    status: "reconciled",
    provider_ref_seed: {
      venue: "hyperliquid",
      targeted: true,
      cloid: targetCloid || null,
      oid: venueOid || null,
      order_status: venueOrderStatus,
      fills_count: fills.length,
    },
    result_seed: {
      kind: "hyperliquid_order_status_reconcile",
      order_status: venueOrderStatus,
      fills_count: fills.length,
    },
    fills,
    final_proof: {
      version: 1,
      proof_kind: "hyperliquid_order_status_reconciliation_v1",
      status: finalFillProven ? "filled" : venueOrderStatus,
      venue_id: "hyperliquid",
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: finalFillProven,
      cumulative_filled_micro_usdc: Math.max(0, Math.round(filledNotional * 1_000_000)),
      filled_base_size: filledBase > 0 ? trimDecimal(filledBase) : null,
      checked_at: new Date().toISOString(),
    },
  };
}

function hyperliquidFinalProof({ instruction, result }) {
  const fills = Array.isArray(result?.fills) ? result.fills : [];
  let filledBase = 0;
  let filledNotional = 0;
  for (const fill of fills) {
    const size = positiveDecimal(fill?.sz ?? fill?.size ?? fill?.totalSz);
    const price = positiveDecimal(fill?.px ?? fill?.price ?? fill?.avgPx);
    if (!size || !price) continue;
    filledBase += size;
    filledNotional += size * price;
  }
  const requestedBase = positiveDecimal(instruction.order?.base_size);
  const requestedQuote = positiveDecimal(instruction.order?.quote_size);
  const minimumFillRatio = boundedRatio(process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_FILL_RATIO, 0.999);
  const fullByBase = requestedBase > 0 && filledBase >= requestedBase * minimumFillRatio;
  const fullByQuote = requestedQuote > 0 && filledNotional >= requestedQuote * minimumFillRatio;
  const cancelled = instruction.operation_class === "cancel" && result?.status === "cancelled";
  const fullFill = result?.status === "filled" && (requestedBase > 0 ? fullByBase : fullByQuote);
  const terminalIoc = result?.status === "filled" && String(instruction.order?.tif || "").toLowerCase() === "ioc";
  return {
    version: 1,
    proof_kind: "hyperliquid_immediate_order_state_v1",
    status: fullFill ? "filled" : cancelled ? "cancelled" : filledBase > 0 ? "partially_filled" : "outcome_unknown",
    venue_id: "hyperliquid",
    broadcast_performed: true,
    final_venue_execution_proven: fullFill || cancelled || terminalIoc,
    final_fill_proven: fullFill,
    cumulative_filled_micro_usdc: Math.max(0, Math.round(filledNotional * 1_000_000)),
    filled_base_size: filledBase > 0 ? trimDecimal(filledBase) : null,
    checked_at: new Date().toISOString(),
  };
}

export async function verifyHyperliquidNoSubmit({
  credential,
  instruction,
  cloid,
  executionMode = "byo_api_key",
  runner = defaultRunner,
  turnkeyVerifier = verifyTurnkeyHyperliquidNoSubmit,
}) {
  assertHyperliquidPilotNetwork(credential, instruction);
  if (credential?.signing_mode === "turnkey_delegated") {
    const runnerResult = await turnkeyVerifier({ credential, instruction, cloid });
    return hyperliquidNoSubmitResult({
      instruction,
      cloid,
      executionMode,
      runnerResult,
    });
  }
  if (
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" ||
    process.env.PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS === "true"
  ) {
    return hyperliquidNoSubmitResult({
      instruction,
      cloid,
      executionMode,
      runnerResult: {
        sdk_checked: true,
        api_wallet_loaded: true,
        market_data_checked: true,
        account_state_checked: true,
        order_request_checked: true,
        live_venue_checked: false,
      },
    });
  }
  const runnerResult = await runner({
    credential,
    instruction,
    cloid,
    verify_no_submit: true,
    timeout_ms: Number.parseInt(process.env.PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS || "12000", 10),
  });
  return hyperliquidNoSubmitResult({
    instruction,
    cloid,
    executionMode,
    runnerResult: { ...runnerResult, live_venue_checked: true },
  });
}

export async function readHyperliquidAccountSnapshot({
  credential,
  accountSource = "sealed_byo",
  fetchImpl = fetch,
}) {
  assertHyperliquidPilotNetwork(credential, { operation_class: "read" });
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      version: 1,
      status: "ready_to_trade",
      account_source: accountSource,
      trading_enabled: true,
      equity_bucket: "ready",
      position_count: 0,
      open_order_count: 0,
      stream_status: "snapshot",
      positions: [],
      open_orders: [],
      recent_fills: [],
      visibility_summary: hyperliquidAccountVisibility(accountSource),
      last_checked_at: new Date().toISOString(),
      next_step: "Preview trade",
    };
  }
  const [state, spotState, abstraction, openOrders, userFills] = await Promise.all([
    postHyperliquidInfo(fetchImpl, credential.base_url, {
      type: "clearinghouseState",
      user: credential.account_address,
    }),
    postHyperliquidInfo(fetchImpl, credential.base_url, {
      type: "spotClearinghouseState",
      user: credential.account_address,
    }),
    postHyperliquidInfo(fetchImpl, credential.base_url, {
      type: "userAbstraction",
      user: credential.account_address,
    }).catch(() => null),
    postHyperliquidInfo(fetchImpl, credential.base_url, {
      type: "openOrders",
      user: credential.account_address,
    }),
    postHyperliquidInfo(fetchImpl, credential.base_url, {
      type: "userFills",
      user: credential.account_address,
      aggregateByTime: true,
    }).catch(() => []),
  ]);
  return hyperliquidAccountStateFromParts({
    state,
    spotState,
    abstraction,
    openOrders,
    userFills,
    accountSource,
    streamStatus: "snapshot",
  });
}

export async function createHyperliquidAccountStateStream({
  credential,
  accountSource = "sealed_byo",
  coin = "BTC",
  fetchImpl = fetch,
  webSocketCtor,
  onEvent,
}) {
  assertHyperliquidPilotNetwork(credential, { operation_class: "read" });
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const snapshot = {
      version: 1,
      status: "ready_to_trade",
      account_source: accountSource,
      trading_enabled: true,
      equity_bucket: "ready",
      position_count: 0,
      open_order_count: 0,
      stream_status: "live",
      positions: [],
      open_orders: [],
      recent_fills: [],
      visibility_summary: hyperliquidAccountVisibility(accountSource),
      last_checked_at: new Date().toISOString(),
      last_event_at: new Date().toISOString(),
      next_step: "Preview trade",
    };
    onEvent({ event: "stream_status", data: accountStreamStatus("live") });
    onEvent({ event: "account_state", data: snapshot });
    const timer = setInterval(() => {
      onEvent({ event: "stream_status", data: accountStreamStatus("live") });
    }, 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  const WebSocketCtor = webSocketCtor || globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new HyperliquidExecutionError("hyperliquid websocket runtime unavailable", 503, "connector_submit_failed");
  }

  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let reconnectAttempts = 0;
  let currentState = null;
  let currentSpotState = null;
  let currentAbstraction = null;
  let currentOpenOrders = [];
  let currentFills = [];

  async function backfill(status = "backfilling") {
    onEvent({ event: "stream_status", data: accountStreamStatus(status) });
    const [state, spotState, abstraction, openOrders, userFills] = await Promise.all([
      postHyperliquidInfo(fetchImpl, credential.base_url, {
        type: "clearinghouseState",
        user: credential.account_address,
      }),
      postHyperliquidInfo(fetchImpl, credential.base_url, {
        type: "spotClearinghouseState",
        user: credential.account_address,
      }),
      postHyperliquidInfo(fetchImpl, credential.base_url, {
        type: "userAbstraction",
        user: credential.account_address,
      }).catch(() => null),
      postHyperliquidInfo(fetchImpl, credential.base_url, {
        type: "openOrders",
        user: credential.account_address,
      }),
      postHyperliquidInfo(fetchImpl, credential.base_url, {
        type: "userFills",
        user: credential.account_address,
        aggregateByTime: true,
      }).catch(() => []),
    ]);
    currentState = state;
    currentSpotState = spotState;
    currentAbstraction = abstraction;
    currentOpenOrders = Array.isArray(openOrders) ? openOrders : [];
    currentFills = Array.isArray(userFills) ? userFills : [];
    emitAccountState("backfilling");
  }

  function emitAccountState(streamStatus = "live") {
    onEvent({
      event: "account_state",
      data: hyperliquidAccountStateFromParts({
        state: currentState,
        spotState: currentSpotState,
        abstraction: currentAbstraction,
        openOrders: currentOpenOrders,
        userFills: currentFills,
        accountSource,
        streamStatus,
      }),
    });
  }

  function subscribe() {
    const subscriptions = [
      { type: "clearinghouseState", user: credential.account_address },
      { type: "openOrders", user: credential.account_address },
      { type: "orderUpdates", user: credential.account_address },
      { type: "userEvents", user: credential.account_address },
      { type: "userFills", user: credential.account_address, aggregateByTime: true },
      { type: "userFundings", user: credential.account_address },
      { type: "activeAssetData", user: credential.account_address, coin },
    ];
    for (const subscription of subscriptions) {
      socket?.send(JSON.stringify({ method: "subscribe", subscription }));
    }
  }

  function connect() {
    if (stopped) return;
    onEvent({ event: "stream_status", data: accountStreamStatus(reconnectAttempts > 0 ? "reconnecting" : "connecting") });
    socket = new WebSocketCtor(credential.network === "testnet" ? TESTNET_WS_URL : MAINNET_WS_URL);
    socket.onopen = () => {
      reconnectAttempts = 0;
      onEvent({ event: "stream_status", data: accountStreamStatus("live") });
      subscribe();
      heartbeatTimer = setInterval(() => {
        try {
          socket?.send(JSON.stringify({ method: "ping" }));
        } catch {
          // The close handler will move the stream back to reconnecting.
        }
      }, 30_000);
      heartbeatTimer.unref?.();
    };
    socket.onmessage = (event) => {
      const changed = mergeHyperliquidAccountStreamMessage(String(event.data));
      if (changed) emitAccountState("live");
    };
    socket.onerror = () => {
      onEvent({ event: "stream_status", data: accountStreamStatus("reconnecting") });
    };
    socket.onclose = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (stopped) return;
      onEvent({ event: "stream_status", data: accountStreamStatus("reconnecting") });
      const delay = Math.min(8_000, 500 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        void backfill("backfilling").catch((error) => {
          onEvent({ event: "error", data: safeStreamError(error) });
        }).finally(connect);
      }, delay);
      reconnectTimer.unref?.();
    };
  }

  function mergeHyperliquidAccountStreamMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return false;
    }
    const channel = message?.channel;
    const data = message?.data;
    if (channel === "clearinghouseState") {
      currentState = data?.clearinghouseState || data;
      return true;
    }
    if (channel === "openOrders") {
      currentOpenOrders = Array.isArray(data)
        ? data
        : Array.isArray(data?.openOrders)
          ? data.openOrders
          : currentOpenOrders;
      return true;
    }
    if (channel === "userFills") {
      const fills = Array.isArray(data?.fills) ? data.fills : Array.isArray(data) ? data : [];
      currentFills = mergeByCommitment(fills, currentFills, "hyperliquid_fill").slice(0, RECENT_FILL_WINDOW);
      return fills.length > 0;
    }
    if (channel === "userEvents") {
      const fills = Array.isArray(data?.fills) ? data.fills : [];
      currentFills = mergeByCommitment(fills, currentFills, "hyperliquid_fill").slice(0, RECENT_FILL_WINDOW);
      return fills.length > 0;
    }
    if (channel === "orderUpdates") {
      onEvent({ event: "account_event", data: sanitizeOrderUpdate(data) });
      return true;
    }
    if (channel === "userFundings") {
      onEvent({ event: "account_event", data: sanitizeFundingUpdate(data) });
      return false;
    }
    if (channel === "activeAssetData") {
      onEvent({ event: "account_event", data: sanitizeActiveAssetData(data) });
      return false;
    }
    return false;
  }

  await backfill("backfilling");
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      socket?.close();
    } catch {
      // Best effort close.
    }
  };
}

function hyperliquidAccountStateFromParts({
  state,
  spotState,
  abstraction,
  openOrders,
  userFills,
  accountSource,
  streamStatus = "snapshot",
}) {
  const perpAccountValue = decimalNumber(
    state?.marginSummary?.accountValue ??
      state?.crossMarginSummary?.accountValue ??
      "0",
  );
  const unifiedUsdc = abstraction === "unifiedAccount"
    ? availableSpotUsdc(spotState)
    : 0;
  const accountValue = Math.max(perpAccountValue, unifiedUsdc);
  const positions = sanitizePositions(state?.assetPositions);
  const sanitizedOpenOrders = sanitizeOpenOrders(openOrders);
  const recentFills = sanitizeFills(userFills);
  const positionCount = positions.length;
  const openOrderCount = sanitizedOpenOrders.length;
  // Match the ticket and venue launch minimum. Previously a $5 account could
  // appear ready even though every supported order would be rejected.
  const status = accountValue >= 10 ? "ready_to_trade" : "needs_funds";
  return {
    version: 1,
    status,
    account_source: accountSource,
    trading_enabled: status === "ready_to_trade",
    equity_bucket: accountValue <= 0
      ? "none"
      : accountValue < 10
        ? "low"
        : "ready",
    position_count: positionCount,
    open_order_count: openOrderCount,
    stream_status: streamStatus,
    positions,
    open_orders: sanitizedOpenOrders,
    recent_fills: recentFills,
    visibility_summary: hyperliquidAccountVisibility(accountSource),
    last_checked_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    next_step: status === "ready_to_trade"
      ? "Preview trade"
      : "Add collateral on Hyperliquid, then check again.",
  };
}

function availableSpotUsdc(spotState) {
  const balance = Array.isArray(spotState?.balances)
    ? spotState.balances.find((item) => item?.coin === "USDC")
    : null;
  return Math.max(0, decimalNumber(balance?.total) - decimalNumber(balance?.hold));
}

function sanitizePositions(assetPositions) {
  if (!Array.isArray(assetPositions)) return [];
  return assetPositions
    .map((item) => item?.position || item)
    .filter((position) => decimalNumber(position?.szi ?? "0") !== 0)
    .slice(0, POSITION_WINDOW)
    .map((position) => {
      const size = decimalNumber(position?.szi ?? "0");
      return {
        position_commitment: commitment("hyperliquid_position", {
          coin: position?.coin,
          side: size >= 0 ? "long" : "short",
          size_bucket: decimalBucket(Math.abs(size)),
          entry_price_bucket: decimalBucket(position?.entryPx),
        }),
        market: stringValue(position?.coin) || "UNKNOWN",
        side: size >= 0 ? "long" : "short",
        size_bucket: decimalBucket(Math.abs(size)),
        entry_price_bucket: decimalBucket(position?.entryPx),
        unrealized_pnl_bucket: signedDecimalBucket(position?.unrealizedPnl),
      };
    });
}

function sanitizeOpenOrders(openOrders) {
  if (!Array.isArray(openOrders)) return [];
  return openOrders.slice(0, OPEN_ORDER_WINDOW).map((openOrder) => ({
    order_handle_commitment: commitment("hyperliquid_open_order", {
      oid: openOrder?.oid,
      cloid: openOrder?.cloid,
      coin: openOrder?.coin,
      side: openOrder?.side,
      timestamp: openOrder?.timestamp,
    }),
    market: stringValue(openOrder?.coin) || "UNKNOWN",
    side: normalizeSide(openOrder?.side),
    size_bucket: decimalBucket(openOrder?.sz ?? openOrder?.origSz),
    price_bucket: decimalBucket(openOrder?.limitPx ?? openOrder?.px),
    status: stringValue(openOrder?.status) || "open",
    reduce_only: openOrder?.reduceOnly === true,
  }));
}

function sanitizeFills(fills) {
  if (!Array.isArray(fills)) return [];
  return fills.slice(0, RECENT_FILL_WINDOW).map((fill) => ({
    fill_commitment: commitment("hyperliquid_fill", {
      coin: fill?.coin,
      side: fill?.side,
      px: fill?.px,
      sz: fill?.sz,
      time: fill?.time,
      fee: fill?.fee,
    }),
    market: stringValue(fill?.coin) || "UNKNOWN",
    side: normalizeSide(fill?.side),
    size_bucket: decimalBucket(fill?.sz),
    price_bucket: decimalBucket(fill?.px),
    fee_bucket: signedDecimalBucket(fill?.fee),
    time_bucket: timeBucket(fill?.time),
  }));
}

function sanitizeOrderUpdate(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.orderUpdates) ? data.orderUpdates : [data];
  return {
    type: "order_update",
    updates: rows.filter(Boolean).slice(0, 8).map((row) => {
      const order = row?.order || row;
      return {
        order_handle_commitment: commitment("hyperliquid_order_update", {
          oid: order?.oid,
          cloid: order?.cloid,
          status: row?.status || order?.status,
          timestamp: row?.statusTimestamp || order?.timestamp,
        }),
        market: stringValue(order?.coin) || "UNKNOWN",
        status: stringValue(row?.status || order?.status) || "updated",
        side: normalizeSide(order?.side),
        size_bucket: decimalBucket(order?.sz ?? order?.origSz),
        price_bucket: decimalBucket(order?.limitPx ?? order?.px),
        time_bucket: timeBucket(row?.statusTimestamp || order?.timestamp),
      };
    }),
    updated_at: new Date().toISOString(),
  };
}

function sanitizeFundingUpdate(data) {
  return {
    type: "funding_update",
    update_commitment: commitment("hyperliquid_funding_update", data || {}),
    updated_at: new Date().toISOString(),
  };
}

function sanitizeActiveAssetData(data) {
  return {
    type: "active_asset_data",
    update_commitment: commitment("hyperliquid_active_asset_data", data || {}),
    market: stringValue(data?.coin) || "UNKNOWN",
    updated_at: new Date().toISOString(),
  };
}

function mergeByCommitment(incoming, existing, prefix) {
  const seen = new Set();
  return [...incoming, ...existing].filter((item) => {
    const key = commitment(prefix, item || {});
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function accountStreamStatus(status) {
  return {
    version: 1,
    stream_status: status,
    updated_at: new Date().toISOString(),
  };
}

function safeStreamError(error) {
  return {
    version: 1,
    stream_status: "worker_unavailable",
    error: error?.code === "venue_access_required" ? "venue_access_required" : "stream_unavailable",
    next_step: error?.code === "venue_access_required"
      ? "Connect a Hyperliquid API wallet."
      : "Wait for the private worker to reconnect.",
    updated_at: new Date().toISOString(),
  };
}

function hyperliquidAccountVisibility(accountSource) {
  return {
    main_wallet_exposed: false,
    ghola_operator_sees: "commitment_and_ciphertext_only",
    hyperliquid_sees: "execution_account_and_order_activity",
    venue_access_source: accountSource === "ghola_pooled"
      ? "ghola_pooled_venue_account"
      : accountSource === "ghola_managed" ? "ghola_managed_testnet" : "user_provided_credentials",
    public_chain_sees: "no_direct_main_wallet_trade_settlement",
  };
}

function hyperliquidNoSubmitResult({ instruction, cloid, executionMode, runnerResult }) {
  const market = instruction.order?.market || instruction.cancel?.market || null;
  const checks = {
    sealed_vault_opened: true,
    sealed_instruction_opened: true,
    authority_derived: runnerResult.api_wallet_loaded === true,
    api_wallet_loaded: runnerResult.api_wallet_loaded === true,
    policy_enforced: true,
    live_gate_enforced: true,
    rpc_reachable: runnerResult.market_data_checked === true,
    hyperliquid_api_reachable: runnerResult.market_data_checked === true,
    phoenix_sdk_ready: runnerResult.sdk_checked === true,
    hyperliquid_sdk_ready: runnerResult.sdk_checked === true,
    account_read_checked: runnerResult.account_state_checked === true,
    order_packet_built: runnerResult.order_request_checked === true,
    order_request_built: runnerResult.order_request_checked === true,
    live_venue_checked: runnerResult.live_venue_checked === true,
    transaction_broadcast: false,
  };
  return {
    status: "verified_no_funds",
    provider_ref_seed: {
      venue: "hyperliquid",
      cloid,
      execution_mode: executionMode,
      no_submit: true,
    },
    result_seed: {
      kind: "hyperliquid_no_submit_verification",
      operation_class: instruction.operation_class,
      market_commitment: market ? `hyperliquid_market_${sha256Hex(String(market)).slice(0, 32)}` : null,
      sdk_checked: checks.hyperliquid_sdk_ready,
      market_data_checked: checks.hyperliquid_api_reachable,
      account_state_checked: checks.account_read_checked,
      order_request_checked: checks.order_request_built,
      transaction_broadcast: false,
    },
    checks,
  };
}

function managedHyperliquidAccounts() {
  const raw = process.env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON ||
    readManagedAccountsPath();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is invalid JSON", 503);
  }
  const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is empty", 503);
  }
  return accounts.map((account) => ({
    ...account,
    network: account.network === "mainnet" ? "mainnet" : "testnet",
  }));
}

async function postHyperliquidInfo(fetchImpl, baseUrl, body) {
  const res = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HyperliquidExecutionError("hyperliquid account read failed", 502, "connector_submit_failed");
  }
  return res.json();
}

function decimalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveDecimal(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function boundedRatio(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0.9 && parsed <= 1 ? parsed : fallback;
}

function trimDecimal(value) {
  return Number(value).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function decimalBucket(value) {
  const parsed = Math.abs(decimalNumber(value));
  if (parsed <= 0) return "none";
  if (parsed < 0.001) return "<0.001";
  if (parsed < 0.01) return "0.001-0.01";
  if (parsed < 0.1) return "0.01-0.1";
  if (parsed < 1) return "0.1-1";
  if (parsed < 10) return "1-10";
  if (parsed < 100) return "10-100";
  if (parsed < 1_000) return "100-1k";
  if (parsed < 10_000) return "1k-10k";
  return "10k+";
}

function signedDecimalBucket(value) {
  const parsed = decimalNumber(value);
  if (parsed === 0) return "none";
  return `${parsed < 0 ? "-" : "+"}${decimalBucket(Math.abs(parsed))}`;
}

function timeBucket(value) {
  const parsed = decimalNumber(value);
  if (parsed <= 0) return "unknown";
  return new Date(Math.floor(parsed / 60_000) * 60_000).toISOString();
}

function normalizeSide(value) {
  const side = String(value || "").toLowerCase();
  if (side === "b" || side === "buy" || side === "long") return "buy";
  if (side === "a" || side === "sell" || side === "short") return "sell";
  return "unknown";
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function commitment(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJson(value || {})).slice(0, 48)}`;
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function readManagedAccountsPath() {
  const path = process.env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_PATH;
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is unreadable", 503);
  }
}

function managedCredentialRef(account, index) {
  return `hyperliquid_managed_credential_${sha256Hex(JSON.stringify({
    index,
    network: account.network === "mainnet" ? "mainnet" : "testnet",
    account_address: String(account.account_address || "").toLowerCase(),
    agent_name: account.agent_name || null,
  })).slice(0, 48)}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRunner(payload) {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "hyperliquid_runner.py");
  const python = process.env.PRIVATE_AGENT_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HyperliquidExecutionError("hyperliquid runner timed out", 504));
    }, payload.timeout_ms || 12000);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new HyperliquidExecutionError(error.message || "hyperliquid runner failed", 502));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const text = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const parsed = parseRunnerFailure(text);
        reject(new HyperliquidExecutionError(
          parsed.message,
          parsed.status,
          parsed.code,
        ));
        return;
      }
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        reject(new HyperliquidExecutionError("hyperliquid runner returned invalid JSON", 502));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function parseRunnerFailure(text) {
  try {
    const body = JSON.parse(text || "{}");
    const message = typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : "hyperliquid runner failed";
    const code = body.error_code === "venue_rejected"
      ? "venue_rejected"
      : body.error_code === "venue_access_required"
        ? "venue_access_required"
        : "connector_submit_failed";
    const status = code === "venue_rejected" ? 422 : code === "venue_access_required" ? 400 : 502;
    return { message, code, status };
  } catch {
    return {
      message: "hyperliquid runner failed",
      code: "connector_submit_failed",
      status: 502,
    };
  }
}
