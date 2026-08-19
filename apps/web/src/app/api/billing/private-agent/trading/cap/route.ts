import { NextRequest } from "next/server";
import { proxyBillingRequest } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  return proxyBillingRequest(req, "/api/billing/private-agent/trading/cap", "PATCH");
}
