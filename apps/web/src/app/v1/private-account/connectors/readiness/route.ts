import {
  connectorReadinessBody,
  json,
  readJson,
  rejectForbiddenFields,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  return json(await connectorReadinessBody(body));
}
