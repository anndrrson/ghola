import { NextRequest } from "next/server";
import { proxyBillingRequest } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyBillingRequest(req, "/api/billing/status", "GET");
}
