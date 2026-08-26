import type {
  AsterProgrammaticPreparation,
  AsterPublicRegistrationReceipt,
} from "./private-account-client";

export type AsterOnboardingFailureDisposition =
  | { action: "finish_link"; receipt: AsterPublicRegistrationReceipt; message: string }
  | { action: "reprepare"; message: string }
  | { action: "hold_ambiguous"; message: string }
  | { action: "none"; message: string };

const STALE_CODES = new Set([
  "nonce_outside_aster_window",
  "aster_authorization_stale",
  "aster_authorization_expired",
]);
const REJECTED_CODES = new Set(["aster_registration_rejected"]);
const AMBIGUOUS_CODES = new Set([
  "aster_registration_ambiguous",
  "aster_registration_outcome_ambiguous",
  "aster_registration_not_retryable",
]);

export function classifyAsterOnboardingFailure(
  error: unknown,
  preparation: AsterProgrammaticPreparation,
): AsterOnboardingFailureDisposition {
  const body = errorBody(error);
  const errorCode = string(body.error);
  if (Object.keys(body).length === 0) {
    return {
      action: "hold_ambiguous",
      message: "The connection ended after Aster submission began. Do not retry; reconcile the existing attempt.",
    };
  }
  if (AMBIGUOUS_CODES.has(errorCode)) {
    return {
      action: "hold_ambiguous",
      message: "Aster registration has an unknown outcome. Do not retry; reconcile the existing attempt.",
    };
  }
  if (REJECTED_CODES.has(errorCode)) {
    const providerCode = Number.isSafeInteger(Number(body.provider_code))
      ? Number(body.provider_code)
      : null;
    const providerMessage = string(body.provider_message).slice(0, 240);
    const providerDetail = [
      providerCode == null ? "" : `code ${providerCode}`,
      providerMessage,
    ].filter(Boolean).join(": ");
    return {
      action: "reprepare",
      message: providerDetail
        ? `Aster rejected this registration (${providerDetail}). Correct the Aster account or approval, then prepare one fresh request. The rejected request was not retried.`
        : "Aster rejected this registration. Correct the Aster account or approval, then prepare one fresh request. The rejected request was not retried.",
    };
  }
  const receipt = registrationReceipt(body.registration_receipt, preparation);
  if (body.credential_registered === true && body.needs_link_retry === true && receipt) {
    return {
      action: "finish_link",
      receipt,
      message: "Aster registered the trade-only signer. Finish linking it; registration will not be submitted again.",
    };
  }
  if (body.credential_registered !== true && (body.reprepare_allowed === true || STALE_CODES.has(errorCode))) {
    return {
      action: "reprepare",
      message: "The Aster approval expired before registration. Re-prepare once, then approve the fresh request.",
    };
  }
  return {
    action: "none",
    message: error instanceof Error ? error.message : "Aster authorization failed.",
  };
}

function registrationReceipt(
  value: unknown,
  preparation: AsterProgrammaticPreparation,
): AsterPublicRegistrationReceipt | null {
  const receipt = record(value);
  const params = preparation.contract.approval.parametersWithoutSignature;
  if (
    receipt.version !== 1 ||
    receipt.venue_id !== "aster" ||
    receipt.status !== "registered" ||
    receipt.preparation_id !== preparation.preparation_id ||
    string(receipt.owner_address).toLowerCase() !== preparation.contract.ownerAuthorization.ownerAddress ||
    string(receipt.signer_address).toLowerCase() !== preparation.contract.attestedSigner.publicAddress ||
    receipt.authorization_expires_at !== new Date(params.expired).toISOString() ||
    !/^sha256:[0-9a-f]{64}$/.test(string(receipt.signature_commitment))
  ) {
    return null;
  }
  return receipt as unknown as AsterPublicRegistrationReceipt;
}

function errorBody(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" && "body" in error ? record(error.body) : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
