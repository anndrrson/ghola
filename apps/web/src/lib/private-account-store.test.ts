import { afterEach, describe, expect, it } from "vitest";

const privateBlobRecords = new Map<string, string>();

import {
  claimConnectorWorkOrderForPreview,
  claimPrivateLighterUdaAttempt,
  consumePrivateAccountApproval,
  consumePrivateAccountPreview,
  getPrivateAccountByOwner,
  getPrivateAgentPassportByAccount,
  getHyperliquidExecutionVaultByAccount,
  getPrivateAccountApproval,
  getPrivateAccountIntent,
  getPrivateAccountPreview,
  getPrivateVaultState,
  getVenueExecutionVault,
  getVenueExecutionVaultByAccount,
  getLatestAnonymityEvidence,
  listPrivateVenueCapabilities,
  getPrivacyBudget,
  getQueuedAction,
  putPrivateAccountApproval,
  putPrivateAccountRecord,
  putPrivateAgentPassport,
  putPrivateVenueCapability,
  putHyperliquidExecutionVault,
  putPrivateAccountIntent,
  putPrivateAccountPreview,
  putPrivateVaultState,
  putAnonymityEvidence,
  putPrivacyBudget,
  putQueuedAction,
  putVenueExecutionVault,
  recordPrivacyBudgetEvent,
  resetPrivateAccountStoreForTests,
  settlePrivateLighterUdaAttempt,
  setPrivateBlobRecordAdapterForTests,
  type PrivateConnectorWorkOrderRecordV1,
} from "./private-account-store";
import {
  approvePrivateAccountAction,
  createHyperliquidExecutionVault,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  createVenueExecutionVault,
  gholaCommitment,
  previewPrivateAccountAction,
} from "./private-account";

describe("private account store", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    privateBlobRecords.clear();
    setPrivateBlobRecordAdapterForTests(null);
    delete process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.DATABASE_URL;
  });

  it("atomically binds one connector work order to each preview", async () => {
    const record = (suffix: string): PrivateConnectorWorkOrderRecordV1 => ({
      version: 1,
      work_order_commitment: `connector_work_order_${suffix}`,
      owner_commitment: "owner_preview_once",
      intent_id: "intent_preview_once",
      account_commitment: "account_preview_once",
      action_commitment: "action_preview_once",
      preview_commitment: "preview_once",
      approval_commitment: `approval_${suffix}`,
      execution_plan_commitment: null,
      platform_class: "hyperliquid_style_market",
      status: "prepared",
      work_order: {
        version: 1,
        work_order_commitment: `connector_work_order_${suffix}`,
        owner_commitment: "owner_preview_once",
        intent_id: "intent_preview_once",
        account_commitment: "account_preview_once",
        action_commitment: "action_preview_once",
        preview_commitment: "preview_once",
        approval_commitment: `approval_${suffix}`,
        execution_plan_commitment: null,
        platform_class: "hyperliquid_style_market",
        selected_rail: "direct_public_fallback",
        manifest_commitment: "manifest_preview_once",
        connector_readiness_commitment: "readiness_preview_once",
        compiler_commitment: "compiler_preview_once",
        linkability_score_commitment: "linkability_preview_once",
        platform_funding_account_commitment: "funding_preview_once",
        rotation_commitment: "rotation_preview_once",
        status: "prepared",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    const claims = await Promise.all([
      claimConnectorWorkOrderForPreview(record("first")),
      claimConnectorWorkOrderForPreview(record("second")),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.record.work_order_commitment)).size).toBe(1);
  });

  it("atomically persists one owner-bound Lighter UDA result across process-memory resets", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "blob";
    process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS = "private";
    process.env.BLOB_READ_WRITE_TOKEN = "private-test-token";
    setPrivateBlobRecordAdapterForTests({
      async put(pathname, value) {
        privateBlobRecords.set(pathname, value);
      },
      async putIfAbsent(pathname, value) {
        if (privateBlobRecords.has(pathname)) return false;
        privateBlobRecords.set(pathname, value);
        return true;
      },
      async get(pathname) {
        return privateBlobRecords.get(pathname) ?? null;
      },
    });
    const ownerCommitment = gholaCommitment("owner", "lighter-uda-owner");
    const ownerAddress = "0xa0582521e11effdf12ff00b50087802c3346e7ef" as const;
    const walletCommitment = gholaCommitment("wallet", ownerAddress);
    const attemptId = gholaCommitment("lighter_uda_attempt", {
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
    });
    const claims = await Promise.all([
      claimPrivateLighterUdaAttempt({
        attempt_id: attemptId,
        owner_commitment: ownerCommitment,
        wallet_commitment: walletCommitment,
        owner_address: ownerAddress,
        claim_token: "aa".repeat(32),
        now: new Date("2026-08-31T00:00:00.000Z"),
      }),
      claimPrivateLighterUdaAttempt({
        attempt_id: attemptId,
        owner_commitment: ownerCommitment,
        wallet_commitment: walletCommitment,
        owner_address: ownerAddress,
        claim_token: "bb".repeat(32),
        now: new Date("2026-08-31T00:00:00.001Z"),
      }),
    ]);
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    const winner = claims.find((claim) => claim.acquired);
    if (!winner?.acquired) throw new Error("missing atomic claim winner");
    const destination = {
      owner_address: ownerAddress,
      deposit_address: "0x2222222222222222222222222222222222222222" as const,
      market: "perps" as const,
      asset: "USDC" as const,
      blocked: false as const,
      action_type: "LIGHTER_PERPS" as const,
      to_chain_id: "3586256" as const,
      to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
      recipient_address: ownerAddress,
      recipient_binding: "owner_address" as const,
      owner_account_index: null,
      resolved_user_id: ownerAddress,
    };
    await settlePrivateLighterUdaAttempt({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: winner.record.claim_token,
      status: "verified",
      destination,
      failure_code: null,
      now: new Date("2026-08-31T00:00:01.000Z"),
    });

    await resetPrivateAccountStoreForTests();

    const replay = await claimPrivateLighterUdaAttempt({
      attempt_id: attemptId,
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: "cc".repeat(32),
      now: new Date("2026-08-31T00:01:00.000Z"),
    });
    expect(replay).toMatchObject({ acquired: false, record: { status: "verified", destination } });
    const rotated = await claimPrivateLighterUdaAttempt({
      attempt_id: gholaCommitment("lighter_uda_attempt", "rotated"),
      owner_commitment: ownerCommitment,
      wallet_commitment: gholaCommitment("wallet", "0x1111111111111111111111111111111111111111"),
      owner_address: "0x1111111111111111111111111111111111111111",
      claim_token: "dd".repeat(32),
      now: new Date("2026-08-31T00:02:00.000Z"),
    });
    expect(rotated).toMatchObject({
      acquired: false,
      record: { owner_address: ownerAddress, status: "verified" },
    });
    const crossSession = await claimPrivateLighterUdaAttempt({
      attempt_id: gholaCommitment("lighter_uda_attempt", "cross-session"),
      owner_commitment: gholaCommitment("owner", "another-session"),
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: "12".repeat(32),
      now: new Date("2026-08-31T00:03:00.000Z"),
    });
    expect(crossSession).toMatchObject({
      acquired: false,
      record: { owner_commitment: ownerCommitment, status: "verified" },
    });
  });

  it("keeps an interrupted Lighter UDA claim durably pending and retry-forbidden", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "blob";
    process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS = "private";
    process.env.BLOB_READ_WRITE_TOKEN = "private-test-token";
    setPrivateBlobRecordAdapterForTests({
      async put(pathname, value) {
        privateBlobRecords.set(pathname, value);
      },
      async putIfAbsent(pathname, value) {
        if (privateBlobRecords.has(pathname)) return false;
        privateBlobRecords.set(pathname, value);
        return true;
      },
      async get(pathname) {
        return privateBlobRecords.get(pathname) ?? null;
      },
    });
    const ownerCommitment = gholaCommitment("owner", "lighter-uda-interrupted");
    const attemptId = gholaCommitment("lighter_uda_attempt", ownerCommitment);
    const ownerAddress = "0xa0582521e11effdf12ff00b50087802c3346e7ef" as const;
    const walletCommitment = gholaCommitment("wallet", ownerAddress);
    expect((await claimPrivateLighterUdaAttempt({
      attempt_id: attemptId,
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: "ee".repeat(32),
      now: new Date("2026-08-31T00:00:00.000Z"),
    })).acquired).toBe(true);

    await resetPrivateAccountStoreForTests();

    expect(await claimPrivateLighterUdaAttempt({
      attempt_id: attemptId,
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: "ff".repeat(32),
      now: new Date("2026-08-31T00:01:00.000Z"),
    })).toMatchObject({ acquired: false, record: { status: "pending" } });
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

  it("keeps cross-venue passports and sealed vaults in private Blob when database variables also exist", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "blob";
    process.env.GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS = "private";
    process.env.BLOB_READ_WRITE_TOKEN = "private-test-token";
    process.env.DATABASE_URL = "postgresql://must-not-be-used.invalid/ghola";
    setPrivateBlobRecordAdapterForTests({
      async put(pathname, value) {
        privateBlobRecords.set(pathname, value);
      },
      async get(pathname) {
        return privateBlobRecords.get(pathname) ?? null;
      },
    });
    const ownerCommitment = "owner_cross_venue_reload";
    const account = createPrivateExecutionAccount({
      sessionId: ownerCommitment,
      turnkeyWalletId: `turnkey:${ownerCommitment}`,
      vaultSeed: `vault:${ownerCommitment}`,
      policySeed: "private-mode-default",
      platformSeed: `platforms:${ownerCommitment}`,
      vaultReady: false,
    });
    const now = "2026-08-31T00:00:00.000Z";
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
    const created = createVenueExecutionVault({
      venue_id: "lighter",
      execution_mode: "byo_api_key",
      account_commitment: account.account_commitment,
      encrypted_execution_vault: {
        alg: "sealed-provider-v1",
        ciphertext: "encrypted-lighter-test-ciphertext",
        recipient: "phala:cvm:cross-venue-worker",
        aad: "ghola/lighter-execution-vault-v1",
      },
      now: new Date(now),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    await putVenueExecutionVault({
      version: 1,
      owner_commitment: ownerCommitment,
      account_commitment: account.account_commitment,
      venue_id: created.vault.venue_id,
      platform_class: created.vault.platform_class,
      execution_mode: created.vault.execution_mode,
      vault_commitment: created.vault.vault_commitment,
      encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
      recipient_commitment: created.vault.recipient_commitment,
      policy_commitment: created.vault.policy_commitment,
      allocation_commitment: created.vault.allocation_commitment,
      status: "sealed",
      vault: created.vault,
      created_at: now,
      updated_at: now,
    });
    await putPrivateVenueCapability({
      version: 1,
      owner_commitment: ownerCommitment,
      account_commitment: account.account_commitment,
      venue_id: "lighter",
      capability_commitment: "lighter_capability_cross_venue_reload",
      status: "ready",
      capability: { can_read: true, can_trade: true, can_withdraw: false },
      created_at: now,
      updated_at: now,
    });
    await putPrivateAgentPassport({
      version: 1,
      owner_commitment: ownerCommitment,
      account_commitment: account.account_commitment,
      passport_commitment: "passport_cross_venue_reload",
      status: "active",
      passport: { venues: ["lighter"] },
      created_at: now,
      updated_at: now,
    });

    await resetPrivateAccountStoreForTests();

    expect((await getPrivateAccountByOwner(ownerCommitment))?.account_commitment)
      .toBe(account.account_commitment);
    expect(await getPrivateAgentPassportByAccount(account.account_commitment)).toMatchObject({
      passport_commitment: "passport_cross_venue_reload",
      status: "active",
    });
    expect(await listPrivateVenueCapabilities({
      owner_commitment: ownerCommitment,
      account_commitment: account.account_commitment,
    })).toEqual([expect.objectContaining({
      venue_id: "lighter",
      capability_commitment: "lighter_capability_cross_venue_reload",
      status: "ready",
    })]);
    expect(await getVenueExecutionVaultByAccount({
      account_commitment: account.account_commitment,
      venue_id: "lighter",
      execution_mode: "byo_api_key",
    })).toMatchObject({
      vault_commitment: created.vault.vault_commitment,
      venue_id: "lighter",
      status: "sealed",
    });
    expect(await getVenueExecutionVault(created.vault.vault_commitment)).toMatchObject({
      account_commitment: account.account_commitment,
      venue_id: "lighter",
    });
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
