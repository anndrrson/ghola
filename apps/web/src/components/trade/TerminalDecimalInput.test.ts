import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalDecimalInput } from "./TerminalDecimalInput";

describe("TerminalDecimalInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("preserves cents and incomplete drafts without multiplying magnitude", () => {
    const onValue = vi.fn();
    const onStatus = vi.fn();
    act(() => root.render(createElement(Harness, { onValue, onStatus })));
    const input = container.querySelector("input")!;

    change(input, "25.");
    expect(input.value).toBe("25.");
    expect(onValue).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("incomplete");

    change(input, "25.50");
    expect(input.value).toBe("25.50");
    expect(onValue).toHaveBeenLastCalledWith(25.5);
    expect(onStatus).toHaveBeenLastCalledWith("valid");
    expect(container.querySelector("output")?.textContent).toBe("25.5");
  });

  it("keeps invalid values local, explains the blocker, and reverts on blur", () => {
    const onValue = vi.fn();
    act(() => root.render(createElement(Harness, { onValue })));
    const input = container.querySelector("input")!;

    act(() => input.focus());
    change(input, "250");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Maximum 100.");
    expect(container.querySelector("output")?.textContent).toBe("25");
    act(() => input.blur());
    expect(input.value).toBe("25");
  });

  it("restores the pre-edit value on Escape", () => {
    const onValue = vi.fn();
    act(() => root.render(createElement(Harness, { onValue })));
    const input = container.querySelector("input")!;
    change(input, "30.25");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("output")?.textContent).toBe("25");
    expect(input.value).toBe("25");
  });
});

function Harness({ onValue, onStatus }: { onValue: (value: number | null) => void; onStatus?: (status: "settled" | "valid" | "incomplete" | "invalid") => void }) {
  const [value, setValue] = useState<number | null>(25);
  return createElement("div", null,
    createElement(TerminalDecimalInput, {
      "aria-label": "Order value",
      value,
      bounds: { min: 1, max: 100, maxFractionDigits: 2 },
      onValueChange(next) {
        onValue(next);
        setValue(next);
      },
      onDraftStatusChange: onStatus,
    }),
    createElement("output", null, String(value)),
  );
}

function change(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
