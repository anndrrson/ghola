import {
  cancelTreasuryPartnerRefs,
  type TreasuryPartnerReconciliationV1,
} from "@/lib/treasury-execution";
import {
  getTreasuryIntentRecord,
  recordTreasuryReconciliation,
} from "@/lib/treasury-execution-store";
import {
  agentForRequest,
  json,
  treasuryAdaptersForEnv,
  treasuryExecutionEnv,
  treasuryStatus,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);

  const status = treasuryStatus();
  if (!status.ready) {
    return json(
      {
        error: "treasury cancellation unavailable",
        blocking_reasons: status.blocking_reasons,
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const intentId = treasuryIntentIdFromBody(body);
  if (!intentId) return json({ error: "intent_id is required" }, 400);

  const record = await getTreasuryIntentRecord(intentId);
  if (!record) return json({ error: "treasury intent not found" }, 404);
  if (record.receipt?.agent_id && record.receipt.agent_id !== agent.agent_id) {
    return json({ error: "treasury intent not found" }, 404);
  }
  if (record.partner_submissions.length === 0) {
    return json({ error: "treasury intent has no partner submissions" }, 409);
  }

  const env = treasuryExecutionEnv();
  let reconciliations: TreasuryPartnerReconciliationV1[];
  try {
    reconciliations = await cancelTreasuryPartnerRefs({
      submissions: record.partner_submissions,
      providerId: env.providerId,
      adapters: treasuryAdaptersForEnv(env),
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "treasury partner cancellation failed",
      },
      502,
    );
  }

  const updated = await recordTreasuryReconciliation({
    intentId,
    reconciliations,
  });

  return json({
    version: 1,
    ok: true,
    intent_id: intentId,
    reconciliation_state: updated.state,
    reconciliations,
    partner_refs: updated.partner_refs,
  });
}

function treasuryIntentIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value.version !== 1) return null;
  return typeof value.intent_id === "string" && value.intent_id.trim()
    ? value.intent_id
    : null;
}
