"use client";

import { useState } from "react";
import { Bot, Check, Loader2, TriangleAlert } from "lucide-react";
import {
  armLevelTriggerAgent,
  levelTriggerSupportsPlan,
  type LevelTriggerPlanInput,
} from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

type ArmState =
  | { status: "idle" }
  | { status: "arming" }
  | { status: "armed"; sessionId: string; sessionStatus: string }
  | { status: "error"; message: string };

// Isolated, additive control: turns the drawn directional plan into a running
// level_trigger agent. Reads only the existing orderDraft and posts to the
// autopilot sessions route — it does not touch the hand-coded trade layout.
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
  const disabled = !ready || !supported || state.status === "arming" || state.status === "armed";

  async function handleArm() {
    if (disabled) return;
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

      {state.status === "armed" ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Agent armed · {state.sessionStatus.replaceAll("_", " ")}
            {state.sessionId ? ` · ${state.sessionId.slice(0, 12)}…` : ""}
          </span>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={handleArm}
            disabled={disabled}
            aria-disabled={disabled}
            className="trade-action flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === "arming" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
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
