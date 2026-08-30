import { privateKeyToAccount } from "viem/accounts";
import { asterLiquidationDistance } from "./liquidation-distance.js";

const MAINNET_URL = "https://fapi.asterdex.com";
const DOMAIN = Object.freeze({
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000",
});
const TYPES = Object.freeze({ Message: Object.freeze([{ name: "msg", type: "string" }]) });
const CLIENT_ORDER_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/;
const MAX_USER_TRADES = 1_000;
const MAX_USER_TRADE_PAGES = 4;
const QUOTE_ASSET = "USDT";
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
  const [serverTime, exchangeInfo, markPrice] = await Promise.all([
    publicRequest({ credential, path: "/fapi/v3/time", fetchImpl }),
    publicRequest({ credential, path: "/fapi/v3/exchangeInfo", fetchImpl }),
    publicRequest({ credential, path: `/fapi/v3/premiumIndex?symbol=${encodeURIComponent(order.symbol)}`, fetchImpl }),
  ]);
  const localNow = now();
  if (!Number.isFinite(Number(serverTime?.serverTime)) || Math.abs(Number(serverTime.serverTime) - localNow) > 4_000) {
    throw new AsterExecutionError("aster clock is outside the signing window", 400, "venue_clock_skew");
  }
  const market = exchangeInfo?.symbols?.find((item) => item?.symbol === order.symbol && item?.status === "TRADING");
  if (!market) throw new AsterExecutionError("aster market is unavailable", 422, "venue_rejected");
  if (String(markPrice?.symbol || "").toUpperCase() !== order.symbol) {
    throw new AsterExecutionError("aster mark-price symbol lineage is invalid", 502, "connector_submit_failed");
  }
  const marketRules = validateMarketOrderShape(order, market, markPrice);
  const account = await readAsterAccountState({ credential, symbol: order.symbol, fetchImpl, now, env });
  if (account.target_symbol_open_order_count >= marketRules.max_num_orders.limit) {
    throw new AsterExecutionError("aster maximum open orders reached", 422, "venue_rejected");
  }
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
    market_rules: marketRules,
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
    signedRequest({ credential, method: "GET", path: "/fapi/v3/positionRisk", params: {}, fetchImpl, now }),
    signedRequest({ credential, method: "GET", path: "/fapi/v3/openOrders", params: {}, fetchImpl, now }),
    signedRequest({ credential, method: "GET", path: "/fapi/v3/commissionRate", params: { symbol: normalizedSymbol }, fetchImpl, now }),
  ]);
  const liquidation = asterLiquidationDistance(positions);
  const availableBalance = strictDecimal(account?.availableBalance);
  const marginBalance = strictDecimal(account?.totalMarginBalance);
  const initialMargin = strictDecimal(account?.totalInitialMargin);
  const maintenanceMargin = strictDecimal(account?.totalMaintMargin);
  if (typeof account?.canTrade !== "boolean"
    || availableBalance === null
    || marginBalance === null
    || initialMargin === null
    || initialMargin < 0
    || maintenanceMargin === null
    || maintenanceMargin < 0
    || !Array.isArray(openOrders)
    || openOrders.some((item) => !item || typeof item !== "object" || !/^[A-Z0-9]{5,24}$/.test(String(item.symbol || "").toUpperCase()))
    || !Number.isSafeInteger(liquidation.position_count)) {
    throw new AsterExecutionError("aster account state response is invalid", 502, "connector_submit_failed");
  }
  const openOrderCount = openOrders.length;
  const makerFeeBps = rateToBps(commission?.makerCommissionRate);
  const takerFeeBps = rateToBps(commission?.takerCommissionRate);
  return {
    can_trade: account?.canTrade === true,
    available_balance: availableBalance,
    margin_balance: marginBalance,
    initial_margin: initialMargin,
    maintenance_margin: maintenanceMargin,
    position_count: liquidation.position_count,
    liquidation_distance_bps: liquidation.liquidation_distance_bps,
    liquidation_distance_verified: liquidation.liquidation_distance_verified,
    liquidation_distance_source: liquidation.liquidation_distance_source,
    open_order_count: openOrderCount,
    target_symbol_open_order_count: openOrders.filter((item) => String(item.symbol).toUpperCase() === normalizedSymbol).length,
    flat_zero_orders: liquidation.position_count === 0 && openOrderCount === 0,
    maker_fee_bps: makerFeeBps,
    taker_fee_bps: takerFeeBps,
    fee_source: "aster_account_commission_rate",
    fees_exact_for_account: makerFeeBps !== null && takerFeeBps !== null,
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
    }), { targetClientOrderId: target, expectedSymbol: symbol, broadcastPerformed: false });
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
    }), { targetClientOrderId: target, expectedSymbol: symbol, broadcastPerformed: true });
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
  }), { targetClientOrderId: clientOrderId, expectedSymbol: order.symbol, broadcastPerformed: true });
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
  const reconcileOnly = instruction?.operation_class === "reconcile";
  const reconciliationClientOrderId = reconcileOnly
    ? exactAsterClientOrderId(instruction?.reconcile?.target_client_order_id)
    : exactAsterClientOrderId(instruction?.operation_class === "cancel"
      ? instruction?.cancel?.client_order_id || clientOrderId
      : clientOrderId);
  const reconciliationMarket = reconcileOnly
    ? instruction?.reconcile?.market || instruction?.reconcile?.product_id
    : instruction?.operation_class === "cancel"
      ? instruction?.cancel?.market
      : instruction?.order?.market;
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return submitAsterExecution({ credential, instruction, clientOrderId, fetchImpl, now, env });
  }
  let submitted = reconcileOnly ? {
    status: "unknown",
    provider_ref_seed: { venue: "aster", client_order_id: reconciliationClientOrderId, order_id: null },
    result_seed: { kind: "aster_reconcile_started" },
    fills: [],
    final_proof: null,
  } : null;
  let submissionResponseAmbiguous = false;
  if (!reconcileOnly) {
    try {
      submitted = await submitAsterExecution({ credential, instruction, clientOrderId, fetchImpl, now, env });
    } catch (error) {
      if (error?.code !== "submission_outcome_ambiguous") throw error;
      submissionResponseAmbiguous = true;
      submitted = {
        status: "unknown",
        provider_ref_seed: { venue: "aster", client_order_id: reconciliationClientOrderId, order_id: null },
        result_seed: { kind: "aster_submission_response_ambiguous" },
        fills: [],
        final_proof: null,
      };
    }
  }
  if (submitted.provider_ref_seed?.dry_run === true) return submitted;
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
            market: reconciliationMarket,
            target_client_order_id: reconciliationClientOrderId,
          },
        },
        clientOrderId: reconciliationClientOrderId,
        fetchImpl,
        now,
        env,
      });
      if (reconciled.final_proof?.target_client_order_matched === true
        && reconciledOrderIdMatchesSubmission(reconciled, submitted)) {
        exactOrderObserved = true;
        last = reconciled;
      }
    } catch {
      readFailures += 1;
    }
    if (last.final_proof?.final_venue_execution_proven === true) {
      return attachExactAsterTrades(reconciledAsterResult(last, submitted, {
        reconcileOnly,
        submissionResponseAmbiguous,
        readFailures,
        attempts: attempt,
        exhausted: false,
      }), { credential, fetchImpl, now, env });
    }
    if (attempt >= maxAttempts || now() >= deadline) break;
    await sleep(interval);
  }
  if (exactOrderObserved) {
    return attachExactAsterTrades(reconciledAsterResult(last, submitted, {
      reconcileOnly,
      submissionResponseAmbiguous,
      readFailures,
      attempts,
      exhausted: true,
    }), { credential, fetchImpl, now, env });
  }
  throw new AsterExecutionError(
    "aster submission outcome remains ambiguous after bounded exact-order reconciliation",
    503,
    "submission_outcome_ambiguous",
  );
}

function exactAsterClientOrderId(value) {
  const result = String(value || "");
  if (!CLIENT_ORDER_ID.test(result)) {
    throw new AsterExecutionError("aster reconciliation client order id is invalid", 422, "venue_rejected");
  }
  return result;
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
    final_proof: result.final_proof ? {
      ...result.final_proof,
      broadcast_performed: reconciliation.reconcileOnly !== true
        && reconciliation.submissionResponseAmbiguous !== true
        && submitted.final_proof?.broadcast_performed === true,
    } : null,
  };
}

async function attachExactAsterTrades(result, { credential, fetchImpl, now, env }) {
  assertAsterPilotMode(credential, "read", env);
  const proof = result?.final_proof;
  const order = result?.result_seed?.order_evidence;
  if (proof?.target_client_order_matched !== true || proof?.target_symbol_matched !== true || !order) {
    throw ambiguousAsterTradeEvidence("aster exact order lineage is unavailable");
  }
  const symbol = asterSymbol(order.symbol);
  const orderId = exactUnsignedIdentifier(order.order_id);
  const clientOrderId = exactAsterClientOrderId(order.client_order_id);
  const executedBase = exactDecimal(order.executed_base_size);
  const expectedQuote = exactDecimal(order.executed_quote_notional);
  const orderTimeMs = exactTimestamp(order.order_time_ms);
  const updateTimeMs = exactTimestamp(order.update_time_ms);
  const venueStatus = String(proof?.venue_status || "").toUpperCase();
  if (orderId === null
    || executedBase === null
    || executedBase.coefficient < 0n
    || expectedQuote === null
    || expectedQuote.coefficient < 0n
    || orderTimeMs === null
    || updateTimeMs === null
    || updateTimeMs < orderTimeMs
    || updateTimeMs - orderTimeMs > 7 * 86_400_000) {
    throw ambiguousAsterTradeEvidence("aster exact order evidence is incomplete");
  }
  if (venueStatus === "FILLED" && (executedBase.coefficient <= 0n || expectedQuote.coefficient <= 0n)) {
    throw ambiguousAsterTradeEvidence("aster filled order has no exact execution");
  }
  const tradeRead = await readBoundedAsterUserTrades({
    credential,
    symbol,
    orderId,
    orderTimeMs,
    updateTimeMs,
    executedBase,
    expectedQuote,
    fetchImpl,
    now,
  });
  const rows = tradeRead.rows;
  const targetRows = rows.filter((row) => exactUnsignedIdentifier(row?.orderId) === orderId);
  const seenTradeIds = new Set();
  const fills = [];
  const quantities = [];
  const notionals = [];
  const commissions = [];
  for (const row of targetRows) {
    const tradeId = exactUnsignedIdentifier(row?.id);
    const tradeTimeMs = exactTimestamp(row?.time);
    const quantity = exactDecimal(row?.qty);
    const price = exactDecimal(row?.price);
    const quoteNotional = exactDecimal(row?.quoteQty);
    const venueCommission = exactDecimal(row?.commission, { signed: true });
    const commissionAsset = String(row?.commissionAsset || "").toUpperCase();
    if (String(row?.symbol || "").toUpperCase() !== symbol
      || tradeId === null
      || seenTradeIds.has(tradeId)
      || tradeTimeMs === null
      || tradeTimeMs < orderTimeMs
      || tradeTimeMs > updateTimeMs
      || quantity === null
      || quantity.coefficient <= 0n
      || price === null
      || price.coefficient <= 0n
      || quoteNotional === null
      || quoteNotional.coefficient <= 0n
      || venueCommission === null
      || commissionAsset !== QUOTE_ASSET) {
      throw ambiguousAsterTradeEvidence("aster target trade evidence is incomplete");
    }
    seenTradeIds.add(tradeId);
    quantities.push(quantity);
    notionals.push(quoteNotional);
    const realizedFee = { coefficient: -venueCommission.coefficient, scale: venueCommission.scale };
    commissions.push(realizedFee);
    fills.push({
      size: exactDecimalString(quantity),
      price: exactDecimalString(price),
      order_id: orderId,
      trade_id: tradeId,
      quote_notional: exactDecimalString(quoteNotional),
      fee: exactDecimalString(realizedFee),
      fee_asset: commissionAsset,
    });
  }
  const filledBase = sumExactDecimals(quantities);
  const filledQuote = sumExactDecimals(notionals);
  const realizedFee = sumExactDecimals(commissions);
  if (!sameExactDecimal(filledBase, executedBase)
    || !sameExactDecimal(filledQuote, expectedQuote)
    || (executedBase.coefficient > 0n && fills.length === 0)
    || (venueStatus === "FILLED" && fills.length === 0)) {
    throw ambiguousAsterTradeEvidence("aster target trade totals do not match the exact order");
  }
  const filledBaseString = exactDecimalString(filledBase);
  const filledQuoteString = exactDecimalString(filledQuote);
  const realizedFeeString = exactDecimalString(realizedFee);
  const averageFillPrice = filledBase.coefficient > 0n
    ? exactDecimalRatio(filledQuote, filledBase, 18)
    : "0";
  return {
    ...result,
    result_seed: {
      ...result.result_seed,
      exact_trade_evidence: {
        source: "aster_fapi_v3_user_trades_v1",
        symbol,
        order_id: orderId,
        client_order_id: clientOrderId,
        bounded_limit: MAX_USER_TRADES,
        bounded_page_limit: MAX_USER_TRADE_PAGES,
        fetched_page_count: tradeRead.page_count,
        returned_trade_count: tradeRead.returned_trade_count,
        target_trade_count: fills.length,
        window_start_ms: orderTimeMs,
        window_end_ms: updateTimeMs,
        filled_base_size: filledBaseString,
        filled_quote_notional: filledQuoteString,
        fee_amounts_by_asset: [{ asset: QUOTE_ASSET, amount: realizedFeeString }],
      },
    },
    fills,
    final_proof: {
      ...proof,
      filled_base_size: filledBaseString,
      filled_quote_notional: filledQuoteString,
      average_fill_price: averageFillPrice,
      fee_quote_amount: realizedFeeString,
      fee_asset: QUOTE_ASSET,
      realized_fees_exact: true,
      realized_fee_source: "aster_fapi_v3_user_trades_v1",
      user_trade_count: fills.length,
    },
  };
}

async function readBoundedAsterUserTrades({
  credential,
  symbol,
  orderId,
  orderTimeMs,
  updateTimeMs,
  executedBase,
  expectedQuote,
  fetchImpl,
  now,
}) {
  const rows = [];
  let cursor = null;
  let previousTradeId = null;
  let previousTradeTime = null;
  let returnedTradeCount = 0;
  let pageCount = 0;
  for (let page = 0; page < MAX_USER_TRADE_PAGES; page += 1) {
    let pageRows;
    try {
      pageRows = await signedRequest({
        credential,
        method: "GET",
        path: "/fapi/v3/userTrades",
        params: page === 0
          ? { symbol, startTime: orderTimeMs, endTime: updateTimeMs, limit: MAX_USER_TRADES }
          : { symbol, fromId: cursor, limit: MAX_USER_TRADES },
        fetchImpl,
        now,
      });
    } catch {
      throw ambiguousAsterTradeEvidence("aster user-trade evidence is unavailable");
    }
    pageCount += 1;
    if (!Array.isArray(pageRows) || pageRows.length > MAX_USER_TRADES) {
      throw ambiguousAsterTradeEvidence("aster user-trade evidence is invalid");
    }
    returnedTradeCount += pageRows.length;
    let reachedWindowEnd = false;
    for (const row of pageRows) {
      const tradeIdText = exactUnsignedIdentifier(row?.id);
      const rowOrderId = exactUnsignedIdentifier(row?.orderId);
      const tradeTimeMs = exactTimestamp(row?.time);
      if (String(row?.symbol || "").toUpperCase() !== symbol
        || tradeIdText === null
        || rowOrderId === null
        || tradeTimeMs === null) {
        throw ambiguousAsterTradeEvidence("aster user-trade page lineage is invalid");
      }
      const tradeId = BigInt(tradeIdText);
      if ((previousTradeId !== null && tradeId <= previousTradeId)
        || (previousTradeTime !== null && tradeTimeMs < previousTradeTime)) {
        throw ambiguousAsterTradeEvidence("aster user-trade pagination did not advance");
      }
      previousTradeId = tradeId;
      previousTradeTime = tradeTimeMs;
      if (tradeTimeMs < orderTimeMs) {
        throw ambiguousAsterTradeEvidence("aster user-trade time lineage is invalid");
      }
      if (tradeTimeMs > updateTimeMs) {
        reachedWindowEnd = true;
        continue;
      }
      rows.push(row);
    }
    if (targetAsterTradeTotalsMatch(rows, orderId, executedBase, expectedQuote)) break;
    if (pageRows.length < MAX_USER_TRADES || reachedWindowEnd) break;
    if (previousTradeId === null) throw ambiguousAsterTradeEvidence("aster user-trade pagination cursor is unavailable");
    cursor = (previousTradeId + 1n).toString();
  }
  return { rows, page_count: pageCount, returned_trade_count: returnedTradeCount };
}

function targetAsterTradeTotalsMatch(rows, orderId, expectedBase, expectedQuote) {
  const target = rows.filter((row) => exactUnsignedIdentifier(row?.orderId) === orderId);
  const quantities = target.map((row) => exactDecimal(row?.qty));
  const notionals = target.map((row) => exactDecimal(row?.quoteQty));
  if (quantities.some((value) => value === null) || notionals.some((value) => value === null)) return false;
  return sameExactDecimal(sumExactDecimals(quantities), expectedBase)
    && sameExactDecimal(sumExactDecimals(notionals), expectedQuote);
}

function reconciledOrderIdMatchesSubmission(reconciled, submitted) {
  const acknowledged = submitted?.provider_ref_seed?.order_id;
  if (acknowledged === null || acknowledged === undefined) return true;
  const submittedOrderId = exactUnsignedIdentifier(acknowledged);
  const reconciledOrderId = exactUnsignedIdentifier(reconciled?.provider_ref_seed?.order_id);
  return submittedOrderId !== null && reconciledOrderId !== null && submittedOrderId === reconciledOrderId;
}

function ambiguousAsterTradeEvidence(message) {
  return new AsterExecutionError(message, 503, "submission_outcome_ambiguous");
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

function validateMarketOrderShape(order, market, markPrice) {
  const filters = Array.isArray(market?.filters) ? market.filters : [];
  const priceFilters = filters.filter((item) => item?.filterType === "PRICE_FILTER");
  const lotFilters = filters.filter((item) => item?.filterType === "LOT_SIZE");
  const notionalFilters = filters.filter((item) => item?.filterType === "MIN_NOTIONAL");
  const percentFilters = filters.filter((item) => item?.filterType === "PERCENT_PRICE");
  const maxOrderFilters = filters.filter((item) => item?.filterType === "MAX_NUM_ORDERS");
  const priceFilter = priceFilters[0];
  const lotFilter = lotFilters[0];
  const notionalFilter = notionalFilters[0];
  const percentFilter = percentFilters[0];
  const maxOrderFilter = maxOrderFilters[0];
  const price = exactDecimal(order.price);
  const quantity = exactDecimal(order.quantity);
  if (price === null || price.coefficient <= 0n || quantity === null || quantity.coefficient <= 0n) {
    throw new AsterExecutionError("aster order decimal evidence is invalid", 422, "venue_rejected");
  }
  const minPrice = exactDecimal(priceFilter?.minPrice);
  const maxPrice = exactDecimal(priceFilter?.maxPrice);
  const tickSize = exactDecimal(priceFilter?.tickSize);
  if (priceFilters.length !== 1
    || minPrice === null
    || maxPrice === null
    || tickSize === null
    || (maxPrice.coefficient > 0n && exactDecimalCompare(maxPrice, minPrice) < 0)) {
    throw new AsterExecutionError("aster PRICE_FILTER evidence is unavailable", 502, "connector_submit_failed");
  }
  const minQty = exactDecimal(lotFilter?.minQty);
  const maxQty = exactDecimal(lotFilter?.maxQty);
  const stepSize = exactDecimal(lotFilter?.stepSize);
  if (lotFilters.length !== 1
    || minQty === null
    || maxQty === null
    || stepSize === null
    || maxQty.coefficient <= 0n
    || stepSize.coefficient <= 0n
    || exactDecimalCompare(maxQty, minQty) < 0) {
    throw new AsterExecutionError("aster LOT_SIZE evidence is unavailable", 502, "connector_submit_failed");
  }
  if (minPrice.coefficient > 0n && exactDecimalCompare(price, minPrice) < 0) throw new AsterExecutionError("aster price is below minimum", 422, "venue_rejected");
  if (maxPrice.coefficient > 0n && exactDecimalCompare(price, maxPrice) > 0) throw new AsterExecutionError("aster price is above maximum", 422, "venue_rejected");
  if (tickSize.coefficient > 0n && !exactAligned(order.price, priceFilter.tickSize, priceFilter.minPrice)) throw new AsterExecutionError("aster price is off tick", 422, "venue_rejected");
  if (minQty.coefficient > 0n && exactDecimalCompare(quantity, minQty) < 0) throw new AsterExecutionError("aster quantity is below minimum", 422, "venue_rejected");
  if (maxQty.coefficient > 0n && exactDecimalCompare(quantity, maxQty) > 0) throw new AsterExecutionError("aster quantity is above maximum", 422, "venue_rejected");
  if (!exactAligned(order.quantity, lotFilter.stepSize, lotFilter.minQty)) throw new AsterExecutionError("aster quantity is off step", 422, "venue_rejected");
  if (notionalFilters.length > 1) {
    throw new AsterExecutionError("aster MIN_NOTIONAL evidence is ambiguous", 502, "connector_submit_failed");
  }
  const minimumNotional = notionalFilter ? exactDecimal(notionalFilter.notional ?? notionalFilter.minNotional) : null;
  if (notionalFilter && (minimumNotional === null || minimumNotional.coefficient <= 0n)) {
    throw new AsterExecutionError("aster MIN_NOTIONAL evidence is unavailable", 502, "connector_submit_failed");
  }
  if (minimumNotional && exactDecimalCompare(exactDecimalMultiply(price, quantity), minimumNotional) < 0) {
    throw new AsterExecutionError("aster order is below minimum notional", 422, "venue_rejected");
  }
  if (percentFilters.length > 1) {
    throw new AsterExecutionError("aster PERCENT_PRICE evidence is ambiguous", 502, "connector_submit_failed");
  }
  let mark = null;
  let multiplierUp = null;
  let multiplierDown = null;
  if (percentFilter) {
    mark = exactDecimal(markPrice?.markPrice);
    multiplierUp = exactDecimal(percentFilter.multiplierUp);
    multiplierDown = exactDecimal(percentFilter.multiplierDown);
    if (mark === null || mark.coefficient <= 0n
      || multiplierUp === null || multiplierUp.coefficient <= 0n
      || multiplierDown === null || multiplierDown.coefficient <= 0n) {
      throw new AsterExecutionError("aster percent-price evidence is unavailable", 502, "connector_submit_failed");
    }
    if (order.side === "BUY" && exactDecimalCompare(price, exactDecimalMultiply(mark, multiplierUp)) > 0) throw new AsterExecutionError("aster buy price exceeds percent-price limit", 422, "venue_rejected");
    if (order.side === "SELL" && exactDecimalCompare(price, exactDecimalMultiply(mark, multiplierDown)) < 0) throw new AsterExecutionError("aster sell price exceeds percent-price limit", 422, "venue_rejected");
  }
  const maxNumOrders = strictPositiveInteger(maxOrderFilter?.limit);
  if (maxOrderFilters.length !== 1 || maxNumOrders === null) {
    throw new AsterExecutionError("aster MAX_NUM_ORDERS evidence is unavailable", 502, "connector_submit_failed");
  }
  return {
    source: "aster_fapi_v3_exchange_info",
    price_filter: {
      min_price: exactDecimalString(minPrice),
      max_price: exactDecimalString(maxPrice),
      tick_size: exactDecimalString(tickSize),
    },
    lot_size: {
      min_quantity: exactDecimalString(minQty),
      max_quantity: exactDecimalString(maxQty),
      step_size: exactDecimalString(stepSize),
    },
    minimum_notional: minimumNotional ? exactDecimalString(minimumNotional) : null,
    percent_price: percentFilter ? {
      mark_price: exactDecimalString(mark),
      multiplier_up: exactDecimalString(multiplierUp),
      multiplier_down: exactDecimalString(multiplierDown),
    } : null,
    max_num_orders: { limit: maxNumOrders },
  };
}

function normalizedResult(payload, {
  dryRun = false,
  targetClientOrderId = null,
  expectedSymbol = null,
  broadcastPerformed = false,
} = {}) {
  const venueStatus = String(payload?.status || "UNKNOWN").toUpperCase();
  const executedQty = String(payload?.executedQty || "0");
  const executedBase = exactDecimal(executedQty);
  const executedQuote = exactDecimal(payload?.cumQuote);
  const filledEvidenceValid = executedBase !== null && executedBase.coefficient > 0n
    && executedQuote !== null && executedQuote.coefficient > 0n;
  const status = venueStatus === "FILLED" ? filledEvidenceValid ? "filled" : "unknown"
    : venueStatus === "CANCELED" ? "cancelled"
      : venueStatus === "REJECTED" || venueStatus === "EXPIRED" ? "rejected"
        : venueStatus === "NEW" || venueStatus === "PARTIALLY_FILLED" ? "open" : "unknown";
  const averagePrice = String(payload?.avgPrice || payload?.price || "0");
  const targetClientOrderMatched = targetClientOrderId !== null
    && String(payload?.clientOrderId || "") === String(targetClientOrderId);
  const targetSymbolMatched = expectedSymbol === null
    || String(payload?.symbol || "").toUpperCase() === String(expectedSymbol).toUpperCase();
  const targetMatched = targetClientOrderMatched && targetSymbolMatched;
  return {
    status,
    provider_ref_seed: {
      venue: "aster",
      client_order_id: payload?.clientOrderId || null,
      order_id: payload?.orderId ?? null,
      venue_status: venueStatus,
      dry_run: dryRun,
    },
    result_seed: {
      kind: "aster_v3_result",
      status,
      symbol: payload?.symbol || null,
      order_evidence: {
        symbol: payload?.symbol || null,
        client_order_id: payload?.clientOrderId || null,
        order_id: payload?.orderId ?? null,
        executed_base_size: executedQty,
        executed_quote_notional: payload?.cumQuote ?? null,
        order_time_ms: payload?.time ?? null,
        update_time_ms: payload?.updateTime ?? null,
      },
    },
    fills: [],
    final_proof: {
      target_client_order_matched: targetMatched,
      target_symbol_matched: targetSymbolMatched,
      broadcast_performed: broadcastPerformed && !dryRun,
      final_venue_execution_proven: targetMatched && (status === "filled" || status === "cancelled" || status === "rejected"),
      filled_base_size: executedQty,
      average_fill_price: averagePrice,
      filled_quote_notional: payload?.cumQuote ?? null,
      fee_quote_amount: null,
      fee_asset: null,
      realized_fees_exact: false,
      realized_fee_source: null,
      open_order_count: status === "open" ? 1
        : ["filled", "cancelled", "rejected"].includes(status) ? 0 : null,
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
  const parsed = exactDecimal(value);
  if (parsed === null || parsed.coefficient <= 0n) throw new AsterExecutionError("aster order value is invalid", 422, "venue_rejected");
  return exactDecimalString(parsed);
}

function rateToBps(value) {
  const raw = String(value ?? "");
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const rate = Number(raw);
  return Number.isFinite(rate) ? rate * 10_000 : null;
}

function strictDecimal(value) {
  const raw = String(value ?? "");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function exactDecimal(value, { signed = false } = {}) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? ""));
  if (!match || (!signed && match[1] === "-")) return null;
  const scale = String(match[3] || "").length;
  const magnitude = BigInt(`${match[2]}${match[3] || ""}`);
  return { coefficient: match[1] === "-" ? -magnitude : magnitude, scale };
}

function exactDecimalString(value) {
  let coefficient = value.coefficient;
  if (coefficient === 0n) return "0";
  const negative = coefficient < 0n;
  if (negative) coefficient = -coefficient;
  const scale = value.scale;
  let digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale > 0) {
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.?0+$/, "");
  }
  return negative ? `-${digits}` : digits;
}

function sumExactDecimals(values) {
  const scale = values.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  const coefficient = values.reduce(
    (sum, value) => sum + value.coefficient * (10n ** BigInt(scale - value.scale)),
    0n,
  );
  return { coefficient, scale };
}

function sameExactDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * (10n ** BigInt(scale - left.scale))
    === right.coefficient * (10n ** BigInt(scale - right.scale));
}

function exactDecimalCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function exactDecimalMultiply(left, right) {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

function strictPositiveInteger(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function exactAligned(value, step, origin = "0") {
  const amount = exactDecimal(value);
  const increment = exactDecimal(step);
  const start = exactDecimal(origin);
  if (amount === null || increment === null || start === null || increment.coefficient <= 0n) return false;
  const scale = Math.max(amount.scale, increment.scale, start.scale);
  const amountValue = amount.coefficient * (10n ** BigInt(scale - amount.scale));
  const incrementValue = increment.coefficient * (10n ** BigInt(scale - increment.scale));
  const startValue = start.coefficient * (10n ** BigInt(scale - start.scale));
  return amountValue >= startValue && (amountValue - startValue) % incrementValue === 0n;
}

function exactDecimalRatio(numerator, denominator, scale) {
  if (denominator.coefficient <= 0n || numerator.coefficient < 0n) {
    throw ambiguousAsterTradeEvidence("aster average fill price is unavailable");
  }
  const scaledNumerator = numerator.coefficient * (10n ** BigInt(denominator.scale + scale));
  const scaledDenominator = denominator.coefficient * (10n ** BigInt(numerator.scale));
  const quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const rounded = remainder * 2n >= scaledDenominator ? quotient + 1n : quotient;
  return exactDecimalString({ coefficient: rounded, scale });
}

function exactTimestamp(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function exactUnsignedIdentifier(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  const text = String(value ?? "");
  return /^\d+$/.test(text) ? BigInt(text).toString() : null;
}
