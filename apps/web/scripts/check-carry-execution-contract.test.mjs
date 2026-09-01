import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY_RELEASE_FILES,
  checkCarryExecutionContract,
  findUntrackedCarryReleaseFiles,
  loadCarryReleaseSources,
} from "./check-carry-execution-contract.mjs";

const sources = loadCarryReleaseSources();

function mutateSection(source, start, end, mutate) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing mutation start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing mutation end: ${end}`);
  const section = source.slice(startIndex, endIndex);
  const mutated = mutate(section);
  assert.notEqual(mutated, section, `mutation made no change in: ${start}`);
  return `${source.slice(0, startIndex)}${mutated}${source.slice(endIndex)}`;
}

test("accepts the complete cross-venue Carry execution contract", () => {
  assert.equal(checkCarryExecutionContract(sources).ok, true);
});

test("rejects Hyperliquid carry handling that loses post-broadcast ambiguity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      hyperliquidRunner: sources.hyperliquidRunner.replace(
        'return "submission_ambiguous" if broadcast_started else "pre_submit_failed"',
        'return "venue_rejected"',
      ),
    }),
    /hyperliquid_post_broadcast_ambiguity_classification_missing/,
  );
});

test("rejects Hyperliquid handling that trusts a generic venue rejection as no-submit proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        'return ["venue_access_required", "pre_submit_failed"].includes(error?.code);',
        'return ["venue_rejected", "venue_access_required", "pre_submit_failed"].includes(error?.code);',
      ),
    }),
    /hyperliquid_no_submit_proof_whitelist_missing/,
  );
});

test("rejects Turnkey Hyperliquid recovery that performs an untracked compensation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      hyperliquidTurnkey: `${sources.hyperliquidTurnkey}\nfunction compensateUnprotectedEntry() {}`,
    }),
    /hyperliquid_turnkey_untracked_compensation_forbidden/,
  );
});

test("rejects Turnkey Hyperliquid handling without an explicit broadcast boundary", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      hyperliquidTurnkey: sources.hyperliquidTurnkey.replaceAll(
        "markBroadcastStarted();",
        "void 0;",
      ),
    }),
    /hyperliquid_turnkey_broadcast_boundary_missing/,
  );
});

test("rejects Hyperliquid handling without explicit acknowledgement shapes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      hyperliquidRunner: sources.hyperliquidRunner.replaceAll(
        "explicit_order_acknowledgement(item, expected_cloids[index])",
        "item is not None",
      ),
    }),
    /hyperliquid_order_acknowledgement_shape_gate_missing/,
  );
});

test("rejects Turnkey Hyperliquid handling without explicit acknowledgement shapes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      hyperliquidTurnkey: sources.hyperliquidTurnkey.replace(
        "explicitOrderAcknowledgement(item, expectedCloids[index])",
        "statuses.every(Boolean)",
      ),
    }),
    /hyperliquid_turnkey_order_acknowledgement_shape_gate_missing/,
  );
});

test("rejects restart recovery without explicit original-order broadcast proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "proof?.original_order_broadcast_proven === true",
        "proof?.original_order_broadcast_proven !== false",
      ),
    }),
    /carry_recovery_original_broadcast_gate_missing/,
  );
});

test("rejects Lighter recovery that coerces a missing venue order id into proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replace(
        "nonnegativeIntegerOrNull(order?.order_index) !== null",
        "Number.isSafeInteger(Number(order?.order_index))",
      ),
    }),
    /lighter_original_order_id_proof_missing/,
  );
});

test("rejects release validation when any venue bypasses the atomic policy-and-attempt claim", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        "pendingAttempt = await claimSubmissionAfterPolicyValidation({",
        "pendingAttempt = await claimExecutionAttemptOnly({",
      ),
    }),
    /durable_atomic_policy_adapter_claim_missing/,
  );
});

test("rejects Coinbase, Solana perps, or Jupiter network access before a durable pending claim", () => {
  for (const [start, end, code] of [
    ["export async function executeCoinbaseOrder(", "export async function reconcileCoinbaseOrder(", /coinbase_pending_claim_before_(reservation|network)_missing|durable_atomic_policy_adapter_claim_missing/],
    ["export async function executeSolanaPerpsOrder(", "export async function executeJupiterSwapOrder(", /solana_perps_pending_claim_before_network_missing|durable_atomic_policy_adapter_claim_missing/],
    ["export async function executeJupiterSwapOrder(", "export async function executeAutopilotOrder(", /jupiter_pending_claim_before_network_missing|durable_atomic_policy_adapter_claim_missing/],
  ]) {
    assert.throws(
      () => checkCarryExecutionContract({
        ...sources,
        privateExecution: mutateSection(sources.privateExecution, start, end, (section) => section.replace(
          "pending = await claimSubmissionAfterPolicyValidation({",
          "pending = await claimExecutionAttemptOnly({",
        )),
      }),
      code,
    );
  }
});

test("rejects Coinbase ambiguity paths that release omnibus reservation before exact reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: mutateSection(
        sources.privateExecution,
        "export async function executeCoinbaseOrder(",
        "export async function reconcileCoinbaseOrder(",
        (section) => section.replace(
          "  const receipt = executionReceipt({",
          "  await state.releaseOmnibus({});\n  const receipt = executionReceipt({",
        ),
      ),
    }),
    /coinbase_ambiguous_omnibus_release_present/,
  );
});

test("rejects a venue execution vault without exact mode, network, and venue AAD", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        'opened.associatedDataText !== aadParts.join("|")',
        "false",
      ),
    }),
    /venue_execution_vault_exact_context_aad_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        'aadParts.push(`venue:${venueId}`)',
        "void venueId",
      ),
    }),
    /venue_execution_vault_venue_aad_missing/,
  );
});

test("rejects preview authorization that is reusable or detached from exact approval", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivateAccountStore: sources.webPrivateAccountStore.replace(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_private_account_connector_work_orders_preview_unique",
        "CREATE INDEX IF NOT EXISTS idx_private_account_connector_work_orders_preview_unique",
      ),
    }),
    /connector_preview_unique_index_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivateAccountRouteLib: sources.webPrivateAccountRouteLib.replace(
        "const claimed = await claimConnectorWorkOrderForPreview({",
        "const claimed = await putConnectorWorkOrder({",
      ),
    }),
    /connector_preview_claim_route_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivateAccountRouteLib: sources.webPrivateAccountRouteLib.replace(
        "workOrderRecord.approval_commitment !== input.approval_commitment",
        "workOrderRecord.approval_commitment === input.approval_commitment",
      ),
    }),
    /connector_preview_approval_binding_missing/,
  );
});

test("rejects release validation when quota updates are detached from the claimed attempt", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        'client.query("BEGIN ISOLATION LEVEL READ COMMITTED")',
        'client.query("SELECT 1")',
      ),
    }),
    /durable_atomic_policy_postgres_transaction_missing/,
  );
});

test("rejects rearming a failed-no-submit attempt without zero-submit proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        "attempt.submit_count === 0",
        "attempt.submit_count >= 0",
      ),
    }),
    /durable_atomic_policy_rearm_zero_submit_missing/,
  );
});

test("rejects rearming a failed-no-submit attempt with prior ambiguity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        "Number(attempt.ambiguity_retry_count || 0) === 0",
        "Number(attempt.ambiguity_retry_count || 0) >= 0",
      ),
    }),
    /durable_atomic_policy_rearm_no_ambiguity_missing/,
  );
});

test("rejects a Postgres policy rearm without exact-prior compare", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        "AND attempt_json = $4::jsonb",
        "AND attempt_json IS NOT NULL",
      ),
    }),
    /durable_atomic_policy_postgres_exact_prior_compare_missing/,
  );
});

test("rejects release validation when SQLite bypasses its atomic state transaction", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replace(
        'if (typeof atomicUpdate === "function") return atomicUpdate(mutator);',
        'if (false) return atomicUpdate(mutator);',
      ),
    }),
    /durable_atomic_policy_sqlite_routing_missing/,
  );
});

test("rejects release validation without distinct allowed and denied attempt bindings", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        "denied_attempt: deniedAttempt",
        "denied_attempt: allowedAttempt",
      ),
    }),
    /durable_atomic_policy_denied_binding_missing/,
  );
});

test("rejects release validation without direct Lighter atomic submission proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighterConcurrencyTest: sources.lighterConcurrencyTest.replaceAll(
        "atomically permits exactly one Lighter submission under concurrent identical requests",
        "does not prove concurrent Lighter submission",
      ),
    }),
    /lighter_atomic_submit_concurrency_test_missing/,
  );
});

test("rejects terminal status inherited from lower-fill evidence", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "terminal = proof?.final_venue_execution_proven === true;\n      selectedEvidence = true;\n      terminalRegressed = false;",
        "terminal ||= proof?.final_venue_execution_proven === true;\n      selectedEvidence = true;",
      ),
    }),
    /carry_recovery_highest_fill_terminal_reset_missing/,
  );
});

test("rejects same-fill terminal evidence that can regress true to false open", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "if (selectedEvidence && terminal && !candidateTerminal) {\n        terminal = false;\n        terminalRegressed = true;",
        "if (selectedEvidence && terminal && !candidateTerminal) {\n        terminal = true;\n        terminalRegressed = false;",
      ),
    }),
    /carry_recovery_terminal_regression_fail_closed_missing/,
  );
});

test("rejects recovery that cannot advance same-fill evidence from nonterminal to terminal", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "} else if (!terminalRegressed && candidateTerminal) {\n        terminal = true;",
        "} else if (false) {\n        terminal = true;",
      ),
    }),
    /carry_recovery_terminal_progression_missing/,
  );
});

test("rejects exact base evidence retained below the selected fill amount", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "let filledBase = evidenceMicro === filledMicro ? evidenceBase : null;",
        "let filledBase = evidenceBase;",
      ),
    }),
    /carry_recovery_highest_fill_exact_base_binding_missing/,
  );
});

test("rejects terminal proof detached from the final selected fill amount", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "if (evidenceMicro !== filledMicro) terminal = false;",
        "if (evidenceMicro !== filledMicro) terminal = true;",
      ),
    }),
    /carry_recovery_terminal_fill_binding_missing/,
  );
});

test("rejects a full requested fill applied before terminal proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "const applicableFilledMicro = !progress.terminal && progress.filledMicro === requestedMicro\n    ? appliedMicro\n    : progress.filledMicro;",
        "const applicableFilledMicro = progress.filledMicro;",
      ),
    }),
    /carry_recovery_nonterminal_full_fill_withhold_missing/,
  );
});

test("rejects reconciled unwind progress detached from durable position state", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        'if (action === "unwind" && targetCumulative > currentCumulative) {',
        "if (false) {",
      ),
    }),
    /carry_recovery_reconciled_unwind_position_sync_missing/,
  );
});

test("rejects terminal saga advancement before durable unwind position state", () => {
  const safePositionWrite = `    await putRecoveryPosition({
      state,
      session,
      saga: current,
      leg: { ...currentLeg, unwind_filled_micro_usdc: targetCumulative },
      filledBase,
      nowMs,
    });`;
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(safePositionWrite, ""),
    }),
    /carry_recovery_(reconciled_unwind_position_sync|position_before_terminal)_missing/,
  );
});

test("rejects removal of terminal-zero crash recovery coverage", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replace(
        "recovers a persisted terminal-zero unwind receipt without retrying the order",
        "ignores a persisted terminal-zero unwind receipt",
      ),
    }),
    /carry_recovery_terminal_zero_crash_test_missing/,
  );
});

test("rejects recovery submission without a durable pre-broadcast intent", () => {
  const source = sources.multiLegOrchestrator;
  const start = source.indexOf(
    'const workOrderCommitment = recoveryWorkOrder(current, leg, "unwind", remainingMicro);',
  );
  const head = source.slice(0, start);
  const tail = source.slice(start).replace("await storeRecoveryAccounting({", "await Promise.resolve({");
  assert.throws(
    () => checkCarryExecutionContract({ ...sources, multiLegOrchestrator: head + tail }),
    /carry_recovery_unwind_intent_before_submit_missing/,
  );
});

test("rejects removal of a two-phase unwind crash boundary", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replace(
        'for (const boundary of ["applied-accounting", "flat-position"])',
        'for (const boundary of ["applied-accounting"])',
      ),
    }),
    /carry_recovery_two_phase_crash_matrix_missing/,
  );
});

test("rejects removal of the full-base nonterminal completion regression", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replace(
        "keeps a full-base nonterminal completion compensating until exact reconciliation",
        "accepts full-base completion without terminal proof",
      ),
    }),
    /carry_recovery_full_nonterminal_completion_test_missing/,
  );
});

test("rejects removal of zero-applied accounting before residual reconciliation", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replace(
        "[6_000_000, 0]",
        "[6_000_000, 4_000_000]",
      ),
    }),
    /carry_recovery_partial_nonterminal_accounting_test_missing/,
  );
});

test("rejects partial completion that overwrites original submission state", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreMultiLeg: sources.coreMultiLeg.replace(
        "const originalSubmissionStatus = leg.submission_status;\n    applyFill(leg, event.cumulative_filled_micro_usdc, \"filled_micro_usdc\");\n    leg.submission_status = originalSubmissionStatus;",
        "applyFill(leg, event.cumulative_filled_micro_usdc, \"filled_micro_usdc\");",
      ),
    }),
    /carry_partial_completion_submission_status_preservation_missing/,
  );
});

test("rejects removal of crash-after-cancel terminal progression proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestratorTest: sources.multiLegOrchestratorTest.replace(
        "recovers a crash after exact cancel without cancelling twice",
        "does not prove crash-after-cancel recovery",
      ),
    }),
    /carry_cancel_ack_restart_test_missing/,
  );
});

test("rejects recovery decimal comparison that bypasses bounded canonical parsing", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "function samePositiveDecimal(left, right) {\n  const normalizedLeft = canonicalExactPositiveDecimal(left);\n  return normalizedLeft !== null && normalizedLeft === canonicalExactPositiveDecimal(right);\n}",
        "function samePositiveDecimal(left, right) {\n  return Number(left) === Number(right);\n}",
      ),
    }),
    /carry_recovery_exact_decimal_comparator_missing/,
  );
});

test("rejects unbounded recovery decimal precision", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      multiLegOrchestrator: sources.multiLegOrchestrator.replace(
        "if (match[1].length + fraction.length > MAX_EXACT_BASE_DIGITS || fraction.length > MAX_EXACT_BASE_SCALE) return null;",
        "if (false) return null;",
      ),
    }),
    /carry_recovery_exact_decimal_bounds_missing/,
  );
});

test("rejects release validation without partial-fill and restart recovery proofs", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lifecycleTest: sources.lifecycleTest
        .replaceAll("restart-frozen reconciled entry resumes active or exiting without resubmission", "missing restart-frozen proof")
        .replaceAll("restart recovery closes only the failed leg of a symmetric partial entry", "missing partial recovery proof")
        .replaceAll("restart closes a symmetric partial entry once and remains proven flat with zero orders", "missing flat-zero proof"),
    }),
    /carry_restart_frozen_entry_reconciliation_test_missing|carry_partial_exit_missing_leg_recovery_test_missing|carry_partial_restart_flat_zero_test_missing/,
  );
});

test("rejects a no-submit assembler that can persist sealed venue access", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      noSubmitEvidenceAssembler: sources.noSubmitEvidenceAssembler.replaceAll(
        "sanitizeRequest",
        "persistRawRequest",
      ),
    }),
    /carry_no_submit_assembler_sanitization_missing/,
  );
});

test("rejects a Lighter runner that calls an API absent from the pinned SDK", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighterRunner: sources.lighterRunner
        .replaceAll("account_active_orders(", "account_orders(")
        .replaceAll("account_inactive_orders(", "account_orders("),
    }),
    /lighter_pinned_active_order_api_missing|lighter_pinned_inactive_order_api_missing|lighter_unavailable_order_api_present/,
  );
});

test("rejects a worker image that never verifies the pinned Lighter SDK surface", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerDockerfile: sources.workerDockerfile.replaceAll("account_active_orders", "unchecked_active_orders"),
    }),
    /lighter_image_active_order_api_guard_missing/,
  );
});

test("rejects funding observation evaluated against its pre-fetch clock", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      fundingPersistence: sources.fundingPersistence.replace(
        "const completedAtMs = now();",
        "const completedAtMs = requestedAtMs;",
      ),
    }),
    /carry_funding_post_fetch_clock_missing/,
  );
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

test("rejects release proof assembled from the truncated Carry UI tail", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial
        .replaceAll("readCompleteCarryLifecycleJournal", "readTruncatedCarryLifecycleTail"),
    }),
    /carry_release_full_lifecycle_journal_missing/,
  );
});

test("rejects Carry entry without an interprocess state assertion", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll("PRIVATE_AGENT_STATE_SINGLE_PROCESS_OK", "PRIVATE_AGENT_STATE_UNSAFE"),
    }),
    /carry_json_single_process_assertion_missing/,
  );
});

test("rejects a route surface that allows stateful work without interprocess safety", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll(
        "stateAccessAllowedWithoutInterprocessSafety",
        "stateAccessAlwaysAllowed",
      ),
    }),
    /carry_global_state_route_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      serverTest: sources.serverTest.replaceAll(
        "blocks risk-increasing and non-emergency routes when interprocess state is unsafe",
        "allows stateful routes without interprocess state",
      ),
    }),
    /carry_global_state_route_test_missing/,
  );
});

test("rejects an unsafe-state gate without authenticated emergency reduction", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replaceAll(
        "UNSAFE_STATE_EMERGENCY_ROUTES",
        "UNSAFE_STATE_NO_EMERGENCY_ROUTES",
      ),
    }),
    /carry_emergency_state_allowlist_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replaceAll(
        "enforceEmergencyRiskReductionInstruction",
        "permitEmergencyExecutionWithoutInspection",
      ),
    }),
    /carry_emergency_decrypted_instruction_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      serverTest: sources.serverTest.replaceAll(
        "unsafe_state_disguised_entry_work_order_123",
        "unsafe_state_unchecked_entry_work_order_123",
      ),
    }),
    /carry_emergency_disguised_entry_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        '  "/venues/lighter/orders",',
        '  "/venues/lighter/orders",\n  "/venues/solana-perps/orders",',
      ),
    }),
    /carry_unsafe_solana_order_route_allowed/,
  );
});

test("rejects unsafe-state exit or kill routes that bypass the exact fail-closed allowlist", () => {
  for (const [route, code] of [
    ['  "/carry/positions/exit-request",\n', /carry_unsafe_exit_route_allowed/],
    ['  "/autopilot/tri-venue/kill",\n', /carry_unsafe_tri_kill_route_allowed/],
  ]) {
    assert.throws(
      () => checkCarryExecutionContract({
        ...sources,
        server: sources.server.replace(
          '  "/carry/positions/read",\n',
          `  "/carry/positions/read",\n${route}`,
        ),
      }),
      code,
    );
  }
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        "return UNSAFE_STATE_EMERGENCY_ROUTES.has(path);",
        'return UNSAFE_STATE_EMERGENCY_ROUTES.has(path) || path.endsWith("/kill");',
      ),
    }),
    /carry_unsafe_state_exact_allowlist_gate_missing/,
  );
});

test("rejects non-event mutation of lifecycle-derived Carry projections", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerState: sources.workerState.replaceAll(
        "carry_lifecycle_projection_write_requires_event",
        "carry_lifecycle_projection_write_allowed",
      ),
    }),
    /carry_lifecycle_projection_guard_missing/,
  );
});

test("rejects a Phala surface that cannot configure the single-process assertion", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      phalaCompose: sources.phalaCompose.replaceAll("PRIVATE_AGENT_STATE_SINGLE_PROCESS_OK", "PRIVATE_AGENT_STATE_UNSAFE"),
    }),
    /carry_phala_single_process_env_missing/,
  );
});

test("rejects Carry release without an origin-one lifecycle gate", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      releaseMaterial: sources.releaseMaterial.replace(
        "record.lifecycle_journal.origin_sequence !== 1",
        "record.lifecycle_journal.origin_sequence < 1",
      ),
    }),
    /carry_release_lifecycle_origin_gate_missing/,
  );
});

test("rejects an image workflow that skips worker tests", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      workerImageWorkflow: sources.workerImageWorkflow.replace("run: node --test", "run: node --check src/server.js"),
    }),
    /carry_worker_image_test_command_missing/,
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

test("rejects an unattested or report-detached portfolio value response", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        "worker_authentication: authenticateCarryPortfolioValueReport({",
        "worker_authentication: { report_replay_bound: true }, //",
      ),
    }),
    /carry_portfolio_value_worker_response_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replace(
        "verifyCarryPortfolioValueWorkerAuthentication({",
        "trustCarryPortfolioValueWorkerAuthentication({",
      ),
    }),
    /carry_portfolio_value_web_verification_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPortfolioValueAuthentication: sources.webPortfolioValueAuthentication.replace(
        "carry:portfolio-value-report:",
        "carry:unbound-report:",
      ),
    }),
    /carry_portfolio_value_web_report_binding_missing/,
  );
});

test("rejects release evidence detached from the attested worker response", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        "worker_authentication: authenticateCarryReleaseMaterial({",
        "worker_authentication: { material_replay_bound: true }, //",
      ),
    }),
    /carry_release_material_worker_response_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replace(
        "verifyCarryReleaseMaterialWorkerAuthentication({",
        "trustCarryReleaseMaterialWorkerAuthentication({",
      ),
    }),
    /carry_release_material_gateway_authentication_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webReleaseMaterialAuthentication: sources.webReleaseMaterialAuthentication.replace(
        "carry:release-response:",
        "carry:release-unbound:",
      ),
    }),
    /carry_release_material_gateway_exact_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      server: sources.server.replace(
        ', "/carry/positions/release-evidence"].includes(url.pathname)',
        "].includes(url.pathname)",
      ),
    }),
    /carry_release_material_worker_no_submit_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webRoute: sources.webRoute.replace(
        ' || action === "release_evidence" ? { "x-ghola-no-submit-verify": "true" }',
        ' ? { "x-ghola-no-submit-verify": "true" }',
      ),
    }),
    /carry_release_material_gateway_no_submit_gate_missing/,
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

test("rejects private-prime evidence without its exact signed request context", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privatePrimeAuthentication: sources.privatePrimeAuthentication.replace(
        "const context = Object.freeze({",
        "const context = ({",
      ),
    }),
    /carry_private_prime_worker_signed_context_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeAuthentication: sources.webPrivatePrimeAuthentication.replace(
        "context.work_order_commitment === workOrderCommitment",
        "workOrderCommitment.length > 0",
      ),
    }),
    /carry_private_prime_gateway_signed_context_missing/,
  );
});

test("rejects a gateway that conflates negative readiness expiry with response authentication", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webPrivatePrimeAuthentication: sources.webPrivatePrimeAuthentication.replace(
        "checkedAtMs < now_ms - MAX_AUTHENTICATED_RESPONSE_AGE_MS",
        "expiresAtMs > now_ms",
      ),
    }),
    /carry_private_prime_gateway_response_freshness_missing|carry_private_prime_gateway_negative_readiness_rejected/,
  );
});

test("rejects a no-submit proof detached from raw pair evidence or the pinned worker signer", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      preflight: sources.preflight.replace(
        "matrix.readiness_evidence = stored.evidence",
        "matrix.readiness_evidence = undefined",
      ),
    }),
    /carry_three_venue_raw_readiness_evidence_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      noSubmitEvidenceVerifier: sources.noSubmitEvidenceVerifier.replaceAll(
        "expected_signer_public_keys_b64",
        "self_described_signer_keys_b64",
      ),
    }),
    /carry_no_submit_independent_signer_pin_missing/,
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
        "const canSave = routeQualified && actionableProof && creationProofFreshness.fresh",
        "const canSave = actionableProof",
      ),
    }),
    /carry_creation_stale_action_gate_missing/,
  );
});

test("rejects a terminal that unmounts an active check during a transient route gap", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(
        "const terminalExecution = selectedExecution || retainedForDesiredRoute;",
        "const terminalExecution = selectedExecution;",
      ),
    }),
    /carry_terminal_transient_route_retention_missing/,
  );
});

test("rejects a terminal that can carry pending proof state across routes", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replace(
        "key={carryRouteKey(terminalExecution.candidate)}",
        "",
      ),
    }),
    /carry_terminal_route_state_scope_missing/,
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

test("rejects Carry onboarding without visible fail-closed account readiness", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "data-carry-account-readiness",
        "data-removed-account-readiness",
      ),
    }),
    /carry_setup_account_readiness_status_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "No wallet action was enabled.",
        "Wallet action may continue.",
      ),
    }),
    /carry_setup_account_readiness_fail_closed_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "accountReadinessReady && scopedActivationNeeded",
        "scopedActivationNeeded",
      ),
    }),
    /carry_setup_account_readiness_activation_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replace(
        "getHyperliquidExecutionVaultStatus(),",
        "getHyperliquidExecutionVaultStatus().catch(() => null),",
      ),
    }),
    /carry_setup_vault_status_fail_closed_missing|carry_setup_vault_status_soft_fail_forbidden/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetupTest: sources.webAccountSetupTest.replace(
        "blocks wallet preparation on vault-status failure and unlocks only after a successful retry",
        "retries account readiness",
      ),
    }),
    /carry_setup_vault_status_retry_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "accountReadinessGenerationRef.current",
        "accountReadinessGeneration",
      ),
    }),
    /carry_setup_readiness_generation_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetup: sources.webAccountSetup.replaceAll(
        "accountReadinessResolvedScope === recoveryUserScope",
        "Boolean(accountReadinessResolvedScope)",
      ),
    }),
    /carry_setup_readiness_user_scope_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetupTest: sources.webAccountSetupTest.replace(
        "ignores a readiness response that resolves after logout",
        "handles logout",
      ),
    }),
    /carry_setup_readiness_logout_race_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webAccountSetupTest: sources.webAccountSetupTest.replace(
        "rechecks a switched user and ignores the prior user's late response",
        "handles a switched user",
      ),
    }),
    /carry_setup_readiness_user_switch_test_missing/,
  );
});

test("rejects a misleading committed-source attestation claim", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executionContract: sources.executionContract.replaceAll(
        "clean release-critical sources",
        ["committed", "sources"].join(" "),
      ),
    }),
    /carry_source_tree_guard_status_missing|carry_source_tree_guard_misleading_status_present/,
  );
});

test("rejects source attestation that can follow release-critical symlinks", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      sourceTreeAttestation: sources.sourceTreeAttestation.replaceAll(
        "carry_release_source_not_regular",
        "carry_release_source_allowed",
      ),
    }),
    /carry_source_tree_regular_file_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      sourceTreeAttestationTest: sources.sourceTreeAttestationTest.replace(
        "rejects a release-critical symlink escape",
        "accepts a release-critical symlink",
      ),
    }),
    /carry_source_tree_symlink_escape_test_missing/,
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

test("rejects a terminal without exact-once setup handoff proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replace(
        "resolves the setup handoff after exactly one no-submit request",
        "resolves the setup handoff",
      ),
    }),
    /carry_terminal_no_submit_handoff_test_missing/,
  );
});

test("rejects a terminal without a parent-scoped in-flight no-submit latch", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webTradeWorkspace: sources.webTradeWorkspace.replace(
        "onAutoRunNoSubmitStarted={beginCarryNoSubmitRequest}",
        "onAutoRunNoSubmitStarted={undefined}",
      ),
    }),
    /carry_terminal_no_submit_parent_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replace(
        "keeps one no-submit request when the keyed terminal remounts in flight",
        "remounts the keyed terminal in flight",
      ),
    }),
    /carry_terminal_no_submit_remount_test_missing/,
  );
});

test("rejects a terminal that resolves an in-flight handoff against a stale query", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webTradeWorkspace: sources.webTradeWorkspace.replace(
        "new URLSearchParams(workspaceQueryRef.current)",
        "new URLSearchParams(workspaceQuery)",
      ),
    }),
    /carry_terminal_no_submit_latest_query_resolution_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webTradeLifecycleTest: sources.webTradeLifecycleTest.replace(
        "resolves an in-flight carry handoff against the latest workspace query",
        "resolves an in-flight carry handoff",
      ),
    }),
    /carry_terminal_no_submit_latest_query_test_missing/,
  );
});

test("rejects a terminal without auth-expiry no-retry proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replace(
        "keeps an auth-expired handoff pending and never retries automatically",
        "handles an auth-expired handoff",
      ),
    }),
    /carry_terminal_no_submit_auth_expiry_test_missing/,
  );
});

test("rejects a terminal that can auto-check a stale retained route", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replace(
        "!routeQualified || autoRunNoSubmitConsumedRef.current",
        "autoRunNoSubmitConsumedRef.current",
      ),
    }),
    /carry_terminal_stale_route_check_gate_missing/,
  );
});

test("rejects a terminal without stale-route economics quarantine proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilderTest: sources.webCarryBuilderTest.replace(
        "hides retained route economics when the route is stale",
        "renders a retained route when the route is stale",
      ),
    }),
    /carry_terminal_stale_route_economics_test_missing/,
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

test("rejects web reconciliation detached from the exact venue", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webConnectorReconciliation: sources.webConnectorReconciliation.replace(
        'if (venueId === "aster") return "/venues/aster/reconcile";',
        'if (venueId === "aster") return "/hyperliquid/reconcile";',
      ),
    }),
    /web_aster_reconcile_route_binding_missing/,
  );
});

test("rejects Coinbase reconciliation without exact venue, client, product, and order proof", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webConnectorReconciliation: sources.webConnectorReconciliation.replace(
        "proof.target_product_matched === true",
        "proof.target_product_matched !== false",
      ),
    }),
    /connector_coinbase_target_product_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coinbase: sources.coinbase.replace(
        "const exactTargetMatched = targetOrderMatched && targetClientOrderMatched && targetProductMatched;",
        "const exactTargetMatched = targetOrderMatched && targetClientOrderMatched;",
      ),
    }),
    /coinbase_exact_target_conjunction_missing/,
  );
});

test("rejects Coinbase response-loss recovery that requires a persisted order id", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coinbase: sources.coinbase.replace(
        "if (instruction.reconcile?.target_work_order_commitment && !targetOrderId)",
        "if (false && instruction.reconcile?.target_work_order_commitment && !targetOrderId)",
      ),
    }),
    /coinbase_targeted_reconcile_fallback_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coinbase: sources.coinbase.replace(
        "order?.client_order_id === clientOrderId && order?.product_id === productId",
        "order?.client_order_id === clientOrderId || order?.product_id === productId",
      ),
    }),
    /coinbase_targeted_reconcile_lookup_not_exact/,
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

test("rejects value accounting that trusts a hash without replaying its committed depth", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      stablecoinConversion: sources.stablecoinConversion.replace(
        "export function verifyCashflowValuationEvidence",
        "function trustCashflowValuationEvidence",
      ),
    }),
    /cashflow_valuation_replay_verifier_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      executor: sources.executor.replace(
        "verifyCashflowValuationEvidence(row)",
        "normalizeCashflowValuation(row)",
      ),
    }),
    /carry_execution_valuation_replay_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replace(
        "return normalizedValuation.bound_value_micro_usdc;",
        "return amount;",
      ),
    }),
    /cashflow_valuation_exact_bound_conversion_missing/,
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

test("rejects Lighter readiness inferred from an unbound account response", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replaceAll(
        "accountStatus === LIGHTER_ACCOUNT_STATUS_ACTIVE",
        "true",
      ),
    }),
    /lighter_account_status_readiness_gate_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replaceAll("expectedAccountIndex", "ignoredAccountIndex"),
    }),
    /lighter_account_index_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighter: sources.lighter.replaceAll(
        "sanitizeAccount(result.account, {}, { expectedAccountIndex: credential.account_index })",
        "sanitizeAccount(result.account)",
      ),
    }),
    /lighter_credential_account_binding_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighterTest: sources.lighterTest.replaceAll(
        "derives Lighter trade readiness only from a bound active account response",
        "assumes Lighter trade readiness",
      ),
    }),
    /lighter_account_readiness_test_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      lighterTest: sources.lighterTest.replaceAll(
        "assert.equal(inactive.can_trade, false)",
        "assert.equal(inactive.can_trade, true)",
      ),
    }),
    /lighter_credential_inactive_test_missing/,
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

test("rejects portfolio value reporting detached from its cashflow FX basis", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        'funding_valuation_basis: "usdc_equivalent_at_ledger_ingestion"',
        'funding_valuation_basis: "unbound"',
      ),
    }),
    /carry_portfolio_value_fx_basis_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryBuilder: sources.webCarryBuilder.replaceAll("UNVERIFIED FX BASIS", "REAL"),
    }),
    /carry_terminal_portfolio_fx_basis_failure_missing/,
  );
});

test("rejects portfolio value reporting that trusts stored aggregates without replaying ledger claims", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_portfolio_value_ledger_replay_mismatch",
        "carry_portfolio_value_aggregate_only",
      ),
    }),
    /carry_portfolio_value_ledger_replay_missing/,
  );
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      coreCarry: sources.coreCarry.replaceAll(
        "carry_portfolio_value_processed_claim_ids_mismatch",
        "carry_portfolio_value_claims_unchecked",
      ),
    }),
    /carry_portfolio_value_claim_replay_missing/,
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

test("rejects substring matching for encrypted execution-instruction AAD", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        "return associatedDataText === expectedAad;",
        "return associatedDataText.includes(expectedAad);",
      ),
    }),
    /carry_execution_instruction_exact_aad_missing/,
  );
});

test("rejects an encrypted execution-instruction matcher disconnected from ingress", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      privateExecution: sources.privateExecution.replace(
        "if (!privateExecutionInstructionAssociatedDataMatches({",
        "if (false && !privateExecutionInstructionAssociatedDataMatches({",
      ),
    }),
    /carry_execution_instruction_aad_callsite_missing/,
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

test("rejects an Aster stream without live notional depth", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll("@depth20@100ms", "@bookTicker"),
    }),
    /aster_live_depth_feed_missing/,
  );
});

test("rejects dYdX live depth without message-sequence continuity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "sequence !== state.sequence + BigInt(1)",
        "false",
      ),
    }),
    /dydx_live_depth_gap_gate_missing/,
  );
});

test("rejects dYdX live depth frames without exact connection binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "connectionId !== state.connectionId",
        "false",
      ),
    }),
    /dydx_live_depth_frame_connection_binding_missing/,
  );
});

test("rejects dYdX handshake logic that drops interleaved updates", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "[...subscriptionFrames, ...state.pending]",
        "[...subscriptionFrames]",
      ),
    }),
    /dydx_live_depth_interleaved_handshake_missing/,
  );
});

test("rejects dYdX live depth without connection binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "state.connectionId !== connectionId",
        "false",
      ),
    }),
    /dydx_live_depth_connection_binding_missing/,
  );
});

test("rejects dYdX live depth without protocol-version binding", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "state.protocolVersion !== version",
        "false",
      ),
    }),
    /dydx_live_depth_version_binding_missing/,
  );
});

test("rejects edgeX live depth without version continuity", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "startVersion > existingBook.sequence + BigInt(1)",
        "false",
      ),
    }),
    /edgex_live_depth_gap_gate_missing/,
  );
});

test("rejects edgeX depth without a crossed-book quarantine", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll("bookIsCrossed(book)", "false"),
    }),
    /edgex_live_depth_crossed_book_gate_missing/,
  );
});

test("rejects orderbook quarantine that retains stale BBO values", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace(
        "bestBid = orderbookInvalidated ? null",
        "bestBid = false ? null",
      ),
    }),
    /carry_live_orderbook_bbo_clear_missing/,
  );
});

test("rejects orderbook quarantine that an unrelated patch can revive", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryMarket: sources.webCarryMarket.replace(
        "orderbookInvalidated ? { orderbook: 0 }",
        "false ? { orderbook: 0 }",
      ),
    }),
    /carry_live_orderbook_persistent_quarantine_missing/,
  );
});

test("rejects live depth that advances past malformed levels", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace("size < 0", "false"),
    }),
    /carry_live_depth_malformed_level_gate_missing/,
  );
});

test("rejects live depth without a bounded handshake watchdog", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll(
        "CARRY_STREAM_HANDSHAKE_TIMEOUT_MS",
        "REMOVED_HANDSHAKE_TIMEOUT",
      ),
    }),
    /carry_live_depth_handshake_timeout_missing/,
  );
});

test("rejects live depth without a bounded silence watchdog", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll(
        "CARRY_STREAM_SILENCE_TIMEOUT_MS",
        "REMOVED_SILENCE_TIMEOUT",
      ),
    }),
    /carry_live_depth_silence_timeout_missing/,
  );
});

test("rejects dYdX depth without logical-offset uncrossing", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll(
        "uncrossDydxBook",
        "REMOVED_DYDX_UNCROSS",
      ),
    }),
    /dydx_live_depth_uncross_missing/,
  );
});

test("rejects a venue-wide silence watchdog that can mask a dead book", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll(
        "bookWatchdogs",
        "venueWatchdogs",
      ),
    }),
    /carry_live_depth_per_book_watchdog_missing/,
  );
});

test("rejects edgeX live depth that accepts backward replacement snapshots", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replaceAll("existingBook.sequence", "null"),
    }),
    /edgex_live_depth_backward_snapshot_gate_missing/,
  );
});

test("rejects a live publisher that retains stale component fields after publication", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryLiveMarket: sources.webCarryLiveMarket.replace(
        "const batch = [...patches.values()];\n    patches.clear();",
        "const batch = [...patches.values()];",
      ),
    }),
    /carry_live_publisher_sticky_patch_forbidden/,
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

test("rejects a terminal that keeps committed evidence after live snapshot patches", () => {
  assert.throws(
    () => checkCarryExecutionContract({
      ...sources,
      webCarryChart: sources.webCarryChart.replaceAll("committedEvidenceResponse", "data"),
    }),
    /carry_live_patch_evidence_downgrade_missing/,
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
