export type HyperliquidPriceRounding = "nearest" | "up" | "down";

const PERP_MAX_DECIMALS = 6;
export const HYPERLIQUID_MIN_ORDER_NOTIONAL_USD = 10;

/** Hyperliquid perp tick implied by the documented 5-significant-figure and szDecimals rules. */
export function hyperliquidPerpPriceTick(
  price: number,
  sizeDecimals: number | null | undefined,
): number | null {
  if (!positive(price) || !validSizeDecimals(sizeDecimals)) return null;
  const decimalTick = 10 ** -(PERP_MAX_DECIMALS - sizeDecimals);
  const significantTick = price >= 10_000
    ? 1
    : 10 ** (Math.floor(Math.log10(price)) - 4);
  const tick = Math.max(decimalTick, significantTick);
  return positive(tick) ? tick : null;
}

export function quantizeHyperliquidPerpPrice(
  price: number,
  sizeDecimals: number | null | undefined,
  rounding: HyperliquidPriceRounding = "nearest",
): number | null {
  const tick = hyperliquidPerpPriceTick(price, sizeDecimals);
  if (tick == null) return null;
  const ratio = price / tick;
  const units = rounding === "up"
    ? Math.ceil(ratio - 1e-10)
    : rounding === "down"
      ? Math.floor(ratio + 1e-10)
      : Math.round(ratio);
  const value = Number((units * tick).toFixed(8));
  return positive(value) ? value : null;
}

export function floorHyperliquidPerpSize(
  size: number,
  sizeDecimals: number | null | undefined,
): number | null {
  if (!positive(size) || !validSizeDecimals(sizeDecimals)) return null;
  const scale = 10 ** sizeDecimals;
  const value = Number((Math.floor(size * scale + 1e-12) / scale).toFixed(sizeDecimals));
  return positive(value) ? value : null;
}

export function hyperliquidPerpOrderSizing(input: {
  quoteNotionalUsd: number;
  limitPrice: number;
  sizeDecimals: number | null | undefined;
}): { baseSize: number; effectiveQuoteNotionalUsd: number } | null {
  if (!positive(input.quoteNotionalUsd) || !positive(input.limitPrice)) return null;
  const baseSize = floorHyperliquidPerpSize(
    input.quoteNotionalUsd / input.limitPrice,
    input.sizeDecimals,
  );
  if (baseSize == null) return null;
  const representedNotional = baseSize * input.limitPrice;
  const effectiveQuoteNotionalUsd = Math.round((representedNotional + Number.EPSILON) * 100) / 100;
  if (effectiveQuoteNotionalUsd < HYPERLIQUID_MIN_ORDER_NOTIONAL_USD) return null;
  return { baseSize, effectiveQuoteNotionalUsd };
}

function validSizeDecimals(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= PERP_MAX_DECIMALS;
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
