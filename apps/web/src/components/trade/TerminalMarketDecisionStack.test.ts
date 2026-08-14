import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TerminalMarketDecisionStack } from "./TerminalMarketDecisionStack";

describe("TerminalMarketDecisionStack", () => {
  it("renders one chart and scanner in matching chart-first visual and reading order", () => {
    const markup = renderToStaticMarkup(createElement(TerminalMarketDecisionStack, {
      chart: createElement("span", null, "chart-once"),
      scanner: createElement("span", null, "scanner-once"),
    }));

    expect(markup.match(/chart-once/gu)).toHaveLength(1);
    expect(markup.match(/scanner-once/gu)).toHaveLength(1);
    expect(markup).toContain('data-terminal-decision-order="chart-first"');
    expect(markup.indexOf('data-terminal-surface="chart"')).toBeLessThan(markup.indexOf('data-terminal-surface="scanner"'));
    expect(markup).not.toContain("lg:order-");
  });
});
