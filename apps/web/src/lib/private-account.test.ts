import { describe, expect, it } from "vitest";
import {
  buildPrivateAccountReceipt,
  containsForbiddenPublicPrivateAccountField,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  isPrivateModeAvailableStatus,
  listPlatformPrivacyProfiles,
  previewPrivateAccountAction,
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
