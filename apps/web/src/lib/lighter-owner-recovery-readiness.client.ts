import {
  assertLighterOwnerRecoveryIntent,
  lighterOwnerRecoveryPlanCommitment,
  lighterOwnerRecoveryReadinessMessage,
  type LighterOwnerRecoveryReadinessPayload,
} from "./lighter-owner-recovery";
import { lighterAccountIndex, lighterOwnerAddress } from "./lighter-agent-association";
import {
  requestLighterOwnerRecoveryReadinessPhase,
  type LighterOwnerRecoveryReadinessPhaseRequest,
} from "./private-account-client";

const OWNER_COMMITMENT = /^owner_[0-9a-f]{48}$/;
const PLAN_COMMITMENT = /^0x[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const CHALLENGE_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const READINESS_TTL_MS = 2 * 60_000;

export type LighterOwnerRecoveryReadinessAuthorization = Readonly<{
  challenge_token: string;
  message: string;
  payload: LighterOwnerRecoveryReadinessPayload;
}>;

export type LighterOwnerRecoveryReadinessSigningProof = Readonly<{
  signature: `0x${string}`;
  owner_address: `0x${string}`;
  signing_method: "turnkey_eip191_owner_proof";
  transaction_signed: false;
  transaction_broadcast: false;
}>;

export type VerifiedLighterOwnerRecoveryReadiness = Readonly<{
  version: 1;
  venue_id: "lighter";
  network: "mainnet";
  status: "post_account_recovery_ready";
  owner_address: `0x${string}`;
  account_index: number;
  ready: true;
  recovery_readiness_proven: true;
  post_account_recovery_ready: true;
  funding_precondition_satisfied: false;
  initial_funding_safety_proven: false;
  funding_authorized: false;
  checks: Readonly<{
    owner_signer_verified: true;
    lighter_balance_verified: false;
    withdrawal_execution_verified: false;
  }>;
  safety: Readonly<{
    no_submit: true;
    transaction_signed: false;
    transaction_broadcast: false;
    withdrawal_authorized: false;
    withdrawal_execution_proven: false;
    funds_moved: false;
  }>;
}>;

type RequestPhase = (input: LighterOwnerRecoveryReadinessPhaseRequest) => Promise<unknown>;

export async function verifyLighterOwnerRecoveryReadiness(input: {
  ownerAddress: string;
  accountIndex?: number;
  signLighterRecoveryReadiness: (
    authorization: LighterOwnerRecoveryReadinessAuthorization,
  ) => Promise<LighterOwnerRecoveryReadinessSigningProof>;
  requestPhase?: RequestPhase;
  nowMs?: number;
}): Promise<VerifiedLighterOwnerRecoveryReadiness> {
  let ownerAddress: `0x${string}`;
  let requestedAccountIndex: number | undefined;
  try {
    ownerAddress = lighterOwnerAddress(input.ownerAddress);
    requestedAccountIndex = input.accountIndex === undefined
      ? undefined
      : lighterAccountIndex(input.accountIndex);
  } catch {
    throw invalidReadiness();
  }
  const requestPhase = input.requestPhase || requestLighterOwnerRecoveryReadinessPhase;
  const nowMs = input.nowMs ?? Date.now();
  const phaseOneBody = await requestPhase({
    version: 1,
    owner_address: ownerAddress,
    ...(requestedAccountIndex === undefined ? {} : { account_index: requestedAccountIndex }),
  });
  const phaseOne = validatePhaseOne(phaseOneBody, ownerAddress, requestedAccountIndex, nowMs);
  const signingProof = await input.signLighterRecoveryReadiness(phaseOne.authorization);
  if (
    !SIGNATURE.test(signingProof.signature) ||
    signingProof.owner_address.toLowerCase() !== ownerAddress ||
    signingProof.signing_method !== "turnkey_eip191_owner_proof" ||
    signingProof.transaction_signed !== false ||
    signingProof.transaction_broadcast !== false
  ) throw invalidReadiness();

  const phaseTwoBody = await requestPhase({
    version: 1,
    owner_address: ownerAddress,
    account_index: phaseOne.accountIndex,
    challenge_token: phaseOne.authorization.challenge_token,
    owner_signature: signingProof.signature,
  });
  return validatePhaseTwo(
    phaseTwoBody,
    ownerAddress,
    phaseOne.accountIndex,
    phaseOne.planCommitment,
  );
}

function validatePhaseOne(
  value: unknown,
  ownerAddress: `0x${string}`,
  requestedAccountIndex: number | undefined,
  nowMs: number,
) {
  const body = object(value);
  const authorization = validateAuthorization(body.challenge, ownerAddress, requestedAccountIndex, nowMs);
  const accountIndex = authorization.payload.account_index;
  const planCommitment = validateCommonProof(body, ownerAddress, accountIndex, false);
  if (
    body.status !== "owner_signature_required" ||
    body.ready !== false ||
    body.recovery_readiness_proven !== false ||
    body.post_account_recovery_ready !== false ||
    !exactStringArray(body.blocking_reasons, ["turnkey_owner_signature_required"]) ||
    planCommitment !== authorization.payload.plan_commitment
  ) throw invalidReadiness();
  return { authorization, accountIndex, planCommitment };
}

function validatePhaseTwo(
  value: unknown,
  ownerAddress: `0x${string}`,
  accountIndex: number,
  expectedPlanCommitment: `0x${string}`,
): VerifiedLighterOwnerRecoveryReadiness {
  const body = object(value);
  const planCommitment = validateCommonProof(body, ownerAddress, accountIndex, true);
  if (
    body.status !== "post_account_recovery_ready" ||
    body.ready !== true ||
    body.recovery_readiness_proven !== true ||
    body.post_account_recovery_ready !== true ||
    !exactStringArray(body.blocking_reasons, []) ||
    planCommitment !== expectedPlanCommitment
  ) throw invalidReadiness();
  return Object.freeze({
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    status: "post_account_recovery_ready",
    owner_address: ownerAddress,
    account_index: accountIndex,
    ready: true,
    recovery_readiness_proven: true,
    post_account_recovery_ready: true,
    funding_precondition_satisfied: false,
    initial_funding_safety_proven: false,
    funding_authorized: false,
    checks: Object.freeze({
      owner_signer_verified: true,
      lighter_balance_verified: false,
      withdrawal_execution_verified: false,
    }),
    safety: Object.freeze({
      no_submit: true,
      transaction_signed: false,
      transaction_broadcast: false,
      withdrawal_authorized: false,
      withdrawal_execution_proven: false,
      funds_moved: false,
    }),
  });
}

function validateAuthorization(
  value: unknown,
  ownerAddress: `0x${string}`,
  requestedAccountIndex: number | undefined,
  nowMs: number,
): LighterOwnerRecoveryReadinessAuthorization {
  const authorization = object(value);
  const payload = object(authorization.payload);
  if (
    !exactKeys(authorization, ["challenge_token", "message", "payload"]) ||
    !exactKeys(payload, [
      "account_index", "audience", "expires_at_ms", "issued_at_ms", "nonce",
      "owner_address", "owner_commitment", "plan_commitment", "version",
    ]) ||
    payload.version !== 1 ||
    payload.audience !== "ghola_lighter_owner_recovery_readiness" ||
    !OWNER_COMMITMENT.test(text(payload.owner_commitment)) ||
    text(payload.owner_address).toLowerCase() !== ownerAddress ||
    !Number.isSafeInteger(payload.account_index) ||
    Number(payload.account_index) < 0 ||
    (requestedAccountIndex !== undefined && payload.account_index !== requestedAccountIndex) ||
    !PLAN_COMMITMENT.test(text(payload.plan_commitment)) ||
    !NONCE.test(text(payload.nonce)) ||
    !Number.isSafeInteger(payload.issued_at_ms) ||
    !Number.isSafeInteger(payload.expires_at_ms) ||
    Number(payload.expires_at_ms) !== Number(payload.issued_at_ms) + READINESS_TTL_MS ||
    Number(payload.issued_at_ms) > nowMs + 5_000 ||
    Number(payload.issued_at_ms) < nowMs - READINESS_TTL_MS - 5_000 ||
    Number(payload.expires_at_ms) <= nowMs
  ) throw invalidReadiness();
  const normalizedPayload = Object.freeze({
    version: 1 as const,
    audience: "ghola_lighter_owner_recovery_readiness" as const,
    owner_commitment: text(payload.owner_commitment),
    owner_address: ownerAddress,
    account_index: Number(payload.account_index),
    plan_commitment: text(payload.plan_commitment).toLowerCase() as `0x${string}`,
    nonce: text(payload.nonce),
    issued_at_ms: Number(payload.issued_at_ms),
    expires_at_ms: Number(payload.expires_at_ms),
  });
  const challengeToken = text(authorization.challenge_token);
  const message = text(authorization.message);
  if (
    challengeToken.length < 80 ||
    challengeToken.length > 2_048 ||
    !CHALLENGE_TOKEN.test(challengeToken) ||
    message !== lighterOwnerRecoveryReadinessMessage(normalizedPayload)
  ) throw invalidReadiness();
  return Object.freeze({ challenge_token: challengeToken, message, payload: normalizedPayload });
}

function validateCommonProof(
  body: Record<string, unknown>,
  ownerAddress: `0x${string}`,
  accountIndex: number,
  ownerSignerVerified: boolean,
): `0x${string}` {
  const applicability = object(body.applicability);
  const checks = object(body.checks);
  const ownerSigner = object(body.owner_signer);
  const safety = object(body.safety);
  const recoveryPlan = object(body.recovery_plan);
  const simulation = object(recoveryPlan.simulation);
  const gas = object(body.gas);
  let plan;
  try {
    plan = assertLighterOwnerRecoveryIntent(recoveryPlan, { ownerAddress, accountIndex });
  } catch {
    throw invalidReadiness();
  }
  const computedPlanCommitment = lighterOwnerRecoveryPlanCommitment(plan).toLowerCase() as `0x${string}`;
  const suppliedPlanCommitment = text(recoveryPlan.plan_commitment).toLowerCase();
  if (
    body.version !== 1 ||
    body.venue_id !== "lighter" ||
    body.network !== "mainnet" ||
    body.operation !== "owner_recovery_readiness" ||
    body.proof_scope !== "post_account_recovery_capability_not_initial_funding_or_withdrawal_availability" ||
    body.funding_precondition_satisfied !== false ||
    body.initial_funding_safety_proven !== false ||
    body.funding_authorized !== false ||
    applicability.stage !== "post_lighter_account_activation" ||
    applicability.brand_new_account_supported !== false ||
    applicability.pre_uda_funding_gate !== false ||
    applicability.initial_funding_safety_proven !== false ||
    checks.authenticated_session !== true ||
    checks.owner_signer_verified !== ownerSignerVerified ||
    checks.owner_account_binding_verified !== true ||
    checks.contract_identity_verified !== true ||
    checks.asset_identity_verified !== true ||
    checks.exact_calldata_simulated !== true ||
    checks.gas_ready !== true ||
    checks.zero_redirect_verified !== true ||
    checks.lighter_balance_verified !== false ||
    checks.withdrawal_execution_verified !== false ||
    ownerSigner.method !== "turnkey_eip191_owner_proof" ||
    text(ownerSigner.owner_address).toLowerCase() !== ownerAddress ||
    ownerSigner.verified !== ownerSignerVerified ||
    ownerSigner.transaction_signed !== false ||
    simulation.performed !== true ||
    simulation.succeeded !== true ||
    simulation.exact_sender_verified !== true ||
    simulation.exact_contract_verified !== true ||
    simulation.exact_calldata_verified !== true ||
    simulation.proves_contract_acceptance_only !== true ||
    simulation.proves_l2_balance !== false ||
    simulation.proves_withdrawal_execution !== false ||
    safety.no_submit !== true ||
    safety.transaction_signed !== false ||
    safety.transaction_broadcast !== false ||
    safety.claim_available !== false ||
    safety.withdrawal_authorized !== false ||
    safety.withdrawal_execution_proven !== false ||
    safety.funds_moved !== false ||
    safety.redirect_possible !== false ||
    gas.ready !== true ||
    !HEX_QUANTITY.test(text(gas.nonce)) ||
    !HEX_QUANTITY.test(text(gas.gas)) ||
    !HEX_QUANTITY.test(text(gas.max_fee_per_gas)) ||
    !HEX_QUANTITY.test(text(gas.max_priority_fee_per_gas)) ||
    !DECIMAL_INTEGER.test(text(gas.owner_balance_wei)) ||
    !DECIMAL_INTEGER.test(text(gas.required_wei)) ||
    !Number.isSafeInteger(body.withdrawal_delay_seconds) ||
    Number(body.withdrawal_delay_seconds) < 0 ||
    !DECIMAL_INTEGER.test(text(body.pending_base_amount)) ||
    suppliedPlanCommitment !== computedPlanCommitment
  ) throw invalidReadiness();
  return computedPlanCommitment;
}

function invalidReadiness() {
  return new Error("Lighter owner recovery readiness proof is invalid.");
}

function exactStringArray(value: unknown, expected: readonly string[]) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
