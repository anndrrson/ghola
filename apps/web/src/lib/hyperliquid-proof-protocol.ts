export const GHOLA_HYPERLIQUID_PROOF_PROTOCOL = "ghola-hyperliquid-proof-v2" as const;
export const GHOLA_HYPERLIQUID_NO_SUBMIT_ORDER_CONTRACT = "tiny_fill_ioc_v1" as const;

export function isGholaHyperliquidProofProtocol(value: unknown): boolean {
  return value === GHOLA_HYPERLIQUID_PROOF_PROTOCOL;
}
