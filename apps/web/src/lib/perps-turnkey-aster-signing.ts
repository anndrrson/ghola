import { createAccountWithAddress } from "@turnkey/viem";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { AsterV3AgentApprovalTypedData } from "./aster-agent-onboarding";

export const TURNKEY_PERPS_OWNER_PATH = "m/44'/60'/0'/0/0";

type TurnkeyViemClient = Parameters<typeof createAccountWithAddress>[0]["client"];

export async function signAsterAgentApprovalWithTurnkey(input: {
  client: TurnkeyViemClient;
  organizationId: string;
  owner: { address: string; path?: string | null };
  typedData: AsterV3AgentApprovalTypedData;
}): Promise<`0x${string}`> {
  if (!input.organizationId.trim()) throw new Error("Turnkey organization is unavailable.");
  if (input.owner.path !== TURNKEY_PERPS_OWNER_PATH) {
    throw new Error("Turnkey Aster approval requires the Ghola perps owner account.");
  }
  const turnkeyOwnerAddress = input.owner.address.trim();
  const ownerAddress = turnkeyOwnerAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ownerAddress)) {
    throw new Error("Turnkey Aster owner address is invalid.");
  }
  const account = createAccountWithAddress({
    client: input.client,
    organizationId: input.organizationId,
    signWith: turnkeyOwnerAddress,
    ethereumAddress: turnkeyOwnerAddress as `0x${string}`,
  });
  const request = {
    domain: input.typedData.domain,
    types: { Message: input.typedData.types.Message },
    primaryType: input.typedData.primaryType,
    message: input.typedData.message,
  } as const;
  const signature = normalizedSignature(await account.signTypedData(request));
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({ ...request, signature });
  } catch {
    throw new Error("Turnkey returned an invalid Aster owner signature.");
  }
  if (recovered.toLowerCase() !== ownerAddress) {
    throw new Error("Turnkey Aster approval was signed by the wrong wallet.");
  }
  return signature;
}

function normalizedSignature(value: unknown): `0x${string}` {
  if (typeof value !== "string") throw new Error("Turnkey returned an invalid Aster owner signature.");
  const signature = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(signature)) {
    throw new Error("Turnkey returned an invalid Aster owner signature.");
  }
  return signature as Hex;
}
