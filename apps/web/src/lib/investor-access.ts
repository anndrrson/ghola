import { hasPrivateAgentEntitlement } from "./private-agent-runtime";
import type { ThumperBillingStatusResponse } from "./thumper-types";

export const INVESTOR_ACCESS_MIN_REMAINING_MS = 30 * 60 * 1_000;
export const INVESTOR_ACCESS_REQUIRED_COMPUTE_SECONDS = 10 * 60;
export const INVESTOR_ACCESS_REQUIRED_FILLED_NOTIONAL_MICRO_USD = 22_000_000;

const ACCESS_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type InvestorAccessBlocker =
  | "billing_unavailable"
  | "access_state_required"
  | "subscription_required"
  | "investor_invite_required"
  | "expiry_required"
  | "access_expired"
  | "access_expiring_soon"
  | "compute_allowance_required"
  | "compute_allowance_exhausted"
  | "active_agent_limit_reached"
  | "trading_allowance_required"
  | "trading_allowance_exhausted"
  | "billing_period_invalid"
  | "complimentary_overage_enabled";

export type InvestorAccessReadiness = {
  ready: boolean;
  blocker: InvestorAccessBlocker | null;
  message: string;
  expires_at: string | null;
  remaining_compute_seconds: number | null;
  remaining_filled_notional_micro_usd: number | null;
};

export type InvestorAccessRequirements = {
  minRemainingMs?: number;
  requiredComputeSeconds?: number;
  requiredFilledNotionalMicroUsd?: number;
  requireComplimentaryPass?: boolean;
};

export type InvestorAccessInvite = {
  code: string | null;
  clean_path: string;
  error: "invite_code_invalid" | "invite_code_ambiguous" | null;
};

export function evaluateInvestorAccess(
  billing: ThumperBillingStatusResponse | null | undefined,
  nowMs = Date.now(),
  requirements: InvestorAccessRequirements = {},
): InvestorAccessReadiness {
  const minRemainingMs = requirements.minRemainingMs ?? INVESTOR_ACCESS_MIN_REMAINING_MS;
  const requiredComputeSeconds = requirements.requiredComputeSeconds ??
    INVESTOR_ACCESS_REQUIRED_COMPUTE_SECONDS;
  const requiredFilledNotionalMicroUsd = requirements.requiredFilledNotionalMicroUsd ??
    INVESTOR_ACCESS_REQUIRED_FILLED_NOTIONAL_MICRO_USD;

  if (!billing) return blocked("billing_unavailable", "Account access could not be verified.");
  if (billing.access_state === "expired") {
    return blocked(
      "access_expired",
      "This access pass has expired.",
      billing.last_access_expires_at ?? billing.expires_at ?? null,
    );
  }
  if (billing.access_state !== "active") {
    return blocked(
      billing.access_state === "none" ? "subscription_required" : "access_state_required",
      billing.access_state === "none"
        ? "Active private-agent or investor access is required."
        : "The active access state could not be verified.",
    );
  }
  if (!hasPrivateAgentEntitlement(billing.tier)) {
    return blocked("subscription_required", "Active private-agent or investor access is required.");
  }
  if (requirements.requireComplimentaryPass &&
      (billing.access_source !== "complimentary_pass" || billing.invite_state !== "active")) {
    return blocked("investor_invite_required", "An active email-bound investor pass is required for canary trading.");
  }

  const expiresAt = billing.expires_at ?? null;
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return blocked("expiry_required", "The access expiry could not be verified.", expiresAt);
    }
    if (expiresAtMs <= nowMs) {
      return blocked("access_expired", "This access pass has expired.", expiresAt);
    }
    if (expiresAtMs - nowMs <= minRemainingMs) {
      return blocked(
        "access_expiring_soon",
        "This access pass expires too soon to safely start wallet authorization.",
        expiresAt,
      );
    }
  } else if (billing.access_source === "complimentary_pass" || billing.tier === "trial_pack") {
    return blocked("expiry_required", "The access expiry could not be verified.");
  }

  const compute = billing.private_agent_compute;
  if (!compute) {
    return blocked("compute_allowance_required", "Private compute allowance is unavailable.", expiresAt);
  }
  const remainingComputeSeconds = finiteNonNegativeInteger(compute.remaining_seconds);
  if (remainingComputeSeconds == null) {
    return blocked("compute_allowance_required", "Private compute allowance is unavailable.", expiresAt);
  }
  if (remainingComputeSeconds < requiredComputeSeconds) {
    return blocked(
      "compute_allowance_exhausted",
      `At least ${requiredComputeSeconds} compute seconds are required before wallet authorization.`,
      expiresAt,
      remainingComputeSeconds,
    );
  }
  const activeAgentLimit = positiveInteger(compute.active_agent_limit);
  const activeAgentCount = finiteNonNegativeInteger(compute.active_agent_count);
  if (activeAgentLimit == null || activeAgentCount == null) {
    return blocked(
      "compute_allowance_required",
      "Private-agent capacity could not be verified.",
      expiresAt,
      remainingComputeSeconds,
    );
  }
  if (activeAgentCount >= activeAgentLimit) {
    return blocked(
      "active_agent_limit_reached",
      "The active secure-agent limit is already reached.",
      expiresAt,
      remainingComputeSeconds,
    );
  }
  if (!currentPeriod(compute.period_start, compute.period_end, nowMs)) {
    return blocked(
      "billing_period_invalid",
      "The private-compute billing period is not current.",
      expiresAt,
      remainingComputeSeconds,
    );
  }

  const trading = billing.private_agent_trading;
  if (!trading) {
    return blocked(
      "trading_allowance_required",
      "Live-trading allowance is unavailable.",
      expiresAt,
      remainingComputeSeconds,
    );
  }
  const remainingFilledNotional = finiteNonNegativeInteger(trading.remaining_included_notional_micro_usd);
  if (remainingFilledNotional == null) {
    return blocked(
      "trading_allowance_required",
      "Live-trading allowance is unavailable.",
      expiresAt,
      remainingComputeSeconds,
    );
  }
  if (billing.access_source === "complimentary_pass" && trading.overage_fee_bps !== 0) {
    return blocked(
      "complimentary_overage_enabled",
      "Complimentary access must have billing overages disabled.",
      expiresAt,
      remainingComputeSeconds,
      remainingFilledNotional,
    );
  }
  if (trading.cap_reached !== false || trading.live_trading_allowed !== true ||
      remainingFilledNotional < requiredFilledNotionalMicroUsd) {
    return blocked(
      "trading_allowance_exhausted",
      "The remaining live-trading allowance is insufficient for the acceptance trade.",
      expiresAt,
      remainingComputeSeconds,
      remainingFilledNotional,
    );
  }
  if (!currentPeriod(trading.period_start, trading.period_end, nowMs)) {
    return blocked(
      "billing_period_invalid",
      "The live-trading billing period is not current.",
      expiresAt,
      remainingComputeSeconds,
      remainingFilledNotional,
    );
  }

  return {
    ready: true,
    blocker: null,
    message: "Investor access is ready.",
    expires_at: expiresAt,
    remaining_compute_seconds: remainingComputeSeconds,
    remaining_filled_notional_micro_usd: remainingFilledNotional,
  };
}

export function inspectInvestorAccessInvite(href: string): InvestorAccessInvite {
  const url = new URL(href);
  // Query strings are sent to servers and intermediaries. Scrub legacy
  // `access` parameters, but never treat them as invitation credentials.
  url.searchParams.delete("access");

  let fragmentCodes: string[] = [];
  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (rawHash.includes("=")) {
    const fragment = new URLSearchParams(rawHash);
    fragmentCodes = fragment.getAll("access").map((value) => value.trim()).filter(Boolean);
    fragment.delete("access");
    const nextHash = fragment.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }

  const values = [...new Set(fragmentCodes)];
  const code = values.length === 1 ? values[0] : null;
  const error = values.length > 1
    ? "invite_code_ambiguous"
    : code && !ACCESS_CODE_PATTERN.test(code) ? "invite_code_invalid" : null;

  return {
    code: error ? null : code,
    clean_path: `${url.pathname}${url.search}${url.hash}`,
    error,
  };
}

function blocked(
  blocker: InvestorAccessBlocker,
  message: string,
  expiresAt: string | null = null,
  remainingComputeSeconds: number | null = null,
  remainingFilledNotionalMicroUsd: number | null = null,
): InvestorAccessReadiness {
  return {
    ready: false,
    blocker,
    message,
    expires_at: expiresAt,
    remaining_compute_seconds: remainingComputeSeconds,
    remaining_filled_notional_micro_usd: remainingFilledNotionalMicroUsd,
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const integer = finiteNonNegativeInteger(value);
  return integer != null && integer > 0 ? integer : null;
}

function currentPeriod(start: unknown, end: unknown, nowMs: number): boolean {
  if (typeof start !== "string" || typeof end !== "string" || !Number.isFinite(nowMs)) return false;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && nowMs < endMs;
}
