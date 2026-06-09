import { describe, expect, it } from "vitest";
import {
  equityForShares,
  isPoolRedemptionPercentBucket,
  poolNavSnapshot,
  sharesForContribution,
  sharesForRedemptionBucket,
} from "./private-account-pool-ledger";

describe("pool share math", () => {
  it("issues shares at par into an empty pool", () => {
    expect(sharesForContribution(25_000_000, 0, 0)).toBe(25_000_000);
  });

  it("issues fewer shares when NAV is above par", () => {
    // Pool holds 200 equity against 100 shares (NAV 2.0): 50 buys 25 shares.
    expect(sharesForContribution(50_000_000, 200_000_000, 100_000_000)).toBe(25_000_000);
  });

  it("issues more shares when NAV is below par", () => {
    // Pool lost half (NAV 0.5): 50 buys 100 shares.
    expect(sharesForContribution(50_000_000, 50_000_000, 100_000_000)).toBe(100_000_000);
  });

  it("refuses contributions to a wiped-out pool with outstanding shares", () => {
    expect(sharesForContribution(50_000_000, 0, 100_000_000)).toBeNull();
  });

  it("redeems pro-rata at current NAV", () => {
    expect(equityForShares(25_000_000, 200_000_000, 100_000_000)).toBe(50_000_000);
  });

  it("caps redemption at total outstanding shares", () => {
    expect(equityForShares(150_000_000, 200_000_000, 100_000_000)).toBe(200_000_000);
  });

  it("floors so redemptions can never exceed pool equity", () => {
    // 3 holders of 1 share each over 100 equity: each floor(33.33) = 33.
    const total = equityForShares(1, 100, 3) * 3;
    expect(total).toBeLessThanOrEqual(100);
  });

  it("round-trips contribute-then-redeem without value creation", () => {
    const equity = 123_456_789;
    const shares = 987_654_321;
    const contribution = 10_000_000;
    const minted = sharesForContribution(contribution, equity, shares);
    expect(minted).not.toBeNull();
    const redeemed = equityForShares(minted!, equity + contribution, shares + minted!);
    expect(redeemed).toBeLessThanOrEqual(contribution);
    expect(redeemed).toBeGreaterThan(contribution - 2);
  });

  it("reports NAV per share and handles the empty pool", () => {
    expect(poolNavSnapshot(0, 0).nav_per_share_micro_usdc).toBeNull();
    expect(poolNavSnapshot(200_000_000, 100_000_000).nav_per_share_micro_usdc).toBe(2_000_000);
  });

  it("computes percent-bucket share redemptions", () => {
    expect(sharesForRedemptionBucket(100_000_000, "25")).toBe(25_000_000);
    expect(sharesForRedemptionBucket(100_000_000, "50")).toBe(50_000_000);
    expect(sharesForRedemptionBucket(100_000_001, "100")).toBe(100_000_001);
  });

  it("validates redemption buckets", () => {
    expect(isPoolRedemptionPercentBucket("50")).toBe(true);
    expect(isPoolRedemptionPercentBucket("75")).toBe(false);
  });
});
