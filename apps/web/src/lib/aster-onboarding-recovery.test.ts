import { describe, expect, it } from "vitest";
import { classifyAsterOnboardingFailure } from "./aster-onboarding-recovery";
import type { AsterProgrammaticPreparation } from "./private-account-client";

const PREPARATION = {
  version: 1,
  preparation_id: `aster_prepare_${"ab".repeat(32)}`,
  account_commitment: "private_account_aster_recovery_test",
  venue_id: "aster",
  credential_provisioning_mode: "programmatic_generated",
  owner_approval_required: true,
  authorization_expires_at: new Date(1_802_592_000_000).toISOString(),
  contract: {
    ownerAuthorization: { ownerAddress: "0x1111111111111111111111111111111111111111" },
    attestedSigner: { publicAddress: "0x2222222222222222222222222222222222222222" },
    approval: { parametersWithoutSignature: { expired: 1_802_592_000_000 } },
  },
} as unknown as AsterProgrammaticPreparation;

function apiError(body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error || "failed")), { body });
}

function receipt() {
  return {
    version: 1,
    venue_id: "aster",
    status: "registered",
    preparation_id: PREPARATION.preparation_id,
    owner_address: PREPARATION.contract.ownerAuthorization.ownerAddress,
    signer_address: PREPARATION.contract.attestedSigner.publicAddress,
    signature_commitment: `sha256:${"cd".repeat(32)}`,
    authorization_expires_at: PREPARATION.authorization_expires_at,
    permissions: {},
    setup: {},
    registered_at: null,
  };
}

describe("Aster onboarding recovery", () => {
  it("offers exact link recovery only with the matching registered receipt", () => {
    expect(classifyAsterOnboardingFailure(apiError({
      error: "platform_link_failed",
      credential_registered: true,
      needs_link_retry: true,
      registration_receipt: receipt(),
    }), PREPARATION)).toMatchObject({ action: "finish_link", receipt: receipt() });

    expect(classifyAsterOnboardingFailure(apiError({
      credential_registered: true,
      needs_link_retry: true,
      registration_receipt: { ...receipt(), preparation_id: `aster_prepare_${"ef".repeat(32)}` },
    }), PREPARATION).action).toBe("none");
  });

  it("requires one deliberate re-prepare for a stale pre-registration approval", () => {
    expect(classifyAsterOnboardingFailure(apiError({
      error: "nonce_outside_aster_window",
      reprepare_allowed: true,
    }), PREPARATION).action).toBe("reprepare");
  });

  it("never offers retry or re-prepare for an ambiguous registration", () => {
    expect(classifyAsterOnboardingFailure(apiError({
      error: "aster_registration_ambiguous",
      reprepare_allowed: true,
    }), PREPARATION).action).toBe("hold_ambiguous");
    expect(classifyAsterOnboardingFailure(new TypeError("network disconnected"), PREPARATION).action).toBe(
      "hold_ambiguous",
    );
  });
});
