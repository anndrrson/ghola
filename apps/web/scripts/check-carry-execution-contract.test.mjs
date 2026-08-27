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

test("rejects replacing the terminal rail with marketing status copy", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(">XVENUE<", ">Scanning equivalent perps<"),
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

test("rejects a terminal that hides monitored margin runway", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("MIN RUNWAY", "MARGIN"),
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

test("rejects release proof without exact venue-leg funding reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll("realized_funding_evidence_mismatch", "funding_not_checked"),
    }),
    /carry_release_funding_reconciliation_missing/,
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
