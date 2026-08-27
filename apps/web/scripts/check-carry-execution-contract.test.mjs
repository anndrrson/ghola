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

test("rejects qualification evidence not bound to the deployed image", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      qualification: sources.qualification.replaceAll("image_digest: imageDigest", "image_digest: null"),
    }),
    /qualification_image_binding_missing/,
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
      webAccountSetup: sources.webAccountSetup.replace(
        "return_to=${encodeURIComponent(setupReturnTo)}",
        "return_to=${encodeURIComponent(safeReturnTo)}",
      ),
    }),
    /hyperliquid_setup_carry_resume_missing/,
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

test("rejects release without a joined three-venue no-submit matrix", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("preflightCarryExecutionMatrix", "preflightOnePairOnly"),
    }),
    /carry_three_venue_no_submit_matrix_missing/,
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

test("rejects serial Carry monitoring that lets one venue stall every position", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replace("mapConcurrentOrdered(records, concurrency", "mapSerially(records"),
    }),
    /carry_monitor_bounded_concurrency_missing/,
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
