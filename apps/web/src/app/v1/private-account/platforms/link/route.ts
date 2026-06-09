import {
  json,
  privateAccountLiveGuard,
} from "../../_lib";
import { linkAgentPlatformFromBody } from "@/lib/private-agent-passport";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  const linked = await linkAgentPlatformFromBody(guarded.body, guarded.owner);
  if ("error" in linked) return json({ error: linked.error }, 400);
  return json(linked, 201);
}
