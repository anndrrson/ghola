"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import {
  createUnifiedLiveMarket,
  initialUnifiedLiveMarketState,
  type UnifiedLiveMarketOptions,
  type UnifiedLiveMarketState,
} from "./unified-live-market";
import { createBoundedStatePublisher } from "./bounded-state-publisher";
import {
  createLiveMarketSelectionToken,
  isCriticalUnifiedMarketTransition,
  liveMarketStateForSelection,
  unifiedMarketReactCommitPriority,
} from "./live-market-react-priority";

export type UseUnifiedLiveMarketOptions = Omit<UnifiedLiveMarketOptions, "onState"> & {
  publishCadenceMs?: number;
  restartKey?: string | number;
};

export function useUnifiedLiveMarket(
  options: UseUnifiedLiveMarketOptions,
): UnifiedLiveMarketState {
  const {
    createStream,
    fetchImpl,
    fetchTimeoutMs,
    hyperliquidNetwork,
    interval,
    isDocumentHidden,
    market,
    now,
    publishCadenceMs,
    restartKey = 0,
    venue,
  } = options;
  const selectionKey = `${venue}:${market.trim().toUpperCase()}:${interval}:${hyperliquidNetwork ?? "mainnet"}`;
  const selectionToken = useMemo(
    () => createLiveMarketSelectionToken(`${selectionKey}:restart:${String(restartKey)}`),
    [restartKey, selectionKey],
  );
  const failClosedState = initialUnifiedLiveMarketState();
  const [snapshot, setSnapshot] = useState<{
    selectionToken: symbol;
    state: UnifiedLiveMarketState;
  }>(() => ({ selectionToken, state: initialUnifiedLiveMarketState() }));
  const state = liveMarketStateForSelection(snapshot, selectionToken, failClosedState);

  useEffect(() => {
    let previousPublishedState: UnifiedLiveMarketState | null = null;
    const publisher = createBoundedStatePublisher<UnifiedLiveMarketState>({
      cadenceMs: publishCadenceMs ?? 100,
      now,
      onPublish: (nextState) => {
        const priority = unifiedMarketReactCommitPriority(previousPublishedState, nextState);
        previousPublishedState = nextState;
        const commit = () => setSnapshot({ selectionToken, state: nextState });
        if (priority === "transition") startTransition(commit);
        else commit();
      },
      isCritical: isCriticalUnifiedMarketTransition,
    });
    const controller = createUnifiedLiveMarket({
      venue,
      market,
      interval,
      hyperliquidNetwork,
      createStream,
      fetchImpl,
      fetchTimeoutMs,
      isDocumentHidden,
      now,
      onState: (nextState) => publisher.push(nextState),
    });
    controller.start();
    return () => {
      publisher.cancelPending();
      controller.stop();
    };
  }, [
    createStream,
    fetchImpl,
    fetchTimeoutMs,
    hyperliquidNetwork,
    interval,
    isDocumentHidden,
    market,
    now,
    publishCadenceMs,
    selectionToken,
    venue,
  ]);

  return state;
}
