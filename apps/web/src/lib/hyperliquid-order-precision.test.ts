import { describe, expect, it } from "vitest";
import {
  floorHyperliquidPerpSize,
  hyperliquidPerpOrderSizing,
  hyperliquidPerpPriceTick,
  quantizeHyperliquidPerpPrice,
} from "./hyperliquid-order-precision";

describe("Hyperliquid order precision", () => {
  it("applies both five-significant-figure and perp decimal limits", () => {
    expect(hyperliquidPerpPriceTick(63_033.5, 5)).toBe(1);
    expect(quantizeHyperliquidPerpPrice(63_033.5, 5, "up")).toBe(63_034);
    expect(quantizeHyperliquidPerpPrice(63_033.5, 5, "down")).toBe(63_033);
    expect(quantizeHyperliquidPerpPrice(56.3645, 2)).toBe(56.365);
    expect(quantizeHyperliquidPerpPrice(1_234.56, 4)).toBe(1_234.6);
    expect(quantizeHyperliquidPerpPrice(123_456.4, 5)).toBe(123_456);
  });

  it("floors size to the venue lot and reports the conservative effective notional", () => {
    expect(floorHyperliquidPerpSize(0.00017451, 5)).toBe(0.00017);
    expect(hyperliquidPerpOrderSizing({
      quoteNotionalUsd: 11,
      limitPrice: 63_034,
      sizeDecimals: 5,
    })).toEqual({ baseSize: 0.00017, effectiveQuoteNotionalUsd: 10.72 });
    expect(hyperliquidPerpOrderSizing({
      quoteNotionalUsd: 11,
      limitPrice: 56.365,
      sizeDecimals: 2,
    })).toEqual({ baseSize: 0.19, effectiveQuoteNotionalUsd: 10.71 });
  });

  it("fails closed without valid dynamic venue metadata", () => {
    expect(hyperliquidPerpPriceTick(100, null)).toBeNull();
    expect(floorHyperliquidPerpSize(1, 7)).toBeNull();
    expect(hyperliquidPerpOrderSizing({ quoteNotionalUsd: 11, limitPrice: 100, sizeDecimals: null })).toBeNull();
  });

  it("fails closed when venue lot flooring takes the order below Hyperliquid's $10 minimum", () => {
    expect(hyperliquidPerpOrderSizing({
      quoteNotionalUsd: 10,
      limitPrice: 63_034,
      sizeDecimals: 5,
    })).toBeNull();
  });
});
