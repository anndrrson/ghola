import { describe, expect, it } from "vitest";
import type { PrivateAutopilotSession } from "./private-account-client";
import {
  deriveTerminalAgentActivity,
  TERMINAL_AGENT_ACTIVITY_MAX_SESSIONS,
} from "./terminal-agent-activity";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal agent activity", () => {
  it("aggregates only current active sessions with fresh complete risk", () => {
    const model = deriveTerminalAgentActivity([
      session({ updated_at: iso(-10_000), risk_summary: risk({ checked_at: iso(-9_000), exposure_usd: 20, estimated_total_pnl_usd: 2 }) }),
      session({ autopilot_session_id: "session_current_2", updated_at: iso(-20_000), risk_summary: risk({ checked_at: iso(-18_000), exposure_usd: 30, estimated_total_pnl_usd: -1 }) }),
      session({ autopilot_session_id: "session_paused_3", status: "paused", execution_enabled: false, updated_at: iso(-5_000), risk_summary: risk({ checked_at: iso(-5_000), exposure_usd: 99 }) }),
    ], NOW);
    expect(model).toMatchObject({ valid: true, activeCount: 2, staleCount: 0, riskComplete: true, exposureUsd: 50, pnlUsd: 1 });
  });

  it("withholds all totals when any active risk snapshot is stale or incomplete", () => {
    expect(deriveTerminalAgentActivity([session({ risk_summary: risk({ checked_at: iso(-45_001) }) })], NOW))
      .toMatchObject({ activeCount: 1, riskComplete: false, exposureUsd: null, pnlUsd: null });
    expect(deriveTerminalAgentActivity([session({ risk_summary: risk({ complete: false }) })], NOW))
      .toMatchObject({ riskComplete: false, exposureUsd: null, pnlUsd: null });
    expect(deriveTerminalAgentActivity([session({ risk_summary: risk({ stale_markets: ["BTC"] }) })], NOW))
      .toMatchObject({ riskComplete: false, exposureUsd: null, pnlUsd: null });
  });

  it("never counts stale or expired sessions as active", () => {
    const model = deriveTerminalAgentActivity([
      session({ updated_at: iso(-45_001) }),
      session({ autopilot_session_id: "session_expired_2", expires_at: iso(-1) }),
    ], NOW);
    expect(model).toMatchObject({ activeCount: 0, staleCount: 1, exposureUsd: 0, pnlUsd: 0 });
    expect(model.rows.map((row) => row.temporalStatus)).toEqual(["expired", "stale"]);
  });

  it("does not let contradictory execution flags reactivate terminal sessions", () => {
    expect(deriveTerminalAgentActivity([session({ status: "killed", execution_enabled: true })], NOW))
      .toMatchObject({ valid: true, activeCount: 0, exposureUsd: 0 });
  });

  it("fails closed for future, malformed, unsafe, or oversized input", () => {
    expect(deriveTerminalAgentActivity([session({ updated_at: iso(5_001) })], NOW).valid).toBe(false);
    expect(deriveTerminalAgentActivity([session({ risk_summary: risk({ exposure_usd: -1 }) })], NOW).valid).toBe(false);
    expect(deriveTerminalAgentActivity([session(), session()], NOW).valid).toBe(false);
    expect(deriveTerminalAgentActivity(Array.from({ length: TERMINAL_AGENT_ACTIVITY_MAX_SESSIONS + 1 }, () => session()), NOW).valid).toBe(false);
  });
});

function iso(offsetMs = 0) { return new Date(NOW + offsetMs).toISOString(); }
function risk(overrides: Partial<PrivateAutopilotSession["risk_summary"]> = {}): PrivateAutopilotSession["risk_summary"] {
  return { complete: true, stale_markets: [], exposure_usd: 10, realized_pnl_usd: 0, unrealized_pnl_usd: 1, estimated_total_pnl_usd: 1, checked_at: iso(-1_000), ...overrides };
}
function session(overrides: Partial<PrivateAutopilotSession> = {}): PrivateAutopilotSession {
  return {
    version: 2,
    autopilot_session_id: "session_current_1",
    worker_autopilot_session_id: "worker_session_1",
    worker_session_commitment: "worker_commitment_1",
    owner_commitment: "owner_commitment_1",
    status: "running",
    strategy: { version: 1, strategy_id: "momentum_micro_trader", decision_model: "rules_plus_ai_score", executable_order_source: "deterministic_guarded_strategy", ai_can_execute_directly: false },
    session_policy: {} as PrivateAutopilotSession["session_policy"],
    venue_access: {} as PrivateAutopilotSession["venue_access"],
    order_count: 1,
    daily_notional_used_bucket: "10",
    risk_summary: risk(),
    created_at: iso(-60_000),
    updated_at: iso(-1_000),
    expires_at: iso(60_000),
    next_step: "Watch",
    execution_enabled: true,
    autonomous_live_submit_enabled: false,
    autonomous_execution_mode: "no_submit",
    control_plane: "worker",
    visibility_summary: { main_wallet_prompts_per_trade: false, execution_boundary: "bounded_session_policy", user_can_kill_anytime: true },
    ...overrides,
  };
}
