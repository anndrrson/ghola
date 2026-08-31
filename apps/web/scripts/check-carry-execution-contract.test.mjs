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

test("rejects a recovery contract that permits ambiguous retries", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      registry: sources.registry.replaceAll("freeze_reconcile_never_retry", "retry"),
    }),
    /carry_recovery_ambiguity_policy_missing/,
  );
});

test("rejects recovery that cancels before reading the exact original order", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll("reconcile_before_cancel", "reconcile_after_cancel"),
    }),
    /carry_reconcile_before_cancel_missing/,
  );
});

test("rejects recovery that can reuse a stale reconciliation read", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replaceAll("cached?.receipt && !readOnlyReconcile", "cached?.receipt"),
    }),
    /carry_fresh_reconciliation_read_missing/,
  );
});

test("rejects residual recovery submission before exact child reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll(
        "settlePriorRecoveryExecutions",
        "skipPriorRecoveryExecutions",
      ),
    }),
    /carry_recovery_child_reconciliation_missing/,
  );
});

test("rejects recovery that trusts a receipt detached from the exact venue order", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll(
        "recoveryProofTargetsLeg(",
        "trustRecoveryProof(",
      ),
    }),
    /carry_recovery_exact_target_gate_missing/,
  );
});

test("rejects recovery coverage duplicated outside the capability registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "exactQuantityRecoveryAdapter(venueId) !== null",
        'new Set(["hyperliquid", "lighter", "aster"]).has(venueId) === false',
      ),
    }),
    /carry_recovery_exact_target_registry_binding_missing|carry_recovery_venue_registry_duplicated/,
  );
});

test("rejects recovery that treats no-submit evidence as a live fill", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll(
        "proof?.broadcast_performed === true",
        "proof?.broadcast_performed !== null",
      ),
    }),
    /carry_recovery_live_broadcast_gate_missing/,
  );
});

test("rejects recovery that ignores its exact reduce-only no-submit proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll(
        "await verifyRecoveryOrderNoSubmit({",
        "await trustRecoveryOrder({",
      ),
    }),
    /carry_recovery_exact_no_submit_gate_missing/,
  );
});

test("rejects partial exit recovery proven for only one venue pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replaceAll(
        "reconciles a partial reduce-only completion for every ordered execution pair",
        "reconciles a partial reduce-only completion for one pair",
      ),
    }),
    /carry_partial_completion_pair_matrix_missing/,
  );
});

test("rejects recovery no-submit proof detached from the sealed account", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replaceAll(
        "account_commitment: access.account_commitment || undefined",
        "account_commitment: undefined",
      ),
    }),
    /carry_recovery_account_binding_missing/,
  );
});

test("rejects readiness detached from the registered recovery adapter", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        'venueAdapterCapability(venueId, "exact_quantity_recovery")',
        'venueAdapterCapability(venueId, "carry_execution")',
      ),
    }),
    /carry_readiness_recovery_adapter_binding_missing/,
  );
});

test("rejects private-prime readiness that fabricates recovery coverage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "failure_recovery: failureRecovery",
        "failure_recovery: { ready: true }",
      ),
    }),
    /carry_private_prime_recovery_output_missing/,
  );
});

test("rejects recovery readiness inferred from adapter registration without lifecycle qualification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        "qualification: recoveryQualificationRecord(item.qualification)",
        "qualification: null",
      ),
    }),
    /carry_recovery_qualification_binding_missing/,
  );
});

test("rejects a gateway that forwards unauthenticated private-prime evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replaceAll(
        "verifyCarryPrivatePrimeWorkerAuthentication({",
        "trustCarryPrivatePrimeWorkerAuthentication({",
      ),
    }),
    /carry_private_prime_gateway_authentication_missing/,
  );
});

test("rejects a worker that emits unsigned private-prime evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll(
        "private_prime_authentication: authenticateCarryPrivatePrimeReadiness({",
        "private_prime_authentication: { request_bound: true, mac_hex: \"trusted\" }, //",
      ),
    }),
    /carry_private_prime_worker_authentication_missing/,
  );
});

test("rejects Carry creation detached from the exact owner-approved opportunity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "carry_opportunity_mandate_mismatch",
        "carry_opportunity_mandate_unchecked",
      ),
    }),
    /carry_worker_opportunity_binding_missing/,
  );
});

test("rejects funding-flip confirmation detached from fresh venue source evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarryTest: sources.coreCarryTest.replaceAll(
        "new wrapper timestamps cannot manufacture confirmations from replayed funding sources",
        "wrapper timestamps count as fresh confirmations",
      ),
    }),
    /carry_funding_source_replay_test_missing/,
  );
});

test("rejects durable Carry records that omit signed opportunity material", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "opportunity_authentication_material",
        "opportunity_authentication_receipt_only",
      ),
    }),
    /carry_durable_opportunity_material_missing/,
  );
});

test("rejects entry that skips durable opportunity reverification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replaceAll(
        "verifyStoredCarryOpportunityBinding({ record })",
        "trustStoredCarryOpportunity({ record })",
      ),
    }),
    /carry_entry_opportunity_reverification_missing/,
  );
});

test("rejects monitoring that skips durable opportunity reverification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "require_material: false",
        "require_material: null",
      ),
    }),
    /carry_monitor_opportunity_reverification_missing/,
  );
});

test("rejects release evidence that skips durable opportunity reverification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "carry_release_opportunity_provenance_unproven",
        "carry_release_opportunity_trusted",
      ),
    }),
    /carry_release_opportunity_reverification_missing/,
  );
});

test("rejects client-authored Carry creation economics", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "verifyCarryCreationOpportunityAuthentication",
        "trustClientCarryCreationOpportunity",
      ),
    }),
    /carry_creation_opportunity_storage_gate_missing/,
  );
});

test("rejects a gateway that displays unauthenticated Carry creation economics", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replaceAll(
        "verifyCarryCreationOpportunityWorkerAuthentication({",
        "trustCarryCreationOpportunityWorkerAuthentication({",
      ),
    }),
    /carry_creation_opportunity_gateway_authentication_missing/,
  );
});

test("rejects AI inference inside deterministic Carry execution modules", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: `${sources.executor}\nconst route = generateText({ model: \"trade\" });`,
    }),
    /carry_deterministic_boundary_generate_text_present:executor/,
  );
});

test("rejects private-prime evidence detached from the attested worker signer", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeAuthentication: sources.webPrivatePrimeAuthentication.replace(
        "ed25519.verify(",
        "trustSelfDescribedSignature(",
      ),
    }),
    /carry_private_prime_gateway_attested_signature_missing/,
  );
});

test("rejects a terminal that hides recovery qualification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replaceAll("3/3 REC", "RECOVERY"),
    }),
    /carry_private_prime_terminal_recovery_missing/,
  );
});

test("rejects a terminal that leaves expired creation proof actionable", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        "const canSave = actionableProof && creationProofFreshness.fresh",
        "const canSave = actionableProof",
      ),
    }),
    /carry_creation_stale_action_gate_missing/,
  );
});

test("rejects a terminal that invites trading without positive modeled edge", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        '"CONNECT TO VERIFY · NO EDGE YET"',
        '"CONNECT TO VERIFY & TRADE"',
      ),
    }),
    /carry_terminal_nonpositive_edge_cta_missing/,
  );
});

test("rejects restoring the retired standalone Carry workspace", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPage: 'import { CarryWorkspace } from "@/components/carry/CarryWorkspace"; export default CarryWorkspace;',
    }),
    /carry_integrated_terminal_redirect_missing|carry_standalone_workspace_restored/,
  );
});

test("rejects Carry mode that restores venue-owned terminal chrome", () => {
  for (const field of [
    "showVenueReadiness",
    "showVenueMarketStats",
    "showVenueActivity",
    "showVenueOrderTicket",
  ]) {
    assert.throws(
      () => checkCarryExecutionContract({
        ...sources,
        webCarryTerminalChrome: sources.webCarryTerminalChrome.replace(
          `${field}: false`,
          `${field}: true`,
        ),
      }),
      /carry_venue_(readiness_not_hidden|market_stats_not_hidden|activity_not_hidden|ticket_not_hidden)/,
    );
  }
});

test("rejects a Carry Position rail coupled to scanner qualification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webTradeWorkspace: sources.webTradeWorkspace.replace(
        "{carryWorkspaceOpen ? <CarryPositionRail /> : null}",
        "{selectedExecution ? <CarryPositionRail /> : null}",
      ),
    }),
    /carry_persistent_position_rail_missing/,
  );
});

test("rejects live actions in the persistent Carry Position rail", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryPositionRail: `${sources.webCarryPositionRail}\nvoid executeCarryPositionEntry; void requestCarryPositionExit; void createCarryPosition;`,
    }),
    /carry_position_rail_live_(entry|exit|creation)_exposed/,
  );
});

test("rejects Carry mode that removes the reference chart", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryTerminalChrome: sources.webCarryTerminalChrome.replaceAll(
        "showReferenceChart: true",
        "showReferenceChart: false",
      ),
    }),
    /carry_reference_chart_hidden/,
  );
});

test("rejects an integrated terminal that hides collateral-basis risk", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace('label="COLLATERAL"', 'label="ACCOUNT"'),
    }),
    /user_collateral_assets_missing/,
  );
});

test("rejects modeled routing edge presented as realized performance", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replaceAll("not realized P&L.", "realized P&L."),
    }),
    /carry_routing_advantage_modeled_disclosure_missing/,
  );
});

test("rejects routing advantage evidence that can authorize execution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      routingAdvantage: sources.routingAdvantage.replace("execution_ready: false", "execution_ready: true"),
    }),
    /carry_routing_advantage_execution_boundary_missing/,
  );
});

test("rejects a routing advantage benchmark anchored to Hyperliquid", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      routingAdvantage: sources.routingAdvantage
        .replace('benchmark_kind: "next_best_executable_route"', 'anchor_venue_id: "hyperliquid"')
        .replace(
          "bestRoute(candidates.filter((route) => !sameRoute(route, selected)))",
          'bestRoute(candidates.filter((route) => route.long_venue_id === "hyperliquid"))',
        ),
    }),
    /carry_routing_advantage_neutral_benchmark_missing|carry_routing_advantage_next_best_route_missing|carry_routing_advantage_anchor_forbidden/,
  );
});

test("rejects removal of the no-trade selected-value boundary", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      routingAdvantage: sources.routingAdvantage.replace('benchmark_kind: "no_trade"', 'benchmark_kind: "next_best_executable_route"'),
    }),
    /carry_routing_selected_value_benchmark_missing/,
  );
});

test("rejects selected-route net presented as comparative savings", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace("no second funding-qualified route exists", "route savings verified"),
    }),
    /carry_routing_selected_value_boundary_missing/,
  );
});

test("rejects hiding worker-committed selected-route net from the primary rail", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace('committedSelectedNet ? "NET24H✓" : "NET24H*"', '"NET24H*"'),
    }),
    /carry_terminal_selected_net_display_missing/,
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

test("rejects unsigned aggregate supervision health", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      loopSupervisor: sources.loopSupervisor.replaceAll(
        "export function verifyCarrySupervisionHealth",
        "function trustCarrySupervisionHealth",
      ),
    }),
    /carry_supervision_evidence_verifier_missing/,
  );
});

test("rejects private-prime readiness that trusts aggregate supervision booleans", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "verifyCarrySupervisionHealth(carrySupervision",
        "trustCarrySupervisionHealth(carrySupervision",
      ),
    }),
    /carry_private_prime_supervision_verification_missing/,
  );
});

test("rejects multi-leg recovery detached from worker supervision", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace("recovery: multiLegRecoveryLoop", "recovery: null"),
    }),
    /carry_recovery_server_health_missing/,
  );
});

test("rejects supervision that masks a degraded recovery loop", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      loopSupervisor: sources.loopSupervisor.replace("recovery: recoveryHealth", "recovery: disabledCarryLoopHealth(\"multi_leg_recovery\")"),
    }),
    /carry_recovery_aggregate_missing/,
  );
});

test("rejects a terminal that trusts aggregate health without recovery health", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace('&& recovery.status === "healthy"', ""),
    }),
    /carry_terminal_recovery_health_missing/,
  );
});

test("rejects five-venue observation detached from worker supervision", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace("observation: carryFundingObservationLoop", "observation: null"),
    }),
    /carry_observation_server_health_missing/,
  );
});

test("rejects a terminal that trusts aggregate health without observation health", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace('&& observation.status === "healthy"', ""),
    }),
    /carry_terminal_observation_health_missing/,
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

test("rejects lifecycle proof storage that is not isolated per position and venue pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "material.position.position_id,\n    venueIds,",
        '"",\n    [],',
      ),
    }),
    /carry_lifecycle_proof_position_pair_record_binding_missing/,
  );
});

test("rejects private-prime evidence that can outlive its paired lifecycle", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "function minimumExpiry(readinessExpiry, shadowCheckedAt, routeExpiry, supervisionExpiry, lifecycleExpiry)",
        "function minimumExpiry(readinessExpiry, shadowCheckedAt, routeExpiry)",
      ),
    }),
    /carry_private_prime_lifecycle_expiry_binding_missing/,
  );
});

test("rejects live private-prime proof that drops realized after-cost value", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        "Number.isSafeInteger(proof?.realized_net_value_micro_usdc)",
        "true",
      ),
    }),
    /carry_private_prime_realized_net_gate_missing/,
  );
});

test("rejects private-prime readiness that hard-codes live-user readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        "ready_for_live_users: readyForLiveUsers",
        "ready_for_live_users: true",
      ),
    }),
    /carry_private_prime_live_user_gate_missing/,
  );
});

test("rejects a terminal that trusts no-submit evidence as live-user readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replace(
        "value.ready_for_live_users === expectedLiveReady",
        "value.ready_for_live_users === true",
      ),
    }),
    /carry_private_prime_ui_live_user_gate_missing/,
  );
});

test("rejects lifecycle proof without reconciled value attribution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "safeLifecycleValueAttribution(proof.value_attribution)",
        "true",
      ),
    }),
    /carry_lifecycle_proof_value_attribution_gate_missing/,
  );
});

test("rejects private-prime proof that trusts opaque value attribution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        "safeLifecycleValueAttribution(proof?.value_attribution)",
        "proof?.value_attribution",
      ),
    }),
    /carry_private_prime_value_attribution_gate_missing/,
  );
});

test("rejects duplicated lifecycle value math outside execution core", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replace(
        "export function normalizeCarryLifecycleValueAttribution",
        "function normalizeCarryLifecycleValueAttribution",
      ),
    }),
    /carry_lifecycle_value_attribution_core_missing/,
  );
});

test("rejects a terminal that hides modeled-versus-realized attribution", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replace(
        "ΔMODEL ${formatSignedMicroUsd(value.variance_from_modeled_micro_usdc)}",
        "VALUE HIDDEN",
      ),
    }),
    /carry_private_prime_ui_value_attribution_display_missing/,
  );
});

test("rejects aggregate expiry that omits the verified lifecycle deadline", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        "pairedLifecycle.verified ? pairedLifecycle.expires_at_ms : null",
        "null",
      ),
    }),
    /carry_private_prime_lifecycle_expiry_input_missing/,
  );
});

test("rejects a terminal that trusts an aggregate proof beyond its lifecycle deadline", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replace(
        "expiresAt <= lifecycleExpiresAt",
        "expiresAt > lifecycleExpiresAt",
      ),
    }),
    /carry_private_prime_ui_lifecycle_expiry_gate_missing/,
  );
});

test("rejects an HTTP readiness path that omits lifecycle asset scope", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace("            asset: body.asset,", "            asset: undefined,"),
    }),
    /carry_lifecycle_proof_asset_http_binding_missing/,
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

test("rejects exit execution that reuses an opening-shaped preflight", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replaceAll('phase: "exit"', 'phase: "monitoring"'),
    }),
    /carry_exit_exact_preflight_phase_missing/,
  );
});

test("rejects exit preflight that does not verify the exact reduce-only order shape", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("assertExactExitOrderShape({", "trustExitOrderShape({"),
    }),
    /carry_exit_order_shape_verification_missing/,
  );
});

test("rejects venue no-submit receipts that omit reduce-only binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replaceAll("reduce_only: order.reduce_only === true", "reduce_only: false"),
      hyperliquid: sources.hyperliquid.replaceAll("reduce_only: instruction.order?.reduce_only === true", "reduce_only: false"),
      privateExecution: sources.privateExecution.replaceAll('reduce_only: result.order.reduceOnly === "true"', "reduce_only: false"),
    }),
    /lighter_no_submit_reduce_only_binding_missing|hyperliquid_no_submit_reduce_only_binding_missing|aster_no_submit_reduce_only_binding_missing/,
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

test("rejects a worker that silently disables default collateral-route observation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("createReadOnlyCarryRuntimePolicies", "disabledCarryRuntimePolicies"),
    }),
    /carry_runtime_route_policy_default_missing/,
  );
});

test("rejects removing pre-open collateral-route observation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("observePreopenCarryTransferRoutes", "skipPreopenCarryTransferRoutes"),
    }),
    /carry_preopen_route_observation_missing/,
  );
});

test("rejects collateral routes detached from the current no-submit account state", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "routesBoundToCurrentAccounts",
        "routesAcceptedWithoutCurrentAccounts",
      ),
    }),
    /carry_private_prime_route_account_state_binding_missing/,
  );
});

test("rejects private-prime readiness from partial directed collateral-route coverage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "complete_directed_coverage: completeDirectedCoverage",
        "complete_directed_coverage: availableRoutes.length > 0",
      ),
    }),
    /carry_private_prime_route_coverage_output_missing/,
  );
});

test("rejects a terminal that treats one collateral route as private-prime coverage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replaceAll(
        "route.complete_directed_coverage === true",
        "Number(route.available_route_count) > 0",
      ),
    }),
    /carry_private_prime_ui_route_coverage_gate_missing/,
  );
});

test("rejects private-prime readiness that skips exact route commitment verification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        "verifyCarryTransferRouteEvidence(routeEvidence?.evidence)",
        "{ ok: true, evidence: routeEvidence?.evidence }",
      ),
    }),
    /carry_private_prime_route_commitment_verification_missing/,
  );
});

test("rejects a terminal that trusts an aggregate private-prime hash prefix", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replaceAll(
        "value.evidence_commitment === carryPrivatePrimeEvidenceCommitment(value)",
        'String(value.evidence_commitment || "").startsWith("carry:private-prime:")',
      ),
    }),
    /carry_private_prime_ui_commitment_verification_missing/,
  );
});

test("rejects private-prime readiness that outlives supervision health", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "assessedSupervision.health.checked_at_ms + 5_000",
        "null",
      ),
    }),
    /carry_private_prime_supervision_expiry_binding_missing/,
  );
});

test("rejects private-prime readiness that trusts an unverified readiness wrapper", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "verifyCarryExecutionReadinessResult(readiness",
        "trustCarryExecutionReadinessResult(readiness",
      ),
    }),
    /carry_private_prime_readiness_wrapper_verification_missing/,
  );
});

test("rejects private-prime readiness that trusts an unbound shadow wrapper", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "verifyCarryShadowQualification(shadowQualification",
        "trustCarryShadowQualification(shadowQualification",
      ),
    }),
    /carry_private_prime_shadow_wrapper_verification_missing/,
  );
});

test("rejects unsigned three-venue readiness summaries", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        "export function verifyCarryExecutionReadinessResult",
        "function trustCarryExecutionReadinessResult",
      ),
    }),
    /carry_readiness_result_verifier_missing/,
  );
});

test("rejects unsigned five-venue qualification summaries", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowQualification: sources.shadowQualification.replaceAll(
        "export function verifyCarryShadowQualification",
        "function trustCarryShadowQualification",
      ),
    }),
    /carry_shadow_result_verifier_missing/,
  );
});

test("rejects private-prime readiness backed only by a configured route probe", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("route_evidence: routeEvidence", "route_evidence: null"),
    }),
    /carry_private_prime_route_evidence_binding_missing/,
  );
});

test("rejects private-prime readiness that hard-codes live proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replace(
        'proof_level: pairedLifecycle.verified ? "live_paired_lifecycle" : "pre_broadcast_readiness"',
        'proof_level: "live_paired_lifecycle"',
      ),
    }),
    /carry_private_prime_proof_level_missing/,
  );
});

test("rejects private-prime readiness that skips lifecycle commitment verification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeReadiness: sources.privatePrimeReadiness.replaceAll(
        "assessCompletedCarryLifecycleProof({",
        "trustCompletedCarryLifecycleProof({",
      ),
    }),
    /carry_private_prime_lifecycle_commitment_verification_missing/,
  );
});

test("rejects a terminal that presents private-prime status without validating worker proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("carryPrivatePrimeSummary", "trustPrivatePrimeStatus"),
    }),
    /carry_private_prime_terminal_validation_missing/,
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

test("rejects market labels detached from the execution venue registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace(
        "CORE_PERP_VENUES.map((venueId) => [venueId, executionVenueLabel(venueId)])",
        "CORE_PERP_VENUES.map((venueId) => [venueId, venueId])",
      ),
    }),
    /carry_market_venue_label_registry_missing/,
  );
});

test("rejects shadow qualification coverage hard-coded outside the venue registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowQualification: sources.shadowQualification.replace(
        "value?.venues === CORE_PERP_VENUES.length",
        "value?.venues === 5",
      ),
    }),
    /carry_shadow_qualification_registry_coverage_missing|carry_shadow_qualification_venue_count_hardcoded/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace(
        "qualification.venues === CORE_PERP_VENUES.length",
        "qualification.venues === 5",
      ),
    }),
    /carry_market_qualification_registry_coverage_missing|carry_market_qualification_venue_count_hardcoded/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "shadowQualification.venues === CORE_PERP_VENUES.length",
        "shadowQualification.venues === 5",
      ),
    }),
    /carry_release_shadow_registry_coverage_missing|carry_release_shadow_venue_count_hardcoded/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "shadowQualification.expected_snapshots_per_sample === CORE_PERP_VENUES.length * CARRY_SHADOW_ASSETS.length",
        "shadowQualification.expected_snapshots_per_sample === 15",
      ),
    }),
    /carry_release_shadow_snapshot_count_hardcoded/,
  );
});

test("rejects carry shadow assets detached from the execution registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      registry: sources.registry.replace(
        "export function normalizeCarryShadowAssets",
        "function normalizeCarryShadowAssets",
      ),
    }),
    /carry_shadow_asset_normalizer_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        'normalizeCarryShadowAssets(url.searchParams.get("assets"), { default_to_all: true })',
        'String(url.searchParams.get("assets") || "BTC,ETH,SOL").split(",")',
      ),
    }),
    /carry_shadow_worker_asset_policy_missing|carry_shadow_worker_asset_policy_duplicated/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replace(
        'normalizeCarryShadowAssets(req.nextUrl.searchParams.get("assets"), { default_to_all: true })',
        'String(req.nextUrl.searchParams.get("assets") || "BTC,ETH,SOL").split(",")',
      ),
    }),
    /carry_shadow_gateway_asset_policy_missing|carry_shadow_gateway_asset_policy_duplicated/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(
        'CARRY_SHADOW_ASSETS.join(",")',
        '"BTC,ETH,SOL"',
      ),
    }),
    /carry_shadow_ui_asset_policy_missing|carry_shadow_ui_asset_policy_duplicated/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replace(
        "DEFAULT_CARRY_SHADOW_ASSETS = CARRY_SHADOW_ASSETS",
        'DEFAULT_CARRY_SHADOW_ASSETS = Object.freeze(["BTC", "ETH", "SOL"])',
      ),
    }),
    /carry_shadow_core_assets_missing|carry_shadow_verifier_asset_policy_duplicated/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace(
        "qualification.assets === CARRY_SHADOW_ASSETS.length",
        "qualification.assets === 3",
      ),
    }),
    /carry_market_qualification_asset_registry_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "shadowQualification.assets === CARRY_SHADOW_ASSETS.length",
        "shadowQualification.assets === 3",
      ),
    }),
    /carry_release_shadow_asset_registry_missing/,
  );
});

test("rejects margin and liquidation evidence detached from the venue registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replace(
        "snapshot.margin_model !== declared?.margin_model",
        "!snapshot.margin_model",
      ),
    }),
    /carry_shadow_margin_model_registry_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace(
        "PERP_SHADOW_ADAPTERS.aster.liquidation_model",
        '"cross_or_isolated_account_margin"',
      ),
    }),
    /shadow_liquidation_model_registry_binding_missing:aster/,
  );
});

test("rejects Carry creation detached from exact shadow and account inputs", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replace(
        "input_evidence: creationInputEvidence(evidence, accountReadiness)",
        "input_evidence: null",
      ),
    }),
    /carry_creation_input_evidence_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replace(
        "validateCarryCreationInputEvidence(positionInput, opportunity.input_evidence)",
        "null",
      ),
    }),
    /carry_creation_input_evidence_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "creation_input_evidence: creationInputEvidence.evidence",
        "creation_input_evidence: null",
      ),
    }),
    /carry_release_creation_input_evidence_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "leg.account_commitment === readinessVenue?.account_commitment",
        "commitment(leg.account_commitment)",
      ),
    }),
    /carry_release_creation_account_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "creation_input_evidence_commitment: material.creation_input_evidence.evidence_commitment",
        "creation_input_evidence_commitment: null",
      ),
    }),
    /carry_lifecycle_creation_input_commitment_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeReadiness: sources.webPrivatePrimeReadiness.replace(
        "pairedLifecycle.creation_input_evidence_commitment",
        "null",
      ),
    }),
    /carry_private_prime_ui_creation_input_gate_missing/,
  );
});

test("rejects release qualification adapters detached from the capability registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "venueAdapterCapability(venueId, \"carry_execution\")?.adapter_id",
        'venueId === "hyperliquid" ? "hyperliquid_v1" : "legacy_adapter"',
      ),
    }),
    /carry_release_adapter_registry_binding_missing/,
  );
});

test("rejects restoring a hard-coded Hyperliquid qualification anchor", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier
        .replace("CARRY_EXECUTION_VENUES.includes(venue)", 'venue in CARRY_ADAPTERS')
        .replace(
          'fail(pair.every((venue) => typeof CARRY_ADAPTERS[venue] === "string"), "venue_adapter_registry_invalid");',
          'fail(pair.includes("hyperliquid"), "qualification_pair_required");',
        ),
    }),
    /carry_release_pair_registry_binding_missing|carry_release_hyperliquid_anchor_hardcoded/,
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

test("rejects private live-status polling before Ghola authentication", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webTradeWorkspace: sources.webTradeWorkspace.replace(
        "const canPollPrivateLiveTradingStatus = auth.authenticated && !auth.loading;",
        "const canPollPrivateLiveTradingStatus = true;",
      ),
    }),
    /trade_private_status_poll_auth_gate_missing/,
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

test("rejects inline Hyperliquid setup that cannot resume the remaining Carry venues", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        'setHyperliquid("connected")',
        'setHyperliquid("needed")',
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

test("rejects venue recovery that can resubmit or reconcile forever after an ambiguous response", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      aster: sources.aster
        .replaceAll("submission_retry_count: 0", "submission_retry_count: 1")
        .replaceAll("const maxAttempts = Math.max", "const maxAttempts = Math.min"),
      lighter: sources.lighter
        .replaceAll("submission_retry_count: 0", "submission_retry_count: 1")
        .replaceAll("const maxAttempts = Math.max", "const maxAttempts = Math.min"),
    }),
    /aster_ambiguous_submit_retry_guard_missing|lighter_ambiguous_submit_retry_guard_missing|aster_reconciliation_bound_missing|lighter_reconciliation_bound_missing/,
  );
});

test("rejects venue reconciliation that drifts from the exact original order", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      aster: sources.aster.replace("clientOrderId: reconciliationClientOrderId", "clientOrderId"),
      lighter: sources.lighter.replace("clientOrderIndex: reconciliationClientOrderIndex", "clientOrderIndex"),
    }),
    /aster_reconciliation_target_drift_guard_missing|lighter_reconciliation_target_drift_guard_missing/,
  );
});

test("rejects Aster client order ids that exceed the venue limit", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        'const clientOrderId = await state.deriveClientOrderId("gh", body.work_order_commitment);\n  const result = await verifyAsterNoSubmit',
        'const clientOrderId = await state.deriveClientOrderId("ghola", body.work_order_commitment);\n  const result = await verifyAsterNoSubmit',
      ),
    }),
    /aster_client_order_length_guard_missing/,
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

test("rejects five-venue shadow qualification based on wrapper-time-only progress", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier
        .replaceAll("source_observation_commitment", "wrapper_only_commitment")
        .replaceAll("shadow_soak_source_observation_commitments_reused", "wrapper_reuse_accepted"),
    }),
    /carry_shadow_source_observation_commitment_missing|carry_shadow_source_observation_reuse_gate_missing/,
  );
});

test("rejects five-venue shadow qualification without a durable observation span", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifier: sources.shadowVerifier.replaceAll(
        "shadow_soak_duration_insufficient",
        "rapid_samples_accepted",
      ),
    }),
    /carry_shadow_duration_floor_missing/,
  );
});

test("rejects the standalone shadow verifier without the durable observation span", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifierCli: sources.shadowVerifierCli.replace(
        "minimum_span_ms: minimumSpanMs",
        "minimum_span_ms: 0",
      ),
    }),
    /carry_shadow_soak_duration_gate_missing/,
  );
});

test("rejects a standalone verifier that can wait forever for one sample", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadowVerifierCli: sources.shadowVerifierCli.replace("sampleCount > 1 ?", "true ?"),
    }),
    /carry_shadow_single_sample_delay_guard_missing/,
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

test("rejects core venue freshness manufactured from the worker clock", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace("market: bookObservedAtMs", "market: nowMs"),
    }),
    /carry_shadow_market_worker_clock_fallback_forbidden/,
  );
});

test("rejects Lighter shadow data without provider-timestamped read-only streams", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace("stream?readonly=true", "stream"),
    }),
    /lighter_read_only_websocket_missing/,
  );
});

test("rejects five-venue shadow reads without one end-to-end deadline per venue", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace(
        "fetchPerpShadowVenue({ ...options, venue_id: venueId, timeout_ms: venueTimeoutMs })",
        "fetchPerpShadowVenue({ ...options, venue_id: venueId })",
      ),
    }),
    /carry_shadow_end_to_end_venue_deadline_missing/,
  );
});

test("rejects release configuration without the bounded shadow timeout policy", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webEnvExample: sources.webEnvExample.replace(
        "PRIVATE_AGENT_CARRY_SHADOW_FETCH_TIMEOUT_MS=4000",
        "PRIVATE_AGENT_CARRY_SHADOW_FETCH_TIMEOUT_MS=8000",
      ),
    }),
    /carry_shadow_timeout_policy_example_missing/,
  );
});

test("rejects Lighter qualification without a complete initial order-book frame", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace(
        "&& Array.isArray(message.order_book.asks)",
        "&& true",
      ),
    }),
    /lighter_complete_orderbook_ask_gate_missing/,
  );
});

test("rejects source freshness measured against the pre-fetch clock", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replace("Math.max(startedAtMs, completedAtMs)", "startedAtMs"),
    }),
    /shadow_completed_observation_clock_missing/,
  );
});

test("rejects dYdX shadow freshness detached from each served payload", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll("jsonObservedRequest(", "jsonRequest("),
    }),
    /dydx_observed_response_read_missing|dydx_response_timestamp_binding_missing/,
  );
});

test("rejects dYdX freshness manufactured from its server clock", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: `${sources.shadow}\nconst legacyDydxTimePath = "/v4/time";`,
    }),
    /dydx_server_clock_freshness_forbidden/,
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

test("rejects stale or nonexistent stablecoin valuation routes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      stablecoinConversion: sources.stablecoinConversion
        .replaceAll("products/USDT-USDC/book?level=2", "products/USDC-USD/book?level=2"),
    }),
    /cashflow_usdt_liquid_book_missing|cashflow_dead_usdc_usd_book_restored/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      shadow: sources.shadow.replaceAll(
        "createCoinbaseUsdtCashflowValuationReader",
        "createAsterCashflowValuationReader",
      ),
    }),
    /shadow_usdt_valuation_source_missing/,
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

test("rejects worker release material detached from stored three-venue readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "readCarryExecutionReadiness({",
        "readPairOnlyReadiness({",
      ),
    }),
    /carry_release_three_venue_readiness_missing/,
  );
});

test("rejects release verification that accepts a partial execution registry", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "sameStrings(executionReadiness.registry_venue_ids, CARRY_EXECUTION_VENUES)",
        "executionReadiness.registry_venue_ids.includes(\"hyperliquid\")",
      ),
    }),
    /carry_release_three_venue_verifier_missing/,
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

test("rejects a three-venue matrix that loses the exact normally-returned unready venue", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll("carryPairUnreadyCode(result.value)", '"carry_pair_not_ready"'),
    }),
    /carry_no_submit_exact_unready_venue_missing/,
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

test("rejects live Carry execution that trusts an unbound terminal receipt", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replaceAll(
        "carry_execution_receipt_work_order_mismatch",
        "carry_execution_receipt_work_order_ignored",
      ),
    }),
    /carry_live_receipt_work_order_binding_missing/,
  );
});

test("rejects Carry exit that skips revalidating its stored entry receipt", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replaceAll(
        "carry_exact_entry_receipt_unverified",
        "carry_exact_entry_receipt_trusted",
      ),
    }),
    /carry_exit_entry_receipt_revalidation_missing/,
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

test("rejects execution adapters without authoritative liquidation-distance readers", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      liquidationDistance: sources.liquidationDistance.replaceAll(
        "export function lighterLiquidationDistance",
        "function lighterLiquidationDistance",
      ),
    }),
    /lighter_liquidation_distance_reader_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      aster: sources.aster.replaceAll(
        "asterLiquidationDistance(positions)",
        "unverifiedLiquidationDistance(positions)",
      ),
    }),
    /aster_liquidation_reader_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      liquidationDistanceTest: sources.liquidationDistanceTest.replaceAll(
        "Lighter flat is explicit and never defaults malformed positions",
        "Lighter malformed positions default to safe",
      ),
    }),
    /lighter_liquidation_fail_closed_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      liquidationDistance: sources.liquidationDistance.replaceAll(
        'venueAdapterCapability(String(venueId || ""), "carry_execution")?.liquidation_distance_source',
        'venueAdapterCapability(String(venueId || ""), "perp_shadow")?.liquidation_distance_source',
      ),
    }),
    /liquidation_distance_registry_derivation_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      registry: sources.registry.replaceAll(
        "lighter_account_positions_position_value_v1",
        "unbound_lighter_position_source_v1",
      ),
    }),
    /lighter_liquidation_provenance_missing/,
  );
});

test("rejects liquidation evidence detached from readiness and release commitments", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replaceAll(
        "validVenueLiquidationBinding(value, value.position_count)",
        "true",
      ),
    }),
    /carry_preflight_liquidation_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        "validVenueLiquidationBinding(account, positionCount)",
        "true",
      ),
    }),
    /carry_capital_plan_liquidation_validation_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replaceAll(
        "account?.liquidation_distance_bps === leg?.account_state?.liquidation_distance_bps",
        "true",
      ),
    }),
    /carry_capital_plan_liquidation_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "liquidation_distance_source: capitalByVenue.get(venueId)?.liquidation_distance_source ?? null",
        "liquidation_distance_source: null",
      ),
    }),
    /carry_release_liquidation_provenance_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "account_state_evidence: accountStateEvidence",
        "account_state_evidence: []",
      ),
    }),
    /carry_monitor_account_state_persistence_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "row.account_state_commitment !== carryAccountStateCommitment(row)",
        "false",
      ),
    }),
    /carry_monitor_account_state_recomputation_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "releaseMarginRunways({",
        "trustMarginRunways({",
      ),
    }),
    /carry_release_live_runway_material_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "state.account_state_commitment !== carryAccountStateCommitment(state)",
        "false",
      ),
    }),
    /carry_release_account_state_recomputation_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replaceAll(
        "liquidationDistanceSourceForVenue(venueId)",
        "unboundLiquidationSource(venueId)",
      ),
    }),
    /carry_release_canonical_liquidation_source_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterialTest: sources.releaseMaterialTest.replaceAll(
        "refuses swapped venue liquidation sources even when commitments are recomputed",
        "accepts swapped venue liquidation sources when commitments are recomputed",
      ),
    }),
    /carry_release_liquidation_source_test_missing/,
  );
});

test("rejects an independent verifier that trusts fabricated flat-account liquidation evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll(
        "three_venue_liquidation_binding_invalid",
        "three_venue_liquidation_binding_trusted",
      ),
    }),
    /carry_release_liquidation_verifier_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifierTest: sources.evidenceVerifierTest.replaceAll(
        "rejects fabricated liquidation distance for a flat readiness account",
        "accepts fabricated liquidation distance for a flat readiness account",
      ),
    }),
    /carry_release_liquidation_verifier_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll(
        "carryAccountStateCommitment({",
        "trustOpaqueAccountStateCommitment({",
      ),
    }),
    /carry_release_account_state_recomputation_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replaceAll(
        "margin_runway_open_position_unproven",
        "margin_runway_open_position_trusted",
      ),
    }),
    /carry_release_open_position_verifier_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifierTest: sources.evidenceVerifierTest.replaceAll(
        "rejects detached or unverifiable live liquidation evidence",
        "accepts detached or unverifiable live liquidation evidence",
      ),
    }),
    /carry_release_live_liquidation_verifier_test_missing/,
  );
});

test("rejects release verification whose account-state commitment width drifts from the worker", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      readiness: sources.readiness.replace(
        'return `carry:account-state:${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 40)}`;',
        'return `carry:account-state:${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 64)}`;',
      ),
    }),
    /carry_account_state_commitment_width_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifier: sources.evidenceVerifier.replace(
        "/^carry:account-state:[0-9a-f]{40}$/",
        "/^carry:account-state:[0-9a-f]{64}$/",
      ),
    }),
    /carry_release_account_state_width_mismatch/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      evidenceVerifierTest: sources.evidenceVerifierTest.replaceAll(
        "rejects padded three-venue account-state commitments",
        "accepts padded three-venue account-state commitments",
      ),
    }),
    /carry_release_account_state_width_test_missing/,
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

test("rejects collateral rescue that ignores route arrival safety", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "transfer_route_arrival_unsafe",
        "transfer_arrival_assumed_safe",
      ),
    }),
    /carry_transfer_arrival_safety_gate_missing/,
  );
});

test("rejects collateral review that can sign an unverified transfer route", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_collateral_review_transfer_route_unverified",
        "transfer_route_not_checked",
      ),
    }),
    /carry_collateral_review_route_gate_missing/,
  );
});

test("rejects transfer routes that are not committed by the worker", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      transferRoutes: sources.transferRoutes.replaceAll(
        "evidenceCommitment(evidence)",
        '"caller_supplied_commitment"',
      ),
    }),
    /carry_transfer_route_commitment_missing/,
  );
});

test("rejects collateral route observation without all-in fee verification", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      transferRoutes: sources.transferRoutes.replaceAll(
        "all_in_fee_verified",
        "partial_fee_estimate",
      ),
    }),
    /carry_transfer_route_all_in_fee_missing/,
  );
});

test("rejects a route model that hides Aster USDT conversion", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      registry: sources.registry.replaceAll(
        'collateral_asset: "USDT"',
        'collateral_asset: "USDC"',
      ),
    }),
    /carry_aster_usdt_collateral_missing/,
  );
});

test("rejects collateral routes that are not refreshed by worker supervision", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      positions: sources.positions.replaceAll(
        "export async function refreshStoredCarryTransferRoutes",
        "async function refreshStoredCarryTransferRoutes",
      ),
    }),
    /carry_transfer_route_supervised_refresh_missing/,
  );
});

test("rejects collateral routes detached from the latest account state", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "route.source_account_state_commitment === source.account_state_commitment",
        "true",
      ),
    }),
    /carry_transfer_source_state_binding_missing/,
  );
});

test("rejects browser-supplied collateral routes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webClient: `${sources.webClient}\nconst transfer_routes = [];`,
    }),
    /carry_transfer_routes_browser_injection_present/,
  );
});

test("rejects a proxy that forwards collateral-route claims", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: `${sources.webRoute}\nconst transfer_routes = input.transfer_routes;`,
    }),
    /carry_transfer_routes_proxy_injection_present/,
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

test("rejects a terminal that hides capital-free public source synchronization", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("model.contractDataSkewMs", "null"),
    }),
    /carry_terminal_public_source_sync_missing/,
  );
});

test("rejects removal of the capital-free shadow-position boundary", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder
        .replaceAll("SHADOW POSITION · LIVE-DATA MODEL", "MODEL")
        .replaceAll("NO WALLET · NO DEPOSIT · NO ORDER", "READY"),
    }),
    /carry_terminal_shadow_position_missing|carry_terminal_shadow_safety_boundary_missing/,
  );
});

test("rejects a terminal that hides the signed risk mandate", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="RISK MANDATE"', 'label="POLICY"'),
    }),
    /carry_terminal_risk_mandate_display_missing/,
  );
});

test("rejects a browser mandate that hides owner-only capital operations", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webMandate: sources.webMandate.replaceAll(
        'owner_only_operations: ["fund", "transfer", "withdraw"]',
        'owner_only_operations: []',
      ),
    }),
    /carry_web_mandate_owner_only_missing/,
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

test("rejects a terminal that drops normalized liquidation economics", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll('label="LIQUIDATION"', 'label="RISK"'),
    }),
    /carry_terminal_liquidation_display_missing/,
  );
});

test("rejects a terminal that hides capital-free public index-basis evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("model.indexPriceDivergenceBps", "null"),
    }),
    /carry_terminal_public_index_basis_missing/,
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

test("rejects a monitor that trusts runway numbers without verified status", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("if (status === null)", "if (false)"),
    }),
    /margin_runway_status_required_missing/,
  );
});

test("rejects funding-flip confirmation that can reuse one observation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll("previousObservationAsOf === asOf", "false"),
    }),
    /carry_funding_flip_distinct_observation_gate_missing/,
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

test("rejects a terminal that sends a blocked third venue back through the same pair setup", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("CONNECT FLEET", "CONNECT PAIR"),
    }),
    /carry_terminal_fleet_remediation_missing/,
  );
});

test("rejects a fleet setup link scoped back down to one pair", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "/account?setup=carry&return_to=",
        "/account?setup=carry&long_venue=hyperliquid&return_to=",
      ),
    }),
    /carry_terminal_fleet_setup_scope_missing/,
  );
});

test("rejects selected-pair onboarding that silently expands to the full fleet", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll(
        "/account?setup=carry&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}&return_to=",
        "/account?setup=carry&return_to=",
      ),
    }),
    /carry_terminal_pair_setup_scope_missing/,
  );
});

test("rejects carry setup that cannot distinguish a platform authorization failure", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll("carryWorkerPlatformGate", "ignoredWorkerPlatformGate"),
    }),
    /carry_setup_worker_platform_gate_missing/,
  );
});

test("rejects carry setup that sends users back through wallet onboarding for a worker mismatch", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountConnections: sources.webAccountConnections.replaceAll("Venue connections are preserved", "Reconnect every wallet"),
    }),
    /carry_setup_wallet_loop_prevention_missing/,
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
