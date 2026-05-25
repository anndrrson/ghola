import { describe, expect, it } from "vitest";
import {
  compileTradingStrategy,
  formatStrategyUsd,
  usdToMicro,
} from "./trading-strategy";

const OWNER = "did:key:z6Mki11111111111111111111111111111111111111111111";

describe("trading strategy compiler", () => {
  it("compiles DCA strategies into shielded prepare-only policies", () => {
    const result = compileTradingStrategy("DCA $25 into ETH every Friday", OWNER, {
      now: new Date("2026-05-24T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.trigger.kind).toBe("dca_schedule");
    expect(result.policy.allowed_venues).toEqual(["railgun_private_swap"]);
    expect(result.policy.public_venue_policy).toBe("deny");
    expect(result.policy.unshield_policy).toBe("deny");
    expect(result.policy.max_trade_micro_usdc).toBe(usdToMicro(25));
    expect(result.policy.require_user_confirmation).toBe(true);
  });

  it("compiles percent-drop strategies with an explicit amount", () => {
    const result = compileTradingStrategy(
      "If SOL drops 8% in 24h, prepare a $50 buy",
      OWNER,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.trigger.kind).toBe("percent_change_24h");
    expect(result.policy.max_trade_micro_usdc).toBe(usdToMicro(50));
  });

  it("compiles alert-only strategies without execution authority", () => {
    const result = compileTradingStrategy("Alert me if ETH is above $5,000", OWNER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.trigger.kind).toBe("alert_only");
    expect(formatStrategyUsd(result.policy.max_trade_micro_usdc)).toBe("$0.00");
  });

  it("refuses ambiguous trading strategies without an amount", () => {
    const result = compileTradingStrategy("If SOL drops, buy some", OWNER);

    expect(result.ok).toBe(false);
  });
});
