import { NextResponse } from "next/server";
import { consumerProductionStoreReady, getConsumerCircuitState, getConsumerReconciliationHealth } from "@/lib/consumer-production-store";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { customShieldedVerifierHealth } from "@/lib/private-account-verifier";
import { shieldedPoolHealth } from "@/lib/private-account-shielded-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const checkedAt = new Date().toISOString();
  const launchProfile = process.env.GHOLA_CONSUMER_LAUNCH_PROFILE === "byo_hyperliquid"
    ? "byo_hyperliquid" as const
    : "pooled_consumer" as const;
  const pooledRequired = launchProfile === "pooled_consumer";
  const [database, circuit, reconciliation, runtime, verifier, shieldedPool, consumerWorker] = await Promise.all([
    consumerProductionStoreReady().catch(() => false),
    getConsumerCircuitState().catch(() => null),
    getConsumerReconciliationHealth().catch(() => null),
    getPrivateAgentRuntimeStatus().catch(() => null),
    customShieldedVerifierHealth().catch(() => null),
    shieldedPoolHealth().catch(() => null),
    consumerWorkerReadiness().catch(() => null),
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
  const byoHyperliquidReady = process.env.GHOLA_HYPERLIQUID_LIVE_MODE === "full_ticket" &&
    process.env.GHOLA_HYPERLIQUID_ALLOW_MAINNET === "true" &&
    Boolean(process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL) &&
    Boolean(process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN) &&
    workerState !== "blocked";
  const checks = {
    database: database ? "ready" : "blocked",
    trading_circuit: circuit?.status === "open" ? "ready" : "halted",
    worker: workerState,
    byo_hyperliquid: launchProfile === "byo_hyperliquid" ? (byoHyperliquidReady ? "ready" : "blocked") : "not_required",
    consumer_worker_core: pooledRequired ? (consumerWorker?.ready === true ? "ready" : "blocked") : "not_required",
    public_usdc: pooledRequired ? (process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT ? "configured" : "blocked") : "not_required",
    shielded_verifier: pooledRequired ? (verifier?.status === "green" ? "ready" : "blocked") : "not_required",
    shielded_pool: pooledRequired ? (shieldedPool?.status === "green" ? "ready" : "blocked") : "not_required",
    sentry: sentryConfigured ? "configured" : vercelObservabilityConfigured ? "not_required" : "blocked",
    observability: observabilityConfigured ? "configured" : "blocked",
    reconciliation: reconciliation?.ready ? "ready" : "blocked",
    funding_verifier: pooledRequired ? (process.env.GHOLA_CONSUMER_SOLANA_RPC_URL ? "configured" : "blocked") : "not_required",
    withdrawal_dispatch: pooledRequired ? (consumerWorker?.withdrawal_loop === "durable" ? "configured" : "blocked") : "not_required",
    venue_connectivity: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL ? "configured" : "blocked",
    trading_control: process.env.GHOLA_TRADING_CONTROL_TOKEN && process.env.GHOLA_RECONCILIATION_INGEST_TOKEN ? "configured" : "blocked",
  } as const;
  const pooledReady = !pooledRequired || (
    checks.consumer_worker_core === "ready" && checks.public_usdc === "configured" &&
    checks.shielded_verifier === "ready" && checks.shielded_pool === "ready" &&
    checks.funding_verifier === "configured" && checks.withdrawal_dispatch === "configured"
  );
  const ready = database && circuit?.status === "open" && workerState !== "blocked" && pooledReady &&
    (launchProfile !== "byo_hyperliquid" || checks.byo_hyperliquid === "ready") &&
    checks.observability === "configured" && checks.reconciliation === "ready" &&
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
