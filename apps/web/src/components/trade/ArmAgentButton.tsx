"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Bot,
  Check,
  Clock3,
  Loader2,
  OctagonX,
  RefreshCcw,
  ShieldAlert,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  armLevelTriggerAgent,
  controlPrivateAutopilotSession,
  getPrivateAutopilotSession,
  levelTriggerSupportsPlan,
  type LevelTriggerPlanInput,
  type PrivateAutopilotSession,
} from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

type ArmState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "arming" }
  | { status: "session"; session: PrivateAutopilotSession; refreshing?: boolean; killing?: boolean }
  | { status: "killed" }
  | { status: "error"; message: string };

// Isolated, additive control: turns the drawn directional plan into a running
// level_trigger agent that trades the user's connected account. Reads only the
// existing orderDraft and posts to the autopilot sessions route — it does not
// touch the hand-coded trade layout.
export function ArmAgentButton({
  orderDraft,
  ready = false,
}: {
  orderDraft: PrivateExecutionOrderDraft;
  ready?: boolean;
}) {
  const [state, setState] = useState<ArmState>({ status: "idle" });

  const plan: LevelTriggerPlanInput = {
    side: orderDraft.side,
    venueId: orderDraft.venue_id,
    market: orderDraft.market,
    notionalUsd: Number(orderDraft.quote_size) || 0,
    maxSlippageBps: Number(orderDraft.max_slippage_bps) || 50,
    strategyProfile: orderDraft.agent_strategy_profile ?? "custom",
    entryTrigger: orderDraft.agent_entry_trigger ?? "break_level",
    exitRule: orderDraft.agent_exit_rule ?? "exit_on_invalidation",
    timeHorizon: orderDraft.agent_time_horizon ?? "until_invalidated",
    triggerLevel: orderDraft.agent_trigger_level,
    invalidationLevel: orderDraft.agent_invalidation_level,
    strategyNote: orderDraft.agent_strategy_note,
  };

  const supported = levelTriggerSupportsPlan({
    entryTrigger: plan.entryTrigger,
    triggerLevel: plan.triggerLevel,
    invalidationLevel: plan.invalidationLevel,
  });
  const blocked = !ready || !supported;
  const sideLabel = plan.side === "buy" ? "Buy" : "Sell";

  async function confirmAndArm() {
    setState({ status: "arming" });
    try {
      const response = await armLevelTriggerAgent(plan);
      setState({ status: "session", session: response.session });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not arm the agent.",
      });
    }
  }

  async function handleRefreshSession() {
    if (state.status !== "session") return;
    setState({ ...state, refreshing: true });
    try {
      const response = await getPrivateAutopilotSession(state.session.autopilot_session_id);
      setState({ status: "session", session: response.session });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not refresh the agent.",
      });
    }
  }

  async function handleKillSession() {
    if (state.status !== "session") return;
    setState({ ...state, killing: true });
    try {
      await controlPrivateAutopilotSession(state.session.autopilot_session_id, "kill");
      setState({ status: "killed" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not stop the agent.",
      });
    }
  }

  const hint = !ready
    ? "Sign in and connect scoped venue access to arm an agent."
    : !supported
      ? "Draw an entry level and a stop, with a level-based trigger, to arm an agent."
      : plan.entryTrigger === "preview_now"
        ? "The agent will enter now and manage the stop and horizon."
        : "The agent will watch your level, enter on the trigger, and manage the stop.";

  return (
    <div className="trade-panel mt-4 rounded-md p-4">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="h-4 w-4 text-[#5aa7ff]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#a8d8ff]">Autonomous agent</span>
      </div>

      {state.status === "session" ? (
        <AgentSessionStatus
          session={state.session}
          refreshing={state.refreshing === true}
          killing={state.killing === true}
          onRefresh={handleRefreshSession}
          onKill={handleKillSession}
        />
      ) : state.status === "killed" ? (
        <div className="flex items-center gap-2 rounded-md border border-[#1e2a3a] bg-[#090d14] px-3 py-2 text-xs text-[#8b95a8]">
          <OctagonX className="h-3.5 w-3.5 shrink-0" />
          Agent stopped. Draw a new plan to arm another.
        </div>
      ) : state.status === "confirming" ? (
        <div className="grid gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3">
          <div className="flex items-start gap-2 text-xs leading-5 text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <span>
              This arms an agent that places <strong>real orders on your connected account</strong>. It will{" "}
              <strong>{sideLabel.toLowerCase()} ${plan.notionalUsd}</strong> of {plan.market}
              {plan.triggerLevel ? <> when the {plan.entryTrigger.replaceAll("_", " ")} at <strong>{plan.triggerLevel}</strong> triggers</> : <> now</>}
              {plan.invalidationLevel ? <>, and exit if it hits <strong>{plan.invalidationLevel}</strong></> : null}. You can kill it anytime.
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmAndArm}
              className="trade-action flex h-10 flex-1 items-center justify-center gap-2 rounded-md text-sm font-semibold"
            >
              <Bot className="h-4 w-4" />
              Yes, arm it
            </button>
            <button
              type="button"
              onClick={() => setState({ status: "idle" })}
              className="trade-chip flex h-10 items-center justify-center rounded-md px-4 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setState({ status: "confirming" })}
            disabled={blocked || state.status === "arming"}
            aria-disabled={blocked || state.status === "arming"}
            className="trade-action flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === "arming" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            {state.status === "arming" ? "Arming agent" : "Arm agent for this plan"}
          </button>
          <p className="mt-2 text-[11px] leading-5 text-[#566278]">{hint}</p>
          {state.status === "error" && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] leading-5 text-rose-300">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {state.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function AgentSessionStatus({
  session,
  refreshing,
  killing,
  onRefresh,
  onKill,
}: {
  session: PrivateAutopilotSession;
  refreshing: boolean;
  killing: boolean;
  onRefresh: () => void;
  onKill: () => void;
}) {
  const view = sessionStatusView(session);
  const Icon = view.icon;

  return (
    <div className={`rounded-md border px-3 py-3 text-xs ${view.shellClass}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${view.iconClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className={`font-semibold ${view.titleClass}`}>{view.title}</p>
              <p className="mt-1 leading-5 text-[#8b95a8]">{view.description}</p>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-[#566278]">
              {session.autopilot_session_id.slice(0, 12)}...
            </span>
          </div>

          {view.nextStep ? (
            <p className="mt-2 rounded-md border border-[#1e2a3a] bg-[#05070b] px-2 py-1.5 leading-5 text-[#aab5c8]">
              {view.nextStep}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {view.showFundingCta ? (
              <Link
                href="/private-balance"
                className="trade-action inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold"
              >
                <Wallet className="h-3.5 w-3.5" />
                Fund venue
              </Link>
            ) : null}
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || killing}
              className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh status
            </button>
            {view.terminal ? null : (
              <button
                type="button"
                onClick={onKill}
                disabled={killing || refreshing}
                className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {killing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <OctagonX className="h-3.5 w-3.5" />}
                {killing ? "Stopping" : "Kill agent"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function sessionStatusView(session: PrivateAutopilotSession): {
  title: string;
  description: string;
  nextStep: string | null;
  shellClass: string;
  iconClass: string;
  titleClass: string;
  icon: LucideIcon;
  showFundingCta: boolean;
  terminal: boolean;
} {
  if (session.execution_enabled || session.status === "running" || session.status === "watching") {
    return {
      title: "Agent live",
      description: "The autonomous worker is allowed to execute inside your capped plan.",
      nextStep: session.next_step || "Watching the market and allowed to submit inside your plan.",
      shellClass: "border-emerald-500/30 bg-emerald-500/10",
      iconClass: "text-emerald-200",
      titleClass: "text-emerald-200",
      icon: Check,
      showFundingCta: false,
      terminal: false,
    };
  }

  if (session.status === "pending_funding") {
    return {
      title: "Funding needed before live execution",
      description: "Your agent plan is saved, but no order has been sent. Add or connect venue funds before this session can trade.",
      nextStep: "Next step: fund or connect a venue account, then refresh status. The agent stays idle until funds are ready.",
      shellClass: "border-amber-400/30 bg-amber-400/10",
      iconClass: "text-amber-200",
      titleClass: "text-amber-100",
      icon: Wallet,
      showFundingCta: true,
      terminal: false,
    };
  }

  if (session.status === "pending_worker") {
    return {
      title: "Worker not armed yet",
      description: "Your plan is saved, but the private worker has not accepted the autonomous session. No order has been sent.",
      nextStep: session.next_step || "Refresh status after the private worker comes online.",
      shellClass: "border-amber-400/30 bg-amber-400/10",
      iconClass: "text-amber-200",
      titleClass: "text-amber-100",
      icon: Clock3,
      showFundingCta: false,
      terminal: false,
    };
  }

  if (session.status === "blocked" || session.status === "killed" || session.status === "expired") {
    return {
      title: `Agent ${session.status.replaceAll("_", " ")}`,
      description: "This session cannot execute. Create a new plan after resolving the blocker.",
      nextStep: session.next_step || "Create a new plan after resolving the blocker.",
      shellClass: "border-rose-400/30 bg-rose-400/10",
      iconClass: "text-rose-200",
      titleClass: "text-rose-200",
      icon: TriangleAlert,
      showFundingCta: false,
      terminal: true,
    };
  }

  return {
    title: `Agent ${session.status.replaceAll("_", " ")}`,
    description: "Your agent session is staged. No order has been sent until execution is enabled.",
    nextStep: session.next_step || null,
    shellClass: "border-[#1e2a3a] bg-[#090d14]",
    iconClass: "text-[#5aa7ff]",
    titleClass: "text-[#eef1f8]",
    icon: Bot,
    showFundingCta: false,
    terminal: false,
  };
}
