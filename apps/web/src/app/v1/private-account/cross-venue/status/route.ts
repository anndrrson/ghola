import { probeCrossVenueExecutionReadiness } from "@/lib/cross-venue-worker";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(await probeCrossVenueExecutionReadiness());
}
