import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundedMainnetRoundTrip } from "./FundedMainnetRoundTrip";

describe("FundedMainnetRoundTrip", () => {
  it("states the exact real-money bounds and durable advantages", () => {
    const markup = renderToStaticMarkup(createElement(FundedMainnetRoundTrip));
    expect(markup).toContain("Hyperliquid mainnet · real funds");
    expect(markup).toContain("$10.50 filled round trip");
    expect(markup).toContain("Postgres claims");
    expect(markup).toContain("duplicate-submit protection");
    expect(markup).toContain("final-flat proof");
    expect(markup).toContain("Run real Hyperliquid proof trade");
  });
});
