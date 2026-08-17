import { act, createElement } from "react";
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
  getThumperBillingStatus: vi.fn(),
}));

vi.mock("@/lib/private-account-client", () => mocks);
vi.mock("@/lib/thumper-api", () => ({
  getThumperBillingStatus: mocks.getThumperBillingStatus,
}));
vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => ({
    authenticated: true,
    loading: false,
    user: { id: "investor-1", email: "investor@example.com" },
  }),
}));
vi.mock("./ConnectHyperliquidButton", () => ({
  ConnectHyperliquidButton: () => createElement("input", {
    type: "password",
    "aria-label": "API wallet private key",
  }),
}));

import { HyperliquidAccountSetup } from "./HyperliquidAccountSetup";

describe("HyperliquidAccountSetup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.getThumperBillingStatus.mockResolvedValue({ tier: "starter" });
    mocks.getPublicAgentStartupStatus.mockResolvedValue({ runtime: { ready: false } });
    mocks.getHyperliquidLiveAccess
      .mockResolvedValueOnce({ eligibility_ready: false, vault_ready: false })
      .mockResolvedValue({ eligibility_ready: true, vault_ready: false });
    mocks.verifyVenueEligibility.mockResolvedValue({ ready: true });
  });

  afterEach(() => {
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
});
