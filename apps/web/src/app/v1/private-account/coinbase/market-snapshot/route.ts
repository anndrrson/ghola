import { getCoinbaseMarketSnapshot } from "@/lib/coinbase-market-data";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

// CORS-safe fallback for the Coinbase Advanced public-market graph.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = await getCoinbaseMarketSnapshot({
    productId: url.searchParams.get("product_id"),
    interval: url.searchParams.get("interval"),
  });
  return json(snapshot);
}
