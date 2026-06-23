export const PRIVATE_AGENT_PLAN_ID = "private_agent";
export const PRIVATE_AGENT_MONTHLY_PRICE_USD = 49;
export const PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS = 60 * 60 * 60;
export const PRIVATE_AGENT_ACTIVE_AGENT_LIMIT = 1;
export const PRIVATE_AGENT_PHALA_SMALL_HOURLY_USD = 0.058;
export const PRIVATE_AGENT_DEFAULT_LIVE_TRADE_RESERVATION_SECONDS = 10 * 60;
export const PRIVATE_AGENT_MIN_LIVE_TRADE_RESERVATION_SECONDS = 60;
export const PRIVATE_AGENT_MAX_LIVE_TRADE_RESERVATION_SECONDS = 60 * 60;

export function privateAgentIncludedComputeHours(): number {
  return PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS / 3600;
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
