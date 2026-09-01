import "server-only";

import {
  isLighterFundingEligibilityAttestation,
  isLighterFundingEligibilityEvidence,
  LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES,
  type LighterFundingEligibilityAttestationV1,
  type LighterFundingEligibilityEvidenceV1,
} from "./lighter-funding-eligibility";

const COUNTRY_HEADER = "x-vercel-ip-country";
const RESTRICTED_COUNTRIES = new Set<string>(LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES);

export function assertLighterFundingEligibility(input: {
  request: Request;
  attestation: unknown;
}): LighterFundingEligibilityEvidenceV1 {
  if (!isLighterFundingEligibilityAttestation(input.attestation)) {
    throw eligibilityError("lighter_uda_eligibility_attestation_invalid", 400);
  }
  return evidence(input.request, input.attestation);
}

export function assertLighterFundingEligibilityMatchesRequest(input: {
  request: Request;
  evidence: unknown;
}): LighterFundingEligibilityEvidenceV1 {
  if (!isLighterFundingEligibilityEvidence(input.evidence)) {
    throw eligibilityError("lighter_uda_eligibility_evidence_invalid", 403);
  }
  const current = evidence(input.request, input.evidence);
  if (current.country_code !== input.evidence.country_code) {
    throw eligibilityError("lighter_uda_eligibility_country_mismatch", 403);
  }
  return current;
}

function evidence(
  request: Request,
  attestation: LighterFundingEligibilityAttestationV1,
): LighterFundingEligibilityEvidenceV1 {
  const countryCode = countryFromRequest(request);
  return Object.freeze({
    ...attestation,
    country_code: countryCode,
    country_source: "vercel_request_header" as const,
    eligible: true as const,
  });
}

function countryFromRequest(request: Request) {
  const raw = request.headers.get(COUNTRY_HEADER)?.trim().toUpperCase() ?? "";
  const countryCode = raw === "UK" ? "GB" : raw;
  if (!/^[A-Z]{2}$/.test(countryCode) || countryCode === "XX") {
    throw eligibilityError("lighter_uda_eligibility_country_unavailable", 403);
  }
  if (RESTRICTED_COUNTRIES.has(countryCode)) {
    throw eligibilityError("lighter_uda_eligibility_country_restricted", 403);
  }
  return countryCode;
}

function eligibilityError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}
