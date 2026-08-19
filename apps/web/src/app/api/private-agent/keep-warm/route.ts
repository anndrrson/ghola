import { NextRequest, NextResponse } from "next/server";
import { privateAgentCronAuthorized } from "@/lib/private-agent-cron-auth";
import { keepPrivateAgentWarmForActiveSessions } from "@/lib/private-agent-phala";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function run(req: NextRequest) {
  if (!privateAgentCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await keepPrivateAgentWarmForActiveSessions();
  return NextResponse.json(
    {
      version: 1,
      provider_id: "phala",
      keep_warm: result,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

export async function POST(req: NextRequest) {
  return run(req);
}
