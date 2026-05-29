import { NextResponse } from "next/server";
import { enterpriseGateStatus } from "@/lib/enterprise-gate-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(enterpriseGateStatus(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
