import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEntryTargetSurface as Surface } from "@/lib/terminal-entry-target-surface";
import { TerminalEntryTargetSurface } from "./TerminalEntryTargetSurface";

describe("TerminalEntryTargetSurface", () => {
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

  it("renders joint execution/evidence cells and stages one exact combination", () => {
    const onStage = vi.fn();
    act(() => root.render(createElement(TerminalEntryTargetSurface, {
      surface: surface(),
      selectedEntryPrice: 100,
      selectedMultiple: 2,
      replay: false,
      onStage,
    })));
    expect(container.textContent).toContain("Entry × target surface");
    expect(container.textContent).toContain("fill 100% · budget pass");
    expect(container.textContent).toContain("above BE");
    expect(container.textContent).toContain("never previews or submits");
    const action = container.querySelector<HTMLButtonElement>('[aria-label^="Stage cross entry 101 with 3.0R"]');
    if (!action) throw new Error("joint stage action missing");
    act(() => action.click());
    expect(onStage).toHaveBeenCalledWith("cross", 101, 3, 107);
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain("selected");
  });

  it("keeps degraded prices visible but disables all staging in replay", () => {
    const onStage = vi.fn();
    const degraded = surface();
    degraded.status = "degraded";
    degraded.blocker = "historical_evidence_unavailable";
    for (const row of degraded.rows) {
      for (const cell of row.cells) {
        cell.evidenceStatus = "unavailable";
        cell.resolvedHitRatePct = null;
        cell.requiredWinRatePct = null;
      }
    }
    act(() => root.render(createElement(TerminalEntryTargetSurface, {
      surface: degraded,
      selectedEntryPrice: 100,
      selectedMultiple: 2,
      replay: true,
      onStage,
    })));
    expect(container.textContent).toContain("prices only");
    expect(container.textContent).toContain("Historical evidence is unavailable");
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain("Historical replay is read-only");
  });

  it("fails visibly closed without certified entry outcomes", () => {
    act(() => root.render(createElement(TerminalEntryTargetSurface, {
      surface: { status: "unavailable", blocker: "entry_outcomes_unavailable", horizonBars: 20, rows: [] },
      selectedEntryPrice: null,
      selectedMultiple: 2,
      replay: false,
      onStage: vi.fn(),
    })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("paused");
    expect(container.querySelector("button")).toBeNull();
  });
});

function surface(): Surface {
  return {
    status: "ready",
    blocker: null,
    horizonBars: 20,
    rows: [
      row("join", 99, 0, false),
      row("current", 100, 50, true),
      row("cross", 101, 100, true),
    ],
  };
}

function row(
  mode: "join" | "current" | "cross",
  entryPrice: number,
  fillPct: number,
  budgetAllowed: boolean,
): Surface["rows"][number] {
  return {
    mode,
    entryPrice,
    intent: mode === "cross" ? "marketable" : "resting",
    visibleFillPct: fillPct,
    budgetAllowed,
    invalidationPrice: entryPrice - 2,
    cells: ([1, 1.5, 2, 3] as const).map((rewardMultiple) => ({
      rewardMultiple,
      targetPrice: entryPrice + 2 * rewardMultiple,
      targetProfitUsd: 20 * rewardMultiple,
      evidenceStatus: "ready" as const,
      resolvedCount: 20,
      resolvedHitRatePct: 60,
      hitRateLowerPct: 40,
      hitRateUpperPct: 78,
      requiredWinRatePct: 40,
      assessment: "above_break_even" as const,
    })),
  };
}
