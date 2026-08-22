import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { localEd25519Signer, open } from "./envelope";
import {
  buildHyperliquidExecutionVaultBundle,
  buildTurnkeyHyperliquidExecutionVaultBundle,
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
  it("seals only Turnkey references and a signed mandate for delegated execution", async () => {
    const userSecret = ed25519.utils.randomPrivateKey();
    const sealingWalletAddress = bs58.encode(ed25519.getPublicKey(userSecret));
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const now = Date.now();
    const owner = "0x1111111111111111111111111111111111111111";
    const agent = "0x2222222222222222222222222222222222222222";
    const runtimeStatus: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: new Date(now).toISOString(),
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
        label: "Local worker",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        sealed_recipient: {
          recipient_id: "local:test",
          x25519_pub_hex: bytesToHex(recipientPub),
          tee_kind: "phala",
          measurement_hex: "00".repeat(32),
        },
      }],
      blocking_reasons: [],
      disclosure: "test",
    };
    const built = await buildTurnkeyHyperliquidExecutionVaultBundle({
      accountCommitment: "private_account_commitment_test",
      sealingWalletAddress,
      signBytes: localEd25519Signer(userSecret),
      runtimeStatus,
      now: new Date(now),
      credential: {
        signing_mode: "turnkey_delegated",
        turnkey_organization_id: "org-test",
        turnkey_agent_key_ref: "worker-test",
        owner_wallet_address: owner,
        agent_wallet_address: agent,
        hyperliquid_account_address: owner,
        owner_mandate_signature: `0x${"ab".repeat(65)}`,
        agent_name: "ghola-perps",
        perps_mandate: {
          version: 1,
          mandate_id: "mandate:test:turnkey",
          network: "testnet",
          owner_address: owner,
          agent_address: agent,
          execution_address: owner,
          allowed_markets: ["BTC", "ETH", "SOL"],
          margin_mode: "isolated",
          configured_leverage: 2,
          max_leverage: 2,
          max_order_notional_micro_usdc: 25_000_000,
          max_gross_exposure_micro_usdc: 50_000_000,
          max_daily_notional_micro_usdc: 100_000_000,
          daily_loss_limit_micro_usdc: 10_000_000,
          max_drawdown_micro_usdc: 15_000_000,
          max_drawdown_bps: 1_500,
          max_slippage_bps: 50,
          stop_loss_bps: 500,
          max_open_orders: 4,
          max_orders_per_day: 20,
          data_max_age_ms: 30_000,
          expires_at_ms: now + 86_400_000,
          kill_switch: false,
          jurisdiction: {
            eligible: true,
            accepted_risk: true,
            attested_at_ms: now,
            terms_version: "test-2026-08",
          },
        },
      },
    });
    const opened = await open(base64ToBytes(built.encrypted_execution_vault.ciphertext), recipientSecret);
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext)) as Record<string, unknown>;
    expect(plaintext.signing_mode).toBe("turnkey_delegated");
    expect(plaintext.owner_wallet_address).toBe(owner);
    expect(plaintext.agent_wallet_address).toBe(agent);
    expect(JSON.stringify(plaintext)).not.toContain("private_key");
    expect(JSON.stringify(plaintext)).not.toContain("seed");
  });

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
      bounded_beta_enabled: true,
      operator_spend_lock: false,
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
