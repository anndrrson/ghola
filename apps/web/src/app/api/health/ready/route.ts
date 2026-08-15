import { NextResponse } from "next/server";
import { consumerProductionStoreReady, getConsumerCircuitState, getConsumerReconciliationHealth } from "@/lib/consumer-production-store";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { customShieldedVerifierHealth } from "@/lib/private-account-verifier";
import { shieldedPoolHealth } from "@/lib/private-account-shielded-pool";
import { consumerTreasuryConfigured } from "@/lib/consumer-turnkey-treasury";
import { getCrossVenueReconciliationHealth } from "@/lib/cross-venue-execution-store";
import { probeCrossVenueExecutionReadiness } from "@/lib/cross-venue-worker";
import {
  probeConfiguredAutopilotWorkerReadiness,
  probeLiveTradingWorkerReadiness,
} from "@/lib/private-agent-worker-readiness";
import {
  configuredLiveTradingPublicCapabilities,
  currentLiveTradingReleaseIdentity,
  liveTradingLaunchBindingFailures,
} from "@/lib/live-trading-release.server";
import {
  evaluateLiveTradingCapability,
  getLiveTradingLaunchControl,
} from "@/lib/live-trading-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const checkedAt = new Date().toISOString();
  const liveRelease = currentLiveTradingReleaseIdentity();
  const publicCapabilities = configuredLiveTradingPublicCapabilities();
  const launchProfile = process.env.GHOLA_CONSUMER_LAUNCH_PROFILE === "byo_hyperliquid"
    ? "byo_hyperliquid" as const
    : "pooled_consumer" as const;
  const pooledRequired = launchProfile === "pooled_consumer";
  const [database, circuit, reconciliation, crossVenueReconciliation, crossVenue, runtime, verifier, shieldedPool, consumerWorker, autopilotWorker, liveLaunch, liveWorker] = await Promise.all([
    consumerProductionStoreReady().catch(() => false),
    getConsumerCircuitState().catch(() => null),
    getConsumerReconciliationHealth().catch(() => null),
    getCrossVenueReconciliationHealth().catch(() => null),
    probeCrossVenueExecutionReadiness().catch(() => null),
    getPrivateAgentRuntimeStatus().catch(() => null),
    customShieldedVerifierHealth().catch(() => null),
    shieldedPoolHealth().catch(() => null),
    consumerWorkerReadiness().catch(() => null),
    probeConfiguredAutopilotWorkerReadiness().catch(() => ({
      ok: false,
      error: "worker_unavailable",
      missing: [],
      status: null,
    })),
    getLiveTradingLaunchControl().catch(() => null),
    probeLiveTradingWorkerReadiness({
      expectedRelease: liveRelease,
      requiredCapabilities: publicCapabilities,
    }).catch(() => null),
  ]);
  const phala = runtime?.providers.find((provider) => provider.id === "phala");
  const cvmStatus = phala?.evidence && typeof phala.evidence === "object"
    ? String((phala.evidence as { cvm_status?: unknown }).cvm_status || "unknown")
    : "unknown";
  const workerState = runtime?.remote_execution_ready && runtime.selected_provider === "phala"
    ? "ready"
    : phala?.configured && ["stopped", "starting", "unknown"].includes(cvmStatus)
      ? "sleeping_wakeable"
      : "blocked";
  const sentryConfigured = Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);
  const vercelObservabilityConfigured = process.env.GHOLA_OBSERVABILITY_PROVIDER === "vercel" &&
    process.env.VERCEL_ENV === "production";
  const observabilityConfigured = sentryConfigured || vercelObservabilityConfigured;
  const liveCapabilities = liveLaunch ? await Promise.all(publicCapabilities.map((capability) =>
    evaluateLiveTradingCapability({
      capability,
      release: liveRelease,
      launch_state: liveLaunch.state,
      visible: true,
    }).catch(() => null)
  )) : [];
  const launchBindingFailures = liveLaunch
    ? liveTradingLaunchBindingFailures(liveLaunch, liveRelease, publicCapabilities)
    : ["live_launch_state_unavailable"];
  const byoHyperliquidReady = liveRelease.valid && liveWorker?.ready === true &&
    launchBindingFailures.length === 0 && liveCapabilities.length === publicCapabilities.length &&
    liveCapabilities.every((capability) => capability?.state === "live") && workerState !== "blocked";
  const checks = {
    database: database ? "ready" : "blocked",
    trading_circuit: circuit?.status === "open" ? "ready" : "halted",
    worker: workerState,
    autopilot_worker: autopilotWorker.ok ? "ready" : "blocked",
    byo_hyperliquid: launchProfile === "byo_hyperliquid" ? (byoHyperliquidReady ? "ready" : "blocked") : "not_required",
    consumer_worker_core: pooledRequired ? (consumerWorker?.ready === true ? "ready" : "blocked") : "not_required",
    public_usdc: pooledRequired ? (process.env.GHOLA_CONSUMER_PREPAID_BALANCE_ENABLED === "true" && consumerTreasuryConfigured() ? "configured" : "blocked") : "not_required",
    shielded_verifier: pooledRequired ? (verifier?.status === "green" ? "ready" : "blocked") : "not_required",
    shielded_pool: pooledRequired ? (shieldedPool?.status === "green" ? "ready" : "blocked") : "not_required",
    sentry: sentryConfigured ? "configured" : vercelObservabilityConfigured ? "not_required" : "blocked",
    observability: observabilityConfigured ? "configured" : "blocked",
    reconciliation: reconciliation?.ready ? "ready" : "blocked",
    cross_venue_execution: crossVenue?.enabled ? (crossVenue.ready && crossVenueReconciliation?.ready ? "ready" : "blocked") : "not_required",
    funding_verifier: pooledRequired ? (process.env.GHOLA_CONSUMER_SOLANA_RPC_URL ? "configured" : "blocked") : "not_required",
    withdrawal_signer: pooledRequired ? (consumerTreasuryConfigured() ? "configured" : "blocked") : "not_required",
    withdrawal_finalizer: pooledRequired ? (consumerWorker?.withdrawal_loop === "durable" ? "configured" : "blocked") : "not_required",
    venue_connectivity: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL ? "configured" : "blocked",
    trading_control: process.env.GHOLA_TRADING_CONTROL_TOKEN && process.env.GHOLA_RECONCILIATION_INGEST_TOKEN ? "configured" : "blocked",
  } as const;
  const pooledReady = !pooledRequired || (
    checks.consumer_worker_core === "ready" && checks.public_usdc === "configured" &&
    checks.shielded_verifier === "ready" && checks.shielded_pool === "ready" &&
    checks.funding_verifier === "configured" && checks.withdrawal_signer === "configured" && checks.withdrawal_finalizer === "configured"
  );
  const ready = database && circuit?.status === "open" && workerState !== "blocked" && autopilotWorker.ok && pooledReady &&
    (launchProfile !== "byo_hyperliquid" || checks.byo_hyperliquid === "ready") &&
    checks.observability === "configured" && checks.reconciliation === "ready" &&
    checks.cross_venue_execution !== "blocked" &&
    checks.venue_connectivity === "configured" && checks.trading_control === "configured";
  console.log(JSON.stringify({ level: "info", message: "production_readiness_checked", ready, launch_profile: launchProfile, checks, checked_at: checkedAt }));
  return NextResponse.json({
    status: ready ? "ready" : "blocked",
    ready,
    launch_profile: launchProfile,
    checks,
    reconciliation: reconciliation ? {
      overdue_order_count: reconciliation.overdue_order_count,
      oldest_unreconciled_age_ms: reconciliation.oldest_unreconciled_age_ms,
    } : null,
    cross_venue_reconciliation: crossVenueReconciliation ? {
      overdue_execution_count: crossVenueReconciliation.overdue_execution_count,
      oldest_unreconciled_age_ms: crossVenueReconciliation.oldest_unreconciled_age_ms,
    } : null,
    autopilot_worker: {
      status: autopilotWorker.status,
      error: autopilotWorker.error,
      missing: autopilotWorker.missing,
    },
    live_trading: {
      contract_version: liveRelease.contract_version,
      launch_state: liveLaunch?.state ?? "unavailable",
      release_valid: liveRelease.valid,
      worker_ready: liveWorker?.ready === true,
      public_capabilities: publicCapabilities,
      reason_codes: [...new Set([
        ...liveRelease.reason_codes,
        ...launchBindingFailures,
        ...(liveWorker?.reason_codes ?? ["live_worker_unavailable"]),
        ...liveCapabilities.flatMap((capability) => capability?.reason_codes ?? ["capability_evidence_unavailable"]),
      ])],
    },
    reason_codes: Object.entries(checks).filter(([, value]) => value === "blocked" || value === "halted").map(([key, value]) => `${key}:${value}`),
    checked_at: checkedAt,
  }, {
    status: ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

async function consumerWorkerReadiness() {
  const base = process.env.PRIVATE_AGENT_WORKER_URL?.trim() || process.env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim();
  if (!base) return null;
  const response = await fetch(new URL("/consumer/ready", base), { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return null;
  return response.json() as Promise<{ ready?: boolean; withdrawal_loop?: string }>;
}
