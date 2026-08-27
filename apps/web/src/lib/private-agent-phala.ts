import { createHash } from "node:crypto";
import type { ConfidentialComputeProviderStatus } from "./private-agent-runtime";
import {
  getPrivateAgentRuntimeLease,
  markPrivateAgentRuntimeActivity,
  markPrivateAgentRuntimeStopped,
  privateAgentRuntimeLeaseActive,
} from "./private-agent-runtime-lease";
import { schedulePhalaIdleShutdown } from "./private-agent-idle-scheduler";

const DEFAULT_WORKER_IMAGE =
  "ghcr.io/anndrrson/ghola:private-agent-worker-6a4f843@sha256:9b36fd7356dc8be88a685419b8af9b17bb5c46248daf942d753e928b6edc7933";
const DEFAULT_WORKER_IMAGE_DIGEST =
  "sha256:9b36fd7356dc8be88a685419b8af9b17bb5c46248daf942d753e928b6edc7933";
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

const phalaWakeInFlight = new Map<string, Promise<PhalaProvisionResult>>();

export function resetPhalaWakeStateForTests(): void {
  phalaWakeInFlight.clear();
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

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const candidate of [record.status, record.statusCode, record.code]) {
    const numeric = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const status = Number((response as Record<string, unknown>).status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

function cvmStatus(value: unknown): string {
  return value && typeof value === "object"
    ? String((value as Record<string, unknown>).status ?? "").toLowerCase()
    : "";
}

export function phalaWorkerReadyPollMs(): number {
  return intEnv("GHOLA_PHALA_WORKER_READY_POLL_MS", 1_000, 500, 5_000);
}

export function phalaRecipientFetchTimeoutMs(): number {
  return intEnv("GHOLA_PHALA_RECIPIENT_FETCH_TIMEOUT_MS", 15_000, 5_000, 30_000);
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

export function phalaWorkerCapabilitySecret(): string | null {
  return (
    env("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET") ??
    env("GHOLA_WORKER_CAPABILITY_SECRET")
  );
}

export function phalaWorkerFundingSigningKey(): string | null {
  return (
    env("GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY") ??
    env("PRIVATE_AGENT_FUNDING_SIGNING_KEY")
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

function liveHyperliquidEnabled(): boolean {
  return (
    env("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE") === "tiny_fill" ||
    env("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE") === "full_ticket" ||
    env("GHOLA_HYPERLIQUID_LIVE_MODE") === "tiny_fill" ||
    env("GHOLA_HYPERLIQUID_LIVE_MODE") === "full_ticket"
  );
}

function liveSolanaPerpsEnabled(): boolean {
  return (
    env("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE") === "sdk_runner" ||
    env("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE") === "full_ticket" ||
    env("GHOLA_SOLANA_PERPS_LIVE_MODE") === "sdk_runner" ||
    env("GHOLA_SOLANA_PERPS_LIVE_MODE") === "full_ticket"
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

function composeEnvLine(name: string, value: string): string {
  return `      ${name}: ${JSON.stringify(value)}`;
}

function phalaWorkerImageReference(image: string, imageDigest: string): string {
  return /@sha256:[0-9a-f]+$/i.test(image) ? image : `${image}@${imageDigest}`;
}

function expectedHyperliquidWorkerConfig(): Record<string, string> {
  return {
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: workerEnv(
      "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
      "false",
      ["GHOLA_HYPERLIQUID_ALLOW_MAINNET"],
    ),
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: workerLiveEnv(
      "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
      "disabled",
    ),
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: workerLiveEnv(
      "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
      "5",
    ),
    PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: workerEnv(
      "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
      "25",
      ["GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD"],
    ),
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: workerEnv(
      "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
      "",
    ),
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: workerEnv(
      "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
      "",
    ),
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: workerEnv(
      "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
      "50",
      ["GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS"],
    ),
  };
}

function expectedCarryWorkerConfig(): Record<string, string> {
  return {
    PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT",
      "false",
    ),
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED",
      "false",
    ),
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC",
      "11000000",
    ),
    PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS",
      "2000",
    ),
    PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS",
      "2000",
    ),
    PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS",
      "25",
    ),
    PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS",
      "50",
    ),
    PRIVATE_AGENT_CARRY_AUTO_EXIT_ENABLED: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_AUTO_EXIT_ENABLED",
      "true",
    ),
    PRIVATE_AGENT_CARRY_EXECUTION_SWEEP_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_EXECUTION_SWEEP_MS",
      "2000",
    ),
    PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY",
      "8",
    ),
    PRIVATE_AGENT_CARRY_EXIT_VERIFY_RETRY_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_EXIT_VERIFY_RETRY_MS",
      "30000",
    ),
    PRIVATE_AGENT_CARRY_MONITOR_ENABLED: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MONITOR_ENABLED",
      "true",
    ),
    PRIVATE_AGENT_CARRY_MONITOR_INITIAL_DELAY_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MONITOR_INITIAL_DELAY_MS",
      "5000",
    ),
    PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS",
      "5000",
    ),
    PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY",
      "8",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED",
      "true",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS",
      "5000",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS",
      "60000",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS",
      "BTC,ETH,SOL",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES",
      "3",
    ),
    PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS",
      "600000",
    ),
    PRIVATE_AGENT_CARRY_QUALIFICATION_MAX_AGE_MS: workerLiveEnv(
      "PRIVATE_AGENT_CARRY_QUALIFICATION_MAX_AGE_MS",
      "7776000000",
    ),
  };
}

function phalaComposeText(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const composeFile = (info as Record<string, unknown>).compose_file;
  if (!composeFile || typeof composeFile !== "object") return null;
  const compose = (composeFile as Record<string, unknown>).docker_compose_file;
  return typeof compose === "string" && compose.trim() ? compose : null;
}

function phalaComposeHash(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const value = record.compose_hash ?? record.composeHash;
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function composeScalar(compose: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compose.match(
    new RegExp(`^\\s*${escaped}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*$`, "m"),
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

export function phalaWorkerRuntimeConfigDrift(info: unknown): string[] {
  const reasons: string[] = [];
  const expectedComposeHash = env("GHOLA_PHALA_PRIVATE_AGENT_COMPOSE_HASH")?.toLowerCase();
  if (expectedComposeHash && phalaComposeHash(info) !== expectedComposeHash) {
    reasons.push("phala_worker_compose_hash_mismatch");
  }

  const compose = phalaComposeText(info);
  if (!compose) return [...reasons, "phala_worker_compose_unavailable"];

  const expectedImage = phalaWorkerImageReference(phalaWorkerImage(), phalaWorkerImageDigest());
  if (composeScalar(compose, "image") !== expectedImage) {
    reasons.push("phala_worker_image_mismatch");
  }
  const expectedRuntime = {
    ...expectedHyperliquidWorkerConfig(),
    ...expectedCarryWorkerConfig(),
  };
  for (const [name, expected] of Object.entries(expectedRuntime)) {
    if (composeScalar(compose, name) !== expected) {
      reasons.push(`${name.toLowerCase()}_mismatch`);
    }
  }
  return reasons;
}

export function phalaJitProvisioningEnabled(): boolean {
  return !privateAgentRemoteExecutionDisabled() && boolEnv("GHOLA_PRIVATE_AGENT_JIT_PROVISIONING");
}

export function phalaIdleShutdownEnabled(): boolean {
  if (env("GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN")?.toLowerCase() === "false") {
    return false;
  }
  return boolEnv("GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN") || boolEnv("GHOLA_PRIVATE_AGENT_JIT_PROVISIONING");
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

export async function markPhalaPrivateAgentActivityWithShutdown(input: {
  reason: string;
  leaseMs?: number;
  now?: Date;
}) {
  const lease = await markPhalaPrivateAgentActivity(input);
  if (!phalaIdleShutdownEnabled()) {
    return { lease, shutdown_armed: false, shutdown_disabled: true };
  }
  const schedule = await schedulePhalaIdleShutdown(lease);
  if (!schedule.scheduled) {
    throw new Error(
      schedule.reason ?? "Durable Phala idle shutdown could not be scheduled.",
    );
  }
  return {
    lease,
    shutdown_armed: true,
    shutdown_disabled: false,
    workflow_run_id: schedule.run_id ?? null,
  };
}

export function privateAgentRemoteExecutionDisabled(): boolean {
  return (
    boolEnv("GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED") ||
    boolEnv("GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN")
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
  if (!phalaWorkerCapabilitySecret()) {
    return "GHOLA_WORKER_CAPABILITY_SECRET is required for scoped worker authorization.";
  }
  if (!phalaWorkerFundingSigningKey()) {
    return "GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY is required for attested funding receipts.";
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
  const hyperliquid = expectedHyperliquidWorkerConfig();
  const carry = expectedCarryWorkerConfig();
  return [
    "services:",
    "  private-agent-worker:",
    `    image: ${imageReference}`,
    "    restart: unless-stopped",
    "    ports:",
    '      - "8787:8787"',
    "    environment:",
    '      PORT: "8787"',
    '      NODE_ENV: "production"',
    '      PRIVATE_AGENT_PROVIDER_ID: "phala"',
    '      PRIVATE_AGENT_TEE_KIND: "phala"',
    '      PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    '      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "${PRIVATE_AGENT_WORKER_CAPABILITY_SECRET}"',
    '      PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true"',
    '      PRIVATE_AGENT_FUNDING_SIGNING_KEY: "${PRIVATE_AGENT_FUNDING_SIGNING_KEY}"',
    '      PRIVATE_AGENT_ALLOW_UNATTESTED_DEV: "false"',
    '      PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true"',
    `      PHALA_CVM_IMAGE_DIGEST: "${imageDigest}"`,
    composeEnvLine("PRIVATE_AGENT_VENUE_DRY_RUN", workerEnv("PRIVATE_AGENT_VENUE_DRY_RUN", "false")),
    composeEnvLine("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", workerEnv("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", "false")),
    composeEnvLine("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", workerEnv("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", "60")),
    composeEnvLine("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", "0")),
    ...Object.entries(hyperliquid).map(([name, value]) => composeEnvLine(name, value)),
    ...Object.entries(carry).map(([name, value]) => composeEnvLine(name, value)),
    composeEnvLine("PRIVATE_AGENT_LIGHTER_ETHEREUM_RPC_URL", workerEnv(
      "PRIVATE_AGENT_LIGHTER_ETHEREUM_RPC_URL",
      "",
      ["GHOLA_LIGHTER_ETHEREUM_RPC_URL"],
    )),
    composeEnvLine("PRIVATE_AGENT_LIGHTER_API_URL", workerEnv(
      "PRIVATE_AGENT_LIGHTER_API_URL",
      "https://mainnet.zklighter.elliot.ai",
    )),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE", "disabled", ["GHOLA_SOLANA_PERPS_LIVE_MODE"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET", "false", ["GHOLA_SOLANA_PERPS_ALLOW_MAINNET"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD", workerLiveEnv("PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD", "5", ["GHOLA_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_RPC_URL", workerEnv("PRIVATE_AGENT_SOLANA_RPC_URL", "", ["GHOLA_SOLANA_RPC_URL", "SOLANA_RPC_URL"])),
    composeEnvLine("PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS", workerEnv("PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS", "0", ["GHOLA_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS"])),
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

  const status = cvmStatus(info);
  const runtimeConfigDrift = phalaWorkerRuntimeConfigDrift(info);
  if (status !== "running") {
    // Starting/stopped CVMs cannot pass the recipient or attestation checks.
    // Return after the inexpensive state lookup so native wake polling does
    // not repeatedly spend up to five seconds probing an unavailable worker.
    return {
      id: "phala",
      label: "Phala TEE",
      configured: true,
      available: false,
      attested: false,
      supports_sealed_secrets: false,
      supports_background_agents: false,
      supports_trading_execution: false,
      reason: "Phala worker is starting; verified execution is not ready yet.",
      evidence: {
        tee_kind: "phala",
        verifier_url_configured: true,
        execution_url_configured: false,
        image_digest_configured: Boolean(phalaWorkerImageDigest()),
        recipient_configured: false,
        provisioning_enabled: phalaJitProvisioningEnabled(),
        cvm_status: status || null,
        report_data_bound: false,
        funding_signer_bound: false,
        phala_attestation_present: false,
        runtime_config_matches_requested_mode: runtimeConfigDrift.length === 0,
        runtime_config_drift_reasons: runtimeConfigDrift,
      },
    };
  }
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
        undefined,
        phalaRecipientFetchTimeoutMs(),
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
  const runtimeConfigMatchesRequestedMode = runtimeConfigDrift.length === 0;
  const ready =
    status === "running" &&
    Boolean(executionUrl) &&
    recipientReady &&
    attested &&
    runtimeConfigMatchesRequestedMode;

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
      : !runtimeConfigMatchesRequestedMode
        ? "Phala worker runtime configuration does not match the requested live-trading policy."
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
      runtime_config_matches_requested_mode: runtimeConfigMatchesRequestedMode,
      runtime_config_drift_reasons: runtimeConfigDrift,
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
  const name = phalaCvmName();
  const existing = phalaWakeInFlight.get(name);
  if (existing) return existing;

  const wake = ensurePhalaPrivateAgentProvisionedOnce(input).finally(() => {
    if (phalaWakeInFlight.get(name) === wake) phalaWakeInFlight.delete(name);
  });
  phalaWakeInFlight.set(name, wake);
  return wake;
}

async function ensurePhalaPrivateAgentProvisionedOnce(input: {
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
  const capabilitySecret = phalaWorkerCapabilitySecret();
  if (!client || !token || !capabilitySecret) {
    return {
      attempted: false,
      ready: false,
      status: "missing_config",
      reason: "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.",
    };
  }

  const name = phalaCvmName();
  let info: unknown = null;
  let state: unknown = null;
  let confirmedMissing = false;
  try {
    info = await client.getCvmInfo({ id: name }, { schema: false });
  } catch (error) {
    if (errorStatusCode(error) === 404) {
      confirmedMissing = true;
    } else {
      return {
        attempted: false,
        ready: false,
        status: "failed",
        reason: "Phala CVM lookup failed; provisioning was not attempted to avoid creating duplicate paid capacity.",
        cvm_name: name,
      };
    }
  }
  if (info) {
    state = await client.getCvmState({ id: name }, { schema: false }).catch(() => null);
  }

  let status = cvmStatus(state) || cvmStatus(info);
  if (status === "running") {
    const discovered = await discoverPhalaPrivateAgentProvider();
    if (discovered?.available) {
      return {
        attempted: false,
        ready: true,
        status: "already_ready",
        cvm_name: name,
      };
    }
  }

  if (confirmedMissing) {
    try {
      const { encryptEnvVars } = await import("@phala/cloud");
      const provision = await client.provisionCvm({
        name,
        instance_type: env("GHOLA_PHALA_PRIVATE_AGENT_INSTANCE_TYPE") ?? "tdx.small",
        ...(env("GHOLA_PHALA_PRIVATE_AGENT_REGION")
          ? { region: env("GHOLA_PHALA_PRIVATE_AGENT_REGION") }
          : {}),
        compose_file: {
          docker_compose_file: buildPhalaWorkerCompose(),
          allowed_envs: [
            "PRIVATE_AGENT_EXECUTION_TOKEN",
            "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
            "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
          ],
          gateway_enabled: true,
          kms_enabled: true,
          public_logs: false,
          public_sysinfo: false,
        },
        env_keys: [
          "PRIVATE_AGENT_EXECUTION_TOKEN",
          "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
          "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
        ],
        listed: false,
      });
      const encryptedEnv = await encryptEnvVars(
        [
          { key: "PRIVATE_AGENT_EXECUTION_TOKEN", value: token },
          { key: "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET", value: capabilitySecret },
          { key: "PRIVATE_AGENT_FUNDING_SIGNING_KEY", value: phalaWorkerFundingSigningKey()! },
        ],
        provision.app_env_encrypt_pubkey,
      );
      info = await client.commitCvmProvision(
        {
          app_id: provision.app_id,
          compose_hash: provision.compose_hash,
          encrypted_env: encryptedEnv,
          env_keys: [
            "PRIVATE_AGENT_EXECUTION_TOKEN",
            "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
            "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
          ],
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
    status = cvmStatus(info);
  } else if (info && status === "stopped") {
    try {
      await client.startCvm({ id: name });
      status = "starting";
    } catch (error) {
      return {
        attempted: true,
        ready: false,
        status: "failed",
        reason: error instanceof Error ? error.message : "Phala CVM start failed.",
        cvm_name: name,
      };
    }
  }

  const waitForReadyMs = input.waitForReadyMs ?? 0;
  if (waitForReadyMs > 0) {
    const deadline = Date.now() + waitForReadyMs;
    if (status !== "running" && waitForReadyMs >= 10_000) {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), waitForReadyMs);
      try {
        const { watchCvmState } = await import("@phala/cloud");
        await watchCvmState(
          client as unknown as Parameters<typeof watchCvmState>[0],
          {
            id: name,
            target: "running",
            interval: 5,
            timeout: Math.max(10, Math.ceil(waitForReadyMs / 1_000)),
            maxRetries: 1,
            retryDelay: 0,
          },
          { signal: controller.signal },
        );
        status = "running";
      } catch {
        // The bounded recipient/attestation probe below remains fail-closed.
      } finally {
        clearTimeout(abortTimer);
      }
    }

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
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(phalaWorkerReadyPollMs(), remaining)),
      );
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
  verifiedRuntimeReady?: boolean;
}): Promise<PhalaProvisionResult> {
  if (privateAgentRemoteExecutionDisabled()) {
    return ensurePhalaPrivateAgentProvisioned({
      waitForReadyMs: input.waitForReadyMs,
    });
  }
  try {
    // Persist the no-compute shutdown timer before any paid Phala capacity is
    // started. If the durable timer cannot be armed, fail closed on wake.
    await markPhalaPrivateAgentActivityWithShutdown({
      reason: input.reason,
      leaseMs: input.leaseMs,
    });
  } catch {
    return {
      attempted: false,
      ready: false,
      status: "failed",
      reason:
        "Private compute stayed off because its durable idle shutdown could not be armed.",
      cvm_name: phalaCvmName(),
    };
  }
  if (input.verifiedRuntimeReady) {
    return {
      attempted: false,
      ready: true,
      status: "already_ready",
      reason: "Fresh sealed-runtime health evidence verified before lease renewal.",
      cvm_name: phalaCvmName(),
    };
  }
  return ensurePhalaPrivateAgentProvisioned({
    waitForReadyMs: input.waitForReadyMs,
  });
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
