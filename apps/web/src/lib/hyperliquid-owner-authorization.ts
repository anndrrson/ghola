import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { createWalletClient, custom, type Address } from "viem";
import { GHOLA_HYPERLIQUID_AGENT_NAME } from "./hyperliquid-agent-policy";

export type InjectedEvmProvider = {
  isPhantom?: boolean;
  request: (input: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

type WalletWindow = Window & {
  phantom?: { ethereum?: InjectedEvmProvider };
  ethereum?: InjectedEvmProvider & { providers?: InjectedEvmProvider[] };
};

export function resolveInjectedEvmProvider(browserWindow: WalletWindow = window as WalletWindow) {
  const phantom = browserWindow.phantom?.ethereum;
  if (phantom?.isPhantom) return phantom;
  const providers = browserWindow.ethereum?.providers || [];
  return providers.find((provider) => provider.isPhantom) || browserWindow.ethereum || null;
}

export async function connectInjectedHyperliquidOwner(provider: InjectedEvmProvider) {
  const accounts = await provider.request({ method: "eth_requestAccounts", params: [] });
  const ownerAddress = firstEvmAddress(accounts);
  if (!ownerAddress) throw new Error("wallet_owner_address_missing");
  return ownerAddress;
}

export async function authorizeHyperliquidAgentWithInjectedOwner(input: {
  provider: InjectedEvmProvider;
  ownerAddress: `0x${string}`;
  agentAddress: `0x${string}`;
  network: "mainnet" | "testnet";
}) {
  const wallet = createWalletClient({
    account: input.ownerAddress as Address,
    transport: custom(input.provider),
  });
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ isTestnet: input.network === "testnet", timeout: 12_000 }),
    wallet,
  });
  await exchange.approveAgent({
    agentAddress: input.agentAddress,
    agentName: GHOLA_HYPERLIQUID_AGENT_NAME,
  });
}

export function injectedWalletErrorMessage(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code?: unknown }).code)
    : null;
  if (code === 4001) return "Wallet authorization was canceled. No trading access was granted.";
  if (code === -32002) return "A wallet approval is already open. Finish or reject it, then continue once.";
  if (code === 4100) return "Unlock the wallet that owns your Hyperliquid collateral and connect it.";
  if (error instanceof Error && error.message === "wallet_owner_address_missing") {
    return "The wallet did not return an EVM account.";
  }
  return error instanceof Error ? error.message : "The wallet could not authorize Ghola.";
}

function firstEvmAddress(value: unknown): `0x${string}` | null {
  if (!Array.isArray(value)) return null;
  const address = value.find((candidate) =>
    typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate),
  );
  return typeof address === "string" ? address.toLowerCase() as `0x${string}` : null;
}
