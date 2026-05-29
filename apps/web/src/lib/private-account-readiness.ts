import { gholaCommitment, type GholaPlatformClass, type GholaRailKind } from "./private-account";
import type { PaymentHealth } from "./private-balance";
import { summarizePrivateBalance } from "./private-balance";

export type PrivateAccountReadinessStatus = "ready" | "missing" | "stale" | "blocked";

export interface PrivateAccountPlatformReadiness {
  version: 1;
  platform_class: GholaPlatformClass;
  status: PrivateAccountReadinessStatus;
  readiness_commitment: string;
  ready_rails: GholaRailKind[];
  reason_codes: string[];
}

export interface PrivateAccountReadinessResponse {
  version: 1;
  profiles: PrivateAccountPlatformReadiness[];
}

export function privateAccountReadiness(input: {
  paymentHealth?: PaymentHealth | null;
  env?: Record<string, string | undefined>;
} = {}): PrivateAccountReadinessResponse {
  const env = input.env ?? process.env;
  const balance = summarizePrivateBalance(input.paymentHealth);
  const shieldedReady = balance.privateSpendReady;
  const hyperliquid = hyperliquidReadiness(env, shieldedReady);
  const coinbase = env.GHOLA_COINBASE_PROVIDER_READINESS || "missing";
  const rfqSolverCount = Number.parseInt(env.GHOLA_RFQ_SOLVER_COUNT || "0", 10);
  const partnerReady = env.GHOLA_PARTNER_ASSETS_READY === "true";

  return {
    version: 1,
    profiles: [
      readiness("solana_public_wallet", "ready", ["direct_public_fallback"], ["public_settlement_degraded"]),
      readiness(
        "solana_private_balance",
        shieldedReady ? "ready" : "missing",
        shieldedReady ? ["shielded_pool", "combined_vault_shielded_batch"] : [],
        shieldedReady ? [] : ["shielded_rail_unavailable"],
      ),
      readiness(
        "hyperliquid_style_market",
        hyperliquid.status,
        hyperliquid.status === "ready" ? hyperliquid.ready_rails : [],
        hyperliquid.reason_codes,
      ),
      readiness(
        "solana_perps_market",
        env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" && shieldedReady ? "ready" : "missing",
        shieldedReady ? ["shielded_pool", "combined_vault_shielded_batch"] : [],
        [
          ...(shieldedReady ? [] : ["shielded_rail_unavailable"]),
          ...(env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" ? ["venue_visible_order_degraded"] : ["solana_perps_connector_unavailable"]),
        ],
      ),
      readiness(
        "solana_swap_aggregator",
        env.GHOLA_VENUE_JUPITER_PILOT_ENABLED === "true" && shieldedReady ? "ready" : "missing",
        shieldedReady ? ["shielded_pool", "combined_vault_shielded_batch"] : [],
        [
          ...(shieldedReady ? [] : ["shielded_rail_unavailable"]),
          ...(env.GHOLA_VENUE_JUPITER_PILOT_ENABLED === "true" ? ["route_visible_if_public_settlement"] : ["solana_swap_connector_unavailable"]),
        ],
      ),
      readiness(
        "coinbase_style_provider",
        normalizeConnectorStatus(coinbase),
        shieldedReady && coinbase === "ready" ? ["shielded_pool"] : [],
        [
          ...(shieldedReady ? [] : ["shielded_rail_unavailable"]),
          ...(coinbase === "ready" ? ["provider_visible_activity_degraded"] : ["coinbase_provider_unavailable"]),
        ],
      ),
      readiness(
        "rfq_solver_network",
        rfqSolverCount >= 5 && shieldedReady ? "ready" : "blocked",
        rfqSolverCount >= 5 && shieldedReady ? ["shielded_pool"] : [],
        [
          ...(shieldedReady ? [] : ["shielded_rail_unavailable"]),
          ...(rfqSolverCount >= 5 ? [] : ["rfq_solver_set_below_minimum"]),
        ],
      ),
      readiness(
        "partner_tokenized_assets",
        partnerReady ? "ready" : "blocked",
        partnerReady && shieldedReady ? ["shielded_pool"] : [],
        partnerReady ? [] : ["partner_compliance_required"],
      ),
    ],
  };
}

function readiness(
  platformClass: GholaPlatformClass,
  status: PrivateAccountReadinessStatus,
  readyRails: GholaRailKind[],
  reasonCodes: string[],
): PrivateAccountPlatformReadiness {
  return {
    version: 1,
    platform_class: platformClass,
    status,
    readiness_commitment: gholaCommitment("ready", { platformClass, status, readyRails, reasonCodes }),
    ready_rails: readyRails,
    reason_codes: reasonCodes,
  };
}

function normalizeConnectorStatus(value: string): PrivateAccountReadinessStatus {
  if (value === "ready" || value === "stale") return value;
  return "missing";
}

function hyperliquidReadiness(
  env: Record<string, string | undefined>,
  shieldedReady: boolean,
): { status: PrivateAccountReadinessStatus; reason_codes: string[]; ready_rails: GholaRailKind[] } {
  const reasonCodes: string[] = [];
  const liveTinyFill = env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill";
  const connectorReady =
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS === "ready" ||
    env.GHOLA_HYPERLIQUID_READINESS === "ready";
  if (env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED !== "true") {
    reasonCodes.push("hyperliquid_pilot_disabled");
  }
  if (!liveTinyFill && !shieldedReady && env.GHOLA_HYPERLIQUID_SHIELDED_FUNDING_READY !== "true") {
    reasonCodes.push("shielded_rail_unavailable");
  }
  if (!liveTinyFill && env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY !== "true") {
    reasonCodes.push("venue_access_required", "hyperliquid_execution_vault_not_ready");
  }
  if (!env.GHOLA_PRIVATE_RUNTIME_URL && env.GHOLA_PRIVATE_RUNTIME_MODE !== "local_test") {
    reasonCodes.push("sealed_runtime_unavailable");
  }
  if (!connectorReady) reasonCodes.push("hyperliquid_connector_unavailable");
  if (connectorReady) reasonCodes.push("venue_visible_order_degraded");
  const status: PrivateAccountReadinessStatus = reasonCodes.some((reason) =>
      reason.endsWith("_disabled") ||
      reason.endsWith("_unavailable") ||
      reason.endsWith("_not_ready")
    )
      ? "blocked"
      : "ready";
  return {
    status,
    reason_codes: reasonCodes,
    ready_rails: liveTinyFill ? ["direct_public_fallback"] : ["shielded_pool"],
  };
}
