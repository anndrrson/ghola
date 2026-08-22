const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MANDATE_ID = /^[a-zA-Z0-9:_-]{8,128}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

export const GHOLA_PERPS_VERSION = 1;
export const PERPS_OPERATIONS = Object.freeze(["order", "cancel", "reduce_only"]);
export const HYPERLIQUID_SIGNING_BOUNDARY = Object.freeze({
  turnkey_enforced: ["delegated_user", "agent_wallet_account", "eip712_domain"],
  application_enforced: [
    "market",
    "notional",
    "gross_exposure",
    "leverage",
    "slippage",
    "daily_loss",
    "drawdown",
    "stop_loss",
  ],
  owner_only: ["deposit", "withdraw", "transfer", "approve_agent", "revoke_agent", "configure_leverage"],
});

export class PerpsRiskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PerpsRiskError";
    this.code = code;
  }
}

export function normalizePerpsMandate(value) {
  const raw = object(value, "mandate_required", "A perps mandate is required.");
  if (integer(raw.version, "mandate_version") !== GHOLA_PERPS_VERSION) {
    fail("mandate_version", "Unsupported mandate version.");
  }
  const mandateId = text(raw.mandate_id, "mandate_id");
  if (!MANDATE_ID.test(mandateId)) fail("mandate_id", "Mandate ID is invalid.");
  const network = enumValue(raw.network, ["testnet", "mainnet"], "network");
  const ownerAddress = address(raw.owner_address, "owner_address");
  const agentAddress = address(raw.agent_address, "agent_address");
  const executionAddress = address(raw.execution_address || ownerAddress, "execution_address");
  if (ownerAddress === agentAddress) fail("wallet_separation", "Owner and agent addresses must differ.");
  const allowedMarkets = uniqueArray(raw.allowed_markets, "allowed_markets").map((item) => {
    const market = text(item, "allowed_market").toUpperCase();
    if (!MARKET.test(market)) fail("allowed_market", "Allowed market is invalid.");
    return market;
  });
  if (allowedMarkets.length === 0 || allowedMarkets.length > 20) {
    fail("allowed_markets", "One to twenty markets are required.");
  }
  const configuredLeverage = boundedInteger(raw.configured_leverage, 1, 50, "configured_leverage");
  const maxLeverage = boundedInteger(raw.max_leverage, 1, 50, "max_leverage");
  if (configuredLeverage > maxLeverage) {
    fail("configured_leverage", "Configured leverage exceeds the mandate maximum.");
  }
  const expiresAtMs = positiveInteger(raw.expires_at_ms, "expires_at_ms");
  const jurisdiction = object(raw.jurisdiction, "jurisdiction", "Jurisdiction attestation is required.");
  const eligible = jurisdiction.eligible === true;
  const acceptedRisk = jurisdiction.accepted_risk === true;
  const attestedAtMs = positiveInteger(jurisdiction.attested_at_ms, "attested_at_ms");
  const termsVersion = text(jurisdiction.terms_version, "terms_version");

  return Object.freeze({
    version: GHOLA_PERPS_VERSION,
    mandate_id: mandateId,
    network,
    owner_address: ownerAddress,
    agent_address: agentAddress,
    execution_address: executionAddress,
    allowed_markets: Object.freeze(allowedMarkets),
    margin_mode: enumValue(raw.margin_mode, ["cross", "isolated"], "margin_mode"),
    configured_leverage: configuredLeverage,
    max_leverage: maxLeverage,
    max_order_notional_micro_usdc: positiveInteger(raw.max_order_notional_micro_usdc, "max_order_notional"),
    max_gross_exposure_micro_usdc: positiveInteger(raw.max_gross_exposure_micro_usdc, "max_gross_exposure"),
    max_daily_notional_micro_usdc: positiveInteger(raw.max_daily_notional_micro_usdc, "max_daily_notional"),
    daily_loss_limit_micro_usdc: positiveInteger(raw.daily_loss_limit_micro_usdc, "daily_loss_limit"),
    max_drawdown_micro_usdc: positiveInteger(raw.max_drawdown_micro_usdc, "max_drawdown"),
    max_drawdown_bps: boundedInteger(raw.max_drawdown_bps, 1, 10_000, "max_drawdown_bps"),
    max_slippage_bps: boundedInteger(raw.max_slippage_bps, 1, 1_000, "max_slippage_bps"),
    stop_loss_bps: boundedInteger(raw.stop_loss_bps, 1, 10_000, "stop_loss_bps"),
    max_open_orders: boundedInteger(raw.max_open_orders, 1, 100, "max_open_orders"),
    max_orders_per_day: boundedInteger(raw.max_orders_per_day, 1, 1_000, "max_orders_per_day"),
    data_max_age_ms: boundedInteger(raw.data_max_age_ms, 250, 300_000, "data_max_age_ms"),
    expires_at_ms: expiresAtMs,
    kill_switch: raw.kill_switch === true,
    allowed_operations: Object.freeze([...PERPS_OPERATIONS]),
    jurisdiction: Object.freeze({
      eligible,
      accepted_risk: acceptedRisk,
      attested_at_ms: attestedAtMs,
      terms_version: termsVersion,
    }),
  });
}

export function evaluatePerpsIntent({ mandate: mandateInput, intent: intentInput, state: stateInput, now_ms = Date.now() }) {
  const reasons = [];
  let mandate;
  try {
    mandate = normalizePerpsMandate(mandateInput);
  } catch (error) {
    return denied(error instanceof PerpsRiskError ? error.code : "mandate_invalid", reasons);
  }
  let intent;
  let state;
  try {
    intent = normalizeIntent(intentInput);
    state = normalizeState(stateInput);
  } catch (error) {
    return denied(error instanceof PerpsRiskError ? error.code : "risk_input_invalid", reasons);
  }

  const actionClass = intent.operation;
  const isCancel = actionClass === "cancel";
  const isReduction = actionClass === "reduce_only";
  const mayReduceRisk = isCancel || isReduction;
  check(reasons, now_ms <= mandate.expires_at_ms, "mandate_expired");
  check(reasons, mandate.jurisdiction.eligible, "jurisdiction_ineligible");
  check(reasons, mandate.jurisdiction.accepted_risk, "risk_not_accepted");
  check(reasons, now_ms - mandate.jurisdiction.attested_at_ms <= 86_400_000, "jurisdiction_attestation_stale");
  check(reasons, intent.network === mandate.network, "network_mismatch");
  check(reasons, intent.owner_address === mandate.owner_address, "owner_mismatch");
  check(reasons, intent.agent_address === mandate.agent_address, "agent_mismatch");
  check(reasons, intent.execution_address === mandate.execution_address, "execution_account_mismatch");
  check(reasons, mandate.allowed_operations.includes(actionClass), "operation_not_allowed");
  check(reasons, !mandate.kill_switch || mayReduceRisk, "kill_switch_active");
  check(reasons, state.as_of_ms <= now_ms && now_ms - state.as_of_ms <= mandate.data_max_age_ms || isCancel, "risk_data_stale");

  const dailyLoss = Math.max(0, state.day_start_equity_micro_usdc - state.equity_micro_usdc);
  const drawdown = Math.max(0, state.peak_equity_micro_usdc - state.equity_micro_usdc);
  const drawdownBps = state.peak_equity_micro_usdc > 0
    ? Math.ceil((drawdown * 10_000) / state.peak_equity_micro_usdc)
    : 10_000;
  check(reasons, dailyLoss < mandate.daily_loss_limit_micro_usdc || mayReduceRisk, "daily_loss_limit_reached");
  check(reasons, drawdown < mandate.max_drawdown_micro_usdc || mayReduceRisk, "drawdown_usd_limit_reached");
  check(reasons, drawdownBps < mandate.max_drawdown_bps || mayReduceRisk, "drawdown_bps_limit_reached");

  if (isCancel) {
    check(reasons, state.managed_open_order_ids.includes(intent.order_id), "cancel_target_not_managed");
  } else {
    check(reasons, mandate.allowed_markets.includes(intent.market), "market_not_allowed");
    check(reasons, intent.notional_micro_usdc <= mandate.max_order_notional_micro_usdc, "order_notional_limit");
    check(reasons, intent.slippage_bps <= mandate.max_slippage_bps, "slippage_limit");
    check(reasons, intent.leverage === mandate.configured_leverage, "leverage_changed");
    check(reasons, intent.leverage <= mandate.max_leverage, "leverage_limit");
    check(reasons, intent.margin_mode === mandate.margin_mode, "margin_mode_changed");
    check(reasons, intent.venue_max_leverage >= intent.leverage, "venue_leverage_limit");
    check(reasons, state.open_order_count < mandate.max_open_orders || isReduction, "open_order_limit");
    check(reasons, state.orders_today < mandate.max_orders_per_day || isReduction, "daily_order_limit");
    check(
      reasons,
      state.daily_notional_micro_usdc + intent.notional_micro_usdc <= mandate.max_daily_notional_micro_usdc || isReduction,
      "daily_notional_limit",
    );
    const currentMarketExposure = state.position_notional_micro_usdc[intent.market] || 0;
    const projectedGross = intent.projected_gross_exposure_micro_usdc ?? (
      isReduction
        ? Math.max(0, state.gross_exposure_micro_usdc - Math.min(currentMarketExposure, intent.notional_micro_usdc))
        : state.gross_exposure_micro_usdc + intent.notional_micro_usdc
    );
    check(reasons, projectedGross <= mandate.max_gross_exposure_micro_usdc || isReduction, "gross_exposure_limit");
    if (isReduction) {
      check(reasons, intent.reduce_only === true, "reduce_only_required");
      check(reasons, currentMarketExposure > 0, "position_missing");
      check(reasons, intent.notional_micro_usdc <= currentMarketExposure, "reduce_only_oversized");
    } else {
      check(reasons, intent.reduce_only === false, "unexpected_reduce_only");
      check(reasons, intent.stop_loss_price_e8 > 0, "stop_loss_required");
      const stopDistanceBps = adverseDistanceBps(intent.side, intent.reference_price_e8, intent.stop_loss_price_e8);
      check(reasons, stopDistanceBps > 0 && stopDistanceBps <= mandate.stop_loss_bps, "stop_loss_limit");
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return Object.freeze({
    version: GHOLA_PERPS_VERSION,
    allowed: uniqueReasons.length === 0,
    action_class: actionClass,
    reasons: Object.freeze(uniqueReasons),
    risk: Object.freeze({
      daily_loss_micro_usdc: dailyLoss,
      drawdown_micro_usdc: drawdown,
      drawdown_bps: drawdownBps,
      gross_exposure_micro_usdc: state.gross_exposure_micro_usdc,
      checked_at_ms: now_ms,
    }),
    signing_boundary: HYPERLIQUID_SIGNING_BOUNDARY,
  });
}

export function buildTurnkeyHyperliquidPolicies({ delegated_user_id, owner_address, agent_address }) {
  const delegatedUserId = text(delegated_user_id, "delegated_user_id");
  const ownerAddress = address(owner_address, "owner_address");
  const agentAddress = address(agent_address, "agent_address");
  if (ownerAddress === agentAddress) fail("wallet_separation", "Owner and agent addresses must differ.");
  const approver = `approvers.any(user, user.id == '${escapePolicyString(delegatedUserId)}')`;
  const signingActivity = "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'";
  const agentAccount = `wallet_account.address == '${agentAddress}'`;
  const hyperliquidL1 = "eth.eip_712.domain.name == 'Exchange' && eth.eip_712.primary_type == 'Agent'";
  return Object.freeze([
    Object.freeze({
      policyName: "Ghola: allow delegated Hyperliquid agent signatures",
      effect: "EFFECT_ALLOW",
      consensus: approver,
      condition: `${signingActivity} && ${agentAccount} && ${hyperliquidL1}`,
      notes: "Allows only the Turnkey agent account and Hyperliquid L1 signing envelope. Order fields remain application-enforced because Hyperliquid commits them inside connectionId.",
    }),
    Object.freeze({
      policyName: "Ghola: deny delegated signing with owner account",
      effect: "EFFECT_DENY",
      consensus: approver,
      condition: `activity.action == 'SIGN' && wallet_account.address == '${ownerAddress}'`,
      notes: "The delegated worker must never sign with the owner account.",
    }),
    Object.freeze({
      policyName: "Ghola: deny delegated non-EIP712 raw signing",
      effect: "EFFECT_DENY",
      consensus: approver,
      condition: `${signingActivity} && activity.params.encoding != 'PAYLOAD_ENCODING_EIP712'`,
      notes: "Circuit breaker for opaque raw hashes and bytes.",
    }),
    Object.freeze({
      policyName: "Ghola: allow delegated user to self-delete",
      effect: "EFFECT_ALLOW",
      consensus: approver,
      condition: `activity.type == 'ACTIVITY_TYPE_DELETE_USERS' && activity.params.user_ids.count() == 1 && '${escapePolicyString(delegatedUserId)}' in activity.params.user_ids`,
      notes: "Lets the delegated credential remove itself during remediation.",
    }),
  ]);
}

export function canonicalPerpsJson(value) {
  return JSON.stringify(sortValue(value));
}

export function ownerMandateMessage(mandate) {
  return `Ghola Hyperliquid mandate v1\n${canonicalPerpsJson(normalizePerpsMandate(mandate))}`;
}

function normalizeIntent(value) {
  const raw = object(value, "intent_required", "A perps intent is required.");
  const operation = enumValue(raw.operation, PERPS_OPERATIONS, "operation");
  const common = {
    version: integer(raw.version, "intent_version"),
    operation,
    network: enumValue(raw.network, ["testnet", "mainnet"], "intent_network"),
    owner_address: address(raw.owner_address, "intent_owner"),
    agent_address: address(raw.agent_address, "intent_agent"),
    execution_address: address(raw.execution_address, "intent_execution_account"),
  };
  if (common.version !== GHOLA_PERPS_VERSION) fail("intent_version", "Unsupported intent version.");
  if (operation === "cancel") {
    return { ...common, order_id: text(raw.order_id, "order_id") };
  }
  const market = text(raw.market, "intent_market").toUpperCase();
  if (!MARKET.test(market)) fail("intent_market", "Intent market is invalid.");
  return {
    ...common,
    market,
    side: enumValue(raw.side, ["buy", "sell"], "side"),
    notional_micro_usdc: positiveInteger(raw.notional_micro_usdc, "intent_notional"),
    projected_gross_exposure_micro_usdc: optionalNonNegativeInteger(raw.projected_gross_exposure_micro_usdc, "projected_gross_exposure"),
    reference_price_e8: positiveInteger(raw.reference_price_e8, "reference_price"),
    limit_price_e8: positiveInteger(raw.limit_price_e8, "limit_price"),
    stop_loss_price_e8: nonNegativeInteger(raw.stop_loss_price_e8 ?? 0, "stop_loss_price"),
    slippage_bps: boundedInteger(raw.slippage_bps, 0, 10_000, "intent_slippage"),
    leverage: boundedInteger(raw.leverage, 1, 100, "intent_leverage"),
    venue_max_leverage: boundedInteger(raw.venue_max_leverage, 1, 100, "venue_max_leverage"),
    margin_mode: enumValue(raw.margin_mode, ["cross", "isolated"], "intent_margin_mode"),
    reduce_only: raw.reduce_only === true,
  };
}

function normalizeState(value) {
  const raw = object(value, "risk_state_required", "Risk state is required.");
  const positions = object(raw.position_notional_micro_usdc || {}, "positions", "Position state is invalid.");
  const normalizedPositions = {};
  for (const [market, notional] of Object.entries(positions)) {
    const normalizedMarket = text(market, "position_market").toUpperCase();
    if (!MARKET.test(normalizedMarket)) fail("position_market", "Position market is invalid.");
    normalizedPositions[normalizedMarket] = nonNegativeInteger(notional, "position_notional");
  }
  return {
    as_of_ms: positiveInteger(raw.as_of_ms, "risk_as_of"),
    equity_micro_usdc: nonNegativeInteger(raw.equity_micro_usdc, "equity"),
    day_start_equity_micro_usdc: nonNegativeInteger(raw.day_start_equity_micro_usdc, "day_start_equity"),
    peak_equity_micro_usdc: nonNegativeInteger(raw.peak_equity_micro_usdc, "peak_equity"),
    gross_exposure_micro_usdc: nonNegativeInteger(raw.gross_exposure_micro_usdc, "gross_exposure"),
    daily_notional_micro_usdc: nonNegativeInteger(raw.daily_notional_micro_usdc, "daily_notional"),
    orders_today: nonNegativeInteger(raw.orders_today, "orders_today"),
    open_order_count: nonNegativeInteger(raw.open_order_count, "open_order_count"),
    managed_open_order_ids: uniqueArray(raw.managed_open_order_ids || [], "managed_open_order_ids").map(String),
    position_notional_micro_usdc: normalizedPositions,
  };
}

function adverseDistanceBps(side, reference, stop) {
  if (side === "buy" && stop >= reference) return 0;
  if (side === "sell" && stop <= reference) return 0;
  return Math.ceil((Math.abs(reference - stop) * 10_000) / reference);
}

function denied(code, reasons) {
  return Object.freeze({
    version: GHOLA_PERPS_VERSION,
    allowed: false,
    action_class: "invalid",
    reasons: Object.freeze([...reasons, code]),
    risk: null,
    signing_boundary: HYPERLIQUID_SIGNING_BOUNDARY,
  });
}

function check(reasons, condition, code) {
  if (!condition) reasons.push(code);
}

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message);
  return value;
}

function uniqueArray(value, code) {
  if (!Array.isArray(value)) fail(code, `${code} must be an array.`);
  return [...new Set(value)];
}

function address(value, code) {
  const normalized = text(value, code).toLowerCase();
  if (!EVM_ADDRESS.test(normalized)) fail(code, `${code} must be an EVM address.`);
  return normalized;
}

function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) fail(code, `${code} is unsupported.`);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code, `${code} is required.`);
  return value.trim();
}

function integer(value, code) {
  if (!Number.isSafeInteger(value)) fail(code, `${code} must be a safe integer.`);
  return value;
}

function positiveInteger(value, code) {
  const normalized = integer(value, code);
  if (normalized <= 0) fail(code, `${code} must be positive.`);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = integer(value, code);
  if (normalized < 0) fail(code, `${code} must not be negative.`);
  return normalized;
}

function optionalNonNegativeInteger(value, code) {
  return value == null ? null : nonNegativeInteger(value, code);
}

function boundedInteger(value, min, max, code) {
  const normalized = integer(value, code);
  if (normalized < min || normalized > max) fail(code, `${code} is outside its allowed range.`);
  return normalized;
}

function escapePolicyString(value) {
  if (value.includes("'")) fail("policy_identifier", "Policy identifier contains an unsupported quote.");
  return value;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function fail(code, message) {
  throw new PerpsRiskError(code, message);
}
