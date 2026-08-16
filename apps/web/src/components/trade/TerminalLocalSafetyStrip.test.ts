import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_FUNDED_TESTNET_LABEL,
  TERMINAL_LOCAL_SAFETY_LABEL,
  TerminalLocalSafetyStrip,
} from "./TerminalLocalSafetyStrip";

describe("TerminalLocalSafetyStrip", () => {
  it("keeps complete safety semantics while exposing compact mobile copy", () => {
    const markup = renderToStaticMarkup(createElement(TerminalLocalSafetyStrip));

    expect(markup).toContain(`aria-label="${TERMINAL_LOCAL_SAFETY_LABEL}"`);
    expect(markup).toContain("Analysis + PAPER only · live and agents off");
    expect(markup).toContain("Worker start, remote preview, agent arming, and live submission are disabled.");
    expect(markup).toContain("0 runtime");
    expect(markup).toContain("zero runtime hours");
  });

  it("links the explicit funded testnet proof without claiming normal live submit", () => {
    const markup = renderToStaticMarkup(createElement(TerminalLocalSafetyStrip, {
      fundedTestnetProofAvailable: true,
    }));

    expect(markup).toContain('href="/trade/testnet-e2e"');
    expect(markup).toContain(`aria-label="${TERMINAL_FUNDED_TESTNET_LABEL}"`);
    expect(markup).toContain("Funded Hyperliquid testnet enabled");
    expect(markup).toContain("Real testnet fills · mainnet off");
    expect(markup).toContain("Open funded runner");
    expect(markup).not.toContain("Analysis + PAPER only · live and agents off");
  });
});
