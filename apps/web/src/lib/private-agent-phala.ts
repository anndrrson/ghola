import { createHash } from "node:crypto";
import type { ConfidentialComputeProviderStatus } from "./private-agent-runtime";
import {
  getPrivateAgentRuntimeLease,
  markPrivateAgentRuntimeActivity,
  markPrivateAgentRuntimeStopped,
  privateAgentRuntimeLeaseActive,
} from "./private-agent-runtime-lease";

const DEFAULT_WORKER_IMAGE =
  "ghcr.io/anndrrson/ghola:private-agent-worker-d36f9cc@sha256:f87611da536b4b9ac712829a045d7153e80dc71708739cab95c5b4fefd183eb4";
const DEFAULT_WORKER_IMAGE_DIGEST =
  "sha256:f87611da536b4b9ac712829a045d7153e80dc71708739cab95c5b4fefd183eb4";
const DEFAULT_CVM_NAME = "ghola-private-agent-worker";
const RECIPIENT_REPORT_DOMAIN = "ghola-private-agent-recipient-v1";

interface PhalaRecipientMetadata {
  recipient_id?: string;
  x25519_pub_hex?: string;
  funding_signer_public_key_b64?: string | null;
  tee_kind?: string | null;
  measurement_hex?: string | null;
  attestation_hash?: string | null;
  image_digest?: string | null;
  report_data_hex?: string | null;
  quote_hash?: string | null;
  attested_ready?: boolean;
  expires_at_unix?: number | null;
}

interface PhalaProvisionResult {
  attempted: boolean;
  ready: boolean;
  status: "disabled" | "missing_config" | "already_ready" | "provisioning" | "ready" | "failed";
  reason?: string;
  cvm_name?: string;
  cvm_id?: string;
  execution_url?: string;
}

interface PhalaIdleStopResult {
  attempted: boolean;
  stopped: boolean;
  status:
    | "disabled"
    | "missing_config"
    | "lease_active"
    | "already_stopped"
    | "stopped"
    | "failed";
  reason?: string;
  cvm_name?: string;
  lease_expires_at?: string | null;
}

interface PhalaProvisionResponse {
  app_id: string;
  compose_hash: string;
  app_env_encrypt_pubkey: string;
}

interface PhalaCloudClient {
  getCvmInfo(input: { id: string }, options?: { schema: boolean }): Promise<unknown>;
  getCvmNetwork(input: { id: string }, options?: { schema: boolean }): Promise<unknown>;
  getCvmAttestation(input: { id: string }, options?: { schema: boolean }): Promise<unknown>;
  getCvmState(input: { id: string }, options?: { schema: boolean }): Promise<unknown>;
  startCvm(input: { id: string }): Promise<unknown>;
  stopCvm(input: { id: string }): Promise<unknown>;
  provisionCvm(input: Record<string, unknown>): Promise<PhalaProvisionResponse>;
  commitCvmProvision(
    input: Record<string, unknown>,
    options?: { schema: boolean },
  ): Promise<unknown>;
}

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function boolEnv(name: string): boolean {
  return env(name)?.toLowerCase() === "true";
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(env(name) ?? "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function phalaApiKey(): string | null {
  return env("PHALA_CLOUD_API_KEY") ?? env("PHALA_API_KEY");
}

function phalaBaseUrl(): string | undefined {
  return env("PHALA_CLOUD_API_PREFIX") ?? undefined;
}

export function phalaWorkerExecutionToken(): string | null {
  return (
    env("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN") ??
    env("PRIVATE_AGENT_EXECUTION_TOKEN")
  );
}

function phalaWorkerCapabilitySecret(): string | null {
  return (
    env("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET") ??
    env("GHOLA_WORKER_CAPABILITY_SECRET")
  );
}

function phalaWorkerFundingSigningKey(): string | null {
  return (
    env("PRIVATE_AGENT_FUNDING_SIGNING_KEY") ??
    env("GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY")
  );
}

function phalaWorkerStatePostgresUrl(): string | null {
  return (
    env("PRIVATE_AGENT_STATE_POSTGRES_URL") ??
    env("GHOLA_PRIVATE_AGENT_STATE_POSTGRES_URL") ??
    env("GHOLA_PRIVATE_ACCOUNT_DATABASE_URL") ??
    env("PRIVATE_AGENT_DATABASE_URL") ??
    env("DATABASE_URL")
  );
}

function phalaWorkerStateStore(): string {
  return (
    env("PRIVATE_AGENT_STATE_STORE") ??
    env("GHOLA_PRIVATE_AGENT_STATE_STORE") ??
    (phalaWorkerStatePostgresUrl() ? "postgres" : "json")
  );
}

export function phalaCvmName(): string {
  return env("GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME") ?? DEFAULT_CVM_NAME;
}

function phalaWorkerImage(): string {
  return env("GHOLA_PRIVATE_AGENT_WORKER_IMAGE") ?? DEFAULT_WORKER_IMAGE;
}

function phalaWorkerImageDigest(): string {
  return (
    env("GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST") ??
    env("GHOLA_PRIVATE_AGENT_IMAGE_DIGEST") ??
    DEFAULT_WORKER_IMAGE_DIGEST
  );
}

function phalaWorkerImageReference(image: string, imageDigest: string): string {
  if (image.includes("@sha256:")) return image;
  if (imageDigest.startsWith("sha256:")) return `${image}@${imageDigest}`;
  return image;
}

function liveHyperliquidEnabled(): boolean {
  return (
    env("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE") === "tiny_fill" ||
    env("GHOLA_HYPERLIQUID_LIVE_MODE") === "tiny_fill"
  );
}

function liveSolanaPerpsEnabled(): boolean {
  return (
    env("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE") === "sdk_runner" ||
    env("GHOLA_SOLANA_PERPS_LIVE_MODE") === "sdk_runner"
  );
}

function liveWorkerImageConfigured(): boolean {
  return Boolean(
    env("GHOLA_PRIVATE_AGENT_WORKER_IMAGE") &&
      (env("GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST") ||
        env("GHOLA_PRIVATE_AGENT_IMAGE_DIGEST")),
  );
}

export function phalaWorkerImageConfiguredForRequestedMode(): boolean {
  return (!liveHyperliquidEnabled() && !liveSolanaPerpsEnabled()) || liveWorkerImageConfigured();
}

function workerEnv(name: string, fallback: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = env(key);
    if (value) return value;
  }
  return fallback;
}

function workerLiveEnv(name: string, fallback: string, aliases: string[] = []): string {
  return workerEnv(name, fallback, [
    name.replace(/^PRIVATE_AGENT_/, "GHOLA_"),
    ...aliases,
  ]);
}

function secretWorkerEnv(name: string, aliases: string[] = []): string | null {
  return workerEnv(name, "", aliases) || null;
}

function encryptedWorkerSecret(name: string, aliases: string[] = []): Array<{ key: string; value: string }> {
  const value = secretWorkerEnv(name, aliases);
  return value ? [{ key: name, value }] : [];
}

function composeEnvLine(name: string, value: string): string {
  return `      ${name}: ${JSON.stringify(value)}`;
}

function composeEncryptedEnvLine(name: string): string {
  return `      ${name}: "\${${name}:-}"`;
}

function nullableBoolEnv(name: string): boolean | null {
  const value = env(name)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function phalaWakeOnUseConfigPresent(): boolean {
  return Boolean(phalaApiKey() && phalaWorkerExecutionToken());
}

export function phalaWakeOnUseEnabled(): boolean {
  if (privateAgentRemoteExecutionDisabled()) return false;
  const explicitWake = nullableBoolEnv("GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED");
  if (explicitWake === true) return true;
  if (explicitWake === false && !productionCredentialWakeOnUseAllowed()) return false;
  if (boolEnv("GHOLA_PRIVATE_AGENT_JIT_PROVISIONING")) return true;
  return phalaWakeOnUseConfigPresent();
}

export function phalaJitProvisioningEnabled(): boolean {
  return phalaWakeOnUseEnabled();
}

export function phalaIdleShutdownEnabled(): boolean {
  if (env("GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN")?.toLowerCase() === "false") {
    return false;
  }
  return boolEnv("GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN") || phalaWakeOnUseEnabled();
}

export function phalaIdleLeaseMs(): number {
  const minutes = intEnv("GHOLA_PRIVATE_AGENT_IDLE_AFTER_MINUTES", 30, 5, 12 * 60);
  return intEnv("GHOLA_PRIVATE_AGENT_IDLE_AFTER_MS", minutes * 60_000, 5 * 60_000, 12 * 60 * 60_000);
}

export async function markPhalaPrivateAgentActivity(input: {
  reason: string;
  leaseMs?: number;
  now?: Date;
}) {
  return markPrivateAgentRuntimeActivity({
    provider_id: "phala",
    reason: input.reason,
    lease_ms: input.leaseMs ?? phalaIdleLeaseMs(),
    now: input.now,
  });
}

export function privateAgentRemoteExecutionDisabled(): boolean {
  return (
    boolEnv("GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED") ||
    privateAgentSpendLockdownEnabled() ||
    !privateAgentSpendArmed()
  );
}

export function privateAgentSpendLockdownEnabled(): boolean {
  return boolEnv("GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN");
}

export function privateAgentSpendArmed(): boolean {
  const explicit = nullableBoolEnv("GHOLA_PRIVATE_AGENT_SPEND_ARMED");
  if (explicit !== null) return explicit;
  const explicitWake = nullableBoolEnv("GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED");
  if (explicitWake === true) return true;
  if (explicitWake === false && !productionCredentialWakeOnUseAllowed()) return false;
  if (boolEnv("GHOLA_PRIVATE_AGENT_JIT_PROVISIONING")) return true;
  if (productionCredentialWakeOnUseAllowed()) {
    return phalaWakeOnUseConfigPresent();
  }
  return true;
}

function phalaWakeOnUseEvidence() {
  return {
    wake_on_use_config_present: phalaWakeOnUseConfigPresent(),
    wake_on_use_enabled: phalaWakeOnUseEnabled(),
    spend_armed: privateAgentSpendArmed(),
    remote_execution_disabled: privateAgentRemoteExecutionDisabled(),
    spend_lockdown: privateAgentSpendLockdownEnabled(),
  };
}

function productionCredentialWakeOnUseAllowed(): boolean {
  return (
    (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") &&
    phalaWakeOnUseConfigPresent()
  );
}

export function phalaJitProvisioningConfigIssue(): string | null {
  if (!phalaApiKey()) {
    return "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.";
  }
  if (!phalaWorkerExecutionToken()) {
    return "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.";
  }
  if (!phalaWorkerImageConfiguredForRequestedMode()) {
    return "GHOLA_PRIVATE_AGENT_WORKER_IMAGE and GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST are required before provisioning live venue mode.";
  }
  return null;
}

export function phalaJitProvisioningConfigured(): boolean {
  return Boolean(phalaJitProvisioningEnabled() && !phalaJitProvisioningConfigIssue());
}

export function expectedRecipientReportDataHex(input: {
  recipientId: string;
  x25519PubHex: string;
  fundingSignerPublicKeyB64?: string | null;
}): string {
  const fields = [
    RECIPIENT_REPORT_DOMAIN,
    input.recipientId,
    input.x25519PubHex.toLowerCase(),
  ];
  const fundingSignerPublicKeyB64 = input.fundingSignerPublicKeyB64?.trim();
  if (fundingSignerPublicKeyB64) fields.push(fundingSignerPublicKeyB64);
  return `0x${sha256Hex(fields.join("\0"))}`;
}

function pinnedFundingSignerKeys(): Set<string> {
  return new Set(
    (env("GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

export function buildPhalaWorkerCompose(input: {
  image?: string;
  imageDigest?: string;
} = {}): string {
  const image = input.image ?? phalaWorkerImage();
  const imageDigest = input.imageDigest ?? phalaWorkerImageDigest();
  const imageReference = phalaWorkerImageReference(image, imageDigest);
  return [
    "services:",
    "  private-agent-worker:",
    `    image: ${imageReference}`,
    "    restart: unless-stopped",
    "    ports:",
    '      - "8787:8787"',
    "    environment:",
    '      PORT: "8787"',
    '      PRIVATE_AGENT_PROVIDER_ID: "phala"',
    '      PRIVATE_AGENT_TEE_KIND: "phala"',
    '      PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    '      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "${PRIVATE_AGENT_WORKER_CAPABILITY_SECRET}"',
    '      PRIVATE_AGENT_FUNDING_SIGNING_KEY: "${PRIVATE_AGENT_FUNDING_SIGNING_KEY:-}"',
    composeEnvLine("PRIVATE_AGENT_STATE_STORE", phalaWorkerStateStore()),
    composeEnvLine("PRIVATE_AGENT_STATE_SINGLE_CVM_OK", workerEnv("PRIVATE_AGENT_STATE_SINGLE_CVM_OK", "false", ["GHOLA_PRIVATE_AGENT_STATE_SINGLE_CVM_OK"])),
    '      PRIVATE_AGENT_STATE_POSTGRES_URL: "${PRIVATE_AGENT_STATE_POSTGRES_URL:-}"',
    '      PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true"',
    `      PHALA_CVM_IMAGE_DIGEST: "${imageDigest}"`,
    composeEnvLine("PRIVATE_AGENT_VENUE_DRY_RUN", workerEnv("PRIVATE_AGENT_VENUE_DRY_RUN", "false")),
    composeEnvLine("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", workerEnv("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", "false")),
    composeEnvLine("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", workerEnv("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", "60")),
    composeEnvLine("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", "0")),
    composeEnvLine("PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT", workerEnv("PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT", "false", ["GHOLA_PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT"])),
    composeEnvLine("PRIVATE_AGENT_AUTOPILOT_TICK_MS", workerEnv("PRIVATE_AGENT_AUTOPILOT_TICK_MS", "30000", ["GHOLA_PRIVATE_AGENT_AUTOPILOT_TICK_MS"])),
    composeEnvLine("PRIVATE_AGENT_AI_DIRECT_ENABLED", workerEnv("PRIVATE_AGENT_AI_DIRECT_ENABLED", "false", ["GHOLA_PRIVATE_AGENT_AI_DIRECT_ENABLED"])),
    composeEnvLine("PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR", workerEnv("PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR", "12", ["GHOLA_PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR"])),
    composeEnvLine("PRIVATE_AGENT_AI_MODEL", workerEnv("PRIVATE_AGENT_AI_MODEL", "", ["GHOLA_PRIVATE_AGENT_AI_MODEL"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", workerEnv("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "false", ["GHOLA_HYPERLIQUID_ALLOW_MAINNET"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", workerLiveEnv("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", "disabled")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD", workerLiveEnv("PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD", "5")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD", workerEnv("PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD", "25", ["GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD", "", ["GHOLA_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD", workerEnv("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD", "", ["GHOLA_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS", workerEnv("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS", "50", ["GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS"])),
    composeEncryptedEnvLine("PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON"),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "disabled", ["GHOLA_SOLANA_PERPS_LIVE_MODE"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", "false", ["GHOLA_SOLANA_PERPS_ALLOW_MAINNET"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD", "5", ["GHOLA_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD", "", ["GHOLA_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", workerEnv("PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS", "", ["GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS"])),
    composeEncryptedEnvLine("PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON"),
    composeEnvLine("PRIVATE_AGENT_SOLANA_RPC_URL", workerEnv("PRIVATE_AGENT_SOLANA_RPC_URL", "", ["GHOLA_SOLANA_RPC_URL", "SOLANA_RPC_URL"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS", workerEnv("PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS", "0", ["GHOLA_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS"])),
    composeEnvLine("PRIVATE_AGENT_JUPITER_LIVE_MODE", workerEnv("PRIVATE_AGENT_JUPITER_LIVE_MODE", "disabled", ["GHOLA_JUPITER_LIVE_MODE"])),
    composeEncryptedEnvLine("PRIVATE_AGENT_JUPITER_API_KEY"),
    composeEnvLine("PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS", workerEnv("PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS", "", ["GHOLA_JUPITER_ALLOWED_INPUT_MINTS"])),
    composeEnvLine("PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS", workerEnv("PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS", "", ["GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS"])),
    composeEnvLine("PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD", "", ["GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD"])),
    composeEnvLine("PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", workerEnv("PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS", "", ["GHOLA_JUPITER_MAX_SLIPPAGE_BPS"])),
    composeEncryptedEnvLine("PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON"),
    composeEnvLine("PRIVATE_AGENT_COINBASE_LIVE_MODE", workerEnv("PRIVATE_AGENT_COINBASE_LIVE_MODE", "disabled", ["GHOLA_COINBASE_LIVE_MODE"])),
    composeEnvLine("PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS", workerEnv("PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS", "", ["GHOLA_COINBASE_ALLOWED_PRODUCTS"])),
    composeEnvLine("PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD", "", ["GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD"])),
    composeEncryptedEnvLine("PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON"),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS", workerEnv("PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS", "12000")),
    "    volumes:",
    "      - /var/run/dstack.sock:/var/run/dstack.sock",
    "      - private-agent-data:/data",
    "",
    "volumes:",
    "  private-agent-data:",
    "",
  ].join("\n");
}

async function phalaClient(): Promise<PhalaCloudClient | null> {
  const apiKey = phalaApiKey();
  if (!apiKey) return null;
  const { createClient } = await import("@phala/cloud");
  return createClient({
    apiKey,
    ...(phalaBaseUrl() ? { baseURL: phalaBaseUrl() } : {}),
  }) as PhalaCloudClient;
}

function firstPublicAppUrl(network: unknown, fallbackInfo?: unknown): string | null {
  const candidates: unknown[] = [];
  if (network && typeof network === "object") {
    const record = network as Record<string, unknown>;
    if (Array.isArray(record.public_urls)) candidates.push(...record.public_urls);
  }
  if (fallbackInfo && typeof fallbackInfo === "object") {
    const record = fallbackInfo as Record<string, unknown>;
    if (Array.isArray(record.endpoints)) candidates.push(...record.endpoints);
    if (Array.isArray(record.public_urls)) candidates.push(...record.public_urls);
    if (typeof record.app_url === "string") candidates.push(record.app_url);
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("https://")) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const app = (candidate as Record<string, unknown>).app;
      if (typeof app === "string" && app.startsWith("https://")) return app;
    }
  }
  return null;
}

function validX25519Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function safeExecutionUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: URL, headers?: HeadersInit, timeoutMs = 5000): Promise<T | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function attestationPresent(attestation: unknown): boolean {
  if (!attestation || typeof attestation !== "object") return false;
  const record = attestation as Record<string, unknown>;
  if (record.is_online === false) return false;
  if (Array.isArray(record.app_certificates) && record.app_certificates.length > 0) {
    return true;
  }
  if (record.tcb_info && typeof record.tcb_info === "object") return true;
  return false;
}

export async function discoverPhalaPrivateAgentProvider(): Promise<
  ConfidentialComputeProviderStatus | null
> {
  const client = await phalaClient();
  if (!client) return null;

  const name = phalaCvmName();
  const token = phalaWorkerExecutionToken();
  if (!token) {
    return {
      id: "phala",
      label: "Phala TEE",
      configured: false,
      available: false,
      attested: false,
      supports_sealed_secrets: false,
      supports_background_agents: false,
      supports_trading_execution: false,
      reason: "Ghola private-agent worker token is not configured.",
      evidence: {
        ...phalaWakeOnUseEvidence(),
        provisioning_enabled: phalaJitProvisioningEnabled(),
        execution_url_configured: false,
      },
    };
  }

  let info: unknown = null;
  try {
    info = await client.getCvmInfo({ id: name }, { schema: false });
  } catch {
    return null;
  }

  const status =
    info && typeof info === "object"
      ? String((info as Record<string, unknown>).status ?? "")
      : "";
  let network: unknown = null;
  let attestation: unknown = null;
  try {
    [network, attestation] = await Promise.all([
      client.getCvmNetwork({ id: name }, { schema: false }).catch(() => null),
      client.getCvmAttestation({ id: name }, { schema: false }).catch(() => null),
    ]);
  } catch {
    // Keep the provider fail-closed below.
  }

  const executionUrl = safeExecutionUrl(firstPublicAppUrl(network, info));
  const recipient = executionUrl
    ? await fetchJson<PhalaRecipientMetadata>(
        new URL("/.well-known/private-agent-recipient", executionUrl),
      )
    : null;
  const fundingSignerPublicKeyB64 = recipient?.funding_signer_public_key_b64?.trim() || "";
  const pinnedFundingSigners = pinnedFundingSignerKeys();
  const fundingSignerBound =
    !fundingSignerPublicKeyB64 ||
    (pinnedFundingSigners.size > 0 && pinnedFundingSigners.has(fundingSignerPublicKeyB64));
  const expectedReportData =
    recipient?.recipient_id && recipient?.x25519_pub_hex
      ? expectedRecipientReportDataHex({
          recipientId: recipient.recipient_id,
          x25519PubHex: recipient.x25519_pub_hex,
          fundingSignerPublicKeyB64: fundingSignerBound ? fundingSignerPublicKeyB64 : null,
        })
      : null;
  const reportDataBound =
    expectedReportData !== null &&
    recipient?.report_data_hex?.toLowerCase() === expectedReportData.toLowerCase();
  const recipientReady =
    typeof recipient?.recipient_id === "string" &&
    validX25519Hex(recipient.x25519_pub_hex) &&
    recipient.attested_ready === true &&
    fundingSignerBound &&
    reportDataBound;
  const attested = attestationPresent(attestation);
  const ready = status === "running" && Boolean(executionUrl) && recipientReady && attested;

  return {
    id: "phala",
    label: "Phala TEE",
    configured: true,
    available: ready,
    attested: ready,
    supports_sealed_secrets: ready,
    supports_background_agents: ready,
    supports_trading_execution: ready,
    execution_url: executionUrl,
    reason: ready
      ? null
      : "Phala worker exists but is not yet running with verified attestation-bound recipient evidence.",
    ...(recipientReady && recipient?.recipient_id && recipient?.x25519_pub_hex
      ? {
          sealed_recipient: {
            recipient_id: recipient.recipient_id,
            x25519_pub_hex: recipient.x25519_pub_hex,
            tee_kind: recipient.tee_kind ?? "phala",
            measurement_hex: recipient.measurement_hex ?? recipient.image_digest ?? null,
            attestation_hash: recipient.attestation_hash ?? recipient.quote_hash ?? null,
            expires_at_unix: recipient.expires_at_unix ?? null,
          },
        }
      : {}),
    evidence: {
      ...phalaWakeOnUseEvidence(),
      tee_kind: "phala",
      verifier_url_configured: true,
      execution_url_configured: Boolean(executionUrl),
      image_digest_configured: Boolean(phalaWorkerImageDigest()),
      recipient_configured: recipientReady,
      provisioning_enabled: phalaJitProvisioningEnabled(),
      cvm_status: status || null,
      report_data_bound: reportDataBound,
      funding_signer_bound: fundingSignerBound,
      phala_attestation_present: attested,
    },
  };
}

export async function discoverPhalaPrivateAgentExecutionUrl(): Promise<string | null> {
  const client = await phalaClient();
  if (!client) return null;
  const name = phalaCvmName();
  let info: unknown = null;
  let network: unknown = null;
  try {
    info = await client.getCvmInfo({ id: name }, { schema: false });
    network = await client.getCvmNetwork({ id: name }, { schema: false }).catch(() => null);
  } catch {
    return null;
  }
  return safeExecutionUrl(firstPublicAppUrl(network, info));
}

export async function ensurePhalaPrivateAgentProvisioned(input: {
  waitForReadyMs?: number;
} = {}): Promise<PhalaProvisionResult> {
  if (privateAgentRemoteExecutionDisabled()) {
    return {
      attempted: false,
      ready: false,
      status: "disabled",
      reason: "Remote private-agent execution is disabled by operator spend lock.",
    };
  }
  if (!phalaJitProvisioningEnabled()) {
    return { attempted: false, ready: false, status: "disabled" };
  }
  const configIssue = phalaJitProvisioningConfigIssue();
  if (configIssue) {
    return {
      attempted: false,
      ready: false,
      status: "missing_config",
      reason: configIssue,
    };
  }
  const client = await phalaClient();
  const token = phalaWorkerExecutionToken();
  if (!client || !token) {
    return {
      attempted: false,
      ready: false,
      status: "missing_config",
      reason: "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.",
    };
  }

  const discovered = await discoverPhalaPrivateAgentProvider();
  if (discovered?.available) {
    return {
      attempted: false,
      ready: true,
      status: "already_ready",
      cvm_name: phalaCvmName(),
    };
  }

  const name = phalaCvmName();
  let info: unknown = null;
  try {
    info = await client.getCvmInfo({ id: name }, { schema: false });
  } catch {
    // Missing CVM is expected before the first paid private-agent request.
  }

  if (!info) {
    try {
      const { encryptEnvVars } = await import("@phala/cloud");
      const statePostgresUrl = phalaWorkerStatePostgresUrl();
      const encryptedWorkerEnv = [
        { key: "PRIVATE_AGENT_EXECUTION_TOKEN", value: token },
        ...(phalaWorkerCapabilitySecret()
          ? [{ key: "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET", value: phalaWorkerCapabilitySecret() as string }]
          : []),
        ...(phalaWorkerFundingSigningKey()
          ? [{ key: "PRIVATE_AGENT_FUNDING_SIGNING_KEY", value: phalaWorkerFundingSigningKey() as string }]
          : []),
        ...(statePostgresUrl
          ? [{ key: "PRIVATE_AGENT_STATE_POSTGRES_URL", value: statePostgresUrl }]
          : []),
        ...encryptedWorkerSecret("PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON"),
        ...encryptedWorkerSecret("PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON"),
        ...encryptedWorkerSecret("PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON"),
        ...encryptedWorkerSecret("PRIVATE_AGENT_JUPITER_API_KEY", ["JUPITER_API_KEY", "GHOLA_JUPITER_API_KEY"]),
        ...encryptedWorkerSecret("PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON"),
      ];
      const encryptedWorkerEnvKeys = encryptedWorkerEnv.map((item) => item.key);
      const provision = await client.provisionCvm({
        name,
        instance_type: env("GHOLA_PHALA_PRIVATE_AGENT_INSTANCE_TYPE") ?? "tdx.small",
        ...(env("GHOLA_PHALA_PRIVATE_AGENT_REGION")
          ? { region: env("GHOLA_PHALA_PRIVATE_AGENT_REGION") }
          : {}),
        compose_file: {
          docker_compose_file: buildPhalaWorkerCompose(),
          allowed_envs: encryptedWorkerEnvKeys,
          gateway_enabled: true,
          kms_enabled: true,
          public_logs: false,
          public_sysinfo: false,
        },
        env_keys: encryptedWorkerEnvKeys,
        listed: false,
      });
      const encryptedEnv = await encryptEnvVars(
        encryptedWorkerEnv,
        provision.app_env_encrypt_pubkey,
      );
      info = await client.commitCvmProvision(
        {
          app_id: provision.app_id,
          compose_hash: provision.compose_hash,
          encrypted_env: encryptedEnv,
          env_keys: encryptedWorkerEnvKeys,
        },
        { schema: false },
      );
    } catch (error) {
      return {
        attempted: true,
        ready: false,
        status: "failed",
        reason: error instanceof Error ? error.message : "Phala provisioning failed.",
        cvm_name: name,
      };
    }
  } else {
    try {
      const state = await client.getCvmState({ id: name }, { schema: false });
      const status =
        state && typeof state === "object"
          ? String((state as Record<string, unknown>).status ?? "")
          : "";
      if (status === "stopped") {
        await client.startCvm({ id: name });
      }
    } catch {
      // If the state check fails, the readiness check below will keep us closed.
    }
  }

  const waitForReadyMs = input.waitForReadyMs ?? 0;
  if (waitForReadyMs > 0) {
    const deadline = Date.now() + waitForReadyMs;
    while (Date.now() < deadline) {
      const provider = await discoverPhalaPrivateAgentProvider();
      if (provider?.available) {
        return {
          attempted: true,
          ready: true,
          status: "ready",
          cvm_name: name,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  return {
    attempted: true,
    ready: false,
    status: "provisioning",
    cvm_name: name,
    cvm_id:
      info && typeof info === "object"
        ? String(
            (info as Record<string, unknown>).id ??
              (info as Record<string, unknown>).app_id ??
              "",
          ) || undefined
        : undefined,
  };
}

export async function wakePhalaPrivateAgentForUse(input: {
  reason: string;
  waitForReadyMs?: number;
  leaseMs?: number;
}): Promise<PhalaProvisionResult> {
  if (privateAgentRemoteExecutionDisabled()) {
    return ensurePhalaPrivateAgentProvisioned({
      waitForReadyMs: input.waitForReadyMs,
    });
  }
  await markPhalaPrivateAgentActivity({
    reason: input.reason,
    leaseMs: input.leaseMs,
  });
  const result = await ensurePhalaPrivateAgentProvisioned({
    waitForReadyMs: input.waitForReadyMs,
  });
  if (result.ready || result.attempted) {
    await markPhalaPrivateAgentActivity({
      reason: result.ready ? `${input.reason}:ready` : `${input.reason}:${result.status}`,
      leaseMs: input.leaseMs,
    });
  }
  return result;
}

export async function stopIdlePhalaPrivateAgent(input: {
  now?: Date;
  force?: boolean;
} = {}): Promise<PhalaIdleStopResult> {
  const now = input.now ?? new Date();
  const name = phalaCvmName();
  if (!phalaIdleShutdownEnabled() && !input.force) {
    return {
      attempted: false,
      stopped: false,
      status: "disabled",
      reason: "Phala idle shutdown is disabled.",
      cvm_name: name,
    };
  }
  if (!phalaApiKey()) {
    return {
      attempted: false,
      stopped: false,
      status: "missing_config",
      reason: "PHALA_CLOUD_API_KEY is required to stop the Phala worker.",
      cvm_name: name,
    };
  }

  const lease = await getPrivateAgentRuntimeLease("phala");
  if (!input.force && privateAgentRuntimeLeaseActive(lease, now)) {
    return {
      attempted: false,
      stopped: false,
      status: "lease_active",
      reason: "Recent private-agent use is still inside the active lease window.",
      cvm_name: name,
      lease_expires_at: lease?.lease_expires_at ?? null,
    };
  }

  const client = await phalaClient();
  if (!client) {
    return {
      attempted: false,
      stopped: false,
      status: "missing_config",
      reason: "PHALA_CLOUD_API_KEY is required to stop the Phala worker.",
      cvm_name: name,
    };
  }

  try {
    const state = await client.getCvmState({ id: name }, { schema: false });
    const status =
      state && typeof state === "object"
        ? String((state as Record<string, unknown>).status ?? "")
        : "";
    if (status === "stopped" || status === "stopping") {
      await markPrivateAgentRuntimeStopped({
        provider_id: "phala",
        reason: "idle_stop_already_stopped",
        now,
      });
      return {
        attempted: false,
        stopped: false,
        status: "already_stopped",
        cvm_name: name,
      };
    }
    await client.stopCvm({ id: name });
    await markPrivateAgentRuntimeStopped({
      provider_id: "phala",
      reason: "idle_stop",
      now,
    });
    return {
      attempted: true,
      stopped: true,
      status: "stopped",
      cvm_name: name,
    };
  } catch (error) {
    return {
      attempted: true,
      stopped: false,
      status: "failed",
      reason: error instanceof Error ? error.message : "Phala idle stop failed.",
      cvm_name: name,
    };
  }
}
