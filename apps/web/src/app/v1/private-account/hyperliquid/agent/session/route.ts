import {
  armHyperliquidAgentSessionFromBody,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../../../_lib";
import { privateAgentSpendPolicy } from "@/lib/private-agent-spend-policy";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const spendPolicy = privateAgentSpendPolicy("session");
  if (!spendPolicy.allowed && spendPolicy.environment !== "test") {
    return json({ error: "private_agent_remote_execution_disabled" }, 503);
  }
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const session = await armHyperliquidAgentSessionFromBody(body, owner);
  if ("error" in session) return json({ error: session.error }, 400);
  return json(session, 201);
}
