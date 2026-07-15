import { NextResponse } from "next/server";
import { applyStoredCrossVenueWorkerReport } from "@/lib/cross-venue-execution-store";
import type { CrossVenueWorkerReport } from "@/lib/cross-venue-execution";
import { haltConsumerCircuit } from "@/lib/consumer-production-store";
import { verifyInternalBearer } from "@/lib/internal-control-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_RECONCILIATION_INGEST_TOKEN")) {
    return NextResponse.json({ error: "reconciliation_ingest_auth_required" }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const executionId = typeof body?.execution_id === "string" ? body.execution_id : "";
  const ownerCommitment = typeof body?.owner_commitment === "string" ? body.owner_commitment : "";
  const report = body?.report as CrossVenueWorkerReport | undefined;
  if (!executionId || !ownerCommitment || !report) return NextResponse.json({ error: "execution_report_required" }, { status: 400 });
  const result = await applyStoredCrossVenueWorkerReport({ execution_id: executionId, owner_commitment: ownerCommitment, report });
  if (!result.ok) {
    if (["report_sequence_replay", "report_sequence_conflict", "filled_notional_regression", "filled_notional_exceeds_target"].includes(result.error)) {
      await haltConsumerCircuit({ reasons: ["nonce_or_idempotency_violation"], acknowledged_by: `system:cross_venue:${result.error}` });
    }
    return NextResponse.json({ error: result.error }, { status: result.error === "cross_venue_execution_not_found" ? 404 : 409 });
  }
  if (result.plan.status === "manual_intervention_required") {
    await haltConsumerCircuit({ reasons: ["cross_venue_unhedged_exposure"], acknowledged_by: `system:cross_venue:${result.plan.failure_code || "manual"}` });
  }
  return NextResponse.json({ version: 1, execution: result.plan }, { status: 200, headers: { "cache-control": "no-store" } });
}
