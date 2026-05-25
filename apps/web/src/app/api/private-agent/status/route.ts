import { NextResponse } from "next/server";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getPrivateAgentRuntimeStatus();
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
