import { createPrivateKey, randomBytes, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const LIVE_BASE_URL = "https://api.coinbase.com/api/v3/brokerage";
const SANDBOX_BASE_URL = "https://api-sandbox.coinbase.com/api/v3/brokerage";

export class CoinbaseExecutionError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "CoinbaseExecutionError";
    this.status = status;
  }
}

export function coinbaseCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new CoinbaseExecutionError("coinbase execution vault is invalid", 400);
  }
  if (vault.kind !== "ghola_coinbase_advanced_execution_vault") {
    throw new CoinbaseExecutionError("coinbase execution vault kind is invalid", 400);
  }
  if (!vault.api_key_name || !vault.api_private_key_pem) {
    throw new CoinbaseExecutionError("coinbase execution credentials are missing", 400);
  }
  return {
    network: vault.network === "sandbox" ? "sandbox" : "mainnet",
    base_url: safeCoinbaseBaseUrl(vault.base_url, vault.network),
    api_key_name: vault.api_key_name,
    api_private_key_pem: vault.api_private_key_pem,
    portfolio_id: vault.portfolio_id || null,
    execution_mode: vault.execution_mode || "byo_api_key",
  };
}

export function loadPartnerCoinbaseCredential(env = process.env) {
  const inline = env.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON;
  const path = env.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH;
  if (!inline && !path) {
    throw new CoinbaseExecutionError("partner coinbase pool credential is unavailable", 503);
  }
  let parsed;
  try {
    if (inline) {
      parsed = JSON.parse(inline);
    } else {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    }
  } catch {
    throw new CoinbaseExecutionError("partner coinbase pool credential is invalid", 503);
  }
  return coinbaseCredentialFromVault({
    kind: "ghola_coinbase_advanced_execution_vault",
    network: parsed.network || env.PRIVATE_AGENT_COINBASE_NETWORK || "mainnet",
    base_url: parsed.base_url,
    execution_mode: "partner_omnibus",
    api_key_name: parsed.api_key_name,
    api_private_key_pem: parsed.api_private_key_pem,
    portfolio_id: parsed.portfolio_id || null,
  });
}

export function buildCoinbaseJwt({ credential, method, pathWithQuery, now = new Date() }) {
  const base = new URL(credential.base_url || LIVE_BASE_URL);
  const hostname = base.host;
  const requestUri = `${method.toUpperCase()} ${hostname}${pathWithQuery}`;
  const iat = Math.floor(now.getTime() / 1000);
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: credential.api_key_name,
    nonce: randomBytes(16).toString("hex"),
  };
  const payload = {
    iss: "cdp",
    nbf: iat,
    exp: iat + 120,
    sub: credential.api_key_name,
    uri: requestUri,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = createPrivateKey(credential.api_private_key_pem);
  const signature = createSign("SHA256")
    .update(signingInput)
    .end()
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64Url(signature)}`;
}

export async function assertCoinbaseKeyPermissions(credential, fetchImpl = fetch) {
  const body = await coinbaseRequest({
    credential,
    method: "GET",
    path: "/key_permissions",
    fetchImpl,
  });
  if (body.can_view !== true || body.can_trade !== true) {
    throw new CoinbaseExecutionError("coinbase key must have view and trade permissions", 403);
  }
  if (body.can_transfer === true) {
    throw new CoinbaseExecutionError("coinbase transfer-enabled keys are blocked in v1", 403);
  }
  if (credential.portfolio_id && body.portfolio_uuid && credential.portfolio_id !== body.portfolio_uuid) {
    throw new CoinbaseExecutionError("coinbase key portfolio mismatch", 403);
  }
  return {
    can_view: true,
    can_trade: true,
    can_transfer: false,
    portfolio_commitment_seed: body.portfolio_uuid || credential.portfolio_id || "default",
  };
}

export async function submitCoinbaseExecution({
  credential,
  instruction,
  clientOrderId,
  fetchImpl = fetch,
}) {
  assertCoinbaseLiveEnabled(credential, instruction);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await assertCoinbaseKeyPermissions(credential, fetchImpl);
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: instruction.operation_class === "cancel"
        ? "cancelled"
        : instruction.operation_class === "preview_order"
          ? "previewed"
          : instruction.operation_class === "reconcile" || instruction.operation_class === "fills"
            ? "reconciled"
            : "submitted",
      provider_ref_seed: {
        venue: "coinbase_advanced",
        client_order_id: clientOrderId,
        dry_run: true,
      },
      result_seed: {
        kind: "coinbase_dry_run",
        product_id: instruction.order?.market || instruction.cancel?.market || null,
      },
      fills: [],
    };
  }
  if (instruction.operation_class === "cancel") {
    const cancel = instruction.cancel;
    const orderIds = [cancel.order_id || cancel.client_order_id].filter(Boolean);
    const body = await coinbaseRequest({
      credential,
      method: "POST",
      path: "/orders/batch_cancel",
      body: { order_ids: orderIds },
      fetchImpl,
    });
    return {
      status: "cancelled",
      provider_ref_seed: { venue: "coinbase_advanced", client_order_id: clientOrderId, cancel: orderIds },
      result_seed: { kind: "coinbase_cancel", success_count: Array.isArray(body.results) ? body.results.length : 0 },
    };
  }
  if (instruction.operation_class === "fills" || instruction.operation_class === "reconcile") {
    return reconcileCoinbaseExecution({ credential, instruction, clientOrderId, fetchImpl });
  }
  const payload = buildCoinbaseOrderPayload(instruction, clientOrderId, credential);
  if (instruction.operation_class === "preview_order") {
    const preview = await coinbaseRequest({
      credential,
      method: "POST",
      path: "/orders/preview",
      body: payload,
      fetchImpl,
    });
    return {
      status: "previewed",
      provider_ref_seed: {
        venue: "coinbase_advanced",
        client_order_id: clientOrderId,
        preview_id: preview.preview_id || null,
      },
      result_seed: { kind: "coinbase_preview", preview_id: preview.preview_id || null },
    };
  }
  const body = await coinbaseRequest({
    credential,
    method: "POST",
    path: "/orders",
    body: payload,
    fetchImpl,
  });
  const orderId = body.order_id || body.success_response?.order_id || null;
  if (
    body.success !== false &&
    orderId &&
    instruction.operation_class === "spot_market_order" &&
    process.env.PRIVATE_AGENT_COINBASE_RECONCILE_AFTER_SUBMIT !== "false"
  ) {
    return reconcileSubmittedCoinbaseOrder({
      credential,
      instruction,
      clientOrderId,
      orderId,
      fetchImpl,
    });
  }
  return {
    status: body.success === false ? "failed" : "submitted",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: clientOrderId,
      order_id: orderId,
    },
    result_seed: {
      kind: "coinbase_order",
      success: body.success !== false,
      product_id: payload.product_id,
    },
  };
}

async function reconcileSubmittedCoinbaseOrder({ credential, instruction, clientOrderId, orderId, fetchImpl }) {
  const attempts = boundedInt(process.env.PRIVATE_AGENT_COINBASE_RECONCILE_ATTEMPTS, 1, 10, 5);
  const intervalMs = boundedInt(process.env.PRIVATE_AGENT_COINBASE_RECONCILE_INTERVAL_MS, 0, 1_000, 100);
  let order = null;
  let reconciliationError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await coinbaseRequest({
        credential,
        method: "GET",
        path: `/orders/historical/${encodeURIComponent(orderId)}`,
        fetchImpl,
      });
      order = response?.order || null;
      if (coinbaseOrderTerminal(order)) break;
    } catch (error) {
      reconciliationError = String(error?.message || "coinbase_order_reconcile_failed");
      break;
    }
    if (attempt + 1 < attempts && intervalMs > 0) await delay(intervalMs);
  }
  const returnedOrderId = typeof order?.order_id === "string" ? order.order_id : null;
  const returnedClientOrderId = typeof order?.client_order_id === "string" ? order.client_order_id : null;
  const expectedProductId = typeof instruction.order?.market === "string" ? instruction.order.market : null;
  const targetOrderMatched = returnedOrderId === orderId;
  const targetClientOrderMatched = returnedClientOrderId === clientOrderId;
  const targetProductMatched = expectedProductId !== null && order?.product_id === expectedProductId;
  const exactTargetMatched = targetOrderMatched && targetClientOrderMatched && targetProductMatched;
  const terminal = exactTargetMatched && coinbaseOrderTerminal(order);
  const completion = Number.parseFloat(String(order?.completion_percentage ?? "0"));
  const filledSize = decimalNumber(order?.filled_size);
  const reportedFilledValue = Number.parseFloat(String(order?.filled_value ?? ""));
  const averageFilledPrice = Number.parseFloat(String(order?.average_filled_price ?? ""));
  const filledValue = Number.isFinite(reportedFilledValue) && reportedFilledValue >= 0
    ? reportedFilledValue
    : Number.isFinite(averageFilledPrice) && averageFilledPrice > 0
      ? filledSize * averageFilledPrice
      : 0;
  const fullFill = terminal && order?.status === "FILLED" && completion >= 99.999 && filledSize > 0;
  const filledNotionalMicro = Math.max(0, Math.round(filledValue * 1_000_000));
  const fills = filledSize > 0 ? [{
    trade_id: order?.order_id || orderId,
    product_id: order?.product_id || instruction.order?.market || null,
    size: String(order.filled_size),
    price: order?.average_filled_price || null,
    fee: order?.total_fees || order?.fee || null,
  }] : [];
  return {
    status: !exactTargetMatched
      ? "outcome_unknown"
      : fullFill
        ? "filled"
        : terminal
          ? (filledSize > 0 ? "partially_filled" : "unfilled")
          : "submitted",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: returnedClientOrderId,
      order_id: returnedOrderId,
    },
    result_seed: {
      kind: "coinbase_order_reconciliation",
      order_status: order?.status || "UNKNOWN",
      completion_percentage: Number.isFinite(completion) ? completion : 0,
      product_id: order?.product_id || instruction.order?.market || null,
      reconciliation_error: reconciliationError,
    },
    fills,
    final_proof: {
      version: 1,
      proof_kind: "coinbase_advanced_order_state_v1",
      status: fullFill ? "filled" : terminal ? "terminal" : "outcome_unknown",
      venue_id: "coinbase_advanced",
      broadcast_performed: true,
      target_order_matched: targetOrderMatched,
      target_client_order_matched: targetClientOrderMatched,
      target_product_matched: targetProductMatched,
      original_order_target_matched: exactTargetMatched,
      final_venue_execution_proven: terminal,
      final_fill_proven: fullFill,
      cumulative_filled_micro_usdc: filledNotionalMicro,
      filled_base_size: filledSize > 0 ? String(order.filled_size) : null,
      average_filled_price: order?.average_filled_price || null,
      checked_at: new Date().toISOString(),
    },
  };
}

async function locateCoinbaseOrderByClientOrderId({
  credential,
  clientOrderId,
  productId,
  fetchImpl,
}) {
  if (!clientOrderId || !productId) return null;
  let cursor = null;
  const seenCursors = new Set();
  const matches = [];
  for (let page = 0; page < 3; page += 1) {
    const query = new URLSearchParams({
      product_ids: productId,
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await coinbaseRequest({
      credential,
      method: "GET",
      path: `/orders/historical/batch?${query.toString()}`,
      fetchImpl,
    });
    const orders = Array.isArray(response?.orders) ? response.orders : [];
    matches.push(...orders.filter((order) =>
      order?.client_order_id === clientOrderId && order?.product_id === productId));
    if (matches.length > 1) return null;
    const nextCursor = typeof response?.cursor === "string" ? response.cursor : "";
    if (response?.has_next !== true || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return matches.length === 1 && typeof matches[0]?.order_id === "string" ? matches[0] : null;
}

function unknownTargetedCoinbaseReconciliation({ clientOrderId, productId }) {
  return {
    status: "outcome_unknown",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: clientOrderId || null,
      order_id: null,
    },
    result_seed: {
      kind: "coinbase_order_reconciliation",
      order_status: "UNKNOWN",
      product_id: productId || null,
      reconciliation_error: "exact_client_order_not_found",
    },
    fills: [],
    final_proof: {
      version: 1,
      proof_kind: "coinbase_advanced_order_state_v1",
      status: "outcome_unknown",
      venue_id: "coinbase_advanced",
      broadcast_performed: true,
      target_order_matched: false,
      target_client_order_matched: false,
      target_product_matched: false,
      original_order_target_matched: false,
      final_venue_execution_proven: false,
      final_fill_proven: false,
      cumulative_filled_micro_usdc: 0,
      checked_at: new Date().toISOString(),
    },
  };
}

export async function verifyCoinbaseNoSubmit({
  credential,
  instruction,
  clientOrderId,
  fetchImpl = fetch,
}) {
  assertCoinbaseLiveEnabled(credential, instruction);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await assertCoinbaseKeyPermissions(credential, fetchImpl);
  }
  const payload = instruction.order
    ? buildCoinbaseOrderPayload(instruction, clientOrderId, credential)
    : null;
  return {
    status: "verified_no_funds",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: clientOrderId,
      no_submit: true,
    },
    result_seed: {
      kind: "coinbase_no_submit",
      product_id: payload?.product_id || instruction.cancel?.market || null,
      order_request_built: Boolean(payload || instruction.cancel || instruction.reconcile),
    },
    checks: {
      coinbase_api_reachable: true,
      coinbase_order_request_built: Boolean(payload || instruction.cancel || instruction.reconcile),
      transaction_broadcast: false,
    },
  };
}

function assertCoinbaseLiveEnabled(credential, instruction) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") return;
  if (process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE !== "full") {
    throw new CoinbaseExecutionError("coinbase live submit is disabled", 503);
  }
  if (credential?.network !== "mainnet" && credential?.network !== "sandbox") {
    throw new CoinbaseExecutionError("coinbase execution network is unsupported", 400);
  }
  const allowed = new Set(["preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"]);
  if (!allowed.has(instruction.operation_class)) {
    throw new CoinbaseExecutionError("coinbase operation is unsupported", 400);
  }
  if (!instruction.order) return;
  const productId = String(instruction.order.market || "").trim().toUpperCase();
  const productAllowlist = coinbaseProductAllowlist();
  if (productAllowlist.size > 0 && !productAllowlist.has(productId)) {
    throw new CoinbaseExecutionError("coinbase product is outside allowlist", 400);
  }
  if (productAllowlist.size === 0 && process.env.NODE_ENV === "production") {
    throw new CoinbaseExecutionError("coinbase product allowlist is not configured", 503);
  }
  const notional = estimateCoinbaseNotionalUsd(instruction.order);
  const maxNotional = Math.min(
    capUsd(
      process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD ||
        process.env.GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD,
      1_000,
    ),
    capUsd(process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD || process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 1_000),
  );
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new CoinbaseExecutionError("coinbase live order notional must be positive", 400);
  }
  if (notional > maxNotional && instruction.order.reduce_only !== true) {
    throw new CoinbaseExecutionError("coinbase live order exceeds notional cap", 400);
  }
}

export async function reconcileCoinbaseExecution({ credential, instruction, clientOrderId, fetchImpl = fetch }) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await assertCoinbaseKeyPermissions(credential, fetchImpl);
  }
  const product = instruction.order?.market || instruction.cancel?.market || instruction.reconcile?.product_id || null;
  let targetOrderId = instruction.reconcile?.target_order_id;
  const targetClientOrderId = instruction.reconcile?.target_client_order_id || clientOrderId;
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: "outcome_unknown",
      provider_ref_seed: {
        venue: "coinbase_advanced",
        client_order_id: instruction.reconcile?.target_client_order_id || clientOrderId,
        order_id: targetOrderId || null,
        dry_run: true,
      },
      result_seed: { kind: "coinbase_reconcile_dry_run", product_id: product },
      fills: [],
      final_proof: {
        version: 1,
        proof_kind: "coinbase_advanced_order_state_v1",
        status: "outcome_unknown",
        venue_id: "coinbase_advanced",
        broadcast_performed: false,
        final_venue_execution_proven: false,
        final_fill_proven: false,
        checked_at: new Date().toISOString(),
      },
    };
  }
  if (instruction.reconcile?.target_work_order_commitment && !targetOrderId) {
    const located = await locateCoinbaseOrderByClientOrderId({
      credential,
      clientOrderId: targetClientOrderId,
      productId: product,
      fetchImpl,
    });
    targetOrderId = located?.order_id || null;
    if (!targetOrderId) {
      return unknownTargetedCoinbaseReconciliation({
        clientOrderId: targetClientOrderId,
        productId: product,
      });
    }
  }
  if (targetOrderId) {
    return reconcileSubmittedCoinbaseOrder({
      credential,
      instruction: {
        operation_class: "spot_market_order",
        order: { market: product },
      },
      clientOrderId: targetClientOrderId,
      orderId: targetOrderId,
      fetchImpl,
    });
  }
  const query = new URLSearchParams();
  if (product) query.set("product_id", product);
  const path = `/orders/historical/fills${query.size ? `?${query.toString()}` : ""}`;
  const body = await coinbaseRequest({ credential, method: "GET", path, fetchImpl });
  const fills = Array.isArray(body.fills) ? body.fills : [];
  return {
    status: "outcome_unknown",
    provider_ref_seed: { venue: "coinbase_advanced", client_order_id: clientOrderId, fills: fills.length },
    result_seed: {
      kind: "coinbase_reconcile",
      fills_count: fills.length,
      product_id: product,
    },
    fills: fills.slice(0, 25).map((fill) => ({
      trade_id: fill.trade_id || fill.order_id || fill.entry_id || null,
      product_id: fill.product_id || product,
      size: fill.size || fill.base_size || null,
      price: fill.price || null,
      fee: fill.commission || fill.fee || null,
    })),
    final_proof: {
      version: 1,
      proof_kind: "coinbase_advanced_order_state_v1",
      status: "outcome_unknown",
      venue_id: "coinbase_advanced",
      broadcast_performed: false,
      final_venue_execution_proven: false,
      final_fill_proven: false,
      checked_at: new Date().toISOString(),
    },
  };
}

function buildCoinbaseOrderPayload(instruction, clientOrderId, credential) {
  const order = instruction.order;
  const side = order.side === "buy" ? "BUY" : "SELL";
  const payload = {
    client_order_id: clientOrderId,
    product_id: order.market,
    side,
    order_configuration: {},
  };
  if (credential.portfolio_id) {
    payload.retail_portfolio_id = credential.portfolio_id;
  }
  if (instruction.operation_class === "spot_market_order") {
    payload.order_configuration.market_market_ioc = {
      ...coinbaseSizeFields(order),
    };
    if (order.protective_orders?.stop_loss || order.protective_orders?.take_profit) {
      payload.attached_order_configuration = {
        trigger_bracket_gtc: {
          ...(order.protective_orders.take_profit
            ? { limit_price: order.protective_orders.take_profit }
            : {}),
          ...(order.protective_orders.stop_loss
            ? { stop_trigger_price: order.protective_orders.stop_loss }
            : {}),
        },
      };
    }
    return payload;
  }
  const key = order.tif === "ioc"
    ? "sor_limit_ioc"
    : order.tif === "fok"
      ? "limit_limit_fok"
      : "limit_limit_gtc";
  payload.order_configuration[key] = {
    ...coinbaseSizeFields(order),
    limit_price: order.limit_price,
    ...(key === "limit_limit_gtc" ? { post_only: order.post_only === true } : {}),
    rfq_disabled: true,
  };
  if (order.protective_orders?.stop_loss || order.protective_orders?.take_profit) {
    payload.attached_order_configuration = {
      trigger_bracket_gtc: {
        ...(order.protective_orders.take_profit
          ? { limit_price: order.protective_orders.take_profit }
          : {}),
        ...(order.protective_orders.stop_loss
          ? { stop_trigger_price: order.protective_orders.stop_loss }
          : {}),
      },
    };
  }
  return payload;
}

function coinbaseSizeFields(order) {
  if (order.size_mode === "base" && order.base_size) return { base_size: order.base_size };
  if (order.quote_size) return { quote_size: order.quote_size };
  return order.base_size ? { base_size: order.base_size } : {};
}

async function coinbaseRequest({ credential, method, path, body, fetchImpl }) {
  const base = new URL(credential.base_url || LIVE_BASE_URL);
  const resourcePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`/api/v3/brokerage${resourcePath}`, base.origin);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const jwt = buildCoinbaseJwt({ credential, method, pathWithQuery });
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CoinbaseExecutionError(`coinbase request failed with ${res.status}`, 502);
  }
  return json;
}

function safeCoinbaseBaseUrl(baseUrl, network) {
  const fallback = network === "sandbox" ? SANDBOX_BASE_URL : LIVE_BASE_URL;
  if (!baseUrl) return fallback;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.origin !== "https://api.coinbase.com" &&
      parsed.origin !== "https://api-sandbox.coinbase.com"
    ) {
      return fallback;
    }
    return `${parsed.origin}/api/v3/brokerage`;
  } catch {
    return fallback;
  }
}

function coinbaseProductAllowlist() {
  const configured = process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS ||
    process.env.GHOLA_COINBASE_ALLOWED_PRODUCTS ||
    "";
  return new Set(
    configured
      .split(",")
      .map((product) => product.trim().toUpperCase())
      .filter(Boolean),
  );
}

function estimateCoinbaseNotionalUsd(order) {
  const base = Number.parseFloat(String(order.base_size || ""));
  const price = Number.parseFloat(String(order.limit_price || ""));
  if (
    order.size_mode === "base" &&
    Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0
  ) return base * price;
  const quote = Number.parseFloat(String(order.quote_size || ""));
  if (Number.isFinite(quote) && quote > 0) return quote;
  if (Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0) return base * price;
  return 0;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function coinbaseOrderTerminal(order) {
  return ["FILLED", "CANCELLED", "FAILED", "EXPIRED"].includes(String(order?.status || "").toUpperCase());
}

function decimalNumber(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
