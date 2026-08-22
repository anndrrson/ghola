import { describe, expect, it } from "vitest";
import { recoverMessageAddress } from "viem";
import {
  generateHyperliquidApiWallet,
  hyperliquidApiWalletAddress,
  signHyperliquidApiWalletBinding,
} from "./hyperliquid-api-wallet";
import { hyperliquidApiWalletBindingMessage } from "./hyperliquid-agent-binding";
import { validateHyperliquidExecutionCredentialDraft } from "./hyperliquid-vault-seal";

describe("Hyperliquid API wallet generation", () => {
  it("derives the canonical Ethereum address for a private key", () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;

    expect(hyperliquidApiWalletAddress(privateKey)).toBe(
      "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    );
  });

  it("returns a valid dedicated keypair without confusing the address for the key", () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const generated = generateHyperliquidApiWallet(() => privateKey);

    expect(generated.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(generated.privateKey).toBe(`0x${Array.from(privateKey, (byte) =>
      byte.toString(16).padStart(2, "0")).join("")}`);
    expect(generated.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(generated.privateKey).not.toBe(generated.address);
    expect(validateHyperliquidExecutionCredentialDraft({
      network: "testnet",
      hyperliquid_account_address: "0x1111111111111111111111111111111111111111",
      api_wallet_private_key: generated.privateKey,
      agent_name: "ghola",
    })).toEqual([]);
  });

  it("rejects invalid private-key material", () => {
    expect(() => hyperliquidApiWalletAddress(new Uint8Array(20))).toThrow(
      "Could not create a valid Hyperliquid API wallet.",
    );
    expect(() => hyperliquidApiWalletAddress(new Uint8Array(32))).toThrow(
      "Could not create a valid Hyperliquid API wallet.",
    );
  });

  it("signs an owner-to-agent claim with the exact API wallet key", async () => {
    const privateKey = `0x${"00".repeat(31)}01`;
    const proof = await signHyperliquidApiWalletBinding({
      privateKey,
      accountCommitment: "private_account_test_binding",
      network: "mainnet",
      ownerAddress: "0x1111111111111111111111111111111111111111",
    });
    const recovered = await recoverMessageAddress({
      message: hyperliquidApiWalletBindingMessage({
        accountCommitment: "private_account_test_binding",
        network: "mainnet",
        ownerAddress: proof.owner_address,
        agentAddress: proof.agent_address,
      }),
      signature: proof.signature,
    });

    expect(proof.agent_address).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(recovered.toLowerCase()).toBe(proof.agent_address);
  });
});
