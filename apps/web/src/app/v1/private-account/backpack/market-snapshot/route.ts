import { getBackpackMarketSnapshot } from "@/lib/backpack-market-data";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = await getBackpackMarketSnapshot({
    symbol: url.searchParams.get("symbol"),
    interval: url.searchParams.get("interval"),
  });
  return json(snapshot);
}
