import { describe, expect, it } from "vitest";
import { noFundsReason } from "./private-account-connectors";

describe("noFundsReason", () => {
  it("distinguishes safe Hyperliquid credential failure stages", () => {
    expect(noFundsReason({
      error_code: "venue_access_required",
      error: "hyperliquid credentials are invalid",
    }, 400)).toBe("api_wallet_private_key_invalid");

    expect(noFundsReason({
      error_code: "venue_access_required",
      error: "hyperliquid execution credentials are missing",
    }, 400)).toBe("sealed_credential_payload_invalid");

    expect(noFundsReason({
      error_code: "venue_access_required",
      error: "invalid hyperliquid private verification request",
    }, 400)).toBe("sealed_credential_request_invalid");
  });

  it("does not expose unknown worker details as a public reason", () => {
    expect(noFundsReason({
      error_code: "venue_access_required",
      error: "unrecognized internal detail",
    }, 400)).toBe("invalid_authority_or_access");
  });
});
