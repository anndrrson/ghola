import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, serializeTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({ createAccountWithAddress: vi.fn() }));

vi.mock("@turnkey/viem", () => ({
  createAccountWithAddress: mocks.createAccountWithAddress,
}));

import { buildAsterV3AgentOnboardingContract } from "./aster-agent-onboarding";
import {
  signAsterAgentApprovalWithTurnkey,
  signAsterOwnerActivationWithTurnkey,
  TURNKEY_PERPS_OWNER_PATH,
} from "./perps-turnkey-aster-signing";
import { buildAsterOwnerActivationChallenge } from "./aster-owner-activation";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const WRONG = privateKeyToAccount(`0x${"43".repeat(32)}`);
const CLIENT = {} as never;

function typedData() {
  return buildAsterV3AgentOnboardingContract({
    ownerAddress: OWNER.address,
    agentName: "ghola-perps",
    attestedSigner: {
      publicAddress: "0x3333333333333333333333333333333333333333",
      provider: "phala",
      workerId: "phala:cvm:aster-signing-test",
      attestationSha256: `sha256:${"ab".repeat(32)}`,
    },
    nonceMicros: 1_800_000_000_000_000,
    nowMs: 1_800_000_000_000,
    expiresAtMs: 1_800_003_600_000,
  }).approval.typedData;
}

describe("Turnkey Aster owner approval", () => {
  beforeEach(() => mocks.createAccountWithAddress.mockReset());

  it("uses only the exact owner path and forwards the exact typed data", async () => {
    const approval = typedData();
    let forwardedHash: unknown;
    mocks.createAccountWithAddress.mockImplementation(() => ({
      sign: async ({ hash }: { hash: `0x${string}` }) => {
        forwardedHash = hash;
        const signature = await OWNER.sign({ hash });
        return signature.toUpperCase().replace("0X", "0x");
      },
    }));

    const signature = await signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-session-org",
      owner: {
        address: OWNER.address.toLowerCase(),
        path: TURNKEY_PERPS_OWNER_PATH,
        organizationId: "turnkey-resource-org",
      },
      typedData: approval,
    });

    expect(mocks.createAccountWithAddress).toHaveBeenCalledOnce();
    expect(mocks.createAccountWithAddress).toHaveBeenCalledWith({
      client: CLIENT,
      organizationId: "turnkey-resource-org",
      signWith: OWNER.address.toLowerCase(),
      ethereumAddress: OWNER.address.toLowerCase(),
    });
    expect(forwardedHash).toBe(hashTypedData({
      domain: { ...approval.domain, chainId: BigInt(approval.domain.chainId) },
      types: approval.types,
      primaryType: approval.primaryType,
      message: approval.message,
    }));
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("preserves Aster's EIP-712 domain through Turnkey's serialized payload", () => {
    const approval = typedData();
    const serialized = JSON.parse(serializeTypedData({
      domain: { ...approval.domain, chainId: BigInt(approval.domain.chainId) },
      types: approval.types,
      primaryType: approval.primaryType,
      message: approval.message,
    })) as { domain?: unknown; types?: Record<string, unknown> };

    expect(serialized.domain).toEqual({
      ...approval.domain,
      chainId: String(approval.domain.chainId),
    });
    expect(serialized.types?.EIP712Domain).toEqual(approval.types.EIP712Domain);
  });

  it("canonicalizes Turnkey's recovery parity only when it recovers the configured owner", async () => {
    mocks.createAccountWithAddress.mockImplementation(() => ({
      sign: async ({ hash }: { hash: `0x${string}` }) => {
        const signature = await OWNER.sign({ hash });
        const parity = signature.slice(-2).toLowerCase();
        return `${signature.slice(0, -2)}${parity === "1b" ? "1c" : "1b"}`;
      },
    }));

    const signature = await signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    });

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signature.slice(-2)).toMatch(/1b|1c/);
  });

  it("rejects a wrong derivation path before asking Turnkey to sign", async () => {
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: "m/44'/60'/0'/0/1" },
      typedData: typedData(),
    })).rejects.toThrow("requires the Ghola perps owner account");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();
  });

  it("rejects a signature produced by any wallet other than the owner", async () => {
    mocks.createAccountWithAddress.mockImplementation(() => ({
      sign: ({ hash }: { hash: `0x${string}` }) => WRONG.sign({ hash }),
    }));
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    })).rejects.toThrow("signed by the wrong wallet");
    expect(mocks.createAccountWithAddress).toHaveBeenCalledOnce();
  });

  it("fails closed when Turnkey signing fails or returns a malformed signature", async () => {
    mocks.createAccountWithAddress.mockImplementationOnce(() => ({
      sign: async () => { throw new Error("turnkey_signing_failed"); },
    }));
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    })).rejects.toThrow("turnkey_signing_failed");

    mocks.createAccountWithAddress.mockImplementationOnce(() => ({
      sign: async () => "0xdeadbeef",
    }));
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    })).rejects.toThrow("invalid Aster owner signature");
    expect(mocks.createAccountWithAddress).toHaveBeenCalledTimes(2);
  });

  it("personal-signs the exact Aster login challenge with only the perps owner", async () => {
    const challenge = buildAsterOwnerActivationChallenge({
      ownerAddress: OWNER.address,
      nonce: "501182",
    });
    mocks.createAccountWithAddress.mockImplementation(() => ({
      signMessage: ({ message }: { message: string }) => OWNER.signMessage({ message }),
    }));

    const signature = await signAsterOwnerActivationWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-session-org",
      owner: {
        address: OWNER.address,
        path: TURNKEY_PERPS_OWNER_PATH,
        organizationId: "turnkey-resource-org",
      },
      challenge,
    });

    expect(mocks.createAccountWithAddress).toHaveBeenCalledWith({
      client: CLIENT,
      organizationId: "turnkey-resource-org",
      signWith: OWNER.address,
      ethereumAddress: OWNER.address,
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects a cross-owner Aster login challenge before Turnkey signing", async () => {
    const challenge = buildAsterOwnerActivationChallenge({
      ownerAddress: WRONG.address,
      nonce: "501182",
    });
    await expect(signAsterOwnerActivationWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-session-org",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      challenge,
    })).rejects.toThrow("not bound to the Ghola perps owner");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();
  });
});
