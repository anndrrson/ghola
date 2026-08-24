export const GHOLA_HYPERLIQUID_AGENT_NAME = "ghola";
export const HYPERLIQUID_NAMED_AGENT_LIMIT = 3;

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
