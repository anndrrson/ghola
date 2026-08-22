import { submitPublicLivePhoenixOrder } from "@/lib/private-account-public-live";
import {
  markGholaBalancePublicPhoenixOrderSubmitted,
  releaseGholaBalanceReservationAfterFailedPublicPhoenixSubmit,
  reserveGholaBalanceForPublicPhoenixSubmit,
} from "../../../_lib";
import {
  preparePublicLivePhoenixAccess,
  publicLiveJson,
  publicLivePhoenixOwnerFromBody,
  publicLivePhoenixNoKeyConfig,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return publicLiveJson({ error: "json_body_required" }, 400);
  }
  const owner = await publicLivePhoenixOwnerFromBody(body, { req: request });
  if (!owner.ok) return owner.response;

  const prepared = await preparePublicLivePhoenixAccess({
    body: body as Record<string, unknown>,
    owner: owner.owner,
    req: request,
  });
  if ("error" in prepared) return publicLiveJson({ error: prepared.error }, 400);
  const allocationCommitment = prepared.allocation.pooled_allocation?.pooled_allocation_commitment;
  if (!allocationCommitment) {
    return publicLiveJson({ error: "pooled_allocation_not_ready" }, 400);
  }
  if (!prepared.can_submit_live) {
    return publicLiveJson({
      error: prepared.blocking_reason_codes[0] || "public_live_submit_not_ready",
      blocking_reason_codes: prepared.blocking_reason_codes,
      required_margin_micro_usdc: prepared.required_margin_micro_usdc,
      balance: prepared.balance,
    }, 400);
  }
  const workOrderCommitment = typeof body.work_order_commitment === "string"
    ? body.work_order_commitment.trim()
    : "";
  if (!workOrderCommitment) {
    return publicLiveJson({ error: "work_order_commitment_required" }, 400);
  }
  const balanceConfig = publicLivePhoenixNoKeyConfig();
  const reservation = balanceConfig.require_balance
    ? await reserveGholaBalanceForPublicPhoenixSubmit({
        owner: owner.owner,
        account_commitment: prepared.account_commitment,
        work_order_commitment: workOrderCommitment,
        amount_bucket: "5",
      })
    : null;
  if (reservation && !reservation.ok) {
    return publicLiveJson({
      error: reservation.error,
      required_margin_micro_usdc: reservation.required_margin_micro_usdc,
      balance: prepared.balance,
    }, reservation.error === "public_live_submit_in_progress" ? 409 : 400);
  }
  const submitted = await submitPublicLivePhoenixOrder({
    body,
    allocation_commitment: allocationCommitment,
    policy_commitment: prepared.agent.session_policy?.policy_commitment,
  });
  if ("error" in submitted) {
    if (reservation?.ok) {
      await releaseGholaBalanceReservationAfterFailedPublicPhoenixSubmit({
        owner: owner.owner,
        account_commitment: prepared.account_commitment,
        work_order_commitment: workOrderCommitment,
        reservation: reservation.reservation,
        reason: `public_live_phoenix_submit_failed:${submitted.error}`,
      });
    }
    const status = typeof submitted.status === "number" ? submitted.status : 400;
    return publicLiveJson({
      error: submitted.error,
      worker_body: "worker_body" in submitted ? submitted.worker_body : undefined,
    }, status);
  }
  const submittedEntry = reservation?.ok
    ? await markGholaBalancePublicPhoenixOrderSubmitted({
        owner: owner.owner,
        account_commitment: prepared.account_commitment,
        work_order_commitment: workOrderCommitment,
        reservation: reservation.reservation,
      })
    : null;
  return publicLiveJson({
    ...submitted,
    wallet_proof: owner.proof,
    account_commitment: prepared.account_commitment,
    balance_reservation_commitment: reservation?.ok ? reservation.reservation.ledger_entry_id : null,
    balance_order_commitment: submittedEntry?.ledger_entry_id ?? null,
    next_status: "pending_reconciliation",
    live_access: {
      venue_id: prepared.venue_id,
      execution_mode: prepared.execution_mode,
      eligibility_commitment: prepared.eligibility.eligibility.eligibility_commitment,
      allocation_commitment: allocationCommitment,
      policy_commitment: prepared.agent.session_policy?.policy_commitment,
      live_limits: prepared.live_limits,
    },
  }, 202);
}
