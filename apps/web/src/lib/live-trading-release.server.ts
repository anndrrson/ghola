import { gholaCommitment } from "./private-account";
import {
  LIVE_TRADING_CONTRACT_VERSION,
  canonicalLiveTradingCaps,
  configuredLiveTradingCapabilities,
  liveTradingConfigSnapshot,
  liveTradingConfigurationFailures,
  liveTradingReleaseFailures,
  liveTradingReleaseFields,
  type LiveTradingCapabilityId,
  type LiveTradingReleaseIdentity,
} from "./live-trading-contract";

export function currentLiveTradingReleaseIdentity(
  env: Record<string, string | undefined> = process.env,
): LiveTradingReleaseIdentity {
  const releaseFields = liveTradingReleaseFields(env);
  const reasonCodes = [...new Set([
    ...liveTradingConfigurationFailures(env),
    ...liveTradingReleaseFailures(releaseFields),
  ])];
  return {
    contract_version: LIVE_TRADING_CONTRACT_VERSION,
    ...releaseFields,
    config_fingerprint: gholaCommitment("live_trading_config", liveTradingConfigSnapshot(env)),
    valid: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

export function liveTradingLaunchBindingFailures(
  control: {
    state: string;
    contract_version: number;
    web_git_sha: string | null;
    worker_git_sha: string | null;
    worker_image_digest: string | null;
    config_fingerprint: string | null;
    public_capabilities: LiveTradingCapabilityId[];
    caps: unknown;
  },
  release: LiveTradingReleaseIdentity,
  configuredCapabilities: LiveTradingCapabilityId[],
) {
  return liveTradingControlBindingFailures(control, release, configuredCapabilities, ["public"]);
}

export function liveTradingControlBindingFailures(
  control: {
    state: string;
    contract_version: number;
    web_git_sha: string | null;
    worker_git_sha: string | null;
    worker_image_digest: string | null;
    config_fingerprint: string | null;
    public_capabilities: LiveTradingCapabilityId[];
    caps: unknown;
  },
  release: LiveTradingReleaseIdentity,
  configuredCapabilities: LiveTradingCapabilityId[],
  allowedStates: string[],
) {
  const failures: string[] = [];
  if (control.state === "killed") failures.push("live_trading_killed");
  else if (!allowedStates.includes(control.state)) failures.push("live_trading_launch_state_invalid");
  if (control.contract_version !== LIVE_TRADING_CONTRACT_VERSION) failures.push("launch_contract_version_mismatch");
  if (control.web_git_sha !== release.web_git_sha || control.worker_git_sha !== release.worker_git_sha ||
    control.worker_image_digest !== release.worker_image_digest || control.config_fingerprint !== release.config_fingerprint) {
    failures.push("launch_release_binding_mismatch");
  }
  if (JSON.stringify([...control.public_capabilities].sort()) !== JSON.stringify([...configuredCapabilities].sort())) {
    failures.push("launch_capability_binding_mismatch");
  }
  if (JSON.stringify(control.caps) !== JSON.stringify(canonicalLiveTradingCaps())) failures.push("launch_caps_binding_mismatch");
  return failures;
}

export function configuredLiveTradingPublicCapabilities(
  env: Record<string, string | undefined> = process.env,
) {
  return configuredLiveTradingCapabilities(env);
}
