import {
  connectorSubmitFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";
import {
  evaluateLiveTradingJurisdiction,
  liveTradingJurisdictionErrorBody,
} from "@/lib/live-trading-jurisdiction.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const jurisdiction = evaluateLiveTradingJurisdiction(req);
  if (!jurisdiction.allowed) {
    return json(liveTradingJurisdictionErrorBody(jurisdiction), 451);
  }
  const submitted = await connectorSubmitFromBody(guarded.body, guarded.owner);
  if ("error" in submitted) return json({ error: submitted.error }, 400);
  return json(submitted, 201);
}
