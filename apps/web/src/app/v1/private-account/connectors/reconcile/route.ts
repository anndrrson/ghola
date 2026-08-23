import {
  connectorReconcileFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";
import { emitOperationalAlert } from "@/lib/operations-alert";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startedAt = Date.now();
  const correlationId = req.headers.get("x-ghola-correlation-id") || "missing";
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const reconciled = await connectorReconcileFromBody(guarded.body, guarded.owner);
  const durationMs = Date.now() - startedAt;
  if ("error" in reconciled) {
    console.warn(JSON.stringify({
      level: "warning",
      message: "private_account_reconcile_failed",
      correlation_id: correlationId,
      error_code: reconciled.error,
      duration_ms: durationMs,
    }));
    await emitOperationalAlert({
      code: reconciled.error || "connector_reconcile_failed",
      route: "/v1/private-account/connectors/reconcile",
      severity: "warning",
      correlation_id: correlationId,
      duration_ms: durationMs,
    });
    return withTrace(json({ error: reconciled.error, correlation_id: correlationId }, 400), correlationId, durationMs);
  }
  console.info(JSON.stringify({
    level: "info",
    message: "private_account_reconcile_completed",
    correlation_id: correlationId,
    status: reconciled.connector_result.status,
    reason: reconciled.connector_result.reason,
    duration_ms: durationMs,
  }));
  if (["ambiguous", "failed"].includes(reconciled.connector_result.status)) {
    await emitOperationalAlert({
      code: `connector_reconcile_${reconciled.connector_result.status}`,
      route: "/v1/private-account/connectors/reconcile",
      severity: "critical",
      correlation_id: correlationId,
      duration_ms: durationMs,
    });
  }
  return withTrace(json(reconciled), correlationId, durationMs);
}

function withTrace(response: Response, correlationId: string, durationMs: number): Response {
  response.headers.set("x-ghola-correlation-id", correlationId);
  response.headers.set("server-timing", `ghola-reconcile;dur=${durationMs}`);
  return response;
}
