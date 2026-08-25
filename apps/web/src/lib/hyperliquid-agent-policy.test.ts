import { describe, expect, it } from "vitest";
import {
  hyperliquidAgentApprovalTarget,
  hyperliquidNamedAgentCapacity,
} from "./hyperliquid-agent-policy";

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

  it("keeps deterministic named replacement ahead of the unnamed fallback", () => {
    expect(hyperliquidAgentApprovalTarget({
      namedSlotAvailable: true,
      unnamedSlotAvailable: true,
    })).toEqual({ mode: "named", agentName: "ghola" });
  });

  it("uses the unnamed slot only when named slots are full and it is empty", () => {
    expect(hyperliquidAgentApprovalTarget({
      namedSlotAvailable: false,
      unnamedSlotAvailable: true,
    })).toEqual({ mode: "unnamed", agentName: "" });
  });

  it("never replaces an occupied unnamed wallet", () => {
    expect(hyperliquidAgentApprovalTarget({
      namedSlotAvailable: false,
      unnamedSlotAvailable: false,
    })).toEqual({ mode: "unavailable", agentName: null });
  });
});
