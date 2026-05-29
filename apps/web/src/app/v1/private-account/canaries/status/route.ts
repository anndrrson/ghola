import { canaryStatusBody, json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(await canaryStatusBody());
}
