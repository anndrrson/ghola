import { describe, expect, it } from "vitest";
import {
  buildLighterExecutionVaultBundle,
  lighterVaultAssociatedData,
  validateLighterExecutionCredentialDraft,
} from "./lighter-vault-seal";

describe("Lighter vault sealing", () => {
  it("rejects malformed authority material", () => {
    expect(validateLighterExecutionCredentialDraft({ account_index: "-1", api_key_index: "x", api_private_key: "bad" })).toHaveLength(3);
  });

  it("seals an owner-only policy to the attested recipient", async () => {
    const result = await buildLighterExecutionVaultBundle({
      accountCommitment: "private_account_lighter_test",
      sealingWalletAddress: "11111111111111111111111111111111",
      credential: { account_index: "123", api_key_index: "4", api_private_key: "11".repeat(32) },
      signBytes: async () => new Uint8Array(64).fill(7),
      runtimeStatus: {
        version: 1,
        checked_at: "2026-08-24T00:00:00.000Z",
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
            recipient_id: "phala:cvm:lighter-test",
            x25519_pub_hex: "22".repeat(32),
          },
        }],
        blocking_reasons: [],
        disclosure: "test",
      },
      now: new Date("2026-08-24T00:00:00.000Z"),
    });
    expect(result.associated_data).toBe(lighterVaultAssociatedData({
      accountCommitment: "private_account_lighter_test",
      recipientId: "phala:cvm:lighter-test",
    }));
    expect(result.encrypted_execution_vault.ciphertext).not.toContain("11".repeat(32));
  });
});
