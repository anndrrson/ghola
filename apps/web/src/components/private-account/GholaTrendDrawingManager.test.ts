import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GholaTrendDrawingManager } from "./GholaTrendDrawingManager";

describe("GholaTrendDrawingManager", () => {
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

  it("lists bounded exact anchors and deletes only the selected line", () => {
    const onDelete = vi.fn();
    act(() => root.render(createElement(GholaTrendDrawingManager, {
      drawings: [drawing("a", "segment"), drawing("b", "ray")],
      disabled: false,
      disabledReason: null,
      onDelete,
    })));

    expect(container.textContent).toContain("Drawing manager · 2");
    expect(container.textContent).toContain("Segment");
    expect(container.textContent).toContain("Ray →");
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    act(() => buttons[1]?.click());
    expect(onDelete).toHaveBeenCalledWith("b");
    expect(container.textContent).toContain("recoverable with TL redo");
  });

  it("fails closed with an accessible reason", () => {
    act(() => root.render(createElement(GholaTrendDrawingManager, {
      drawings: [drawing("a", "segment")],
      disabled: true,
      disabledReason: "Drawings are read-only during historical replay.",
      onDelete: vi.fn(),
    })));
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toContain("historical replay");
  });
});

function drawing(id: string, kind: "segment" | "ray") {
  return {
    id,
    kind,
    first: { time: Date.parse("2026-08-13T12:00:00.000Z"), price: 100 },
    second: { time: Date.parse("2026-08-13T12:05:00.000Z"), price: 101 },
  };
}
