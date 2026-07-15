import { NextResponse } from "next/server";
import { verifyInternalBearer } from "@/lib/internal-control-auth";
import { proxyConsumerWorker } from "@/lib/consumer-worker-control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_RECONCILIATION_INGEST_TOKEN")) {
    return NextResponse.json({ error: "reconciliation_ingest_auth_required" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "json_body_required" }, { status: 400 });
  const result = await proxyConsumerWorker({
    path: "/consumer/reconciliation",
    tokenEnv: "GHOLA_RECONCILIATION_INGEST_TOKEN",
    body,
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
