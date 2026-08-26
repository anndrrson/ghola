import { createAccountWithAddress } from "@turnkey/viem";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import {
  asterApprovalSigningDefinition,
  type AsterV3AgentApprovalTypedData,
} from "./aster-agent-onboarding";

export const TURNKEY_PERPS_OWNER_PATH = "m/44'/60'/0'/0/0";

type TurnkeyViemClient = Parameters<typeof createAccountWithAddress>[0]["client"];

export async function signAsterAgentApprovalWithTurnkey(input: {
  client: TurnkeyViemClient;
  organizationId: string;
  owner: { address: string; path?: string | null; organizationId?: string | null };
  typedData: AsterV3AgentApprovalTypedData;
}): Promise<`0x${string}`> {
  if (!input.organizationId.trim()) throw new Error("Turnkey organization is unavailable.");
  if (input.owner.path !== TURNKEY_PERPS_OWNER_PATH) {
    throw new Error("Turnkey Aster approval requires the Ghola perps owner account.");
  }
  const signerOrganizationId = input.owner.organizationId?.trim() || input.organizationId.trim();
  const turnkeyOwnerAddress = input.owner.address.trim();
  const ownerAddress = turnkeyOwnerAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ownerAddress)) {
    throw new Error("Turnkey Aster owner address is invalid.");
  }
  const account = createAccountWithAddress({
    client: input.client,
    organizationId: signerOrganizationId,
    signWith: turnkeyOwnerAddress,
    ethereumAddress: turnkeyOwnerAddress as `0x${string}`,
  });
  const request = asterApprovalSigningDefinition(input.typedData);
  // Sign the exact locally verified digest. This avoids any divergence between
  // Turnkey's EIP-712 JSON encoder and viem's verification encoder.
  if (!account.sign) throw new Error("Turnkey raw Aster signing is unavailable.");
  const signature = normalizedSignature(await account.sign({ hash: hashTypedData(request) }));
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({ ...request, signature });
  } catch {
    throw new Error("Turnkey returned an invalid Aster owner signature.");
  }
  if (recovered.toLowerCase() === ownerAddress) return signature;

  // Turnkey's viem serializer has historically treated any non-zero recovery
  // value as yParity=1. Canonicalize only when the alternate parity recovers
  // the exact configured owner; an unrelated signer still fails closed.
  const alternate = alternateParitySignature(signature);
  if (alternate) {
    try {
      recovered = await recoverTypedDataAddress({ ...request, signature: alternate });
      if (recovered.toLowerCase() === ownerAddress) return alternate;
    } catch {
      // Preserve the explicit wrong-wallet failure below.
    }
  }
  throw new Error("Turnkey Aster approval was signed by the wrong wallet.");
}

function normalizedSignature(value: unknown): `0x${string}` {
  if (typeof value !== "string") throw new Error("Turnkey returned an invalid Aster owner signature.");
  const signature = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(signature)) {
    throw new Error("Turnkey returned an invalid Aster owner signature.");
  }
  return signature as Hex;
}

function alternateParitySignature(signature: `0x${string}`): `0x${string}` | null {
  const parity = signature.slice(-2);
  const alternate = parity === "1b" ? "1c" : parity === "1c" ? "1b" : parity === "00" ? "01" : parity === "01" ? "00" : null;
  return alternate ? `${signature.slice(0, -2)}${alternate}` as `0x${string}` : null;
}
