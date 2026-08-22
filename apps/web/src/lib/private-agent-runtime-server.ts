import {
  buildPrivateAgentRuntimeStatus,
  type ConfidentialComputeProviderId,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "@/lib/private-agent-runtime";
import {
  summarizePrivateBalance,
  type PaymentHealth,
} from "@/lib/private-balance";
import {
  discoverPhalaPrivateAgentProvider,
  expectedRecipientReportDataHex,
  privateAgentRemoteExecutionDisabled,
  phalaJitProvisioningConfigIssue,
  phalaJitProvisioningConfigured,
  phalaJitProvisioningEnabled,
  phalaWorkerImageConfiguredForRequestedMode,
} from "@/lib/private-agent-phala";

interface RelayHealth {
  attested_provider_count?: number;
  capacity_reason_codes?: string[];
  private_capacity_ready?: boolean;
  private_ready?: boolean;
  tee_kind?: string | null;
}

interface AttestedProvider {
  enclave_key_id?: string;
  provider_id?: string;
  tee_kind?: string | null;
  enclave_x25519_pub_hex?: string;
  measurement_hex?: string | null;
  attestation_hash?: string | null;
  expires_at_unix?: number | null;
}

interface PhalaWorkerHealth {
  status?: string;
  ok?: boolean;
  ready?: boolean;
  attested?: boolean;
  attested_ready?: boolean;
  sealed_execution_required?: boolean;
  plaintext_rejected?: boolean;
  provider?: string;
  tee_kind?: string;
  checked_at?: string;
  observed_at?: string;
  runtime_attestation_commitment?: string | null;
  runtime_measurement_commitment?: string | null;
  runtime_policy_commitment?: string | null;
  image_digest?: string | null;
  report_data_hex?: string | null;
  attestation_hash?: string | null;
  quote_hash?: string | null;
  missing?: unknown[];
}

interface PhalaWorkerRecipient {
  recipient_id?: string;
  x25519_pub_hex?: string;
  funding_signer_public_key_b64?: string | null;
  tee_kind?: string | null;
  measurement_hex?: string | null;
  image_digest?: string | null;
  report_data_hex?: string | null;
  attestation_hash?: string | null;
  quote_hash?: string | null;
  attested_ready?: boolean;
  expires_at_unix?: number | null;
}

const ATTESTATION_STATUS_MAX_AGE_MS = 5 * 60_000;
const ATTESTATION_STATUS_FETCH_TIMEOUT_MS = 12_000;
const WORKER_EVIDENCE_FETCH_TIMEOUT_MS = 18_000;
const X25519_PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;

function thumperBase(): string {
  return (
    process.env.NEXT_PUBLIC_THUMPER_API_URL ||
    process.env.THUMPER_API_URL ||
    "https://thumper-cloud.onrender.com"
  );
}

function relayBase(): string {
  return (
    process.env.NEXT_PUBLIC_THUMPER_RELAY_URL ||
    process.env.THUMPER_RELAY_URL ||
    "https://ghola-relay.onrender.com"
  );
}

function envSet(...keys: string[]): boolean {
  return keys.some((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function envTrue(key: string): boolean {
  return process.env[key]?.trim() === "true";
}

function preferredProvider(): ConfidentialComputeProviderId | null {
  const raw = process.env.GHOLA_PRIVATE_AGENT_PROVIDER;
  if (
    raw === "local" ||
    raw === "relay_attested_pool" ||
    raw === "phala" ||
    raw === "gensyn" ||
    raw === "mock_attested"
  ) {
    return raw;
  }
  return null;
}

async function fetchJson<T>(url: URL, timeoutMs = 4000): Promise<T | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
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

function normalizedHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function phalaProviderFromAttestationStatus(input: {
  status: PrivateAgentRuntimeStatus;
  executionUrl: string;
  recipientId: string;
  recipientX25519: string;
  measurementHex: string;
  nowMs?: number;
}): ConfidentialComputeProviderStatus | null {
  const checkedAtMs = Date.parse(input.status.checked_at);
  if (
    !Number.isFinite(checkedAtMs) ||
    Math.abs((input.nowMs ?? Date.now()) - checkedAtMs) > ATTESTATION_STATUS_MAX_AGE_MS
  ) {
    return null;
  }
  if (input.status.selected_provider !== "phala") return null;
  const provider = input.status.providers.find((candidate) => candidate.id === "phala");
  const recipient = provider?.sealed_recipient;
  const evidence = provider?.evidence;
  const expectedExecutionUrl = normalizedHttpsUrl(input.executionUrl);
  const verifiedExecutionUrl = normalizedHttpsUrl(provider?.execution_url);
  if (
    !provider ||
    !recipient ||
    !expectedExecutionUrl ||
    verifiedExecutionUrl !== expectedExecutionUrl ||
    recipient.recipient_id !== input.recipientId ||
    recipient.x25519_pub_hex.toLowerCase() !== input.recipientX25519.toLowerCase() ||
    recipient.measurement_hex?.toLowerCase() !== input.measurementHex.toLowerCase() ||
    !recipient.attestation_hash ||
    provider.configured !== true ||
    provider.available !== true ||
    provider.attested !== true ||
    provider.supports_sealed_secrets !== true ||
    provider.supports_background_agents !== true ||
    provider.supports_trading_execution !== true ||
    evidence?.report_data_bound !== true ||
    evidence?.funding_signer_bound !== true ||
    evidence?.phala_attestation_present !== true
  ) {
    return null;
  }
  return provider;
}

export function phalaProviderFromWorkerEvidence(input: {
  executionUrl: string;
  health: PhalaWorkerHealth;
  recipient: PhalaWorkerRecipient;
  fundingSignerPins: string[];
  imageDigestPin: string;
  nowMs?: number;
}): ConfidentialComputeProviderStatus | null {
  const executionUrl = normalizedHttpsUrl(input.executionUrl);
  const checkedAtMs = Date.parse(input.health.checked_at || input.health.observed_at || "");
  const recipientId = input.recipient.recipient_id?.trim() || "";
  const recipientX25519 = input.recipient.x25519_pub_hex?.trim() || "";
  const fundingSigner = input.recipient.funding_signer_public_key_b64?.trim() || "";
  const fundingSignerPins = new Set(input.fundingSignerPins.map((pin) => pin.trim()).filter(Boolean));
  const imageDigestPin = input.imageDigestPin.trim().toLowerCase();
  const recipientImageDigest = (
    input.recipient.image_digest || input.recipient.measurement_hex || ""
  ).trim().toLowerCase();
  const expectedReportData = recipientId && recipientX25519 && fundingSigner
    ? expectedRecipientReportDataHex({
        recipientId,
        x25519PubHex: recipientX25519,
        fundingSignerPublicKeyB64: fundingSigner,
      }).toLowerCase()
    : "";
  const recipientReportData = input.recipient.report_data_hex?.trim().toLowerCase() || "";
  const healthReportData = input.health.report_data_hex?.trim().toLowerCase() || "";
  const recipientAttestation = input.recipient.attestation_hash?.trim().toLowerCase() || "";
  const healthAttestation = input.health.attestation_hash?.trim().toLowerCase() || "";
  const recipientQuote = input.recipient.quote_hash?.trim().toLowerCase() || "";
  const healthQuote = input.health.quote_hash?.trim().toLowerCase() || "";
  const expiresAtMs = typeof input.recipient.expires_at_unix === "number"
    ? input.recipient.expires_at_unix * 1_000
    : null;

  if (
    !executionUrl ||
    !Number.isFinite(checkedAtMs) ||
    Math.abs((input.nowMs ?? Date.now()) - checkedAtMs) > ATTESTATION_STATUS_MAX_AGE_MS ||
    input.health.status !== "green" ||
    input.health.ok !== true ||
    input.health.ready !== true ||
    input.health.attested !== true ||
    input.health.attested_ready !== true ||
    input.health.sealed_execution_required !== true ||
    input.health.plaintext_rejected !== true ||
    input.health.provider !== "phala" ||
    input.health.tee_kind !== "phala" ||
    !input.health.runtime_attestation_commitment ||
    !input.health.runtime_measurement_commitment ||
    !input.health.runtime_policy_commitment ||
    (Array.isArray(input.health.missing) && input.health.missing.length > 0) ||
    input.recipient.attested_ready !== true ||
    input.recipient.tee_kind !== "phala" ||
    !recipientId ||
    !X25519_PUBLIC_KEY_RE.test(recipientX25519) ||
    !fundingSigner ||
    !fundingSignerPins.has(fundingSigner) ||
    !imageDigestPin ||
    recipientImageDigest !== imageDigestPin ||
    input.health.image_digest?.trim().toLowerCase() !== imageDigestPin ||
    !expectedReportData ||
    recipientReportData !== expectedReportData ||
    healthReportData !== expectedReportData ||
    !recipientAttestation ||
    !healthAttestation ||
    !recipientQuote ||
    !healthQuote ||
    recipientAttestation !== recipientQuote ||
    healthAttestation !== healthQuote ||
    (expiresAtMs !== null && expiresAtMs <= (input.nowMs ?? Date.now()))
  ) {
    return null;
  }

  return {
    id: "phala",
    label: "Phala TEE",
    configured: true,
    available: true,
    attested: true,
    supports_sealed_secrets: true,
    supports_background_agents: true,
    supports_trading_execution: true,
    execution_url: executionUrl,
    reason: null,
    sealed_recipient: {
      recipient_id: recipientId,
      x25519_pub_hex: recipientX25519,
      tee_kind: "phala",
      measurement_hex: recipientImageDigest,
      attestation_hash: input.recipient.attestation_hash?.trim() || null,
      expires_at_unix: input.recipient.expires_at_unix ?? null,
    },
    evidence: {
      tee_kind: "phala",
      execution_url_configured: true,
      image_digest_configured: true,
      recipient_configured: true,
      report_data_bound: true,
      funding_signer_bound: true,
      phala_attestation_present: true,
      direct_worker_evidence: true,
    },
  };
}

async function directWorkerPhalaProvider(): Promise<ConfidentialComputeProviderStatus | null> {
  const executionUrl = normalizedHttpsUrl(
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    process.env.PHALA_AGENT_ENDPOINT?.trim(),
  );
  const fundingSignerPins = (
    process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || ""
  ).split(",").map((pin) => pin.trim()).filter(Boolean);
  const imageDigestPin = (
    process.env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST ||
    process.env.GHOLA_PRIVATE_AGENT_IMAGE_DIGEST ||
    process.env.PHALA_CVM_IMAGE_DIGEST ||
    ""
  ).trim();
  if (!executionUrl || fundingSignerPins.length === 0 || !imageDigestPin) return null;

  // The worker obtains fresh Dstack evidence for each response. Fetch these
  // sequentially to avoid contending on the guest attestation socket.
  const recipient = await fetchJson<PhalaWorkerRecipient>(
    new URL("/.well-known/private-agent-recipient", executionUrl),
    WORKER_EVIDENCE_FETCH_TIMEOUT_MS,
  );
  if (!recipient) return null;
  const health = await fetchJson<PhalaWorkerHealth>(
    new URL("/health", executionUrl),
    WORKER_EVIDENCE_FETCH_TIMEOUT_MS,
  );
  if (!health) return null;
  return phalaProviderFromWorkerEvidence({
    executionUrl,
    health,
    recipient,
    fundingSignerPins,
    imageDigestPin,
  });
}

async function mirroredPhalaProvider(): Promise<ConfidentialComputeProviderStatus | null> {
  const statusUrl = normalizedHttpsUrl(
    process.env.GHOLA_PRIVATE_AGENT_ATTESTATION_STATUS_URL?.trim(),
  );
  const executionUrl =
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    process.env.PHALA_AGENT_ENDPOINT?.trim() ||
    "";
  const recipientId =
    process.env.PHALA_ENCLAVE_KEY_ID?.trim() ||
    process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID?.trim() ||
    "";
  const recipientX25519 =
    process.env.PHALA_ENCLAVE_X25519_PUB_HEX?.trim() ||
    process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_X25519_PUB_HEX?.trim() ||
    "";
  const measurementHex =
    process.env.PHALA_CVM_MEASUREMENT_HEX?.trim() ||
    process.env.GHOLA_PRIVATE_AGENT_MEASUREMENT_HEX?.trim() ||
    "";
  if (!statusUrl || !executionUrl || !recipientId || !recipientX25519 || !measurementHex) {
    return null;
  }
  const status = await fetchJson<PrivateAgentRuntimeStatus>(
    new URL(statusUrl),
    ATTESTATION_STATUS_FETCH_TIMEOUT_MS,
  );
  if (!status) return null;
  return phalaProviderFromAttestationStatus({
    status,
    executionUrl,
    recipientId,
    recipientX25519,
    measurementHex,
  });
}

function localProvider(): ConfidentialComputeProviderStatus {
  return {
    id: "local",
    label: "Local browser",
    configured: true,
    available: true,
    attested: false,
    supports_sealed_secrets: false,
    supports_background_agents: false,
    supports_trading_execution: false,
    reason: "Local execution can prepare strategies but cannot provide remote attestation.",
  };
}

function relayProvider(
  relayHealth: RelayHealth | null,
  attestedProviders: unknown[] | null,
): ConfidentialComputeProviderStatus {
  const providers = Array.isArray(attestedProviders)
    ? (attestedProviders.filter(isAttestedProvider) as AttestedProvider[])
    : [];
  const selected = providers[0] ?? null;
  const attestedProviderCount =
    providers.length || relayHealth?.attested_provider_count || 0;
  const executionConfigured = envSet("GHOLA_PRIVATE_AGENT_EXECUTION_URL");
  const executionUrl = process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() || null;
  const ready =
    relayHealth?.private_capacity_ready === true &&
    attestedProviderCount > 0 &&
    executionConfigured;
  const reason =
    ready
      ? null
      : relayHealth?.capacity_reason_codes?.join(", ") ||
        (!executionConfigured
          ? "Private agent execution URL is not configured for the attested pool."
          : null) ||
        "No attested relay providers are currently available.";

  return {
    id: "relay_attested_pool",
    label: "Attested provider pool",
    configured: relayHealth !== null,
    available: ready,
    attested: attestedProviderCount > 0,
    supports_sealed_secrets: ready,
    supports_background_agents: ready,
    supports_trading_execution: ready,
    execution_url: executionUrl,
    reason,
    ...(selected?.enclave_key_id && selected?.enclave_x25519_pub_hex
      ? {
          sealed_recipient: {
            recipient_id: selected.enclave_key_id,
            x25519_pub_hex: selected.enclave_x25519_pub_hex,
            tee_kind: selected.tee_kind ?? null,
            measurement_hex: selected.measurement_hex ?? null,
            attestation_hash: selected.attestation_hash ?? null,
            expires_at_unix: selected.expires_at_unix ?? null,
          },
        }
      : {}),
    evidence: {
      tee_kind: relayHealth?.tee_kind ?? null,
      attested_provider_count: attestedProviderCount,
      execution_url_configured: executionConfigured,
    },
  };
}

function isAttestedProvider(value: unknown): value is AttestedProvider {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enclave_key_id === "string" &&
    typeof record.enclave_x25519_pub_hex === "string"
  );
}

async function phalaProvider(): Promise<ConfidentialComputeProviderStatus> {
  const discovered = await discoverPhalaPrivateAgentProvider().catch(() => null);
  if (discovered) return discovered;
  const directWorker = await directWorkerPhalaProvider().catch(() => null);
  if (directWorker) return directWorker;
  const mirrored = await mirroredPhalaProvider().catch(() => null);
  if (mirrored) return mirrored;
  if (phalaJitProvisioningEnabled()) {
    const configIssue = phalaJitProvisioningConfigIssue();
    const configured = phalaJitProvisioningConfigured();
    return {
      id: "phala",
      label: "Phala TEE",
      configured,
      available: false,
      attested: false,
      supports_sealed_secrets: false,
      supports_background_agents: false,
      supports_trading_execution: false,
      reason: configured
        ? "Phala just-in-time provisioning is armed. The worker starts after a paid private-agent request and remains unavailable until attestation-bound recipient evidence is verified."
        : configIssue ?? "Phala just-in-time provisioning is enabled but missing required configuration.",
      evidence: {
        provisioning_enabled: true,
        execution_url_configured: false,
        image_digest_configured: phalaWorkerImageConfiguredForRequestedMode(),
        recipient_configured: false,
      },
    };
  }

  const executionConfigured = envSet(
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "PHALA_AGENT_ENDPOINT",
  );
  const executionUrl =
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    process.env.PHALA_AGENT_ENDPOINT?.trim() ||
    null;
  const apiConfigured = envSet("PHALA_CLOUD_API_KEY", "PHALA_API_KEY");
  const verifierConfigured = envSet(
    "PHALA_ATTESTATION_VERIFIER_URL",
    "GHOLA_TEE_ATTESTATION_VERIFIER_URL",
  );
  const imageDigestConfigured = envSet(
    "PHALA_CVM_IMAGE_DIGEST",
    "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
  );
  const recipientId =
    process.env.PHALA_ENCLAVE_KEY_ID ||
    process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID ||
    "";
  const recipientX25519 =
    process.env.PHALA_ENCLAVE_X25519_PUB_HEX ||
    process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_X25519_PUB_HEX ||
    "";
  const recipientConfigured = recipientId.trim().length > 0 && recipientX25519.trim().length > 0;
  const attestedReady =
    process.env.GHOLA_PRIVATE_AGENT_ATTESTED_READY === "true" &&
    verifierConfigured &&
    imageDigestConfigured &&
    recipientConfigured;
  const configured = executionConfigured && apiConfigured;
  const available = configured && attestedReady;

  let reason: string | null = null;
  if (!configured) {
    reason = "Phala execution URL/API key are not configured.";
  } else if (!attestedReady) {
    reason =
      "Phala is configured but not marked attested-ready. Configure verifier, image digest, enclave recipient key, and GHOLA_PRIVATE_AGENT_ATTESTED_READY=true after verification.";
  }

  return {
    id: "phala",
    label: "Phala TEE",
    configured,
    available,
    attested: attestedReady,
    supports_sealed_secrets: available,
    supports_background_agents: available,
    supports_trading_execution: available,
    execution_url: executionUrl,
    reason,
    ...(recipientConfigured
      ? {
          sealed_recipient: {
            recipient_id: recipientId,
            x25519_pub_hex: recipientX25519,
            tee_kind: "phala",
            measurement_hex:
              process.env.PHALA_CVM_MEASUREMENT_HEX ||
              process.env.GHOLA_PRIVATE_AGENT_MEASUREMENT_HEX ||
              null,
            attestation_hash:
              process.env.PHALA_ATTESTATION_HASH ||
              process.env.GHOLA_PRIVATE_AGENT_ATTESTATION_HASH ||
              null,
            expires_at_unix: null,
          },
        }
      : {}),
    evidence: {
      verifier_url_configured: verifierConfigured,
      execution_url_configured: executionConfigured,
      image_digest_configured: imageDigestConfigured,
      recipient_configured: recipientConfigured,
    },
  };
}

function gensynProvider(): ConfidentialComputeProviderStatus {
  const executionConfigured = envSet(
    "GENSYN_PRIVATE_AGENT_EXECUTION_URL",
    "GENSYN_API_URL",
  );
  const executionUrl =
    process.env.GENSYN_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    process.env.GENSYN_API_URL?.trim() ||
    null;
  const verifierConfigured = envSet("GENSYN_ATTESTATION_VERIFIER_URL");
  const recipientId = process.env.GENSYN_ENCLAVE_KEY_ID || "";
  const recipientX25519 = process.env.GENSYN_ENCLAVE_X25519_PUB_HEX || "";
  const recipientConfigured =
    recipientId.trim().length > 0 && recipientX25519.trim().length > 0;
  const confidentialReady =
    process.env.GENSYN_CONFIDENTIAL_EXECUTION_READY === "true" &&
    executionConfigured &&
    verifierConfigured &&
    recipientConfigured;
  const configured = executionConfigured;

  return {
    id: "gensyn",
    label: "Gensyn",
    configured,
    available: confidentialReady,
    attested: confidentialReady,
    supports_sealed_secrets: confidentialReady,
    supports_background_agents: confidentialReady,
    supports_trading_execution: confidentialReady,
    execution_url: executionUrl,
    reason: confidentialReady
      ? null
      : configured
        ? "Gensyn is configured but confidential attestation or sealed-recipient publishing is not ready for private trading agents."
        : "Gensyn is not configured. It remains a future provider target.",
    ...(recipientConfigured
      ? {
          sealed_recipient: {
            recipient_id: recipientId,
            x25519_pub_hex: recipientX25519,
            tee_kind: "tdx",
            measurement_hex: process.env.GENSYN_MEASUREMENT_HEX || null,
            attestation_hash: process.env.GENSYN_ATTESTATION_HASH || null,
            expires_at_unix: null,
          },
        }
      : {}),
    evidence: {
      verifier_url_configured: verifierConfigured,
      execution_url_configured: executionConfigured,
      recipient_configured: recipientConfigured,
    },
  };
}

function mockAttestedProvider(): ConfidentialComputeProviderStatus | null {
  if (process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER !== "true") return null;
  const recipientId = process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID?.trim() || "mock_attested:dev";
  const recipientX25519 = process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_X25519_PUB_HEX?.trim() || "11".repeat(32);
  return {
    id: "mock_attested",
    label: "Mock attested provider",
    configured: true,
    available: true,
    attested: true,
    supports_sealed_secrets: true,
    supports_background_agents: true,
    supports_trading_execution: true,
    reason: null,
    sealed_recipient: {
      recipient_id: recipientId,
      x25519_pub_hex: recipientX25519,
      tee_kind: "none",
      measurement_hex: "00".repeat(32),
      attestation_hash: "mock",
      expires_at_unix: null,
    },
  };
}

export async function getPrivateAgentRuntimeStatus(): Promise<PrivateAgentRuntimeStatus> {
  const boundedBetaEnabled = envTrue("GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED");
  const operatorSpendLock = privateAgentRemoteExecutionDisabled();
  if (operatorSpendLock) {
    const status = buildPrivateAgentRuntimeStatus({
      providers: [
        localProvider(),
        {
          id: "phala",
          label: "Phala TEE",
          configured: false,
          available: false,
          attested: false,
          supports_sealed_secrets: false,
          supports_background_agents: false,
          supports_trading_execution: false,
          reason: "Remote private-agent execution is disabled by operator spend lock.",
          evidence: {
            provisioning_enabled: false,
            execution_url_configured: false,
          },
        },
      ],
      preferredProvider: preferredProvider(),
      shieldedRailReady: true,
      boundedBetaEnabled,
      operatorSpendLock,
    });
    return {
      ...status,
      blocking_reasons: Array.from(new Set([
        "operator_spend_lock",
        ...status.blocking_reasons,
      ])),
    };
  }

  const [paymentHealth, relayHealth, attestedProviders, phala] = await Promise.all([
    fetchJson<PaymentHealth>(new URL("/health/payments", thumperBase())),
    fetchJson<RelayHealth>(new URL("/health", relayBase())),
    fetchJson<unknown[]>(new URL("/providers/attested", relayBase())),
    phalaProvider(),
  ]);

  const providers = [
    localProvider(),
    relayProvider(relayHealth, attestedProviders),
    phala,
    gensynProvider(),
  ];
  const mockProvider = mockAttestedProvider();
  if (mockProvider) providers.push(mockProvider);

  return buildPrivateAgentRuntimeStatus({
    providers,
    preferredProvider: preferredProvider(),
    shieldedRailReady: summarizePrivateBalance(paymentHealth).privateSpendReady,
    boundedBetaEnabled,
    operatorSpendLock,
  });
}
