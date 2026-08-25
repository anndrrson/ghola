import { describe, expect, it } from "vitest";
import { carryAccountConnections } from "./carry-account-connections";

describe("Carry account connections", () => {
  it("recognizes the nested Hyperliquid vault status response", () => {
    expect(carryAccountConnections({
      passport: { account_commitment: "account_test", venues: [] },
      hyperliquidStatus: {
        credentials_sealed: true,
        ready: false,
        hyperliquid_execution_vault: { status: "sealed" },
      },
    })).toMatchObject({ accountCommitment: "account_test", hyperliquid: true });
  });

  it("requires read and trade capability before treating passport venues as connected", () => {
    const result = carryAccountConnections({
      passport: {
        passport: {
          account_commitment: "account_test",
          venues: [
            { venue_id: "aster", status: "ready", can_read: true, can_trade: true },
            { venue_id: "lighter", status: "ready", can_read: true, can_trade: false },
          ],
        },
      },
      hyperliquidStatus: null,
    });
    expect(result).toEqual({
      accountCommitment: "account_test",
      hyperliquid: false,
      aster: true,
      lighter: false,
    });
  });

  it("does not mistake a sealed credential for a completed no-submit proof", () => {
    const result = carryAccountConnections({
      passport: { account_commitment: "account_test", venues: [] },
      hyperliquidStatus: { credentials_sealed: true, ready: false, connection_proof: null },
    });
    expect(result.hyperliquid).toBe(true);
  });
});
