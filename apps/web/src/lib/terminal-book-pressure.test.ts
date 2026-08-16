import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  TERMINAL_BOOK_PRESSURE_CAPACITY,
  advanceTerminalBookPressureTape,
  initialTerminalBookPressureState,
  type TerminalBookPressureInput,
  type TerminalBookPressureState,
} from "./terminal-book-pressure";

const NOW = Date.parse("2026-08-12T16:00:00.000Z");

describe("terminal rolling book-pressure tape", () => {
  it("derives honest 5-30s displayed-depth, imbalance, spread, and microprice changes", () => {
    const first = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(frame({ sourceTimeMs: NOW, bidSize: 1, askSize: 1 }), NOW),
    );
    expect(first.tape).toMatchObject({
      status: "unavailable",
      blocker: "insufficient_history",
      updateCount: 0,
    });

    const second = advanceTerminalBookPressureTape(
      first.state,
      input(frame({ sourceTimeMs: NOW + 5_000, bidSize: 3, askSize: 1 }), NOW + 5_000),
    );
    expect(second.tape).toMatchObject({
      status: "ready",
      blocker: null,
      historyCount: 2,
      updateCount: 1,
      horizonSeconds: 5,
      classification: "bid_strengthening",
    });
    expect(second.tape.latest?.bidDepthUsd).toBe(297);
    expect(second.tape.latest?.askDepthUsd).toBe(101);
    expect(second.tape.latest?.spreadBps).toBeCloseTo(200, 8);
    expect(second.tape.latest?.microprice).toBe(100.5);
    expect(second.tape.deltas?.bidDepthPct).toBeCloseTo(200, 8);
    expect(second.tape.deltas?.askDepthPct).toBe(0);
    expect(second.tape.deltas?.imbalancePctPoints).toBeGreaterThan(49);
    expect(second.tape.deltas?.micropriceEdgeBps).toBeCloseTo(50, 8);
    expect(second.tape.deltas).toMatchObject({ spreadPercentile: null, spreadRegime: null });
  });

  it("uses the oldest eligible baseline, never one outside the 5-30s window", () => {
    let state = initialTerminalBookPressureState();
    for (const [offset, bidSize] of [[0, 1], [1_000, 2], [30_000, 3]] as const) {
      state = advanceTerminalBookPressureTape(
        state,
        input(frame({ sourceTimeMs: NOW + offset, bidSize }), NOW + offset),
      ).state;
    }
    const atThirty = advanceTerminalBookPressureTape(
      state,
      input(frame({ sourceTimeMs: NOW + 30_000, bidSize: 3 }), NOW + 30_000),
    ).tape;
    expect(atThirty.horizonSeconds).toBe(30);

    const atThirtyOne = advanceTerminalBookPressureTape(
      state,
      input(frame({ sourceTimeMs: NOW + 31_000, bidSize: 4 }), NOW + 31_000),
    ).tape;
    expect(atThirtyOne.status).toBe("ready");
    expect(atThirtyOne.horizonSeconds).toBe(30);
    expect(atThirtyOne.updateCount).toBe(2);

    const shortOnly = advanceTerminalBookPressureTape(
      advanceTerminalBookPressureTape(
        initialTerminalBookPressureState(),
        input(frame({ sourceTimeMs: NOW }), NOW),
      ).state,
      input(frame({ sourceTimeMs: NOW + 4_999 }), NOW + 4_999),
    );
    expect(shortOnly.tape).toMatchObject({ status: "unavailable", blocker: "insufficient_history" });
  });

  it("normalizes, deduplicates, sorts, and caps displayed depth at ten levels per side", () => {
    const bids = Array.from({ length: 12 }, (_, index) => ({
      px: String(90 + index),
      sz: "1",
      n: null,
    }));
    bids.push({ px: "101", sz: "2", n: null });
    const asks = Array.from({ length: 12 }, (_, index) => ({
      px: String(102 + index),
      sz: "1",
      n: null,
    })).reverse();
    const result = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(frame({ sourceTimeMs: NOW, bids, asks }), NOW),
    );
    const sample = result.state.samples[0];

    expect(sample?.bidDepthUsd).toBe(101 * 3 + sumRange(92, 100));
    expect(sample?.askDepthUsd).toBe(sumRange(102, 111));
    expect(sample?.bookFingerprint.split("|a:")[0]?.split(",")).toHaveLength(10);
    expect(sample?.bookFingerprint.split("|a:")[1]?.split(",")).toHaveLength(10);
  });

  it("deduplicates exact book clocks and fails closed if depth changes without clock advancement", () => {
    const baseInput = input(frame({ sourceTimeMs: NOW }), NOW);
    const first = advanceTerminalBookPressureTape(initialTerminalBookPressureState(), baseInput);
    const duplicate = advanceTerminalBookPressureTape(first.state, baseInput);
    expect(duplicate.state).toBe(first.state);
    expect(duplicate.state.samples).toHaveLength(1);

    const collision = advanceTerminalBookPressureTape(
      duplicate.state,
      input(frame({ sourceTimeMs: NOW, bidSize: 2 }), NOW),
    );
    expect(collision.tape).toMatchObject({ status: "unavailable", blocker: "book_clock_collision" });
    expect(collision.state.samples).toHaveLength(1);
  });

  it("keeps a fixed 90-revision ring", () => {
    let state = initialTerminalBookPressureState();
    for (let index = 0; index < TERMINAL_BOOK_PRESSURE_CAPACITY + 7; index += 1) {
      const sourceTimeMs = NOW + index * 250;
      state = advanceTerminalBookPressureTape(
        state,
        input(frame({ sourceTimeMs, bidSize: 1 + index / 100 }), sourceTimeMs),
      ).state;
    }
    expect(state.samples).toHaveLength(TERMINAL_BOOK_PRESSURE_CAPACITY);
    expect(state.samples[0]?.sourceTimeMs).toBe(NOW + 7 * 250);
    expect(state.samples.at(-1)?.sourceTimeMs).toBe(NOW + (TERMINAL_BOOK_PRESSURE_CAPACITY + 6) * 250);
  });

  it("resets history on venue, product, interval, or network selection changes", () => {
    const seeded = seedReadyState();
    const changes: Array<Partial<TerminalBookPressureInput>> = [
      { selectedVenue: "coinbase", frame: frame({ sourceTimeMs: NOW + 10_000, venue: "coinbase" }) },
      { selectedProduct: "ETH", frame: frame({ sourceTimeMs: NOW + 10_000, product: "ETH-PERP" }) },
      { selectedInterval: "1m", frame: frame({ sourceTimeMs: NOW + 10_000, interval: "1m" }) },
      { network: "testnet", frame: frame({ sourceTimeMs: NOW + 10_000, network: "testnet" }) },
    ];
    for (const change of changes) {
      const result = advanceTerminalBookPressureTape(seeded, {
        ...input(frame({ sourceTimeMs: NOW + 10_000 }), NOW + 10_000),
        ...change,
      });
      expect(result.tape).toMatchObject({ status: "unavailable", blocker: "insufficient_history" });
      expect(result.state.samples).toHaveLength(1);
      expect(result.state.identityKey).not.toBe(seeded.identityKey);
    }
  });

  it("classifies ask strengthening and balanced changes without intent claims", () => {
    const base = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(frame({ sourceTimeMs: NOW }), NOW),
    ).state;
    const ask = advanceTerminalBookPressureTape(
      base,
      input(frame({ sourceTimeMs: NOW + 5_000, askSize: 3 }), NOW + 5_000),
    );
    expect(ask.tape.classification).toBe("ask_strengthening");

    const balanced = advanceTerminalBookPressureTape(
      base,
      input(frame({ sourceTimeMs: NOW + 5_000, bidSize: 2, askSize: 2 }), NOW + 5_000),
    );
    expect(balanced.tape.classification).toBe("balanced");
  });

  it("classifies the current spread against certified 30-second history", () => {
    let state = initialTerminalBookPressureState();
    for (const [index, spread] of [2, 4, 6, 8, 10].entries()) {
      const sourceTimeMs = NOW + index * 2_000;
      state = advanceTerminalBookPressureTape(
        state,
        input(frame({ sourceTimeMs, bestBid: 100 - spread / 2, bestAsk: 100 + spread / 2 }), sourceTimeMs),
      ).state;
    }
    const wideAdvance = advanceTerminalBookPressureTape(
      state,
      input(frame({ sourceTimeMs: NOW + 10_000, bestBid: 94, bestAsk: 106 }), NOW + 10_000),
    );
    expect(wideAdvance.tape.deltas?.spreadRegime).toBe("wide");
    expect(wideAdvance.tape.deltas?.spreadPercentile).toBeCloseTo(100 * 5.5 / 6);

    const tight = advanceTerminalBookPressureTape(
      wideAdvance.state,
      input(frame({ sourceTimeMs: NOW + 12_000, bestBid: 99.5, bestAsk: 100.5 }), NOW + 12_000),
    ).tape;
    expect(tight.deltas?.spreadRegime).toBe("tight");
    expect(tight.deltas?.spreadPercentile).toBeCloseTo(50 / 7);
  });

  it("keeps a tied spread distribution in the normal regime", () => {
    let state = initialTerminalBookPressureState();
    let tape = advanceTerminalBookPressureTape(
      state,
      input(frame({ sourceTimeMs: NOW }), NOW),
    ).tape;
    for (let index = 0; index < 5; index += 1) {
      const sourceTimeMs = NOW + index * 2_000;
      const advanced = advanceTerminalBookPressureTape(
        state,
        input(frame({ sourceTimeMs, bidSize: 1 + index / 10 }), sourceTimeMs),
      );
      state = advanced.state;
      tape = advanced.tape;
    }
    expect(tape.deltas).toMatchObject({ spreadPercentile: 50, spreadRegime: "normal" });
  });

  it("rejects a frame from the wrong network", () => {
    const result = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      { ...input(frame({ sourceTimeMs: NOW, network: "mainnet" }), NOW), network: "testnet" },
    );
    expect(result.tape).toMatchObject({ status: "unavailable", blocker: "market_identity_mismatch" });
    expect(result.state.samples).toEqual([]);
  });

  it("rejects a frame without explicit network identity", () => {
    const value = frame({ sourceTimeMs: NOW });
    delete value.network;
    const result = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(value, NOW),
    );
    expect(result.tape).toMatchObject({ status: "unavailable", blocker: "market_identity_mismatch" });
    expect(result.state.samples).toEqual([]);
  });

  it.each([
    ["synthetic_frame", { synthetic: true }],
    ["stale_frame", { controllerStale: true }],
    ["book_age_invalid", { bookAgeMs: null }],
    ["network_invalid", { network: "" }],
  ] as const)("fails closed on %s input", (blocker, change) => {
    const result = advanceTerminalBookPressureTape(initialTerminalBookPressureState(), {
      ...input(frame({ sourceTimeMs: NOW }), NOW),
      ...change,
    });
    expect(result.tape).toMatchObject({ status: "unavailable", blocker });
    expect(result.tape.latest).toBeNull();
  });

  it.each([
    ["frame_unavailable", null],
    ["stale_frame", frame({ sourceTimeMs: NOW, stale: true })],
    ["market_identity_mismatch", frame({ sourceTimeMs: NOW, product: "ETH-PERP" })],
    ["book_clock_missing", frame({ sourceTimeMs: null })],
    ["book_clock_future", frame({ sourceTimeMs: NOW + 30_001 })],
    ["book_clock_expired", frame({ sourceTimeMs: NOW - 30_001 })],
    ["book_empty", frame({ sourceTimeMs: NOW, bids: [] })],
    ["book_level_invalid", frame({ sourceTimeMs: NOW, bids: [{ px: "99", sz: "bad", n: null }] })],
    ["book_crossed", frame({
      sourceTimeMs: NOW,
      bids: [{ px: "101", sz: "1", n: null }],
      asks: [{ px: "100", sz: "1", n: null }],
    })],
  ] as const)("fails closed with blocker %s", (blocker, value) => {
    const result = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(value, NOW, value?.componentTimestamps?.book === NOW - 30_001 ? 30_001 : 0),
    );
    expect(result.tape).toMatchObject({ status: "unavailable", blocker });
    expect(result.tape.latest).toBeNull();
  });

  it("accepts the unified feed's bounded positive source-clock skew", () => {
    const result = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(frame({ sourceTimeMs: NOW + 30_000 }), NOW, 0),
    );

    expect(result.tape).toMatchObject({ status: "unavailable", blocker: "insufficient_history" });
    expect(result.state.samples[0]?.sourceTimeMs).toBe(NOW + 30_000);
  });

  it("fails closed on a regressed exact book clock", () => {
    const first = advanceTerminalBookPressureTape(
      initialTerminalBookPressureState(),
      input(frame({ sourceTimeMs: NOW }), NOW),
    );
    const regressed = advanceTerminalBookPressureTape(
      first.state,
      input(frame({ sourceTimeMs: NOW - 1 }), NOW, 1),
    );
    expect(regressed.tape).toMatchObject({ status: "unavailable", blocker: "book_clock_regression" });
    expect(regressed.state).toBe(first.state);
  });
});

function seedReadyState(): TerminalBookPressureState {
  const first = advanceTerminalBookPressureTape(
    initialTerminalBookPressureState(),
    input(frame({ sourceTimeMs: NOW }), NOW),
  );
  return advanceTerminalBookPressureTape(
    first.state,
    input(frame({ sourceTimeMs: NOW + 5_000, bidSize: 2 }), NOW + 5_000),
  ).state;
}

function input(
  value: GholaMarketFrame | null,
  nowMs: number,
  bookAgeMs = 0,
): TerminalBookPressureInput {
  return {
    frame: value,
    selectedVenue: "hyperliquid",
    selectedProduct: "BTC",
    selectedInterval: "5m",
    network: "mainnet",
    bookAgeMs,
    nowMs,
  };
}

function frame(overrides: {
  sourceTimeMs?: number | null;
  venue?: GholaMarketFrame["venue"];
  product?: string;
  interval?: string;
  bidSize?: number;
  askSize?: number;
  bids?: GholaMarketFrame["bids"];
  asks?: GholaMarketFrame["asks"];
  stale?: boolean;
  network?: "mainnet" | "testnet";
  bestBid?: number;
  bestAsk?: number;
} = {}): GholaMarketFrame {
  const sourceTimeMs = overrides.sourceTimeMs === undefined ? NOW : overrides.sourceTimeMs;
  return {
    version: 1,
    venue: overrides.venue ?? "hyperliquid",
    network: overrides.network ?? "mainnet",
    product: overrides.product ?? "BTC-PERP",
    interval: overrides.interval ?? "5m",
    fetchedAt: new Date(sourceTimeMs ?? NOW).toISOString(),
    stale: overrides.stale ?? false,
    mid: "100",
    bestBid: String(overrides.bestBid ?? 99),
    bestAsk: String(overrides.bestAsk ?? 101),
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: overrides.bids ?? [{ px: String(overrides.bestBid ?? 99), sz: String(overrides.bidSize ?? 1), n: null }],
    asks: overrides.asks ?? [{ px: String(overrides.bestAsk ?? 101), sz: String(overrides.askSize ?? 1), n: null }],
    trades: [],
    routeQuotes: [],
    componentTimestamps: sourceTimeMs == null ? {} : { book: sourceTimeMs },
  };
}

function sumRange(start: number, end: number) {
  let sum = 0;
  for (let value = start; value <= end; value += 1) sum += value;
  return sum;
}
