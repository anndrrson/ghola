export type ConfidentialComputeProviderId =
  | "local"
  | "relay_attested_pool"
  | "phala"
  | "gensyn"
  | "mock_attested";

export type PrivateAgentEntitlementTier =
  | "free"
  | "pro"
  | "private_agent"
  | "unlimited"
  | "enterprise"
  | "unknown";

export interface ConfidentialComputeProviderStatus {
  id: ConfidentialComputeProviderId;
  label: string;
  configured: boolean;
  available: boolean;
  attested: boolean;
  supports_sealed_secrets: boolean;
  supports_background_agents: boolean;
  supports_trading_execution: boolean;
  reason: string | null;
  sealed_recipient?: {
    recipient_id: string;
    x25519_pub_hex: string;
    tee_kind?: string | null;
    measurement_hex?: string | null;
    attestation_hash?: string | null;
    expires_at_unix?: number | null;
  };
  evidence?: {
    tee_kind?: string | null;
    attested_provider_count?: number | null;
    verifier_url_configured?: boolean;
    execution_url_configured?: boolean;
    image_digest_configured?: boolean;
    recipient_configured?: boolean;
    provisioning_enabled?: boolean;
    cvm_status?: string | null;
    report_data_bound?: boolean;
    phala_attestation_present?: boolean;
  };
}

export interface PrivateAgentRuntimeStatus {
  version: 1;
  checked_at: string;
  sealed_execution_required: true;
  entitlement_required: "paid_private_agent_plan";
  preferred_provider: ConfidentialComputeProviderId | null;
  selected_provider: ConfidentialComputeProviderId | null;
  remote_execution_ready: boolean;
  shielded_rail_ready: boolean;
  providers: ConfidentialComputeProviderStatus[];
  blocking_reasons: string[];
  disclosure: string;
}

export interface PrivateAgentAccessStatus {
  entitled: boolean;
  remote_execution_ready: boolean;
  selected_provider: ConfidentialComputeProviderId | null;
  blocking_reasons: string[];
  message: string;
}

export function normalizePrivateAgentTier(
  tier: string | null | undefined,
): PrivateAgentEntitlementTier {
  if (
    tier === "pro" ||
    tier === "private_agent" ||
    tier === "unlimited" ||
    tier === "enterprise"
  ) {
    return tier;
  }
  if (tier === "free") return "free";
  return "unknown";
}

export function hasPrivateAgentEntitlement(
  tier: string | null | undefined,
): boolean {
  const normalized = normalizePrivateAgentTier(tier);
  return (
    normalized === "private_agent" ||
    normalized === "unlimited" ||
    normalized === "enterprise"
  );
}

export function providerReadyForPrivateAgents(
  provider: ConfidentialComputeProviderStatus,
): boolean {
  const hasSealedRecipient =
    provider.id === "mock_attested" || Boolean(provider.sealed_recipient);
  return (
    provider.configured &&
    provider.available &&
    provider.attested &&
    hasSealedRecipient &&
    provider.supports_sealed_secrets &&
    provider.supports_background_agents &&
    provider.supports_trading_execution
  );
}

export function chooseConfidentialComputeProvider(
  providers: ConfidentialComputeProviderStatus[],
  preferredProvider?: ConfidentialComputeProviderId | null,
): ConfidentialComputeProviderStatus | null {
  const ready = providers.filter(providerReadyForPrivateAgents);
  if (preferredProvider) {
    const preferred = ready.find((provider) => provider.id === preferredProvider);
    if (preferred) return preferred;
  }
  return ready.find((provider) => provider.id !== "local") ?? ready[0] ?? null;
}

export function buildPrivateAgentRuntimeStatus(input: {
  checkedAt?: string;
  providers: ConfidentialComputeProviderStatus[];
  preferredProvider?: ConfidentialComputeProviderId | null;
  shieldedRailReady: boolean;
}): PrivateAgentRuntimeStatus {
  const selected = chooseConfidentialComputeProvider(
    input.providers,
    input.preferredProvider ?? null,
  );
  const blockingReasons: string[] = [];
  const remoteReady = Boolean(selected) && input.shieldedRailReady;

  if (!selected) {
    blockingReasons.push("no_attested_confidential_compute_provider");
  }
  if (!input.shieldedRailReady) {
    blockingReasons.push("no_ready_shielded_settlement_rail");
  }

  return {
    version: 1,
    checked_at: input.checkedAt ?? new Date().toISOString(),
    sealed_execution_required: true,
    entitlement_required: "paid_private_agent_plan",
    preferred_provider: input.preferredProvider ?? null,
    selected_provider: selected?.id ?? null,
    remote_execution_ready: remoteReady,
    shielded_rail_ready: input.shieldedRailReady,
    providers: input.providers,
    blocking_reasons: blockingReasons,
    disclosure:
      "Remote strategy execution is enabled only when an attested confidential-compute provider and a shielded settlement rail are both ready. Ghola must not downgrade these routes to public compute or public settlement.",
  };
}

export function evaluatePrivateAgentAccess(input: {
  runtime: PrivateAgentRuntimeStatus | null | undefined;
  tier: string | null | undefined;
}): PrivateAgentAccessStatus {
  const entitled = hasPrivateAgentEntitlement(input.tier);
  const runtimeReady = input.runtime?.remote_execution_ready === true;
  const blockingReasons = [...(input.runtime?.blocking_reasons ?? [])];

  if (!entitled) {
    blockingReasons.unshift("subscription_required");
  }

  if (!input.runtime) {
    blockingReasons.push("runtime_status_unavailable");
  }

  const remoteExecutionReady = entitled && runtimeReady;
  let message = "Sealed private-agent execution is ready.";
  if (!entitled) {
    message =
      "Private cloud agents require a paid Ghola private-agent plan. Local encrypted preparation remains available.";
  } else if (!runtimeReady) {
    message =
      "Your Ghola private-agent plan is active, but remote agents stay paused until attested Ghola compute and shielded settlement are both ready.";
  }

  return {
    entitled,
    remote_execution_ready: remoteExecutionReady,
    selected_provider: input.runtime?.selected_provider ?? null,
    blocking_reasons: Array.from(new Set(blockingReasons)),
    message,
  };
}
