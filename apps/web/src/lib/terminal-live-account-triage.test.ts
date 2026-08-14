import { describe, expect, it } from "vitest";
import type { TerminalLiveAccountView } from "./terminal-live-account";
import { deriveTerminalLiveAccountTriage } from "./terminal-live-account-triage";

describe("terminal live account triage", () => {
  it("ranks liquidation danger ahead of account blockers and warnings", () => {
    const view = baseView();
    view.marginUtilizationBucket = "75-90%";
    view.positions = [
      position("BTC", "2-5%", "position_commitment_btc"),
      position("ETH", "<2%", "position_commitment_eth"),
    ];
    view.openOrders = [{ order_handle_commitment: "order_commitment_1", market: "SOL", side: "buy", size_bucket: "1-10", price_bucket: "100-1k", status: "open", reduce_only: false }];
    const triage = deriveTerminalLiveAccountTriage(view);

    expect(triage.severity).toBe("critical");
    expect(triage.items.map((item) => item.code)).toEqual([
      "liquidation:position_commitment_eth",
      "working_exposure_orders",
      "margin_warning",
      "liquidation:position_commitment_btc",
    ]);
  });

  it("surfaces stale evidence, truncation, unknown risk, and disabled trading", () => {
    const view = baseView();
    Object.assign(view, {
      status: "degraded",
      blocker: "stream_stale",
      positionsTruncated: true,
      positionTotalCount: 4,
      openOrdersTruncated: true,
      openOrderTotalCount: 3,
      accountStatus: "worker_unavailable",
      tradingEnabled: false,
      marginUtilizationBucket: "unknown",
    });
    const triage = deriveTerminalLiveAccountTriage(view);

    expect(triage.severity).toBe("blocked");
    expect(triage.items).toHaveLength(6);
    expect(triage.hiddenItemCount).toBe(0);
    expect(triage.items.map((item) => item.code)).toEqual(expect.arrayContaining([
      "account_evidence_not_current", "positions_truncated", "orders_truncated", "account_not_ready", "trading_disabled", "margin_unknown",
    ]));
  });

  it("returns clear for a current, ready account without reported hazards", () => {
    expect(deriveTerminalLiveAccountTriage(baseView())).toEqual({ severity: "clear", items: [], hiddenItemCount: 0 });
  });

  it("matches account-source and equity readiness interlocks", () => {
    const view = baseView();
    view.accountSource = "none";
    view.equityBucket = "low";
    expect(deriveTerminalLiveAccountTriage(view).items.map((item) => item.code)).toEqual([
      "account_source_missing",
      "equity_not_ready",
    ]);
  });

  it("caps the action queue deterministically", () => {
    const view = baseView();
    view.positions = Array.from({ length: 8 }, (_, index) => position(`M${index}`, "<2%", `position_commitment_${index}`));
    const triage = deriveTerminalLiveAccountTriage(view);
    expect(triage.items).toHaveLength(6);
    expect(triage.hiddenItemCount).toBe(2);
    expect(triage.items.map((item) => item.market)).toEqual(["M0", "M1", "M2", "M3", "M4", "M5"]);
  });
});

function baseView(): TerminalLiveAccountView {
  return {
    status: "live", blocker: null, network: "mainnet", accountStatus: "ready_to_trade", accountSource: "sealed_byo", equityBucket: "ready", marginUtilizationBucket: "<25%", tradingEnabled: true,
    streamStatus: "live", streamAgeMs: 100, streamObservedAtMs: 1, lastCheckedAt: "2026-08-13T12:00:00.000Z", nearestLiquidationDistance: null,
    positionTotalCount: 0, positionsTruncated: false, openOrderTotalCount: 0, openOrdersTruncated: false,
    positions: [], openOrders: [], recentFills: [], orderEvents: [],
  };
}

function position(market: string, liquidation: "<2%" | "2-5%", commitment: string): TerminalLiveAccountView["positions"][number] {
  return { position_commitment: commitment, market, side: "long", size_bucket: "1-10", entry_price_bucket: "100-1k", unrealized_pnl_bucket: "+1-10", leverage_bucket: "5-10x", liquidation_distance_bucket: liquidation };
}
