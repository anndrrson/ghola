import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
} from "@/lib/live-trading-contract";

const mocks = vi.hoisted(() => ({
  getHyperliquidLiveAccess: vi.fn(),
  getPublicAgentStartupStatus: vi.fn(),
  verifyVenueEligibility: vi.fn(),
  wakePublicAgentWorker: vi.fn(),
  ensureReady: vi.fn(),
}));

vi.mock("@/lib/private-account-client", () => mocks);
vi.mock("./InvestorAccessGate", () => ({
  InvestorAccessGate: ({ children }: { children: (control: unknown) => ReactNode }) => children({
    ensureReady: mocks.ensureReady,
    billing: { tier: "starter" },
    readiness: { ready: true, expires_at: "2026-08-20T12:00:00.000Z" },
  }),
}));
vi.mock("./ConnectHyperliquidButton", () => ({
  ConnectHyperliquidButton: ({ onVaultStatusChange }: { onVaultStatusChange?: () => void | Promise<void> }) => createElement(
    "div",
    null,
    createElement("input", { type: "password", "aria-label": "API wallet private key" }),
    createElement("button", { type: "button", onClick: () => void onVaultStatusChange?.() }, "Simulate wallet change"),
  ),
}));

import { HyperliquidAccountSetup } from "./HyperliquidAccountSetup";

describe("HyperliquidAccountSetup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.ensureReady.mockResolvedValue(true);
    mocks.getPublicAgentStartupStatus.mockResolvedValue({ runtime: { ready: false } });
    mocks.wakePublicAgentWorker.mockResolvedValue({ ready: false, status: "warming", message: "Worker is warming." });
    mocks.getHyperliquidLiveAccess
      .mockResolvedValueOnce({ eligibility_ready: false, vault_ready: false })
      .mockResolvedValue({ eligibility_ready: true, vault_ready: false });
    mocks.verifyVenueEligibility.mockResolvedValue({ ready: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("allows setup on localhost while hiding credentials until exact current consent", async () => {
    await act(async () => {
      root.render(createElement(HyperliquidAccountSetup));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(`terms ${LIVE_TRADING_TERMS_VERSION}`);
    });

    expect(window.location.hostname).toBe("localhost");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    act(() => checkboxes.forEach((checkbox) => checkbox.click()));

    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Accept and continue"));
    await act(async () => submit?.click());
    await vi.waitFor(() => {
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
    });

    expect(mocks.verifyVenueEligibility).toHaveBeenCalledWith({
      venue_id: "hyperliquid",
      credential_type: "self_attested_eligible_user",
      eligible_non_us: true,
      terms_version: LIVE_TRADING_TERMS_VERSION,
      risk_disclosure_version: LIVE_TRADING_RISK_DISCLOSURE_VERSION,
      confirmation: LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
    });
  });

  it("rechecks access before recording eligibility and stops when it is no longer ready", async () => {
    mocks.ensureReady.mockResolvedValue(false);
    await act(async () => {
      root.render(createElement(HyperliquidAccountSetup));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(`terms ${LIVE_TRADING_TERMS_VERSION}`);
    });

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    act(() => checkboxes.forEach((checkbox) => checkbox.click()));
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Accept and continue"));
    await act(async () => submit?.click());

    expect(mocks.ensureReady).toHaveBeenCalledOnce();
    expect(mocks.verifyVenueEligibility).not.toHaveBeenCalled();
  });

  it("rechecks access before starting a secure worker", async () => {
    mocks.ensureReady.mockResolvedValue(false);
    mocks.getHyperliquidLiveAccess.mockReset().mockResolvedValue({ eligibility_ready: true, vault_ready: false });
    await act(async () => {
      root.render(createElement(HyperliquidAccountSetup));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Start secure worker");
    });

    const start = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start secure worker"));
    await act(async () => start?.click());

    expect(mocks.ensureReady).toHaveBeenCalledOnce();
    expect(mocks.wakePublicAgentWorker).not.toHaveBeenCalled();
  });

  it("shows the explicit proof step before graduation", async () => {
    mocks.getHyperliquidLiveAccess.mockReset().mockResolvedValue({
      eligibility_ready: true,
      vault_ready: true,
      graduation_ready: false,
    });
    await act(async () => root.render(createElement(HyperliquidAccountSetup)));
    await vi.waitFor(() => expect(container.textContent).toContain("Run $11 proof"));
    expect(container.querySelector<HTMLAnchorElement>('a[href="/trade/mainnet-e2e"]')).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>('a[href="/trade?flow=hyperliquid-live"]')).toBeNull();
  });

  it("refreshes the parent setup state after the wallet status changes", async () => {
    mocks.getHyperliquidLiveAccess.mockReset()
      .mockResolvedValueOnce({ eligibility_ready: true, vault_ready: false, graduation_ready: false })
      .mockResolvedValue({ eligibility_ready: true, vault_ready: true, graduation_ready: false });
    await act(async () => root.render(createElement(HyperliquidAccountSetup)));
    await vi.waitFor(() => expect(container.textContent).toContain("Simulate wallet change"));

    const change = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Simulate wallet change"));
    await act(async () => change?.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Run $11 proof"));
    expect(mocks.getHyperliquidLiveAccess).toHaveBeenCalledTimes(2);
  });

  it("stops polling a blocked worker and offers a retry", async () => {
    mocks.getHyperliquidLiveAccess.mockReset().mockResolvedValue({ eligibility_ready: true, vault_ready: false });
    mocks.getPublicAgentStartupStatus
      .mockResolvedValueOnce({ runtime: { ready: false, status: "warming", message: "Worker is warming." } })
      .mockResolvedValueOnce({ runtime: { ready: false, status: "warming", message: "Worker is warming." } })
      .mockResolvedValueOnce({ runtime: { ready: false, status: "blocked", message: "private_agent_subscription_required" } });
    await act(async () => root.render(createElement(HyperliquidAccountSetup)));
    await vi.waitFor(() => expect(container.textContent).toContain("Start secure worker"));

    const start = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start secure worker"));
    vi.useFakeTimers();
    await act(async () => start?.click());
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Investor access is not active");
    expect(container.textContent).toContain("Start secure worker");
    vi.useRealTimers();
  });

  it("bounds worker warming and offers a retry after ninety seconds", async () => {
    mocks.getHyperliquidLiveAccess.mockReset().mockResolvedValue({ eligibility_ready: true, vault_ready: false });
    mocks.getPublicAgentStartupStatus.mockResolvedValue({
      runtime: { ready: false, status: "warming", message: "Worker is warming." },
    });
    await act(async () => root.render(createElement(HyperliquidAccountSetup)));
    await vi.waitFor(() => expect(container.textContent).toContain("Start secure worker"));

    const start = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Start secure worker"));
    vi.useFakeTimers();
    await act(async () => start?.click());
    for (let poll = 0; poll < 18; poll += 1) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
    }

    expect(container.textContent).toContain("did not become ready in time");
    expect(container.textContent).toContain("Start secure worker");
    expect(mocks.getPublicAgentStartupStatus).toHaveBeenCalledTimes(20);
  });

  it("unlocks the normal terminal only after current-release graduation", async () => {
    mocks.getHyperliquidLiveAccess.mockReset().mockResolvedValue({
      eligibility_ready: true,
      vault_ready: true,
      graduation_ready: true,
      proof_completed_at: "2026-08-19T00:00:00.000Z",
    });
    await act(async () => root.render(createElement(HyperliquidAccountSetup)));
    await vi.waitFor(() => expect(container.textContent).toContain("Open live terminal"));
    expect(container.querySelector<HTMLAnchorElement>('a[href="/trade?flow=hyperliquid-live"]')).not.toBeNull();
  });
});
