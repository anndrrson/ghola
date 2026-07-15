import {
  publicLivePhoenixRevenueGuard,
  submitPublicLivePhoenixOrder,
} from "@/lib/private-account-public-live";
import { consumerCommitment, consumerFeeMicroUsdc, consumerRolloutEligible } from "@/lib/consumer-production";
import {
  getConsumerCircuitState,
  getConsumerRiskPolicy,
  haltConsumerCircuit,
  markConsumerReservationSubmitted,
  recordConsumerVenueOrder,
  releaseConsumerReservation,
  reserveConsumerBalance,
} from "@/lib/consumer-production-store";
import {
  preparePublicLivePhoenixAccess,
  publicLiveJson,
  publicLivePhoenixOwnerFromBody,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return publicLiveJson({ error: "json_body_required" }, 400);
  }
  const owner = await publicLivePhoenixOwnerFromBody(body, { request, consumeNonce: true });
  if (!owner.ok) return owner.response;
  const rollout = consumerRolloutEligible(owner.owner.owner_commitment);
  if (!rollout.eligible) {
    return publicLiveJson({ error: "consumer_live_trading_not_in_rollout", rollout_percent: rollout.rollout_percent }, 403);
  }
  const circuit = await getConsumerCircuitState();
  if (circuit.status !== "open") {
    return publicLiveJson({ error: "consumer_trading_halted", reason_codes: circuit.reasons }, 503);
  }
  const revenueGuard = publicLivePhoenixRevenueGuard();
  if (!revenueGuard.ok) {
    return publicLiveJson({
      error: revenueGuard.error,
      entitlement_required: revenueGuard.entitlement_required,
    }, revenueGuard.status);
  }

  const declaredNotional = Number((body as Record<string, unknown>).declared_notional_micro_usdc);
  const declaredSlippage = Number((body as Record<string, unknown>).declared_max_slippage_bps);
  const declaredMarket = String((body as Record<string, unknown>).declared_market || "").trim().toUpperCase();
  const declaredSide = String((body as Record<string, unknown>).declared_side || "").trim().toLowerCase();
  if (!Number.isSafeInteger(declaredNotional) || declaredNotional <= 0) {
    return publicLiveJson({ error: "declared_notional_micro_usdc_required" }, 400);
  }
  if (!Number.isInteger(declaredSlippage) || declaredSlippage < 1 || declaredSlippage > 100) {
    return publicLiveJson({ error: "declared_max_slippage_bps_invalid" }, 400);
  }
  if (!declaredMarket) return publicLiveJson({ error: "declared_market_required" }, 400);
  if (declaredSide !== "buy") return publicLiveJson({ error: "pooled_phoenix_sell_not_supported_without_asset_subledger" }, 400);
  const risk = await getConsumerRiskPolicy(owner.owner.owner_commitment);
  if (!risk) return publicLiveJson({ error: "consumer_risk_policy_required" }, 403);
  if (declaredNotional > risk.max_order_micro_usdc) {
    return publicLiveJson({ error: "consumer_order_limit_exceeded" }, 400);
  }
  if (declaredSlippage > risk.max_slippage_bps) {
    return publicLiveJson({ error: "consumer_slippage_limit_exceeded" }, 400);
  }
  if (!risk.market_allowlist.includes(declaredMarket)) {
    return publicLiveJson({ error: "consumer_market_not_allowed" }, 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || String((body as Record<string, unknown>).work_order_commitment || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
    return publicLiveJson({ error: "idempotency_key_required" }, 400);
  }
  const reservation = await reserveConsumerBalance({
    owner_commitment: owner.owner.owner_commitment,
    account_commitment: risk.account_commitment,
    idempotency_key: idempotencyKey,
    venue_id: "phoenix",
    notional_micro_usdc: declaredNotional,
    fee_micro_usdc: consumerFeeMicroUsdc(declaredNotional),
    venue_cost_reserve_micro_usdc: Math.ceil(declaredNotional * consumerVenueCostReserveBps() / 10_000),
    max_daily_notional_micro_usdc: risk.max_daily_notional_micro_usdc,
    max_position_micro_usdc: risk.max_position_micro_usdc,
  });
  if (!reservation.ok) return publicLiveJson({ error: reservation.error }, reservation.error === "insufficient_available_balance" ? 402 : 409);

  const prepared = await preparePublicLivePhoenixAccess({
    body: body as Record<string, unknown>,
    owner: owner.owner,
    req: request,
  });
  if ("error" in prepared) {
    await releaseConsumerReservation({ reservation_id: reservation.reservation.reservation_id, owner_commitment: owner.owner.owner_commitment, reason: prepared.error });
    return publicLiveJson({ error: prepared.error }, 400);
  }
  const allocationCommitment = prepared.allocation.pooled_allocation?.pooled_allocation_commitment;
  if (!allocationCommitment) {
    await releaseConsumerReservation({ reservation_id: reservation.reservation.reservation_id, owner_commitment: owner.owner.owner_commitment, reason: "pooled_allocation_not_ready" });
    return publicLiveJson({ error: "pooled_allocation_not_ready" }, 400);
  }
  const submitted = await submitPublicLivePhoenixOrder({
    body,
    allocation_commitment: allocationCommitment,
    policy_commitment: prepared.agent.session_policy?.policy_commitment,
    reconciliation_context: {
      venue_order_id: consumerCommitment("venue_order", reservation.reservation.reservation_id),
      reservation_id: reservation.reservation.reservation_id,
      deadline_ms: 60_000,
    },
  });
  if ("error" in submitted) {
    await releaseConsumerReservation({ reservation_id: reservation.reservation.reservation_id, owner_commitment: owner.owner.owner_commitment, reason: submitted.error || "private_agent_worker_submit_failed" });
    const status = typeof submitted.status === "number" ? submitted.status : 400;
    return publicLiveJson({
      error: submitted.error,
      worker_body: "worker_body" in submitted ? submitted.worker_body : undefined,
    }, status);
  }
  const markedSubmitted = await markConsumerReservationSubmitted({
    reservation_id: reservation.reservation.reservation_id,
    owner_commitment: owner.owner.owner_commitment,
  });
  if (!markedSubmitted) {
    await haltConsumerCircuit({ reasons: ["nonce_or_idempotency_violation"], acknowledged_by: "system:reservation_submission_state_conflict" });
    return publicLiveJson({ error: "reservation_submission_state_conflict" }, 409);
  }
  const venueOrder = await recordConsumerVenueOrder({
    reservation_id: reservation.reservation.reservation_id,
    owner_commitment: owner.owner.owner_commitment,
    market: declaredMarket,
    work_order_commitment: String((body as Record<string, unknown>).work_order_commitment),
    worker_receipt: submitted.worker_receipt,
  });
  if (!venueOrder) {
    await haltConsumerCircuit({ reasons: ["nonce_or_idempotency_violation"], acknowledged_by: "system:venue_order_record_failed" });
    return publicLiveJson({ error: "venue_order_record_failed" }, 503);
  }
  return publicLiveJson({
    ...submitted,
    wallet_proof: owner.proof,
    account_commitment: prepared.account_commitment,
    live_access: {
      venue_id: prepared.venue_id,
      execution_mode: prepared.execution_mode,
      eligibility_commitment: prepared.eligibility.eligibility.eligibility_commitment,
      allocation_commitment: allocationCommitment,
      policy_commitment: prepared.agent.session_policy?.policy_commitment,
      live_limits: prepared.live_limits,
    },
    balance_reservation: {
      reservation_id: reservation.reservation.reservation_id,
      status: "submitted_pending_reconciliation",
      expires_at: reservation.reservation.expires_at,
    },
    venue_order: {
      venue_order_id: venueOrder.venue_order_id,
      status: venueOrder.status,
      reconciliation_due_at: new Date(new Date(venueOrder.submitted_at).getTime() + 60_000).toISOString(),
    },
  }, 202);
}

function consumerVenueCostReserveBps() {
  const parsed = Number.parseInt(process.env.GHOLA_CONSUMER_PHOENIX_VENUE_COST_RESERVE_BPS || "20", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 20;
}
