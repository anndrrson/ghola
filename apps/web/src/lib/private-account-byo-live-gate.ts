import type { TradeOrderPlan, TradeOrderVenueId } from "./trade-order-plan";

export type PrivateAccountByoVenueId = TradeOrderVenueId | "jupiter";

export type PrivateAccountByoLiveOrderShape = {
  venue_id: TradeOrderVenueId;
  order_type: string;
  time_in_force: string;
  live_order_mode?: string | null;
  post_only?: boolean;
};

export type PrivateAccountByoPlanContainment =
  | { allowed: true; reason_code: null; message: null }
  | { allowed: false; reason_code: string; message: string };

const VENUE_LABELS: Record<PrivateAccountByoVenueId, string> = {
  hyperliquid: "Hyperliquid",
  phoenix: "Phoenix",
  coinbase: "Coinbase",
  jupiter: "Jupiter",
};

const HYPERLIQUID_EXECUTION_PRODUCTS = new Set([
  "BTC-PERP",
  "ETH-PERP",
  "SOL-PERP",
  "HYPE-PERP",
]);
const PHOENIX_EXECUTION_PRODUCTS = new Set(["SOL-PERP"]);

export function privateAccountByoGlobalFailures(
  env: Record<string, string | undefined>,
): string[] {
  const failures: string[] = [];
  if (!envIs(env, "GHOLA_LIVE_TRADING_PUBLIC_ENABLED", "true")) {
    failures.push("live_trading_public_flag_disabled");
  }
  if (envIs(env, "PRIVATE_AGENT_VENUE_DRY_RUN", "true")) {
    failures.push("venue_dry_run_enabled");
  }
  if (!validRequestProofSecret(env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET || "")) {
    failures.push("request_proof_secret_missing");
  }
  if (!capEquals(env, ["GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD"], 1_000)) {
    failures.push("launch_max_order_cap_missing");
  }
  if (!capEquals(env, ["GHOLA_LIVE_TRADING_DAILY_CAP_USD"], 5_000)) {
    failures.push("launch_daily_cap_missing");
  }
  if (!capAtMost(env, ["GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS"], 100)) {
    failures.push("launch_slippage_cap_missing");
  }
  return failures;
}

export function privateAccountByoVenueGate(
  id: PrivateAccountByoVenueId,
  env: Record<string, string | undefined>,
) {
  const reasonCodes: string[] = [];
  if (id === "hyperliquid") {
    if (!envIs(env, "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED", "true")) reasonCodes.push("hyperliquid_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "true")) reasonCodes.push("hyperliquid_mainnet_worker_disabled");
    if (!envIs(env, "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", "full_ticket")) reasonCodes.push("hyperliquid_worker_full_ticket_disabled");
    if (!capEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) reasonCodes.push("hyperliquid_max_order_cap_missing");
    if (!capEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"], 5_000)) reasonCodes.push("hyperliquid_daily_cap_missing");
    if (!capAtMost(env, ["PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS"], 100)) reasonCodes.push("hyperliquid_slippage_cap_missing");
  }
  if (id === "phoenix") {
    if (!envIs(env, "GHOLA_VENUE_PHOENIX_PILOT_ENABLED", "true")) reasonCodes.push("phoenix_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", "true")) reasonCodes.push("phoenix_mainnet_worker_disabled");
    if (
      !envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "full_ticket") &&
      !envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "sdk_runner")
    ) reasonCodes.push("phoenix_worker_live_mode_disabled");
    if (!capEquals(env, ["PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) reasonCodes.push("phoenix_max_order_cap_missing");
    if (!capAtMost(env, ["PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", "GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS"], 100)) reasonCodes.push("phoenix_slippage_cap_missing");
  }
  if (id === "jupiter") {
    if (!envIs(env, "GHOLA_VENUE_JUPITER_PILOT_ENABLED", "true")) reasonCodes.push("jupiter_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_JUPITER_LIVE_MODE", "full")) reasonCodes.push("jupiter_worker_full_mode_disabled");
    if (!jupiterApiKeyConfigured(env)) reasonCodes.push("jupiter_api_key_missing");
    if (!env.GHOLA_JUPITER_ALLOWED_INPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS?.trim()) reasonCodes.push("jupiter_input_mint_allowlist_missing");
    if (!env.GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS?.trim()) reasonCodes.push("jupiter_output_mint_allowlist_missing");
    if (!capEquals(env, ["PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", "GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD"], 1_000)) reasonCodes.push("jupiter_max_order_cap_missing");
    if (!capAtMost(env, ["PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", "GHOLA_JUPITER_MAX_SLIPPAGE_BPS"], 100)) reasonCodes.push("jupiter_slippage_cap_missing");
  }
  if (id === "coinbase") {
    if (!envIs(env, "GHOLA_V6_COINBASE_PILOT_ENABLED", "true")) reasonCodes.push("coinbase_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_COINBASE_LIVE_MODE", "full")) reasonCodes.push("coinbase_worker_full_mode_disabled");
    if (coinbaseProductAllowlist(env).size === 0) reasonCodes.push("coinbase_product_allowlist_missing");
    if (!capEquals(env, ["PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", "GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD"], 1_000)) reasonCodes.push("coinbase_max_order_cap_missing");
  }
  return {
    id,
    label: VENUE_LABELS[id],
    submit_source: "user_scoped_credential" as const,
    status: reasonCodes.length === 0 ? "green" as const : "red" as const,
    reason_codes: reasonCodes,
  };
}

export function privateAccountByoExecutionGate(
  plan: TradeOrderPlan,
  env: Record<string, string | undefined>,
) {
  const venue = privateAccountByoVenueGate(plan.venue_id, env);
  const containment = privateAccountByoPlanContainment(plan);
  const reasonCodes = [...new Set([
    ...privateAccountByoGlobalFailures(env),
    ...venue.reason_codes,
    ...tradeOrderPlanFailures(plan, env),
    ...(containment.allowed ? [] : [containment.reason_code]),
  ])];
  return { allowed: reasonCodes.length === 0, venue, reason_codes: reasonCodes };
}

export function privateAccountByoPlanContainment(
  order: PrivateAccountByoLiveOrderShape,
): PrivateAccountByoPlanContainment {
  const orderType = order.order_type.toLowerCase();
  const tif = order.time_in_force.toLowerCase();
  if (order.venue_id === "hyperliquid" && (orderType !== "limit" || tif !== "ioc")) {
    return {
      allowed: false,
      reason_code: "hyperliquid_resting_order_recovery_unproven",
      message: "Hyperliquid live GTC orders are unavailable until exact cancellation recovery is proven. Use the signed limit IOC terminal mode.",
    };
  }
  if (order.venue_id === "coinbase") {
    return {
      allowed: false,
      reason_code: "coinbase_live_execution_recovery_unproven",
      message: "Coinbase live execution is unavailable until submit, cancellation, and reservation recovery are proven end to end.",
    };
  }
  if (order.venue_id === "phoenix") {
    return {
      allowed: false,
      reason_code: "phoenix_live_execution_recovery_unproven",
      message: "Phoenix live execution is unavailable until exact submit and cancellation recovery are proven end to end.",
    };
  }
  return { allowed: true, reason_code: null, message: null };
}

function tradeOrderPlanFailures(
  plan: TradeOrderPlan,
  env: Record<string, string | undefined>,
): string[] {
  const failures: string[] = [];
  if (!plan.risk_envelope) failures.push("order_plan_risk_envelope_missing");
  else if (!plan.risk_envelope.fee_evidence_at || !plan.risk_envelope.buffer_evidence_at) failures.push("order_plan_risk_evidence_time_missing");
  if (plan.network !== "mainnet") failures.push("byo_live_network_not_mainnet");
  if (
    plan.venue_id === "hyperliquid" &&
    !HYPERLIQUID_EXECUTION_PRODUCTS.has(plan.product)
  ) {
    failures.push("hyperliquid_product_not_allowed");
  }
  if (
    plan.venue_id === "phoenix" &&
    !PHOENIX_EXECUTION_PRODUCTS.has(plan.product)
  ) {
    failures.push("phoenix_product_not_allowed");
  }
  if (
    plan.venue_id === "coinbase"
  ) {
    const allowedProducts = coinbaseProductAllowlist(env);
    if (allowedProducts.size > 0 && !allowedProducts.has(plan.product)) {
      failures.push("coinbase_product_not_allowed");
    }
  }
  return failures;
}

function validRequestProofSecret(secret: string) {
  const trimmed = secret.trim();
  const lowered = trimmed.toLowerCase();
  return trimmed.length >= 32 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder"].some(
      (value) => lowered === value || lowered.includes(value),
    );
}

function envIs(env: Record<string, string | undefined>, key: string, expected: string) {
  return (env[key] ?? "").trim() === expected;
}

function capEquals(env: Record<string, string | undefined>, keys: string[], expected: number) {
  return keys.some((key) => sameNumber(Number(env[key]), expected));
}

function capAtMost(env: Record<string, string | undefined>, keys: string[], max: number) {
  return keys.some((key) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 && value <= max;
  });
}

function sameNumber(left: number, right: number) {
  return Number.isFinite(left) && Math.abs(left - right) < 0.000001;
}

function coinbaseProductAllowlist(env: Record<string, string | undefined>) {
  const configured = env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS ||
    env.GHOLA_COINBASE_ALLOWED_PRODUCTS ||
    "";
  return new Set(
    configured
      .split(",")
      .map((product) => product.trim().toUpperCase())
      .filter(Boolean),
  );
}

function jupiterApiKeyConfigured(env: Record<string, string | undefined>) {
  return env.GHOLA_JUPITER_API_KEY_READY?.trim() === "true" || [
    "GHOLA_JUPITER_API_KEY",
    "PRIVATE_AGENT_JUPITER_API_KEY",
    "JUPITER_API_KEY",
  ].some((key) => Boolean(env[key]?.trim()));
}
