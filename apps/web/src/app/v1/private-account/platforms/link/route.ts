import { gholaCommitment } from "@/lib/private-account";
import { json, readJson, rejectForbiddenFields } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  return json({
    version: 1,
    platform_link_commitment: gholaCommitment("plink", body || "platform-link"),
    status: "commitment_recorded",
  }, 201);
}
