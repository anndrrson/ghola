import { describe, expect, it } from "vitest";
import {
  assertExecutionMatchesTradeOrderPlan,
  buildTradeOrderPlan,
  stableTradeStringify,
  tradeOrderPlanIntentMatches,
  tradeOrderPlanMarketContextFresh,
  tradeOrderPlanIdempotencyKey,
  tradeOrderPlanSlippageBound,
  validateTradeOrderPlan,
} from "./trade-order-plan";
import {
  issueTradeOrderPlanBinding,
  tradeOrderPlanDigest,
  verifyTradeOrderPlanBinding,
} from "./trade-order-plan-binding.server";
import { TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS } from "./terminal-route-cost-policy";

const NOW = Date.parse("2026-08-12T12:00:20.000Z");
const SECRET = "test-order-plan-binding-secret";

describe("trade order plan binding", () => {
  it("canonicalizes every execution and agent-plan field deterministically", () => {
    const plan = fixturePlan();
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      version: 1,
      venue_id: "hyperliquid",
      network: "testnet",
      coin: "BTC",
      product: "BTC-PERP",
      side: "buy",
      quote_notional_usd: "25",
      base_size: "0.0004",
      limit_price: "62500",
      max_slippage_bps: 50,
      risk_envelope: {
        risk_budget_usd: "1",
        stop_and_slippage_loss_usd: "0.325",
        round_trip_cost_loss_usd: "0.05",
        all_in_loss_usd: "0.375",
        fee_bps: 5,
        buffer_bps: 5,
        fee_evidence_at: "2026-08-12T12:00:19.000Z",
        buffer_evidence_at: "2026-08-12T12:00:19.000Z",
        scope: "account_local_cost_assumption_v1",
      },
      stop_intent: { stop_level: "62000", scope: "agent_plan_invalidation_only" },
      agent_mandate: {
        strategy_profile: "breakout",
        entry_trigger: "break_level",
        exit_rule: "exit_on_invalidation",
        time_horizon: "intraday",
        trigger_level: "62550",
        invalidation_level: "62000",
      },
      market_context: {
        frame_version: 1,
        interval: "5m",
        fetched_at: "2026-08-12T12:00:00.000Z",
        max_age_ms: 30_000,
        source_state: "live",
        execution_reference_price: "62490",
      },
    });
    expect(stableTradeStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(tradeOrderPlanDigest(plan!)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("issues and verifies a short-lived server-authenticated binding", () => {
    const plan = fixturePlan()!;
    const binding = issueTradeOrderPlanBinding({
      orderPlan: plan,
      previewCommitment: "preview_abc",
      subjectCommitment: "owner_abc",
      previewExpiresAt: "2026-08-12T12:02:00.000Z",
      secret: SECRET,
      nowMs: NOW,
    });
    const verified = verifyTradeOrderPlanBinding(binding, { secret: SECRET, nowMs: NOW + 1_000 });
    expect(verified).toMatchObject({ ok: true, subject_commitment: "owner_abc" });
    expect(binding.expires_at).toBe("2026-08-12T12:00:30.000Z");
  });

  it("rejects tampered and expired bindings", () => {
    const binding = issueTradeOrderPlanBinding({
      orderPlan: fixturePlan()!,
      previewCommitment: "preview_abc",
      subjectCommitment: "owner_abc",
      previewExpiresAt: "2026-08-12T12:02:00.000Z",
      secret: SECRET,
      nowMs: NOW,
    });
    const tampered = structuredClone(binding);
    tampered.order_plan.side = "sell";
    expect(verifyTradeOrderPlanBinding(tampered, { secret: SECRET, nowMs: NOW + 1_000 })).toMatchObject({ ok: false });
    expect(verifyTradeOrderPlanBinding(binding, { secret: SECRET, nowMs: NOW + 11_000 })).toMatchObject({ ok: false, error: "order_plan_binding_expired" });
  });

  it("rejects a still-signed plan when its bound cost evidence expires", () => {
    const orderPlan = fixturePlan()!;
    const evidenceAt = new Date(NOW - TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 5_000).toISOString();
    orderPlan.risk_envelope = { ...orderPlan.risk_envelope!, fee_evidence_at: evidenceAt, buffer_evidence_at: evidenceAt };
    const binding = issueTradeOrderPlanBinding({
      orderPlan,
      previewCommitment: "preview_expiring_cost",
      subjectCommitment: "owner_abc",
      previewExpiresAt: "2026-08-12T12:02:00.000Z",
      secret: SECRET,
      nowMs: NOW,
    });
    expect(verifyTradeOrderPlanBinding(binding, { secret: SECRET, nowMs: NOW + 4_999 }).ok).toBe(true);
    expect(verifyTradeOrderPlanBinding(binding, { secret: SECRET, nowMs: NOW + 5_001 })).toMatchObject({ ok: false, error: "order_plan_risk_envelope_invalid" });
  });

  it("rejects stale data, invalid stop direction, and unsupported plan fields", () => {
    const plan = fixturePlan()!;
    expect(validateTradeOrderPlan(plan, { nowMs: NOW + 11_000 })).toMatchObject({ ok: false, error: "order_plan_market_stale" });
    expect(validateTradeOrderPlan({
      ...plan,
      stop_intent: { ...plan.stop_intent, stop_level: "63000" },
      agent_mandate: { ...plan.agent_mandate, invalidation_level: "63000" },
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_stop_side_invalid" });
    expect(validateTradeOrderPlan({ ...plan, leverage: 10 }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_shape_invalid" });
  });

  it("server-validates the bound all-in loss arithmetic while preserving legacy parsing", () => {
    const plan = fixturePlan()!;
    expect(validateTradeOrderPlan({
      ...plan,
      risk_envelope: { ...plan.risk_envelope!, fee_bps: 6 },
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_risk_envelope_invalid" });
    expect(validateTradeOrderPlan({
      ...plan,
      risk_envelope: { ...plan.risk_envelope!, all_in_loss_usd: "1.1" },
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_risk_envelope_invalid" });
    expect(validateTradeOrderPlan({
      ...plan,
      risk_envelope: { ...plan.risk_envelope!, fee_evidence_at: new Date(NOW - 8 * 86_400_000).toISOString() },
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_risk_envelope_invalid" });
    const legacyRiskTime = structuredClone(plan);
    delete legacyRiskTime.risk_envelope?.fee_evidence_at;
    delete legacyRiskTime.risk_envelope?.buffer_evidence_at;
    expect(validateTradeOrderPlan(legacyRiskTime, { nowMs: NOW }).ok).toBe(true);
    const legacy = structuredClone(plan);
    delete legacy.risk_envelope;
    const legacyValidation = validateTradeOrderPlan(legacy, { nowMs: NOW });
    expect(legacyValidation.ok).toBe(true);
    if (legacyValidation.ok) expect(legacyValidation.plan.risk_envelope).toBeUndefined();
  });

  it("binds a side-specific executable reference and enforces the advertised slippage cap", () => {
    const plan = fixturePlan()!;
    const legacyPlan = structuredClone(plan);
    delete legacyPlan.risk_envelope;
    expect(tradeOrderPlanSlippageBound({
      side: "buy",
      limitPrice: 100.5,
      executionReferencePrice: 100,
      maxSlippageBps: 50,
    })).toMatchObject({ allowed: true, limitOffsetBps: expect.closeTo(50, 8) });
    expect(tradeOrderPlanSlippageBound({
      side: "sell",
      limitPrice: 99.499,
      executionReferencePrice: 100,
      maxSlippageBps: 50,
    })).toMatchObject({ allowed: false });
    expect(tradeOrderPlanSlippageBound({
      side: "buy",
      limitPrice: 99,
      executionReferencePrice: 100,
      maxSlippageBps: 25,
    })).toMatchObject({ allowed: true, limitOffsetBps: expect.closeTo(-100, 8) });
    expect(validateTradeOrderPlan({
      ...legacyPlan,
      limit_price: "63000",
      base_size: "0.00039683",
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_slippage_bound_invalid" });
    expect(validateTradeOrderPlan({
      ...plan,
      base_size: "0.004",
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_size_notional_mismatch" });
    const legacyMarketContext = { ...plan.market_context };
    delete legacyMarketContext.execution_reference_price;
    expect(validateTradeOrderPlan({
      ...plan,
      market_context: legacyMarketContext,
    }, { nowMs: NOW })).toMatchObject({ ok: false, error: "order_plan_slippage_reference_invalid" });
  });

  it("requires the forwarded execution to match every executable field", () => {
    const plan = fixturePlan()!;
    const body = executionFor(plan);
    expect(assertExecutionMatchesTradeOrderPlan(body, plan)).toEqual({ ok: true });
    expect(assertExecutionMatchesTradeOrderPlan({
      ...body,
      orderIntent: { ...body.orderIntent, limitPrice: "62501" },
    }, plan)).toEqual({ ok: false, error: "bound_order_limit_price_mismatch" });
    expect(assertExecutionMatchesTradeOrderPlan({ ...body, venueIds: ["hyperliquid", "phoenix"] }, plan)).toEqual({ ok: false, error: "bound_order_venue_mismatch" });
  });

  it("binds terminal IOC plans exactly while rejecting unsupported venue TIFs", () => {
    const coinbase = buildTradeOrderPlan({
      venueId: "coinbase",
      network: "mainnet",
      coin: "BTC",
      product: "BTC-USD",
      side: "buy",
      timeInForce: "ioc",
      quoteNotionalUsd: 25,
      baseSize: 0.0004,
      limitPrice: 62_500,
      maxSlippageBps: 50,
      stopLevel: 62_000,
      strategyProfile: "breakout",
      entryTrigger: "break_level",
      exitRule: "exit_on_invalidation",
      timeHorizon: "intraday",
      triggerLevel: 62_550,
      interval: "5m",
      marketFetchedAt: "2026-08-12T12:00:00.000Z",
      executionReferencePrice: 62_490,
      frameVersion: 1,
      nowMs: NOW,
    });

    expect(coinbase).toMatchObject({ order_type: "limit", time_in_force: "ioc" });
    expect(assertExecutionMatchesTradeOrderPlan(executionFor(coinbase!), coinbase!)).toEqual({ ok: true });
    expect(validateTradeOrderPlan({ ...fixturePlan()!, time_in_force: "ioc" }, { nowMs: NOW }).ok).toBe(true);
    expect(validateTradeOrderPlan({ ...fixturePlan()!, time_in_force: "fok" }, { nowMs: NOW }))
      .toEqual({ ok: false, error: "order_plan_order_type_invalid" });
    expect(validateTradeOrderPlan({ ...fixturePlan()!, venue_id: "phoenix", network: "mainnet", coin: "SOL", product: "SOL-PERP", time_in_force: "ioc" }, { nowMs: NOW }))
      .toEqual({ ok: false, error: "order_plan_order_type_invalid" });
  });

  it("holds exact editable intent stable across feed timestamps and expires market context", () => {
    const bound = fixturePlan()!;
    const nextFrame = {
      ...bound,
      market_context: {
        ...bound.market_context,
        fetched_at: "2026-08-12T12:00:05.000Z",
        execution_reference_price: "62495",
      },
    };
    expect(tradeOrderPlanIntentMatches(nextFrame, bound)).toBe(true);
    expect(tradeOrderPlanIntentMatches({ ...nextFrame, limit_price: "62501" }, bound)).toBe(false);
    expect(tradeOrderPlanMarketContextFresh(bound, Date.parse("2026-08-12T12:00:29.999Z"))).toBe(true);
    expect(tradeOrderPlanMarketContextFresh(bound, Date.parse("2026-08-12T12:00:30.001Z"))).toBe(false);
  });
});

function fixturePlan() {
  return buildTradeOrderPlan({
    venueId: "hyperliquid",
    network: "testnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    quoteNotionalUsd: 25,
    baseSize: 0.0004,
    limitPrice: 62_500,
    maxSlippageBps: 50,
    stopLevel: 62_000,
    strategyProfile: "breakout",
    entryTrigger: "break_level",
    exitRule: "exit_on_invalidation",
    timeHorizon: "intraday",
    triggerLevel: 62_550,
    interval: "5m",
    marketFetchedAt: "2026-08-12T12:00:00.000Z",
    executionReferencePrice: 62_490,
    frameVersion: 1,
    riskEnvelope: { riskBudgetUsd: 1, stopAndSlippageLossUsd: 0.325, roundTripCostLossUsd: 0.05, allInLossUsd: 0.375, feeBps: 5, bufferBps: 5, feeEvidenceAtMs: NOW - 1_000, bufferEvidenceAtMs: NOW - 1_000 },
    nowMs: NOW,
  });
}

function executionFor(plan: NonNullable<ReturnType<typeof fixturePlan>>) {
  const tradeOrderPlanBinding = { plan_digest: `sha256:${"a".repeat(64)}` };
  const idempotencyKey = tradeOrderPlanIdempotencyKey(tradeOrderPlanBinding);
  return {
    tradeOrderPlanBinding,
    idempotencyKey,
    venueIds: [plan.venue_id],
    submit: true,
    refreshAfterSubmit: true,
    fetchFills: true,
    cancelIfOpen: false,
    orderIntent: {
      idempotencyKey,
      symbol: plan.venue_id === "hyperliquid" ? plan.coin : plan.product,
      productId: plan.product,
      side: plan.side,
      orderType: plan.order_type,
      timeInForce: plan.time_in_force,
      network: plan.network,
      quoteSize: plan.quote_notional_usd,
      baseSize: plan.base_size,
      limitPrice: plan.limit_price,
      slippageBps: String(plan.max_slippage_bps),
    },
  };
}
