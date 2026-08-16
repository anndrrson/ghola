import { describe, expect, it } from "vitest";
import type { TerminalLiveAccountView } from "./terminal-live-account";
import { deriveTerminalLiveOrderReconciliation } from "./terminal-live-order-reconciliation";

const SNAPSHOT_AT = "2026-08-13T12:00:00.000Z";

describe("terminal live order reconciliation", () => {
  it("blocks a terminal event that the later snapshot still reports open", () => {
    const reconciliation = deriveTerminalLiveOrderReconciliation(view({
      orderEvents: [event("canceled", "2026-08-13T11:59:59.000Z")],
    }));
    expect(reconciliation).toMatchObject({ status: "conflict", blocksExposureIncrease: true });
    expect(reconciliation.items[0]).toMatchObject({ code: "terminal_snapshot_conflict", market: "BTC" });
  });

  it("blocks a newer working event absent from the older snapshot", () => {
    const reconciliation = deriveTerminalLiveOrderReconciliation(view({
      openOrders: [],
      openOrderTotalCount: 0,
      orderEvents: [event("open", "2026-08-13T12:00:01.000Z", "new_order_commitment_123")],
    }));
    expect(reconciliation).toMatchObject({ status: "pending", blocksExposureIncrease: true });
    expect(reconciliation.items[0]?.code).toBe("working_event_ahead");
  });

  it("treats a newer terminal event as de-risking evidence pending snapshot confirmation", () => {
    const reconciliation = deriveTerminalLiveOrderReconciliation(view({
      orderEvents: [event("filled", "2026-08-13T12:00:01.000Z")],
    }));
    expect(reconciliation).toMatchObject({ status: "pending", blocksExposureIncrease: false });
    expect(reconciliation.items[0]?.code).toBe("terminal_event_ahead");
  });

  it("uses the newest event and rejects commitment identity collisions", () => {
    const reconciliation = deriveTerminalLiveOrderReconciliation(view({
      orderEvents: [
        event("open", "2026-08-13T11:59:58.000Z"),
        { ...event("open", "2026-08-13T11:59:59.000Z"), market: "ETH" },
      ],
    }));
    expect(reconciliation).toMatchObject({ status: "conflict", blocksExposureIncrease: true });
    expect(reconciliation.items[0]?.code).toBe("identity_conflict");
  });

  it("does not claim lifecycle proof when bounded history has no matching event", () => {
    expect(deriveTerminalLiveOrderReconciliation(view({ orderEvents: [] }))).toMatchObject({
      status: "limited",
      blocksExposureIncrease: false,
      snapshotOnlyOrderCount: 1,
    });
  });
});

function view(overrides: Partial<TerminalLiveAccountView> = {}): TerminalLiveAccountView {
  return {
    status: "live", blocker: null, network: "mainnet", accountStatus: "ready_to_trade", accountSource: "sealed_byo", equityBucket: "ready", marginUtilizationBucket: "25-50%", tradingEnabled: true,
    streamStatus: "live", streamAgeMs: 100, streamObservedAtMs: Date.parse(SNAPSHOT_AT), lastCheckedAt: SNAPSHOT_AT, nearestLiquidationDistance: null,
    positionTotalCount: 0, positionsTruncated: false, openOrderTotalCount: 1, openOrdersTruncated: false, positions: [],
    openOrders: [{ order_handle_commitment: "order_commitment_123", market: "BTC", side: "buy", size_bucket: "0.01-0.1", price_bucket: "10k+", status: "open", reduce_only: true }],
    recentFills: [], orderEvents: [], ...overrides,
  };
}

function event(status: string, timeBucket: string, orderHandleCommitment = "order_commitment_123") {
  return { orderHandleCommitment, market: "BTC", status, side: "buy" as const, sizeBucket: "0.01-0.1", priceBucket: "10k+", timeBucket, observedAtMs: Date.parse(timeBucket) + 10 };
}
