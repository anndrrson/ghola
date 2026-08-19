export type TerminalLiveExecutionReceiptStatus = "submitted" | "reconciled" | "no_fill" | "not_dispatched";

export interface TerminalLiveExecutionProvenFill {
  filledBaseSize: string;
  averageFillPrice: string;
  feeUsd: string;
  protection:
    | { status: "not_requested" }
    | {
        status: "proven";
        grouping: "normalTpsl";
        triggerSource: "mark";
        triggerOrderType: "bounded_limit";
        maxSlippageBps: number;
      };
}

export interface TerminalLiveExecutionReceipt {
  status: TerminalLiveExecutionReceiptStatus;
  commitment: string;
  orderId: string | null;
  workOrderCommitment: string;
  planDigest: string;
  receivedAt: string;
  /** Authenticated worker data accepted only with a terminal venue fill proof. */
  provenFill?: TerminalLiveExecutionProvenFill;
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
const WORK_ORDER_COMMITMENT = /^live_trade_work_order_[a-f0-9]{48}$/u;

/**
 * Treats nonterminal gateway responses as acknowledgements. Exact fill fields
 * are accepted only inside the server's strict terminal venue-proof shape.
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
  const status = run.status === "submitted" || run.status === "reconciled" || run.status === "no_fill" ||
    run.status === "not_dispatched"
    ? run.status
    : null;
  if (!status) return invalid("execution_receipt_status_unverified");
  const commitment = safeIdentifier(run.gholaAppLiveTradingExecutionRunCommitment);
  if (!commitment) return invalid("execution_receipt_commitment_missing");
  const workOrderCommitment = typeof run.workerWorkOrderCommitment === "string" &&
    WORK_ORDER_COMMITMENT.test(run.workerWorkOrderCommitment)
    ? run.workerWorkOrderCommitment
    : null;
  if (!workOrderCommitment) return invalid("execution_receipt_work_order_missing");
  const liveOrder = run.liveTradingOrder == null ? null : record(run.liveTradingOrder);
  if (run.liveTradingOrder != null && !liveOrder) return invalid("execution_receipt_order_invalid");
  const orderId = liveOrder?.orderId == null ? null : safeIdentifier(liveOrder.orderId);
  if (liveOrder?.orderId != null && !orderId) return invalid("execution_receipt_order_invalid");
  if ((status === "reconciled" || status === "no_fill") && !orderId) {
    return invalid("execution_receipt_order_missing");
  }
  if (status === "not_dispatched" && orderId) return invalid("execution_receipt_order_invalid");
  const provenFill = liveOrder?.venueProvenFill === undefined
    ? undefined
    : inspectTerminalLiveExecutionProvenFill(liveOrder.venueProvenFill);
  if (provenFill === null || (provenFill && status !== "reconciled")) {
    return invalid("execution_receipt_fill_proof_invalid");
  }
  if (!Number.isFinite(nowMs) || nowMs <= 0) return invalid("execution_receipt_time_invalid");
  return {
    ok: true,
    receipt: {
      status,
      commitment,
      orderId,
      workOrderCommitment,
      planDigest: expectedPlanDigest,
      receivedAt: new Date(nowMs).toISOString(),
      ...(provenFill ? { provenFill } : {}),
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
    && left.workOrderCommitment === right.workOrderCommitment
    && left.planDigest === right.planDigest
    && left.receivedAt === right.receivedAt
    && JSON.stringify(left.provenFill ?? null) === JSON.stringify(right.provenFill ?? null);
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

export function inspectTerminalLiveExecutionProvenFill(value: unknown): TerminalLiveExecutionProvenFill | null {
  const fill = record(value);
  if (!fill) return null;
  const filledBaseSize = positiveDecimal(fill.filledBaseSize);
  const averageFillPrice = positiveDecimal(fill.averageFillPrice);
  const feeUsd = unsignedDecimal(fill.feeUsd);
  const protection = record(fill.protection);
  if (!filledBaseSize || !averageFillPrice || feeUsd == null || !protection) return null;
  if (protection.status === "not_requested") {
    return { filledBaseSize, averageFillPrice, feeUsd, protection: { status: "not_requested" } };
  }
  if (protection.status !== "proven" || protection.grouping !== "normalTpsl" ||
      protection.triggerSource !== "mark" || protection.triggerOrderType !== "bounded_limit" ||
      !Number.isInteger(protection.maxSlippageBps) || Number(protection.maxSlippageBps) < 0 ||
      Number(protection.maxSlippageBps) > 10_000) return null;
  return {
    filledBaseSize,
    averageFillPrice,
    feeUsd,
    protection: {
      status: "proven",
      grouping: "normalTpsl",
      triggerSource: "mark",
      triggerOrderType: "bounded_limit",
      maxSlippageBps: Number(protection.maxSlippageBps),
    },
  };
}

function positiveDecimal(value: unknown) {
  const decimal = unsignedDecimal(value);
  return decimal != null && /[1-9]/u.test(decimal) ? decimal : null;
}

function unsignedDecimal(value: unknown) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) &&
    value.length <= 80 && Number.isFinite(Number(value)) ? value : null;
}
