import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalColumnResizeHandle,
  terminalRightPanelWidthFromDrag,
  terminalRightPanelWidthFromKey,
} from "./TerminalColumnResizeHandle";

describe("TerminalColumnResizeHandle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes an adjustable separator and routes bounded keyboard changes", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(TerminalColumnResizeHandle, {
      controls: "order-ticket",
      cssVariable: "--terminal-ticket-width",
      defaultValue: 400,
      label: "Resize order ticket",
      min: 320,
      max: 480,
      value: 400,
      onChange,
    })));
    const separator = container.querySelector<HTMLElement>('[role="separator"]');
    expect(separator?.getAttribute("aria-controls")).toBe("order-ticket");
    expect(separator?.getAttribute("aria-valuetext")).toBe("400 pixels");

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      act(() => separator?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    }
    expect(onChange.mock.calls.map(([next]) => next)).toEqual([416, 384, 320, 480]);
  });

  it("uses leftward movement to enlarge a right panel and clamps every path", () => {
    expect(terminalRightPanelWidthFromDrag(400, 800, 760, 320, 480)).toBe(440);
    expect(terminalRightPanelWidthFromDrag(400, 800, 500, 320, 480)).toBe(480);
    expect(terminalRightPanelWidthFromDrag(400, 800, 1_000, 320, 480)).toBe(320);
    expect(terminalRightPanelWidthFromKey(475, "ArrowLeft", { min: 320, max: 480, defaultValue: 400 })).toBe(480);
    expect(terminalRightPanelWidthFromKey(325, "ArrowRight", { min: 320, max: 480, defaultValue: 400 })).toBe(320);
    expect(terminalRightPanelWidthFromKey(400, "Enter", { min: 320, max: 480, defaultValue: 400 })).toBeNull();
  });

  it("previews pointer motion locally and commits once on release", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement("div", { style: { "--terminal-ticket-width": "400px" } },
      createElement(TerminalColumnResizeHandle, {
        controls: "order-ticket",
        cssVariable: "--terminal-ticket-width",
        defaultValue: 400,
        label: "Resize order ticket",
        min: 320,
        max: 480,
        value: 400,
        onChange,
      }),
    )));
    const separator = container.querySelector<HTMLElement>('[role="separator"]');
    act(() => separator?.dispatchEvent(pointerEvent("pointerdown", { button: 0, clientX: 800, isPrimary: true, pointerId: 7 })));
    act(() => separator?.dispatchEvent(pointerEvent("pointermove", { clientX: 760, pointerId: 7 })));
    expect(onChange).not.toHaveBeenCalled();
    expect(separator?.parentElement?.parentElement?.style.getPropertyValue("--terminal-ticket-width")).toBe("440px");
    expect(separator?.getAttribute("aria-valuenow")).toBe("440");

    act(() => separator?.dispatchEvent(pointerEvent("pointerup", { clientX: 760, pointerId: 7 })));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(440);
  });

  it("restores a cancelled pointer preview without committing it", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement("div", { style: { "--terminal-ticket-width": "400px" } },
      createElement(TerminalColumnResizeHandle, {
        controls: "order-ticket",
        cssVariable: "--terminal-ticket-width",
        defaultValue: 400,
        label: "Resize order ticket",
        min: 320,
        max: 480,
        value: 400,
        onChange,
      }),
    )));
    const separator = container.querySelector<HTMLElement>('[role="separator"]');
    act(() => separator?.dispatchEvent(pointerEvent("pointerdown", { button: 0, clientX: 800, isPrimary: true, pointerId: 8 })));
    act(() => separator?.dispatchEvent(pointerEvent("pointermove", { clientX: 740, pointerId: 8 })));
    act(() => separator?.dispatchEvent(pointerEvent("pointercancel", { clientX: 740, pointerId: 8 })));

    expect(onChange).not.toHaveBeenCalled();
    expect(separator?.parentElement?.parentElement?.style.getPropertyValue("--terminal-ticket-width")).toBe("400px");
    expect(separator?.getAttribute("aria-valuenow")).toBe("400");
  });
});

function pointerEvent(type: string, fields: Record<string, number | boolean>) {
  const event = new Event(type, { bubbles: true });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}
