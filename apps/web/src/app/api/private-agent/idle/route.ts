import { NextRequest, NextResponse } from "next/server";
import { stopIdlePhalaPrivateAgent } from "@/lib/private-agent-phala";
import { hasActiveConsumerExposure } from "@/lib/consumer-production-store";
import { hasActiveCrossVenueExposure } from "@/lib/cross-venue-execution-store";
import { privateAgentCronAuthorized } from "@/lib/private-agent-cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function run(req: NextRequest) {
  if (!privateAgentCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const activeExposure = await Promise.all([
    hasActiveConsumerExposure(),
    hasActiveCrossVenueExposure(),
  ]).then((checks) => checks.some(Boolean));
  if (activeExposure) {
    return NextResponse.json({
      version: 1,
      provider_id: "phala",
      idle: {
        stopped: false,
        reason: "active_consumer_exposure_or_reconciliation",
      },
    }, { headers: { "cache-control": "no-store" } });
  }
  const result = await stopIdlePhalaPrivateAgent();
  return NextResponse.json(
    {
      version: 1,
      provider_id: "phala",
      idle: result,
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
