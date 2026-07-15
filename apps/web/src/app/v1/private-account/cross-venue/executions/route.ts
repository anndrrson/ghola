import { createCrossVenueExecutionPlan, type CrossVenueId, type CrossVenueRiskBudget } from "@/lib/cross-venue-execution";
import {
  applyStoredCrossVenueWorkerReport,
  createStoredCrossVenueExecution,
  listStoredCrossVenueExecutions,
  markCrossVenueExecutionSubmitting,
} from "@/lib/cross-venue-execution-store";
import { probeCrossVenueExecutionReadiness, submitCrossVenueExecution } from "@/lib/cross-venue-worker";
import { getConsumerCircuitState, haltConsumerCircuit } from "@/lib/consumer-production-store";
import { getTriVenueMarketBundle } from "@/lib/private-account-tri-venue-arb";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../_lib";
import { triVenueLiveGuard } from "../../arb/tri-venue/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  return json({
    version: 1,
    executions: await listStoredCrossVenueExecutions({ owner_commitment: owner.owner_commitment }),
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const readiness = await probeCrossVenueExecutionReadiness();
  if (!readiness.ready) return json({ error: "cross_venue_execution_not_ready", readiness }, 409);
  const guarded = await triVenueLiveGuard(request);
  if (!guarded.ok) return guarded.response;
  const circuit = await getConsumerCircuitState();
  if (circuit.status !== "open") return json({ error: "consumer_trading_halted", reason_codes: circuit.reasons }, 503);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) return json({ error: "idempotency_key_required" }, 400);
  const body = guarded.body;
  const opportunityCommitment = stringValue(body.opportunity_commitment);
  const requestedNotional = Number(body.matched_notional_micro_usdc);
  if (!opportunityCommitment) return json({ error: "opportunity_commitment_required" }, 400);
  if (!Number.isSafeInteger(requestedNotional) || requestedNotional < 1_000_000 || requestedNotional > 5_000_000) {
    return json({ error: "matched_notional_outside_initial_1_to_5_usdc_cap" }, 400);
  }
  const bundle = await getTriVenueMarketBundle();
  const opportunity = bundle.opportunities.find((item) => item.commitment === opportunityCommitment);
  if (!opportunity || opportunity.status !== "preflight_pass" || !opportunity.leg_plan || opportunity.leg_plan.length !== 2) {
    return json({ error: "fresh_preflight_opportunity_required" }, 409);
  }
  try {
    const plan = createCrossVenueExecutionPlan({
      owner_commitment: guarded.owner.owner_commitment,
      idempotency_key: idempotencyKey,
      opportunity_commitment: opportunity.commitment,
      market: opportunity.market,
      matched_notional_micro_usdc: requestedNotional,
      risk_budget: riskBudget(body.risk_budget, requestedNotional),
      legs: opportunity.leg_plan.map((leg) => ({
        venue_id: leg.venue_id as CrossVenueId,
        side: leg.side,
        symbol: leg.symbol,
        limit_price: leg.price,
      })),
    });
    const stored = await createStoredCrossVenueExecution(plan);
    if (stored.disposition === "conflict") return json({ error: "idempotency_key_payload_conflict" }, 409);
    if (stored.disposition === "replayed") return json({ version: 1, replayed: true, execution: stored.plan }, 200);
    await markCrossVenueExecutionSubmitting({ execution_id: plan.execution_id, owner_commitment: plan.owner_commitment });
    const accepted = await applyStoredCrossVenueWorkerReport({
      execution_id: plan.execution_id,
      owner_commitment: plan.owner_commitment,
      report: {
        sequence: 1,
        phase: "accepted",
        legs: plan.legs.map((leg) => ({ leg_id: leg.leg_id, status: "pending", filled_notional_micro_usdc: 0 })),
        observed_at: new Date().toISOString(),
      },
    });
    if (!accepted.ok) {
      await haltConsumerCircuit({ reasons: ["nonce_or_idempotency_violation"], acknowledged_by: "system:cross_venue_accept_state_conflict" });
      return json({ error: "cross_venue_accept_state_conflict" }, 503);
    }
    const submitted = await submitCrossVenueExecution({ plan });
    if (!submitted.ok) {
      const failed = await applyStoredCrossVenueWorkerReport({
        execution_id: plan.execution_id,
        owner_commitment: plan.owner_commitment,
        report: {
          sequence: 2,
          phase: "failed",
          legs: [],
          failure_code: submitted.error,
          observed_at: new Date().toISOString(),
        },
      });
      return json({ error: submitted.error, execution: failed.ok ? failed.plan : accepted.plan }, submitted.status >= 500 ? 503 : 409);
    }
    await markCrossVenueExecutionSubmitting({
      execution_id: plan.execution_id,
      owner_commitment: plan.owner_commitment,
      worker_receipt: submitted.worker_receipt,
    });
    return json({ version: 1, access_mode: guarded.access_mode, execution: accepted.plan }, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "cross_venue_plan_invalid" }, 400);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function riskBudget(value: unknown, notional: number): CrossVenueRiskBudget {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    max_unhedged_notional_micro_usdc: numberValue(input.max_unhedged_notional_micro_usdc, Math.min(notional, 500_000)),
    max_hedge_slippage_bps: numberValue(input.max_hedge_slippage_bps, 25),
    max_hedge_duration_ms: numberValue(input.max_hedge_duration_ms, 5_000),
    max_unwind_loss_micro_usdc: numberValue(input.max_unwind_loss_micro_usdc, 250_000),
    max_daily_loss_micro_usdc: numberValue(input.max_daily_loss_micro_usdc, notional),
  };
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
