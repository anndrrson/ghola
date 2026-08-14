import { TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS } from "./terminal-route-cost-policy";

export const TRADE_ORDER_PLAN_VERSION = 1 as const;
export const TRADE_ORDER_PLAN_KIND = "ghola_trade_order_plan" as const;

export type TradeOrderVenueId = "hyperliquid" | "phoenix" | "coinbase";
export type TradeOrderSide = "buy" | "sell";
export type TradeOrderInterval = "1m" | "5m" | "15m" | "1h";
export type TradeOrderTimeInForce = "gtc" | "ioc" | "fok";

export interface TradeOrderPlan {
  version: typeof TRADE_ORDER_PLAN_VERSION;
  kind: typeof TRADE_ORDER_PLAN_KIND;
  venue_id: TradeOrderVenueId;
  network: "mainnet" | "testnet";
  coin: string;
  product: string;
  side: TradeOrderSide;
  order_type: "limit";
  time_in_force: TradeOrderTimeInForce;
  quote_notional_usd: string;
  base_size: string;
  limit_price: string;
  max_slippage_bps: number;
  /** HMAC-bound all-in loss authority. Absent only on legacy analytical plans. */
  risk_envelope?: TradeOrderRiskEnvelope;
  stop_intent: {
    stop_level: string;
    scope: "agent_plan_invalidation_only";
  };
  agent_mandate: {
    strategy_profile: string;
    entry_trigger: string;
    exit_rule: string;
    time_horizon: string;
    trigger_level: string | null;
    invalidation_level: string;
  };
  execution_policy: {
    submit: true;
    refresh_after_submit: true;
    fetch_fills: true;
    cancel_if_open: false;
    reduce_only: false;
  };
  market_context: {
    frame_version: 1;
    interval: TradeOrderInterval;
    fetched_at: string;
    max_age_ms: number;
    source_state: "live";
    /** Side-specific executable BBO captured with the plan. Required for new bindings. */
    execution_reference_price?: string;
  };
}

export interface TradeOrderRiskEnvelope {
  risk_budget_usd: string;
  stop_and_slippage_loss_usd: string;
  round_trip_cost_loss_usd: string;
  all_in_loss_usd: string;
  fee_bps: number;
  buffer_bps: number;
  /** Absent only on legacy analytical envelopes; live execution requires both. */
  fee_evidence_at?: string;
  buffer_evidence_at?: string;
  scope: "account_local_cost_assumption_v1";
}

export interface TradeOrderPlanBindingEnvelope {
  version: 1;
  algorithm: "HMAC-SHA256";
  preview_commitment: string;
  plan_digest: string;
  issued_at: string;
  expires_at: string;
  token: string;
  order_plan: TradeOrderPlan;
}

export interface TradeOrderPlanBuildInput {
  venueId: TradeOrderVenueId;
  network: "mainnet" | "testnet";
  coin: string;
  product: string;
  side: TradeOrderSide;
  timeInForce?: TradeOrderTimeInForce;
  quoteNotionalUsd: number;
  baseSize: number;
  limitPrice: number;
  maxSlippageBps: number;
  stopLevel: number;
  strategyProfile: string;
  entryTrigger: string;
  exitRule: string;
  timeHorizon: string;
  triggerLevel: number | null;
  interval: TradeOrderInterval;
  marketFetchedAt: string;
  executionReferencePrice: number;
  frameVersion: number;
  riskEnvelope?: {
    riskBudgetUsd: number;
    stopAndSlippageLossUsd: number;
    roundTripCostLossUsd: number;
    allInLossUsd: number;
    feeBps: number;
    bufferBps: number;
    feeEvidenceAtMs: number;
    bufferEvidenceAtMs: number;
  };
  nowMs?: number;
}

export type TradeOrderPlanValidation =
  | { ok: true; plan: TradeOrderPlan }
  | { ok: false; error: string };

const PLAN_KEYS = [
  "version",
  "kind",
  "venue_id",
  "network",
  "coin",
  "product",
  "side",
  "order_type",
  "time_in_force",
  "quote_notional_usd",
  "base_size",
  "limit_price",
  "max_slippage_bps",
  "risk_envelope",
  "stop_intent",
  "agent_mandate",
  "execution_policy",
  "market_context",
] as const;
const STOP_KEYS = ["stop_level", "scope"] as const;
const MANDATE_KEYS = [
  "strategy_profile",
  "entry_trigger",
  "exit_rule",
  "time_horizon",
  "trigger_level",
  "invalidation_level",
] as const;
const EXECUTION_KEYS = ["submit", "refresh_after_submit", "fetch_fills", "cancel_if_open", "reduce_only"] as const;
const MARKET_KEYS = ["frame_version", "interval", "fetched_at", "max_age_ms", "source_state", "execution_reference_price"] as const;
const RISK_KEYS = ["risk_budget_usd", "stop_and_slippage_loss_usd", "round_trip_cost_loss_usd", "all_in_loss_usd", "fee_bps", "buffer_bps", "fee_evidence_at", "buffer_evidence_at", "scope"] as const;
const LEGACY_RISK_KEYS = RISK_KEYS.filter((key) => key !== "fee_evidence_at" && key !== "buffer_evidence_at");
const VENUES = new Set<TradeOrderVenueId>(["hyperliquid", "phoenix", "coinbase"]);
const INTERVALS = new Set<TradeOrderInterval>(["1m", "5m", "15m", "1h"]);
const SAFE_TERM = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_COIN = /^[A-Z0-9]{2,12}$/;

export function buildTradeOrderPlan(input: TradeOrderPlanBuildInput): TradeOrderPlan | null {
  const limitPrice = canonicalTradeDecimal(input.limitPrice);
  const stopLevel = canonicalTradeDecimal(input.stopLevel);
  const quoteNotional = canonicalTradeDecimal(input.quoteNotionalUsd);
  const baseSize = canonicalTradeDecimal(input.baseSize, 8);
  const executionReferencePrice = canonicalTradeDecimal(input.executionReferencePrice);
  const triggerLevel = input.triggerLevel == null ? null : canonicalTradeDecimal(input.triggerLevel);
  const riskEnvelope = input.riskEnvelope ? canonicalRiskEnvelope(input.riskEnvelope) : null;
  if (!limitPrice || !stopLevel || !quoteNotional || !baseSize || !executionReferencePrice || (input.triggerLevel != null && !triggerLevel) || (input.riskEnvelope && !riskEnvelope)) return null;
  const slippageBound = tradeOrderPlanSlippageBound({
    side: input.side,
    limitPrice: Number(limitPrice),
    executionReferencePrice: Number(executionReferencePrice),
    maxSlippageBps: input.maxSlippageBps,
  });
  if (!slippageBound.allowed) return null;

  const timeInForce = input.timeInForce ?? "gtc";
  const candidate: TradeOrderPlan = {
    version: TRADE_ORDER_PLAN_VERSION,
    kind: TRADE_ORDER_PLAN_KIND,
    venue_id: input.venueId,
    network: input.network,
    coin: input.coin.toUpperCase(),
    product: input.product.toUpperCase(),
    side: input.side,
    order_type: "limit",
    time_in_force: timeInForce,
    quote_notional_usd: quoteNotional,
    base_size: baseSize,
    limit_price: limitPrice,
    max_slippage_bps: Math.trunc(input.maxSlippageBps),
    ...(riskEnvelope ? { risk_envelope: riskEnvelope } : {}),
    stop_intent: {
      stop_level: stopLevel,
      scope: "agent_plan_invalidation_only",
    },
    agent_mandate: {
      strategy_profile: input.strategyProfile,
      entry_trigger: input.entryTrigger,
      exit_rule: input.exitRule,
      time_horizon: input.timeHorizon,
      trigger_level: triggerLevel,
      invalidation_level: stopLevel,
    },
    execution_policy: {
      submit: true,
      refresh_after_submit: true,
      fetch_fills: true,
      cancel_if_open: false,
      reduce_only: false,
    },
    market_context: {
      frame_version: input.frameVersion === 1 ? 1 : input.frameVersion as 1,
      interval: input.interval,
      fetched_at: input.marketFetchedAt,
      max_age_ms: tradeOrderPlanFreshnessMs(input.interval),
      source_state: "live",
      execution_reference_price: executionReferencePrice,
    },
  };
  const validation = validateTradeOrderPlan(candidate, { nowMs: input.nowMs, requireFresh: true });
  return validation.ok ? validation.plan : null;
}

export function tradeOrderPlanIntentMatches(
  current: TradeOrderPlan,
  bound: TradeOrderPlan,
): boolean {
  return stableTradeStringify({
    ...current,
    market_context: {
      ...current.market_context,
      fetched_at: bound.market_context.fetched_at,
      execution_reference_price: bound.market_context.execution_reference_price,
    },
  }) === stableTradeStringify(bound);
}

export interface TradeOrderPlanSlippageBound {
  allowed: boolean;
  limitOffsetBps: number | null;
}

/** Positive offset is adverse executable reach; negative offset is resting distance. */
export function tradeOrderPlanSlippageBound(input: {
  side: TradeOrderSide;
  limitPrice: number | null;
  executionReferencePrice: number | null;
  maxSlippageBps: number;
}): TradeOrderPlanSlippageBound {
  if (
    (input.side !== "buy" && input.side !== "sell")
    || !positiveFinite(input.limitPrice)
    || !positiveFinite(input.executionReferencePrice)
    || !Number.isInteger(input.maxSlippageBps)
    || input.maxSlippageBps < 1
    || input.maxSlippageBps > 100
  ) return { allowed: false, limitOffsetBps: null };
  const limitOffsetBps = input.side === "buy"
    ? ((input.limitPrice as number) - (input.executionReferencePrice as number)) / (input.executionReferencePrice as number) * 10_000
    : ((input.executionReferencePrice as number) - (input.limitPrice as number)) / (input.executionReferencePrice as number) * 10_000;
  return {
    allowed: Number.isFinite(limitOffsetBps) && limitOffsetBps <= input.maxSlippageBps + 1e-8,
    limitOffsetBps: Number.isFinite(limitOffsetBps) ? limitOffsetBps : null,
  };
}

export function tradeOrderPlanMarketContextFresh(
  plan: TradeOrderPlan,
  nowMs = Date.now(),
): boolean {
  const fetchedAt = Date.parse(plan.market_context.fetched_at);
  return Number.isFinite(fetchedAt) && fetchedAt <= nowMs &&
    nowMs - fetchedAt <= plan.market_context.max_age_ms;
}

export function validateTradeOrderPlan(
  input: unknown,
  options: { nowMs?: number; requireFresh?: boolean; allowLegacySlippageReference?: boolean } = {},
): TradeOrderPlanValidation {
  const plan = objectValue(input);
  const legacyShape = Boolean(plan
    && !("risk_envelope" in plan)
    && Object.keys(plan).length === PLAN_KEYS.length - 1
    && Object.keys(plan).every((key) => PLAN_KEYS.includes(key as typeof PLAN_KEYS[number])));
  if (!plan || (!hasOnlyKeys(plan, PLAN_KEYS) && !legacyShape)) return invalid("order_plan_shape_invalid");
  if (plan.version !== TRADE_ORDER_PLAN_VERSION || plan.kind !== TRADE_ORDER_PLAN_KIND) return invalid("order_plan_version_invalid");
  if (typeof plan.venue_id !== "string" || !VENUES.has(plan.venue_id as TradeOrderVenueId)) return invalid("order_plan_venue_invalid");
  const venueId = plan.venue_id as TradeOrderVenueId;
  if (plan.network !== "mainnet" && plan.network !== "testnet") return invalid("order_plan_network_invalid");
  if (plan.network === "testnet" && venueId !== "hyperliquid") return invalid("order_plan_network_invalid");
  if (typeof plan.coin !== "string" || !SAFE_COIN.test(plan.coin)) return invalid("order_plan_coin_invalid");
  const expectedProduct = venueId === "coinbase" ? `${plan.coin}-USD` : `${plan.coin}-PERP`;
  if (plan.product !== expectedProduct) return invalid("order_plan_product_invalid");
  if (plan.side !== "buy" && plan.side !== "sell") return invalid("order_plan_side_invalid");
  if (
    plan.order_type !== "limit"
    || (plan.time_in_force !== "gtc" && plan.time_in_force !== "ioc" && plan.time_in_force !== "fok")
    || (venueId === "phoenix" && plan.time_in_force !== "gtc")
    || (venueId === "hyperliquid" && plan.time_in_force === "fok")
  ) return invalid("order_plan_order_type_invalid");

  const quoteNotional = strictCanonicalDecimal(plan.quote_notional_usd, 2);
  const baseSize = strictCanonicalDecimal(plan.base_size, 8);
  const limitPrice = strictCanonicalDecimal(plan.limit_price, 8);
  if (!quoteNotional || Number(quoteNotional) < 1 || Number(quoteNotional) > 100) return invalid("order_plan_notional_invalid");
  if (!baseSize) return invalid("order_plan_base_size_invalid");
  if (!limitPrice) return invalid("order_plan_limit_price_invalid");
  const representedNotional = Number(baseSize) * Number(limitPrice);
  if (!Number.isFinite(representedNotional) || Math.abs(representedNotional - Number(quoteNotional)) > 0.0051) {
    return invalid("order_plan_size_notional_mismatch");
  }
  if (!Number.isInteger(plan.max_slippage_bps) || Number(plan.max_slippage_bps) < 1 || Number(plan.max_slippage_bps) > 100) {
    return invalid("order_plan_slippage_invalid");
  }

  const stop = objectValue(plan.stop_intent);
  if (!stop || !hasOnlyKeys(stop, STOP_KEYS) || stop.scope !== "agent_plan_invalidation_only") return invalid("order_plan_stop_invalid");
  const stopLevel = strictCanonicalDecimal(stop.stop_level, 8);
  if (!stopLevel) return invalid("order_plan_stop_invalid");
  if (plan.side === "buy" ? Number(stopLevel) >= Number(limitPrice) : Number(stopLevel) <= Number(limitPrice)) {
    return invalid("order_plan_stop_side_invalid");
  }

  const riskEnvelope = plan.risk_envelope == null ? null : validateRiskEnvelope(plan.risk_envelope, {
    quoteNotionalUsd: Number(quoteNotional),
    limitPrice: Number(limitPrice),
    stopLevel: Number(stopLevel),
    maxSlippageBps: Number(plan.max_slippage_bps),
  }, { nowMs: options.nowMs, requireFresh: options.requireFresh });
  if (plan.risk_envelope != null && !riskEnvelope) return invalid("order_plan_risk_envelope_invalid");

  const mandate = objectValue(plan.agent_mandate);
  if (!mandate || !hasOnlyKeys(mandate, MANDATE_KEYS)) return invalid("order_plan_mandate_invalid");
  for (const key of ["strategy_profile", "entry_trigger", "exit_rule", "time_horizon"] as const) {
    if (typeof mandate[key] !== "string" || !SAFE_TERM.test(mandate[key])) return invalid("order_plan_mandate_invalid");
  }
  const triggerLevel = mandate.trigger_level == null ? null : strictCanonicalDecimal(mandate.trigger_level, 8);
  if (mandate.trigger_level != null && !triggerLevel) return invalid("order_plan_trigger_invalid");
  if (mandate.invalidation_level !== stopLevel) return invalid("order_plan_invalidation_mismatch");

  const execution = objectValue(plan.execution_policy);
  if (!execution || !hasOnlyKeys(execution, EXECUTION_KEYS)) return invalid("order_plan_execution_policy_invalid");
  if (
    execution.submit !== true ||
    execution.refresh_after_submit !== true ||
    execution.fetch_fills !== true ||
    execution.cancel_if_open !== false ||
    execution.reduce_only !== false
  ) return invalid("order_plan_execution_policy_invalid");

  const market = objectValue(plan.market_context);
  const marketShapeWithoutReference = Boolean(market
    && !("execution_reference_price" in market)
    && Object.keys(market).length === MARKET_KEYS.length - 1
    && Object.keys(market).every((key) => MARKET_KEYS.includes(key as typeof MARKET_KEYS[number])));
  if (!market || (!hasOnlyKeys(market, MARKET_KEYS) && !marketShapeWithoutReference)) {
    return invalid("order_plan_market_context_invalid");
  }
  if (market.frame_version !== 1 || typeof market.interval !== "string" || !INTERVALS.has(market.interval as TradeOrderInterval)) {
    return invalid("order_plan_market_version_invalid");
  }
  const interval = market.interval as TradeOrderInterval;
  if (market.max_age_ms !== tradeOrderPlanFreshnessMs(interval) || market.source_state !== "live") {
    return invalid("order_plan_market_freshness_invalid");
  }
  const fetchedAtMs = typeof market.fetched_at === "string" ? Date.parse(market.fetched_at) : Number.NaN;
  if (!Number.isFinite(fetchedAtMs) || new Date(fetchedAtMs).toISOString() !== market.fetched_at) {
    return invalid("order_plan_market_timestamp_invalid");
  }
  if (options.requireFresh !== false) {
    const nowMs = options.nowMs ?? Date.now();
    if (fetchedAtMs > nowMs + 5_000 || nowMs - fetchedAtMs > Number(market.max_age_ms)) {
      return invalid("order_plan_market_stale");
    }
  }
  const executionReferencePrice = strictCanonicalDecimal(market.execution_reference_price, 8);
  if (!executionReferencePrice && !options.allowLegacySlippageReference) {
    return invalid("order_plan_slippage_reference_invalid");
  }
  if (executionReferencePrice && !tradeOrderPlanSlippageBound({
    side: plan.side as TradeOrderSide,
    limitPrice: Number(limitPrice),
    executionReferencePrice: Number(executionReferencePrice),
    maxSlippageBps: Number(plan.max_slippage_bps),
  }).allowed) return invalid("order_plan_slippage_bound_invalid");

  return {
    ok: true,
    plan: {
      version: TRADE_ORDER_PLAN_VERSION,
      kind: TRADE_ORDER_PLAN_KIND,
      venue_id: venueId,
      network: plan.network as "mainnet" | "testnet",
      coin: plan.coin,
      product: plan.product,
      side: plan.side,
      order_type: "limit",
      time_in_force: plan.time_in_force as TradeOrderTimeInForce,
      quote_notional_usd: quoteNotional,
      base_size: baseSize,
      limit_price: limitPrice,
      max_slippage_bps: Number(plan.max_slippage_bps),
      ...(riskEnvelope ? { risk_envelope: riskEnvelope } : {}),
      stop_intent: { stop_level: stopLevel, scope: "agent_plan_invalidation_only" },
      agent_mandate: {
        strategy_profile: mandate.strategy_profile as string,
        entry_trigger: mandate.entry_trigger as string,
        exit_rule: mandate.exit_rule as string,
        time_horizon: mandate.time_horizon as string,
        trigger_level: triggerLevel,
        invalidation_level: stopLevel,
      },
      execution_policy: {
        submit: true,
        refresh_after_submit: true,
        fetch_fills: true,
        cancel_if_open: false,
        reduce_only: false,
      },
      market_context: {
        frame_version: 1,
        interval,
        fetched_at: market.fetched_at as string,
        max_age_ms: Number(market.max_age_ms),
        source_state: "live",
        ...(executionReferencePrice ? { execution_reference_price: executionReferencePrice } : {}),
      },
    },
  };
}

function canonicalRiskEnvelope(input: TradeOrderPlanBuildInput["riskEnvelope"]): TradeOrderRiskEnvelope | null {
  if (!input) return null;
  const candidate: TradeOrderRiskEnvelope = {
    risk_budget_usd: canonicalTradeDecimal(input.riskBudgetUsd, 8) ?? "",
    stop_and_slippage_loss_usd: canonicalTradeDecimal(input.stopAndSlippageLossUsd, 8) ?? "",
    round_trip_cost_loss_usd: canonicalNonNegativeTradeDecimal(input.roundTripCostLossUsd, 8) ?? "",
    all_in_loss_usd: canonicalTradeDecimal(input.allInLossUsd, 8) ?? "",
    fee_bps: input.feeBps,
    buffer_bps: input.bufferBps,
    fee_evidence_at: canonicalIsoFromMs(input.feeEvidenceAtMs) ?? "",
    buffer_evidence_at: canonicalIsoFromMs(input.bufferEvidenceAtMs) ?? "",
    scope: "account_local_cost_assumption_v1",
  };
  return validateRiskEnvelope(candidate, null, { requireFresh: false });
}

function validateRiskEnvelope(
  value: unknown,
  plan: { quoteNotionalUsd: number; limitPrice: number; stopLevel: number; maxSlippageBps: number } | null,
  options: { nowMs?: number; requireFresh?: boolean } = {},
): TradeOrderRiskEnvelope | null {
  const input = objectValue(value);
  const legacyShape = Boolean(input && hasOnlyKeys(input, LEGACY_RISK_KEYS));
  if (!input || (!hasOnlyKeys(input, RISK_KEYS) && !legacyShape) || input.scope !== "account_local_cost_assumption_v1") return null;
  const riskBudget = strictCanonicalDecimal(input.risk_budget_usd, 8);
  const stopLoss = strictCanonicalDecimal(input.stop_and_slippage_loss_usd, 8);
  const costLoss = strictCanonicalNonNegativeDecimal(input.round_trip_cost_loss_usd, 8);
  const allInLoss = strictCanonicalDecimal(input.all_in_loss_usd, 8);
  const feeBps = boundedCostBps(input.fee_bps);
  const bufferBps = boundedCostBps(input.buffer_bps);
  const feeEvidenceAt = input.fee_evidence_at === undefined ? undefined : canonicalIso(input.fee_evidence_at);
  const bufferEvidenceAt = input.buffer_evidence_at === undefined ? undefined : canonicalIso(input.buffer_evidence_at);
  if (!riskBudget || !stopLoss || costLoss == null || !allInLoss || feeBps == null || bufferBps == null) return null;
  if ((feeEvidenceAt == null) !== (bufferEvidenceAt == null)) return null;
  if ((input.fee_evidence_at !== undefined && !feeEvidenceAt) || (input.buffer_evidence_at !== undefined && !bufferEvidenceAt)) return null;
  if (feeEvidenceAt && bufferEvidenceAt && options.requireFresh !== false) {
    const nowMs = options.nowMs ?? Date.now();
    const timestamps = [Date.parse(feeEvidenceAt), Date.parse(bufferEvidenceAt)];
    if (!Number.isFinite(nowMs) || timestamps.some((timestamp) => timestamp > nowMs + 30_000 || nowMs - timestamp > TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS)) return null;
  }
  if (Number(allInLoss) > Number(riskBudget) + arithmeticTolerance(Number(riskBudget))) return null;
  if (Math.abs(Number(allInLoss) - Number(stopLoss) - Number(costLoss)) > arithmeticTolerance(Number(allInLoss))) return null;
  if (plan) {
    const expectedStopLoss = plan.quoteNotionalUsd * (
      Math.abs(plan.limitPrice - plan.stopLevel) / plan.limitPrice
      + plan.maxSlippageBps / 10_000
    );
    const expectedCostLoss = plan.quoteNotionalUsd * (2 * (feeBps + bufferBps)) / 10_000;
    if (Math.abs(Number(stopLoss) - expectedStopLoss) > arithmeticTolerance(expectedStopLoss)) return null;
    if (Math.abs(Number(costLoss) - expectedCostLoss) > arithmeticTolerance(expectedCostLoss)) return null;
  }
  return {
    risk_budget_usd: riskBudget,
    stop_and_slippage_loss_usd: stopLoss,
    round_trip_cost_loss_usd: costLoss,
    all_in_loss_usd: allInLoss,
    fee_bps: feeBps,
    buffer_bps: bufferBps,
    ...(feeEvidenceAt && bufferEvidenceAt ? { fee_evidence_at: feeEvidenceAt, buffer_evidence_at: bufferEvidenceAt } : {}),
    scope: "account_local_cost_assumption_v1",
  };
}

function boundedCostBps(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 500 ? value : null;
}

function arithmeticTolerance(expected: number) {
  return Math.max(1e-6, Math.abs(expected) * 1e-8);
}

function canonicalIso(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function canonicalIsoFromMs(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function assertExecutionMatchesTradeOrderPlan(body: unknown, plan: TradeOrderPlan): { ok: true } | { ok: false; error: string } {
  const request = objectValue(body);
  const intent = objectValue(request?.orderIntent);
  if (!request || !intent) return { ok: false, error: "bound_order_intent_missing" };
  const venues = Array.isArray(request.venueIds) ? request.venueIds : [];
  if (venues.length !== 1 || venues[0] !== plan.venue_id) return { ok: false, error: "bound_order_venue_mismatch" };
  const expectedSymbol = plan.venue_id === "hyperliquid" ? plan.coin : plan.product;
  const expectedIdempotencyKey = tradeOrderPlanIdempotencyKey(request.tradeOrderPlanBinding);
  if (!expectedIdempotencyKey || request.idempotencyKey !== expectedIdempotencyKey || intent.idempotencyKey !== expectedIdempotencyKey) {
    return { ok: false, error: "bound_order_idempotency_mismatch" };
  }
  const checks: Array<[unknown, unknown, string]> = [
    [intent.symbol, expectedSymbol, "bound_order_symbol_mismatch"],
    [intent.productId, plan.product, "bound_order_product_mismatch"],
    [intent.side, plan.side, "bound_order_side_mismatch"],
    [intent.orderType, plan.order_type, "bound_order_type_mismatch"],
    [intent.timeInForce, plan.time_in_force, "bound_order_tif_mismatch"],
    [intent.network, plan.network, "bound_order_network_mismatch"],
    [Number(intent.slippageBps), plan.max_slippage_bps, "bound_order_slippage_mismatch"],
    [request.submit, plan.execution_policy.submit, "bound_order_submit_policy_mismatch"],
    [request.refreshAfterSubmit, plan.execution_policy.refresh_after_submit, "bound_order_refresh_policy_mismatch"],
    [request.fetchFills, plan.execution_policy.fetch_fills, "bound_order_fill_policy_mismatch"],
    [request.cancelIfOpen, plan.execution_policy.cancel_if_open, "bound_order_cancel_policy_mismatch"],
  ];
  for (const [actual, expected, error] of checks) {
    if (actual !== expected) return { ok: false, error };
  }
  for (const [actual, expected, error] of [
    [intent.quoteSize, plan.quote_notional_usd, "bound_order_notional_mismatch"],
    [intent.baseSize, plan.base_size, "bound_order_base_size_mismatch"],
    [intent.limitPrice, plan.limit_price, "bound_order_limit_price_mismatch"],
  ] as const) {
    if (canonicalTradeDecimal(actual as string | number, 8) !== expected) return { ok: false, error };
  }
  return { ok: true };
}

export function tradeOrderPlanIdempotencyKey(binding: unknown) {
  const record = objectValue(binding);
  const digest = typeof record?.plan_digest === "string" ? record.plan_digest : "";
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? `trade-bound-${digest.slice("sha256:".length)}` : null;
}

export function tradeOrderPlanFreshnessMs(interval: TradeOrderInterval) {
  if (interval === "1m") return 30_000;
  if (interval === "5m") return 30_000;
  if (interval === "15m") return 90_000;
  return 120_000;
}

export function canonicalTradeDecimal(value: string | number, maxFractionDigits = 8): string | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const fixed = number.toFixed(maxFractionDigits).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
  return fixed === "-0" ? "0" : fixed;
}

function canonicalNonNegativeTradeDecimal(value: string | number, maxFractionDigits = 8): string | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number === 0 ? "0" : canonicalTradeDecimal(number, maxFractionDigits);
}

export function stableTradeStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableTradeStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableTradeStringify(record[key])}`).join(",")}}`;
}

function strictCanonicalDecimal(value: unknown, maxFractionDigits: number): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const canonical = canonicalTradeDecimal(value, maxFractionDigits);
  return canonical === value ? canonical : null;
}

function strictCanonicalNonNegativeDecimal(value: unknown, maxFractionDigits: number): string | null {
  return value === "0" ? "0" : strictCanonicalDecimal(value, maxFractionDigits);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function invalid(error: string): TradeOrderPlanValidation {
  return { ok: false, error };
}
