import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveTerminalExecutionFlightCheck } from "@/lib/terminal-execution-flight-check";
import { TerminalExecutionFlightCheck } from "./TerminalExecutionFlightCheck";

describe("TerminalExecutionFlightCheck", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("announces the primary blocker and exposes every remaining safe recovery action", () => {
    const onAction = vi.fn();
    const decision = deriveTerminalExecutionFlightCheck({
      localPreview: false,
      replayActive: false,
      authenticated: false,
      marketReady: true,
      marketReason: "Ready.",
      ticketDraftBlocker: null,
      orderPlanReady: true,
      invalidationReady: true,
      planMarketReady: true,
      planReason: "Ready.",
      riskReady: true,
      riskReason: "Within budget.",
      liquidityStatus: "full",
      liquidityReason: "Certified visible depth covers the requested size.",
      liquidityRecovery: null,
      portfolioStatus: "not_applicable",
      portfolioReady: true,
      portfolioReason: "Not applicable.",
      venueReady: false,
      venueReason: "Venue gate pending.",
      venueRecoveryElementId: "connection",
      previewState: "missing",
      signatureState: "not_required",
      signatureRecoveryElementId: null,
      journalState: "ready",
    });
    act(() => root.render(createElement(TerminalExecutionFlightCheck, { decision, onAction })));

    expect(container.textContent).toContain("Next · Identity: Sign in before binding or submitting an order.");
    expect(container.textContent).toContain("2 additional blockers · review all");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Sign in",
      "Review venue access",
      "Focus preview action",
    ]);
    act(() => buttons[0]?.click());
    expect(onAction).toHaveBeenCalledWith({ type: "open_auth", label: "Sign in" });
    act(() => buttons[1]?.click());
    expect(onAction).toHaveBeenCalledWith({ type: "focus_element", elementId: "connection", label: "Review venue access" });
  });

  it("renders a non-actionable ready state without implying submission", () => {
    const decision = deriveTerminalExecutionFlightCheck({
      localPreview: false,
      replayActive: false,
      authenticated: true,
      marketReady: true,
      marketReason: "Ready.",
      ticketDraftBlocker: null,
      orderPlanReady: true,
      invalidationReady: true,
      planMarketReady: true,
      planReason: "Ready.",
      riskReady: true,
      riskReason: "Within budget.",
      liquidityStatus: "full",
      liquidityReason: "Certified visible depth covers the requested size.",
      liquidityRecovery: null,
      portfolioStatus: "not_applicable",
      portfolioReady: true,
      portfolioReason: "Not applicable.",
      venueReady: true,
      venueReason: "Ready.",
      venueRecoveryElementId: null,
      previewState: "ready",
      signatureState: "not_required",
      signatureRecoveryElementId: null,
      journalState: "ready",
    });
    act(() => root.render(createElement(TerminalExecutionFlightCheck, { decision, onAction: vi.fn() })));
    expect(container.textContent).toContain("All local gates pass. Binding and submit remain explicit user actions.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("surfaces a certified liquidity warning while keeping hard-gate readiness explicit", () => {
    const onAction = vi.fn();
    const decision = deriveTerminalExecutionFlightCheck({
      localPreview: false,
      replayActive: false,
      authenticated: true,
      marketReady: true,
      marketReason: "Ready.",
      ticketDraftBlocker: null,
      orderPlanReady: true,
      invalidationReady: true,
      planMarketReady: true,
      planReason: "Ready.",
      riskReady: true,
      riskReason: "Within budget.",
      liquidityStatus: "partial",
      liquidityReason: "Visible asks cover 40%; $60 remains unfilled.",
      liquidityRecovery: { elementId: "terminal-apply-safe-size", label: "Review reduction cap $40.00" },
      portfolioStatus: "not_applicable",
      portfolioReady: true,
      portfolioReason: "Not applicable.",
      venueReady: true,
      venueReason: "Ready.",
      venueRecoveryElementId: null,
      previewState: "ready",
      signatureState: "not_required",
      signatureRecoveryElementId: null,
      journalState: "ready",
    });
    act(() => root.render(createElement(TerminalExecutionFlightCheck, { decision, onAction })));

    expect(container.textContent).toContain("ready · 1 warn");
    expect(container.textContent).toContain("Visible asks cover 40%; $60 remains unfilled.");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Review reduction cap $40.00");
    act(() => button?.click());
    expect(onAction).toHaveBeenCalledWith({
      type: "focus_element",
      elementId: "terminal-apply-safe-size",
      label: "Review reduction cap $40.00",
    });
  });
});
