import { gholaCommitment } from "@/lib/private-account";
import {
  privateAccountByoGlobalFailures,
  privateAccountByoVenueGate,
} from "@/lib/private-account-byo-live-gate";
import {
  LIVE_TRADING_CAPABILITIES,
  LIVE_TRADING_CONTRACT_VERSION,
  canonicalLiveTradingCaps,
} from "@/lib/live-trading-contract";
import {
  configuredLiveTradingPublicCapabilities,
  currentLiveTradingReleaseIdentity,
  liveTradingLaunchBindingFailures,
} from "@/lib/live-trading-release.server";
import {
  evaluateLiveTradingCapability,
  getLiveTradingLaunchControl,
} from "@/lib/live-trading-store";
import { probeLiveTradingWorkerReadiness } from "@/lib/private-agent-worker-readiness";
import { json } from "../../_lib";

const VENUES = [
  { id: "hyperliquid", label: "Hyperliquid" },
  { id: "phoenix", label: "Phoenix" },
  { id: "jupiter", label: "Jupiter" },
  { id: "coinbase", label: "Coinbase" },
] as const;

type LiveTradingStatusDependencies = { fetchImpl: typeof fetch };

export function createLiveTradingStatusGet(dependencies: LiveTradingStatusDependencies) {
  return () => handleGet(dependencies);
}

async function handleGet(dependencies: LiveTradingStatusDependencies) {
  const release = currentLiveTradingReleaseIdentity(process.env);
  const publicCapabilities = configuredLiveTradingPublicCapabilities(process.env);
  const [launch, worker] = await Promise.all([
    getLiveTradingLaunchControl(),
    probeLiveTradingWorkerReadiness({
      env: process.env,
      fetchImpl: dependencies.fetchImpl,
      expectedRelease: release,
      requiredCapabilities: publicCapabilities,
    }),
  ]);
  const capabilities = await Promise.all(LIVE_TRADING_CAPABILITIES.map((capability) =>
    evaluateLiveTradingCapability({
      capability,
      release,
      launch_state: launch.state,
      visible: publicCapabilities.includes(capability),
    })
  ));
  const requiredCapabilityFailures = capabilities
    .filter((capability) => publicCapabilities.includes(capability.id) && capability.state !== "live")
    .flatMap((capability) => capability.reason_codes.map((reason) => `${capability.id}:${reason}`));
  const globalFailures = [...new Set([
    ...privateAccountByoGlobalFailures(process.env),
    ...release.reason_codes,
    ...liveTradingLaunchBindingFailures(launch, release, publicCapabilities),
    ...worker.reason_codes,
    ...requiredCapabilityFailures,
  ])];
  const byoVenues = VENUES.map((venue) => {
    const environmentGate = privateAccountByoVenueGate(venue.id, process.env);
    const reasonCodes = venue.id === "hyperliquid"
      ? [...new Set([...environmentGate.reason_codes, ...globalFailures])]
      : [...new Set([...environmentGate.reason_codes, "venue_execution_not_in_launch"])];
    return {
      ...environmentGate,
      status: reasonCodes.length === 0 ? "green" as const : "red" as const,
      reason_codes: reasonCodes,
    };
  });
  const hyperliquidGreen = byoVenues.find((venue) => venue.id === "hyperliquid")?.status === "green";
  const requiredVenues = VENUES.map((venue) => ({
    id: venue.id,
    label: venue.label,
    submit_source: "ghola_pooled_account" as const,
    status: "red" as const,
    canary_status: "missing" as const,
    canary_report: null,
    canary_required: false,
    canary_reason_codes: ["pooled_execution_not_in_launch"],
    capital_free_proof_status: "missing" as const,
    capital_free_proof_report: null,
    capital_free_proof_reason_codes: ["pooled_execution_not_in_launch"],
    reason_codes: ["pooled_execution_not_in_launch"],
  }));
  const checkedAt = new Date().toISOString();
  const response = {
    version: 1 as const,
    contract_version: LIVE_TRADING_CONTRACT_VERSION,
    status: hyperliquidGreen ? "green" as const : "red" as const,
    launch_state: launch.state,
    live_trading_enabled: hyperliquidGreen,
    live_submit_mode: hyperliquidGreen ? "byo_mainnet" as const : "disabled" as const,
    byo_live_trading_enabled: hyperliquidGreen,
    pooled_live_trading_enabled: false,
    pooled_live_venues: [],
    pooled_capital_free_proven_venues: [],
    public_live_copy_allowed: hyperliquidGreen,
    public_market_data_enabled: process.env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED === "true",
    release_identity: release,
    live_worker_readiness: worker,
    effective_caps: canonicalLiveTradingCaps(),
    proof_policy: {
      venue_id: "hyperliquid" as const,
      network: "mainnet" as const,
      first_proof_notional_usd: canonicalLiveTradingCaps().first_proof_notional_usd,
      required_consecutive_passes: 3,
      final_flat_required: true as const,
      zero_open_orders_required: true as const,
    },
    hyperliquid_capabilities: capabilities,
    default_access_mode: "ghola_auto_access" as const,
    required_venues: requiredVenues,
    byo_live_venues: byoVenues,
    pooled_worker_readiness: {
      status: "blocked",
      ready: false,
      endpoint_configured: false,
      reason_codes: ["pooled_execution_not_in_launch"],
      checked_at: checkedAt,
    },
    pooled_reason_codes: ["pooled_execution_not_in_launch"],
    pooled_unavailable_reason_codes: ["pooled_execution_not_in_launch"],
    reason_codes: hyperliquidGreen ? [] : globalFailures,
    checked_at: checkedAt,
  };
  return json({
    ...response,
    gate_commitment: gholaCommitment("live_trading_launch_gate", response),
  });
}
