import {
  publicLivePhoenixRevenueGuard,
  submitPublicLivePhoenixOrder,
} from "@/lib/private-account-public-live";
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
  const owner = await publicLivePhoenixOwnerFromBody(body);
  if (!owner.ok) return owner.response;
  const revenueGuard = publicLivePhoenixRevenueGuard();
  if (!revenueGuard.ok) {
    return publicLiveJson({
      error: revenueGuard.error,
      entitlement_required: revenueGuard.entitlement_required,
    }, revenueGuard.status);
  }

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
  const submitted = await submitPublicLivePhoenixOrder({
    body,
    allocation_commitment: allocationCommitment,
    policy_commitment: prepared.agent.session_policy?.policy_commitment,
  });
  if ("error" in submitted) {
    const status = typeof submitted.status === "number" ? submitted.status : 400;
    return publicLiveJson({
      error: submitted.error,
      worker_body: "worker_body" in submitted ? submitted.worker_body : undefined,
    }, status);
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
  }, 202);
}
