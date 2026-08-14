import { describe, expect, it } from "vitest";
import { buildTradeOrderPlan, type TradeOrderPlan, type TradeOrderVenueId } from "./trade-order-plan";
import {
  assertSignedExecutionMaterialMatchesTradeOrderPlan,
  configuredHyperliquidAssetIndex,
  inspectHyperliquidSignedActionForTradeOrderPlan,
  parseSignedExecutionPayload,
} from "./signed-execution-material";

describe("signed execution material binding", () => {
  it("accepts exactly one Hyperliquid IOC order matching every bound field", () => {
    const plan = fixturePlan("hyperliquid");
    expect(validate(request(plan))).toEqual({ ok: true, hyperliquid_asset_index: 7 });
  });

  it.each([
    ["extra order", (body: TestRequest) => body.signedAction.action.orders.push(structuredClone(body.signedAction.action.orders[0])), "hyperliquid_signed_action_order_count_mismatch"],
    ["side", (body: TestRequest) => { body.signedAction.action.orders[0].b = false; }, "hyperliquid_signed_order_side_mismatch"],
    ["price", (body: TestRequest) => { body.signedAction.action.orders[0].p = "62501"; }, "hyperliquid_signed_order_limit_price_mismatch"],
    ["size", (body: TestRequest) => { body.signedAction.action.orders[0].s = "0.0005"; }, "hyperliquid_signed_order_base_size_mismatch"],
    ["TIF", (body: TestRequest) => { body.signedAction.action.orders[0].t.limit.tif = "Gtc"; }, "hyperliquid_signed_order_tif_mismatch"],
    ["reduce-only", (body: TestRequest) => { body.signedAction.action.orders[0].r = true; }, "hyperliquid_signed_order_reduce_only_mismatch"],
    ["network", (body: TestRequest) => { body.signedAction.network = "mainnet"; }, "hyperliquid_signed_action_network_mismatch"],
    ["asset", (body: TestRequest) => { body.signedAction.action.orders[0].a = 8; }, "hyperliquid_signed_order_asset_mismatch"],
  ])("rejects a signed-action %s mismatch", (_label, mutate, error) => {
    const body = request(fixturePlan("hyperliquid"));
    mutate(body);
    expect(validate(body)).toEqual({ ok: false, error });
  });

  it("rejects extra action, order, envelope, and request fields", () => {
    const plan = fixturePlan("hyperliquid");
    for (const mutate of [
      (body: TestRequest) => { (body.signedAction.action as unknown as Record<string, unknown>).builder = {}; },
      (body: TestRequest) => { (body.signedAction.action.orders[0] as unknown as Record<string, unknown>).c = "0x01"; },
      (body: TestRequest) => { (body.signedAction as unknown as Record<string, unknown>).vaultAddress = "0x0000000000000000000000000000000000000000"; },
      (body: TestRequest) => { (body as unknown as Record<string, unknown>).actions = []; },
    ]) {
      const body = request(plan);
      mutate(body);
      expect(validate(body).ok).toBe(false);
    }
  });

  it("fails closed when the server has no configured coin/network asset identity", () => {
    expect(assertSignedExecutionMaterialMatchesTradeOrderPlan(
      request(fixturePlan("hyperliquid")),
      fixturePlan("hyperliquid"),
      { hyperliquidAssetIndex: null },
    )).toEqual({ ok: false, error: "hyperliquid_asset_identity_unconfigured" });
  });

  it("allows a browser inspection without turning it into server authorization", () => {
    const plan = fixturePlan("hyperliquid");
    expect(inspectHyperliquidSignedActionForTradeOrderPlan(request(plan).signedAction, plan)).toEqual({
      ok: true,
      hyperliquid_asset_index: 7,
    });
  });

  it("rejects opaque Phoenix transactions until an instruction verifier exists", () => {
    const plan = fixturePlan("phoenix");
    const body = request(plan) as unknown as Record<string, unknown>;
    delete body.signedAction;
    delete body.hyperliquidAccountCommitment;
    body.ensureWallet = true;
    body.signedTransactionBase64 = "AQIDBA==";
    expect(assertSignedExecutionMaterialMatchesTradeOrderPlan(body, plan, { hyperliquidAssetIndex: null })).toEqual({
      ok: false,
      error: "phoenix_signed_transaction_verifier_unavailable",
    });
    expect(() => parseSignedExecutionPayload("phoenix", "AQIDBA==")).toThrow(/blocked/i);
  });

  it("accepts Coinbase only when no signed or executable sibling material exists", () => {
    const plan = fixturePlan("coinbase");
    const body = request(plan) as unknown as Record<string, unknown>;
    delete body.signedAction;
    delete body.hyperliquidAccountCommitment;
    body.coinbaseAccountCommitment = HASH;
    expect(assertSignedExecutionMaterialMatchesTradeOrderPlan(body, plan, { hyperliquidAssetIndex: null })).toEqual({ ok: true });
    body.signedAction = signedAction();
    expect(assertSignedExecutionMaterialMatchesTradeOrderPlan(body, plan, { hyperliquidAssetIndex: null })).toEqual({
      ok: false,
      error: "coinbase_signed_material_forbidden",
    });
  });

  it("parses only an exact Hyperliquid signed-action envelope", () => {
    const action = signedAction();
    expect(parseSignedExecutionPayload("hyperliquid", JSON.stringify(action))).toEqual({ signedAction: action });
    expect(parseSignedExecutionPayload("hyperliquid", JSON.stringify({ signedAction: action }))).toEqual({ signedAction: action });
    expect(() => parseSignedExecutionPayload("hyperliquid", JSON.stringify({ signedAction: action, actions: [] }))).toThrow(/exact/i);
    expect(() => parseSignedExecutionPayload("coinbase", "{}")).toThrow(/does not accept/i);
  });

  it("loads the asset index only from the exact server coin/network key", () => {
    const plan = fixturePlan("hyperliquid");
    expect(configuredHyperliquidAssetIndex(plan, {
      GHOLA_HYPERLIQUID_TESTNET_BTC_ASSET_INDEX: "7",
    })).toBe(7);
    expect(configuredHyperliquidAssetIndex(plan, {
      GHOLA_HYPERLIQUID_MAINNET_BTC_ASSET_INDEX: "7",
    })).toBeNull();
    expect(configuredHyperliquidAssetIndex(plan, {
      GHOLA_HYPERLIQUID_TESTNET_BTC_ASSET_INDEX: "7.5",
    })).toBeNull();
  });
});

const HASH = "a".repeat(64);

function validate(body: TestRequest) {
  return assertSignedExecutionMaterialMatchesTradeOrderPlan(body, fixturePlan("hyperliquid"), {
    hyperliquidAssetIndex: 7,
  });
}

function fixturePlan(venueId: TradeOrderVenueId): TradeOrderPlan {
  const coin = venueId === "phoenix" ? "SOL" : "BTC";
  const plan = buildTradeOrderPlan({
    venueId,
    network: venueId === "hyperliquid" ? "testnet" : "mainnet",
    coin,
    product: venueId === "coinbase" ? `${coin}-USD` : `${coin}-PERP`,
    side: "buy",
    timeInForce: venueId === "hyperliquid" ? "ioc" : undefined,
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
    nowMs: Date.parse("2026-08-12T12:00:20.000Z"),
  });
  if (!plan) throw new Error("fixture plan invalid");
  return plan;
}

function signedAction() {
  return {
    action: {
      type: "order",
      orders: [{ a: 7, b: true, p: "62500", s: "0.0004", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    },
    nonce: 1_786_534_420_000,
    signature: { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 27 },
    network: "testnet",
  };
}

function request(plan: TradeOrderPlan) {
  return {
    csrfToken: "csrf-token",
    venueIds: [plan.venue_id],
    ensureWallet: false,
    executionCredentialHandleCommitmentsByVenue: { [plan.venue_id]: HASH },
    idempotencyKey: "bound-key",
    submit: true,
    refreshAfterSubmit: true,
    fetchFills: true,
    cancelIfOpen: false,
    tradeOrderPlanBinding: {},
    orderIntent: {
      idempotencyKey: "bound-key",
      venueIds: [plan.venue_id],
      symbol: plan.coin,
      productId: plan.product,
      side: plan.side,
      orderType: plan.order_type,
      timeInForce: plan.time_in_force,
      network: plan.network,
      baseSize: plan.base_size,
      quoteSize: plan.quote_notional_usd,
      limitPrice: plan.limit_price,
      slippageBps: String(plan.max_slippage_bps),
    },
    signedAction: signedAction(),
    hyperliquidAccountCommitment: HASH,
  };
}

type TestRequest = ReturnType<typeof request>;
