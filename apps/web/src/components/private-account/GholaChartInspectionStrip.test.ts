import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GholaChartInspectionStrip } from "./GholaChartInspectionStrip";

describe("GholaChartInspectionStrip", () => {
  it("renders one keyboard-scrollable mobile rail and the full desktop grid", () => {
    const stats = [
      { label: "Time", value: "12:34" },
      { label: "Open", value: "100" },
      { label: "High", value: "102", tone: "good" as const },
      { label: "Low", value: "99", tone: "bad" as const },
      { label: "Close", value: "101" },
      { label: "Change", value: "+1.0%" },
      { label: "Volume", value: "2.4M" },
    ];
    const markup = renderToStaticMarkup(createElement(GholaChartInspectionStrip, { stats }));

    for (const stat of stats) {
      expect(markup.match(new RegExp(`>${stat.label}<`, "gu"))).toHaveLength(1);
    }
    expect(markup).toContain('aria-label="Scrollable chart inspection statistics"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("snap-mandatory");
    expect(markup).toContain("sm:grid-cols-4");
    expect(markup).toContain("lg:grid-cols-7");
  });
});
