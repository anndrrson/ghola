import { describe, expect, it } from "vitest";
import {
  hyperliquidMarketFromTradeReturn,
  hyperliquidNoSubmitProofOrder,
  hyperliquidNoSubmitProofReady,
  hyperliquidSetupAuthRedirect,
  liveHyperliquidReferencePrice,
  safeHyperliquidSetupReturn,
} from "./hyperliquid-trade-return";

describe("hyperliquid setup return target", () => {
  it("preserves the requested HYPE perpetual market", () => {
    expect(hyperliquidMarketFromTradeReturn(
      "/trade?product=perps&venue=hyperliquid&market=HYPE-PERP",
    )).toBe("HYPE");
  });

  it("rejects external and non-Hyperliquid targets", () => {
    expect(hyperliquidMarketFromTradeReturn("https://example.com/trade?venue=hyperliquid&market=HYPE-PERP")).toBeNull();
    expect(hyperliquidMarketFromTradeReturn("/trade?venue=backpack&market=HYPE-PERP")).toBeNull();
  });

  it("preserves the focused setup and safe trade return through sign-in", () => {
    expect(hyperliquidSetupAuthRedirect(
      "/trade?product=perps&venue=hyperliquid&market=HYPE-PERP",
    )).toBe(
      "/account?flow=private-mode&setup=hyperliquid&return_to=%2Ftrade%3Fproduct%3Dperps%26venue%3Dhyperliquid%26market%3DHYPE-PERP",
    );
    expect(hyperliquidSetupAuthRedirect("https://example.com/trade?venue=hyperliquid&market=HYPE-PERP"))
      .toBe("/account?flow=private-mode&setup=hyperliquid");
  });

  it("returns Hyperliquid setup to the exact Carry setup before the terminal", () => {
    const carrySetup = "/account?setup=carry&long_venue=hyperliquid&short_venue=aster&return_to=%2Ftrade%3Fproduct%3Dperps%26venue%3Dhyperliquid%26market%3DBTC-PERP%26carry%3Dopen";
    expect(safeHyperliquidSetupReturn(carrySetup)).toBe(true);
    expect(hyperliquidMarketFromTradeReturn(carrySetup)).toBe("BTC");
    expect(decodeURIComponent(hyperliquidSetupAuthRedirect(carrySetup))).toContain(carrySetup);
  });

  it("rejects recursive and externally nested Carry setup returns", () => {
    expect(safeHyperliquidSetupReturn(
      "/account?setup=carry&return_to=https%3A%2F%2Fexample.com%2Ftrade%3Fvenue%3Dhyperliquid%26market%3DBTC-PERP",
    )).toBe(false);
    expect(safeHyperliquidSetupReturn(
      "/account?setup=carry&return_to=%2Faccount%3Fsetup%3Dcarry%26return_to%3D%252Ftrade%253Fvenue%253Dhyperliquid%2526market%253DBTC-PERP",
    )).toBe(false);
  });

  it("requires a positive live reference price", () => {
    expect(liveHyperliquidReferencePrice({ mark_price: "79.25" })).toBe(79.25);
    expect(liveHyperliquidReferencePrice({ mid: "79.10" })).toBe(79.1);
    expect(liveHyperliquidReferencePrice({ mark_price: "0" })).toBeNull();
    expect(liveHyperliquidReferencePrice(null)).toBeNull();
  });

  it("builds the connection proof with the worker's tiny-fill IOC contract", () => {
    expect(hyperliquidNoSubmitProofOrder({
      market: "HYPE-PERP",
      referencePrice: 79.25,
      maxSlippageBps: "50",
      leverage: 1,
      marginMode: "cross",
    })).toMatchObject({
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      market: "HYPE",
      quote_size: "5",
      live_order_mode: "tiny_fill",
      order_type: "limit",
      size_mode: "quote",
      tif: "Ioc",
    });
  });

  it("does not accept a verified status unless the live proof was persisted", () => {
    const verification = {
      status: "verified_no_funds",
      checks: {
        sealed_vault_opened: true,
        sealed_instruction_opened: true,
        authority_derived: true,
        policy_enforced: true,
        live_gate_enforced: true,
        api_wallet_loaded: true,
        hyperliquid_api_reachable: true,
        hyperliquid_sdk_ready: true,
        account_read_checked: true,
        order_request_built: true,
        live_venue_checked: true,
        transaction_broadcast: false,
      },
    };
    expect(hyperliquidNoSubmitProofReady({ verification })).toBe(false);
    expect(hyperliquidNoSubmitProofReady({ connection_proof_persisted: true, verification })).toBe(true);
  });

  it("fails closed when any required live check is absent", () => {
    expect(hyperliquidNoSubmitProofReady({
      connection_proof_persisted: true,
      verification: {
        status: "verified_no_funds",
        checks: {
          sealed_vault_opened: true,
          sealed_instruction_opened: true,
          authority_derived: true,
          policy_enforced: true,
          live_gate_enforced: true,
          api_wallet_loaded: true,
          hyperliquid_api_reachable: true,
          hyperliquid_sdk_ready: true,
          account_read_checked: true,
          order_request_built: true,
          transaction_broadcast: false,
        },
      },
    })).toBe(false);
  });
});
