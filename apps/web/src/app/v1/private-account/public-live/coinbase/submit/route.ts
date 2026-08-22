import { submitPublicLiveCoinbaseOrder } from "@/lib/private-account-public-live";
import {
  markGholaBalancePublicVenueOrderSubmitted,
  releaseGholaBalanceReservationAfterFailedPublicVenueSubmit,
  reserveGholaBalanceForPublicVenueSubmit,
} from "../../../_lib";
import {
  preparePublicLiveCoinbaseAccess,
  publicLiveCoinbaseOwnerFromRequest,
  publicLiveJson,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return publicLiveJson({ error: "json_body_required" }, 400);
  }
  const owner = await publicLiveCoinbaseOwnerFromRequest(request);
  if (!owner.ok) return owner.response;

  const prepared = await preparePublicLiveCoinbaseAccess({
    body: body as Record<string, unknown>,
    owner: owner.owner,
    req: request,
  });
  if ("error" in prepared) return publicLiveJson({ error: prepared.error }, 400);
  const allocation = prepared.allocation.allocation;
  const allocationCommitment = allocation?.allocation_commitment;
  if (!allocationCommitment || !allocation) {
    return publicLiveJson({ error: "coinbase_omnibus_allocation_not_ready" }, 400);
  }
  if (!prepared.can_submit_live) {
    return publicLiveJson({
      error: prepared.blocking_reason_codes[0] || "public_live_submit_not_ready",
      blocking_reason_codes: prepared.blocking_reason_codes,
      required_margin_micro_usdc: prepared.required_margin_micro_usdc,
      balance: prepared.balance,
    }, 400);
  }
  const workOrderCommitment = typeof (body as Record<string, unknown>).work_order_commitment === "string"
    ? String((body as Record<string, unknown>).work_order_commitment).trim()
    : "";
  if (!workOrderCommitment) {
    return publicLiveJson({ error: "work_order_commitment_required" }, 400);
  }
  const reservation = await reserveGholaBalanceForPublicVenueSubmit({
    owner: owner.owner,
    account_commitment: prepared.account_commitment,
    work_order_commitment: workOrderCommitment,
    venue_id: "coinbase_advanced",
    amount_bucket: prepared.live_limits.max_notional_bucket,
  });
  if (!reservation.ok) {
    return publicLiveJson({
      error: reservation.error,
      required_margin_micro_usdc: reservation.required_margin_micro_usdc,
      balance: prepared.balance,
    }, reservation.error === "public_live_submit_in_progress" ? 409 : 400);
  }
  const submitted = await submitPublicLiveCoinbaseOrder({
    body,
    allocation_commitment: allocationCommitment,
    omnibus_allocation: allocation,
    policy_commitment: prepared.agent.session_policy?.policy_commitment,
  });
  if ("error" in submitted) {
    await releaseGholaBalanceReservationAfterFailedPublicVenueSubmit({
      owner: owner.owner,
      account_commitment: prepared.account_commitment,
      work_order_commitment: workOrderCommitment,
      venue_id: "coinbase_advanced",
      reservation: reservation.reservation,
      reason: `public_live_coinbase_submit_failed:${submitted.error}`,
    });
    const status = typeof submitted.status === "number" ? submitted.status : 400;
    return publicLiveJson({
      error: submitted.error,
      worker_body: "worker_body" in submitted ? submitted.worker_body : undefined,
    }, status);
  }
  const submittedEntry = await markGholaBalancePublicVenueOrderSubmitted({
    owner: owner.owner,
    account_commitment: prepared.account_commitment,
    work_order_commitment: workOrderCommitment,
    venue_id: "coinbase_advanced",
    reservation: reservation.reservation,
  });
  return publicLiveJson({
    ...submitted,
    account_commitment: prepared.account_commitment,
    balance_reservation_commitment: reservation.reservation.ledger_entry_id,
    balance_order_commitment: submittedEntry.ledger_entry_id,
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
