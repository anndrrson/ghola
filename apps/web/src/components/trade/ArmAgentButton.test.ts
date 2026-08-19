import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

const clientMocks = vi.hoisted(() => ({ arm: vi.fn(), killFlat: vi.fn(), get: vi.fn(), authorize: vi.fn() }));

vi.mock("@/lib/private-account-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/private-account-client")>(),
  armLevelTriggerAgent: clientMocks.arm,
  getPrivateAutopilotSession: clientMocks.get,
  killAndFlatPrivateAutopilotSession: clientMocks.killFlat,
}));
vi.mock("@/lib/private-account-wallet-step-up", () => ({
  authorizePrivateAccountWalletRequest: clientMocks.authorize,
}));

import { ArmAgentButton, levelTriggerPlanFromOrderDraft } from "./ArmAgentButton";

afterEach(() => {
  clientMocks.arm.mockReset();
  clientMocks.killFlat.mockReset();
  clientMocks.get.mockReset();
  clientMocks.authorize.mockReset();
});

describe("levelTriggerPlanFromOrderDraft", () => {
  it("uses the displayed entry price as the immediate-entry mandate level", () => {
    const plan = levelTriggerPlanFromOrderDraft({
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      market: "BTC-PERP",
      side: "buy",
      base_size: "0.001",
      quote_size: "10",
      limit_price: "65266.5",
      max_slippage_bps: "50",
      order_type: "limit",
      size_mode: "quote",
      agent_entry_trigger: "preview_now",
      agent_invalidation_level: "64777.0",
    });

    expect(plan.triggerLevel).toBe("65266.5");
    expect(plan.entryTrigger).toBe("preview_now");
  });
});

describe("ArmAgentButton exact-plan arming", () => {
  it("offers confirmation for a supported exact Hyperliquid plan", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draft = orderDraft();

    await act(async () => root.render(createElement(ArmAgentButton, { orderDraft: draft, ready: true })));
    const button = findButton(container, "Arm agent for this plan");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(container.textContent).toContain("Yes, arm it");
    expect(clientMocks.arm).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("requires confirmation and renders worker-backed final-flat evidence", async () => {
    const session = workerSession();
    clientMocks.arm.mockResolvedValue({ session, events: [] });
    clientMocks.authorize.mockResolvedValue({ "x-ghola-mobile-proof-version": "1" });
    clientMocks.killFlat.mockResolvedValue({
      version: 1,
      session: {
        ...session,
        status: "killed",
        execution_enabled: false,
        final_flat_evidence: {
          proof_kind: "hyperliquid_kill_and_flat_v1",
          status: "reconciled",
          final_flat_proven: true,
          account_flat: true,
          open_order_count: 0,
          cancellations: [{ venue_order_oid: "111" }],
          closes: [{ venue_order_oid: "222", reduce_only: true }],
          evidence_commitment: "hl_risk_evidence_1234567890",
          root_work_order_commitment: "hl_flat_root_1234567890",
          reconciled_at: "2026-08-17T12:00:00.000Z",
          completed_at: "2026-08-17T12:00:01.000Z",
        },
      },
      event: {},
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ArmAgentButton, { orderDraft: orderDraft(), ready: true })));
    await act(async () => findButton(container, "Arm agent for this plan").click());
    await act(async () => findButton(container, "Yes, arm it").click());
    await act(async () => findButton(container, "Kill + flatten").click());
    expect(container.textContent).toContain("disables execution first");
    await act(async () => findButton(container, "Sign + kill + flatten").click());
    expect(clientMocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/private-account/autopilot/sessions/session_123456/kill-and-flat",
      body: {},
    }));
    expect(container.textContent).toContain("Venue final-flat · zero open orders · 1 reduce-only fill");
    expect(container.textContent).toContain("hl_risk_evi");
    act(() => root.unmount());
    container.remove();
  });

  it("stays fail-closed with retry and manual-close guidance after an uncertain flatten", async () => {
    const session = workerSession();
    clientMocks.arm.mockResolvedValue({ session, events: [] });
    clientMocks.authorize.mockResolvedValue({ "x-ghola-mobile-proof-version": "1" });
    clientMocks.killFlat.mockRejectedValue(new Error("worker response timed out"));
    clientMocks.get.mockResolvedValue({
      session: {
        ...session,
        status: "risk_halted",
        execution_enabled: false,
        next_step: "Retry kill-and-flat or close manually.",
      },
      events: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(ArmAgentButton, { orderDraft: orderDraft(), ready: true })));
    await act(async () => findButton(container, "Arm agent for this plan").click());
    await act(async () => findButton(container, "Yes, arm it").click());
    await act(async () => findButton(container, "Kill + flatten").click());
    await act(async () => findButton(container, "Sign + kill + flatten").click());

    expect(clientMocks.get).toHaveBeenCalledWith("session_123456");
    expect(container.textContent).toContain("Flatten outcome unconfirmed");
    expect(container.textContent).toContain("Retry kill + flatten");
    expect(container.textContent).toContain("Close · RO");
    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent?.includes("Arm agent for this plan"))).toBe(false);

    act(() => root.unmount());
    container.remove();
  });
});

function workerSession() {
  return {
    version: 2,
    autopilot_session_id: "session_123456",
    worker_autopilot_session_id: "worker_123456",
    worker_session_commitment: "worker_commitment_123456",
    owner_commitment: "owner_commitment_123456",
    status: "running",
    strategy: {
      version: 1,
      strategy_id: "level_trigger_v1",
      decision_model: "deterministic_level_trigger",
      executable_order_source: "deterministic_level_trigger",
      ai_can_execute_directly: false,
    },
    session_policy: {},
    venue_access: {},
    order_count: 0,
    daily_notional_used_bucket: "0",
    risk_summary: { complete: true, stale_markets: [], exposure_usd: 0, realized_pnl_usd: 0, unrealized_pnl_usd: 0, estimated_total_pnl_usd: 0, checked_at: "2026-08-17T12:00:00.000Z" },
    created_at: "2026-08-17T12:00:00.000Z",
    updated_at: "2026-08-17T12:00:00.000Z",
    expires_at: "2026-08-17T14:00:00.000Z",
    next_step: "Running.",
    execution_enabled: true,
    autonomous_live_submit_enabled: true,
    autonomous_execution_mode: "live",
    control_plane: "worker",
    visibility_summary: { main_wallet_prompts_per_trade: false, execution_boundary: "bounded_delegated_worker_policy", user_can_kill_anytime: true },
  };
}

function orderDraft(): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "BTC-PERP",
    side: "buy",
    base_size: "0.001",
    quote_size: "10",
    limit_price: "65266.5",
    max_slippage_bps: "50",
    order_type: "limit",
    size_mode: "quote",
    agent_entry_trigger: "break_level",
    agent_trigger_level: "65266.5",
    agent_invalidation_level: "64777.0",
  };
}

function findButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}
