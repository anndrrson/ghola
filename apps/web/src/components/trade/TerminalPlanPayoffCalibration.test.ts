import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalPlanPayoffCalibration as Calibration } from "@/lib/terminal-plan-payoff-calibration";
import { TerminalPlanPayoffCalibration } from "./TerminalPlanPayoffCalibration";

describe("TerminalPlanPayoffCalibration", () => {
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

  it("renders the break-even comparison and explicit model limits", () => {
    act(() => root.render(createElement(TerminalPlanPayoffCalibration, {
      calibration: calibration(), replay: false,
    })));

    expect(container.textContent).toContain("interval above break-even");
    expect(container.textContent).toContain("62.5%");
    expect(container.textContent).toContain("33.3%");
    expect(container.textContent).toContain("+29.2 pp");
    expect(container.textContent).toContain("38.6–81.5%");
    expect(container.textContent).toContain("Descriptive calibration only");
    expect(container.textContent).toContain("not a probability");
  });

  it("fails visibly closed without resolved payoff evidence", () => {
    act(() => root.render(createElement(TerminalPlanPayoffCalibration, {
      calibration: { ...calibration(), status: "unavailable", blocker: "payoff_invalid", resolvedHitRatePct: null, hitRateLowerPct: null, hitRateUpperPct: null, requiredWinRatePct: null, edgeMarginPct: null, modeledExpectancyUsd: null, resolutionCoveragePct: null, assessment: null },
      replay: true,
    })));

    expect(container.textContent).toContain("paused");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).toContain("Revealed replay prefix");
  });
});

function calibration(): Calibration {
  return {
    status: "ready",
    blocker: null,
    horizonBars: 20,
    episodeCount: 20,
    resolvedCount: 16,
    resolvedHitRatePct: 62.5,
    hitRateLowerPct: 38.64,
    hitRateUpperPct: 81.52,
    requiredWinRatePct: 33.3333,
    edgeMarginPct: 29.1667,
    modeledExpectancyUsd: 8.75,
    resolutionCoveragePct: 80,
    assessment: "above_break_even",
  };
}
