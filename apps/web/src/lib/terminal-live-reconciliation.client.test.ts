import { describe, expect, it, vi } from "vitest";
import {
  pollTerminalLiveReconciliation,
  TERMINAL_LIVE_RECONCILIATION_POLL_MS,
} from "./terminal-live-reconciliation.client";

const PLAN = `sha256:${"a".repeat(64)}`;
const WORK_ORDER = `live_trade_work_order_${"b".repeat(48)}`;

describe("terminal live reconciliation poller", () => {
  it("polls by same-origin JSON POST and accepts a late terminal receipt without rebroadcast", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      calls += 1;
      expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ plan_digest: PLAN });
      if (calls === 1) {
        return Response.json({
          version: 1,
          status: "pending",
          planDigest: PLAN,
          workerWorkOrderCommitment: WORK_ORDER,
          checkedAt: "2026-08-19T12:00:00.000Z",
        }, { status: 202 });
      }
      return Response.json({
        planDigest: PLAN,
        appLiveTradingExecutionRun: {
          status: "reconciled",
          gholaAppLiveTradingExecutionRunCommitment: "result_commitment_terminal",
          workerWorkOrderCommitment: WORK_ORDER,
          liveTradingOrder: { orderId: "hyperliquid:99" },
        },
      }, { status: 202 });
    });

    expect(await pollTerminalLiveReconciliation({ planDigest: PLAN, fetchImpl: fetchMock })).toEqual({
      status: "pending",
      workOrderCommitment: WORK_ORDER,
      checkedAt: "2026-08-19T12:00:00.000Z",
    });
    // A later poll (>1 second by the production cadence) recovers without any POST/rebroadcast.
    expect(TERMINAL_LIVE_RECONCILIATION_POLL_MS).toBeGreaterThan(1_000);
    expect(await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: fetchMock,
      nowMs: Date.parse("2026-08-19T12:00:01.500Z"),
    })).toMatchObject({ status: "terminal", receipt: { status: "reconciled", workOrderCommitment: WORK_ORDER, planDigest: PLAN } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("fails closed for a cross-plan or cross-work-order response", async () => {
    const crossPlan = await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: vi.fn(async () => Response.json({
        version: 1,
        status: "pending",
        planDigest: `sha256:${"c".repeat(64)}`,
        workerWorkOrderCommitment: WORK_ORDER,
        checkedAt: "2026-08-19T12:00:00.000Z",
      }, { status: 202 })),
    });
    expect(crossPlan).toEqual({ status: "unavailable", error: "live_reconciliation_plan_mismatch" });

    const malformedWorkOrder = await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: vi.fn(async () => Response.json({
        version: 1,
        status: "pending",
        planDigest: PLAN,
        workerWorkOrderCommitment: "other_work_order",
        checkedAt: "2026-08-19T12:00:00.000Z",
      }, { status: 202 })),
    });
    expect(malformedWorkOrder).toEqual({ status: "unavailable", error: "live_reconciliation_pending_invalid" });
  });

  it("accepts an exact durable worker no-broadcast receipt as terminal", async () => {
    const result = await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: vi.fn(async () => Response.json({
        planDigest: PLAN,
        appLiveTradingExecutionRun: {
          status: "not_dispatched",
          gholaAppLiveTradingExecutionRunCommitment: "worker_no_broadcast_commitment",
          workerWorkOrderCommitment: WORK_ORDER,
          liveTradingOrder: null,
        },
      }, { status: 200 })),
    });
    expect(result).toMatchObject({
      status: "terminal",
      receipt: { status: "not_dispatched", orderId: null, workOrderCommitment: WORK_ORDER },
    });
  });

  it("accepts only a delayed exact server absence proof", async () => {
    const fetchProof = (checkedAt: string) => vi.fn<typeof fetch>(async () => Response.json({
      version: 1,
      status: "not_dispatched",
      planDigest: PLAN,
      dispatchAbsenceProofCommitment: `live_trade_absence_proof_${"d".repeat(48)}`,
      dispatchAbsenceEvidence: {
        workOrderRecord: false,
        reservation: false,
        workerClaim: false,
        workerIdempotency: false,
        workerCallRequiresDurableRecord: true,
        graceMs: 30_000,
      },
      firstCheckedAt: "2026-08-19T12:00:00.000Z",
      checkedAt,
    }));
    expect(await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: fetchProof("2026-08-19T12:00:29.999Z"),
    })).toEqual({ status: "unavailable", error: "live_reconciliation_absence_proof_invalid" });
    expect(await pollTerminalLiveReconciliation({
      planDigest: PLAN,
      fetchImpl: fetchProof("2026-08-19T12:00:30.000Z"),
    })).toEqual({
      status: "not_dispatched",
      proofCommitment: `live_trade_absence_proof_${"d".repeat(48)}`,
      firstCheckedAt: "2026-08-19T12:00:00.000Z",
      checkedAt: "2026-08-19T12:00:30.000Z",
    });
  });
});
