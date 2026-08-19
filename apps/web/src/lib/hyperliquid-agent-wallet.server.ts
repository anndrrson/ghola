import { recoverTypedDataAddress, type Address } from "viem";
import {
  HYPERLIQUID_AGENT_ACTION_MAX_AGE_MS,
  HYPERLIQUID_AGENT_MIN_REMAINING_MS,
  HYPERLIQUID_AGENT_VALIDITY_MS,
  HYPERLIQUID_SIGNATURE_CHAIN_ID,
  hyperliquidApproveAgentTypedData,
  normalizedEvmAddress,
  parseHyperliquidAgentName,
  signatureHex,
  type HyperliquidAgentAuthorizationRequest,
  type HyperliquidAgentRevocationRequest,
  type HyperliquidApproveAgentAction,
  type HyperliquidApproveAgentSignature,
  type HyperliquidEncryptedAgentVault,
} from "./hyperliquid-agent-wallet";
import {
  hyperliquidVaultIdentityCommitments,
  parseHyperliquidVaultAssociatedData,
} from "./hyperliquid-vault-seal";

const HYPERLIQUID_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_VENUE_RESPONSE_BYTES = 64 * 1_024;
const MIN_SETUP_ACCOUNT_VALUE_USD = 12;

export class HyperliquidAgentAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "HyperliquidAgentAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

export interface VerifiedHyperliquidAgentAuthorization {
  account_address: Address;
  agent_address: Address;
  agent_base_name: string;
  valid_until_ms: number;
  approve_nonce: number;
  recovered_existing_authorization: boolean;
}

export interface HyperliquidAgentAuthorizationDependencies {
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  recoverAddress: typeof recoverTypedDataAddress;
}

export interface HyperliquidMasterAccountPreflight {
  account_address: Address;
  role: "user";
  account_abstraction: "default" | "disabled" | "unifiedAccount";
  available_value_usd: number;
  flat: true;
  open_order_count: 0;
  frontend_open_order_count: 0;
}

const DEFAULT_DEPENDENCIES: HyperliquidAgentAuthorizationDependencies = {
  fetchImpl: fetch,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recoverAddress: recoverTypedDataAddress,
};

export async function verifyAndSubmitHyperliquidAgentAuthorization(input: {
  body: unknown;
  accountCommitment: string;
  requireEncryptedVault: true;
  minimumAccountValueUsd?: number;
  dependencies?: Partial<HyperliquidAgentAuthorizationDependencies>;
}): Promise<{
  request: HyperliquidAgentAuthorizationRequest;
  authorization: VerifiedHyperliquidAgentAuthorization;
}>;
export async function verifyAndSubmitHyperliquidAgentAuthorization(input: {
  body: unknown;
  accountCommitment: string;
  requireEncryptedVault: false;
  minimumAccountValueUsd?: number;
  dependencies?: Partial<HyperliquidAgentAuthorizationDependencies>;
}): Promise<{
  request: HyperliquidAgentRevocationRequest;
  authorization: VerifiedHyperliquidAgentAuthorization;
}>;
export async function verifyAndSubmitHyperliquidAgentAuthorization(input: {
  body: unknown;
  accountCommitment: string;
  requireEncryptedVault: boolean;
  minimumAccountValueUsd?: number;
  dependencies?: Partial<HyperliquidAgentAuthorizationDependencies>;
}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const nowMs = dependencies.now();
  const request = parseAuthorizationRequest(input.body, input.requireEncryptedVault);
  const parsedName = validateCanonicalAction(request, input.accountCommitment, nowMs);
  let recovered: Address;
  try {
    recovered = normalizedEvmAddress(await dependencies.recoverAddress({
      ...hyperliquidApproveAgentTypedData(request.action),
      signature: signatureHex(request.signature),
    }));
  } catch {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_signature_invalid", 400);
  }
  if (recovered === request.action.agentAddress) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_master_key_cannot_be_agent", 400);
  }
  if ("encrypted_execution_vault" in request) {
    assertHyperliquidAgentVaultBinding({
      aad: request.encrypted_execution_vault.aad,
      recipient: request.encrypted_execution_vault.recipient,
      accountCommitment: input.accountCommitment,
      masterAddress: recovered,
      agentAddress: request.action.agentAddress,
    });
  }
  await preflightHyperliquidMasterAccount(recovered, {
    dependencies,
    minimumAccountValueUsd: input.minimumAccountValueUsd,
  });

  const expected = {
    address: request.action.agentAddress,
    baseName: parsedName.base_name,
    validUntil: parsedName.valid_until_ms,
  };
  const existing = await queryExactAgentAuthorization(
    dependencies.fetchImpl,
    recovered,
    expected,
  );
  if (existing === true) {
    return {
      request,
      authorization: verifiedAuthorization(request, recovered, parsedName, true),
    };
  }
  if (existing === null) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_authorization_state_unknown", 503);
  }
  if (nowMs - request.action.nonce > HYPERLIQUID_AGENT_ACTION_MAX_AGE_MS) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_authorization_stale", 400);
  }

  const exchangeResponse = await postApproveAgent(dependencies.fetchImpl, request).catch(() => ({
    kind: "unknown" as const,
    body: null,
  }));
  const responseWasCanonicalError = exchangeResponse.kind === "response" &&
    canonicalExchangeError(exchangeResponse.body);
  const retryDelays = [0, 150, 300, 600, 1_000];
  let authoritativeAbsent = false;
  for (const delayMs of retryDelays) {
    if (delayMs) await dependencies.sleep(delayMs);
    const verified = await queryExactAgentAuthorization(
      dependencies.fetchImpl,
      recovered,
      expected,
    );
    if (verified === true) {
      return {
        request,
        authorization: verifiedAuthorization(request, recovered, parsedName, false),
      };
    }
    if (verified === false) authoritativeAbsent = true;
  }
  throw new HyperliquidAgentAuthorizationError(
    responseWasCanonicalError && authoritativeAbsent
        ? "hyperliquid_agent_authorization_rejected"
        : "hyperliquid_agent_authorization_state_unknown",
    responseWasCanonicalError && authoritativeAbsent ? 422 : 503,
  );
}

export function assertHyperliquidAgentVaultBinding(input: {
  aad: string;
  recipient: string;
  accountCommitment: string;
  masterAddress: string;
  agentAddress: string;
}) {
  const scope = parseHyperliquidVaultAssociatedData(input.aad);
  const identity = hyperliquidVaultIdentityCommitments({
    venueAccountAddress: input.masterAddress,
    agentWalletAddress: input.agentAddress,
  });
  if (
    scope?.version !== 2 ||
    scope.network !== "mainnet" ||
    scope.account_commitment !== input.accountCommitment ||
    scope.recipient !== input.recipient ||
    scope.venue_account_commitment !== identity.venue_account_commitment ||
    scope.agent_wallet_commitment !== identity.agent_wallet_commitment
  ) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_vault_binding_mismatch", 400);
  }
  return scope;
}

export async function preflightHyperliquidMasterAccount(
  accountAddress: string,
  options: {
    dependencies?: Partial<HyperliquidAgentAuthorizationDependencies>;
    minimumAccountValueUsd?: number;
  } = {},
): Promise<HyperliquidMasterAccountPreflight> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const account = normalizedAddressOrInvalid(accountAddress);
  const [role, abstraction, clearinghouse, orders, frontendOrders] = await Promise.all([
    postInfo(dependencies.fetchImpl, { type: "userRole", user: account }),
    postInfo(dependencies.fetchImpl, { type: "userAbstraction", user: account }),
    postInfo(dependencies.fetchImpl, { type: "clearinghouseState", user: account }),
    postInfo(dependencies.fetchImpl, { type: "openOrders", user: account }),
    postInfo(dependencies.fetchImpl, { type: "frontendOpenOrders", user: account }),
  ]);
  const roleKind = parsedUserRole(role);
  if (roleKind !== "user") {
    if (roleKind === null) {
      throw new HyperliquidAgentAuthorizationError("hyperliquid_account_preflight_unavailable", 503);
    }
    throw new HyperliquidAgentAuthorizationError("hyperliquid_master_account_required", 422);
  }
  const accountAbstraction = parsedUserAbstraction(abstraction);
  if (!accountAbstraction || !validClearinghouseState(clearinghouse) ||
      !Array.isArray(orders) || !Array.isArray(frontendOrders)) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_account_preflight_unavailable", 503);
  }
  const openOrderCount = orders.length;
  const frontendOpenOrderCount = frontendOrders.length;
  const flat = clearinghouse.assetPositions.every(positionIsFlat);
  if (!flat || openOrderCount !== 0 || frontendOpenOrderCount !== 0) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_account_must_be_flat_for_wallet_setup", 409);
  }
  const perpsAvailableValue = Math.max(
    nonNegativeDecimal(clearinghouse.marginSummary.accountValue) ?? 0,
    nonNegativeDecimal(clearinghouse.withdrawable) ?? 0,
  );
  let availableValue = perpsAvailableValue;
  if (accountAbstraction === "unifiedAccount") {
    const spot = await postInfo(dependencies.fetchImpl, {
      type: "spotClearinghouseState",
      user: account,
    });
    if (!validSpotState(spot)) {
      throw new HyperliquidAgentAuthorizationError("hyperliquid_account_preflight_unavailable", 503);
    }
    availableValue = Math.max(perpsAvailableValue, spotUsdcAvailable(spot));
  }
  const minimumValue = options.minimumAccountValueUsd ?? MIN_SETUP_ACCOUNT_VALUE_USD;
  if (!Number.isFinite(minimumValue) || minimumValue < 0 || availableValue < minimumValue) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_account_funding_required", 409);
  }
  return {
    account_address: account,
    role: "user",
    account_abstraction: accountAbstraction,
    available_value_usd: availableValue,
    flat: true,
    open_order_count: 0,
    frontend_open_order_count: 0,
  };
}

function parseAuthorizationRequest(
  body: unknown,
  requireEncryptedVault: boolean,
): HyperliquidAgentAuthorizationRequest | HyperliquidAgentRevocationRequest {
  const value = strictObject(body, requireEncryptedVault
    ? ["version", "action", "signature", "nonce", "encrypted_execution_vault"]
    : ["version", "action", "signature", "nonce"]);
  if (value.version !== 1) invalidRequest();
  const action = parseAction(value.action);
  const signature = parseSignature(value.signature);
  if (!Number.isSafeInteger(value.nonce) || value.nonce !== action.nonce) invalidRequest();
  const base = {
    version: 1 as const,
    action,
    signature,
    nonce: action.nonce,
  };
  if (!requireEncryptedVault) return base;
  return {
    ...base,
    encrypted_execution_vault: parseEncryptedVault(value.encrypted_execution_vault),
  };
}

function parseAction(value: unknown): HyperliquidApproveAgentAction {
  const action = strictObject(value, [
    "type",
    "hyperliquidChain",
    "signatureChainId",
    "agentAddress",
    "agentName",
    "nonce",
  ]);
  if (
    action.type !== "approveAgent" ||
    action.hyperliquidChain !== "Mainnet" ||
    action.signatureChainId !== HYPERLIQUID_SIGNATURE_CHAIN_ID ||
    typeof action.agentName !== "string" ||
    !Number.isSafeInteger(action.nonce) ||
    (action.nonce as number) <= 0
  ) invalidRequest();
  return {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: HYPERLIQUID_SIGNATURE_CHAIN_ID,
    agentAddress: normalizedAddressOrInvalid(action.agentAddress),
    agentName: action.agentName as string,
    nonce: action.nonce as number,
  };
}

function parseSignature(value: unknown): HyperliquidApproveAgentSignature {
  const signature = strictObject(value, ["r", "s", "v"]);
  if (
    typeof signature.r !== "string" || !/^0x[0-9a-f]{64}$/.test(signature.r) ||
    typeof signature.s !== "string" || !/^0x[0-9a-f]{64}$/.test(signature.s) ||
    (signature.v !== 27 && signature.v !== 28)
  ) invalidRequest();
  return {
    r: signature.r as `0x${string}`,
    s: signature.s as `0x${string}`,
    v: signature.v as 27 | 28,
  };
}

function parseEncryptedVault(value: unknown): HyperliquidEncryptedAgentVault {
  const bundle = strictObject(value, ["alg", "ciphertext", "recipient", "aad", "encapsulated_key"], true);
  if (
    bundle.alg !== "sealed-provider-v1" ||
    typeof bundle.ciphertext !== "string" || !bundle.ciphertext || bundle.ciphertext.length > 256_000 ||
    typeof bundle.recipient !== "string" || !bundle.recipient || bundle.recipient.length > 256 ||
    typeof bundle.aad !== "string" || !bundle.aad || bundle.aad.length > 1_024 ||
    !(bundle.encapsulated_key == null || typeof bundle.encapsulated_key === "string")
  ) invalidRequest();
  return {
    alg: "sealed-provider-v1",
    ciphertext: bundle.ciphertext,
    recipient: bundle.recipient,
    aad: bundle.aad,
    ...(typeof bundle.encapsulated_key === "string"
      ? { encapsulated_key: bundle.encapsulated_key }
      : {}),
  };
}

function validateCanonicalAction(
  request: HyperliquidAgentAuthorizationRequest | HyperliquidAgentRevocationRequest,
  accountCommitment: string,
  nowMs: number,
) {
  const parsedName = parseHyperliquidAgentName(request.action.agentName, accountCommitment);
  if (!parsedName) invalidRequest("hyperliquid_agent_name_invalid");
  if (
    request.action.nonce > nowMs + HYPERLIQUID_AGENT_ACTION_MAX_AGE_MS ||
    parsedName.valid_until_ms !== request.action.nonce + HYPERLIQUID_AGENT_VALIDITY_MS ||
    parsedName.valid_until_ms <= nowMs + HYPERLIQUID_AGENT_MIN_REMAINING_MS
  ) invalidRequest("hyperliquid_agent_authorization_stale");
  return parsedName;
}

async function postApproveAgent(
  fetchImpl: typeof fetch,
  request: HyperliquidAgentAuthorizationRequest | HyperliquidAgentRevocationRequest,
) {
  const response = await fetchImpl(HYPERLIQUID_EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      action: request.action,
      nonce: request.nonce,
      signature: request.signature,
      vaultAddress: null,
      expiresAfter: null,
    }),
  });
  if (!response.ok) return { kind: "unknown" as const, body: null };
  const body = await readBoundedJson(response);
  return body === null
    ? { kind: "unknown" as const, body: null }
    : { kind: "response" as const, body };
}

async function queryExactAgentAuthorization(
  fetchImpl: typeof fetch,
  account: Address,
  expected: { address: Address; baseName: string; validUntil: number },
): Promise<boolean | null> {
  try {
    const body = await postInfo(fetchImpl, { type: "extraAgents", user: account });
    if (!Array.isArray(body) || body.length > 16) return null;
    const rows = body.map(parseAgentRow);
    if (rows.some((row) => row === null)) return null;
    const sameName = rows.filter((row) => row && (
      row.name === expected.baseName || row.name.startsWith(`${expected.baseName} valid_until `)
    ));
    if (sameName.length > 1) return null;
    return sameName.length === 1 &&
      (sameName[0]?.name === expected.baseName ||
        sameName[0]?.name === `${expected.baseName} valid_until ${expected.validUntil}`) &&
      sameName[0]?.address === expected.address &&
      sameName[0]?.validUntil === expected.validUntil;
  } catch {
    return null;
  }
}

async function postInfo(fetchImpl: typeof fetch, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify(body),
    });
    return response.ok ? readBoundedJson(response) : null;
  } catch {
    return null;
  }
}

function parseAgentRow(value: unknown): { name: string; address: Address; validUntil: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !Number.isSafeInteger(row.validUntil)) return null;
  try {
    return {
      name: row.name,
      address: normalizedEvmAddress(String(row.address ?? "")),
      validUntil: row.validUntil as number,
    };
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_VENUE_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function canonicalExchangeError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "err" && typeof record.response === "string" && record.response.length > 0;
}

function parsedUserRole(value: unknown): "user" | "missing" | "agent" | "vault" | "subAccount" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.role === "user") return Object.keys(record).length === 1 ? "user" : null;
  return record.role === "missing" || record.role === "agent" ||
    record.role === "vault" || record.role === "subAccount"
    ? record.role
    : null;
}

function parsedUserAbstraction(value: unknown): "default" | "disabled" | "unifiedAccount" | null {
  return value === "default" || value === "disabled" || value === "unifiedAccount"
    ? value
    : null;
}

function validClearinghouseState(value: unknown): value is {
  assetPositions: unknown[];
  marginSummary: { accountValue: unknown };
  withdrawable: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const summary = record.marginSummary;
  return Array.isArray(record.assetPositions) && !!summary && typeof summary === "object" &&
    !Array.isArray(summary) && nonNegativeDecimal((summary as Record<string, unknown>).accountValue) !== null &&
    nonNegativeDecimal(record.withdrawable) !== null;
}

function validSpotState(value: unknown): value is { balances: unknown[] } {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).balances);
}

function positionIsFlat(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = (value as Record<string, unknown>).position;
  if (!position || typeof position !== "object" || Array.isArray(position)) return false;
  const size = finiteDecimal((position as Record<string, unknown>).szi);
  return size === 0;
}

function spotUsdcAvailable(value: { balances: unknown[] }): number {
  const matches = value.balances.filter((entry) =>
    !!entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>).coin === "USDC");
  if (matches.length !== 1) return 0;
  const row = matches[0] as Record<string, unknown>;
  const total = nonNegativeDecimal(row.total);
  const hold = nonNegativeDecimal(row.hold);
  return total === null || hold === null ? 0 : Math.max(0, total - hold);
}

function finiteDecimal(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeDecimal(value: unknown): number | null {
  const parsed = finiteDecimal(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function verifiedAuthorization(
  request: HyperliquidAgentAuthorizationRequest | HyperliquidAgentRevocationRequest,
  recoveredAccount: Address,
  parsedName: { base_name: string; valid_until_ms: number },
  recoveredExisting: boolean,
): VerifiedHyperliquidAgentAuthorization {
  return {
    account_address: recoveredAccount,
    agent_address: request.action.agentAddress,
    agent_base_name: parsedName.base_name,
    valid_until_ms: parsedName.valid_until_ms,
    approve_nonce: request.action.nonce,
    recovered_existing_authorization: recoveredExisting,
  };
}

function strictObject(value: unknown, keys: readonly string[], allowMissingOptional = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.some((key) => !keys.includes(key))) invalidRequest();
  const required = allowMissingOptional ? keys.filter((key) => key !== "encapsulated_key") : keys;
  if (required.some((key) => !Object.hasOwn(record, key))) invalidRequest();
  return record;
}

function normalizedAddressOrInvalid(value: unknown): Address {
  try {
    return normalizedEvmAddress(typeof value === "string" ? value : "");
  } catch {
    return invalidRequest();
  }
}

function invalidRequest(code = "hyperliquid_agent_authorization_invalid"): never {
  throw new HyperliquidAgentAuthorizationError(code, 400);
}
