import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TerminalClassicOrderTicket } from "./TerminalClassicOrderTicket";

describe("TerminalClassicOrderTicket", () => {
  it("keeps the primary 3011 ticket compact while exposing advanced capability", () => {
    const markup = renderToStaticMarkup(createElement(TerminalClassicOrderTicket, {
      venueLabel: "Hyperliquid",
      productLabel: "BTC-PERP",
      authenticated: true,
      statusLabel: "Preview ready",
      statusReady: false,
      side: "buy",
      notional: 25,
      baseSize: 0.00039,
      effectiveNotionalUsd: 24.57,
      protectionAttached: true,
      entryPrice: 63_000,
      stopPrice: 62_500,
      targetPrice: 64_000,
      modeledLossUsd: 0.2,
      riskBudgetUsd: 1,
      actions: createElement("button", null, "Bind & preview exact plan"),
      onSignIn: vi.fn(),
      onSideChange: vi.fn(),
      onNotionalChange: vi.fn(),
      onStopChange: vi.fn(),
      onOpenAdvanced: vi.fn(),
    }));

    expect(markup).toContain("Place order");
    expect(markup).toContain("Planned exits");
    expect(markup).toContain("OCO when submitted");
    expect(markup).toContain("Risk estimate");
    expect(markup).toContain("Venue lot 0.00039 BTC · $24.57 effective");
    expect(markup).toContain("Advanced tools");
    expect(markup).toContain("Bind &amp; preview exact plan");
    expect(markup).toContain('value="62500.0"');
    expect(markup).toContain('value="64000.0"');
    expect(markup).not.toContain("Terminal diagnostics");
  });
});
