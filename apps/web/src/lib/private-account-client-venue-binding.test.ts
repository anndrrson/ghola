import { describe, expect, it } from "vitest";
import {
  bindPrivateAccountSafeInputPlatform,
  type PrivateAccountSafeInput,
} from "./private-account-client";

const ASTER_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "hyperliquid_style_market",
  venue_id: "aster",
  product_bucket: "perps",
  amount_bucket: "25",
  urgency: "fast_degraded",
  destination_class: "platform_subaccount",
  asset_bucket: "BTC",
  solver_count_bucket: "5+",
};

describe("private-account platform switching", () => {
  it("replaces an old venue on every execution-platform switch", () => {
    expect(bindPrivateAccountSafeInputPlatform(ASTER_INPUT, "hyperliquid_style_market").venue_id)
      .toBe("hyperliquid");
    expect(bindPrivateAccountSafeInputPlatform(ASTER_INPUT, "solana_perps_market").venue_id)
      .toBe("phoenix");
    expect(bindPrivateAccountSafeInputPlatform(ASTER_INPUT, "solana_swap_aggregator").venue_id)
      .toBe("jupiter");
    expect(bindPrivateAccountSafeInputPlatform(ASTER_INPUT, "coinbase_style_provider").venue_id)
      .toBe("coinbase_advanced");
  });

  it("removes a prior venue when switching to a non-execution platform", () => {
    const switched = bindPrivateAccountSafeInputPlatform(ASTER_INPUT, "solana_private_balance");
    expect(switched.platform_class).toBe("solana_private_balance");
    expect(switched).not.toHaveProperty("venue_id");
  });
});
