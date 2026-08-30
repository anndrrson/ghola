import { describe, expect, it } from "vitest";
import {
  evaluateLiveTradingJurisdiction,
  LIVE_TRADING_COUNTRY_ALLOWLIST_ENV,
} from "./live-trading-jurisdiction.server";

describe("live-trading jurisdiction gate", () => {
  it("accepts only an allowlisted Vercel country in production", () => {
    expect(evaluateLiveTradingJurisdiction(request({
      "x-vercel-ip-country": "CA",
      "x-country-code": "US",
    }), productionEnv("CA,GB"))).toMatchObject({
      allowed: true,
      status: 200,
      country: "CA",
      reason: "allowed",
    });
  });

  it.each(["US", "PR", "VI", "GU", "AS", "MP", "UM"])(
    "hard-denies US jurisdiction %s even when configured",
    (country) => {
      expect(evaluateLiveTradingJurisdiction(
        request({ "x-vercel-ip-country": country }),
        productionEnv(`CA,${country}`),
      )).toMatchObject({
        allowed: false,
        status: 451,
        country,
        reason: "restricted_us_jurisdiction",
      });
    },
  );

  it("denies missing, malformed, untrusted, and non-allowlisted countries", () => {
    expect(evaluateLiveTradingJurisdiction(request({}), productionEnv("CA")))
      .toMatchObject({ status: 451, reason: "country_header_missing" });
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-vercel-ip-country": "Canada" }),
      productionEnv("CA"),
    )).toMatchObject({ status: 451, reason: "country_header_invalid" });
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-vercel-ip-country": "CA" }),
      { ...productionEnv("CA"), VERCEL: "0" },
    )).toMatchObject({ status: 451, reason: "untrusted_country_source" });
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-vercel-ip-country": "GB" }),
      productionEnv("CA"),
    )).toMatchObject({ status: 451, reason: "country_not_allowlisted" });
  });

  it("ignores generic and test country headers in production", () => {
    const decision = evaluateLiveTradingJurisdiction(request({
      "cf-ipcountry": "CA",
      "x-country-code": "CA",
      "x-ghola-test-country": "CA",
    }), productionEnv("CA"));
    expect(decision).toMatchObject({ status: 451, reason: "country_header_missing" });
  });

  it("uses only the explicit test header outside production", () => {
    const env = testEnv("CA");
    expect(evaluateLiveTradingJurisdiction(request({
      "x-ghola-test-country": "CA",
      "x-vercel-ip-country": "US",
    }), env)).toMatchObject({ allowed: true, country: "CA" });
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-vercel-ip-country": "CA" }),
      env,
    )).toMatchObject({ status: 451, reason: "country_header_missing" });
  });

  it("fails closed for missing or malformed allowlists", () => {
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-ghola-test-country": "CA" }),
      testEnv(undefined),
    )).toMatchObject({ status: 451, reason: "jurisdiction_allowlist_missing" });
    expect(evaluateLiveTradingJurisdiction(
      request({ "x-ghola-test-country": "CA" }),
      testEnv("CA,USA"),
    )).toMatchObject({ status: 451, reason: "jurisdiction_allowlist_invalid" });
  });
});

function request(headers: Record<string, string>) {
  return new Request("https://ghola.test/api/trading/eligibility", { headers });
}

function productionEnv(allowlist: string): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "production",
    [LIVE_TRADING_COUNTRY_ALLOWLIST_ENV]: allowlist,
  };
}

function testEnv(allowlist: string | undefined): Record<string, string | undefined> {
  return {
    NODE_ENV: "test",
    [LIVE_TRADING_COUNTRY_ALLOWLIST_ENV]: allowlist,
  };
}
