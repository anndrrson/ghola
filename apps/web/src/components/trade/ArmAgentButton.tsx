"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  killAndFlatPrivateAutopilotSession,
  levelTriggerSupportsPlan,
  type LevelTriggerPlanInput,
  type PrivateAutopilotSession,
} from "@/lib/private-account-client";
import { authorizePrivateAccountWalletRequest } from "@/lib/private-account-wallet-step-up";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

type ArmState =
  | { status: "idle" }
  | { status: "confirming"; confirmationKey: string }
  | { status: "arming" }
  | { status: "session"; session: PrivateAutopilotSession; refreshing?: boolean; killing?: boolean; confirmingFlat?: boolean; flattening?: boolean; controlError?: string }
  | { status: "uncertain"; session: PrivateAutopilotSession; message: string; refreshing?: boolean; flattening?: boolean }
  | { status: "killed"; session?: PrivateAutopilotSession }
  | { status: "error"; message: string };

export function levelTriggerPlanFromOrderDraft(
  orderDraft: PrivateExecutionOrderDraft,
  network: "mainnet" | "testnet" = "mainnet",
): LevelTriggerPlanInput {
  const entryTrigger = orderDraft.agent_entry_trigger ?? "break_level";
  return {
    side: orderDraft.side,
    venueId: orderDraft.venue_id,
    network,
    market: orderDraft.market,
    notionalUsd: Number(orderDraft.quote_size) || 0,
    maxSlippageBps: Number(orderDraft.max_slippage_bps) || 50,
    strategyProfile: orderDraft.agent_strategy_profile ?? "custom",
    entryTrigger,
    exitRule: orderDraft.agent_exit_rule ?? "exit_on_invalidation",
    timeHorizon: orderDraft.agent_time_horizon ?? "until_invalidated",
    triggerLevel: orderDraft.agent_trigger_level ??
      (entryTrigger === "preview_now" ? orderDraft.limit_price : undefined),
    invalidationLevel: orderDraft.agent_invalidation_level,
    strategyNote: orderDraft.agent_strategy_note,
  };
}

// Isolated, additive control: turns the drawn directional plan into a running
// level_trigger agent that trades the user's connected account. Reads only the
// existing orderDraft and posts to the autopilot sessions route — it does not
// touch the hand-coded trade layout.
export function ArmAgentButton({
  orderDraft,
  ready = false,
  network = "mainnet",
}: {
  orderDraft: PrivateExecutionOrderDraft;
  ready?: boolean;
  network?: "mainnet" | "testnet";
}) {
  const [state, setState] = useState<ArmState>({ status: "idle" });
  const armingRef = useRef(false);

  const plan = levelTriggerPlanFromOrderDraft(orderDraft, network);

  const supported = levelTriggerSupportsPlan({
    entryTrigger: plan.entryTrigger,
    triggerLevel: plan.triggerLevel,
    invalidationLevel: plan.invalidationLevel,
  });
  const exactPlanSupported = plan.venueId === "hyperliquid" &&
    Number.isFinite(plan.notionalUsd) && plan.notionalUsd > 0 && plan.notionalUsd <= 100 &&
    ["BTC", "ETH", "SOL", "HYPE"].includes(plan.market.split(/[-/]/)[0]?.toUpperCase() || "");
  const blocked = !ready || !supported || !exactPlanSupported;
  const confirmationKey = agentConfirmationKey(plan, network);
  const sideLabel = plan.side === "buy" ? "Buy" : "Sell";

  useEffect(() => {
    if (state.status !== "confirming") return;
    if (!blocked && state.confirmationKey === confirmationKey) return;
    queueMicrotask(() => setState((current) => (
      current.status === "confirming" && (blocked || current.confirmationKey !== confirmationKey)
        ? { status: "idle" }
        : current
    )));
  }, [blocked, confirmationKey, state]);

  async function confirmAndArm() {
    if (
      armingRef.current
      || state.status !== "confirming"
      || blocked
      || state.confirmationKey !== confirmationKey
    ) {
      setState({ status: "idle" });
      return;
    }
    armingRef.current = true;
    setState({ status: "arming" });
    try {
      const response = await armLevelTriggerAgent(plan);
      setState({ status: "session", session: response.session });
    } catch (error) {
      armingRef.current = false;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not arm the agent.",
      });
    }
  }

  async function handleRefreshSession() {
    if (state.status !== "session" && state.status !== "uncertain") return;
    const current = state;
    setState({ ...current, refreshing: true });
    try {
      const response = await getPrivateAutopilotSession(current.session.autopilot_session_id);
      if (finalFlatProven(response.session)) {
        setState({ status: "killed", session: response.session });
      } else if (current.status === "uncertain") {
        setState({ ...current, session: response.session, refreshing: false });
      } else {
        setState({ status: "session", session: response.session });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh the agent.";
      setState(current.status === "uncertain"
        ? { ...current, refreshing: false, message }
        : { status: "session", session: current.session, controlError: message });
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
        status: "session",
        session: state.session,
        controlError: error instanceof Error ? error.message : "Could not stop the agent.",
      });
    }
  }

  async function handleKillAndFlatSession() {
    if (state.status !== "session" && state.status !== "uncertain") return;
    const session = state.session;
    const path = `/v1/private-account/autopilot/sessions/${encodeURIComponent(session.autopilot_session_id)}/kill-and-flat`;
    try {
      setState(state.status === "uncertain"
        ? { ...state, flattening: true }
        : { status: "session", session, flattening: true });
      const proofHeaders = await authorizePrivateAccountWalletRequest({ path, body: {} });
      const result = await killAndFlatPrivateAutopilotSession(session.autopilot_session_id, { proofHeaders });
      if (!finalFlatProven(result.session)) {
        throw new Error("Worker did not return venue-proven final-flat evidence.");
      }
      setState({ status: "killed", session: result.session });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not kill and flatten the agent.";
      let latest = session;
      try {
        const refreshed = await getPrivateAutopilotSession(session.autopilot_session_id);
        latest = refreshed.session;
        if (finalFlatProven(latest)) {
          setState({ status: "killed", session: latest });
          return;
        }
      } catch {
        // Preserve the last known session and keep the UI fail-closed.
      }
      setState({
        status: "uncertain",
        session: latest,
        message,
      });
    }
  }

  const hint = !exactPlanSupported
    ? "Autonomous arming currently supports exact BTC, ETH, SOL, or HYPE plans on Hyperliquid."
    : !ready
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

      {state.status === "uncertain" ? (
        <KillAndFlatUncertainStatus
          session={state.session}
          message={state.message}
          refreshing={state.refreshing === true}
          flattening={state.flattening === true}
          onRefresh={handleRefreshSession}
          onRetry={handleKillAndFlatSession}
        />
      ) : state.status === "session" ? (
        <AgentSessionStatus
          session={state.session}
          refreshing={state.refreshing === true}
          killing={state.killing === true}
          confirmingFlat={state.confirmingFlat === true}
          flattening={state.flattening === true}
          onRefresh={handleRefreshSession}
          onKill={handleKillSession}
          onRequestKillAndFlat={() => setState({ status: "session", session: state.session, confirmingFlat: true })}
          onCancelKillAndFlat={() => setState({ status: "session", session: state.session })}
          onKillAndFlat={handleKillAndFlatSession}
          controlError={state.controlError}
        />
      ) : state.status === "killed" ? (
        <div className="rounded-md border border-[#1e2a3a] bg-[#090d14] px-3 py-2 text-xs text-[#8b95a8]">
          <p className="flex items-center gap-2"><OctagonX className="h-3.5 w-3.5 shrink-0" />Agent stopped. Draw a new plan to arm another.</p>
          {state.session?.final_flat_evidence ? (
            <p className="mt-2 font-mono text-[9px] text-emerald-200">
              Venue final-flat · zero open orders · {state.session.final_flat_evidence.closes.length} reduce-only fill{state.session.final_flat_evidence.closes.length === 1 ? "" : "s"} · evidence {state.session.final_flat_evidence.evidence_commitment.slice(0, 12)}…
            </p>
          ) : null}
        </div>
      ) : state.status === "confirming" ? (
        <div className="grid gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3">
          <div className="flex items-start gap-2 text-xs leading-5 text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <span>
              This arms an agent that places <strong>{network === "testnet" ? "testnet orders with no real funds" : "real orders on your connected account"}</strong>. It will{" "}
              <strong>{sideLabel.toLowerCase()} ${plan.notionalUsd}</strong> of {plan.market}
              {plan.triggerLevel ? <> when the {plan.entryTrigger.replaceAll("_", " ")} at <strong>{plan.triggerLevel}</strong> triggers</> : <> now</>}
              {plan.invalidationLevel ? <>, and exit if it hits <strong>{plan.invalidationLevel}</strong></> : null}. You can kill it anytime.
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmAndArm}
              disabled={blocked || state.confirmationKey !== confirmationKey}
              aria-disabled={blocked || state.confirmationKey !== confirmationKey}
              className="trade-action flex h-10 flex-1 items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
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
            onClick={() => setState({ status: "confirming", confirmationKey })}
            disabled={blocked || state.status === "arming"}
            aria-disabled={blocked || state.status === "arming"}
            className="trade-action flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === "arming" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            {state.status === "arming"
              ? "Arming agent"
              : "Arm agent for this plan"}
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

function agentConfirmationKey(plan: LevelTriggerPlanInput, network: "mainnet" | "testnet") {
  return JSON.stringify({
    network,
    side: plan.side,
    venueId: plan.venueId,
    market: plan.market,
    notionalUsd: plan.notionalUsd,
    maxSlippageBps: plan.maxSlippageBps,
    strategyProfile: plan.strategyProfile,
    entryTrigger: plan.entryTrigger,
    exitRule: plan.exitRule,
    timeHorizon: plan.timeHorizon,
    triggerLevel: plan.triggerLevel ?? null,
    invalidationLevel: plan.invalidationLevel ?? null,
    strategyNote: plan.strategyNote ?? null,
  });
}

function finalFlatProven(session: PrivateAutopilotSession) {
  const evidence = session.final_flat_evidence;
  return session.status === "killed" && session.execution_enabled === false &&
    evidence?.final_flat_proven === true && evidence.account_flat === true &&
    evidence.open_order_count === 0 && Boolean(evidence.evidence_commitment);
}

function KillAndFlatUncertainStatus({
  session,
  message,
  refreshing,
  flattening,
  onRefresh,
  onRetry,
}: {
  session: PrivateAutopilotSession;
  message: string;
  refreshing: boolean;
  flattening: boolean;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-3 text-xs" role="alert">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-200" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-rose-100">Flatten outcome unconfirmed</p>
          <p className="mt-1 leading-5 text-rose-100/80">
            This screen treats execution as halted and will not allow another agent to arm until venue final-flat evidence is available.
          </p>
          <p className="mt-2 font-mono text-[10px] text-rose-200/80">
            Last worker state: {session.status} · {message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRetry}
              disabled={refreshing || flattening}
              className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-semibold text-rose-100 disabled:opacity-60"
            >
              {flattening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {flattening ? "Retrying flatten" : "Retry kill + flatten"}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || flattening}
              className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 disabled:opacity-60"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh safety state
            </button>
          </div>
          <p className="mt-3 leading-5 text-amber-100">
            If retry cannot reconcile, use each position&apos;s Close · RO control and verify zero open orders before doing anything else.
          </p>
        </div>
      </div>
    </div>
  );
}

function AgentSessionStatus({
  session,
  refreshing,
  killing,
  confirmingFlat,
  flattening,
  onRefresh,
  onKill,
  onRequestKillAndFlat,
  onCancelKillAndFlat,
  onKillAndFlat,
  controlError,
}: {
  session: PrivateAutopilotSession;
  refreshing: boolean;
  killing: boolean;
  confirmingFlat: boolean;
  flattening: boolean;
  onRefresh: () => void;
  onKill: () => void;
  onRequestKillAndFlat: () => void;
  onCancelKillAndFlat: () => void;
  onKillAndFlat: () => void;
  controlError?: string;
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
              disabled={refreshing || killing || flattening}
              className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh status
            </button>
            {view.terminal ? null : (
              <button
                type="button"
                onClick={onKill}
                disabled={killing || refreshing || flattening}
                className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {killing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <OctagonX className="h-3.5 w-3.5" />}
                {killing ? "Stopping" : "Kill agent"}
              </button>
            )}
            {view.terminal ? null : (
              <button
                type="button"
                onClick={onRequestKillAndFlat}
                disabled={killing || refreshing || flattening}
                className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {flattening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                {flattening ? "Flattening" : "Kill + flatten"}
              </button>
            )}
          </div>
          {confirmingFlat ? (
            <div className="mt-3 rounded-md border border-rose-400/30 bg-rose-400/[0.06] p-2 text-[10px] leading-4 text-rose-100" role="alert">
              <p>This disables execution first, cancels every allowed Hyperliquid order, closes allowed positions reduce-only, then waits for venue proof of zero positions and zero open orders.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={onKillAndFlat} className="trade-chip h-8 px-3 font-semibold text-rose-100">Sign + kill + flatten</button>
                <button type="button" onClick={onCancelKillAndFlat} className="trade-chip h-8 px-3">Cancel</button>
              </div>
            </div>
          ) : null}
          {controlError ? (
            <p className="mt-3 flex items-center gap-1.5 text-[10px] leading-4 text-rose-200" role="alert">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {controlError}
            </p>
          ) : null}
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
