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
      details: ["encrypted_execution_instruction_bundle.recipient must match worker recipient"],
    }, 400)).toBe("sealed_instruction_recipient_mismatch");

    expect(noFundsReason({
      error_code: "venue_access_required",
      error: "invalid hyperliquid private verification request",
      details: ["encrypted_execution_vault.recipient must match worker recipient"],
    }, 400)).toBe("sealed_vault_recipient_mismatch");

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

  it("preserves actionable Hyperliquid live-policy failures", () => {
    expect(noFundsReason({
      error_code: "live_gate_disabled",
      error: "hyperliquid full-ticket max notional is not configured",
    }, 503)).toBe("live_gate_disabled");

    expect(noFundsReason({
      error_code: "live_mode_mismatch",
      error: "hyperliquid live order must use tiny_fill mode",
    }, 403)).toBe("live_mode_mismatch");
  });
});
