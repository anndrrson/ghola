import {
  executeStoredActionFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startedAt = Date.now();
  const correlationId = req.headers.get("x-ghola-correlation-id") || "missing";
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const execution = await executeStoredActionFromBody(guarded.body, guarded.owner);
  const durationMs = Date.now() - startedAt;
  if ("error" in execution) {
    console.warn("[private-account-execute] failed", {
      correlation_id: correlationId,
      error_code: execution.error,
      duration_ms: durationMs,
    });
    return withTrace(json({
      error: execution.error,
      correlation_id: correlationId,
      retry_forbidden: execution.error === "connector_submit_ambiguous" || execution.error === "connector_submit_in_progress",
    }, 400), correlationId, durationMs);
  }
  console.info("[private-account-execute] completed", {
    correlation_id: correlationId,
    duration_ms: durationMs,
    receipt_commitment: execution.receipt.receipt_commitment,
  });
  return withTrace(json(execution, 201), correlationId, durationMs);
}

function withTrace(response: Response, correlationId: string, durationMs: number): Response {
  response.headers.set("x-ghola-correlation-id", correlationId);
  response.headers.set("server-timing", `ghola-execute;dur=${durationMs}`);
  return response;
}
