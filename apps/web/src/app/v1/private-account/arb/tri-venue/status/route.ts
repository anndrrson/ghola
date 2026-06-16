import { getTriVenueStatus } from "@/lib/private-account-tri-venue-arb";
import { json } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const probeWorker = url.searchParams.get("probe_worker") === "1";
  return json(await getTriVenueStatus({ probeWorker }));
}
