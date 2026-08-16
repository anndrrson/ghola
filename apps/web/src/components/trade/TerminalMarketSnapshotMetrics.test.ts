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
      dayChange: "+1.20%",
      dayChangeTone: "good",
      funding: "0.0100%",
      openInterest: "$1.2M",
      dayVolume: "$9.8M",
    }));

    for (const label of ["Mark", "Oracle", "24h change", "Funding / 1h", "Open interest", "24h volume"]) {
      expect(markup.match(new RegExp(`>${label}<`, "gu"))).toHaveLength(1);
    }
    expect(markup).toContain('aria-label="Scrollable market snapshot metrics"');
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("sm:grid-cols-3");
    expect(markup).toContain("2xl:grid-cols-6");
    expect(markup).toContain("border-[#1d2633]");
    expect(markup).toContain("text-emerald-300");
  });
});
