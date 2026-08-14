export function requestsDisabledLevelTriggerSession(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  const nested = value.session_policy;
  const policy = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : value;
  return typeof policy.strategy_id === "string" && policy.strategy_id.trim() === "level_trigger_v1";
}

export function levelTriggerExactPlanError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const nested = value.session_policy;
  const policy = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : value;
  if (typeof policy.strategy_id !== "string" || policy.strategy_id.trim() !== "level_trigger_v1") return null;
  const venues = Array.isArray(policy.venue_allowlist) ? policy.venue_allowlist : [];
  const markets = Array.isArray(policy.market_allowlist) ? policy.market_allowlist : [];
  const notional = Number(policy.exact_notional_usd);
  const maxNotional = Number(policy.max_notional_bucket);
  const market = typeof markets[0] === "string" ? markets[0].trim().toUpperCase() : "";
  if (
    venues.length !== 1 || venues[0] !== "hyperliquid" || markets.length !== 1 ||
    !["BTC-USD", "ETH-USD", "SOL-USD", "HYPE-USD"].includes(market) ||
    !["mainnet", "testnet"].includes(String(policy.execution_network || "")) ||
    !Number.isFinite(notional) || notional <= 0 || notional > 100 ||
    (Number.isFinite(maxNotional) && maxNotional > 0 && notional > maxNotional)
  ) return "level_trigger_exact_plan_required";
  return null;
}
