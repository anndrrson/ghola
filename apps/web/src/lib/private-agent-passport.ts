import {
  blockedVenueOperations,
  createVenueExecutionVault,
  getVenueManifest,
  gholaCommitment,
  supportedVenueOperations,
  type GholaVenueBlockedOperation,
  type GholaEncryptedBundleAlg,
  type GholaVenueExecutionMode,
  type GholaVenueId,
  type GholaVenueOperationClass,
} from "./private-account";
import {
  getPrivateAgentPassportByAccount,
  getLatestAgentArbCanaryReport,
  getHyperliquidExecutionVaultByAccount,
  getVenueExecutionVaultByAccount,
  listPrivateVenueCapabilities,
  PRIVATE_AGENT_VENUE_IDS,
  putPrivateAgentPassport,
  putPrivateVenueCapability,
  putVenueExecutionVault,
  type PrivateAgentArbCanaryReportRecordV1,
  type PrivateAgentVenueId,
  type PrivateVenueCapabilityRecordV1,
} from "./private-account-store";
import {
  createOrGetStoredPrivateAccount,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import { workerAuthorizationHeader } from "./private-agent-capability";
import { resolvePrivateAgentWorkerUrl } from "./private-account-worker-routing";
import {
  evaluateVenueExecutionCredential,
  type TurnkeyAuthorizationRole,
  type VenueCredentialProvisioningMode,
  type VenueCredentialSecretHandling,
  type VenueExecutionPermissionAttestation,
  type VenueOwnerAuthorizationSource,
} from "./venue-execution-credential-capability";
import { connectorSdkDefaultVenue } from "@ghola/execution-core";

const ARB_MARKETS = ["SOL-USD"];

export interface AgentPassportCapability {
  version: 1;
  credential_contract_version: 1;
  venue_id: PrivateAgentVenueId;
  platform_class: string;
  execution_mode: GholaVenueExecutionMode;
  source: "user_provided_credentials" | "turnkey_delegated" | "programmatic_generated";
  provisioning_mode: VenueCredentialProvisioningMode;
  can_read: boolean;
  can_trade: boolean;
  can_withdraw: false;
  allowed_operations: GholaVenueOperationClass[];
  blocked_operations: GholaVenueBlockedOperation[];
  vault_commitment: string | null;
  encrypted_vault_commitment: string | null;
  permission_commitment: string;
  status: "ready" | "blocked";
  reason_codes: string[];
  created_at: string;
  updated_at: string;
}

export interface AgentPassport {
  version: 1;
  passport_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  status: "active" | "blocked";
  supported_strategy: "hedged_spread_arbitrage_v1";
  venues: AgentPassportCapability[];
  blocked_operations: GholaVenueBlockedOperation[];
  created_at: string;
  updated_at: string;
}

export async function linkAgentPlatformFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  now: Date = new Date(),
) {
  const value = record(body);
  const venueId = agentVenueId(value.venue_id) ?? agentVenueForPlatform(value.platform_class);
  if (!venueId) return { error: "venue_not_supported" as const };

  const account = await createOrGetStoredPrivateAccount(owner);
  const permission = permissionAttestation(value.permission_attestation ?? value.permissions);
  if (!permission.ok) return { error: permission.error };
  const provisioningMode = credentialProvisioningMode(value.provisioning_mode);
  if (!provisioningMode) return { error: "provisioning_mode_not_supported" as const };
  const manualImport = provisioningMode === "manual_sealed_import";
  const credentialRequest = {
    venue_id: venueId,
    provisioning_mode: provisioningMode,
    turnkey_role: manualImport ? "none" as const : turnkeyAuthorizationRole(value.turnkey_role),
    owner_authorization_source: manualImport
      ? "external_owner_signature" as const
      : ownerAuthorizationSource(value.owner_authorization_source),
    explicit_owner_authorization: manualImport || value.explicit_owner_authorization === true,
    owner_binding_verified: manualImport || value.owner_binding_verified === true,
    secret_handling: manualImport
      ? "direct_to_attested_runtime" as const
      : credentialSecretHandling(value.secret_handling),
    permission_attestation: permission.attestation,
    silent_provisioning: value.silent_provisioning === true,
  };
  const preflightDecision = evaluateVenueExecutionCredential(credentialRequest);
  if (!preflightDecision.allowed) return { error: preflightDecision.reason_codes[0] };

  const executionMode = executionModeForVenue(venueId, value.execution_mode);
  const encryptedVault = recordOrNull(value.encrypted_execution_vault ?? value.encrypted_vault);
  let vaultCommitment: string | null = stringValue(value.vault_commitment);
  let encryptedVaultCommitment: string | null = stringValue(value.encrypted_vault_commitment);
  let vaultToStore: Parameters<typeof putVenueExecutionVault>[0] | null = null;

  if (encryptedVault) {
    const createdVault = createVenueExecutionVault({
      venue_id: venueId,
      execution_mode: executionMode,
      account_commitment: account.account_commitment,
      encrypted_execution_vault: encryptedVault as {
        alg?: GholaEncryptedBundleAlg;
        ciphertext: string;
        recipient: string;
        aad: string;
        encapsulated_key?: string | null;
      },
      policy_seed: {
        owner_commitment: owner.owner_commitment,
        purpose: "agent_passport_link",
      },
      now,
    });
    if (!createdVault.ok) return { error: createdVault.error };
    const vault = createdVault.vault;
    vaultToStore = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      venue_id: vault.venue_id,
      platform_class: vault.platform_class,
      execution_mode: vault.execution_mode,
      vault_commitment: vault.vault_commitment,
      encrypted_vault_commitment: vault.encrypted_vault_commitment,
      recipient_commitment: vault.recipient_commitment,
      policy_commitment: vault.policy_commitment,
      allocation_commitment: vault.allocation_commitment,
      status: vault.status,
      vault,
      created_at: vault.created_at,
      updated_at: vault.updated_at,
    };
    vaultCommitment = vault.vault_commitment;
    encryptedVaultCommitment = vault.encrypted_vault_commitment;
  }

  if (!vaultCommitment || !encryptedVaultCommitment) {
    return { error: "sealed_execution_vault_required" as const };
  }

  const serverVerification = await verifyCredentialServerSide({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    execution_mode: executionMode,
    encrypted_execution_vault: encryptedVault,
  });
  if (!serverVerification.ok) return { error: serverVerification.error };

  const credentialDecision = evaluateVenueExecutionCredential({
    ...credentialRequest,
    permission_attestation: {
      ...permission.attestation,
      can_read: serverVerification.can_read && permission.attestation.can_read,
      can_trade: serverVerification.can_trade && permission.attestation.can_trade,
      can_withdraw: serverVerification.can_withdraw || permission.attestation.can_withdraw,
      can_transfer: serverVerification.can_transfer || permission.attestation.can_transfer,
      can_manage_credentials:
        serverVerification.can_manage_credentials || permission.attestation.can_manage_credentials,
      can_export_secret: serverVerification.can_export_secret || permission.attestation.can_export_secret,
      unknown_scopes: Array.from(new Set([
        ...permission.attestation.unknown_scopes || [],
        ...serverVerification.unknown_scopes,
      ])),
    },
  });
  if (!credentialDecision.allowed) {
    return { error: credentialDecision.reason_codes[0] };
  }
  if (vaultToStore) await putVenueExecutionVault(vaultToStore);

  const capability = buildCapability({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    execution_mode: executionMode,
    provisioning_mode: provisioningMode,
    can_read: serverVerification.can_read && permission.attestation.can_read,
    can_trade: serverVerification.can_trade && permission.attestation.can_trade,
    vault_commitment: vaultCommitment,
    encrypted_vault_commitment: encryptedVaultCommitment,
    now,
  });
  const storedCapability = await putPrivateVenueCapability({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    capability_commitment: capability.permission_commitment,
    status: capability.status,
    capability: capability as unknown as Record<string, unknown>,
    created_at: capability.created_at,
    updated_at: capability.updated_at,
  });
  const passport = await refreshAgentPassport(owner, now);
  return {
    version: 1,
    platform_link_commitment: storedCapability.capability_commitment,
    capability: publicCapability(storedCapability),
    passport,
  };
}

export async function agentPassportForOwner(
  owner: PrivateAccountRequestOwner,
  now: Date = new Date(),
): Promise<AgentPassport> {
  return refreshAgentPassport(owner, now);
}

export async function agentPassportReadinessForOwner(
  owner: PrivateAccountRequestOwner,
  now: Date = new Date(),
) {
  const passport = await refreshAgentPassport(owner, now);
  const arbCanary = await agentArbCanaryDiagnostics(now);
  const readyVenues = passport.venues
    .filter((venue) => venue.status === "ready" && venue.can_read && venue.can_trade)
    .map((venue) => venue.venue_id);
  const blockers = readinessBlockers(readyVenues);
  const envBlockers = liveConfigBlockers(process.env);
  return {
    version: 1,
    account_commitment: passport.account_commitment,
    strategy_id: "hedged_spread_arbitrage_v1",
    can_arm: blockers.length === 0,
    can_live_submit: blockers.length === 0 && envBlockers.length === 0,
    supported_markets: ARB_MARKETS,
    ready_venues: readyVenues,
    blockers,
    live_submit_blockers: envBlockers,
    arb_canary_required: false,
    arb_canary_status: arbCanary.status,
    arb_canary_report: arbCanary.report,
    arb_canary_reason_codes: arbCanary.reason_codes,
    passport,
  };
}

export async function agentPassportVenueAccessForWorker(
  owner: PrivateAccountRequestOwner,
): Promise<Record<string, unknown>> {
  const account = await createOrGetStoredPrivateAccount(owner);
  const capabilities = await listPrivateVenueCapabilities({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
  });
  const out: Record<string, unknown> = {};
  for (const record of latestCapabilities(capabilities).values()) {
    const capability = publicCapability(record);
    if (capability.status !== "ready" || !capability.vault_commitment) continue;
    const vault = await getVenueExecutionVaultByAccount({
      account_commitment: account.account_commitment,
      venue_id: capability.venue_id,
      execution_mode: capability.execution_mode,
    });
    if (!vault || vault.status !== "sealed") continue;
    out[capability.venue_id] = {
      status: "ready",
      execution_mode: capability.execution_mode,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault_commitment,
      encrypted_vault_commitment: vault.encrypted_vault_commitment,
      policy_commitment: vault.vault.policy_commitment,
      encrypted_execution_vault: vault.vault.encrypted_execution_vault,
      reason: "agent_passport_ready",
    };
  }
  if (!out.hyperliquid) {
    const hyperliquid = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
    if (hyperliquid?.owner_commitment === owner.owner_commitment && hyperliquid.status === "sealed") {
      out.hyperliquid = {
        status: "ready",
        execution_mode: "byo_api_key",
        account_commitment: account.account_commitment,
        vault_commitment: hyperliquid.vault_commitment,
        encrypted_vault_commitment: hyperliquid.encrypted_vault_commitment,
        policy_commitment: hyperliquid.policy_commitment,
        encrypted_execution_vault: hyperliquid.vault.encrypted_execution_vault,
        reason: "hyperliquid_vault_ready",
      };
    }
  }
  return out;
}

async function refreshAgentPassport(
  owner: PrivateAccountRequestOwner,
  now: Date,
): Promise<AgentPassport> {
  const account = await createOrGetStoredPrivateAccount(owner);
  const existing = await getPrivateAgentPassportByAccount(account.account_commitment);
  const capabilities = await listPrivateVenueCapabilities({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
  });
  const latest = latestCapabilities(capabilities);
  const venues = PRIVATE_AGENT_VENUE_IDS.map((venueId) => {
    const stored = latest.get(venueId);
    if (stored) return publicCapability(stored);
    return missingCapability(venueId, now);
  });
  const blockedOperations = Array.from(new Set(venues.flatMap((venue) => venue.blocked_operations)));
  const passport: AgentPassport = {
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    passport_commitment: gholaCommitment("agent_passport", {
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      capability_commitments: venues.map((venue) => venue.permission_commitment),
    }),
    status: venues.some((venue) => venue.status === "ready") ? "active" : "blocked",
    supported_strategy: "hedged_spread_arbitrage_v1",
    venues,
    blocked_operations: blockedOperations,
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  await putPrivateAgentPassport({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    passport_commitment: passport.passport_commitment,
    status: passport.status,
    passport: passport as unknown as Record<string, unknown>,
    created_at: passport.created_at,
    updated_at: passport.updated_at,
  });
  return passport;
}

function buildCapability(input: {
  owner_commitment: string;
  account_commitment: string;
  venue_id: PrivateAgentVenueId;
  execution_mode: GholaVenueExecutionMode;
  provisioning_mode: VenueCredentialProvisioningMode;
  can_read: boolean;
  can_trade: boolean;
  vault_commitment: string;
  encrypted_vault_commitment: string;
  now: Date;
}): AgentPassportCapability {
  const manifest = getVenueManifest(input.venue_id);
  const allowed = supportedVenueOperations(input.venue_id)
    .filter((operation) => operation === "read" || operation === "preview_order" || operation.includes("order") || operation === "swap" || operation === "cancel" || operation === "reconcile");
  const reasonCodes = [
    ...(input.can_read ? [] : ["read_permission_required"]),
    ...(input.can_trade ? [] : ["trade_permission_required"]),
  ];
  const status = reasonCodes.length === 0 ? "ready" : "blocked";
  const seed = {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    vault_commitment: input.vault_commitment,
    credential_contract_version: 1,
    provisioning_mode: input.provisioning_mode,
    can_read: input.can_read,
    can_trade: input.can_trade,
    can_withdraw: false,
  };
  return {
    version: 1,
    credential_contract_version: 1,
    venue_id: input.venue_id,
    platform_class: manifest.platform_class,
    execution_mode: input.execution_mode,
    source: input.provisioning_mode === "manual_sealed_import"
      ? "user_provided_credentials"
      : input.provisioning_mode,
    provisioning_mode: input.provisioning_mode,
    can_read: input.can_read,
    can_trade: input.can_trade,
    can_withdraw: false,
    allowed_operations: allowed,
    blocked_operations: blockedVenueOperations(input.venue_id, input.execution_mode),
    vault_commitment: input.vault_commitment,
    encrypted_vault_commitment: input.encrypted_vault_commitment,
    permission_commitment: gholaCommitment("agent_venue_capability", seed),
    status,
    reason_codes: reasonCodes,
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  };
}

function publicCapability(record: PrivateVenueCapabilityRecordV1): AgentPassportCapability {
  const raw = record.capability as unknown as Partial<AgentPassportCapability>;
  const fallback = missingCapability(record.venue_id, new Date(record.updated_at));
  const contractVerified = raw.credential_contract_version === 1;
  const reasonCodes = Array.isArray(raw.reason_codes)
    ? raw.reason_codes.filter((reason): reason is string => typeof reason === "string")
    : [];
  return {
    ...fallback,
    ...raw,
    version: 1,
    credential_contract_version: 1,
    venue_id: record.venue_id,
    status: record.status === "ready" && contractVerified ? "ready" : "blocked",
    can_read: contractVerified && raw.can_read === true,
    can_trade: contractVerified && raw.can_trade === true,
    can_withdraw: false,
    vault_commitment: stringValue(raw.vault_commitment) ?? null,
    encrypted_vault_commitment: stringValue(raw.encrypted_vault_commitment) ?? null,
    permission_commitment: record.capability_commitment,
    reason_codes: contractVerified
      ? reasonCodes
      : Array.from(new Set([...reasonCodes, "credential_contract_reverification_required"])),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function missingCapability(venueId: PrivateAgentVenueId, now: Date): AgentPassportCapability {
  const manifest = getVenueManifest(venueId);
  return {
    version: 1,
    credential_contract_version: 1,
    venue_id: venueId,
    platform_class: manifest.platform_class,
    execution_mode: "byo_api_key",
    source: "user_provided_credentials",
    provisioning_mode: "manual_sealed_import",
    can_read: false,
    can_trade: false,
    can_withdraw: false,
    allowed_operations: [],
    blocked_operations: blockedVenueOperations(venueId),
    vault_commitment: null,
    encrypted_vault_commitment: null,
    permission_commitment: gholaCommitment("agent_venue_capability_missing", { venue_id: venueId }),
    status: "blocked",
    reason_codes: ["venue_not_linked"],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function latestCapabilities(records: PrivateVenueCapabilityRecordV1[]) {
  const out = new Map<PrivateAgentVenueId, PrivateVenueCapabilityRecordV1>();
  for (const record of records) {
    const existing = out.get(record.venue_id);
    if (!existing || record.updated_at > existing.updated_at) out.set(record.venue_id, record);
  }
  return out;
}

function readinessBlockers(readyVenues: PrivateAgentVenueId[]): string[] {
  const blockers: string[] = [];
  if (!readyVenues.includes("hyperliquid")) blockers.push("hyperliquid_required");
  if (!readyVenues.includes("phoenix")) blockers.push("phoenix_required");
  if (!readyVenues.includes("backpack")) blockers.push("backpack_required");
  return blockers;
}

function liveConfigBlockers(env: Record<string, string | undefined>): string[] {
  const blockers: string[] = [];
  if (env.PRIVATE_AGENT_TRI_VENUE_ARB_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_ARB_LIVE_SUBMIT !== "true") {
    blockers.push("tri_venue_arb_live_submit_disabled");
  }
  for (const name of [
    "PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD",
    "PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD",
    "PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS",
    "PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS",
    "PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS",
  ]) {
    if (!positiveNumber(env[name])) blockers.push(`${name.toLowerCase()}_required`);
  }
  return blockers;
}

async function agentArbCanaryDiagnostics(now: Date): Promise<{
  status: "missing" | "green" | "red" | "stale";
  report: Record<string, unknown> | null;
  reason_codes: string[];
}> {
  const report = await getLatestAgentArbCanaryReport();
  if (!report) {
    return {
      status: "missing",
      report: null,
      reason_codes: ["agent_arb_canary_missing"],
    };
  }
  const stale = new Date(report.expires_at).getTime() <= now.getTime();
  const status = stale ? "stale" : report.status;
  return {
    status,
    report: publicArbCanaryReport(report),
    reason_codes: stale
      ? ["agent_arb_canary_stale"]
      : report.reason_codes,
  };
}

function publicArbCanaryReport(report: PrivateAgentArbCanaryReportRecordV1): Record<string, unknown> {
  return {
    report_id: report.report_id,
    status: report.status,
    mode: report.mode,
    market: report.market,
    worker_url: report.worker_url,
    leg_notional_usd: report.leg_notional_usd,
    checks: report.checks,
    quote: report.quote,
    pair: report.pair,
    preflight: report.preflight,
    live_receipts: report.live_receipts,
    reconciliation: report.reconciliation,
    evidence_commitment: report.evidence_commitment,
    reason_codes: report.reason_codes,
    reason: report.reason,
    observed_at: report.observed_at,
    expires_at: report.expires_at,
  };
}

function permissionAttestation(value: unknown):
  | { ok: true; attestation: VenueExecutionPermissionAttestation }
  | { ok: false; error: "permission_attestation_required" | "permission_attestation_incomplete" } {
  const raw = recordOrNull(value);
  if (!raw) return { ok: false, error: "permission_attestation_required" };
  const booleanFields = [
    "can_read",
    "can_trade",
    "can_withdraw",
    "can_transfer",
    "can_manage_credentials",
    "can_export_secret",
  ] as const;
  if (booleanFields.some((field) => typeof raw[field] !== "boolean")) {
    return { ok: false, error: "permission_attestation_incomplete" };
  }
  if (!Array.isArray(raw.unknown_scopes) || raw.unknown_scopes.some((scope) => typeof scope !== "string")) {
    return { ok: false, error: "permission_attestation_incomplete" };
  }
  if (raw.scopes !== undefined && (!Array.isArray(raw.scopes) || raw.scopes.some((scope) => typeof scope !== "string"))) {
    return { ok: false, error: "permission_attestation_incomplete" };
  }
  const scopes = arrayOfStrings(raw.scopes).map((scope) => scope.trim().toLowerCase()).filter(Boolean);
  const knownScopes = new Set(["read", "view", "trade", "order", "orders"]);
  const unknownScopes = Array.from(new Set([
    ...arrayOfStrings(raw.unknown_scopes).map((scope) => scope.trim().toLowerCase()).filter(Boolean),
    ...scopes.filter((scope) => !knownScopes.has(scope)),
  ]));
  return {
    ok: true,
    attestation: {
      can_read: raw.can_read === true,
      can_trade: raw.can_trade === true,
      can_withdraw: raw.can_withdraw === true,
      can_transfer: raw.can_transfer === true,
      can_manage_credentials: raw.can_manage_credentials === true,
      can_export_secret: raw.can_export_secret === true,
      unknown_scopes: unknownScopes,
    },
  };
}

async function verifyCredentialServerSide(input: {
  owner_commitment: string;
  account_commitment: string;
  venue_id: PrivateAgentVenueId;
  execution_mode: GholaVenueExecutionMode;
  encrypted_execution_vault: Record<string, unknown> | null;
}): Promise<
  | {
      ok: true;
      can_read: boolean;
      can_trade: boolean;
      can_withdraw: boolean;
      can_transfer: boolean;
      can_manage_credentials: boolean;
      can_export_secret: boolean;
      unknown_scopes: string[];
    }
  | { ok: false; error: "server_credential_verification_required" | "credential_verifier_unavailable" | "credential_verification_failed" | "withdraw_permission_blocked" }
> {
  if (!input.encrypted_execution_vault) {
    return { ok: false, error: "server_credential_verification_required" };
  }
  const cfg = workerConfig(process.env);
  if (!cfg.url) {
    if (localCredentialVerificationBypassAllowed()) {
      return {
        ok: true,
        can_read: true,
        can_trade: true,
        can_withdraw: false,
        can_transfer: false,
        can_manage_credentials: false,
        can_export_secret: false,
        unknown_scopes: [],
      };
    }
    return { ok: false, error: "credential_verifier_unavailable" };
  }
  const path = "/venues/credentials/verify";
  const payload = {
    version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    execution_mode: input.execution_mode,
    encrypted_execution_vault: input.encrypted_execution_vault,
  };
  const authorization = workerAuthorizationHeader({
    fallbackToken: cfg.token,
    method: "POST",
    path,
    scope: "credential:verify",
    body: payload,
    expected: {
      owner_commitment: input.owner_commitment,
      account_commitment: input.account_commitment,
      venue_id: input.venue_id,
      execution_mode: input.execution_mode,
    },
  });
  if (!authorization) return { ok: false, error: "credential_verifier_unavailable" };
  const response = await fetch(new URL(path, cfg.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response) return { ok: false, error: "credential_verifier_unavailable" };
  const body = record(await response.json().catch(() => null));
  if (!response.ok || body.status !== "verified") return { ok: false, error: "credential_verification_failed" };
  if (body.can_withdraw === true) return { ok: false, error: "withdraw_permission_blocked" };
  return {
    ok: true,
    can_read: body.can_read === true,
    can_trade: body.can_trade === true,
    can_withdraw: false,
    can_transfer: body.can_transfer === true,
    can_manage_credentials: body.can_manage_credentials === true,
    can_export_secret: body.can_export_secret === true,
    unknown_scopes: arrayOfStrings(body.unknown_scopes),
  };
}

function credentialProvisioningMode(value: unknown): VenueCredentialProvisioningMode | null {
  if (value === undefined || value === null || value === "") return "manual_sealed_import";
  return value === "manual_sealed_import" || value === "turnkey_delegated" || value === "programmatic_generated"
    ? value
    : null;
}

function turnkeyAuthorizationRole(value: unknown): TurnkeyAuthorizationRole {
  return value === "venue_owner" || value === "delegated_agent" ? value : "none";
}

function ownerAuthorizationSource(value: unknown): VenueOwnerAuthorizationSource {
  return value === "turnkey_venue_owner" || value === "external_owner_signature" ? value : "none";
}

function credentialSecretHandling(value: unknown): VenueCredentialSecretHandling {
  return value === "turnkey_non_exportable" ||
      value === "direct_to_attested_runtime" ||
      value === "raw_exportable" ||
      value === "plaintext_persisted"
    ? value
    : "unknown";
}

function localCredentialVerificationBypassAllowed(): boolean {
  return process.env.NODE_ENV === "test" ||
    process.env.GHOLA_CONNECTOR_MODE === "local_test" ||
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true";
}

function workerConfig(env: Record<string, string | undefined>) {
  return {
    url: resolvePrivateAgentWorkerUrl({
      connector_url: env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
      execution_url: env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || env.PRIVATE_AGENT_EXECUTION_URL,
      worker_url: env.GHOLA_PRIVATE_AGENT_WORKER_URL || env.PRIVATE_AGENT_WORKER_URL,
      phala_endpoint: env.PHALA_AGENT_ENDPOINT,
    }),
    token: env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() ||
      env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PRIVATE_AGENT_WORKER_TOKEN?.trim() ||
      "",
  };
}

function agentVenueForPlatform(value: unknown): PrivateAgentVenueId | null {
  return typeof value === "string" ? agentVenueId(connectorSdkDefaultVenue(value)) : null;
}

function agentVenueId(value: unknown): PrivateAgentVenueId | null {
  return typeof value === "string" && PRIVATE_AGENT_VENUE_IDS.includes(value as PrivateAgentVenueId)
    ? value as PrivateAgentVenueId
    : null;
}

function executionModeForVenue(venueId: GholaVenueId, value: unknown): GholaVenueExecutionMode {
  const raw = stringValue(value);
  if (raw === "ghola_pooled") return "ghola_pooled";
  if (venueId === "jupiter") return raw === "user_stealth" ? "user_stealth" : "byo_api_key";
  return "byo_api_key";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): boolean {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0;
}
