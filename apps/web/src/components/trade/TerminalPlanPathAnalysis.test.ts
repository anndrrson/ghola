import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalPlanPathAnalysis as PlanPath } from "@/lib/terminal-plan-path-analysis";
import { TerminalPlanPathAnalysis } from "./TerminalPlanPathAnalysis";

describe("TerminalPlanPathAnalysis", () => {
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

  it("renders bounded path outcome and explicit model limits", () => {
    act(() => root.render(createElement(TerminalPlanPathAnalysis, {
      analysis: analysis(), replay: false, sourceFresh: true,
    })));
    expect(container.textContent).toContain("target first");
    expect(container.textContent).toContain("500 bp · $50.00");
    expect(container.textContent).toContain("Newest and entry bars are excluded");
    expect(container.textContent).toContain("No fill, queue, gap, fee, or probability claim");
  });

  it("fails visibly closed when source history is not certified", () => {
    act(() => root.render(createElement(TerminalPlanPathAnalysis, {
      analysis: analysis(), replay: false, sourceFresh: false,
    })));
    expect(container.textContent).toContain("paused");
    expect(container.textContent).toContain("Unavailable until certified candle history");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

function analysis(): PlanPath {
  return {
    outcome: "target_first",
    sampleSize: 20,
    entryBarIndex: 3,
    entryTouchedAt: 1,
    barsToEntry: 3,
    postEntryBars: 4,
    terminalTouchedAt: 2,
    maxFavorableExcursionBps: 500,
    maxAdverseExcursionBps: 100,
    maxFavorableExcursionUsd: 50,
    maxAdverseExcursionUsd: 10,
  };
}
