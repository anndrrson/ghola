import {
  anonymityEvidenceFromBody,
  internalUnauthorized,
  json,
  privateAccountInternalAuth,
  readJson,
  rejectForbiddenFields,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  const evidence = await anonymityEvidenceFromBody(body);
  if ("error" in evidence) return json({ error: evidence.error }, 400);
  return json(evidence, 201);
}
