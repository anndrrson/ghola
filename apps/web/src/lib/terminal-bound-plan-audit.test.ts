import { describe, expect, it } from "vitest";
import {
  captureTerminalBoundPlanAudit,
  deriveTerminalBoundPlanAudit,
  terminalBoundPlanAuditEqual,
  terminalBoundPlanDifferences,
} from "./terminal-bound-plan-audit";
import type { TradeOrderPlan, TradeOrderPlanBindingEnvelope } from "./trade-order-plan";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal bound plan audit", () => {
  it("captures no authorization material", () => {
    const snapshot = captureTerminalBoundPlanAudit(binding(plan()));
    expect(snapshot).toMatchObject({ planDigest: `sha256:${"a".repeat(64)}` });
    expect(snapshot).not.toHaveProperty("token");
    expect(snapshot).not.toHaveProperty("preview_commitment");
  });

  it("ignores market receipt advancement but reports deterministic intent changes", () => {
    const bound = plan();
    const current = plan({
      quote_notional_usd: "25",
      limit_price: "101",
      market_context: { ...bound.market_context, fetched_at: "2026-08-13T12:00:01.000Z" },
    });
    const result = deriveTerminalBoundPlanAudit({
      snapshot: captureTerminalBoundPlanAudit(binding(bound)),
      currentPlan: current,
      active: false,
      nowMs: NOW,
    });
    expect(result.status).toBe("changed");
    expect(result.differences.map(({ field }) => field)).toEqual(["notional", "entry"]);
  });

  it("distinguishes an inactive unchanged plan from an authorizing active preview", () => {
    const snapshot = captureTerminalBoundPlanAudit(binding(plan()));
    expect(deriveTerminalBoundPlanAudit({ snapshot, currentPlan: plan(), active: false, nowMs: NOW }).status).toBe("inactive");
    expect(deriveTerminalBoundPlanAudit({ snapshot, currentPlan: plan(), active: true, nowMs: NOW }).status).toBe("active");
  });

  it("surfaces bound budget and cost-assumption changes", () => {
    const bound = plan();
    const current = plan({ risk_envelope: { ...bound.risk_envelope!, fee_bps: 6, round_trip_cost_loss_usd: "0.022", all_in_loss_usd: "0.572" } });
    expect(deriveTerminalBoundPlanAudit({ snapshot: captureTerminalBoundPlanAudit(binding(bound)), currentPlan: current, active: false, nowMs: NOW }).differences.map(({ field }) => field))
      .toEqual(["all_in_loss", "fee_assumption"]);
  });

  it("invalidates a binding when cost evidence is reconfirmed", () => {
    const bound = plan();
    const current = plan({ risk_envelope: { ...bound.risk_envelope!, buffer_evidence_at: "2026-08-13T12:00:00.000Z" } });
    expect(terminalBoundPlanDifferences(bound, current).map(({ field }) => field)).toEqual(["buffer_assumption"]);
  });

  it("reports expiry and unavailable current plans without authorizing either", () => {
    const snapshot = captureTerminalBoundPlanAudit(binding(plan(), { expires_at: "2026-08-13T11:59:59.000Z" }));
    expect(deriveTerminalBoundPlanAudit({ snapshot, currentPlan: plan(), active: true, nowMs: NOW }).status).toBe("expired");
    expect(deriveTerminalBoundPlanAudit({ snapshot, currentPlan: null, active: false, nowMs: NOW }).status).toBe("current_plan_unavailable");
  });

  it("treats receipt-only plan rebuilds as render-equivalent", () => {
    const snapshot = captureTerminalBoundPlanAudit(binding(plan()));
    const first = deriveTerminalBoundPlanAudit({ snapshot, currentPlan: plan(), active: true, nowMs: NOW });
    const current = plan();
    current.market_context.fetched_at = "2026-08-13T12:00:01.000Z";
    const second = deriveTerminalBoundPlanAudit({ snapshot, currentPlan: current, active: true, nowMs: NOW });
    expect(terminalBoundPlanAuditEqual(first, second)).toBe(true);
  });
});

function binding(
  orderPlan: TradeOrderPlan,
  overrides: Partial<TradeOrderPlanBindingEnvelope> = {},
): TradeOrderPlanBindingEnvelope {
  return {
    version: 1,
    algorithm: "HMAC-SHA256",
    preview_commitment: `sha256:${"b".repeat(64)}`,
    plan_digest: `sha256:${"a".repeat(64)}`,
    issued_at: "2026-08-13T11:59:50.000Z",
    expires_at: "2026-08-13T12:00:10.000Z",
    token: "secret-token",
    order_plan: orderPlan,
    ...overrides,
  };
}

function plan(overrides: Partial<TradeOrderPlan> = {}): TradeOrderPlan {
  const base: TradeOrderPlan = {
    version: 1,
    kind: "ghola_trade_order_plan",
    venue_id: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    order_type: "limit",
    time_in_force: "gtc",
    quote_notional_usd: "10",
    base_size: "0.1",
    limit_price: "100",
    max_slippage_bps: 50,
    risk_envelope: {
      risk_budget_usd: "1",
      stop_and_slippage_loss_usd: "0.55",
      round_trip_cost_loss_usd: "0.02",
      all_in_loss_usd: "0.57",
      fee_bps: 5,
      buffer_bps: 5,
      fee_evidence_at: "2026-08-13T11:59:59.000Z",
      buffer_evidence_at: "2026-08-13T11:59:59.000Z",
      scope: "account_local_cost_assumption_v1",
    },
    stop_intent: { stop_level: "95", scope: "agent_plan_invalidation_only" },
    agent_mandate: {
      strategy_profile: "trend_following",
      entry_trigger: "preview_now",
      exit_rule: "manual_approval",
      time_horizon: "scalp",
      trigger_level: null,
      invalidation_level: "95",
    },
    execution_policy: {
      submit: true,
      refresh_after_submit: true,
      fetch_fills: true,
      cancel_if_open: false,
      reduce_only: false,
    },
    market_context: {
      frame_version: 1,
      interval: "1m",
      fetched_at: "2026-08-13T12:00:00.000Z",
      max_age_ms: 30_000,
      source_state: "live",
      execution_reference_price: "99.9",
    },
  };
  return { ...base, ...overrides };
}
