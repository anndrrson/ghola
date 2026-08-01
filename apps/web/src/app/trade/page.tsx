import { PublicCoinbaseLiveTrade } from "@/components/trade/PublicCoinbaseLiveTrade";
import { headers } from "next/headers";
import { resolveGholaProductEnvironment } from "@/lib/product-environment";

export const dynamic = "force-dynamic";

export default async function TradePage() {
  const requestHeaders = await headers();
  const productEnvironment = resolveGholaProductEnvironment({
    host: requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    configuredEnvironment: process.env.GHOLA_PRODUCT_ENVIRONMENT,
    configuredHyperliquidNetwork: process.env.GHOLA_HYPERLIQUID_PILOT_NETWORK,
  });
  const configuredSlippage = Number.parseInt(
    process.env.GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS ||
      process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS ||
      "25",
    10,
  );
  const hyperliquidMaxSlippageBps = Number.isInteger(configuredSlippage)
    ? Math.max(1, Math.min(configuredSlippage, 100))
    : 25;
  return (
    <PublicCoinbaseLiveTrade
      hyperliquidNetwork={productEnvironment.hyperliquidNetwork}
      productEnvironment={productEnvironment.environment}
      hyperliquidMaxSlippageBps={hyperliquidMaxSlippageBps}
    />
  );
}
