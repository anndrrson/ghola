import { describe, expect, it } from "vitest";

import { safeInternalRedirect } from "./google-auth";

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
});
