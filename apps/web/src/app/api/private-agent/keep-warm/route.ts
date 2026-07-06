import { NextRequest, NextResponse } from "next/server";
import { keepPrivateAgentWarmForActiveSessions } from "@/lib/private-agent-phala";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function bearer(req: NextRequest): string | null {
  const value = req.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
}

function bearerAuthorized(req: NextRequest): boolean {
  const token = bearer(req);
  const idleCronSecret = process.env.GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET?.trim();
  if (idleCronSecret && token === idleCronSecret) return true;
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && token === cronSecret) return true;
  const provisionToken = process.env.GHOLA_PRIVATE_AGENT_PROVISION_TOKEN?.trim();
  if (provisionToken && token === provisionToken) return true;
  const internalToken = process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN?.trim();
  if (internalToken && (token === internalToken || req.headers.get("x-ghola-internal-token") === internalToken)) {
    return true;
  }
  return false;
}

function authorized(req: NextRequest): boolean {
  if (bearerAuthorized(req)) return true;
  return req.headers.get("x-vercel-cron") === "1";
}

async function run(req: NextRequest) {
  if (!authorized(req)) {
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

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
