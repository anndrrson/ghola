import type {
  GholaHyperliquidConnectionProof,
  GholaHyperliquidExecutionVault,
} from "./private-account";
import {
  getHyperliquidExecutionVaultByAccount,
  getHyperliquidManagedAllocationByAccount,
  getPrivateAccountByOwner,
  type PrivateHyperliquidManagedAllocationRecordV1,
  type PrivateHyperliquidVaultRecordV1,
} from "./private-account-store";

const CONNECTION_PROOF_MAX_AGE_MS = 15 * 60_000;

export async function verifiedHyperliquidVenueAccessForBoundedRun(
  owner: { owner_commitment: string },
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const account = await getPrivateAccountByOwner(owner.owner_commitment);
  if (!account ||
      account.owner_commitment !== owner.owner_commitment ||
      account.account.account_commitment !== account.account_commitment) return {};

  const [allocation, vault] = await Promise.all([
    getHyperliquidManagedAllocationByAccount(account.account_commitment),
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
  ]);
  const managedAccess = verifiedManagedAllocation(
    allocation,
    owner.owner_commitment,
    account.account_commitment,
    now,
  );
  if (allocation?.status === "allocated") {
    return managedAccess ? { hyperliquid: managedAccess } : {};
  }

  const vaultAccess = verifiedExecutionVault(
    vault,
    owner.owner_commitment,
    account.account_commitment,
    now,
  );
  return vaultAccess ? { hyperliquid: vaultAccess } : {};
}

function verifiedManagedAllocation(
  record: PrivateHyperliquidManagedAllocationRecordV1 | null,
  ownerCommitment: string,
  accountCommitment: string,
  now: Date,
): Record<string, unknown> | null {
  if (!record ||
      record.owner_commitment !== ownerCommitment ||
      record.account_commitment !== accountCommitment ||
      record.status !== "allocated") return null;

  const allocation = record.allocation;
  if (allocation.version !== 1 ||
      allocation.venue_id !== "hyperliquid" ||
      allocation.platform_class !== "hyperliquid_style_market" ||
      allocation.account_commitment !== accountCommitment ||
      allocation.allocation_commitment !== record.allocation_commitment ||
      allocation.policy_commitment !== record.policy_commitment ||
      allocation.pool_commitment !== record.pool_commitment ||
      allocation.subledger_account_commitment !== record.subledger_account_commitment ||
      allocation.status !== "allocated" ||
      !freshConnectionProof(allocation.connection_proof, allocation.network, now)) return null;

  return {
    status: "ready",
    execution_mode: allocation.execution_mode,
    network: allocation.network,
    account_commitment: accountCommitment,
    allocation_commitment: allocation.allocation_commitment,
    managed_allocation_commitment: allocation.allocation_commitment,
    policy_commitment: allocation.policy_commitment,
    reason: "verified_hyperliquid_allocation_ready",
  };
}

function verifiedExecutionVault(
  record: PrivateHyperliquidVaultRecordV1 | null,
  ownerCommitment: string,
  accountCommitment: string,
  now: Date,
): Record<string, unknown> | null {
  if (!record ||
      record.owner_commitment !== ownerCommitment ||
      record.account_commitment !== accountCommitment ||
      record.status !== "sealed") return null;

  const vault = record.vault;
  const binding = vault.signer_binding;
  const encrypted = vault.encrypted_execution_vault;
  if (vault.version !== 1 ||
      vault.platform_class !== "hyperliquid_style_market" ||
      vault.account_commitment !== accountCommitment ||
      vault.vault_commitment !== record.vault_commitment ||
      vault.encrypted_vault_commitment !== record.encrypted_vault_commitment ||
      vault.recipient_commitment !== record.recipient_commitment ||
      vault.policy_commitment !== record.policy_commitment ||
      vault.status !== "sealed" ||
      !validSignerBinding(binding, now) ||
      !freshConnectionProof(vault.connection_proof, binding.network, now) ||
      encrypted.version !== 1 ||
      encrypted.alg !== "sealed-provider-v1" ||
      !nonEmpty(encrypted.ciphertext) ||
      !nonEmpty(encrypted.recipient) ||
      !nonEmpty(encrypted.aad) ||
      !nonEmpty(encrypted.ciphertext_commitment) ||
      !nonEmpty(encrypted.aad_commitment) ||
      encrypted.recipient_commitment !== vault.recipient_commitment) return null;

  return {
    status: "ready",
    execution_mode: "byo_api_key",
    network: binding.network,
    account_commitment: accountCommitment,
    vault_commitment: vault.vault_commitment,
    encrypted_vault_commitment: vault.encrypted_vault_commitment,
    policy_commitment: vault.policy_commitment,
    encrypted_execution_vault: encrypted,
    reason: "verified_hyperliquid_vault_ready",
  };
}

function freshConnectionProof(
  proof: GholaHyperliquidConnectionProof | null | undefined,
  network: "testnet" | "mainnet",
  now: Date,
): proof is GholaHyperliquidConnectionProof {
  if (!proof ||
      proof.version !== 1 ||
      proof.status !== "verified_no_funds" ||
      proof.network !== network ||
      proof.credential_opened !== true ||
      proof.signer_binding_verified !== true ||
      proof.account_read_verified !== true ||
      proof.order_request_built !== true ||
      !nonEmpty(proof.verification_commitment) ||
      !nonEmpty(proof.work_order_commitment)) return false;

  const nowMs = now.getTime();
  const verifiedAtMs = Date.parse(proof.verified_at);
  const expiresAtMs = Date.parse(proof.expires_at);
  return Number.isFinite(nowMs) &&
    Number.isFinite(verifiedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    verifiedAtMs <= nowMs &&
    nowMs - verifiedAtMs <= CONNECTION_PROOF_MAX_AGE_MS &&
    expiresAtMs > nowMs &&
    expiresAtMs > verifiedAtMs;
}

function validSignerBinding(
  binding: GholaHyperliquidExecutionVault["signer_binding"],
  now: Date,
): binding is NonNullable<GholaHyperliquidExecutionVault["signer_binding"]> {
  if (!binding ||
      binding.version !== 1 ||
      !/^0x[0-9a-fA-F]{40}$/.test(binding.owner_address) ||
      !/^0x[0-9a-fA-F]{40}$/.test(binding.agent_address) ||
      !nonEmpty(binding.binding_commitment)) return false;
  const verifiedAtMs = Date.parse(binding.verified_at);
  return Number.isFinite(verifiedAtMs) && verifiedAtMs <= now.getTime();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
