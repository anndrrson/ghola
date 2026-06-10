import {
  json,
  internalUnauthorized,
  privateAccountInternalAuth,
  readJson,
  rejectForbiddenFields,
  updateVaultReadinessFromBody,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  const updated = await updateVaultReadinessFromBody(body);
  if ("error" in updated) return json({ error: updated.error }, 400);
  return json(updated);
}
