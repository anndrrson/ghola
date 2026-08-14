export const PAPER_TRADING_STATE_VERSION = 5 as const;
export const PAPER_TRADING_MODE = "paper" as const;
export const PAPER_TRADING_LEGACY_STORAGE_KEY = "ghola.paper-trading.v1";
export const PAPER_TRADING_STORAGE_PREFIX = "ghola.paper-trading.v2:";
export const PAPER_TRADING_GUEST_SCOPE = "device_guest";
export const PAPER_TRADING_STORAGE_KEY = `${PAPER_TRADING_STORAGE_PREFIX}${PAPER_TRADING_GUEST_SCOPE}`;
export const PAPER_TRADING_HISTORY_CAP = 500;
const PAPER_TRADING_PERSISTENCE_SCOPE = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export function paperTradingStorageKey(persistenceScope: string | null | undefined) {
  return typeof persistenceScope === "string" && PAPER_TRADING_PERSISTENCE_SCOPE.test(persistenceScope)
    ? `${PAPER_TRADING_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export type PaperSide = "buy" | "sell";
export type PaperOrderStatus = "pending" | "filled" | "cancelled" | "replaced";
export type PaperOrderKind = "entry" | "oco_target" | "oco_invalidation";
export type PaperOrderType = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
export type PaperTimeInForce = "GTC" | "IOC" | "FOK";
export type PaperOrderCancelReason =
  | "user_cancelled"
  | "cancel_all"
  | "ioc_not_marketable"
  | "ioc_remainder_cancelled"
  | "fok_not_fillable"
  | "risk_control"
  | "oco_sibling"
  | "position_unavailable"
  | null;
export type PaperRiskControlStatus = "armed" | "tripped" | "killed";
export type PaperRiskRejectionCode =
  | "kill_switch"
  | "circuit_breaker_tripped"
  | "portfolio_marks_stale"
  | "max_order_notional"
  | "max_position_notional"
  | "max_open_orders"
  | "session_loss_limit"
  | "max_drawdown_limit";

export interface PaperTradingAssumptions {
  starting_equity_usd: number;
  fee_bps: number;
  slippage_bps: number;
}

export interface PaperRiskPolicy {
  max_order_notional_usd: number;
  max_position_notional_usd: number;
  max_open_orders: number;
  max_session_loss_usd: number;
  max_drawdown_usd: number;
}

export interface PaperRiskControl {
  status: PaperRiskControlStatus;
  reason: "kill_switch" | "session_loss_limit" | "max_drawdown_limit" | null;
  message: string | null;
  session_started_at: string;
  session_start_equity_usd: number;
  session_peak_equity_usd: number;
  last_equity_usd: number;
  triggered_at: string | null;
}

export interface PaperOcoDefaults {
  enabled: boolean;
}

export interface PaperAttachedOco {
  target_price: number;
  invalidation_price: number;
}

export interface PaperOcoValidation {
  valid: boolean;
  message: string;
}

export interface PaperRiskMetrics {
  current_equity_usd: number;
  portfolio_fully_priced: boolean;
  unpriced_position_count: number;
  session_loss_usd: number;
  drawdown_usd: number;
  open_order_count: number;
  projected_position_notional_usd: number | null;
  order_notional_usd: number | null;
}

export interface PaperRiskDecision {
  allowed: boolean;
  code: PaperRiskRejectionCode | null;
  message: string;
  metrics: PaperRiskMetrics;
}

export interface PaperOrder {
  order_id: string;
  venue_id: string;
  network: string;
  product: string;
  side: PaperSide;
  order_kind: PaperOrderKind;
  reduce_only: boolean;
  parent_order_id: string | null;
  oco_group_id: string | null;
  oco_sibling_order_id: string | null;
  attached_oco: PaperAttachedOco | null;
  order_type: PaperOrderType;
  time_in_force: PaperTimeInForce;
  status: PaperOrderStatus;
  limit_price: number | null;
  stop_price: number | null;
  trail_offset_bps: number | null;
  trail_anchor_price: number | null;
  triggered_at: string | null;
  arrival_reference_price: number | null;
  quote_notional_usd: number;
  base_size: number;
  filled_base_size: number;
  remaining_base_size: number;
  submitted_at: string;
  updated_at: string;
  filled_at: string | null;
  cancelled_at: string | null;
  fill_id: string | null;
  fill_price: number | null;
  fee_usd: number;
  cancel_reason: PaperOrderCancelReason;
  replaces_order_id: string | null;
  replaced_by_order_id: string | null;
}

export interface PaperFill {
  fill_id: string;
  order_id: string;
  venue_id: string;
  network: string;
  product: string;
  side: PaperSide;
  base_size: number;
  reference_price: number;
  fill_price: number;
  notional_usd: number;
  fee_usd: number;
  fee_bps: number;
  slippage_bps: number;
  realized_pnl_gross_usd: number;
  filled_at: string;
}

export interface PaperPosition {
  position_key: string;
  venue_id: string;
  network: string;
  product: string;
  quantity_base: number;
  average_entry_price: number | null;
  realized_pnl_gross_usd: number;
  fees_paid_usd: number;
  opened_at: string;
  updated_at: string;
}

export interface PaperMark {
  position_key: string;
  venue_id: string;
  network: string;
  product: string;
  mark_price: number;
  fetched_at: string;
  observed_at: string;
}

export type PaperJournalEventType =
  | "order_placed"
  | "order_filled"
  | "order_cancelled"
  | "order_replaced"
  | "orders_cancelled"
  | "assumptions_updated"
  | "risk_policy_updated"
  | "risk_control_tripped"
  | "risk_control_killed"
  | "risk_control_rearmed"
  | "oco_defaults_updated"
  | "oco_attached"
  | "oco_reconciled"
  | "oco_sibling_cancelled"
  | "note";

export interface PaperJournalEntry {
  journal_id: string;
  event_type: PaperJournalEventType;
  created_at: string;
  product: string | null;
  order_id: string | null;
  fill_id: string | null;
  message: string;
}

export interface PaperTradingState {
  version: typeof PAPER_TRADING_STATE_VERSION;
  mode: typeof PAPER_TRADING_MODE;
  revision: number;
  next_sequence: number;
  assumptions: PaperTradingAssumptions;
  risk_policy: PaperRiskPolicy;
  risk_control: PaperRiskControl;
  oco_defaults: PaperOcoDefaults;
  orders: PaperOrder[];
  fills: PaperFill[];
  positions: PaperPosition[];
  marks: PaperMark[];
  observation_times: Record<string, string>;
  market_cursors: Record<string, PaperMarketCursor>;
  journal: PaperJournalEntry[];
  created_at: string;
  updated_at: string;
}

export interface PaperMarketCursor {
  snapshot_id: string;
  book_snapshot_id: string;
  snapshot_fetched_at: string;
  max_trade_time: number | null;
  max_trade_keys: string[];
  updated_at: string;
}

export interface PaperLimitOrderInput {
  venue_id: string;
  network: string;
  product: string;
  side: PaperSide;
  limit_price: number;
  reference_price?: number | null;
  order_type?: "limit";
  time_in_force?: PaperTimeInForce;
  quote_notional_usd: number;
  base_size?: number;
  reduce_only?: boolean;
  attached_oco?: PaperAttachedOco | null;
  submitted_at: string;
}

export interface PaperOrderInput {
  venue_id: string;
  network: string;
  product: string;
  side: PaperSide;
  order_type?: PaperOrderType;
  time_in_force?: PaperTimeInForce;
  limit_price?: number | null;
  stop_price?: number | null;
  trail_offset_bps?: number | null;
  reference_price?: number | null;
  quote_notional_usd: number;
  base_size?: number;
  reduce_only?: boolean;
  attached_oco?: PaperAttachedOco | null;
  submitted_at: string;
}

export interface PaperMarketObservation {
  venue_id: string;
  network: string;
  product: string;
  market_state: "live" | "stale" | "fallback";
  fetched_at: string;
  observed_at: string;
  quote_fetched_at: string | null;
  book_fetched_at: string | null;
  snapshot_id?: string;
  book_revision?: number | null;
  max_age_ms: number;
  best_bid: number | null;
  best_ask: number | null;
  mark_price: number | null;
  bids?: Array<{ price: number; size: number }>;
  asks?: Array<{ price: number; size: number }>;
  trades: Array<{ id?: string; price: number; side: PaperSide; time: number; size?: number }>;
}

export interface MarkedPaperPosition extends PaperPosition {
  mark_price: number | null;
  mark_fetched_at: string | null;
  mark_observed_at: string | null;
  mark_age_ms: number | null;
  mark_status: "fresh" | "stale" | "missing" | "future" | "closed";
  unrealized_pnl_usd: number | null;
  realized_pnl_net_usd: number;
  market_value_usd: number | null;
}

export interface PaperAccountSummary {
  starting_equity_usd: number;
  realized_pnl_gross_usd: number;
  unrealized_pnl_usd: number;
  fees_paid_usd: number;
  net_pnl_usd: number;
  equity_usd: number;
  pending_order_count: number;
  fill_count: number;
  portfolio_fully_priced: boolean;
  open_position_count: number;
  fresh_mark_count: number;
  stale_mark_count: number;
  missing_mark_count: number;
  future_mark_count: number;
  unpriced_position_count: number;
  marks_as_of: string;
  mark_max_age_ms: number;
  marked_positions: MarkedPaperPosition[];
}

export interface PaperMarkFreshnessOptions {
  now?: string;
  maxAgeMs?: number;
}

const DEFAULT_ASSUMPTIONS: PaperTradingAssumptions = {
  starting_equity_usd: 10_000,
  fee_bps: 2.5,
  slippage_bps: 3,
};
const MAX_RECORDS = PAPER_TRADING_HISTORY_CAP;
const MAX_MARKET_TRADES = 1_000;
const MAX_MARKET_DEPTH_LEVELS = 100;
const ID_PREFIX = "paper";
export const PAPER_MARK_MAX_AGE_MS = 30_000;
const PAPER_MARK_FUTURE_TOLERANCE_MS = 5_000;
const LEGACY_V4_BOOK_CURSOR_PREFIX = "legacy-v4-book-consumed-through:";

export function defaultPaperRiskPolicy(startingEquityUsd = DEFAULT_ASSUMPTIONS.starting_equity_usd): PaperRiskPolicy {
  const equity = positiveFinite(startingEquityUsd, "paper_risk_policy_invalid");
  return {
    max_order_notional_usd: roundMoney(Math.max(1, equity * 0.05)),
    max_position_notional_usd: roundMoney(Math.max(1, equity * 0.1)),
    max_open_orders: 5,
    max_session_loss_usd: roundMoney(Math.max(1, equity * 0.02)),
    max_drawdown_usd: roundMoney(Math.max(1, equity * 0.03)),
  };
}

export function createPaperTradingState(input: {
  now?: string;
  assumptions?: Partial<PaperTradingAssumptions>;
  riskPolicy?: Partial<PaperRiskPolicy>;
  ocoDefaults?: Partial<PaperOcoDefaults>;
} = {}): PaperTradingState {
  const now = requiredIso(input.now ?? new Date().toISOString(), "paper_state_time_invalid");
  const assumptions = validateAssumptions({ ...DEFAULT_ASSUMPTIONS, ...input.assumptions });
  const riskPolicy = validateRiskPolicy({ ...defaultPaperRiskPolicy(assumptions.starting_equity_usd), ...input.riskPolicy });
  return {
    version: PAPER_TRADING_STATE_VERSION,
    mode: PAPER_TRADING_MODE,
    revision: 0,
    next_sequence: 1,
    assumptions,
    risk_policy: riskPolicy,
    risk_control: armedRiskControl(assumptions.starting_equity_usd, now),
    oco_defaults: validateOcoDefaults({ enabled: false, ...input.ocoDefaults }),
    orders: [],
    fills: [],
    positions: [],
    marks: [],
    observation_times: {},
    market_cursors: {},
    journal: [],
    created_at: now,
    updated_at: now,
  };
}

export function placePaperLimitOrder(
  state: PaperTradingState,
  input: PaperLimitOrderInput,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperTradingState {
  return placePaperOrder(state, {
    ...input,
    order_type: "limit",
    time_in_force: input.time_in_force ?? "GTC",
  }, markFreshness);
}

export function placePaperOrder(
  state: PaperTradingState,
  input: PaperOrderInput,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperTradingState {
  assertPaperState(state);
  const normalized = normalizePaperOrderInput(input);
  assertReduceOnlyPlacement(state, normalized);
  const decision = evaluateNormalizedPaperOrderRisk(state, normalized, undefined, markFreshness);
  if (!decision.allowed) throw new Error(`${decision.code}: ${decision.message}`);
  const orderId = sequenceId("order", state.next_sequence);
  const order = paperOrderFromNormalized(normalized, orderId);
  const journal = journalEntry({
    sequence: state.next_sequence + 1,
    event_type: "order_placed",
    created_at: normalized.submitted_at,
    product: normalized.product,
    order_id: orderId,
    message: paperOrderPlacedMessage(order),
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 2,
    orders: [order, ...state.orders],
    journal: trimRecords([journal, ...state.journal]),
    updated_at: normalized.submitted_at,
  });
}

export function evaluatePaperOrderRisk(
  state: PaperTradingState,
  input: PaperOrderInput,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperRiskDecision {
  assertPaperState(state);
  const normalized = normalizePaperOrderInput(input);
  const freshness = paperOrderRiskFreshness(state, normalized, markFreshness);
  try {
    assertReduceOnlyPlacement(state, normalized);
  } catch (error) {
    return {
      allowed: false,
      code: null,
      message: error instanceof Error ? error.message : "paper_reduce_only_invalid",
      metrics: {
        ...paperRiskMetrics(state, freshness),
        order_notional_usd: normalized.quote_notional_usd,
        projected_position_notional_usd: null,
      },
    };
  }
  return evaluateNormalizedPaperOrderRisk(state, normalized, undefined, markFreshness);
}

export function paperRiskMetrics(
  state: PaperTradingState,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperRiskMetrics {
  assertPaperState(state);
  const summary = paperAccountSummary(state, {}, markFreshness);
  const equity = summary.portfolio_fully_priced
    ? summary.equity_usd
    : state.risk_control.last_equity_usd;
  return {
    current_equity_usd: equity,
    portfolio_fully_priced: summary.portfolio_fully_priced,
    unpriced_position_count: summary.unpriced_position_count,
    session_loss_usd: Math.max(0, state.risk_control.session_start_equity_usd - equity),
    drawdown_usd: Math.max(0, state.risk_control.session_peak_equity_usd - equity),
    open_order_count: paperOpenOrderUsage(state.orders),
    projected_position_notional_usd: null,
    order_notional_usd: null,
  };
}

export function cancelPaperOrder(state: PaperTradingState, orderId: string, cancelledAt: string): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(cancelledAt, "paper_cancel_time_invalid");
  const target = state.orders.find((order) => order.order_id === orderId);
  if (!target) throw new Error("paper_order_not_found");
  if (target.status !== "pending") throw new Error("paper_order_not_pending");
  const cancelledIds = new Set(target.oco_group_id
    ? state.orders.filter((order) => order.oco_group_id === target.oco_group_id && order.status === "pending").map((order) => order.order_id)
    : [orderId]);
  const orders = state.orders.map((order) => cancelledIds.has(order.order_id)
    ? {
      ...order,
      status: "cancelled" as const,
      cancelled_at: now,
      updated_at: maxIso(state.updated_at, now),
      cancel_reason: "user_cancelled" as const,
    }
    : order);
  const journal = journalEntry({
    sequence: state.next_sequence,
    event_type: "order_cancelled",
    created_at: now,
    product: target.product,
    order_id: target.order_id,
    message: target.oco_group_id
      ? `PAPER simulated OCO group cancelled · ${target.product} · ${cancelledIds.size} exit orders`
      : `PAPER order cancelled · ${target.product} ${target.side} ${formatOrderPrice(target)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    orders,
    journal: trimRecords([journal, ...state.journal]),
    updated_at: maxIso(state.updated_at, now),
  });
}

export function cancelAllPaperOrders(
  state: PaperTradingState,
  cancelledAt: string,
  scope: Partial<Pick<PaperOrder, "venue_id" | "network" | "product">> = {},
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(cancelledAt, "paper_cancel_time_invalid");
  const directlyMatched = state.orders.filter((order) => order.status === "pending" && paperOrderMatchesScope(order, scope));
  if (!directlyMatched.length) return state;
  const ocoGroups = new Set(directlyMatched.map((order) => order.oco_group_id).filter((value): value is string => value != null));
  const cancelledIds = new Set(state.orders
    .filter((order) => order.status === "pending" && (directlyMatched.includes(order) || (order.oco_group_id != null && ocoGroups.has(order.oco_group_id))))
    .map((order) => order.order_id));
  const orders = state.orders.map((order) => cancelledIds.has(order.order_id) ? {
    ...order,
    status: "cancelled" as const,
    cancelled_at: now,
    updated_at: now,
    cancel_reason: "cancel_all" as const,
  } : order);
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "orders_cancelled",
    created_at: now,
    message: `PAPER cancel-all completed · ${cancelledIds.size} resting order${cancelledIds.size === 1 ? "" : "s"} cancelled${paperScopeMessage(scope)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    orders,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
}

export function replacePaperOrder(
  state: PaperTradingState,
  orderId: string,
  changes: Partial<Pick<PaperOrderInput,
    | "order_type"
    | "time_in_force"
    | "limit_price"
    | "stop_price"
    | "trail_offset_bps"
    | "reference_price"
    | "quote_notional_usd"
    | "base_size"
    | "reduce_only"
    | "attached_oco">>,
  replacedAt: string,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(replacedAt, "paper_replace_time_invalid");
  const target = state.orders.find((order) => order.order_id === orderId);
  if (!target) throw new Error("paper_order_not_found");
  if (target.status !== "pending") throw new Error("paper_order_not_pending");
  if (target.order_kind !== "entry" || target.oco_group_id != null) throw new Error("paper_order_replace_oco_invalid");
  const normalizedTotal = normalizePaperOrderInput({
    venue_id: target.venue_id,
    network: target.network,
    product: target.product,
    side: target.side,
    order_type: changes.order_type ?? target.order_type,
    time_in_force: changes.time_in_force ?? target.time_in_force,
    limit_price: changes.limit_price === undefined ? target.limit_price : changes.limit_price,
    stop_price: changes.stop_price === undefined ? target.stop_price : changes.stop_price,
    trail_offset_bps: changes.trail_offset_bps === undefined ? target.trail_offset_bps : changes.trail_offset_bps,
    reference_price: changes.reference_price ?? orderValuationPrice(target),
    quote_notional_usd: changes.quote_notional_usd ?? target.quote_notional_usd,
    base_size: changes.base_size ?? target.base_size,
    reduce_only: changes.reduce_only ?? target.reduce_only,
    attached_oco: changes.attached_oco === undefined ? target.attached_oco : changes.attached_oco,
    submitted_at: now,
  });
  if (normalizedTotal.base_size <= target.filled_base_size + 1e-12) {
    throw new Error("paper_order_replace_size_filled");
  }
  const residualBaseSize = normalizedTotal.base_size - target.filled_base_size;
  const residualQuoteNotional = normalizedTotal.quote_notional_usd
    * residualBaseSize / normalizedTotal.base_size;
  const normalized: NormalizedPaperOrder = {
    ...normalizedTotal,
    quote_notional_usd: residualQuoteNotional,
    base_size: residualBaseSize,
    arrival_reference_price: changes.reference_price === undefined
      ? null
      : finitePositiveOrNull(changes.reference_price),
  };
  assertReduceOnlyPlacement(state, normalized);
  const decision = evaluateNormalizedPaperOrderRisk(state, normalized, orderId, markFreshness);
  if (!decision.allowed) throw new Error(`${decision.code}: ${decision.message}`);
  const replacementId = sequenceId("order", state.next_sequence);
  const replacement: PaperOrder = {
    ...paperOrderFromNormalized(normalized, replacementId),
    replaces_order_id: target.order_id,
  };
  const orders = state.orders.map((order) => order.order_id === target.order_id ? {
    ...order,
    status: "replaced" as const,
    replaced_by_order_id: replacementId,
    updated_at: now,
    cancelled_at: now,
  } : order);
  const entry = journalEntry({
    sequence: state.next_sequence + 1,
    event_type: "order_replaced",
    created_at: now,
    product: target.product,
    order_id: replacementId,
    message: `PAPER order ${target.order_id} replaced by ${replacementId} · ${paperOrderPlacedMessage(replacement)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 2,
    orders: [replacement, ...orders],
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
}

export function updatePaperRiskPolicy(
  state: PaperTradingState,
  policy: Partial<PaperRiskPolicy>,
  updatedAt: string,
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(updatedAt, "paper_risk_policy_time_invalid");
  const nextPolicy = validateRiskPolicy({ ...state.risk_policy, ...policy });
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "risk_policy_updated",
    created_at: now,
    message: `PAPER risk limits · order $${formatNumber(nextPolicy.max_order_notional_usd)} · position $${formatNumber(nextPolicy.max_position_notional_usd)} · open ${nextPolicy.max_open_orders} · session loss $${formatNumber(nextPolicy.max_session_loss_usd)} · drawdown $${formatNumber(nextPolicy.max_drawdown_usd)}`,
  });
  const updated = nextState(state, {
    next_sequence: state.next_sequence + 1,
    risk_policy: nextPolicy,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
  return refreshPaperRiskControl(updated, now);
}

export function updatePaperOcoDefaults(
  state: PaperTradingState,
  defaults: Partial<PaperOcoDefaults>,
  updatedAt: string,
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(updatedAt, "paper_oco_defaults_time_invalid");
  if (defaults.enabled != null && typeof defaults.enabled !== "boolean") throw new Error("paper_oco_defaults_invalid");
  const nextDefaults = { ...state.oco_defaults, ...defaults };
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "oco_defaults_updated",
    created_at: now,
    message: `PAPER simulated OCO attachment ${nextDefaults.enabled ? "enabled" : "disabled"} for future entries`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    oco_defaults: nextDefaults,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
}

export function validatePaperAttachedOco(input: {
  side: PaperSide;
  entry_price: number;
  target_price: number | null | undefined;
  invalidation_price: number | null | undefined;
}): PaperOcoValidation {
  const entry = finitePositiveOrNull(input.entry_price);
  const target = finitePositiveOrNull(input.target_price);
  const invalidation = finitePositiveOrNull(input.invalidation_price);
  if (entry == null || target == null || invalidation == null) {
    return { valid: false, message: "Simulated OCO requires positive entry, target, and invalidation prices." };
  }
  if (input.side === "buy" && !(invalidation < entry && entry < target)) {
    return { valid: false, message: "Buy OCO requires invalidation below entry and target above entry." };
  }
  if (input.side === "sell" && !(target < entry && entry < invalidation)) {
    return { valid: false, message: "Sell OCO requires target below entry and invalidation above entry." };
  }
  if (input.side !== "buy" && input.side !== "sell") return { valid: false, message: "Simulated OCO side is invalid." };
  return { valid: true, message: `Simulated OCO ready · target ${formatNumber(target)} · invalidation ${formatNumber(invalidation)}.` };
}

export function activatePaperKillSwitch(state: PaperTradingState, activatedAt: string): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(activatedAt, "paper_kill_switch_time_invalid");
  if (state.risk_control.status === "killed") return state;
  const summary = paperAccountSummary(state, {}, { now });
  const equity = summary.portfolio_fully_priced ? summary.equity_usd : state.risk_control.last_equity_usd;
  const message = "Local PAPER kill switch is active. Exposure-increasing orders are cancelled and blocked; compatible reduce-only exits remain available while the latch stays active.";
  return stopPaperRiskControl(state, {
    now,
    status: "killed",
    reason: "kill_switch",
    message,
    equity,
    eventType: "risk_control_killed",
  });
}

export function rearmPaperRiskControl(
  state: PaperTradingState,
  input: { confirmed: boolean; rearmed_at: string },
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(input.rearmed_at, "paper_risk_rearm_time_invalid");
  if (!input.confirmed) throw new Error("paper_risk_rearm_confirmation_required");
  if (state.risk_control.status === "armed") throw new Error("paper_risk_control_already_armed");
  const summary = paperAccountSummary(state, {}, { now });
  if (!summary.portfolio_fully_priced) {
    throw new Error(`paper_risk_rearm_marks_stale: Refresh marks for ${summary.unpriced_position_count} open position${summary.unpriced_position_count === 1 ? "" : "s"} before re-arming.`);
  }
  const equity = summary.equity_usd;
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "risk_control_rearmed",
    created_at: now,
    message: `PAPER risk controls deliberately re-armed · new session baseline ${formatUsdForMessage(equity)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    risk_control: armedRiskControl(equity, now),
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
}

export function advancePaperTrading(
  state: PaperTradingState,
  observation: PaperMarketObservation,
): PaperTradingState {
  assertPaperState(state);
  const market = validateObservation(observation);
  if (market.market_state !== "live") return state;
  const fetchedAtMs = Date.parse(market.fetched_at);
  const observedAtMs = Date.parse(market.observed_at);
  if (fetchedAtMs > observedAtMs + PAPER_MARK_FUTURE_TOLERANCE_MS) return state;
  if (!paperFreshBbo(market) && !market.trades.some((trade) => paperTradeFresh(trade, market))) return state;
  const observationKey = paperPositionKey(market);
  const snapshotId = paperSnapshotId(market);
  const bookSnapshotId = paperBookSnapshotId(market);
  const previousCursor = state.market_cursors[observationKey];
  if (previousCursor && (
    snapshotId === previousCursor.snapshot_id && bookSnapshotId === previousCursor.book_snapshot_id
  )) return state;
  const previousObservation = state.observation_times[observationKey];
  if (previousObservation && observedAtMs < Date.parse(previousObservation)) return state;

  let next = recordPaperMark(state, market);
  next = refreshPaperRiskControl(next, market.observed_at, market.max_age_ms);
  const portfolioFullyPriced = paperAccountSummary(next, {}, {
    now: market.observed_at,
    maxAgeMs: market.max_age_ms,
  }).portfolio_fully_priced;
  const exitsOnly = next.risk_control.status !== "armed" || !portfolioFullyPriced;

  const candidates = next.orders
    .filter((order) =>
      order.status === "pending" &&
      (!exitsOnly || order.reduce_only) &&
      order.venue_id === market.venue_id &&
      order.network === market.network &&
      order.product === market.product &&
      Date.parse(order.submitted_at) <= observedAtMs)
    .sort(paperOrderPriority);
  const ledger = paperLiquidityLedger(market, previousCursor);
  const plans = candidates.map((order) => planPaperOrderExecution(order, market, ledger));
  if (plans.some((plan) => plan.order !== next.orders.find((order) => order.order_id === plan.order.order_id))) {
    const plannedOrders = new Map(plans.map((plan) => [plan.order.order_id, plan.order]));
    next = nextState(next, {
      orders: next.orders.map((order) => plannedOrders.get(order.order_id) ?? order),
      updated_at: maxIso(next.updated_at, market.observed_at),
    });
  }
  const pendingPlans = plans.filter((item) => item.eventAt != null);
  while (pendingPlans.length > 0) {
    pendingPlans.sort(comparePaperExecutionPlans);
    const plan = pendingPlans.shift() as PaperOrderExecutionPlan;
    const currentOrder = next.orders.find((order) => order.order_id === plan.order.order_id);
    if (!currentOrder || currentOrder.status !== "pending") continue;
    if (next.risk_control.status !== "armed" && !currentOrder.reduce_only) continue;
    if (plan.source === "trade" && !paperTradePlanAvailable(plan, ledger)) {
      next = refreshPaperRiskControl(next, new Date(plan.eventAt as number).toISOString(), market.max_age_ms);
      const stillPending = next.orders.find((order) => order.order_id === plan.order.order_id);
      if (!stillPending || stillPending.status !== "pending") continue;
      const replacement = planPaperOrderExecution(stillPending, market, ledger);
      next = applyPaperExecutionPlanOrder(next, replacement, market.observed_at);
      if (replacement.eventAt != null) pendingPlans.push(replacement);
      continue;
    }
    const filledBefore = currentOrder.filled_base_size;
    next = executePaperOrderPlan(next, currentOrder, plan, market, ledger);
    next = refreshPaperRiskControl(next, new Date(plan.eventAt as number).toISOString(), market.max_age_ms);
    const executedOrder = next.orders.find((order) => order.order_id === currentOrder.order_id);
    if (currentOrder.order_kind === "entry" && (executedOrder?.filled_base_size ?? filledBefore) > filledBefore + 1e-12) {
      const dynamicOcoOrders = next.orders.filter((order) =>
        order.status === "pending" &&
        order.oco_group_id != null &&
        order.venue_id === market.venue_id &&
        order.network === market.network &&
        order.product === market.product &&
        Date.parse(order.submitted_at) <= observedAtMs);
      const dynamicIds = new Set(dynamicOcoOrders.map((order) => order.order_id));
      for (let index = pendingPlans.length - 1; index >= 0; index -= 1) {
        if (dynamicIds.has(pendingPlans[index].order.order_id)) pendingPlans.splice(index, 1);
      }
      for (const dynamicOrder of dynamicOcoOrders.sort(paperOrderPriority)) {
        const dynamicPlan = planPaperOrderExecution(dynamicOrder, market, ledger);
        next = applyPaperExecutionPlanOrder(next, dynamicPlan, market.observed_at);
        if (dynamicPlan.eventAt != null) pendingPlans.push(dynamicPlan);
      }
    }
    if (plan.source !== "trade") continue;
    const remainingOrder = next.orders.find((order) => order.order_id === plan.order.order_id);
    if (!remainingOrder || remainingOrder.status !== "pending") continue;
    const followUp = planPaperOrderExecution(remainingOrder, market, ledger);
    next = applyPaperExecutionPlanOrder(next, followUp, market.observed_at);
    if (followUp.eventAt != null) pendingPlans.push(followUp);
  }
  const marketCursor = nextPaperMarketCursor(market, previousCursor, snapshotId);
  next = recordPaperMarketCursor(next, observationKey, marketCursor);
  return recordPaperObservation(next, observationKey, market.observed_at);
}

/**
 * Restores one open-position mark without evaluating any PAPER order.
 * Risk controls still revalue and may cancel exposure-increasing orders, but
 * this path never creates a fill or changes a position.
 */
export function restorePaperTradingMark(
  state: PaperTradingState,
  observation: PaperMarketObservation,
): PaperTradingState {
  assertPaperState(state);
  const market = validateObservation(observation);
  if (market.market_state !== "live") return state;
  const fetchedAtMs = Date.parse(market.fetched_at);
  const observedAtMs = Date.parse(market.observed_at);
  if (fetchedAtMs > observedAtMs + PAPER_MARK_FUTURE_TOLERANCE_MS) {
    return state;
  }
  const positionKey = paperPositionKey(market);
  const position = state.positions.find((item) => item.position_key === positionKey);
  if (!position || Math.abs(position.quantity_base) <= 1e-12) return state;
  const previousObservation = state.observation_times[positionKey];
  if (previousObservation && observedAtMs <= Date.parse(previousObservation)) return state;
  const previousMark = state.marks.find((mark) => mark.position_key === positionKey);
  const quoteFetchedAtMs = Date.parse(market.quote_fetched_at ?? "");
  if (previousMark && (!Number.isFinite(quoteFetchedAtMs) || quoteFetchedAtMs <= Date.parse(previousMark.fetched_at))) return state;

  let next = recordPaperMark(state, market);
  if (next === state) return state;
  next = refreshPaperRiskControl(next, market.observed_at, market.max_age_ms);
  return recordPaperObservation(next, positionKey, market.observed_at);
}

export function addPaperJournalNote(
  state: PaperTradingState,
  input: { message: string; created_at: string; product?: string | null },
): PaperTradingState {
  assertPaperState(state);
  const message = input.message.trim().replace(/\s+/g, " ");
  if (!message || message.length > 500) throw new Error("paper_note_invalid");
  const createdAt = requiredIso(input.created_at, "paper_note_time_invalid");
  const product = input.product ? safeProduct(input.product) : null;
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "note",
    created_at: createdAt,
    product,
    message,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: createdAt,
  });
}

export function updatePaperTradingAssumptions(
  state: PaperTradingState,
  assumptions: Partial<PaperTradingAssumptions>,
  updatedAt: string,
): PaperTradingState {
  assertPaperState(state);
  const now = requiredIso(updatedAt, "paper_assumptions_time_invalid");
  const nextAssumptions = validateAssumptions({ ...state.assumptions, ...assumptions });
  const equityDelta = nextAssumptions.starting_equity_usd - state.assumptions.starting_equity_usd;
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "assumptions_updated",
    created_at: now,
    message: `PAPER assumptions · equity $${formatNumber(nextAssumptions.starting_equity_usd)} · fee ${formatNumber(nextAssumptions.fee_bps)} bps · slippage ${formatNumber(nextAssumptions.slippage_bps)} bps`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    assumptions: nextAssumptions,
    risk_control: equityDelta === 0 ? state.risk_control : {
      ...state.risk_control,
      session_start_equity_usd: state.risk_control.session_start_equity_usd + equityDelta,
      session_peak_equity_usd: state.risk_control.session_peak_equity_usd + equityDelta,
      last_equity_usd: state.risk_control.last_equity_usd + equityDelta,
    },
    journal: trimRecords([entry, ...state.journal]),
    updated_at: now,
  });
}

export function paperAccountSummary(
  state: PaperTradingState,
  marks: Record<string, number | null> = {},
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperAccountSummary {
  assertPaperState(state);
  const { now, nowMs, maxAgeMs } = normalizePaperMarkFreshness(state, markFreshness);
  const storedMarks = new Map(state.marks.map((mark) => [mark.position_key, mark]));
  const markedPositions = state.positions.map((position): MarkedPaperPosition => {
    const storedMark = storedMarks.get(position.position_key) ?? null;
    const markPrice = finitePositiveOrNull(marks[position.position_key] ?? storedMark?.mark_price);
    const markStatus = paperPositionMarkStatus(position, storedMark, markPrice, nowMs, maxAgeMs);
    const usableMark = markStatus === "fresh" ? markPrice : null;
    const unrealized = usableMark != null && position.average_entry_price != null
      ? position.quantity_base * (usableMark - position.average_entry_price)
      : position.quantity_base === 0 ? 0 : null;
    const fetchedAtMs = storedMark == null ? Number.NaN : Date.parse(storedMark.fetched_at);
    const observedAtMs = storedMark == null ? Number.NaN : Date.parse(storedMark.observed_at);
    const oldestMarkAtMs = Math.min(fetchedAtMs, observedAtMs);
    return {
      ...position,
      mark_price: markPrice,
      mark_fetched_at: storedMark?.fetched_at ?? null,
      mark_observed_at: storedMark?.observed_at ?? null,
      mark_age_ms: Number.isFinite(oldestMarkAtMs) ? Math.max(0, nowMs - oldestMarkAtMs) : null,
      mark_status: markStatus,
      unrealized_pnl_usd: finiteOrNull(unrealized),
      realized_pnl_net_usd: position.realized_pnl_gross_usd - position.fees_paid_usd,
      market_value_usd: usableMark != null ? Math.abs(position.quantity_base) * usableMark : null,
    };
  });
  const realizedGross = sum(markedPositions.map((position) => position.realized_pnl_gross_usd));
  const fees = sum(markedPositions.map((position) => position.fees_paid_usd));
  const unrealized = sum(markedPositions.map((position) => position.unrealized_pnl_usd ?? 0));
  const netPnl = realizedGross + unrealized - fees;
  const openPositions = markedPositions.filter((position) => Math.abs(position.quantity_base) > 1e-12);
  const countStatus = (status: MarkedPaperPosition["mark_status"]) => openPositions.filter((position) => position.mark_status === status).length;
  const freshMarkCount = countStatus("fresh");
  const staleMarkCount = countStatus("stale");
  const missingMarkCount = countStatus("missing");
  const futureMarkCount = countStatus("future");
  const unpricedPositionCount = staleMarkCount + missingMarkCount + futureMarkCount;
  return {
    starting_equity_usd: state.assumptions.starting_equity_usd,
    realized_pnl_gross_usd: realizedGross,
    unrealized_pnl_usd: unrealized,
    fees_paid_usd: fees,
    net_pnl_usd: netPnl,
    equity_usd: state.assumptions.starting_equity_usd + netPnl,
    pending_order_count: state.orders.filter((order) => order.status === "pending").length,
    fill_count: state.fills.length,
    portfolio_fully_priced: unpricedPositionCount === 0,
    open_position_count: openPositions.length,
    fresh_mark_count: freshMarkCount,
    stale_mark_count: staleMarkCount,
    missing_mark_count: missingMarkCount,
    future_mark_count: futureMarkCount,
    unpriced_position_count: unpricedPositionCount,
    marks_as_of: now,
    mark_max_age_ms: maxAgeMs,
    marked_positions: markedPositions,
  };
}

function normalizePaperMarkFreshness(
  state: PaperTradingState,
  options: PaperMarkFreshnessOptions,
) {
  const now = requiredIso(options.now ?? state.updated_at, "paper_mark_time_invalid");
  const maxAgeMs = options.maxAgeMs ?? PAPER_MARK_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 300_000) {
    throw new Error("paper_mark_age_invalid");
  }
  return { now, nowMs: Date.parse(now), maxAgeMs };
}

function paperOrderRiskFreshness(
  state: PaperTradingState,
  order: NormalizedPaperOrder,
  options: PaperMarkFreshnessOptions,
): PaperMarkFreshnessOptions {
  const requestedNow = requiredIso(options.now ?? order.submitted_at, "paper_mark_time_invalid");
  return {
    now: maxIso(maxIso(state.updated_at, order.submitted_at), requestedNow),
    maxAgeMs: options.maxAgeMs,
  };
}

function paperPositionMarkStatus(
  position: PaperPosition,
  mark: PaperMark | null,
  markPrice: number | null,
  nowMs: number,
  maxAgeMs: number,
): MarkedPaperPosition["mark_status"] {
  if (Math.abs(position.quantity_base) <= 1e-12) return "closed";
  if (mark == null || markPrice == null) return "missing";
  const fetchedAtMs = Date.parse(mark.fetched_at);
  const observedAtMs = Date.parse(mark.observed_at);
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(observedAtMs)) return "missing";
  if (
    fetchedAtMs > nowMs + PAPER_MARK_FUTURE_TOLERANCE_MS ||
    observedAtMs > nowMs + PAPER_MARK_FUTURE_TOLERANCE_MS ||
    fetchedAtMs > observedAtMs + PAPER_MARK_FUTURE_TOLERANCE_MS
  ) {
    return "future";
  }
  if (nowMs - fetchedAtMs > maxAgeMs || nowMs - observedAtMs > maxAgeMs) return "stale";
  return "fresh";
}

export function paperPositionKey(input: { venue_id: string; network: string; product: string }) {
  return `${input.venue_id}:${input.network}:${input.product}`;
}

export function resetPaperTradingState(state: PaperTradingState, now: string, input: { confirmed: boolean }): PaperTradingState {
  assertPaperState(state);
  if (!input.confirmed) throw new Error("paper_reset_confirmation_required");
  return createPaperTradingState({ now, assumptions: state.assumptions, riskPolicy: state.risk_policy, ocoDefaults: state.oco_defaults });
}

export function serializePaperTradingState(state: PaperTradingState) {
  assertPaperState(state);
  return JSON.stringify(state);
}

export function exportPaperTradingJournal(state: PaperTradingState, exportedAt: string) {
  assertPaperState(state);
  const timestamp = requiredIso(exportedAt, "paper_export_time_invalid");
  return JSON.stringify({
    export_version: 5,
    exported_at: timestamp,
    warning: "PAPER SIMULATION ONLY — no venue orders or assets",
    state,
  }, null, 2);
}

export function parsePaperTradingState(value: string | null | undefined): PaperTradingState | null {
  if (!value) return null;
  try {
    const parsed = migratePaperTradingState(JSON.parse(value) as unknown);
    assertPaperState(parsed);
    return parsed as PaperTradingState;
  } catch {
    return null;
  }
}

interface NormalizedPaperOrder {
  venue_id: string;
  network: string;
  product: string;
  side: PaperSide;
  order_type: PaperOrderType;
  time_in_force: PaperTimeInForce;
  limit_price: number | null;
  stop_price: number | null;
  trail_offset_bps: number | null;
  reference_price: number;
  arrival_reference_price: number | null;
  quote_notional_usd: number;
  base_size: number;
  reduce_only: boolean;
  attached_oco: PaperAttachedOco | null;
  submitted_at: string;
}

function normalizePaperOrderInput(input: PaperOrderInput): NormalizedPaperOrder {
  const submittedAt = requiredIso(input.submitted_at, "paper_order_time_invalid");
  const venueId = safeLabel(input.venue_id, "paper_order_venue_invalid");
  const network = safeLabel(input.network, "paper_order_network_invalid");
  const product = safeProduct(input.product);
  if (input.side !== "buy" && input.side !== "sell") throw new Error("paper_order_side_invalid");
  const orderType = input.order_type ?? "limit";
  if (!new Set<PaperOrderType>(["market", "limit", "stop", "stop_limit", "trailing_stop"]).has(orderType)) {
    throw new Error("paper_order_type_invalid");
  }
  const timeInForce = input.time_in_force ?? (orderType === "market" ? "IOC" : "GTC");
  if (!new Set<PaperTimeInForce>(["GTC", "IOC", "FOK"]).has(timeInForce)) throw new Error("paper_order_tif_invalid");
  if (orderType === "market" && timeInForce === "GTC") throw new Error("paper_market_order_tif_invalid");
  const limitPrice = orderType === "limit" || orderType === "stop_limit"
    ? positiveFinite(Number(input.limit_price), "paper_order_limit_invalid")
    : null;
  const stopPrice = orderType === "stop" || orderType === "stop_limit"
    ? positiveFinite(Number(input.stop_price), "paper_order_stop_invalid")
    : null;
  const trailOffsetBps = orderType === "trailing_stop"
    ? positiveFinite(Number(input.trail_offset_bps), "paper_order_trail_invalid")
    : null;
  if (trailOffsetBps != null && trailOffsetBps > 5_000) throw new Error("paper_order_trail_invalid");
  const reduceOnly = input.reduce_only === true;
  const quoteNotional = positiveFinite(input.quote_notional_usd, "paper_order_notional_invalid");
  if (quoteNotional > 1_000_000 && !reduceOnly) throw new Error("paper_order_notional_invalid");
  const inputReference = finitePositiveOrNull(input.reference_price);
  const sizingReference = limitPrice ?? stopPrice ?? inputReference ?? (input.base_size ? quoteNotional / input.base_size : null);
  if (sizingReference == null) throw new Error("paper_order_reference_invalid");
  const baseSize = positiveFinite(input.base_size ?? quoteNotional / sizingReference, "paper_order_size_invalid");
  let attachedOco: PaperAttachedOco | null = null;
  if (input.attached_oco) {
    if (reduceOnly) throw new Error("paper_oco_reduce_only_invalid");
    const validation = validatePaperAttachedOco({
      side: input.side,
      entry_price: sizingReference,
      target_price: input.attached_oco.target_price,
      invalidation_price: input.attached_oco.invalidation_price,
    });
    if (!validation.valid) throw new Error(`paper_oco_levels_invalid: ${validation.message}`);
    attachedOco = {
      target_price: positiveFinite(input.attached_oco.target_price, "paper_oco_levels_invalid"),
      invalidation_price: positiveFinite(input.attached_oco.invalidation_price, "paper_oco_levels_invalid"),
    };
  }
  return {
    venue_id: venueId,
    network,
    product,
    side: input.side,
    order_type: orderType,
    time_in_force: timeInForce,
    limit_price: limitPrice,
    stop_price: stopPrice,
    trail_offset_bps: trailOffsetBps,
    reference_price: sizingReference,
    arrival_reference_price: inputReference,
    quote_notional_usd: quoteNotional,
    base_size: baseSize,
    reduce_only: reduceOnly,
    attached_oco: attachedOco,
    submitted_at: submittedAt,
  };
}

function paperOrderFromNormalized(order: NormalizedPaperOrder, orderId: string): PaperOrder {
  return {
    order_id: orderId,
    venue_id: order.venue_id,
    network: order.network,
    product: order.product,
    side: order.side,
    order_kind: "entry",
    reduce_only: order.reduce_only,
    parent_order_id: null,
    oco_group_id: null,
    oco_sibling_order_id: null,
    attached_oco: order.attached_oco,
    order_type: order.order_type,
    time_in_force: order.time_in_force,
    status: "pending",
    limit_price: order.limit_price,
    stop_price: order.stop_price,
    trail_offset_bps: order.trail_offset_bps,
    trail_anchor_price: null,
    triggered_at: null,
    arrival_reference_price: order.arrival_reference_price,
    quote_notional_usd: order.quote_notional_usd,
    base_size: order.base_size,
    filled_base_size: 0,
    remaining_base_size: order.base_size,
    submitted_at: order.submitted_at,
    updated_at: order.submitted_at,
    filled_at: null,
    cancelled_at: null,
    fill_id: null,
    fill_price: null,
    fee_usd: 0,
    cancel_reason: null,
    replaces_order_id: null,
    replaced_by_order_id: null,
  };
}

function assertReduceOnlyPlacement(state: PaperTradingState, order: NormalizedPaperOrder) {
  if (!order.reduce_only) return;
  const position = state.positions.find((item) => item.position_key === paperPositionKey(order));
  const quantity = position?.quantity_base ?? 0;
  if (Math.abs(quantity) <= 1e-12) throw new Error("paper_reduce_only_position_unavailable");
  if ((quantity > 0 && order.side !== "sell") || (quantity < 0 && order.side !== "buy")) {
    throw new Error("paper_reduce_only_side_invalid");
  }
  if (order.base_size > Math.abs(quantity) + 1e-12) throw new Error("paper_reduce_only_size_invalid");
}

function paperOrderPlacedMessage(order: PaperOrder) {
  return `PAPER ${order.order_type.replaceAll("_", "-")} ${order.time_in_force} placed · ${order.product} ${order.side} ${formatQuantity(order.base_size)} @ ${formatOrderPrice(order)}${order.reduce_only ? " · reduce-only" : ""}`;
}

function orderValuationPrice(order: Pick<PaperOrder, "limit_price" | "stop_price" | "quote_notional_usd" | "base_size"> | NormalizedPaperOrder) {
  return finitePositiveOrNull(order.limit_price)
    ?? finitePositiveOrNull(order.stop_price)
    ?? positiveFinite(order.quote_notional_usd / order.base_size, "paper_order_reference_invalid");
}

function evaluateNormalizedPaperOrderRisk(
  state: PaperTradingState,
  order: NormalizedPaperOrder,
  excludedOrderId?: string,
  markFreshness: PaperMarkFreshnessOptions = {},
): PaperRiskDecision {
  const baseMetrics = paperRiskMetrics(state, paperOrderRiskFreshness(state, order, markFreshness));
  const key = paperPositionKey(order);
  const position = state.positions.find((item) => item.position_key === key);
  const currentQuantity = position?.quantity_base ?? 0;
  const resting = state.orders.filter((item) => item.order_id !== excludedOrderId && item.status === "pending" && !item.reduce_only && paperPositionKey(item) === key);
  const restingBuys = sum(resting.filter((item) => item.side === "buy").map((item) => item.remaining_base_size));
  const restingSells = sum(resting.filter((item) => item.side === "sell").map((item) => item.remaining_base_size));
  const newBuySize = !order.reduce_only && order.side === "buy" ? order.base_size : 0;
  const newSellSize = !order.reduce_only && order.side === "sell" ? order.base_size : 0;
  const projectedLongQuantity = currentQuantity + restingBuys + newBuySize;
  const projectedShortQuantity = currentQuantity - restingSells - newSellSize;
  const storedMark = state.marks.find((mark) => mark.position_key === key)?.mark_price ?? 0;
  const valuationPrice = Math.max(order.reference_price, storedMark);
  const projectedNotional = order.reduce_only
    ? Math.abs(currentQuantity) * valuationPrice
    : Math.max(Math.abs(projectedLongQuantity), Math.abs(projectedShortQuantity)) * valuationPrice;
  const effectiveOrderNotional = Math.max(order.quote_notional_usd, order.base_size * order.reference_price);
  const metrics: PaperRiskMetrics = {
    ...baseMetrics,
    open_order_count: excludedOrderId == null
      ? baseMetrics.open_order_count
      : Math.max(0, baseMetrics.open_order_count - paperOpenOrderUsage(state.orders.filter((item) => item.order_id === excludedOrderId))),
    projected_position_notional_usd: projectedNotional,
    order_notional_usd: effectiveOrderNotional,
  };
  const reject = (code: PaperRiskRejectionCode, message: string): PaperRiskDecision => ({
    allowed: false,
    code,
    message,
    metrics,
  });
  const emergencyExit = isPaperEmergencyExit(order);

  // A validated market reduce-only order can only decrease exposure. It must
  // remain available through every risk latch and cannot be stranded by entry
  // notional/open-order limits. Placement validation above still enforces the
  // exact position, opposite side, and non-oversize invariants.
  if (emergencyExit) {
    return {
      allowed: true,
      code: null,
      message: state.risk_control.status === "armed"
        ? `Reduce-only emergency exit is valid for the current ${order.product} position.`
        : `Risk latch remains ${state.risk_control.status}; only this reduce-only market exit is allowed.`,
      metrics,
    };
  }

  if (!order.reduce_only && !baseMetrics.portfolio_fully_priced) {
    return reject(
      "portfolio_marks_stale",
      `Portfolio marks are not current for ${baseMetrics.unpriced_position_count} open position${baseMetrics.unpriced_position_count === 1 ? "" : "s"}. New PAPER exposure is blocked until every open market is refreshed; valid reduce-only exits remain available.`,
    );
  }

  if (state.risk_control.status === "killed") {
    return reject("kill_switch", `${state.risk_control.message ?? "Local PAPER kill switch is active."} Only an opposite-side, non-oversize, reduce-only market IOC/FOK exit may be added before re-arm.`);
  }
  if (state.risk_control.status === "tripped") {
    return reject("circuit_breaker_tripped", `${state.risk_control.message ?? "The PAPER circuit breaker is tripped."} Only an opposite-side, non-oversize, reduce-only market IOC/FOK exit may be added before re-arm.`);
  }
  if (metrics.session_loss_usd >= state.risk_policy.max_session_loss_usd) {
    return reject("session_loss_limit", `Session loss ${formatUsdForMessage(metrics.session_loss_usd)} reached the ${formatUsdForMessage(state.risk_policy.max_session_loss_usd)} PAPER stop.`);
  }
  if (metrics.drawdown_usd >= state.risk_policy.max_drawdown_usd) {
    return reject("max_drawdown_limit", `Session drawdown ${formatUsdForMessage(metrics.drawdown_usd)} reached the ${formatUsdForMessage(state.risk_policy.max_drawdown_usd)} PAPER stop.`);
  }
  if (effectiveOrderNotional > state.risk_policy.max_order_notional_usd) {
    return reject("max_order_notional", `Order notional ${formatUsdForMessage(effectiveOrderNotional)} exceeds the ${formatUsdForMessage(state.risk_policy.max_order_notional_usd)} PAPER order limit.`);
  }
  if (!order.reduce_only && projectedNotional > state.risk_policy.max_position_notional_usd) {
    return reject("max_position_notional", `Projected ${order.product} position ${formatUsdForMessage(projectedNotional)} exceeds the ${formatUsdForMessage(state.risk_policy.max_position_notional_usd)} PAPER position limit.`);
  }
  const requiredSlots = order.attached_oco ? 2 : 1;
  if (metrics.open_order_count + requiredSlots > state.risk_policy.max_open_orders) {
    return reject("max_open_orders", `${metrics.open_order_count} resting PAPER orders plus ${requiredSlots} required slot${requiredSlots === 1 ? "" : "s"} would exceed the ${state.risk_policy.max_open_orders}-order limit${order.attached_oco ? " for this entry and its simulated OCO exits" : ""}.`);
  }
  return {
    allowed: true,
    code: null,
    message: `Within local PAPER limits · projected position ${formatUsdForMessage(projectedNotional)} of ${formatUsdForMessage(state.risk_policy.max_position_notional_usd)}.`,
    metrics,
  };
}

function isPaperEmergencyExit(order: NormalizedPaperOrder) {
  return order.reduce_only &&
    order.order_type === "market" &&
    (order.time_in_force === "IOC" || order.time_in_force === "FOK") &&
    order.attached_oco == null;
}

function paperOpenOrderUsage(orders: PaperOrder[]) {
  return sum(orders
    .filter((order) => order.status === "pending")
    .map((order) => order.order_kind === "entry" && !order.reduce_only && order.attached_oco ? 2 : 1));
}

function refreshPaperRiskControl(
  state: PaperTradingState,
  updatedAt: string,
  markMaxAgeMs = PAPER_MARK_MAX_AGE_MS,
): PaperTradingState {
  const now = requiredIso(updatedAt, "paper_risk_control_time_invalid");
  const summary = paperAccountSummary(state, {}, { now, maxAgeMs: markMaxAgeMs });
  if (!summary.portfolio_fully_priced) return state;
  const equity = summary.equity_usd;
  const peak = Math.max(state.risk_control.session_peak_equity_usd, equity);
  if (state.risk_control.status !== "armed") {
    if (state.risk_control.last_equity_usd === equity) return state;
    return nextState(state, {
      risk_control: { ...state.risk_control, last_equity_usd: equity },
      updated_at: maxIso(state.updated_at, now),
    });
  }
  const sessionLoss = Math.max(0, state.risk_control.session_start_equity_usd - equity);
  const drawdown = Math.max(0, peak - equity);
  if (sessionLoss >= state.risk_policy.max_session_loss_usd) {
    return stopPaperRiskControl(state, {
      now,
      status: "tripped",
      reason: "session_loss_limit",
      message: `PAPER circuit breaker tripped: session loss ${formatUsdForMessage(sessionLoss)} reached the ${formatUsdForMessage(state.risk_policy.max_session_loss_usd)} stop.`,
      equity,
      peak,
      eventType: "risk_control_tripped",
    });
  }
  if (drawdown >= state.risk_policy.max_drawdown_usd) {
    return stopPaperRiskControl(state, {
      now,
      status: "tripped",
      reason: "max_drawdown_limit",
      message: `PAPER circuit breaker tripped: drawdown ${formatUsdForMessage(drawdown)} reached the ${formatUsdForMessage(state.risk_policy.max_drawdown_usd)} stop.`,
      equity,
      peak,
      eventType: "risk_control_tripped",
    });
  }
  if (state.risk_control.last_equity_usd === equity && state.risk_control.session_peak_equity_usd === peak) return state;
  return nextState(state, {
    risk_control: {
      ...state.risk_control,
      last_equity_usd: equity,
      session_peak_equity_usd: peak,
    },
    updated_at: maxIso(state.updated_at, now),
  });
}

function stopPaperRiskControl(state: PaperTradingState, input: {
  now: string;
  status: "tripped" | "killed";
  reason: NonNullable<PaperRiskControl["reason"]>;
  message: string;
  equity: number;
  peak?: number;
  eventType: "risk_control_tripped" | "risk_control_killed";
}) {
  const cancelledCount = state.orders.filter((order) => order.status === "pending" && !order.reduce_only).length;
  const preservedExitCount = state.orders.filter((order) => order.status === "pending" && order.reduce_only).length;
  const orders = state.orders.map((order) => order.status === "pending" && !order.reduce_only ? {
    ...order,
    status: "cancelled" as const,
    cancelled_at: input.now,
    updated_at: maxIso(state.updated_at, input.now),
    cancel_reason: "risk_control" as const,
  } : order);
  const message = [
    input.message,
    cancelledCount
      ? `${cancelledCount} exposure-increasing resting order${cancelledCount === 1 ? " was" : "s were"} cancelled.`
      : "No exposure-increasing resting orders remained.",
    preservedExitCount
      ? `${preservedExitCount} reduce-only protective exit${preservedExitCount === 1 ? " remains" : "s remain"} active.`
      : "A validated reduce-only market IOC/FOK exit may still flatten an open position.",
  ].join(" ");
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: input.eventType,
    created_at: input.now,
    message,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    risk_control: {
      ...state.risk_control,
      status: input.status,
      reason: input.reason,
      message,
      session_peak_equity_usd: input.peak ?? Math.max(state.risk_control.session_peak_equity_usd, input.equity),
      last_equity_usd: input.equity,
      triggered_at: input.now,
    },
    orders,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: maxIso(state.updated_at, input.now),
  });
}

interface PaperOrderExecutionPlan {
  order: PaperOrder;
  eventAt: number | null;
  source: "book" | "trade" | null;
  tradeKey: string | null;
}

interface PaperLiquidityLevel {
  price: number;
  remainingSize: number;
}

interface PaperLiquidityLedger {
  bids: PaperLiquidityLevel[] | null;
  asks: PaperLiquidityLevel[] | null;
  trades: Map<string, PaperTradeLiquidity>;
  eligibleTradeKeys: Set<string>;
}

interface PaperTradeLiquidity {
  price: number;
  remainingSize: number;
}

function planPaperOrderExecution(
  order: PaperOrder,
  market: PaperMarketObservation,
  ledger: PaperLiquidityLedger,
): PaperOrderExecutionPlan {
  const observedAtMs = Date.parse(market.observed_at);
  if (order.order_type === "trailing_stop") {
    const trailing = advanceTrailingOrder(order, market, ledger);
    if (trailing.order.triggered_at == null) return noPaperExecutionPlan(trailing.order);
    return bookExecutionPlan(trailing.order, observedAtMs);
  }
  let evaluated = order;
  let triggerAt = order.triggered_at == null ? null : Date.parse(order.triggered_at);
  if ((order.order_type === "stop" || order.order_type === "stop_limit") && triggerAt == null) {
    const trigger = firstStopTrigger(order, market, ledger);
    if (!trigger) {
      return noPaperExecutionPlan({ ...order, updated_at: market.observed_at });
    }
    triggerAt = trigger.crossedAt;
    const triggeredAt = new Date(triggerAt).toISOString();
    evaluated = { ...order, triggered_at: triggeredAt, updated_at: triggeredAt };
  }
  if (evaluated.order_type === "stop") return bookExecutionPlan(evaluated, observedAtMs);
  if (evaluated.order_type === "stop_limit") {
    const crossing = evaluated.time_in_force === "GTC"
      ? firstLimitTrade(evaluated, market, ledger, triggerAt ?? Date.parse(evaluated.submitted_at))
      : null;
    if (crossing) return tradeExecutionPlan(evaluated, crossing.trade, crossing.key);
    if (paperBookMarketable(evaluated, market)) return bookExecutionPlan({ ...evaluated, updated_at: market.observed_at }, observedAtMs);
    if (evaluated.time_in_force !== "GTC") return bookExecutionPlan({ ...evaluated, updated_at: market.observed_at }, observedAtMs);
    return noPaperExecutionPlan({ ...evaluated, updated_at: market.observed_at });
  }
  if (evaluated.order_type === "market") return bookExecutionPlan(evaluated, observedAtMs);
  if (evaluated.time_in_force !== "GTC") return bookExecutionPlan(evaluated, observedAtMs);
  const crossingAfter = Date.parse(evaluated.submitted_at);
  const crossing = firstLimitTrade(evaluated, market, ledger, crossingAfter);
  if (crossing) return tradeExecutionPlan(evaluated, crossing.trade, crossing.key);
  if (paperBookMarketable(evaluated, market)) return bookExecutionPlan({ ...evaluated, updated_at: market.observed_at }, observedAtMs);
  return noPaperExecutionPlan({ ...evaluated, updated_at: market.observed_at });
}

function noPaperExecutionPlan(order: PaperOrder): PaperOrderExecutionPlan {
  return { order, eventAt: null, source: null, tradeKey: null };
}

function bookExecutionPlan(order: PaperOrder, eventAt: number): PaperOrderExecutionPlan {
  return { order, eventAt, source: "book", tradeKey: null };
}

function tradeExecutionPlan(
  order: PaperOrder,
  trade: { price: number; time: number; size?: number },
  tradeKey: string,
): PaperOrderExecutionPlan {
  return {
    order: { ...order, updated_at: new Date(trade.time).toISOString() },
    eventAt: trade.time,
    source: "trade",
    tradeKey,
  };
}

function firstLimitTrade(
  order: PaperOrder,
  market: PaperMarketObservation,
  ledger: PaperLiquidityLedger,
  afterMs: number,
) {
  const limit = order.limit_price;
  if (limit == null) return null;
  const observedAtMs = Date.parse(market.observed_at);
  return market.trades
    .map((trade, ordinal) => ({ trade, ordinal, key: paperTradeKey(trade) }))
    .filter((entry): entry is { trade: typeof entry.trade; ordinal: number; key: string } => entry.key != null)
    .filter(({ trade }) => trade.time > afterMs && trade.time <= observedAtMs)
    .filter(({ key }) => (ledger.trades.get(key)?.remainingSize ?? 0) > 1e-12)
    .filter(({ trade }) => trade.side === (order.side === "buy" ? "sell" : "buy"))
    .sort((a, b) => a.trade.time - b.trade.time || a.ordinal - b.ordinal)
    .find(({ trade }) => order.side === "buy" ? trade.price <= limit : trade.price >= limit) ?? null;
}

function firstStopTrigger(order: PaperOrder, market: PaperMarketObservation, ledger: PaperLiquidityLedger) {
  const stop = order.stop_price;
  if (stop == null) return null;
  const afterMs = order.triggered_at == null ? Date.parse(order.submitted_at) : Date.parse(order.triggered_at);
  const observedAtMs = Date.parse(market.observed_at);
  const trade = market.trades
    .filter((item) => item.time > afterMs && item.time <= observedAtMs)
    .filter((item) => {
      const key = paperTradeKey(item);
      return key != null && ledger.eligibleTradeKeys.has(key);
    })
    .slice()
    .sort((a, b) => a.time - b.time)
    .find((item) => order.side === "buy" ? item.price >= stop : item.price <= stop);
  if (trade) return { referencePrice: trade.price, crossedAt: trade.time };
  const quote = paperFreshBbo(market)
    ? finitePositiveOrNull(order.side === "buy" ? market.best_ask : market.best_bid)
    : null;
  return quote != null && (order.side === "buy" ? quote >= stop : quote <= stop)
    ? { referencePrice: quote, crossedAt: observedAtMs }
    : null;
}

function advanceTrailingOrder(order: PaperOrder, market: PaperMarketObservation, ledger: PaperLiquidityLedger) {
  const offset = order.trail_offset_bps;
  if (offset == null || order.triggered_at != null) {
    return { order, triggeredAt: order.triggered_at == null ? null : Date.parse(order.triggered_at) };
  }
  const afterMs = Date.parse(order.submitted_at);
  const observedAtMs = Date.parse(market.observed_at);
  const prices = market.trades
    .filter((trade) => trade.time > afterMs && trade.time <= observedAtMs)
    .filter((trade) => {
      const key = paperTradeKey(trade);
      return key != null && ledger.eligibleTradeKeys.has(key);
    })
    .sort((a, b) => a.time - b.time)
    .map((trade) => ({ price: trade.price, time: trade.time }));
  const quote = paperFreshBbo(market)
    ? finitePositiveOrNull(order.side === "buy" ? market.best_ask : market.best_bid)
    : null;
  if (quote != null) prices.push({ price: quote, time: observedAtMs });
  let anchor = order.trail_anchor_price;
  let stop = order.stop_price;
  let triggeredAt: number | null = null;
  for (const event of prices) {
    const price = event.price;
    if (anchor == null) {
      anchor = price;
      stop = trailingStopPrice(order.side, anchor, offset);
      continue;
    }
    const nextAnchor = order.side === "sell" ? Math.max(anchor, price) : Math.min(anchor, price);
    if (nextAnchor !== anchor) {
      anchor = nextAnchor;
      stop = trailingStopPrice(order.side, anchor, offset);
    }
    if (stop != null && (order.side === "sell" ? price <= stop : price >= stop)) {
      triggeredAt = event.time;
      break;
    }
  }
  const nextOrder = {
    ...order,
    trail_anchor_price: anchor,
    stop_price: stop,
    triggered_at: triggeredAt == null ? null : new Date(triggeredAt).toISOString(),
    updated_at: triggeredAt == null ? market.observed_at : new Date(triggeredAt).toISOString(),
  };
  return { order: nextOrder, triggeredAt };
}

function trailingStopPrice(side: PaperSide, anchor: number, offsetBps: number) {
  return anchor * (side === "sell" ? 1 - offsetBps / 10_000 : 1 + offsetBps / 10_000);
}

function paperBookMarketable(order: PaperOrder, market: PaperMarketObservation) {
  if (!paperBookExecutable(market)) return false;
  const quote = finitePositiveOrNull(order.side === "buy" ? market.best_ask : market.best_bid);
  if (quote == null) return false;
  if (order.order_type !== "limit" && order.order_type !== "stop_limit" && order.order_kind !== "oco_target") return true;
  const limit = order.limit_price;
  return limit != null && (order.side === "buy" ? quote <= limit : quote >= limit);
}

function paperLiquidityLedger(
  market: PaperMarketObservation,
  previousCursor: PaperMarketCursor | undefined,
): PaperLiquidityLedger {
  const trades = new Map<string, PaperTradeLiquidity>();
  const eligibleTradeKeys = new Set<string>();
  const previousKeys = new Set(previousCursor?.max_trade_keys ?? []);
  const previousTime = previousCursor?.max_trade_time ?? null;
  const bookAlreadyConsumed = paperBookAlreadyConsumed(previousCursor, market);
  const bookExecutable = paperBookExecutable(market);
  market.trades.forEach((trade) => {
    const key = paperTradeKey(trade);
    const size = finitePositiveOrNull(trade.size);
    if (!key || size == null || !paperTradeFresh(trade, market)) return;
    if (previousTime != null && (trade.time < previousTime || (trade.time === previousTime && previousKeys.has(key)))) return;
    if (trades.has(key)) return;
    trades.set(key, { price: trade.price, remainingSize: size });
    eligibleTradeKeys.add(key);
  });
  return {
    bids: !bookExecutable ? null : bookAlreadyConsumed ? [] : normalizePaperDepth(market.bids, market.best_bid, "sell"),
    asks: !bookExecutable ? null : bookAlreadyConsumed ? [] : normalizePaperDepth(market.asks, market.best_ask, "buy"),
    trades,
    eligibleTradeKeys,
  };
}

function paperFreshBbo(market: PaperMarketObservation) {
  const bid = finitePositiveOrNull(market.best_bid);
  const ask = finitePositiveOrNull(market.best_ask);
  return bid != null && ask != null && bid < ask && paperComponentFresh(market.quote_fetched_at, market);
}

function paperBookExecutable(market: PaperMarketObservation) {
  return paperFreshBbo(market) && paperComponentFresh(market.book_fetched_at, market);
}

function paperComponentFresh(sourceAt: string | null, market: PaperMarketObservation) {
  if (sourceAt == null) return false;
  const sourceAtMs = Date.parse(sourceAt);
  const observedAtMs = Date.parse(market.observed_at);
  return Number.isFinite(sourceAtMs) &&
    sourceAtMs <= observedAtMs &&
    observedAtMs - sourceAtMs <= market.max_age_ms;
}

function paperBookAlreadyConsumed(previous: PaperMarketCursor | undefined, market: PaperMarketObservation) {
  if (!previous) return false;
  if (previous.book_snapshot_id === paperBookSnapshotId(market)) return true;
  return legacyV4BookCursorCutoff(previous.book_snapshot_id) != null && !paperBookNewerThanLegacyCursor(previous, market);
}

function paperBookNewerThanLegacyCursor(previous: PaperMarketCursor, market: PaperMarketObservation) {
  const cutoff = legacyV4BookCursorCutoff(previous.book_snapshot_id);
  const sourceAtMs = Date.parse(market.book_fetched_at ?? "");
  return cutoff != null && Number.isFinite(sourceAtMs) && sourceAtMs > cutoff;
}

function normalizePaperDepth(
  raw: PaperMarketObservation["bids"] | PaperMarketObservation["asks"],
  top: number | null,
  takerSide: PaperSide,
): PaperLiquidityLevel[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const levels = raw
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .map((level) => ({ price: level.price, remainingSize: level.size }))
    .sort((a, b) => takerSide === "buy" ? a.price - b.price : b.price - a.price);
  if (!levels.length) return null;
  if (top != null && Math.abs(levels[0].price - top) > Math.max(1e-8, top * 1e-8)) return null;
  return levels;
}

function executePaperOrderPlan(
  state: PaperTradingState,
  order: PaperOrder,
  plan: PaperOrderExecutionPlan,
  market: PaperMarketObservation,
  ledger: PaperLiquidityLedger,
) {
  const eventAt = new Date(plan.eventAt as number).toISOString();
  const remaining = order.remaining_base_size;
  const reducible = paperReducibleSize(state, order);
  if (order.reduce_only && reducible <= 1e-12) return cancelPendingPaperOrder(state, order, eventAt, "position_unavailable");
  if (order.time_in_force === "FOK" && order.reduce_only && reducible + 1e-12 < remaining) {
    return cancelPendingPaperOrder(state, order, eventAt, "position_unavailable");
  }

  const liquidity = plan.source === "trade"
    ? paperTradeLiquidity(plan, ledger, remaining, false)
    : paperBookLiquidity(order, ledger, remaining, false);
  if (order.time_in_force === "FOK") {
    if (liquidity.referencePrice == null || liquidity.availableSize == null || liquidity.availableSize + 1e-12 < remaining) {
      return cancelPendingPaperOrder(state, order, eventAt, "fok_not_fillable");
    }
  } else if (order.time_in_force === "IOC" && (liquidity.referencePrice == null || liquidity.availableSize == null || liquidity.availableSize <= 1e-12)) {
    return cancelPendingPaperOrder(state, order, eventAt, "ioc_not_marketable");
  } else if (liquidity.referencePrice == null) {
    return state;
  }

  const available = liquidity.availableSize;
  const plannedSize = order.time_in_force === "FOK" ? remaining : Math.min(remaining, available);
  const fillSize = order.reduce_only ? Math.min(plannedSize, reducible) : plannedSize;
  if (fillSize <= 1e-12) return state;
  const consumed = plan.source === "book"
    ? paperBookLiquidity(order, ledger, fillSize, true)
    : paperTradeLiquidity(plan, ledger, fillSize, true);
  if (consumed.referencePrice == null) return state;
  const cancelRemainder = order.time_in_force === "IOC" && fillSize + 1e-12 < remaining
    || order.reduce_only && fillSize + 1e-12 < plannedSize;
  return fillPaperOrder(state, order, consumed.referencePrice, eventAt, fillSize, cancelRemainder);
}

function paperTradeLiquidity(
  plan: PaperOrderExecutionPlan,
  ledger: PaperLiquidityLedger,
  requestedSize: number,
  consume: boolean,
) {
  const trade = plan.tradeKey == null ? null : ledger.trades.get(plan.tradeKey);
  if (!trade || trade.remainingSize <= 1e-12) return { referencePrice: null, availableSize: 0 };
  const availableSize = trade.remainingSize;
  if (consume) trade.remainingSize = Math.max(0, trade.remainingSize - Math.min(requestedSize, availableSize));
  return { referencePrice: trade.price, availableSize };
}

function paperTradePlanAvailable(plan: PaperOrderExecutionPlan, ledger: PaperLiquidityLedger) {
  return plan.tradeKey != null && (ledger.trades.get(plan.tradeKey)?.remainingSize ?? 0) > 1e-12;
}

function applyPaperExecutionPlanOrder(
  state: PaperTradingState,
  plan: PaperOrderExecutionPlan,
  observedAt: string,
) {
  const current = state.orders.find((order) => order.order_id === plan.order.order_id);
  if (!current || current === plan.order) return state;
  return nextState(state, {
    orders: state.orders.map((order) => order.order_id === plan.order.order_id ? plan.order : order),
    updated_at: maxIso(state.updated_at, observedAt),
  });
}

function paperBookLiquidity(
  order: PaperOrder,
  ledger: PaperLiquidityLedger,
  requestedSize: number,
  consume: boolean,
) {
  const limit = order.order_type === "limit" || order.order_type === "stop_limit" || order.order_kind === "oco_target"
    ? order.limit_price
    : null;
  const levels = order.side === "buy" ? ledger.asks : ledger.bids;
  if (levels == null) return { referencePrice: null, availableSize: 0 };
  let remaining = requestedSize;
  let filled = 0;
  let notional = 0;
  let availableSize = 0;
  for (const level of levels) {
    if (limit != null && (order.side === "buy" ? level.price > limit : level.price < limit)) continue;
    availableSize += level.remainingSize;
    if (remaining <= 1e-12) continue;
    const size = Math.min(remaining, level.remainingSize);
    filled += size;
    notional += size * level.price;
    remaining -= size;
  }
  if (consume && filled > 0) {
    let toConsume = filled;
    for (const level of levels) {
      if (limit != null && (order.side === "buy" ? level.price > limit : level.price < limit)) continue;
      const size = Math.min(toConsume, level.remainingSize);
      level.remainingSize -= size;
      toConsume -= size;
      if (toConsume <= 1e-12) break;
    }
  }
  return { referencePrice: filled > 0 ? notional / filled : null, availableSize };
}

function paperReducibleSize(state: PaperTradingState, order: PaperOrder) {
  if (!order.reduce_only) return Number.POSITIVE_INFINITY;
  const quantity = state.positions.find((position) => position.position_key === paperPositionKey(order))?.quantity_base ?? 0;
  return order.side === "sell" ? Math.max(0, quantity) : Math.max(0, -quantity);
}

function validPaperTrade(trade: PaperMarketObservation["trades"][number]) {
  return Number.isFinite(trade.price) && trade.price > 0 && Number.isFinite(trade.time) &&
    (trade.side === "buy" || trade.side === "sell");
}

function paperTradeFresh(
  trade: PaperMarketObservation["trades"][number],
  market: PaperMarketObservation,
) {
  if (!validPaperTrade(trade) || finitePositiveOrNull(trade.size) == null) return false;
  const observedAtMs = Date.parse(market.observed_at);
  return trade.time <= observedAtMs && observedAtMs - trade.time <= market.max_age_ms;
}

function paperTradeKey(trade: PaperMarketObservation["trades"][number]) {
  const size = finitePositiveOrNull(trade.size);
  if (!validPaperTrade(trade) || size == null) return null;
  const sourceId = typeof trade.id === "string" && trade.id.trim() && trade.id.length <= 200
    ? trade.id.trim()
    : null;
  return sourceId == null
    ? `${trade.time}:${trade.price}:${trade.side}:${size}`
    : `id:${sourceId}`;
}

function paperOrderPriority(a: PaperOrder, b: PaperOrder) {
  return Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.order_id.localeCompare(b.order_id);
}

function paperPlanPriority(plan: PaperOrderExecutionPlan) {
  return plan.order.order_kind === "oco_invalidation" ? 0 : plan.order.order_kind === "oco_target" ? 1 : 2;
}

function comparePaperExecutionPlans(left: PaperOrderExecutionPlan, right: PaperOrderExecutionPlan) {
  return (left.eventAt as number) - (right.eventAt as number) ||
    paperPlanPriority(left) - paperPlanPriority(right) ||
    left.order.order_id.localeCompare(right.order.order_id);
}

function cancelPendingPaperOrder(
  state: PaperTradingState,
  order: PaperOrder,
  cancelledAt: string,
  reason: Exclude<PaperOrderCancelReason, null>,
) {
  const orders = state.orders.map((item) => item.order_id === order.order_id ? {
    ...item,
    status: "cancelled" as const,
    cancelled_at: cancelledAt,
    updated_at: cancelledAt,
    cancel_reason: reason,
  } : item);
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "order_cancelled",
    created_at: cancelledAt,
    product: order.product,
    order_id: order.order_id,
    message: `PAPER ${order.order_type.replaceAll("_", "-")} ${order.time_in_force} cancelled · ${paperCancelReasonMessage(reason)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    orders,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: maxIso(state.updated_at, cancelledAt),
  });
}

function fillPaperOrder(
  state: PaperTradingState,
  order: PaperOrder,
  referencePrice: number,
  filledAt: string,
  requestedBaseSize = order.remaining_base_size,
  cancelRemainder = false,
) {
  const key = paperPositionKey(order);
  const existing = state.positions.find((position) => position.position_key === key) ?? emptyPosition(order, filledAt);
  let fillBaseSize = Math.min(requestedBaseSize, order.remaining_base_size);
  let remainderCancelReason: PaperOrderCancelReason = cancelRemainder ? "ioc_remainder_cancelled" : null;
  if (order.reduce_only) {
    const reducibleSize = order.side === "sell" ? Math.max(0, existing.quantity_base) : Math.max(0, -existing.quantity_base);
    if (reducibleSize <= 1e-12) {
      return order.oco_group_id
        ? cancelOcoGroup(state, order, filledAt, "No matching paper position remained; simulated OCO exits cancelled.")
        : cancelPendingPaperOrder(state, order, filledAt, "position_unavailable");
    }
    if (fillBaseSize > reducibleSize) {
      fillBaseSize = reducibleSize;
      cancelRemainder = true;
      remainderCancelReason = "position_unavailable";
    }
  }
  if (fillBaseSize <= 1e-12) return state;
  const slippageMultiplier = order.side === "buy"
    ? 1 + state.assumptions.slippage_bps / 10_000
    : 1 - state.assumptions.slippage_bps / 10_000;
  const slippedPrice = referencePrice * slippageMultiplier;
  const hasLimitCap = (order.order_type === "limit" || order.order_type === "stop_limit" || order.order_kind === "oco_target") && order.limit_price != null;
  const fillPrice = !hasLimitCap
    ? slippedPrice
    : order.side === "buy"
      ? Math.min(order.limit_price as number, slippedPrice)
      : Math.max(order.limit_price as number, slippedPrice);
  const fillId = sequenceId("fill", state.next_sequence);
  const notional = fillBaseSize * fillPrice;
  const fee = notional * state.assumptions.fee_bps / 10_000;
  const applied = applyFillToPosition(existing, order.side, fillBaseSize, fillPrice, fee, filledAt);
  const openedBaseSize = openedExposureFromFill(existing.quantity_base, order.side, fillBaseSize);
  const cumulativeFilled = order.filled_base_size + fillBaseSize;
  const remainingBaseSize = Math.max(0, order.base_size - cumulativeFilled);
  const completed = remainingBaseSize <= 1e-12;
  const nextStatus: PaperOrderStatus = completed ? "filled" : cancelRemainder ? "cancelled" : "pending";
  const averageFillPrice = (order.filled_base_size * (order.fill_price ?? fillPrice) + fillBaseSize * fillPrice) / cumulativeFilled;
  const fill: PaperFill = {
    fill_id: fillId,
    order_id: order.order_id,
    venue_id: order.venue_id,
    network: order.network,
    product: order.product,
    side: order.side,
    base_size: fillBaseSize,
    reference_price: referencePrice,
    fill_price: fillPrice,
    notional_usd: notional,
    fee_usd: fee,
    fee_bps: state.assumptions.fee_bps,
    slippage_bps: state.assumptions.slippage_bps,
    realized_pnl_gross_usd: applied.realizedDelta,
    filled_at: filledAt,
  };
  let orders = state.orders.map((item) => item.order_id === order.order_id ? {
    ...item,
    status: nextStatus,
    filled_base_size: cumulativeFilled,
    remaining_base_size: remainingBaseSize,
    updated_at: filledAt,
    filled_at: filledAt,
    cancelled_at: nextStatus === "cancelled" ? filledAt : item.cancelled_at,
    fill_id: fillId,
    fill_price: averageFillPrice,
    fee_usd: item.fee_usd + fee,
    cancel_reason: nextStatus === "cancelled" ? remainderCancelReason : null,
  } : item);
  const positions = state.positions.some((position) => position.position_key === key)
    ? state.positions.map((position) => position.position_key === key ? applied.position : position)
    : [applied.position, ...state.positions];
  const fillJournal = journalEntry({
    sequence: state.next_sequence + 1,
    event_type: "order_filled",
    created_at: filledAt,
    product: order.product,
    order_id: order.order_id,
    fill_id: fillId,
    message: `PAPER ${order.order_kind === "entry" ? order.order_type.replaceAll("_", "-") : order.order_kind === "oco_target" ? "simulated OCO target" : "simulated OCO invalidation"} filled ${order.side} ${formatQuantity(fillBaseSize)} ${order.product} @ ${formatNumber(fillPrice)} · fee $${fee.toFixed(4)}${nextStatus === "cancelled" ? " · unfilled remainder cancelled" : ""}`,
  });
  const journal = [fillJournal, ...state.journal];
  let sequence = state.next_sequence + 2;
  if (order.reduce_only && order.oco_sibling_order_id) {
    orders = orders.map((item) => item.order_id === order.oco_sibling_order_id && item.status === "pending" ? {
      ...item,
      status: "cancelled" as const,
      cancelled_at: filledAt,
      updated_at: filledAt,
      cancel_reason: "oco_sibling" as const,
    } : item);
    journal.unshift(journalEntry({
      sequence,
      event_type: "oco_sibling_cancelled",
      created_at: filledAt,
      product: order.product,
      order_id: order.oco_sibling_order_id,
      message: `PAPER simulated OCO sibling ${order.oco_sibling_order_id} cancelled after ${order.order_kind === "oco_target" ? "target" : "invalidation"} fill`,
    }));
    sequence += 1;
  }
  let next = nextState(state, {
    next_sequence: sequence,
    orders,
    fills: [fill, ...state.fills],
    positions,
    journal: trimRecords(journal),
    updated_at: maxIso(state.updated_at, filledAt),
  });
  if (order.order_kind === "entry" && order.attached_oco && openedBaseSize > 1e-12) {
    next = attachPaperOcoExits(next, order, openedBaseSize, filledAt);
  }
  if (order.order_kind === "entry") next = reconcilePaperOcoExits(next, key, filledAt);
  return next;
}

function attachPaperOcoExits(state: PaperTradingState, entryOrder: PaperOrder, baseSize: number, attachedAt: string) {
  if (!entryOrder.attached_oco) return state;
  const activeExits = state.orders.filter((order) =>
    order.status === "pending" && order.parent_order_id === entryOrder.order_id && order.oco_group_id != null);
  if (activeExits.length) {
    const activeGroup = activeExits[0].oco_group_id;
    const group = activeExits.filter((order) => order.oco_group_id === activeGroup);
    if (group.length !== 2) return state;
    const orders = state.orders.map((order) => group.some((item) => item.order_id === order.order_id) ? {
      ...order,
      base_size: order.base_size + baseSize,
      remaining_base_size: order.remaining_base_size + baseSize,
      quote_notional_usd: (order.base_size + baseSize) * orderValuationPrice(order),
      updated_at: attachedAt,
    } : order);
    const journal = journalEntry({
      sequence: state.next_sequence,
      event_type: "oco_reconciled",
      created_at: attachedAt,
      product: entryOrder.product,
      order_id: entryOrder.order_id,
      message: `PAPER simulated OCO increased by ${formatQuantity(baseSize)} ${entryOrder.product} after a partial entry fill`,
    });
    return nextState(state, {
      next_sequence: state.next_sequence + 1,
      orders,
      journal: trimRecords([journal, ...state.journal]),
      updated_at: maxIso(state.updated_at, attachedAt),
    });
  }
  const targetId = sequenceId("order", state.next_sequence);
  const invalidationId = sequenceId("order", state.next_sequence + 1);
  const groupId = `paper-oco-${entryOrder.order_id}-${targetId}`;
  const exitSide: PaperSide = entryOrder.side === "buy" ? "sell" : "buy";
  const common = {
    venue_id: entryOrder.venue_id,
    network: entryOrder.network,
    product: entryOrder.product,
    side: exitSide,
    reduce_only: true,
    parent_order_id: entryOrder.order_id,
    oco_group_id: groupId,
    attached_oco: null,
    time_in_force: "GTC" as const,
    status: "pending" as const,
    base_size: baseSize,
    filled_base_size: 0,
    remaining_base_size: baseSize,
    submitted_at: attachedAt,
    updated_at: attachedAt,
    filled_at: null,
    cancelled_at: null,
    fill_id: null,
    fill_price: null,
    fee_usd: 0,
    trail_offset_bps: null,
    trail_anchor_price: null,
    triggered_at: null,
    arrival_reference_price: null,
    cancel_reason: null,
    replaces_order_id: null,
    replaced_by_order_id: null,
  };
  const target: PaperOrder = {
    ...common,
    order_id: targetId,
    order_kind: "oco_target",
    order_type: "limit",
    oco_sibling_order_id: invalidationId,
    limit_price: entryOrder.attached_oco.target_price,
    stop_price: null,
    quote_notional_usd: baseSize * entryOrder.attached_oco.target_price,
  };
  const invalidation: PaperOrder = {
    ...common,
    order_id: invalidationId,
    order_kind: "oco_invalidation",
    order_type: "stop",
    oco_sibling_order_id: targetId,
    limit_price: null,
    stop_price: entryOrder.attached_oco.invalidation_price,
    quote_notional_usd: baseSize * entryOrder.attached_oco.invalidation_price,
  };
  const journal = journalEntry({
    sequence: state.next_sequence + 2,
    event_type: "oco_attached",
    created_at: attachedAt,
    product: entryOrder.product,
    order_id: entryOrder.order_id,
    message: `PAPER simulated reduce-only OCO attached · ${formatQuantity(baseSize)} ${entryOrder.product} · target ${formatNumber(target.limit_price as number)} · invalidation ${formatNumber(invalidation.stop_price as number)}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 3,
    orders: [invalidation, target, ...state.orders],
    journal: trimRecords([journal, ...state.journal]),
    updated_at: maxIso(state.updated_at, attachedAt),
  });
}

function reconcilePaperOcoExits(state: PaperTradingState, positionKey: string, reconciledAt: string) {
  const position = state.positions.find((item) => item.position_key === positionKey);
  const desiredSize = Math.abs(position?.quantity_base ?? 0);
  const desiredSide: PaperSide | null = !position || position.quantity_base === 0 ? null : position.quantity_base > 0 ? "sell" : "buy";
  const groupIds = Array.from(new Set(state.orders
    .filter((order) => order.status === "pending" && order.reduce_only && paperPositionKey(order) === positionKey && order.oco_group_id)
    .map((order) => order.oco_group_id as string)))
    .sort((a, b) => {
      const aTime = state.orders.find((order) => order.oco_group_id === a)?.submitted_at ?? "";
      const bTime = state.orders.find((order) => order.oco_group_id === b)?.submitted_at ?? "";
      return aTime.localeCompare(bTime) || a.localeCompare(b);
    });
  if (!groupIds.length) return state;

  let orders = state.orders;
  const actions: string[] = [];
  for (const groupId of groupIds) {
    const group = orders.filter((order) => order.status === "pending" && order.oco_group_id === groupId);
    if (!desiredSide || group.some((order) => order.side !== desiredSide)) {
      orders = cancelPendingGroupOrders(orders, groupId, reconciledAt);
      actions.push(`cancelled ${groupId}`);
    }
  }

  const activeGroups = groupIds
    .map((groupId) => orders.find((order) => order.status === "pending" && order.oco_group_id === groupId && order.order_kind === "oco_target"))
    .filter((order): order is PaperOrder => Boolean(order));
  let excess = Math.max(0, sum(activeGroups.map((order) => order.base_size)) - desiredSize);
  for (const target of activeGroups.slice().reverse()) {
    if (excess <= 1e-12) break;
    if (target.base_size <= excess + 1e-12) {
      orders = cancelPendingGroupOrders(orders, target.oco_group_id as string, reconciledAt);
      actions.push(`cancelled ${target.oco_group_id}`);
      excess -= target.base_size;
      continue;
    }
    const nextSize = target.base_size - excess;
    orders = orders.map((order) => order.status === "pending" && order.oco_group_id === target.oco_group_id ? {
      ...order,
      base_size: nextSize,
      remaining_base_size: Math.max(0, nextSize - order.filled_base_size),
      quote_notional_usd: nextSize * orderValuationPrice(order),
      updated_at: reconciledAt,
    } : order);
    actions.push(`resized ${target.oco_group_id} to ${formatQuantity(nextSize)}`);
    excess = 0;
  }
  if (!actions.length) return state;
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "oco_reconciled",
    created_at: reconciledAt,
    product: position?.product ?? null,
    message: `PAPER simulated OCO reconciled to ${formatQuantity(desiredSize)} base · ${actions.join(" · ")}`,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    orders,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: maxIso(state.updated_at, reconciledAt),
  });
}

function cancelOcoGroup(state: PaperTradingState, order: PaperOrder, cancelledAt: string, message: string) {
  if (!order.oco_group_id) return state;
  const orders = cancelPendingGroupOrders(state.orders, order.oco_group_id, cancelledAt);
  const entry = journalEntry({
    sequence: state.next_sequence,
    event_type: "oco_reconciled",
    created_at: cancelledAt,
    product: order.product,
    order_id: order.order_id,
    message,
  });
  return nextState(state, {
    next_sequence: state.next_sequence + 1,
    orders,
    journal: trimRecords([entry, ...state.journal]),
    updated_at: maxIso(state.updated_at, cancelledAt),
  });
}

function cancelPendingGroupOrders(orders: PaperOrder[], groupId: string, cancelledAt: string) {
  return orders.map((order) => order.status === "pending" && order.oco_group_id === groupId ? {
    ...order,
    status: "cancelled" as const,
    cancelled_at: cancelledAt,
    updated_at: cancelledAt,
    cancel_reason: "oco_sibling" as const,
  } : order);
}

function openedExposureFromFill(currentQuantity: number, side: PaperSide, baseSize: number) {
  const fillQuantity = side === "buy" ? baseSize : -baseSize;
  if (currentQuantity === 0 || Math.sign(currentQuantity) === Math.sign(fillQuantity)) return baseSize;
  return Math.max(0, baseSize - Math.abs(currentQuantity));
}

function recordPaperMark(state: PaperTradingState, market: PaperMarketObservation) {
  if (!paperFreshBbo(market) || market.quote_fetched_at == null) return state;
  const markPrice = midpoint(market.best_bid, market.best_ask);
  if (markPrice == null) return state;
  const positionKey = paperPositionKey(market);
  const existing = state.marks.find((item) => item.position_key === positionKey);
  if (existing && Date.parse(market.quote_fetched_at) <= Date.parse(existing.fetched_at)) return state;
  const mark: PaperMark = {
    position_key: positionKey,
    venue_id: market.venue_id,
    network: market.network,
    product: market.product,
    mark_price: markPrice,
    fetched_at: market.quote_fetched_at,
    observed_at: market.observed_at,
  };
  const marks = state.marks.some((item) => item.position_key === positionKey)
    ? state.marks.map((item) => item.position_key === positionKey ? mark : item)
    : trimRecords([mark, ...state.marks]);
  return nextState(state, { marks, updated_at: maxIso(state.updated_at, market.observed_at) });
}

function applyFillToPosition(
  position: PaperPosition,
  side: PaperSide,
  baseSize: number,
  fillPrice: number,
  fee: number,
  filledAt: string,
) {
  const oldQuantity = position.quantity_base;
  const fillQuantity = side === "buy" ? baseSize : -baseSize;
  const oldSign = Math.sign(oldQuantity);
  const fillSign = Math.sign(fillQuantity);
  let nextQuantity = oldQuantity + fillQuantity;
  if (Math.abs(nextQuantity) < 1e-12) nextQuantity = 0;
  let averageEntry = position.average_entry_price;
  let realizedDelta = 0;

  if (oldQuantity === 0 || oldSign === fillSign) {
    const oldNotional = Math.abs(oldQuantity) * (averageEntry ?? fillPrice);
    averageEntry = (oldNotional + Math.abs(fillQuantity) * fillPrice) / Math.abs(nextQuantity);
  } else {
    const closingSize = Math.min(Math.abs(oldQuantity), Math.abs(fillQuantity));
    realizedDelta = closingSize * (fillPrice - (averageEntry ?? fillPrice)) * oldSign;
    if (nextQuantity === 0) averageEntry = null;
    else if (Math.sign(nextQuantity) !== oldSign) averageEntry = fillPrice;
  }

  return {
    realizedDelta,
    position: {
      ...position,
      quantity_base: nextQuantity,
      average_entry_price: averageEntry,
      realized_pnl_gross_usd: position.realized_pnl_gross_usd + realizedDelta,
      fees_paid_usd: position.fees_paid_usd + fee,
      updated_at: filledAt,
    },
  };
}

function emptyPosition(order: PaperOrder, openedAt: string): PaperPosition {
  return {
    position_key: paperPositionKey(order),
    venue_id: order.venue_id,
    network: order.network,
    product: order.product,
    quantity_base: 0,
    average_entry_price: null,
    realized_pnl_gross_usd: 0,
    fees_paid_usd: 0,
    opened_at: openedAt,
    updated_at: openedAt,
  };
}

function journalEntry(input: {
  sequence: number;
  event_type: PaperJournalEventType;
  created_at: string;
  product?: string | null;
  order_id?: string | null;
  fill_id?: string | null;
  message: string;
}): PaperJournalEntry {
  return {
    journal_id: sequenceId("journal", input.sequence),
    event_type: input.event_type,
    created_at: input.created_at,
    product: input.product ?? null,
    order_id: input.order_id ?? null,
    fill_id: input.fill_id ?? null,
    message: input.message,
  };
}

function armedRiskControl(equity: number, startedAt: string): PaperRiskControl {
  return {
    status: "armed",
    reason: null,
    message: null,
    session_started_at: startedAt,
    session_start_equity_usd: equity,
    session_peak_equity_usd: equity,
    last_equity_usd: equity,
    triggered_at: null,
  };
}

function nextState(state: PaperTradingState, patch: Partial<PaperTradingState>): PaperTradingState {
  const candidate = {
    ...state,
    ...patch,
    version: PAPER_TRADING_STATE_VERSION,
    mode: PAPER_TRADING_MODE,
    revision: state.revision + 1,
  };
  const retained = retainPaperHistory(candidate.orders, candidate.fills);
  return {
    ...candidate,
    orders: retained.orders,
    fills: retained.fills,
  };
}

function recordPaperObservation(state: PaperTradingState, key: string, observedAt: string) {
  return nextState(state, {
    observation_times: { ...state.observation_times, [key]: observedAt },
    updated_at: maxIso(state.updated_at, observedAt),
  });
}

function recordPaperMarketCursor(state: PaperTradingState, key: string, cursor: PaperMarketCursor) {
  return nextState(state, {
    market_cursors: { ...state.market_cursors, [key]: cursor },
    updated_at: maxIso(state.updated_at, cursor.updated_at),
  });
}

function nextPaperMarketCursor(
  market: PaperMarketObservation,
  previous: PaperMarketCursor | undefined,
  snapshotId: string,
): PaperMarketCursor {
  const validTrades = market.trades
    .map((trade) => ({ trade, key: paperTradeKey(trade) }))
    .filter((entry): entry is { trade: typeof entry.trade; key: string } => entry.key != null)
    .filter(({ trade }) => paperTradeFresh(trade, market));
  const frameMax = validTrades.length ? Math.max(...validTrades.map(({ trade }) => trade.time)) : null;
  const maxTradeTime = previous?.max_trade_time == null
    ? frameMax
    : frameMax == null ? previous.max_trade_time : Math.max(previous.max_trade_time, frameMax);
  const previousKeys = previous?.max_trade_time === maxTradeTime ? previous.max_trade_keys : [];
  const maxTradeKeys = maxTradeTime == null ? [] : Array.from(new Set([
    ...previousKeys,
    ...validTrades.filter(({ trade }) => trade.time === maxTradeTime).map(({ key }) => key),
  ])).slice(0, MAX_MARKET_TRADES);
  const bookSnapshotId = previous && legacyV4BookCursorCutoff(previous.book_snapshot_id) != null && !paperBookNewerThanLegacyCursor(previous, market)
    ? previous.book_snapshot_id
    : paperBookSnapshotId(market);
  return {
    snapshot_id: snapshotId,
    book_snapshot_id: bookSnapshotId,
    snapshot_fetched_at: market.fetched_at,
    max_trade_time: maxTradeTime,
    max_trade_keys: maxTradeKeys,
    updated_at: market.observed_at,
  };
}

function paperSnapshotId(market: PaperMarketObservation) {
  const explicit = typeof market.snapshot_id === "string" && market.snapshot_id.trim() && market.snapshot_id.length <= 500
    ? market.snapshot_id.trim()
    : null;
  if (explicit) return boundedPaperSnapshotId(`${explicit}#quote:${market.quote_fetched_at ?? "missing"}`);
  const tradeIdentity = market.trades.map((trade) => paperTradeKey(trade) ?? "invalid").join("|");
  const bids = market.bids?.map((level) => `${level.price}:${level.size}`).join("|") ?? "missing";
  const asks = market.asks?.map((level) => `${level.price}:${level.size}`).join("|") ?? "missing";
  return boundedPaperSnapshotId(`${market.fetched_at}#quote:${market.quote_fetched_at ?? "missing"}#${market.best_bid ?? ""}#${market.best_ask ?? ""}#${bids}#${asks}#${tradeIdentity}`);
}

function paperBookSnapshotId(market: PaperMarketObservation) {
  const bids = market.bids?.map((level) => `${level.price}:${level.size}`).join("|") ?? "missing";
  const asks = market.asks?.map((level) => `${level.price}:${level.size}`).join("|") ?? "missing";
  const revision = market.book_revision == null
    ? `content:${bids}#${asks}`
    : `revision:${market.book_revision}`;
  return boundedPaperSnapshotId(`${market.venue_id}:${market.network}:${market.product}:book:${revision}`);
}

function boundedPaperSnapshotId(identity: string) {
  if (identity.length <= 10_000) return identity;
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32:${identity.length}:${(hash >>> 0).toString(16)}`;
}

function legacyV4BookCursor(snapshotFetchedAt: string) {
  return `${LEGACY_V4_BOOK_CURSOR_PREFIX}${snapshotFetchedAt}`;
}

function legacyV4BookCursorCutoff(value: string) {
  if (!value.startsWith(LEGACY_V4_BOOK_CURSOR_PREFIX)) return null;
  const cutoff = Date.parse(value.slice(LEGACY_V4_BOOK_CURSOR_PREFIX.length));
  return Number.isFinite(cutoff) ? cutoff : null;
}

function maxIso(a: string, b: string) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function validateObservation(observation: PaperMarketObservation): PaperMarketObservation {
  const maxAge = Number(observation.max_age_ms);
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 300_000) throw new Error("paper_market_age_invalid");
  requiredIso(observation.fetched_at, "paper_market_time_invalid");
  requiredIso(observation.observed_at, "paper_market_time_invalid");
  if (observation.snapshot_id != null && (typeof observation.snapshot_id !== "string" || !observation.snapshot_id.trim() || observation.snapshot_id.length > 500)) {
    throw new Error("paper_market_snapshot_invalid");
  }
  return {
    ...observation,
    venue_id: safeLabel(observation.venue_id, "paper_market_venue_invalid"),
    network: safeLabel(observation.network, "paper_market_network_invalid"),
    product: safeProduct(observation.product),
    quote_fetched_at: optionalIso(observation.quote_fetched_at, "paper_market_quote_time_invalid"),
    book_fetched_at: optionalIso(observation.book_fetched_at, "paper_market_book_time_invalid"),
    book_revision: observation.book_revision == null
      ? null
      : strictPositiveNumber(observation.book_revision, "paper_market_book_revision_invalid"),
    max_age_ms: maxAge,
    best_bid: finitePositiveOrNull(observation.best_bid),
    best_ask: finitePositiveOrNull(observation.best_ask),
    mark_price: finitePositiveOrNull(observation.mark_price),
    bids: normalizeObservationDepth(observation.bids),
    asks: normalizeObservationDepth(observation.asks),
    trades: Array.isArray(observation.trades)
      ? observation.trades.slice(0, MAX_MARKET_TRADES).map((trade) => ({
        id: typeof trade.id === "string" && trade.id.trim() && trade.id.length <= 200 ? trade.id.trim() : undefined,
        price: trade.price,
        side: trade.side,
        time: trade.time,
        size: finitePositiveOrNull(trade.size) ?? undefined,
      }))
      : [],
  };
}

function normalizeObservationDepth(levels: PaperMarketObservation["bids"] | PaperMarketObservation["asks"]) {
  return Array.isArray(levels) ? levels.slice(0, MAX_MARKET_DEPTH_LEVELS) : undefined;
}

function migratePaperTradingState(value: unknown): unknown {
  const state = objectValue(value);
  if (!state || state.mode !== PAPER_TRADING_MODE) return value;
  if (state.version === PAPER_TRADING_STATE_VERSION) {
    return state;
  }
  if (state.version === 4) {
    const assumptions = validateAssumptions(state.assumptions as PaperTradingAssumptions);
    const cursors = objectValue(state.market_cursors);
    const migrated = {
      ...state,
      version: PAPER_TRADING_STATE_VERSION,
      assumptions,
      orders: Array.isArray(state.orders) ? state.orders.map((value) => {
        const order = objectValue(value);
        return order ? { ...order, arrival_reference_price: null } : value;
      }) : state.orders,
      observation_times: objectValue(state.observation_times) ? state.observation_times : {},
      market_cursors: cursors
        ? Object.fromEntries(Object.entries(cursors).map(([key, value]) => {
          const cursor = objectValue(value);
          return [key, cursor && typeof cursor.book_snapshot_id !== "string"
            ? { ...cursor, book_snapshot_id: legacyV4BookCursor(String(cursor.snapshot_fetched_at)) }
            : value];
        }))
        : {},
    };
    assertPaperState(migrated);
    return migrated;
  }
  if (!new Set([1, 2, 3]).has(Number(state.version))) return value;
  const assumptions = validateAssumptions(state.assumptions as PaperTradingAssumptions);
  const sessionStartedAt = requiredIso(String(state.created_at), "paper_state_invalid");
  const orders = Array.isArray(state.orders) ? state.orders.map((value) => {
    const order = objectValue(value);
    if (!order) return value;
    const legacyKind = state.version === 1 || state.version === 2 ? "entry" : String(order.order_kind);
    const baseSize = Number(order.base_size);
    const status = String(order.status);
    const legacyLimit = finitePositiveOrNull(Number(order.limit_price));
    const isInvalidation = legacyKind === "oco_invalidation";
    return {
      ...order,
      order_kind: legacyKind,
      reduce_only: state.version === 1 || state.version === 2 ? false : order.reduce_only,
      parent_order_id: state.version === 1 || state.version === 2 ? null : order.parent_order_id,
      oco_group_id: state.version === 1 || state.version === 2 ? null : order.oco_group_id,
      oco_sibling_order_id: state.version === 1 || state.version === 2 ? null : order.oco_sibling_order_id,
      attached_oco: state.version === 1 || state.version === 2 ? null : order.attached_oco,
      order_type: isInvalidation ? "stop" : "limit",
      time_in_force: "GTC",
      limit_price: isInvalidation ? null : legacyLimit,
      stop_price: isInvalidation ? legacyLimit : null,
      trail_offset_bps: null,
      trail_anchor_price: null,
      triggered_at: null,
      arrival_reference_price: null,
      filled_base_size: status === "filled" ? baseSize : 0,
      remaining_base_size: status === "filled" ? 0 : baseSize,
      cancel_reason: null,
      replaces_order_id: null,
      replaced_by_order_id: null,
    };
  }) : state.orders;
  const migrated = {
    ...state,
    version: PAPER_TRADING_STATE_VERSION,
    assumptions,
    orders,
    marks: Array.isArray(state.marks) ? state.marks : [],
    risk_policy: state.version === 1 ? defaultPaperRiskPolicy(assumptions.starting_equity_usd) : state.risk_policy,
    risk_control: state.version === 1 ? armedRiskControl(assumptions.starting_equity_usd, sessionStartedAt) : state.risk_control,
    oco_defaults: { enabled: false },
    observation_times: {},
    market_cursors: {},
  };
  assertPaperState(migrated);
  if (state.version === 2 || state.version === 3) return migrated;
  const currentEquity = paperAccountSummary(migrated).equity_usd;
  return { ...migrated, risk_control: armedRiskControl(currentEquity, sessionStartedAt) };
}

function assertPaperState(value: unknown): asserts value is PaperTradingState {
  const state = objectValue(value);
  if (!state || state.version !== PAPER_TRADING_STATE_VERSION || state.mode !== PAPER_TRADING_MODE) throw new Error("paper_state_invalid");
  if (!Number.isInteger(state.revision) || Number(state.revision) < 0 || !Number.isInteger(state.next_sequence) || Number(state.next_sequence) < 1) {
    throw new Error("paper_state_invalid");
  }
  validateAssumptions(state.assumptions as PaperTradingAssumptions);
  validateRiskPolicy(state.risk_policy as PaperRiskPolicy);
  validateRiskControl(state.risk_control as PaperRiskControl);
  validateOcoDefaults(state.oco_defaults as PaperOcoDefaults);
  const observationTimes = objectValue(state.observation_times);
  const marketCursors = objectValue(state.market_cursors);
  if (!Array.isArray(state.orders) || !Array.isArray(state.fills) || !Array.isArray(state.positions) || !Array.isArray(state.marks) || !Array.isArray(state.journal) || !observationTimes || !marketCursors) {
    throw new Error("paper_state_invalid");
  }
  if ([state.orders, state.fills, state.positions, state.marks, state.journal].some((records) => records.length > MAX_RECORDS)) throw new Error("paper_state_invalid");
  requiredIso(String(state.created_at), "paper_state_invalid");
  requiredIso(String(state.updated_at), "paper_state_invalid");
  const orders = state.orders as PaperOrder[];
  const fills = state.fills as PaperFill[];
  const positions = state.positions as PaperPosition[];
  const marks = state.marks as PaperMark[];
  const journal = state.journal as PaperJournalEntry[];
  assertUnique(orders.map((order) => order.order_id));
  assertUnique(fills.map((fill) => fill.fill_id));
  assertUnique(positions.map((position) => position.position_key));
  assertUnique(marks.map((mark) => mark.position_key));
  assertUnique(journal.map((entry) => entry.journal_id));
  const recordIds = [
    ...orders.map((order) => order.order_id),
    ...fills.map((fill) => fill.fill_id),
    ...journal.map((entry) => entry.journal_id),
  ];
  const recordSequences = recordIds.map(paperRecordSequence);
  assertUnique(recordSequences.map(String));
  const highestSequence = Math.max(0, ...recordSequences);
  if (Number(state.next_sequence) <= highestSequence) throw new Error("paper_state_invalid");

  if (Object.keys(observationTimes).length > MAX_RECORDS) throw new Error("paper_state_invalid");
  for (const [key, observedAt] of Object.entries(observationTimes)) {
    validatePaperPositionKey(key);
    requiredIso(String(observedAt), "paper_state_invalid");
  }
  if (Object.keys(marketCursors).length > MAX_RECORDS) throw new Error("paper_state_invalid");
  for (const [key, value] of Object.entries(marketCursors)) {
    validatePaperPositionKey(key);
    validatePaperMarketCursor(value);
  }
  for (const order of orders) validateOrder(order);
  const ordersById = new Map(orders.map((order) => [order.order_id, order]));
  const fillsById = new Map(fills.map((fill) => [fill.fill_id, fill]));
  for (const order of orders) {
    if (order.filled_base_size > 1e-12) {
      const fill = fillsById.get(String(order.fill_id));
      if (!fill || fill.order_id !== order.order_id) throw new Error("paper_state_invalid");
    } else if (order.fill_id != null || order.fill_price != null || order.fee_usd !== 0) {
      throw new Error("paper_state_invalid");
    }
    if (order.replaces_order_id != null) {
      const replaced = ordersById.get(order.replaces_order_id);
      if (
        !replaced ||
        replaced.replaced_by_order_id !== order.order_id ||
        replaced.status !== "replaced" ||
        paperPositionKey(replaced) !== paperPositionKey(order) ||
        replaced.side !== order.side ||
        paperRecordSequence(replaced.order_id) >= paperRecordSequence(order.order_id) ||
        Date.parse(replaced.submitted_at) > Date.parse(order.submitted_at)
      ) {
        throw new Error("paper_state_invalid");
      }
    }
    if (order.replaced_by_order_id != null) {
      const replacement = ordersById.get(order.replaced_by_order_id);
      if (!replacement || replacement.replaces_order_id !== order.order_id || order.status !== "replaced" || paperPositionKey(replacement) !== paperPositionKey(order) || replacement.side !== order.side) {
        throw new Error("paper_state_invalid");
      }
    } else if (order.status === "replaced") {
      throw new Error("paper_state_invalid");
    }
    if (order.oco_group_id != null) {
      const sibling = ordersById.get(String(order.oco_sibling_order_id));
      const parent = ordersById.get(String(order.parent_order_id));
      if (
        !sibling ||
        !parent ||
        parent.order_kind !== "entry" ||
        parent.filled_base_size <= 0 ||
        !parent.attached_oco ||
        sibling.oco_sibling_order_id !== order.order_id ||
        sibling.oco_group_id !== order.oco_group_id ||
        sibling.parent_order_id !== order.parent_order_id ||
        sibling.side !== order.side ||
        sibling.order_kind === order.order_kind ||
        paperPositionKey(parent) !== paperPositionKey(order)
      ) {
        throw new Error("paper_state_invalid");
      }
    }
  }
  const ocoGroups = new Map<string, PaperOrder[]>();
  for (const order of orders) {
    if (!order.oco_group_id) continue;
    ocoGroups.set(order.oco_group_id, [...(ocoGroups.get(order.oco_group_id) ?? []), order]);
  }
  for (const group of ocoGroups.values()) {
    const filled = group.filter((order) => order.status === "filled").length;
    if (group.length !== 2 || filled > 1) throw new Error("paper_state_invalid");
  }
  for (const fill of fills) {
    validateFill(fill);
    const order = ordersById.get(fill.order_id);
    if (!order || paperPositionKey(fill) !== paperPositionKey(order) || fill.side !== order.side) throw new Error("paper_state_invalid");
  }
  for (const position of positions) validatePosition(position);
  for (const mark of marks) validateMark(mark);
  for (const entry of journal) validateJournal(entry);
}

function validateOrder(order: PaperOrder) {
  if (!order || typeof order !== "object" || !/^paper-order-\d{8}$/.test(order.order_id)) throw new Error("paper_state_invalid");
  if (!new Set<PaperOrderStatus>(["pending", "filled", "cancelled", "replaced"]).has(order.status)) throw new Error("paper_state_invalid");
  if (!new Set<PaperOrderKind>(["entry", "oco_target", "oco_invalidation"]).has(order.order_kind)) throw new Error("paper_state_invalid");
  if (typeof order.reduce_only !== "boolean" || (order.order_kind !== "entry" && !order.reduce_only)) throw new Error("paper_state_invalid");
  if (order.order_kind === "entry") {
    if (order.parent_order_id != null || order.oco_group_id != null || order.oco_sibling_order_id != null) throw new Error("paper_state_invalid");
    if (order.attached_oco) {
      const validation = validatePaperAttachedOco({
        side: order.side,
        entry_price: orderValuationPrice(order),
        target_price: order.attached_oco.target_price,
        invalidation_price: order.attached_oco.invalidation_price,
      });
      if (!validation.valid) throw new Error("paper_state_invalid");
    }
  } else {
    if (!/^paper-order-\d{8}$/.test(String(order.parent_order_id)) || !/^paper-order-\d{8}$/.test(String(order.oco_sibling_order_id)) || !/^paper-oco-paper-order-\d{8}(?:-paper-order-\d{8})?$/.test(String(order.oco_group_id)) || order.attached_oco != null) {
      throw new Error("paper_state_invalid");
    }
  }
  safeLabel(order.venue_id, "paper_state_invalid");
  safeLabel(order.network, "paper_state_invalid");
  safeProduct(order.product);
  if (order.side !== "buy" && order.side !== "sell") throw new Error("paper_state_invalid");
  if (!new Set<PaperOrderType>(["market", "limit", "stop", "stop_limit", "trailing_stop"]).has(order.order_type)) throw new Error("paper_state_invalid");
  if (!new Set<PaperTimeInForce>(["GTC", "IOC", "FOK"]).has(order.time_in_force)) throw new Error("paper_state_invalid");
  if (order.order_type === "market" && order.time_in_force === "GTC") throw new Error("paper_state_invalid");
  if (order.order_type === "limit" || order.order_type === "stop_limit") positiveFinite(Number(order.limit_price), "paper_state_invalid");
  else if (order.limit_price != null) throw new Error("paper_state_invalid");
  if (order.order_type === "stop" || order.order_type === "stop_limit") positiveFinite(Number(order.stop_price), "paper_state_invalid");
  else if (order.order_type !== "trailing_stop" && order.stop_price != null) throw new Error("paper_state_invalid");
  if (order.order_type === "trailing_stop") {
    const offset = positiveFinite(Number(order.trail_offset_bps), "paper_state_invalid");
    if (offset > 5_000) throw new Error("paper_state_invalid");
    if (order.trail_anchor_price != null) positiveFinite(order.trail_anchor_price, "paper_state_invalid");
    if (order.stop_price != null) positiveFinite(order.stop_price, "paper_state_invalid");
  } else if (order.trail_offset_bps != null || order.trail_anchor_price != null) throw new Error("paper_state_invalid");
  if (!("arrival_reference_price" in order)) throw new Error("paper_state_invalid");
  if (order.arrival_reference_price !== null) positiveFinite(order.arrival_reference_price, "paper_state_invalid");
  positiveFinite(order.quote_notional_usd, "paper_state_invalid");
  positiveFinite(order.base_size, "paper_state_invalid");
  nonNegativeFinite(order.filled_base_size, "paper_state_invalid");
  nonNegativeFinite(order.remaining_base_size, "paper_state_invalid");
  nonNegativeFinite(order.fee_usd, "paper_state_invalid");
  if (Math.abs(order.filled_base_size + order.remaining_base_size - order.base_size) > 1e-8) throw new Error("paper_state_invalid");
  if (order.status === "pending" && order.remaining_base_size <= 0) throw new Error("paper_state_invalid");
  if (order.status === "filled" && (order.remaining_base_size > 1e-12 || order.filled_base_size <= 0)) throw new Error("paper_state_invalid");
  if (!new Set<PaperOrderCancelReason>([
    null, "user_cancelled", "cancel_all", "ioc_not_marketable", "ioc_remainder_cancelled", "fok_not_fillable",
    "risk_control", "oco_sibling", "position_unavailable",
  ]).has(order.cancel_reason)) throw new Error("paper_state_invalid");
  if (order.replaces_order_id != null && !/^paper-order-\d{8}$/.test(order.replaces_order_id)) throw new Error("paper_state_invalid");
  if (order.replaced_by_order_id != null && !/^paper-order-\d{8}$/.test(order.replaced_by_order_id)) throw new Error("paper_state_invalid");
  requiredIso(order.submitted_at, "paper_state_invalid");
  requiredIso(order.updated_at, "paper_state_invalid");
  if (order.triggered_at != null) requiredIso(order.triggered_at, "paper_state_invalid");
  if (order.filled_at != null) requiredIso(order.filled_at, "paper_state_invalid");
  if (order.cancelled_at != null) requiredIso(order.cancelled_at, "paper_state_invalid");
  if (order.filled_base_size > 1e-12 && (order.filled_at == null || order.fill_price == null)) throw new Error("paper_state_invalid");
  if (order.fill_price != null) positiveFinite(order.fill_price, "paper_state_invalid");
  if (order.status === "pending" && order.cancelled_at != null) throw new Error("paper_state_invalid");
  if ((order.status === "cancelled" || order.status === "replaced") && order.cancelled_at == null) throw new Error("paper_state_invalid");
}

function validateFill(fill: PaperFill) {
  if (!fill || typeof fill !== "object" || !/^paper-fill-\d{8}$/.test(fill.fill_id) || !/^paper-order-\d{8}$/.test(fill.order_id)) throw new Error("paper_state_invalid");
  safeLabel(fill.venue_id, "paper_state_invalid");
  safeLabel(fill.network, "paper_state_invalid");
  safeProduct(fill.product);
  if (fill.side !== "buy" && fill.side !== "sell") throw new Error("paper_state_invalid");
  positiveFinite(fill.base_size, "paper_state_invalid");
  positiveFinite(fill.reference_price, "paper_state_invalid");
  positiveFinite(fill.fill_price, "paper_state_invalid");
  positiveFinite(fill.notional_usd, "paper_state_invalid");
  nonNegativeFinite(fill.fee_usd, "paper_state_invalid");
  nonNegativeFinite(fill.fee_bps, "paper_state_invalid");
  nonNegativeFinite(fill.slippage_bps, "paper_state_invalid");
  const expectedNotional = fill.fill_price * fill.base_size;
  const expectedFee = fill.notional_usd * fill.fee_bps / 10_000;
  if (
    !paperArithmeticMatches(fill.notional_usd, expectedNotional, 1e-8)
    || !paperArithmeticMatches(fill.fee_usd, expectedFee, 1e-10)
  ) throw new Error("paper_state_invalid");
  if (!Number.isFinite(fill.realized_pnl_gross_usd)) throw new Error("paper_state_invalid");
  requiredIso(fill.filled_at, "paper_state_invalid");
}

function paperArithmeticMatches(actual: number, expected: number, absoluteTolerance: number) {
  return Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * 1e-8);
}

function validatePosition(position: PaperPosition) {
  if (!position || typeof position !== "object" || position.position_key !== paperPositionKey(position)) throw new Error("paper_state_invalid");
  safeLabel(position.venue_id, "paper_state_invalid");
  safeLabel(position.network, "paper_state_invalid");
  safeProduct(position.product);
  if (!Number.isFinite(position.quantity_base) || !Number.isFinite(position.realized_pnl_gross_usd) || !Number.isFinite(position.fees_paid_usd)) {
    throw new Error("paper_state_invalid");
  }
  nonNegativeFinite(position.fees_paid_usd, "paper_state_invalid");
  if (position.average_entry_price != null) positiveFinite(position.average_entry_price, "paper_state_invalid");
  if ((Math.abs(position.quantity_base) <= 1e-12) !== (position.average_entry_price == null)) throw new Error("paper_state_invalid");
  requiredIso(position.opened_at, "paper_state_invalid");
  requiredIso(position.updated_at, "paper_state_invalid");
}

function validateMark(mark: PaperMark) {
  if (!mark || typeof mark !== "object" || mark.position_key !== paperPositionKey(mark)) throw new Error("paper_state_invalid");
  safeLabel(mark.venue_id, "paper_state_invalid");
  safeLabel(mark.network, "paper_state_invalid");
  safeProduct(mark.product);
  positiveFinite(mark.mark_price, "paper_state_invalid");
  requiredIso(mark.fetched_at, "paper_state_invalid");
  requiredIso(mark.observed_at, "paper_state_invalid");
}

function validateJournal(entry: PaperJournalEntry) {
  if (!entry || typeof entry !== "object" || !/^paper-journal-\d{8}$/.test(entry.journal_id) || typeof entry.message !== "string") {
    throw new Error("paper_state_invalid");
  }
  if (!new Set<PaperJournalEventType>([
    "order_placed",
    "order_filled",
    "order_cancelled",
    "order_replaced",
    "orders_cancelled",
    "assumptions_updated",
    "risk_policy_updated",
    "risk_control_tripped",
    "risk_control_killed",
    "risk_control_rearmed",
    "oco_defaults_updated",
    "oco_attached",
    "oco_reconciled",
    "oco_sibling_cancelled",
    "note",
  ]).has(entry.event_type)) throw new Error("paper_state_invalid");
  if (entry.product != null) safeProduct(entry.product);
  if (entry.order_id != null && !/^paper-order-\d{8}$/.test(entry.order_id)) throw new Error("paper_state_invalid");
  if (entry.fill_id != null && !/^paper-fill-\d{8}$/.test(entry.fill_id)) throw new Error("paper_state_invalid");
  if (!entry.message.trim() || entry.message.length > 1_000) throw new Error("paper_state_invalid");
  requiredIso(entry.created_at, "paper_state_invalid");
}

function validateRiskPolicy(input: PaperRiskPolicy): PaperRiskPolicy {
  const policy = objectValue(input);
  if (!policy) throw new Error("paper_risk_policy_invalid");
  const maxOrder = strictPositiveNumber(policy.max_order_notional_usd, "paper_risk_policy_invalid");
  const maxPosition = strictPositiveNumber(policy.max_position_notional_usd, "paper_risk_policy_invalid");
  const maxOpenOrders = strictPositiveNumber(policy.max_open_orders, "paper_risk_policy_invalid");
  const maxSessionLoss = strictPositiveNumber(policy.max_session_loss_usd, "paper_risk_policy_invalid");
  const maxDrawdown = strictPositiveNumber(policy.max_drawdown_usd, "paper_risk_policy_invalid");
  if (
    maxOrder > 1_000_000 ||
    maxPosition > 10_000_000 ||
    maxPosition < maxOrder ||
    !Number.isInteger(maxOpenOrders) ||
    maxOpenOrders < 1 ||
    maxOpenOrders > 100 ||
    maxSessionLoss > 100_000_000 ||
    maxDrawdown > 100_000_000
  ) throw new Error("paper_risk_policy_invalid");
  return {
    max_order_notional_usd: maxOrder,
    max_position_notional_usd: maxPosition,
    max_open_orders: maxOpenOrders,
    max_session_loss_usd: maxSessionLoss,
    max_drawdown_usd: maxDrawdown,
  };
}

function validateOcoDefaults(input: PaperOcoDefaults): PaperOcoDefaults {
  const defaults = objectValue(input);
  if (!defaults || typeof defaults.enabled !== "boolean") throw new Error("paper_oco_defaults_invalid");
  return { enabled: defaults.enabled };
}

function validateRiskControl(input: PaperRiskControl) {
  const control = objectValue(input);
  if (!control || !new Set<PaperRiskControlStatus>(["armed", "tripped", "killed"]).has(control.status as PaperRiskControlStatus)) {
    throw new Error("paper_risk_control_invalid");
  }
  const validReasons = new Set([null, "kill_switch", "session_loss_limit", "max_drawdown_limit"]);
  if (!validReasons.has(control.reason as string | null)) throw new Error("paper_risk_control_invalid");
  if (control.message != null && (typeof control.message !== "string" || control.message.length > 1_000)) throw new Error("paper_risk_control_invalid");
  requiredIso(String(control.session_started_at), "paper_risk_control_invalid");
  for (const value of [control.session_start_equity_usd, control.session_peak_equity_usd, control.last_equity_usd]) {
    if (!Number.isFinite(value)) throw new Error("paper_risk_control_invalid");
  }
  if (
    Number(control.session_peak_equity_usd) < Number(control.session_start_equity_usd) ||
    Number(control.session_peak_equity_usd) < Number(control.last_equity_usd)
  ) throw new Error("paper_risk_control_invalid");
  if (control.triggered_at != null) requiredIso(String(control.triggered_at), "paper_risk_control_invalid");
  if (control.status === "armed" && (control.reason != null || control.message != null || control.triggered_at != null)) throw new Error("paper_risk_control_invalid");
  if (control.status !== "armed" && (control.reason == null || control.message == null || control.triggered_at == null)) throw new Error("paper_risk_control_invalid");
}

function validateAssumptions(input: PaperTradingAssumptions) {
  const assumptions = objectValue(input);
  if (!assumptions) throw new Error("paper_assumptions_invalid");
  const startingEquity = strictPositiveNumber(assumptions.starting_equity_usd, "paper_assumptions_invalid");
  const feeBps = strictNonNegativeNumber(assumptions.fee_bps, "paper_assumptions_invalid");
  const slippageBps = strictNonNegativeNumber(assumptions.slippage_bps, "paper_assumptions_invalid");
  if (startingEquity > 100_000_000 || feeBps > 500 || slippageBps > 500) throw new Error("paper_assumptions_invalid");
  return { starting_equity_usd: startingEquity, fee_bps: feeBps, slippage_bps: slippageBps };
}

function safeLabel(value: string, error: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) throw new Error(error);
  return normalized;
}

function safeProduct(value: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized)) throw new Error("paper_order_product_invalid");
  return normalized;
}

function requiredIso(value: string, error: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(error);
  return value;
}

function optionalIso(value: string | null | undefined, error: string) {
  return value == null ? null : requiredIso(String(value), error);
}

function positiveFinite(value: number, error: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(error);
  return value;
}

function nonNegativeFinite(value: number, error: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(error);
  return value;
}

function strictPositiveNumber(value: unknown, error: string) {
  if (typeof value !== "number") throw new Error(error);
  return positiveFinite(value, error);
}

function strictNonNegativeNumber(value: unknown, error: string) {
  if (typeof value !== "number") throw new Error(error);
  return nonNegativeFinite(value, error);
}

function finitePositiveOrNull(value: number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteOrNull(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null;
}

function midpoint(bid: number | null | undefined, ask: number | null | undefined) {
  const safeBid = finitePositiveOrNull(bid);
  const safeAsk = finitePositiveOrNull(ask);
  return safeBid != null && safeAsk != null ? (safeBid + safeAsk) / 2 : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertUnique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error("paper_state_invalid");
}

function paperRecordSequence(id: string) {
  const match = /^paper-(?:order|fill|journal)-(\d{8})$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function validatePaperPositionKey(key: string) {
  const parts = key.split(":");
  if (parts.length !== 3 || `${safeLabel(parts[0], "paper_state_invalid")}:${safeLabel(parts[1], "paper_state_invalid")}:${safeProduct(parts[2])}` !== key) {
    throw new Error("paper_state_invalid");
  }
}

function validatePaperMarketCursor(value: unknown) {
  const cursor = objectValue(value);
  if (!cursor || typeof cursor.snapshot_id !== "string" || !cursor.snapshot_id || cursor.snapshot_id.length > 10_000) {
    throw new Error("paper_state_invalid");
  }
  if (typeof cursor.book_snapshot_id !== "string" || !cursor.book_snapshot_id || cursor.book_snapshot_id.length > 10_000) {
    throw new Error("paper_state_invalid");
  }
  requiredIso(String(cursor.snapshot_fetched_at), "paper_state_invalid");
  requiredIso(String(cursor.updated_at), "paper_state_invalid");
  if (cursor.max_trade_time != null && (!Number.isFinite(cursor.max_trade_time) || Number(cursor.max_trade_time) <= 0)) {
    throw new Error("paper_state_invalid");
  }
  if (!Array.isArray(cursor.max_trade_keys) || cursor.max_trade_keys.length > MAX_MARKET_TRADES || cursor.max_trade_keys.some((key) => (
    typeof key !== "string" || !key || key.length > 500
  ))) throw new Error("paper_state_invalid");
  assertUnique(cursor.max_trade_keys as string[]);
  if (cursor.max_trade_time == null && cursor.max_trade_keys.length > 0) throw new Error("paper_state_invalid");
}

function sequenceId(kind: "order" | "fill" | "journal", sequence: number) {
  return `${ID_PREFIX}-${kind}-${String(sequence).padStart(8, "0")}`;
}

function trimRecords<T>(values: T[]): T[] {
  return values.slice(0, MAX_RECORDS);
}

function retainPaperHistory(orders: PaperOrder[], fills: PaperFill[]) {
  if (orders.length <= MAX_RECORDS && fills.length <= MAX_RECORDS) return { orders, fills };

  const ordersById = new Map(orders.map((order) => [order.order_id, order]));
  const adjacentOrderIds = new Map<string, Set<string>>();
  const connect = (left: string, right: string | null) => {
    if (!right || !ordersById.has(right)) return;
    const leftEdges = adjacentOrderIds.get(left) ?? new Set<string>();
    const rightEdges = adjacentOrderIds.get(right) ?? new Set<string>();
    leftEdges.add(right);
    rightEdges.add(left);
    adjacentOrderIds.set(left, leftEdges);
    adjacentOrderIds.set(right, rightEdges);
  };
  for (const order of orders) {
    connect(order.order_id, order.parent_order_id);
    connect(order.order_id, order.oco_sibling_order_id);
    connect(order.order_id, order.replaces_order_id);
    connect(order.order_id, order.replaced_by_order_id);
  }

  const componentByOrderId = new Map<string, number>();
  const components: PaperOrder[][] = [];
  for (const order of orders) {
    if (componentByOrderId.has(order.order_id)) continue;
    const componentIndex = components.length;
    const component: PaperOrder[] = [];
    const pending = [order.order_id];
    while (pending.length) {
      const orderId = pending.pop() as string;
      if (componentByOrderId.has(orderId)) continue;
      const member = ordersById.get(orderId);
      if (!member) continue;
      componentByOrderId.set(orderId, componentIndex);
      component.push(member);
      for (const adjacent of adjacentOrderIds.get(orderId) ?? []) pending.push(adjacent);
    }
    components.push(component);
  }

  const fillsByOrderId = new Map<string, PaperFill[]>();
  for (const fill of fills) {
    const current = fillsByOrderId.get(fill.order_id) ?? [];
    current.push(fill);
    fillsByOrderId.set(fill.order_id, current);
  }
  const componentRequiredFillIds = components.map((component) => new Set(component.flatMap((order) => (
    order.filled_base_size > 1e-12 && order.fill_id ? [order.fill_id] : []
  ))));
  const componentNewestFillSequence = components.map((component) => Math.max(0, ...component.flatMap((order) => (
    fillsByOrderId.get(order.order_id)?.map((fill) => paperRecordSequence(fill.fill_id)) ?? []
  ))));
  const componentNewestOrderSequence = components.map((component) => Math.max(...component.map((order) => paperRecordSequence(order.order_id))));
  const activeComponents = components
    .map((component, index) => ({ component, index }))
    .filter(({ component }) => component.some((order) => order.status === "pending"));
  const activeOrderCount = activeComponents.reduce((total, { component }) => total + component.length, 0);
  const activeFillCount = activeComponents.reduce((total, { index }) => total + componentRequiredFillIds[index].size, 0);
  if (activeOrderCount > MAX_RECORDS || activeFillCount > MAX_RECORDS) throw new Error("paper_history_capacity_exceeded");

  const selectedComponentIndexes = new Set(activeComponents.map(({ index }) => index));
  let selectedOrderCount = activeOrderCount;
  let requiredFillCount = activeFillCount;
  const candidates = components
    .map((component, index) => ({ component, index }))
    .filter(({ index }) => !selectedComponentIndexes.has(index))
    .sort((left, right) => {
      const leftHasFills = componentNewestFillSequence[left.index] > 0;
      const rightHasFills = componentNewestFillSequence[right.index] > 0;
      if (leftHasFills !== rightHasFills) return leftHasFills ? -1 : 1;
      return componentNewestFillSequence[right.index] - componentNewestFillSequence[left.index]
        || componentNewestOrderSequence[right.index] - componentNewestOrderSequence[left.index];
    });
  for (const { component, index } of candidates) {
    const componentFillCount = componentRequiredFillIds[index].size;
    if (selectedOrderCount + component.length > MAX_RECORDS || requiredFillCount + componentFillCount > MAX_RECORDS) continue;
    selectedComponentIndexes.add(index);
    selectedOrderCount += component.length;
    requiredFillCount += componentFillCount;
  }

  const selectedOrderIds = new Set<string>();
  const selectedFillIds = new Set<string>();
  for (const componentIndex of selectedComponentIndexes) {
    for (const order of components[componentIndex]) selectedOrderIds.add(order.order_id);
    for (const fillId of componentRequiredFillIds[componentIndex]) selectedFillIds.add(fillId);
  }
  for (const fill of fills) {
    if (selectedFillIds.size >= MAX_RECORDS) break;
    if (selectedOrderIds.has(fill.order_id)) selectedFillIds.add(fill.fill_id);
  }
  return {
    orders: orders.filter((order) => selectedOrderIds.has(order.order_id)),
    fills: fills.filter((fill) => selectedFillIds.has(fill.fill_id)),
  };
}

function paperOrderMatchesScope(order: PaperOrder, scope: Partial<Pick<PaperOrder, "venue_id" | "network" | "product">>) {
  return (scope.venue_id == null || order.venue_id === safeLabel(scope.venue_id, "paper_cancel_scope_invalid"))
    && (scope.network == null || order.network === safeLabel(scope.network, "paper_cancel_scope_invalid"))
    && (scope.product == null || order.product === safeProduct(scope.product));
}

function paperScopeMessage(scope: Partial<Pick<PaperOrder, "venue_id" | "network" | "product">>) {
  const values = [scope.venue_id, scope.network, scope.product].filter((value): value is string => Boolean(value));
  return values.length ? ` · scope ${values.join("/")}` : "";
}

function paperCancelReasonMessage(reason: Exclude<PaperOrderCancelReason, null>) {
  const messages: Record<Exclude<PaperOrderCancelReason, null>, string> = {
    user_cancelled: "cancelled by trader",
    cancel_all: "cancel-all requested",
    ioc_not_marketable: "IOC had no executable displayed liquidity",
    ioc_remainder_cancelled: "IOC unfilled remainder cancelled",
    fok_not_fillable: "FOK could not fill entirely from displayed liquidity",
    risk_control: "local PAPER risk control stopped the order",
    oco_sibling: "simulated OCO sibling completed",
    position_unavailable: "reduce-only position was unavailable",
  };
  return messages[reason];
}

function formatOrderPrice(order: Pick<PaperOrder, "order_type" | "limit_price" | "stop_price" | "trail_offset_bps">) {
  if (order.order_type === "market") return "market";
  if (order.order_type === "trailing_stop") return `${formatNumber(order.trail_offset_bps as number)} bps trail`;
  if (order.order_type === "stop_limit") return `stop ${formatNumber(order.stop_price as number)} / limit ${formatNumber(order.limit_price as number)}`;
  return formatNumber((order.order_type === "stop" ? order.stop_price : order.limit_price) as number);
}

function formatNumber(value: number) {
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/\.?0+$/g, "");
}

function formatQuantity(value: number) {
  return value.toFixed(8).replace(/\.?0+$/g, "");
}

function formatUsdForMessage(value: number) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
