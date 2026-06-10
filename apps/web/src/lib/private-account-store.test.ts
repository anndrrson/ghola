import { afterEach, describe, expect, it } from "vitest";
import {
  consumePrivateAccountApproval,
  consumePrivateAccountPreview,
  getPrivateAccountByOwner,
  getPrivateAccountApproval,
  getPrivateAccountIntent,
  getPrivateAccountPreview,
  getPrivateVaultState,
  getLatestAnonymityEvidence,
  getPrivacyBudget,
  getQueuedAction,
  putPrivateAccountApproval,
  putPrivateAccountRecord,
  putPrivateAccountIntent,
  putPrivateAccountPreview,
  putPrivateVaultState,
  putAnonymityEvidence,
  putPrivacyBudget,
  putQueuedAction,
  recordPrivacyBudgetEvent,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";
import {
  approvePrivateAccountAction,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  gholaCommitment,
  previewPrivateAccountAction,
} from "./private-account";

describe("private account store", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
  });

  it("persists intent, preview, and approval records in memory during tests", async () => {
    const action = createPrivateAccountAction({ action_class: "transfer" });
    const intent = await putPrivateAccountIntent({
      version: 1,
      owner_commitment: "owner_1",
      intent_id: "intent_1",
      account_commitment: "acct_1",
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      product_bucket: action.product_bucket,
      policy_commitment: action.policy_commitment,
      intent_commitment: action.intent_commitment,
      status: "created",
      created_at: "2026-05-27T00:00:00.000Z",
      expires_at: "2026-05-27T00:30:00.000Z",
    });
    const preview = previewPrivateAccountAction({
      account: { account_commitment: intent.account_commitment, vault_ready: true },
      action,
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      now: new Date("2026-05-27T00:01:00.000Z"),
    });
    await putPrivateAccountPreview({
      version: 1,
      owner_commitment: "owner_1",
      preview_commitment: preview.preview_commitment,
      intent_id: intent.intent_id,
      account_commitment: preview.account_commitment,
      action_commitment: preview.action_commitment,
      platform_class: preview.platform_class,
      selected_rail: preview.selected_rail,
      claim_status: preview.claim_status,
      anonymity_level: preview.anonymity_level,
      preview,
      created_at: "2026-05-27T00:01:00.000Z",
      expires_at: preview.expires_at,
      consumed_at: null,
    });
    const approval = approvePrivateAccountAction({
      preview_commitment: preview.preview_commitment,
      now: new Date("2026-05-27T00:02:00.000Z"),
    });
    await putPrivateAccountApproval({
      version: 1,
      owner_commitment: "owner_1",
      approval_commitment: approval.approval_commitment,
      preview_commitment: approval.preview_commitment,
      intent_id: intent.intent_id,
      execution_plan_commitment: null,
      degraded_accepted: false,
      approved_at: approval.approved_at,
      expires_at: preview.expires_at,
      consumed_at: null,
    });

    expect(await getPrivateAccountIntent("intent_1")).toMatchObject({ status: "created" });
    expect(await getPrivateAccountPreview(preview.preview_commitment)).toMatchObject({
      consumed_at: null,
    });
    expect(await getPrivateAccountApproval(approval.approval_commitment)).toMatchObject({
      consumed_at: null,
    });
  });

  it("marks previews and approvals consumed", async () => {
    const action = createPrivateAccountAction({ action_class: "transfer" });
    const preview = previewPrivateAccountAction({
      account: { account_commitment: "acct_1", vault_ready: true },
      action,
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
    });
    await putPrivateAccountPreview({
      version: 1,
      owner_commitment: "owner_1",
      preview_commitment: preview.preview_commitment,
      intent_id: "intent_1",
      account_commitment: preview.account_commitment,
      action_commitment: preview.action_commitment,
      platform_class: preview.platform_class,
      selected_rail: preview.selected_rail,
      claim_status: preview.claim_status,
      anonymity_level: preview.anonymity_level,
      preview,
      created_at: "2026-05-27T00:01:00.000Z",
      expires_at: preview.expires_at,
      consumed_at: null,
    });
    await putPrivateAccountApproval({
      version: 1,
      owner_commitment: "owner_1",
      approval_commitment: "approval_1",
      preview_commitment: preview.preview_commitment,
      intent_id: "intent_1",
      execution_plan_commitment: null,
      degraded_accepted: false,
      approved_at: "2026-05-27T00:02:00.000Z",
      expires_at: preview.expires_at,
      consumed_at: null,
    });

    await consumePrivateAccountPreview(preview.preview_commitment, "2026-05-27T00:03:00.000Z");
    await consumePrivateAccountApproval("approval_1", "2026-05-27T00:03:00.000Z");

    expect((await getPrivateAccountPreview(preview.preview_commitment))?.consumed_at).toBe(
      "2026-05-27T00:03:00.000Z",
    );
    expect((await getPrivateAccountApproval("approval_1"))?.consumed_at).toBe(
      "2026-05-27T00:03:00.000Z",
    );
  });

  it("persists private account, vault, privacy budget, and queued action records", async () => {
    const account = createPrivateExecutionAccount({
      sessionId: "owner_1",
      turnkeyWalletId: "turnkey_1",
      vaultSeed: "vault_1",
      policySeed: "private-mode-default",
      platformSeed: "platforms_1",
      vaultReady: true,
    });
    const now = "2026-05-27T00:00:00.000Z";
    await putPrivateAccountRecord({
      version: 1,
      owner_commitment: "owner_1",
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
    await putPrivateVaultState({
      version: 1,
      owner_commitment: "owner_1",
      account_commitment: account.account_commitment,
      vault_root_commitment: account.vault_root_commitment,
      note_root_commitment: gholaCommitment("note_root", account.vault_root_commitment),
      nullifier_root_commitment: gholaCommitment("nullifier_root", account.vault_root_commitment),
      balance_bucket_summary: ["stablecoin_25"],
      ready_rails: ["shielded_pool"],
      last_import_commitment: "import_1",
      created_at: now,
      updated_at: now,
    });
    await putPrivacyBudget({
      version: 1,
      owner_commitment: "owner_1",
      account_commitment: account.account_commitment,
      budget: {
        version: 1,
        degraded_action_count: 0,
        repeated_withdrawal_count: 0,
        repeated_cadence_count: 0,
        platform_concentration_bps: 0,
        solver_concentration_bps: 0,
      },
      updated_at: now,
    });
    await recordPrivacyBudgetEvent({
      owner_commitment: "owner_1",
      account_commitment: account.account_commitment,
      degraded: true,
      repeated_withdrawal: true,
    });
    await putQueuedAction({
      version: 1,
      queue_id: "queue_1",
      owner_commitment: "owner_1",
      account_commitment: account.account_commitment,
      intent_id: "intent_1",
      action_commitment: "action_1",
      latest_preview_commitment: "preview_1",
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      wait_reasons: ["minimum delay window has not elapsed"],
      target_anonymity_set: 50,
      current_anonymity_set: 25,
      status: "queued",
      created_at: now,
      expires_at: "2026-05-27T00:30:00.000Z",
      updated_at: now,
    });

    expect(await getPrivateAccountByOwner("owner_1")).toMatchObject({
      account_commitment: account.account_commitment,
      privacy_mode: "private_mode",
    });
    expect(await getPrivateVaultState(account.account_commitment)).toMatchObject({
      ready_rails: ["shielded_pool"],
    });
    expect((await getPrivacyBudget(account.account_commitment))?.budget).toMatchObject({
      degraded_action_count: 1,
      repeated_withdrawal_count: 1,
    });
    expect(await getQueuedAction("queue_1")).toMatchObject({
      status: "queued",
      current_anonymity_set: 25,
    });
  });

  it("persists server-owned anonymity evidence by action and queue", async () => {
    await putAnonymityEvidence({
      version: 1,
      evidence_commitment: "anon_evidence_1",
      owner_commitment: "owner_1",
      account_commitment: "acct_1",
      intent_id: "intent_1",
      action_commitment: "action_1",
      queue_id: null,
      source: "internal_test",
      anonymity_set: {
        required: 50,
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
        repeated_pattern_score_bps: 0,
      },
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    await putAnonymityEvidence({
      version: 1,
      evidence_commitment: "anon_evidence_2",
      owner_commitment: "owner_1",
      account_commitment: "acct_1",
      intent_id: "intent_1",
      action_commitment: "action_1",
      queue_id: "queue_1",
      source: "batch_coordinator",
      anonymity_set: {
        required: 50,
        effective: 100,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 250,
        repeated_pattern_score_bps: 0,
      },
      created_at: "2026-05-27T00:01:00.000Z",
      updated_at: "2026-05-27T00:01:00.000Z",
    });

    expect(await getLatestAnonymityEvidence({
      account_commitment: "acct_1",
      action_commitment: "action_1",
    })).toMatchObject({ evidence_commitment: "anon_evidence_2" });
    expect(await getLatestAnonymityEvidence({
      account_commitment: "acct_1",
      queue_id: "queue_1",
    })).toMatchObject({
      source: "batch_coordinator",
      anonymity_set: { effective: 100 },
    });
  });
});
