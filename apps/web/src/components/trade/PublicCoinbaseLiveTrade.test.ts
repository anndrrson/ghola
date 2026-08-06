import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import {
  buildVenueSetupHref,
  formatHyperliquidMarketStatus,
  HYPERLIQUID_REVIEW_TTL_MS,
  hyperliquidExecutionNotice,
  hyperliquidReviewExpired,
  minimumExecutablePerpQuote,
  resolveAvailableTradeProduct,
  validatePerpTicket,
  WorkspaceProductNav,
} from "./PublicCoinbaseLiveTrade";
import { emptyHyperliquidLiveMarketSnapshot } from "@/lib/hyperliquid-live-market";

describe("available trade products", () => {
  it("defaults new and unavailable product visits to Hyperliquid Perps", () => {
    expect(resolveAvailableTradeProduct(null)).toBe("perps");
    expect(resolveAvailableTradeProduct("spot", "automate")).toBe("perps");
    expect(resolveAvailableTradeProduct("swap")).toBe("perps");
    expect(resolveAvailableTradeProduct("automate")).toBe("perps");
    expect(resolveAvailableTradeProduct(null, "spot")).toBe("perps");
    expect(resolveAvailableTradeProduct(null, "swap")).toBe("perps");
    expect(resolveAvailableTradeProduct(null, "automate")).toBe("perps");
  });

  it("preserves the enabled Perps selection", () => {
    expect(resolveAvailableTradeProduct("perps")).toBe("perps");
    expect(resolveAvailableTradeProduct(null, "perps")).toBe("perps");
  });

  it("renders Spot, Swap, and Automate as disabled Coming soon controls", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceProductNav, {
      value: "perps",
      onChange: () => undefined,
    }));

    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
    expect(markup).toContain("Spot is coming soon");
    expect(markup).toContain("Swap is coming soon");
    expect(markup).toContain("Automate is coming soon");
    expect(markup.match(/Coming soon/g)).toHaveLength(3);
  });
});

describe("Hyperliquid execution evidence", () => {
  it("distinguishes venue-proven fills from accepted and unfilled orders", () => {
    expect(hyperliquidExecutionNotice({
      status: "filled",
      final_proof: { final_fill_proven: true },
    })).toContain("fill proven");
    expect(hyperliquidExecutionNotice({
      status: "filled",
      final_proof: {
        final_fill_proven: true,
        final_position_state_checked: true,
        final_position_flat_proven: true,
      },
    })).toContain("flat position proven");
    expect(hyperliquidExecutionNotice({
      status: "filled",
      final_proof: {
        final_fill_proven: true,
        final_position_state_checked: true,
        final_position_flat_proven: false,
      },
    })).toContain("residual position");
    expect(hyperliquidExecutionNotice({ status: "resting" })).toContain("working, not filled");
    expect(hyperliquidExecutionNotice({ status: "unfilled" })).toContain("without a fill");
    expect(hyperliquidExecutionNotice({ status: "submitted" })).toContain("no fill is proven yet");
  });
});

describe("Hyperliquid chart feed status", () => {
  it("shows candle-specific age for every clear feed state", () => {
    const now = new Date("2026-08-06T06:00:10.000Z").getTime();
    const snapshot = {
      ...emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "1m" }),
      stale: false,
      channel_updated_at: {
        candle: now - 3_000,
        trades: now - 1_000,
        bbo: now - 100,
        order_book: now - 200,
        market_context: now - 500,
        mid: now - 100,
      },
    };

    expect(formatHyperliquidMarketStatus("live", snapshot, now)).toBe("Live · candle 3s ago");
    expect(formatHyperliquidMarketStatus("delayed", { ...snapshot, stale: true }, now)).toBe("Delayed · candle 3s ago");
    expect(formatHyperliquidMarketStatus("reconnecting", snapshot, now)).toBe("Reconnecting · candle 3s ago");
    expect(formatHyperliquidMarketStatus("fallback_polling", snapshot, now)).toBe("Fallback polling · candle 3s ago");
    expect(formatHyperliquidMarketStatus("unavailable", snapshot, now)).toBe("Unavailable · candle 3s ago");
    expect(formatHyperliquidMarketStatus("connecting", null, now)).toBe("Connecting · awaiting candle");
  });
});

describe("venue setup route", () => {
  it("always routes perpetual setup through the Hyperliquid verifier", () => {
    const href = buildVenueSetupHref({
      product: "perps",
      venue: "coinbase_advanced",
      market: "SOL-PERP",
    });

    expect(href).toContain("setup=hyperliquid");
    expect(decodeURIComponent(href)).toContain("venue=hyperliquid");
    expect(href).not.toContain("coinbase_advanced");
  });

  it("preserves the selected venue for non-perpetual setup", () => {
    const href = buildVenueSetupHref({
      product: "spot",
      venue: "coinbase_advanced",
      market: "SOL-USD",
    });

    expect(href).toContain("setup=coinbase_advanced");
    expect(decodeURIComponent(href)).toContain("venue=coinbase_advanced");
  });
});

function ticket(quoteSize: string, reduceOnly = false): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "SOL",
    side: "buy",
    base_size: "",
    quote_size: quoteSize,
    limit_price: "",
    order_type: "market",
    size_mode: "quote",
    tif: "Ioc",
    max_slippage_bps: "50",
    leverage: 1,
    margin_mode: "cross",
    reduce_only: reduceOnly,
  };
}

describe("bounded Hyperliquid ticket", () => {
  it("accepts a capped ticket that remains above $10 after SOL lot-size rounding", () => {
    expect(validatePerpTicket(ticket("11"), "70", 20, 50, 2)).toEqual([]);
  });

  it("rejects notionals below the venue minimum or above the bounded launch cap", () => {
    expect(validatePerpTicket(ticket("5"), "70", 20, 50, 2)).toContain(
      "Hyperliquid orders must be at least $10 after venue lot-size rounding.",
    );
    expect(validatePerpTicket(ticket("16"), "70", 20, 50, 2)).toContain(
      "Orders are capped at $15 during the bounded mainnet launch.",
    );
  });

  it("rejects an apparent $10 SOL ticket when lot rounding would send less than $10", () => {
    expect(validatePerpTicket(ticket("10"), "70", 20, 50, 2)).toContain(
      "SOL needs at least $10.57 at the current price and venue lot size.",
    );
    expect(minimumExecutablePerpQuote(ticket("10"), "70", 2)).toBe(10.57);
  });

  it("allows reduce-only exits outside the entry ticket bounds", () => {
    expect(validatePerpTicket(ticket("9", true), "70", 20, 50, 2)).not.toContain(
      "Hyperliquid orders must be at least $10 after venue lot-size rounding.",
    );
    expect(validatePerpTicket(ticket("16", true), "70", 20, 50, 2)).not.toContain(
      "Orders are capped at $15 during the bounded mainnet launch.",
    );
  });

  it("allows an exact close without accepting a user-supplied size", () => {
    expect(validatePerpTicket({
      ...ticket("", true),
      size_mode: "base",
      live_order_mode: "tiny_fill",
      close_position: true,
    }, "70", 20, 50, 2)).toEqual([]);
  });
});

describe("Hyperliquid live review freshness", () => {
  it("keeps a review valid long enough for a deliberate confirmation", () => {
    const createdAt = 1_000_000;

    expect(hyperliquidReviewExpired(createdAt, createdAt + 30_000)).toBe(false);
    expect(hyperliquidReviewExpired(createdAt, createdAt + HYPERLIQUID_REVIEW_TTL_MS)).toBe(false);
  });

  it("expires the review after the bounded confirmation window", () => {
    const createdAt = 1_000_000;

    expect(hyperliquidReviewExpired(createdAt, createdAt + HYPERLIQUID_REVIEW_TTL_MS + 1)).toBe(true);
  });
});
