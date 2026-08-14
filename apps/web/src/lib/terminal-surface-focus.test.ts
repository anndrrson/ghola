import { afterEach, describe, expect, it, vi } from "vitest";
import { focusTerminalSurfaceWhenReady } from "./terminal-surface-focus";

describe("terminal surface focus", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("focuses an existing exact target immediately", async () => {
    const target = focusable("target");
    expect(await focusTerminalSurfaceWhenReady({ targetId: "target" })).toBe("target");
    expect(document.activeElement).toBe(target);
  });

  it("waits for a lazy target and then focuses it", async () => {
    const fallback = focusable("fallback");
    const result = focusTerminalSurfaceWhenReady({ targetId: "target", fallbackId: "fallback", timeoutMs: 1_000 });
    const target = focusable("target");

    expect(await result).toBe("target");
    expect(document.activeElement).toBe(target);
    expect(document.activeElement).not.toBe(fallback);
  });

  it("falls back after a bounded wait and supports cancellation", async () => {
    vi.useFakeTimers();
    const fallback = focusable("fallback");
    const timed = focusTerminalSurfaceWhenReady({ targetId: "missing", fallbackId: "fallback", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await timed).toBe("fallback");
    expect(document.activeElement).toBe(fallback);

    const controller = new AbortController();
    const cancelled = focusTerminalSurfaceWhenReady({ targetId: "still-missing", fallbackId: "fallback", signal: controller.signal });
    controller.abort();
    expect(await cancelled).toBe("cancelled");
  });
});

function focusable(id: string) {
  const element = document.createElement("section");
  element.id = id;
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}
