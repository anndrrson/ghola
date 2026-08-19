import { describe, expect, it } from "vitest";
import {
  isMainnetHyperliquidVaultAadForAccount,
  isCurrentHyperliquidVaultAuthorization,
  isSealedHyperliquidVaultRecordForAccount,
  type HyperliquidVaultScopeRecord,
} from "./hyperliquid-vault-scope";
import type { LiveTradingReleaseIdentity } from "./live-trading-contract";

const account = "account_commitment_12345";
const owner = "owner_commitment_12345";
const release: LiveTradingReleaseIdentity = {
  contract_version: 2,
  web_git_sha: "a".repeat(40),
  worker_git_sha: "a".repeat(40),
  worker_image_digest: `sha256:${"b".repeat(64)}`,
  config_fingerprint: "live_trading_config_scope_test",
  valid: true,
  reason_codes: [],
};

function record(overrides: Partial<HyperliquidVaultScopeRecord> = {}): HyperliquidVaultScopeRecord {
  return {
    owner_commitment: owner,
    account_commitment: account,
    status: "sealed",
    vault: {
      encrypted_execution_vault: {
        aad: `ghola/hyperliquid-execution-vault-v1|account:${account}|recipient:mock_attested:dev|network:mainnet`,
      },
    },
    ...overrides,
  };
}

describe("Hyperliquid vault scope", () => {
  it("requires the exact owner, record account, and sealed status", () => {
    expect(isSealedHyperliquidVaultRecordForAccount(record(), owner, account)).toBe(true);
    expect(isSealedHyperliquidVaultRecordForAccount(record({ owner_commitment: "other_owner" }), owner, account)).toBe(false);
    expect(isSealedHyperliquidVaultRecordForAccount(record({ account_commitment: "other_account" }), owner, account)).toBe(false);
    expect(isSealedHyperliquidVaultRecordForAccount(record({ status: "revoked" }), owner, account)).toBe(false);
  });

  it("requires parseable mainnet AAD bound to the exact account", () => {
    const aad = record().vault.encrypted_execution_vault.aad;
    expect(isMainnetHyperliquidVaultAadForAccount(aad, account)).toBe(true);
    expect(isMainnetHyperliquidVaultAadForAccount(aad, "other_account")).toBe(false);
    expect(isMainnetHyperliquidVaultAadForAccount(aad.replace("mainnet", "testnet"), account)).toBe(false);
    expect(isMainnetHyperliquidVaultAadForAccount("malformed", account)).toBe(false);
  });

  it("keeps legacy vaults compatible but requires current identity-bound automatic authorization", () => {
    const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    const venueAccountCommitment = `hyperliquid_venue_account_${"a".repeat(48)}`;
    const agentWalletCommitment = `hyperliquid_agent_wallet_${"b".repeat(48)}`;
    expect(isCurrentHyperliquidVaultAuthorization(record(), nowMs)).toBe(true);
    const automatic = record({
      vault: {
        encrypted_execution_vault: {
          aad: `ghola/hyperliquid-execution-vault-v2|account:${account}|recipient:mock_attested:dev|network:mainnet|venue-account:${venueAccountCommitment}|agent-wallet:${agentWalletCommitment}`,
        },
        authorization: {
          source: "phantom_approve_agent_v1",
          network: "mainnet",
          agent_name: "ghola-mainnet",
          venue_account_commitment: venueAccountCommitment,
          agent_wallet_commitment: agentWalletCommitment,
          valid_until: new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString(),
          worker_verification_commitment: `hyperliquid_agent_onboarding_verification_${"c".repeat(48)}`,
          worker_verified_at: new Date(nowMs).toISOString(),
          worker_contract_version: release.contract_version,
          worker_git_sha: release.worker_git_sha!,
          worker_image_digest: release.worker_image_digest!,
          worker_config_fingerprint: release.config_fingerprint,
        },
      },
    });
    expect(isCurrentHyperliquidVaultAuthorization(automatic, nowMs, undefined, release)).toBe(true);
    expect(isCurrentHyperliquidVaultAuthorization({
      ...automatic,
      vault: {
        ...automatic.vault,
        authorization: {
          ...automatic.vault.authorization!,
          valid_until: new Date(nowMs + 5 * 60 * 1_000).toISOString(),
        },
      },
    }, nowMs, undefined, release)).toBe(false);
    expect(isCurrentHyperliquidVaultAuthorization({
      ...automatic,
      vault: {
        ...automatic.vault,
        authorization: {
          ...automatic.vault.authorization!,
          agent_wallet_commitment: `hyperliquid_agent_wallet_${"c".repeat(48)}`,
        },
      },
    }, nowMs, undefined, release)).toBe(false);
    expect(isCurrentHyperliquidVaultAuthorization({
      ...automatic,
      vault: {
        ...automatic.vault,
        authorization: {
          ...automatic.vault.authorization!,
          worker_git_sha: "d".repeat(40),
        },
      },
    }, nowMs, undefined, release)).toBe(false);
  });
});
