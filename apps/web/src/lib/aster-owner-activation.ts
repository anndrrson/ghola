import { recoverMessageAddress, type Hex } from "viem";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ASTER_NONCE = /^[0-9]{1,32}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export const ASTER_OWNER_ACTIVATION_SCHEMA = Object.freeze({
  verified: true,
  origin: "https://www.asterdex.com",
  nonceEndpoint: "/bapi/futures/v1/public/future/web3/get-nonce",
  loginEndpoint: "/bapi/futures/v1/public/future/web3/ae/login",
  nonceType: "LOGIN",
  clientType: "web",
  chainId: 56,
  documentationCommit: "e48f0f0ba55c5446993c1fd4d9981924d76f90c6",
  documentationUrl:
    "https://github.com/asterdex/api-docs/blob/e48f0f0ba55c5446993c1fd4d9981924d76f90c6/demo/create-apikey-front.js",
} as const);

export interface AsterOwnerActivationChallenge {
  readonly version: 1;
  readonly venue: "aster";
  readonly ownerAddress: `0x${string}`;
  readonly nonce: string;
  readonly message: string;
  readonly chainId: 56;
  readonly setup: Readonly<{
    mayDeposit: false;
    mayTrade: false;
    mayTransfer: false;
    mayWithdraw: false;
  }>;
}

export class AsterOwnerActivationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AsterOwnerActivationError";
  }
}

export function buildAsterOwnerActivationChallenge(input: {
  ownerAddress: string;
  nonce: string;
}): AsterOwnerActivationChallenge {
  const ownerAddress = normalizeAddress(input.ownerAddress);
  const nonce = normalizeNonce(input.nonce);
  return Object.freeze({
    version: 1,
    venue: "aster",
    ownerAddress,
    nonce,
    message: `You are signing into Astherus ${nonce}`,
    chainId: ASTER_OWNER_ACTIVATION_SCHEMA.chainId,
    setup: Object.freeze({
      mayDeposit: false,
      mayTrade: false,
      mayTransfer: false,
      mayWithdraw: false,
    }),
  });
}

export async function verifyAsterOwnerActivationSignature(input: {
  challenge: AsterOwnerActivationChallenge;
  signature: string;
}): Promise<Hex> {
  const expected = buildAsterOwnerActivationChallenge({
    ownerAddress: input.challenge.ownerAddress,
    nonce: input.challenge.nonce,
  });
  if (
    input.challenge.version !== expected.version ||
    input.challenge.venue !== expected.venue ||
    input.challenge.message !== expected.message ||
    input.challenge.chainId !== expected.chainId ||
    input.challenge.setup.mayDeposit !== false ||
    input.challenge.setup.mayTrade !== false ||
    input.challenge.setup.mayTransfer !== false ||
    input.challenge.setup.mayWithdraw !== false
  ) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_challenge_invalid",
      "The Aster owner activation challenge is invalid.",
    );
  }
  const signature = input.signature.trim().toLowerCase();
  if (!EVM_SIGNATURE.test(signature)) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_signature_invalid",
      "The Aster owner activation signature is invalid.",
    );
  }
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: expected.message,
      signature: signature as Hex,
    });
  } catch {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_signature_invalid",
      "The Aster owner activation signature is invalid.",
    );
  }
  if (recovered.toLowerCase() !== expected.ownerAddress) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_wrong_wallet",
      "The Aster owner activation was signed by the wrong wallet.",
    );
  }
  return signature as Hex;
}

export function asterOwnerActivationNonce(value: unknown): string {
  const envelope = record(value);
  const data = record(envelope.data);
  if (envelope.success !== true || string(envelope.code) !== "000000") {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_nonce_rejected",
      "Aster rejected the owner activation challenge request.",
    );
  }
  return normalizeNonce(string(data.nonce));
}

export function validateAsterOwnerActivationLogin(value: unknown): {
  providerUid: string;
} {
  const envelope = record(value);
  const data = record(envelope.data);
  const providerUid = string(data.uid);
  const sessionToken = string(data.token);
  if (
    envelope.success !== true ||
    string(envelope.code) !== "000000" ||
    !providerUid ||
    !sessionToken
  ) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_receipt_invalid",
      "Aster did not return a valid owner activation receipt.",
    );
  }
  return { providerUid };
}

function normalizeAddress(value: string): `0x${string}` {
  const normalized = String(value || "").trim().toLowerCase();
  if (!EVM_ADDRESS.test(normalized)) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_address_invalid",
      "The Aster owner address is invalid.",
    );
  }
  return normalized as `0x${string}`;
}

function normalizeNonce(value: string): string {
  const normalized = String(value || "").trim();
  if (!ASTER_NONCE.test(normalized)) {
    throw new AsterOwnerActivationError(
      "aster_owner_activation_nonce_invalid",
      "Aster returned an invalid owner activation nonce.",
    );
  }
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return "";
}
