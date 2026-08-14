// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalLiveAccountView } from "@/lib/terminal-live-account";
import type { TerminalLiveAccountRiskDecision } from "@/lib/terminal-live-account-risk";
import { TerminalLiveAccountBlotter } from "./TerminalLiveAccountBlotter";

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

describe("TerminalLiveAccountBlotter", () => {
  it("renders bounded privacy rows and only navigates through market controls", () => {
    host = document.createElement("div");
    document.body.append(host);
    const onInspectMarket = vi.fn();
    const onRefresh = vi.fn();
    act(() => createRoot(host as HTMLDivElement).render(createElement(TerminalLiveAccountBlotter, { view: liveView(), decision: riskDecision(), onInspectMarket, onRefresh })));

    expect(host.querySelector("h2")?.textContent).toBe("Live account blotter");
    expect(host.querySelectorAll("table")).toHaveLength(4);
    expect(host.textContent).toContain("BTC");
    expect(host.textContent).toContain("Nearest liq");
    expect(host.textContent).toContain("Margin use");
    expect(host.textContent).toContain("Portfolio warn");
    expect(host.textContent).toContain("Risk triage");
    expect(host.textContent).toContain("Order-state reconciliation");
    expect(host.textContent).toContain("Snapshot still reports this order open after a canceled lifecycle event.");
    expect(host.textContent).toContain("BTC liquidation 2–5%");
    expect(host.textContent).toContain("within 2–5%");
    expect(host.textContent).toContain("ready to trade");
    expect(host.textContent).toContain("sealed byo");
    expect(host.textContent).toContain("01:59:00");
    expect(host.textContent).toContain("01:58:30");
    expect(host.textContent).toContain("canceled");
    expect(host.textContent).toContain("75-90%");
    expect(host.textContent).toContain("2-5%");
    expect(host.textContent).toContain("5-10x");
    expect(host.textContent).toContain("privacy buckets");
    const inspectButtons = host.querySelectorAll('button[aria-label^="Inspect"]');
    expect(inspectButtons).toHaveLength(5);
    expect(inspectButtons[0]?.getAttribute("aria-label")).toBe("Inspect BTC risk item");
    act(() => (inspectButtons[0] as HTMLButtonElement | undefined)?.click());
    expect(onInspectMarket).toHaveBeenCalledWith({ market: "BTC", network: "mainnet" });
    act(() => host?.querySelector<HTMLButtonElement>('button[aria-label="Refresh live account evidence"]')?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("explains fail-closed network mismatch without rendering rows", () => {
    host = document.createElement("div");
    document.body.append(host);
    act(() => createRoot(host as HTMLDivElement).render(createElement(TerminalLiveAccountBlotter, {
      view: { ...liveView(), status: "unavailable", blocker: "network_mismatch", positions: [], openOrders: [], recentFills: [] },
    })));
    expect(host.textContent).toContain("does not match");
    expect(host.querySelector("table")).toBeNull();
  });

  it("renders distinct lifecycle transitions for one order without duplicate React keys", () => {
    host = document.createElement("div");
    document.body.append(host);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = liveView();
    act(() => createRoot(host as HTMLDivElement).render(createElement(TerminalLiveAccountBlotter, {
      view: {
        ...base,
        orderEvents: [
          { ...base.orderEvents[0], status: "canceled" },
          { ...base.orderEvents[0], status: "open", timeBucket: "2026-08-13T01:58:00.000Z", observedAtMs: Date.parse("2026-08-13T01:58:01.000Z") },
        ],
      },
    })));
    const lifecycle = [...host.querySelectorAll("h3")].find((heading) => heading.textContent?.startsWith("Order lifecycle"))?.parentElement;
    expect(lifecycle?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(lifecycle?.textContent).toContain("open");
    expect(lifecycle?.textContent).toContain("canceled");
    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    error.mockRestore();
  });
});

function liveView(): TerminalLiveAccountView {
  return {
    status: "live", blocker: null, network: "mainnet", accountStatus: "ready_to_trade", accountSource: "sealed_byo", equityBucket: "ready", marginUtilizationBucket: "75-90%", tradingEnabled: true,
    streamStatus: "live", streamAgeMs: 100, streamObservedAtMs: Date.parse("2026-08-13T02:00:00.000Z"), lastCheckedAt: "2026-08-13T02:00:00.000Z",
    nearestLiquidationDistance: "2-5%",
    positionTotalCount: 1, positionsTruncated: false, openOrderTotalCount: 1, openOrdersTruncated: false,
    positions: [{ position_commitment: "position_commitment_123", market: "BTC", side: "long", size_bucket: "0.01-0.1", entry_price_bucket: "10k+", unrealized_pnl_bucket: "+1-10", leverage_bucket: "5-10x", liquidation_distance_bucket: "2-5%" }],
    openOrders: [{ order_handle_commitment: "order_commitment_123", market: "BTC", side: "sell", size_bucket: "0.01-0.1", price_bucket: "10k+", status: "open", reduce_only: true }],
    recentFills: [{ fill_commitment: "fill_commitment_123", market: "BTC", side: "buy", size_bucket: "0.01-0.1", price_bucket: "10k+", fee_bucket: "-<0.001", time_bucket: "2026-08-13T01:59:00.000Z" }],
    orderEvents: [{ orderHandleCommitment: "order_commitment_123", market: "BTC", status: "canceled", side: "sell", sizeBucket: "0.01-0.1", priceBucket: "10k+", timeBucket: "2026-08-13T01:58:30.000Z", observedAtMs: Date.parse("2026-08-13T01:58:31.000Z") }],
  };
}

function riskDecision(): TerminalLiveAccountRiskDecision {
  return {
    identityKey: "authenticated:hyperliquid:mainnet:BTC-PERP:exposure_increasing",
    status: "warning",
    allowed: true,
    reason: "Caution: an open position is within 2–5% of liquidation.",
    nearestLiquidationDistance: "2-5%",
    accountStreamCurrent: true,
    accountStreamObservedAtMs: Date.parse("2026-08-13T02:00:00.000Z"),
  };
}
