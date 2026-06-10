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
  return {
    status: body.success === false ? "failed" : "submitted",
    provider_ref_seed: {
      venue: "coinbase_advanced",
      client_order_id: clientOrderId,
      order_id: body.order_id || body.success_response?.order_id || null,
    },
    result_seed: {
      kind: "coinbase_order",
      success: body.success !== false,
      product_id: payload.product_id,
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
  if (notional > maxNotional) {
    throw new CoinbaseExecutionError("coinbase live order exceeds notional cap", 400);
  }
}

export async function reconcileCoinbaseExecution({ credential, instruction, clientOrderId, fetchImpl = fetch }) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await assertCoinbaseKeyPermissions(credential, fetchImpl);
  }
  const product = instruction.order?.market || instruction.cancel?.market || instruction.reconcile?.product_id || null;
  const query = new URLSearchParams();
  if (product) query.set("product_id", product);
  const path = `/orders/historical/fills${query.size ? `?${query.toString()}` : ""}`;
  const body = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
    ? { fills: [] }
    : await coinbaseRequest({ credential, method: "GET", path, fetchImpl });
  const fills = Array.isArray(body.fills) ? body.fills : [];
  return {
    status: "reconciled",
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
      ...(order.quote_size ? { quote_size: order.quote_size } : {}),
      ...(order.base_size ? { base_size: order.base_size } : {}),
    };
    return payload;
  }
  const key = order.tif === "ioc"
    ? "sor_limit_ioc"
    : order.tif === "fok"
      ? "limit_limit_fok"
      : "limit_limit_gtc";
  payload.order_configuration[key] = {
    ...(order.quote_size ? { quote_size: order.quote_size } : {}),
    ...(order.base_size ? { base_size: order.base_size } : {}),
    limit_price: order.limit_price,
    ...(key === "limit_limit_gtc" ? { post_only: order.post_only === true } : {}),
    rfq_disabled: true,
  };
  return payload;
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
  const quote = Number.parseFloat(String(order.quote_size || ""));
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number.parseFloat(String(order.base_size || ""));
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
