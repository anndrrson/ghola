export type TerminalPositionPreviewStatus = "planned" | "preparing" | "submitting" | "acknowledged" | "unknown";

export function terminalPositionPreviewStatus(
  liveExecutionStatus: "idle" | "working" | "done" | "unknown" | "error",
  workingStage: "session" | "linking" | "submitting" | null = null,
): TerminalPositionPreviewStatus {
  if (liveExecutionStatus === "working") return workingStage === "submitting" ? "submitting" : "preparing";
  if (liveExecutionStatus === "done") return "acknowledged";
  if (liveExecutionStatus === "unknown") return "unknown";
  return "planned";
}

export function terminalPositionPreviewStatusCopy(status: TerminalPositionPreviewStatus) {
  if (status === "preparing") return {
    label: "preparing · not dispatched",
    detail: "Session and venue checks are still running; no live submit has been dispatched.",
    tone: "neutral" as const,
  };
  if (status === "submitting") return {
    label: "submitting · outcome pending",
    detail: "A live request is in flight. Do not repeat it; P&L remains unavailable without a venue-confirmed fill.",
    tone: "pending" as const,
  };
  if (status === "acknowledged") return {
    label: "acknowledged · fill unverified",
    detail: "The submission receipt is not fill proof. P&L remains unavailable until a venue-confirmed fill establishes a position.",
    tone: "pending" as const,
  };
  if (status === "unknown") return {
    label: "outcome unknown",
    detail: "Exposure may exist. Do not resubmit; reconcile the account stream before relying on position or P&L state.",
    tone: "danger" as const,
  };
  return {
    label: "planned · not submitted",
    detail: "No live submission is acknowledged. P&L remains unavailable until a venue-confirmed fill establishes a position.",
    tone: "neutral" as const,
  };
}
