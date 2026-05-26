import { json, treasuryStatus } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(treasuryStatus());
}
