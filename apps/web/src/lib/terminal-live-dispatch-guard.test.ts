import { describe, expect, it } from "vitest";
import { buildTradeOrderPlan, type TradeOrderPlan } from "./trade-order-plan";
import { terminalLiveDispatchGuard } from "./terminal-live-dispatch-guard";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal final live dispatch guard", () => {
  it("allows only the unchanged current bound plan", () => {
    expect(guard()).toEqual({ allowed: true, blocker: null });
  });

  it.each([
    ["queued epoch changed", { currentEpoch: 8 }, "execution_context_changed"],
    ["local preview resumed", { localPreview: true }, "local_preview"],
    ["subject changed", { subjectMatches: false }, "execution_subject_changed"],
    ["journal changed", { journalReady: false }, "execution_journal_not_ready"],
    ["plan disappeared", { currentPlan: null }, "current_plan_unavailable"],
    ["binding expired", { nowMs: NOW + 10_000 }, "bound_preview_expired"],
    ["market context expired", { nowMs: NOW + 5_001, bindingExpiresAt: "2026-08-13T12:00:10.000Z" }, "bound_market_stale"],
  ] as const)("blocks when %s", (_label, overrides, blocker) => {
    expect(guard(overrides)).toEqual({ allowed: false, blocker });
  });

  it("blocks a plan or cost-evidence mutation while the browser lock is queued", () => {
    const boundPlan = plan();
    const currentPlan = structuredClone(boundPlan);
    currentPlan.risk_envelope = { ...currentPlan.risk_envelope!, fee_evidence_at: "2026-08-13T11:59:59.500Z" };
    expect(guard({ boundPlan, currentPlan })).toEqual({ allowed: false, blocker: "bound_plan_changed" });
  });
});

function guard(overrides: Partial<Parameters<typeof terminalLiveDispatchGuard>[0]> = {}) {
  const boundPlan = overrides.boundPlan ?? plan();
  return terminalLiveDispatchGuard({
    capturedEpoch: 7,
    currentEpoch: 7,
    localPreview: false,
    subjectMatches: true,
    journalReady: true,
    currentPlan: boundPlan,
    boundPlan,
    bindingExpiresAt: "2026-08-13T12:00:10.000Z",
    nowMs: NOW,
    ...overrides,
  });
}

function plan(): TradeOrderPlan {
  const value = buildTradeOrderPlan({
    venueId: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    timeInForce: "ioc",
    quoteNotionalUsd: 10,
    baseSize: 0.1,
    limitPrice: 100,
    maxSlippageBps: 50,
    stopLevel: 95,
    strategyProfile: "trend_following",
    entryTrigger: "preview_now",
    exitRule: "manual_approval",
    timeHorizon: "scalp",
    triggerLevel: null,
    interval: "1m",
    marketFetchedAt: "2026-08-13T11:59:35.000Z",
    executionReferencePrice: 100,
    frameVersion: 1,
    riskEnvelope: {
      riskBudgetUsd: 1,
      stopAndSlippageLossUsd: 0.55,
      roundTripCostLossUsd: 0.02,
      allInLossUsd: 0.57,
      feeBps: 5,
      bufferBps: 5,
      feeEvidenceAtMs: NOW - 1_000,
      bufferEvidenceAtMs: NOW - 1_000,
    },
    nowMs: NOW,
  });
  if (!value) throw new Error("dispatch_guard_test_plan_invalid");
  return value;
}
