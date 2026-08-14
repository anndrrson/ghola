import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  inspectTerminalWatchlistPreferences,
  serializeTerminalWatchlistPreferences,
  setTerminalWatchlistSort,
  defaultTerminalWatchlistPreferences,
  type TerminalWatchlistSource,
} from "@/lib/terminal-market-watchlist";
import { TerminalMarketWatchlist } from "./TerminalMarketWatchlist";

const { scannerHook } = vi.hoisted(() => ({ scannerHook: vi.fn((targets: unknown[]) => {
  void targets;
  return [];
}) }));
vi.mock("@/lib/use-terminal-market-scanner", () => ({
  useTerminalMarketScanner: scannerHook,
}));

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("TerminalMarketWatchlist", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    scannerHook.mockClear();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("reorders visible rows from sortable headers and persists the choice", async () => {
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [source("BTC", 4, 98, 102), source("ETH", 1, 99.9, 100.1)],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect: vi.fn(),
    })));

    expect(instrumentOrder(container).slice(0, 2)).toEqual(["BTC", "ETH"]);
    const spread = button(container, "Sort scanner by Spread");
    expect(spread.closest("th")?.getAttribute("aria-sort")).toBe("none");
    await act(async () => spread.click());

    expect(instrumentOrder(container).slice(0, 2)).toEqual(["ETH", "BTC"]);
    expect(spread.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(window.localStorage.getItem("ghola.terminal-market-watchlist.v2:device_guest")).toContain('"field":"spread"');
  });

  it("waits for saved preferences before starting peer snapshot rotation", async () => {
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [source("BTC", 4, 98, 102)],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect: vi.fn(),
    })));

    expect(scannerHook.mock.calls.at(-1)?.[0]).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(scannerHook.mock.calls.at(-1)?.[0]).toHaveLength(3);
  });

  it("preserves unreadable preferences until confirmed reset", async () => {
    const key = "ghola.terminal-market-watchlist.v2:device_guest";
    const raw = "{broken-scanner-preferences";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.localStorage.setItem(key, raw);
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [source("BTC", 4, 98, 102)],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect: vi.fn(),
    })));
    await act(async () => vi.advanceTimersByTimeAsync(20));

    expect(container.textContent).toContain("preferences are unreadable or unavailable and preserved");
    expect(button(container, "Sort scanner by Spread").disabled).toBe(true);
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(window.localStorage.getItem(key)).toBe(raw);

    clickButtonText(container, "Reset scanner");
    expect(window.localStorage.getItem(key)).toBe(raw);
    confirm.mockReturnValue(true);
    clickButtonText(container, "Reset scanner");
    expect(inspectTerminalWatchlistPreferences(window.localStorage.getItem(key)).status).toBe("ready");
    expect(button(container, "Sort scanner by Spread").disabled).toBe(false);
  });

  it("synchronizes valid preferences and locks corrupt cross-tab changes", async () => {
    const key = "ghola.terminal-market-watchlist.v2:device_guest";
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [source("BTC", 4, 98, 102), source("ETH", 1, 99.9, 100.1)],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect: vi.fn(),
    })));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    const remote = setTerminalWatchlistSort(defaultTerminalWatchlistPreferences(), "spread");
    const remoteRaw = serializeTerminalWatchlistPreferences(remote);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: remoteRaw })));
    expect(button(container, "Sort scanner by Spread").closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    const corrupt = "{corrupt-remote";
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: corrupt })));
    expect(container.textContent).toContain("preferences are unreadable or unavailable and preserved");
    expect(button(container, "Sort scanner by Spread").disabled).toBe(true);
  });

  it("does not apply a preference mutation when its durable write fails", async () => {
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [source("BTC", 4, 98, 102), source("ETH", 1, 99.9, 100.1)],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect: vi.fn(),
    })));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    await act(async () => button(container, "Sort scanner by Spread").click());

    expect(button(container, "Sort scanner by Spread").closest("th")?.getAttribute("aria-sort")).toBe("none");
    expect(container.textContent).toContain("preferences are unreadable or unavailable and preserved");
  });

  it("bails out on tape/depth-only source ticks but renders quote changes", async () => {
    const onSelect = vi.fn();
    const initial = source("BTC", 4, 98, 102);
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [initial],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect,
    })));
    const renders = scannerHook.mock.calls.length;
    const aggregateOnly: TerminalWatchlistSource = {
      ...initial,
      frame: {
        ...initial.frame,
        fetchedAt: new Date(NOW + 1_000).toISOString(),
        trades: [{ side: "buy", px: "102", sz: "0.1", time: NOW + 1_000 }],
        bids: [{ px: "98", sz: "5", n: 2 }],
      },
      telemetryCapturedAtMs: NOW + 1_000,
      componentAgesMs: { quote: 1_100, candles: 1_100 },
    };
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [aggregateOnly],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect,
    })));
    expect(scannerHook).toHaveBeenCalledTimes(renders);

    const quoteChanged = { ...aggregateOnly, frame: { ...aggregateOnly.frame, bestAsk: "103" } };
    await act(async () => root.render(createElement(TerminalMarketWatchlist, {
      persistenceScope: "device_guest",
      sources: [quoteChanged],
      interval: "5m",
      hyperliquidNetwork: "mainnet",
      selectedInstrument: "BTC",
      selectedVenue: "hyperliquid",
      onSelect,
    })));
    expect(scannerHook.mock.calls.length).toBeGreaterThan(renders);
  });
});

function instrumentOrder(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    .map((row) => row.querySelector("th button")?.textContent?.trim() ?? "");
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.getAttribute("aria-label") === label);
  if (!match) throw new Error(`missing button ${label}`);
  return match;
}

function clickButtonText(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`missing button ${label}`);
  act(() => match.click());
}

function source(instrument: "BTC" | "ETH", candleStep: number, bid: number, ask: number): TerminalWatchlistSource {
  const frame: GholaMarketFrame = {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: `${instrument}-PERP`,
    interval: "5m",
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid: String((bid + ask) / 2),
    bestBid: String(bid),
    bestAsk: String(ask),
    spreadBps: null,
    markPrice: null,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: Array.from({ length: 12 }, (_, index) => ({
      t: NOW - (12 - index) * 300_000,
      T: NOW - (11 - index) * 300_000 - 1,
      o: String(100 + index * candleStep),
      h: String(101 + index * candleStep),
      l: String(99 + index * candleStep),
      c: String(100 + index * candleStep),
      v: "10",
      n: 1,
    })),
    bids: [{ px: String(bid), sz: "1", n: 1 }],
    asks: [{ px: String(ask), sz: "1", n: 1 }],
    trades: [],
    routeQuotes: [],
  };
  return {
    frame,
    status: "live",
    stale: false,
    provenance: "public_live",
    healthGrade: "A",
    componentAgesMs: { quote: 100, candles: 100 },
    telemetryCapturedAtMs: NOW,
  };
}
