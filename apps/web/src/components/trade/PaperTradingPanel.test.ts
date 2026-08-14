import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import { createPaperTradingState, paperTradingStorageKey, PAPER_TRADING_GUEST_SCOPE, PAPER_TRADING_STORAGE_KEY, placePaperOrder, serializePaperTradingState, type PaperOrderInput } from "@/lib/paper-trading-engine";
import {
  classifyPaperTradingStorage,
  PaperTradingPanel,
  paperClosePositionBlocker,
  paperOrderReferencePrices,
  paperStorageValuesConflict,
  replaceBlockedPaperTradingStorage,
  submitPaperOrderWithExecutableArrival,
} from "./PaperTradingPanel";

const NOW = Date.parse("2026-08-12T12:00:01.000Z");

describe("PAPER order reference provenance", () => {
  it("keeps limit sizing separate from the executable-side arrival quote", () => {
    expect(references({ orderType: "limit", side: "buy", limitPrice: 95 })).toEqual({
      sizingReference: 95,
      arrivalReference: 101,
    });
    expect(references({ orderType: "stop_limit", side: "sell", limitPrice: 96, stopPrice: 97 })).toEqual({
      sizingReference: 96,
      arrivalReference: 99,
    });
    expect(references({ orderType: "stop", side: "buy", stopPrice: 105 })).toEqual({
      sizingReference: 105,
      arrivalReference: 101,
    });
  });

  it("never infers an arrival benchmark from the limit, midpoint, mark, or stop", () => {
    expect(references({
      orderType: "limit",
      side: "buy",
      limitPrice: 95,
      frame: marketFrame({ bestAsk: null, mid: "100", markPrice: "100" }),
    })).toEqual({ sizingReference: 95, arrivalReference: null });
    expect(references({
      orderType: "stop",
      side: "sell",
      stopPrice: 97,
      frame: marketFrame({ bestBid: null, mid: "100", markPrice: "100" }),
    })).toEqual({ sizingReference: 97, arrivalReference: null });
  });

  it("fails the benchmark closed for stale quote clocks, one-sided books, or mismatched frames", () => {
    expect(references({ marketDataLive: false }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ stale: true }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ componentTimestamps: { quote: NOW - 5_001 } }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ componentTimestamps: { quote: NOW + 1 } }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ componentTimestamps: {} }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ bestBid: null }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ bestAsk: null }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ bestBid: "101", bestAsk: "101" }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ network: "testnet" }) }).arrivalReference).toBeNull();
    expect(references({ frame: marketFrame({ product: "ETH-PERP" }) }).arrivalReference).toBeNull();
  });

  it("uses the normalized quote component clock instead of aggregate frame receipt time", () => {
    expect(references({
      frame: marketFrame({
        fetchedAt: "2026-08-12T11:00:00.000Z",
        componentTimestamps: { quote: (NOW - 1_000) / 1_000 },
      }),
    }).arrivalReference).toBe(101);
  });

  it("does not place or amend when the click-time executable BBO is unavailable", () => {
    const draft = paperDraft();
    const empty = createPaperTradingState({ now: "2026-08-12T12:00:00.000Z" });
    expect(submitPaperOrderWithExecutableArrival({
      state: empty,
      draft,
      amendingOrderId: null,
      arrivalReference: null,
      now: draft.submitted_at,
      marketMaxAgeMs: 5_000,
    })).toBeNull();

    const pending = placePaperOrder(empty, draft);
    expect(submitPaperOrderWithExecutableArrival({
      state: pending,
      draft,
      amendingOrderId: pending.orders[0]!.order_id,
      arrivalReference: null,
      now: "2026-08-12T12:00:02.000Z",
      marketMaxAgeMs: 5_000,
    })).toBeNull();
    expect(pending.orders).toHaveLength(1);
    expect(pending.orders[0]!.replaced_by_order_id).toBeNull();
  });
});

describe("PAPER close quote provenance", () => {
  it("requires the same fresh, exact-market, uncrossed BBO as placement", () => {
    expect(closeBlocker()).toBeNull();
    for (const frame of [
      marketFrame({ componentTimestamps: { quote: NOW - 5_001, book: NOW - 1_000 } }),
      marketFrame({ componentTimestamps: { quote: NOW + 1, book: NOW - 1_000 } }),
      marketFrame({ componentTimestamps: { book: NOW - 1_000 } }),
      marketFrame({ bestBid: null }),
      marketFrame({ bestAsk: null }),
      marketFrame({ bestBid: "101", bestAsk: "101" }),
      marketFrame({ network: "testnet" }),
      marketFrame({ product: "ETH-PERP" }),
    ]) {
      expect(closeBlocker({ frame })).toContain("fresh, uncrossed executable BBO");
    }
  });
});

describe("PAPER storage load containment", () => {
  it("detects any changed or removed persisted document", () => {
    expect(paperStorageValuesConflict("one", "one")).toBe(false);
    expect(paperStorageValuesConflict("one", "two")).toBe(true);
    expect(paperStorageValuesConflict("one", null)).toBe(true);
    expect(paperStorageValuesConflict(null, null)).toBe(false);
  });

  it("distinguishes absence from valid, corrupt, and future storage", () => {
    expect(classifyPaperTradingStorage(null)).toEqual({ status: "absent" });
    const state = createPaperTradingState({ now: "2026-08-12T12:00:00.000Z" });
    expect(classifyPaperTradingStorage(serializePaperTradingState(state))).toEqual({ status: "ready", state });
    expect(classifyPaperTradingStorage("{broken")).toEqual({
      status: "blocked",
      block: { reason: "corrupt", raw: "{broken" },
    });
    const future = JSON.stringify({ version: 999, mode: "paper", orders: ["preserve"] });
    expect(classifyPaperTradingStorage(future)).toEqual({
      status: "blocked",
      block: { reason: "future", raw: future },
    });
  });

  it("does not write blocked storage without confirmation", () => {
    const writes: string[] = [];
    expect(replaceBlockedPaperTradingStorage({
      confirmed: false,
      now: "2026-08-12T12:00:00.000Z",
      write: (value) => writes.push(value),
    })).toBeNull();
    expect(writes).toEqual([]);
  });

  it("recovers only through an explicit reset write", () => {
    const writes: string[] = [];
    const state = replaceBlockedPaperTradingStorage({
      confirmed: true,
      now: "2026-08-12T12:00:00.000Z",
      write: (value) => writes.push(value),
    });

    expect(state).toEqual(createPaperTradingState({ now: "2026-08-12T12:00:00.000Z" }));
    expect(writes).toEqual([serializePaperTradingState(state!)]);
  });
});

describe("PaperTradingPanel preserved storage lock", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  for (const [label, raw] of [
    ["corrupt", "{broken"],
    ["future", JSON.stringify({ version: 999, mode: "paper", orders: ["preserve"] })],
  ] as const) {
    it(`preserves ${label} raw storage across mount and pagehide`, async () => {
      window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, raw);
      const write = vi.spyOn(Storage.prototype, "setItem");
      await renderPanel(root);

      expect(container.textContent).toContain("PAPER LOCKED");
      expect(container.textContent).toContain(label === "future" ? "newer PAPER storage version" : "failed integrity validation");
      act(() => window.dispatchEvent(new Event("pagehide")));
      expect(write).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).toBe(raw);
    });
  }

  it("replaces preserved storage only after an explicit confirmed reset", async () => {
    const raw = "{broken";
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, raw);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderPanel(root);
    const reset = buttonNamed(container, "Reset preserved PAPER data");

    act(() => reset.click());
    expect(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).toBe(raw);
    expect(container.textContent).toContain("PAPER LOCKED");

    act(() => reset.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(classifyPaperTradingStorage(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).status).toBe("ready");
    expect(container.textContent).not.toContain("PAPER LOCKED");
    expect(container.textContent).toContain("Trading simulator & journal");
  });

  it("never hydrates another account's preserved PAPER state", async () => {
    const leftScope = `subject_${"a".repeat(32)}`;
    const rightScope = `subject_${"b".repeat(32)}`;
    const leftKey = paperTradingStorageKey(leftScope)!;
    const rightKey = paperTradingStorageKey(rightScope)!;
    window.localStorage.setItem(leftKey, "{other-account-corrupt");
    window.localStorage.setItem(rightKey, serializePaperTradingState(createPaperTradingState({ now: new Date(NOW).toISOString() })));

    await renderPanel(root, { persistenceScope: rightScope });

    expect(container.textContent).not.toContain("PAPER LOCKED");
    expect(window.localStorage.getItem(leftKey)).toBe("{other-account-corrupt");
    expect(classifyPaperTradingStorage(window.localStorage.getItem(rightKey)).status).toBe("ready");
  });

  it("locks on a cross-tab PAPER write and never overwrites it on pagehide", async () => {
    const original = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, original);
    await renderPanel(root);
    const remote = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW + 1_000).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, remote);

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: PAPER_TRADING_STORAGE_KEY, newValue: remote }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Another browser tab changed this PAPER account");
    expect(container.textContent).toContain("Use stored version");
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).toBe(remote);
  });

  it("checks stored bytes again immediately before a queued write", async () => {
    const original = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, original);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPanel(root);
    act(() => buttonNamed(container, "Reset").click());
    expect(confirm).toHaveBeenCalledOnce();
    const remote = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW + 1_000).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, remote);

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });

    expect(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).toBe(remote);
    expect(container.textContent).toContain("Another browser tab changed this PAPER account");
  });

  it("resumes only after confirmed conflict resolution", async () => {
    const original = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, original);
    await renderPanel(root);
    const remote = serializePaperTradingState(createPaperTradingState({ now: new Date(NOW + 1_000).toISOString() }));
    window.localStorage.setItem(PAPER_TRADING_STORAGE_KEY, remote);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: PAPER_TRADING_STORAGE_KEY, newValue: remote }));
      await Promise.resolve();
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    act(() => buttonNamed(container, "Use stored version").click());
    expect(container.textContent).toContain("PAPER LOCKED");
    await act(async () => {
      buttonNamed(container, "Use stored version").click();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("PAPER LOCKED");
    expect(window.localStorage.getItem(PAPER_TRADING_STORAGE_KEY)).toBe(remote);
  });

  it("disables placement when the quote component expires before the aggregate frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await renderPanel(root, {
      frame: marketFrame({
        fetchedAt: new Date(NOW).toISOString(),
        componentTimestamps: { quote: NOW - 1_000, book: NOW - 1_000 },
      }),
      marketDataLive: true,
      marketMaxAgeMs: 5_000,
    });
    const place = buttonNamed(container, "PLACE PAPER BUY LIMIT");
    expect(place.disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_001);
    });
    expect(buttonNamed(container, "PLACE PAPER BUY LIMIT").disabled).toBe(true);
    expect(container.textContent).toContain("fresh, uncrossed executable BBO");
  });
});

function references(overrides: Partial<Parameters<typeof paperOrderReferencePrices>[0]> = {}) {
  return paperOrderReferencePrices({
    orderType: "limit",
    side: "buy",
    limitPrice: 95,
    stopPrice: null,
    frame: marketFrame(),
    venueId: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    marketDataLive: true,
    marketMaxAgeMs: 5_000,
    nowMs: NOW,
    ...overrides,
  });
}

function marketFrame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    interval: "1m",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: NOW - 1_000, book: NOW - 1_000 },
    ...overrides,
  };
}

function paperDraft(): PaperOrderInput {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    order_type: "limit",
    time_in_force: "GTC",
    limit_price: 95,
    reference_price: 101,
    quote_notional_usd: 95,
    base_size: 1,
    submitted_at: "2026-08-12T12:00:01.000Z",
  };
}

function closeBlocker(overrides: Partial<Parameters<typeof paperClosePositionBlocker>[0]> = {}) {
  return paperClosePositionBlocker({
    loaded: true,
    frame: marketFrame(),
    venueId: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    positionQuantity: 1,
    marketDataLive: true,
    marketMaxAgeMs: 5_000,
    nowMs: NOW,
    ...overrides,
  });
}

async function renderPanel(root: Root, overrides: Partial<Parameters<typeof PaperTradingPanel>[0]> = {}) {
  await act(async () => {
    root.render(createElement(PaperTradingPanel, {
      persistenceScope: PAPER_TRADING_GUEST_SCOPE,
      frame: null,
      venueId: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limitPrice: 100,
      quoteNotionalUsd: 100,
      stopLevel: 90,
      targetPrice: 120,
      targetRewardMultiple: 2,
      marketDataLive: false,
      marketMaxAgeMs: 30_000,
      onSelectMarkMarket: vi.fn(),
      ...overrides,
    }));
    await Promise.resolve();
  });
}

function buttonNamed(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}
