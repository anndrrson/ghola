export interface HyperliquidApiWalletBindingInput {
  accountCommitment: string;
  network: "mainnet" | "testnet";
  ownerAddress: string;
  agentAddress: string;
}

export interface HyperliquidApiWalletBindingProof {
  version: 1;
  network: "mainnet" | "testnet";
  owner_address: string;
  agent_address: string;
  signature: `0x${string}`;
}

export function hyperliquidApiWalletBindingMessage(input: HyperliquidApiWalletBindingInput): string {
  const accountCommitment = input.accountCommitment.trim();
  const ownerAddress = input.ownerAddress.trim().toLowerCase();
  const agentAddress = input.agentAddress.trim().toLowerCase();
  if (!accountCommitment || !/^0x[0-9a-f]{40}$/.test(ownerAddress) || !/^0x[0-9a-f]{40}$/.test(agentAddress)) {
    throw new Error("Hyperliquid API wallet binding details are invalid.");
  }
  if (input.network !== "mainnet" && input.network !== "testnet") {
    throw new Error("Hyperliquid API wallet binding network is invalid.");
  }
  return [
    "Ghola Hyperliquid API wallet binding",
    "Version: 1",
    `Private account: ${accountCommitment}`,
    `Network: ${input.network}`,
    `Owner: ${ownerAddress}`,
    `Agent: ${agentAddress}`,
  ].join("\n");
}
