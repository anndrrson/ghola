import { describe, expect, it } from "vitest";
import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";
import {
  hyperliquidCredentialsSealed,
  hyperliquidAccountSnapshotAuthoritative,
  hyperliquidAccountSnapshotUnavailable,
  hyperliquidPerpsReadiness,
  mergeHyperliquidAccountSnapshot,
  spotVenueReadiness,
} from "@/lib/trade-readiness";

describe("trade readiness", () => {
  it("keeps Coinbase spot independent from Phoenix readiness", () => {
    expect(spotVenueReadiness("coinbase", { coinbase_public_live_ready: false, phoenix_public_live_ready: true }).label).toBe("worker unavailable");
    expect(spotVenueReadiness("phoenix", { coinbase_public_live_ready: false, phoenix_public_live_ready: true }).label).toBe("ready");
  });

  it("reports the first actionable Hyperliquid perp prerequisite", () => {
    const account = { status: "ready_to_trade", trading_enabled: true, stream_status: "live", next_step: "", version: 1, platform_class: "hyperliquid_style_market", venue_id: "hyperliquid", account_source: "sealed_byo", equity_bucket: "ready", position_count: 0, open_order_count: 0, last_checked_at: "now" } as const;
    const base = { authenticated: true, network: "testnet" as const, credentialsReady: true, accountState: "ready" as const, account, marketCatalogState: "ready" as const, selectedMarketAvailable: true };
    expect(hyperliquidPerpsReadiness({ ...base, credentialsReady: false }).label).toBe("credentials required");
    expect(hyperliquidPerpsReadiness({ ...base, accountState: "unavailable", credentialsReady: false }).label).toBe("credentials required");
    expect(hyperliquidPerpsReadiness({ ...base, account: { ...account, status: "needs_funds" } }).label).toBe("collateral required");
    expect(hyperliquidPerpsReadiness({ ...base, account: { ...account, status: "private_mode_waiting" } }).label).toBe("verification required");
    expect(hyperliquidPerpsReadiness({ ...base, accountState: "unavailable", account: { ...account, status: "private_mode_waiting" } }).label).toBe("verification required");
    expect(hyperliquidPerpsReadiness({ ...base, selectedMarketAvailable: false }).label).toBe("selected market unavailable");
    expect(hyperliquidPerpsReadiness(base).label).toBe("ready");
  });

  it("does not confuse sealed credentials with full venue readiness", () => {
    expect(hyperliquidCredentialsSealed({ credentials_sealed: true })).toBe(true);
    expect(hyperliquidCredentialsSealed({ credentials_sealed: false })).toBe(false);
    expect(hyperliquidCredentialsSealed({})).toBe(false);
    expect(hyperliquidCredentialsSealed(null)).toBe(false);
  });

  it("preserves a confirmed collateral blocker over a temporary verification stream state", () => {
    const current = { status: "needs_funds", next_step: "Add collateral." } as HyperliquidAccountSnapshot;
    const incoming = { status: "private_mode_waiting", next_step: "Run the no-submit connection check." } as HyperliquidAccountSnapshot;
    expect(mergeHyperliquidAccountSnapshot(current, incoming)).toBe(current);
    expect(mergeHyperliquidAccountSnapshot(null, incoming)).toBe(incoming);
  });

  it("never replaces an authoritative account with a worker-unavailable empty fallback", () => {
    const current = {
      status: "ready_to_trade",
      stream_status: "live",
      positions: [{ position_commitment: "position_1" }],
      open_orders: [],
      recent_fills: [],
    } as HyperliquidAccountSnapshot;
    const incoming = {
      status: "worker_unavailable",
      stream_status: "worker_unavailable",
      positions: [],
      open_orders: [],
      recent_fills: [],
    } as HyperliquidAccountSnapshot;

    expect(hyperliquidAccountSnapshotAuthoritative(current)).toBe(true);
    expect(hyperliquidAccountSnapshotUnavailable(incoming)).toBe(true);
    expect(mergeHyperliquidAccountSnapshot(current, incoming)).toBe(current);
  });

  it("does not treat missing activity arrays as proof that an account is flat", () => {
    const incomplete = {
      status: "ready_to_trade",
      stream_status: "snapshot",
      position_count: 1,
    } as HyperliquidAccountSnapshot;

    expect(hyperliquidAccountSnapshotAuthoritative(incomplete)).toBe(false);
  });
});
