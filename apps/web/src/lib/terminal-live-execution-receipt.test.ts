import { describe, expect, it } from "vitest";
import {
  inspectTerminalLiveExecutionReceipt,
  inspectTerminalLiveExecutionResponse,
  terminalLiveExecutionCanSubmit,
} from "./terminal-live-execution-receipt";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal live execution receipt", () => {
  it.each(["submitted", "reconciled"] as const)("accepts a strict %s acknowledgement", (status) => {
    expect(inspectTerminalLiveExecutionReceipt({
      appLiveTradingExecutionRun: {
        status,
        gholaAppLiveTradingExecutionRunCommitment: "run_commitment_123",
        liveTradingOrder: { orderId: "venue_order_456" },
      },
    }, DIGEST, NOW)).toEqual({
      ok: true,
      receipt: {
        status,
        commitment: "run_commitment_123",
        orderId: "venue_order_456",
        planDigest: DIGEST,
        receivedAt: "2026-08-13T12:00:00.000Z",
      },
    });
  });

  it.each([
    [{}, "execution_receipt_missing"],
    [{ appLiveTradingExecutionRun: {} }, "execution_receipt_status_unverified"],
    [{ appLiveTradingExecutionRun: { status: "failed", gholaAppLiveTradingExecutionRunCommitment: "run_commitment_123" } }, "execution_receipt_status_unverified"],
    [{ appLiveTradingExecutionRun: { status: "submitted" } }, "execution_receipt_commitment_missing"],
    [{ appLiveTradingExecutionRun: { status: "submitted", gholaAppLiveTradingExecutionRunCommitment: "short" } }, "execution_receipt_commitment_missing"],
    [{ appLiveTradingExecutionRun: { status: "submitted", gholaAppLiveTradingExecutionRunCommitment: "run_commitment_123", liveTradingOrder: { orderId: "bad id" } } }, "execution_receipt_order_invalid"],
  ])("fails closed for malformed success payloads", (payload, error) => {
    expect(inspectTerminalLiveExecutionReceipt(payload, DIGEST, NOW)).toEqual({ ok: false, error });
  });

  it("locks repeat submission after dispatch or acknowledgement", () => {
    expect(terminalLiveExecutionCanSubmit("idle")).toBe(true);
    expect(terminalLiveExecutionCanSubmit("error")).toBe(true);
    expect(terminalLiveExecutionCanSubmit("working")).toBe(false);
    expect(terminalLiveExecutionCanSubmit("unknown")).toBe(false);
    expect(terminalLiveExecutionCanSubmit("done")).toBe(false);
  });

  it("treats every post-dispatch non-success response as unknown", () => {
    expect(inspectTerminalLiveExecutionResponse({
      httpOk: false,
      body: { error: "connector rejected" },
      dispatchEvidence: "dispatched",
      expectedPlanDigest: DIGEST,
      nowMs: NOW,
    })).toEqual({ outcome: "unknown", reason: "execution_http_outcome_unknown" });
  });

  it("permits correction only with authoritative pre-dispatch rejection evidence", () => {
    expect(inspectTerminalLiveExecutionResponse({
      httpOk: false,
      body: { error: "order_plan_binding_expired" },
      dispatchEvidence: "not_dispatched",
      expectedPlanDigest: DIGEST,
      nowMs: NOW,
    })).toEqual({ outcome: "rejected", reason: "order_plan_binding_expired" });
    expect(inspectTerminalLiveExecutionResponse({
      httpOk: false,
      body: { error: "connector rejected" },
      dispatchEvidence: "forged_value",
      expectedPlanDigest: DIGEST,
      nowMs: NOW,
    })).toEqual({ outcome: "unknown", reason: "execution_http_outcome_unknown" });
  });

  it("requires proxy-bound plan identity on successful responses", () => {
    const body = { appLiveTradingExecutionRun: { status: "submitted", gholaAppLiveTradingExecutionRunCommitment: "run_commitment_123" } };
    expect(inspectTerminalLiveExecutionResponse({ httpOk: true, body, expectedPlanDigest: DIGEST, responsePlanDigest: DIGEST, nowMs: NOW }).outcome).toBe("acknowledged");
    expect(inspectTerminalLiveExecutionResponse({ httpOk: true, body, expectedPlanDigest: DIGEST, responsePlanDigest: null, nowMs: NOW }))
      .toEqual({ outcome: "unknown", reason: "execution_response_plan_digest_mismatch" });
    expect(inspectTerminalLiveExecutionResponse({ httpOk: true, body, expectedPlanDigest: DIGEST, responsePlanDigest: `sha256:${"b".repeat(64)}`, nowMs: NOW }))
      .toEqual({ outcome: "unknown", reason: "execution_response_plan_digest_mismatch" });
  });
});
