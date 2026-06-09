import { getMobileMarketSnapshot } from "@/lib/mobile-market-data";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const snapshot = await getMobileMarketSnapshot({
    productId: url.searchParams.get("product_id"),
    interval: url.searchParams.get("interval"),
  });
  return json(snapshot);
}
