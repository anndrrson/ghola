import { describe, expect, it, vi } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  aggregateCrossVenueState,
  createCrossVenueLiveMarket,
  crossVenueMarketVenues,
  summarizeCrossVenueHealth,
  type CrossVenueLiveMarketState,
} from "./cross-venue-live-market";
import {
  initialUnifiedLiveMarketState,
  unifiedMarketSnapshotUrl,
  type UnifiedLiveMarketController,
  type UnifiedLiveMarketOptions,
  type UnifiedLiveMarketState,
} from "./unified-live-market";

const NOW = Date.parse("2026-08-12T15:00:00.000Z");

describe("cross-venue public live market", () => {
  it("selects only venues that support the instrument", () => {
    expect(crossVenueMarketVenues("hyperliquid", "SOL")).toEqual(["phoenix", "coinbase"]);
    expect(crossVenueMarketVenues("coinbase", "BTC")).toEqual(["hyperliquid"]);
    expect(crossVenueMarketVenues("hyperliquid", "HYPE")).toEqual([]);
  });

  it("consolidates executable bids, asks, spread and per-venue health", () => {
    const states = new Map([
      ["hyperliquid" as const, liveState(frame("hyperliquid", "99", "101", "100"), 2)],
      ["phoenix" as const, liveState(frame("phoenix", "101", "102", "101.5"), 3)],
      ["coinbase" as const, pollingState(frame("coinbase", "98", "100", "99"), 4)],
    ]);
    const result = aggregateCrossVenueState({
      currentVenue: "hyperliquid",
      market: "SOL",
      interval: "5m",
      sequence: 7,
      venueStates: states,
    });

    expect(result.frames).toHaveLength(3);
    expect(result.comparisonFrames.map((item) => item.venue)).toEqual(["phoenix", "coinbase"]);
    expect(result.bestBid).toMatchObject({ venue: "phoenix", bid: 101 });
    expect(result.bestAsk).toMatchObject({ venue: "coinbase", ask: 100 });
    expect(result.executableSpreadBps).toBeCloseTo(100);
    expect(result.liveVenueCount).toBe(3);
    expect(result.health.find((item) => item.venue === "coinbase")?.status).toBe("polling");
  });

  it("excludes stale, errored and crossed quotes while retaining venue health", () => {
    const stale = { ...liveState(frame("phoenix", "101", "102", "101.5"), 2), stale: true };
    const crossedFrame = frame("coinbase", "102", "101", "101.5");
    const result = aggregateCrossVenueState({
      currentVenue: "hyperliquid",
      market: "SOL",
      interval: "5m",
      sequence: 3,
      venueStates: new Map([
        ["hyperliquid", liveState(frame("hyperliquid", "99", "101", "100"), 1)],
        ["phoenix", stale],
        ["coinbase", liveState(crossedFrame, 3)],
      ]),
    });

    expect(result.quotes.map((quote) => quote.venue)).toEqual(["hyperliquid"]);
    expect(result.frames.map((item) => item.venue)).toEqual(["hyperliquid", "coinbase"]);
    expect(result.staleVenueCount).toBe(1);
    expect(result.health).toHaveLength(3);
    expect(result.executableSpreadBps).toBeCloseTo(-198.0198, 3);
  });

  it("excludes reconnecting and unhealthy polling venues from frames, quotes, and live counts", () => {
    const value = frame("coinbase", "99", "101", "100");
    const excludedStates: UnifiedLiveMarketState[] = [
      {
        ...liveState(value, 1),
        status: "reconnecting",
        transport: null,
      },
      {
        ...pollingState(value, 2),
        stale: true,
      },
      {
        ...pollingState(value, 3),
        error: "market_unavailable",
      },
    ];

    for (const state of excludedStates) {
      const result = aggregateCrossVenueState({
        currentVenue: "hyperliquid",
        market: "BTC",
        interval: "5m",
        sequence: state.sequence,
        venueStates: new Map([["coinbase", state]]),
      });

      expect(result.frames).toEqual([]);
      expect(result.comparisonFrames).toEqual([]);
      expect(result.quotes).toEqual([]);
      expect(result.liveVenueCount).toBe(0);
    }
  });

  it("starts only unique peer children and ignores out-of-order child states", () => {
    const harness = childHarness();
    const emitted: CrossVenueLiveMarketState[] = [];
    const controller = createCrossVenueLiveMarket({
      currentVenue: "hyperliquid",
      market: "SOL",
      interval: "5m",
      createMarket: harness.create,
      onState: (state) => emitted.push(state),
    });

    controller.start();
    expect(harness.venues()).toEqual(["phoenix", "coinbase"]);
    const childUrls = harness.selections().map(unifiedMarketSnapshotUrl);
    expect(new Set(childUrls).size).toBe(childUrls.length);
    expect(childUrls).not.toContain(unifiedMarketSnapshotUrl({
      venue: "hyperliquid",
      market: "SOL",
      interval: "5m",
    }));
    harness.emit("phoenix", liveState(frame("phoenix", "149", "150", "149.5"), 5));
    const sequence = controller.getState().sequence;
    harness.emit("phoenix", liveState(frame("phoenix", "140", "141", "140.5"), 4));

    expect(controller.getState().sequence).toBe(sequence);
    expect(controller.getState().quotes.find((quote) => quote.venue === "phoenix")?.mid).toBe(149.5);
    controller.stop();
    expect(harness.stopped()).toEqual(["phoenix", "coinbase"]);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("cleanly tears down and ignores late callbacks from an old generation", () => {
    const harness = childHarness();
    const onState = vi.fn();
    const controller = createCrossVenueLiveMarket({
      currentVenue: "coinbase",
      market: "BTC",
      interval: "5m",
      createMarket: harness.create,
      onState,
    });
    controller.start();
    harness.emit("hyperliquid", liveState(frame("hyperliquid", "99", "100", "99.5"), 1));
    const atStop = onState.mock.calls.length;
    controller.stop();
    harness.emit("hyperliquid", liveState(frame("hyperliquid", "199", "200", "199.5"), 2));

    expect(onState).toHaveBeenCalledTimes(atStop);
    expect(harness.stopped()).toEqual(["hyperliquid"]);
  });

  it("opens no comparison child for a single-venue market", () => {
    const harness = childHarness();
    const controller = createCrossVenueLiveMarket({
      currentVenue: "hyperliquid",
      market: "HYPE",
      interval: "5m",
      createMarket: harness.create,
      onState: vi.fn(),
    });

    controller.start();
    expect(harness.venues()).toEqual([]);
    expect(harness.selections()).toEqual([]);
    expect(controller.getState().health).toEqual([]);
    controller.stop();
    expect(harness.stopped()).toEqual([]);
  });

  it("counts the existing primary stream with peer health", () => {
    const summary = summarizeCrossVenueHealth(
      "hyperliquid",
      liveState(frame("hyperliquid", "99", "101", "100"), 9),
      [
        {
          venue: "phoenix",
          status: "polling",
          sourceStatus: "fallback_polling",
          stale: false,
          error: null,
          fetchedAt: new Date(NOW).toISOString(),
          sequence: 3,
          telemetry: initialUnifiedLiveMarketState().telemetry,
        },
        {
          venue: "coinbase",
          status: "stale",
          sourceStatus: "stale",
          stale: true,
          error: null,
          fetchedAt: new Date(NOW - 180_000).toISOString(),
          sequence: 4,
          telemetry: initialUnifiedLiveMarketState().telemetry,
        },
      ],
    );

    expect(summary.health.map((item) => item.venue)).toEqual(["hyperliquid", "phoenix", "coinbase"]);
    expect(summary.liveVenueCount).toBe(2);
    expect(summary.staleVenueCount).toBe(1);
  });

  it("coalesces peer data updates while publishing critical health immediately", () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = childHarness();
    const emitted: CrossVenueLiveMarketState[] = [];
    const controller = createCrossVenueLiveMarket({
      currentVenue: "coinbase",
      market: "BTC",
      interval: "5m",
      createMarket: harness.create,
      now: () => now,
      publishCadenceMs: 100,
      onState: (state) => emitted.push(state),
    });
    controller.start();
    harness.emit("hyperliquid", liveState(frame("hyperliquid", "99", "101", "100"), 1));
    const afterLive = emitted.length;

    for (let sequence = 2; sequence <= 10; sequence += 1) {
      now += 10;
      harness.emit(
        "hyperliquid",
        liveState(frame("hyperliquid", String(98 + sequence), String(100 + sequence), String(99 + sequence)), sequence),
      );
    }
    expect(emitted).toHaveLength(afterLive);
    now = 100;
    vi.advanceTimersByTime(90);
    expect(emitted).toHaveLength(afterLive + 1);
    expect(controller.getState().quotes[0]?.mid).toBe(109);

    now += 1;
    const stale = {
      ...liveState(frame("hyperliquid", "108", "110", "109"), 11),
      status: "stale" as const,
      stale: true,
    };
    harness.emit("hyperliquid", stale);
    expect(emitted.at(-1)?.staleVenueCount).toBe(1);
    controller.stop();
    vi.useRealTimers();
  });
});

function childHarness() {
  const callbacks = new Map<string, (state: UnifiedLiveMarketState) => void>();
  const selections: UnifiedLiveMarketOptions[] = [];
  const startedVenues: string[] = [];
  const stoppedVenues: string[] = [];
  return {
    create: ((options: UnifiedLiveMarketOptions): UnifiedLiveMarketController => {
      selections.push(options);
      callbacks.set(options.venue, options.onState);
      return {
        start() { startedVenues.push(options.venue); },
        stop() { stoppedVenues.push(options.venue); },
        getState: initialUnifiedLiveMarketState,
      };
    }),
    emit(venue: string, state: UnifiedLiveMarketState) {
      callbacks.get(venue)?.(state);
    },
    venues: () => startedVenues,
    selections: () => selections,
    stopped: () => stoppedVenues,
  };
}

function liveState(value: GholaMarketFrame, sequence: number): UnifiedLiveMarketState {
  return {
    ...initialUnifiedLiveMarketState(),
    status: "live",
    transport: "websocket",
    frame: value,
    loading: false,
    stale: false,
    sequence,
    lastUpdateAt: value.fetchedAt,
  };
}

function pollingState(value: GholaMarketFrame, sequence: number): UnifiedLiveMarketState {
  return { ...liveState(value, sequence), status: "fallback_polling", transport: "polling" };
}

function frame(
  venue: GholaMarketFrame["venue"],
  bestBid: string,
  bestAsk: string,
  mid: string,
): GholaMarketFrame {
  return {
    version: 1,
    venue,
    product: "SOL-USD",
    interval: "5m",
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid,
    bestBid,
    bestAsk,
    spreadBps: null,
    markPrice: mid,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}
