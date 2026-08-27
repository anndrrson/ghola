import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { asterApprovalSigningDefinition, buildAsterV3AgentOnboardingContract } from "./aster-agent-onboarding";
import { buildLighterChangePubKeyIntent } from "./lighter-agent-association";
import {
  sendLighterKeyAssociationWithInjectedOwner,
  signAsterAgentApprovalWithInjectedOwner,
} from "./injected-venue-owner";

const OWNER = privateKeyToAccount(`0x${"31".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"32".repeat(32)}`);

describe("injected venue owner", () => {
  it("accepts only the exact Aster owner signature", async () => {
    const typedData = asterTypedData();
    const request = vi.fn(async ({ method }: { method: string }) => {
      expect(method).toBe("eth_signTypedData_v4");
      return OWNER.signTypedData(asterApprovalSigningDefinition(typedData));
    });
    await expect(signAsterAgentApprovalWithInjectedOwner({
      provider: { request },
      ownerAddress: OWNER.address,
      typedData,
    })).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects a different Aster signer", async () => {
    const typedData = asterTypedData();
    await expect(signAsterAgentApprovalWithInjectedOwner({
      provider: { request: async () => OTHER.signTypedData(asterApprovalSigningDefinition(typedData)) },
      ownerAddress: OWNER.address,
      typedData,
    })).rejects.toThrow("wrong wallet");
  });

  it("submits the exact Lighter plan once on Ethereum mainnet", async () => {
    const transactionHash = `0x${"ab".repeat(32)}` as const;
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] | object }) => {
      if (method === "eth_chainId") return "0x1";
      expect(method).toBe("eth_sendTransaction");
      expect(params).toEqual([expect.objectContaining({
        from: OWNER.address.toLowerCase(),
        type: "0x2",
        value: "0x0",
      })]);
      return transactionHash;
    });
    await expect(sendLighterKeyAssociationWithInjectedOwner({
      provider: { request },
      ownerAddress: OWNER.address,
      transactionPlan: lighterPlan(),
    })).resolves.toEqual({ external_broadcast: true, transaction_hash: transactionHash });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never submits Lighter on the wrong chain", async () => {
    const request = vi.fn(async () => "0x38");
    await expect(sendLighterKeyAssociationWithInjectedOwner({
      provider: { request },
      ownerAddress: OWNER.address,
      transactionPlan: lighterPlan(),
    })).rejects.toThrow("Ethereum Mainnet");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function asterTypedData() {
  return buildAsterV3AgentOnboardingContract({
    ownerAddress: OWNER.address,
    agentName: "ghola-perps",
    attestedSigner: {
      publicAddress: OTHER.address,
      provider: "phala",
      workerId: "worker-1",
      attestationSha256: `sha256:${"44".repeat(32)}`,
    },
    nonceMicros: 1_800_000_000_000_000,
    nowMs: 1_800_000_000_000,
    expiresAtMs: 1_800_000_060_000,
  }).approval.typedData;
}

function lighterPlan() {
  return {
    ...buildLighterChangePubKeyIntent({
      ownerAddress: OWNER.address,
      accountIndex: 123,
      apiKeyIndex: 2,
      publicKey: `01${"00".repeat(39)}`,
    }),
    nonce: "0x1" as const,
    gas: "0x30d40" as const,
    max_fee_per_gas: "0x6fc23ac00" as const,
    max_priority_fee_per_gas: "0x3b9aca00" as const,
    simulation: {
      performed: true as const,
      succeeded: true as const,
      chain_id_verified: true as const,
      exact_sender_verified: true as const,
      exact_contract_verified: true as const,
    },
  };
}
