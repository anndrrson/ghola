"use client";

import { memo, useEffect, useState } from "react";
import {
  listPrivateAutopilotSessions,
  type PrivateAutopilotSession,
  type PrivateAutopilotStatus,
} from "@/lib/private-account-client";
import {
  deriveTerminalAgentActivity,
  type TerminalAgentActivityTemporalStatus,
} from "@/lib/terminal-agent-activity";

export interface TerminalAgentActivityProps {
  authenticated: boolean;
  authenticatedSubject: string | null;
  localPreview: boolean;
  onSignIn: () => void;
}

export function terminalAgentActivityPropsEqual(
  left: TerminalAgentActivityProps,
  right: TerminalAgentActivityProps,
) {
  return left.authenticated === right.authenticated &&
    left.authenticatedSubject === right.authenticatedSubject &&
    left.localPreview === right.localPreview &&
    left.onSignIn === right.onSignIn;
}

export const TerminalAgentActivity = memo(function TerminalAgentActivity({
  authenticated,
  authenticatedSubject,
  localPreview,
  onSignIn,
}: TerminalAgentActivityProps) {
  const [sessions, setSessions] = useState<PrivateAutopilotSession[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSessions(null);
    setFailed(false);
    if (!authenticated || !authenticatedSubject || localPreview) return;
    let cancelled = false;
    let pollTimer: number | null = null;
    let activeController: AbortController | null = null;
    async function load() {
      if (cancelled || activeController) return;
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const body = await listPrivateAutopilotSessions({ signal: controller.signal });
        if (!cancelled) {
          setSessions(body.autopilot_sessions ?? []);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        if (!cancelled) pollTimer = window.setTimeout(() => void load(), 20_000);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (pollTimer != null) window.clearTimeout(pollTimer);
      activeController?.abort();
      activeController = null;
    };
  }, [authenticated, authenticatedSubject, localPreview]);

  if (localPreview) {
    return (
      <div className="px-4 py-4">
        <p className="text-xs leading-5 text-[#6f7d9a]">Runtime activity is intentionally offline in local preview.</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-300">No worker started</p>
      </div>
    );
  }
  if (!authenticated) {
    return (
      <div className="px-4 py-4">
        <p className="text-xs leading-5 text-[#566278]">Your agent&apos;s sessions, decisions, and orders show up here.</p>
        <button type="button" onClick={onSignIn} className="trade-chip mt-2 h-8 rounded-md px-3 text-xs">Sign in to view</button>
      </div>
    );
  }
  if (failed) return <p className="px-4 py-4 text-xs text-[#566278]">Agent activity is unavailable right now.</p>;
  if (sessions == null) return <p className="px-4 py-4 text-xs text-[#566278]">Checking agent sessions...</p>;
  if (sessions.length === 0) {
    return <p className="px-4 py-4 text-xs leading-5 text-[#566278]">No agent sessions yet. Drag the entry and plan invalidation lines on the chart, then preview the plan and arm an agent.</p>;
  }

  const activity = deriveTerminalAgentActivity(sessions);
  if (!activity.valid) return <p className="px-4 py-4 text-xs text-rose-200">Agent activity failed strict validation; retained values are hidden.</p>;
  return (
    <div className="px-4 py-3">
      <div className="mb-3 grid grid-cols-4 gap-2 border-b border-[#141d2e] pb-3">
        <ActivityMetric label="Active" value={String(activity.activeCount)} />
        <ActivityMetric label="Stale" value={String(activity.staleCount)} tone={activity.staleCount ? "bad" : "neutral"} />
        <ActivityMetric label="Exposure" value={activity.exposureUsd == null ? "—" : `$${formatCompactNumber(activity.exposureUsd)}`} />
        <ActivityMetric label="Marked P&L" value={formatSignedUsd(activity.pnlUsd)} tone={activity.pnlUsd == null ? "neutral" : activity.pnlUsd >= 0 ? "good" : "bad"} />
      </div>
      {!activity.riskComplete ? <p className="mb-2 text-[10px] text-amber-300">Active-session risk is incomplete or expired; exposure and P&amp;L totals are withheld.</p> : null}
      <div className="grid gap-2">
        {activity.rows.map(({ session, temporalStatus }) => {
          const copy = autopilotStatusCopy(session, temporalStatus);
          return (
            <div key={session.autopilot_session_id} className="rounded-md border border-[#1e2a3a] bg-[#090d14] px-3 py-2 shadow-[inset_0_1px_0_rgba(220,238,255,0.04)]">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-[#eef1f8]"><span aria-hidden className={`trade-live-dot h-1.5 w-1.5 rounded-full ${autopilotStatusDot(session.status, temporalStatus)}`} />{copy.label}</span>
                <span className="font-mono text-[10px] tabular-nums text-[#566278]">{formatAgo(session.updated_at)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#8b95a8]">
                <span className="shrink-0 font-mono tabular-nums">{session.order_count} order{session.order_count === 1 ? "" : "s"}</span>
                <span className="truncate text-right">{copy.nextStep}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}, terminalAgentActivityPropsEqual);

function ActivityMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return <div className="min-w-0"><p className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</p><p className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#c7d2e4]"}`}>{value}</p></div>;
}

function autopilotStatusCopy(session: PrivateAutopilotSession, temporalStatus: TerminalAgentActivityTemporalStatus): { label: string; nextStep: string } {
  if (temporalStatus === "stale") return { label: "State stale", nextStep: "The session update expired; no activity or risk total is inferred." };
  if (temporalStatus === "expired") return { label: "Expired", nextStep: "The session TTL elapsed; create a new bounded session if needed." };
  if ((session.execution_enabled || session.status === "running" || session.status === "watching") && (session.autonomous_live_submit_enabled !== true || session.autonomous_execution_mode === "no_submit")) {
    return { label: "Verification only", nextStep: session.next_step || "Evaluating bounded orders without broadcasting to a venue." };
  }
  if (session.execution_enabled || session.status === "running") return { label: "Agent live", nextStep: session.next_step || "Watching and allowed to execute inside your plan." };
  if (session.status === "watching") return { label: "Watching market", nextStep: session.next_step || "Waiting for the trigger before submitting an order." };
  if (session.status === "pending_funding") return { label: "Funding needed", nextStep: "No order sent. Fund or connect venue funds, then refresh status." };
  if (session.status === "pending_worker") return { label: "Worker starting", nextStep: session.next_step || "Waiting for the private worker to accept the session." };
  if (session.status === "armed") return { label: "Agent staged", nextStep: session.next_step || "No order sent until execution is enabled." };
  if (session.status === "paused") return { label: "Paused", nextStep: session.next_step || "Resume when you want the agent to continue." };
  if (session.status === "blocked") return { label: "Blocked", nextStep: session.next_step || "Resolve the blocker before this session can execute." };
  if (session.status === "killed") return { label: "Killed", nextStep: session.next_step || "Create a new plan to continue." };
  return { label: "Expired", nextStep: session.next_step || "Create a new agent session." };
}

function autopilotStatusDot(status: PrivateAutopilotStatus, temporalStatus: TerminalAgentActivityTemporalStatus) {
  if (temporalStatus !== "current") return "bg-[#566278]";
  if (status === "running" || status === "watching") return "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]";
  if (status === "armed") return "bg-[#5aa7ff] shadow-[0_0_8px_rgba(90,167,255,0.8)]";
  if (status === "paused" || status === "pending_worker" || status === "pending_funding") return "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  return "bg-[#566278]";
}

function formatAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "now";
  const seconds = Math.floor(diff / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function formatCompactNumber(value: number) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value) : "-";
}

function formatSignedUsd(value: number | null) {
  return value != null && Number.isFinite(value) ? `${value > 0 ? "+" : value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}` : "—";
}
