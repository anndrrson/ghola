"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import {
  createCrossVenueLiveMarket,
  initialCrossVenueLiveMarketState,
  type CrossVenueLiveMarketOptions,
  type CrossVenueLiveMarketState,
} from "./cross-venue-live-market";
import {
  createLiveMarketSelectionToken,
  liveMarketStateForSelection,
} from "./live-market-react-priority";

export type UseCrossVenueLiveMarketOptions = Omit<CrossVenueLiveMarketOptions, "onState">;

export function useCrossVenueLiveMarket(
  options: UseCrossVenueLiveMarketOptions,
): CrossVenueLiveMarketState {
  const {
    createMarket,
    currentVenue,
    enabled,
    fetchImpl,
    fetchTimeoutMs,
    hyperliquidNetwork,
    interval,
    isDocumentHidden,
    market,
    now,
    publishCadenceMs,
  } = options;
  const selectionKey = `${currentVenue}:${market.trim().toUpperCase()}:${interval}:${hyperliquidNetwork ?? "mainnet"}:${enabled !== false}`;
  const selectionToken = useMemo(
    () => createLiveMarketSelectionToken(selectionKey),
    [selectionKey],
  );
  const failClosedState = useMemo(
    () => initialCrossVenueLiveMarketState({ currentVenue, market, interval }),
    [currentVenue, interval, market],
  );
  const [snapshot, setSnapshot] = useState<{
    selectionToken: symbol;
    state: CrossVenueLiveMarketState;
  }>(() => ({ selectionToken, state: initialCrossVenueLiveMarketState(options) }));
  const state = liveMarketStateForSelection(snapshot, selectionToken, failClosedState);

  useEffect(() => {
    const controller = createCrossVenueLiveMarket({
      currentVenue,
      market,
      interval,
      hyperliquidNetwork,
      enabled,
      createMarket,
      fetchImpl,
      fetchTimeoutMs,
      isDocumentHidden,
      now,
      publishCadenceMs,
      onState: (nextState) => {
        startTransition(() => setSnapshot({ selectionToken, state: nextState }));
      },
    });
    controller.start();
    return () => controller.stop();
  }, [
    createMarket,
    currentVenue,
    enabled,
    fetchImpl,
    fetchTimeoutMs,
    hyperliquidNetwork,
    interval,
    isDocumentHidden,
    market,
    now,
    publishCadenceMs,
    selectionToken,
  ]);

  return state;
}
