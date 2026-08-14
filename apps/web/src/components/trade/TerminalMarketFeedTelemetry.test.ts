import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialMarketFeedTelemetry } from "@/lib/market-feed-telemetry";
import { TerminalMarketFeedTelemetry } from "./TerminalMarketFeedTelemetry";

describe("TerminalMarketFeedTelemetry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps grade, freshness, rate, and recent warnings visible while mobile details collapse", () => {
    render({ rollingEventCount: 2, healthGrade: "C", healthScore: 71 });

    expect(container.textContent).toContain("Feed C · 71");
    expect(container.textContent).toContain("2 recent events");
    const button = container.querySelector("button");
    const diagnostics = document.getElementById(button?.getAttribute("aria-controls") ?? "");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(diagnostics?.className).toContain("hidden");

    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(diagnostics?.className).toContain("flex");
    expect(diagnostics?.textContent).toContain("Reconnect / fallback / stale");
  });

  it("announces full diagnostics even while visually compact", () => {
    render({ reconnectCount: 1, timestampRegressionCount: 2, receiptLatencyMs: 450 });

    const label = container.querySelector("section")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("receipt latency 450 ms");
    expect(label).toContain("reconnect, fallback, stale counters 1, 0, 0");
    expect(label).toContain("sequence, timestamp, gap rejection counters 0, 2, 0");
  });

  it("shows independently certified quote, book, trade, and candle freshness", () => {
    render({}, {
      quote: { ready: true, blocker: null, ageMs: 120 },
      book: { ready: false, blocker: "component_stale", ageMs: 30_001 },
      trades: { ready: false, blocker: "trades_empty", ageMs: 500 },
      candles: { ready: true, blocker: null, ageMs: 61_000 },
    });

    expect(container.textContent).toContain("Quote · 120 ms");
    expect(container.textContent).toContain("Book · stale");
    expect(container.textContent).toContain("Trades · missing");
    expect(container.textContent).toContain("Candles · 61.0 s");
    const sectionLabel = container.querySelector("section")?.getAttribute("aria-label") ?? "";
    expect(sectionLabel).toContain("Quote certified, age 120 ms");
    expect(sectionLabel).toContain("Book book component stale, age 30.0 s");
  });

  function render(
    overrides: Partial<ReturnType<typeof initialMarketFeedTelemetry>>,
    components?: Parameters<typeof TerminalMarketFeedTelemetry>[0]["components"],
  ) {
    act(() => root.render(createElement(TerminalMarketFeedTelemetry, {
      telemetry: {
        ...initialMarketFeedTelemetry(),
        sourceAgeMs: 220,
        receiptLatencyMs: 180,
        updateRateHz: 12.5,
        healthGrade: "A",
        healthScore: 100,
        ...overrides,
      },
      peerGrades: [],
      components,
    })));
  }
});
