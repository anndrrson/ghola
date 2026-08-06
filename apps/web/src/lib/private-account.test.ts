import { describe, expect, it } from "vitest";
import {
  buildPrivateAccountReceipt,
  containsForbiddenPublicPrivateAccountField,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  isPrivateModeAvailableStatus,
  listPlatformPrivacyProfiles,
  previewPrivateAccountAction,
  requiresPrivateSettlementBinding,
} from "./private-account";

describe("private account anonymity engine", () => {
  it("allows full anonymity only when the private rail and anonymity set pass", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({
      action_class: "transfer",
      product_bucket: "stablecoin",
      now: new Date("2026-05-27T00:00:00.000Z"),
    });

    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
      now: new Date("2026-05-27T00:10:00.000Z"),
    });

    expect(preview.claim_status).toBe("private_mode_available");
    expect(isPrivateModeAvailableStatus(preview.claim_status)).toBe(true);
    expect(preview.anonymity_level).toBe("P3_anonymity_set");
    expect(preview.public_chain_sees).toBe("hidden");
  });

  it("refuses a Private Mode receipt without an evidence commitment", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "transfer" });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(() => buildPrivateAccountReceipt({
      preview,
      approval_commitment: "approval_1",
      execution_commitment: "exec_1",
    })).toThrow("private_mode_evidence_required");
  });

  it("never labels direct public Solana fallback as fully anonymous", () => {
    const action = createPrivateAccountAction({ action_class: "pay" });

    const preview = previewPrivateAccountAction({
      action,
      platform_class: "solana_public_wallet",
      requested_rail: "direct_public_fallback",
      anonymity_set: {
        effective: 100,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 0,
      },
    });

    expect(preview.claim_status).not.toBe("full_anonymity_available");
    expect(preview.public_chain_sees).toBe("visible");
    expect(preview.degraded_reasons).toContain("direct_public_fallback cannot satisfy Private Mode");
  });

  it("marks venue-visible markets as degraded even when source wallet is hidden", () => {
    const action = createPrivateAccountAction({ action_class: "trade_on_platform" });

    const preview = previewPrivateAccountAction({
      action,
      platform_class: "hyperliquid_style_market",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 100,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 0,
      },
    });

    expect(preview.claim_status).toBe("degraded_user_accepted_required");
    expect(preview.visible_to).toContain("executing venue");
    expect(preview.degraded_reasons).toContain("this platform will see the order");
  });

  it("blocks RFQ when the solver set is too small", () => {
    const action = createPrivateAccountAction({ action_class: "trade_on_platform" });

    const preview = previewPrivateAccountAction({
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_pool",
      anonymity_set: {
        effective: 80,
        solver_count: 1,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 0,
      },
    });

    expect(preview.claim_status).toBe("blocked_leaky_path");
    expect(preview.blocked_reasons).toContain("rfq solver set is below minimum");
  });

  it("labels RFQ shielded batch as full anonymity only with full preview evidence", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "rebalance" });

    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      connector_context: connectorContext(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(preview.claim_status).toBe("full_anonymity_available");
    expect(preview.anonymity_level).toBe("P5_selectively_disclosable");
    expect(preview.claim_levels_missing).toHaveLength(0);

    const noConnectorPreview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(noConnectorPreview.claim_status).toBe("private_mode_available");
  });

  it("blocks zero-front-run mode on non-auction rails", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "transfer" });

    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "solana_private_balance",
      requested_rail: "shielded_pool",
      front_run_mode: "zero_front_run",
      anonymity_set: {
        effective: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(preview.claim_status).toBe("blocked_leaky_path");
    expect(preview.blocked_reasons).toContain("zero-front-run mode requires shielded batch auction rail");
    expect(preview.front_run_protection.canLiveSubmitInZeroMode).toBe(false);
  });

  it("keeps zero-front-run shielded auctions pending until fair clearing evidence is bound", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "rebalance" });

    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      front_run_mode: "zero_front_run",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      connector_context: connectorContext(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(preview.claim_status).toBe("wait_for_anonymity");
    expect(preview.wait_reasons).toContain("zero-front-run certificate is not ready");
    expect(preview.front_run_protection).toMatchObject({
      kind: "blocked",
      label: "Zero-front-run pending",
      canLiveSubmitInZeroMode: false,
    });
  });

  it("certifies zero-front-run only when the auction proof and runtime attestation are bound", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "rebalance" });

    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      front_run_mode: "zero_front_run",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: zeroFrontRunEvidenceChain(),
      connector_context: connectorContext(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(preview.claim_status).toBe("full_anonymity_available");
    expect(preview.front_run_mode).toBe("zero_front_run");
    expect(preview.front_run_certificate_commitment).toMatch(/^front_run_certificate_[0-9a-f]{48}$/);
    expect(preview.front_run_protection).toMatchObject({
      kind: "zero_certified",
      zeroFrontRun: true,
      canLiveSubmitInZeroMode: true,
      certificateCommitment: preview.front_run_certificate_commitment,
    });
  });

  it("requires zero-front-run evidence on receipts", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "rebalance" });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      front_run_mode: "zero_front_run",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: zeroFrontRunEvidenceChain(),
      connector_context: connectorContext(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(() => buildPrivateAccountReceipt({
      preview,
      approval_commitment: "approval_1",
      execution_commitment: "exec_1",
      evidence_chain: fullReceiptEvidenceChain(),
    })).toThrow("zero_front_run_certificate_required");

    const receipt = buildPrivateAccountReceipt({
      preview,
      approval_commitment: "approval_1",
      execution_commitment: "exec_1",
      evidence_chain: fullReceiptEvidenceChain({
        front_run_certificate_commitment: preview.front_run_certificate_commitment,
      }),
    });

    expect(receipt.zero_front_run).toBe(true);
    expect(receipt.front_run_certificate_commitment).toBe(preview.front_run_certificate_commitment);
    expect(receipt.evidence_chain?.front_run_certificate_commitment).toBe(preview.front_run_certificate_commitment);
  });

  it("requires connector result evidence for full-anonymity RFQ receipts", () => {
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "rebalance" });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      anonymity_set: {
        effective: 75,
        solver_count: 5,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      },
      evidence_status: "ready",
      evidence_chain: evidenceChain(),
      connector_context: connectorContext(),
      sealed_runtime_context: sealedRuntime(),
      schedule_decision: scheduleDecision(),
      rotation: platformRotation(),
      linkability_simulation: linkabilitySimulation(),
      require_private_mode_evidence: true,
    });

    expect(preview.claim_status).toBe("full_anonymity_available");
    expect(requiresPrivateSettlementBinding(preview.selected_rail)).toBe(true);
    expect(() => buildPrivateAccountReceipt({
      preview,
      approval_commitment: "approval_1",
      execution_commitment: "exec_1",
      evidence_chain: fullReceiptEvidenceChain({
        work_order_commitment: null,
        connector_result_commitment: null,
      }),
    })).toThrow("full_anonymity_connector_result_required");

    const receipt = buildPrivateAccountReceipt({
      preview,
      approval_commitment: "approval_1",
      execution_commitment: "exec_1",
      evidence_chain: fullReceiptEvidenceChain(),
    });

    expect(receipt.result).toBe("executed");
    expect(receipt.claim_status).toBe("full_anonymity_available");
    expect(receipt.settlement_commitment).toBe("settlement_test");
    expect(receipt.connector_result_commitment).toBe("connector_result_test");
  });

  it("keeps public platform profiles commitment-only", () => {
    // 6 CEX/RFQ profiles + 2 venue profiles (hyperliquid_style_market,
    // solana_perps_market) added for private venue trading.
    expect(listPlatformPrivacyProfiles()).toHaveLength(8);
    expect(
      containsForbiddenPublicPrivateAccountField({
        platform_class: "coinbase_style_provider",
        provider_account_id: "acct_raw",
      }),
    ).toBe(true);
  });
});

function evidenceChain() {
  return {
    version: 1 as const,
    funding_import_commitment: "funding_import_test",
    batch_id: "batch_test",
    batch_evidence_commitment: "anon_evidence_test",
    preview_commitment: "pending",
    approval_commitment: null,
    execution_commitment: null,
  };
}

function zeroFrontRunEvidenceChain() {
  return {
    ...evidenceChain(),
    auction_epoch_commitment: "auction_epoch_test",
    auction_order_commitment: "auction_order_test",
    clearing_commitment: "clearing_test",
    auction_settlement_commitment: "auction_settlement_test",
    proof_commitment: "proof_test",
    finality_commitment: "finality_test",
    runtime_attestation_commitment: "runtime_attestation_test",
  };
}

function fullReceiptEvidenceChain(overrides: {
  work_order_commitment?: string | null;
  connector_result_commitment?: string | null;
  front_run_certificate_commitment?: string | null;
} = {}) {
  return {
    ...zeroFrontRunEvidenceChain(),
    execution_plan_commitment: "plan_test",
    approval_commitment: "approval_1",
    execution_commitment: "exec_1",
    settlement_commitment: "settlement_test",
    manifest_commitment: "connector_manifest_test",
    connector_readiness_commitment: "connector_readiness_test",
    compiler_commitment: "compiler_test",
    linkability_score_commitment: "linkability_score_test",
    work_order_commitment: overrides.work_order_commitment === undefined
      ? "work_order_test"
      : overrides.work_order_commitment,
    connector_result_commitment: overrides.connector_result_commitment === undefined
      ? "connector_result_test"
      : overrides.connector_result_commitment,
    runtime_envelope_commitment: "runtime_envelope_test",
    runtime_attestation_commitment: "runtime_attestation_test",
    runtime_health_commitment: "runtime_health_test",
    schedule_commitment: "privacy_schedule_test",
    rotation_commitment: "platform_rotation_test",
    simulator_commitment: "adversarial_linkability_simulator_test",
    front_run_certificate_commitment: overrides.front_run_certificate_commitment,
  };
}

function connectorContext() {
  return {
    version: 1 as const,
    manifest_commitment: "connector_manifest_test",
    connector_readiness_commitment: "connector_readiness_test",
    compiler_commitment: "compiler_test",
    linkability_score_commitment: "linkability_score_test",
    sandbox_policy_commitment: "sandbox_policy_test",
    connector_status: "ready" as const,
    linkability_decision: "proceed" as const,
    main_wallet_exposed: false,
    venue_order_visibility: "ticket_only" as const,
    public_chain_settlement_visibility: "hidden" as const,
    venue_access_source: "partner_omnibus" as const,
    ghola_access_role: "private_execution_router" as const,
    venue_gate: "partner_accepts_or_rejects_order" as const,
    venue_visibility: "ticket_only" as const,
    source_wallet_visibility: "not_exposed_to_public_chain_by_ghola" as const,
    privacy_claim: "private_mode_available" as const,
    reason_codes: [],
  };
}

function sealedRuntime() {
  return {
    version: 1 as const,
    runtime_status: "ready" as const,
    runtime_mode: "local_test" as const,
    runtime_envelope_commitment: "runtime_envelope_test",
    runtime_attestation_commitment: "runtime_attestation_test",
    runtime_measurement_commitment: "runtime_measurement_test",
    runtime_policy_commitment: "runtime_policy_test",
    runtime_health_commitment: "runtime_health_test",
    runtime_observed_at: "2026-05-27T00:00:00.000Z",
    reason_codes: [],
  };
}

function scheduleDecision() {
  return {
    version: 1 as const,
    schedule_commitment: "privacy_schedule_test",
    mode: "ready_now" as const,
    status: "ready" as const,
    privacy_window_commitment: "privacy_window_test",
    execute_after: null,
    reason_codes: [],
  };
}

function platformRotation() {
  return {
    version: 1 as const,
    rotation_commitment: "platform_rotation_test",
    platform_funding_account_commitment: "platform_funding_account_test",
    rotation_epoch_commitment: "platform_rotation_epoch_test",
    reuse_count: 0,
    withdrawal_destination_reuse_count: 0,
    status: "ready" as const,
    reason_codes: [],
  };
}

function linkabilitySimulation() {
  return {
    version: 1 as const,
    simulator_commitment: "adversarial_linkability_simulator_test",
    score_bps: 0,
    decision: "proceed" as const,
    actors: {
      chain_observer: 0,
      venue: 0,
      solver: 0,
      provider: 0,
      colluding_platforms: 0,
    },
    reason_codes: [],
    simulated_at: "2026-05-27T00:00:00.000Z",
  };
}
