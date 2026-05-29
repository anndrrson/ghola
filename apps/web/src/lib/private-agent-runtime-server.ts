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
      recipient_id: "mock_attested:dev",
      x25519_pub_hex: "11".repeat(32),
      tee_kind: "none",
      measurement_hex: "00".repeat(32),
      attestation_hash: "mock",
      expires_at_unix: null,
    },
  };
}

export async function getPrivateAgentRuntimeStatus(): Promise<PrivateAgentRuntimeStatus> {
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
  });
}
