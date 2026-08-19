import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthModal } from "./AuthModal";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  setAuth: vi.fn(),
  googleSignIn: vi.fn(),
  authHook: vi.fn(() => ({ setAuth: vi.fn() })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/thumper-auth-context", () => ({ useThumperAuth: () => {
  mocks.authHook();
  return { setAuth: mocks.setAuth };
} }));
vi.mock("@/lib/turnkey-provider", () => ({
  useTurnkeyWallet: () => ({ createWallet: vi.fn(), walletAddress: "wallet-ready" }),
}));
vi.mock("@/lib/thumper-api", () => ({
  thumperGoogleSignIn: mocks.googleSignIn,
  thumperSignIn: vi.fn(),
  thumperSignUp: vi.fn(),
}));

describe("AuthModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "google-client";
    mocks.googleSignIn.mockResolvedValue({
      token: "session-token",
      user: { id: "investor", email: "investor@example.com", name: "Investor" },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    delete (window as typeof window & { google?: unknown }).google;
  });

  it("opens as a named modal with associated fields and Escape handling", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(AuthModal, {
        mode: "signin",
        open: true,
        onClose,
        onModeChange: vi.fn(),
      }));
      await Promise.resolve();
    });

    const dialog = requiredElement<HTMLDivElement>(container, '[role="dialog"]');
    const email = requiredElement<HTMLInputElement>(dialog, 'input[type="email"]');
    const password = requiredElement<HTMLInputElement>(dialog, 'input[type="password"]');
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Welcome back");
    expect(email.labels?.[0]?.textContent?.trim()).toBe("Email");
    expect(password.labels?.[0]?.textContent?.trim()).toBe("Password");
    expect(document.activeElement).toBe(email);
    expect(document.body.style.overflow).toBe("hidden");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("bails out when a hot parent republishes identical closed-modal props", async () => {
    const onClose = vi.fn();
    const onModeChange = vi.fn();
    const props = { mode: "signin" as const, open: false, onClose, onModeChange, redirectTo: "/trade" };
    await act(async () => root.render(createElement(AuthModal, props)));
    const renders = mocks.authHook.mock.calls.length;

    await act(async () => root.render(createElement(AuthModal, { ...props })));

    expect(mocks.authHook).toHaveBeenCalledTimes(renders);
    expect(container.innerHTML).toBe("");
  });

  it("requires verified Google identity for an investor invitation", async () => {
    let credentialCallback: ((response: { credential: string }) => void) | null = null;
    const renderButton = vi.fn((element: HTMLElement) => {
      const button = document.createElement("button");
      button.textContent = "Continue with Google";
      element.appendChild(button);
    });
    (window as typeof window & { google?: GoogleIdentityMock }).google = {
      accounts: { id: {
        initialize: ({ callback }) => { credentialCallback = callback; },
        renderButton,
      } },
    };
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(AuthModal, {
        mode: "signup",
        open: true,
        onClose,
        onModeChange: vi.fn(),
        redirectTo: null,
        verifiedEmailRequired: true,
      }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Verify the invited email");
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(renderButton).toHaveBeenCalledOnce();
    await act(async () => {
      if (!credentialCallback) throw new Error("Google credential callback missing");
      credentialCallback({ credential: "verified-google-token" });
      credentialCallback({ credential: "duplicate-google-token" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.googleSignIn).toHaveBeenCalledOnce();
    expect(mocks.googleSignIn).toHaveBeenCalledWith("verified-google-token");
    expect(mocks.setAuth).toHaveBeenCalledWith("session-token", {
      id: "investor",
      email: "investor@example.com",
      name: "Investor",
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

type GoogleIdentityMock = {
  accounts: { id: {
    initialize: (config: { callback: (response: { credential: string }) => void }) => void;
    renderButton: (element: HTMLElement) => void;
  } };
};

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing test element: ${selector}`);
  return value;
}
