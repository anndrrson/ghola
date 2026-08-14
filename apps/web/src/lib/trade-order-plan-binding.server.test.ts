import { describe, expect, it } from "vitest";

import {
  tradeExecutionIdentityCommitments,
  verifyTradeExecutionIdentityCommitments,
} from "./trade-order-plan-binding.server";

describe("trade execution identity commitments", () => {
  it("matches the browser v1 commitment contract", () => {
    expect(tradeExecutionIdentityCommitments("web-user-1", "hyperliquid")).toEqual({
      executionCredentialHandleCommitment:
        "db0362b4c772a35b967738d7a75c827cee74dc2362f4c1802e7274ac99edc258",
      venueAccountCommitment:
        "260d0fd13750490e7801f7b5b0d116961840982e7e9797460e6dc62330ccc637",
      upstreamAccountId:
        "260d0fd13750490e7801f7b5b0d116961840982e7e9797460e6dc62330ccc637",
    });
    expect(tradeExecutionIdentityCommitments("web-user-1", "coinbase").venueAccountCommitment)
      .toBe("09e6d38518a9b6fdb0cb6a6119c2e4d13b4d231eaaf06383cbfe54083127fefc");
    expect(tradeExecutionIdentityCommitments("web-user-1", "phoenix")).toEqual({
      executionCredentialHandleCommitment:
        "08114df6d95d3004e1c8c139109838db2b59305dd7486e2673e5973ed5dc9c38",
      venueAccountCommitment: null,
      upstreamAccountId:
        "08114df6d95d3004e1c8c139109838db2b59305dd7486e2673e5973ed5dc9c38",
    });
  });

  it("returns only server-derived upstream identity", () => {
    const identity = tradeExecutionIdentityCommitments("web-user-1", "hyperliquid");
    expect(verifyTradeExecutionIdentityCommitments({
      executionCredentialHandleCommitmentsByVenue: {
        hyperliquid: identity.executionCredentialHandleCommitment,
      },
      hyperliquidAccountCommitment: identity.venueAccountCommitment,
    }, {
      verifiedSubjectId: "web-user-1",
      venueId: "hyperliquid",
    })).toEqual({ ok: true, ...identity });
  });

  it("rejects a different subject's credential handle", () => {
    const account = tradeExecutionIdentityCommitments("web-user-1", "hyperliquid");
    const swapped = tradeExecutionIdentityCommitments("other-web-user", "hyperliquid");
    expect(verifyTradeExecutionIdentityCommitments({
      executionCredentialHandleCommitmentsByVenue: {
        hyperliquid: swapped.executionCredentialHandleCommitment,
      },
      hyperliquidAccountCommitment: account.venueAccountCommitment,
    }, {
      verifiedSubjectId: "web-user-1",
      venueId: "hyperliquid",
    })).toEqual({ ok: false, error: "execution_credential_subject_mismatch" });
  });

  it("rejects a different subject's venue account", () => {
    const identity = tradeExecutionIdentityCommitments("web-user-1", "hyperliquid");
    const swapped = tradeExecutionIdentityCommitments("other-web-user", "hyperliquid");
    expect(verifyTradeExecutionIdentityCommitments({
      executionCredentialHandleCommitmentsByVenue: {
        hyperliquid: identity.executionCredentialHandleCommitment,
      },
      hyperliquidAccountCommitment: swapped.venueAccountCommitment,
    }, {
      verifiedSubjectId: "web-user-1",
      venueId: "hyperliquid",
    })).toEqual({ ok: false, error: "execution_account_subject_mismatch" });
  });

  it("rejects missing accounts and hidden credential selectors", () => {
    const identity = tradeExecutionIdentityCommitments("web-user-1", "coinbase");
    expect(verifyTradeExecutionIdentityCommitments({
      executionCredentialHandleCommitmentsByVenue: {
        coinbase: identity.executionCredentialHandleCommitment,
      },
    }, {
      verifiedSubjectId: "web-user-1",
      venueId: "coinbase",
    })).toEqual({ ok: false, error: "execution_account_subject_mismatch" });
    expect(verifyTradeExecutionIdentityCommitments({
      executionCredentialHandleCommitmentsByVenue: {
        coinbase: identity.executionCredentialHandleCommitment,
        hyperliquid: "a".repeat(64),
      },
      coinbaseAccountCommitment: identity.venueAccountCommitment,
    }, {
      verifiedSubjectId: "web-user-1",
      venueId: "coinbase",
    })).toEqual({ ok: false, error: "execution_credential_subject_mismatch" });
  });
});
