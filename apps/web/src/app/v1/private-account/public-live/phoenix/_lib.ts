import type { PrivateAccountRequestOwner } from "../../_lib";
import {
  allocatePooledVenueFromBody,
  armVenueAgentSessionFromBody,
  createOrGetStoredPrivateAccount,
  json,
  preflightVenueTradeFromBody,
  privateAccountOwnerFromRequest,
  verifyVenueEligibilityFromBody,
} from "../../_lib";
import {
  publicLiveOwnerCommitment,
  publicLiveWalletCommitment,
  verifyPublicLiveWalletProof,
  type PublicLiveWalletProofInput,
} from "@/lib/private-account-public-live";
import {
  CONSUMER_RISK_VERSION,
  CONSUMER_TERMS_VERSION,
} from "@/lib/consumer-production";
import {
  consumeConsumerNonce,
  getConsumerEligibilityAcceptance,
  getConsumerWalletBinding,
} from "@/lib/consumer-production-store";

export type PublicLivePhoenixPreparedAccess = {
  version: 1;
  status: "live_ready" | "funding_required";
  account_commitment: string;
  venue_id: "phoenix";
  platform_class: "solana_perps_market";
  execution_mode: "ghola_pooled";
  eligibility: {
    eligibility: {
      eligibility_commitment: string;
    };
  };
  allocation: {
    pooled_allocation?: {
      pooled_allocation_commitment?: string;
      status?: string;
    };
  };
  agent: {
    session_policy?: {
      policy_commitment?: string;
    };
  };
  preflight: unknown;
  live_limits: {
    max_notional_bucket: "5";
    max_order_count: 3;
    allowed_markets: string[];
    operation_class: "perp_limit_order";
  };
  submit_path: "/v1/private-account/public-live/phoenix/submit";
};

export function publicLiveJson(body: unknown, status = 200) {
  return json(body, status);
}

export async function publicLivePhoenixOwnerFromBody(
  body: PublicLiveWalletProofInput,
  options: { consumeNonce?: boolean; request: Request },
):
  Promise<
    | { ok: true; owner: PrivateAccountRequestOwner; proof: ReturnType<typeof publicProofOk> }
    | { ok: false; response: Response }
  > {
  const authenticated = await privateAccountOwnerFromRequest(options.request);
  if (!authenticated) {
    return { ok: false, response: publicLiveJson({ error: "private_account_auth_required" }, 401) };
  }
  if (authenticated.user.email_verified !== true && process.env.GHOLA_CONSUMER_EMAIL_VERIFICATION_MODE !== "report_only") {
    return { ok: false, response: publicLiveJson({ error: "verified_email_required" }, 403) };
  }
  const verified = verifyPublicLiveWalletProof(body, { consumeNonce: false });
  if (!verified.ok) {
    return {
      ok: false,
      response: publicLiveJson({ error: verified.error }, verified.status),
    };
  }
  const proof = publicProofOk(verified.proof);
  if (options.consumeNonce !== false) {
    const accepted = await consumeConsumerNonce({
      namespace: "phoenix_wallet_proof",
      owner_commitment: authenticated.owner_commitment,
      nonce: proof.nonce,
      expires_at_ms: proof.timestamp_ms + 5 * 60_000,
    });
    if (!accepted) {
      return { ok: false, response: publicLiveJson({ error: "public_live_wallet_proof_replayed" }, 403) };
    }
  }
  const account = await createOrGetStoredPrivateAccount(authenticated);
  const [binding, acceptance] = await Promise.all([
    getConsumerWalletBinding(authenticated.owner_commitment),
    getConsumerEligibilityAcceptance(authenticated.owner_commitment),
  ]);
  if (
    !binding ||
    binding.account_commitment !== account.account_commitment ||
    binding.wallet_pubkey !== proof.wallet_pubkey ||
    binding.wallet_commitment !== proof.wallet_commitment
  ) {
    return { ok: false, response: publicLiveJson({ error: "bound_solana_wallet_required" }, 403) };
  }
  if (
    acceptance?.terms_version !== CONSUMER_TERMS_VERSION ||
    acceptance.risk_version !== CONSUMER_RISK_VERSION ||
    acceptance.not_prohibited_person !== true
  ) {
    return { ok: false, response: publicLiveJson({ error: "current_consumer_acceptance_required" }, 403) };
  }
  const owner: PrivateAccountRequestOwner = authenticated;
  return { ok: true, owner, proof };
}

export async function preparePublicLivePhoenixAccess(input: {
  body: Record<string, unknown>;
  owner: PrivateAccountRequestOwner;
  req: Request;
}): Promise<PublicLivePhoenixPreparedAccess | { error: string }> {
  if (input.body.accepted_terms !== true || input.body.accepted_risk !== true) {
    return { error: "terms_acceptance_required" as const };
  }
  if (input.body.not_prohibited_person !== true) {
    return { error: "eligibility_self_attestation_required" as const };
  }
  const utilizationBucket = fundingBucket(input.body.utilization_bucket) || "5";
  const eligibility = await verifyVenueEligibilityFromBody({
    credential_type: "self_attested_eligible_user",
    accepted_terms: true,
    accepted_risk: true,
    jurisdiction_assertion: stringValue(input.body.jurisdiction_assertion) || "self_attested_eligible",
    country_code: stringValue(input.body.country_code) || undefined,
    region_code: stringValue(input.body.region_code) || undefined,
  }, input.owner, "phoenix");
  const eligibilityError = errorValue(eligibility);
  if (eligibilityError) return { error: eligibilityError };

  const allocated = await allocatePooledVenueFromBody({
    utilization_bucket: utilizationBucket,
  }, input.owner, "phoenix");
  const allocationError = errorValue(allocated);
  if (allocationError) return { error: allocationError };

  const agent = await armVenueAgentSessionFromBody({
    execution_mode: "ghola_pooled",
    market_allowlist: ["SOL-PERP"],
    max_notional_bucket: "5",
    max_order_count: 3,
    kill_switch: false,
  }, input.owner, "solana_perps_market");
  const agentError = errorValue(agent);
  if (agentError) return { error: agentError };
  const eligible = eligibility as {
    account_commitment: string;
    eligibility: { eligibility_commitment: string };
  };
  const allocation = allocated as PublicLivePhoenixPreparedAccess["allocation"];
  const armedAgent = agent as PublicLivePhoenixPreparedAccess["agent"];

  const preflight = await preflightVenueTradeFromBody({
    account_mode: "ghola_pooled",
  }, input.owner, "phoenix");
  return {
    version: 1,
    status: allocation.pooled_allocation?.status === "allocated" ? "live_ready" as const : "funding_required" as const,
    account_commitment: eligible.account_commitment,
    venue_id: "phoenix" as const,
    platform_class: "solana_perps_market" as const,
    execution_mode: "ghola_pooled" as const,
    eligibility: eligible,
    allocation,
    agent: armedAgent,
    preflight,
    live_limits: {
      max_notional_bucket: "5",
      max_order_count: 3,
      allowed_markets: ["SOL-PERP"],
      operation_class: "perp_limit_order",
    },
    submit_path: "/v1/private-account/public-live/phoenix/submit",
  };
}

function publicProofOk(proof: {
  wallet_pubkey: string;
  wallet_commitment: string;
  owner_commitment: string;
  proof_commitment: string;
  timestamp_ms: number;
  nonce: string;
}) {
  return {
    wallet_pubkey: proof.wallet_pubkey,
    wallet_commitment: proof.wallet_commitment || publicLiveWalletCommitment(proof.wallet_pubkey),
    owner_commitment: proof.owner_commitment || publicLiveOwnerCommitment(proof.wallet_pubkey),
    proof_commitment: proof.proof_commitment,
    timestamp_ms: proof.timestamp_ms,
    nonce: proof.nonce,
  };
}

function fundingBucket(value: unknown) {
  const text = stringValue(value);
  return ["5", "10", "25"].includes(text) ? text : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorValue(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : null;
}
