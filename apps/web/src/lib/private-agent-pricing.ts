export const PRIVATE_AGENT_TRIAL_PACK_ID = "trial_pack";
export const PRIVATE_AGENT_TRIAL_PACK_PRICE_USD = 9;
export const PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS = 5 * 60 * 60;
export const PRIVATE_AGENT_TRIAL_PACK_DAYS = 14;

export const PRIVATE_AGENT_STARTER_PLAN_ID = "starter";
export const PRIVATE_AGENT_STARTER_MONTHLY_PRICE_USD = 39;
export const PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS = 20 * 60 * 60;
export const PRIVATE_AGENT_STARTER_ACTIVE_AGENT_LIMIT = 1;
export const PRIVATE_AGENT_STARTER_INCLUDED_NOTIONAL_USD = 100_000;
export const PRIVATE_AGENT_STARTER_OVERAGE_FEE_BPS = 3;
export const PRIVATE_AGENT_STARTER_DEFAULT_MONTHLY_FEE_CAP_USD = 50;

export const PRIVATE_AGENT_PLAN_ID = "private_agent";
export const PRIVATE_AGENT_MONTHLY_PRICE_USD = 129;
export const PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS = 80 * 60 * 60;
export const PRIVATE_AGENT_ACTIVE_AGENT_LIMIT = 1;
export const PRIVATE_AGENT_INCLUDED_NOTIONAL_USD = 1_000_000;
export const PRIVATE_AGENT_OVERAGE_FEE_BPS = 2;
export const PRIVATE_AGENT_DEFAULT_MONTHLY_FEE_CAP_USD = 500;
export const PRIVATE_AGENT_PHALA_SMALL_HOURLY_USD = 0.058;
export const PRIVATE_AGENT_DEFAULT_LIVE_TRADE_RESERVATION_SECONDS = 10 * 60;
export const PRIVATE_AGENT_MIN_LIVE_TRADE_RESERVATION_SECONDS = 60;
export const PRIVATE_AGENT_MAX_LIVE_TRADE_RESERVATION_SECONDS = 60 * 60;

export function privateAgentIncludedComputeHours(): number {
  return PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS / 3600;
}

export function privateAgentComputeHours(seconds: number): number {
  return seconds / 3600;
}

export function privateAgentLiveTradeReservationSeconds(
  env: Record<string, string | undefined>,
): number {
  const parsed = Number.parseInt(
    env.GHOLA_PRIVATE_ACCOUNT_LIVE_TRADE_RESERVATION_SECONDS ?? "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return PRIVATE_AGENT_DEFAULT_LIVE_TRADE_RESERVATION_SECONDS;
  }
  return Math.min(
    PRIVATE_AGENT_MAX_LIVE_TRADE_RESERVATION_SECONDS,
    Math.max(PRIVATE_AGENT_MIN_LIVE_TRADE_RESERVATION_SECONDS, parsed),
  );
}
