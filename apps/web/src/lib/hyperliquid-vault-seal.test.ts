import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { localEd25519Signer, open } from "./envelope";
import {
  buildHyperliquidExecutionVaultBundle,
  hyperliquidVaultAssociatedData,
  parseHyperliquidCredentialImport,
  validateHyperliquidExecutionCredentialDraft,
} from "./hyperliquid-vault-seal";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("Hyperliquid vault sealing", () => {
  it("seals raw execution credentials to the attested TEE recipient only", async () => {
    const userSecret = ed25519.utils.randomPrivateKey();
    const walletAddress = bs58.encode(ed25519.getPublicKey(userSecret));
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const recipientId = "phala:cvm:test";
    const accountCommitment = "private_account_commitment_test";
    const runtimeStatus: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: "2026-05-27T12:00:00.000Z",
      sealed_execution_required: true,
      entitlement_required: "paid_private_agent_plan",
      preferred_provider: "phala",
      selected_provider: "phala",
      remote_execution_ready: true,
      shielded_rail_ready: true,
      providers: [
        {
          id: "phala",
          label: "Phala TEE",
          configured: true,
          available: true,
          attested: true,
          supports_sealed_secrets: true,
          supports_background_agents: true,
          supports_trading_execution: true,
          reason: null,
          sealed_recipient: {
            recipient_id: recipientId,
            x25519_pub_hex: bytesToHex(recipientPub),
            tee_kind: "phala",
            measurement_hex: "00".repeat(32),
          },
        },
      ],
      blocking_reasons: [],
      disclosure: "test",
    };
    const apiWalletPrivateKey = `0x${"ab".repeat(32)}`;
    const hyperliquidAccount = "0x1111111111111111111111111111111111111111";

    const built = await buildHyperliquidExecutionVaultBundle({
      accountCommitment,
      ownerWalletAddress: walletAddress,
      credential: {
        network: "mainnet",
        hyperliquid_account_address: hyperliquidAccount,
        api_wallet_private_key: apiWalletPrivateKey,
        agent_name: "ghola-agent-1",
      },
      signBytes: localEd25519Signer(userSecret),
      runtimeStatus,
      now: new Date("2026-05-27T12:00:00.000Z"),
    });

    const requestBody = JSON.stringify({
      encrypted_execution_vault: built.encrypted_execution_vault,
    });
    expect(requestBody).not.toContain(apiWalletPrivateKey);
    expect(requestBody).not.toContain(hyperliquidAccount);
    expect(built.encrypted_execution_vault.recipient).toBe(recipientId);
    expect(built.encrypted_execution_vault.aad).toBe(
      hyperliquidVaultAssociatedData({
        accountCommitment,
        recipientId,
        network: "mainnet",
      }),
    );

    const opened = await open(
      base64ToBytes(built.encrypted_execution_vault.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
      network: string;
      hyperliquid_account_address: string;
      api_wallet_private_key: string;
      agent_name: string | null;
      blocked_operations: string[];
    };
    expect(new TextDecoder().decode(opened.associatedData)).toBe(built.associated_data);
    expect(plaintext.network).toBe("mainnet");
    expect(plaintext.hyperliquid_account_address).toBe(hyperliquidAccount);
    expect(plaintext.api_wallet_private_key).toBe(apiWalletPrivateKey);
    expect(plaintext.agent_name).toBe("ghola-agent-1");
    expect(plaintext.blocked_operations).toEqual([
      "withdraw",
      "vault_transfer",
      "leverage_escalation",
    ]);
  });

  it("rejects malformed local credential drafts before sealing", () => {
    expect(validateHyperliquidExecutionCredentialDraft({
      network: "mainnet",
      hyperliquid_account_address: "not-an-address",
      api_wallet_private_key: "twelve word seed phrase should not pass",
    })).toEqual(expect.arrayContaining([
      "Enter a 0x Hyperliquid account address.",
      "Enter a 0x API wallet private key.",
    ]));
  });

  it("parses common paste/import shapes into a local credential draft", () => {
    const jsonImport = parseHyperliquidCredentialImport(JSON.stringify({
      network: "testnet",
      accountAddress: "0x2222222222222222222222222222222222222222",
      agentPrivateKey: `0x${"cd".repeat(32)}`,
      agentName: "ghola-api",
    }));

    expect(jsonImport.fields).toEqual(expect.arrayContaining([
      "network",
      "hyperliquid_account_address",
      "api_wallet_private_key",
      "agent_name",
    ]));
    expect(jsonImport.draft.network).toBe("testnet");
    expect(jsonImport.draft.hyperliquid_account_address).toBe("0x2222222222222222222222222222222222222222");
    expect(jsonImport.draft.api_wallet_private_key).toBe(`0x${"cd".repeat(32)}`);
    expect(jsonImport.draft.agent_name).toBe("ghola-api");

    const envImport = parseHyperliquidCredentialImport([
      "HYPERLIQUID_ACCOUNT_ADDRESS=0x3333333333333333333333333333333333333333",
      `API_WALLET_PRIVATE_KEY=0x${"ef".repeat(32)}`,
    ].join("\n"));

    expect(envImport.draft.hyperliquid_account_address).toBe("0x3333333333333333333333333333333333333333");
    expect(envImport.draft.api_wallet_private_key).toBe(`0x${"ef".repeat(32)}`);

    const rawKeyImport = parseHyperliquidCredentialImport(`0x${"12".repeat(32)}`);
    expect(rawKeyImport.fields).toEqual(["api_wallet_private_key"]);
    expect(rawKeyImport.draft.api_wallet_private_key).toBe(`0x${"12".repeat(32)}`);
  });
});
