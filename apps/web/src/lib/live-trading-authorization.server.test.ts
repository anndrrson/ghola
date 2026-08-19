import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeLiveTradingMutation } from "./live-trading-authorization.server";
import {
  createHyperliquidExecutionVault,
  createPrivateExecutionAccount,
  gholaCommitment,
} from "./private-account";
import {
  putHyperliquidExecutionVault,
  putPrivateAccountRecord,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";
import { resetLiveTradingStoreForTests } from "./live-trading-store";
import { buildTradeOrderPlan } from "./trade-order-plan";

const OWNER = "owner_reduce_only_test";

describe("central live-trading authorization", () => {
  beforeEach(async () => {
    await resetPrivateAccountStoreForTests();
    resetLiveTradingStoreForTests();
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    resetLiveTradingStoreForTests();
  });

  it("keeps signed reduce-only exits available without launch, billing, eligibility, or opening caps", async () => {
    const { accountCommitment, vaultCommitment } = await accountWithVault();
    const result = await authorizeLiveTradingMutation({
      owner_commitment: OWNER,
      web_session_token: "",
      order_plan: plan(true),
      idempotency_key: "reduce_only_exit_test",
      plan_digest: `sha256:${"c".repeat(64)}`,
      env: {},
    });
    expect(result).toMatchObject({
      ok: true,
      capability: "reduce_only",
      account_commitment: accountCommitment,
      vault_commitment: vaultCommitment,
      reservation: null,
    });
  });

  it.each([
    ["cross-account AAD", "account_other", "mainnet"],
    ["testnet AAD", null, "testnet"],
  ] as const)("fails a reduce-only exit closed for %s", async (_label, aadAccount, network) => {
    const { accountCommitment } = await accountWithVault({ aadAccount, network });
    const result = await authorizeLiveTradingMutation({
      owner_commitment: OWNER,
      web_session_token: "",
      order_plan: plan(true),
      idempotency_key: "reduce_only_scope_rejection_test",
      plan_digest: `sha256:${"d".repeat(64)}`,
      env: {},
    });
    expect(accountCommitment).not.toBe(aadAccount);
    expect(result).toEqual({
      ok: false,
      error: "hyperliquid_mainnet_vault_required",
      status: 409,
      reason_codes: ["hyperliquid_mainnet_vault_required"],
    });
  });
});

async function accountWithVault(options: {
  aadAccount?: string | null;
  network?: "mainnet" | "testnet";
} = {}) {
  const account = createPrivateExecutionAccount({
    sessionId: OWNER,
    turnkeyWalletId: "turnkey_reduce_only_test",
    vaultSeed: "vault_reduce_only_test",
    policySeed: "policy_reduce_only_test",
    platformSeed: "platform_reduce_only_test",
    vaultReady: true,
  });
  const now = new Date().toISOString();
  await putPrivateAccountRecord({
    version: 1,
    owner_commitment: OWNER,
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
    vault_ready: true,
    account,
    created_at: now,
    updated_at: now,
  });
  const recipient = "phala:cvm:reduce-only-test";
  const created = createHyperliquidExecutionVault({
    account_commitment: account.account_commitment,
    encrypted_execution_vault: {
      ciphertext: "sealed-reduce-only-vault",
      recipient,
      aad: `ghola/hyperliquid-execution-vault-v1|account:${options.aadAccount ?? account.account_commitment}|recipient:${recipient}|network:${options.network ?? "mainnet"}`,
    },
  });
  if (!created.ok) throw new Error(created.error);
  await putHyperliquidExecutionVault({
    version: 1,
    owner_commitment: OWNER,
    account_commitment: account.account_commitment,
    vault_commitment: created.vault.vault_commitment,
    encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
    recipient_commitment: created.vault.recipient_commitment,
    policy_commitment: created.vault.policy_commitment,
    status: "sealed",
    vault: created.vault,
    created_at: created.vault.created_at,
    updated_at: created.vault.updated_at,
  });
  return { accountCommitment: account.account_commitment, vaultCommitment: created.vault.vault_commitment };
}

function plan(reduceOnly: boolean) {
  const nowMs = Date.now();
  const value = buildTradeOrderPlan({
    venueId: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "sell",
    timeInForce: "ioc",
    quoteNotionalUsd: 25,
    baseSize: 0.0004,
    limitPrice: 62_500,
    maxSlippageBps: 50,
    stopLevel: 63_000,
    strategyProfile: "manual_exit",
    entryTrigger: "preview_now",
    exitRule: "manual_approval",
    timeHorizon: "intraday",
    triggerLevel: null,
    interval: "5m",
    marketFetchedAt: new Date(nowMs).toISOString(),
    executionReferencePrice: 62_510,
    frameVersion: 1,
    riskEnvelope: {
      riskBudgetUsd: 1,
      stopAndSlippageLossUsd: 0.325,
      roundTripCostLossUsd: 0.05,
      allInLossUsd: 0.375,
      feeBps: 5,
      bufferBps: 5,
      feeEvidenceAtMs: nowMs,
      bufferEvidenceAtMs: nowMs,
    },
    reduceOnly,
    nowMs,
  });
  if (!value) throw new Error("reduce_only_plan_invalid");
  return value;
}
