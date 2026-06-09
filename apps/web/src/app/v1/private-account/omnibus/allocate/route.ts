import {
  allocateOmnibusFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  return json(await allocateOmnibusFromBody(guarded.body, guarded.owner), 201);
}
