#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const PROGRAMMATIC_MODES = new Set(["turnkey_delegated", "programmatic_generated"]);
const EXPECTED_PROGRAMMATIC = new Map([
  ["hyperliquid", "turnkey_delegated"],
  ["aster", "programmatic_generated"],
  ["lighter", "programmatic_generated"],
]);
const EXPECTED_AUTHORIZERS = new Map([
  ["hyperliquid", ["turnkey_venue_owner"]],
  ["aster", ["turnkey_venue_owner", "external_owner_signature"]],
  ["lighter", ["turnkey_venue_owner"]],
]);
const EXPECTED_GENERATED_CUSTODY = new Map([
  ["hyperliquid", ["turnkey_non_exportable"]],
  ["aster", ["turnkey_non_exportable", "direct_to_attested_runtime"]],
  ["lighter", ["direct_to_attested_runtime"]],
]);
const EXPECTED_UNSUPPORTED = ["backpack", "drift", "rfq_network"];
const UNSAFE_PERMISSIONS = ["withdraw", "transfer", "credential_admin", "secret_export"];

export function checkVenueExecutionCredentialContract(contract) {
  const failures = [];
  if (contract?.version !== 1) failures.push("contract_version_required");
  if (contract?.default_disposition !== "blocked") failures.push("default_blocked_required");
  if (contract?.silent_provisioning_allowed !== false) failures.push("silent_provisioning_must_be_blocked");

  const unsafe = Array.isArray(contract?.unsafe_execution_permissions)
    ? contract.unsafe_execution_permissions
    : [];
  for (const permission of UNSAFE_PERMISSIONS) {
    if (!unsafe.includes(permission)) failures.push(`${permission}_permission_guard_required`);
  }

  const venues = object(contract?.venues);
  for (const [venueId, expectedMode] of EXPECTED_PROGRAMMATIC) {
    const venue = object(venues[venueId]);
    const modes = strings(venue.provisioning_modes);
    const implemented = strings(venue.implemented_provisioning_modes);
    if (!modes.includes(expectedMode)) failures.push(`${venueId}_programmatic_capability_required`);
    if (!new Set(["exact_owner_address", "verified_owner_association"]).has(venue.owner_binding)) {
      failures.push(`${venueId}_owner_association_required`);
    }
    if (!sameStrings(strings(venue.programmatic_authorizers), EXPECTED_AUTHORIZERS.get(venueId))) {
      failures.push(`${venueId}_owner_authorizer_contract_invalid`);
    }
    if (!sameStrings(strings(venue.generated_secret_custody), EXPECTED_GENERATED_CUSTODY.get(venueId))) {
      failures.push(`${venueId}_generated_secret_custody_invalid`);
    }
    if (!implemented.includes(expectedMode)) failures.push(`${venueId}_programmatic_implementation_required`);
  }

  const lighter = object(venues.lighter);
  if (lighter.owner_private_key_handling !== "turnkey_non_exportable_change_pub_key_transaction") {
    failures.push("lighter_non_exportable_owner_transaction_required");
  }

  for (const [venueId, raw] of Object.entries(venues)) {
    const venue = object(raw);
    const modes = strings(venue.provisioning_modes);
    const implemented = strings(venue.implemented_provisioning_modes);
    for (const mode of implemented) {
      if (!modes.includes(mode)) failures.push(`${venueId}_implemented_mode_not_declared`);
    }
    if (modes.includes("manual_sealed_import") && venue.manual_secret_handling !== "direct_to_attested_runtime") {
      failures.push(`${venueId}_direct_sealed_import_required`);
    }
    for (const mode of modes.filter((value) => PROGRAMMATIC_MODES.has(value))) {
      if (EXPECTED_PROGRAMMATIC.get(venueId) !== mode) {
        failures.push(`${venueId}_undocumented_programmatic_provisioning`);
      }
    }
  }

  for (const venueId of EXPECTED_UNSUPPORTED) {
    const venue = object(venues[venueId]);
    if (strings(venue.provisioning_modes).length !== 0) failures.push(`${venueId}_must_remain_unsupported`);
    if (strings(venue.implemented_provisioning_modes).length !== 0) {
      failures.push(`${venueId}_must_not_claim_implementation`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Venue execution credential contract failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkVenueExecutionCredentialBoundary(source) {
  const failures = [];
  const required = [
    ["evaluateVenueExecutionCredential", "agent_passport_capability_evaluator_required"],
    ["const preflightDecision = evaluateVenueExecutionCredential", "client_preflight_evaluator_required"],
    ["const credentialDecision = evaluateVenueExecutionCredential", "merged_worker_evaluator_required"],
    ["permission_attestation_incomplete", "complete_permission_attestation_required"],
    ["can_manage_credentials", "credential_admin_attestation_required"],
    ["can_export_secret", "secret_export_attestation_required"],
    ["unknown_scopes", "unknown_scope_attestation_required"],
    ["if (vaultToStore) await putVenueExecutionVault", "verified_before_vault_persistence_required"],
  ];
  for (const [value, code] of required) {
    if (!source.includes(value)) failures.push(code);
  }
  const preflight = source.indexOf("const preflightDecision = evaluateVenueExecutionCredential");
  const verification = source.indexOf("const serverVerification = await verifyCredentialServerSide");
  const evaluation = source.indexOf("const credentialDecision = evaluateVenueExecutionCredential");
  const persistence = source.indexOf("if (vaultToStore) await putVenueExecutionVault");
  if (preflight < 0 || verification < 0 || preflight > verification) {
    failures.push("client_preflight_must_precede_worker_verification");
  }
  if (evaluation < 0 || verification < 0 || persistence < 0 || evaluation < verification || evaluation > persistence) {
    failures.push("credential_evaluation_must_precede_persistence");
  }
  if (failures.length > 0) {
    throw new Error(`Venue execution credential boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkAsterCredentialProvisioningBoundary(prepareSource, completeSource, workerSource) {
  const failures = [];
  const prepareRequired = [
    ["scope: \"credential:provision\"", "aster_prepare_capability_required"],
    ["buildAsterV3AgentOnboardingContract", "aster_exact_typed_data_required"],
    ["may_place_trade: false", "aster_prepare_trade_block_required"],
    ["credential_registered: false", "aster_prepare_must_not_claim_registration"],
    ["authorization_expires_at", "aster_expiry_visibility_required"],
    ["serverTimeMs + ASTER_V3_AGENT_MAX_LIFETIME_MS", "aster_bounded_long_lived_expiry_required"],
  ];
  const completeRequired = [
    ["authorizeAsterV3AgentRegistration", "aster_owner_signature_verification_required"],
    ["\"credential:authorize\"", "aster_authorize_capability_required"],
    ["x-ghola-credential-authorization-required", "aster_explicit_authorization_header_required"],
    ["linkAgentPlatformFromBody", "aster_verified_platform_link_required"],
    ["needs_link_retry: true", "aster_post_registration_link_recovery_required"],
    ["WORKER_RECEIPT_PATH", "aster_link_recovery_receipt_path_required"],
    ["registration_receipt: registrationReceipt", "aster_explicit_registration_receipt_required"],
  ];
  const workerRequired = [
    ["authorizeAsterCredential", "aster_worker_authorizer_required"],
    ["state.claimExecutionAttempt", "aster_atomic_attempt_claim_required"],
    ["aster_registration_ambiguous", "aster_ambiguous_outcome_required"],
    ["reconcile it instead of retrying", "aster_no_retry_guard_required"],
    ["recoverAsterCredentialRegistration", "aster_receipt_only_recovery_required"],
    ["never contacts Aster", "aster_recovery_must_not_resubmit_required"],
    ["canWithdraw: false", "aster_withdrawal_block_required"],
  ];
  for (const [value, code] of prepareRequired) if (!prepareSource.includes(value)) failures.push(code);
  for (const [value, code] of completeRequired) if (!completeSource.includes(value)) failures.push(code);
  for (const [value, code] of workerRequired) if (!workerSource.includes(value)) failures.push(code);
  if (failures.length > 0) {
    throw new Error(`Aster credential provisioning boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkAsterOnboardingUiBoundary(source) {
  const failures = [];
  const required = [
    ["\"use client\";", "aster_ui_client_boundary_required"],
    ["getCurrentVenueCredentialOnboardingPath(\"aster\")", "aster_programmatic_ux_metadata_required"],
    ["const perpsTurnkey = usePerpsTurnkey()", "aster_owner_wallet_boundary_required"],
    ["onClick={() => void beginAsterProgrammatic()}", "aster_programmatic_primary_action_required"],
    ["const [showAsterManual, setShowAsterManual] = useState(false)", "aster_manual_fallback_must_default_hidden"],
    ["showAsterManual && (", "aster_manual_fallback_visibility_guard_required"],
    ["Use an existing Aster wallet instead", "aster_manual_fallback_label_required"],
    ["onClick={() => void connectAsterManual()}", "aster_manual_fallback_action_required"],
    ["completed.status !== \"ready\"", "aster_ready_response_required"],
    ["pendingAsterLinkRecovery", "aster_exact_link_recovery_state_required"],
    ["link_recovery_receipt: pendingAsterLinkRecovery.receipt", "aster_receipt_only_link_recovery_required"],
    ["Finish Aster linking", "aster_link_recovery_action_required"],
    ["Re-prepare Aster approval", "aster_deliberate_reprepare_action_required"],
    ["classifyAsterOnboardingFailure", "aster_failure_classifier_required"],
    ["asterRegistrationAmbiguous", "aster_ambiguous_ui_hold_required"],
    ["Aster reconciliation required", "aster_ambiguous_retry_block_required"],
    ["Resume Aster signing", "aster_unsigned_preparation_resume_action_required"],
    ["30 days of perpetual trading", "aster_expiry_disclosure_required"],
    ["Withdrawals stay disabled", "aster_no_withdrawal_disclosure_required"],
  ];
  for (const [value, code] of required) if (!source.includes(value)) failures.push(code);

  const flowStart = source.indexOf("const connectAsterProgrammatic = useCallback");
  const flowEnd = source.indexOf("\n  useEffect(() =>", flowStart);
  const flow = flowStart >= 0 && flowEnd > flowStart ? source.slice(flowStart, flowEnd) : "";
  const prepare = flow.indexOf("await prepareAsterProgrammaticCredential");
  const persistPrepared = flow.indexOf("persistRecovery(accountCommitment, { aster: unsignedPending })");
  const ownerSign = flow.indexOf("await perpsTurnkey.signAsterAgentApproval");
  const complete = flow.indexOf("await completeAsterProgrammaticCredential");
  const ready = flow.indexOf("completed.status !== \"ready\"");
  const connected = flow.indexOf("setAster(\"connected\")");
  if (
    prepare < 0 ||
    persistPrepared < 0 ||
    ownerSign < 0 ||
    complete < 0 ||
    ready < 0 ||
    connected < 0 ||
    !(prepare < persistPrepared && persistPrepared < ownerSign && ownerSign < complete && complete < ready && ready < connected)
  ) {
    failures.push("aster_prepare_persist_sign_complete_ready_order_required");
  }

  const fallbackGuard = source.indexOf("showAsterManual && (");
  const privateKeyInput = source.indexOf("value={draft.api_wallet_private_key}", fallbackGuard);
  const fallbackAction = source.indexOf("onClick={() => void connectAsterManual()}", fallbackGuard);
  if (fallbackGuard < 0 || privateKeyInput < fallbackGuard || fallbackAction < privateKeyInput) {
    failures.push("aster_manual_private_key_must_remain_hidden_fallback");
  }

  if (failures.length > 0) {
    throw new Error(`Aster onboarding UI boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkLighterCredentialProvisioningBoundary(prepareSource, completeSource, workerSource, signingSource) {
  const failures = [];
  const prepareRequired = [
    ["selectLighterOwnerAccount", "lighter_exact_owner_account_required"],
    ["selectLighterApiKeyIndex", "lighter_vacant_slot_required"],
    ["buildEthereumTransactionPlan", "lighter_transaction_simulation_required"],
    ["eth_call", "lighter_exact_call_simulation_required"],
    ["transaction_signed: false", "lighter_prepare_unsigned_required"],
    ["transaction_broadcast: false", "lighter_prepare_unbroadcast_required"],
  ];
  const completeRequired = [
    ["verifyLighterChangePubKeyTransaction", "lighter_signed_transaction_verification_required"],
    ["x-ghola-credential-authorization-required", "lighter_explicit_authorization_header_required"],
    ["WORKER_RECEIPT_PATH", "lighter_receipt_reconciliation_path_required"],
    ["retry_allowed: false", "lighter_web_retry_block_required"],
    ["linkAgentPlatformFromBody", "lighter_verified_platform_link_required"],
    ["owner_authorization_source: \"turnkey_venue_owner\"", "lighter_turnkey_owner_source_required"],
  ];
  const workerRequired = [
    ["recoverTransactionAddress", "lighter_worker_owner_recovery_required"],
    ["state.claimExecutionAttempt", "lighter_atomic_attempt_claim_required"],
    ["eth_sendRawTransaction", "lighter_exact_submission_required"],
    ["return reconcileLighterCredential", "lighter_prior_attempt_reconcile_required"],
    ["outcome is ambiguous; reconcile it without resubmitting", "lighter_ambiguity_no_retry_required"],
    ["eth_getTransactionReceipt", "lighter_chain_receipt_required"],
    ["/api/v1/apikeys", "lighter_association_observation_required"],
    ["ghola_lighter_pending_execution_vault", "lighter_pending_vault_required"],
    ["ghola_lighter_execution_vault", "lighter_active_vault_required"],
    ["allowed_operations: [\"read\", \"limit_order\", \"cancel\", \"reconcile\"]", "lighter_execution_allowlist_required"],
  ];
  const signingRequired = [
    ["TURNKEY_PERPS_OWNER_PATH", "lighter_turnkey_owner_path_required"],
    ["account.signTransaction", "lighter_turnkey_transaction_signing_required"],
    ["recoverTransactionAddress", "lighter_client_signer_recovery_required"],
    ["assertSignedTransaction", "lighter_signed_fields_recheck_required"],
  ];
  for (const [value, code] of prepareRequired) if (!prepareSource.includes(value)) failures.push(code);
  for (const [value, code] of completeRequired) if (!completeSource.includes(value)) failures.push(code);
  for (const [value, code] of workerRequired) if (!workerSource.includes(value)) failures.push(code);
  for (const [value, code] of signingRequired) if (!signingSource.includes(value)) failures.push(code);
  if ((workerSource.match(/eth_sendRawTransaction/g) || []).length !== 1) {
    failures.push("lighter_single_broadcast_site_required");
  }
  if (failures.length > 0) {
    throw new Error(`Lighter credential provisioning boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkLighterOnboardingUiBoundary(source) {
  const failures = [];
  const required = [
    ["getCurrentVenueCredentialOnboardingPath(\"lighter\")", "lighter_programmatic_ux_metadata_required"],
    ["onClick={() => void beginLighterProgrammatic()}", "lighter_programmatic_primary_action_required"],
    ["const [showLighterManual, setShowLighterManual] = useState(false)", "lighter_manual_fallback_must_default_hidden"],
    ["showLighterManual && lighter !== \"connected\"", "lighter_manual_fallback_visibility_guard_required"],
    ["Use an existing Lighter key instead", "lighter_manual_fallback_label_required"],
    ["onClick={() => void connectLighterManual()}", "lighter_manual_fallback_action_required"],
    ["prepareLighterProgrammaticCredential", "lighter_prepare_step_required"],
    ["signLighterKeyAssociation", "lighter_turnkey_owner_sign_step_required"],
    ["completeLighterProgrammaticCredential", "lighter_complete_step_required"],
    ["reconcile_only: true", "lighter_reconcile_only_polling_required"],
    ["Ghola will not create or submit another key", "lighter_ambiguity_ui_hold_required"],
    ["Resume verification", "lighter_resume_reconciliation_action_required"],
  ];
  for (const [value, code] of required) if (!source.includes(value)) failures.push(code);
  const prepare = source.indexOf("await prepareLighterProgrammaticCredential");
  const ownerSign = source.indexOf("await perpsTurnkey.signLighterKeyAssociation");
  const complete = source.indexOf("await completeLighterProgrammaticCredential(pending)");
  const connected = source.indexOf("setLighter(\"connected\")", complete);
  if (prepare < 0 || ownerSign < prepare || complete < ownerSign || connected < complete) {
    failures.push("lighter_prepare_sign_complete_ready_order_required");
  }
  if (failures.length > 0) {
    throw new Error(`Lighter onboarding UI boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkVenueOnboardingLiveProofBoundary(clientSource, routesSource, proxySource) {
  const failures = [];
  const required = [
    [routesSource, "platforms\\/(?:aster|lighter)\\/(?:prepare|complete)", "venue_onboarding_live_route_required"],
    [routesSource, "allowsSerializedOwnerTransaction", "lighter_serialized_transaction_scope_required"],
    [routesSource, 'pathname === "/v1/private-account/platforms/lighter/complete"', "lighter_serialized_transaction_exact_path_required"],
    [clientSource, "isPrivateAccountLiveMutationPath(pathname)", "venue_client_live_proxy_routing_required"],
    [proxySource, "isPrivateAccountLiveMutationPath(target.pathname)", "venue_server_live_proxy_allowlist_required"],
    [proxySource, "allowsSerializedOwnerTransaction(target.pathname)", "venue_server_serialized_transaction_guard_required"],
  ];
  for (const [source, value, code] of required) if (!source.includes(value)) failures.push(code);
  if (clientSource.includes("LIVE_GUARDED_MUTATION_PATHS") || proxySource.includes("LIVE_MUTATION_PATHS")) {
    failures.push("duplicate_live_route_allowlist_forbidden");
  }
  if (failures.length > 0) {
    throw new Error(`Venue onboarding live proof boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkTurnkeyVenueOwnerAddressBoundary(asterSigningSource, lighterSigningSource) {
  const failures = [];
  for (const [venue, source] of [["aster", asterSigningSource], ["lighter", lighterSigningSource]]) {
    if (!source.includes("const turnkeyOwnerAddress = input.owner.address.trim()")) {
      failures.push(`${venue}_turnkey_resource_address_required`);
    }
    if (!source.includes("input.owner.organizationId?.trim() || input.organizationId.trim()")) {
      failures.push(`${venue}_turnkey_resource_organization_required`);
    }
    if (!source.includes("signWith: turnkeyOwnerAddress") ||
        !source.includes("ethereumAddress: turnkeyOwnerAddress")) {
      failures.push(`${venue}_turnkey_resource_address_case_must_be_preserved`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Turnkey venue owner address boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function sameStrings(actual, expected = []) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function main() {
  const contract = JSON.parse(readFileSync(
    resolve(HERE, "../src/lib/venue-execution-credential-contract.json"),
    "utf8",
  ));
  checkVenueExecutionCredentialContract(contract);
  checkVenueExecutionCredentialBoundary(readFileSync(
    resolve(HERE, "../src/lib/private-agent-passport.ts"),
    "utf8",
  ));
  checkAsterCredentialProvisioningBoundary(
    readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/aster/prepare/route.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/aster/complete/route.ts"), "utf8"),
    readFileSync(resolve(HERE, "../../private-agent-worker/src/venues/aster-provisioning.js"), "utf8"),
  );
  checkAsterOnboardingUiBoundary(readFileSync(
    resolve(HERE, "../src/components/carry/CarryAccountSetup.tsx"),
    "utf8",
  ));
  checkLighterCredentialProvisioningBoundary(
    readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/lighter/prepare/route.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/lighter/complete/route.ts"), "utf8"),
    readFileSync(resolve(HERE, "../../private-agent-worker/src/venues/lighter-provisioning.js"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-lighter-signing.ts"), "utf8"),
  );
  checkLighterOnboardingUiBoundary(readFileSync(
    resolve(HERE, "../src/components/carry/CarryAccountSetup.tsx"),
    "utf8",
  ));
  checkVenueOnboardingLiveProofBoundary(
    readFileSync(resolve(HERE, "../src/lib/private-account-client.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/private-account-live-routes.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/app/api/private-account/live-proxy/route.ts"), "utf8"),
  );
  checkTurnkeyVenueOwnerAddressBoundary(
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-aster-signing.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-lighter-signing.ts"), "utf8"),
  );
  console.log("[venue-execution-credential-contract] verified");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
