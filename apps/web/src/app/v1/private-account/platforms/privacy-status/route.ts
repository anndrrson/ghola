import { json, platformStatusBody, readJson, rejectForbiddenFields } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const status = platformStatusBody(body);
  if (!status) return json({ error: "valid platform_class is required" }, 400);
  return json(status);
}
