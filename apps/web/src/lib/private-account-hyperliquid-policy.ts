export const DEFAULT_HYPERLIQUID_MARKET_ALLOWLIST = ["BTC", "ETH", "SOL", "HYPE"] as const;

export function defaultHyperliquidMarketAllowlist(): string[] {
  return [...DEFAULT_HYPERLIQUID_MARKET_ALLOWLIST];
}
