import {
  inspectTerminalLiveExecutionReceipt,
  type TerminalLiveExecutionReceipt,
} from "./terminal-live-execution-receipt";

export const TERMINAL_LIVE_RECONCILIATION_POLL_MS = 1_500;

export type TerminalLiveReconciliationPollResult =
  | { status: "pending"; workOrderCommitment: string | null; checkedAt: string }
  | { status: "terminal"; receipt: TerminalLiveExecutionReceipt }
  | { status: "not_dispatched"; proofCommitment: string; firstCheckedAt: string; checkedAt: string }
  | { status: "unavailable"; error: string };

const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WORK_ORDER = /^live_trade_work_order_[a-f0-9]{48}$/u;
const ABSENCE_PROOF = /^live_trade_absence_proof_[a-f0-9]{48}$/u;
const ABSENCE_GRACE_MS = 30_000;

export async function pollTerminalLiveReconciliation(input: {
  planDigest: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<TerminalLiveReconciliationPollResult> {
  if (!PLAN_DIGEST.test(input.planDigest)) {
    return { status: "unavailable", error: "live_plan_digest_invalid" };
  }
  const response = await (input.fetchImpl ?? fetch)(
    "/v1/private-account/live-trading/reconciliation",
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_digest: input.planDigest }),
    },
  ).catch(() => null);
  if (!response) return { status: "unavailable", error: "live_reconciliation_transport_unavailable" };
  const body = await response.json().catch(() => null);
  if (!response.ok) return { status: "unavailable", error: publicError(body) };
  const root = record(body);
  if (root?.planDigest !== input.planDigest) {
    return { status: "unavailable", error: "live_reconciliation_plan_mismatch" };
  }
  if (response.status === 200 && root.status === "not_dispatched") {
    const evidence = record(root.dispatchAbsenceEvidence);
    const proofCommitment = typeof root.dispatchAbsenceProofCommitment === "string" &&
      ABSENCE_PROOF.test(root.dispatchAbsenceProofCommitment)
      ? root.dispatchAbsenceProofCommitment
      : null;
    const firstCheckedAt = strictIso(root.firstCheckedAt);
    const checkedAt = strictIso(root.checkedAt);
    const exactNegativeEvidence = evidence?.workOrderRecord === false &&
      evidence.reservation === false &&
      evidence.workerClaim === false &&
      evidence.workerIdempotency === false &&
      evidence.workerCallRequiresDurableRecord === true &&
      evidence.graceMs === ABSENCE_GRACE_MS;
    return proofCommitment && firstCheckedAt && checkedAt && exactNegativeEvidence &&
      Date.parse(checkedAt) - Date.parse(firstCheckedAt) >= ABSENCE_GRACE_MS
      ? { status: "not_dispatched", proofCommitment, firstCheckedAt, checkedAt }
      : { status: "unavailable", error: "live_reconciliation_absence_proof_invalid" };
  }
  if (response.status === 202 && root.status === "pending") {
    const workOrderCommitment = typeof root.workerWorkOrderCommitment === "string" &&
      WORK_ORDER.test(root.workerWorkOrderCommitment)
      ? root.workerWorkOrderCommitment
      : null;
    const checkedAt = strictIso(root.checkedAt);
    const validAbsenceProbe = root.dispatchAbsencePending === true && strictIso(root.firstCheckedAt) != null;
    return checkedAt && (workOrderCommitment || validAbsenceProbe)
      ? { status: "pending", workOrderCommitment, checkedAt }
      : { status: "unavailable", error: "live_reconciliation_pending_invalid" };
  }
  const inspected = inspectTerminalLiveExecutionReceipt(body, input.planDigest, input.nowMs);
  if (!inspected.ok || (inspected.receipt.status !== "reconciled" && inspected.receipt.status !== "no_fill" &&
    inspected.receipt.status !== "not_dispatched")) {
    return { status: "unavailable", error: inspected.ok
      ? "live_reconciliation_not_terminal"
      : inspected.error };
  }
  return { status: "terminal", receipt: inspected.receipt };
}

function strictIso(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
    ? value
    : null;
}

function publicError(value: unknown) {
  const error = record(value)?.error;
  return typeof error === "string" && /^[A-Za-z0-9 _.:/-]{3,160}$/u.test(error)
    ? error
    : "live_reconciliation_unavailable";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
