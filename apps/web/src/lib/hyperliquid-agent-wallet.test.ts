import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  HYPERLIQUID_AGENT_PRIMARY_TYPE,
  HYPERLIQUID_AGENT_VALIDITY_MS,
  createHyperliquidApproveAgentAction,
  hyperliquidApproveAgentProviderPayload,
  hyperliquidApproveAgentTypedData,
  parseHyperliquidAgentName,
  parseHyperliquidEvmSignature,
  signatureHex,
} from "./hyperliquid-agent-wallet";

const MASTER_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const AGENT_ADDRESS = "0x2222222222222222222222222222222222222222";
const ACCOUNT_COMMITMENT = "private_account_test";
const NOW = 1_780_000_000_000;

describe("Hyperliquid approveAgent signing", () => {
  it("matches the official SDK EIP-712 field order, domain, and fixed signer chain", () => {
    const action = createHyperliquidApproveAgentAction({
      accountCommitment: ACCOUNT_COMMITMENT,
      agentAddress: AGENT_ADDRESS.toUpperCase().replace("0X", "0x"),
      nowMs: NOW,
    });

    expect(hyperliquidApproveAgentProviderPayload(action)).toEqual({
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 421_614,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: HYPERLIQUID_AGENT_PRIMARY_TYPE,
      message: {
        type: "approveAgent",
        hyperliquidChain: "Mainnet",
        signatureChainId: "0x66eee",
        agentAddress: AGENT_ADDRESS,
        agentName: `ghola-mainnet valid_until ${NOW + HYPERLIQUID_AGENT_VALIDITY_MS}`,
        nonce: NOW,
      },
    });
  });

  it("locally recovers the exact signer from the canonical typed data", async () => {
    const master = privateKeyToAccount(MASTER_PRIVATE_KEY);
    const action = createHyperliquidApproveAgentAction({
      accountCommitment: ACCOUNT_COMMITMENT,
      agentAddress: AGENT_ADDRESS,
      nowMs: NOW,
    });
    const signature = await master.signTypedData(hyperliquidApproveAgentTypedData(action));
    const parsed = parseHyperliquidEvmSignature(signature);

    await expect(recoverTypedDataAddress({
      ...hyperliquidApproveAgentTypedData(action),
      signature: signatureHex(parsed),
    })).resolves.toBe(master.address);
    expect(signatureHex(parsed).slice(0, -2)).toBe(signature.toLowerCase().slice(0, -2));
    expect(parsed.v).toBe(Number.parseInt(signature.slice(-2), 16));
  });

  it("uses one fixed 24-hour named-agent window", () => {
    const action = createHyperliquidApproveAgentAction({
      accountCommitment: ACCOUNT_COMMITMENT,
      agentAddress: AGENT_ADDRESS,
      nowMs: NOW,
    });
    expect(parseHyperliquidAgentName(action.agentName, ACCOUNT_COMMITMENT)).toEqual({
      base_name: "ghola-mainnet",
      valid_until_ms: NOW + 24 * 60 * 60 * 1_000,
    });
    expect(parseHyperliquidAgentName(action.agentName, "different-account")).toEqual({
      base_name: "ghola-mainnet",
      valid_until_ms: NOW + 24 * 60 * 60 * 1_000,
    });
  });

  it("rejects malformed signatures and agent addresses", () => {
    expect(() => parseHyperliquidEvmSignature("0x1234")).toThrow(/invalid Hyperliquid signature/);
    expect(() => createHyperliquidApproveAgentAction({
      accountCommitment: ACCOUNT_COMMITMENT,
      agentAddress: "not-an-address",
      nowMs: NOW,
    })).toThrow(/valid EVM account/);
  });
});
