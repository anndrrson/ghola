import { NextResponse } from "next/server";
import { privateAccountLaunchStatus } from "@/lib/private-account-launch-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const status = await privateAccountLaunchStatus();
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
