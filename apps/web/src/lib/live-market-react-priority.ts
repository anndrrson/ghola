import type { UnifiedLiveMarketState } from "./unified-live-market";

export type LiveMarketReactCommitPriority = "sync" | "transition";

export interface LiveMarketSelectionSnapshot<T> {
  selectionToken: symbol;
  state: T;
}

export function createLiveMarketSelectionToken(selectionKey: string): symbol {
  return Symbol(selectionKey);
}

export function liveMarketStateForSelection<T>(
  snapshot: LiveMarketSelectionSnapshot<T>,
  selectionToken: symbol,
  failClosedState: T,
): T {
  return snapshot.selectionToken === selectionToken ? snapshot.state : failClosedState;
}

export function isCriticalUnifiedMarketTransition(
  previous: UnifiedLiveMarketState,
  next: UnifiedLiveMarketState,
) {
  return previous.status !== next.status ||
    previous.stale !== next.stale ||
    previous.error !== next.error ||
    previous.loading !== next.loading ||
    previous.transport !== next.transport;
}

export function unifiedMarketReactCommitPriority(
  previous: UnifiedLiveMarketState | null,
  next: UnifiedLiveMarketState,
): LiveMarketReactCommitPriority {
  return previous == null || isCriticalUnifiedMarketTransition(previous, next)
    ? "sync"
    : "transition";
}
