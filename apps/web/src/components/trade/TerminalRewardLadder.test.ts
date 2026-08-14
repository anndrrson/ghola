import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRewardLadder as RewardLadder } from "@/lib/terminal-reward-ladder";
import { TerminalRewardLadder } from "./TerminalRewardLadder";

describe("TerminalRewardLadder", () => {
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

  it("renders the target tradeoff and honest evidence labels", () => {
    const onStage = vi.fn();
    act(() => root.render(createElement(TerminalRewardLadder, {
      ladder: ready(),
      replay: false,
      selectedMultiple: 1.5,
      onStage,
    })));
    expect(container.textContent).toContain("1.5R · selected");
    expect(container.textContent).toContain("interval above");
    expect(container.textContent).toContain("thin · inconclusive");
    expect(container.textContent).toContain("Wilson 95% intervals");
    expect(container.textContent).toContain("not a target recommendation");
    expect(container.querySelector("caption")?.textContent).toContain("break-even rate");
    const target = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("3.0R"));
    act(() => target?.click());
    expect(onStage).toHaveBeenCalledWith(3, 106);
  });

  it("fails visibly closed without history", () => {
    act(() => root.render(createElement(TerminalRewardLadder, {
      ladder: { status: "unavailable", blocker: "history_unavailable", horizonBars: 20, stopLossUsd: 10, rows: [] },
      replay: true,
      selectedMultiple: 2,
      onStage: vi.fn(),
    })));
    expect(container.textContent).toContain("paused");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).toContain("Revealed replay prefix");
  });

  it("keeps target staging read-only during replay", () => {
    const onStage = vi.fn();
    act(() => root.render(createElement(TerminalRewardLadder, {
      ladder: ready(),
      replay: true,
      selectedMultiple: 2,
      onStage,
    })));
    const target = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("3.0R"));
    expect(target?.disabled).toBe(true);
    act(() => target?.click());
    expect(onStage).not.toHaveBeenCalled();
  });

  it("keeps valid target prices stageable when historical evidence is unavailable", () => {
    const onStage = vi.fn();
    act(() => root.render(createElement(TerminalRewardLadder, {
      ladder: { ...ready(), status: "unavailable", blocker: "history_unavailable" },
      replay: false,
      selectedMultiple: 2,
      onStage,
    })));
    expect(container.textContent).toContain("Historical evidence is unavailable");
    const target = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("1.0R"));
    act(() => target?.click());
    expect(onStage).toHaveBeenCalledWith(1, 102);
  });
});

function ready(): RewardLadder {
  return {
    status: "ready",
    blocker: null,
    horizonBars: 20,
    stopLossUsd: 21,
    rows: [
      row(1, "thin_sample", "inconclusive"),
      row(1.5, "ready", "inconclusive"),
      row(2, "ready", "above_break_even"),
      row(3, "ready", "below_break_even"),
    ],
  };
}

function row(
  rewardMultiple: 1 | 1.5 | 2 | 3,
  status: "ready" | "thin_sample",
  assessment: "above_break_even" | "below_break_even" | "inconclusive",
): RewardLadder["rows"][number] {
  return {
    rewardMultiple,
    targetPrice: 100 + rewardMultiple * 2,
    targetProfitUsd: rewardMultiple * 20,
    status,
    resolvedCount: status === "ready" ? 16 : 4,
    episodeCount: status === "ready" ? 20 : 8,
    resolvedHitRatePct: 60,
    hitRateLowerPct: 38,
    hitRateUpperPct: 79,
    requiredWinRatePct: 40,
    assessment,
  };
}
