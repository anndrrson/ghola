import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { localEd25519Signer, open } from "./envelope";
import {
  asterVaultAssociatedData,
  buildAsterExecutionVaultBundle,
  validateAsterExecutionCredentialDraft,
} from "./aster-vault-seal";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

function runtime(x25519Pub: Uint8Array): PrivateAgentRuntimeStatus {
  return {
    version: 1,
    checked_at: "2026-08-24T12:00:00.000Z",
    sealed_execution_required: true,
    entitlement_required: "paid_private_agent_plan",
    bounded_beta_enabled: true,
    operator_spend_lock: false,
    preferred_provider: "phala",
    selected_provider: "phala",
    remote_execution_ready: true,
    shielded_rail_ready: true,
    providers: [{
      id: "phala",
      label: "Phala",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      reason: null,
      sealed_recipient: {
        recipient_id: "phala:cvm:aster-test",
        x25519_pub_hex: Array.from(x25519Pub).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        tee_kind: "phala",
        measurement_hex: "00".repeat(32),
      },
    }],
    blocking_reasons: [],
    disclosure: "test",
  };
}

function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

describe("Aster vault sealing", () => {
  it("derives the signer and exposes only ciphertext outside the TEE", async () => {
    const userSecret = ed25519.utils.randomPrivateKey();
    const sealingAddress = bs58.encode(ed25519.getPublicKey(userSecret));
    const recipientSecret = x25519.utils.randomPrivateKey();
    const privateKey = `0x${"31".repeat(32)}` as const;
    const account = "0x2222222222222222222222222222222222222222";
    const built = await buildAsterExecutionVaultBundle({
      accountCommitment: "private_account_aster_test",
      sealingWalletAddress: sealingAddress,
      credential: { user_address: account, api_wallet_private_key: privateKey },
      signBytes: localEd25519Signer(userSecret),
      runtimeStatus: runtime(x25519.getPublicKey(recipientSecret)),
      now: new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(JSON.stringify(built.encrypted_execution_vault)).not.toContain(privateKey);
    expect(JSON.stringify(built.encrypted_execution_vault)).not.toContain(account);
    expect(built.signer_address).toBe(privateKeyToAccount(privateKey).address.toLowerCase());
    expect(built.associated_data).toBe(asterVaultAssociatedData({
      accountCommitment: "private_account_aster_test",
      recipientId: "phala:cvm:aster-test",
    }));

    const opened = await open(base64Bytes(built.encrypted_execution_vault.ciphertext), recipientSecret);
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext)) as Record<string, unknown>;
    expect(plaintext.kind).toBe("ghola_aster_execution_vault");
    expect(plaintext.user_address).toBe(account);
    expect(plaintext.signer_address).toBe(built.signer_address);
    expect(plaintext.api_wallet_private_key).toBe(privateKey);
    expect(plaintext.blocked_operations).toEqual(["withdraw", "vault_transfer", "leverage_escalation"]);
  });

  it("rejects a signer that does not match the trade-only key", () => {
    expect(validateAsterExecutionCredentialDraft({
      user_address: "0x2222222222222222222222222222222222222222",
      signer_address: "0x3333333333333333333333333333333333333333",
      api_wallet_private_key: `0x${"31".repeat(32)}`,
    })).toContain("The Aster API wallet address does not match its private key.");
  });
});
