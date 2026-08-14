import { describe, expect, it } from "vitest";
import { terminalLiveOrderMode } from "./terminal-live-order-mode";

describe("terminal live order mode", () => {
  it("uses bounded non-resting quote sizing for Coinbase", () => {
    expect(terminalLiveOrderMode("coinbase")).toMatchObject({
      orderType: "limit",
      timeInForce: "ioc",
      operationClass: "spot_limit_order",
      workerVenueId: "coinbase_advanced",
      includeBaseSize: false,
      liveAvailable: true,
      label: "Limit · IOC",
    });
  });

  it("uses signed Hyperliquid IOC and keeps Phoenix fail-closed", () => {
    expect(terminalLiveOrderMode("hyperliquid")).toMatchObject({
      timeInForce: "ioc",
      operationClass: "limit_order",
      includeBaseSize: true,
      liveAvailable: true,
      label: "Limit · IOC",
    });
    expect(terminalLiveOrderMode("phoenix")).toMatchObject({
      timeInForce: "gtc",
      operationClass: "limit_order",
      liveAvailable: false,
    });
  });
});
