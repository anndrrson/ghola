import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { AccountRole } from "@solana/kit";
import {
  createPhoenixClient,
  placeLimitOrder,
  placeMarketOrder,
  Side,
} from "@ellipsis-labs/rise";
import { ed25519 } from "@noble/curves/ed25519";

const SUPPORTED_SOLANA_PERPS_VENUES = new Set(["phoenix", "drift", "backpack", "solana_perps"]);
const DEFAULT_PHOENIX_API_URL = "https://perp-api.phoenix.trade";
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_BACKPACK_API_URL = "https://api.backpack.exchange";
const BACKPACK_SOL_PERP_SYMBOL = "SOL_USDC_PERP";

export class SolanaPerpsExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "SolanaPerpsExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeSolanaPerpsVenueId(value) {
  const venueId = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "phoenix";
  if (!SUPPORTED_SOLANA_PERPS_VENUES.has(venueId)) {
    throw new SolanaPerpsExecutionError("solana perps venue_id is unsupported", 400);
  }
  return venueId === "solana_perps" ? "phoenix" : venueId;
}

export function solanaPerpsCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new SolanaPerpsExecutionError("solana perps execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_solana_perps_execution_vault") {
    throw new SolanaPerpsExecutionError("solana perps execution vault kind is invalid", 400, "venue_access_required");
  }
  const venueId = normalizeSolanaPerpsVenueId(vault.venue_id);
  if (venueId === "backpack") {
    const apiKey = stringValue(vault.api_key || vault.apiKey || vault.backpack_api_key);
    const privateSeed = backpackPrivateSeed(
      vault.api_secret ||
        vault.api_private_key_b64 ||
        vault.backpack_api_secret ||
        vault.private_key,
    );
    if (!apiKey || !privateSeed) {
      throw new SolanaPerpsExecutionError("backpack execution credentials are missing", 400, "venue_access_required");
    }
    return {
      venueId,
      network: "mainnet",
      apiKey,
      privateSeed,
      apiUrl: stringValue(vault.api_url) || stringValue(vault.apiUrl) || DEFAULT_BACKPACK_API_URL,
      allowedSymbols: envList(vault.allowed_symbols || vault.allowedSymbols || BACKPACK_SOL_PERP_SYMBOL),
      maxOrderNotionalUsd: positiveNumber(vault.max_order_notional_usd, 5),
      dailyNotionalCapUsd: positiveNumber(vault.daily_notional_cap_usd, 25),
      postOnlyMarketMaking: vault.post_only_mm !== false,
    };
  }
  if (venueId !== "phoenix") {
    throw new SolanaPerpsExecutionError("only phoenix solana perps live pilot is enabled", 400, "venue_rejected");
  }
  const keypair = keypairFromSecret(
    vault.wallet_private_key ||
      vault.authority_private_key ||
      vault.secret_key ||
      vault.private_key,
  );
  const authority = keypair.publicKey.toBase58();
  if (vault.authority && String(vault.authority) !== authority) {
    throw new SolanaPerpsExecutionError("solana perps vault authority mismatch", 400, "venue_access_required");
  }
  const network = vault.network === "mainnet" ? "mainnet" : "mainnet";
  return {
    venueId,
    network,
    authority,
    keypair,
    apiUrl: stringValue(vault.api_url) || stringValue(vault.apiUrl) || DEFAULT_PHOENIX_API_URL,
    rpcUrl: stringValue(vault.rpc_url) ||
      stringValue(vault.rpcUrl) ||
      process.env.PRIVATE_AGENT_SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      DEFAULT_SOLANA_RPC_URL,
    traderPdaIndex: integerValue(vault.trader_pda_index ?? vault.traderPdaIndex, 0),
    traderSubaccountIndex: integerValue(vault.trader_subaccount_index ?? vault.traderSubaccountIndex, 0),
    priorityFeeMicroLamports: integerValue(
      vault.priority_fee_micro_lamports ?? process.env.PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS,
      0,
    ),
  };
}

export function loadPooledSolanaPerpsCredential(venueId = "phoenix") {
  const normalizedVenueId = normalizeSolanaPerpsVenueId(venueId);
  if (normalizedVenueId === "backpack") return loadPooledBackpackCredential();
  if (normalizedVenueId !== "phoenix") {
    throw new SolanaPerpsExecutionError("only phoenix/backpack pooled solana perps pilot is enabled", 400, "venue_rejected");
  }
  const raw = process.env.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON ||
    process.env.PRIVATE_AGENT_SOLANA_PERPS_POOL_VAULT_JSON ||
    readPooledVaultPath(process.env.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_PATH) ||
    readPooledVaultPath(process.env.PRIVATE_AGENT_SOLANA_PERPS_POOL_VAULT_PATH);
  if (!raw && process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const keypair = Keypair.generate();
    return {
      venueId: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      keypair,
      apiUrl: DEFAULT_PHOENIX_API_URL,
      rpcUrl: DEFAULT_SOLANA_RPC_URL,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      priorityFeeMicroLamports: 0,
    };
  }
  if (!raw) {
    throw new SolanaPerpsExecutionError("pooled Phoenix trading authority is unavailable", 503, "venue_access_required");
  }
  try {
    const parsed = JSON.parse(raw);
    return solanaPerpsCredentialFromVault({
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      ...parsed,
    });
  } catch (error) {
    if (error instanceof SolanaPerpsExecutionError) throw error;
    throw new SolanaPerpsExecutionError("pooled Phoenix trading authority is invalid JSON", 503, "venue_access_required");
  }
}

function loadPooledBackpackCredential() {
  const apiKey = stringValue(process.env.PRIVATE_AGENT_BACKPACK_API_KEY || process.env.GHOLA_BACKPACK_API_KEY);
  const privateSeed = backpackPrivateSeed(
    process.env.PRIVATE_AGENT_BACKPACK_API_SECRET ||
      process.env.PRIVATE_AGENT_BACKPACK_API_PRIVATE_KEY_B64 ||
      process.env.GHOLA_BACKPACK_API_SECRET ||
      process.env.GHOLA_BACKPACK_API_PRIVATE_KEY_B64,
  );
  if (!apiKey || !privateSeed) {
    if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
      return {
        venueId: "backpack",
        network: "mainnet",
        apiKey: "dry-run",
        privateSeed: new Uint8Array(32),
        apiUrl: DEFAULT_BACKPACK_API_URL,
        allowedSymbols: [BACKPACK_SOL_PERP_SYMBOL],
        maxOrderNotionalUsd: 5,
        dailyNotionalCapUsd: 25,
        postOnlyMarketMaking: true,
      };
    }
    throw new SolanaPerpsExecutionError("pooled Backpack API key is unavailable", 503, "venue_access_required");
  }
  return {
    venueId: "backpack",
    network: "mainnet",
    apiKey,
    privateSeed,
    apiUrl: stringValue(process.env.PRIVATE_AGENT_BACKPACK_API_URL || process.env.GHOLA_BACKPACK_API_URL) ||
      DEFAULT_BACKPACK_API_URL,
    allowedSymbols: envList(
      process.env.PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS ||
        process.env.GHOLA_BACKPACK_ALLOWED_SYMBOLS ||
        BACKPACK_SOL_PERP_SYMBOL,
    ),
    maxOrderNotionalUsd: positiveNumber(
      process.env.PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD ||
        process.env.GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD,
      5,
    ),
    dailyNotionalCapUsd: positiveNumber(
      process.env.PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD ||
        process.env.GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD,
      25,
    ),
    postOnlyMarketMaking: process.env.PRIVATE_AGENT_BACKPACK_POST_ONLY_MM === "true" ||
      process.env.GHOLA_BACKPACK_POST_ONLY_MM === "true",
  };
}

export async function submitSolanaPerpsExecution({
  credential,
  instruction,
  clientOrderId,
  venueId = "phoenix",
  executionMode = "user_stealth",
  runner = null,
}) {
  const normalizedVenueId = normalizeSolanaPerpsVenueId(venueId);
  const executionRunner = runner || (normalizedVenueId === "backpack" ? runBackpackLiveOrder : runPhoenixLiveOrder);
  const status = statusForOperation(instruction.operation_class);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status,
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        dry_run: true,
      },
      result_seed: {
        kind: "solana_perps_dry_run",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market: instruction.order?.market || instruction.cancel?.market || null,
      },
      fills: [],
    };
  }

  assertSolanaPerpsLiveEnabled(normalizedVenueId, instruction, credential);
  try {
    const result = await executionRunner({
      credential,
      instruction,
      clientOrderId,
      venueId: normalizedVenueId,
    });
    return {
      status: result.status || status,
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        transaction_signature: result.signature || null,
      },
      result_seed: {
        kind: "solana_perps_live_result",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market: instruction.order?.market || null,
        signature: result.signature || null,
      },
      fills: [],
    };
  } catch (error) {
    throw safeSolanaPerpsError(error);
  }
}

export async function verifySolanaPerpsNoSubmit({
  credential,
  instruction,
  clientOrderId,
  venueId = "phoenix",
  executionMode = "user_stealth",
  checker = null,
}) {
  const normalizedVenueId = normalizeSolanaPerpsVenueId(venueId);
  const noSubmitChecker = checker || (normalizedVenueId === "backpack" ? checkBackpackNoSubmit : checkPhoenixNoSubmit);
  assertSolanaPerpsLiveEnabled(normalizedVenueId, instruction, credential);
  try {
    const result = await noSubmitChecker({
      credential,
      instruction,
      clientOrderId,
      venueId: normalizedVenueId,
    });
    return {
      status: "verified_no_funds",
      provider_ref_seed: {
        venue: normalizedVenueId,
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        no_submit: true,
      },
      result_seed: {
        kind: "solana_perps_no_submit_verification",
        venue: normalizedVenueId,
        operation_class: instruction.operation_class,
        market_commitment: sha256Hex(String(instruction.order?.market || "")).slice(0, 32),
        rpc_checked: result.rpc_checked === true,
        phoenix_checked: result.phoenix_checked === true,
        backpack_checked: result.backpack_checked === true,
        order_packet_checked: result.order_packet_checked === true,
      },
      checks: {
        sealed_vault_opened: true,
        sealed_instruction_opened: true,
        authority_derived: true,
        policy_enforced: true,
        live_gate_enforced: true,
        rpc_reachable: result.rpc_checked === true,
        phoenix_sdk_ready: result.phoenix_checked === true,
        backpack_rest_ready: result.backpack_checked === true,
        order_packet_built: result.order_packet_checked === true,
        transaction_broadcast: false,
      },
    };
  } catch (error) {
    throw safeSolanaPerpsError(error);
  }
}

async function checkPhoenixNoSubmit({ credential, instruction, clientOrderId }) {
  if (process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS === "true") {
    return {
      rpc_checked: true,
      phoenix_checked: true,
      order_packet_checked: true,
    };
  }
  const order = instruction.order;
  const connection = new Connection(credential.rpcUrl, "confirmed");
  await connection.getLatestBlockhash("confirmed");
  const client = createPhoenixClient({
    apiUrl: credential.apiUrl,
    rpcUrl: credential.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    await client.exchange.ready();
    await buildPhoenixOrderPacket({ client, order, clientOrderId });
    return {
      rpc_checked: true,
      phoenix_checked: true,
      order_packet_checked: true,
    };
  } finally {
    client.dispose?.();
  }
}

function assertSolanaPerpsLiveEnabled(venueId, instruction, credential) {
  if (venueId === "backpack") return assertBackpackLiveEnabled(instruction, credential);
  const liveMode = process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE || "disabled";
  if (liveMode !== "sdk_runner" && liveMode !== "full_ticket") {
    throw new SolanaPerpsExecutionError(
      "solana perps live submit is disabled",
      503,
      "connector_submit_failed",
    );
  }
  if (venueId !== "phoenix") {
    throw new SolanaPerpsExecutionError(
      "only phoenix solana perps live pilot is enabled",
      400,
      "venue_rejected",
    );
  }
  if (process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET !== "true") {
    throw new SolanaPerpsExecutionError(
      "solana perps mainnet submit is disabled",
      503,
      "connector_submit_failed",
    );
  }
  if (!credential?.keypair || !credential.rpcUrl || !credential.apiUrl) {
    throw new SolanaPerpsExecutionError("solana perps execution vault is unavailable", 400, "venue_access_required");
  }
  if (instruction.operation_class !== "perp_limit_order") {
    throw new SolanaPerpsExecutionError("solana perps live pilot only supports tiny-fill orders", 400);
  }
  const order = instruction.order || {};
  if (liveMode !== "full_ticket" && (order.live_order_mode !== "tiny_fill" || order.tif !== "Ioc")) {
    throw new SolanaPerpsExecutionError("solana perps live order must use tiny_fill IOC mode", 400);
  }
  if (liveMode === "full_ticket" && order.post_only === true) {
    throw new SolanaPerpsExecutionError("phoenix post-only submit is not enabled yet", 400, "venue_rejected");
  }
  const notional = estimateOrderNotionalUsd(order);
  const cap = liveMode === "full_ticket"
    ? Math.min(
      capUsd(process.env.PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD, 0),
      capUsd(process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD || process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 1_000),
    )
    : Math.min(capUsd(process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD, 50), 50);
  if (liveMode === "full_ticket" && cap <= 0) {
    throw new SolanaPerpsExecutionError("solana perps full-ticket max notional is not configured", 400);
  }
  const slippage = Number.parseInt(order.max_slippage_bps || "50", 10);
  const maxSlippage = Math.min(
    capBps(
      process.env.PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS,
      100,
    ),
    100,
  );
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > maxSlippage) {
    throw new SolanaPerpsExecutionError("solana perps slippage is outside policy", 400, "venue_rejected");
  }
  if (notional <= 0) {
    throw new SolanaPerpsExecutionError("solana perps live order notional must be positive", 400);
  }
  if (notional > cap) {
    throw new SolanaPerpsExecutionError("solana perps live order exceeds live notional cap", 400);
  }
}

function assertBackpackLiveEnabled(instruction, credential) {
  const liveMode = process.env.PRIVATE_AGENT_BACKPACK_LIVE_MODE ||
    process.env.GHOLA_BACKPACK_LIVE_MODE ||
    "disabled";
  if (liveMode !== "tiny_live" && liveMode !== "full_ticket") {
    throw new SolanaPerpsExecutionError("backpack live submit is disabled", 503, "connector_submit_failed");
  }
  if (!credential?.apiKey || !credential.privateSeed || !credential.apiUrl) {
    throw new SolanaPerpsExecutionError("backpack execution credentials are unavailable", 400, "venue_access_required");
  }
  if (instruction.operation_class !== "perp_limit_order" && instruction.operation_class !== "cancel") {
    throw new SolanaPerpsExecutionError("backpack live pilot only supports perp limit orders and cancels", 400);
  }
  if (instruction.operation_class === "cancel") return;
  const order = instruction.order || {};
  const symbol = backpackSymbol(order.market);
  const allowedSymbols = (credential.allowedSymbols || []).map((item) => String(item).toUpperCase());
  if (!allowedSymbols.includes(symbol)) {
    throw new SolanaPerpsExecutionError("backpack symbol is outside policy", 400, "venue_rejected");
  }
  if (liveMode !== "full_ticket" && (order.live_order_mode !== "tiny_fill" || !/^ioc$/i.test(String(order.tif || "")))) {
    throw new SolanaPerpsExecutionError("backpack live order must use tiny_live IOC mode", 400);
  }
  if (order.post_only === true && credential.postOnlyMarketMaking !== true) {
    throw new SolanaPerpsExecutionError("backpack post-only market making is disabled", 400, "venue_rejected");
  }
  const notional = estimateOrderNotionalUsd(order);
  const cap = Math.min(
    positiveNumber(credential.maxOrderNotionalUsd, 5),
    capUsd(process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD || process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 5),
    5,
  );
  if (notional <= 0) {
    throw new SolanaPerpsExecutionError("backpack live order notional must be positive", 400);
  }
  if (notional > cap) {
    throw new SolanaPerpsExecutionError("backpack live order exceeds live notional cap", 400);
  }
  const slippage = Number.parseInt(order.max_slippage_bps || "25", 10);
  const maxSlippage = Math.min(
    capBps(
      process.env.PRIVATE_AGENT_BACKPACK_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_BACKPACK_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS,
      25,
    ),
    25,
  );
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > maxSlippage) {
    throw new SolanaPerpsExecutionError("backpack slippage is outside policy", 400, "venue_rejected");
  }
}

async function runPhoenixLiveOrder({ credential, instruction, clientOrderId }) {
  const order = instruction.order;
  const client = createPhoenixClient({
    apiUrl: credential.apiUrl,
    rpcUrl: credential.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  const transactionClient = Object.assign(client, {
    sendAndConfirmFromInstruction: async (ix, options = {}) =>
      sendAndConfirmPhoenixInstruction({
        credential,
        ix,
        commitment: options.commitment || "confirmed",
        priorityFee: options.priorityFee,
      }),
  });
  try {
    await client.exchange.ready();
    const packet = await buildPhoenixOrderPacket({ client, order, clientOrderId });
    const place = order.order_type === "limit" && order.live_order_mode !== "tiny_fill"
      ? placeLimitOrder
      : placeMarketOrder;
    const signature = await place(
      transactionClient,
      {
        authority: credential.authority,
        symbol: order.market,
        orderPacket: packet,
      },
      {
        traderPdaIndex: credential.traderPdaIndex,
        traderSubaccountIndex: credential.traderSubaccountIndex,
        commitment: "confirmed",
      },
    );
    return { status: "submitted", signature };
  } finally {
    client.dispose?.();
  }
}

async function runBackpackLiveOrder({ credential, instruction, clientOrderId }) {
  if (instruction.operation_class === "cancel") {
    const body = {
      symbol: backpackSymbol(instruction.cancel?.market || instruction.order?.market),
      ...(instruction.cancel?.order_id ? { orderId: String(instruction.cancel.order_id) } : {}),
      ...(instruction.cancel?.client_id ? { clientId: Number(instruction.cancel.client_id) } : {}),
    };
    const result = await backpackRequest({
      credential,
      instruction: "orderCancel",
      method: "DELETE",
      path: "/api/v1/order",
      params: body,
      body,
    });
    return { status: "cancelled", provider_order_id: result?.id || result?.orderId || null };
  }
  const order = backpackOrderRequest(instruction.order || {}, clientOrderId);
  const result = await backpackRequest({
    credential,
    instruction: "orderExecute",
    method: "POST",
    path: "/api/v1/order",
    params: order,
    body: order,
  });
  return { status: "submitted", provider_order_id: result?.id || result?.orderId || null };
}

async function checkBackpackNoSubmit({ credential, instruction, clientOrderId }) {
  if (instruction.operation_class === "cancel") {
    backpackSignedHeaders({
      credential,
      instruction: "orderCancel",
      params: {
        symbol: backpackSymbol(instruction.cancel?.market || instruction.order?.market),
      },
    });
  } else {
    const order = backpackOrderRequest(instruction.order || {}, clientOrderId);
    backpackSignedHeaders({ credential, instruction: "orderExecute", params: order });
  }
  if (process.env.PRIVATE_AGENT_BACKPACK_NO_SUBMIT_LOCAL_CHECKS === "true") {
    return {
      backpack_checked: true,
      order_packet_checked: true,
    };
  }
  await backpackRequest({
    credential,
    instruction: "accountQuery",
    method: "GET",
    path: "/api/v1/account",
    params: {},
  });
  return {
    backpack_checked: true,
    order_packet_checked: true,
  };
}

function backpackOrderRequest(order, clientOrderId) {
  const price = Number.parseFloat(order.limit_price || "");
  const request = {
    symbol: backpackSymbol(order.market),
    side: order.side === "sell" ? "Ask" : "Bid",
    orderType: "Limit",
    quantity: order.base_size ? trimDecimal(Number.parseFloat(order.base_size)) : orderBaseUnits(order, order.limit_price),
    price: Number.isFinite(price) && price > 0 ? trimDecimal(price) : undefined,
    postOnly: order.post_only === true,
    timeInForce: backpackTimeInForce(order.tif),
    selfTradePrevention: "RejectTaker",
    clientId: clientOrderIdNumber(clientOrderId),
  };
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined && value !== ""));
}

async function backpackRequest({ credential, instruction, method, path, params = {}, body = null }) {
  const response = await fetch(`${credential.apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...backpackSignedHeaders({ credential, instruction, params }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SolanaPerpsExecutionError(
      `backpack api request failed with ${response.status}`,
      response.status === 401 || response.status === 403 ? 400 : 502,
      response.status === 401 || response.status === 403 ? "venue_access_required" : "connector_submit_failed",
    );
  }
  return responseBody;
}

function backpackSignedHeaders({ credential, instruction, params = {}, timestamp = Date.now(), windowMs = 5_000 }) {
  const normalizedWindow = normalizeBackpackWindow(windowMs);
  const signingString = backpackSigningString({ instruction, params, timestamp, windowMs: normalizedWindow });
  const signature = ed25519.sign(new TextEncoder().encode(signingString), credential.privateSeed);
  return {
    "X-API-Key": credential.apiKey,
    "X-Signature": Buffer.from(signature).toString("base64"),
    "X-Timestamp": String(timestamp),
    "X-Window": String(normalizedWindow),
  };
}

function backpackSigningString({ instruction, params, timestamp, windowMs }) {
  const prefix = `instruction=${instruction}`;
  const query = orderedQuery(params || {});
  return `${prefix}${query ? `&${query}` : ""}&timestamp=${timestamp}&window=${windowMs}`;
}

function orderedQuery(value) {
  return Object.entries(value || {})
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(queryValue(item))}`)
    .join("&");
}

function queryValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value);
}

function normalizeBackpackWindow(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return 5_000;
  return Math.min(60_000, Math.max(1_000, parsed));
}

function backpackSymbol(value) {
  const raw = stringValue(value).toUpperCase();
  if (
    raw === "" ||
    raw === "SOL" ||
    raw === "SOL-USD" ||
    raw === "SOL/USDC" ||
    raw === "SOL-PERP" ||
    raw === BACKPACK_SOL_PERP_SYMBOL
  ) {
    return BACKPACK_SOL_PERP_SYMBOL;
  }
  throw new SolanaPerpsExecutionError("backpack symbol is unsupported", 400, "venue_rejected");
}

function backpackTimeInForce(value) {
  const raw = stringValue(value).toUpperCase();
  if (raw === "GTC" || raw === "GTC_POST_ONLY" || raw === "ALO") return "GTC";
  if (raw === "FOK") return "FOK";
  return "IOC";
}

function clientOrderIdNumber(value) {
  const hex = createHash("sha256").update(String(value || "backpack")).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16);
}

async function sendAndConfirmPhoenixInstruction({ credential, ix, commitment, priorityFee }) {
  const connection = new Connection(credential.rpcUrl, commitment);
  const transaction = new Transaction();
  const microLamports = Number.isInteger(priorityFee) && priorityFee > 0
    ? priorityFee
    : credential.priorityFeeMicroLamports;
  if (microLamports > 0) {
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  const instructions = Array.isArray(ix) ? ix : [ix];
  for (const instruction of instructions) {
    transaction.add(toWeb3Instruction(instruction));
  }
  const latest = await connection.getLatestBlockhash(commitment);
  transaction.feePayer = credential.keypair.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(credential.keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    preflightCommitment: commitment,
    skipPreflight: false,
  });
  const confirmed = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, commitment);
  if (confirmed.value.err) {
    throw new SolanaPerpsExecutionError("solana perps transaction was rejected", 422, "venue_rejected");
  }
  return signature;
}

function toWeb3Instruction(instruction) {
  if (!instruction?.programAddress) {
    throw new SolanaPerpsExecutionError("phoenix instruction is invalid", 502);
  }
  return new TransactionInstruction({
    programId: new PublicKey(String(instruction.programAddress)),
    keys: (instruction.accounts || []).map((account) => ({
      pubkey: new PublicKey(String(account.address)),
      isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(instruction.data || []),
  });
}

function keypairFromSecret(value) {
  const bytes = secretBytes(value);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new SolanaPerpsExecutionError("solana perps wallet key must be 32-byte seed or 64-byte secret key", 400, "venue_access_required");
}

function secretBytes(value) {
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item)));
  const text = stringValue(value);
  if (!text) {
    throw new SolanaPerpsExecutionError("solana perps wallet key is missing", 400, "venue_access_required");
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((item) => Number(item)));
    } catch {
      throw new SolanaPerpsExecutionError("solana perps wallet key JSON is invalid", 400, "venue_access_required");
    }
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex) || /^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    return Uint8Array.from(Buffer.from(cleanHex, "hex"));
  }
  try {
    return bs58.decode(text);
  } catch {
    throw new SolanaPerpsExecutionError("solana perps wallet key encoding is unsupported", 400, "venue_access_required");
  }
}

async function buildPhoenixOrderPacket({ client, order, clientOrderId }) {
  if (order.post_only === true) {
    throw new SolanaPerpsExecutionError("phoenix post-only order packet is not enabled yet", 400, "venue_rejected");
  }
  if (order.order_type === "limit" && order.live_order_mode !== "tiny_fill") {
    return client.orderPackets.buildLimitOrderPacket({
      symbol: order.market,
      side: order.side === "buy" ? Side.Bid : Side.Ask,
      baseUnits: orderBaseUnits(order, order.limit_price),
      priceUsd: order.limit_price,
      clientOrderId: clientOrderIdBigInt(clientOrderId),
    });
  }
  const priceLimitUsd = order.limit_price;
  if (!priceLimitUsd) {
    throw new SolanaPerpsExecutionError("phoenix market order requires a price limit", 400, "venue_rejected");
  }
  return client.orderPackets.buildMarketOrderPacket({
    symbol: order.market,
    side: order.side === "buy" ? Side.Bid : Side.Ask,
    baseUnits: orderBaseUnits(order, priceLimitUsd),
    priceLimitUsd,
    clientOrderId: clientOrderIdBigInt(clientOrderId),
  });
}

function orderBaseUnits(order, priceLimitUsd = order.limit_price) {
  if (order.base_size) return order.base_size;
  const quote = Number.parseFloat(order.quote_size || "");
  const price = Number.parseFloat(priceLimitUsd || "");
  if (Number.isFinite(quote) && Number.isFinite(price) && quote > 0 && price > 0) {
    return trimDecimal(quote / price);
  }
  throw new SolanaPerpsExecutionError("solana perps order requires base size or quote size with price", 400);
}

function estimateOrderNotionalUsd(order) {
  const quote = Number.parseFloat(order.quote_size || "");
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number.parseFloat(order.base_size || "");
  const price = Number.parseFloat(order.limit_price || "");
  if (Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0) return base * price;
  return 0;
}

function clientOrderIdBigInt(value) {
  const hex = createHash("sha256").update(String(value || "phoenix")).digest("hex").slice(0, 15);
  return BigInt(`0x${hex}`);
}

function safeSolanaPerpsError(error) {
  if (error instanceof SolanaPerpsExecutionError) return error;
  const message = String(error?.message || "solana perps live submit failed");
  if (/401|403|auth|access|invite|permission|unauthorized/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps venue access was rejected", 400, "venue_access_required");
  }
  if (/insufficient|not enough|funds|lamports|balance/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps account needs funds", 402, "needs_funds");
  }
  if (/insufficient|simulation|blockhash|rejected|failed/i.test(message)) {
    return new SolanaPerpsExecutionError("solana perps venue rejected the transaction", 422, "venue_rejected");
  }
  return new SolanaPerpsExecutionError("solana perps live submit failed", 502, "connector_submit_failed");
}

function statusForOperation(operationClass) {
  if (operationClass === "cancel") return "cancelled";
  if (operationClass === "fills" || operationClass === "reconcile") return "reconciled";
  if (operationClass === "read") return "previewed";
  return "submitted";
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function integerValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function backpackPrivateSeed(value) {
  const text = stringValue(value);
  if (!text) return null;
  try {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length === 32) return new Uint8Array(bytes);
    if (bytes.length === 64) return new Uint8Array(bytes.subarray(0, 32));
  } catch {
    // Try hex below.
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex)) return new Uint8Array(Buffer.from(cleanHex, "hex"));
  if (/^[0-9a-fA-F]{128}$/.test(cleanHex)) return new Uint8Array(Buffer.from(cleanHex, "hex").subarray(0, 32));
  return null;
}

function readPooledVaultPath(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new SolanaPerpsExecutionError("pooled Phoenix trading authority file is unreadable", 503, "venue_access_required");
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function trimDecimal(value) {
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
