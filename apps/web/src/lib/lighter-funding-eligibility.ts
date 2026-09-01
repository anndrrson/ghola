export const LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION = 1;
export const LIGHTER_FUNDING_TERMS_VERSION = "2025-12-29";

// Lighter Terms, last updated 2025-12-29: https://lighter.xyz/terms
export const LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES = Object.freeze([
  "BY",
  "CA",
  "CN",
  "CU",
  "GB",
  "IR",
  "KP",
  "MM",
  "RU",
  "SD",
  "SY",
  "UA",
  "US",
  "VE",
] as const);

export type LighterFundingEligibilityAttestationV1 = Readonly<{
  version: typeof LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION;
  terms_version: typeof LIGHTER_FUNDING_TERMS_VERSION;
  accepts_lighter_terms: true;
  attests_not_prohibited_person: true;
}>;

export type LighterFundingEligibilityEvidenceV1 = Readonly<
  LighterFundingEligibilityAttestationV1 & {
    country_code: string;
    country_source: "vercel_request_header";
    eligible: true;
  }
>;

export const LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION = Object.freeze({
  version: LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION,
  terms_version: LIGHTER_FUNDING_TERMS_VERSION,
  accepts_lighter_terms: true,
  attests_not_prohibited_person: true,
} satisfies LighterFundingEligibilityAttestationV1);

const ATTESTATION_KEYS = [
  "accepts_lighter_terms",
  "attests_not_prohibited_person",
  "terms_version",
  "version",
] as const;

const EVIDENCE_KEYS = [
  ...ATTESTATION_KEYS,
  "country_code",
  "country_source",
  "eligible",
] as const;

export function isLighterFundingEligibilityAttestation(
  value: unknown,
): value is LighterFundingEligibilityAttestationV1 {
  if (!exactObject(value, ATTESTATION_KEYS)) return false;
  return value.version === LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION &&
    value.terms_version === LIGHTER_FUNDING_TERMS_VERSION &&
    value.accepts_lighter_terms === true &&
    value.attests_not_prohibited_person === true;
}

export function isLighterFundingEligibilityEvidence(
  value: unknown,
): value is LighterFundingEligibilityEvidenceV1 {
  if (!exactObject(value, EVIDENCE_KEYS)) return false;
  return value.version === LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION &&
    value.terms_version === LIGHTER_FUNDING_TERMS_VERSION &&
    value.accepts_lighter_terms === true &&
    value.attests_not_prohibited_person === true &&
    value.country_source === "vercel_request_header" &&
    value.eligible === true &&
    isLighterFundingCountryCodeEligible(value.country_code);
}

export function isLighterFundingCountryCodeEligible(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Z]{2}$/.test(value) &&
    value !== "XX" &&
    !LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES.includes(
      value as (typeof LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES)[number],
    );
}

function exactObject<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}
