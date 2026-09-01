import { createAccountWithAddress } from "@turnkey/viem";
import { recoverMessageAddress, type Hex } from "viem";
import { lighterOwnerAddress } from "./lighter-agent-association";
import {
  lighterOwnerRecoveryReadinessMessage,
  type LighterOwnerRecoveryReadinessPayload,
} from "./lighter-owner-recovery";
import { TURNKEY_PERPS_OWNER_PATH } from "./perps-turnkey-aster-signing";

type TurnkeyViemClient = Parameters<typeof createAccountWithAddress>[0]["client"];

export async function signLighterRecoveryReadinessWithTurnkey(input: {
  client: TurnkeyViemClient;
  organizationId: string;
  owner: { address: string; path?: string | null; organizationId?: string | null };
  authorization: {
    message: string;
    payload: LighterOwnerRecoveryReadinessPayload;
  };
}) {
  if (!input.organizationId.trim()) throw new Error("Turnkey organization is unavailable.");
  if (input.owner.path !== TURNKEY_PERPS_OWNER_PATH) {
    throw new Error("Turnkey Lighter recovery readiness requires the Ghola perps owner account.");
  }
  const owner = lighterOwnerAddress(input.owner.address);
  const payload = input.authorization.payload;
  if (
    payload.version !== 1 || payload.audience !== "ghola_lighter_owner_recovery_readiness" ||
    payload.owner_address.toLowerCase() !== owner ||
    input.authorization.message !== lighterOwnerRecoveryReadinessMessage(payload) ||
    !/^owner_[0-9a-f]{48}$/.test(payload.owner_commitment) ||
    !/^0x[0-9a-f]{64}$/.test(payload.plan_commitment) ||
    !/^[0-9a-f]{64}$/.test(payload.nonce) ||
    !Number.isSafeInteger(payload.issued_at_ms) || !Number.isSafeInteger(payload.expires_at_ms) ||
    payload.expires_at_ms !== payload.issued_at_ms + 120_000
  ) throw new Error("Lighter recovery readiness challenge is invalid.");
  const account = createAccountWithAddress({
    client: input.client,
    organizationId: input.owner.organizationId?.trim() || input.organizationId.trim(),
    signWith: input.owner.address.trim(),
    ethereumAddress: input.owner.address.trim() as `0x${string}`,
  });
  const signature = normalizedSignature(await account.signMessage({ message: input.authorization.message }));
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({ message: input.authorization.message, signature });
  } catch {
    throw new Error("Turnkey returned an invalid Lighter recovery readiness signature.");
  }
  if (recovered.toLowerCase() !== owner) {
    throw new Error("Turnkey Lighter recovery readiness was signed by the wrong wallet.");
  }
  return {
    signature,
    owner_address: owner,
    signing_method: "turnkey_eip191_owner_proof" as const,
    transaction_signed: false as const,
    transaction_broadcast: false as const,
  };
}

function normalizedSignature(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{130}$/i.test(value)) {
    throw new Error("Turnkey returned an invalid Lighter recovery readiness signature.");
  }
  return value.toLowerCase() as Hex;
}
