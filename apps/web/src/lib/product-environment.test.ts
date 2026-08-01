import { describe, expect, it } from "vitest";
import { resolveGholaProductEnvironment } from "./product-environment";

describe("Ghola product environment", () => {
  it("binds the public testnet hostname to Hyperliquid testnet", () => {
    expect(resolveGholaProductEnvironment({
      host: "testnet.ghola.xyz",
      configuredHyperliquidNetwork: "mainnet",
    })).toEqual({ environment: "testnet", hyperliquidNetwork: "testnet" });
  });

  it("allows an explicit testnet environment on preview hosts", () => {
    expect(resolveGholaProductEnvironment({
      host: "web-preview.vercel.app",
      configuredEnvironment: "testnet",
    })).toEqual({ environment: "testnet", hyperliquidNetwork: "testnet" });
  });

  it("keeps the production hostname on its configured network", () => {
    expect(resolveGholaProductEnvironment({
      host: "ghola.xyz:443",
      configuredHyperliquidNetwork: "mainnet",
    })).toEqual({ environment: "production", hyperliquidNetwork: "mainnet" });
  });
});
