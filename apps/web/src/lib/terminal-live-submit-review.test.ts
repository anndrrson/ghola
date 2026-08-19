import { describe, expect, it } from "vitest";
import type { TradeOrderPlanBindingEnvelope } from "./trade-order-plan";
import {
  captureTerminalLiveSubmitReview,
  deriveTerminalLiveSubmitLiquidityEvidence,
  terminalLiveSubmitReviewDecision,
} from "./terminal-live-submit-review";

describe("terminal live submit review", () => {
  it("captures an exact display-only snapshot without the authorization token", () => {
    const review = captureTerminalLiveSubmitReview(binding(), 7);
    expect(review).toMatchObject({
      planDigest: "sha256:plan",
      previewCommitment: "preview-1",
      capturedEpoch: 7,
      venueId: "hyperliquid",
      network: "mainnet",
      side: "buy",
      quoteNotionalUsd: "100",
      limitPrice: "101",
      venueProtection: {
        mode: "venue_native_oco",
        takeProfitLevel: "110",
        stopLossLevel: "95",
        maxSlippageBps: 50,
      },
      executionReferencePrice: "100.5",
      stopAndSlippageLossUsd: "5",
      roundTripCostLossUsd: "0.25",
      allInLossUsd: "5.25",
      feeEvidenceAt: "2026-08-13T11:59:00.000Z",
      marketFetchedAt: "2026-08-13T12:00:00.000Z",
      marketMaxAgeMs: 30_000,
    });
    expect(JSON.stringify(review)).not.toContain("secret-token");
  });

  it("allows only the same unexpired preview and execution epoch", () => {
    const review = captureTerminalLiveSubmitReview(binding(), 7);
    expect(terminalLiveSubmitReviewDecision({
      review,
      currentPlanDigest: "sha256:plan",
      currentPreviewCommitment: "preview-1",
      currentEpoch: 7,
      executionReady: true,
      nowMs: Date.parse("2026-08-13T12:00:10.000Z"),
    })).toEqual({ allowed: true, blocker: null });

    expect(terminalLiveSubmitReviewDecision({
      review,
      currentPlanDigest: "sha256:plan",
      currentPreviewCommitment: "preview-2",
      currentEpoch: 7,
      executionReady: true,
      nowMs: Date.parse("2026-08-13T12:00:10.000Z"),
    })).toEqual({ allowed: false, blocker: "preview_changed" });
    expect(terminalLiveSubmitReviewDecision({
      review,
      currentPlanDigest: "sha256:plan",
      currentPreviewCommitment: "preview-1",
      currentEpoch: 8,
      executionReady: true,
      nowMs: Date.parse("2026-08-13T12:00:10.000Z"),
    })).toEqual({ allowed: false, blocker: "execution_context_changed" });
    expect(terminalLiveSubmitReviewDecision({
      review,
      currentPlanDigest: "sha256:plan",
      currentPreviewCommitment: "preview-1",
      currentEpoch: 7,
      executionReady: true,
      nowMs: Date.parse("2026-08-13T12:01:00.000Z"),
    })).toEqual({ allowed: false, blocker: "review_expired" });
  });

  it("fails closed on missing risk authority or malformed chronology", () => {
    const missingRisk = binding();
    delete missingRisk.order_plan.risk_envelope;
    expect(captureTerminalLiveSubmitReview(missingRisk, 0)).toBeNull();
    const badTime = binding();
    badTime.expires_at = badTime.issued_at;
    expect(captureTerminalLiveSubmitReview(badTime, 0)).toBeNull();
    const missingEvidence = binding();
    delete missingEvidence.order_plan.risk_envelope?.fee_evidence_at;
    expect(captureTerminalLiveSubmitReview(missingEvidence, 0)).toBeNull();
    const mismatchedProtection = binding();
    mismatchedProtection.order_plan.protection_intent!.stop_level = "94";
    expect(captureTerminalLiveSubmitReview(mismatchedProtection, 0)).toBeNull();
  });

  it("sanitizes current certified visible-book evidence without binding it", () => {
    const evidence = deriveTerminalLiveSubmitLiquidityEvidence({
      quality: quality({ status: "partial", fillPct: 62.5, filledNotionalUsd: 62.5, unfilledNotionalUsd: 37.5 }),
      bookCertified: true,
      bookAgeMs: 450,
      currentExecutionReferencePrice: 101.5,
      boundReferencePrice: 100.5,
      side: "buy",
    });
    expect(evidence).toMatchObject({
      status: "partial",
      fillPct: 62.5,
      filledNotionalUsd: 62.5,
      unfilledNotionalUsd: 37.5,
      vwap: 101,
      impactBps: 10,
      bookAgeMs: 450,
      currentExecutionReferencePrice: 101.5,
    });
    expect(evidence.adverseDriftBps).toBeCloseTo(99.50248756);
    expect(deriveTerminalLiveSubmitLiquidityEvidence({
      quality: quality(),
      bookCertified: true,
      bookAgeMs: 10,
      currentExecutionReferencePrice: 99,
      boundReferencePrice: 100,
      side: "sell",
    }).adverseDriftBps).toBeCloseTo(100);
    expect(deriveTerminalLiveSubmitLiquidityEvidence({
      quality: quality({ status: "full", fillPct: 100 }),
      bookCertified: false,
      bookAgeMs: 1,
      currentExecutionReferencePrice: 100,
      boundReferencePrice: 100,
      side: "buy",
    }).status).toBe("unavailable");
  });
});

function quality(overrides: Partial<import("./terminal-execution-quality").TerminalExecutionQuality> = {}): import("./terminal-execution-quality").TerminalExecutionQuality {
  return {
    status: "full",
    targetBaseSize: 1,
    filledBaseSize: 1,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    fillPct: 100,
    vwap: 101,
    worstPrice: 101,
    impactBps: 10,
    feeUsd: 0,
    arrivalCostUsd: 0.1,
    allInImpactBps: 10,
    levelsConsumed: 1,
    ...overrides,
  };
}

function binding(): TradeOrderPlanBindingEnvelope {
  return {
    version: 1,
    algorithm: "HMAC-SHA256",
    preview_commitment: "preview-1",
    plan_digest: "sha256:plan",
    issued_at: "2026-08-13T12:00:00.000Z",
    expires_at: "2026-08-13T12:01:00.000Z",
    token: "secret-token",
    order_plan: {
      version: 1,
      kind: "ghola_trade_order_plan",
      venue_id: "hyperliquid",
      network: "mainnet",
      coin: "BTC",
      product: "BTC-PERP",
      side: "buy",
      order_type: "limit",
      time_in_force: "ioc",
      quote_notional_usd: "100",
      base_size: "0.99009901",
      limit_price: "101",
      max_slippage_bps: 50,
      risk_envelope: {
        risk_budget_usd: "10",
        stop_and_slippage_loss_usd: "5",
        round_trip_cost_loss_usd: "0.25",
        all_in_loss_usd: "5.25",
        fee_bps: 5,
        buffer_bps: 7,
        fee_evidence_at: "2026-08-13T11:59:00.000Z",
        buffer_evidence_at: "2026-08-13T11:59:00.000Z",
        scope: "account_local_cost_assumption_v1",
      },
      stop_intent: { stop_level: "95", scope: "agent_plan_invalidation_only" },
      protection_intent: {
        mode: "venue_native_oco",
        trigger_source: "mark",
        take_profit_level: "110",
        stop_level: "95",
        max_slippage_bps: 50,
      },
      agent_mandate: {
        strategy_profile: "manual",
        entry_trigger: "preview_now",
        exit_rule: "manual_approval",
        time_horizon: "scalp",
        trigger_level: null,
        invalidation_level: "95",
      },
      execution_policy: {
        submit: true,
        refresh_after_submit: true,
        fetch_fills: true,
        cancel_if_open: false,
        reduce_only: false,
      },
      market_context: {
        frame_version: 1,
        interval: "1m",
        fetched_at: "2026-08-13T12:00:00.000Z",
        max_age_ms: 30_000,
        source_state: "live",
        execution_reference_price: "100.5",
      },
    },
  };
}
