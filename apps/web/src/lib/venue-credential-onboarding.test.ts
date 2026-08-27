import { describe, expect, it } from "vitest";
import {
  getCurrentVenueCredentialOnboardingPath,
  getVenueCredentialOnboardingCapability,
  getVenueCredentialOnboardingPath,
  VENUE_CREDENTIAL_ONBOARDING_MODES,
  VENUE_CREDENTIAL_ONBOARDING,
} from "./venue-credential-onboarding";
import { CARRY_EXECUTION_VENUES } from "./carry-venues";

describe("venue credential onboarding capabilities", () => {
  it("models the three credential-provisioning boundaries", () => {
    expect(VENUE_CREDENTIAL_ONBOARDING_MODES).toEqual([
      "wallet_authorized_auto_provisioning",
      "programmatic_key_one_owner_signature",
      "venue_controlled_owner_association",
      "manual_only",
    ]);
  });

  it("derives onboarding coverage from the execution capability registry", () => {
    expect(Object.keys(VENUE_CREDENTIAL_ONBOARDING)).toEqual(CARRY_EXECUTION_VENUES);
  });

  it("advertises Hyperliquid automation without claiming silent authorization or trading", () => {
    const current = getCurrentVenueCredentialOnboardingPath("hyperliquid");
    expect(current).toMatchObject({
      mode: "wallet_authorized_auto_provisioning",
      availability: "available",
      credential_custody: "turnkey_managed",
      requires_wallet_authentication: true,
      requires_manual_secret_entry: false,
      requires_venue_controlled_association: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
    });
    expect(current.requirements.join(" ")).toContain("Turnkey");
    expect(current.requirements.join(" ")).toContain("control the Hyperliquid owner account");

    const ownerSignature = getVenueCredentialOnboardingPath(
      "hyperliquid",
      "programmatic_key_one_owner_signature",
    );
    expect(ownerSignature).toMatchObject({
      availability: "feature_gated",
      requires_one_owner_signature: true,
      requires_manual_secret_entry: false,
      may_place_trade_during_setup: false,
    });
  });

  it("exposes Lighter's verified one-approval Turnkey association path", () => {
    const capability = getVenueCredentialOnboardingCapability("lighter");
    const automated = getVenueCredentialOnboardingPath("lighter", "programmatic_key_one_owner_signature");
    const current = getCurrentVenueCredentialOnboardingPath("lighter");
    expect(capability.highest_proven_mode).toBe("programmatic_key_one_owner_signature");
    expect(capability.paths.some((path) => path.mode === "wallet_authorized_auto_provisioning")).toBe(false);
    expect(automated).toMatchObject({
      availability: "available",
      credential_custody: "attested_worker_generated_sealed",
      requires_one_owner_signature: true,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
    });
    expect(automated?.requirements.join(" ")).toContain("attested worker");
    expect(automated?.requirements.join(" ")).toContain("Turnkey owner");
    expect(automated?.requirements.join(" ")).toContain("without retrying ambiguity");
    expect(current).toMatchObject({
      mode: "programmatic_key_one_owner_signature",
      availability: "available",
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
    });
    expect(current.ux.action_label).toBe("Create key & authorize");
  });

  it("exposes Aster's verified one-signature programmatic path", () => {
    const capability = getVenueCredentialOnboardingCapability("aster");
    const future = getVenueCredentialOnboardingPath("aster", "programmatic_key_one_owner_signature");
    const current = getCurrentVenueCredentialOnboardingPath("aster");
    expect(capability.highest_proven_mode).toBe("programmatic_key_one_owner_signature");
    expect(capability.paths.some((path) => path.mode === "wallet_authorized_auto_provisioning")).toBe(false);
    expect(future).toMatchObject({
      availability: "available",
      credential_custody: "attested_worker_generated_sealed",
      requires_one_owner_signature: true,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
    });
    expect(future?.requirements.join(" ")).toContain("attested worker");
    expect(current).toMatchObject({
      mode: "programmatic_key_one_owner_signature",
      availability: "available",
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
    });
    expect(current.ux.action_label).toBe("Create signer & authorize");
  });

  it("never allows setup metadata to imply a trade", () => {
    for (const venue of CARRY_EXECUTION_VENUES) {
      for (const path of getVenueCredentialOnboardingCapability(venue).paths) {
        expect(path.may_place_trade_during_setup).toBe(false);
      }
    }
  });
});
