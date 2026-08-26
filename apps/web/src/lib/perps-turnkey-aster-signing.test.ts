import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({ createAccountWithAddress: vi.fn() }));

vi.mock("@turnkey/viem", () => ({
  createAccountWithAddress: mocks.createAccountWithAddress,
}));

import { buildAsterV3AgentOnboardingContract } from "./aster-agent-onboarding";
import {
  signAsterAgentApprovalWithTurnkey,
  TURNKEY_PERPS_OWNER_PATH,
} from "./perps-turnkey-aster-signing";

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
    let forwarded: unknown;
    mocks.createAccountWithAddress.mockImplementation(() => ({
      signTypedData: async (request: Parameters<typeof OWNER.signTypedData>[0]) => {
        forwarded = request;
        const signature = await OWNER.signTypedData(request);
        return signature.toUpperCase().replace("0X", "0x");
      },
    }));

    const signature = await signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: approval,
    });

    expect(mocks.createAccountWithAddress).toHaveBeenCalledOnce();
    expect(mocks.createAccountWithAddress).toHaveBeenCalledWith({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      signWith: OWNER.address,
      ethereumAddress: OWNER.address,
    });
    expect(forwarded).toEqual({
      domain: approval.domain,
      types: { Message: approval.types.Message },
      primaryType: approval.primaryType,
      message: approval.message,
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
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
      signTypedData: (request: Parameters<typeof WRONG.signTypedData>[0]) => WRONG.signTypedData(request),
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
      signTypedData: async () => { throw new Error("turnkey_signing_failed"); },
    }));
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    })).rejects.toThrow("turnkey_signing_failed");

    mocks.createAccountWithAddress.mockImplementationOnce(() => ({
      signTypedData: async () => "0xdeadbeef",
    }));
    await expect(signAsterAgentApprovalWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      typedData: typedData(),
    })).rejects.toThrow("invalid Aster owner signature");
    expect(mocks.createAccountWithAddress).toHaveBeenCalledTimes(2);
  });
});
