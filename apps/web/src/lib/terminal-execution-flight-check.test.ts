import { describe, expect, it } from "vitest";
import { deriveTerminalExecutionFlightCheck, type TerminalExecutionFlightInput } from "./terminal-execution-flight-check";

describe("terminal execution flight check", () => {
  it("reports a fully ready remote execution path", () => {
    const check = deriveTerminalExecutionFlightCheck(input());
    expect(check).toMatchObject({ ready: true, completedCount: 10, applicableCount: 10, blockingCount: 0, warningCount: 0, firstBlocker: null });
    expect(check.stages.find((stage) => stage.id === "signature")?.status).toBe("not_applicable");
  });

  it("ranks the first blocker and points to its exact field", () => {
    const check = deriveTerminalExecutionFlightCheck(input({
      marketReady: false,
      marketReason: "Quote expired.",
      ticketDraftBlocker: "notional",
      riskReady: false,
    }));
    expect(check.firstBlocker).toMatchObject({ id: "market", status: "pending" });
    expect(check.blockingCount).toBe(3);
    expect(check.firstBlocker?.action).toMatchObject({ type: "focus_element", elementId: "terminal-refresh-market" });
    expect(check.stages.find((stage) => stage.id === "ticket")?.action).toEqual({
      type: "focus_ticket_field", field: "notional", label: "Focus notional",
    });
  });

  it("allows portfolio warnings without claiming they are safe", () => {
    const check = deriveTerminalExecutionFlightCheck(input({
      portfolioStatus: "warning",
      portfolioReady: true,
      portfolioReason: "Margin utilization is elevated.",
    }));
    expect(check.ready).toBe(true);
    expect(check.warningCount).toBe(1);
    expect(check.stages.find((stage) => stage.id === "portfolio")).toMatchObject({ status: "warning", detail: "Margin utilization is elevated." });
  });

  it("keeps a visible-liquidity shortfall non-authorizing but impossible to miss", () => {
    const check = deriveTerminalExecutionFlightCheck(input({
      liquidityStatus: "partial",
      liquidityReason: "Visible asks cover 40%; $60 remains unfilled.",
      liquidityRecovery: null,
    }));
    expect(check).toMatchObject({ ready: true, blockingCount: 0, warningCount: 1 });
    expect(check.stages.find((stage) => stage.id === "liquidity")).toEqual({
      id: "liquidity",
      label: "Visible liquidity",
      status: "warning",
      detail: "Visible asks cover 40%; $60 remains unfilled.",
      action: { type: "focus_element", elementId: "terminal-market-depth", label: "Inspect visible depth" },
    });
  });

  it("targets an explicit certified safe-size control when one is available", () => {
    const check = deriveTerminalExecutionFlightCheck(input({
      liquidityStatus: "partial",
      liquidityReason: "Visible asks cover 40%; $60 remains unfilled.",
      liquidityRecovery: { elementId: "terminal-apply-safe-size", label: "Review reduction cap $40.00" },
    }));
    expect(check.stages.find((stage) => stage.id === "liquidity")?.action).toEqual({
      type: "focus_element",
      elementId: "terminal-apply-safe-size",
      label: "Review reduction cap $40.00",
    });
  });

  it("makes preview not applicable and exposes the local safety lock", () => {
    const check = deriveTerminalExecutionFlightCheck(input({ localPreview: true, previewState: "unavailable" }));
    expect(check.stages.find((stage) => stage.id === "preview")?.status).toBe("not_applicable");
    expect(check.stages.filter((stage) => ["portfolio", "identity", "venue", "preview", "signature"].includes(stage.id)).every((stage) => stage.status === "not_applicable")).toBe(true);
    expect(check.firstBlocker).toMatchObject({ id: "mode", status: "blocked" });
  });

  it("distinguishes missing and invalid signed material", () => {
    expect(deriveTerminalExecutionFlightCheck(input({ signatureState: "missing" })).firstBlocker)
      .toMatchObject({ id: "signature", status: "pending", action: { elementId: "signed-live-payload" } });
    expect(deriveTerminalExecutionFlightCheck(input({ signatureState: "invalid" })).firstBlocker)
      .toMatchObject({ id: "signature", status: "blocked" });
  });

  it("blocks on unresolved or unavailable durable execution history", () => {
    expect(deriveTerminalExecutionFlightCheck(input({ journalState: "unresolved" })).firstBlocker)
      .toMatchObject({ id: "journal", status: "blocked", action: { elementId: "live-execution-journal" } });
    expect(deriveTerminalExecutionFlightCheck(input({ journalState: "blocked" })).ready).toBe(false);
  });
});

function input(overrides: Partial<TerminalExecutionFlightInput> = {}): TerminalExecutionFlightInput {
  return {
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
    signatureRecoveryElementId: "signed-live-payload",
    journalState: "ready",
    ...overrides,
  };
}
