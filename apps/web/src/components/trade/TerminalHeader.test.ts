import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalHeader, type TerminalHeaderProps } from "./TerminalHeader";

const renderProbe = vi.hoisted(() => ({ logoCount: 0 }));

vi.mock("@/components/GholaLogo", () => ({
  GholaLogo: () => {
    renderProbe.logoCount += 1;
    return null;
  },
}));

vi.mock("@/components/trade/TerminalCommandPalette", () => ({
  TerminalCommandPalette: () => null,
}));

vi.mock("@/components/trade/TerminalWorkspacePresets", () => ({
  TerminalWorkspacePresets: () => null,
}));

describe("TerminalHeader", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renderProbe.logoCount = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("bails out when a parent market tick leaves its cold props unchanged", () => {
    const props = headerProps();
    act(() => root.render(createElement(TerminalHeader, props)));
    expect(renderProbe.logoCount).toBe(1);

    act(() => root.render(createElement(TerminalHeader, { ...props })));
    expect(renderProbe.logoCount).toBe(1);

    act(() => root.render(createElement(TerminalHeader, { ...props, marketStatusValue: "polling" })));
    expect(renderProbe.logoCount).toBe(2);
  });

  it("preserves inert state and routes both auth actions", () => {
    const onOpenAuth = vi.fn();
    act(() => root.render(createElement(TerminalHeader, headerProps({ inert: true, onOpenAuth }))));

    expect(container.querySelector("header")?.hasAttribute("inert")).toBe(true);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    act(() => buttons.find((button) => button.textContent === "Sign in")?.click());
    act(() => buttons.find((button) => button.textContent === "Get started")?.click());
    expect(onOpenAuth.mock.calls).toEqual([["signin"], ["signup"]]);
  });

  it("annunciates unread alerts and opens triage without breaking cold memoization", () => {
    const onCommand = vi.fn();
    const props = headerProps({ onCommand });
    act(() => root.render(createElement(TerminalHeader, props)));
    const initialRenders = renderProbe.logoCount;

    act(() => root.render(createElement(TerminalHeader, { ...props, alertSummary: { scope: "BTC", activeCount: 1, primaryActiveLabel: "Feed health below 60", unreadCount: 2, latestUnreadLabel: "Plan entry crossed above", latestTriggeredAt: 1_000 } })));

    expect(renderProbe.logoCount).toBe(initialRenders + 1);
    const alertButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open local alerts, 1 active, 2 unread"]');
    expect(alertButton?.title).toBe("BTC · Feed health below 60 · Plan entry crossed above");
    expect(alertButton?.textContent).toContain("!1");
    expect(alertButton?.getAttribute("aria-keyshortcuts")).toBe("L");
    act(() => alertButton?.click());
    expect(onCommand).toHaveBeenCalledWith({ type: "open_alerts" });
  });
});

function headerProps(overrides: Partial<TerminalHeaderProps> = {}): TerminalHeaderProps {
  return {
    authenticated: false,
    alertSummary: { scope: null, activeCount: 0, primaryActiveLabel: null, unreadCount: 0, latestUnreadLabel: null, latestTriggeredAt: null },
    byoLiveEnabled: false,
    inert: false,
    keyboardMessage: "",
    localPreview: true,
    marketStatusTone: "good",
    marketStatusValue: "live",
    pooledStatusTone: "warn",
    pooledStatusValue: "off",
    userEmail: null,
    workerStatusTone: "warn",
    workerStatusValue: "local off",
    onCommand: vi.fn(),
    onCaptureWorkspace: vi.fn(),
    onLoadWorkspace: vi.fn(),
    onOpenAuth: vi.fn(),
    ...overrides,
  };
}
