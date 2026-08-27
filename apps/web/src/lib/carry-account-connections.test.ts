import { describe, expect, it } from "vitest";
import {
  carryAccountConnectionProgress,
  carryAccountConnectionProgressForVenues,
  carryAccountConnections,
  carryExecutionPairFromReturnTo,
  carryNoSubmitVerificationHref,
  carryAccountSetupNextAction,
} from "./carry-account-connections";

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

  it("scopes guided setup to the selected pair without weakening fleet setup", () => {
    const connections = {
      accountCommitment: "account_test",
      venues: { hyperliquid: true, aster: true, lighter: false },
    } as const;
    expect(carryAccountConnectionProgressForVenues(connections, ["hyperliquid", "aster"])).toMatchObject({
      connectedCount: 2,
      requiredCount: 2,
      ready: true,
      missingVenueIds: [],
    });
    expect(carryAccountConnectionProgress(connections)).toMatchObject({
      connectedCount: 2,
      requiredCount: 3,
      ready: false,
      missingVenueIds: ["lighter"],
    });
  });

  it("recovers only an exact distinct execution pair from a terminal return", () => {
    expect(carryExecutionPairFromReturnTo(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=aster",
    )).toEqual({ longVenueId: "hyperliquid", shortVenueId: "aster" });
    expect(carryExecutionPairFromReturnTo(
      "/trade?market=BTC-PERP&long_venue=hyperliquid&short_venue=hyperliquid",
    )).toBeNull();
    expect(carryExecutionPairFromReturnTo(
      "/trade?market=BTC-PERP&long_venue=hyperliquid&short_venue=edgex",
    )).toBeNull();
    expect(carryExecutionPairFromReturnTo("https://example.com/trade?long_venue=hyperliquid&short_venue=aster")).toBeNull();
  });

  it("keeps one guided next action while skipping a venue blocked on external activation", () => {
    const progress = carryAccountConnectionProgress({
      accountCommitment: "account_test",
      venues: { hyperliquid: true, aster: false, lighter: false },
    });
    expect(carryAccountSetupNextAction(progress)).toEqual({ kind: "connect_venue", venueId: "lighter" });
    expect(carryAccountSetupNextAction(progress, ["lighter"])).toEqual({ kind: "connect_venue", venueId: "aster" });
  });

  it("turns the same guided action into route verification only after all venues connect", () => {
    const progress = carryAccountConnectionProgress({
      accountCommitment: "account_test",
      venues: { hyperliquid: true, aster: true, lighter: true },
    });
    expect(carryAccountSetupNextAction(progress)).toEqual({ kind: "verify_routes", venueId: null });
  });

  it("hands completed setup to one explicit no-submit terminal check", () => {
    expect(carryNoSubmitVerificationHref(
      "/trade?product=perps&venue=hyperliquid&market=ETH-PERP&carry=open",
    )).toBe(
      "/trade?product=perps&venue=hyperliquid&market=ETH-PERP&carry=open&carry_check=no-submit",
    );
    expect(carryNoSubmitVerificationHref("/carry")).toBe(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&carry_check=no-submit",
    );
    expect(carryNoSubmitVerificationHref("https://evil.example/trade")).toBe(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&carry_check=no-submit",
    );
  });
});
