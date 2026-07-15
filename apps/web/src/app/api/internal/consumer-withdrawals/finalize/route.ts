import { NextResponse } from "next/server";
import { verifyInternalBearer } from "@/lib/internal-control-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_RECONCILIATION_INGEST_TOKEN")) {
    return NextResponse.json({ error: "withdrawal_finalization_auth_required" }, { status: 401 });
  }
  return NextResponse.json({
    error: "withdrawal_finalization_is_worker_owned",
    status: "automatic_finalized_solana_verification",
  }, { status: 409, headers: { "cache-control": "no-store" } });
}
