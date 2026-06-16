"use client";

import { useState } from "react";
import { Bot, Check, Loader2, OctagonX, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  armLevelTriggerAgent,
  controlPrivateAutopilotSession,
  levelTriggerSupportsPlan,
  type LevelTriggerPlanInput,
} from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

type ArmState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "arming" }
  | { status: "armed"; sessionId: string; sessionStatus: string }
  | { status: "killing"; sessionId: string }
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
      const session = (response as { session?: { autopilot_session_id?: string; status?: string } }).session;
      setState({
        status: "armed",
        sessionId: session?.autopilot_session_id ?? "",
        sessionStatus: session?.status ?? "pending_worker",
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not arm the agent.",
      });
    }
  }

  async function killAgent(sessionId: string) {
    if (!sessionId) {
      setState({ status: "killed" });
      return;
    }
    setState({ status: "killing", sessionId });
    try {
      await controlPrivateAutopilotSession(sessionId, "kill");
      setState({ status: "killed" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not stop the agent.",
      });
    }
  }

  const hint = !ready
    ? "Sign in and connect a venue to arm an agent."
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

      {state.status === "armed" || state.status === "killing" ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Agent armed · {state.status === "armed" ? state.sessionStatus.replaceAll("_", " ") : "stopping"}
              {state.status === "armed" && state.sessionId ? ` · ${state.sessionId.slice(0, 12)}…` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={() => killAgent(state.sessionId)}
            disabled={state.status === "killing"}
            className="trade-chip flex h-10 items-center justify-center gap-2 rounded-md text-sm text-rose-200 disabled:opacity-60"
          >
            {state.status === "killing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <OctagonX className="h-4 w-4" />}
            {state.status === "killing" ? "Stopping" : "Kill agent"}
          </button>
        </div>
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
