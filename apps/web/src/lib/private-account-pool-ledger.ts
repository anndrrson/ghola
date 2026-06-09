// Unitized pool share math for ghola_pooled venue allocations.
//
// Conventions:
// - Equity is denominated in micro-USDC.
// - Shares are denominated in micro-shares; an empty pool issues shares at
//   par (1 micro-share per micro-USDC), so NAV per share starts at 1.0.
// - All math is BigInt with floor rounding so the pool can never owe more
//   than it holds; rounding dust accrues to the pool, never to a redeemer.

export const POOL_SHARE_SCALE_MICRO = 1_000_000;

export type PoolNavSnapshot = {
  equity_micro_usdc: number;
  shares_micro: number;
  nav_per_share_micro_usdc: number | null;
};

export function poolNavSnapshot(
  equityMicroUsdc: number,
  sharesMicro: number,
): PoolNavSnapshot {
  const equity = nonNegativeInt(equityMicroUsdc);
  const shares = nonNegativeInt(sharesMicro);
  return {
    equity_micro_usdc: equity,
    shares_micro: shares,
    nav_per_share_micro_usdc: shares === 0
      ? null
      : Number((BigInt(equity) * BigInt(POOL_SHARE_SCALE_MICRO)) / BigInt(shares)),
  };
}

// Shares minted for a contribution at the pool's current NAV. Returns null
// when the contribution cannot be fairly priced (a wiped-out pool with
// outstanding shares must not accept new capital).
export function sharesForContribution(
  amountMicroUsdc: number,
  poolEquityMicroUsdc: number,
  poolSharesMicro: number,
): number | null {
  const amount = nonNegativeInt(amountMicroUsdc);
  const equity = nonNegativeInt(poolEquityMicroUsdc);
  const shares = nonNegativeInt(poolSharesMicro);
  if (amount === 0) return 0;
  if (shares === 0) return amount;
  if (equity === 0) return null;
  return Number((BigInt(amount) * BigInt(shares)) / BigInt(equity));
}

// Equity owed for redeeming `sharesMicro` at the pool's current NAV.
export function equityForShares(
  sharesMicro: number,
  poolEquityMicroUsdc: number,
  poolSharesMicro: number,
): number {
  const redeem = nonNegativeInt(sharesMicro);
  const equity = nonNegativeInt(poolEquityMicroUsdc);
  const total = nonNegativeInt(poolSharesMicro);
  if (redeem === 0 || total === 0 || equity === 0) return 0;
  const capped = Math.min(redeem, total);
  return Number((BigInt(capped) * BigInt(equity)) / BigInt(total));
}

export const POOL_REDEMPTION_PERCENT_BUCKETS = ["25", "50", "100"] as const;

export type PoolRedemptionPercentBucket =
  (typeof POOL_REDEMPTION_PERCENT_BUCKETS)[number];

export function isPoolRedemptionPercentBucket(
  value: string,
): value is PoolRedemptionPercentBucket {
  return (POOL_REDEMPTION_PERCENT_BUCKETS as readonly string[]).includes(value);
}

export function sharesForRedemptionBucket(
  holderSharesMicro: number,
  bucket: PoolRedemptionPercentBucket,
): number {
  const held = nonNegativeInt(holderSharesMicro);
  if (bucket === "100") return held;
  return Number((BigInt(held) * BigInt(Number(bucket))) / BigInt(100));
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
