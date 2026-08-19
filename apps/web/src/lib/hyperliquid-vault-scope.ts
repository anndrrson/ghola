import { parseHyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import { HYPERLIQUID_AGENT_MIN_REMAINING_MS } from "./hyperliquid-agent-wallet";
import type { LiveTradingReleaseIdentity } from "./live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";

export type HyperliquidVaultScopeRecord = {
  owner_commitment: string;
  account_commitment: string;
  status: string;
  vault: {
    encrypted_execution_vault: {
      aad: string;
    };
    authorization?: {
      source: string;
      network: string;
      agent_name: string;
      venue_account_commitment: string;
      agent_wallet_commitment: string;
      valid_until: string;
      worker_verification_commitment: string;
      worker_verified_at: string;
      worker_contract_version: number;
      worker_git_sha: string;
      worker_image_digest: string;
      worker_config_fingerprint: string;
    } | null;
  };
};

export function isSealedHyperliquidVaultRecordForAccount(
  value: HyperliquidVaultScopeRecord | null | undefined,
  ownerCommitment: string,
  accountCommitment: string,
): value is HyperliquidVaultScopeRecord {
  return Boolean(value) && value?.owner_commitment === ownerCommitment &&
    value.account_commitment === accountCommitment && value.status === "sealed";
}

export function isMainnetHyperliquidVaultAadForAccount(
  aad: string,
  accountCommitment: string,
): boolean {
  const scope = parseHyperliquidVaultAssociatedData(aad);
  return scope?.network === "mainnet" && scope.account_commitment === accountCommitment;
}

export function isCurrentHyperliquidVaultAuthorization(
  value: HyperliquidVaultScopeRecord,
  nowMs = Date.now(),
  minRemainingMs = HYPERLIQUID_AGENT_MIN_REMAINING_MS,
  release: LiveTradingReleaseIdentity = currentLiveTradingReleaseIdentity(),
): boolean {
  const authorization = value.vault.authorization;
  if (authorization == null) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(minRemainingMs) || minRemainingMs < 0 ||
      authorization.source !== "phantom_approve_agent_v1" || authorization.network !== "mainnet" ||
      authorization.agent_name !== "ghola-mainnet") return false;
  const validUntilMs = Date.parse(authorization.valid_until);
  if (!Number.isFinite(validUntilMs) || validUntilMs <= nowMs + minRemainingMs) return false;
  const workerVerifiedAtMs = Date.parse(authorization.worker_verified_at);
  if (!release.valid || !Number.isFinite(workerVerifiedAtMs) || workerVerifiedAtMs > nowMs + 30_000 ||
      workerVerifiedAtMs >= validUntilMs ||
      !/^hyperliquid_agent_onboarding_verification_[0-9a-f]{48}$/u.test(
        authorization.worker_verification_commitment,
      ) ||
      authorization.worker_contract_version !== release.contract_version ||
      authorization.worker_git_sha !== release.worker_git_sha ||
      authorization.worker_image_digest !== release.worker_image_digest ||
      authorization.worker_config_fingerprint !== release.config_fingerprint) return false;
  const scope = parseHyperliquidVaultAssociatedData(value.vault.encrypted_execution_vault.aad);
  return scope?.version === 2 &&
    scope.venue_account_commitment === authorization.venue_account_commitment &&
    scope.agent_wallet_commitment === authorization.agent_wallet_commitment;
}
