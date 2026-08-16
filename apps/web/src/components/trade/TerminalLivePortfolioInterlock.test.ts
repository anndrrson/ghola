import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalLiveAccountRiskDecision } from "@/lib/terminal-live-account-risk";
import { TerminalLivePortfolioInterlock } from "./TerminalLivePortfolioInterlock";

describe("TerminalLivePortfolioInterlock", () => {
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

  it("announces a portfolio block and its privacy boundary", () => {
    act(() => root.render(createElement(TerminalLivePortfolioInterlock, { decision: blocked() })));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("BLOCKED");
    expect(container.textContent).toContain("within 2% of liquidation");
    expect(container.textContent).toContain("server policy remain authoritative");
  });

  it("stays absent when the selected venue is not applicable", () => {
    act(() => root.render(createElement(TerminalLivePortfolioInterlock, { decision: { ...blocked(), status: "not_applicable", allowed: true } })));
    expect(container.textContent).toBe("");
  });

  it("distinguishes an allowed margin warning from a block", () => {
    act(() => root.render(createElement(TerminalLivePortfolioInterlock, { decision: {
      ...blocked(),
      status: "warning",
      allowed: true,
      reason: "Caution: account margin utilization is 75–90%.",
    } })));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("CAUTION");
    expect(container.textContent).toContain("75–90%");
  });
});

function blocked(): TerminalLiveAccountRiskDecision {
  return {
    identityKey: "authenticated:hyperliquid:mainnet:BTC-PERP:exposure_increasing",
    status: "blocked",
    allowed: false,
    reason: "Exposure increase blocked: an open position is within 2% of liquidation.",
    nearestLiquidationDistance: "<2%",
    accountStreamCurrent: true,
    accountStreamObservedAtMs: Date.parse("2026-08-13T02:00:00.000Z"),
  };
}
