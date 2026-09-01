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

  it("preserves an already-decoded Carry setup with its nested terminal return", () => {
    const target = "/account?setup=carry&long_venue=hyperliquid&short_venue=aster&return_to=%2Ftrade%3Fproduct%3Dperps%26venue%3Dhyperliquid%26market%3DBTC-PERP%26carry%3Dopen%26long_venue%3Dhyperliquid%26short_venue%3Daster";
    expect(safeInternalRedirect(target)).toBe(target);
    const setup = new URL(safeInternalRedirect(target), "https://ghola.test");
    expect(setup.searchParams.get("return_to")).toBe(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=aster",
    );
  });

  it("rejects absolute, protocol-relative, and backslash redirects", () => {
    expect(safeInternalRedirect("https://evil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("//evil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("%2F%2Fevil.test%2Fsteal")).toBe("/trade");
    expect(safeInternalRedirect("/\\evil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("/%5Cevil.test/steal")).toBe("/trade");
    expect(safeInternalRedirect("%2F%5Cevil.test%2Fsteal")).toBe("/trade");
    expect(safeInternalRedirect("/%255Cevil.test/steal")).toBe("/trade");
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
