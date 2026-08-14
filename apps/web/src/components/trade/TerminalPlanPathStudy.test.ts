import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalPlanPathStudy as PathStudy } from "@/lib/terminal-plan-path-study";
import { TerminalPlanPathStudy } from "./TerminalPlanPathStudy";

describe("TerminalPlanPathStudy", () => {
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

  it("renders resolved evidence and explicit exclusions", () => {
    act(() => root.render(createElement(TerminalPlanPathStudy, {
      studies: studies(), replay: false, sourceFresh: true,
    })));
    expect(container.textContent).toContain("4 episodes · 20 bars");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("+0.50R");
    expect(container.textContent).toContain("5 bars");
    expect(container.textContent).toContain("50 bars");
    expect(container.textContent).toContain("Ambiguous and unresolved episodes are excluded");
    expect(container.textContent).toContain("Descriptive only");
  });

  it("fails visibly closed for uncertified history", () => {
    act(() => root.render(createElement(TerminalPlanPathStudy, {
      studies: studies(), replay: false, sourceFresh: false,
    })));
    expect(container.textContent).toContain("paused");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

function studies(): PathStudy[] {
  const primary: PathStudy = {
    status: "ready",
    blocker: null,
    sampleSize: 120,
    horizonBars: 20,
    episodeCount: 4,
    resolvedCount: 2,
    targetFirstCount: 1,
    stopFirstCount: 1,
    ambiguousCount: 1,
    unresolvedCount: 1,
    targetFirstRatePct: 50,
    expectancyR: 0.5,
    rewardRiskRatio: 2,
    medianBarsToResolution: 3,
  };
  return [
    { ...primary, horizonBars: 5, episodeCount: 5, unresolvedCount: 3 },
    primary,
    { ...primary, horizonBars: 50, episodeCount: 3, unresolvedCount: 0 },
  ];
}
