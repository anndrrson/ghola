export const GHOLA_HYPERLIQUID_PROOF_PROTOCOL = "ghola-hyperliquid-proof-v2" as const;

export function isGholaHyperliquidProofProtocol(value: unknown): boolean {
  return value === GHOLA_HYPERLIQUID_PROOF_PROTOCOL;
}
