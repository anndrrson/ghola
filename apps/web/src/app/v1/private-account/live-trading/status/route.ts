import { gholaCommitment } from "@/lib/private-account";
import {
  getLatestLiveTradingCanaryReport,
  type PrivateLiveTradingCanaryReportRecordV1,
  type PrivateLiveTradingVenueId,
} from "@/lib/private-account-store";
import {
  getPooledWorkerReadiness,
  type PooledWorkerReadiness,
} from "@/lib/private-account-pooled-readiness";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

const VENUES = [
  { id: "hyperliquid", label: "Hyperliquid" },
  { id: "phoenix", label: "Phoenix" },
  { id: "jupiter", label: "Jupiter" },
  { id: "coinbase", label: "Coinbase" },
] as const;

export async function GET() {
  const [reports, capitalFreeProofs, workerReadiness] = await Promise.all([
    Promise.all(VENUES.map((venue) => getLatestLiveTradingCanaryReport(venue.id))),
    Promise.all(VENUES.map((venue) => getLatestLiveTradingCanaryReport(venue.id, "capital_free_no_submit"))),
    getPooledWorkerReadiness(process.env),
  ]);
  const venues = VENUES.map((venue, index) =>
    venuePooledLiveGate(
      venue.id,
      process.env,
      evaluateCanary(venue.id, reports[index]),
      evaluateCapitalFreeProof(venue.id, capitalFreeProofs[index]),
      workerReadiness,
    )
  );
  const pooledGlobalFailures = pooledLiveGateFailures(process.env, workerReadiness);
  const byoGlobalFailures = byoLiveGateFailures(process.env);
  const pooledUnavailableReasons = pooledGlobalFailures.concat(
    venues.flatMap((venue) => venue.reason_codes.map((reason) => `${venue.id}:${reason}`)),
  );
  const pooledReadyVenueIds = venues
    .filter((venue) => venue.status === "green")
    .map((venue) => venue.id);
  const pooledCapitalFreeProvenVenueIds = venues
    .filter((venue) => venue.capital_free_proof_status === "green")
    .map((venue) => venue.id);
  const pooledGreen = pooledGlobalFailures.length === 0 && pooledReadyVenueIds.length > 0;
  const publicLiveCopyAllowed = process.env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED === "true";
  const byoVenues = VENUES.map((venue) => venueByoLiveGate(venue.id, process.env));
  const byoGreen = byoGlobalFailures.length === 0 && byoVenues.some((venue) => venue.status === "green");
  const liveTradingEnabled = pooledGreen || byoGreen;
  const liveSubmitMode = pooledGreen && byoGreen
    ? "pooled_and_byo"
    : pooledGreen
      ? "pooled_account"
      : byoGreen
        ? "byo_mainnet"
        : "disabled";
  const reasonCodes = liveTradingEnabled
    ? []
    : byoGlobalFailures.concat(byoVenues.flatMap((venue) => venue.reason_codes.map((reason) => `${venue.id}:${reason}`)));
  return json({
    version: 1,
    status: liveTradingEnabled ? "green" : "red",
    live_trading_enabled: liveTradingEnabled,
    live_submit_mode: liveSubmitMode,
    byo_live_trading_enabled: byoGreen,
    pooled_live_trading_enabled: pooledGreen,
    pooled_live_venues: pooledReadyVenueIds,
    pooled_capital_free_proven_venues: pooledCapitalFreeProvenVenueIds,
    public_live_copy_allowed: publicLiveCopyAllowed,
    public_market_data_enabled: publicLiveCopyAllowed,
    default_access_mode: "ghola_auto_access",
    pooled_worker_readiness: {
      status: workerReadiness.status,
      ready: workerReadiness.ready,
      endpoint_configured: workerReadiness.endpoint_configured,
      reason_codes: workerReadiness.reason_codes,
      checked_at: workerReadiness.checked_at,
    },
    required_venues: venues,
    byo_live_venues: byoVenues,
    pooled_reason_codes: pooledGreen ? [] : pooledUnavailableReasons,
    pooled_unavailable_reason_codes: pooledUnavailableReasons,
    reason_codes: reasonCodes,
    gate_commitment: gholaCommitment("live_trading_launch_gate", {
      live_submit_mode: liveSubmitMode,
      pooled_live_venues: pooledReadyVenueIds,
      byo_venues: byoVenues.map((venue) => ({
        id: venue.id,
        status: venue.status,
        reason_codes: venue.reason_codes,
      })),
      venues: venues.map((venue) => ({
        id: venue.id,
        status: venue.status,
        canary_status: venue.canary_status,
        canary_evidence_commitment: venue.canary_report?.evidence_commitment ?? null,
        capital_free_proof_status: venue.capital_free_proof_status,
        capital_free_proof_evidence_commitment: venue.capital_free_proof_report?.evidence_commitment ?? null,
        reason_codes: venue.reason_codes,
      })),
      byo_global_failures: byoGlobalFailures,
      pooled_global_failures: pooledGlobalFailures,
      pooled_unavailable_reasons: pooledUnavailableReasons,
    }),
    checked_at: new Date().toISOString(),
  });
}

function byoLiveGateFailures(env: Record<string, string | undefined>) {
  const failures: string[] = [];
  if (!envIs(env, "GHOLA_LIVE_TRADING_PUBLIC_ENABLED", "true")) failures.push("live_trading_public_flag_disabled");
  if (envIs(env, "PRIVATE_AGENT_VENUE_DRY_RUN", "true")) failures.push("venue_dry_run_enabled");
  if (!validRequestProofSecret(env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET || "")) failures.push("request_proof_secret_missing");
  if (!capEnvEquals(env, ["GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD"], 1_000)) {
    failures.push("launch_max_order_cap_missing");
  }
  if (!capEnvEquals(env, ["GHOLA_LIVE_TRADING_DAILY_CAP_USD"], 5_000)) {
    failures.push("launch_daily_cap_missing");
  }
  if (!capEnvAtMost(env, ["GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS"], 100)) {
    failures.push("launch_slippage_cap_missing");
  }
  return failures;
}

function pooledLiveGateFailures(
  env: Record<string, string | undefined>,
  workerReadiness: PooledWorkerReadiness,
) {
  return [...new Set(byoLiveGateFailures(env).concat(workerReadiness.reason_codes))];
}

function venueByoLiveGate(
  id: (typeof VENUES)[number]["id"],
  env: Record<string, string | undefined>,
) {
  const reasonCodes: string[] = [];
  if (id === "hyperliquid") {
    if (!envIs(env, "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED", "true")) reasonCodes.push("hyperliquid_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "true")) reasonCodes.push("hyperliquid_mainnet_worker_disabled");
    if (!envIs(env, "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", "full_ticket")) {
      reasonCodes.push("hyperliquid_worker_full_ticket_disabled");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("hyperliquid_max_order_cap_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"], 5_000)) {
      reasonCodes.push("hyperliquid_daily_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("hyperliquid_slippage_cap_missing");
    }
  }
  if (id === "phoenix") {
    if (!envIs(env, "GHOLA_VENUE_PHOENIX_PILOT_ENABLED", "true")) reasonCodes.push("phoenix_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", "true")) reasonCodes.push("phoenix_mainnet_worker_disabled");
    if (
      !envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "full_ticket") &&
      !envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "sdk_runner")
    ) {
      reasonCodes.push("phoenix_worker_live_mode_disabled");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("phoenix_max_order_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", "GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("phoenix_slippage_cap_missing");
    }
  }
  if (id === "jupiter") {
    if (!envIs(env, "GHOLA_VENUE_JUPITER_PILOT_ENABLED", "true")) reasonCodes.push("jupiter_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_JUPITER_LIVE_MODE", "full")) reasonCodes.push("jupiter_worker_full_mode_disabled");
    if (!jupiterApiKeyConfigured(env)) {
      reasonCodes.push("jupiter_api_key_missing");
    }
    if (!env.GHOLA_JUPITER_ALLOWED_INPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS?.trim()) {
      reasonCodes.push("jupiter_input_mint_allowlist_missing");
    }
    if (!env.GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS?.trim()) {
      reasonCodes.push("jupiter_output_mint_allowlist_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", "GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("jupiter_max_order_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", "GHOLA_JUPITER_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("jupiter_slippage_cap_missing");
    }
  }
  if (id === "coinbase") {
    if (!envIs(env, "GHOLA_V6_COINBASE_PILOT_ENABLED", "true")) reasonCodes.push("coinbase_pilot_disabled");
    if (!envIs(env, "PRIVATE_AGENT_COINBASE_LIVE_MODE", "full")) reasonCodes.push("coinbase_worker_full_mode_disabled");
    if (!env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS?.trim() && !env.GHOLA_COINBASE_ALLOWED_PRODUCTS?.trim()) {
      reasonCodes.push("coinbase_product_allowlist_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", "GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("coinbase_max_order_cap_missing");
    }
  }
  return {
    id,
    label: VENUES.find((venue) => venue.id === id)?.label ?? id,
    submit_source: "user_scoped_credential",
    status: reasonCodes.length === 0 ? "green" : "red",
    reason_codes: reasonCodes,
  };
}

function venuePooledLiveGate(
  id: (typeof VENUES)[number]["id"],
  env: Record<string, string | undefined>,
  canary: ReturnType<typeof evaluateCanary>,
  capitalFreeProof: ReturnType<typeof evaluateCapitalFreeProof>,
  workerReadiness: PooledWorkerReadiness,
) {
  const reasonCodes: string[] = [];
  const workerVenue = workerReadiness.venues[id];
  if (id === "hyperliquid") {
    if (!envIs(env, "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED", "true")) reasonCodes.push("hyperliquid_pilot_disabled");
    if (!envIs(env, "GHOLA_HYPERLIQUID_LIVE_MODE", "full_ticket")) {
      reasonCodes.push("hyperliquid_live_mode_disabled");
    }
    if (!envIs(env, "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "true")) reasonCodes.push("hyperliquid_mainnet_worker_disabled");
    if (!capEnvEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("hyperliquid_max_order_cap_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"], 5_000)) {
      reasonCodes.push("hyperliquid_daily_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("hyperliquid_slippage_cap_missing");
    }
  }
  if (id === "phoenix") {
    if (!envIs(env, "GHOLA_VENUE_PHOENIX_PILOT_ENABLED", "true")) reasonCodes.push("phoenix_pilot_disabled");
    if (
      !envIs(env, "GHOLA_SOLANA_PERPS_LIVE_MODE", "full_ticket") &&
      !envIs(env, "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "full_ticket")
    ) {
      reasonCodes.push("phoenix_live_mode_disabled");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("phoenix_max_order_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", "GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("phoenix_slippage_cap_missing");
    }
  }
  if (id === "jupiter") {
    if (!envIs(env, "GHOLA_VENUE_JUPITER_PILOT_ENABLED", "true")) reasonCodes.push("jupiter_pilot_disabled");
    if (!envIs(env, "GHOLA_JUPITER_LIVE_MODE", "full") && !envIs(env, "PRIVATE_AGENT_JUPITER_LIVE_MODE", "full")) {
      reasonCodes.push("jupiter_live_mode_disabled");
    }
    if (!jupiterApiKeyConfigured(env)) {
      reasonCodes.push("jupiter_api_key_missing");
    }
    if (!env.GHOLA_JUPITER_ALLOWED_INPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS?.trim()) {
      reasonCodes.push("jupiter_input_mint_allowlist_missing");
    }
    if (!env.GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS?.trim() && !env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS?.trim()) {
      reasonCodes.push("jupiter_output_mint_allowlist_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", "GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("jupiter_max_order_cap_missing");
    }
    if (!capEnvAtMost(env, ["PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", "GHOLA_JUPITER_MAX_SLIPPAGE_BPS"], 100)) {
      reasonCodes.push("jupiter_slippage_cap_missing");
    }
  }
  if (id === "coinbase") {
    if (!envIs(env, "GHOLA_V6_COINBASE_PILOT_ENABLED", "true")) reasonCodes.push("coinbase_pilot_disabled");
    if (!envIs(env, "GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED", "true")) reasonCodes.push("coinbase_omnibus_disabled");
    if (!envIs(env, "GHOLA_COINBASE_LIVE_MODE", "full") && !envIs(env, "PRIVATE_AGENT_COINBASE_LIVE_MODE", "full")) {
      reasonCodes.push("coinbase_live_mode_disabled");
    }
    if (!env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS?.trim() && !env.GHOLA_COINBASE_ALLOWED_PRODUCTS?.trim()) {
      reasonCodes.push("coinbase_product_allowlist_missing");
    }
    if (!capEnvEquals(env, ["PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", "GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD"], 1_000)) {
      reasonCodes.push("coinbase_max_order_cap_missing");
    }
  }
  if (!workerReadiness.ready && workerReadiness.reason_codes.length > 0) {
    reasonCodes.push(...workerReadiness.reason_codes);
  }
  if (!workerVenue?.ready) {
    reasonCodes.push(...(workerVenue?.reason_codes ?? ["pooled_worker_venue_not_ready"]));
  }
  return {
    id,
    label: VENUES.find((venue) => venue.id === id)?.label ?? id,
    submit_source: "ghola_pooled_account",
    status: reasonCodes.length === 0 ? "green" : "red",
    canary_status: canary.status,
    canary_report: canary.report,
    canary_required: false,
    canary_reason_codes: canary.reason_codes,
    capital_free_proof_status: capitalFreeProof.status,
    capital_free_proof_report: capitalFreeProof.report,
    capital_free_proof_reason_codes: capitalFreeProof.reason_codes,
    reason_codes: [...new Set(reasonCodes)],
  };
}

function evaluateCanary(
  venueId: PrivateLiveTradingVenueId,
  report: PrivateLiveTradingCanaryReportRecordV1 | null,
) {
  if (!report) {
    return {
      status: "missing" as const,
      reason_codes: ["funded_full_ticket_canary_missing"],
      report: null,
    };
  }

  const reasonCodes: string[] = [];
  const now = Date.now();
  const observedAt = Date.parse(report.observed_at);
  const expiresAt = Date.parse(report.expires_at);
  const maxStaleMs = positiveIntegerEnv("GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS", 24 * 60 * 60 * 1_000);
  const requiredMaxOrderUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD", 1_000);
  const requiredDailyCapUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_DAILY_CAP_USD", 5_000);
  const requiredMaxSlippageBps = positiveIntegerEnv("GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS", 100);

  if (report.venue_id !== venueId) reasonCodes.push("funded_full_ticket_canary_wrong_venue");
  if (report.network !== "mainnet") reasonCodes.push("funded_full_ticket_canary_wrong_network");
  if (report.status !== "green") reasonCodes.push("funded_full_ticket_canary_failed");
  if (report.live_mode !== "full_ticket" || report.canary_kind !== "full_ticket_broadcast") {
    reasonCodes.push("full_ticket_canary_required");
  }
  if (!report.broadcast_performed) reasonCodes.push("canary_broadcast_missing");
  if (report.reconcile_status !== "reconciled") reasonCodes.push("canary_reconcile_missing");
  if (!report.receipt_commitment || !report.result_commitment) reasonCodes.push("canary_commitment_missing");
  if (
    !Number.isFinite(report.order_notional_usd) ||
    report.order_notional_usd <= 0 ||
    report.order_notional_usd > requiredMaxOrderUsd
  ) {
    reasonCodes.push("canary_order_notional_invalid");
  }
  if (
    !sameNumber(report.max_order_notional_usd, requiredMaxOrderUsd) ||
    !sameNumber(report.daily_cap_usd, requiredDailyCapUsd) ||
    report.max_slippage_bps > requiredMaxSlippageBps
  ) {
    reasonCodes.push("canary_cap_mismatch");
  }
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    now - observedAt > maxStaleMs
  ) {
    reasonCodes.push("funded_full_ticket_canary_stale");
  }

  const status = reasonCodes.includes("funded_full_ticket_canary_stale")
    ? "stale"
    : reasonCodes.length > 0
      ? "red"
      : "green";
  return {
    status,
    reason_codes: reasonCodes,
    report: {
      report_id: report.report_id,
      network: report.network,
      observed_at: report.observed_at,
      expires_at: report.expires_at,
      evidence_commitment: report.evidence_commitment,
      receipt_commitment: report.receipt_commitment,
      result_commitment: report.result_commitment,
      order_notional_usd: report.order_notional_usd,
      max_order_notional_usd: report.max_order_notional_usd,
      daily_cap_usd: report.daily_cap_usd,
      max_slippage_bps: report.max_slippage_bps,
    },
  };
}

function evaluateCapitalFreeProof(
  venueId: PrivateLiveTradingVenueId,
  report: PrivateLiveTradingCanaryReportRecordV1 | null,
) {
  if (!report) {
    return {
      status: "missing" as const,
      reason_codes: ["capital_free_no_submit_proof_missing"],
      report: null,
    };
  }

  const reasonCodes: string[] = [];
  const now = Date.now();
  const observedAt = Date.parse(report.observed_at);
  const expiresAt = Date.parse(report.expires_at);
  const maxStaleMs = positiveIntegerEnv("GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS", 24 * 60 * 60 * 1_000);
  const requiredMaxOrderUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD", 1_000);
  const requiredDailyCapUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_DAILY_CAP_USD", 5_000);
  const requiredMaxSlippageBps = positiveIntegerEnv("GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS", 100);

  if (report.venue_id !== venueId) reasonCodes.push("capital_free_proof_wrong_venue");
  if (report.network !== "mainnet") reasonCodes.push("capital_free_proof_wrong_network");
  if (report.status !== "green") reasonCodes.push("capital_free_proof_failed");
  if (report.live_mode !== "no_submit" || report.canary_kind !== "capital_free_no_submit") {
    reasonCodes.push("capital_free_no_submit_proof_required");
  }
  if (report.broadcast_performed) reasonCodes.push("capital_free_proof_broadcast_performed");
  if (report.reconcile_status !== "reconciled") reasonCodes.push("capital_free_proof_reconcile_missing");
  if (!report.receipt_commitment || !report.result_commitment) reasonCodes.push("capital_free_proof_commitment_missing");
  if (
    !Number.isFinite(report.order_notional_usd) ||
    report.order_notional_usd <= 0 ||
    report.order_notional_usd > requiredMaxOrderUsd
  ) {
    reasonCodes.push("capital_free_proof_order_notional_invalid");
  }
  if (
    !sameNumber(report.max_order_notional_usd, requiredMaxOrderUsd) ||
    !sameNumber(report.daily_cap_usd, requiredDailyCapUsd) ||
    report.max_slippage_bps > requiredMaxSlippageBps
  ) {
    reasonCodes.push("capital_free_proof_cap_mismatch");
  }
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    now - observedAt > maxStaleMs
  ) {
    reasonCodes.push("capital_free_proof_stale");
  }

  return {
    status: reasonCodes.length === 0 ? "green" as const : "red" as const,
    reason_codes: reasonCodes,
    report,
  };
}

function validRequestProofSecret(secret: string) {
  const trimmed = secret.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  return trimmed.length >= 32 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder"].some((value) =>
      lowered === value || lowered.includes(value)
    );
}

function envIs(env: Record<string, string | undefined>, key: string, expected: string): boolean {
  return (env[key] ?? "").trim() === expected;
}

function positiveNumberEnv(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sameNumber(a: number, b: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) < 0.000001;
}

function capEnvEquals(env: Record<string, string | undefined>, keys: string[], expected: number): boolean {
  return keys.some((key) => sameNumber(Number(env[key]), expected));
}

function capEnvAtMost(env: Record<string, string | undefined>, keys: string[], max: number): boolean {
  return keys.some((key) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 && value <= max;
  });
}

function jupiterApiKeyConfigured(env: Record<string, string | undefined>): boolean {
  return envFlag(env, "GHOLA_JUPITER_API_KEY_READY") ||
    envPresent(env, [
      "GHOLA_JUPITER_API_KEY",
      "PRIVATE_AGENT_JUPITER_API_KEY",
      "JUPITER_API_KEY",
    ]);
}

function envFlag(env: Record<string, string | undefined>, key: string): boolean {
  return (env[key] ?? "").trim() === "true";
}

function envPresent(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()));
}
