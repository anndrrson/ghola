import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateAutopilotSession } from "@/lib/private-account-client";

const clientMocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  control: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  killFlat: vi.fn(),
  list: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock("@/components/AuthModal", () => ({ AuthModal: () => null }));
vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => ({ authenticated: true }),
}));
vi.mock("@/lib/private-account-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/private-account-client")>(),
  controlPrivateAutopilotSession: clientMocks.control,
  createPrivateAutopilotSession: clientMocks.create,
  getPrivateAutopilotSession: clientMocks.get,
  killAndFlatPrivateAutopilotSession: clientMocks.killFlat,
  listPrivateAutopilotSessions: clientMocks.list,
  openPrivateAutopilotEventStream: clientMocks.openStream,
}));
vi.mock("@/lib/private-account-wallet-step-up", () => ({
  authorizePrivateAccountWalletRequest: clientMocks.authorize,
}));

import RunsPage from "./page";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(clientMocks)) mock.mockReset();
  clientMocks.openStream.mockReturnValue({ close: vi.fn() });
  clientMocks.authorize.mockResolvedValue({ "x-ghola-mobile-proof-version": "1" });
});

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("runs kill-and-flat controls", () => {
  it("requires confirmation and an exact action-time wallet proof before showing final-flat evidence", async () => {
    const running = session();
    clientMocks.list.mockResolvedValue({ autopilot_sessions: [running] });
    clientMocks.killFlat.mockResolvedValue({
      version: 1,
      session: finalFlatSession(running),
      event: {},
    });
    const { container } = await renderPage();

    const start = findButton(container, "Start run");
    expect(start.disabled).toBe(false);
    await act(async () => findButton(container, "Kill + flatten").click());

    expect(container.textContent).toContain("cancels allowed Hyperliquid orders");
    expect(start.disabled).toBe(true);
    expect(clientMocks.authorize).not.toHaveBeenCalled();

    await act(async () => findButton(container, "Sign + kill + flatten").click());

    expect(clientMocks.authorize).toHaveBeenCalledWith({
      path: "/v1/private-account/autopilot/sessions/session_123456/kill-and-flat",
      body: {},
    });
    expect(clientMocks.killFlat).toHaveBeenCalledWith("session_123456", {
      proofHeaders: { "x-ghola-mobile-proof-version": "1" },
    });
    expect(container.textContent).toContain("Venue final-flat proven · zero open orders");
    expect(container.textContent).toContain("hl_risk_ev…345678");
  });

  it("refetches an invalid outcome, stays fail-closed, and preserves retry plus manual-close guidance", async () => {
    const running = session();
    const invalidEvidence = {
      ...finalFlatSession(running),
      final_flat_evidence: {
        ...finalFlatSession(running).final_flat_evidence,
        open_order_count: 1,
      },
    } as PrivateAutopilotSession;
    const halted = session({
      status: "risk_halted",
      execution_enabled: false,
      next_step: "Retry kill-and-flat or close manually.",
    });
    clientMocks.list.mockResolvedValue({ autopilot_sessions: [running] });
    clientMocks.killFlat.mockResolvedValue({ version: 1, session: invalidEvidence, event: {} });
    clientMocks.get.mockResolvedValue({ version: 1, session: halted });
    const { container } = await renderPage();

    await act(async () => findButton(container, "Kill + flatten").click());
    await act(async () => findButton(container, "Sign + kill + flatten").click());

    expect(clientMocks.get).toHaveBeenCalledWith("session_123456");
    expect(container.textContent).toContain("Flatten outcome unconfirmed");
    expect(container.textContent).toContain("Close · RO");
    expect(container.textContent).toContain("Open terminal for manual close");
    expect(container.textContent).not.toContain("Venue final-flat proven");
    expect(findButton(container, "Start run").disabled).toBe(true);

    await act(async () => findButton(container, "Retry kill + flatten").click());
    expect(container.textContent).toContain("Sign + kill + flatten");
    expect(clientMocks.authorize).toHaveBeenCalledTimes(1);
    await act(async () => findButton(container, "Cancel").click());
    expect(container.textContent).toContain("Flatten outcome unconfirmed");
    expect(findButton(container, "Start run").disabled).toBe(true);
  });

  it("blocks new runs and resumes for a listed risk-halted outcome", async () => {
    clientMocks.list.mockResolvedValue({
      autopilot_sessions: [
        session({ status: "risk_halted", execution_enabled: false }),
        session({
          autopilot_session_id: "session_paused",
          worker_autopilot_session_id: "worker_paused",
          status: "paused",
          execution_enabled: false,
        }),
      ],
    });
    const { container } = await renderPage();

    expect(findButton(container, "Start run").disabled).toBe(true);
    expect(findButton(container, "Resume").disabled).toBe(true);
    expect(container.textContent).toContain("Resolve every risk-halted session");
    expect(container.textContent).toContain("Flatten outcome unconfirmed");
    await act(async () => findButton(container, "Retry kill + flatten").click());
    expect(clientMocks.authorize).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sign + kill + flatten");
  });

  it("fails closed when the session inventory cannot be refreshed", async () => {
    clientMocks.list.mockRejectedValue(new Error("session inventory unavailable"));
    const { container } = await renderPage();

    expect(findButton(container, "Start run").disabled).toBe(true);
    expect(container.textContent).toContain("Run safety state is unavailable");
    expect(clientMocks.create).not.toHaveBeenCalled();
  });
});

async function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { container, root };
  await act(async () => root.render(createElement(RunsPage)));
  await act(async () => Promise.resolve());
  return { container, root };
}

function session(overrides: Partial<PrivateAutopilotSession> = {}): PrivateAutopilotSession {
  return {
    version: 2,
    autopilot_session_id: "session_123456",
    worker_autopilot_session_id: "worker_123456",
    worker_session_commitment: "worker_commitment_123456",
    owner_commitment: "owner_commitment_123456",
    status: "running",
    strategy: {
      version: 1,
      strategy_id: "momentum_micro_trader",
      decision_model: "ai_direct_order_v1",
      executable_order_source: "ai_structured_decision_validated_by_policy",
      ai_can_execute_directly: true,
    },
    session_policy: {
      strategy_id: "momentum_micro_trader",
      decision_model: "ai_direct_order_v1",
      ai_direct_enabled: true,
      venue_allowlist: ["hyperliquid"],
      market_allowlist: ["BTC-USD"],
      max_notional_bucket: "25",
      max_position_notional_bucket: "100",
      max_loss_bucket: "10",
      max_daily_notional_bucket: "100",
      max_order_count: 12,
      ttl_ms: 604_800_000,
      max_slippage_bps: 50,
      stop_loss_bps: 500,
      take_profit_bps: 1_000,
      cooldown_ms: 60_000,
      data_max_age_ms: 30_000,
      min_ai_score_bps: 6_500,
      ai_min_confidence_bps: 6_500,
      min_signal_bps: 25,
      max_spread_bps: 150,
      allowed_order_types: ["limit_order", "cancel"],
      kill_switch: true,
      reduce_only_on_reconcile_failure: true,
      locale_hint: "en",
      timezone: "America/New_York",
      policy_commitment: "autopilot_policy_123456",
    },
    venue_access: {
      hyperliquid: { status: "ready", execution_mode: "live", reason: null },
      coinbase_advanced: { status: "blocked", execution_mode: null, reason: "disabled" },
      backpack: { status: "blocked", execution_mode: null, reason: "disabled" },
      jupiter: { status: "blocked", execution_mode: null, reason: "disabled" },
      phoenix: { status: "blocked", execution_mode: null, reason: "disabled" },
    },
    order_count: 1,
    daily_notional_used_bucket: "25",
    risk_summary: {
      complete: true,
      stale_markets: [],
      exposure_usd: 10.5,
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 0,
      estimated_total_pnl_usd: 0,
      checked_at: "2026-08-17T12:00:00.000Z",
    },
    created_at: "2026-08-17T12:00:00.000Z",
    updated_at: "2026-08-17T12:00:00.000Z",
    expires_at: "2026-08-24T12:00:00.000Z",
    next_step: "Autonomous worker is running.",
    execution_enabled: true,
    autonomous_live_submit_enabled: true,
    autonomous_execution_mode: "live",
    control_plane: "worker",
    visibility_summary: {
      main_wallet_prompts_per_trade: false,
      execution_boundary: "bounded_delegated_worker_policy",
      user_can_kill_anytime: true,
    },
    ...overrides,
  };
}

function finalFlatSession(base: PrivateAutopilotSession): PrivateAutopilotSession {
  return {
    ...base,
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
      evidence_commitment: "hl_risk_evidence_12345678",
      root_work_order_commitment: "hl_flat_root_12345678",
      reconciled_at: "2026-08-17T12:00:01.000Z",
      completed_at: "2026-08-17T12:00:02.000Z",
    },
  } as PrivateAutopilotSession;
}

function findButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}
