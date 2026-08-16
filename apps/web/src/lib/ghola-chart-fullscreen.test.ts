import { describe, expect, it, vi } from "vitest";
import {
  gholaChartFullscreenElement,
  gholaChartFullscreenSupported,
  toggleGholaChartFullscreen,
  type GholaChartFullscreenDocument,
  type GholaChartFullscreenTarget,
} from "./ghola-chart-fullscreen";

describe("ghola chart fullscreen", () => {
  it("enters and exits only the chart's own native fullscreen session", async () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const target: GholaChartFullscreenTarget = { requestFullscreen: enter };
    const documentLike: GholaChartFullscreenDocument = { fullscreenElement: null, exitFullscreen: exit };

    expect(await toggleGholaChartFullscreen(documentLike, target)).toBe("enter_requested");
    expect(enter).toHaveBeenCalledOnce();
    documentLike.fullscreenElement = target as Element;
    expect(await toggleGholaChartFullscreen(documentLike, target)).toBe("exit_requested");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("never exits or replaces another element's fullscreen session", async () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const target: GholaChartFullscreenTarget = { requestFullscreen: enter };
    const documentLike: GholaChartFullscreenDocument = {
      fullscreenElement: {} as Element,
      exitFullscreen: exit,
    };

    expect(await toggleGholaChartFullscreen(documentLike, target)).toBe("occupied");
    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("supports WebKit fullscreen and fails closed when no complete API exists", async () => {
    const enter = vi.fn();
    const target: GholaChartFullscreenTarget = { webkitRequestFullscreen: enter };
    const documentLike: GholaChartFullscreenDocument = {
      webkitFullscreenElement: null,
      webkitExitFullscreen: vi.fn(),
    };

    expect(gholaChartFullscreenElement(documentLike)).toBeNull();
    expect(gholaChartFullscreenSupported(documentLike, target)).toBe(true);
    expect(await toggleGholaChartFullscreen(documentLike, target)).toBe("enter_requested");
    expect(await toggleGholaChartFullscreen({}, target)).toBe("unsupported");
  });

  it("reports rejected browser requests without changing state", async () => {
    const target: GholaChartFullscreenTarget = {
      requestFullscreen: vi.fn().mockRejectedValue(new Error("denied")),
    };
    const documentLike: GholaChartFullscreenDocument = {
      fullscreenElement: null,
      exitFullscreen: vi.fn(),
    };

    expect(await toggleGholaChartFullscreen(documentLike, target)).toBe("failed");
  });
});
