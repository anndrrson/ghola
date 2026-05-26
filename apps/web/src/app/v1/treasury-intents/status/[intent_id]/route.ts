import { json, treasuryStatus } from "../../_lib";
import { getTreasuryIntentRecord } from "@/lib/treasury-execution-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ intent_id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { intent_id } = await params;
  const status = treasuryStatus();
  const record = await getTreasuryIntentRecord(intent_id);
  if (record) {
    return json({
      version: 1,
      intent_id,
      ready: status.ready,
      reconciliation_state: record.state,
      policy_hash: record.policy_hash,
      proposal_hash: record.proposal_hash,
      approval_hash: record.approval?.approval_hash ?? record.receipt?.approval_hash ?? null,
      receipt_id: record.receipt?.receipt_id ?? null,
      partner_refs: record.partner_refs,
      partner_reconciliations: record.partner_reconciliations,
      blocking_reasons: [...status.blocking_reasons, ...record.blocking_reasons],
      updated_at: record.updated_at,
    });
  }
  return json({
    version: 1,
    intent_id,
    ready: status.ready,
    reconciliation_state: "not_found",
    partner_refs: [],
    partner_reconciliations: [],
    blocking_reasons: status.blocking_reasons,
  });
}
