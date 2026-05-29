import { json, leakageMapFromBody, readJson, rejectForbiddenFields } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const leakage = await leakageMapFromBody(body);
  if (!leakage) return json({ error: "valid preview_commitment or simulation input is required" }, 400);
  return json(leakage);
}
