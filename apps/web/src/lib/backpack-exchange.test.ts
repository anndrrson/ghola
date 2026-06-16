import { describe, expect, it } from "vitest";
import {
  backpackPooledReadiness,
  buildBackpackSigningString,
} from "./backpack-exchange";

describe("Backpack exchange helpers", () => {
  it("builds the documented orderExecute signing string with sorted fields", () => {
    expect(buildBackpackSigningString({
      instruction: "orderExecute",
      params: {
        symbol: "SOL_USDC_PERP",
        side: "Bid",
        orderType: "Limit",
        price: "141",
        quantity: "12",
        postOnly: true,
      },
      timestamp: 1750793021519,
      windowMs: 5000,
    })).toBe(
      "instruction=orderExecute&orderType=Limit&postOnly=true&price=141&quantity=12&side=Bid&symbol=SOL_USDC_PERP&timestamp=1750793021519&window=5000",
    );
  });

  it("requires pooled Backpack caps and credential material", () => {
    const blocked = backpackPooledReadiness({});
    expect(blocked.ready).toBe(false);
    expect(blocked.reason_codes).toContain("backpack_pooled_disabled");

    const ready = backpackPooledReadiness({
      GHOLA_BACKPACK_POOLED_ENABLED: "true",
      GHOLA_BACKPACK_API_KEY: "pub",
      GHOLA_BACKPACK_API_SECRET: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      GHOLA_BACKPACK_ALLOWED_SYMBOLS: "SOL_USDC_PERP",
      GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD: "5",
      GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD: "25",
      GHOLA_BACKPACK_POST_ONLY_MM: "true",
    });
    expect(ready.ready).toBe(true);
    expect(ready.reason_codes).toEqual([]);
  });
});
