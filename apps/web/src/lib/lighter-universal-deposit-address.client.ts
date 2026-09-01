import {
  isLighterFundingCountryCodeEligible,
  isLighterFundingEligibilityAttestation,
  isLighterFundingEligibilityEvidence,
  LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION,
  LIGHTER_FUNDING_TERMS_VERSION,
  type LighterFundingEligibilityAttestationV1,
} from "./lighter-funding-eligibility";

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const LIGHTER_UDA_CLIENT_MAX_AGE_MS = 60_000;
export const LIGHTER_UDA_BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const LIGHTER_UDA_L1_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

export type VerifiedLighterDepositDestination = Readonly<{
  version: 1;
  venue_id: "lighter";
  network: "mainnet";
  owner_address: `0x${string}`;
  source: Readonly<{
    chain_id: 8453;
    chain: "base";
    asset: "USDC";
    token_address: `0x${string}`;
    minimum_microunits: "5000000";
    recommended_microunits: "5500000";
  }>;
  destination: Readonly<{
    deposit_address: `0x${string}`;
    provider: "lighter_fun_uda";
    market: "perps";
    asset: "USDC";
    blocked: false;
    resolved: Readonly<{
      to_chain_id: "3586256";
      to_token_address: `0x${string}`;
      action_type: "LIGHTER_PERPS";
      recipient_address: string;
      recipient_binding: "owner_address" | "lighter_account_index";
      owner_account_index: number | null;
      user_id: `0x${string}`;
    }>;
  }>;
  deposit_destination_verified: true;
  funding_action_enabled: true;
  checked_at: string;
  safety: Readonly<{
    address_generation_only: true;
    transfer_performed: false;
    withdrawal_performed: false;
    trade_performed: false;
    bounded_replay: "returns_only_the_original_owner_bound_destination";
  }>;
}>;

export type LighterDepositDestinationAuthorization = Readonly<{
  ownerAddress: string;
  eligibilityAttestation: LighterFundingEligibilityAttestationV1;
  signLighterDepositAuthorization: (message: string, expectedOwnerAddress: string) => Promise<`0x${string}`>;
}>;

export class LighterDepositDestinationError extends Error {
  readonly retryForbidden: boolean;

  constructor(message: string, retryForbidden = false) {
    super(message);
    this.name = "LighterDepositDestinationError";
    this.retryForbidden = retryForbidden;
  }
}

const RETRYABLE_DESTINATION_REJECTIONS = new Set([
  "lighter_uda_authorization_expired",
  "lighter_uda_authorization_invalid",
  "lighter_uda_authorization_session_mismatch",
  "lighter_uda_builder_key_unconfigured",
  "lighter_uda_cross_site_rejected",
  "lighter_uda_destination_request_invalid",
  "lighter_uda_json_required",
  "lighter_uda_attempt_ledger_unavailable",
  "lighter_uda_attempt_ledger_unconfigured",
  "lighter_uda_attempt_private_blob_required",
  "lighter_uda_owner_signature_invalid",
  "lighter_uda_owner_signature_mismatch",
  "lighter_uda_session_invalid",
  "lighter_uda_session_required",
  "lighter_uda_session_unavailable",
]);

export async function fetchVerifiedLighterDepositDestination(
  authorization: LighterDepositDestinationAuthorization,
  fetchImpl: typeof fetch = fetch,
  nowMs?: number,
): Promise<VerifiedLighterDepositDestination> {
  const ownerAddress = address(authorization.ownerAddress);
  if (!ownerAddress) throw new Error("Verified Turnkey owner identity is required.");
  if (!isLighterFundingEligibilityAttestation(authorization.eligibilityAttestation)) {
    throw new Error("Explicit Lighter funding eligibility attestation is required.");
  }
  const challengeResponse = await fetchImpl("/api/carry/lighter-deposit-authorization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({
      version: 1,
      owner_address: ownerAddress,
      eligibility_attestation: authorization.eligibilityAttestation,
    }),
  });
  const challengeBody = await challengeResponse.json().catch(() => null) as unknown;
  if (!challengeResponse.ok) {
    const error = object(challengeBody).error;
    throw new LighterDepositDestinationError(typeof error === "string" && error
      ? error
      : "Lighter owner authorization is unavailable.");
  }
  const challenge = validateLighterDepositAuthorizationChallenge(challengeBody, ownerAddress, nowMs ?? Date.now());
  const signature = await authorization.signLighterDepositAuthorization(challenge.message, ownerAddress);
  if (!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error("Lighter owner authorization signature is invalid.");

  let destinationResponse: Response;
  try {
    destinationResponse = await fetchImpl("/api/carry/lighter-deposit-destination", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        version: 1,
        challenge_token: challenge.challenge_token,
        signature,
      }),
    });
  } catch {
    throw ambiguousDestinationError();
  }
  const destinationBody = await destinationResponse.json().catch(() => null) as unknown;
  if (!destinationResponse.ok) {
    const failure = object(destinationBody);
    const error = failure.error;
    const code = typeof error === "string" ? error : "";
    throw new LighterDepositDestinationError(
      code
        ? code
        : "Verified Lighter deposit destination is unavailable.",
      failure.retry_forbidden === true || !RETRYABLE_DESTINATION_REJECTIONS.has(code),
    );
  }
  try {
    return validateVerifiedLighterDepositDestination(destinationBody, ownerAddress, nowMs ?? Date.now());
  } catch {
    throw ambiguousDestinationError();
  }
}

export async function reconcileExistingLighterDepositDestination(
  ownerAddress: string,
  eligibilityAttestation: LighterFundingEligibilityAttestationV1,
  fetchImpl: typeof fetch = fetch,
  nowMs?: number,
): Promise<VerifiedLighterDepositDestination> {
  const owner = address(ownerAddress);
  if (!owner) throw new LighterDepositDestinationError("Verified Turnkey owner identity is required.", true);
  if (!isLighterFundingEligibilityAttestation(eligibilityAttestation)) {
    throw new LighterDepositDestinationError("Explicit Lighter funding eligibility attestation is required.", true);
  }
  let response: Response;
  try {
    response = await fetchImpl("/api/carry/lighter-uda-attempt-reconciliation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        version: 1,
        owner_address: owner,
        eligibility_attestation: eligibilityAttestation,
      }),
    });
  } catch {
    throw reconciliationLockedError();
  }
  const body = await response.json().catch(() => null) as unknown;
  if (response.status !== 200) {
    const failure = object(body);
    const code = failure.error;
    const historyObserved = failure.historical_activity_observed === true;
    throw new LighterDepositDestinationError(
      historyObserved
        ? "Provider history was found, but it cannot prove a current safe funding address. Generation remains locked."
        : typeof code === "string" && code
          ? code
          : "Existing Lighter deposit address was not proven.",
      true,
    );
  }
  try {
    return validateVerifiedLighterDepositDestination(body, owner, nowMs ?? Date.now());
  } catch {
    throw reconciliationLockedError();
  }
}

function ambiguousDestinationError() {
  return new LighterDepositDestinationError(
    "Lighter deposit-address creation may have completed, but its verified result was not received. Generation is locked; reconcile manually before trying again.",
    true,
  );
}

function reconciliationLockedError() {
  return new LighterDepositDestinationError(
    "Existing Lighter deposit address was not uniquely proven. Generation remains locked.",
    true,
  );
}

export function isLighterDepositRetryForbidden(caught: unknown) {
  return caught instanceof LighterDepositDestinationError && caught.retryForbidden;
}

export function validateLighterDepositAuthorizationMessage(
  message: string,
  expectedOwnerAddress: string,
  nowMs = Date.now(),
) {
  const ownerAddress = address(expectedOwnerAddress);
  const lines = message.split("\n");
  const issuedAt = Date.parse(lines[16]?.replace("Issued at: ", "") || "");
  const expiresAt = Date.parse(lines[17]?.replace("Expires at: ", "") || "");
  if (
    !ownerAddress ||
    message.length < 20 ||
    message.length > 2_048 ||
    lines.length !== 20 ||
    lines[0] !== "Ghola Lighter deposit address authorization" ||
    lines[1] !== "Version: 1" ||
    lines[2] !== "Action: create_lighter_uda" ||
    !/^Ghola owner: owner_[0-9a-f]{48}$/.test(lines[3] || "") ||
    lines[4]?.toLowerCase() !== `owner wallet: ${ownerAddress.toLowerCase()}` ||
    lines[5] !== "Network: mainnet" ||
    lines[6] !== "Source chain: Base (8453)" ||
    lines[7] !== "Source asset: USDC" ||
    lines[8] !== "Destination: Lighter perps" ||
    lines[9] !== `Eligibility attestation version: ${LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION}` ||
    lines[10] !== `Lighter terms version: ${LIGHTER_FUNDING_TERMS_VERSION}` ||
    !isLighterFundingCountryCodeEligible(lines[11]?.replace("Server-verified country: ", "")) ||
    lines[12] !== "Lighter terms accepted: yes" ||
    lines[13] !== "Not a prohibited person: confirmed" ||
    lines[14] !== "Jurisdiction eligible: yes" ||
    !/^Nonce: [0-9a-f]{64}$/.test(lines[15] || "") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > nowMs + 5_000 ||
    issuedAt < nowMs - 2 * 60_000 - 5_000 ||
    expiresAt - issuedAt !== 2 * 60_000 ||
    expiresAt <= nowMs ||
    expiresAt > nowMs + 2 * 60_000 + 5_000 ||
    lines[16] !== `Issued at: ${new Date(issuedAt).toISOString()}` ||
    lines[17] !== `Expires at: ${new Date(expiresAt).toISOString()}` ||
    lines[18] !== "This authorizes address generation only." ||
    lines[19] !== "It does not authorize a transfer, withdrawal, or trade."
  ) throw new Error("Lighter owner authorization message is invalid or expired.");
  return Object.freeze({
    message,
    owner_address: ownerAddress,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
}

export function validateLighterDepositAuthorizationChallenge(
  value: unknown,
  expectedOwnerAddress: string,
  nowMs = Date.now(),
) {
  const body = object(value);
  const ownerAddress = address(expectedOwnerAddress);
  const challengeToken = text(body.challenge_token);
  const message = text(body.message);
  const expiresAt = Date.parse(text(body.expires_at));
  const responseOwner = address(body.owner_address);
  const authorization = object(body.authorization);
  const eligibility = authorization.eligibility;
  validateLighterDepositAuthorizationMessage(message, expectedOwnerAddress, nowMs);
  const lines = message.split("\n");
  const issuedAt = Date.parse(lines[16]?.replace("Issued at: ", "") || "");
  const expiresAtIso = Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "";
  if (
    body.version !== 1 ||
    !ownerAddress ||
    !responseOwner ||
    !sameAddress(responseOwner, ownerAddress) ||
    challengeToken.length < 80 ||
    challengeToken.length > 4_096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(challengeToken) ||
    lines.length !== 20 ||
    lines[0] !== "Ghola Lighter deposit address authorization" ||
    lines[1] !== "Version: 1" ||
    lines[2] !== "Action: create_lighter_uda" ||
    !/^Ghola owner: owner_[0-9a-f]{48}$/.test(lines[3] || "") ||
    lines[4]?.toLowerCase() !== `owner wallet: ${ownerAddress.toLowerCase()}` ||
    lines[5] !== "Network: mainnet" ||
    lines[6] !== "Source chain: Base (8453)" ||
    lines[7] !== "Source asset: USDC" ||
    lines[8] !== "Destination: Lighter perps" ||
    lines[9] !== `Eligibility attestation version: ${LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION_VERSION}` ||
    lines[10] !== `Lighter terms version: ${LIGHTER_FUNDING_TERMS_VERSION}` ||
    !isLighterFundingEligibilityEvidence(eligibility) ||
    lines[11] !== `Server-verified country: ${eligibility.country_code}` ||
    lines[12] !== "Lighter terms accepted: yes" ||
    lines[13] !== "Not a prohibited person: confirmed" ||
    lines[14] !== "Jurisdiction eligible: yes" ||
    !/^Nonce: [0-9a-f]{64}$/.test(lines[15] || "") ||
    !lines[16]?.startsWith("Issued at: ") ||
    !Number.isFinite(issuedAt) ||
    issuedAt > nowMs + 5_000 ||
    issuedAt < nowMs - 2 * 60_000 - 5_000 ||
    !Number.isFinite(expiresAt) ||
    expiresAt - issuedAt !== 2 * 60_000 ||
    lines[17] !== `Expires at: ${expiresAtIso}` ||
    lines[18] !== "This authorizes address generation only." ||
    lines[19] !== "It does not authorize a transfer, withdrawal, or trade." ||
    authorization.action !== "create_lighter_uda" ||
    authorization.source_chain_id !== 8453 ||
    authorization.source_chain !== "base" ||
    authorization.source_asset !== "USDC" ||
    authorization.destination_market !== "perps" ||
    authorization.transfer_authorized !== false ||
    authorization.withdrawal_authorized !== false ||
    authorization.trade_authorized !== false ||
    expiresAt <= nowMs ||
    expiresAt > nowMs + 2 * 60_000 + 5_000
  ) throw new Error("Lighter owner authorization challenge is invalid or expired.");
  return Object.freeze({
    version: 1 as const,
    challenge_token: challengeToken,
    message,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

export function validateVerifiedLighterDepositDestination(
  value: unknown,
  expectedOwnerAddress: string,
  nowMs = Date.now(),
): VerifiedLighterDepositDestination {
  const body = object(value);
  const source = object(body.source);
  const destination = object(body.destination);
  const resolved = object(destination.resolved);
  const safety = object(body.safety);
  const ownerAddress = address(body.owner_address);
  const expectedOwner = address(expectedOwnerAddress);
  const depositAddress = address(destination.deposit_address);
  const recipientAddress = text(resolved.recipient_address);
  const recipientBinding = resolved.recipient_binding;
  const ownerAccountIndex = resolved.owner_account_index === null
    ? null
    : typeof resolved.owner_account_index === "number" &&
      Number.isSafeInteger(resolved.owner_account_index) &&
      resolved.owner_account_index >= 0 &&
      resolved.owner_account_index <= 281_474_976_710_655
      ? resolved.owner_account_index
      : undefined;
  const recipientBound = recipientBinding === "owner_address"
    ? ownerAccountIndex === null && Boolean(address(recipientAddress)) && sameAddress(recipientAddress, text(ownerAddress))
    : recipientBinding === "lighter_account_index"
      ? typeof ownerAccountIndex === "number" && recipientAddress === String(ownerAccountIndex)
      : false;
  const userId = address(resolved.user_id);
  const checkedAt = Date.parse(text(body.checked_at));

  if (
    body.version !== 1 ||
    body.venue_id !== "lighter" ||
    body.network !== "mainnet" ||
    !ownerAddress ||
    !expectedOwner ||
    !sameAddress(ownerAddress, expectedOwner) ||
    source.chain_id !== 8453 ||
    source.chain !== "base" ||
    source.asset !== "USDC" ||
    !sameAddress(text(source.token_address), LIGHTER_UDA_BASE_USDC_ADDRESS) ||
    source.minimum_microunits !== "5000000" ||
    source.recommended_microunits !== "5500000" ||
    !depositAddress ||
    sameAddress(depositAddress, ZERO_ADDRESS) ||
    sameAddress(depositAddress, ownerAddress) ||
    destination.provider !== "lighter_fun_uda" ||
    destination.market !== "perps" ||
    destination.asset !== "USDC" ||
    destination.blocked !== false ||
    resolved.to_chain_id !== "3586256" ||
    !sameAddress(text(resolved.to_token_address), LIGHTER_UDA_L1_USDC_ADDRESS) ||
    resolved.action_type !== "LIGHTER_PERPS" ||
    !recipientAddress ||
    !recipientBound ||
    !userId ||
    !sameAddress(userId, ownerAddress) ||
    body.deposit_destination_verified !== true ||
    body.funding_action_enabled !== true ||
    safety.address_generation_only !== true ||
    safety.transfer_performed !== false ||
    safety.withdrawal_performed !== false ||
    safety.trade_performed !== false ||
    safety.bounded_replay !== "returns_only_the_original_owner_bound_destination" ||
    !Number.isFinite(checkedAt) ||
    checkedAt > nowMs + 5_000 ||
    nowMs - checkedAt > LIGHTER_UDA_CLIENT_MAX_AGE_MS
  ) {
    throw new Error("Lighter deposit destination evidence is invalid or stale.");
  }

  return Object.freeze({
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: ownerAddress,
    source: Object.freeze({
      chain_id: 8453,
      chain: "base",
      asset: "USDC",
      token_address: LIGHTER_UDA_BASE_USDC_ADDRESS,
      minimum_microunits: "5000000",
      recommended_microunits: "5500000",
    }),
    destination: Object.freeze({
      deposit_address: depositAddress,
      provider: "lighter_fun_uda",
      market: "perps",
      asset: "USDC",
      blocked: false,
      resolved: Object.freeze({
        to_chain_id: "3586256",
        to_token_address: LIGHTER_UDA_L1_USDC_ADDRESS,
        action_type: "LIGHTER_PERPS",
        recipient_address: recipientAddress,
        recipient_binding: recipientBinding as "owner_address" | "lighter_account_index",
        owner_account_index: ownerAccountIndex as number | null,
        user_id: userId,
      }),
    }),
    deposit_destination_verified: true,
    funding_action_enabled: true,
    checked_at: new Date(checkedAt).toISOString(),
    safety: Object.freeze({
      address_generation_only: true,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
      bounded_replay: "returns_only_the_original_owner_bound_destination",
    }),
  });
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function address(value: unknown): `0x${string}` | null {
  return typeof value === "string" && EVM_ADDRESS.test(value)
    ? value as `0x${string}`
    : null;
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}
