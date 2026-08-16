export type TerminalLiveExecutionReceiptStatus = "submitted" | "reconciled";

export interface TerminalLiveExecutionReceipt {
  status: TerminalLiveExecutionReceiptStatus;
  commitment: string;
  orderId: string | null;
  planDigest: string;
  receivedAt: string;
}

export type TerminalLiveExecutionReceiptInspection =
  | { ok: true; receipt: TerminalLiveExecutionReceipt }
  | { ok: false; error: string };

export type TerminalLiveExecutionResponseInspection =
  | { outcome: "acknowledged"; receipt: TerminalLiveExecutionReceipt }
  | { outcome: "rejected"; reason: string }
  | { outcome: "unknown"; reason: string };

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{8,200}$/u;
const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * Treats the gateway response as an acknowledgement, never as fill proof.
 * Unknown/missing states fail closed instead of being relabeled submitted.
 */
export function inspectTerminalLiveExecutionReceipt(
  input: unknown,
  expectedPlanDigest: string,
  nowMs = Date.now(),
): TerminalLiveExecutionReceiptInspection {
  if (!PLAN_DIGEST.test(expectedPlanDigest)) return invalid("execution_plan_digest_invalid");
  const root = record(input);
  const run = record(root?.appLiveTradingExecutionRun);
  if (!run) return invalid("execution_receipt_missing");
  const status = run.status === "submitted" || run.status === "reconciled" ? run.status : null;
  if (!status) return invalid("execution_receipt_status_unverified");
  const commitment = safeIdentifier(run.gholaAppLiveTradingExecutionRunCommitment);
  if (!commitment) return invalid("execution_receipt_commitment_missing");
  const liveOrder = run.liveTradingOrder == null ? null : record(run.liveTradingOrder);
  if (run.liveTradingOrder != null && !liveOrder) return invalid("execution_receipt_order_invalid");
  const orderId = liveOrder?.orderId == null ? null : safeIdentifier(liveOrder.orderId);
  if (liveOrder?.orderId != null && !orderId) return invalid("execution_receipt_order_invalid");
  if (!Number.isFinite(nowMs) || nowMs <= 0) return invalid("execution_receipt_time_invalid");
  return {
    ok: true,
    receipt: {
      status,
      commitment,
      orderId,
      planDigest: expectedPlanDigest,
      receivedAt: new Date(nowMs).toISOString(),
    },
  };
}

export function inspectTerminalLiveExecutionResponse(input: {
  httpOk: boolean;
  body: unknown;
  expectedPlanDigest: string;
  dispatchEvidence?: string | null;
  responsePlanDigest?: string | null;
  nowMs?: number;
}): TerminalLiveExecutionResponseInspection {
  if (!input.httpOk) {
    return input.dispatchEvidence === "not_dispatched"
      ? { outcome: "rejected", reason: rejectionReason(input.body) }
      : { outcome: "unknown", reason: "execution_http_outcome_unknown" };
  }
  if (input.responsePlanDigest !== input.expectedPlanDigest) {
    return { outcome: "unknown", reason: "execution_response_plan_digest_mismatch" };
  }
  const inspected = inspectTerminalLiveExecutionReceipt(
    input.body,
    input.expectedPlanDigest,
    input.nowMs,
  );
  return inspected.ok
    ? { outcome: "acknowledged", receipt: inspected.receipt }
    : { outcome: "unknown", reason: inspected.error };
}

function rejectionReason(value: unknown) {
  const error = record(value)?.error;
  return typeof error === "string" && /^[A-Za-z0-9 _.:/-]{3,160}$/u.test(error)
    ? error
    : "execution_rejected_before_dispatch";
}

export function terminalLiveExecutionReceiptEqual(
  left: TerminalLiveExecutionReceipt,
  right: TerminalLiveExecutionReceipt,
) {
  return left.status === right.status
    && left.commitment === right.commitment
    && left.orderId === right.orderId
    && left.planDigest === right.planDigest
    && left.receivedAt === right.receivedAt;
}

export function terminalLiveExecutionCanSubmit(
  status: "idle" | "working" | "done" | "unknown" | "error",
) {
  return status === "idle" || status === "error";
}

function invalid(error: string): TerminalLiveExecutionReceiptInspection {
  return { ok: false, error };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}
