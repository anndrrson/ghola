import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThumperBillingStatusResponse } from "@/lib/thumper-types";
import type { InvestorAccessRequirements } from "@/lib/investor-access";

const mocks = vi.hoisted(() => ({
  auth: { authenticated: true, loading: false, user: { id: "investor", email: "investor@example.com" } },
  billing: vi.fn(),
  redeem: vi.fn(),
}));

vi.mock("@/lib/thumper-auth-context", () => ({ useThumperAuth: () => mocks.auth }));
vi.mock("@/lib/thumper-api", () => ({
  getThumperBillingStatus: mocks.billing,
  redeemComplimentaryAccessPass: mocks.redeem,
}));
vi.mock("@/components/AuthModal", () => ({
  AuthModal: ({ open }: { open: boolean }) => open ? createElement("div", { "data-testid": "auth-modal" }) : null,
}));

import { InvestorAccessGate, type InvestorAccessControl } from "./InvestorAccessGate";

const CODE = "A".repeat(43);

describe("InvestorAccessGate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(mocks.auth, {
      authenticated: true,
      loading: false,
      user: { id: "investor", email: "investor@example.com" },
    });
    mocks.redeem.mockResolvedValue({ ok: true });
    mocks.billing.mockResolvedValue(activeBilling());
    window.history.replaceState({}, "", "/account");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("captures and removes a fragment invite before redeeming and exposing children", async () => {
    window.history.replaceState({}, "", `/account?flow=trade#access=${CODE}`);
    mocks.redeem.mockImplementation(async () => {
      expect(window.location.href).not.toContain(CODE);
      return { ok: true };
    });
    await mount(root, container);

    expect(window.location.href).not.toContain(CODE);
    expect(window.location.pathname + window.location.search).toBe("/account?flow=trade");
    expect(mocks.redeem).toHaveBeenCalledWith(CODE);
    expect(mocks.redeem.mock.invocationCallOrder[0]).toBeLessThan(mocks.billing.mock.invocationCallOrder[0]);
    expect(container.querySelector("[data-testid='protected-wallet-ui']")).not.toBeNull();
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2999-08-20T12:00:00.000Z");
    expect(container.textContent).toContain("3,600 compute seconds remaining");
    expect(container.textContent).toContain("$100.00 included filled notional remaining");
  });

  it("scrubs but never redeems a query token", async () => {
    window.history.replaceState({}, "", `/account?access=${CODE}&flow=trade#eligibility-consent`);
    mocks.billing.mockResolvedValue({ ...activeBilling(), tier: "free" });
    await mount(root, container);

    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe("/account?flow=trade#eligibility-consent");
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='protected-wallet-ui']")).toBeNull();
  });

  it.each([
    ["free", { ...activeBilling(), tier: "free" }],
    ["expired", activeBilling({ expires_at: "2000-08-20T12:00:00.000Z" })],
    ["near-expiry", activeBilling({ expires_at: new Date(Date.now() + 10 * 60_000).toISOString() })],
    ["low-compute", activeBilling({ private_agent_compute: compute({ remaining_seconds: 599 }) })],
    ["trading-disabled", activeBilling({ private_agent_trading: trading({ live_trading_allowed: false }) })],
  ])("blocks protected UI for %s access", async (_label, response) => {
    mocks.billing.mockResolvedValue(response);
    await mount(root, container);

    expect(container.querySelector("[data-testid='protected-wallet-ui']")).toBeNull();
    expect(container.querySelector("[data-investor-access='blocked']")).not.toBeNull();
  });

  it("keeps an expired redemption 402 ahead of protected UI", async () => {
    window.history.replaceState({}, "", `/account#access=${CODE}`);
    mocks.redeem.mockRejectedValue(Object.assign(new Error("access pass has expired"), { status: 402 }));
    mocks.billing.mockResolvedValue({ ...activeBilling(), tier: "free" });
    await mount(root, container);

    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("investor pass has expired");
    expect(container.querySelector("[data-testid='protected-wallet-ui']")).toBeNull();
  });

  it.each([
    ["verified_email_required", "Verify the invited email account"],
    ["access_pass_email_mismatch", "belongs to a different email"],
    ["private_agent_subscription_required", "Investor access is not active"],
  ])("shows safe guidance for %s", async (code, expected) => {
    window.history.replaceState({}, "", `/account#access=${CODE}`);
    mocks.redeem.mockRejectedValue(new Error(code));
    mocks.billing.mockResolvedValue({ ...activeBilling(), tier: "free" });
    await mount(root, container);

    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain(code);
  });

  it("blocks paid access when the canary requires an email-bound investor pass", async () => {
    mocks.billing.mockResolvedValue(activeBilling({
      access_source: "stripe",
      expires_at: null,
    }));
    await mount(root, container, undefined, { requireComplimentaryPass: true });

    expect(container.textContent).toContain("email-bound investor pass");
    expect(container.querySelector("[data-testid='protected-wallet-ui']")).toBeNull();
  });

  it("rechecks immediately before a protected action and closes the gate on expiry", async () => {
    mocks.billing
      .mockResolvedValueOnce(activeBilling())
      .mockResolvedValueOnce(activeBilling({ expires_at: "2000-08-20T12:00:00.000Z" }));
    await mount(root, container, (control) => createElement("button", {
      type: "button",
      onClick: () => void control.ensureReady(),
    }, "Authorize wallet"));

    await act(async () => {
      findButton(container, "Authorize wallet").click();
      await flush();
    });

    expect(mocks.billing).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-investor-access='blocked']")).not.toBeNull();
  });

  it("keeps invite activation inline while signed out", async () => {
    Object.assign(mocks.auth, { authenticated: false, loading: false, user: null });
    window.history.replaceState({}, "", `/account#access=${CODE}`);
    await mount(root, container);

    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
    await act(async () => findButton(container, "Sign in").click());
    expect(container.querySelector("[data-testid='auth-modal']")).not.toBeNull();
  });
});

async function mount(
  root: Root,
  container: HTMLElement,
  child: (control: InvestorAccessControl) => ReturnType<typeof createElement> = () =>
    createElement("div", { "data-testid": "protected-wallet-ui" }, "wallet controls"),
  requirements: InvestorAccessRequirements = {},
) {
  await act(async () => {
    const gateProps = Object.assign({}, requirements, { children: child });
    root.render(createElement(InvestorAccessGate, gateProps));
    await flush();
  });
  await vi.waitFor(() => {
    expect(container.querySelector("[data-investor-access]")).not.toBeNull();
  });
}

function findButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`button missing: ${label}`);
  return button;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function activeBilling(overrides: Partial<ThumperBillingStatusResponse> = {}): ThumperBillingStatusResponse {
  return {
    tier: "starter",
    access_source: "complimentary_pass",
    access_state: "active",
    expires_at: "2999-08-20T12:00:00.000Z",
    stripe_customer_id: null,
    limits: { calls_per_month: 20, emails_per_month: 30, private_compute_seconds: 72_000, active_private_agents: 1 },
    private_agent_compute: compute(),
    private_agent_trading: trading(),
    ...overrides,
  };
}

function compute(overrides: Partial<NonNullable<ThumperBillingStatusResponse["private_agent_compute"]>> = {}) {
  return {
    included_seconds: 72_000,
    reserved_seconds: 0,
    used_seconds: 0,
    remaining_seconds: 3_600,
    active_agent_limit: 1,
    active_agent_count: 0,
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-09-01T00:00:00.000Z",
    metering_unit: "agent_second" as const,
    ...overrides,
  };
}

function trading(overrides: Partial<NonNullable<ThumperBillingStatusResponse["private_agent_trading"]>> = {}) {
  return {
    included_notional_micro_usd: 100_000_000,
    filled_notional_micro_usd: 0,
    remaining_included_notional_micro_usd: 100_000_000,
    overage_notional_micro_usd: 0,
    overage_fee_bps: 0,
    accrued_fee_micro_usd: 0,
    queued_fee_cents: 0,
    invoiced_fee_cents: 0,
    monthly_fee_cap_micro_usd: 0,
    cap_reached: false,
    live_trading_allowed: true,
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-09-01T00:00:00.000Z",
    metering_unit: "filled_notional_micro_usd" as const,
    billing_state: "current" as const,
    ...overrides,
  };
}
