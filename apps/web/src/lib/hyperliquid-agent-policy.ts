export const GHOLA_HYPERLIQUID_AGENT_NAME = "ghola";
export const HYPERLIQUID_NAMED_AGENT_LIMIT = 3;

export type HyperliquidAgentApprovalTarget =
  | { mode: "named"; agentName: typeof GHOLA_HYPERLIQUID_AGENT_NAME }
  | { mode: "unnamed"; agentName: "" }
  | { mode: "unavailable"; agentName: null };

export function hyperliquidNamedAgentCapacity(input: {
  activeNamedAgentCount: number;
  preferredNameInUse: boolean;
}) {
  const activeNamedAgentCount = Math.max(0, Math.floor(input.activeNamedAgentCount));
  return {
    activeNamedAgentCount,
    namedAgentLimit: HYPERLIQUID_NAMED_AGENT_LIMIT,
    preferredNameInUse: input.preferredNameInUse,
    namedSlotAvailable:
      activeNamedAgentCount < HYPERLIQUID_NAMED_AGENT_LIMIT || input.preferredNameInUse,
  };
}

export function hyperliquidAgentApprovalTarget(input: {
  namedSlotAvailable: boolean;
  unnamedSlotAvailable: boolean;
}): HyperliquidAgentApprovalTarget {
  if (input.namedSlotAvailable) {
    return { mode: "named", agentName: GHOLA_HYPERLIQUID_AGENT_NAME };
  }
  if (input.unnamedSlotAvailable) {
    return { mode: "unnamed", agentName: "" };
  }
  return { mode: "unavailable", agentName: null };
}
