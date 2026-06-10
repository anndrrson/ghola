import {
  fundingImportFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const imported = await fundingImportFromBody(guarded.body, guarded.owner);
  if ("error" in imported) return json({ error: imported.error }, 400);
  return json(imported, 201);
}
