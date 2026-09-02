import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeSessionKey: undefined as string | undefined,
  sessions: new Map<string, Record<string, unknown>>(),
  turnkey: null as Record<string, unknown> | null,
  handleLogin: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  getActiveSessionKey: vi.fn(async () => state.activeSessionKey),
  getSession: vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
    state.sessions.get(sessionKey)),
}));

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID = "parent-org";
  process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID = "auth-proxy";
});

vi.mock("@turnkey/react-wallet-kit", () => ({
  TurnkeyProvider: ({ children }: { children: React.ReactNode }) => children,
  useTurnkey: () => state.turnkey,
}));

vi.mock("./thumper-auth-context", () => ({
  useThumperAuth: () => ({
    authenticated: true,
    loading: false,
    user: { id: "ghola-user", email: "user@example.com" },
  }),
}));

vi.mock("./turnkey-provider", () => ({
  opaqueTurnkeyWalletScope: () => "a".repeat(64),
}));

import {
  PerpsTurnkeyProvider,
  usePerpsTurnkey,
} from "./perps-turnkey-provider";
import { TURNKEY_AUTH_MODAL_CLOSED_EVENT } from "./turnkey-auth-single-flight";

type PerpsTurnkeyContext = ReturnType<typeof usePerpsTurnkey>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function makeTurnkey(authenticated = false) {
  return {
    clientState: "ready",
    authState: authenticated ? "authenticated" : "unauthenticated",
    session: authenticated ? { token: "session-token" } : null,
    user: { authenticators: [] },
    wallets: [],
    httpClient: null,
    getActiveSessionKey: state.getActiveSessionKey,
    getSession: state.getSession,
    handleLogin: state.handleLogin,
    logout: state.logout,
  };
}

function Probe({ onValue }: { onValue: (value: PerpsTurnkeyContext) => void }) {
  const value = usePerpsTurnkey();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

describe("perps Turnkey modal reconciliation lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: PerpsTurnkeyContext | null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    state.activeSessionKey = undefined;
    state.sessions.clear();
    state.handleLogin.mockClear();
    state.logout.mockClear();
    state.getActiveSessionKey.mockClear();
    state.getSession.mockClear();
    state.turnkey = makeTurnkey();
    current = null;
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          operation: () => unknown,
        ) => operation(),
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("keeps one close reconciliation alive across the Turnkey auth rerender", async () => {
    await render();
    await act(async () => current!.login());
    const attemptId = state.handleLogin.mock.calls[0]?.[0]?.sessionKey as string;

    window.dispatchEvent(new Event(TURNKEY_AUTH_MODAL_CLOSED_EVENT));
    state.activeSessionKey = attemptId;
    state.turnkey = makeTurnkey(true);
    await render();
    state.sessions.set(attemptId, {
      sessionType: "SESSION_TYPE_READ_WRITE",
      userId: "turnkey-user",
      organizationId: "turnkey-org",
      expiry: Math.floor(Date.now() / 1_000) + 3_600,
      token: "session-token",
      publicKey: "public-key",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(current?.authenticated).toBe(true);
    expect(current?.organizationId).toBe("turnkey-org");
  });

  it("releases a timed-out attempt for an immediate fresh retry", async () => {
    await render();
    await act(async () => current!.login());
    state.getActiveSessionKey.mockClear();
    window.dispatchEvent(new Event(TURNKEY_AUTH_MODAL_CLOSED_EVENT));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    window.dispatchEvent(new Event(TURNKEY_AUTH_MODAL_CLOSED_EVENT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_250);
      await Promise.resolve();
    });
    await act(async () => current!.login());

    expect(state.getActiveSessionKey).toHaveBeenCalledTimes(11);
    expect(state.handleLogin).toHaveBeenCalledTimes(2);
    expect(state.handleLogin.mock.calls[1]?.[0]?.sessionKey)
      .not.toBe(state.handleLogin.mock.calls[0]?.[0]?.sessionKey);
  });

  async function render() {
    await act(async () => {
      root.render(
        <PerpsTurnkeyProvider>
          <Probe onValue={(value) => { current = value; }} />
        </PerpsTurnkeyProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current).not.toBeNull();
  }
});
