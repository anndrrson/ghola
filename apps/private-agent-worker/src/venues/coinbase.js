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
    const target = await resolveCoinbaseOrder({
      credential,
      orderId: cancel.order_id,
      clientOrderId: cancel.client_order_id,
      productId: cancel.market,
      fetchImpl,
    });
    if (!target?.order_id) {
      throw coinbaseRecoveryError(
        "coinbase cancel target could not be resolved exactly",
        "COINBASE_CANCEL_TARGET_UNRESOLVED",
        409,
      );
    }
    const orderIds = [target.order_id];
    const body = await coinbaseRequest({
      credential,
      method: "POST",
      path: "/orders/batch_cancel",
      body: { order_ids: orderIds },
      fetchImpl,
    });
    const result = Array.isArray(body.results)
      ? body.results.find((item) => item?.order_id === target.order_id)
      : null;
    if (!result || result.success !== true) {
      throw coinbaseRecoveryError(
        "coinbase did not accept the exact cancel request",
        "COINBASE_CANCEL_NOT_ACCEPTED",
        409,
      );
    }
    const reconciled = await reconcileCoinbaseExecution({
      credential,
      instruction: {
        operation_class: "reconcile",
        reconcile: { product_id: target.product_id || cancel.market || null },
      },
      clientOrderId: target.client_order_id || cancel.client_order_id,
      providerOrderId: target.order_id,
      fetchImpl,
    });
    if (reconciled.final_proof?.terminal_status !== "cancelled") {
      throw coinbaseRecoveryError(
        "coinbase cancellation is not terminal; reconciliation is required",
        "COINBASE_CANCEL_RECONCILIATION_REQUIRED",
        409,
      );
    }
    return {
      status: "cancelled",
      provider_ref_seed: {
        ...reconciled.provider_ref_seed,
        cancel: orderIds,
      },
      result_seed: {
        ...reconciled.result_seed,
        kind: "coinbase_cancel",
        success_count: 1,
      },
      fills: reconciled.fills,
      final_proof: {
        ...reconciled.final_proof,
        cancel_request_accepted: true,
      },
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
  if (body.success !== true || !safeIdentifier(orderId)) {
    const errorCode = safeIdentifier(body.error_response?.error) || "COINBASE_ORDER_REJECTED";
    throw coinbaseRecoveryError(
      "coinbase rejected the order before accepting it",
      errorCode,
      422,
    );
  }
  return {
    status: "submitted",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: clientOrderId,
      order_id: orderId,
    },
    result_seed: {
      kind: "coinbase_order",
      success: true,
      product_id: payload.product_id,
    },
    final_proof: {
      version: 1,
      proof_kind: "coinbase_create_order_acceptance_v1",
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: false,
      provider_order_id: orderId,
      client_order_id: clientOrderId,
      terminal_status: null,
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
  const sizeFields = instruction?.order
    ? coinbaseOrderSizeFields(instruction.order)
    : null;
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
  const notional = estimateCoinbaseNotionalUsd(instruction.order, sizeFields);
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
  if (notional > maxNotional) {
    throw new CoinbaseExecutionError("coinbase live order exceeds notional cap", 400);
  }
}

export async function reconcileCoinbaseExecution({
  credential,
  instruction,
  clientOrderId,
  providerOrderId = null,
  fetchImpl = fetch,
}) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await assertCoinbaseKeyPermissions(credential, fetchImpl);
  }
  const product = instruction.order?.market || instruction.cancel?.market || instruction.reconcile?.product_id || null;
  const order = await resolveCoinbaseOrder({
    credential,
    orderId: providerOrderId || instruction.cancel?.order_id,
    clientOrderId,
    productId: product,
    fetchImpl,
  });
  if (!order) {
    return {
      status: "reconcile_required",
      provider_ref_seed: {
        venue: "coinbase_advanced",
        client_order_id: clientOrderId,
        order_id: providerOrderId || null,
      },
      result_seed: {
        kind: "coinbase_reconcile",
        status: "unresolved",
        product_id: product,
      },
      fills: [],
      final_proof: {
        version: 1,
        proof_kind: "coinbase_order_state_v1",
        broadcast_performed: false,
        final_venue_execution_proven: false,
        final_fill_proven: false,
        provider_order_id: providerOrderId || null,
        client_order_id: clientOrderId,
        terminal_status: null,
        checked_at: new Date().toISOString(),
      },
    };
  }
  const query = new URLSearchParams();
  query.append("order_ids", order.order_id);
  const path = `/orders/historical/fills${query.size ? `?${query.toString()}` : ""}`;
  const body = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
    ? { fills: [] }
    : await coinbaseRequest({ credential, method: "GET", path, fetchImpl });
  const fills = Array.isArray(body.fills)
    ? body.fills.filter((fill) => fill?.order_id === order.order_id)
    : [];
  const terminalStatus = terminalCoinbaseOrderStatus(order.status);
  const fillsProven = terminalStatus !== null && coinbaseFillTotalMatches(order, fills);
  return {
    status: terminalStatus && fillsProven ? terminalStatus : terminalStatus ? "reconcile_required" : "submitted",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: order.client_order_id,
      order_id: order.order_id,
      fills: fills.length,
    },
    result_seed: {
      kind: "coinbase_reconcile",
      status: String(order.status || "UNKNOWN").toUpperCase(),
      fills_count: fills.length,
      product_id: order.product_id || product,
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
      proof_kind: "coinbase_order_state_v1",
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: fillsProven,
      provider_order_id: order.order_id,
      client_order_id: order.client_order_id,
      terminal_status: terminalStatus,
      venue_status: String(order.status || "UNKNOWN").toUpperCase(),
      filled_size: canonicalDecimal(order.filled_size || "0"),
      checked_at: new Date().toISOString(),
    },
  };
}

async function resolveCoinbaseOrder({ credential, orderId, clientOrderId, productId, fetchImpl }) {
  const exactOrderId = safeIdentifier(orderId);
  const exactClientOrderId = safeIdentifier(clientOrderId);
  if (exactOrderId) {
    const body = await coinbaseRequest({
      credential,
      method: "GET",
      path: `/orders/historical/${encodeURIComponent(exactOrderId)}`,
      fetchImpl,
    });
    return exactCoinbaseOrder(body.order, { exactOrderId, exactClientOrderId, productId });
  }
  if (!exactClientOrderId) return null;
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams();
    query.set("limit", "100");
    if (productId) query.append("product_ids", String(productId).toUpperCase());
    if (cursor) query.set("cursor", cursor);
    const body = await coinbaseRequest({
      credential,
      method: "GET",
      path: `/orders/historical/batch?${query.toString()}`,
      fetchImpl,
    });
    const matches = (Array.isArray(body.orders) ? body.orders : [])
      .filter((order) => order?.client_order_id === exactClientOrderId);
    if (matches.length > 1) {
      throw coinbaseRecoveryError(
        "coinbase returned multiple orders for one client order id",
        "COINBASE_CLIENT_ORDER_ID_COLLISION",
        409,
      );
    }
    if (matches[0]) {
      return exactCoinbaseOrder(matches[0], { exactClientOrderId, productId });
    }
    const next = safeIdentifier(body.cursor);
    if (!body.has_next || !next || next === cursor) break;
    cursor = next;
  }
  return null;
}

function exactCoinbaseOrder(order, { exactOrderId = null, exactClientOrderId = null, productId = null }) {
  if (!order || typeof order !== "object") return null;
  const orderId = safeIdentifier(order.order_id);
  const clientOrderId = safeIdentifier(order.client_order_id);
  const product = safeIdentifier(order.product_id)?.toUpperCase() || null;
  if (!orderId || !clientOrderId) return null;
  if (exactOrderId && orderId !== exactOrderId) return null;
  if (exactClientOrderId && clientOrderId !== exactClientOrderId) return null;
  if (productId && product !== String(productId).toUpperCase()) return null;
  return { ...order, order_id: orderId, client_order_id: clientOrderId, product_id: product };
}

function terminalCoinbaseOrderStatus(value) {
  const status = String(value || "").toUpperCase();
  if (status === "FILLED") return "filled";
  if (status === "CANCELLED") return "cancelled";
  if (status === "EXPIRED") return "expired";
  if (status === "FAILED") return "failed";
  return null;
}

function coinbaseFillTotalMatches(order, fills) {
  const expected = fixedDecimalUnits(order.filled_size || "0");
  if (expected == null) return false;
  let actual = 0n;
  for (const fill of fills) {
    const size = fixedDecimalUnits(fill?.size || fill?.base_size || "0");
    if (size == null) return false;
    actual += size;
  }
  return actual === expected;
}

function fixedDecimalUnits(value) {
  const canonical = canonicalDecimal(value);
  if (canonical == null) return null;
  const [whole, fraction = ""] = canonical.split(".");
  if (fraction.length > 18) return null;
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

function canonicalDecimal(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [wholeRaw, fractionRaw = ""] = text.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function safeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : null;
}

function coinbaseRecoveryError(message, code, status) {
  const error = new CoinbaseExecutionError(message, status);
  error.code = code;
  return error;
}

function buildCoinbaseOrderPayload(instruction, clientOrderId, credential) {
  const order = instruction.order;
  const sizeFields = coinbaseOrderSizeFields(order);
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
      ...sizeFields,
    };
    return payload;
  }
  const key = order.tif === "ioc"
    ? "sor_limit_ioc"
    : order.tif === "fok"
      ? "limit_limit_fok"
      : "limit_limit_gtc";
  payload.order_configuration[key] = {
    ...sizeFields,
    limit_price: order.limit_price,
    ...(key === "limit_limit_gtc" ? { post_only: order.post_only === true } : {}),
    rfq_disabled: true,
  };
  return payload;
}

function coinbaseOrderSizeFields(order) {
  const quoteSize = positiveDecimalText(order.quote_size);
  const baseSize = positiveDecimalText(order.base_size);
  const sizeMode = order.size_mode === "quote" || order.size_mode === "base"
    ? order.size_mode
    : quoteSize && !baseSize
      ? "quote"
      : baseSize && !quoteSize
        ? "base"
        : null;
  if (sizeMode === "quote" && quoteSize) return { quote_size: quoteSize };
  if (sizeMode === "base" && baseSize) return { base_size: baseSize };
  throw new CoinbaseExecutionError("coinbase order requires one authoritative size mode", 400);
}

function positiveDecimalText(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return text && Number.isFinite(parsed) && parsed > 0 ? text : null;
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

function estimateCoinbaseNotionalUsd(order, sizeFields) {
  const quote = Number.parseFloat(String(sizeFields?.quote_size || ""));
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number.parseFloat(String(sizeFields?.base_size || ""));
  const price = Number.parseFloat(String(order.limit_price || ""));
  if (Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0) return base * price;
  return 0;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
