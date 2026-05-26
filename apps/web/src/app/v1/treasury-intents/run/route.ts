import {
  simulateTreasuryIntent,
  validateTreasurySimulationRequest,
  type TreasuryExecuteRequestV1,
} from "@/lib/treasury-execution";
import {
  recordTreasuryExecution,
  recordTreasurySimulation,
} from "@/lib/treasury-execution-store";
import {
  agentForRequest,
  buildReceiptForRequest,
  json,
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
        error: "treasury execution unavailable",
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

  const validation = validateTreasurySimulationRequest(body);
  if (!validation.ok || !validation.policy || !validation.intent) {
    return json({ error: validation.error ?? "invalid treasury intent" }, 400);
  }

  const simulation = simulateTreasuryIntent({
    policy: validation.policy,
    intent: validation.intent,
  });
  await recordTreasurySimulation(simulation);

  if (!simulation.ok) {
    return json({
      version: 1,
      ok: false,
      action: "blocked",
      simulation,
    });
  }

  if (simulation.proposal.approval_required) {
    return json(
      {
        version: 1,
        ok: false,
        action: "approval_required",
        approval: simulation.approval,
        simulation,
      },
      409,
    );
  }

  if (isObject(body) && body.execute === false) {
    return json({
      version: 1,
      ok: true,
      action: "simulated",
      simulation,
    });
  }

  if (!simulation.approval) {
    return json({ error: "treasury approval could not be derived" }, 500);
  }

  const executeRequest: TreasuryExecuteRequestV1 = {
    version: 1,
    intent_id: validation.intent.intent_id,
    owner_did: validation.intent.owner_did,
    policy_hash: simulation.policy_hash,
    proposal_hash: simulation.proposal_hash,
    approval_hash: simulation.approval.approval_hash,
    approval_expires_at: simulation.approval.expires_at,
    amount_micro_usd: simulation.proposal.amount_micro_usd,
    rails: uniqueRails(simulation.proposal.routes.map((route) => route.rail)),
    encrypted_context_bundle: validation.intent.encrypted_context_bundle,
  };

  const result = await buildReceiptForRequest({
    request: executeRequest,
    agent,
  });
  if (!result.ok || !("receipt" in result)) {
    return json({ error: result.error ?? "invalid treasury execution request" }, 400);
  }

  const record = await recordTreasuryExecution({
    receipt: result.receipt,
    submissions: result.submissions,
  });

  return json(
    {
      version: 1,
      ok: true,
      action: "executed",
      simulation,
      receipt: result.receipt,
      reconciliation_state: record.state,
      partner_refs: record.partner_refs,
    },
    201,
  );
}

function uniqueRails<T extends string>(rails: T[]): T[] {
  return Array.from(new Set(rails));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
