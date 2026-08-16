import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRouteCheckControl } from "./TerminalRouteCheckControl";

describe("TerminalRouteCheckControl", () => {
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

  it("starts an explicit check without exposing execution", () => {
    const onOpen = vi.fn();
    render({ active: false, onOpen });

    click(buttonNamed("Check compatible routes"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Peer public feeds stay off until requested");
    expect(container.textContent).toContain("never preview or submit");
  });

  it("opens or stops an active on-demand check", () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    render({ active: true, onOpen, onStop });

    expect(container.textContent).toContain("2/3 venues live · full visible route");
    click(buttonNamed("View route matrix"));
    click(buttonNamed("Stop peer feeds"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("leaves feed ownership with Compare mode", () => {
    render({ active: true, compareMode: true });
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Stop peer feeds");
  });

  function render(overrides: Partial<ComponentProps<typeof TerminalRouteCheckControl>> = {}) {
    act(() => root.render(createElement(TerminalRouteCheckControl, {
      active: false,
      compareMode: false,
      liveVenueCount: 2,
      totalVenueCount: 3,
      status: "full_available",
      onOpen: vi.fn(),
      onStop: vi.fn(),
      ...overrides,
    })));
  }

  function buttonNamed(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`button_not_found:${label}`);
    return button;
  }
});

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
