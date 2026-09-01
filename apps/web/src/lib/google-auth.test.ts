import { describe, expect, it } from "vitest";

import {
  isGoogleAuthOriginAllowed,
  resolveAuthRedirect,
  safeInternalRedirect,
} from "./google-auth";

describe("Google auth redirect safety", () => {
  it("keeps valid in-app routes and decodes the callback cookie", () => {
    expect(safeInternalRedirect("%2Ftrade%3Fmarket%3DHYPE-PERP")).toBe(
      "/trade?market=HYPE-PERP",
    );
  });

  it("rejects absolute and protocol-relative redirects", () => {
    expect(safeInternalRedirect("https://evil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("//evil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("%2F%2Fevil.test%2Fsteal")).toBe("/trade");
  });

  it("returns sign-in users to trading from either supported query name", () => {
    expect(
      resolveAuthRedirect(
        new URLSearchParams("next=%2Ftrade%3Fmarket%3DATOM-PERP"),
      ),
    ).toBe("/trade?market=ATOM-PERP");
    expect(
      resolveAuthRedirect(
        new URLSearchParams("redirect=%2Ftrade%3Fmarket%3DHYPE-PERP"),
      ),
    ).toBe("/trade?market=HYPE-PERP");
    expect(resolveAuthRedirect(new URLSearchParams())).toBe("/trade");
  });

  it("allows only the canonical production origin by default", () => {
    expect(isGoogleAuthOriginAllowed("https://ghola.xyz", undefined)).toBe(true);
    expect(isGoogleAuthOriginAllowed("https://ghola.xyz/", undefined)).toBe(true);
    expect(
      isGoogleAuthOriginAllowed(
        "https://web-random-anndrrsons-projects.vercel.app",
        undefined,
      ),
    ).toBe(false);
  });

  it("allows an explicitly registered stable Preview without allowing siblings", () => {
    const registered = [
      "https://ghola.xyz",
      "https://ghola-preview.example",
    ].join(",");
    expect(
      isGoogleAuthOriginAllowed("https://ghola-preview.example", registered),
    ).toBe(true);
    expect(
      isGoogleAuthOriginAllowed("https://other-preview.example", registered),
    ).toBe(false);
  });

  it("fails closed for blank, wildcard, credentialed, and path-bearing entries", () => {
    expect(isGoogleAuthOriginAllowed("https://ghola.xyz", "")).toBe(false);
    expect(isGoogleAuthOriginAllowed("https://ghola.xyz", "*")).toBe(false);
    expect(
      isGoogleAuthOriginAllowed(
        "https://ghola.xyz",
        "https://user:secret@ghola.xyz",
      ),
    ).toBe(false);
    expect(
      isGoogleAuthOriginAllowed(
        "https://ghola.xyz",
        "https://ghola.xyz/auth",
      ),
    ).toBe(false);
  });
});
