import {
  tradeOrderPlanIntentMatches,
  tradeOrderPlanMarketContextFresh,
  type TradeOrderPlan,
} from "./trade-order-plan";

export type TerminalLiveDispatchBlocker =
  | "local_preview"
  | "execution_context_changed"
  | "execution_subject_changed"
  | "execution_journal_not_ready"
  | "current_plan_unavailable"
  | "bound_plan_changed"
  | "bound_preview_expired"
  | "bound_market_stale";

export type TerminalLiveDispatchGuard =
  | { allowed: true; blocker: null }
  | { allowed: false; blocker: TerminalLiveDispatchBlocker };

/** Final synchronous gate after an awaited browser execution lock is acquired. */
export function terminalLiveDispatchGuard(input: {
  capturedEpoch: number;
  currentEpoch: number;
  localPreview: boolean;
  subjectMatches: boolean;
  journalReady: boolean;
  currentPlan: TradeOrderPlan | null;
  boundPlan: TradeOrderPlan;
  bindingExpiresAt: string;
  nowMs?: number;
}): TerminalLiveDispatchGuard {
  if (input.localPreview) return blocked("local_preview");
  if (!Number.isSafeInteger(input.capturedEpoch) || input.capturedEpoch !== input.currentEpoch) return blocked("execution_context_changed");
  if (!input.subjectMatches) return blocked("execution_subject_changed");
  if (!input.journalReady) return blocked("execution_journal_not_ready");
  if (!input.currentPlan) return blocked("current_plan_unavailable");
  if (!tradeOrderPlanIntentMatches(input.currentPlan, input.boundPlan)) return blocked("bound_plan_changed");
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = Date.parse(input.bindingExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return blocked("bound_preview_expired");
  if (!tradeOrderPlanMarketContextFresh(input.boundPlan, nowMs)) return blocked("bound_market_stale");
  return { allowed: true, blocker: null };
}

export function terminalLiveDispatchBlockerLabel(blocker: TerminalLiveDispatchBlocker) {
  if (blocker === "local_preview") return "Live execution is disabled on localhost and local previews.";
  if (blocker === "execution_subject_changed") return "The authenticated trading account changed before dispatch. Start again.";
  if (blocker === "execution_journal_not_ready") return "The execution safety ledger changed before dispatch. Review it before retrying.";
  if (blocker === "current_plan_unavailable") return "The current exact order plan became unavailable before dispatch. Start again.";
  if (blocker === "bound_plan_changed") return "The order context changed while waiting for the execution lock. Refresh the bound preview.";
  if (blocker === "bound_preview_expired") return "The bound preview expired while waiting for the execution lock. Refresh it before execution.";
  if (blocker === "bound_market_stale") return "The bound market context expired while waiting for the execution lock. Refresh the preview.";
  return "The order context changed while waiting for the execution lock. Start again.";
}

function blocked(blocker: TerminalLiveDispatchBlocker): TerminalLiveDispatchGuard {
  return { allowed: false, blocker };
}
