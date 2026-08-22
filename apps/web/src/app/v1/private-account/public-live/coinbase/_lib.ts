import type { PrivateAccountRequestOwner } from "../../_lib";
import {
  allocateOmnibusFromBody,
  amountBucketMicroUsdc,
  armVenueAgentSessionFromBody,
  gholaBalanceForOwner,
  json,
  preflightVenueTradeFromBody,
  privateAccountOwnerFromRequest,
  verifyVenueEligibilityFromBody,
} from "../../_lib";

export type PublicLiveCoinbasePreparedAccess = {
  version: 1;
  status: "live_ready" | "funding_required";
  account_commitment: string;
  venue_id: "coinbase_advanced";
  platform_class: "coinbase_style_provider";
  execution_mode: "partner_omnibus";
  eligibility: {
    eligibility: {
      eligibility_commitment: string;
    };
  };
  allocation: {
    allocation?: {
      allocation_commitment?: string;
      status?: string;
    };
    ready?: boolean;
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
    max_notional_bucket: string;
    max_order_count: 3;
    allowed_markets: string[];
    operation_class: "spot_market_order";
  };
  submit_path: "/v1/private-account/public-live/coinbase/submit";
};

export function publicLiveJson(body: unknown, status = 200) {
  return json(body, status);
}

export async function publicLiveCoinbaseOwnerFromRequest(
  req: Request,
): Promise<
  | { ok: true; owner: PrivateAccountRequestOwner }
  | { ok: false; response: Response }
> {
  const owner = await privateAccountOwnerFromRequest(req);
  const config = publicLiveCoinbaseConfig();
  if (config.require_auth && !owner) {
    return {
      ok: false,
      response: publicLiveJson({ error: "public_live_auth_required" }, 401),
    };
  }
  if (!owner) {
    return {
      ok: false,
      response: publicLiveJson({ error: "public_live_auth_required" }, 401),
    };
  }
  if (config.require_allowlist && !publicLiveCoinbaseAllowlisted(owner)) {
    return {
      ok: false,
      response: publicLiveJson({ error: "public_live_allowlist_required" }, 403),
    };
  }
  return { ok: true, owner };
}

export async function preparePublicLiveCoinbaseAccess(input: {
  body: Record<string, unknown>;
  owner: PrivateAccountRequestOwner;
  req: Request;
}): Promise<PublicLiveCoinbasePreparedAccess | { error: string }> {
  const config = publicLiveCoinbaseConfig();
  if (!config.enabled) {
    return { error: "no_key_live_disabled" as const };
  }
  if (!config.pool_ready) {
    return { error: "coinbase_omnibus_pool_not_ready" as const };
  }
  if (input.body.accepted_terms !== true || input.body.accepted_risk !== true) {
    return { error: "terms_acceptance_required" as const };
  }
  if (input.body.not_prohibited_person !== true) {
    return { error: "eligibility_self_attestation_required" as const };
  }
  const utilizationBucket = fundingBucket(input.body.utilization_bucket) || "5";
  if (Number(utilizationBucket) > Number(config.max_notional_bucket)) {
    return { error: "public_live_notional_limit_exceeded" as const };
  }
  const eligibility = await verifyVenueEligibilityFromBody({
    credential_type: "self_attested_eligible_user",
    accepted_terms: true,
    accepted_risk: true,
    jurisdiction_assertion: stringValue(input.body.jurisdiction_assertion) || "self_attested_eligible",
    country_code: stringValue(input.body.country_code) || "US",
    region_code: stringValue(input.body.region_code) || undefined,
  }, input.owner, "coinbase_advanced", input.req);
  const eligibilityError = errorValue(eligibility);
  if (eligibilityError) return { error: eligibilityError };

  const allocated = await allocateOmnibusFromBody({
    utilization_bucket: utilizationBucket,
    settlement_funding_commitment: gholaBalanceFundingCommitment(input.owner, utilizationBucket),
  }, input.owner);
  const allocationError = errorValue(allocated);
  if (allocationError) return { error: allocationError };

  const agent = await armVenueAgentSessionFromBody({
    execution_mode: "partner_omnibus",
    market_allowlist: publicLiveCoinbaseAllowedProducts(),
    max_notional_bucket: utilizationBucket,
    max_order_count: 3,
    kill_switch: false,
  }, input.owner, "coinbase_style_provider");
  const agentError = errorValue(agent);
  if (agentError) return { error: agentError };
  const eligible = eligibility as {
    account_commitment: string;
    eligibility: { eligibility_commitment: string };
  };
  const allocation = allocated as PublicLiveCoinbasePreparedAccess["allocation"];
  const armedAgent = agent as PublicLiveCoinbasePreparedAccess["agent"];

  const preflight = await preflightVenueTradeFromBody({
    account_mode: "partner_omnibus",
  }, input.owner, "coinbase_advanced");
  const balance = await gholaBalanceForOwner(input.owner);
  const balanceSnapshot = balance.balance as PublicLiveCoinbasePreparedAccess["balance"];
  const requiredMarginMicroUsdc = amountBucketMicroUsdc(utilizationBucket);
  const blockingReasonCodes: string[] = [];
  const availableMicroUsdc = Number(balanceSnapshot?.available_micro_usdc ?? 0);
  if (config.require_balance && availableMicroUsdc < requiredMarginMicroUsdc) {
    blockingReasonCodes.push("ghola_balance_insufficient");
  }
  const liveReady = config.pool_ready && config.live_mode === "full";
  if (config.live_mode !== "full") blockingReasonCodes.push("coinbase_live_mode_disabled");
  return {
    version: 1,
    status: liveReady ? "live_ready" as const : "funding_required" as const,
    account_commitment: eligible.account_commitment,
    venue_id: "coinbase_advanced" as const,
    platform_class: "coinbase_style_provider" as const,
    execution_mode: "partner_omnibus" as const,
    eligibility: eligible,
    allocation,
    agent: armedAgent,
    preflight,
    balance: balanceSnapshot,
    required_margin_micro_usdc: requiredMarginMicroUsdc,
    can_submit_live: liveReady && blockingReasonCodes.length === 0,
    blocking_reason_codes: blockingReasonCodes,
    live_limits: {
      max_notional_bucket: utilizationBucket,
      max_order_count: 3,
      allowed_markets: publicLiveCoinbaseAllowedProducts(),
      operation_class: "spot_market_order",
    },
    submit_path: "/v1/private-account/public-live/coinbase/submit",
  };
}

export function publicLiveCoinbaseConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const enabled = env.GHOLA_NO_KEY_LIVE_ENABLED === "true" &&
    (env.GHOLA_PUBLIC_LIVE_PRIMARY_VENUE || "phoenix") === "coinbase";
  const requireAllowlist = (enabled || env.GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST === "true") &&
    env.GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST !== "false";
  return {
    enabled,
    require_auth: true,
    require_balance: enabled || env.GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE === "true",
    require_allowlist: requireAllowlist,
    allowed_users: csvSet(env.GHOLA_PUBLIC_LIVE_ALLOWED_USERS),
    pool_ready: env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED === "true" &&
      env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY === "true",
    live_mode: env.GHOLA_COINBASE_LIVE_MODE || env.PRIVATE_AGENT_COINBASE_LIVE_MODE || "disabled",
    max_notional_bucket: configuredNotionalBucket(
      env.GHOLA_PUBLIC_LIVE_MAX_NOTIONAL_USD ||
      env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD ||
      env.GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD ||
      "100",
    ),
  };
}

export function publicLiveCoinbaseAllowedProducts(
  env: Record<string, string | undefined> = process.env,
) {
  const products = (env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS || env.GHOLA_COINBASE_ALLOWED_PRODUCTS || "SOL-USD,BTC-USD,ETH-USD")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item === "SOL-USD" || item === "BTC-USD" || item === "ETH-USD");
  return products.length ? products : ["SOL-USD"];
}

function publicLiveCoinbaseAllowlisted(owner: PrivateAccountRequestOwner) {
  const config = publicLiveCoinbaseConfig();
  if (!config.require_allowlist) return true;
  if (config.allowed_users.size === 0) return false;
  return [
    owner.user.id,
    owner.user.email,
    owner.owner_commitment,
  ].map((item) => item.toLowerCase()).some((item) => config.allowed_users.has(item));
}

function gholaBalanceFundingCommitment(owner: PrivateAccountRequestOwner, utilizationBucket: string) {
  return `ghola_balance_funding_${owner.owner_commitment}_${utilizationBucket}`;
}

function fundingBucket(value: unknown) {
  const text = stringValue(value);
  return ["5", "10", "25", "50", "100", "250"].includes(text) ? text : null;
}

function configuredNotionalBucket(value: string) {
  const requested = Number(value);
  const buckets = [5, 10, 25, 50, 100, 250];
  return String(buckets.filter((bucket) => bucket <= requested).at(-1) || 5);
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
