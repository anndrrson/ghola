import { getTriVenueMarketBundle } from "@/lib/private-account-tri-venue-arb";
import { json } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const bundle = await getTriVenueMarketBundle({
    interval: url.searchParams.get("interval"),
  });
  return json(bundle);
}
