import { describe, expect, it } from "vitest";
import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";
import {
  hyperliquidCredentialsSealed,
  hyperliquidAccountTopologyChanged,
  hyperliquidPerpsReadiness,
  hyperliquidSubmissionSignerMode,
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
    expect(hyperliquidPerpsReadiness({ ...base, authenticationLoading: true, authenticated: false }).label).toBe("checking");
    expect(hyperliquidPerpsReadiness({ ...base, credentialsReady: null }).label).toBe("checking");
    expect(hyperliquidPerpsReadiness({ ...base, credentialsReady: false }).label).toBe("credentials required");
    expect(hyperliquidPerpsReadiness({ ...base, account: { ...account, status: "needs_funds" } }).label).toBe("collateral required");
    expect(hyperliquidPerpsReadiness({ ...base, selectedMarketAvailable: false }).label).toBe("selected market unavailable");
    expect(hyperliquidPerpsReadiness(base).label).toBe("ready");
  });

  it("does not confuse sealed credentials with full venue readiness", () => {
    expect(hyperliquidCredentialsSealed({ credentials_sealed: true })).toBe(true);
    expect(hyperliquidCredentialsSealed({ credentials_sealed: false })).toBe(false);
    expect(hyperliquidCredentialsSealed({})).toBe(false);
    expect(hyperliquidCredentialsSealed(null)).toBe(false);
  });

  it("uses the private-account signer for the enabled API-wallet flow", () => {
    expect(hyperliquidSubmissionSignerMode({
      legacyApiKeysEnabled: true,
      privateAccountWalletReady: true,
      perpsTurnkeyConfigured: false,
      perpsTurnkeyAuthenticated: false,
    })).toBe("private_account_wallet");
  });

  it("requires authenticated perps Turnkey outside the API-wallet flow", () => {
    expect(hyperliquidSubmissionSignerMode({
      legacyApiKeysEnabled: false,
      privateAccountWalletReady: true,
      perpsTurnkeyConfigured: true,
      perpsTurnkeyAuthenticated: false,
    })).toBeNull();
  });

  it("preserves a confirmed collateral blocker over a temporary verification stream state", () => {
    const current = { status: "needs_funds", next_step: "Add collateral." } as HyperliquidAccountSnapshot;
    const incoming = { status: "private_mode_waiting", next_step: "Run the no-submit connection check." } as HyperliquidAccountSnapshot;
    expect(mergeHyperliquidAccountSnapshot(current, incoming)).toBe(current);
    expect(mergeHyperliquidAccountSnapshot(null, incoming)).toBe(incoming);
  });

  it("requires authoritative reconciliation before accepting stream topology changes", () => {
    const flat = {
      status: "ready_to_trade",
      position_count: 0,
      open_order_count: 0,
    } as HyperliquidAccountSnapshot;
    expect(hyperliquidAccountTopologyChanged(flat, {
      ...flat,
      open_order_count: 1,
    })).toBe(true);
    expect(hyperliquidAccountTopologyChanged(flat, {
      ...flat,
      position_count: 1,
    })).toBe(true);
    expect(hyperliquidAccountTopologyChanged(flat, {
      ...flat,
      last_event_at: "later",
    })).toBe(false);
    expect(hyperliquidAccountTopologyChanged(null, flat)).toBe(false);
  });
});
