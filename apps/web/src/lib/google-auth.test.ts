import { describe, expect, it } from "vitest";

import { resolveAuthRedirect, safeInternalRedirect } from "./google-auth";

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
});
