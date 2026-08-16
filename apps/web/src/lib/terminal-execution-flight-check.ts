import type { TerminalTicketField } from "./terminal-command";
import type { TerminalLiveAccountRiskStatus } from "./terminal-live-account-risk";

export type TerminalExecutionFlightStatus = "pass" | "warning" | "blocked" | "pending" | "not_applicable";

export type TerminalExecutionFlightAction =
  | { type: "focus_ticket_field"; field: TerminalTicketField; label: string }
  | { type: "open_auth"; label: string }
  | { type: "focus_element"; elementId: string; label: string };

export interface TerminalExecutionFlightStage {
  id: "market" | "ticket" | "plan" | "risk" | "liquidity" | "portfolio" | "identity" | "venue" | "preview" | "signature" | "journal" | "mode";
  label: string;
  status: TerminalExecutionFlightStatus;
  detail: string;
  action: TerminalExecutionFlightAction | null;
}

export interface TerminalExecutionFlightCheck {
  ready: boolean;
  completedCount: number;
  applicableCount: number;
  blockingCount: number;
  warningCount: number;
  stages: TerminalExecutionFlightStage[];
  firstBlocker: TerminalExecutionFlightStage | null;
}

export interface TerminalExecutionFlightInput {
  localPreview: boolean;
  replayActive: boolean;
  authenticated: boolean;
  marketReady: boolean;
  marketReason: string;
  ticketDraftBlocker: TerminalTicketField | null;
  orderPlanReady: boolean;
  invalidationReady: boolean;
  planMarketReady: boolean;
  planReason: string;
  riskReady: boolean;
  riskReason: string;
  liquidityStatus: "full" | "partial" | "none" | "unavailable";
  liquidityReason: string;
  liquidityRecovery: { elementId: string; label: string } | null;
  portfolioStatus: TerminalLiveAccountRiskStatus;
  portfolioReady: boolean;
  portfolioReason: string;
  venueReady: boolean;
  venueReason: string;
  venueRecoveryElementId: string | null;
  previewState: "ready" | "missing" | "stale" | "unavailable";
  signatureState: "not_required" | "missing" | "invalid" | "ready";
  signatureRecoveryElementId: string | null;
  journalState: "ready" | "loading" | "blocked" | "unresolved";
}

export function deriveTerminalExecutionFlightCheck(input: TerminalExecutionFlightInput): TerminalExecutionFlightCheck {
  const planReady = input.orderPlanReady && input.invalidationReady && input.planMarketReady;
  const livePathLocked = input.localPreview || input.replayActive;
  const stages: TerminalExecutionFlightStage[] = [
    stage(
      "market",
      "Market data",
      input.marketReady ? "pass" : "pending",
      input.marketReady ? "Exact quote identity and freshness certified." : input.marketReason,
      input.marketReady ? null : focusElement("terminal-refresh-market", "Focus feed reconnect"),
    ),
    stage(
      "ticket",
      "Ticket values",
      input.ticketDraftBlocker == null ? "pass" : "blocked",
      input.ticketDraftBlocker == null ? "All decimal values are complete and exact." : "Finish or correct the highlighted decimal value.",
      input.ticketDraftBlocker == null ? null : focusField(input.ticketDraftBlocker),
    ),
    stage(
      "plan",
      "Entry plan",
      planReady ? "pass" : "blocked",
      planReady ? "Entry, invalidation, and current market state agree." : input.planReason,
      planReady ? null : focusField(input.invalidationReady ? "entry" : "invalidation"),
    ),
    stage(
      "risk",
      "Loss budget",
      input.riskReady ? "pass" : "blocked",
      input.riskReason,
      input.riskReady ? null : focusField("risk_budget"),
    ),
    liquidityStage(input.liquidityStatus, input.liquidityReason, input.liquidityRecovery),
    livePathLocked
      ? stage("portfolio", "Portfolio", "not_applicable", "Live portfolio authorization is not evaluated in the current safety mode.", null)
      : portfolioStage(input),
    livePathLocked
      ? stage("identity", "Identity", "not_applicable", "Live application identity is not required in the current safety mode.", null)
      : stage(
        "identity",
        "Identity",
        input.authenticated ? "pass" : "blocked",
        input.authenticated ? "Application session authenticated." : "Sign in before binding or submitting an order.",
        input.authenticated ? null : { type: "open_auth", label: "Sign in" },
      ),
    livePathLocked
      ? stage("venue", "Venue access", "not_applicable", "Venue execution access is not evaluated in the current safety mode.", null)
      : stage(
        "venue",
        "Venue access",
        input.venueReady ? "pass" : "pending",
        input.venueReady ? "Fresh global and selected-venue gates are green." : input.venueReason,
        input.venueReady || !input.venueRecoveryElementId ? null : focusElement(input.venueRecoveryElementId, "Review venue access"),
      ),
    previewStage(livePathLocked ? "unavailable" : input.previewState),
    livePathLocked
      ? stage("signature", "Signature", "not_applicable", "Live signed material is not accepted in the current safety mode.", null)
      : signatureStage(input.signatureState, input.signatureRecoveryElementId),
    livePathLocked
      ? stage("journal", "Safety ledger", "not_applicable", "Live execution history is not required in the current safety mode.", null)
      : journalStage(input.journalState),
    modeStage(input.localPreview, input.replayActive),
  ];
  const applicable = stages.filter((item) => item.status !== "not_applicable");
  const blocking = applicable.filter((item) => item.status === "blocked" || item.status === "pending");
  const firstBlocker = blocking[0] ?? null;
  return {
    ready: firstBlocker == null,
    completedCount: applicable.filter((item) => item.status === "pass" || item.status === "warning").length,
    applicableCount: applicable.length,
    blockingCount: blocking.length,
    warningCount: applicable.filter((item) => item.status === "warning").length,
    stages,
    firstBlocker,
  };
}

function liquidityStage(
  status: TerminalExecutionFlightInput["liquidityStatus"],
  detail: string,
  recovery: TerminalExecutionFlightInput["liquidityRecovery"],
): TerminalExecutionFlightStage {
  if (status === "full") {
    return stage("liquidity", "Visible liquidity", "pass", detail, null);
  }
  return stage(
    "liquidity",
    "Visible liquidity",
    "warning",
    detail,
    focusElement(
      recovery?.elementId ?? "terminal-market-depth",
      recovery?.label ?? "Inspect visible depth",
    ),
  );
}

function journalStage(state: TerminalExecutionFlightInput["journalState"]): TerminalExecutionFlightStage {
  if (state === "ready") return stage("journal", "Safety ledger", "pass", "No unresolved local live submission blocks a new dispatch.", null);
  const detail = state === "loading"
    ? "Restore the local execution safety ledger before submitting."
    : state === "blocked"
      ? "The local execution safety ledger is unavailable or invalid."
      : "A prior live submission remains unacknowledged or unreconciled.";
  return stage("journal", "Safety ledger", state === "loading" ? "pending" : "blocked", detail, focusElement("live-execution-journal", "Review execution safety ledger"));
}

function portfolioStage(input: TerminalExecutionFlightInput): TerminalExecutionFlightStage {
  if (input.portfolioStatus === "not_applicable") {
    return stage("portfolio", "Portfolio", "not_applicable", input.portfolioReason, null);
  }
  if (input.portfolioStatus === "warning" && input.portfolioReady) {
    return stage("portfolio", "Portfolio", "warning", input.portfolioReason, focusElement("terminal-live-account-blotter", "Review portfolio"));
  }
  return stage(
    "portfolio",
    "Portfolio",
    input.portfolioReady ? "pass" : input.portfolioStatus === "checking" ? "pending" : "blocked",
    input.portfolioReason,
    input.portfolioReady ? null : focusElement("terminal-live-account-blotter", "Review portfolio"),
  );
}

function previewStage(state: TerminalExecutionFlightInput["previewState"]): TerminalExecutionFlightStage {
  if (state === "unavailable") return stage("preview", "Bound preview", "not_applicable", "Remote preview is unavailable in the current safety mode.", null);
  if (state === "ready") return stage("preview", "Bound preview", "pass", "Exact plan binding is current and unexpired.", null);
  return stage(
    "preview",
    "Bound preview",
    state === "stale" ? "blocked" : "pending",
    state === "stale" ? "The bound preview no longer matches the ticket or has expired." : "Bind an exact privacy preview before submit.",
    focusElement("terminal-preview-order", state === "stale" ? "Refresh bound preview" : "Focus preview action"),
  );
}

function signatureStage(state: TerminalExecutionFlightInput["signatureState"], recoveryElementId: string | null): TerminalExecutionFlightStage {
  if (state === "not_required") return stage("signature", "Signature", "not_applicable", "No browser-supplied signature is required for this route.", null);
  if (state === "ready") return stage("signature", "Signature", "pass", "Signed material exactly matches the bound plan.", null);
  return stage(
    "signature",
    "Signature",
    state === "invalid" ? "blocked" : "pending",
    state === "invalid" ? "Signed material does not exactly match the bound plan." : "Paste the exact approved signed material.",
    recoveryElementId ? focusElement(recoveryElementId, "Focus signed payload") : null,
  );
}

function modeStage(localPreview: boolean, replayActive: boolean): TerminalExecutionFlightStage {
  if (replayActive) return stage("mode", "Submit mode", "blocked", "Historical replay locks live preview, arming, and submit.", null);
  if (localPreview) return stage("mode", "Submit mode", "blocked", "Local safety mode permits analysis and PAPER only; live submit is disabled.", null);
  return stage("mode", "Submit mode", "pass", "Live submit mode is available; server gates remain authoritative.", null);
}

function stage(
  id: TerminalExecutionFlightStage["id"],
  label: string,
  status: TerminalExecutionFlightStatus,
  detail: string,
  action: TerminalExecutionFlightAction | null,
): TerminalExecutionFlightStage {
  return { id, label, status, detail, action };
}

function focusField(field: TerminalTicketField): TerminalExecutionFlightAction {
  return { type: "focus_ticket_field", field, label: `Focus ${field.replace("_", " ")}` };
}

function focusElement(elementId: string, label: string): TerminalExecutionFlightAction {
  return { type: "focus_element", elementId, label };
}
