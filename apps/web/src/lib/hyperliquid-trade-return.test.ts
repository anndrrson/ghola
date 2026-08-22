import { describe, expect, it } from "vitest";
import {
  hyperliquidMarketFromTradeReturn,
  liveHyperliquidReferencePrice,
} from "./hyperliquid-trade-return";

describe("hyperliquid setup return target", () => {
  it("preserves the requested HYPE perpetual market", () => {
    expect(hyperliquidMarketFromTradeReturn(
      "/trade?product=perps&venue=hyperliquid&market=HYPE-PERP",
    )).toBe("HYPE");
  });

  it("rejects external and non-Hyperliquid targets", () => {
    expect(hyperliquidMarketFromTradeReturn("https://example.com/trade?venue=hyperliquid&market=HYPE-PERP")).toBeNull();
    expect(hyperliquidMarketFromTradeReturn("/trade?venue=backpack&market=HYPE-PERP")).toBeNull();
  });

  it("requires a positive live reference price", () => {
    expect(liveHyperliquidReferencePrice({ mark_price: "79.25" })).toBe(79.25);
    expect(liveHyperliquidReferencePrice({ mid: "79.10" })).toBe(79.1);
    expect(liveHyperliquidReferencePrice({ mark_price: "0" })).toBeNull();
    expect(liveHyperliquidReferencePrice(null)).toBeNull();
  });
});
