import { describe, expect, it } from "vitest";
import {
  hyperliquidMarketFromTradeReturn,
  hyperliquidNoSubmitProofReady,
  liveHyperliquidReferencePrice,
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

  it("requires a positive live reference price", () => {
    expect(liveHyperliquidReferencePrice({ mark_price: "79.25" })).toBe(79.25);
    expect(liveHyperliquidReferencePrice({ mid: "79.10" })).toBe(79.1);
    expect(liveHyperliquidReferencePrice({ mark_price: "0" })).toBeNull();
    expect(liveHyperliquidReferencePrice(null)).toBeNull();
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
