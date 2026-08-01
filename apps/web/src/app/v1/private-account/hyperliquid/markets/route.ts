import { getHyperliquidMarketUniverse } from "@/lib/hyperliquid-market-data";
import { ensureMarketDataWarmer } from "@/lib/market-data-warmer";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  void ensureMarketDataWarmer();
  const url = new URL(req.url);
  const markets = await getHyperliquidMarketUniverse({
    network: url.searchParams.get("network"),
  });
  return json({
    version: 1,
    platform: "hyperliquid",
    markets,
  });
}
