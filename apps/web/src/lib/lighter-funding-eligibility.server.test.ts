import { describe, expect, it, vi } from "vitest";
import {
  assertLighterFundingEligibility,
  assertLighterFundingEligibilityMatchesRequest,
} from "./lighter-funding-eligibility.server";
import {
  LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
  LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES,
} from "./lighter-funding-eligibility";

vi.mock("server-only", () => ({}));

describe("Lighter funding eligibility", () => {
  it("tracks the complete country list in the current Lighter Terms", () => {
    expect([...LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES].sort()).toEqual([
      "BY", "CA", "CN", "CU", "GB", "IR", "KP", "MM", "RU", "SD", "SY", "UA", "US", "VE",
    ]);
  });

  it.each(LIGHTER_FUNDING_RESTRICTED_COUNTRY_CODES)("blocks restricted country %s", (country) => {
    expect(() => issue(country)).toThrowError(expect.objectContaining({
      code: "lighter_uda_eligibility_country_restricted",
      status: 403,
    }));
  });

  it.each([undefined, "", "XX", "USA", "1A"])("blocks missing or unknown country %j", (country) => {
    expect(() => issue(country)).toThrowError(expect.objectContaining({
      code: "lighter_uda_eligibility_country_unavailable",
      status: 403,
    }));
  });

  it("returns only signed country evidence and never raw IP", () => {
    const evidence = assertLighterFundingEligibility({
      request: request("de", "203.0.113.9"),
      attestation: LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
    });
    expect(evidence).toEqual({
      ...LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
      country_code: "DE",
      country_source: "vercel_request_header",
      eligible: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("203.0.113.9");
  });

  it("requires the current exact attestation and the same country on use", () => {
    expect(() => assertLighterFundingEligibility({
      request: request("DE"),
      attestation: { ...LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION, terms_version: "old" },
    })).toThrowError(expect.objectContaining({ code: "lighter_uda_eligibility_attestation_invalid" }));

    const evidence = issue("DE");
    expect(() => assertLighterFundingEligibilityMatchesRequest({
      request: request("FR"),
      evidence,
    })).toThrowError(expect.objectContaining({
      code: "lighter_uda_eligibility_country_mismatch",
      status: 403,
    }));
  });
});

function issue(country: string | undefined) {
  return assertLighterFundingEligibility({
    request: request(country),
    attestation: LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
  });
}

function request(country?: string, forwardedFor?: string) {
  const headers = new Headers();
  if (country !== undefined) headers.set("x-vercel-ip-country", country);
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  return new Request("https://ghola.example/api/carry/lighter", { headers });
}
