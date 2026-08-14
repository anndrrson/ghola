import { describe, expect, it } from "vitest";
import {
  advanceMarketComponent,
  advanceMarketComponents,
  attachMarketComponentClocks,
  hasAuthoritativeDepthUpdate,
  hasAuthoritativePricingUpdate,
  marketComponentClocks,
  marketComponentUpdates,
  normalizeMarketTimestamp,
} from "./market-component-clock";

describe("market component clocks", () => {
  it("infers explicit component sources without letting a fresh trade replace book age", () => {
    const base = 1_700_000_000_000;
    const snapshot = {
      source_timestamp: base + 20_000,
      book_updated_at: new Date(base + 10_000).toISOString(),
      market_updated_at: new Date(base + 15_000).toISOString(),
      bids: [{ px: "1", sz: "1" }],
      asks: [{ px: "2", sz: "1" }],
      recent_trades: [{ time: base + 20_000 }],
      candles: [{ t: base + 5_000 }],
    };

    expect(marketComponentClocks(snapshot)).toEqual({
      quote: base + 10_000,
      book: base + 10_000,
      market: base + 15_000,
      candles: base + 5_000,
      trades: base + 20_000,
    });
  });

  it("carries independent clocks while marking only the updated component", () => {
    const base = 1_700_000_000_000;
    const previous = attachMarketComponentClocks({ value: "old" }, {
      book: base + 20_000,
      market: base + 30_000,
    });
    const next = advanceMarketComponent(previous, { value: "new" }, "book", base + 15_000);

    expect(marketComponentClocks(next)).toEqual({
      book: base + 15_000,
      market: base + 30_000,
    });
    expect([...marketComponentUpdates(next)]).toEqual(["book"]);
    expect(normalizeMarketTimestamp(15)).toBe(15_000);
  });

  it("can suppress misleading inference when a merge selects an undated component", () => {
    const snapshot = attachMarketComponentClocks({
      source_timestamp: 1_700_000_000_000,
      best_bid: "1",
      best_ask: "2",
      bids: [{ px: "1", sz: "1" }],
      asks: [{ px: "2", sz: "1" }],
    }, { market: 1_700_000_000_000 }, true);

    expect(marketComponentClocks(snapshot)).toEqual({ market: 1_700_000_000_000 });
    const marketUpdate = advanceMarketComponent(
      snapshot,
      { ...snapshot },
      "market",
      1_700_000_001_000,
    );
    expect(marketComponentClocks(marketUpdate).book).toBeUndefined();
    const datedBook = advanceMarketComponent(
      marketUpdate,
      { ...marketUpdate },
      "book",
      1_700_000_002_000,
    );
    expect(marketComponentClocks(datedBook).book).toBe(1_700_000_002_000);
  });

  it("treats an explicit null market timestamp as unknown instead of inferring receipt time", () => {
    const snapshot = {
      source_timestamp: 1_700_000_000_000,
      market_updated_at: null,
      mid: "100",
      mark_price: "100",
      bids: [],
      asks: [],
    };

    expect(marketComponentClocks(snapshot)).toEqual({});
  });

  it("distinguishes executable pricing updates from ancillary tape", () => {
    const base = attachMarketComponentClocks({
      best_bid: "99" as string | null,
      best_ask: "101" as string | null,
      mid: null as string | null,
      bids: [],
      asks: [],
      recent_trades: [] as Array<{ time: number }>,
    }, { quote: 1_700_000_000_000 }, true);
    const tape = advanceMarketComponent(
      base,
      { ...base, recent_trades: [{ time: 1_700_000_001_000 }] },
      "trades",
      1_700_000_001_000,
    );
    const quote = advanceMarketComponents(base, { ...base }, {
      quote: 1_700_000_002_000,
      book: 1_700_000_002_000,
    });
    const depth = advanceMarketComponent(
      base,
      { ...base, bids: [{ px: "98", sz: "1" }] },
      "book",
      1_700_000_002_000,
    );
    const noBookMarket = advanceMarketComponent({
      ...base,
      best_bid: null,
      best_ask: null,
    }, {
      ...base,
      best_bid: null,
      best_ask: null,
      mid: "100",
    }, "market", 1_700_000_003_000);
    const oneSidedMarket = advanceMarketComponent({
      ...base,
      best_ask: null,
    }, {
      ...base,
      best_ask: null,
      mid: "99",
    }, "market", 1_700_000_003_000);

    expect(hasAuthoritativePricingUpdate(tape)).toBe(false);
    expect(hasAuthoritativePricingUpdate(quote)).toBe(true);
    expect(hasAuthoritativePricingUpdate(depth)).toBe(false);
    expect(hasAuthoritativeDepthUpdate(depth)).toBe(true);
    expect(hasAuthoritativeDepthUpdate(quote)).toBe(true);
    expect(hasAuthoritativePricingUpdate(noBookMarket)).toBe(true);
    expect(hasAuthoritativePricingUpdate(oneSidedMarket)).toBe(false);
  });

  it("does not infer omitted component clocks after an explicit component update", () => {
    const timestamp = 1_700_000_000_000;
    const markOnly = advanceMarketComponent({
      source_timestamp: null,
      mid: null,
      mark_price: null,
      bids: [],
      asks: [],
    }, {
      source_timestamp: timestamp,
      mid: "100",
      mark_price: "100",
      bids: [],
      asks: [],
    }, "mark", timestamp);

    expect(marketComponentClocks(markOnly)).toEqual({ mark: timestamp });
  });
});
