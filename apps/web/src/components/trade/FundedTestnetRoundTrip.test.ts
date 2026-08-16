import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundedTestnetRoundTrip } from "./FundedTestnetRoundTrip";

describe("FundedTestnetRoundTrip", () => {
  it("states the exact funded testnet flow and never claims mainnet availability", () => {
    const markup = renderToStaticMarkup(createElement(FundedTestnetRoundTrip, {
      market: "HYPE",
      notionalUsd: 11,
    }));

    expect(markup).toContain("Filled round-trip proof");
    expect(markup).toContain("Hyperliquid testnet only");
    expect(markup).toContain("Postgres execution claims");
    expect(markup).toContain("Run funded testnet round trip");
    expect(markup).not.toContain("mainnet enabled");
  });
});
