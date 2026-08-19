import type { TradeOrderPlan } from "./trade-order-plan";

export const LIVE_TRADING_CONTRACT_VERSION = 2 as const;
export const LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD = 11;
export const LIVE_TRADING_MAX_ORDER_NOTIONAL_USD = 100;
export const LIVE_TRADING_ROLLING_24H_NOTIONAL_USD = 500;
export const LIVE_TRADING_DEFAULT_SLIPPAGE_BPS = 50;
export const LIVE_TRADING_MAX_SLIPPAGE_BPS = 100;
export const LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS = 3;
export const LIVE_TRADING_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const LIVE_TRADING_TERMS_VERSION = "2026-08-14";
export const LIVE_TRADING_RISK_DISCLOSURE_VERSION = "2026-08-14";
export const LIVE_TRADING_ELIGIBILITY_CONFIRMATION =
  "I attest that I am an eligible non-US user and accept the live-trading terms and risk disclosure.";
const COMPILED_WEB_GIT_SHA = process.env.GHOLA_BAKED_WEB_GIT_SHA;

export const LIVE_TRADING_CAPABILITIES = [
  "market_order",
  "limit_order",
  "cancel",
  "replace",
  "reduce_only",
  "flatten",
  "cross_margin",
  "isolated_margin",
  "leverage",
  "stop_loss",
  "take_profit",
  "twap",
  "chase",
  "agent_trigger",
  "agent_lifecycle",
  "dead_man",
] as const;

export const LIVE_TRADING_REQUIRED_CAPABILITIES = [
  "limit_order",
  "cancel",
  "reduce_only",
  "stop_loss",
  "take_profit",
] as const satisfies readonly LiveTradingCapabilityId[];

export type LiveTradingCapabilityId = (typeof LIVE_TRADING_CAPABILITIES)[number];
export type LiveTradingLaunchState = "disabled" | "canary" | "public" | "killed";
export type LiveTradingCapabilityState = "disabled" | "verifying" | "live" | "paused";

export interface LiveTradingCaps {
  first_proof_notional_usd: number;
  max_order_notional_usd: number;
  rolling_24h_notional_usd: number;
  default_slippage_bps: number;
  max_slippage_bps: number;
}

export interface LiveTradingReleaseIdentity {
  contract_version: typeof LIVE_TRADING_CONTRACT_VERSION;
  web_git_sha: string | null;
  worker_git_sha: string | null;
  worker_image_digest: string | null;
  config_fingerprint: string;
  valid: boolean;
  reason_codes: string[];
}

export interface LiveTradingCapabilityStatus {
  id: LiveTradingCapabilityId;
  state: LiveTradingCapabilityState;
  visible: boolean;
  consecutive_mainnet_proofs: number;
  required_mainnet_proofs: number;
  last_proven_at: string | null;
  reason_codes: string[];
}

export function canonicalLiveTradingCaps(): LiveTradingCaps {
  return {
    first_proof_notional_usd: LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD,
    max_order_notional_usd: LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
    rolling_24h_notional_usd: LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
    default_slippage_bps: LIVE_TRADING_DEFAULT_SLIPPAGE_BPS,
    max_slippage_bps: LIVE_TRADING_MAX_SLIPPAGE_BPS,
  };
}

export function configuredLiveTradingCapabilities(
  env: Record<string, string | undefined>,
): LiveTradingCapabilityId[] {
  const configured = (env.GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES || "limit_order")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.filter(isLiveTradingCapability))];
}

export function liveTradingConfigSnapshot(env: Record<string, string | undefined>) {
  return {
    contract_version: LIVE_TRADING_CONTRACT_VERSION,
    venue: "hyperliquid",
    network: "mainnet",
    live_mode: env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE?.trim() || null,
    mainnet_proof_enabled: env.PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED?.trim() || null,
    max_order_notional_usd: numberOrNull(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD),
    rolling_24h_notional_usd: numberOrNull(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD),
    max_slippage_bps: numberOrNull(env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS),
    live_max_order_notional_usd: numberOrNull(env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD),
    live_rolling_24h_notional_usd: numberOrNull(env.PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD),
    venue_dry_run: env.PRIVATE_AGENT_VENUE_DRY_RUN?.trim() || null,
    state_store: env.PRIVATE_AGENT_STATE_STORE?.trim().toLowerCase() || null,
    require_dstack_quote: env.PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE?.trim() || null,
    require_worker_capability: env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY?.trim() || null,
    position_protection_enabled: env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() || null,
    risk_reduction_enabled: env.PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED?.trim() || null,
    public_capabilities: configuredLiveTradingCapabilities(env).sort(),
    funding_signer_keys_b64: configuredLiveTradingFundingSignerKeys(env).sort(),
  };
}

export function configuredLiveTradingFundingSignerKeys(
  env: Record<string, string | undefined>,
): string[] {
  return [...new Set((env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function liveTradingConfigurationFailures(
  env: Record<string, string | undefined>,
): string[] {
  const failures: string[] = [];
  const workerImageDigestPin = configuredWorkerImageDigestPin(env);
  if (env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED?.trim() !== "true") failures.push("live_trading_public_flag_disabled");
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN?.trim() === "true") failures.push("venue_dry_run_enabled");
  if (env.PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS?.trim() === "true") {
    failures.push("hyperliquid_no_submit_simulation_enabled");
  }
  if (!strongSecret(env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET || "")) failures.push("request_proof_secret_missing");
  const controlToken = env.GHOLA_LIVE_TRADING_CONTROL_TOKEN?.trim() || "";
  const resetToken = env.GHOLA_LIVE_TRADING_RESET_TOKEN?.trim() || "";
  if (!strongWorkerSecret(controlToken)) {
    failures.push("live_trading_control_token_weak");
  }
  if (!strongWorkerSecret(resetToken)) failures.push("live_trading_reset_token_weak");
  else if (resetToken === controlToken) failures.push("live_trading_reset_token_not_distinct");
  if (!strongWorkerSecret(env.GHOLA_INVESTOR_CANARY_SECRET || "")) {
    failures.push("investor_canary_secret_weak");
  }
  if (!exactNumber(env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, LIVE_TRADING_MAX_ORDER_NOTIONAL_USD)) failures.push("launch_max_order_cap_mismatch");
  if (!exactNumber(env.GHOLA_LIVE_TRADING_DAILY_CAP_USD, LIVE_TRADING_ROLLING_24H_NOTIONAL_USD)) failures.push("launch_daily_cap_mismatch");
  if (!exactNumber(env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS, LIVE_TRADING_MAX_SLIPPAGE_BPS)) failures.push("launch_slippage_cap_mismatch");
  if (env.GHOLA_HYPERLIQUID_LIVE_MODE?.trim()) failures.push("legacy_hyperliquid_live_mode_present");
  if (env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED?.trim() !== "true") failures.push("hyperliquid_pilot_disabled");
  if (env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET?.trim() !== "true") failures.push("hyperliquid_mainnet_worker_disabled");
  if (env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE?.trim() !== "full_ticket") failures.push("hyperliquid_worker_full_ticket_disabled");
  if (env.PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED?.trim() !== "true") failures.push("hyperliquid_mainnet_proof_disabled");
  if (!exactNumber(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD, LIVE_TRADING_MAX_ORDER_NOTIONAL_USD)) failures.push("hyperliquid_max_order_cap_mismatch");
  if (!exactNumber(env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD, LIVE_TRADING_ROLLING_24H_NOTIONAL_USD)) failures.push("hyperliquid_daily_cap_mismatch");
  if (!exactNumber(env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS, LIVE_TRADING_MAX_SLIPPAGE_BPS)) failures.push("hyperliquid_slippage_cap_mismatch");
  if (!exactNumber(env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD, LIVE_TRADING_MAX_ORDER_NOTIONAL_USD)) failures.push("worker_live_max_order_cap_mismatch");
  if (!exactNumber(env.PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD, LIVE_TRADING_ROLLING_24H_NOTIONAL_USD)) failures.push("worker_live_daily_cap_mismatch");
  if (env.PRIVATE_AGENT_VENUE_DRY_RUN?.trim() !== "false") failures.push("venue_dry_run_configuration_invalid");
  if (env.PRIVATE_AGENT_STATE_STORE?.trim().toLowerCase() !== "postgres") failures.push("worker_state_store_not_postgres");
  if (env.GHOLA_PRIVATE_ACCOUNT_STORE?.trim().toLowerCase() !== "postgres") {
    failures.push("app_state_store_not_postgres");
  }
  if (env.GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED?.trim() !== "false") {
    failures.push("private_agent_provisioning_mutations_not_disabled");
  }
  if (!(env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim())) {
    failures.push("app_state_database_not_configured");
  }
  const executionUrl = env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() || "";
  if (!executionUrl) failures.push("worker_execution_url_missing");
  else if (!isStablePublicHttpsOrigin(executionUrl)) failures.push("worker_execution_url_not_stable_https");
  const canonicalExecutionOrigin = stablePublicHttpsOrigin(executionUrl);
  const executionUrlAliases = [
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
    env.GHOLA_PRIVATE_AGENT_WORKER_URL,
    env.PHALA_AGENT_ENDPOINT,
  ].map((value) => value?.trim() || "").filter(Boolean);
  if (executionUrlAliases.some((value) => stablePublicHttpsOrigin(value) !== canonicalExecutionOrigin)) {
    failures.push("worker_execution_url_alias_mismatch");
  }
  if (!env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim()) failures.push("google_client_id_missing");
  const canonicalExecutionToken = env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() || "";
  if (!strongWorkerSecret(canonicalExecutionToken)) {
    failures.push("worker_execution_token_weak");
  }
  const requiredWorkerExecutionToken = env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() || "";
  const executionTokenAliases = [
    requiredWorkerExecutionToken,
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() || "",
    env.PRIVATE_AGENT_WORKER_TOKEN?.trim() || "",
  ].filter(Boolean);
  if (!requiredWorkerExecutionToken ||
      executionTokenAliases.some((value) => value !== canonicalExecutionToken)) {
    failures.push("worker_execution_token_alias_mismatch");
  }
  if (!strongWorkerSecret(env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET || env.GHOLA_WORKER_CAPABILITY_SECRET || "")) {
    failures.push("worker_capability_secret_weak");
  }
  const configuredWebGitSha = normalizedSha(env.GHOLA_WEB_GIT_SHA);
  const bakedWebGitSha = normalizedSha(
    env === process.env
      ? COMPILED_WEB_GIT_SHA || (env.NODE_ENV === "test" ? env.GHOLA_BAKED_WEB_GIT_SHA : undefined)
      : env.GHOLA_BAKED_WEB_GIT_SHA,
  );
  const platformWebGitSha = normalizedSha(env.VERCEL_GIT_COMMIT_SHA);
  if (!configuredWebGitSha) failures.push("web_release_pin_missing");
  if (!bakedWebGitSha) failures.push("web_baked_release_pin_missing");
  else if (!configuredWebGitSha || bakedWebGitSha !== configuredWebGitSha) {
    failures.push("web_baked_release_mismatch");
  }
  if (!platformWebGitSha) failures.push("web_platform_release_pin_missing");
  else if (!configuredWebGitSha || platformWebGitSha !== configuredWebGitSha ||
      (bakedWebGitSha && platformWebGitSha !== bakedWebGitSha)) {
    failures.push("web_platform_release_mismatch");
  }
  const workerGitSha = normalizedSha(env.GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA || env.PRIVATE_AGENT_BUILD_GIT_SHA);
  const workerImage = env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE?.trim() || "";
  if (!workerImage) failures.push("worker_image_tag_missing");
  else if (!workerGitSha || workerImage !== `ghcr.io/anndrrson/ghola:private-agent-worker-${workerGitSha}`) {
    failures.push("worker_image_tag_release_mismatch");
  }
  if (workerImageDigestPin.configured && !workerImageDigestPin.valid) {
    failures.push("worker_image_digest_pin_mismatch");
  }
  if (env.PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE?.trim() !== "true") failures.push("worker_dstack_quote_not_required");
  if (env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY?.trim() !== "true") failures.push("worker_capability_auth_not_required");
  if (env.PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED?.trim() !== "true") {
    failures.push("hyperliquid_risk_reduction_disabled");
  }
  if (env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() !== "true") {
    failures.push("position_protection_disabled");
  }
  const fundingSignerKeys = configuredLiveTradingFundingSignerKeys(env);
  if (fundingSignerKeys.length === 0) failures.push("funding_worker_signer_pin_missing");
  else if (fundingSignerKeys.some((key) => !validBase64PublicKey(key))) failures.push("funding_worker_signer_pin_invalid");

  const requested = (env.GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES || "limit_order")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0 || requested.some((value) => !isLiveTradingCapability(value))) {
    failures.push("public_capability_configuration_invalid");
  }
  const implementedCapabilities = new Set<LiveTradingCapabilityId>(["limit_order"]);
  if (env.PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED?.trim() === "true") {
    implementedCapabilities.add("cancel");
    implementedCapabilities.add("reduce_only");
  }
  if (env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() === "true") {
    implementedCapabilities.add("stop_loss");
    implementedCapabilities.add("take_profit");
  }
  const configuredCapabilities = configuredLiveTradingCapabilities(env);
  if (configuredCapabilities.some((capability) => !implementedCapabilities.has(capability))) {
    failures.push("public_capability_not_implemented");
  }
  if (
    env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() === "true" &&
    !["limit_order", "stop_loss", "take_profit"].every((capability) => configuredCapabilities.includes(capability as LiveTradingCapabilityId))
  ) failures.push("position_protection_capabilities_missing");
  if (
    env.PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED?.trim() === "true" &&
    !["limit_order", "cancel", "reduce_only"].every((capability) => configuredCapabilities.includes(capability as LiveTradingCapabilityId))
  ) failures.push("risk_reduction_capabilities_missing");
  if (
    requested.length !== LIVE_TRADING_REQUIRED_CAPABILITIES.length ||
    new Set(requested).size !== requested.length ||
    LIVE_TRADING_REQUIRED_CAPABILITIES.some((capability) => !requested.includes(capability))
  ) failures.push("required_live_capabilities_mismatch");
  return [...new Set(failures)];
}

export function liveTradingReleaseFields(env: Record<string, string | undefined>) {
  const workerImageDigestPin = configuredWorkerImageDigestPin(env);
  return {
    web_git_sha: normalizedSha(env.GHOLA_WEB_GIT_SHA),
    worker_git_sha: normalizedSha(env.GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA || env.PRIVATE_AGENT_BUILD_GIT_SHA),
    worker_image_digest: workerImageDigestPin.valid ? workerImageDigestPin.digest : null,
  };
}

export function liveTradingReleaseFailures(input: {
  web_git_sha: string | null;
  worker_git_sha: string | null;
  worker_image_digest: string | null;
}): string[] {
  const failures: string[] = [];
  if (!input.web_git_sha) failures.push("web_release_identity_missing");
  if (!input.worker_git_sha) failures.push("worker_release_identity_missing");
  if (!input.worker_image_digest) failures.push("worker_image_digest_missing");
  if (input.web_git_sha && input.worker_git_sha && input.web_git_sha !== input.worker_git_sha) failures.push("web_worker_release_mismatch");
  return failures;
}

export function liveTradingCapabilityForPlan(plan: TradeOrderPlan): LiveTradingCapabilityId | null {
  if (plan.venue_id !== "hyperliquid" || plan.order_type !== "limit" || plan.time_in_force !== "ioc") return null;
  return plan.execution_policy.reduce_only ? "reduce_only" : "limit_order";
}

export function liveTradingCapabilitiesForPlan(plan: TradeOrderPlan): LiveTradingCapabilityId[] {
  const primary = liveTradingCapabilityForPlan(plan);
  if (!primary) return [];
  return plan.protection_intent && !plan.execution_policy.reduce_only
    ? [primary, "stop_loss", "take_profit"]
    : [primary];
}

export function isLiveTradingCapability(value: string): value is LiveTradingCapabilityId {
  return (LIVE_TRADING_CAPABILITIES as readonly string[]).includes(value);
}

function numberOrNull(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function exactNumber(value: string | undefined, expected: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed - expected) < 0.000001;
}

function strongSecret(value: string) {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return trimmed.length >= 32 && !["dev", "test", "default", "local", "changeme", "example", "placeholder"]
    .some((item) => lowered === item || lowered.includes(item));
}

function strongWorkerSecret(value: string) {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return trimmed.length >= 32 && new Set(trimmed).size >= 8 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder", "secret"]
      .some((item) => lowered === item || lowered.includes(item));
}

function validBase64PublicKey(value: string) {
  return value.length >= 40 && value.length <= 256 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && value.length % 4 === 0;
}

function isStablePublicHttpsOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname && url.pathname !== "/") || (url.port && url.port !== "443")) return false;
  const hostname = url.hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!hostname || !hostname.includes(".") ||
      ["localhost", ".localhost", ".local", ".internal", ".test", ".example", ".invalid"]
        .some((suffix) => hostname === suffix.replace(/^\./u, "") || hostname.endsWith(suffix))) return false;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!ipv4) return !hostname.includes(":");
  const [, aRaw, bRaw, cRaw] = ipv4;
  const [a, b, c] = [Number(aRaw), Number(bRaw), Number(cRaw)];
  if ([...ipv4.slice(1)].some((part) => Number(part) > 255)) return false;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function stablePublicHttpsOrigin(value: string) {
  if (!isStablePublicHttpsOrigin(value)) return null;
  return new URL(value).origin;
}

function normalizedSha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() || "";
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizedDigest(value: string | undefined): string | null {
  const normalized = value?.trim() || "";
  return /^sha256:[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function configuredWorkerImageDigestPin(env: Record<string, string | undefined>) {
  const required = [
    env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST,
    env.PRIVATE_AGENT_IMAGE_DIGEST,
    env.PHALA_CVM_IMAGE_DIGEST,
  ].map((value) => value?.trim() || "");
  const configured = [
    ...required,
    env.GHOLA_PRIVATE_AGENT_IMAGE_DIGEST?.trim() || "",
  ].filter(Boolean);
  const canonical = configured.map((value) => normalizedDigest(value));
  const valid = required.every(Boolean) && canonical.every(Boolean) && new Set(configured).size === 1;
  return {
    configured: configured.length > 0,
    valid,
    digest: valid ? canonical[0] as string : null,
  };
}
