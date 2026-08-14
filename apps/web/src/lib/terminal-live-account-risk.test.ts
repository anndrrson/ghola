import { describe, expect, it } from "vitest";
import type { TerminalLiveAccountView } from "./terminal-live-account";
import {
  deriveTerminalLiveAccountRisk,
  terminalLiveAccountRiskDecisionEqual,
} from "./terminal-live-account-risk";

describe("terminal live account risk interlock", () => {
  it("fails closed for missing, degraded, mismatched, or disabled Hyperliquid account truth", () => {
    expect(derive({ view: null })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ status: "degraded" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ network: "testnet" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ tradingEnabled: false }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ accountStatus: "needs_funds" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ accountSource: "none" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ equityBucket: "none" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ equityBucket: "low" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ equityBucket: "unknown" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ marginUtilizationBucket: "unknown" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ marginUtilizationBucket: "90%+" }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ positionsTruncated: true, positionTotalCount: 13 }) })).toMatchObject({ status: "blocked", allowed: false });
    expect(derive({ view: view({ openOrdersTruncated: true, openOrderTotalCount: 13 }) })).toMatchObject({ status: "blocked", allowed: false });
  });

  it("blocks exposure increases for unknown or critical liquidation proximity", () => {
    expect(derive({ view: view({ positions: [position("unknown")] }) })).toMatchObject({ allowed: false, status: "blocked" });
    expect(derive({ view: view({ positions: [position("at_or_beyond")] }) })).toMatchObject({ allowed: false, status: "blocked" });
    expect(derive({ view: view({ positions: [position("<2%")] }) })).toMatchObject({ allowed: false, status: "blocked" });
  });

  it("warns at 2–5%, allows safer or flat portfolios, and scans every position", () => {
    expect(derive({ view: view({ positions: [position("25%+"), position("2-5%", "position_critical_456")], nearestLiquidationDistance: "2-5%" }) })).toMatchObject({ allowed: true, status: "warning", nearestLiquidationDistance: "2-5%" });
    expect(derive({ view: view({ positions: [position("5-10%")] }) })).toMatchObject({ allowed: true, status: "safe" });
    expect(derive({ view: view({ positions: [], nearestLiquidationDistance: null }) })).toMatchObject({ allowed: true, status: "safe" });
  });

  it("blocks concurrent exposure orders while preserving reduce-only working orders", () => {
    const exposureOrder = { order_handle_commitment: "order_commitment_123", market: "BTC", side: "buy" as const, size_bucket: "0.01-0.1", price_bucket: "10k+", status: "open", reduce_only: false };
    expect(derive({ view: view({ openOrders: [exposureOrder], openOrderTotalCount: 1 }) })).toMatchObject({
      allowed: false,
      status: "blocked",
      reason: expect.stringContaining("cannot be included exactly"),
    });
    expect(derive({ view: view({ openOrders: [exposureOrder, { ...exposureOrder, order_handle_commitment: "order_commitment_456" }], openOrderTotalCount: 2 }) }).reason).toContain("2 exposure-increasing orders are");
    expect(derive({ view: view({ openOrders: [{ ...exposureOrder, reduce_only: true }], openOrderTotalCount: 1 }) })).toMatchObject({ allowed: true, status: "safe" });
    expect(derive({ reduceOnly: true, view: view({ openOrders: [exposureOrder], openOrderTotalCount: 1 }) })).toMatchObject({ allowed: true, status: "safe" });
  });

  it("blocks a causally unresolved order event outside the current snapshot", () => {
    expect(derive({
      view: view({
        openOrders: [],
        openOrderTotalCount: 0,
        orderEvents: [{
          orderHandleCommitment: "new_order_commitment_123",
          market: "BTC",
          status: "open",
          side: "buy",
          sizeBucket: "0.01-0.1",
          priceBucket: "10k+",
          timeBucket: "2026-08-13T02:00:01.000Z",
          observedAtMs: Date.parse("2026-08-13T02:00:01.010Z"),
        }],
      }),
    })).toMatchObject({
      allowed: false,
      status: "blocked",
      reason: expect.stringContaining("unresolved order-state hazard"),
    });
  });

  it("keeps reduce-only exits available during order reconciliation", () => {
    const conflicted = view({
      orderEvents: [{
        orderHandleCommitment: "order_commitment_123",
        market: "ETH",
        status: "open",
        side: "buy",
        sizeBucket: "0.01-0.1",
        priceBucket: "10k+",
        timeBucket: "2026-08-13T01:59:59.000Z",
        observedAtMs: Date.parse("2026-08-13T01:59:59.010Z"),
      }],
      openOrders: [{ order_handle_commitment: "order_commitment_123", market: "BTC", side: "buy", size_bucket: "0.01-0.1", price_bucket: "10k+", status: "open", reduce_only: true }],
      openOrderTotalCount: 1,
    });
    expect(derive({ view: conflicted })).toMatchObject({ allowed: false, status: "blocked" });
    expect(derive({ reduceOnly: true, view: conflicted })).toMatchObject({ allowed: true, status: "safe" });
  });

  it("warns near margin capacity without blocking", () => {
    expect(derive({ view: view({ marginUtilizationBucket: "75-90%" }) })).toMatchObject({ allowed: true, status: "warning" });
    expect(derive({ view: view({ marginUtilizationBucket: "50-75%" }) })).toMatchObject({ allowed: true, status: "safe" });
  });

  it("preserves validated reduce-only exits while keeping degraded streams blocked", () => {
    expect(derive({ reduceOnly: true, view: view({ tradingEnabled: false, positions: [position("<2%")] }) })).toMatchObject({ allowed: true, status: "safe" });
    expect(derive({ reduceOnly: true, view: view({ positionsTruncated: true, positionTotalCount: 13, openOrdersTruncated: true, openOrderTotalCount: 13 }) })).toMatchObject({ allowed: true, status: "safe" });
    expect(derive({ reduceOnly: true, view: view({ status: "degraded", positions: [position("<2%")] }) })).toMatchObject({ allowed: false, status: "blocked" });
  });

  it("is not applicable off Hyperliquid and treats identity changes as distinct decisions", () => {
    expect(derive({ selectedVenue: "coinbase", view: null })).toMatchObject({ allowed: true, status: "not_applicable" });
    const mainnet = derive({ view: view() });
    const testnet = derive({ expectedNetwork: "testnet", view: view({ network: "testnet" }) });
    expect(terminalLiveAccountRiskDecisionEqual(mainnet, { ...mainnet })).toBe(true);
    expect(terminalLiveAccountRiskDecisionEqual(mainnet, { ...mainnet, accountStreamObservedAtMs: (mainnet.accountStreamObservedAtMs ?? 0) + 1 })).toBe(true);
    expect(terminalLiveAccountRiskDecisionEqual(mainnet, testnet)).toBe(false);
  });

  it("binds decisions to the authenticated subject and fails closed without it", () => {
    const subjectA = derive({ subjectScope: "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const subjectB = derive({ subjectScope: "subject_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(subjectA.identityKey).not.toBe(subjectB.identityKey);
    expect(derive({ subjectScope: null })).toMatchObject({ status: "blocked", allowed: false, accountStreamCurrent: false });
  });
});

function derive(overrides: Partial<Parameters<typeof deriveTerminalLiveAccountRisk>[0]> = {}) {
  return deriveTerminalLiveAccountRisk({
    authenticated: true,
    subjectScope: "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    selectedVenue: "hyperliquid",
    expectedNetwork: "mainnet",
    market: "BTC-PERP",
    reduceOnly: false,
    view: view(),
    ...overrides,
  });
}

function view(overrides: Partial<TerminalLiveAccountView> = {}): TerminalLiveAccountView {
  const positions = overrides.positions ?? [position("10-25%")];
  return {
    status: "live", blocker: null, network: "mainnet", accountStatus: "ready_to_trade", accountSource: "sealed_byo", equityBucket: "ready", marginUtilizationBucket: "25-50%", tradingEnabled: true,
    streamStatus: "live", streamAgeMs: 100, streamObservedAtMs: Date.parse("2026-08-13T02:00:00.000Z"), lastCheckedAt: "2026-08-13T02:00:00.000Z",
    nearestLiquidationDistance: positions[0]?.liquidation_distance_bucket ?? null,
    positionTotalCount: positions.length, positionsTruncated: false, openOrderTotalCount: 0, openOrdersTruncated: false,
    positions, openOrders: [], recentFills: [], orderEvents: [], ...overrides,
  };
}

function position(
  liquidation: TerminalLiveAccountView["positions"][number]["liquidation_distance_bucket"],
  commitment = "position_commitment_123",
): TerminalLiveAccountView["positions"][number] {
  return { position_commitment: commitment, market: "BTC", side: "long", size_bucket: "0.01-0.1", entry_price_bucket: "10k+", unrealized_pnl_bucket: "+1-10", leverage_bucket: "5-10x", liquidation_distance_bucket: liquidation };
}
