import {
  preparePublicLiveCoinbaseAccess,
  publicLiveCoinbaseOwnerFromRequest,
  publicLiveJson,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return publicLiveJson({ error: "json_body_required" }, 400);
  }
  const owner = await publicLiveCoinbaseOwnerFromRequest(request);
  if (!owner.ok) return owner.response;
  const prepared = await preparePublicLiveCoinbaseAccess({
    body: body as Record<string, unknown>,
    owner: owner.owner,
    req: request,
  });
  if ("error" in prepared) return publicLiveJson({ error: prepared.error }, 400);
  return publicLiveJson(prepared, prepared.status === "live_ready" ? 201 : 202);
}
