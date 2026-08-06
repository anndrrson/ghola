import { NextResponse } from "next/server";
import {
  buildPublicPrivateAgentDemoRun,
  type PublicPrivateAgentDemoRunRequest,
} from "@/lib/private-account-demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const run = await buildPublicPrivateAgentDemoRun();
  return NextResponse.json(run, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as PublicPrivateAgentDemoRunRequest;
  const run = await buildPublicPrivateAgentDemoRun(body);
  return NextResponse.json(run, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
