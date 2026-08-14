import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TerminalMarketSnapshotMetrics } from "./TerminalMarketSnapshotMetrics";

describe("TerminalMarketSnapshotMetrics", () => {
  it("renders every metric once in one mobile rail and desktop grid", () => {
    const markup = renderToStaticMarkup(createElement(TerminalMarketSnapshotMetrics, {
      mark: "100.1",
      oracle: "100.0",
      spread: "1.00 bps",
      funding: "0.0100%",
      openInterest: "$1.2M",
      dayVolume: "$9.8M",
    }));

    for (const label of ["Mark", "Oracle", "Spread", "Funding", "Open interest", "24h volume"]) {
      expect(markup.match(new RegExp(`>${label}<`, "gu"))).toHaveLength(1);
    }
    expect(markup).toContain('aria-label="Scrollable market snapshot metrics"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("sm:grid-cols-6");
    expect(markup).toContain("snap-mandatory");
  });
});
