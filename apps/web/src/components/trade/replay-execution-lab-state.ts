import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  advanceReplaySession,
  createReplaySession,
  forkReplaySession,
  prepareReplaySource,
  seekReplaySession,
  type ReplayOrderInput,
  type ReplayOrderType,
  type ReplaySessionState,
  type ReplaySide,
  type ReplaySource,
} from "@/lib/terminal-replay-session";

export interface ReplayOrderDraft {
  type: ReplayOrderType;
  side: ReplaySide;
  size: string;
  limitPrice: string;
  stopPrice: string;
  reduceOnly: boolean;
  attachOco: boolean;
  ocoStopPrice: string;
  ocoTargetPrice: string;
  riskUsd: string;
}

export type ReplayCursorSyncEvent = "none" | "advanced" | "seeked" | "forked" | "source_changed";

export interface ReplayCursorSyncResult {
  state: ReplaySessionState;
  event: ReplayCursorSyncEvent;
}

export function boundedReplaySyncTarget(
  currentCursor: number,
  requestedCursor: number,
  maxBarsPerFrame = 128,
) {
  const current = Math.max(0, Math.trunc(currentCursor));
  const requested = Math.max(0, Math.trunc(requestedCursor));
  const budget = Math.max(1, Math.trunc(maxBarsPerFrame));
  return requested <= current ? requested : Math.min(requested, current + budget);
}

export function replaySourceFromFrame(frame: GholaMarketFrame): ReplaySource {
  const first = frame.candles[0]?.t ?? 0;
  const last = frame.candles.at(-1)?.t ?? first;
  return prepareReplaySource({
    source_id: `ghola-chart:${frame.venue}:${frame.product}:${frame.interval}:${first}:${last}:${frame.candles.length}`,
    instrument: {
      venue: frame.venue,
      product: frame.product,
      interval: frame.interval,
    },
    candles: frame.candles,
  });
}

export function syncReplaySessionCursor(
  state: ReplaySessionState,
  source: ReplaySource,
  cursor: number,
): ReplayCursorSyncResult {
  if (state.source.fingerprint !== source.fingerprint) {
    return {
      state: createReplaySession(source, { cursor, assumptions: state.assumptions }),
      event: "source_changed",
    };
  }
  if (cursor === state.cursor) return { state, event: "none" };
  if (cursor > state.cursor) {
    return { state: advanceReplaySession(state, source, cursor), event: "advanced" };
  }
  if (replaySessionHasActions(state)) {
    return { state: forkReplaySession(state, source, cursor), event: "forked" };
  }
  return { state: seekReplaySession(state, source, cursor), event: "seeked" };
}

export function replayOrderInputFromDraft(draft: ReplayOrderDraft): ReplayOrderInput {
  const size = requiredPositive(draft.size, "Size must be greater than zero.");
  const limitPrice = draft.type === "limit" || draft.type === "stop_limit"
    ? requiredPositive(draft.limitPrice, "Enter a valid limit price.")
    : null;
  const stopPrice = draft.type === "stop" || draft.type === "stop_limit"
    ? requiredPositive(draft.stopPrice, "Enter a valid stop trigger.")
    : null;
  if (draft.reduceOnly && draft.attachOco) {
    throw new Error("Reduce-only orders cannot open an attached OCO.");
  }
  const attachedOco = draft.attachOco
    ? {
        stop_price: requiredPositive(draft.ocoStopPrice, "Enter a valid OCO stop."),
        target_price: requiredPositive(draft.ocoTargetPrice, "Enter a valid OCO target."),
      }
    : null;
  if (attachedOco && (
    (draft.side === "buy" && attachedOco.stop_price >= attachedOco.target_price)
    || (draft.side === "sell" && attachedOco.stop_price <= attachedOco.target_price)
  )) {
    throw new Error(draft.side === "buy"
      ? "A buy OCO stop must be below its target."
      : "A sell OCO stop must be above its target.");
  }
  return {
    type: draft.type,
    side: draft.side,
    size,
    limit_price: limitPrice,
    stop_price: stopPrice,
    reduce_only: draft.reduceOnly,
    attached_oco: attachedOco,
    risk_usd: optionalPositive(draft.riskUsd, "Risk must be greater than zero when set."),
  };
}

export function defaultReplayOrderDraft(mark: number, side: ReplaySide = "buy"): ReplayOrderDraft {
  const price = Number.isFinite(mark) && mark > 0 ? mark : 1;
  return {
    type: "market",
    side,
    size: "1",
    limitPrice: formatDraftPrice(price),
    stopPrice: formatDraftPrice(side === "buy" ? price * 1.005 : price * 0.995),
    reduceOnly: false,
    attachOco: false,
    ocoStopPrice: formatDraftPrice(side === "buy" ? price * 0.99 : price * 1.01),
    ocoTargetPrice: formatDraftPrice(side === "buy" ? price * 1.02 : price * 0.98),
    riskUsd: "",
  };
}

export function replaySessionHasActions(state: ReplaySessionState) {
  return state.orders.length > 0 || state.fills.length > 0 || state.positions.length > 0 || state.journal.length > 0;
}

function requiredPositive(value: string, message: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(message);
  return parsed;
}

function optionalPositive(value: string, message: string) {
  if (!value.trim()) return null;
  return requiredPositive(value, message);
}

function formatDraftPrice(value: number) {
  return String(Number(value.toFixed(value >= 1_000 ? 2 : 6)));
}
