import { describe, expect, it } from "vitest";
import {
  getHyperliquidExecutionVaultByAccount,
  getPrivateAccountByOwner,
  putHyperliquidExecutionVault,
  putPrivateAccountRecord,
} from "./private-account-store";
import {
  createHyperliquidExecutionVault,
  createPrivateExecutionAccount,
  gholaCommitment,
} from "./private-account";
import { hyperliquidVaultStatusForOwner } from "@/app/v1/private-account/_lib";

const phase = process.env.GHOLA_PRIVATE_ACCOUNT_POSTGRES_E2E_PHASE;
const enabled = phase === "write" || phase === "read";
const ownerCommitment = "owner_postgres_persistence_e2e_20260806";
const opaqueCiphertext = "opaque-mainnet-vault-ciphertext-e2e";
const forbiddenPlaintext = "0xprivate-key-must-never-be-stored-or-returned";
const now = "2026-08-06T20:00:00.000Z";

function fixture() {
  const account = createPrivateExecutionAccount({
    sessionId: ownerCommitment,
    turnkeyWalletId: `turnkey:${ownerCommitment}`,
    vaultSeed: `vault:${ownerCommitment}`,
    policySeed: "private-mode-default",
    platformSeed: `platforms:${ownerCommitment}`,
    vaultReady: false,
  });
  return {
    account,
    owner: {
      user: { id: "postgres-persistence-user", email: "postgres-persistence@example.com" },
      owner_commitment: ownerCommitment,
    },
  };
}

describe.runIf(enabled)("private-account PostgreSQL deployment persistence", () => {
  it("writes in one process and detects the sealed mainnet credential in another", async () => {
    expect(process.env.GHOLA_PRIVATE_ACCOUNT_STORE).toBe("postgres");
    expect(process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL).toMatch(/^postgres(?:ql)?:\/\//);
    const { account, owner } = fixture();

    if (phase === "write") {
      await putPrivateAccountRecord({
        version: 1,
        owner_commitment: ownerCommitment,
        account_commitment: account.account_commitment,
        session_commitment: account.session_commitment,
        turnkey_wallet_commitment: account.turnkey_wallet_commitment,
        vault_root_commitment: account.vault_root_commitment,
        note_root_commitment: gholaCommitment("note_root", account.vault_root_commitment),
        nullifier_root_commitment: gholaCommitment("nullifier_root", account.vault_root_commitment),
        platform_link_root: account.platform_link_root,
        policy_commitment: account.policy_commitment,
        privacy_mode: "private_mode",
        claim_boundary: "engine_gated_full_anonymity",
        vault_ready: false,
        account,
        created_at: now,
        updated_at: now,
      });
      const created = createHyperliquidExecutionVault({
        account_commitment: account.account_commitment,
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: opaqueCiphertext,
          recipient: "phala:cvm:production-worker",
          aad: [
            "ghola/hyperliquid-execution-vault-v1",
            `account:${account.account_commitment}`,
            "recipient:phala:cvm:production-worker",
            "network:mainnet",
          ].join("|"),
        },
        now: new Date(now),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      await putHyperliquidExecutionVault({
        version: 1,
        owner_commitment: ownerCommitment,
        account_commitment: account.account_commitment,
        vault_commitment: created.vault.vault_commitment,
        encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
        recipient_commitment: created.vault.recipient_commitment,
        policy_commitment: created.vault.policy_commitment,
        status: "sealed",
        vault: {
          ...created.vault,
          connection_proof: {
            version: 1,
            status: "verified_no_funds",
            verification_commitment: "verification_postgres_restart_e2e",
            work_order_commitment: "work_order_postgres_restart_e2e",
            network: "mainnet",
            credential_opened: true,
            signer_binding_verified: true,
            account_read_verified: true,
            order_request_built: true,
            verified_at: now,
            expires_at: "2099-08-06T20:15:00.000Z",
          },
          updated_at: now,
        },
        created_at: now,
        updated_at: now,
      });
    }

    const reloadedAccount = await getPrivateAccountByOwner(ownerCommitment);
    const reloadedVault = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
    const publicStatus = await hyperliquidVaultStatusForOwner(owner);

    expect(reloadedAccount?.account_commitment).toBe(account.account_commitment);
    expect(reloadedVault?.vault.encrypted_execution_vault.ciphertext).toBe(opaqueCiphertext);
    expect(reloadedVault?.vault.connection_proof).toMatchObject({
      status: "verified_no_funds",
      network: "mainnet",
      credential_opened: true,
      signer_binding_verified: true,
      account_read_verified: true,
      order_request_built: true,
    });
    expect(publicStatus).toMatchObject({
      account_commitment: account.account_commitment,
      ready: true,
      credentials_sealed: true,
      connection_proof: {
        status: "verified_no_funds",
        network: "mainnet",
      },
    });
    expect(JSON.stringify(publicStatus)).not.toContain("ciphertext");
    expect(JSON.stringify(reloadedVault)).not.toContain(forbiddenPlaintext);
    expect(JSON.stringify(publicStatus)).not.toContain(forbiddenPlaintext);
  });
});
