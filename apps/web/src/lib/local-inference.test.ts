import { describe, expect, it } from "vitest";

import { isAllowedGholaHomeUrl } from "./local-inference";

describe("local inference loopback boundary", () => {
  it("allows only loopback ghola-home endpoints", () => {
    expect(isAllowedGholaHomeUrl("http://127.0.0.1:7878")).toBe(true);
    expect(isAllowedGholaHomeUrl("http://localhost:7878")).toBe(true);
    expect(isAllowedGholaHomeUrl("http://[::1]:7878")).toBe(true);

    expect(isAllowedGholaHomeUrl("https://ghola.example.com")).toBe(false);
    expect(isAllowedGholaHomeUrl("http://192.168.1.20:7878")).toBe(false);
    expect(isAllowedGholaHomeUrl("http://10.0.0.2:7878")).toBe(false);
    expect(isAllowedGholaHomeUrl("ftp://127.0.0.1:7878")).toBe(false);
    expect(isAllowedGholaHomeUrl("not a url")).toBe(false);
  });
});
