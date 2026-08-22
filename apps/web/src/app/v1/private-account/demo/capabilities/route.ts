import { NextResponse } from "next/server";
import { getPublicPrivateAgentDemoCapabilities } from "@/lib/private-account-demo";

export const dynamic = "force-dynamic";

export async function GET() {
  const capabilities = await getPublicPrivateAgentDemoCapabilities();
  return NextResponse.json(capabilities, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
