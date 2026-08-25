import { describe, expect, it } from "vitest";
import {
  evaluateVenueExecutionCredential,
  VENUE_EXECUTION_CREDENTIAL_CONTRACT,
  type VenueExecutionCredentialRequest,
} from "./venue-execution-credential-capability";

const TRADE_ONLY = {
  can_read: true,
  can_trade: true,
  can_withdraw: false,
  can_transfer: false,
  can_manage_credentials: false,
  can_export_secret: false,
};

function programmatic(venue_id: "hyperliquid" | "aster" | "lighter"): VenueExecutionCredentialRequest {
  return {
    venue_id,
    provisioning_mode: venue_id === "hyperliquid" ? "turnkey_delegated" : "programmatic_generated",
    turnkey_role: "venue_owner",
    owner_authorization_source: "turnkey_venue_owner",
    explicit_owner_authorization: true,
    owner_binding_verified: true,
    secret_handling: venue_id === "lighter" ? "direct_to_attested_runtime" : "turnkey_non_exportable",
    permission_attestation: TRADE_ONLY,
  };
}

describe("venue execution credential capability", () => {
  it("allows the implemented Hyperliquid Turnkey path", () => {
    expect(evaluateVenueExecutionCredential(programmatic("hyperliquid"))).toMatchObject({
      allowed: true,
      disposition: "provision",
      venue_id: "hyperliquid",
    });
  });

  it("allows Aster programmatic generation after release verification", () => {
    expect(VENUE_EXECUTION_CREDENTIAL_CONTRACT.venues.aster.provisioning_modes)
      .toContain("programmatic_generated");
    expect(evaluateVenueExecutionCredential(programmatic("aster"))).toMatchObject({
      allowed: true,
      disposition: "provision",
      venue_id: "aster",
    });
  });

  it("allows Lighter generation only through the verified Turnkey owner-association path", () => {
    expect(VENUE_EXECUTION_CREDENTIAL_CONTRACT.venues.lighter.provisioning_modes)
      .toContain("programmatic_generated");
    expect(evaluateVenueExecutionCredential(programmatic("lighter"))).toMatchObject({
      allowed: true,
      disposition: "provision",
      venue_id: "lighter",
    });
  });

  it("requires an explicit owner signature and verified venue-owner binding", () => {
    expect(evaluateVenueExecutionCredential({
      ...programmatic("aster"),
      turnkey_role: "delegated_agent",
      explicit_owner_authorization: false,
      owner_binding_verified: false,
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining([
        "explicit_owner_authorization_required",
        "turnkey_must_be_venue_owner",
        "owner_binding_required",
      ]),
    });
  });

  it("accepts Aster's external-owner/attested-generation shape", () => {
    const decision = evaluateVenueExecutionCredential({
      ...programmatic("aster"),
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      secret_handling: "direct_to_attested_runtime",
    });
    expect(decision).toMatchObject({ allowed: true, disposition: "provision" });
  });

  it("rejects external Lighter signatures because the implemented path requires the Turnkey venue owner", () => {
    const decision = evaluateVenueExecutionCredential({
      ...programmatic("lighter"),
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      secret_handling: "direct_to_attested_runtime",
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining(["owner_authorization_source_not_supported"]),
    });
  });

  it("never treats programmatic generation as silent key creation", () => {
    expect(VENUE_EXECUTION_CREDENTIAL_CONTRACT.silent_provisioning_allowed).toBe(false);
    expect(evaluateVenueExecutionCredential({
      ...programmatic("lighter"),
      silent_provisioning: true,
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining(["silent_provisioning_blocked"]),
    });
  });

  it.each([
    ["raw_exportable", "programmatic_secret_handling_not_supported"],
    ["plaintext_persisted", "programmatic_secret_handling_not_supported"],
    ["unknown", "programmatic_secret_handling_not_supported"],
  ] as const)("blocks programmatic credentials with %s secret handling", (secretHandling, reason) => {
    expect(evaluateVenueExecutionCredential({
      ...programmatic("aster"),
      secret_handling: secretHandling,
    })).toMatchObject({ allowed: false, reason_codes: expect.arrayContaining([reason]) });
  });

  it("allows documented manual credentials only when sealed directly to the attested runtime", () => {
    expect(evaluateVenueExecutionCredential({
      venue_id: "coinbase_advanced",
      provisioning_mode: "manual_sealed_import",
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "direct_to_attested_runtime",
      permission_attestation: TRADE_ONLY,
    })).toMatchObject({ allowed: true, disposition: "sealed_import" });

    expect(evaluateVenueExecutionCredential({
      venue_id: "phoenix",
      provisioning_mode: "manual_sealed_import",
      turnkey_role: "none",
      owner_authorization_source: "external_owner_signature",
      explicit_owner_authorization: true,
      owner_binding_verified: true,
      secret_handling: "plaintext_persisted",
      permission_attestation: TRADE_ONLY,
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining(["direct_seal_to_attested_runtime_required"]),
    });
  });

  it.each([
    ["can_withdraw", "withdrawal_permission_blocked"],
    ["can_transfer", "transfer_permission_blocked"],
    ["can_manage_credentials", "credential_admin_permission_blocked"],
    ["can_export_secret", "secret_export_permission_blocked"],
  ] as const)("fails closed when the execution credential has %s", (permission, reason) => {
    expect(evaluateVenueExecutionCredential({
      ...programmatic("hyperliquid"),
      permission_attestation: { ...TRADE_ONLY, [permission]: true },
    })).toMatchObject({ allowed: false, reason_codes: expect.arrayContaining([reason]) });
  });

  it("blocks missing, incomplete, and unknown permission attestations", () => {
    expect(evaluateVenueExecutionCredential({
      ...programmatic("hyperliquid"),
      permission_attestation: null,
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining(["permission_attestation_required"]),
    });
    expect(evaluateVenueExecutionCredential({
      ...programmatic("hyperliquid"),
      permission_attestation: {
        ...TRADE_ONLY,
        can_trade: false,
        unknown_scopes: ["account:write"],
      },
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining([
        "read_trade_permissions_required",
        "unknown_permission_scope_blocked",
      ]),
    });
  });

  it.each(["backpack", "drift", "rfq_network", "kraken", "unknown"])(
    "blocks unsupported venue %s without implying silent provisioning",
    (venueId) => {
      expect(evaluateVenueExecutionCredential({
        ...programmatic("aster"),
        venue_id: venueId,
      })).toMatchObject({
        allowed: false,
        reason_codes: expect.arrayContaining(["venue_not_supported"]),
      });
    },
  );

  it("does not let a supported venue borrow another venue's provisioning mode", () => {
    expect(evaluateVenueExecutionCredential({
      ...programmatic("aster"),
      venue_id: "coinbase_advanced",
    })).toMatchObject({
      allowed: false,
      reason_codes: expect.arrayContaining(["provisioning_mode_not_supported"]),
    });
  });
});
