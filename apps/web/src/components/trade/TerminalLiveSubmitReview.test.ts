import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalLiveSubmitReviewSnapshot } from "@/lib/terminal-live-submit-review";
import { TerminalLiveSubmitReview } from "./TerminalLiveSubmitReview";

describe("TerminalLiveSubmitReview", () => {
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

  it("shows the exact route, risk, and one-shot warning before confirmation", () => {
    const onConfirm = vi.fn();
    act(() => root.render(createElement(TerminalLiveSubmitReview, {
      review: snapshot(),
      liquidity: liquidity(),
      decision: { allowed: true, blocker: null },
      onConfirm,
      onCancel: vi.fn(),
    })));
    expect(container.textContent).toContain("hyperliquid · mainnet");
    expect(container.textContent).toContain("BUY · IOC");
    expect(container.textContent).toContain("All-in modeled loss$5.25");
    expect(container.textContent).toContain("Stop + slippage loss$5");
    expect(container.textContent).toContain("Eligible fill62.5% · partial");
    expect(container.textContent).toContain("Move since binding+10.00 bp adverse");
    expect(container.textContent).toContain("Current displayed depth only");
    expect(container.textContent).toContain("Venue take-profit$110");
    expect(container.textContent).toContain("Venue stop-loss$95");
    expect(container.textContent).toContain("Protection modeHyperliquid native TP/SL");
    expect(container.textContent).toContain("Submits the bound entry plus venue-native take-profit and stop-loss protection");
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Confirm"));
    expect(confirm?.disabled).toBe(false);
    act(() => confirm?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disables confirmation and announces an invalidated execution context", () => {
    act(() => root.render(createElement(TerminalLiveSubmitReview, {
      review: snapshot(),
      liquidity: liquidity(),
      decision: { allowed: false, blocker: "execution_context_changed" },
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("context changed");
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Confirm"))?.disabled).toBe(true);
  });
});

function snapshot(): TerminalLiveSubmitReviewSnapshot {
  return {
    planDigest: "sha256:abcdef1234567890",
    previewCommitment: "preview-1",
    capturedEpoch: 7,
    venueId: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    timeInForce: "ioc",
    quoteNotionalUsd: "100",
    baseSize: "0.99009901",
    limitPrice: "101",
    invalidationLevel: "95",
    venueProtection: {
      mode: "venue_native_oco",
      takeProfitLevel: "110",
      stopLossLevel: "95",
      maxSlippageBps: 50,
    },
    maxSlippageBps: 50,
    executionReferencePrice: "100.5",
    riskBudgetUsd: "10",
    stopAndSlippageLossUsd: "5",
    roundTripCostLossUsd: "0.25",
    allInLossUsd: "5.25",
    feeBps: 5,
    bufferBps: 7,
    feeEvidenceAt: "2026-08-13T11:59:00.000Z",
    bufferEvidenceAt: "2026-08-13T11:59:00.000Z",
    marketFetchedAt: "2026-08-13T12:00:00.000Z",
    marketMaxAgeMs: 30_000,
    issuedAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
  };
}

function liquidity() {
  return {
    status: "partial" as const,
    fillPct: 62.5,
    filledNotionalUsd: 62.5,
    unfilledNotionalUsd: 37.5,
    vwap: 101,
    impactBps: 10,
    bookAgeMs: 450,
    currentExecutionReferencePrice: 100.6,
    adverseDriftBps: 10,
  };
}
