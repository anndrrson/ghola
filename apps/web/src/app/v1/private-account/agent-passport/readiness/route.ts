import {
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import { agentPassportReadinessForOwner } from "@/lib/private-agent-passport";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await agentPassportReadinessForOwner(owner));
}
