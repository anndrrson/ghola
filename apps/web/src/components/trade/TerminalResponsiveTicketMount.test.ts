import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalResponsiveTicketMount } from "./TerminalResponsiveTicketMount";

describe("TerminalResponsiveTicketMount", () => {
  let container: HTMLDivElement;
  let root: Root;
  let desktop = false;
  let listeners: Set<() => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listeners = new Set();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: desktop,
      media: "(min-width: 1280px)",
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    desktop = false;
  });

  it("does not construct a closed mobile ticket, but mounts it immediately when opened", () => {
    const render = vi.fn(() => createElement("div", { "data-ticket-body": true }, "Ticket"));
    act(() => root.render(createElement(TerminalResponsiveTicketMount, { mobileOpen: false, render })));
    expect(render).not.toHaveBeenCalled();
    expect(container.querySelector("[data-ticket-body]")).toBeNull();

    act(() => root.render(createElement(TerminalResponsiveTicketMount, { mobileOpen: true, render })));
    expect(render).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Ticket");
  });

  it("keeps the ticket mounted on desktop and removes it across the mobile breakpoint", () => {
    const render = () => createElement("div", { "data-ticket-body": true }, "Ticket");
    act(() => root.render(createElement(TerminalResponsiveTicketMount, { mobileOpen: false, render })));

    act(() => {
      desktop = true;
      listeners.forEach((listener) => listener());
    });
    expect(container.querySelector("[data-ticket-body]")).not.toBeNull();

    act(() => {
      desktop = false;
      listeners.forEach((listener) => listener());
    });
    expect(container.querySelector("[data-ticket-body]")).toBeNull();
  });
});
