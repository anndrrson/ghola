import { describe, expect, it } from "vitest";
import { carryAccountConnectionProgress, carryAccountConnections } from "./carry-account-connections";

describe("Carry account connections", () => {
  it("recognizes the nested Hyperliquid vault status response", () => {
    expect(carryAccountConnections({
      passport: { account_commitment: "account_test", venues: [] },
      hyperliquidStatus: {
        credentials_sealed: true,
        ready: false,
        hyperliquid_execution_vault: { status: "sealed" },
      },
    })).toMatchObject({ accountCommitment: "account_test", venues: { hyperliquid: true } });
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
      venues: { hyperliquid: false, aster: true, lighter: false },
    });
  });

  it("does not mistake a sealed credential for a completed no-submit proof", () => {
    const result = carryAccountConnections({
      passport: { account_commitment: "account_test", venues: [] },
      hyperliquidStatus: { credentials_sealed: true, ready: false, connection_proof: null },
    });
    expect(result.venues.hyperliquid).toBe(true);
  });

  it("unlocks route verification only when every execution venue is connected", () => {
    expect(carryAccountConnectionProgress({
      accountCommitment: "account_test",
      venues: { hyperliquid: true, aster: true, lighter: false },
    })).toMatchObject({
      connectedCount: 2,
      requiredCount: 3,
      ready: false,
      missingVenueIds: ["lighter"],
    });
    expect(carryAccountConnectionProgress({
      accountCommitment: "account_test",
      venues: { hyperliquid: true, aster: true, lighter: true },
    })).toMatchObject({ connectedCount: 3, requiredCount: 3, ready: true, missingVenueIds: [] });
  });
});
