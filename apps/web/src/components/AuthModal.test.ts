import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthModal } from "./AuthModal";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  setAuth: vi.fn(),
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

describe("AuthModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
});

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing test element: ${selector}`);
  return value;
}
