import { sha256 } from "@noble/hashes/sha256";

export const REPLAY_SESSION_STATE_VERSION = 1 as const;
export const REPLAY_SESSION_MODE = "replay_execution_lab" as const;
export const REPLAY_FILL_MODEL = "bar_model" as const;

export const REPLAY_SESSION_LIMITS = Object.freeze({
  candles: 100_000,
  orders: 2_048,
  fills: 2_048,
  positions: 2_048,
  journal: 16_384,
} as const);

export type ReplaySide = "buy" | "sell";
export type ReplayOrderType = "market" | "limit" | "stop" | "stop_limit";
export type ReplayOrderRole = "primary" | "oco_stop" | "oco_target";
export type ReplayOrderStatus = "pending" | "filled" | "cancelled";
export type ReplayOrderCancelReason = "user_cancelled" | "oco_sibling_filled" | "position_unavailable" | null;
export type ReplayFillTrigger = "market_open" | "gap_open" | "bar_touch" | "stop_limit_activation";
export type ReplayJournalEvent =
  | "order_submitted"
  | "order_triggered"
  | "order_filled"
  | "order_cancelled"
  | "position_opened"
  | "position_closed";

export interface ReplayInstrument {
  venue: string;
  product: string;
  interval: string;
}

export interface ReplayCandleInput {
  t: number;
  T?: number | null;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  v?: number | string;
  n?: number | null;
}

export interface ReplayCandle {
  t: number;
  T: number | null;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number | null;
}

export interface ReplaySourceInput {
  source_id: string;
  instrument: ReplayInstrument;
  candles: ReplayCandleInput[];
  fingerprint?: string;
}

export interface ReplaySource {
  readonly source_id: string;
  readonly instrument: Readonly<ReplayInstrument>;
  readonly candles: readonly Readonly<ReplayCandle>[];
  readonly fingerprint: string;
}

export interface ReplayAssumptions {
  starting_equity_usd: number;
  fee_bps: number;
  slippage_bps: number;
}

export interface ReplayAttachedOco {
  stop_price: number;
  target_price: number;
}

export interface ReplayOrderInput {
  type: ReplayOrderType;
  side: ReplaySide;
  size: number;
  limit_price?: number | null;
  stop_price?: number | null;
  reduce_only?: boolean;
  attached_oco?: ReplayAttachedOco | null;
  risk_usd?: number | null;
}

export interface ReplayOrder {
  order_id: string;
  role: ReplayOrderRole;
  parent_order_id: string | null;
  position_id: string | null;
  oco_group_id: string | null;
  type: ReplayOrderType;
  side: ReplaySide;
  size: number;
  filled_size: number;
  reduce_only: boolean;
  limit_price: number | null;
  stop_price: number | null;
  attached_oco: ReplayAttachedOco | null;
  risk_usd: number | null;
  status: ReplayOrderStatus;
  submitted_cursor: number;
  eligible_cursor: number;
  triggered_cursor: number | null;
  filled_cursor: number | null;
  cancelled_cursor: number | null;
  fill_id: string | null;
  cancel_reason: ReplayOrderCancelReason;
}

export interface ReplayFill {
  fill_id: string;
  order_id: string;
  position_ids: string[];
  order_role: ReplayOrderRole;
  side: ReplaySide;
  size: number;
  reference_price: number;
  fill_price: number;
  notional_usd: number;
  fee_usd: number;
  fee_bps: number;
  slippage_bps: number;
  slippage_cost_usd: number;
  realized_pnl_gross_usd: number;
  bar_cursor: number;
  bar_time: number;
  trigger: ReplayFillTrigger;
  execution_model: typeof REPLAY_FILL_MODEL;
}

export interface ReplayPosition {
  position_id: string;
  side: "long" | "short";
  status: "open" | "closed";
  quantity: number;
  average_entry_price: number;
  opened_cursor: number;
  closed_cursor: number | null;
  realized_pnl_gross_usd: number;
  fees_usd: number;
  initial_risk_usd: number | null;
  realized_r: number | null;
  mae_usd: number;
  mfe_usd: number;
}

export interface ReplayJournalEntry {
  journal_id: string;
  event: ReplayJournalEvent;
  cursor: number;
  order_id: string | null;
  fill_id: string | null;
  position_id: string | null;
  message: string;
}

export interface ReplayPerformance {
  mark_price: number;
  realized_pnl_gross_usd: number;
  unrealized_pnl_gross_usd: number;
  fees_usd: number;
  net_pnl_usd: number;
  equity_usd: number;
  realized_r: number | null;
  mae_usd: number;
  mfe_usd: number;
}

export interface ReplaySourceDescriptor {
  source_id: string;
  instrument: ReplayInstrument;
  fingerprint: string;
  candle_count: number;
  first_candle_time: number;
  last_candle_time: number;
}

export interface ReplaySessionState {
  version: typeof REPLAY_SESSION_STATE_VERSION;
  mode: typeof REPLAY_SESSION_MODE;
  revision: number;
  next_sequence: number;
  source: ReplaySourceDescriptor;
  cursor: number;
  assumptions: ReplayAssumptions;
  orders: ReplayOrder[];
  fills: ReplayFill[];
  positions: ReplayPosition[];
  journal: ReplayJournalEntry[];
  performance: ReplayPerformance;
  updated_cursor: number;
}

interface ReplayFillCandidate {
  order_id: string;
  reference_price: number;
  trigger: ReplayFillTrigger;
}

interface OrderEvaluation {
  triggered: boolean;
  candidate: ReplayFillCandidate | null;
}

interface ApplyFillResult {
  positions: ReplayPosition[];
  positionIds: string[];
  openedSize: number;
  openedPositionId: string | null;
  realizedGross: number;
  closedPositionIds: string[];
}

const DEFAULT_ASSUMPTIONS: ReplayAssumptions = {
  starting_equity_usd: 10_000,
  fee_bps: 2.5,
  slippage_bps: 3,
};

const FINGERPRINT_PREFIX = "ghola-replay-fp-v1:";
const MAX_LABEL_LENGTH = 160;
const MAX_PRICE = 1e15;
const MAX_SIZE = 1e15;
const EPSILON = 1e-10;
const trustedReplaySources = new WeakSet<object>();

export function prepareReplaySource(input: ReplaySourceInput | ReplaySource): ReplaySource {
  if (trustedReplaySources.has(input)) return input as ReplaySource;
  const sourceId = safeLabel(input.source_id, "replay_source_id_invalid");
  const instrument = normalizeInstrument(input.instrument);
  if (!Array.isArray(input.candles) || input.candles.length < 1 || input.candles.length > REPLAY_SESSION_LIMITS.candles) {
    throw new Error("replay_source_candles_invalid");
  }
  const candles = input.candles.map((value, index) => normalizeCandle(value, index));
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].t <= candles[index - 1].t) throw new Error("replay_source_time_invalid");
  }
  const fingerprint = fingerprintNormalizedSource(sourceId, instrument, candles);
  if (input.fingerprint != null && input.fingerprint !== fingerprint) {
    throw new Error("replay_source_fingerprint_mismatch");
  }
  const source = Object.freeze({
    source_id: sourceId,
    instrument: Object.freeze(instrument),
    candles: Object.freeze(candles.map((candle) => Object.freeze(candle))),
    fingerprint,
  });
  trustedReplaySources.add(source);
  return source;
}

export function replaySourceFingerprint(input: ReplaySourceInput | ReplaySource): string {
  return prepareReplaySource(input).fingerprint;
}

export function createReplaySession(
  sourceInput: ReplaySourceInput | ReplaySource,
  options: { cursor?: number; assumptions?: Partial<ReplayAssumptions> } = {},
): ReplaySessionState {
  const source = prepareReplaySource(sourceInput);
  const cursor = validCursor(options.cursor ?? 0, source.candles.length);
  const assumptions = normalizeAssumptions({ ...DEFAULT_ASSUMPTIONS, ...options.assumptions });
  const state: ReplaySessionState = {
    version: REPLAY_SESSION_STATE_VERSION,
    mode: REPLAY_SESSION_MODE,
    revision: 0,
    next_sequence: 1,
    source: sourceDescriptor(source),
    cursor,
    assumptions,
    orders: [],
    fills: [],
    positions: [],
    journal: [],
    performance: derivePerformance([], [], source.candles[cursor].c, assumptions),
    updated_cursor: cursor,
  };
  assertReplaySessionState(state);
  return state;
}

export function submitReplayOrder(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  input: ReplayOrderInput,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  if (state.cursor >= source.candles.length - 1) throw new Error("replay_order_has_no_future_candle");
  const normalized = normalizeOrderInput(input);
  const reserved = reservedOrderSlots(state.orders);
  const needed = normalized.attached_oco ? 3 : 1;
  if (reserved + needed > REPLAY_SESSION_LIMITS.orders) throw new Error("replay_order_capacity_exceeded");

  let sequence = state.next_sequence;
  const orderId = sequenceId("order", sequence++);
  const order: ReplayOrder = {
    order_id: orderId,
    role: "primary",
    parent_order_id: null,
    position_id: null,
    oco_group_id: null,
    type: normalized.type,
    side: normalized.side,
    size: normalized.size,
    filled_size: 0,
    reduce_only: normalized.reduce_only,
    limit_price: normalized.limit_price,
    stop_price: normalized.stop_price,
    attached_oco: normalized.attached_oco,
    risk_usd: normalized.risk_usd,
    status: "pending",
    submitted_cursor: state.cursor,
    eligible_cursor: state.cursor + 1,
    triggered_cursor: null,
    filled_cursor: null,
    cancelled_cursor: null,
    fill_id: null,
    cancel_reason: null,
  };
  const journal = appendJournal(state.journal, {
    journal_id: sequenceId("journal", sequence++),
    event: "order_submitted",
    cursor: state.cursor,
    order_id: orderId,
    fill_id: null,
    position_id: null,
    message: `${normalized.side} ${normalized.type} ${formatNumber(normalized.size)} submitted; eligible at candle ${state.cursor + 1}`,
  });
  return checkedNextState(state, {
    next_sequence: sequence,
    orders: [...state.orders, order],
    journal,
  });
}

export function cancelReplayOrder(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  orderId: string,
): ReplaySessionState {
  assertReplaySessionState(state);
  assertMatchingSource(state, sourceInput);
  const index = state.orders.findIndex((order) => order.order_id === orderId);
  if (index < 0) throw new Error("replay_order_not_found");
  if (state.orders[index].status !== "pending") throw new Error("replay_order_not_pending");
  let sequence = state.next_sequence;
  const orders = state.orders.slice();
  orders[index] = {
    ...orders[index],
    status: "cancelled",
    cancelled_cursor: state.cursor,
    cancel_reason: "user_cancelled",
  };
  const journal = appendJournal(state.journal, {
    journal_id: sequenceId("journal", sequence++),
    event: "order_cancelled",
    cursor: state.cursor,
    order_id: orderId,
    fill_id: null,
    position_id: orders[index].position_id,
    message: "Order cancelled by replay user",
  });
  return checkedNextState(state, { next_sequence: sequence, orders, journal });
}

export function stepReplaySession(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  if (state.cursor >= source.candles.length - 1) return state;
  return processReplayCandle(state, source, state.cursor + 1);
}

export function advanceReplaySession(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  targetCursor: number,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  const target = validCursor(targetCursor, source.candles.length);
  if (target < state.cursor) return seekReplaySession(state, source, target);
  let next = state;
  while (next.cursor < target) next = processReplayCandle(next, source, next.cursor + 1);
  return next;
}

export function seekReplaySession(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  targetCursor: number,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  const target = validCursor(targetCursor, source.candles.length);
  if (target === state.cursor) return state;
  if (target > state.cursor) return advanceReplaySession(state, source, target);
  if (hasReplayAction(state)) throw new Error("replay_backward_seek_requires_fork_or_reset");
  return checkedNextState(state, {
    cursor: target,
    updated_cursor: target,
    performance: derivePerformance(state.positions, state.fills, source.candles[target].c, state.assumptions),
  });
}

export function resetReplaySession(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  cursor = 0,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  return createReplaySession(source, { cursor, assumptions: state.assumptions });
}

export function forkReplaySession(
  state: ReplaySessionState,
  sourceInput: ReplaySourceInput | ReplaySource,
  cursor = state.cursor,
): ReplaySessionState {
  assertReplaySessionState(state);
  const source = assertMatchingSource(state, sourceInput);
  return createReplaySession(source, { cursor, assumptions: state.assumptions });
}

export function replayPerformance(state: ReplaySessionState): ReplayPerformance {
  assertReplaySessionState(state);
  return { ...state.performance };
}

export function serializeReplaySession(state: ReplaySessionState): string {
  assertReplaySessionState(state);
  return canonicalJson(state);
}

export const exportReplaySession = serializeReplaySession;

export function parseReplaySession(value: string | null | undefined): ReplaySessionState | null {
  if (!value || value.length > 20_000_000) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    assertReplaySessionState(parsed);
    return parsed;
  } catch {
    return null;
  }
}

function processReplayCandle(state: ReplaySessionState, source: ReplaySource, cursor: number): ReplaySessionState {
  if (cursor !== state.cursor + 1) throw new Error("replay_step_not_contiguous");
  const bar = source.candles[cursor];
  const orders = state.orders.slice();
  let positions = state.positions.map((position) => ({ ...position }));
  const fills = state.fills.slice();
  let journal = state.journal.slice();
  let sequence = state.next_sequence;

  const allocateId = (kind: "order" | "fill" | "position" | "journal" | "oco") => sequenceId(kind, sequence++);
  const updateOrder = (next: ReplayOrder) => {
    const index = orders.findIndex((order) => order.order_id === next.order_id);
    if (index < 0) throw new Error("replay_state_invalid");
    orders[index] = next;
  };
  const record = (entry: Omit<ReplayJournalEntry, "journal_id">) => {
    journal = appendJournal(journal, { ...entry, journal_id: allocateId("journal") });
  };

  const candidates: ReplayFillCandidate[] = [];
  for (const order of orders) {
    if (order.status !== "pending" || order.eligible_cursor > cursor) continue;
    const evaluation = evaluateOrder(order, bar);
    if (evaluation.triggered && order.triggered_cursor == null) {
      updateOrder({ ...order, triggered_cursor: cursor });
      record({
        event: "order_triggered",
        cursor,
        order_id: order.order_id,
        fill_id: null,
        position_id: order.position_id,
        message: "Stop-limit activated by bar model",
      });
    }
    if (evaluation.candidate) candidates.push(evaluation.candidate);
  }

  candidates.sort((left, right) => {
    const a = orders.find((order) => order.order_id === left.order_id)!;
    const b = orders.find((order) => order.order_id === right.order_id)!;
    return candidatePriority(a) - candidatePriority(b) || a.order_id.localeCompare(b.order_id);
  });

  for (const candidate of candidates) {
    const orderIndex = orders.findIndex((value) => value.order_id === candidate.order_id);
    const order = orders[orderIndex];
    if (!order || order.status !== "pending") continue;
    if (fills.length >= REPLAY_SESSION_LIMITS.fills) throw new Error("replay_fill_capacity_exceeded");

    const executableSize = order.reduce_only ? reduceOnlySize(order, positions) : order.size;
    if (executableSize <= EPSILON) {
      const cancelled = cancelAtCursor(order, cursor, "position_unavailable");
      updateOrder(cancelled);
      record({
        event: "order_cancelled",
        cursor,
        order_id: order.order_id,
        fill_id: null,
        position_id: order.position_id,
        message: "Reduce-only order cancelled because its position is unavailable",
      });
      continue;
    }

    const fillPrice = modeledFillPrice(order, candidate.reference_price, state.assumptions.slippage_bps);
    const fee = money(executableSize * fillPrice * state.assumptions.fee_bps / 10_000);
    const fillId = allocateId("fill");
    const applied = applyFillToPositions({
      positions,
      order,
      size: executableSize,
      fillPrice,
      fee,
      cursor,
      allocatePositionId: () => allocateId("position"),
    });
    positions = applied.positions;
    const fill: ReplayFill = {
      fill_id: fillId,
      order_id: order.order_id,
      position_ids: applied.positionIds,
      order_role: order.role,
      side: order.side,
      size: clean(executableSize),
      reference_price: clean(candidate.reference_price),
      fill_price: fillPrice,
      notional_usd: money(executableSize * fillPrice),
      fee_usd: fee,
      fee_bps: state.assumptions.fee_bps,
      slippage_bps: state.assumptions.slippage_bps,
      slippage_cost_usd: money(Math.abs(fillPrice - candidate.reference_price) * executableSize),
      realized_pnl_gross_usd: money(applied.realizedGross),
      bar_cursor: cursor,
      bar_time: bar.t,
      trigger: candidate.trigger,
      execution_model: REPLAY_FILL_MODEL,
    };
    fills.push(fill);
    updateOrder({
      ...orders[orderIndex],
      status: "filled",
      filled_size: clean(executableSize),
      filled_cursor: cursor,
      fill_id: fillId,
    });
    record({
      event: "order_filled",
      cursor,
      order_id: order.order_id,
      fill_id: fillId,
      position_id: applied.positionIds[0] ?? null,
      message: `${formatNumber(executableSize)} filled by ${REPLAY_FILL_MODEL} at ${formatNumber(fillPrice)}`,
    });

    for (const positionId of applied.closedPositionIds) {
      record({
        event: "position_closed",
        cursor,
        order_id: order.order_id,
        fill_id: fillId,
        position_id: positionId,
        message: "Replay position closed",
      });
    }
    if (applied.openedPositionId) {
      const opened = positions.find((position) => position.position_id === applied.openedPositionId);
      if (opened?.opened_cursor === cursor && Math.abs(opened.quantity) === applied.openedSize) {
        record({
          event: "position_opened",
          cursor,
          order_id: order.order_id,
          fill_id: fillId,
          position_id: applied.openedPositionId,
          message: `Replay ${opened.side} position opened`,
        });
      }
    }

    if (order.attached_oco && applied.openedSize > EPSILON && applied.openedPositionId) {
      if (orders.length + 2 > REPLAY_SESSION_LIMITS.orders) throw new Error("replay_order_capacity_exceeded");
      const groupId = allocateId("oco");
      const exitSide: ReplaySide = order.side === "buy" ? "sell" : "buy";
      const stopOrder = bracketOrder({
        orderId: allocateId("order"),
        parent: order,
        positionId: applied.openedPositionId,
        groupId,
        role: "oco_stop",
        type: "stop",
        side: exitSide,
        size: applied.openedSize,
        stopPrice: order.attached_oco.stop_price,
        limitPrice: null,
        cursor,
      });
      const targetOrder = bracketOrder({
        orderId: allocateId("order"),
        parent: order,
        positionId: applied.openedPositionId,
        groupId,
        role: "oco_target",
        type: "limit",
        side: exitSide,
        size: applied.openedSize,
        stopPrice: null,
        limitPrice: order.attached_oco.target_price,
        cursor,
      });
      orders.push(stopOrder, targetOrder);
      for (const child of [stopOrder, targetOrder]) {
        record({
          event: "order_submitted",
          cursor,
          order_id: child.order_id,
          fill_id: null,
          position_id: child.position_id,
          message: `${child.role} created; eligible at candle ${child.eligible_cursor}`,
        });
      }
    }

    if (order.oco_group_id) {
      for (const sibling of orders) {
        if (sibling.order_id === order.order_id || sibling.oco_group_id !== order.oco_group_id || sibling.status !== "pending") continue;
        const cancelled = cancelAtCursor(sibling, cursor, "oco_sibling_filled");
        updateOrder(cancelled);
        record({
          event: "order_cancelled",
          cursor,
          order_id: sibling.order_id,
          fill_id: null,
          position_id: sibling.position_id,
          message: "OCO sibling cancelled after adverse-priority fill resolution",
        });
      }
    }

    for (const positionId of applied.closedPositionIds) {
      for (const linked of orders) {
        if (linked.position_id !== positionId || linked.status !== "pending") continue;
        const cancelled = cancelAtCursor(linked, cursor, linked.oco_group_id ? "oco_sibling_filled" : "position_unavailable");
        updateOrder(cancelled);
        record({
          event: "order_cancelled",
          cursor,
          order_id: linked.order_id,
          fill_id: null,
          position_id: positionId,
          message: "Position-linked order cancelled after position close",
        });
      }
    }
  }

  positions = positions.map((position) => position.status === "open" ? withBarExcursion(position, bar) : position);
  positions = positions.map(withRealizedR);
  const performance = derivePerformance(positions, fills, bar.c, state.assumptions);
  return checkedNextState(state, {
    next_sequence: sequence,
    cursor,
    updated_cursor: cursor,
    orders,
    fills,
    positions,
    journal,
    performance,
  });
}

function evaluateOrder(order: ReplayOrder, bar: ReplayCandle): OrderEvaluation {
  if (order.type === "market") {
    return { triggered: false, candidate: candidate(order, bar.o, "market_open") };
  }
  if (order.type === "limit") {
    return { triggered: false, candidate: limitCandidate(order, bar) };
  }
  if (order.type === "stop") {
    return { triggered: false, candidate: stopCandidate(order, bar) };
  }
  if (order.triggered_cursor != null) {
    return { triggered: false, candidate: limitCandidate(order, bar) };
  }

  const stop = order.stop_price!;
  const limit = order.limit_price!;
  const opensTriggered = order.side === "buy" ? bar.o >= stop : bar.o <= stop;
  if (opensTriggered) {
    const marketable = order.side === "buy" ? bar.o <= limit : bar.o >= limit;
    return {
      triggered: true,
      candidate: marketable ? candidate(order, bar.o, "gap_open") : null,
    };
  }
  const touched = order.side === "buy" ? bar.h >= stop : bar.l <= stop;
  if (!touched) return { triggered: false, candidate: null };
  const immediatelyMarketable = order.side === "buy" ? limit >= stop : limit <= stop;
  return {
    triggered: true,
    candidate: immediatelyMarketable ? candidate(order, stop, "stop_limit_activation") : null,
  };
}

function limitCandidate(order: ReplayOrder, bar: ReplayCandle): ReplayFillCandidate | null {
  const limit = order.limit_price!;
  if (order.side === "buy") {
    if (bar.o <= limit) return candidate(order, bar.o, "gap_open");
    return bar.l <= limit ? candidate(order, limit, "bar_touch") : null;
  }
  if (bar.o >= limit) return candidate(order, bar.o, "gap_open");
  return bar.h >= limit ? candidate(order, limit, "bar_touch") : null;
}

function stopCandidate(order: ReplayOrder, bar: ReplayCandle): ReplayFillCandidate | null {
  const stop = order.stop_price!;
  if (order.side === "buy") {
    if (bar.o >= stop) return candidate(order, bar.o, "gap_open");
    return bar.h >= stop ? candidate(order, stop, "bar_touch") : null;
  }
  if (bar.o <= stop) return candidate(order, bar.o, "gap_open");
  return bar.l <= stop ? candidate(order, stop, "bar_touch") : null;
}

function candidate(order: ReplayOrder, referencePrice: number, trigger: ReplayFillTrigger): ReplayFillCandidate {
  return { order_id: order.order_id, reference_price: referencePrice, trigger };
}

function modeledFillPrice(order: ReplayOrder, referencePrice: number, slippageBps: number): number {
  const multiplier = order.side === "buy" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  let price = referencePrice * multiplier;
  if ((order.type === "limit" || order.type === "stop_limit") && order.limit_price != null) {
    price = order.side === "buy" ? Math.min(price, order.limit_price) : Math.max(price, order.limit_price);
  }
  return priceNumber(price, "replay_fill_price_invalid");
}

function applyFillToPositions(input: {
  positions: ReplayPosition[];
  order: ReplayOrder;
  size: number;
  fillPrice: number;
  fee: number;
  cursor: number;
  allocatePositionId: () => string;
}): ApplyFillResult {
  const positions = input.positions.map((position) => ({ ...position }));
  const signedFill = input.order.side === "buy" ? input.size : -input.size;
  let remaining = input.size;
  let realizedGross = 0;
  let openedSize = 0;
  let openedPositionId: string | null = null;
  const positionIds: string[] = [];
  const closedPositionIds: string[] = [];
  let activeIndex = positions.findIndex((position) => position.status === "open");

  if (activeIndex >= 0 && Math.sign(positions[activeIndex].quantity) !== Math.sign(signedFill)) {
    let active = withPriceExcursion(positions[activeIndex], input.fillPrice);
    const closingSize = Math.min(Math.abs(active.quantity), remaining);
    const gross = (input.fillPrice - active.average_entry_price) * closingSize * Math.sign(active.quantity);
    const closingFee = input.fee * closingSize / input.size;
    const remainingQuantity = clean(active.quantity + Math.sign(signedFill) * closingSize);
    realizedGross += gross;
    active = withRealizedR({
      ...active,
      quantity: Math.abs(remainingQuantity) <= EPSILON ? 0 : remainingQuantity,
      status: Math.abs(remainingQuantity) <= EPSILON ? "closed" : "open",
      closed_cursor: Math.abs(remainingQuantity) <= EPSILON ? input.cursor : null,
      realized_pnl_gross_usd: money(active.realized_pnl_gross_usd + gross),
      fees_usd: money(active.fees_usd + closingFee),
    });
    positions[activeIndex] = active;
    positionIds.push(active.position_id);
    if (active.status === "closed") closedPositionIds.push(active.position_id);
    remaining = clean(remaining - closingSize);
    if (remaining <= EPSILON) return { positions, positionIds, openedSize, openedPositionId, realizedGross, closedPositionIds };
    activeIndex = -1;
  }

  if (remaining > EPSILON) {
    const openingFee = input.fee * remaining / input.size;
    const risk = orderRiskForOpenedSize(input.order, input.fillPrice, remaining, input.size);
    if (activeIndex >= 0) {
      const active = positions[activeIndex];
      const oldSize = Math.abs(active.quantity);
      const totalSize = oldSize + remaining;
      const nextRisk = addNullable(active.initial_risk_usd, risk);
      positions[activeIndex] = withRealizedR({
        ...active,
        quantity: clean(active.quantity + Math.sign(signedFill) * remaining),
        average_entry_price: priceNumber((active.average_entry_price * oldSize + input.fillPrice * remaining) / totalSize, "replay_position_price_invalid"),
        fees_usd: money(active.fees_usd + openingFee),
        initial_risk_usd: nextRisk,
      });
      openedPositionId = active.position_id;
      positionIds.push(active.position_id);
    } else {
      if (positions.length >= REPLAY_SESSION_LIMITS.positions) throw new Error("replay_position_capacity_exceeded");
      const positionId = input.allocatePositionId();
      const position: ReplayPosition = {
        position_id: positionId,
        side: signedFill > 0 ? "long" : "short",
        status: "open",
        quantity: clean(Math.sign(signedFill) * remaining),
        average_entry_price: input.fillPrice,
        opened_cursor: input.cursor,
        closed_cursor: null,
        realized_pnl_gross_usd: 0,
        fees_usd: money(openingFee),
        initial_risk_usd: risk,
        realized_r: null,
        mae_usd: 0,
        mfe_usd: 0,
      };
      positions.push(position);
      openedPositionId = positionId;
      positionIds.push(positionId);
    }
    openedSize = remaining;
  }
  return {
    positions,
    positionIds: [...new Set(positionIds)],
    openedSize,
    openedPositionId,
    realizedGross,
    closedPositionIds,
  };
}

function withBarExcursion(position: ReplayPosition, bar: ReplayCandle): ReplayPosition {
  const size = Math.abs(position.quantity);
  const adverse = position.quantity > 0
    ? Math.max(0, (position.average_entry_price - bar.l) * size)
    : Math.max(0, (bar.h - position.average_entry_price) * size);
  const favorable = position.quantity > 0
    ? Math.max(0, (bar.h - position.average_entry_price) * size)
    : Math.max(0, (position.average_entry_price - bar.l) * size);
  return {
    ...position,
    mae_usd: money(Math.max(position.mae_usd, adverse)),
    mfe_usd: money(Math.max(position.mfe_usd, favorable)),
  };
}

function withPriceExcursion(position: ReplayPosition, price: number): ReplayPosition {
  return withBarExcursion(position, { t: 0, T: null, o: price, h: price, l: price, c: price, v: 0, n: null });
}

function withRealizedR(position: ReplayPosition): ReplayPosition {
  const qualifies = position.status === "closed" || Math.abs(position.realized_pnl_gross_usd) > EPSILON;
  const realizedR = qualifies && position.initial_risk_usd != null
    ? clean((position.realized_pnl_gross_usd - position.fees_usd) / position.initial_risk_usd)
    : null;
  return { ...position, realized_r: realizedR };
}

function derivePerformance(
  positions: ReplayPosition[],
  fills: ReplayFill[],
  mark: number,
  assumptions: ReplayAssumptions,
): ReplayPerformance {
  const realizedGross = money(positions.reduce((total, position) => total + position.realized_pnl_gross_usd, 0));
  const fees = money(fills.reduce((total, fill) => total + fill.fee_usd, 0));
  const unrealized = money(positions.reduce((total, position) => {
    if (position.status !== "open") return total;
    return total + (mark - position.average_entry_price) * position.quantity;
  }, 0));
  const riskPositions = positions.filter((position) => position.realized_r != null && position.initial_risk_usd != null);
  const risk = riskPositions.reduce((total, position) => total + position.initial_risk_usd!, 0);
  const riskPnl = riskPositions.reduce((total, position) => total + position.realized_pnl_gross_usd - position.fees_usd, 0);
  const net = money(realizedGross + unrealized - fees);
  return {
    mark_price: mark,
    realized_pnl_gross_usd: realizedGross,
    unrealized_pnl_gross_usd: unrealized,
    fees_usd: fees,
    net_pnl_usd: net,
    equity_usd: money(assumptions.starting_equity_usd + net),
    realized_r: risk > 0 ? clean(riskPnl / risk) : null,
    mae_usd: money(positions.reduce((max, position) => Math.max(max, position.mae_usd), 0)),
    mfe_usd: money(positions.reduce((max, position) => Math.max(max, position.mfe_usd), 0)),
  };
}

function reduceOnlySize(order: ReplayOrder, positions: ReplayPosition[]): number {
  const active = order.position_id
    ? positions.find((position) => position.position_id === order.position_id && position.status === "open")
    : positions.find((position) => position.status === "open");
  if (!active) return 0;
  const reduces = order.side === "sell" ? active.quantity > 0 : active.quantity < 0;
  return reduces ? Math.min(order.size, Math.abs(active.quantity)) : 0;
}

function orderRiskForOpenedSize(order: ReplayOrder, fillPrice: number, openedSize: number, totalFillSize: number): number | null {
  if (order.risk_usd != null) return money(order.risk_usd * openedSize / totalFillSize);
  if (order.attached_oco) return money(Math.abs(fillPrice - order.attached_oco.stop_price) * openedSize);
  return null;
}

function bracketOrder(input: {
  orderId: string;
  parent: ReplayOrder;
  positionId: string;
  groupId: string;
  role: "oco_stop" | "oco_target";
  type: "stop" | "limit";
  side: ReplaySide;
  size: number;
  stopPrice: number | null;
  limitPrice: number | null;
  cursor: number;
}): ReplayOrder {
  return {
    order_id: input.orderId,
    role: input.role,
    parent_order_id: input.parent.order_id,
    position_id: input.positionId,
    oco_group_id: input.groupId,
    type: input.type,
    side: input.side,
    size: clean(input.size),
    filled_size: 0,
    reduce_only: true,
    limit_price: input.limitPrice,
    stop_price: input.stopPrice,
    attached_oco: null,
    risk_usd: null,
    status: "pending",
    submitted_cursor: input.cursor,
    eligible_cursor: input.cursor + 1,
    triggered_cursor: null,
    filled_cursor: null,
    cancelled_cursor: null,
    fill_id: null,
    cancel_reason: null,
  };
}

function cancelAtCursor(order: ReplayOrder, cursor: number, reason: Exclude<ReplayOrderCancelReason, null>): ReplayOrder {
  return { ...order, status: "cancelled", cancelled_cursor: cursor, cancel_reason: reason };
}

function candidatePriority(order: ReplayOrder): number {
  return order.role === "oco_stop" ? 0 : order.role === "oco_target" ? 2 : 1;
}

function normalizeOrderInput(input: ReplayOrderInput): Omit<ReplayOrder, "order_id" | "role" | "parent_order_id" | "position_id" | "oco_group_id" | "filled_size" | "status" | "submitted_cursor" | "eligible_cursor" | "triggered_cursor" | "filled_cursor" | "cancelled_cursor" | "fill_id" | "cancel_reason"> {
  if (!new Set<ReplayOrderType>(["market", "limit", "stop", "stop_limit"]).has(input.type)) throw new Error("replay_order_type_invalid");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("replay_order_side_invalid");
  const size = boundedPositive(input.size, MAX_SIZE, "replay_order_size_invalid");
  const limitPrice = input.type === "limit" || input.type === "stop_limit"
    ? boundedPositive(Number(input.limit_price), MAX_PRICE, "replay_order_limit_invalid")
    : null;
  const stopPrice = input.type === "stop" || input.type === "stop_limit"
    ? boundedPositive(Number(input.stop_price), MAX_PRICE, "replay_order_stop_invalid")
    : null;
  const attached = input.attached_oco == null ? null : normalizeAttachedOco(input.attached_oco, input.side);
  if (input.reduce_only && attached) throw new Error("replay_reduce_only_oco_invalid");
  const risk = input.risk_usd == null ? null : boundedPositive(input.risk_usd, MAX_PRICE, "replay_order_risk_invalid");
  return {
    type: input.type,
    side: input.side,
    size,
    reduce_only: input.reduce_only === true,
    limit_price: limitPrice,
    stop_price: stopPrice,
    attached_oco: attached,
    risk_usd: risk,
  };
}

function normalizeAttachedOco(value: ReplayAttachedOco, side: ReplaySide): ReplayAttachedOco {
  const stop = boundedPositive(value.stop_price, MAX_PRICE, "replay_order_oco_invalid");
  const target = boundedPositive(value.target_price, MAX_PRICE, "replay_order_oco_invalid");
  if ((side === "buy" && stop >= target) || (side === "sell" && stop <= target)) throw new Error("replay_order_oco_invalid");
  return { stop_price: stop, target_price: target };
}

function normalizeAssumptions(value: ReplayAssumptions): ReplayAssumptions {
  return {
    starting_equity_usd: boundedPositive(value.starting_equity_usd, 1e15, "replay_assumptions_invalid"),
    fee_bps: boundedNonnegative(value.fee_bps, 10_000, "replay_assumptions_invalid"),
    slippage_bps: boundedNonnegative(value.slippage_bps, 10_000, "replay_assumptions_invalid"),
  };
}

function normalizeInstrument(value: ReplayInstrument): ReplayInstrument {
  if (!value || typeof value !== "object") throw new Error("replay_instrument_invalid");
  return {
    venue: safeLabel(value.venue, "replay_instrument_invalid"),
    product: safeLabel(value.product, "replay_instrument_invalid"),
    interval: safeLabel(value.interval, "replay_instrument_invalid"),
  };
}

function normalizeCandle(value: ReplayCandleInput, index: number): ReplayCandle {
  if (!value || typeof value !== "object") throw new Error("replay_source_candle_invalid");
  const t = nonnegativeInteger(value.t, "replay_source_time_invalid");
  const T = value.T == null ? null : nonnegativeInteger(value.T, "replay_source_time_invalid");
  if (T != null && T < t) throw new Error("replay_source_time_invalid");
  const o = boundedPositive(Number(value.o), MAX_PRICE, "replay_source_price_invalid");
  const h = boundedPositive(Number(value.h), MAX_PRICE, "replay_source_price_invalid");
  const l = boundedPositive(Number(value.l), MAX_PRICE, "replay_source_price_invalid");
  const c = boundedPositive(Number(value.c), MAX_PRICE, "replay_source_price_invalid");
  if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) throw new Error(`replay_source_ohlc_invalid:${index}`);
  const v = value.v == null ? 0 : boundedNonnegative(Number(value.v), MAX_SIZE, "replay_source_volume_invalid");
  const n = value.n == null ? null : nonnegativeInteger(value.n, "replay_source_trade_count_invalid");
  return { t, T, o, h, l, c, v, n };
}

function fingerprintNormalizedSource(sourceId: string, instrument: ReplayInstrument, candles: readonly ReplayCandle[]): string {
  const canonical = canonicalJson({ source_id: sourceId, instrument, candles });
  const digest = sha256(new TextEncoder().encode(canonical));
  return FINGERPRINT_PREFIX + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceDescriptor(source: ReplaySource): ReplaySourceDescriptor {
  return {
    source_id: source.source_id,
    instrument: { ...source.instrument },
    fingerprint: source.fingerprint,
    candle_count: source.candles.length,
    first_candle_time: source.candles[0].t,
    last_candle_time: source.candles[source.candles.length - 1].t,
  };
}

function assertMatchingSource(state: ReplaySessionState, input: ReplaySourceInput | ReplaySource): ReplaySource {
  const source = prepareReplaySource(input);
  const descriptor = sourceDescriptor(source);
  if (canonicalJson(descriptor) !== canonicalJson(state.source)) throw new Error("replay_source_fingerprint_mismatch");
  if (state.performance.mark_price !== source.candles[state.cursor].c) throw new Error("replay_state_source_cursor_mismatch");
  return source;
}

function checkedNextState(state: ReplaySessionState, patch: Partial<ReplaySessionState>): ReplaySessionState {
  const next: ReplaySessionState = {
    ...state,
    ...patch,
    version: REPLAY_SESSION_STATE_VERSION,
    mode: REPLAY_SESSION_MODE,
    revision: state.revision + 1,
  };
  assertReplaySessionState(next);
  return next;
}

function assertReplaySessionState(value: unknown): asserts value is ReplaySessionState {
  const state = objectValue(value);
  if (!state || state.version !== REPLAY_SESSION_STATE_VERSION || state.mode !== REPLAY_SESSION_MODE) throw new Error("replay_state_invalid");
  if (!isNonnegativeInteger(state.revision) || !Number.isSafeInteger(state.next_sequence) || Number(state.next_sequence) < 1) throw new Error("replay_state_invalid");
  const source = objectValue(state.source);
  if (!source) throw new Error("replay_state_invalid");
  safeLabel(source.source_id, "replay_state_invalid");
  normalizeInstrument(source.instrument as ReplayInstrument);
  if (typeof source.fingerprint !== "string" || !/^ghola-replay-fp-v1:[0-9a-f]{64}$/.test(source.fingerprint)) throw new Error("replay_state_invalid");
  if (!Number.isSafeInteger(source.candle_count) || Number(source.candle_count) < 1 || Number(source.candle_count) > REPLAY_SESSION_LIMITS.candles) throw new Error("replay_state_invalid");
  nonnegativeInteger(source.first_candle_time as number, "replay_state_invalid");
  nonnegativeInteger(source.last_candle_time as number, "replay_state_invalid");
  if (Number(source.last_candle_time) < Number(source.first_candle_time)) throw new Error("replay_state_invalid");
  const cursor = validCursor(state.cursor as number, source.candle_count as number);
  if (state.updated_cursor !== cursor) throw new Error("replay_state_invalid");
  const assumptions = normalizeAssumptions(state.assumptions as ReplayAssumptions);
  if (!Array.isArray(state.orders) || state.orders.length > REPLAY_SESSION_LIMITS.orders) throw new Error("replay_state_invalid");
  if (!Array.isArray(state.fills) || state.fills.length > REPLAY_SESSION_LIMITS.fills) throw new Error("replay_state_invalid");
  if (!Array.isArray(state.positions) || state.positions.length > REPLAY_SESSION_LIMITS.positions) throw new Error("replay_state_invalid");
  if (!Array.isArray(state.journal) || state.journal.length > REPLAY_SESSION_LIMITS.journal) throw new Error("replay_state_invalid");
  const orders = state.orders as ReplayOrder[];
  const fills = state.fills as ReplayFill[];
  const positions = state.positions as ReplayPosition[];
  const journal = state.journal as ReplayJournalEntry[];
  assertUnique(orders.map((order) => order.order_id));
  assertUnique(fills.map((fill) => fill.fill_id));
  assertUnique(positions.map((position) => position.position_id));
  assertUnique(journal.map((entry) => entry.journal_id));
  orders.forEach((order) => validateOrder(order, cursor));
  const orderIds = new Set(orders.map((order) => order.order_id));
  const positionIds = new Set(positions.map((position) => position.position_id));
  const fillsById = new Map(fills.map((fill) => [fill.fill_id, fill]));
  fills.forEach((fill) => validateFill(fill, cursor, orderIds, positionIds, assumptions));
  validateOrderFillGraph(orders, fills, fillsById, positionIds);
  validateOcoGraph(orders, orderIds, positionIds);
  positions.forEach((position) => validatePosition(position, cursor));
  if (positions.filter((position) => position.status === "open").length > 1) throw new Error("replay_state_invalid");
  const fillIds = new Set(fills.map((fill) => fill.fill_id));
  journal.forEach((entry) => validateJournal(entry, cursor, orderIds, fillIds, positionIds));
  const performance = state.performance as ReplayPerformance;
  validatePerformance(performance);
  const expected = derivePerformance(positions, fills, performance.mark_price, assumptions);
  if (canonicalJson(expected) !== canonicalJson(performance)) throw new Error("replay_state_invalid");
  const recordIds = [
    ...orders.flatMap((order) => [order.order_id, order.oco_group_id].filter((id): id is string => id != null)),
    ...fills.map((fill) => fill.fill_id),
    ...positions.map((position) => position.position_id),
    ...journal.map((entry) => entry.journal_id),
  ];
  const highWater = recordIds.reduce((max, id) => Math.max(max, sequenceNumber(id)), 0);
  if (Number(state.next_sequence) <= highWater) throw new Error("replay_state_invalid");
}

function validateOrder(order: ReplayOrder, cursor: number) {
  if (!objectValue(order) || !isSequenceId(order.order_id, "order")) throw new Error("replay_state_invalid");
  if (!new Set<ReplayOrderRole>(["primary", "oco_stop", "oco_target"]).has(order.role)) throw new Error("replay_state_invalid");
  if (!new Set<ReplayOrderType>(["market", "limit", "stop", "stop_limit"]).has(order.type)) throw new Error("replay_state_invalid");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("replay_state_invalid");
  boundedPositive(order.size, MAX_SIZE, "replay_state_invalid");
  boundedNonnegative(order.filled_size, order.size, "replay_state_invalid");
  if (order.type === "limit" || order.type === "stop_limit") boundedPositive(order.limit_price as number, MAX_PRICE, "replay_state_invalid");
  else if (order.limit_price !== null) throw new Error("replay_state_invalid");
  if (order.type === "stop" || order.type === "stop_limit") boundedPositive(order.stop_price as number, MAX_PRICE, "replay_state_invalid");
  else if (order.stop_price !== null) throw new Error("replay_state_invalid");
  if (order.attached_oco) normalizeAttachedOco(order.attached_oco, order.side);
  if (order.risk_usd != null) boundedPositive(order.risk_usd, MAX_PRICE, "replay_state_invalid");
  if (!new Set<ReplayOrderStatus>(["pending", "filled", "cancelled"]).has(order.status)) throw new Error("replay_state_invalid");
  const submitted = nonnegativeInteger(order.submitted_cursor, "replay_state_invalid");
  if (submitted > cursor || order.eligible_cursor !== submitted + 1) throw new Error("replay_state_invalid");
  nullableCursor(order.triggered_cursor, cursor);
  nullableCursor(order.filled_cursor, cursor);
  nullableCursor(order.cancelled_cursor, cursor);
  if (order.status === "pending" && (order.fill_id != null || order.filled_cursor != null || order.cancelled_cursor != null || order.cancel_reason != null || order.filled_size !== 0)) throw new Error("replay_state_invalid");
  if (order.status === "filled" && (!isSequenceId(order.fill_id, "fill") || order.filled_cursor == null || order.cancelled_cursor != null || order.cancel_reason != null || order.filled_size <= 0)) throw new Error("replay_state_invalid");
  if (order.status === "cancelled" && (order.cancelled_cursor == null || order.fill_id != null || order.filled_cursor != null || order.cancel_reason == null || order.filled_size !== 0)) throw new Error("replay_state_invalid");
  if (order.type !== "stop_limit" && order.triggered_cursor != null) throw new Error("replay_state_invalid");
  if (order.role !== "primary") {
    if (!order.reduce_only || !isSequenceId(order.parent_order_id, "order") || !isSequenceId(order.oco_group_id, "oco") || !isSequenceId(order.position_id, "position") || order.attached_oco != null) throw new Error("replay_state_invalid");
  } else if (order.parent_order_id != null || order.position_id != null || order.oco_group_id != null) throw new Error("replay_state_invalid");
}

function validateFill(
  fill: ReplayFill,
  cursor: number,
  orderIds: Set<string>,
  positionIds: Set<string>,
  assumptions: ReplayAssumptions,
) {
  if (!objectValue(fill) || !isSequenceId(fill.fill_id, "fill") || !orderIds.has(fill.order_id)) throw new Error("replay_state_invalid");
  if (!Array.isArray(fill.position_ids) || fill.position_ids.length < 1 || new Set(fill.position_ids).size !== fill.position_ids.length || fill.position_ids.some((id) => !positionIds.has(id))) throw new Error("replay_state_invalid");
  if (fill.execution_model !== REPLAY_FILL_MODEL || (fill.side !== "buy" && fill.side !== "sell")) throw new Error("replay_state_invalid");
  boundedPositive(fill.size, MAX_SIZE, "replay_state_invalid");
  boundedPositive(fill.reference_price, MAX_PRICE, "replay_state_invalid");
  boundedPositive(fill.fill_price, MAX_PRICE, "replay_state_invalid");
  boundedPositive(fill.notional_usd, 1e30, "replay_state_invalid");
  boundedNonnegative(fill.fee_usd, 1e30, "replay_state_invalid");
  boundedNonnegative(fill.fee_bps, 10_000, "replay_state_invalid");
  boundedNonnegative(fill.slippage_bps, 10_000, "replay_state_invalid");
  boundedNonnegative(fill.slippage_cost_usd, 1e30, "replay_state_invalid");
  finite(fill.realized_pnl_gross_usd, "replay_state_invalid");
  nullableCursor(fill.bar_cursor, cursor, false);
  nonnegativeInteger(fill.bar_time, "replay_state_invalid");
  if (!new Set<ReplayFillTrigger>(["market_open", "gap_open", "bar_touch", "stop_limit_activation"]).has(fill.trigger)) throw new Error("replay_state_invalid");
  if (fill.notional_usd !== money(fill.size * fill.fill_price)) throw new Error("replay_state_invalid");
  if (fill.fee_bps !== assumptions.fee_bps || fill.slippage_bps !== assumptions.slippage_bps) throw new Error("replay_state_invalid");
  if (fill.fee_usd !== money(fill.notional_usd * fill.fee_bps / 10_000)) throw new Error("replay_state_invalid");
  if (fill.slippage_cost_usd !== money(Math.abs(fill.fill_price - fill.reference_price) * fill.size)) throw new Error("replay_state_invalid");
}

function validateOrderFillGraph(
  orders: ReplayOrder[],
  fills: ReplayFill[],
  fillsById: Map<string, ReplayFill>,
  positionIds: Set<string>,
) {
  const fillsByOrder = new Map<string, ReplayFill[]>();
  for (const fill of fills) fillsByOrder.set(fill.order_id, [...(fillsByOrder.get(fill.order_id) ?? []), fill]);
  for (const order of orders) {
    const linked = fillsByOrder.get(order.order_id) ?? [];
    if (order.status !== "filled") {
      if (linked.length !== 0) throw new Error("replay_state_invalid");
      continue;
    }
    if (linked.length !== 1 || !order.fill_id) throw new Error("replay_state_invalid");
    const fill = fillsById.get(order.fill_id);
    if (!fill || fill !== linked[0]) throw new Error("replay_state_invalid");
    if (fill.side !== order.side || fill.order_role !== order.role || fill.size !== order.filled_size) throw new Error("replay_state_invalid");
    if (fill.position_ids.some((id) => !positionIds.has(id))) throw new Error("replay_state_invalid");
    if (fill.fill_price !== modeledFillPrice(order, fill.reference_price, fill.slippage_bps)) throw new Error("replay_state_invalid");
    if (order.type === "stop_limit" && order.triggered_cursor == null) throw new Error("replay_state_invalid");
    if (order.type === "market" && fill.trigger !== "market_open") throw new Error("replay_state_invalid");
    if (order.type === "limit" && fill.trigger !== "gap_open" && fill.trigger !== "bar_touch") throw new Error("replay_state_invalid");
    if (order.type === "stop" && fill.trigger !== "gap_open" && fill.trigger !== "bar_touch") throw new Error("replay_state_invalid");
  }
}

function validateOcoGraph(orders: ReplayOrder[], orderIds: Set<string>, positionIds: Set<string>) {
  const groups = new Map<string, ReplayOrder[]>();
  for (const order of orders) {
    if (order.parent_order_id != null && !orderIds.has(order.parent_order_id)) throw new Error("replay_state_invalid");
    if (order.position_id != null && !positionIds.has(order.position_id)) throw new Error("replay_state_invalid");
    if (order.oco_group_id) groups.set(order.oco_group_id, [...(groups.get(order.oco_group_id) ?? []), order]);
  }
  for (const children of groups.values()) {
    if (children.length !== 2) throw new Error("replay_state_invalid");
    const stop = children.find((order) => order.role === "oco_stop");
    const target = children.find((order) => order.role === "oco_target");
    if (!stop || !target) throw new Error("replay_state_invalid");
    if (stop.type !== "stop" || target.type !== "limit") throw new Error("replay_state_invalid");
    if (stop.parent_order_id !== target.parent_order_id || stop.position_id !== target.position_id || stop.side !== target.side || stop.size !== target.size) {
      throw new Error("replay_state_invalid");
    }
    const parent = orders.find((order) => order.order_id === stop.parent_order_id);
    if (!parent || parent.status !== "filled" || !parent.attached_oco || parent.side === stop.side) throw new Error("replay_state_invalid");
    if (stop.stop_price !== parent.attached_oco.stop_price || target.limit_price !== parent.attached_oco.target_price) throw new Error("replay_state_invalid");
    if (stop.status === "filled" && target.status !== "cancelled") throw new Error("replay_state_invalid");
    if (target.status === "filled" && stop.status !== "cancelled") throw new Error("replay_state_invalid");
  }
}

function validatePosition(position: ReplayPosition, cursor: number) {
  if (!objectValue(position) || !isSequenceId(position.position_id, "position")) throw new Error("replay_state_invalid");
  if (position.side !== "long" && position.side !== "short") throw new Error("replay_state_invalid");
  if (position.status !== "open" && position.status !== "closed") throw new Error("replay_state_invalid");
  finite(position.quantity, "replay_state_invalid");
  boundedPositive(position.average_entry_price, MAX_PRICE, "replay_state_invalid");
  nullableCursor(position.opened_cursor, cursor, false);
  nullableCursor(position.closed_cursor, cursor);
  finite(position.realized_pnl_gross_usd, "replay_state_invalid");
  boundedNonnegative(position.fees_usd, 1e30, "replay_state_invalid");
  if (position.initial_risk_usd != null) boundedPositive(position.initial_risk_usd, 1e30, "replay_state_invalid");
  if (position.realized_r != null) finite(position.realized_r, "replay_state_invalid");
  boundedNonnegative(position.mae_usd, 1e30, "replay_state_invalid");
  boundedNonnegative(position.mfe_usd, 1e30, "replay_state_invalid");
  if (position.status === "open" && (Math.abs(position.quantity) <= EPSILON || position.closed_cursor != null)) throw new Error("replay_state_invalid");
  if (position.status === "closed" && (position.quantity !== 0 || position.closed_cursor == null)) throw new Error("replay_state_invalid");
  if ((position.side === "long" && position.quantity < 0) || (position.side === "short" && position.quantity > 0)) throw new Error("replay_state_invalid");
  if (canonicalJson(withRealizedR(position)) !== canonicalJson(position)) throw new Error("replay_state_invalid");
}

function validateJournal(entry: ReplayJournalEntry, cursor: number, orderIds: Set<string>, fillIds: Set<string>, positionIds: Set<string>) {
  if (!objectValue(entry) || !isSequenceId(entry.journal_id, "journal")) throw new Error("replay_state_invalid");
  if (!new Set<ReplayJournalEvent>(["order_submitted", "order_triggered", "order_filled", "order_cancelled", "position_opened", "position_closed"]).has(entry.event)) throw new Error("replay_state_invalid");
  nullableCursor(entry.cursor, cursor, false);
  if (entry.order_id != null && !orderIds.has(entry.order_id)) throw new Error("replay_state_invalid");
  if (entry.fill_id != null && !fillIds.has(entry.fill_id)) throw new Error("replay_state_invalid");
  if (entry.position_id != null && !positionIds.has(entry.position_id)) throw new Error("replay_state_invalid");
  safeLabel(entry.message, "replay_state_invalid", 300);
}

function validatePerformance(value: ReplayPerformance) {
  if (!objectValue(value)) throw new Error("replay_state_invalid");
  boundedPositive(value.mark_price, MAX_PRICE, "replay_state_invalid");
  finite(value.realized_pnl_gross_usd, "replay_state_invalid");
  finite(value.unrealized_pnl_gross_usd, "replay_state_invalid");
  boundedNonnegative(value.fees_usd, 1e30, "replay_state_invalid");
  finite(value.net_pnl_usd, "replay_state_invalid");
  finite(value.equity_usd, "replay_state_invalid");
  if (value.realized_r != null) finite(value.realized_r, "replay_state_invalid");
  boundedNonnegative(value.mae_usd, 1e30, "replay_state_invalid");
  boundedNonnegative(value.mfe_usd, 1e30, "replay_state_invalid");
}

function hasReplayAction(state: ReplaySessionState): boolean {
  return state.orders.length > 0 || state.fills.length > 0 || state.journal.length > 0;
}

function reservedOrderSlots(orders: ReplayOrder[]): number {
  return orders.length + orders.reduce((total, order) => total + (order.status === "pending" && order.attached_oco ? 2 : 0), 0);
}

function appendJournal(journal: ReplayJournalEntry[], entry: ReplayJournalEntry): ReplayJournalEntry[] {
  const next = [...journal, entry];
  return next.length > REPLAY_SESSION_LIMITS.journal ? next.slice(next.length - REPLAY_SESSION_LIMITS.journal) : next;
}

function sequenceId(kind: "order" | "fill" | "position" | "journal" | "oco", sequence: number): string {
  return `replay-${kind}-${String(sequence).padStart(8, "0")}`;
}

function isSequenceId(value: unknown, kind: "order" | "fill" | "position" | "journal" | "oco"): value is string {
  if (typeof value !== "string" || !new RegExp(`^replay-${kind}-[0-9]{8,}$`).test(value)) return false;
  const sequence = Number(value.slice(value.lastIndexOf("-") + 1));
  return Number.isSafeInteger(sequence) && sequence > 0;
}

function sequenceNumber(id: string): number {
  const value = Number(id.slice(id.lastIndexOf("-") + 1));
  return Number.isSafeInteger(value) ? value : 0;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return money(left + right);
}

function validCursor(value: number, candleCount: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= candleCount) throw new Error("replay_cursor_invalid");
  return value;
}

function nullableCursor(value: number | null, cursor: number, nullable = true): number | null {
  if (value == null) {
    if (!nullable) throw new Error("replay_state_invalid");
    return null;
  }
  const normalized = nonnegativeInteger(value, "replay_state_invalid");
  if (normalized > cursor) throw new Error("replay_state_invalid");
  return normalized;
}

function boundedPositive(value: number, maximum: number, code: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(code);
  return clean(value);
}

function boundedNonnegative(value: number, maximum: number, code: string): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(code);
  return clean(value);
}

function finite(value: number, code: string): number {
  if (!Number.isFinite(value)) throw new Error(code);
  return clean(value);
}

function nonnegativeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function isNonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeLabel(value: unknown, code: string, maxLength = MAX_LABEL_LENGTH): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(code);
  return normalized;
}

function priceNumber(value: number, code: string): number {
  return boundedPositive(value, MAX_PRICE, code);
}

function money(value: number): number {
  return clean(value, 10);
}

function clean(value: number, decimals = 12): number {
  if (!Number.isFinite(value)) throw new Error("replay_number_invalid");
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(value: number): string {
  return String(clean(value));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertUnique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error("replay_state_invalid");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const object = objectValue(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
}
