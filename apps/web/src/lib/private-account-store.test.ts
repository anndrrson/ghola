import { afterEach, describe, expect, it, vi } from "vitest";

const privateBlobRecords = new Map<string, string>();

import {
  consumePrivateAccountApproval,
  consumePrivateAccountPreview,
  getPrivateAccountByOwner,
  getHyperliquidExecutionVaultByAccount,
  getPrivateAccountApproval,
  getPrivateAccountIntent,
  getPrivateAccountPreview,
  getPrivateVaultState,
  getLatestAnonymityEvidence,
  getPrivacyBudget,
  getQueuedAction,
  putPrivateAccountApproval,
  putPrivateAccountRecord,
  putHyperliquidExecutionVault,
  putPrivateAccountIntent,
  putPrivateAccountPreview,
  putPrivateVaultState,
  privateAccountDatabaseDriver,
  putAnonymityEvidence,
  putPrivacyBudget,
  putQueuedAction,
  reserveHyperliquidShardAssignment,
  retireUnavailableHyperliquidShardAssignment,
  recordPrivacyBudgetEvent,
  resetPrivateAccountStoreForTests,
  setPrivateBlobRecordAdapterForTests,
  sealHyperliquidShardAssignment,
} from "./private-account-store";
import {
  approvePrivateAccountAction,
  createHyperliquidExecutionVault,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  gholaCommitment,
  previewPrivateAccountAction,
} from "./private-account";

describe("private account store", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    privateBlobRecords.clear();
    setPrivateBlobRecordAdapterForTests(null);
    delete process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_DRIVER;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS;
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  it("selects Neon HTTP only for Neon hosts and TCP PostgreSQL otherwise", () => {
    expect(privateAccountDatabaseDriver("postgresql://user:pass@ep-test.us-east-2.aws.neon.tech/db")).toBe("neon");
    expect(privateAccountDatabaseDriver("postgresql://user:pass@127.0.0.1:5432/db")).toBe("postgres");
    expect(privateAccountDatabaseDriver("postgresql://user:pass@db.internal.example/db")).toBe("postgres");
  });

  it("restores a verified Hyperliquid credential after process memory is cleared", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "blob";
    process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS = "private";
    process.env.BLOB_READ_WRITE_TOKEN = "private-test-token";
    setPrivateBlobRecordAdapterForTests({
      async put(pathname, value) {
        privateBlobRecords.set(pathname, value);
      },
      async get(pathname) {
        return privateBlobRecords.get(pathname) ?? null;
      },
    });
    const ownerCommitment = "owner_verified_reload";
    const account = createPrivateExecutionAccount({
      sessionId: ownerCommitment,
      turnkeyWalletId: `turnkey:${ownerCommitment}`,
      vaultSeed: `vault:${ownerCommitment}`,
      policySeed: "private-mode-default",
      platformSeed: `platforms:${ownerCommitment}`,
      vaultReady: false,
    });
    const now = "2026-08-01T00:00:00.000Z";
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
        ciphertext: "encrypted-test-ciphertext",
        recipient: "phala:cvm:testnet-worker",
        aad: [
          "ghola/hyperliquid-execution-vault-v1",
          `account:${account.account_commitment}`,
          "recipient:phala:cvm:testnet-worker",
          "network:testnet",
        ].join("|"),
      },
      now: new Date(now),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    const verifiedAt = "2026-08-01T00:01:00.000Z";
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
          verification_commitment: "verification_reload_test",
          work_order_commitment: "work_order_reload_test",
          network: "testnet",
          credential_opened: true,
          signer_binding_verified: true,
          account_read_verified: true,
          order_request_built: true,
          verified_at: verifiedAt,
          expires_at: "2099-08-01T00:16:00.000Z",
        },
        updated_at: verifiedAt,
      },
      created_at: now,
      updated_at: verifiedAt,
    });

    await resetPrivateAccountStoreForTests();

    const reloadedAccount = await getPrivateAccountByOwner(ownerCommitment);
    const reloadedVault = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
    expect(reloadedAccount?.account_commitment).toBe(account.account_commitment);
    expect(reloadedVault).toMatchObject({
      owner_commitment: ownerCommitment,
      account_commitment: account.account_commitment,
      status: "sealed",
      vault: {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          recipient: "phala:cvm:testnet-worker",
        },
        connection_proof: {
          status: "verified_no_funds",
          network: "testnet",
          credential_opened: true,
        },
      },
    });
    expect(JSON.stringify(reloadedVault)).not.toContain("api_wallet_private_key");
  });

  it("keeps 100 durable Hyperliquid credentials isolated by account across reloads", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "blob";
    process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS = "private";
    process.env.BLOB_READ_WRITE_TOKEN = "private-test-token";
    setPrivateBlobRecordAdapterForTests({
      async put(pathname, value) {
        privateBlobRecords.set(pathname, value);
      },
      async get(pathname) {
        return privateBlobRecords.get(pathname) ?? null;
      },
    });

    const expected = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const ownerCommitment = `owner_100_trader_${index}`;
      const accountCommitment = `account_100_trader_${index}`;
      const created = createHyperliquidExecutionVault({
        account_commitment: accountCommitment,
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: `opaque-test-ciphertext-${index}`,
          recipient: "phala:cvm:production-worker",
          aad: [
            "ghola/hyperliquid-execution-vault-v1",
            `account:${accountCommitment}`,
            "recipient:phala:cvm:production-worker",
            "network:mainnet",
          ].join("|"),
        },
        now: new Date(`2026-08-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      const record = {
        version: 1 as const,
        owner_commitment: ownerCommitment,
        account_commitment: accountCommitment,
        vault_commitment: created.vault.vault_commitment,
        encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
        recipient_commitment: created.vault.recipient_commitment,
        policy_commitment: created.vault.policy_commitment,
        status: "sealed" as const,
        vault: created.vault,
        created_at: created.vault.created_at,
        updated_at: created.vault.updated_at,
      };
      await putHyperliquidExecutionVault(record);
      return record;
    }));

    await resetPrivateAccountStoreForTests();
    const reloaded = await Promise.all(expected.map((record) =>
      getHyperliquidExecutionVaultByAccount(record.account_commitment)));

    expect(reloaded).toHaveLength(100);
    expect(new Set(reloaded.map((record) => record?.vault_commitment)).size).toBe(100);
    reloaded.forEach((record, index) => {
      expect(record).toMatchObject({
        owner_commitment: expected[index].owner_commitment,
        account_commitment: expected[index].account_commitment,
        vault_commitment: expected[index].vault_commitment,
      });
      expect(record?.account_commitment).not.toBe(expected[(index + 1) % expected.length].account_commitment);
    });
    expect(JSON.stringify(reloaded)).not.toContain("api_wallet_private_key");
  });

  it("atomically admits exactly 100 accounts into ten ten-user Hyperliquid shards", async () => {
    const shards = Array.from({ length: 10 }, (_, index) => ({
      id: `hl-${index}`,
      recipient_id: `phala:hl-${index}`,
    }));
    const assignments = await Promise.all(Array.from({ length: 101 }, (_, index) =>
      reserveHyperliquidShardAssignment({
        account_commitment: `account_capacity_${index}`,
        shards,
        slots_per_shard: 10,
      })
    ));
    expect(assignments.filter(Boolean)).toHaveLength(100);
    expect(assignments.filter((assignment) => assignment === null)).toHaveLength(1);
    for (const shard of shards) {
      expect(assignments.filter((assignment) => assignment?.recipient_id === shard.recipient_id)).toHaveLength(10);
    }
    expect(new Set(assignments.filter(Boolean).map((assignment) =>
      `${assignment?.recipient_id}:${assignment?.slot_number}`
    )).size).toBe(100);
    const first = assignments[0];
    expect(first).not.toBeNull();
    expect(await sealHyperliquidShardAssignment({
      account_commitment: "account_capacity_0",
      recipient_id: first!.recipient_id,
    })).toBe(true);
    expect(await sealHyperliquidShardAssignment({
      account_commitment: "account_capacity_0",
      recipient_id: "phala:wrong",
    })).toBe(false);
  });

  it("caps the founding beta at ten accounts on its single Hyperliquid egress", async () => {
    const shard = { id: "hl-founding", recipient_id: "phala:hl-founding" };
    const assignments = await Promise.all(Array.from({ length: 11 }, (_, index) =>
      reserveHyperliquidShardAssignment({
        account_commitment: `founding_account_${index}`,
        shards: [shard],
        slots_per_shard: 10,
      })
    ));

    const admitted = assignments.filter((assignment) => assignment !== null);
    expect(admitted).toHaveLength(10);
    expect(assignments.filter((assignment) => assignment === null)).toHaveLength(1);
    expect(new Set(admitted.map((assignment) => assignment.recipient_id))).toEqual(
      new Set([shard.recipient_id]),
    );
    expect(new Set(admitted.map((assignment) => assignment.slot_number)).size).toBe(10);
  });

  it("reclaims a sealed shard lease after entitlement refreshes stop", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
      const shard = { id: "hl-founding", recipient_id: "phala:hl-founding" };
      const original = await reserveHyperliquidShardAssignment({
        account_commitment: "former_paid_account",
        shards: [shard],
        slots_per_shard: 1,
        pending_ttl_ms: 60_000,
      });
      expect(original).not.toBeNull();
      expect(await sealHyperliquidShardAssignment({
        account_commitment: "former_paid_account",
        recipient_id: shard.recipient_id,
        lease_ttl_ms: 60_000,
      })).toBe(true);

      vi.advanceTimersByTime(60_001);
      const replacement = await reserveHyperliquidShardAssignment({
        account_commitment: "new_paid_account",
        shards: [shard],
        slots_per_shard: 1,
        pending_ttl_ms: 60_000,
      });
      expect(replacement?.slot_number).toBe(original?.slot_number);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires only assignments whose recipient is no longer active", async () => {
    const account = "account_retired_recipient";
    const original = await reserveHyperliquidShardAssignment({
      account_commitment: account,
      shards: [{ id: "old", recipient_id: "phala:old" }],
    });
    expect(original?.recipient_id).toBe("phala:old");
    expect(await retireUnavailableHyperliquidShardAssignment({
      account_commitment: account,
      active_recipient_ids: ["phala:new"],
    })).toBe(true);
    const replacement = await reserveHyperliquidShardAssignment({
      account_commitment: account,
      shards: [{ id: "new", recipient_id: "phala:new" }],
    });
    expect(replacement?.recipient_id).toBe("phala:new");
    expect(await retireUnavailableHyperliquidShardAssignment({
      account_commitment: account,
      active_recipient_ids: ["phala:new"],
    })).toBe(false);
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
