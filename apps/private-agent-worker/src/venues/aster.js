import { privateKeyToAccount } from "viem/accounts";

const MAINNET_URL = "https://fapi.asterdex.com";
const DOMAIN = Object.freeze({
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000",
});
const TYPES = Object.freeze({ Message: Object.freeze([{ name: "msg", type: "string" }]) });
const CLIENT_ORDER_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/;
let lastNonce = 0n;

export class AsterExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed", details = null) {
    super(message);
    this.name = "AsterExecutionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asterCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object" || vault.kind !== "ghola_aster_execution_vault") {
    throw new AsterExecutionError("aster execution vault is invalid", 400, "venue_access_required");
  }
  const user = String(vault.user_address || "").toLowerCase();
  const signer = String(vault.signer_address || "").toLowerCase();
  const privateKey = String(vault.api_wallet_private_key || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(user) || !/^0x[0-9a-f]{40}$/.test(signer) || !/^0x[0-9a-f]{64}$/.test(privateKey)) {
    throw new AsterExecutionError("aster execution credentials are invalid", 400, "venue_access_required");
  }
  let derived;
  try {
    derived = privateKeyToAccount(privateKey).address.toLowerCase();
  } catch {
    throw new AsterExecutionError("aster API wallet key is invalid", 400, "venue_access_required");
  }
  if (derived !== signer) {
    throw new AsterExecutionError("aster signer does not match the API wallet key", 400, "venue_access_required");
  }
  return Object.freeze({
    network: "mainnet",
    base_url: MAINNET_URL,
    user_address: user,
    signer_address: signer,
    api_wallet_private_key: privateKey,
    authority_boundary: Object.freeze({
      venue_native_trade_only: true,
      withdrawal_request_permitted: false,
      transfer_request_permitted: false,
      owner_wallet_key_present: false,
      non_owner_fund_movement_possible: false,
    }),
  });
}

export function dryRunAsterCredential() {
  const key = `0x${"11".repeat(32)}`;
  return asterCredentialFromVault({
    kind: "ghola_aster_execution_vault",
    user_address: `0x${"22".repeat(20)}`,
    signer_address: privateKeyToAccount(key).address,
    api_wallet_private_key: key,
  });
}

export function assertAsterPilotMode(credential, operationClass, env = process.env) {
  if (credential?.network !== "mainnet") throw new AsterExecutionError("aster network is unsupported", 400, "venue_access_required");
  if (env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET !== "true") {
    throw new AsterExecutionError("aster mainnet is disabled", 400, "live_execution_disabled");
  }
  const mode = env.PRIVATE_AGENT_ASTER_LIVE_MODE || "disabled";
  if (operationClass === "read" || operationClass === "reconcile") {
    if (["read_only", "tiny_fill", "full_ticket"].includes(mode)) return;
  } else if (operationClass === "cancel") {
    if (["tiny_fill", "full_ticket"].includes(mode)) return;
  } else if (operationClass === "limit_order") {
    if (mode === "full_ticket") return;
  }
  throw new AsterExecutionError("aster operation is disabled", 400, "live_execution_disabled");
}

export async function verifyAsterNoSubmit({
  credential,
  instruction,
  clientOrderId,
  fetchImpl = fetch,
  now = () => Date.now(),
  env = process.env,
}) {
  assertAsterPilotMode(credential, "read", env);
  const order = normalizeAsterOrder(instruction, clientOrderId);
  const [serverTime, exchangeInfo] = await Promise.all([
    publicRequest({ credential, path: "/fapi/v3/time", fetchImpl }),
    publicRequest({ credential, path: "/fapi/v3/exchangeInfo", fetchImpl }),
  ]);
  const localNow = now();
  if (!Number.isFinite(Number(serverTime?.serverTime)) || Math.abs(Number(serverTime.serverTime) - localNow) > 4_000) {
    throw new AsterExecutionError("aster clock is outside the signing window", 400, "venue_clock_skew");
  }
  const market = exchangeInfo?.symbols?.find((item) => item?.symbol === order.symbol && item?.status === "TRADING");
  if (!market) throw new AsterExecutionError("aster market is unavailable", 422, "venue_rejected");
  validateMarketOrderShape(order, market);
  const account = await readAsterAccountState({ credential, symbol: order.symbol, fetchImpl, now, env });
  return {
    status: account.can_trade && account.available_balance > 0 ? "verified_ready" : "verified_no_funds",
    checks: {
      sdk_checked: true,
      signer_matches_key: true,
      market_data_checked: true,
      account_state_checked: true,
      order_request_checked: true,
      transaction_broadcast: false,
    },
    account,
    order,
    authority_boundary: credential.authority_boundary,
  };
}

export async function readAsterAccountState({
  credential,
  symbol = "BTCUSDT",
  fetchImpl = fetch,
  now = () => Date.now(),
  env = process.env,
}) {
  assertAsterPilotMode(credential, "read", env);
  const normalizedSymbol = asterSymbol(symbol);
  const [account, positions, openOrders, commission] = await Promise.all([
    signedRequest({ credential, method: "GET", path: "/fapi/v3/account", params: {}, fetchImpl, now }),
    signedRequest({ credential, method: "GET", path: "/fapi/v3/positionRisk", params: { symbol: normalizedSymbol }, fetchImpl, now }),
    signedRequest({ credential, method: "GET", path: "/fapi/v3/openOrders", params: { symbol: normalizedSymbol }, fetchImpl, now }),
    signedRequest({ credential, method: "GET", path: "/fapi/v3/commissionRate", params: { symbol: normalizedSymbol }, fetchImpl, now }),
  ]);
  return {
    can_trade: account?.canTrade === true,
    available_balance: decimal(account?.availableBalance),
    margin_balance: decimal(account?.totalMarginBalance),
    initial_margin: decimal(account?.totalInitialMargin),
    maintenance_margin: decimal(account?.totalMaintMargin),
    position_count: Array.isArray(positions) ? positions.filter((item) => decimal(item?.positionAmt) !== 0).length : 0,
    open_order_count: Array.isArray(openOrders) ? openOrders.length : 0,
    maker_fee_bps: rateToBps(commission?.makerCommissionRate),
    taker_fee_bps: rateToBps(commission?.takerCommissionRate),
    fee_source: "aster_account_commission_rate",
    fees_exact_for_account: true,
    fees_conservative_upper_bound: false,
  };
}

export async function readAsterFundingSettlements({
  credential,
  symbol,
  start_time_ms: startTimeMs,
  end_time_ms: endTimeMs = Date.now(),
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const start = Number(startTimeMs);
  const end = Number(endTimeMs);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end - start > 7 * 86_400_000) {
    throw new AsterExecutionError("aster funding window is invalid", 400, "venue_rejected");
  }
  const normalizedSymbol = asterSymbol(symbol);
  const rows = await signedRequest({
    credential,
    method: "GET",
    path: "/fapi/v1/income",
    params: { symbol: normalizedSymbol, incomeType: "FUNDING_FEE", startTime: start, endTime: end, limit: 1_000 },
    fetchImpl,
    now,
  });
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    venue_id: "aster",
    asset: normalizedSymbol.replace(/USDT$/, ""),
    occurred_at_ms: Number(row?.time),
    amount_quote: String(row?.income ?? ""),
    quote_asset: String(row?.asset || "USDT").toUpperCase(),
    settlement_id: String(row?.tranId ?? `${row?.time}:${normalizedSymbol}`),
  })).filter((row) => Number.isSafeInteger(row.occurred_at_ms) && /^-?\d+(?:\.\d+)?$/.test(row.amount_quote));
}

export async function submitAsterExecution({
  credential,
  instruction,
  clientOrderId,
  fetchImpl = fetch,
  now = () => Date.now(),
  env = process.env,
}) {
  assertAsterPilotMode(credential, instruction?.operation_class, env);
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return normalizedResult({
      clientOrderId,
      symbol: instruction?.order?.market || instruction?.cancel?.market,
      status: instruction?.operation_class === "cancel" ? "CANCELED" : "NEW",
      executedQty: "0",
    }, { dryRun: true, targetClientOrderId: clientOrderId });
  }
  if (instruction?.operation_class === "reconcile") {
    const symbol = asterSymbol(instruction.reconcile?.market || instruction.reconcile?.product_id);
    const target = instruction.reconcile?.target_client_order_id || clientOrderId;
    return normalizedResult(await signedRequest({
      credential,
      method: "GET",
      path: "/fapi/v3/order",
      params: { symbol, origClientOrderId: target },
      fetchImpl,
      now,
    }), { targetClientOrderId: target });
  }
  if (instruction?.operation_class === "cancel") {
    const symbol = asterSymbol(instruction.cancel?.market);
    const target = instruction.cancel?.client_order_id || clientOrderId;
    return normalizedResult(await signedRequest({
      credential,
      method: "DELETE",
      path: "/fapi/v3/order",
      params: { symbol, origClientOrderId: target },
      fetchImpl,
      now,
      ambiguousOnTransportFailure: true,
    }), { targetClientOrderId: target });
  }
  const order = normalizeAsterOrder(instruction, clientOrderId);
  return normalizedResult(await signedRequest({
    credential,
    method: "POST",
    path: "/fapi/v3/order",
    params: order,
    fetchImpl,
    now,
    ambiguousOnTransportFailure: true,
  }), { targetClientOrderId: clientOrderId });
}

export async function submitAndReconcileAsterExecution({
  credential,
  instruction,
  clientOrderId,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
}) {
  let submitted;
  let submissionResponseAmbiguous = false;
  try {
    submitted = await submitAsterExecution({ credential, instruction, clientOrderId, fetchImpl, now, env });
  } catch (error) {
    if (error?.code !== "submission_outcome_ambiguous") throw error;
    submissionResponseAmbiguous = true;
    submitted = {
      status: "unknown",
      provider_ref_seed: { venue: "aster", client_order_id: clientOrderId, order_id: null },
      result_seed: { kind: "aster_submission_response_ambiguous" },
      fills: [],
      final_proof: null,
    };
  }
  if (submitted.final_proof?.final_venue_execution_proven === true) return submitted;
  const timeout = boundedMs(env.PRIVATE_AGENT_ASTER_RECONCILE_TIMEOUT_MS, 250, 5_000, 1_200);
  const interval = boundedMs(env.PRIVATE_AGENT_ASTER_RECONCILE_INTERVAL_MS, 25, 1_000, 100);
  const deadline = now() + timeout;
  const maxAttempts = Math.max(1, Math.ceil(timeout / interval) + 1);
  let last = submitted;
  let exactOrderObserved = false;
  let readFailures = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const reconciled = await submitAsterExecution({
        credential,
        instruction: {
          version: 1,
          kind: "ghola_private_execution_instruction",
          venue_id: "aster",
          operation_class: "reconcile",
          reconcile: {
            market: instruction?.order?.market,
            target_client_order_id: clientOrderId,
          },
        },
        clientOrderId,
        fetchImpl,
        now,
        env,
      });
      if (reconciled.final_proof?.target_client_order_matched === true) {
        exactOrderObserved = true;
        last = reconciled;
      }
    } catch {
      readFailures += 1;
    }
    if (last.final_proof?.final_venue_execution_proven === true) {
      return reconciledAsterResult(last, submitted, {
        submissionResponseAmbiguous,
        readFailures,
        attempts: attempt,
        exhausted: false,
      });
    }
    if (attempt >= maxAttempts || now() >= deadline) break;
    await sleep(interval);
  }
  if (exactOrderObserved) {
    return reconciledAsterResult(last, submitted, {
      submissionResponseAmbiguous,
      readFailures,
      attempts,
      exhausted: true,
    });
  }
  throw new AsterExecutionError(
    "aster submission outcome remains ambiguous after bounded exact-order reconciliation",
    503,
    "submission_outcome_ambiguous",
  );
}

function reconciledAsterResult(result, submitted, reconciliation) {
  return {
    ...result,
    provider_ref_seed: {
      ...result.provider_ref_seed,
      submission_order_id: submitted.provider_ref_seed?.order_id ?? null,
    },
    reconciliation: {
      ...reconciliation,
      target_client_order_only: true,
      submission_retry_count: 0,
    },
  };
}

export async function signedRequest({
  credential,
  method,
  path,
  params,
  fetchImpl,
  now,
  ambiguousOnTransportFailure = false,
}) {
  const account = privateKeyToAccount(credential.api_wallet_private_key);
  const signedParams = {
    ...stringParams(params),
    nonce: nextNonce(now()).toString(),
    user: credential.user_address,
    signer: credential.signer_address,
  };
  const message = queryString(signedParams);
  const signature = await account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Message", message: { msg: message } });
  const body = new URLSearchParams({ ...signedParams, signature });
  const url = new URL(path, credential.base_url);
  const init = { method, headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(12_000) };
  if (method === "GET") url.search = body.toString();
  else {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = body.toString();
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (ambiguousOnTransportFailure) {
      throw new AsterExecutionError("aster submission outcome is ambiguous", 503, "submission_outcome_ambiguous");
    }
    throw new AsterExecutionError("aster request failed", 502, "connector_submit_failed");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code < 0) {
    if (ambiguousOnTransportFailure && (response.status === 408 || response.status >= 500)) {
      throw new AsterExecutionError("aster submission outcome is ambiguous", 503, "submission_outcome_ambiguous");
    }
    throw new AsterExecutionError("aster rejected the request", response.status || 422, "venue_rejected", {
      venue_code: payload?.code ?? null,
      venue_message: String(payload?.msg || "").slice(0, 200),
    });
  }
  return payload;
}

function publicRequest({ credential, path, fetchImpl }) {
  return fetchImpl(new URL(path, credential.base_url), {
    method: "GET",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(12_000),
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AsterExecutionError("aster public request failed", 502, "connector_submit_failed");
    return payload;
  }).catch((error) => {
    if (error instanceof AsterExecutionError) throw error;
    throw new AsterExecutionError("aster public request failed", 502, "connector_submit_failed");
  });
}

function normalizeAsterOrder(instruction, clientOrderId) {
  if (instruction?.operation_class !== "limit_order") {
    throw new AsterExecutionError("aster supports limit_order for protected entry", 422, "venue_rejected");
  }
  if (!CLIENT_ORDER_ID.test(String(clientOrderId || ""))) {
    throw new AsterExecutionError("aster client order id is invalid", 422, "venue_rejected");
  }
  const input = instruction.order || {};
  const side = String(input.side || "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") throw new AsterExecutionError("aster side is invalid", 422, "venue_rejected");
  const quantity = positiveDecimal(input.base_size);
  const price = positiveDecimal(input.limit_price);
  return {
    symbol: asterSymbol(input.market),
    side,
    type: "LIMIT",
    timeInForce: normalizeTif(input.tif),
    quantity,
    price,
    reduceOnly: input.reduce_only === true ? "true" : "false",
    newClientOrderId: clientOrderId,
    newOrderRespType: "RESULT",
  };
}

function validateMarketOrderShape(order, market) {
  const filters = Array.isArray(market?.filters) ? market.filters : [];
  const priceFilter = filters.find((item) => item?.filterType === "PRICE_FILTER");
  const lotFilter = filters.find((item) => item?.filterType === "LOT_SIZE");
  if (priceFilter && !aligned(order.price, priceFilter.tickSize)) throw new AsterExecutionError("aster price is off tick", 422, "venue_rejected");
  if (lotFilter && !aligned(order.quantity, lotFilter.stepSize)) throw new AsterExecutionError("aster quantity is off step", 422, "venue_rejected");
}

function normalizedResult(payload, { dryRun = false, targetClientOrderId = null } = {}) {
  const venueStatus = String(payload?.status || "UNKNOWN").toUpperCase();
  const status = venueStatus === "FILLED" ? "filled"
    : venueStatus === "CANCELED" ? "cancelled"
      : venueStatus === "REJECTED" || venueStatus === "EXPIRED" ? "rejected"
        : venueStatus === "NEW" || venueStatus === "PARTIALLY_FILLED" ? "open" : "unknown";
  const executedQty = String(payload?.executedQty || "0");
  const averagePrice = String(payload?.avgPrice || payload?.price || "0");
  const feeAmount = payload?.cumCommission ?? payload?.commission ?? payload?.fee ?? null;
  const feeAsset = payload?.commissionAsset ?? payload?.feeAsset ?? null;
  const targetMatched = targetClientOrderId !== null
    && String(payload?.clientOrderId || "") === String(targetClientOrderId);
  const fills = decimal(executedQty) > 0 && decimal(averagePrice) > 0
    ? [{ size: executedQty, price: averagePrice, order_id: payload?.orderId ?? null, fee: feeAmount, fee_asset: feeAsset }]
    : [];
  return {
    status,
    provider_ref_seed: {
      venue: "aster",
      client_order_id: payload?.clientOrderId || null,
      order_id: payload?.orderId ?? null,
      venue_status: venueStatus,
      dry_run: dryRun,
    },
    result_seed: { kind: "aster_v3_result", status, symbol: payload?.symbol || null },
    fills,
    final_proof: {
      target_client_order_matched: targetMatched,
      broadcast_performed: !dryRun,
      final_venue_execution_proven: targetMatched && (status === "filled" || status === "cancelled" || status === "rejected"),
      filled_base_size: executedQty,
      average_fill_price: averagePrice,
      fee_quote_amount: feeAmount,
      fee_asset: feeAsset,
      open_order_count: status === "open" ? 1 : 0,
      venue_status: venueStatus,
    },
  };
}

function boundedMs(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function nextNonce(nowMs) {
  const candidate = BigInt(Math.trunc(nowMs)) * 1_000n;
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce;
}

function queryString(params) {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
}

function stringParams(params) {
  return Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
}

function asterSymbol(value) {
  const compact = String(value || "").toUpperCase().replace(/[-_/]/g, "");
  const symbol = compact.endsWith("PERP") ? compact.slice(0, -4) : compact;
  const normalized = /USDT$/.test(symbol) ? symbol : `${symbol}USDT`;
  if (!/^[A-Z0-9]{5,24}$/.test(normalized)) throw new AsterExecutionError("aster symbol is invalid", 422, "venue_rejected");
  return normalized;
}

function normalizeTif(value) {
  const tif = String(value || "GTC").toUpperCase();
  if (!new Set(["GTC", "IOC", "FOK", "GTX"]).has(tif)) throw new AsterExecutionError("aster time in force is invalid", 422, "venue_rejected");
  return tif;
}

function positiveDecimal(value) {
  if (!(decimal(value) > 0)) throw new AsterExecutionError("aster order value is invalid", 422, "venue_rejected");
  return String(value);
}

function decimal(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rateToBps(value) {
  const rate = decimal(value);
  return rate >= 0 ? rate * 10_000 : null;
}

function aligned(value, step) {
  const amount = decimal(value);
  const increment = decimal(step);
  if (!(increment > 0)) return true;
  const units = amount / increment;
  return Math.abs(units - Math.round(units)) < 1e-8;
}
