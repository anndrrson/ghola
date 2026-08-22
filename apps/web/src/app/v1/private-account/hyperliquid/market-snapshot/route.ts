import {
  getHyperliquidMarketSnapshot,
} from "@/lib/hyperliquid-market-data";
import { ensureMarketDataWarmer } from "@/lib/market-data-warmer";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  void ensureMarketDataWarmer();
  const url = new URL(req.url);
  const snapshot = await getHyperliquidMarketSnapshot({
    network: url.searchParams.get("network"),
    coin: url.searchParams.get("coin"),
    interval: url.searchParams.get("interval"),
  });
  return json(snapshot);
}
