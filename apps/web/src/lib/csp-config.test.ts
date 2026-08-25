import { describe, expect, it } from "vitest";
import { CONNECT_SRC_HOSTS, connectSrcDirective } from "./csp-config";

describe("CSP connection allowlist", () => {
  it("allows the official Hyperliquid HTTPS authorization APIs", () => {
    expect(CONNECT_SRC_HOSTS).toContain("https://api.hyperliquid.xyz");
    expect(CONNECT_SRC_HOSTS).toContain("https://api.hyperliquid-testnet.xyz");
    expect(connectSrcDirective()).not.toContain("https: wss:");
  });
});
