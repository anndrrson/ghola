import { createHash } from "node:crypto";
import type { ConfidentialComputeProviderStatus } from "./private-agent-runtime";

const DEFAULT_WORKER_IMAGE =
  "ghcr.io/anndrrson/ghola-private-agent-worker:private-agent-worker-128f9e8@sha256:9e2cb99b475ab193bfa5cc9c8c2dcd4b1ed314586ee4801aa217a2eeeb6c66f7";
const DEFAULT_WORKER_IMAGE_DIGEST =
  "sha256:9e2cb99b475ab193bfa5cc9c8c2dcd4b1ed314586ee4801aa217a2eeeb6c66f7";
const DEFAULT_CVM_NAME = "ghola-private-agent-worker";
const RECIPIENT_REPORT_DOMAIN = "ghola-private-agent-recipient-v1";

interface PhalaRecipientMetadata {
  recipient_id?: string;
  x25519_pub_hex?: string;
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
    env("GHOLA_HYPERLIQUID_LIVE_MODE") === "tiny_fill"
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
  return !liveHyperliquidEnabled() || liveWorkerImageConfigured();
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

export function phalaJitProvisioningEnabled(): boolean {
  return boolEnv("GHOLA_PRIVATE_AGENT_JIT_PROVISIONING");
}

export function phalaJitProvisioningConfigIssue(): string | null {
  if (!phalaApiKey()) {
    return "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.";
  }
  if (!phalaWorkerExecutionToken()) {
    return "PHALA_CLOUD_API_KEY and GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN are required.";
  }
  if (!phalaWorkerImageConfiguredForRequestedMode()) {
    return "GHOLA_PRIVATE_AGENT_WORKER_IMAGE and GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST are required before provisioning Hyperliquid live mode.";
  }
  return null;
}

export function phalaJitProvisioningConfigured(): boolean {
  return Boolean(phalaJitProvisioningEnabled() && !phalaJitProvisioningConfigIssue());
}

export function expectedRecipientReportDataHex(input: {
  recipientId: string;
  x25519PubHex: string;
}): string {
  return `0x${sha256Hex(
    `${RECIPIENT_REPORT_DOMAIN}\0${input.recipientId}\0${input.x25519PubHex.toLowerCase()}`,
  )}`;
}

export function buildPhalaWorkerCompose(input: {
  image?: string;
  imageDigest?: string;
} = {}): string {
  const image = input.image ?? phalaWorkerImage();
  const imageDigest = input.imageDigest ?? phalaWorkerImageDigest();
  return [
    "services:",
    "  private-agent-worker:",
    `    image: ${image}`,
    "    restart: unless-stopped",
    "    ports:",
    '      - "8787:8787"',
    "    environment:",
    '      PORT: "8787"',
    '      PRIVATE_AGENT_PROVIDER_ID: "phala"',
    '      PRIVATE_AGENT_TEE_KIND: "phala"',
    '      PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    '      PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true"',
    `      PHALA_CVM_IMAGE_DIGEST: "${imageDigest}"`,
    composeEnvLine("PRIVATE_AGENT_VENUE_DRY_RUN", workerEnv("PRIVATE_AGENT_VENUE_DRY_RUN", "false")),
    composeEnvLine("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", workerEnv("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", "false")),
    composeEnvLine("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", workerEnv("PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE", "60")),
    composeEnvLine("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", workerEnv("PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD", "0")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", workerEnv("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "false")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", workerLiveEnv("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", "disabled")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD", workerLiveEnv("PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD", "5")),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD", workerEnv("PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD", "25", ["GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD"])),
    composeEnvLine("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS", workerEnv("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS", "50", ["GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS"])),
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
  const expectedReportData =
    recipient?.recipient_id && recipient?.x25519_pub_hex
      ? expectedRecipientReportDataHex({
          recipientId: recipient.recipient_id,
          x25519PubHex: recipient.x25519_pub_hex,
        })
      : null;
  const reportDataBound =
    expectedReportData !== null &&
    recipient?.report_data_hex?.toLowerCase() === expectedReportData.toLowerCase();
  const recipientReady =
    typeof recipient?.recipient_id === "string" &&
    validX25519Hex(recipient.x25519_pub_hex) &&
    recipient.attested_ready === true &&
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
    reason: ready
      ? null
      : "Phala worker exists but is not yet running with verified attestation-bound recipient evidence.",
    ...(recipientReady && recipient?.recipient_id && recipient?.x25519_pub_hex
      ? {
          sealed_recipient: {
            recipient_id: recipient.recipient_id,
            x25519_pub_hex: recipient.x25519_pub_hex,
            tee_kind: recipient.tee_kind ?? "phala",
            measurement_hex: recipient.measurement_hex ?? null,
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
      phala_attestation_present: attested,
    },
  };
}

export async function ensurePhalaPrivateAgentProvisioned(input: {
  waitForReadyMs?: number;
} = {}): Promise<PhalaProvisionResult> {
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
      const provision = await client.provisionCvm({
        name,
        instance_type: env("GHOLA_PHALA_PRIVATE_AGENT_INSTANCE_TYPE") ?? "tdx.small",
        ...(env("GHOLA_PHALA_PRIVATE_AGENT_REGION")
          ? { region: env("GHOLA_PHALA_PRIVATE_AGENT_REGION") }
          : {}),
        compose_file: {
          docker_compose_file: buildPhalaWorkerCompose(),
          allowed_envs: ["PRIVATE_AGENT_EXECUTION_TOKEN"],
          gateway_enabled: true,
          kms_enabled: true,
          public_logs: false,
          public_sysinfo: false,
        },
        env_keys: ["PRIVATE_AGENT_EXECUTION_TOKEN"],
        listed: false,
      });
      const encryptedEnv = await encryptEnvVars(
        [{ key: "PRIVATE_AGENT_EXECUTION_TOKEN", value: token }],
        provision.app_env_encrypt_pubkey,
      );
      info = await client.commitCvmProvision(
        {
          app_id: provision.app_id,
          compose_hash: provision.compose_hash,
          encrypted_env: encryptedEnv,
          env_keys: ["PRIVATE_AGENT_EXECUTION_TOKEN"],
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
