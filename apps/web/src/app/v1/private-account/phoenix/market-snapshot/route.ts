import { getPhoenixMarketSnapshot } from "@/lib/phoenix-market-data";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

// CORS-safe fallback for the live Phoenix chart. The browser stream client
// (phoenix-live-market.ts) calls this when the perp-api WebSocket is unreachable.
// Runs the Rise HTTP client server-side (no WS) and returns a normalized snapshot.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = await getPhoenixMarketSnapshot({
    symbol: url.searchParams.get("symbol"),
    interval: url.searchParams.get("interval"),
  });
  return json(snapshot);
}
