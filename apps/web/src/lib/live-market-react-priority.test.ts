import { describe, expect, it } from "vitest";
import { initialUnifiedLiveMarketState, type UnifiedLiveMarketState } from "./unified-live-market";
import {
  createLiveMarketSelectionToken,
  isCriticalUnifiedMarketTransition,
  liveMarketStateForSelection,
  unifiedMarketReactCommitPriority,
} from "./live-market-react-priority";

describe("live market React commit priority", () => {
  it("commits the initial publication and every safety transition synchronously", () => {
    const live = state();
    expect(unifiedMarketReactCommitPriority(null, live)).toBe("sync");

    const critical: UnifiedLiveMarketState[] = [
      { ...live, status: "stale" },
      { ...live, stale: true },
      { ...live, error: "market_unavailable" },
      { ...live, loading: true },
      { ...live, transport: "polling" },
    ];
    for (const next of critical) {
      expect(isCriticalUnifiedMarketTransition(live, next)).toBe(true);
      expect(unifiedMarketReactCommitPriority(live, next)).toBe("sync");
    }
  });

  it("defers only non-critical market-data and telemetry publications", () => {
    const live = state();
    const dataOnly = {
      ...live,
      sequence: live.sequence + 1,
      lastUpdateAt: "2026-08-12T14:00:00.000Z",
      telemetry: { ...live.telemetry, acceptedUpdateCount: 1 },
    };
    expect(isCriticalUnifiedMarketTransition(live, dataOnly)).toBe(false);
    expect(unifiedMarketReactCommitPriority(live, dataOnly)).toBe("transition");
  });

  it("keeps delayed old A state fail-closed after an A to B to A selection cycle", () => {
    const oldA = createLiveMarketSelectionToken("hyperliquid:BTC:5m:mainnet");
    const selectionB = createLiveMarketSelectionToken("hyperliquid:ETH:5m:mainnet");
    const newA = createLiveMarketSelectionToken("hyperliquid:BTC:5m:mainnet");
    const failClosed = { source: "fail_closed" };

    expect(oldA).not.toBe(selectionB);
    expect(oldA).not.toBe(newA);
    expect(liveMarketStateForSelection(
      { selectionToken: oldA, state: { source: "delayed_old_A" } },
      newA,
      failClosed,
    )).toBe(failClosed);
    expect(liveMarketStateForSelection(
      { selectionToken: newA, state: { source: "current_A" } },
      newA,
      failClosed,
    )).toEqual({ source: "current_A" });
  });
});

function state(): UnifiedLiveMarketState {
  return {
    ...initialUnifiedLiveMarketState(),
    status: "live",
    transport: "websocket",
    loading: false,
    stale: false,
    error: null,
  };
}
