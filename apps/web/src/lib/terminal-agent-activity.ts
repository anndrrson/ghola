import type { PrivateAutopilotSession } from "./private-account-client";

export const TERMINAL_AGENT_ACTIVITY_MAX_SESSIONS = 100;
export const TERMINAL_AGENT_ACTIVITY_MAX_AGE_MS = 45_000;

export type TerminalAgentActivityTemporalStatus = "current" | "stale" | "expired";

export interface TerminalAgentActivityRow {
  session: PrivateAutopilotSession;
  temporalStatus: TerminalAgentActivityTemporalStatus;
  updatedAgeMs: number;
  riskAgeMs: number;
}

export interface TerminalAgentActivityModel {
  valid: boolean;
  activeCount: number;
  staleCount: number;
  riskComplete: boolean;
  exposureUsd: number | null;
  pnlUsd: number | null;
  rows: TerminalAgentActivityRow[];
}

/** Bounded, timestamp-certified activity; stale risk never enters totals. */
export function deriveTerminalAgentActivity(
  sessions: readonly PrivateAutopilotSession[],
  nowMs = Date.now(),
): TerminalAgentActivityModel {
  if (
    !Number.isFinite(nowMs)
    || nowMs <= 0
    || sessions.length > TERMINAL_AGENT_ACTIVITY_MAX_SESSIONS
  ) return invalid();
  const rows: TerminalAgentActivityRow[] = [];
  const ids = new Set<string>();
  for (const session of sessions) {
    const updatedAtMs = canonicalTimestamp(session.updated_at);
    const expiresAtMs = canonicalTimestamp(session.expires_at);
    const riskAtMs = canonicalTimestamp(session.risk_summary?.checked_at);
    if (
      updatedAtMs == null
      || expiresAtMs == null
      || riskAtMs == null
      || updatedAtMs > nowMs + 5_000
      || riskAtMs > nowMs + 5_000
      || !Number.isFinite(session.risk_summary.exposure_usd)
      || session.risk_summary.exposure_usd < 0
      || !Number.isFinite(session.risk_summary.estimated_total_pnl_usd)
      || !Array.isArray(session.risk_summary.stale_markets)
      || session.risk_summary.stale_markets.length > TERMINAL_AGENT_ACTIVITY_MAX_SESSIONS
      || !session.risk_summary.stale_markets.every((market) => typeof market === "string" && /^[A-Z0-9/_:-]{1,32}$/u.test(market))
      || !Number.isSafeInteger(session.order_count)
      || session.order_count < 0
      || typeof session.autopilot_session_id !== "string"
      || !/^[A-Za-z0-9._:-]{8,200}$/u.test(session.autopilot_session_id)
      || ids.has(session.autopilot_session_id)
    ) return invalid();
    ids.add(session.autopilot_session_id);
    const updatedAgeMs = Math.max(0, nowMs - updatedAtMs);
    const riskAgeMs = Math.max(0, nowMs - riskAtMs);
    const temporalStatus = expiresAtMs <= nowMs
      ? "expired" as const
      : updatedAgeMs > TERMINAL_AGENT_ACTIVITY_MAX_AGE_MS
        ? "stale" as const
        : "current" as const;
    rows.push({ session, temporalStatus, updatedAgeMs, riskAgeMs });
  }
  rows.sort((left, right) => Date.parse(right.session.updated_at) - Date.parse(left.session.updated_at));
  const active = rows.filter((row) => row.temporalStatus === "current" && sessionActive(row.session));
  const riskComplete = active.every((row) =>
    row.session.risk_summary.complete
    && row.session.risk_summary.stale_markets.length === 0
    && row.riskAgeMs <= TERMINAL_AGENT_ACTIVITY_MAX_AGE_MS
  );
  return {
    valid: true,
    activeCount: active.length,
    staleCount: rows.filter((row) => row.temporalStatus === "stale").length,
    riskComplete,
    exposureUsd: riskComplete ? sum(active.map((row) => row.session.risk_summary.exposure_usd)) : null,
    pnlUsd: riskComplete ? sum(active.map((row) => row.session.risk_summary.estimated_total_pnl_usd)) : null,
    rows: rows.slice(0, 5),
  };
}

function sessionActive(session: PrivateAutopilotSession) {
  return session.status === "running" || session.status === "watching";
}

function canonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }

function invalid(): TerminalAgentActivityModel {
  return { valid: false, activeCount: 0, staleCount: 0, riskComplete: false, exposureUsd: null, pnlUsd: null, rows: [] };
}
