import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  sanitizeFundedMainnetProofReport,
  sanitizeHyperliquidCloseReport,
  validateInvestorCanaryDossier,
  verifyInvestorCanaryAcceptance,
} from "./investor-canary-acceptance-lib.mjs";

const NOW = new Date("2026-08-19T16:00:00.000Z");
const SHA = "6f91bf9dc9abbf2a7d5efabe85e01785c1d2091b";

test("accepts two independent investors without a third public-promotion proof", () => {
  const input = fixture();
  assert.equal(input.graduation_proofs.length, 2);
  assert.equal(Object.hasOwn(input, "release_proof_ids"), false);
  const report = verify(input);
  assert.equal(report.ok, true, report.failures.join(", "));
});

test("never promotes an operator-supplied dossier to acceptance GO", () => {
  const report = verifyInvestorCanaryAcceptance(fixture(), { now: NOW });
  assert.equal(report.ok, false);
  assertFailure(report, "live_authenticated_evidence_required");
});

test("rejects public launch or a green global gate", () => {
  const publicInput = fixture();
  publicInput.release.launch_state = "public";
  publicInput.release.public_live_enabled = true;
  assertFailure(verify(publicInput), "launch_must_remain_non_public_canary");

  const globalGreen = fixture();
  globalGreen.release.global_status.status = "green";
  globalGreen.release.global_status.live_trading_enabled = true;
  assertFailure(verify(globalGreen), "global_public_gate_must_remain_red");
});

test("requires the protected operator issuance and fragment redemption contract", () => {
  const wrongRoute = fixture();
  wrongRoute.invite_gate.issue_path = "/api/invites";
  assertFailure(verify(wrongRoute), "email_bound_single_use_invite_gate_unproven");

  const tokenPrintingIssuer = fixture();
  tokenPrintingIssuer.invite_gate.issuer_stdout_redacted = false;
  assertFailure(verify(tokenPrintingIssuer), "email_bound_single_use_invite_gate_unproven");
});

test("requires exact-release v3 graduation for both investors", () => {
  const input = fixture();
  input.graduation_proofs[0].graduation.worker_git_sha = "a".repeat(40);
  assertFailure(verify(input), "graduation_not_bound_to_exact_release");
});

test("requires owner-green and different-owner-red account canary evidence", () => {
  const input = fixture();
  input.investor_runs[0].terminal_round_trips[0].account_canary_access.access_mode = "public";
  assertFailure(verify(input), "owner_account_canary_access_invalid");

  const missingNegative = fixture();
  missingNegative.investor_runs[0].negative_control_access.status = "green";
  assertFailure(verify(missingNegative), "account_canary_negative_control_invalid");
});

test("rejects secret-bearing and raw venue identifier fields", () => {
  const secret = fixture();
  secret.investor_runs[0].api_wallet_private_key = "must-never-appear";
  assertFailure(verify(secret), "forbidden_secret_or_raw_identifier");

  const raw = fixture();
  raw.investor_runs[0].terminal_round_trips[0].entry.venue_order_oid = "518475952911";
  assertFailure(verify(raw), "forbidden_secret_or_raw_identifier");
});

test("requires current complimentary entitlement, expiry, compute, and allowance", () => {
  const expired = fixture();
  expired.investor_runs[0].terminal_round_trips[1].entitlement.expires_at =
    "2026-08-19T15:49:59.000Z";
  assertFailure(verify(expired), "terminal_entitlement_invalid");

  const compute = fixture();
  compute.investor_runs[0].terminal_round_trips[1]
    .entitlement.private_agent_compute.remaining_seconds = 599;
  assertFailure(verify(compute), "terminal_entitlement_invalid");

  const allowance = fixture();
  allowance.investor_runs[0].terminal_round_trips[1]
    .entitlement.private_agent_trading.remaining_included_notional_micro_usd = 21_999_999;
  assertFailure(verify(allowance), "terminal_entitlement_invalid");
});

test("does not treat a gateway acknowledgement as fill proof", () => {
  const input = fixture();
  input.investor_runs[0].terminal_round_trips[0].entry.venue_fill.final_fill_proven = false;
  assertFailure(verify(input), "terminal_entry_fill_not_proven");
});

test("accepts a retry only after terminal IOC no-fill proof", () => {
  const input = fixture();
  const trade = input.investor_runs[0].terminal_round_trips[0];
  trade.entry.prior_terminal_no_fills = [
    noFillAttempt("investor-a-trade-1-no-fill", "2026-08-19T15:09:50.000Z"),
  ];
  const report = verify(input);
  assert.equal(report.ok, true, report.failures.join(", "));

  trade.entry.prior_terminal_no_fills[0].terminal_receipt.final_no_fill_proven = false;
  assertFailure(verify(input), "terminal_entry_fill_not_proven");
});

test("requires current completed Postgres claims with exact request binding", () => {
  const legacy = fixture();
  legacy.investor_runs[0].terminal_round_trips[0].entry.claim.namespace =
    "worker_execution_claims_v0";
  assertFailure(verify(legacy), "terminal_entry_fill_not_proven");

  const unresolved = fixture();
  unresolved.investor_runs[0].terminal_round_trips[0].entry.claim.status =
    "reconcile_required";
  unresolved.investor_runs[0].terminal_round_trips[0].entry.claim.unresolved = true;
  assertFailure(verify(unresolved), "terminal_entry_fill_not_proven");
});

test("requires venue-reconciled reduce-only close and venue-wide final flat", () => {
  const close = fixture();
  close.investor_runs[0].terminal_round_trips[0].close.report.closes[0].reduce_only = false;
  assertFailure(verify(close), "terminal_reduce_only_close_invalid");

  const final = fixture();
  final.investor_runs[0].terminal_round_trips[0].final_state.open_order_count = 1;
  assertFailure(verify(final), "terminal_final_state_not_flat");
});

test("requires a human reload and a genuinely distinct second terminal trade", () => {
  const reload = fixture();
  reload.investor_runs[0].reload.human_initiated = false;
  assertFailure(verify(reload), "investor_reload_evidence_invalid");

  const replay = fixture();
  const [first, second] = replay.investor_runs[0].terminal_round_trips;
  second.order_plan.plan_digest = first.order_plan.plan_digest;
  assertFailure(verify(replay), "terminal_plan_claim_order_or_transaction_reused");
});

test("requires restart replay without a second broadcast and links it to the run", () => {
  const rebroadcast = fixture();
  rebroadcast.rollback.worker_restart_recovery.rebroadcast_performed = true;
  rebroadcast.rollback.worker_restart_recovery.broadcast_count_after = 2;
  assertFailure(verify(rebroadcast), "rollback_or_restart_recovery_gate_incomplete");

  const unlinked = fixture();
  unlinked.rollback.worker_restart_recovery.work_order_commitment = terminalWork("unlinked");
  assertFailure(verify(unlinked), "restart_recovery_work_order_not_in_acceptance_run");
});

test("sanitizes proof evidence without addresses, order ids, or transaction hashes", () => {
  const sanitized = sanitizeFundedMainnetProofReport(rawProofReport());
  const encoded = JSON.stringify(sanitized);
  assert.equal(sanitized.sanitized, true);
  assert.equal(sanitized.claim_namespace, "hl_mainnet_investor_proof_v2");
  assert.doesNotMatch(encoded, /0x1111111111111111111111111111111111111111/u);
  assert.doesNotMatch(encoded, /123456/u);
  assert.doesNotMatch(encoded, /0x[a-f0-9]{64}/u);
  assert.equal(Object.hasOwn(sanitized, "api_wallet_address"), false);
});

test("sanitizes close evidence without venue order identifiers", () => {
  const raw = rawCloseReport();
  const sanitized = sanitizeHyperliquidCloseReport(raw);
  const encoded = JSON.stringify(sanitized);
  assert.equal(sanitized.sanitized, true);
  assert.doesNotMatch(encoded, /518475952911/u);
  assert.doesNotMatch(encoded, /0x[a-f0-9]{32}/u);
  assert.equal(Object.hasOwn(sanitized.closes[0], "venue_order_oid"), false);
  assert.match(sanitized.closes[0].order_commitment, /^sha256:[a-f0-9]{64}$/u);
});

function verify(input) {
  return validateInvestorCanaryDossier(input, { now: NOW });
}

function assertFailure(report, failure) {
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.includes(failure),
    failure + " missing from " + report.failures.join(", "),
  );
}

function fixture() {
  const identity = releaseIdentity();
  const owners = [digest("owner-a"), digest("owner-b")];
  const accounts = [digest("venue-a"), digest("venue-b")];
  const vaults = [digest("vault-a"), digest("vault-b")];
  const proofs = [
    proof({
      proofId: "proof-a",
      owner: owners[0],
      account: accounts[0],
      vault: vaults[0],
      completedAt: "2026-08-19T15:00:00.000Z",
      identity,
    }),
    proof({
      proofId: "proof-b",
      owner: owners[1],
      account: accounts[1],
      vault: vaults[1],
      completedAt: "2026-08-19T15:02:00.000Z",
      identity,
    }),
  ];
  const investorRuns = [
    investorRun({
      runId: "investor-a",
      owner: owners[0],
      account: accounts[0],
      vault: vaults[0],
      phantom: digest("phantom-a"),
      proofId: "proof-a",
      firstEntry: "2026-08-19T15:10:00.000Z",
      secondEntry: "2026-08-19T15:20:00.000Z",
      reloadAt: "2026-08-19T15:15:00.000Z",
      identity,
    }),
    investorRun({
      runId: "investor-b",
      owner: owners[1],
      account: accounts[1],
      vault: vaults[1],
      phantom: digest("phantom-b"),
      proofId: "proof-b",
      firstEntry: "2026-08-19T15:30:00.000Z",
      secondEntry: "2026-08-19T15:40:00.000Z",
      reloadAt: "2026-08-19T15:35:00.000Z",
      identity,
    }),
  ];
  const recoveryTrade = investorRuns[0].terminal_round_trips[0];
  return {
    version: 2,
    mode: "invite_only_account_canary",
    acceptance_scope: "graduation_plus_two_normal_terminal_roundtrips",
    generated_at: "2026-08-19T15:59:30.000Z",
    release: {
      identity,
      immutable: true,
      deployment_id: "dpl_investor_canary_002",
      release_manifest_commitment: digest("manifest"),
      launch_state: "canary",
      public_live_enabled: false,
      public_rollout_percent: 0,
      checked_at: "2026-08-19T15:59:00.000Z",
      worker: {
        release_identity: identity,
        ready: true,
        attested_ready: true,
        report_data_bound: true,
        state_store: "postgres",
        mainnet: true,
        dry_run: false,
        full_ticket: true,
        capabilities: requiredCapabilities(),
        execution_claim_store: "worker_execution_claims",
        execution_attempt_store: "worker_execution_attempts",
        idempotency_store: "worker_idempotency",
        checked_at: "2026-08-19T15:59:00.000Z",
      },
      global_status: {
        source_path: "/v1/private-account/live-trading/status",
        contract_version: 2,
        status: "red",
        launch_state: "canary",
        live_trading_enabled: false,
        byo_live_trading_enabled: false,
        pooled_live_trading_enabled: false,
        public_live_copy_allowed: false,
        release_identity: identity,
        reason_codes: ["live_trading_launch_state_invalid"],
        gate_commitment: gholaId("live_trading_gate", "global-red"),
        checked_at: "2026-08-19T15:59:00.000Z",
      },
    },
    invite_gate: {
      mode: "email_bound_single_use_complimentary_pass",
      issue_path: "/api/billing/access-passes",
      redeem_path: "/api/billing/access-passes/redeem",
      landing_path: "/account",
      transport: "url_fragment",
      fragment_key: "access",
      operator_auth_required: true,
      dual_operator_auth_required: true,
      issuer_stdout_redacted: true,
      protected_artifact_mode: "0600",
      server_redeem_enforced: true,
      email_bound: true,
      single_use: true,
      postgres_backed: true,
      public_discovery_disabled: true,
      fragment_captured_and_scrubbed: true,
      pass_store_commitment: digest("pass-store"),
      checked_at: "2026-08-19T15:59:00.000Z",
    },
    rollback: {
      kill_control_ready: true,
      reduce_only_close_ready: true,
      rollback_artifact_pinned: true,
      incident_owner_present: true,
      unresolved_claim_count: 0,
      open_exposure_count: 0,
      open_order_count: 0,
      launch_state_after_run: "canary",
      rollback_artifact_commitment: digest("rollback-artifact"),
      worker_restart_recovery: {
        proven: true,
        release_identity: identity,
        claim_store: "postgres",
        claim_namespace: "worker_execution_claims",
        work_order_commitment: recoveryTrade.entry.gateway_ack.work_order_commitment,
        process_restart_observed: true,
        receipt_replayed: true,
        rebroadcast_performed: false,
        broadcast_count_before: 1,
        broadcast_count_after: 1,
        original_receipt_commitment: recoveryTrade.entry.gateway_ack.receipt_commitment,
        replayed_receipt_commitment: recoveryTrade.entry.gateway_ack.receipt_commitment,
        checked_at: "2026-08-19T15:58:00.000Z",
      },
      checked_at: "2026-08-19T15:59:00.000Z",
    },
    graduation_proofs: proofs,
    investor_runs: investorRuns,
  };
}

function releaseIdentity() {
  return {
    contract_version: 2,
    web_git_sha: SHA,
    worker_git_sha: SHA,
    worker_image_digest: digest("worker-image"),
    config_fingerprint: gholaId("live_trading_config", "config"),
    valid: true,
    reason_codes: [],
  };
}

function proof({ proofId, owner, account, vault, completedAt, identity }) {
  const root = "hl_mainnet_investor_proof_v2_" + hash(proofId).slice(0, 32);
  const before = offset(completedAt, -60);
  const after = offset(completedAt, 60);
  return {
    proof_id: proofId,
    owner_commitment: owner,
    venue_account_commitment: account,
    vault_commitment: vault,
    release_identity: identity,
    entitlement: entitlement(before),
    vault: {
      status: "sealed",
      network: "mainnet",
      vault_commitment: vault,
      trade_only: true,
      withdrawal_authority: false,
      checked_at: before,
    },
    preflight_access: {
      network: "mainnet",
      vault_ready: true,
      eligibility_ready: true,
      graduation_ready: false,
      vault_commitment: vault,
      eligibility_expires_at: "2026-08-20T16:00:00.000Z",
      proof_completed_at: null,
      checked_at: before,
    },
    pre_state: flatVenueState(account, before, proofId + "-pre"),
    human_control: {
      automation_used: false,
      wallet_unlocked_by_human: true,
      phantom_account_selected_by_human: true,
      eligibility_attested_by_human: true,
      trade_confirmed_by_human: true,
      vault_message_approvals_by_human: 2,
      proof_message_approvals_by_human: 2,
    },
    receipt: proofReceipt(proofId, root, completedAt),
    postflight_access: {
      network: "mainnet",
      vault_ready: true,
      eligibility_ready: true,
      graduation_ready: true,
      vault_commitment: vault,
      eligibility_expires_at: "2026-08-20T16:00:00.000Z",
      proof_completed_at: completedAt,
      checked_at: after,
    },
    graduation: {
      version: 3,
      contract_version: 2,
      graduation_id: gholaId("hyperliquid_account_graduation", proofId),
      owner_commitment: owner,
      account_commitment: account,
      vault_commitment: vault,
      web_git_sha: identity.web_git_sha,
      worker_git_sha: identity.worker_git_sha,
      worker_image_digest: identity.worker_image_digest,
      config_fingerprint: identity.config_fingerprint,
      proof_evidence_commitment: gholaId("proof_evidence", proofId),
      proof_notional_usd: 11,
      status: "active",
      completed_at: completedAt,
    },
    final_state: flatVenueState(account, after, proofId + "-final"),
  };
}

function investorRun({
  runId,
  owner,
  account,
  vault,
  phantom,
  proofId,
  firstEntry,
  secondEntry,
  reloadAt,
  identity,
}) {
  return {
    run_id: runId,
    owner_commitment: owner,
    venue_account_commitment: account,
    vault_commitment: vault,
    phantom_wallet_commitment: phantom,
    release_identity: identity,
    invite: {
      pass_commitment: digest(runId + "-pass"),
      email_commitment: digest(runId + "-email"),
      owner_commitment: owner,
      access_source: "complimentary_pass",
      redeemed_once: true,
      revoked: false,
      redeemed_at: "2026-08-19T14:50:00.000Z",
      expires_at: "2026-08-20T16:00:00.000Z",
    },
    graduation_proof_id: proofId,
    negative_control_access: blockedAccess(runId, identity),
    terminal_round_trips: [
      terminalTrade({
        tradeId: runId + "-trade-1",
        owner,
        account,
        vault,
        entryAt: firstEntry,
        identity,
      }),
      terminalTrade({
        tradeId: runId + "-trade-2",
        owner,
        account,
        vault,
        entryAt: secondEntry,
        identity,
      }),
    ],
    reload: {
      full_document_reload: true,
      human_initiated: true,
      automation_used: false,
      at: reloadAt,
      pre_reload_document_commitment: digest(runId + "-document-1"),
      post_reload_document_commitment: digest(runId + "-document-2"),
    },
  };
}

function terminalTrade({ tradeId, owner, account, vault, entryAt, identity }) {
  const fillAt = offset(entryAt, 10);
  const openAt = offset(entryAt, 20);
  const closeSubmittedAt = offset(entryAt, 60);
  const closeCompletedAt = offset(entryAt, 80);
  const finalAt = offset(entryAt, 90);
  const workOrder = terminalWork(tradeId);
  const planDigest = digest(tradeId + "-plan");
  const receiptCommitment = digest(tradeId + "-gateway-receipt");
  const closeRoot = "hl_close_" + hash(tradeId + "-close").slice(0, 40);
  const closeWorkOrder = closeRoot + "_close_hype_1";
  return {
    trade_id: tradeId,
    route: "normal_terminal",
    owner_commitment: owner,
    venue_account_commitment: account,
    vault_commitment: vault,
    release_identity: identity,
    entitlement: entitlement(offset(entryAt, -30)),
    account_canary_access: readyAccess(owner, identity, offset(entryAt, -10), tradeId),
    pre_state: flatVenueState(account, offset(entryAt, -30), tradeId + "-pre"),
    order_plan: {
      market: "HYPE",
      order_type: "limit",
      time_in_force: "ioc",
      side: "buy",
      quote_notional_usd: 11,
      reduce_only: false,
      margin_mode: "isolated",
      leverage: 1,
      max_slippage_bps: 50,
      plan_digest: planDigest,
      preview_commitment: digest(tradeId + "-preview"),
      idempotency_commitment: digest(tradeId + "-idempotency"),
      issued_at: offset(entryAt, -20),
      expires_at: offset(entryAt, 30),
      position_protection: {
        mode: "normal_tpsl",
        stop_loss_bound: true,
        take_profit_bound: true,
        trigger_source: "mark",
        trigger_order_type: "bounded_limit",
      },
    },
    human_control: {
      automation_used: false,
      normal_terminal_controls_used: true,
      exact_order_reviewed_by_human: true,
      entry_confirmed_by_human: true,
      close_ro_selected_by_human: true,
      close_confirmed_by_human: true,
      phantom_step_up_signed_by_human: true,
      extension_operated_by_human: true,
    },
    entry: {
      submitted_at: entryAt,
      prior_terminal_no_fills: [],
      gateway_ack: {
        sanitized: true,
        outcome: "acknowledged",
        status: "submitted",
        dispatch: "dispatched",
        fill_proof: false,
        plan_digest: planDigest,
        response_plan_digest: planDigest,
        work_order_commitment: workOrder,
        receipt_commitment: receiptCommitment,
        result_commitment: digest(tradeId + "-gateway-result"),
      },
      claim: claim(workOrder, receiptCommitment, fillAt, tradeId + "-entry"),
      venue_fill: {
        sanitized: true,
        proof_kind: "hyperliquid_execution_proof_v1",
        network: "mainnet",
        market: "HYPE",
        work_order_commitment: workOrder,
        terminal_status: "filled",
        broadcast_performed: true,
        final_venue_execution_proven: true,
        final_fill_proven: true,
        final_no_fill_proven: false,
        venue_order_readback_proven: true,
        venue_order_status: "filled",
        execution_configuration_proven: true,
        margin_mode: "isolated",
        leverage: 1,
        market_data_freshness_proven: true,
        market_slippage_bound_proven: true,
        market_source_age_ms: 350,
        market_max_age_ms: 2_000,
        action_expiry_proven: true,
        position_protection_proven: true,
        protection_grouping: "normalTpsl",
        protection_trigger_source: "mark",
        protection_trigger_order_type: "bounded_limit",
        fill_status: "full",
        fill_count: 1,
        filled_notional_usd: 11,
        fee_paid: true,
        ioc_remainder_terminal: true,
        raw_worker_receipt_commitment: digest(tradeId + "-raw-worker"),
        order_commitment: digest(tradeId + "-entry-order"),
        transaction_commitment: digest(tradeId + "-entry-transaction"),
        fill_evidence_commitment: digest(tradeId + "-entry-fill"),
        completed_at: fillAt,
      },
    },
    post_entry_state: {
      source: "hyperliquid_public_info",
      account_address_commitment: account,
      position_count: 1,
      hype_position_nonzero: true,
      open_order_count: 2,
      hype_open_order_count: 2,
      protection_order_count: 2,
      snapshot_commitment: digest(tradeId + "-open"),
      checked_at: openAt,
    },
    close: {
      route: "/v1/private-account/hyperliquid/positions/close",
      idempotency_commitment: digest(tradeId + "-close-idempotency"),
      wallet_step_up_proof_commitment: digest(tradeId + "-wallet-step-up"),
      submitted_at: closeSubmittedAt,
      claims: [claim(
        closeWorkOrder,
        digest(tradeId + "-close-claim-receipt"),
        closeCompletedAt,
        tradeId + "-close",
      )],
      report: {
        sanitized: true,
        version: 1,
        proof_kind: "hyperliquid_position_close_v1",
        status: "reconciled",
        network: "mainnet",
        markets: ["HYPE"],
        initial_position_count: 1,
        initial_open_order_count: 2,
        cancellations: [],
        closes: [{
          market: "HYPE",
          work_order_commitment: closeWorkOrder,
          order_commitment: digest(tradeId + "-close-order"),
          terminal_status: "filled",
          reduce_only: true,
          fill_count_bucket: "1",
          fill_evidence_commitment: digest(tradeId + "-close-fill"),
          venue_readback_proven: true,
          replay_protected: true,
        }],
        reduce_only_exit_proven: true,
        cancellations_terminal: true,
        market_flat: true,
        account_flat: true,
        open_order_count: 0,
        final_flat_proven: true,
        reconciled_at: offset(closeCompletedAt, -1),
        completed_at: closeCompletedAt,
        root_work_order_commitment: closeRoot,
        worker_evidence_commitment: digest(tradeId + "-worker-close-evidence"),
        report_commitment: digest(tradeId + "-close-report"),
      },
    },
    final_state: flatVenueState(account, finalAt, tradeId + "-final"),
  };
}

function noFillAttempt(label, submittedAt) {
  const planDigest = digest(label + "-plan");
  const workOrder = terminalWork(label);
  const receiptCommitment = digest(label + "-receipt");
  const completedAt = offset(submittedAt, 5);
  return {
    plan_digest: planDigest,
    preview_commitment: digest(label + "-preview"),
    idempotency_commitment: digest(label + "-idempotency"),
    submitted_at: submittedAt,
    retry_authorized_after_terminal_no_fill: true,
    gateway_ack: {
      sanitized: true,
      outcome: "acknowledged",
      status: "reconciled",
      dispatch: "dispatched",
      fill_proof: false,
      plan_digest: planDigest,
      response_plan_digest: planDigest,
      work_order_commitment: workOrder,
      receipt_commitment: receiptCommitment,
      result_commitment: digest(label + "-result"),
    },
    claim: claim(workOrder, receiptCommitment, completedAt, label),
    terminal_receipt: {
      sanitized: true,
      proof_kind: "hyperliquid_execution_proof_v1",
      network: "mainnet",
      market: "HYPE",
      work_order_commitment: workOrder,
      terminal_status: "canceled",
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: false,
      final_no_fill_proven: true,
      venue_order_readback_proven: true,
      ioc_remainder_terminal: true,
      raw_worker_receipt_commitment: digest(label + "-raw-worker"),
      order_commitment: digest(label + "-order"),
      completed_at: completedAt,
    },
  };
}

function claim(workOrder, receiptCommitment, checkedAt, label) {
  return {
    work_order_commitment: workOrder,
    store: "postgres",
    namespace: "worker_execution_claims",
    attempt_store: "worker_execution_attempts",
    receipt_store: "worker_idempotency",
    status: "completed",
    exact_request_binding: true,
    replay_protected: true,
    unresolved: false,
    request_digest_commitment: digest(label + "-request"),
    claim_commitment: digest(label + "-claim"),
    receipt_commitment: receiptCommitment,
    checked_at: checkedAt,
  };
}

function entitlement(checkedAt) {
  return {
    tier: "private_agent",
    access_source: "complimentary_pass",
    expires_at: "2026-08-20T16:00:00.000Z",
    checked_at: checkedAt,
    private_agent_compute: {
      remaining_seconds: 3_600,
      active_agent_limit: 1,
      active_agent_count: 0,
    },
    private_agent_trading: {
      live_trading_allowed: true,
      cap_reached: false,
      remaining_included_notional_micro_usd: 44_000_000,
      overage_fee_bps: 0,
      period_end: "2026-09-01T00:00:00.000Z",
    },
  };
}

function readyAccess(owner, identity, checkedAt, label) {
  return {
    source_path: "/v1/private-account/live-trading/terminal-access",
    authenticated_owner_commitment: owner,
    version: 1,
    status: "green",
    venue_id: "hyperliquid",
    network: "mainnet",
    opening_orders_enabled: true,
    access_mode: "account_canary",
    launch_state: "canary",
    release_identity: identity,
    live_worker_readiness: {
      ready: true,
      endpoint_configured: true,
      contract_version: 2,
      worker_git_sha: identity.worker_git_sha,
      worker_image_digest: identity.worker_image_digest,
      config_fingerprint: identity.config_fingerprint,
      capabilities: ["limit_order", "stop_loss", "take_profit"],
      reason_codes: [],
      checked_at: checkedAt,
    },
    effective_caps: canonicalCaps(),
    configured_capabilities: requiredCapabilities(),
    required_capabilities: ["limit_order", "stop_loss", "take_profit"],
    authorized_capabilities: ["limit_order", "stop_loss", "take_profit"],
    account_requirements: {
      account_ready: true,
      vault_ready: true,
      eligibility_ready: true,
      entitlement_ready: true,
      graduation_ready: true,
    },
    graduation_completed_at: "2026-08-19T15:02:00.000Z",
    reason_codes: [],
    access_commitment: gholaId("live_trading_terminal_access", label),
    checked_at: checkedAt,
  };
}

function blockedAccess(label, identity) {
  return {
    source_path: "/v1/private-account/live-trading/terminal-access",
    authenticated_owner_commitment: digest(label + "-uninvited-owner"),
    version: 1,
    status: "red",
    venue_id: "hyperliquid",
    network: "mainnet",
    opening_orders_enabled: false,
    access_mode: "blocked",
    launch_state: "canary",
    release_identity: identity,
    live_worker_readiness: null,
    effective_caps: canonicalCaps(),
    configured_capabilities: requiredCapabilities(),
    required_capabilities: ["limit_order", "stop_loss", "take_profit"],
    authorized_capabilities: [],
    account_requirements: {
      account_ready: false,
      vault_ready: false,
      eligibility_ready: false,
      entitlement_ready: false,
      graduation_ready: false,
    },
    graduation_completed_at: null,
    reason_codes: ["private_account_required"],
    access_commitment: gholaId("live_trading_terminal_access", label + "-blocked"),
    checked_at: "2026-08-19T15:58:00.000Z",
  };
}

function proofReceipt(proofId, root, completedAt) {
  return {
    sanitized: true,
    ok: true,
    status: "filled",
    network: "mainnet",
    market: "HYPE",
    notional_usd: 11,
    max_slippage_bps: 100,
    claim_store: "postgres",
    claim_namespace: "hl_mainnet_investor_proof_v2",
    proof_work_order_commitment: root,
    entry_work_order_commitment: root + "_entry",
    exit_work_order_commitment: root + "_exit",
    receipt_commitment: digest(proofId + "-receipt"),
    result_commitment: digest(proofId + "-result"),
    venue_evidence_commitment: digest(proofId + "-venue"),
    entry_order_commitment: digest(proofId + "-entry-order"),
    exit_order_commitment: digest(proofId + "-exit-order"),
    entry_transaction_commitment: digest(proofId + "-entry-tx"),
    exit_transaction_commitment: digest(proofId + "-exit-tx"),
    preflight_verified: true,
    preflight_transaction_broadcast: false,
    exit_preflight_verified: true,
    exit_preflight_transaction_broadcast: false,
    api_wallet_authorization_verified: true,
    duplicate_entry_prevented: true,
    duplicate_exit_prevented: true,
    stored_receipt_replayed: true,
    isolated_margin: true,
    leverage: 1,
    entry_fill_proven: true,
    exit_fill_proven: true,
    reduce_only_exit_proven: true,
    position_protection_proven: true,
    protection_cleanup_confirmed: true,
    protection_children_terminal: true,
    independent_venue_evidence_proven: true,
    transaction_hashes_distinct: true,
    fees_paid: true,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    account_graduated: true,
    completed_at: completedAt,
  };
}

function flatVenueState(account, checkedAt, label) {
  return {
    source: "hyperliquid_public_info",
    account_address_commitment: account,
    position_count: 0,
    open_order_count: 0,
    hype_position_size: "0",
    hype_open_order_count: 0,
    snapshot_commitment: digest(label),
    checked_at: checkedAt,
  };
}

function rawProofReport() {
  const root = "hl_mainnet_investor_proof_v2_" + hash("raw-proof").slice(0, 32);
  const entry = {
    oid: "123456",
    cloid: "0x" + hash("entry-cloid").slice(0, 32),
    fee_usd: 0.01,
    transaction_hashes: ["0x" + hash("entry-transaction")],
  };
  const exit = {
    oid: "123457",
    cloid: "0x" + hash("exit-cloid").slice(0, 32),
    fee_usd: 0.01,
    transaction_hashes: ["0x" + hash("exit-transaction")],
  };
  return {
    ok: true,
    status: "filled",
    network: "mainnet",
    market: "HYPE",
    notional_usd: 11,
    max_slippage_bps: 100,
    claim_store: "postgres",
    proof_work_order_commitment: root,
    entry_work_order_commitment: root + "_entry",
    exit_work_order_commitment: root + "_exit",
    preflight_verified: true,
    preflight_transaction_broadcast: false,
    exit_preflight_verified: true,
    exit_preflight_transaction_broadcast: false,
    api_wallet_authorization_verified: true,
    api_wallet_address: "0x1111111111111111111111111111111111111111",
    duplicate_entry_prevented: true,
    duplicate_exit_prevented: true,
    stored_receipt_replayed: true,
    default_margin_mode: "isolated",
    default_leverage: 1,
    entry_fill_proven: true,
    exit_fill_proven: true,
    venue_position_protection_proven: true,
    protection_cleanup_confirmed: true,
    protection_children_terminal: true,
    independent_venue_evidence_proven: true,
    entry_order_reference: entry,
    exit_order_reference: exit,
    venue_evidence_commitment: digest("raw-venue-evidence"),
    venue_evidence: {
      entry,
      exit,
      reduce_only_exit_proven: true,
      transaction_hashes_distinct: true,
    },
    flat_after_exit: true,
    open_orders_after_exit: 0,
    account_graduated: true,
    completed_at: "2026-08-19T15:00:00.000Z",
  };
}

function rawCloseReport() {
  const root = "hl_close_" + hash("raw-close").slice(0, 40);
  return {
    version: 1,
    proof_kind: "hyperliquid_position_close_v1",
    status: "reconciled",
    network: "mainnet",
    markets: ["HYPE"],
    initial_position_count: 1,
    initial_open_order_count: 2,
    cancellations: [],
    closes: [{
      market: "HYPE",
      work_order_commitment: root + "_close_hype_1",
      venue_order_oid: "518475952911",
      venue_order_cloid: "0x" + hash("close-cloid").slice(0, 32),
      terminal_status: "filled",
      reduce_only: true,
      fill_count_bucket: "1",
      fill_evidence_commitment: gholaId("hl_fill_evidence", "close-fill"),
      venue_readback_proven: true,
      replay_protected: true,
    }],
    reduce_only_exit_proven: true,
    cancellations_terminal: true,
    market_flat: true,
    account_flat: true,
    open_order_count: 0,
    final_flat_proven: true,
    reconciled_at: "2026-08-19T15:11:19.000Z",
    completed_at: "2026-08-19T15:11:20.000Z",
    root_work_order_commitment: root,
    evidence_commitment: gholaId("hl_risk_evidence", "raw-close"),
  };
}

function canonicalCaps() {
  return {
    first_proof_notional_usd: 11,
    max_order_notional_usd: 100,
    rolling_24h_notional_usd: 500,
    default_slippage_bps: 50,
    max_slippage_bps: 100,
  };
}

function requiredCapabilities() {
  return ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"];
}

function terminalWork(label) {
  return "live_trade_work_order_" + hash(label).slice(0, 48);
}

function gholaId(prefix, label) {
  return prefix + "_" + hash(label).slice(0, 48);
}

function offset(value, seconds) {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function digest(label) {
  return "sha256:" + hash(label);
}

function hash(label) {
  return createHash("sha256").update(label).digest("hex");
}
