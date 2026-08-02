import { describe, expect, it } from "vitest";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import {
  buildVenueSetupHref,
  HYPERLIQUID_REVIEW_TTL_MS,
  hyperliquidReviewExpired,
  validatePerpTicket,
} from "./PublicCoinbaseLiveTrade";

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
  it("accepts the exact $10 venue minimum and launch cap", () => {
    expect(validatePerpTicket(ticket("10"), "70", 20, 50)).toEqual([]);
  });

  it("rejects notionals below the venue minimum or above the launch cap", () => {
    expect(validatePerpTicket(ticket("5"), "70", 20, 50)).toContain(
      "Hyperliquid orders must be at least $10.",
    );
    expect(validatePerpTicket(ticket("11"), "70", 20, 50)).toContain(
      "Orders are capped at $10 during the bounded mainnet launch.",
    );
  });

  it("allows reduce-only exits outside the entry ticket bounds", () => {
    expect(validatePerpTicket(ticket("9", true), "70", 20, 50)).not.toContain(
      "Hyperliquid orders must be at least $10.",
    );
    expect(validatePerpTicket(ticket("11", true), "70", 20, 50)).not.toContain(
      "Orders are capped at $10 during the bounded mainnet launch.",
    );
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
