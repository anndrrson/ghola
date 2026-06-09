import { NextResponse } from "next/server";
import { shieldedPoolAdapterHealth } from "@/lib/private-account-shielded-pool-health-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await shieldedPoolAdapterHealth("prover");
  return NextResponse.json(result.body, { status: result.status });
}
