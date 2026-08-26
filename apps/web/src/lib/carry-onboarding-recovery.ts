import type {
  AsterProgrammaticPreparation,
  AsterPublicRegistrationReceipt,
  LighterAssociationProof,
  LighterProgrammaticPreparation,
} from "./private-account-client";
import { keccak256 } from "viem";
import {
  LIGHTER_MAINNET_PROXY_ADDRESS,
  buildLighterChangePubKeyIntent,
} from "./lighter-agent-association";

const STORAGE_PREFIX = "ghola:carry-onboarding-recovery:v1:";
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1_000;
const ACCOUNT = /^[A-Za-z0-9_.:-]{8,240}$/;
const ASTER_PREPARATION = /^aster_prepare_[0-9a-f]{64}$/;
const LIGHTER_PREPARATION = /^lighter_prepare_[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const RAW_TRANSACTION = /^0x02[0-9a-f]+$/i;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX_QUANTITY = /^0x[0-9a-f]+$/i;
const SIGNATURE_COMMITMENT = /^sha256:[0-9a-f]{64}$/i;

export interface PendingAsterOnboarding {
  preparation: AsterProgrammaticPreparation;
  signature?: `0x${string}`;
  receipt?: AsterPublicRegistrationReceipt;
}

export interface PendingLighterOnboarding {
  preparation: LighterProgrammaticPreparation;
  authorization: LighterAssociationProof;
}

export interface CarryOnboardingRecovery {
  version: 1;
  account_commitment: string;
  saved_at_ms: number;
  aster?: PendingAsterOnboarding;
  lighter?: PendingLighterOnboarding;
}

export function readCarryOnboardingRecovery(
  storage: Pick<Storage, "getItem" | "removeItem">,
  accountCommitment: string,
  nowMs = Date.now(),
): CarryOnboardingRecovery | null {
  const key = recoveryKey(accountCommitment);
  try {
    const value = JSON.parse(storage.getItem(key) || "null") as unknown;
    if (!validRecovery(value, accountCommitment, nowMs)) {
      storage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeCarryOnboardingRecovery(
  storage: Pick<Storage, "setItem">,
  accountCommitment: string,
  pending: Pick<CarryOnboardingRecovery, "aster" | "lighter">,
  nowMs = Date.now(),
): CarryOnboardingRecovery {
  const value: CarryOnboardingRecovery = {
    version: 1,
    account_commitment: normalizedAccount(accountCommitment),
    saved_at_ms: nowMs,
    ...(pending.aster ? { aster: pending.aster } : {}),
    ...(pending.lighter ? { lighter: pending.lighter } : {}),
  };
  if (!validRecovery(value, accountCommitment, nowMs)) throw new Error("carry_onboarding_recovery_invalid");
  storage.setItem(recoveryKey(accountCommitment), JSON.stringify(value));
  return value;
}

export function clearCarryOnboardingRecovery(
  storage: Pick<Storage, "removeItem">,
  accountCommitment: string,
): void {
  storage.removeItem(recoveryKey(accountCommitment));
}

export function updateCarryOnboardingRecovery(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  accountCommitment: string,
  update: { aster?: PendingAsterOnboarding | null; lighter?: PendingLighterOnboarding | null },
  nowMs = Date.now(),
): CarryOnboardingRecovery | null {
  const current = readCarryOnboardingRecovery(storage, accountCommitment, nowMs);
  const aster = Object.hasOwn(update, "aster") ? update.aster ?? undefined : current?.aster;
  const lighter = Object.hasOwn(update, "lighter") ? update.lighter ?? undefined : current?.lighter;
  if (!aster && !lighter) {
    clearCarryOnboardingRecovery(storage, accountCommitment);
    return null;
  }
  return writeCarryOnboardingRecovery(storage, accountCommitment, { aster, lighter }, nowMs);
}

function validRecovery(value: unknown, accountCommitment: string, nowMs: number): value is CarryOnboardingRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 || record.account_commitment !== normalizedAccount(accountCommitment) ||
    !Number.isSafeInteger(record.saved_at_ms) || Number(record.saved_at_ms) > nowMs + 60_000 ||
    nowMs - Number(record.saved_at_ms) > MAX_AGE_MS
  ) return false;
  const aster = record.aster;
  const lighter = record.lighter;
  if (!aster && !lighter) return false;
  return (!aster || validAster(aster, normalizedAccount(accountCommitment))) &&
    (!lighter || validLighter(lighter, normalizedAccount(accountCommitment)));
}

function validAster(value: unknown, accountCommitment: string): value is PendingAsterOnboarding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const preparation = asRecord(record.preparation);
  const contract = asRecord(preparation.contract);
  const signer = asRecord(contract.attestedSigner);
  const owner = asRecord(contract.ownerAuthorization);
  const permissions = asRecord(contract.permissions);
  const setup = asRecord(contract.setup);
  const approval = asRecord(contract.approval);
  const parameters = asRecord(approval.parametersWithoutSignature);
  const encryptedVault = asRecord(preparation.encrypted_execution_vault);
  const receipt = record.receipt === undefined ? null : asRecord(record.receipt);
  const ownerAddress = string(owner.ownerAddress).toLowerCase();
  const signerAddress = string(signer.publicAddress).toLowerCase();
  const expiresAtMs = Date.parse(string(preparation.authorization_expires_at));
  return preparation.version === 1 && preparation.venue_id === "aster" &&
    preparation.account_commitment === accountCommitment &&
    preparation.credential_provisioning_mode === "programmatic_generated" &&
    preparation.owner_approval_required === true &&
    ASTER_PREPARATION.test(string(preparation.preparation_id)) &&
    (record.signature === undefined || SIGNATURE.test(string(record.signature))) &&
    contract.version === 1 && contract.venue === "aster" && contract.network === "mainnet" &&
    contract.endpoint === "/fapi/v3/registerAndApproveAgent" && contract.method === "POST" &&
    EVM_ADDRESS.test(ownerAddress) && EVM_ADDRESS.test(signerAddress) && ownerAddress !== signerAddress &&
    owner.required === true && owner.status === "signature_required" && owner.algorithm === "EIP-712" &&
    signer.privateKeyExposed === false &&
    permissions.canSpotTrade === false && permissions.canPerpTrade === true && permissions.canWithdraw === false &&
    setup.mayPlaceTrade === false && setup.networkEffects === "none" &&
    parameters.user === ownerAddress && parameters.agentAddress === signerAddress &&
    parameters.signatureChainId === 56 && parameters.canSpotTrade === false &&
    parameters.canPerpTrade === true && parameters.canWithdraw === false &&
    Number.isSafeInteger(parameters.nonce) && Number.isSafeInteger(parameters.expired) &&
    Number.isFinite(expiresAtMs) && expiresAtMs === Number(parameters.expired) &&
    string(encryptedVault.ciphertext).length > 0 &&
    asRecord(preparation.setup).may_place_trade === false &&
    asRecord(preparation.setup).transaction_broadcast === false &&
    asRecord(preparation.setup).credential_registered === false &&
    (!receipt || (SIGNATURE.test(string(record.signature)) &&
      receipt.version === 1 && receipt.venue_id === "aster" && receipt.status === "registered" &&
      receipt.preparation_id === preparation.preparation_id &&
      string(receipt.owner_address).toLowerCase() === ownerAddress &&
      string(receipt.signer_address).toLowerCase() === signerAddress &&
      receipt.authorization_expires_at === preparation.authorization_expires_at &&
      SIGNATURE_COMMITMENT.test(string(receipt.signature_commitment))
    ));
}

function validLighter(value: unknown, accountCommitment: string): value is PendingLighterOnboarding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const preparation = asRecord(record.preparation);
  const authorization = asRecord(record.authorization);
  const association = asRecord(preparation.owner_association);
  const plan = asRecord(preparation.transaction_plan);
  const simulation = asRecord(plan.simulation);
  const encryptedVault = asRecord(preparation.encrypted_execution_vault);
  const setup = asRecord(preparation.setup);
  const rawTransaction = string(authorization.raw_transaction);
  const transactionHash = string(authorization.transaction_hash).toLowerCase();
  let expectedData = "";
  try {
    expectedData = buildLighterChangePubKeyIntent({
      ownerAddress: string(plan.from),
      accountIndex: Number(plan.account_index),
      apiKeyIndex: Number(plan.api_key_index),
      publicKey: string(plan.public_key),
    }).data.toLowerCase();
  } catch {
    return false;
  }
  return preparation.version === 1 && preparation.venue_id === "lighter" &&
    preparation.account_commitment === accountCommitment &&
    preparation.credential_provisioning_mode === "programmatic_generated" &&
    preparation.owner_approval_required === true &&
    LIGHTER_PREPARATION.test(string(preparation.preparation_id)) &&
    association.method === "ethereum_change_pub_key" && association.status === "transaction_prepared" &&
    association.ethereum_gas_required === true &&
    plan.chain_id === 1 && EVM_ADDRESS.test(string(plan.from)) &&
    string(plan.to).toLowerCase() === LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase() &&
    plan.value === "0x0" && plan.function === "changePubKey(uint48,uint8,bytes)" &&
    string(plan.data).toLowerCase() === expectedData &&
    plan.transaction_signed === false && plan.transaction_broadcast === false &&
    plan.simulation_required_before_signing === true &&
    HEX_QUANTITY.test(string(plan.nonce)) && HEX_QUANTITY.test(string(plan.gas)) &&
    HEX_QUANTITY.test(string(plan.max_fee_per_gas)) && HEX_QUANTITY.test(string(plan.max_priority_fee_per_gas)) &&
    simulation.performed === true && simulation.succeeded === true &&
    simulation.chain_id_verified === true && simulation.exact_sender_verified === true &&
    simulation.exact_contract_verified === true &&
    string(encryptedVault.ciphertext).length > 0 &&
    setup.may_place_trade === false && setup.transaction_signed === false &&
    setup.transaction_broadcast === false && setup.credential_ready === false &&
    RAW_TRANSACTION.test(rawTransaction) && TRANSACTION_HASH.test(transactionHash) &&
    keccak256(rawTransaction as `0x${string}`).toLowerCase() === transactionHash;
}

function recoveryKey(accountCommitment: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(normalizedAccount(accountCommitment))}`;
}

function normalizedAccount(value: string): string {
  const normalized = String(value || "").trim();
  if (!ACCOUNT.test(normalized)) throw new Error("carry_onboarding_account_invalid");
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
