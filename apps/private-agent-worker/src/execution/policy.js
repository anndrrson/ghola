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

export class ExecutionPolicyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ExecutionPolicyError";
    this.status = status;
  }
}

export function assertVenueOperationAllowed(venueId, operationClass) {
  const allowed = venueId === "coinbase_advanced" ? COINBASE_ALLOWED : HYPERLIQUID_ALLOWED;
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
  if (["limit_order", "spot_limit_order", "spot_market_order", "preview_order"].includes(op)) {
    if (!order) throw new ExecutionPolicyError("execution instruction order is required");
    return {
      version: 1,
      venue_id,
      operation_class: op,
      expires_at: stringOrNull(value.expires_at),
      order: normalizeOrder(order, venue_id, op),
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
    };
  }
  return {
    version: 1,
    venue_id,
    operation_class: op,
    expires_at: stringOrNull(value.expires_at),
    reconcile: value.reconcile && typeof value.reconcile === "object" ? value.reconcile : {},
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
  const hyperliquidTinyFill =
    venueId === "hyperliquid" &&
    operationClass === "limit_order" &&
    liveOrderMode === "tiny_fill";
  const limitPrice = decimalString(order.limit_price ?? order.price ?? order.px);
  if (operationClass !== "spot_market_order" && !hyperliquidTinyFill && !limitPrice) {
    throw new ExecutionPolicyError("execution instruction limit price is required");
  }
  const baseSize = decimalString(order.base_size ?? order.size ?? order.sz);
  const quoteSize = decimalString(order.quote_size ?? order.notional_usd);
  if (!baseSize && !quoteSize) {
    throw new ExecutionPolicyError("execution instruction size is required");
  }
  if (hyperliquidTinyFill && !quoteSize) {
    throw new ExecutionPolicyError("hyperliquid tiny fill requires quote size");
  }
  const tif = stringValue(order.tif || order.time_in_force || "Gtc");
  const normalizedTif = hyperliquidTinyFill ? "Ioc" : normalizeTif(tif, venueId);
  const maxSlippageBps = integerString(order.max_slippage_bps ?? order.slippage_bps);
  return {
    market: normalizeMarket(market, venueId),
    side,
    base_size: baseSize,
    quote_size: quoteSize,
    limit_price: limitPrice,
    tif: normalizedTif,
    live_order_mode: liveOrderMode,
    max_slippage_bps: maxSlippageBps,
    post_only: order.post_only === true,
    reduce_only: order.reduce_only === true,
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

export function enforceInstructionPolicy({ body, instruction, session, state }) {
  if (process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH === "true") {
    throw new ExecutionPolicyError("private execution kill switch is active", 503);
  }
  const now = Date.now();
  if (instruction.expires_at && new Date(instruction.expires_at).getTime() <= now) {
    throw new ExecutionPolicyError("execution instruction is expired");
  }
  const policy = body.session_policy || session?.session_policy || null;
  if (policy?.kill_switch === true) {
    throw new ExecutionPolicyError("session policy kill switch is active");
  }
  if (policy?.expires_at && new Date(policy.expires_at).getTime() <= now) {
    throw new ExecutionPolicyError("session policy is expired");
  }
  if (instruction.order) {
    const allowlist = Array.isArray(policy?.market_allowlist)
      ? policy.market_allowlist.map((item) => String(item).toUpperCase())
      : [];
    if (allowlist.length > 0 && !allowlist.includes(instruction.order.market.toUpperCase())) {
      throw new ExecutionPolicyError("execution instruction market is outside session allowlist");
    }
    const maxNotional = bucketToUsd(policy?.max_notional_bucket);
    const notional = estimateOrderNotionalUsd(instruction.order);
    const minNotional = bucketToUsd(process.env.PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD || "0");
    if (notional <= 0) {
      throw new ExecutionPolicyError("execution instruction notional must be positive");
    }
    if (minNotional > 0 && notional < minNotional) {
      throw new ExecutionPolicyError("execution instruction is below min notional");
    }
    if (maxNotional > 0 && notional > maxNotional) {
      throw new ExecutionPolicyError("execution instruction exceeds max notional bucket");
    }
    enforceHyperliquidTinyFillPolicy({ body, instruction, state, notional });
  }
  const rateLimit = Number.parseInt(process.env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE || "0", 10);
  if (state && Number.isInteger(rateLimit) && rateLimit > 0) {
    const minute = Math.floor(Date.now() / 60_000);
    const count = state.incrementPolicyCount(
      `rate:${instruction.venue_id}:${minute}`,
      rateLimit,
    );
    if (!count.ok) throw new ExecutionPolicyError("private execution rate limit exceeded", 429);
  }
  if (state && policy?.policy_commitment && Number.isInteger(policy.max_order_count)) {
    const countedOps = ["limit_order", "spot_limit_order", "spot_market_order", "preview_order"];
    if (countedOps.includes(instruction.operation_class)) {
      const count = state.incrementPolicyCount(policy.policy_commitment, policy.max_order_count);
      if (!count.ok) throw new ExecutionPolicyError("session policy order count exceeded");
    }
  }
}

function enforceHyperliquidTinyFillPolicy({ body, instruction, state, notional }) {
  if (instruction.venue_id !== "hyperliquid" || instruction.operation_class !== "limit_order") {
    return;
  }
  const order = instruction.order;
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
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD, 5),
    25,
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
    capUsd(process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD, 25),
    100,
  );
  if (state && dailyCap > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const subject = body.vault_commitment ||
      body.managed_allocation_commitment ||
      body.policy_commitment ||
      "unknown";
    const amount = state.incrementPolicyAmount(
      `hyperliquid_live_notional:${subject}:${day}`,
      notional,
      dailyCap,
    );
    if (!amount.ok) throw new ExecutionPolicyError("hyperliquid tiny fill daily notional cap exceeded");
  }
}

export function estimateOrderNotionalUsd(order) {
  const quote = Number.parseFloat(order.quote_size || "");
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number.parseFloat(order.base_size || "");
  const price = Number.parseFloat(order.limit_price || "");
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

function integerString(value) {
  const string = stringValue(value);
  if (!string) return null;
  if (!/^\d+$/.test(string)) {
    throw new ExecutionPolicyError("execution instruction integer field is invalid");
  }
  return string;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
