import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HyperliquidMarketSnapshot } from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import type { TradingNextAction, VenueReadinessStep } from "@/lib/private-account-trading-ui";
import { ProTradingTerminal } from "./ProTradingTerminal";

const invalidOrder: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "BTC",
  side: "buy",
  base_size: "",
  limit_price: "",
  quote_size: "",
  order_type: "limit",
  size_mode: "quote",
  tif: "Gtc",
};

const nextAction: TradingNextAction = {
  kind: "preview",
  label: "Preview trade",
  description: "Check the capped order before any venue submit.",
  tone: "primary",
};

const validOrder: PrivateExecutionOrderDraft = {
  ...invalidOrder,
  quote_size: "5",
  limit_price: "100.5",
};

const marketSnapshot: HyperliquidMarketSnapshot = {
  version: 1,
  platform: "hyperliquid",
  network: "mainnet",
  coin: "BTC",
  interval: "5m",
  fetched_at: "2026-05-30T12:00:00.000Z",
  source_timestamp: 1_780_000_000_000,
  stale: false,
  mid: "100",
  best_bid: "99.5",
  best_ask: "100.5",
  spread_bps: 10,
  mark_price: "100.1",
  oracle_price: "100",
  prev_day_price: "98",
  day_notional_volume: "1000000",
  day_base_volume: "10000",
  open_interest: "200000",
  funding_rate: "0.0001",
  premium: null,
  max_leverage: 20,
  candles: [
    { t: 1_780_000_000_000, T: null, o: "98", h: "101", l: "97", c: "100", v: "10", n: null },
  ],
  bids: [{ px: "99.5", sz: "2", n: null }],
  asks: [{ px: "100.5", sz: "3", n: null }],
  recent_trades: [],
};

const readinessSteps: VenueReadinessStep[] = [
  { id: "venue", label: "Venue", value: "Hyperliquid", status: "done" },
  { id: "access", label: "Access", value: "Connect Hyperliquid account", status: "current" },
  { id: "limits", label: "Limits", value: "Waiting for access", status: "pending" },
  { id: "privacy", label: "Privacy", value: "Ready to preview", status: "current" },
  { id: "submit", label: "Submit", value: "Pending", status: "pending" },
];

describe("ProTradingTerminal", () => {
  it("renders the terminal with inline field hints and human empty states", () => {
    const html = renderToStaticMarkup(
      <ProTradingTerminal
        venue="hyperliquid"
        venueOptions={[
          { venue: "phoenix", label: "Phoenix" },
          { venue: "hyperliquid", label: "Hyperliquid" },
        ]}
        market="BTC"
        marketOptions={[
          { value: "BTC", label: "BTC" },
          { value: "ETH", label: "ETH" },
        ]}
        interval="5m"
        snapshot={null}
        marketStatus="connecting"
        accountSnapshot={null}
        accountStatus="Connect Hyperliquid account"
        order={invalidOrder}
        previewCommitment={null}
        working={false}
        nextAction={nextAction}
        readinessSteps={readinessSteps}
        onVenueChange={() => undefined}
        onMarketChange={() => undefined}
        onIntervalChange={() => undefined}
        onOrderChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain("Order ticket");
    expect(html).toContain("Trade plan");
    expect(html).toContain("Entry");
    expect(html).toContain("Chart levels");
    expect(html).toContain("Trade idea");
    expect(html).toContain("Trading rules");
    expect(html).toContain("Plan summary");
    expect(html).toContain("Only trade if");
    expect(html).toContain("Front-run protection");
    expect(html).toContain("Pre-submit private");
    expect(html).toContain("Slippage cap");
    expect(html).toContain("Slippage band");
    expect(html).toContain("Entry price");
    expect(html).toContain("Use current");
    expect(html).toContain("Exit on");
    expect(html).toContain("Route");
    expect(html).toContain("role=\"radiogroup\"");
    expect(html).toContain("aria-label=\"Slippage cap\"");
    expect(html).toContain("aria-checked=\"true\"");
    expect(html).toContain("Order book");
    expect(html).toContain("Trades");
    expect(html).toContain("Needs fields");
    expect(html).toContain("Enter a USD amount greater than 0.");
    expect(html).toContain("Enter a limit price greater than 0.");
    expect(html).toContain("Fix order fields before preview");
    expect(html).toContain("Waiting for asks");
    expect(html).toContain("Waiting for bids");
    expect(html).toContain("Waiting for market prints");
    expect(html).not.toMatch(/>Waiting<\/[^>]+>/);
    expect(html).not.toMatch(/>unknown<\/[^>]+>/);
    expect(html).not.toMatch(/>connect account<\/[^>]+>/);
    expect(html).not.toContain("needs fields");
  });

  it("adds accessible control semantics without changing terminal sections", () => {
    const html = renderToStaticMarkup(
      <ProTradingTerminal
        venue="hyperliquid"
        venueOptions={[
          { venue: "phoenix", label: "Phoenix" },
          { venue: "hyperliquid", label: "Hyperliquid" },
        ]}
        market="BTC"
        marketOptions={[
          { value: "BTC", label: "BTC" },
          { value: "ETH", label: "ETH" },
        ]}
        interval="5m"
        snapshot={marketSnapshot}
        marketStatus="live"
        accountSnapshot={null}
        accountStatus="Connect Hyperliquid account"
        order={validOrder}
        previewCommitment={null}
        working={false}
        nextAction={nextAction}
        readinessSteps={readinessSteps}
        onVenueChange={() => undefined}
        onMarketChange={() => undefined}
        onIntervalChange={() => undefined}
        onOrderChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain("Order ticket");
    expect(html).toContain("Trade plan");
    expect(html).toContain("Trend follow");
    expect(html).toContain("trend filter passes");
    expect(html).toContain("use entry price now");
    expect(html).toContain("Use entry now");
    expect(html).toContain("Slippage cap");
    expect(html).toContain("role=\"radio\"");
    expect(html).toContain("Order book");
    expect(html).toContain("Readiness");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("role=\"group\"");
    expect(html).toContain("aria-label=\"Market chart\"");
    expect(html).toContain("candles chart for BTC");
    expect(html).toContain("role=\"status\"");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("aria-label=\"Reduce only\"");
    expect(html).toContain("aria-label=\"Set sell limit at 100.5 from Asks\"");
    expect(html).toContain("aria-label=\"Set buy limit at 99.5 from Bids\"");
  });

  it("links invalid ticket fields to accessible hints", () => {
    const html = renderToStaticMarkup(
      <ProTradingTerminal
        venue="hyperliquid"
        venueOptions={[
          { venue: "phoenix", label: "Phoenix" },
          { venue: "hyperliquid", label: "Hyperliquid" },
        ]}
        market="BTC"
        marketOptions={[
          { value: "BTC", label: "BTC" },
          { value: "ETH", label: "ETH" },
        ]}
        interval="5m"
        snapshot={null}
        marketStatus="connecting"
        accountSnapshot={null}
        accountStatus="Connect Hyperliquid account"
        order={invalidOrder}
        previewCommitment={null}
        working={false}
        nextAction={nextAction}
        readinessSteps={readinessSteps}
        onVenueChange={() => undefined}
        onMarketChange={() => undefined}
        onIntervalChange={() => undefined}
        onOrderChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain("aria-invalid=\"true\"");
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("Enter a USD amount greater than 0.");
    expect(html).toContain("Enter a limit price greater than 0.");
  });
});
