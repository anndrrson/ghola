import { createHash } from "node:crypto";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";
import { createAccountWithAddress } from "@turnkey/viem";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import {
  evaluatePerpsIntent,
  normalizePerpsMandate,
  ownerMandateMessage,
} from "@ghola/perps-core";
import { verifyMessage } from "viem";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;

export class TurnkeyHyperliquidError extends Error {
  constructor(message, status = 400, code = "turnkey_hyperliquid_blocked") {
    super(message);
    this.name = "TurnkeyHyperliquidError";
    this.status = status;
    this.code = code;
  }
}

export function turnkeyHyperliquidCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object" || Array.isArray(vault)) {
    throw new TurnkeyHyperliquidError("Turnkey Hyperliquid vault is invalid.", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_hyperliquid_execution_vault" || vault.signing_mode !== "turnkey_delegated") {
    throw new TurnkeyHyperliquidError("Turnkey delegated signing mode is required.", 400, "venue_access_required");
  }
  const mandate = normalizePerpsMandate(vault.perps_mandate);
  const organizationId = requiredText(vault.turnkey_organization_id, "Turnkey organization ID is required.");
  const ownerAddress = requiredAddress(vault.owner_wallet_address, "Owner wallet address is invalid.");
  const agentAddress = requiredAddress(vault.agent_wallet_address, "Agent wallet address is invalid.");
  const executionAddress = requiredAddress(vault.hyperliquid_account_address, "Hyperliquid account address is invalid.");
  if (
    ownerAddress !== mandate.owner_address ||
    agentAddress !== mandate.agent_address ||
    executionAddress !== mandate.execution_address
  ) {
    throw new TurnkeyHyperliquidError("Wallet addresses do not match the signed mandate.", 400, "mandate_wallet_mismatch");
  }
  const ownerSignature = requiredText(vault.owner_mandate_signature, "Owner mandate signature is required.");
  if (!SIGNATURE.test(ownerSignature) && ownerSignature !== "local-mock-owner-signature") {
    throw new TurnkeyHyperliquidError("Owner mandate signature is invalid.", 400, "mandate_signature_invalid");
  }
  return Object.freeze({
    signing_mode: "turnkey_delegated",
    network: mandate.network,
    base_url: mandate.network === "testnet"
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz",
    turnkey_organization_id: organizationId,
    turnkey_agent_key_ref: requiredText(vault.turnkey_agent_key_ref, "Turnkey agent key reference is required."),
    owner_wallet_address: ownerAddress,
    agent_wallet_address: agentAddress,
    account_address: executionAddress,
    perps_mandate: mandate,
    owner_mandate_signature: ownerSignature,
    agent_name: typeof vault.agent_name === "string" ? vault.agent_name.slice(0, 64) : "Ghola Perps",
  });
}

export { ownerMandateMessage };

export async function verifyTurnkeyMandateAuthority(credential, env = process.env) {
  if (
    env.GHOLA_PERPS_LOCAL_MOCK === "true" &&
    credential.network === "testnet" &&
    credential.owner_mandate_signature === "local-mock-owner-signature"
  ) {
    return true;
  }
  const valid = await verifyMessage({
    address: credential.owner_wallet_address,
    message: ownerMandateMessage(credential.perps_mandate),
    signature: credential.owner_mandate_signature,
  });
  if (!valid) {
    throw new TurnkeyHyperliquidError("Owner signature does not authorize this mandate.", 403, "mandate_signature_invalid");
  }
  return true;
}

export function resolveTurnkeyAgentApiKey(credential, env = process.env) {
  const keyRef = credential.turnkey_agent_key_ref;
  let configured = null;
  if (env.GHOLA_TURNKEY_AGENT_KEYRING_JSON) {
    try {
      const keyring = JSON.parse(env.GHOLA_TURNKEY_AGENT_KEYRING_JSON);
      configured = keyring?.[keyRef] || null;
    } catch {
      throw new TurnkeyHyperliquidError("Turnkey agent keyring is invalid JSON.", 503, "turnkey_agent_unavailable");
    }
  }
  const apiPublicKey = configured?.api_public_key || env.GHOLA_TURNKEY_AGENT_API_PUBLIC_KEY;
  const apiPrivateKey = configured?.api_private_key || env.GHOLA_TURNKEY_AGENT_API_PRIVATE_KEY;
  if (!apiPublicKey || !apiPrivateKey) {
    throw new TurnkeyHyperliquidError("Turnkey delegated signer is not configured.", 503, "turnkey_agent_unavailable");
  }
  return { apiPublicKey: String(apiPublicKey), apiPrivateKey: String(apiPrivateKey) };
}

export function createTurnkeyHyperliquidWallet(credential, env = process.env) {
  const { apiPublicKey, apiPrivateKey } = resolveTurnkeyAgentApiKey(credential, env);
  const client = new TurnkeyClient(
    { baseUrl: env.TURNKEY_API_BASE_URL || "https://api.turnkey.com" },
    new ApiKeyStamper({ apiPublicKey, apiPrivateKey }),
  );
  return createAccountWithAddress({
    client,
    organizationId: credential.turnkey_organization_id,
    signWith: credential.agent_wallet_address,
    ethereumAddress: credential.agent_wallet_address,
  });
}

export async function prepareTurnkeyHyperliquidExecution({
  credential,
  instruction,
  cloid,
  env = process.env,
  marketContext,
  contextProvider = fetchTurnkeyRiskContext,
}) {
  await verifyTurnkeyMandateAuthority(credential, env);
  const context = marketContext || await contextProvider({ credential, instruction });
  const prepared = buildPreparedAction({ credential, instruction, cloid, context });
  if (!prepared.risk_decision.allowed) {
    throw new TurnkeyHyperliquidError(
      `Perps risk policy rejected the action: ${prepared.risk_decision.reasons.join(", ")}`,
      409,
      "perps_risk_rejected",
    );
  }
  return prepared;
}

export async function verifyTurnkeyHyperliquidNoSubmit(input) {
  const prepared = await prepareTurnkeyHyperliquidExecution(input);
  if (input.env?.GHOLA_PERPS_LOCAL_MOCK !== "true" && input.env !== undefined) {
    resolveTurnkeyAgentApiKey(input.credential, input.env);
  } else if (input.env === undefined) {
    resolveTurnkeyAgentApiKey(input.credential, process.env);
  }
  return {
    status: "verified_no_funds",
    sdk_checked: true,
    api_wallet_loaded: true,
    turnkey_policy_checked: true,
    owner_mandate_checked: true,
    market_data_checked: true,
    account_state_checked: true,
    order_request_checked: true,
    live_venue_checked: prepared.context_source === "hyperliquid_public_api",
    transaction_broadcast: false,
    risk_decision: prepared.risk_decision,
    prepared_action: redactPreparedAction(prepared),
  };
}

export async function submitTurnkeyHyperliquidExecution({
  credential,
  instruction,
  cloid,
  env = process.env,
  marketContext,
  contextProvider = fetchTurnkeyRiskContext,
  exchangeFactory = defaultExchangeFactory,
}) {
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" || env.GHOLA_PERPS_LOCAL_MOCK === "true") {
    const prepared = await prepareTurnkeyHyperliquidExecution({
      credential,
      instruction,
      cloid,
      env,
      marketContext,
      contextProvider,
    });
    return {
      status: instruction.operation_class === "cancel" ? "cancelled" : "submitted",
      oid: null,
      bracket_count: Math.max(0, prepared.orders.length - 1),
      risk_decision: prepared.risk_decision,
      mock: true,
    };
  }
  const prepared = await prepareTurnkeyHyperliquidExecution({
    credential,
    instruction,
    cloid,
    env,
    marketContext,
    contextProvider,
  });
  const exchange = exchangeFactory({ credential, env });
  if (prepared.operation === "cancel") {
    const result = prepared.cancel.client_order_id
      ? await exchange.cancelByCloid({
          cancels: [{ asset: prepared.asset_index, cloid: prepared.cancel.client_order_id }],
        })
      : await exchange.cancel({
          cancels: [{ a: prepared.asset_index, o: Number(prepared.cancel.order_id) }],
        });
    assertStatuses(result, 1, "cancel");
    return { status: "cancelled", oid: prepared.cancel.order_id || null, bracket_count: 0, risk_decision: prepared.risk_decision };
  }
  const result = await exchange.order({
    orders: prepared.orders,
    grouping: prepared.orders.length > 1 ? "normalTpsl" : "na",
  });
  const statuses = responseStatuses(result);
  if (statuses.length !== prepared.orders.length || statuses.some((item) => item?.error)) {
    await compensateUnprotectedEntry({ exchange, prepared, entryStatus: statuses[0] }).catch(() => {});
    throw new TurnkeyHyperliquidError("Hyperliquid did not acknowledge the complete protected order.", 502, "venue_rejected");
  }
  const entry = statuses[0] || {};
  const fill = entry.filled || null;
  return {
    status: fill ? "filled" : "submitted",
    oid: entry.resting?.oid || fill?.oid || null,
    bracket_count: Math.max(0, prepared.orders.length - 1),
    fills: fill ? [{ coin: prepared.market, px: fill.avgPx, sz: fill.totalSz, time: Date.now() }] : [],
    risk_decision: prepared.risk_decision,
  };
}

export async function fetchTurnkeyRiskContext({ credential, instruction, clients }) {
  const transport = clients?.transport || new HttpTransport({
    isTestnet: credential.network === "testnet",
    timeout: 10_000,
  });
  const info = clients?.info || new InfoClient({ transport });
  const startTime = new Date().setUTCHours(0, 0, 0, 0);
  const [meta, mids, account, openOrders, fills, portfolio] = await Promise.all([
    info.meta(),
    info.allMids(),
    info.clearinghouseState({ user: credential.account_address }),
    info.openOrders({ user: credential.account_address }),
    info.userFillsByTime({ user: credential.account_address, startTime, aggregateByTime: true }),
    info.portfolio({ user: credential.account_address }),
  ]);
  return riskContextFromVenue({ credential, instruction, meta, mids, account, openOrders, fills, portfolio });
}

export function riskContextFromVenue({ credential, instruction, meta, mids, account, openOrders, fills, portfolio }) {
  const market = String(instruction.order?.market || instruction.cancel?.market || "").toUpperCase();
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const assetIndex = universe.findIndex((item) => item?.name === market);
  if (assetIndex < 0) throw new TurnkeyHyperliquidError("Hyperliquid market is unavailable.", 404, "market_unavailable");
  const asset = universe[assetIndex];
  const mark = positiveDecimal(mids?.[market], "Hyperliquid mark price is unavailable.");
  const positions = Array.isArray(account?.assetPositions) ? account.assetPositions : [];
  const positionNotional = {};
  const positionSides = {};
  let grossExposure = 0;
  for (const wrapper of positions) {
    const position = wrapper?.position || wrapper;
    const coin = String(position?.coin || "").toUpperCase();
    const size = Number(position?.szi || 0);
    const positionMark = Number(mids?.[coin] || position?.positionValue && Math.abs(Number(position.positionValue) / size) || 0);
    if (!coin || !Number.isFinite(size) || !Number.isFinite(positionMark) || positionMark <= 0) continue;
    const notional = usdToMicro(Math.abs(size) * positionMark);
    positionNotional[coin] = notional;
    positionSides[coin] = size > 0 ? "buy" : size < 0 ? "sell" : null;
    grossExposure += notional;
  }
  const equity = usdToMicro(positiveOrZero(account?.marginSummary?.accountValue ?? account?.crossMarginSummary?.accountValue));
  const perpDay = Array.isArray(portfolio)
    ? portfolio.find((entry) => entry?.[0] === "perpDay")?.[1]
    : null;
  const history = Array.isArray(perpDay?.accountValueHistory) ? perpDay.accountValueHistory : [];
  const historyValues = history.map((entry) => Number(entry?.[1])).filter((value) => Number.isFinite(value) && value >= 0);
  const dayStart = usdToMicro(historyValues[0] ?? (equity / 1_000_000));
  const peak = usdToMicro(Math.max(equity / 1_000_000, ...historyValues));
  const dailyNotional = Array.isArray(fills)
    ? fills.reduce((sum, fill) => sum + usdToMicro(positiveOrZero(fill?.px) * positiveOrZero(fill?.sz)), 0)
    : 0;
  return {
    context_source: "hyperliquid_public_api",
    asset_index: assetIndex,
    sz_decimals: Number.isInteger(asset?.szDecimals) ? asset.szDecimals : 6,
    venue_max_leverage: Number.isInteger(asset?.maxLeverage) ? asset.maxLeverage : Number(asset?.maxLeverage || 1),
    mark_price: mark,
    position_sides: positionSides,
    state: {
      as_of_ms: Date.now(),
      equity_micro_usdc: equity,
      day_start_equity_micro_usdc: dayStart,
      peak_equity_micro_usdc: peak,
      gross_exposure_micro_usdc: grossExposure,
      daily_notional_micro_usdc: dailyNotional,
      orders_today: Array.isArray(fills) ? fills.length : 0,
      open_order_count: Array.isArray(openOrders) ? openOrders.length : 0,
      managed_open_order_ids: instruction.operation_class === "cancel"
        ? [String(instruction.cancel?.order_id || instruction.cancel?.client_order_id || "")].filter(Boolean)
        : [],
      position_notional_micro_usdc: positionNotional,
    },
  };
}

function buildPreparedAction({ credential, instruction, cloid, context }) {
  const operation = instruction.operation_class === "cancel"
    ? "cancel"
    : instruction.order?.reduce_only === true ? "reduce_only" : "order";
  const common = {
    version: 1,
    operation,
    network: credential.network,
    owner_address: credential.owner_wallet_address,
    agent_address: credential.agent_wallet_address,
    execution_address: credential.account_address,
  };
  if (operation === "cancel") {
    const cancel = instruction.cancel || {};
    const orderId = String(cancel.order_id || cancel.client_order_id || "");
    const decision = evaluatePerpsIntent({
      mandate: credential.perps_mandate,
      intent: { ...common, order_id: orderId },
      state: context.state,
    });
    return {
      operation,
      market: cancel.market,
      asset_index: context.asset_index,
      cancel,
      orders: [],
      risk_decision: decision,
      context_source: context.context_source,
    };
  }
  const order = instruction.order || {};
  const referencePrice = positiveDecimal(context.mark_price, "Reference price is unavailable.");
  const explicitPrice = Number(order.limit_price || 0);
  const slippageBps = Number.parseInt(String(order.max_slippage_bps || "50"), 10);
  const rawLimit = explicitPrice > 0
    ? explicitPrice
    : referencePrice * (order.side === "buy" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000);
  const limitPrice = Number(formatPrice(rawLimit, context.sz_decimals));
  const quoteNotional = Number(order.quote_size || 0) || Number(order.base_size || 0) * limitPrice;
  const baseSize = Number(order.base_size || 0) > 0
    ? formatSize(order.base_size, context.sz_decimals)
    : formatSize(quoteNotional / limitPrice, context.sz_decimals);
  const notionalMicro = usdToMicro(Number(baseSize) * limitPrice);
  const currentNotional = context.state.position_notional_micro_usdc[String(order.market).toUpperCase()] || 0;
  const currentSide = context.position_sides?.[String(order.market).toUpperCase()] || null;
  if (operation === "reduce_only" && currentSide && currentSide === order.side) {
    throw new TurnkeyHyperliquidError("Reduce-only side would increase the position.", 409, "reduce_only_direction");
  }
  const projectedGross = operation === "reduce_only"
    ? Math.max(0, context.state.gross_exposure_micro_usdc - Math.min(currentNotional, notionalMicro))
    : context.state.gross_exposure_micro_usdc + notionalMicro;
  const stopLoss = Number(order.protective_orders?.stop_loss || 0);
  const decision = evaluatePerpsIntent({
    mandate: credential.perps_mandate,
    intent: {
      ...common,
      market: String(order.market).toUpperCase(),
      side: order.side,
      notional_micro_usdc: notionalMicro,
      projected_gross_exposure_micro_usdc: projectedGross,
      reference_price_e8: priceToE8(referencePrice),
      limit_price_e8: priceToE8(limitPrice),
      stop_loss_price_e8: stopLoss > 0 ? priceToE8(stopLoss) : 0,
      slippage_bps: slippageBps,
      leverage: Number(order.leverage || 1),
      venue_max_leverage: context.venue_max_leverage,
      margin_mode: order.margin_mode || "cross",
      reduce_only: operation === "reduce_only",
    },
    state: context.state,
  });
  const orders = [{
    a: context.asset_index,
    b: order.side === "buy",
    p: String(formatPrice(limitPrice, context.sz_decimals)),
    s: baseSize,
    r: operation === "reduce_only",
    t: { limit: { tif: order.tif === "Alo" ? "Alo" : order.tif === "Gtc" ? "Gtc" : "Ioc" } },
    c: cloid,
  }];
  if (operation === "order") {
    addProtectiveOrder(orders, {
      price: order.protective_orders?.take_profit,
      kind: "tp",
      order,
      baseSize,
      context,
      cloid: derivedCloid(cloid, "tp"),
    });
    addProtectiveOrder(orders, {
      price: order.protective_orders?.stop_loss,
      kind: "sl",
      order,
      baseSize,
      context,
      cloid: derivedCloid(cloid, "sl"),
    });
  }
  return {
    operation,
    market: String(order.market).toUpperCase(),
    asset_index: context.asset_index,
    base_size: baseSize,
    orders,
    risk_decision: decision,
    context_source: context.context_source,
  };
}

function addProtectiveOrder(orders, { price, kind, order, baseSize, context, cloid }) {
  const trigger = Number(price || 0);
  if (!(trigger > 0)) return;
  const formatted = formatPrice(trigger, context.sz_decimals);
  orders.push({
    a: context.asset_index,
    b: order.side !== "buy",
    p: formatted,
    s: baseSize,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: formatted, tpsl: kind } },
    c: cloid,
  });
}

function defaultExchangeFactory({ credential, env }) {
  const wallet = createTurnkeyHyperliquidWallet(credential, env);
  const transport = new HttpTransport({ isTestnet: credential.network === "testnet", timeout: 12_000 });
  return new ExchangeClient({
    transport,
    wallet,
    defaultExpiresAfter: () => Date.now() + 30_000,
  });
}

async function compensateUnprotectedEntry({ exchange, prepared, entryStatus }) {
  if (entryStatus?.resting) {
    await exchange.cancelByCloid({ cancels: [{ asset: prepared.asset_index, cloid: prepared.orders[0].c }] });
    return;
  }
  if (entryStatus?.filled) {
    const entry = prepared.orders[0];
    await exchange.order({
      orders: [{
        a: prepared.asset_index,
        b: !entry.b,
        p: entry.p,
        s: entryStatus.filled.totalSz || entry.s,
        r: true,
        t: { limit: { tif: "Ioc" } },
        c: derivedCloid(entry.c, "emergency-close"),
      }],
      grouping: "na",
    });
  }
}

function responseStatuses(result) {
  return result?.response?.data?.statuses || [];
}

function assertStatuses(result, count, action) {
  const statuses = responseStatuses(result);
  if (statuses.length !== count || statuses.some((item) => item?.error)) {
    throw new TurnkeyHyperliquidError(`Hyperliquid ${action} was rejected.`, 502, "venue_rejected");
  }
}

function redactPreparedAction(prepared) {
  return {
    operation: prepared.operation,
    market: prepared.market,
    order_count: prepared.orders.length,
    bracket_count: Math.max(0, prepared.orders.length - 1),
    risk_allowed: prepared.risk_decision.allowed,
  };
}

function derivedCloid(parent, suffix) {
  return `0x${createHash("sha256").update(`${parent}:${suffix}`).digest("hex").slice(0, 32)}`;
}

function usdToMicro(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new TurnkeyHyperliquidError("Invalid USD risk value.", 502, "risk_data_invalid");
  }
  const micro = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(micro)) {
    throw new TurnkeyHyperliquidError("USD risk value exceeds the safe range.", 502, "risk_data_invalid");
  }
  return micro;
}

function priceToE8(value) {
  const result = Math.round(Number(value) * 100_000_000);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TurnkeyHyperliquidError("Price exceeds the safe range.", 502, "risk_data_invalid");
  }
  return result;
}

function positiveDecimal(value, message) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TurnkeyHyperliquidError(message, 502, "market_data_unavailable");
  return parsed;
}

function positiveOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requiredAddress(value, message) {
  const normalized = requiredText(value, message).toLowerCase();
  if (!ADDRESS.test(normalized)) throw new TurnkeyHyperliquidError(message);
  return normalized;
}

function requiredText(value, message) {
  if (typeof value !== "string" || value.trim() === "") throw new TurnkeyHyperliquidError(message);
  return value.trim();
}
