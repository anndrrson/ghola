import { NextRequest } from "next/server";
import { proxyBillingRequest } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyBillingRequest(req, "/api/billing/access-passes/redeem", "POST");
}
