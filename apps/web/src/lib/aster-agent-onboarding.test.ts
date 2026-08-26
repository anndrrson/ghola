import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ASTER_V3_AGENT_APPROVAL_SCHEMA,
  ASTER_V3_AGENT_MAX_LIFETIME_MS,
  AsterV3AgentOnboardingError,
  asterApprovalSigningDefinition,
  authorizeAsterV3AgentRegistration,
  buildAsterV3AgentOnboardingContract,
  type BuildAsterV3AgentOnboardingInput,
} from "./aster-agent-onboarding";

const TEST_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const NOW_MS = 1_800_000_000_000;

function validInput(overrides: Partial<BuildAsterV3AgentOnboardingInput> = {}): BuildAsterV3AgentOnboardingInput {
  return {
    ownerAddress: TEST_OWNER.address,
    agentName: "ghola-perps",
    attestedSigner: {
      publicAddress: "0x1111111111111111111111111111111111111111",
      provider: "phala",
      workerId: "phala:cvm:ghola-aster-1",
      attestationSha256: `sha256:${"ab".repeat(32)}`,
    },
    nonceMicros: NOW_MS * 1_000 + 321,
    nowMs: NOW_MS,
    expiresAtMs: NOW_MS + 60 * 60 * 1_000,
    ...overrides,
  };
}

describe("Aster V3 agent onboarding contract", () => {
  it("builds the exact documented owner approval and a credential-only setup", () => {
    const contract = buildAsterV3AgentOnboardingContract(validInput({
      ipWhitelist: ["10.0.0.0/024", "2001:db8::1", "10.0.0.0/24"],
    }));

    expect(ASTER_V3_AGENT_APPROVAL_SCHEMA).toMatchObject({
      verified: true,
      endpoint: "/fapi/v3/registerAndApproveAgent",
      method: "POST",
    });
    expect(contract).toMatchObject({
      venue: "aster",
      network: "mainnet",
      permissions: {
        canSpotTrade: false,
        canPerpTrade: true,
        canWithdraw: false,
      },
      ownerAuthorization: {
        required: true,
        status: "signature_required",
        ownerAddress: TEST_OWNER.address.toLowerCase(),
      },
      setup: { mayPlaceTrade: false, networkEffects: "none" },
      attestedSigner: {
        publicAddress: "0x1111111111111111111111111111111111111111",
        privateKeyExposed: false,
      },
    });
    expect(contract.approval.parametersWithoutSignature).toEqual({
      agentName: "ghola-perps",
      agentAddress: "0x1111111111111111111111111111111111111111",
      ipWhitelist: "10.0.0.0/24 2001:db8::1",
      expired: NOW_MS + 60 * 60 * 1_000,
      signatureChainId: 56,
      canSpotTrade: false,
      canPerpTrade: true,
      canWithdraw: false,
      user: TEST_OWNER.address.toLowerCase(),
      nonce: NOW_MS * 1_000 + 321,
    });
    expect(contract.approval.message).toBe(
      `user=${TEST_OWNER.address.toLowerCase()}&nonce=${NOW_MS * 1_000 + 321}` +
      "&agentName=ghola-perps&agentAddress=0x1111111111111111111111111111111111111111" +
      `&expired=${NOW_MS + 60 * 60 * 1_000}` +
      "&signatureChainId=56" +
      "&canSpotTrade=false&canPerpTrade=true&canWithdraw=false" +
      "&ipWhitelist=10.0.0.0/24 2001:db8::1",
    );
    expect(contract.approval.typedData).toEqual({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Message: [{ name: "msg", type: "string" }],
      },
      primaryType: "Message",
      domain: {
        name: "AsterSignTransaction",
        version: "1",
        chainId: 56,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      message: { msg: contract.approval.message },
    });
  });

  it("requires and verifies an explicit signature from the owner before producing request parameters", async () => {
    const contract = buildAsterV3AgentOnboardingContract(validInput());
    const signature = await TEST_OWNER.signTypedData(signingDefinition(contract));
    const authorized = await authorizeAsterV3AgentRegistration(contract, signature);

    expect(authorized.ownerAuthorization).toEqual({
      required: true,
      status: "signature_verified",
      ownerAddress: TEST_OWNER.address.toLowerCase(),
    });
    expect(authorized.parameters.signature).toBe(signature);
    expect(authorized.setup).toEqual({ mayPlaceTrade: false, networkEffects: "none" });
  });

  it("rejects a signature from any address other than the collateral owner", async () => {
    const contract = buildAsterV3AgentOnboardingContract(validInput());
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a84177b0fbcfdadab8e");
    const signature = await other.signTypedData(signingDefinition(contract));

    await expect(authorizeAsterV3AgentRegistration(contract, signature)).rejects.toMatchObject({
      code: "owner_signature_mismatch",
    });
  });

  it.each([
    [{ canSpotTrade: true, canPerpTrade: true, canWithdraw: false }, "permissions_outside_policy"],
    [{ canSpotTrade: false, canPerpTrade: false, canWithdraw: false }, "permissions_outside_policy"],
    [{ canSpotTrade: false, canPerpTrade: true, canWithdraw: true }, "permissions_outside_policy"],
  ] as const)("rejects permission broadening or removal: %j", (permissions, code) => {
    expect(() => buildAsterV3AgentOnboardingContract(validInput({ permissions }))).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects trades during setup, stale nonces, and unbounded expiry", () => {
    expect(() => buildAsterV3AgentOnboardingContract(validInput({ mayPlaceTradeDuringSetup: true }))).toThrowError(
      expect.objectContaining({ code: "setup_trade_blocked" }),
    );
    expect(() => buildAsterV3AgentOnboardingContract(validInput({ nonceMicros: (NOW_MS - 10_001) * 1_000 }))).toThrowError(
      expect.objectContaining({ code: "nonce_outside_aster_window" }),
    );
    expect(() => buildAsterV3AgentOnboardingContract(validInput({
      expiresAtMs: NOW_MS + ASTER_V3_AGENT_MAX_LIFETIME_MS + 1,
    }))).toThrowError(expect.objectContaining({ code: "expiry_outside_policy" }));
    expect(buildAsterV3AgentOnboardingContract(validInput({
      expiresAtMs: NOW_MS + ASTER_V3_AGENT_MAX_LIFETIME_MS,
    })).approval.parametersWithoutSignature.expired).toBe(NOW_MS + 30 * 24 * 60 * 60 * 1_000);
  });

  it("fails closed on malformed attestation, ambiguous names, addresses, and IP restrictions", () => {
    const cases: Array<[Partial<BuildAsterV3AgentOnboardingInput>, string]> = [
      [{ ownerAddress: "0x1234" }, "owner_address_invalid"],
      [{ agentName: "bad&canWithdraw=true" }, "agent_name_invalid"],
      [{ attestedSigner: { ...validInput().attestedSigner, attestationSha256: "sha256:nope" } }, "attestation_digest_invalid"],
      [{ ipWhitelist: ["300.1.1.1"] }, "ip_whitelist_invalid"],
      [{ ipWhitelist: ["10.0.0.0/33"] }, "ip_whitelist_invalid"],
    ];
    for (const [override, code] of cases) {
      expect(() => buildAsterV3AgentOnboardingContract(validInput(override))).toThrowError(
        expect.objectContaining({ code }),
      );
    }
    expect(() => buildAsterV3AgentOnboardingContract(validInput({
      attestedSigner: { ...validInput().attestedSigner, publicAddress: TEST_OWNER.address },
    }))).toThrowError(expect.objectContaining({ code: "owner_agent_address_collision" }));
  });

  it("returns a typed domain and contract that callers cannot mutate", () => {
    const contract = buildAsterV3AgentOnboardingContract(validInput());
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.permissions)).toBe(true);
    expect(Object.isFrozen(contract.approval.typedData.types.Message)).toBe(true);
    expect(() => {
      (contract.permissions as { canWithdraw: boolean }).canWithdraw = true;
    }).toThrow(TypeError);
    expect(contract.permissions.canWithdraw).toBe(false);
  });

  it("uses stable machine-readable failures", () => {
    try {
      buildAsterV3AgentOnboardingContract(validInput({ agentName: "" }));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AsterV3AgentOnboardingError);
      expect(error).toMatchObject({ code: "agent_name_invalid" });
    }
  });
});

function signingDefinition(contract: ReturnType<typeof buildAsterV3AgentOnboardingContract>) {
  return asterApprovalSigningDefinition(contract.approval.typedData);
}
