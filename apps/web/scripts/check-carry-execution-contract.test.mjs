import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY_RELEASE_FILES,
  checkCarryExecutionContract,
  findUntrackedCarryReleaseFiles,
  loadCarryReleaseSources,
} from "./check-carry-execution-contract.mjs";

const sources = loadCarryReleaseSources();

test("accepts the complete cross-venue Carry execution contract", () => {
  assert.equal(checkCarryExecutionContract(sources).ok, true);
});

test("rejects a full-book scan without its composite database index", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        "idx_worker_carry_positions_owner_status_scan",
        "idx_worker_carry_positions_owner_status_legacy",
      ),
    }),
    /carry_record_scan_composite_index_missing/,
  );
});

test("rejects background Carry failures that are no longer supervised", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      loopSupervisor: sources.loopSupervisor.replaceAll("consecutive_failures", "ignored_failures"),
    }),
    /carry_loop_health_state_missing/,
  );
});

test("rejects supervision that cannot detect a silently stalled loop", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      loopSupervisor: sources.loopSupervisor.replace('status: "stalled"', 'status: "healthy"'),
    }),
    /carry_loop_stall_detection_missing/,
  );
});

test("rejects release proof that accepts manual-only monitoring", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        'event?.observation_source === "supervised_loop"',
        'event?.observation_source === "manual"',
      ),
    }),
    /carry_release_supervised_monitoring_missing/,
  );
});

test("rejects release proof that accepts one unattended observation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "automaticObservations >= 2",
        "automaticObservations >= 1",
      ),
    }),
    /carry_release_monitoring_cadence_verifier_missing/,
  );
});

test("rejects release proof that ignores monitoring outages", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "supervision.failure_count === 0",
        "supervision.failure_count >= 0",
      ),
    }),
    /carry_release_monitoring_outage_verifier_missing/,
  );
});

test("rejects release proof that invents an unmeasured exit reason", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll("verifyExitTrigger", "trustExitLabel"),
    }),
    /carry_release_exit_trigger_verifier_missing/,
  );
});

test("rejects live Carry entry that ignores degraded supervision", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("carry_supervision_not_ready", "carry_entry_allowed_anyway"),
    }),
    /carry_entry_supervision_gate_missing/,
  );
});

test("rejects an automatic-exit loop that never retries its failed restart audit", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replace(
        "const audit = await ensureRestartAudit()",
        "const audit = await ready",
      ),
    }),
    /carry_restart_audit_retry_missing/,
  );
});

test("rejects carry entry without durable adverse funding evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      fundingPersistence: sources.fundingPersistence.replaceAll(
        '"funding_not_persistent"',
        '"funding_tick_accepted"',
      ),
    }),
    /carry_funding_flip_entry_gate_missing/,
  );
});

test("rejects a Carry venue contract that omits no-submit reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      registry: sources.registry.replace(
        '"carry_execution",\n  "no_submit_reconciliation",\n  "exact_quantity_recovery",',
        '"carry_execution",\n  "exact_quantity_recovery",',
      ),
    }),
    /carry_required_adapter_contract_missing/,
  );
});

test("rejects private-account policy that drifts from the Carry registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivateAccount: sources.webPrivateAccount.replaceAll(
        "if (isCarryExecutionVenue(venueId))",
        'if (venueId === "hyperliquid")',
      ),
    }),
    /private_account_policy_registry_missing/,
  );
});

test("rejects credential onboarding that duplicates the Carry venue union", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCredentialOnboarding: sources.webCredentialOnboarding.replace(
        "export type CredentialOnboardingVenue = CarryExecutionVenue",
        'export type CredentialOnboardingVenue = "hyperliquid" | "lighter" | "aster"',
      ),
    }),
    /carry_onboarding_registry_type_missing/,
  );
});

test("rejects coupling public Carry intelligence back to private execution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replace(
        "const worker = carryShadowWorkerConfig();",
        "const worker = workerConfig();",
      ),
    }),
    /carry_public_shadow_worker_boundary_missing/,
  );
});

test("rejects private Carry polling before Ghola authentication", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        "const privateSessionReady = auth.authenticated && !auth.loading;",
        "const privateSessionReady = true;",
      ),
    }),
    /carry_private_poll_auth_gate_missing/,
  );
});

test("rejects qualification evidence not bound to the deployed image", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      qualification: sources.qualification.replaceAll("image_digest: imageDigest", "image_digest: null"),
    }),
    /qualification_image_binding_missing/,
  );
});

test("rejects final flat evidence that is not bound to the exact venue account", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      reconciliation: sources.reconciliation.replaceAll(
        "carry_reconciliation_account_binding_mismatch",
        "carry_reconciliation_account_not_checked",
      ),
    }),
    /carry_reconciliation_account_lineage_gate_missing/,
  );
});

test("rejects removal of separate live qualification confirmation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replaceAll("carry_qualification_pilot_confirmation_required", "confirmation_removed"),
    }),
    /pilot_confirmation_gate_missing/,
  );
});

test("rejects a preview compose that can advertise an inactive Carry pilot", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      phalaConfig: sources.phalaConfig.replaceAll("expectedCarryWorkerConfig", "carryConfigRemoved"),
    }),
    /carry_runtime_config_missing|carry_runtime_drift_gate_missing/,
  );
});

test("rejects onboarding that loses its exact signed preparation on refresh", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll("readCarryOnboardingRecovery", "recoveryRemoved"),
    }),
    /carry_setup_recovery_restore_missing/,
  );
});

test("rejects onboarding recovery without an exact account binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webOnboardingRecovery: sources.webOnboardingRecovery.replaceAll(
        "preparation.account_commitment === accountCommitment",
        "Boolean(preparation.account_commitment)",
      ),
    }),
    /carry_setup_recovery_account_binding_missing/,
  );
});

test("rejects Hyperliquid setup that skips the remaining Carry venues", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "return_to=${encodeURIComponent(setupReturnTo)}",
        "return_to=${encodeURIComponent(safeReturnTo)}",
      ),
    }),
    /hyperliquid_setup_carry_resume_missing/,
  );
});

test("rejects a Carry setup screen that restores three independent venue choices", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll("carryAccountSetupNextAction", "removedGuidedAction"),
    }),
    /carry_setup_guided_action_ui_missing/,
  );
});

test("rejects Carry onboarding that drops the selected pair scope", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "carryAccountConnectionProgressForVenues",
        "carryAccountConnectionProgress",
      ),
    }),
    /carry_setup_pair_scope_missing/,
  );
});

test("rejects Carry onboarding that does not bind the pair to its terminal return", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replace(
        "carryExecutionPairFromReturnTo(safeReturnTo)",
        "null",
      ),
    }),
    /carry_setup_pair_return_binding_missing/,
  );
});

test("rejects a terminal that does not bind setup to its selected pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "long_venue=${encodeURIComponent(candidate.long.venue_id)}",
        "long_venue=hyperliquid",
      ),
    }),
    /carry_terminal_pair_setup_binding_missing/,
  );
});

test("rejects a terminal that does not restore its selected pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        "&carry=open&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}",
        "&carry=open",
      ),
    }),
    /carry_terminal_pair_return_binding_missing/,
  );
});

test("rejects a terminal rail that can execute aged routes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace("const freshCandidates", "const visibleCandidates"),
    }),
    /carry_ui_execution_stale_route_gate_missing/,
  );
});

test("rejects a headline route that can diverge from the executable builder", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace("selectedExecution || selectedObserved", "selectedObserved"),
    }),
    /carry_primary_rail_execution_alignment_missing/,
  );
});

test("rejects a headline that hides execution versus shadow status", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(
        '{routeMode === "execution" ? "EXEC" : "SHADOW"}',
        '"XVENUE"',
      ),
    }),
    /carry_primary_rail_visible_route_mode_missing/,
  );
});

test("rejects a missing exact-reconciliation adapter", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replaceAll("submitAndReconcileLighterExecution", "submitLighterOnly"),
    }),
    /lighter_exact_reconcile_missing/,
  );
});

test("rejects five-venue shadow qualification based on one lucky snapshot", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifierCli: sources.shadowVerifierCli.replaceAll(
        "verifyCarryShadowSoak(sampleResults",
        "acceptOneShadowSample(sampleResults",
      ),
    }),
    /carry_shadow_soak_cli_missing/,
  );
});

test("rejects release qualification that is not persistent and image-bound", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowQualification: sources.shadowQualification
        .replaceAll("PHALA_CVM_IMAGE_DIGEST", "UNBOUND_IMAGE")
        .replaceAll("sample_results: sampleResults", "sample_results: []"),
    }),
    /carry_shadow_qualification_image_binding_missing|carry_shadow_qualification_persistence_missing/,
  );
});

test("rejects a terminal that relabels unbound market data as qualified", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll(
        "CARRY_SHADOW_QUALIFICATION_COMMITMENT",
        "IGNORED_SHADOW_COMMITMENT",
      ),
    }),
    /carry_market_qualification_commitment_gate_missing/,
  );
});

test("rejects five-venue shadow evidence without exact sample commitments", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "shadow_soak_sample_commitment_invalid",
        "shadow_soak_sample_commitment_ignored",
      ),
    }),
    /carry_shadow_sample_commitment_gate_missing/,
  );
});

test("rejects durable five-venue qualification that can promote degraded economics", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "shadow_soak_snapshot_not_ready",
        "shadow_soak_snapshot_degraded_but_accepted",
      ),
    }),
    /carry_shadow_degraded_qualification_gate_missing/,
  );
});

test("rejects five-venue shadow qualification without liquidity-depth validation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "liquidity_depth_missing",
        "liquidity_depth_ignored",
      ),
    }),
    /carry_shadow_liquidity_depth_gate_missing/,
  );
});

test("rejects five-venue shadow qualification without component freshness validation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "source_observation_stale",
        "source_observation_ignored",
      ),
    }),
    /carry_shadow_component_freshness_gate_missing/,
  );
});

test("rejects five-venue shadow evidence with an unaudited missing-field manifest", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "missing_field_manifest_mismatch",
        "missing_field_manifest_trusted",
      ),
    }),
    /carry_shadow_missing_manifest_gate_missing/,
  );
});

test("rejects five-venue shadow evidence without economic bounds validation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "normalized_field_invalid",
        "normalized_field_trusted",
      ),
    }),
    /carry_shadow_economic_bounds_gate_missing/,
  );
});

test("rejects Hyperliquid shadow data without no-clearance-fee provenance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll("liquidation_has_no_clearance_fee", "liquidation_fee_assumed"),
    }),
    /hyperliquid_liquidation_fee_evidence_gate_missing/,
  );
});

test("rejects public Aster economics that lose their base-schedule provenance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll("fees_venue_base_schedule", "fees_unproven"),
    }),
    /aster_base_fee_provenance_missing/,
  );
});

test("rejects dYdX economics that lose their live chain provenance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll("fees_chain_parameter_ceiling", "fees_unproven"),
    }),
    /dydx_chain_fee_provenance_missing/,
  );
});

test("rejects dYdX economics without independent chain-source consensus", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll("fees_chain_source_consensus", "fees_chain_single_source"),
    }),
    /dydx_chain_fee_consensus_missing/,
  );
});

test("rejects release without a joined three-venue no-submit matrix", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("preflightCarryExecutionMatrix", "preflightOnePairOnly"),
    }),
    /carry_three_venue_no_submit_matrix_missing/,
  );
});

test("rejects executable Carry preflight that bypasses the shared shadow contract", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "verifyCarryShadowSnapshot",
        "acceptNarrowShadowSnapshot",
      ),
    }),
    /carry_preflight_shared_shadow_contract_missing/,
  );
});

test("rejects Carry qualification that accepts numeric fees without provenance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "trustedAccountFeeEvidence",
        "trustNumericAccountFee",
      ),
    }),
    /carry_account_fee_provenance_gate_missing/,
  );
});

test("rejects release without a positive three-venue no-submit HTTP proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      serverTest: sources.serverTest.replaceAll(
        "proves the three-venue no-submit matrix and durable exact account state over HTTP",
        "skips the three-venue no-submit HTTP boundary",
      ),
    }),
    /carry_three_venue_no_submit_http_proof_missing/,
  );
});

test("rejects a three-venue matrix that does not verify every unique pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("allVenuePairs(orderedVenues)", "anchorPairs(orderedVenues)"),
    }),
    /carry_all_pair_no_submit_matrix_missing/,
  );
});

test("rejects a three-venue matrix that discards successful evidence when one pair fails", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("Promise.allSettled(pairs.map", "Promise.all(pairs.map"),
    }),
    /carry_no_submit_pair_fault_isolation_missing/,
  );
});

test("rejects a matrix gateway that discards partial venue readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replaceAll("workerMatrixVenueAccess", "workerVenueAccess"),
    }),
    /carry_partial_matrix_gateway_missing/,
  );
});

test("rejects a matrix worker that accepts unsanitized not-ready venue markers", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("non-ready venue access must be sanitized", "non-ready venue access accepted"),
    }),
    /carry_matrix_not_ready_marker_sanitization_missing/,
  );
});

test("rejects partial matrix evidence that can be reused as readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll("reusable_for_readiness: false", "reusable_for_readiness: true"),
    }),
    /carry_partial_matrix_diagnostic_authority_boundary_missing/,
  );
});

test("rejects a terminal that forgets diagnostic fleet evidence after refresh", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("readyStoredDiagnostic", "discardStoredDiagnostic"),
    }),
    /carry_terminal_diagnostic_restore_missing/,
  );
});

test("rejects a no-submit receipt that is not bound to the verified account", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "carry_account_verification_mismatch",
        "carry_account_match_not_checked",
      ),
    }),
    /carry_no_submit_account_match_gate_missing/,
  );
});

test("rejects three-venue readiness without receipt-bound exact account state", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        "carry_readiness_leg_account_state_invalid",
        "carry_readiness_leg_account_state_ignored",
      ),
    }),
    /carry_no_submit_account_state_validation_missing/,
  );
});

test("rejects a three-venue check that can claim readiness without durable deployment-bound evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("storeCarryExecutionReadiness", "returnTransientReadiness"),
    }),
    /carry_three_venue_readiness_persistence_missing/,
  );
});

test("rejects durable readiness that can outlive its freshness window", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll("carry_readiness_stale", "carry_readiness_accepted"),
    }),
    /carry_readiness_freshness_gate_missing/,
  );
});

test("rejects a terminal that discards fresh readiness after refresh", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("getCarryExecutionReadiness", "discardCarryExecutionReadiness"),
    }),
    /carry_terminal_readiness_restore_missing/,
  );
});

test("rejects reconnecting no-submit verification to deposited capital", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replace(
        "const noSubmitReady = connectionReady && (!monitoring || monitoringReady);",
        "const noSubmitReady = connectionReady && capitalReady && (!monitoring || monitoringReady);",
      ),
    }),
    /carry_capital_free_no_submit_missing/,
  );
});

test("rejects live Carry creation that ignores exact capital readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("&& modeled.capital_ready", "&& true"),
    }),
    /carry_live_capital_gate_missing/,
  );
});

test("rejects durable readiness that drops exact owner-funded shortfalls", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll("opening_collateral_shortfall_micro_usdc", "capital_gap"),
    }),
    /carry_readiness_shortfall_binding_missing/,
  );
});

test("rejects capital planning that advertises releasable collateral while funding is short", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "account.opening_collateral_shortfall_micro_usdc === 0",
        "true",
      ),
    }),
    /carry_unfunded_releasable_collateral_gate_missing/,
  );
});

test("rejects margin runway that double-counts venue-reported maintenance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "Math.max(reportedMaintenance, contractMaintenanceFloor)",
        "reportedMaintenance + contractMaintenanceFloor",
      ),
    }),
    /carry_maintenance_double_count_gate_missing/,
  );
});

test("rejects a terminal that hides a safe unfunded connection result", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        "exact owner funding shortfall shown; no order submitted",
        "not ready",
      ),
    }),
    /carry_terminal_capital_free_status_missing/,
  );
});

test("rejects an opening capital packet that could move funds", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("automatic_transfer_permitted: false", "automatic_transfer_permitted: true"),
    }),
    /carry_opening_transfer_boundary_missing/,
  );
});

test("rejects portfolio capital allocation without its owner-only authority gate", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_portfolio_capital_position_authority_boundary",
        "portfolio_capital_boundary_removed",
      ),
    }),
    /carry_portfolio_capital_authority_gate_missing/,
  );
});

test("rejects collateral review approval without durable replay protection", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll("state.consumeCapabilityJti", "acceptReusableReview"),
    }),
    /carry_collateral_review_replay_gate_missing/,
  );
});

test("rejects portfolio capital planning that stops aggregating shared venue accounts", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replace(
        "const accountGroups = new Map();",
        "const accountGroupsRemoved = new Map();",
      ),
    }),
    /carry_portfolio_capital_account_aggregation_missing/,
  );
});

test("rejects capital evidence that loses its sealed account scope", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "account_commitment: access.account_commitment",
        "account_commitment: undefined",
      ),
    }),
    /carry_capital_account_scope_missing/,
  );
});

test("rejects a portfolio value report without its no-transfer authority gate", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_portfolio_value_capital_authority_boundary",
        "portfolio_value_authority_removed",
      ),
    }),
    /carry_portfolio_value_authority_gate_missing/,
  );
});

test("rejects a stress-capital proposal that silently changes live leverage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("live_execution_leverage_unchanged: true", "live_execution_leverage_unchanged: false"),
    }),
    /carry_stress_leverage_boundary_missing/,
  );
});

test("rejects Carry preflight without exact owner binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("carry_account_owner_mismatch", "carry_account_ready"),
    }),
    /carry_preflight_owner_binding_missing/,
  );
});

test("rejects Carry preflight without a cross-venue market-data skew veto", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("carry_market_data_skew_exceeded", "carry_market_data_accepted"),
    }),
    /carry_market_data_skew_gate_missing/,
  );
});

test("rejects Carry preflight that assumes same ticker means equivalent contracts", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("carry_contract_equivalence_failed", "carry_contracts_assumed_equivalent"),
    }),
    /carry_contract_equivalence_gate_missing/,
  );
});

test("rejects a terminal that hides cross-venue source synchronization", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="SOURCE SYNC"', 'label="DATA"'),
    }),
    /carry_terminal_source_sync_missing/,
  );
});

test("rejects a terminal that hides index-basis evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="INDEX BASIS"', 'label="PAIR"'),
    }),
    /carry_terminal_index_basis_missing/,
  );
});

test("rejects release evidence without durable one-submit counters", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll("attempt?.submit_count !== 1", "false"),
    }),
    /carry_release_submit_count_gate_missing/,
  );
});

test("rejects a monitor that treats unverifiable margin runway as safe", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("margin_runway_unverifiable", "margin_runway_healthy"),
    }),
    /margin_runway_unverifiable_exit_missing/,
  );
});

test("rejects a capital planner that could grant automatic transfer authority", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_capital_automatic_transfer_forbidden",
        "carry_capital_transfer_allowed",
      ),
    }),
    /carry_capital_transfer_boundary_missing/,
  );
});

test("rejects monitoring that omits the deterministic capital action plan", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll("compileCarryCapitalActionPlan", "ignoreCarryCapitalRisk"),
    }),
    /carry_monitor_capital_plan_missing/,
  );
});

test("rejects a terminal that hides the owner-only capital action", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="OWNER CAPITAL"', 'label="STATUS"'),
    }),
    /carry_terminal_capital_action_missing/,
  );
});

test("rejects a terminal that hides the stress-adjusted owner capital plan", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("STRESS CAPITAL ·", "CAPITAL ·"),
    }),
    /carry_terminal_stress_capital_missing/,
  );
});

test("rejects serial Carry monitoring that lets one venue stall every position", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replace("mapConcurrentOrdered(records, concurrency", "mapSerially(records"),
    }),
    /carry_monitor_bounded_concurrency_missing/,
  );
});

test("rejects serial funding-history reads across Carry legs", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "const venueReads = await Promise.all",
        "const venueReads = await seriallyRead",
      ),
    }),
    /carry_funding_parallel_read_missing/,
  );
});

test("rejects release without an unattended monitor-to-flat lifecycle proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lifecycleTest: sources.lifecycleTest.replaceAll(
        "background monitoring triggers an automatic reduce-only exit and finalizes flat value evidence",
        "manual exit only",
      ),
    }),
    /carry_automatic_exit_lifecycle_test_missing/,
  );
});

test("rejects an executor proven only for one hard-coded venue pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lifecycleTest: sources.lifecycleTest.replaceAll(
        "executes every qualified Hyperliquid, Lighter, and Aster pair through one contract",
        "executes one preferred pair",
      ),
    }),
    /carry_three_venue_pair_contract_test_missing/,
  );
});

test("rejects full lifecycle recovery proven for only one venue pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lifecycleTest: sources.lifecycleTest.replaceAll(
        "completes a supervised restart-to-flat lifecycle for every qualified venue pair",
        "completes one preferred lifecycle",
      ),
    }),
    /carry_three_venue_full_lifecycle_matrix_missing/,
  );
});

test("rejects Carry vault verification outside its exact account binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        "if (opened.associatedDataText !== expectedAad)",
        "if (false)",
      ),
    }),
    /carry_execution_vault_exact_aad_missing/,
  );
});

test("rejects restart recovery that cannot distinguish pre-submit from ambiguity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreMultiLeg: sources.coreMultiLeg.replaceAll("cancel_before_submit", "retry_after_restart"),
    }),
    /carry_pre_submit_cancel_event_missing/,
  );
});

test("rejects monitoring that cannot compile signed no-submit migration candidates", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll("migration_candidates: migrationCandidates", "migration_candidates: []"),
    }),
    /carry_monitor_migration_candidates_missing/,
  );
});

test("rejects a migration replacement without signed parent lineage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("migration_parent_position_id", "parent_position_reference"),
    }),
    /carry_migration_signed_lineage_missing/,
  );
});

test("rejects migration replacement creation before the parent is flat", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll("carry_migration_parent_not_flat", "carry_migration_parent_ready"),
    }),
    /carry_migration_flat_parent_gate_missing/,
  );
});

test("rejects a terminal that silently disables signed route migration", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webMandate: sources.webMandate.replaceAll("allow_migration: true", "allow_migration: false"),
    }),
    /carry_default_migration_disabled/,
  );
});

test("rejects Carry creation without a recovered owner signature", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerMandate: sources.workerMandate.replaceAll("recoverMessageAddress", "trustClientSignature"),
    }),
    /carry_worker_signature_recovery_missing/,
  );
});

test("rejects release evidence that does not verify the signed mandate", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll("owner_signature_mismatch", "owner_signature_ignored"),
    }),
    /carry_release_signature_verifier_missing/,
  );
});

test("rejects an independent release verifier that ignores exact lifecycle accounts", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier
        .replaceAll("entry_account_binding_mismatch", "entry_account_binding_ignored")
        .replaceAll("exit_account_binding_mismatch", "exit_account_binding_ignored"),
    }),
    /carry_release_verifier_entry_account_lineage_missing|carry_release_verifier_exit_account_lineage_missing/,
  );
});

test("rejects an independent verifier that ignores runway status", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll("margin_runway_status_missing", "margin_runway_status_ignored"),
    }),
    /carry_evidence_runway_status_gate_missing/,
  );
});

test("rejects a Vercel source bundle that omits the carry proof runbook", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      vercelIgnore: sources.vercelIgnore.replaceAll("!deploy/evidence/CARRY_MAINNET_PROOF_RUNBOOK.md", ""),
    }),
    /carry_proof_runbook_bundle_missing/,
  );
});

test("rejects removal of the incremental carry quote engine", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll("applyCarryLivePatches", "applySlowSnapshots"),
    }),
    /carry_incremental_quote_engine_missing/,
  );
});

test("rejects a partial live patch that can revive a stale component", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll("carryStaleSources", "ignoreComponentStaleness"),
    }),
    /carry_component_staleness_gate_missing/,
  );
});

test("rejects terminal routing that skips exact contract equivalence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll("carryContractsAreComparable", "sameTickerIsEnough"),
    }),
    /carry_terminal_contract_equivalence_gate_missing/,
  );
});

test("rejects terminal net value that omits conservative worker costs", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll("CARRY_CAPITAL_COST_BPS_PER_DAY", "IGNORED_CAPITAL_COST_BPS"),
    }),
    /carry_terminal_capital_cost_missing/,
  );
});

test("rejects replacing the terminal rail with marketing status copy", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace("XVENUE", "Scanning equivalent perps"),
    }),
    /carry_terminal_rail_missing|carry_marketing_status_copy_forbidden/,
  );
});

test("rejects transport activity presented as verified market data", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: `${sources.webCarryChart}\nDATA {liveVenueCount}`,
    }),
    /carry_socket_status_mislabeled_as_live_data/,
  );
});

test("rejects route qualification that does not prove positive net value", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replaceAll("routeHasPositiveNet", "routeHasAnySpread"),
    }),
    /carry_positive_net_qualification_missing/,
  );
});

test("rejects promoting a point-in-time net tick to a qualified route", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: `${sources.webCarryChart}\ndata-route-qualified={selectedHasPositiveNet ? "true" : "false"}`,
    }),
    /carry_single_tick_route_qualification_forbidden/,
  );
});

test("rejects urgent React updates for the high-frequency quote rail", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(
        "startTransition(() => setLivePatches(patches))",
        "setLivePatches(patches)",
      ),
    }),
    /carry_nonblocking_ui_publish_missing/,
  );
});

test("rejects an unrealistic sub-millisecond UI claim", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarketTest: sources.webCarryLiveMarketTest.replace(
        "inside one 16ms UI frame",
        "below one millisecond per tick",
      ),
    }),
    /carry_hot_path_benchmark_missing|carry_unrealistic_sub_ms_claim_forbidden/,
  );
});

test("rejects benchmarking the obsolete single-pair route path", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarketTest: sources.webCarryLiveMarketTest.replaceAll(
        "rankCarryCandidatesByNet",
        "rankByGrossFunding",
      ),
    }),
    /carry_net_rank_hot_path_benchmark_missing/,
  );
});

test("rejects redundant quote evaluation in the carry render path", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: `${sources.webCarryChart}\nquoteCarryCandidate(candidate)`,
    }),
    /carry_redundant_quote_rendering/,
  );
});

test("rejects ranking the same carry universe twice per market update", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: `${sources.webCarryChart}\nrankCarryCandidatesByNet(buildPairCandidates(effectiveVenues))`,
    }),
    /carry_redundant_net_ranking/,
  );
});

test("rejects cross-venue routing that optimizes gross funding instead of net value", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replaceAll("rankCarryCandidatesByNet", "rankByGrossFunding"),
    }),
    /carry_net_route_ranking_missing/,
  );
});

test("rejects a duplicated browser-stream venue list", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll(
        "CARRY_BROWSER_STREAM_VENUES",
        '["lighter", "aster", "dydx", "edgex"]',
      ),
    }),
    /carry_browser_stream_registry_missing|carry_browser_stream_registry_duplicated/,
  );
});

test("rejects a terminal builder without separate live-entry confirmation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("CONFIRM LIVE PAIRED ENTRY", "ENTER"),
    }),
    /carry_terminal_separate_confirmation_missing/,
  );
});

test("rejects a terminal that cannot start another lifecycle after a flat proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replaceAll(
        "allows a new Carry Position after the previous route proved flat with zero orders",
        "shows the previous route",
      ),
    }),
    /carry_terminal_repeat_lifecycle_test_missing/,
  );
});

test("rejects a terminal that trades before authoritative position sync", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("RETRY POSITION SYNC", "NO-SUBMIT CHECK"),
    }),
    /carry_terminal_position_sync_gate_missing/,
  );
});

test("rejects a terminal that bypasses the three-venue no-submit matrix", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("preflightCarryExecutionMatrix", "preflightCarryPair"),
    }),
    /carry_terminal_three_venue_matrix_missing/,
  );
});

test("rejects a terminal whose no-submit matrix drifts from the capability registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "CARRY_EXECUTION_VENUES.every",
        '["hyperliquid", "lighter", "aster"].every',
      ),
    }),
    /carry_terminal_matrix_registry_(missing|duplicated)/,
  );
});

test("rejects a terminal that hides successful pair evidence behind one venue failure", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("carryFleetGuardSummary", "pendingFleetGuard"),
    }),
    /carry_terminal_partial_fleet_evidence_missing/,
  );
});

test("rejects a terminal that hides monitored margin runway", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("LEG RUNWAY", "MARGIN"),
    }),
    /carry_terminal_runway_display_missing/,
  );
});

test("rejects removal of component-level carry value attribution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("summarizeValueAttribution", "summarizeNetOnly"),
    }),
    /carry_value_attribution_missing/,
  );
});

test("rejects a Carry ledger that accepts conflicting evidence replays", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("carry_value_entry_replay_mismatch", "carry_value_replay_accepted"),
    }),
    /carry_value_conflicting_replay_gate_missing/,
  );
});

test("rejects client-reachable Carry lifecycle or realized-value mutation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: `${sources.server}\nconst route = \"/carry/positions/value-entries\";`,
      webRoute: `${sources.webRoute}\nif (action === \"event\") return null;`,
    }),
    /carry_client_value_entry_mutation_exposed|carry_web_generic_event_mutation_exposed/,
  );
});

test("rejects funding history that cannot resume a bounded backfill", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replace(
        "if (read.cursor_ms > priorCursor) cursors[read.venue_id] = read.cursor_ms",
        "if (read.caught_up) cursors[read.venue_id] = nowMs",
      ),
    }),
    /carry_funding_backfill_cursor_resume_missing/,
  );
});

test("rejects carry funding persistence that requires manual preflight checks", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("funding_persistence: fundingPersistence", "funding_persistence: null"),
    }),
    /carry_funding_shadow_cycle_missing/,
  );
});

test("rejects a terminal that hides commitment-backed funding evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replaceAll("EVID {edgeEvidence.value}", "EVID —"),
    }),
    /carry_funding_evidence_display_missing/,
  );
});

test("rejects release proof without exact venue-leg funding reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll("realized_funding_evidence_mismatch", "funding_not_checked"),
    }),
    /carry_release_funding_reconciliation_missing/,
  );
});

test("rejects release assembly that ignores canonical position-leg funding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "const fundingLegId = carryPositionLegId(record.position, sagaLeg.venue_id)",
        "const fundingLegId = sagaLeg.leg_id",
      ),
    }),
    /carry_release_canonical_funding_leg_missing/,
  );
});

test("rejects funding settlements stored without their exact Carry leg", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "legId: carryPositionLegId(initial.position, read.venue_id)",
        "legId: null",
      ),
    }),
    /carry_funding_leg_binding_missing/,
  );
});

test("rejects non-canonical venue settlement ordering", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll("entries.sort(compareFundingEntries)", "entries.reverse()"),
    }),
    /carry_funding_canonical_order_missing/,
  );
});

test("rejects a terminal that hides realized execution attribution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="EXEC Δ"', 'label="COST"'),
    }),
    /carry_terminal_execution_attribution_missing/,
  );
});

test("rejects removal of verified capital-efficiency evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("CAPITAL OFFSET ·", "CAPITAL ·"),
    }),
    /carry_terminal_capital_efficiency_missing/,
  );
});

test("rejects a terminal that masks incomplete worker proof with browser estimates", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "const netUsd = opportunity ? proofNet : model.netUsd",
        "const netUsd = proofNet ?? model.netUsd",
      ),
    }),
    /carry_terminal_proof_economics_fallback_missing/,
  );
});

test("rejects terminal gross funding that ignores worker proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "carryTerminalGrossFunding(candidate, proof ? proofOpportunity || {} : null)",
        "carryTerminalGrossFunding(candidate, null)",
      ),
    }),
    /carry_terminal_proof_gross_fallback_missing/,
  );
});

test("rejects terminal minimum margin that ignores worker proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "carryVenueMinimumMarginSummary(model, proof)",
        "carryVenueMinimumMarginSummary(model, null)",
      ),
    }),
    /carry_terminal_proof_margin_fallback_missing/,
  );
});

test("reports required sources absent from git", () => {
  const tracked = new Set(Object.values(CARRY_RELEASE_FILES).slice(0, -1));
  const untracked = findUntrackedCarryReleaseFiles({
    repoRoot: "/fixture",
    gitAvailable: true,
    run: (_command, args) => {
      const path = args.at(-1);
      if (!tracked.has(path)) throw new Error("not tracked");
    },
  });
  assert.deepEqual(untracked, [Object.values(CARRY_RELEASE_FILES).at(-1)]);
});
