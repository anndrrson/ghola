import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAgentActivity, terminalAgentActivityPropsEqual, type TerminalAgentActivityProps } from "./TerminalAgentActivity";

const listSessions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/private-account-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/private-account-client")>(),
  listPrivateAutopilotSessions: listSessions,
}));

describe("TerminalAgentActivity", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    listSessions.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders localhost containment without starting activity polling", () => {
    act(() => root.render(createElement(TerminalAgentActivity, props({ authenticated: true, localPreview: true }))));
    expect(container.textContent).toContain("Runtime activity is intentionally offline");
    expect(container.textContent).toContain("No worker started");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("aborts a hung request and never overlaps polling", async () => {
    vi.useFakeTimers();
    listSessions.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    act(() => root.render(createElement(TerminalAgentActivity, props({ authenticated: true, authenticatedSubject: "user-1" }))));
    expect(listSessions).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.textContent).toContain("unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(listSessions).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("routes signed-out access and defines the exact cold-render bailout", () => {
    const onSignIn = vi.fn();
    const value = props({ onSignIn });
    act(() => root.render(createElement(TerminalAgentActivity, value)));
    act(() => container.querySelector("button")?.click());
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(terminalAgentActivityPropsEqual(value, { ...value })).toBe(true);
    expect(terminalAgentActivityPropsEqual(value, { ...value, authenticated: true })).toBe(false);
    expect(terminalAgentActivityPropsEqual(value, { ...value, authenticatedSubject: "other-user" })).toBe(false);
    expect(terminalAgentActivityPropsEqual(value, { ...value, onSignIn: vi.fn() })).toBe(false);
  });

  it("never commits a previous subject's delayed activity", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    listSessions
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ version: 1, autopilot_sessions: [] });
    act(() => root.render(createElement(TerminalAgentActivity, props({ authenticated: true, authenticatedSubject: "user-1" }))));
    await act(async () => {
      root.render(createElement(TerminalAgentActivity, props({ authenticated: true, authenticatedSubject: "user-2" })));
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst?.({ version: 1, autopilot_sessions: [{}] });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("No agent sessions yet");
    expect(container.textContent).not.toContain("failed strict validation");
  });
});

function props(overrides: Partial<TerminalAgentActivityProps> = {}): TerminalAgentActivityProps {
  return { authenticated: false, authenticatedSubject: null, localPreview: false, onSignIn: vi.fn(), ...overrides };
}
