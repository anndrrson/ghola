// Live automation is intentionally narrow: exact Hyperliquid level plans only,
// and only when the shared Postgres execution-claim store is authoritative.
export function autonomousLiveSubmitEnabled({ strategyId, venue, policy, state } = {}) {
  const exactNotional = Number(policy?.exact_notional_usd);
  const durableStore = state?.path === "postgres" || (
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" &&
    typeof state?.path === "string" && state.path.endsWith(".sqlite")
  );
  return strategyId === "level_trigger_v1" &&
    venue === "hyperliquid" &&
    durableStore &&
    ["mainnet", "testnet"].includes(policy?.execution_network) &&
    policy?.venue_allowlist?.length === 1 &&
    policy.venue_allowlist[0] === "hyperliquid" &&
    policy?.market_allowlist?.length === 1 &&
    Number.isFinite(exactNotional) &&
    exactNotional > 0 &&
    exactNotional <= Number(policy.max_notional_bucket);
}
