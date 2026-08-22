import { describe, expect, it } from "vitest";
import {
  formatAssetQuantity,
  formatCompactUsd,
  formatSignedPercent,
  formatUsdPrice,
} from "./market-number-format";

describe("market number formatting", () => {
  it("keeps spot prices stable and currency-labelled", () => {
    expect(formatUsdPrice("183.2", "0.01")).toBe("$183.20");
    expect(formatUsdPrice("0.1234567", "0.0001")).toBe("$0.1235");
  });

  it("makes large quote volume and small quantities readable", () => {
    expect(formatCompactUsd("1250000")).toBe("$1.3M");
    expect(formatAssetQuantity(5 / 183.2)).toBe("0.027293");
    expect(formatSignedPercent("-2.456")).toBe("-2.46%");
  });
});
