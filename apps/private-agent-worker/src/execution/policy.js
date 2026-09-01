const HYPERLIQUID_ALLOWED = new Set(["read", "limit_order", "cancel", "reconcile"]);
const COINBASE_ALLOWED = new Set([
  "read",
  "preview_order",
  "spot_limit_order",
  "spot_market_order",
  "cancel",
  "fills",
  "reconcile",
]);
const SOLANA_PERPS_ALLOWED = new Set(["read", "perp_limit_order", "cancel", "fills", "reconcile"]);
const JUPITER_ALLOWED = new Set(["read", "preview_order", "swap", "reconcile"]);
const MAX_EXACT_BASE_DIGITS = 80;
const MAX_EXACT_BASE_SCALE = 40;
const BLOCKED_OPERATION_WORDS = [
  "withdraw",
  "transfer",
  "vault",
  "leverage",
  "margin",
  "stake",
  "staking",
  "portfolio_mutation",
  "futures",
  "derivatives",
];
const AGENT_STRATEGY_PROFILE_VALUES = new Set([
  "momentum_continuation",
  "breakout_retest",
  "sweep_reclaim",
  "mean_reversion",
  "funding_mark_divergence",
  "venue_route_edge",
  "custom",
]);
const AGENT_ENTRY_TRIGGER_VALUES = new Set([
  "preview_now",
  "break_level",
  "retest_level",
  "sweep_reclaim",
  "book_imbalance",
  "funding_mark_divergence",
  "route_edge_threshold",
  "custom",
]);
const AGENT_EXIT_RULE_VALUES = new Set([
  "manual_approval",
  "take_profit_stop",
  "trail_after_profit",
  "exit_on_invalidation",
  "time_stop",
  "reduce_on_risk_flip",
]);
const AGENT_TIME_HORIZON_VALUES = new Set([
  "scalp",
  "session_trade",
  "intraday",
  "until_invalidated",
  "custom_window",
]);
const SUBMITTING_OPERATIONS = new Set([
  "limit_order",
  "spot_limit_order",
  "spot_market_order",
  "perp_limit_order",
  "swap",
]);

export class ExecutionPolicyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ExecutionPolicyError";
    this.status = status;
  }
}

export function assertVenueOperationAllowed(venueId, operationClass) {
  const allowed = allowedOperationsForVenue(venueId);
  if (!allowed.has(operationClass)) {
    throw new ExecutionPolicyError("operation_class is unsupported");
  }
  const lowered = String(operationClass || "").toLowerCase();
  if (BLOCKED_OPERATION_WORDS.some((word) => lowered.includes(word))) {
    throw new ExecutionPolicyError("operation_class is blocked for private execution");
  }
}

export function normalizeInstruction(value, { venue_id, operation_class }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionPolicyError("encrypted execution instruction is required");
  }
  if (value.version !== 1) throw new ExecutionPolicyError("execution instruction version must be 1");
  if (
    value.kind !== "ghola_private_execution_instruction" &&
    value.kind !== "ghola_execution_instruction"
  ) {
    throw new ExecutionPolicyError("execution instruction kind is unsupported");
  }
  if (value.venue_id && value.venue_id !== venue_id) {
    throw new ExecutionPolicyError("execution instruction venue mismatch");
  }
  const op = value.operation_class || operation_class;
  assertVenueOperationAllowed(venue_id, op);
  const order = value.order && typeof value.order === "object" ? value.order : null;
  const cancel = value.cancel && typeof value.cancel === "object" ? value.cancel : null;
  const mandate = normalizeAgentMandate(value.mandate);
  if (op === "swap") {
    if (!order) throw new ExecutionPolicyError("execution instruction swap order is required");
    return {
      version: 1,
      venue_id,
      operation_class: op,
      expires_at: stringOrNull(value.expires_at),
      order: normalizeSwapOrder(order, venue_id),
      ...(mandate ? { mandate } : {}),
    };
  }
  if (["limit_order", "spot_limit_order", "spot_market_order", "preview_order", "perp_limit_order"].includes(op)) {
    if (!order) throw new ExecutionPolicyError("execution instruction order is required");
    return {
      version: 1,
      venue_id,
      operation_class: op,
      expires_at: stringOrNull(value.expires_at),
      order: normalizeOrder(order, venue_id, op),
      ...(mandate ? { mandate } : {}),
    };
  }
  if (op === "cancel") {
    if (!cancel) throw new ExecutionPolicyError("execution instruction cancel is required");
    return {
      version: 1,
      venue_id,
      operation_class: op,
      expires_at: stringOrNull(value.expires_at),
      cancel: normalizeCancel(cancel, venue_id),
      ...(mandate ? { mandate } : {}),
    };
  }
  return {
    version: 1,
    venue_id,
    operation_class: op,
    expires_at: stringOrNull(value.expires_at),
    reconcile: value.reconcile && typeof value.reconcile === "object" ? value.reconcile : {},
    ...(mandate ? { mandate } : {}),
  };
}

function normalizeOrder(order, venueId, operationClass) {
  const market = stringValue(order.market) ||
    stringValue(order.product_id) ||
    stringValue(order.coin);
  if (!market) throw new ExecutionPolicyError("execution instruction market is required");
  const side = stringValue(order.side).toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new ExecutionPolicyError("execution instruction side must be buy or sell");
  }
  const liveOrderMode = normalizeLiveOrderMode(order.live_order_mode || order.mode);
  const orderType = normalizeOrderType(order.order_type);
  const sizeMode = normalizeSizeMode(order.size_mode || (order.quote_size || order.notional_usd ? "quote" : "base"));
  const hyperliquidTinyFill =
    venueId === "hyperliquid" &&
    operationClass === "limit_order" &&
    liveOrderMode === "tiny_fill";
  const limitPrice = decimalString(order.limit_price ?? order.price ?? order.px);
  if (operationClass !== "spot_market_order" && orderType !== "market" && !hyperliquidTinyFill && !limitPrice) {
    throw new ExecutionPolicyError("execution instruction limit price is required");
  }
  const baseSize = decimalString(order.base_size ?? order.size ?? order.sz);
  const quoteSize = decimalString(order.quote_size ?? order.notional_usd);
  if (sizeMode === "base" && !baseSize) {
    throw new ExecutionPolicyError("execution instruction base size is required");
  }
  if (sizeMode === "quote" && !quoteSize) {
    throw new ExecutionPolicyError("execution instruction quote size is required");
  }
  if (!baseSize && !quoteSize) {
    throw new ExecutionPolicyError("execution instruction size is required");
  }
  if (hyperliquidTinyFill && !quoteSize) {
    throw new ExecutionPolicyError("hyperliquid tiny fill requires quote size");
  }
  const tif = stringValue(order.tif || order.time_in_force || "Gtc");
  const normalizedTif = hyperliquidTinyFill ? "Ioc" : normalizeTif(tif, venueId);
  const maxSlippageBps = integerString(order.max_slippage_bps ?? order.slippage_bps);
  const stopLoss = decimalString(order.protective_orders?.stop_loss);
  const takeProfit = decimalString(order.protective_orders?.take_profit);
  const leverage = Number.parseInt(String(order.leverage ?? "1"), 10);
  const marginMode = stringValue(order.margin_mode || "cross").toLowerCase();
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) {
    throw new ExecutionPolicyError("execution instruction leverage is invalid");
  }
  if (marginMode !== "cross" && marginMode !== "isolated") {
    throw new ExecutionPolicyError("execution instruction margin mode is invalid");
  }
  if (order.reduce_only === true && (stopLoss || takeProfit)) {
    throw new ExecutionPolicyError("reduce-only orders cannot attach protective orders");
  }
  return {
    market: normalizeMarket(market, venueId),
    side,
    base_size: baseSize,
    quote_size: quoteSize,
    limit_price: limitPrice,
    order_type: orderType,
    size_mode: sizeMode,
    tif: normalizedTif,
    live_order_mode: liveOrderMode,
    max_slippage_bps: maxSlippageBps,
    post_only: order.post_only === true,
    reduce_only: order.reduce_only === true,
    leverage,
    margin_mode: marginMode,
    protective_orders: stopLoss || takeProfit
      ? {
          ...(stopLoss ? { stop_loss: stopLoss } : {}),
          ...(takeProfit ? { take_profit: takeProfit } : {}),
        }
      : null,
  };
}

function normalizeSwapOrder(order, venueId) {
  if (venueId !== "jupiter") {
    throw new ExecutionPolicyError("swap operation is only supported for Jupiter");
  }
  const inputMint = stringValue(order.input_mint ?? order.inputMint);
  const outputMint = stringValue(order.output_mint ?? order.outputMint);
  if (!isSolanaAddress(inputMint) || !isSolanaAddress(outputMint)) {
    throw new ExecutionPolicyError("jupiter swap mints are invalid");
  }
  if (inputMint === outputMint) {
    throw new ExecutionPolicyError("jupiter swap input and output mints must differ");
  }
  const amount = integerString(order.amount ?? order.in_amount ?? order.inAmount);
  if (!amount || amount === "0") {
    throw new ExecutionPolicyError("jupiter swap amount is required");
  }
  const routingMode = stringValue(order.routing_mode ?? order.routingMode ?? "meta_aggregator").toLowerCase();
  if (routingMode !== "meta_aggregator" && routingMode !== "router") {
    throw new ExecutionPolicyError("jupiter routing mode is unsupported");
  }
  const maxSlippageBps = integerString(order.max_slippage_bps ?? order.slippage_bps);
  const notional = decimalString(order.quote_size ?? order.notional_usd ?? order.notionalUsd) || "1";
  return {
    market: `${inputMint.slice(0, 6)}/${outputMint.slice(0, 6)}`,
    side: "buy",
    base_size: null,
    quote_size: notional,
    limit_price: "1",
    tif: "Ioc",
    live_order_mode: null,
    max_slippage_bps: maxSlippageBps,
    post_only: false,
    reduce_only: false,
    input_mint: inputMint,
    output_mint: outputMint,
    amount,
    routing_mode: routingMode,
    payer: stringValue(order.payer) || null,
  };
}

function normalizeCancel(cancel, venueId) {
  const market = stringValue(cancel.market) ||
    stringValue(cancel.product_id) ||
    stringValue(cancel.coin);
  if (!market) throw new ExecutionPolicyError("execution instruction cancel market is required");
  const orderId = stringValue(cancel.order_id || cancel.oid);
  const clientOrderId = stringValue(cancel.client_order_id || cancel.cloid);
  const targetWorkOrderCommitment = stringValue(cancel.target_work_order_commitment);
  if (venueId === "hyperliquid" && !targetWorkOrderCommitment) {
    throw new ExecutionPolicyError("execution instruction cancel target work order is required");
  }
  if (!orderId && !clientOrderId) {
    if (!targetWorkOrderCommitment) {
      throw new ExecutionPolicyError("execution instruction cancel id is required");
    }
    if (!/^[A-Za-z0-9_:-]{8,160}$/.test(targetWorkOrderCommitment)) {
      throw new ExecutionPolicyError("execution instruction cancel target is invalid");
    }
  }
  return {
    market: normalizeMarket(market, venueId),
    order_id: orderId || null,
    client_order_id: clientOrderId || null,
    target_work_order_commitment: targetWorkOrderCommitment || null,
  };
}

export async function enforceInstructionPolicy({
  body,
  instruction,
  session,
  state,
  trusted_internal = false,
  account_usage = true,
}) {
  const recoveryAction = instruction.operation_class === "cancel" || instruction.order?.reduce_only === true;
  if (process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH === "true" && !recoveryAction) {
    throw new ExecutionPolicyError("private execution kill switch is active", 503);
  }
  const now = Date.now();
  if (instruction.expires_at && new Date(instruction.expires_at).getTime() <= now) {
    throw new ExecutionPolicyError("execution instruction is expired");
  }
  const policy = body.session_policy || session?.session_policy || null;
  if (policy?.kill_switch === true && !recoveryAction) {
    throw new ExecutionPolicyError("session policy kill switch is active");
  }
  if (policy?.expires_at && new Date(policy.expires_at).getTime() <= now && !recoveryAction) {
    throw new ExecutionPolicyError("session policy is expired");
  }
  await enforceLogicalSpotReduction({ body, instruction, policy, state, trustedInternal: trusted_internal });
  enforceAgentMandatePolicy({ body, instruction, liveSubmit: Boolean(state), now });
  if (instruction.order) {
    const allowlist = Array.isArray(policy?.market_allowlist)
      ? policy.market_allowlist.map((item) => String(item).toUpperCase())
      : [];
    if (
      allowlist.length > 0 &&
      instruction.venue_id !== "jupiter" &&
      !marketAllowedByPolicy(instruction.order.market, allowlist)
    ) {
      throw new ExecutionPolicyError("execution instruction market is outside session allowlist");
    }
    const maxNotional = bucketToUsd(policy?.max_notional_bucket);
    const notional = estimateOrderNotionalUsd(instruction.order);
    const minNotional = bucketToUsd(process.env.PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD || "0");
    if (notional <= 0) {
      throw new ExecutionPolicyError("execution instruction notional must be positive");
    }
    if (!recoveryAction && minNotional > 0 && notional < minNotional) {
      throw new ExecutionPolicyError("execution instruction is below min notional");
    }
    if (!recoveryAction && maxNotional > 0 && notional > maxNotional) {
      throw new ExecutionPolicyError("execution instruction exceeds max notional bucket");
    }
    if (account_usage) {
      await enforceGlobalSessionDailyNotional({ body, instruction, state, policy, notional });
      await enforceHyperliquidTinyFillPolicy({ body, instruction, state, notional });
      await enforceHyperliquidFullTicketPolicy({ body, instruction, state, notional });
      await enforceAsterFullTicketPolicy({ body, instruction, state, notional });
      await enforceLighterFullTicketPolicy({ body, instruction, state, notional });
    }
  }
  const rateLimit = Number.parseInt(process.env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE || "0", 10);
  if (account_usage && state && Number.isInteger(rateLimit) && rateLimit > 0) {
    const minute = Math.floor(Date.now() / 60_000);
    const count = await state.incrementPolicyCount(
      `rate:${instruction.venue_id}:${minute}`,
      rateLimit,
    );
    if (!count.ok) throw new ExecutionPolicyError("private execution rate limit exceeded", 429);
  }
  if (account_usage && state && policy?.policy_commitment && Number.isInteger(policy.max_order_count)) {
    const countedOps = ["limit_order", "spot_limit_order", "spot_market_order", "preview_order", "perp_limit_order", "swap"];
    if (countedOps.includes(instruction.operation_class) && instruction.order?.reduce_only !== true) {
      const count = await state.incrementPolicyCount(policy.policy_commitment, policy.max_order_count);
      if (!count.ok) throw new ExecutionPolicyError("session policy order count exceeded");
    }
  }
}

async function enforceLogicalSpotReduction({ body, instruction, policy, state, trustedInternal }) {
  if (instruction.venue_id !== "coinbase_advanced" || instruction.order?.reduce_only !== true) return;
  if (!trustedInternal) {
    throw new ExecutionPolicyError("coinbase logical reduce-only is restricted to the protected recovery worker");
  }
  const sessionId = stringValue(body.autopilot_session_id);
  if (!sessionId || typeof state?.getAutopilotSession !== "function" || typeof state?.listAutopilotPositions !== "function") {
    throw new ExecutionPolicyError("coinbase logical reduce-only requires portfolio position state");
  }
  const autopilot = await state.getAutopilotSession(sessionId);
  const commitment = stringValue(body.policy_commitment || policy?.policy_commitment);
  if (!autopilot || autopilot.session_policy?.policy_commitment !== commitment) {
    throw new ExecutionPolicyError("coinbase logical reduce-only policy binding failed");
  }
  const position = (await state.listAutopilotPositions(sessionId)).find((item) =>
    item.venue_id === "coinbase_advanced" &&
    String(item.market || "").toUpperCase() === String(instruction.order.market || "").toUpperCase() &&
    Math.abs(Number(item.signed_notional_micro_usdc || 0)) > 0
  );
  const signedNotional = Number(position?.signed_notional_micro_usdc || 0);
  const directionReduces = signedNotional > 0
    ? instruction.order.side === "sell"
    : signedNotional < 0 && instruction.order.side === "buy";
  if (!position || !directionReduces) {
    throw new ExecutionPolicyError("coinbase logical reduce-only does not reduce a recorded position");
  }
  const requestedBase = exactPositiveDecimal(instruction.order.base_size);
  const recordedBase = exactAbsolutePositiveDecimal(position.signed_base_size);
  if (!requestedBase) {
    throw new ExecutionPolicyError("coinbase logical reduce-only base size is invalid");
  }
  if (recordedBase) {
    if (compareExactPositiveDecimals(requestedBase, recordedBase) > 0) {
      throw new ExecutionPolicyError("coinbase logical reduce-only exceeds the recorded base position");
    }
    return;
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    throw new ExecutionPolicyError("coinbase logical reduce-only exact base position is unavailable");
  }
  const requestedNotional = estimateOrderNotionalUsd(instruction.order);
  const existingNotional = Math.abs(signedNotional) / 1_000_000;
  const slippage = Math.max(0, Number(policy?.max_slippage_bps || 0)) / 10_000;
  if (requestedNotional > existingNotional * (1 + slippage + 0.001)) {
    throw new ExecutionPolicyError("coinbase logical reduce-only exceeds the recorded dry-run position");
  }
}

function normalizeAgentMandate(value) {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionPolicyError("agent mandate is invalid");
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new ExecutionPolicyError("agent mandate version must be 1");
  }
  const strategyProfile = stringValue(value.strategy_profile || "momentum_continuation");
  const entryTrigger = stringValue(value.entry_trigger || "preview_now");
  const exitRule = stringValue(value.exit_rule || "manual_approval");
  const timeHorizon = stringValue(value.time_horizon || "scalp");
  if (!AGENT_STRATEGY_PROFILE_VALUES.has(strategyProfile)) {
    throw new ExecutionPolicyError("agent mandate strategy is unsupported");
  }
  if (!AGENT_ENTRY_TRIGGER_VALUES.has(entryTrigger)) {
    throw new ExecutionPolicyError("agent mandate entry trigger is unsupported");
  }
  if (!AGENT_EXIT_RULE_VALUES.has(exitRule)) {
    throw new ExecutionPolicyError("agent mandate exit rule is unsupported");
  }
  if (!AGENT_TIME_HORIZON_VALUES.has(timeHorizon)) {
    throw new ExecutionPolicyError("agent mandate horizon is unsupported");
  }
  const triggerLevel = optionalPositiveDecimal(value.trigger_level, "agent mandate trigger level is invalid");
  const invalidationLevel = optionalPositiveDecimal(value.invalidation_level, "agent mandate invalidation level is invalid");
  const edgeThresholdBps = optionalBps(value.edge_threshold_bps, "agent mandate edge threshold is invalid");
  const timeWindow = stringValue(value.time_window);
  const strategyNote = stringValue(value.strategy_note);
  if (strategyNote.length > 240) {
    throw new ExecutionPolicyError("agent mandate strategy note is too long");
  }
  if (timeWindow.length > 64) {
    throw new ExecutionPolicyError("agent mandate time window is too long");
  }
  if (needsAgentTriggerLevel(entryTrigger) && !triggerLevel) {
    throw new ExecutionPolicyError("agent mandate trigger level is required");
  }
  if (needsAgentEdgeThreshold(strategyProfile, entryTrigger) && !edgeThresholdBps) {
    throw new ExecutionPolicyError("agent mandate edge threshold is required");
  }
  if (needsAgentInvalidationLevel(strategyProfile, exitRule) && !invalidationLevel) {
    throw new ExecutionPolicyError("agent mandate invalidation level is required");
  }
  if (needsAgentTimeWindow(timeHorizon, exitRule) && !timeWindow) {
    throw new ExecutionPolicyError("agent mandate time window is required");
  }
  if ((strategyProfile === "custom" || entryTrigger === "custom") && strategyNote.length < 8) {
    throw new ExecutionPolicyError("agent mandate custom rule is required");
  }
  return {
    version: 1,
    strategy_profile: strategyProfile,
    entry_trigger: entryTrigger,
    exit_rule: exitRule,
    time_horizon: timeHorizon,
    enforcement: "fail_closed_without_condition_proof",
    ...(triggerLevel ? { trigger_level: triggerLevel } : {}),
    ...(invalidationLevel ? { invalidation_level: invalidationLevel } : {}),
    ...(edgeThresholdBps ? { edge_threshold_bps: edgeThresholdBps } : {}),
    ...(timeWindow ? { time_window: timeWindow } : {}),
    ...(strategyNote ? { strategy_note: strategyNote } : {}),
    ...(value.condition_proof ? { condition_proof: normalizeAgentConditionProof(value.condition_proof) } : {}),
  };
}

function normalizeAgentConditionProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionPolicyError("agent mandate condition proof is invalid");
  }
  const proof = {
    status: stringValue(value.status),
    proof_id: stringValue(value.proof_id),
    strategy_profile: stringValue(value.strategy_profile),
    entry_trigger: stringValue(value.entry_trigger),
    venue_id: stringValue(value.venue_id),
    market: stringValue(value.market),
    checked_at: stringOrNull(value.checked_at),
    expires_at: stringOrNull(value.expires_at),
    evidence_commitment: stringValue(value.evidence_commitment),
    exit_rule_supported: value.exit_rule_supported === true,
  };
  if (proof.status !== "satisfied") {
    throw new ExecutionPolicyError("agent mandate condition proof is not satisfied");
  }
  if (proof.strategy_profile && !AGENT_STRATEGY_PROFILE_VALUES.has(proof.strategy_profile)) {
    throw new ExecutionPolicyError("agent mandate condition proof strategy is unsupported");
  }
  if (proof.entry_trigger && !AGENT_ENTRY_TRIGGER_VALUES.has(proof.entry_trigger)) {
    throw new ExecutionPolicyError("agent mandate condition proof trigger is unsupported");
  }
  if (proof.venue_id && !/^[a-z0-9_:-]{2,48}$/i.test(proof.venue_id)) {
    throw new ExecutionPolicyError("agent mandate condition proof venue is invalid");
  }
  if (proof.market && !/^[A-Z0-9/_:-]{2,32}$/i.test(proof.market)) {
    throw new ExecutionPolicyError("agent mandate condition proof market is invalid");
  }
  if (proof.evidence_commitment && !/^[A-Za-z0-9_:-]{8,180}$/.test(proof.evidence_commitment)) {
    throw new ExecutionPolicyError("agent mandate condition proof commitment is invalid");
  }
  return proof;
}

function enforceAgentMandatePolicy({ body, instruction, liveSubmit, now }) {
  const mandate = instruction?.mandate || null;
  if (!mandate || !SUBMITTING_OPERATIONS.has(instruction.operation_class)) return;
  if (!liveSubmit) return;
  const proof = mandate.condition_proof ||
    (body.mandate_condition_proof && typeof body.mandate_condition_proof === "object"
      ? normalizeAgentConditionProof(body.mandate_condition_proof)
      : null);
  if (!agentMandateRequiresConditionProof(mandate)) return;
  if (!proof) {
    throw new ExecutionPolicyError("agent mandate proof is required before live execution");
  }
  if (proof.expires_at && new Date(proof.expires_at).getTime() <= now) {
    throw new ExecutionPolicyError("agent mandate proof is expired");
  }
  if (proof.strategy_profile && proof.strategy_profile !== mandate.strategy_profile) {
    throw new ExecutionPolicyError("agent mandate proof strategy mismatch");
  }
  if (proof.entry_trigger && proof.entry_trigger !== mandate.entry_trigger) {
    throw new ExecutionPolicyError("agent mandate proof trigger mismatch");
  }
  if (proof.venue_id && proof.venue_id !== instruction.venue_id) {
    throw new ExecutionPolicyError("agent mandate proof venue mismatch");
  }
  if (
    proof.market &&
    instruction.order?.market &&
    !marketAllowedByPolicy(instruction.order.market, [proof.market.toUpperCase()])
  ) {
    throw new ExecutionPolicyError("agent mandate proof market mismatch");
  }
  if (mandate.exit_rule !== "manual_approval" && proof.exit_rule_supported !== true) {
    throw new ExecutionPolicyError("agent mandate exit rule is not supported by the proof");
  }
}

function agentMandateRequiresConditionProof(mandate) {
  return mandate.entry_trigger !== "preview_now" ||
    mandate.exit_rule !== "manual_approval" ||
    mandate.strategy_profile === "custom";
}

async function enforceGlobalSessionDailyNotional({ body, instruction, state, policy, notional }) {
  if (!state || !policy) return;
  if (instruction.order?.reduce_only === true) return;
  const dailyCap = bucketToUsd(policy.max_daily_notional_bucket);
  if (dailyCap <= 0) return;
  const countedOps = ["limit_order", "spot_limit_order", "spot_market_order", "perp_limit_order", "swap"];
  if (!countedOps.includes(instruction.operation_class)) return;
  const day = new Date().toISOString().slice(0, 10);
  const subject = policy.policy_commitment ||
    body.policy_commitment ||
    body.autopilot_session_id ||
    "unknown";
  const amount = await state.incrementPolicyAmount(
    `session_daily_notional:${subject}:${day}`,
    notional,
    dailyCap,
  );
  if (!amount.ok) throw new ExecutionPolicyError("session policy daily notional cap exceeded");
}

function allowedOperationsForVenue(venueId) {
  if (venueId === "coinbase_advanced") return COINBASE_ALLOWED;
  if (venueId === "jupiter") return JUPITER_ALLOWED;
  if (
    venueId === "phoenix" ||
    venueId === "drift" ||
    venueId === "backpack" ||
    venueId === "solana_perps"
  ) {
    return SOLANA_PERPS_ALLOWED;
  }
  return HYPERLIQUID_ALLOWED;
}

async function enforceHyperliquidTinyFillPolicy({ body, instruction, state, notional }) {
  if (instruction.venue_id !== "hyperliquid" || instruction.operation_class !== "limit_order") {
    return;
  }
  const order = instruction.order;
  if (
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE === "full_ticket" &&
    order.live_order_mode !== "tiny_fill"
  ) {
    return;
  }
  if (order.live_order_mode !== "tiny_fill" && !order.quote_size) return;
  if (order.live_order_mode !== "tiny_fill") {
    throw new ExecutionPolicyError("hyperliquid live order must use tiny_fill mode");
  }
  if (order.tif !== "Ioc") {
    throw new ExecutionPolicyError("hyperliquid tiny fill must use IOC");
  }
  if (!order.quote_size) {
    throw new ExecutionPolicyError("hyperliquid tiny fill requires quote size");
  }
  const perOrderCap = Math.min(
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD, 50),
    50,
  );
  if (notional > perOrderCap) {
    throw new ExecutionPolicyError("hyperliquid tiny fill exceeds live notional cap");
  }
  const maxSlippageBps = Number.parseInt(order.max_slippage_bps || "50", 10);
  const allowedSlippageBps = Math.min(
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS, 50),
    100,
  );
  if (
    !Number.isInteger(maxSlippageBps) ||
    maxSlippageBps < 1 ||
    maxSlippageBps > allowedSlippageBps
  ) {
    throw new ExecutionPolicyError("hyperliquid tiny fill slippage is outside policy");
  }
  const dailyCap = Math.min(
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD, 250),
    250,
  );
  if (state && dailyCap > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const subject = body.vault_commitment ||
      body.managed_allocation_commitment ||
      body.policy_commitment ||
      "unknown";
    const amount = await state.incrementPolicyAmount(
      `hyperliquid_live_notional:${subject}:${day}`,
      notional,
      dailyCap,
    );
    if (!amount.ok) throw new ExecutionPolicyError("hyperliquid tiny fill daily notional cap exceeded");
  }
}

async function enforceAsterFullTicketPolicy({ body, instruction, state, notional }) {
  if (instruction.venue_id !== "aster" || instruction.operation_class !== "limit_order" || instruction.order?.reduce_only === true) return;
  if (process.env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET !== "true" || process.env.PRIVATE_AGENT_ASTER_LIVE_MODE !== "full_ticket") {
    throw new ExecutionPolicyError("aster live execution is disabled");
  }
  if (instruction.order.tif !== "Ioc") {
    throw new ExecutionPolicyError("aster paired entry must use IOC");
  }
  const perOrderCap = Math.min(capUsd(process.env.PRIVATE_AGENT_ASTER_FULL_TICKET_MAX_NOTIONAL_USD, 25), 1_000);
  if (notional > perOrderCap) throw new ExecutionPolicyError("aster order exceeds the live notional cap");
  const dailyCap = Math.min(capUsd(process.env.PRIVATE_AGENT_ASTER_DAILY_NOTIONAL_CAP_USD, 100), 10_000);
  if (state && dailyCap > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const subject = body.vault_commitment || body.policy_commitment || "unknown";
    const amount = await state.incrementPolicyAmount(`aster_full_ticket_notional:${subject}:${day}`, notional, dailyCap);
    if (!amount.ok) throw new ExecutionPolicyError("aster daily notional cap exceeded");
  }
}

async function enforceLighterFullTicketPolicy({ body, instruction, state, notional }) {
  if (instruction.venue_id !== "lighter" || instruction.operation_class !== "limit_order" || instruction.order?.reduce_only === true) return;
  if (process.env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET !== "true" || process.env.PRIVATE_AGENT_LIGHTER_LIVE_MODE !== "full_ticket") {
    throw new ExecutionPolicyError("lighter live execution is disabled");
  }
  if (instruction.order.tif !== "Ioc") {
    throw new ExecutionPolicyError("lighter paired entry must use IOC");
  }
  const perOrderCap = Math.min(capUsd(process.env.PRIVATE_AGENT_LIGHTER_FULL_TICKET_MAX_NOTIONAL_USD, 25), 1_000);
  if (notional > perOrderCap) throw new ExecutionPolicyError("lighter order exceeds the live notional cap");
  const dailyCap = Math.min(capUsd(process.env.PRIVATE_AGENT_LIGHTER_DAILY_NOTIONAL_CAP_USD, 100), 10_000);
  if (state && dailyCap > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const subject = body.vault_commitment || body.policy_commitment || "unknown";
    const amount = await state.incrementPolicyAmount(`lighter_full_ticket_notional:${subject}:${day}`, notional, dailyCap);
    if (!amount.ok) throw new ExecutionPolicyError("lighter daily notional cap exceeded");
  }
}

async function enforceHyperliquidFullTicketPolicy({ body, instruction, state, notional }) {
  if (instruction.venue_id !== "hyperliquid" || instruction.operation_class !== "limit_order") {
    return;
  }
  if (instruction.order.live_order_mode === "tiny_fill" || instruction.order.quote_size && !instruction.order.order_type) {
    return;
  }
  if (process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE !== "full_ticket") {
    return;
  }
  const maxSlippageBps = Number.parseInt(instruction.order.max_slippage_bps || "50", 10);
  const allowedSlippageBps = Math.min(
    capBps(
      process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS,
      100,
    ),
    100,
  );
  if (
    !Number.isInteger(maxSlippageBps) ||
    maxSlippageBps < 1 ||
    maxSlippageBps > allowedSlippageBps
  ) {
    throw new ExecutionPolicyError("hyperliquid full-ticket slippage is outside policy");
  }
  if (instruction.order.reduce_only === true) return;
  const perOrderCap = capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD, 0);
  if (perOrderCap <= 0) {
    throw new ExecutionPolicyError("hyperliquid full-ticket max notional is not configured");
  }
  const launchPerOrderCap = capUsd(
    process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD ||
      process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
    1_000,
  );
  const effectivePerOrderCap = Math.min(perOrderCap, launchPerOrderCap);
  if (notional > effectivePerOrderCap) {
    throw new ExecutionPolicyError("hyperliquid full-ticket order exceeds live notional cap");
  }
  const dailyCap = Math.min(
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD, 0),
    capUsd(process.env.PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD || process.env.GHOLA_LIVE_TRADING_DAILY_CAP_USD, 5_000),
  );
  if (state && dailyCap > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const subject = body.vault_commitment ||
      body.managed_allocation_commitment ||
      body.policy_commitment ||
      "unknown";
    const amount = await state.incrementPolicyAmount(
      `hyperliquid_full_ticket_notional:${subject}:${day}`,
      notional,
      dailyCap,
    );
    if (!amount.ok) throw new ExecutionPolicyError("hyperliquid full-ticket daily notional cap exceeded");
  }
}

export function estimateOrderNotionalUsd(order) {
  const base = Number.parseFloat(order.base_size || "");
  const price = Number.parseFloat(order.limit_price || "");
  if (
    order.size_mode === "base" &&
    Number.isFinite(base) &&
    Number.isFinite(price) &&
    base > 0 &&
    price > 0
  ) {
    return base * price;
  }
  const quote = Number.parseFloat(order.quote_size || "");
  if (Number.isFinite(quote) && quote > 0) return quote;
  if (Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0) {
    return base * price;
  }
  return 0;
}

export function bucketToUsd(bucket) {
  const number = Number.parseFloat(String(bucket || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function normalizeMarket(market, venueId) {
  const normalized = String(market || "").trim().toUpperCase();
  if (!/^[A-Z0-9/_:-]{2,32}$/.test(normalized)) {
    throw new ExecutionPolicyError("execution instruction market is invalid");
  }
  if (venueId === "coinbase_advanced" && !normalized.includes("-")) {
    return `${normalized}-USD`;
  }
  return normalized;
}

function marketAllowedByPolicy(market, allowlist) {
  const normalized = String(market || "").toUpperCase();
  const base = normalized
    .replace(/_USDC_PERP$/, "")
    .replace(/-PERP$/, "")
    .split("-")[0]
    .split("/")[0];
  return allowlist.includes(normalized) ||
    allowlist.includes(`${normalized}-USD`) ||
    allowlist.includes(`${normalized}/USDC`) ||
    allowlist.includes(base) ||
    allowlist.includes(`${base}-USD`) ||
    allowlist.includes(`${base}/USDC`) ||
    allowlist.includes(`${base}-PERP`) ||
    allowlist.includes(`${base}_USDC_PERP`);
}

function normalizeTif(tif, venueId) {
  const normalized = String(tif || "").trim().toLowerCase();
  if (venueId === "coinbase_advanced") {
    if (normalized === "gtc" || normalized === "good_til_cancelled") return "gtc";
    if (normalized === "ioc" || normalized === "immediate_or_cancel") return "ioc";
    if (normalized === "fok" || normalized === "fill_or_kill") return "fok";
    return "gtc";
  }
  if (normalized === "alo" || normalized === "post_only") return "Alo";
  if (normalized === "ioc") return "Ioc";
  return "Gtc";
}

function normalizeOrderType(value) {
  const normalized = stringValue(value).toLowerCase();
  if (!normalized || normalized === "limit") return "limit";
  if (normalized === "market") return "market";
  throw new ExecutionPolicyError("execution instruction order type is unsupported");
}

function normalizeSizeMode(value) {
  const normalized = stringValue(value).toLowerCase();
  if (!normalized || normalized === "base") return "base";
  if (normalized === "quote") return "quote";
  throw new ExecutionPolicyError("execution instruction size mode is unsupported");
}

function normalizeLiveOrderMode(value) {
  const normalized = stringValue(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === "tiny_fill") return "tiny_fill";
  throw new ExecutionPolicyError("execution instruction live order mode is unsupported");
}

function decimalString(value) {
  const string = stringValue(value);
  if (!string) return null;
  if (!/^\d+(?:\.\d+)?$/.test(string)) {
    throw new ExecutionPolicyError("execution instruction numeric field is invalid");
  }
  return string;
}

function exactPositiveDecimal(value) {
  const parsed = exactDecimalParts(value);
  return parsed && parsed.units > 0n ? exactDecimalString(parsed) : null;
}

function exactAbsolutePositiveDecimal(value) {
  const text = stringValue(value);
  if (!text || text.length > MAX_EXACT_BASE_DIGITS + 2) return null;
  const parsed = exactDecimalParts(text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text);
  return parsed && parsed.units > 0n ? exactDecimalString(parsed) : null;
}

function compareExactPositiveDecimals(left, right) {
  const leftParts = exactDecimalParts(left);
  const rightParts = exactDecimalParts(right);
  if (!leftParts || !rightParts) throw new ExecutionPolicyError("coinbase logical reduce-only exact base position is unavailable");
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftUnits = leftParts.units * (10n ** BigInt(scale - leftParts.scale));
  const rightUnits = rightParts.units * (10n ** BigInt(scale - rightParts.scale));
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function exactDecimalParts(value) {
  const text = stringValue(value);
  if (!text || text.length > MAX_EXACT_BASE_DIGITS + 1) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] || "";
  if (match[1].length + fraction.length > MAX_EXACT_BASE_DIGITS || fraction.length > MAX_EXACT_BASE_SCALE) return null;
  return { units: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function exactDecimalString({ units, scale }) {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function integerString(value) {
  const string = stringValue(value);
  if (!string) return null;
  if (!/^\d+$/.test(string)) {
    throw new ExecutionPolicyError("execution instruction integer field is invalid");
  }
  return string;
}

function optionalPositiveDecimal(value, message) {
  const string = stringValue(value);
  if (!string) return null;
  if (!/^\d+(?:\.\d+)?$/.test(string) || Number(string) <= 0) {
    throw new ExecutionPolicyError(message);
  }
  return string;
}

function optionalBps(value, message) {
  const string = stringValue(value);
  if (!string) return null;
  if (!/^\d+$/.test(string) || Number(string) < 1 || Number(string) > 500) {
    throw new ExecutionPolicyError(message);
  }
  return string;
}

function needsAgentTriggerLevel(entryTrigger) {
  return entryTrigger === "break_level" || entryTrigger === "retest_level" || entryTrigger === "sweep_reclaim";
}

function needsAgentEdgeThreshold(strategyProfile, entryTrigger) {
  return (
    entryTrigger === "book_imbalance" ||
    entryTrigger === "funding_mark_divergence" ||
    entryTrigger === "route_edge_threshold" ||
    strategyProfile === "funding_mark_divergence" ||
    strategyProfile === "venue_route_edge"
  );
}

function needsAgentInvalidationLevel(strategyProfile, exitRule) {
  return (
    exitRule === "exit_on_invalidation" ||
    exitRule === "reduce_on_risk_flip" ||
    strategyProfile === "sweep_reclaim"
  );
}

function needsAgentTimeWindow(timeHorizon, exitRule) {
  return timeHorizon === "custom_window" || exitRule === "time_stop";
}

function isSolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || ""));
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
