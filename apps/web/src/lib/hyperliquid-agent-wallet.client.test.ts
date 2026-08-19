import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  preparePhantomHyperliquidAgentAuthorization,
  preparePhantomHyperliquidAgentDisable,
  type HyperliquidAgentWalletClientDependencies,
  type PhantomEthereumProvider,
} from "./hyperliquid-agent-wallet.client";
import { hyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

const MASTER_KEY = `0x${"11".repeat(32)}` as Hex;
const AGENT_KEY = `0x${"22".repeat(32)}` as Hex;
const OTHER_KEY = `0x${"33".repeat(32)}` as Hex;
const MASTER = privateKeyToAccount(MASTER_KEY);
const AGENT = privateKeyToAccount(AGENT_KEY);
const OTHER = privateKeyToAccount(OTHER_KEY);
const NOW = 1_780_000_000_000;
const ACCOUNT_COMMITMENT = "private_account_test";

function runtime() {
  return {
    providers: [],
    preferred_provider: "phala",
  } as unknown as PrivateAgentRuntimeStatus;
}

function provider(options: { driftOnFinalAccountCheck?: boolean } = {}) {
  const calls: Array<{ method: string; params?: readonly unknown[] }> = [];
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  let accountChecks = 0;
  const value: PhantomEthereumProvider = {
    isPhantom: true,
    on(event, listener) {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    async request(input) {
      calls.push(input);
      if (input.method === "eth_requestAccounts") return [MASTER.address];
      if (input.method === "eth_accounts") {
        accountChecks += 1;
        return options.driftOnFinalAccountCheck && accountChecks > 1
          ? [OTHER.address]
          : [MASTER.address];
      }
      if (input.method === "eth_signTypedData_v4") {
        const payload = JSON.parse(String(input.params?.[1])) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: "HyperliquidTransaction:ApproveAgent";
          message: Record<string, unknown>;
        };
        delete payload.types.EIP712Domain;
        return MASTER.signTypedData({
          domain: payload.domain,
          types: payload.types,
          primaryType: payload.primaryType,
          message: payload.message,
        });
      }
      throw new Error(`unexpected provider method: ${input.method}`);
    },
  };
  return { value, calls, listeners };
}

function dependencies(phantom: PhantomEthereumProvider, order: string[] = []) {
  const preflight = vi.fn(async (account: string) => {
    order.push("preflight");
    expect(account).toBe(MASTER.address.toLowerCase());
    return { ready: true };
  });
  const generateKey = vi.fn(() => {
    order.push("generate");
    return AGENT_KEY;
  });
  const buildVault = vi.fn(async (input) => {
    order.push("seal");
    expect(input.credential.api_wallet_private_key).toBe(AGENT_KEY);
    expect(input.credential.hyperliquid_account_address).toBe(MASTER.address.toLowerCase());
    expect(input.agentWalletAddress).toBe(AGENT.address.toLowerCase());
    return {
      recipient: {} as never,
      associated_data: "aad",
      encrypted_execution_vault: {
        alg: "sealed-provider-v1" as const,
        ciphertext: "sealed-only",
        recipient: "attested:test",
        aad: hyperliquidVaultAssociatedData({
          accountCommitment: ACCOUNT_COMMITMENT,
          recipientId: "attested:test",
          network: "mainnet",
          venueAccountAddress: MASTER.address,
          agentWalletAddress: AGENT.address,
        }),
      },
    };
  });
  return {
    getProvider: () => phantom,
    generateKey,
    deriveAddress: (key: Hex) => privateKeyToAccount(key).address.toLowerCase() as Address,
    recoverAddress: recoverTypedDataAddress,
    preflight,
    buildVault,
    now: () => NOW,
  } satisfies HyperliquidAgentWalletClientDependencies;
}

describe("Phantom Hyperliquid agent-wallet client", () => {
  it("preflights, generates, seals, then requests the one canonical Phantom signature", async () => {
    const phantom = provider();
    const order: string[] = [];
    const deps = dependencies(phantom.value, order);
    const request = await preparePhantomHyperliquidAgentAuthorization({
      accountCommitment: ACCOUNT_COMMITMENT,
      runtime: runtime(),
      dependencies: deps,
    });

    expect(order).toEqual(["preflight", "generate", "seal"]);
    expect(phantom.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_accounts",
      "eth_signTypedData_v4",
      "eth_accounts",
    ]);
    const sign = phantom.calls.find((call) => call.method === "eth_signTypedData_v4");
    expect(sign?.params?.[0]).toBe(MASTER.address.toLowerCase());
    expect(JSON.parse(String(sign?.params?.[1]))).toMatchObject({
      domain: { chainId: 421_614 },
      primaryType: "HyperliquidTransaction:ApproveAgent",
      message: {
        signatureChainId: "0x66eee",
        hyperliquidChain: "Mainnet",
        agentAddress: AGENT.address.toLowerCase(),
        nonce: NOW,
      },
    });
    expect(request.encrypted_execution_vault.ciphertext).toBe("sealed-only");
    expect(JSON.stringify(request)).not.toContain(AGENT_KEY);
    expect(JSON.stringify(request)).not.toContain(MASTER_KEY);
    expect(phantom.listeners.get("accountsChanged")?.size ?? 0).toBe(0);
  });

  it("fails closed when the selected account drifts after signing", async () => {
    const phantom = provider({ driftOnFinalAccountCheck: true });
    await expect(preparePhantomHyperliquidAgentAuthorization({
      accountCommitment: ACCOUNT_COMMITMENT,
      runtime: runtime(),
      dependencies: dependencies(phantom.value),
    })).rejects.toThrow(/changed the selected EVM account/);
  });

  it("fails before key generation when the canonical provider object drifts", async () => {
    const first = provider();
    const second = provider();
    let reads = 0;
    const deps = dependencies(first.value);
    deps.getProvider = () => (++reads < 2 ? first.value : second.value);
    await expect(preparePhantomHyperliquidAgentAuthorization({
      accountCommitment: ACCOUNT_COMMITMENT,
      runtime: runtime(),
      dependencies: deps,
    })).rejects.toThrow(/changed account or provider/);
    expect(deps.generateKey).not.toHaveBeenCalled();
  });

  it("rotates to a fresh discarded same-name key without creating a vault", async () => {
    const phantom = provider();
    const deps = dependencies(phantom.value);
    const request = await preparePhantomHyperliquidAgentDisable({
      accountCommitment: ACCOUNT_COMMITMENT,
      dependencies: deps,
    });
    expect(request.action.agentAddress).toBe(AGENT.address.toLowerCase());
    expect(request.action.agentName).toBe(`ghola-mainnet valid_until ${NOW + 24 * 60 * 60 * 1_000}`);
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.buildVault).not.toHaveBeenCalled();
    expect(JSON.stringify(request)).not.toContain(AGENT_KEY);
  });
});
