import { describe, expect, it } from "vitest";
import type { ThumperBillingStatusResponse } from "./thumper-types";
import {
  evaluateInvestorAccess,
  inspectInvestorAccessInvite,
} from "./investor-access";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

describe("investor access readiness", () => {
  it("requires exact active, non-billable complimentary capacity", () => {
    expect(evaluateInvestorAccess(activeBilling(), NOW)).toMatchObject({
      ready: true,
      blocker: null,
      expires_at: "2026-08-20T12:00:00.000Z",
      remaining_compute_seconds: 3_600,
      remaining_filled_notional_micro_usd: 100_000_000,
    });
  });

  it.each([
    ["free", { ...activeBilling(), tier: "free" }, "subscription_required"],
    ["expired recorded pass", {
      ...activeBilling(),
      tier: "free",
      access_source: "free",
      access_state: "expired",
      expires_at: null,
      last_access_expires_at: "2026-08-18T12:00:00.000Z",
    }, "access_expired"],
    ["expired", activeBilling({ expires_at: "2026-08-19T11:59:59.000Z" }), "access_expired"],
    ["near expiry", activeBilling({ expires_at: "2026-08-19T12:29:59.000Z" }), "access_expiring_soon"],
    ["exact expiry floor", activeBilling({ expires_at: "2026-08-19T12:30:00.000Z" }), "access_expiring_soon"],
    ["missing expiry", activeBilling({ expires_at: null }), "expiry_required"],
    ["missing access state", activeBilling({ access_state: undefined }), "access_state_required"],
    ["missing compute", activeBilling({ private_agent_compute: compute({ remaining_seconds: undefined as unknown as number }) }), "compute_allowance_required"],
    ["zero agent limit", activeBilling({ private_agent_compute: compute({ active_agent_limit: 0 }) }), "compute_allowance_required"],
    ["low compute", activeBilling({ private_agent_compute: compute({ remaining_seconds: 599 }) }), "compute_allowance_exhausted"],
    ["agent limit", activeBilling({ private_agent_compute: compute({ active_agent_count: 1 }) }), "active_agent_limit_reached"],
    ["trading disabled", activeBilling({ private_agent_trading: trading({ live_trading_allowed: false }) }), "trading_allowance_exhausted"],
    ["low notional", activeBilling({ private_agent_trading: trading({ remaining_included_notional_micro_usd: 21_999_999 }) }), "trading_allowance_exhausted"],
    ["missing notional", activeBilling({ private_agent_trading: trading({ remaining_included_notional_micro_usd: undefined as unknown as number }) }), "trading_allowance_required"],
    ["cap inconsistency", activeBilling({ private_agent_trading: trading({ cap_reached: true, live_trading_allowed: true }) }), "trading_allowance_exhausted"],
    ["expired period", activeBilling({ private_agent_trading: trading({ period_end: "2026-08-19T12:00:00.000Z" }) }), "billing_period_invalid"],
    ["overage", activeBilling({ private_agent_trading: trading({ overage_fee_bps: 3 }) }), "complimentary_overage_enabled"],
  ])("blocks %s before wallet work", (_label, billing, blocker) => {
    expect(evaluateInvestorAccess(billing as ThumperBillingStatusResponse, NOW)).toMatchObject({
      ready: false,
      blocker,
    });
  });
});

describe("investor invite capture", () => {
  const code = "A".repeat(43);

  it("prefers a server-blind fragment and removes it from the clean URL", () => {
    expect(inspectInvestorAccessInvite(`https://ghola.xyz/account?flow=trade#access=${code}`)).toEqual({
      code,
      clean_path: "/account?flow=trade",
      error: null,
    });
  });

  it("scrubs but never accepts a query token while preserving unrelated URL state", () => {
    expect(inspectInvestorAccessInvite(`https://ghola.xyz/account?access=${code}&flow=trade#eligibility-consent`)).toEqual({
      code: null,
      clean_path: "/account?flow=trade#eligibility-consent",
      error: null,
    });
  });

  it("fails closed on conflicting or malformed fragment codes and still removes them", () => {
    expect(inspectInvestorAccessInvite(`https://ghola.xyz/account#access=${code}&access=${"B".repeat(43)}`)).toMatchObject({
      code: null,
      clean_path: "/account",
      error: "invite_code_ambiguous",
    });
    expect(inspectInvestorAccessInvite("https://ghola.xyz/account#access=short")).toEqual({
      code: null,
      clean_path: "/account",
      error: "invite_code_invalid",
    });
    expect(inspectInvestorAccessInvite(
      `https://ghola.xyz/account#access=${code}&access=${"B".repeat(43)}`,
    )).toMatchObject({
      code: null,
      clean_path: "/account",
      error: "invite_code_ambiguous",
    });
  });
});

function activeBilling(overrides: Partial<ThumperBillingStatusResponse> = {}): ThumperBillingStatusResponse {
  return {
    tier: "starter",
    access_source: "complimentary_pass",
    access_state: "active",
    expires_at: "2026-08-20T12:00:00.000Z",
    stripe_customer_id: null,
    limits: {
      calls_per_month: 20,
      emails_per_month: 30,
      private_compute_seconds: 72_000,
      active_private_agents: 1,
    },
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
