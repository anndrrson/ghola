import { recoverTypedDataAddress, type Hex } from "viem";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const SAFE_AGENT_NAME = /^[A-Za-z0-9._:-]{1,32}$/;
const SAFE_WORKER_ID = /^[A-Za-z0-9._:/-]{1,160}$/;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256 = /^sha256:[0-9a-fA-F]{64}$/;

export const ASTER_V3_AGENT_NONCE_WINDOW_MS = 10_000;
export const ASTER_V3_AGENT_MIN_LIFETIME_MS = 60_000;
export const ASTER_V3_AGENT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
export const ASTER_V3_AGENT_MAX_IP_WHITELIST_ENTRIES = 16;

/**
 * Exact Aster schema source reviewed for this pure builder. Pinning the source
 * prevents a later venue change from being mistaken for a compatible payload.
 */
export const ASTER_V3_AGENT_APPROVAL_SCHEMA = Object.freeze({
  verified: true,
  endpoint: "/fapi/v3/registerAndApproveAgent",
  method: "POST",
  documentation_commit: "71679b4aa69e80372eb55d437a80df21f135e1bf",
  documentation_url:
    "https://github.com/asterdex/api-docs/blob/71679b4aa69e80372eb55d437a80df21f135e1bf/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md#register-and-approve-agent-public",
} as const);

export interface AsterV3AgentPermissions {
  canSpotTrade: boolean;
  canPerpTrade: boolean;
  canWithdraw: boolean;
}

export interface AsterAttestedSignerInput {
  /** Public EVM address returned by the attested worker; never a private key. */
  publicAddress: string;
  provider: string;
  workerId: string;
  /** Digest of the attestation evidence that bound the worker to this address. */
  attestationSha256: string;
}

export interface BuildAsterV3AgentOnboardingInput {
  ownerAddress: string;
  agentName: string;
  attestedSigner: AsterAttestedSignerInput;
  /** A microsecond timestamp synchronized to Aster server time. */
  nonceMicros: number;
  /** Caller clock used only for fail-closed nonce and expiry checks. */
  nowMs: number;
  expiresAtMs: number;
  ipWhitelist?: readonly string[];
  /** Optional explicit request; any broader permission is rejected. */
  permissions?: AsterV3AgentPermissions;
  /** Setup is credential-only. Passing true always fails. */
  mayPlaceTradeDuringSetup?: boolean;
}

export interface AsterV3AgentApprovalParameters {
  readonly agentName: string;
  readonly agentAddress: `0x${string}`;
  readonly ipWhitelist: string;
  readonly expired: number;
  readonly signatureChainId: 56;
  readonly canSpotTrade: false;
  readonly canPerpTrade: true;
  readonly canWithdraw: false;
  readonly user: `0x${string}`;
  readonly nonce: number;
}

export interface AsterV3AgentApprovalTypedData {
  readonly types: Readonly<{
    EIP712Domain: readonly [
      Readonly<{ name: "name"; type: "string" }>,
      Readonly<{ name: "version"; type: "string" }>,
      Readonly<{ name: "chainId"; type: "uint256" }>,
      Readonly<{ name: "verifyingContract"; type: "address" }>,
    ];
    Message: readonly [Readonly<{ name: "msg"; type: "string" }>];
  }>;
  readonly primaryType: "Message";
  readonly domain: Readonly<{
    name: "AsterSignTransaction";
    version: "1";
    chainId: 56;
    verifyingContract: "0x0000000000000000000000000000000000000000";
  }>;
  readonly message: Readonly<{ msg: string }>;
}

export interface AsterV3AgentOnboardingContract {
  readonly version: 1;
  readonly venue: "aster";
  readonly network: "mainnet";
  readonly endpoint: typeof ASTER_V3_AGENT_APPROVAL_SCHEMA.endpoint;
  readonly method: typeof ASTER_V3_AGENT_APPROVAL_SCHEMA.method;
  readonly attestedSigner: Readonly<{
    publicAddress: `0x${string}`;
    provider: string;
    workerId: string;
    attestationSha256: string;
    privateKeyExposed: false;
  }>;
  readonly permissions: Readonly<{
    canSpotTrade: false;
    canPerpTrade: true;
    canWithdraw: false;
  }>;
  readonly ownerAuthorization: Readonly<{
    required: true;
    status: "signature_required";
    ownerAddress: `0x${string}`;
    algorithm: "EIP-712";
  }>;
  readonly setup: Readonly<{
    mayPlaceTrade: false;
    networkEffects: "none";
  }>;
  readonly approval: Readonly<{
    parametersWithoutSignature: AsterV3AgentApprovalParameters;
    message: string;
    typedData: AsterV3AgentApprovalTypedData;
  }>;
}

export interface AsterV3AuthorizedAgentRegistration {
  readonly endpoint: typeof ASTER_V3_AGENT_APPROVAL_SCHEMA.endpoint;
  readonly method: typeof ASTER_V3_AGENT_APPROVAL_SCHEMA.method;
  readonly ownerAuthorization: Readonly<{
    required: true;
    status: "signature_verified";
    ownerAddress: `0x${string}`;
  }>;
  readonly setup: Readonly<{
    mayPlaceTrade: false;
    networkEffects: "none";
  }>;
  readonly parameters: Readonly<AsterV3AgentApprovalParameters & { signature: Hex }>;
}

export class AsterV3AgentOnboardingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AsterV3AgentOnboardingError";
  }
}

export function buildAsterV3AgentOnboardingContract(
  input: BuildAsterV3AgentOnboardingInput,
): AsterV3AgentOnboardingContract {
  const ownerAddress = normalizedAddress(input.ownerAddress, "owner_address_invalid");
  const agentAddress = normalizedAddress(input.attestedSigner.publicAddress, "agent_address_invalid");
  if (ownerAddress === agentAddress) {
    fail("owner_agent_address_collision", "The Aster owner and agent addresses must be different.");
  }

  const agentName = input.agentName.trim();
  if (!SAFE_AGENT_NAME.test(agentName)) {
    fail("agent_name_invalid", "Aster agentName must use 1-32 letters, numbers, dots, underscores, colons, or hyphens.");
  }
  const provider = input.attestedSigner.provider.trim().toLowerCase();
  const workerId = input.attestedSigner.workerId.trim();
  const attestationSha256 = input.attestedSigner.attestationSha256.trim().toLowerCase();
  if (!SAFE_PROVIDER.test(provider)) fail("attestation_provider_invalid", "The attestation provider is invalid.");
  if (!SAFE_WORKER_ID.test(workerId)) fail("attested_worker_invalid", "The attested worker identifier is invalid.");
  if (!SHA256.test(attestationSha256)) fail("attestation_digest_invalid", "The worker attestation digest is invalid.");

  requireSafeInteger(input.nowMs, "now_invalid");
  requireSafeInteger(input.nonceMicros, "nonce_invalid");
  requireSafeInteger(input.expiresAtMs, "expiry_invalid");
  if (Math.abs(input.nonceMicros / 1_000 - input.nowMs) > ASTER_V3_AGENT_NONCE_WINDOW_MS) {
    fail("nonce_outside_aster_window", "The Aster nonce must be within 10 seconds of the synchronized clock.");
  }
  const lifetimeMs = input.expiresAtMs - input.nowMs;
  if (lifetimeMs < ASTER_V3_AGENT_MIN_LIFETIME_MS || lifetimeMs > ASTER_V3_AGENT_MAX_LIFETIME_MS) {
    fail("expiry_outside_policy", "The Aster agent expiry must be between 1 minute and 30 days from now.");
  }

  const requestedPermissions = input.permissions ?? {
    canSpotTrade: false,
    canPerpTrade: true,
    canWithdraw: false,
  };
  if (
    requestedPermissions.canSpotTrade !== false ||
    requestedPermissions.canPerpTrade !== true ||
    requestedPermissions.canWithdraw !== false
  ) {
    fail("permissions_outside_policy", "Aster onboarding permits perpetual trading only and never withdrawal.");
  }
  if (input.mayPlaceTradeDuringSetup === true) {
    fail("setup_trade_blocked", "Aster credential setup cannot place a trade.");
  }

  const ipWhitelist = normalizeIpWhitelist(input.ipWhitelist ?? []);
  const parametersWithoutSignature = Object.freeze({
    agentName,
    agentAddress,
    ipWhitelist: ipWhitelist.join(" "),
    expired: input.expiresAtMs,
    signatureChainId: 56,
    canSpotTrade: false,
    canPerpTrade: true,
    canWithdraw: false,
    user: ownerAddress,
    nonce: input.nonceMicros,
  } as const satisfies AsterV3AgentApprovalParameters);
  const message = buildApprovalMessage(parametersWithoutSignature);
  const typedData = buildApprovalTypedData(message);

  return Object.freeze({
    version: 1,
    venue: "aster",
    network: "mainnet",
    endpoint: ASTER_V3_AGENT_APPROVAL_SCHEMA.endpoint,
    method: ASTER_V3_AGENT_APPROVAL_SCHEMA.method,
    attestedSigner: Object.freeze({
      publicAddress: agentAddress,
      provider,
      workerId,
      attestationSha256,
      privateKeyExposed: false,
    }),
    permissions: Object.freeze({
      canSpotTrade: false,
      canPerpTrade: true,
      canWithdraw: false,
    }),
    ownerAuthorization: Object.freeze({
      required: true,
      status: "signature_required",
      ownerAddress,
      algorithm: "EIP-712",
    }),
    setup: Object.freeze({
      mayPlaceTrade: false,
      networkEffects: "none",
    }),
    approval: Object.freeze({ parametersWithoutSignature, message, typedData }),
  });
}

/**
 * Verifies the explicit owner signature and only then produces submit-ready
 * parameters. This performs no network request and cannot place a trade.
 */
export async function authorizeAsterV3AgentRegistration(
  contract: AsterV3AgentOnboardingContract,
  signature: string,
): Promise<AsterV3AuthorizedAgentRegistration> {
  if (!EVM_SIGNATURE.test(signature)) fail("owner_signature_invalid", "The Aster owner signature is invalid.");
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      ...asterApprovalSigningDefinition(contract.approval.typedData),
      signature: signature as Hex,
    });
  } catch {
    fail("owner_signature_invalid", "The Aster owner signature is invalid.");
  }
  if (recovered.toLowerCase() !== contract.ownerAuthorization.ownerAddress) {
    fail("owner_signature_mismatch", "The Aster approval was not signed by the collateral owner.");
  }
  return Object.freeze({
    endpoint: contract.endpoint,
    method: contract.method,
    ownerAuthorization: Object.freeze({
      required: true,
      status: "signature_verified",
      ownerAddress: contract.ownerAuthorization.ownerAddress,
    }),
    setup: contract.setup,
    parameters: Object.freeze({
      ...contract.approval.parametersWithoutSignature,
      signature: signature as Hex,
    }),
  });
}

/** Converts JSON-safe wire timestamps into viem's exact uint256 values. */
export function asterApprovalSigningDefinition(typedData: AsterV3AgentApprovalTypedData) {
  return {
    domain: {
      ...typedData.domain,
      chainId: BigInt(typedData.domain.chainId),
    },
    // Keep EIP712Domain explicit. Turnkey's viem adapter serializes typed data
    // before signing and otherwise drops the domain from the wire payload.
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  } as const;
}

function buildApprovalMessage(parameters: AsterV3AgentApprovalParameters): string {
  return [
    `user=${parameters.user}`,
    `nonce=${parameters.nonce}`,
    `agentName=${parameters.agentName}`,
    `agentAddress=${parameters.agentAddress}`,
    `expired=${parameters.expired}`,
    `signatureChainId=${parameters.signatureChainId}`,
    `canSpotTrade=${parameters.canSpotTrade}`,
    `canPerpTrade=${parameters.canPerpTrade}`,
    `canWithdraw=${parameters.canWithdraw}`,
    `ipWhitelist=${parameters.ipWhitelist}`,
  ].join("&");
}

function buildApprovalTypedData(message: string): AsterV3AgentApprovalTypedData {
  return Object.freeze({
    types: Object.freeze({
      EIP712Domain: Object.freeze([
        Object.freeze({ name: "name", type: "string" }),
        Object.freeze({ name: "version", type: "string" }),
        Object.freeze({ name: "chainId", type: "uint256" }),
        Object.freeze({ name: "verifyingContract", type: "address" }),
      ] as const),
      Message: Object.freeze([Object.freeze({ name: "msg", type: "string" })] as const),
    }),
    primaryType: "Message",
    domain: Object.freeze({
      name: "AsterSignTransaction",
      version: "1",
      chainId: 56,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    }),
    message: Object.freeze({ msg: message }),
  });
}

function normalizedAddress(value: string, code: string): `0x${string}` {
  const address = value.trim();
  if (!EVM_ADDRESS.test(address)) fail(code, "Enter a valid EVM address.");
  return address.toLowerCase() as `0x${string}`;
}

function normalizeIpWhitelist(entries: readonly string[]): readonly string[] {
  if (entries.length > ASTER_V3_AGENT_MAX_IP_WHITELIST_ENTRIES) {
    fail("ip_whitelist_too_large", "The Aster IP whitelist is limited to 16 entries.");
  }
  const normalized = entries.map(normalizeIpWhitelistEntry);
  return Object.freeze(Array.from(new Set(normalized)).sort());
}

function normalizeIpWhitelistEntry(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value || /\s/.test(value)) fail("ip_whitelist_invalid", "An Aster IP whitelist entry is invalid.");
  const slash = value.indexOf("/");
  if (slash !== value.lastIndexOf("/")) fail("ip_whitelist_invalid", "An Aster IP whitelist entry is invalid.");
  const address = slash === -1 ? value : value.slice(0, slash);
  const prefixText = slash === -1 ? null : value.slice(slash + 1);
  const version = isIpv4(address) ? 4 : isIpv6(address) ? 6 : 0;
  if (!version) fail("ip_whitelist_invalid", "An Aster IP whitelist entry is invalid.");
  if (prefixText === null) return address;
  if (!/^\d{1,3}$/.test(prefixText)) fail("ip_whitelist_invalid", "An Aster CIDR prefix is invalid.");
  const prefix = Number(prefixText);
  if (prefix > (version === 4 ? 32 : 128)) fail("ip_whitelist_invalid", "An Aster CIDR prefix is invalid.");
  return `${address}/${prefix}`;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
  );
}

function isIpv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9a-f:]+$/.test(value) || value.split("::").length > 2) return false;
  const compressed = value.includes("::");
  const [head = "", tail = ""] = value.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const validParts = [...headParts, ...tailParts].every((part) => /^[0-9a-f]{1,4}$/.test(part));
  const count = headParts.length + tailParts.length;
  return validParts && (compressed ? count < 8 : count === 8);
}

function requireSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, "Aster onboarding timestamps must be positive safe integers.");
}

function fail(code: string, message: string): never {
  throw new AsterV3AgentOnboardingError(code, message);
}
