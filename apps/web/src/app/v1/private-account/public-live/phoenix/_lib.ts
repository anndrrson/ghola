import type { PrivateAccountRequestOwner } from "../../_lib";
import {
  allocatePooledVenueFromBody,
  amountBucketMicroUsdc,
  armVenueAgentSessionFromBody,
  gholaBalanceForOwner,
  json,
  privateAccountOwnerFromRequest,
  preflightVenueTradeFromBody,
  verifyVenueEligibilityFromBody,
} from "../../_lib";
import {
  publicLiveOwnerCommitment,
  publicLiveWalletCommitment,
  verifyPublicLiveWalletProof,
  type PublicLiveWalletProofInput,
} from "@/lib/private-account-public-live";

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
  balance: {
    available_micro_usdc?: number;
    available_usd?: string;
    withdrawable_micro_usdc?: number;
    withdrawable_usd?: string;
  } | null;
  required_margin_micro_usdc: number;
  can_submit_live: boolean;
  blocking_reason_codes: string[];
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
  options: { consumeNonce?: boolean; req?: Request } = {},
):
  Promise<
    | { ok: true; owner: PrivateAccountRequestOwner; proof: ReturnType<typeof publicProofOk> }
    | { ok: false; response: Response }
  > {
  const verified = verifyPublicLiveWalletProof(body, {
    consumeNonce: false,
  });
  if (!verified.ok) {
    return {
      ok: false,
      response: publicLiveJson({ error: verified.error }, verified.status),
    };
  }
  const proof = publicProofOk(verified.proof);
  const authenticatedOwner = options.req
    ? await privateAccountOwnerFromRequest(options.req)
    : null;
  const config = publicLivePhoenixNoKeyConfig();
  if (config.require_auth && !authenticatedOwner) {
    return {
      ok: false,
      response: publicLiveJson({ error: "public_live_auth_required" }, 401),
    };
  }
  if (
    authenticatedOwner &&
    config.require_allowlist &&
    !publicLiveAllowlisted(authenticatedOwner, proof)
  ) {
    return {
      ok: false,
      response: publicLiveJson({ error: "public_live_allowlist_required" }, 403),
    };
  }
  if (options.consumeNonce !== false) {
    const consumed = verifyPublicLiveWalletProof(body, { consumeNonce: true });
    if (!consumed.ok) {
      return {
        ok: false,
        response: publicLiveJson({ error: consumed.error }, consumed.status),
      };
    }
  }
  const fallbackOwner: PrivateAccountRequestOwner = {
    user: {
      id: `public-live:${proof.wallet_commitment}`,
      email: `${proof.wallet_commitment.slice(0, 40)}@public-live.ghola.local`,
      name: "Public Live Wallet",
    },
    owner_commitment: proof.owner_commitment,
  };
  const owner = authenticatedOwner ?? fallbackOwner;
  return { ok: true, owner, proof };
}

export async function preparePublicLivePhoenixAccess(input: {
  body: Record<string, unknown>;
  owner: PrivateAccountRequestOwner;
  req: Request;
}): Promise<PublicLivePhoenixPreparedAccess | { error: string }> {
  const config = publicLivePhoenixNoKeyConfig();
  if (!config.enabled) {
    return { error: "no_key_live_disabled" as const };
  }
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
  }, input.owner, "phoenix", input.req);
  const eligibilityError = errorValue(eligibility);
  if (eligibilityError) return { error: eligibilityError };

  const allocated = await allocatePooledVenueFromBody({
    utilization_bucket: utilizationBucket,
  }, input.owner, "phoenix");
  const allocationError = errorValue(allocated);
  if (allocationError) return { error: allocationError };

  const agent = await armVenueAgentSessionFromBody({
    execution_mode: "ghola_pooled",
    market_allowlist: ["SOL", "SOL-PERP"],
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
  const balance = await gholaBalanceForOwner(input.owner);
  const balanceSnapshot = balance.balance as PublicLivePhoenixPreparedAccess["balance"];
  const requiredMarginMicroUsdc = amountBucketMicroUsdc("5");
  const blockingReasonCodes: string[] = [];
  const availableMicroUsdc = Number(balanceSnapshot?.available_micro_usdc ?? 0);
  if (config.require_balance && availableMicroUsdc < requiredMarginMicroUsdc) {
    blockingReasonCodes.push("ghola_balance_insufficient");
  }
  const liveReady = allocation.pooled_allocation?.status === "allocated";
  return {
    version: 1,
    status: liveReady ? "live_ready" as const : "funding_required" as const,
    account_commitment: eligible.account_commitment,
    venue_id: "phoenix" as const,
    platform_class: "solana_perps_market" as const,
    execution_mode: "ghola_pooled" as const,
    eligibility: eligible,
    allocation,
    agent: armedAgent,
    preflight,
    balance: balanceSnapshot,
    required_margin_micro_usdc: requiredMarginMicroUsdc,
    can_submit_live: liveReady && blockingReasonCodes.length === 0,
    blocking_reason_codes: blockingReasonCodes,
    live_limits: {
      max_notional_bucket: "5",
      max_order_count: 3,
      allowed_markets: ["SOL", "SOL-PERP"],
      operation_class: "perp_limit_order",
    },
    submit_path: "/v1/private-account/public-live/phoenix/submit",
  };
}

export function publicLivePhoenixNoKeyConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const enabled = env.GHOLA_NO_KEY_LIVE_ENABLED === "true";
  const requireAllowlist = (enabled || env.GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST === "true") &&
    env.GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST !== "false";
  return {
    enabled,
    require_auth: enabled || env.GHOLA_PUBLIC_LIVE_REQUIRE_AUTH === "true" || requireAllowlist,
    require_balance: enabled || env.GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE === "true",
    require_allowlist: requireAllowlist,
    allowed_users: csvSet(env.GHOLA_PUBLIC_LIVE_ALLOWED_USERS),
    allowed_wallets: csvSet(env.GHOLA_PUBLIC_LIVE_ALLOWED_WALLETS),
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

function publicLiveAllowlisted(
  owner: PrivateAccountRequestOwner,
  proof: ReturnType<typeof publicProofOk>,
) {
  const config = publicLivePhoenixNoKeyConfig();
  if (!config.require_allowlist) return true;
  if (config.allowed_users.size === 0 && config.allowed_wallets.size === 0) return false;
  const userCandidates = [
    owner.user.id,
    owner.user.email,
    owner.owner_commitment,
  ].map((item) => item.toLowerCase());
  const walletCandidates = [
    proof.wallet_pubkey,
    proof.wallet_commitment,
    proof.owner_commitment,
  ].map((item) => item.toLowerCase());
  return userCandidates.some((item) => config.allowed_users.has(item)) ||
    walletCandidates.some((item) => config.allowed_wallets.has(item));
}

function csvSet(value: string | undefined) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
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
