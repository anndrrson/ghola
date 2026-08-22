import { describe, expect, it } from "vitest";
import {
  buildGholaPerpsMandate,
  DEFAULT_GHOLA_PERPS_RISK,
  riskFromMobileSetupQuery,
  setupStep,
} from "./turnkey-perps-setup";

describe("Turnkey perps setup", () => {
  it("builds a capped testnet mandate with separated wallets", () => {
    const mandate = buildGholaPerpsMandate({
      mandateId: "mandate:test:web",
      network: "testnet",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
      risk: DEFAULT_GHOLA_PERPS_RISK,
      jurisdictionEligible: true,
      acceptedRisk: true,
      nowMs: 1_800_000_000_000,
    });
    expect(mandate.configured_leverage).toBe(2);
    expect(mandate.max_leverage).toBe(2);
    expect(mandate.max_order_notional_micro_usdc).toBe(25_000_000);
    expect(mandate.owner_address).not.toBe(mandate.agent_address);
  });

  it("fails closed on invalid money limits", () => {
    expect(() => buildGholaPerpsMandate({
      mandateId: "mandate:test:web",
      network: "testnet",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
      risk: { ...DEFAULT_GHOLA_PERPS_RISK, maxOrderUsd: 0 },
      jurisdictionEligible: true,
      acceptedRisk: true,
    })).toThrow(/max order/);
  });

  it("reports the first incomplete setup boundary", () => {
    expect(setupStep({
      turnkeyConfigured: true,
      authenticated: true,
      walletsReady: true,
      delegationReady: true,
      mandateSigned: false,
      active: false,
    })).toBe("sign_mandate");
  });

  it("imports a bounded mobile risk draft and rejects tampering", () => {
    const valid = new URLSearchParams({
      risk_source: "mobile_v1",
      risk_markets: "BTC,ETH",
      risk_leverage: "2",
      risk_max_order_usd: "100",
      risk_max_gross_usd: "500",
      risk_daily_loss_usd: "50",
      risk_slippage_bps: "50",
      risk_stop_loss_bps: "400",
    });
    expect(riskFromMobileSetupQuery(valid)).toMatchObject({
      markets: ["BTC", "ETH"],
      leverage: 2,
      maxOrderUsd: 100,
      maxGrossUsd: 500,
      dailyLossUsd: 50,
    });
    valid.set("risk_leverage", "25");
    expect(riskFromMobileSetupQuery(valid)).toBeNull();
  });
});
