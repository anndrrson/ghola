import {
  connectorReconcileFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startedAt = Date.now();
  const correlationId = req.headers.get("x-ghola-correlation-id") || "missing";
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const reconciled = await connectorReconcileFromBody(guarded.body, guarded.owner);
  const durationMs = Date.now() - startedAt;
  if ("error" in reconciled) {
    console.warn("[private-account-reconcile] failed", {
      correlation_id: correlationId,
      error_code: reconciled.error,
      duration_ms: durationMs,
    });
    return withTrace(json({ error: reconciled.error, correlation_id: correlationId }, 400), correlationId, durationMs);
  }
  console.info("[private-account-reconcile] completed", {
    correlation_id: correlationId,
    status: reconciled.connector_result.status,
    reason: reconciled.connector_result.reason,
    duration_ms: durationMs,
  });
  return withTrace(json(reconciled), correlationId, durationMs);
}

function withTrace(response: Response, correlationId: string, durationMs: number): Response {
  response.headers.set("x-ghola-correlation-id", correlationId);
  response.headers.set("server-timing", `ghola-reconcile;dur=${durationMs}`);
  return response;
}
