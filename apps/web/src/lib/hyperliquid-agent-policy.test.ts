import { describe, expect, it } from "vitest";
import { hyperliquidNamedAgentCapacity } from "./hyperliquid-agent-policy";

describe("Hyperliquid named-agent capacity", () => {
  it("allows a fresh named slot", () => {
    expect(hyperliquidNamedAgentCapacity({
      activeNamedAgentCount: 2,
      preferredNameInUse: false,
    }).namedSlotAvailable).toBe(true);
  });

  it("allows replacing the deterministic Ghola slot when all three are occupied", () => {
    expect(hyperliquidNamedAgentCapacity({
      activeNamedAgentCount: 3,
      preferredNameInUse: true,
    }).namedSlotAvailable).toBe(true);
  });

  it("blocks creating a fourth unrelated named wallet", () => {
    expect(hyperliquidNamedAgentCapacity({
      activeNamedAgentCount: 3,
      preferredNameInUse: false,
    }).namedSlotAvailable).toBe(false);
  });
});
