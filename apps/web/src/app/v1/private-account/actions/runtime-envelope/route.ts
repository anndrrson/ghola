import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  runtimeEnvelopeFromBody,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const envelope = await runtimeEnvelopeFromBody(body, owner);
  if ("error" in envelope) return json({ error: envelope.error }, 400);
  return json(envelope);
}
