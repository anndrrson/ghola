import {
  preparePublicLivePhoenixAccess,
  publicLiveJson,
  publicLivePhoenixOwnerFromBody,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return publicLiveJson({ error: "json_body_required" }, 400);
  }
  const owner = await publicLivePhoenixOwnerFromBody(body);
  if (!owner.ok) return owner.response;

  const prepared = await preparePublicLivePhoenixAccess({
    body: body as Record<string, unknown>,
    owner: owner.owner,
    req: request,
  });
  if ("error" in prepared) return publicLiveJson({ error: prepared.error }, 400);
  return publicLiveJson({
    ...prepared,
    wallet_proof: owner.proof,
  }, prepared.status === "live_ready" ? 201 : 202);
}
