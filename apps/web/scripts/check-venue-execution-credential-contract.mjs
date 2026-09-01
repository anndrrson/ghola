#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  ["lighter", ["turnkey_venue_owner", "external_owner_signature"]],
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
  if (lighter.owner_private_key_handling !== "external_wallet_or_turnkey_non_exportable_change_pub_key_transaction") {
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

export function checkAsterCredentialProvisioningBoundary(prepareSource, completeSource, workerSource, contractSource) {
  const failures = [];
  const prepareRequired = [
    ["scope: \"credential:provision\"", "aster_prepare_capability_required"],
    ["buildAsterV3AgentOnboardingContract", "aster_exact_typed_data_required"],
    ["may_place_trade: false", "aster_prepare_trade_block_required"],
    ["credential_registered: false", "aster_prepare_must_not_claim_registration"],
    ["authorization_expires_at", "aster_expiry_visibility_required"],
    ["serverTimeMs + ASTER_V3_AGENT_MAX_LIFETIME_MS", "aster_bounded_long_lived_expiry_required"],
    ["WORKER_REFRESH_PATH", "aster_same_signer_refresh_route_required"],
    ["operation_class: reuseRequested ? \"credential_refresh\" : \"credential_provision\"", "aster_refresh_operation_required"],
    ["prepared.signerAddress !== string(reuse.signer_address).toLowerCase()", "aster_refresh_signer_binding_required"],
    ["signer_reused: reuseRequested", "aster_refresh_disclosure_required"],
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
    ["refreshAsterCredential", "aster_same_signer_refresh_required"],
    ["prior && prior.status !== \"rejected\"", "aster_refresh_rejected_only_required"],
    ["validateSealedAsterCredential", "aster_refresh_sealed_binding_required"],
    ["never generates a second signer and never contacts Aster", "aster_refresh_non_submit_boundary_required"],
    ["canWithdraw: false", "aster_withdrawal_block_required"],
    ["/fapi/v3/registerAndApproveAgent", "aster_current_registration_endpoint_required"],
    ["primaryType: \"Message\"", "aster_current_primary_type_required"],
    ["chainId: 56", "aster_current_signature_domain_required"],
    ["asterRegistrationEntries(parameters)", "aster_canonical_registration_entries_required"],
    ["asterRegistrationFormBody(parameters, signature)", "aster_canonical_form_body_required"],
  ];
  const contractRequired = [
    ["endpoint: \"/fapi/v3/registerAndApproveAgent\"", "aster_contract_current_registration_endpoint_required"],
    ["primaryType: \"Message\"", "aster_contract_current_primary_type_required"],
    ["chainId: 56", "aster_contract_current_signature_domain_required"],
    ["signatureChainId: 56", "aster_contract_signature_chain_parameter_required"],
    ["documentation_commit: \"71679b4aa69e80372eb55d437a80df21f135e1bf\"", "aster_documentation_pin_required"],
  ];
  for (const [value, code] of prepareRequired) if (!prepareSource.includes(value)) failures.push(code);
  for (const [value, code] of completeRequired) if (!completeSource.includes(value)) failures.push(code);
  for (const [value, code] of workerRequired) if (!workerSource.includes(value)) failures.push(code);
  for (const [value, code] of contractRequired) if (!contractSource?.includes(value)) failures.push(code);
  const registrationStart = workerSource.indexOf("function asterRegistrationEntries(parameters)");
  const registrationEnd = workerSource.indexOf("\n}", registrationStart);
  const registrationSource = registrationStart >= 0 && registrationEnd > registrationStart
    ? workerSource.slice(registrationStart, registrationEnd)
    : "";
  const registrationFields = [
    '["user", parameters.user]',
    '["nonce", String(parameters.nonce)]',
    '["agentName", parameters.agentName]',
    '["agentAddress", parameters.agentAddress]',
    '["expired", String(parameters.expired)]',
    '["signatureChainId", String(parameters.signatureChainId)]',
    '["canSpotTrade", String(parameters.canSpotTrade)]',
    '["canPerpTrade", String(parameters.canPerpTrade)]',
    '["canWithdraw", String(parameters.canWithdraw)]',
    '["ipWhitelist", parameters.ipWhitelist]',
  ];
  let registrationCursor = -1;
  for (const field of registrationFields) {
    const position = registrationSource.indexOf(field, registrationCursor + 1);
    if (position < 0) {
      failures.push("aster_canonical_registration_order_required");
      break;
    }
    registrationCursor = position;
  }
  if (workerSource.includes('"/fapi/v3/approveAgent"') || contractSource?.includes('endpoint: "/fapi/v3/approveAgent"')) {
    failures.push("aster_retired_approval_endpoint_forbidden");
  }
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
    ["const usingTurnkeyOwner = true", "aster_turnkey_owner_must_be_explicit"],
    ["if (nextSetupAction.venueId === \"aster\") void beginAsterProgrammatic();", "aster_programmatic_primary_action_required"],
    ["const [showAsterManual, setShowAsterManual] = useState(false)", "aster_manual_fallback_must_default_hidden"],
    ["showAsterManual && (", "aster_manual_fallback_visibility_guard_required"],
    ["Use an existing Aster wallet instead", "aster_manual_fallback_label_required"],
    ["onClick={() => void connectAsterManual()}", "aster_manual_fallback_action_required"],
    ["completed.status !== \"ready\"", "aster_ready_response_required"],
    ["pendingAsterLinkRecovery", "aster_exact_link_recovery_state_required"],
    ["link_recovery_receipt: pendingAsterLinkRecovery.receipt", "aster_receipt_only_link_recovery_required"],
    ["Finish Aster linking", "aster_link_recovery_action_required"],
    ["Refresh same Aster signer", "aster_deliberate_reprepare_action_required"],
    ["reuse_preparation: prior", "aster_same_signer_ui_refresh_required"],
    ["prepared.setup.signer_reused !== true", "aster_same_signer_ui_verification_required"],
    ["never create another signer or retry an ambiguous submission", "aster_same_signer_ui_disclosure_required"],
    ["Continue modeling without funds", "aster_capital_free_continuation_required"],
    ["classifyAsterOnboardingFailure", "aster_failure_classifier_required"],
    ["asterRegistrationAmbiguous", "aster_ambiguous_ui_hold_required"],
    ["Aster reconciliation required", "aster_ambiguous_retry_block_required"],
    ["Resume Aster signing", "aster_unsigned_preparation_resume_action_required"],
    ["Repair secure wallet", "aster_broken_wallet_repair_action_required"],
    ["await perpsTurnkey.replaceWalletPair()", "aster_explicit_wallet_replacement_required"],
    ["30 days of perpetual trading", "aster_expiry_disclosure_required"],
    ["Withdrawals stay disabled", "aster_no_withdrawal_disclosure_required"],
  ];
  for (const [value, code] of required) if (!source.includes(value)) failures.push(code);
  if (source.includes("resolveInjectedEvmProvider") || source.includes("signAsterAgentApprovalWithInjectedOwner")) {
    failures.push("aster_injected_wallet_must_not_hijack_carry_setup");
  }
  if (source.split("setAsterRegistrationAmbiguous(true);").length - 1 < 2) {
    failures.push("aster_ambiguous_all_completion_paths_required");
  }

  const flowStart = source.indexOf("const connectAsterProgrammatic = useCallback");
  const flowEnd = source.indexOf("\n  useEffect(() =>", flowStart);
  const flow = flowStart >= 0 && flowEnd > flowStart ? source.slice(flowStart, flowEnd) : "";
  const prepare = flow.indexOf("await prepareAsterProgrammaticCredential");
  const persistPrepared = flow.indexOf("persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending })");
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
    ["verifyExternalLighterChangePubKeyTransaction", "lighter_external_transaction_verification_required"],
    ["eth_getTransactionByHash", "lighter_external_transaction_observation_required"],
    ["x-ghola-credential-authorization-required", "lighter_explicit_authorization_header_required"],
    ["WORKER_RECEIPT_PATH", "lighter_receipt_reconciliation_path_required"],
    ["retry_allowed: false", "lighter_web_retry_block_required"],
    ["linkAgentPlatformFromBody", "lighter_verified_platform_link_required"],
    ["externalBroadcast ? \"external_owner_signature\" : \"turnkey_venue_owner\"", "lighter_verified_owner_sources_required"],
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
    ["else if (nextSetupAction.venueId === \"lighter\") void beginLighterProgrammatic();", "lighter_programmatic_primary_action_required"],
    ["const [showLighterManual, setShowLighterManual] = useState(false)", "lighter_manual_fallback_must_default_hidden"],
    ["showLighterManual && lighter !== \"connected\"", "lighter_manual_fallback_visibility_guard_required"],
    ["Use an existing Lighter key instead", "lighter_manual_fallback_label_required"],
    ["onClick={() => void connectLighterManual()}", "lighter_manual_fallback_action_required"],
    ["prepareLighterProgrammaticCredential", "lighter_prepare_step_required"],
    ["signLighterKeyAssociation", "lighter_turnkey_owner_sign_step_required"],
    ["await perpsTurnkey.signLighterKeyAssociation", "lighter_turnkey_owner_sign_step_required"],
    ["completeLighterProgrammaticCredential", "lighter_complete_step_required"],
    ["reconcile_only: true", "lighter_reconcile_only_polling_required"],
    ["Ghola will not create or submit another key", "lighter_ambiguity_ui_hold_required"],
    ["Resume verification", "lighter_resume_reconciliation_action_required"],
  ];
  for (const [value, code] of required) if (!source.includes(value)) failures.push(code);
  if (source.includes("sendLighterKeyAssociationWithInjectedOwner")) {
    failures.push("lighter_injected_wallet_must_not_hijack_carry_setup");
  }
  const prepare = source.indexOf("await prepareLighterProgrammaticCredential");
  const ownerSign = source.indexOf("await perpsTurnkey.signLighterKeyAssociation");
  const complete = source.indexOf("await completeLighterProgrammaticCredential({ preparation, authorization })");
  const connected = source.indexOf("setLighter(\"connected\")", complete);
  if (prepare < 0 || ownerSign < prepare || complete < ownerSign || connected < complete) {
    failures.push("lighter_prepare_sign_complete_ready_order_required");
  }
  if (failures.length > 0) {
    throw new Error(`Lighter onboarding UI boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkLighterActivationReadinessBoundary(clientSource, serverSource, setupSource) {
  const failures = [];
  const required = [
    [clientSource, "LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS = BigInt(5_000_000)", "lighter_new_account_five_usdc_minimum_required"],
    [clientSource, "https://apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals", "lighter_deposit_source_required"],
    [serverSource, "LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS", "lighter_server_shared_minimum_required"],
    [setupSource, "LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS", "lighter_ui_shared_minimum_required"],
    [setupSource, "Owner wallet staging balance", "lighter_owner_balance_must_not_be_labeled_deposited_collateral"],
    [setupSource, "USDC · not deposited", "lighter_owner_balance_not_deposited_disclosure_required"],
    [setupSource, "Account identity · not a deposit address", "lighter_owner_identity_not_deposit_address_required"],
    [setupSource, "View official Lighter requirements", "lighter_official_requirements_link_required"],
    [clientSource, "Funding is blocked until Ghola verifies an official Lighter deposit destination", "lighter_unverified_deposit_destination_must_fail_closed"],
    [clientSource, "Do not send USDC directly to the owner address", "lighter_direct_owner_deposit_warning_required"],
    [clientSource, "deposit_destination_verified: false", "lighter_unverified_destination_contract_required"],
    [clientSource, "funding_action_enabled: false", "lighter_funding_action_fail_closed_required"],
    [serverSource, "deposit_destination_verified: false", "lighter_server_unverified_destination_required"],
    [serverSource, "funding_action_enabled: false", "lighter_server_funding_action_block_required"],
  ];
  for (const [source, value, code] of required) if (!source.includes(value)) failures.push(code);
  for (const source of [clientSource, serverSource, setupSource]) {
    if (source.includes("BigInt(3_000_000)") || source.includes("3 USDC on Base")) {
      failures.push("lighter_stale_three_usdc_minimum_forbidden");
      break;
    }
  }
  const withoutWarning = clientSource.replaceAll("Do not send USDC directly to the owner address.", "");
  const unsafeDirectOwnerDeposit = [
    /send[^.\n]{0,160}usdc[^.\n]{0,160}(?:owner address|owner wallet)/i,
    /send[^.\n]{0,160}(?:owner address|owner wallet)[^.\n]{0,160}usdc/i,
    /to the owner address above/i,
  ].some((pattern) => pattern.test(withoutWarning));
  if (unsafeDirectOwnerDeposit) failures.push("lighter_direct_owner_usdc_deposit_forbidden");
  if (failures.length > 0) {
    throw new Error(`Lighter activation readiness boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function checkLighterUniversalDepositBoundary({
  serverSource,
  authorizationSource,
  turnkeyOwnerBindingSource,
  storeSource,
  challengeRouteSource,
  destinationRouteSource,
  clientSource,
  providerSource,
  setupSource,
  envSource,
}) {
  serverSource = stripCodeComments(serverSource);
  authorizationSource = stripCodeComments(authorizationSource);
  turnkeyOwnerBindingSource = stripCodeComments(turnkeyOwnerBindingSource);
  storeSource = stripCodeComments(storeSource);
  challengeRouteSource = stripCodeComments(challengeRouteSource);
  destinationRouteSource = stripCodeComments(destinationRouteSource);
  clientSource = stripCodeComments(clientSource);
  providerSource = stripCodeComments(providerSource);
  setupSource = stripCodeComments(setupSource);
  envSource = stripEnvComments(envSource);
  const failures = [];
  const required = [
    [serverSource, 'LIGHTER_UDA_BASE_URL = "https://bridge.lighter.xyz"', "lighter_uda_official_provider_required"],
    [serverSource, "`${LIGHTER_UDA_BASE_URL}/v1/uda`", "lighter_uda_official_create_endpoint_required"],
    [serverSource, 'process.env.GHOLA_LIGHTER_BUILDER_KEY', "lighter_uda_server_builder_key_required"],
    [serverSource, '"x-api-key": builderKey', "lighter_uda_builder_key_header_required"],
    [serverSource, 'import "server-only";', "lighter_uda_server_only_marker_required"],
    [serverSource, 'redirect: "error"', "lighter_uda_redirect_rejection_required"],
    [serverSource, "AbortSignal.timeout(REQUEST_TIMEOUT_MS)", "lighter_uda_bounded_timeout_required"],
    [serverSource, 'LIGHTER_UDA_ACTION_TYPE = "LIGHTER_PERPS"', "lighter_uda_perps_action_required"],
    [serverSource, 'LIGHTER_UDA_CHAIN_ID = "3586256"', "lighter_uda_destination_chain_required"],
    [serverSource, "validatedRecipient(resolved.recipientAddr, binding)", "lighter_uda_exact_recipient_binding_required"],
    [serverSource, "validatedOwnerAccountBinding(ownerAccountBinding, owner)", "lighter_uda_owner_account_binding_required"],
    [serverSource, "fromChainId !== LIGHTER_UDA_BASE_CHAIN_ID", "lighter_uda_status_base_chain_required"],
    [serverSource, "BigInt(fromAmountBaseUnit) < LIGHTER_UDA_MINIMUM_USDC_MICROUNITS", "lighter_uda_status_minimum_required"],
    [authorizationSource, "createHmac", "lighter_uda_hmac_challenge_required"],
    [authorizationSource, 'import "server-only";', "lighter_uda_authorization_server_only_marker_required"],
    [authorizationSource, "timingSafeEqual", "lighter_uda_timing_safe_verification_required"],
    [authorizationSource, "LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS = 2 * 60_000", "lighter_uda_short_challenge_required"],
    [authorizationSource, "recoverMessageAddress", "lighter_uda_owner_recovery_required"],
    [turnkeyOwnerBindingSource, 'import "server-only";', "lighter_turnkey_query_server_only_required"],
    [turnkeyOwnerBindingSource, "env.GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY", "lighter_turnkey_query_public_key_required"],
    [turnkeyOwnerBindingSource, "env.GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY", "lighter_turnkey_query_private_key_required"],
    [turnkeyOwnerBindingSource, "env.GHOLA_TURNKEY_QUERY_ORGANIZATION_ID", "lighter_turnkey_query_organization_binding_required"],
    [turnkeyOwnerBindingSource, "getSubOrgIds", "lighter_turnkey_query_suborg_lookup_required"],
    [turnkeyOwnerBindingSource, "getWallets", "lighter_turnkey_query_wallet_lookup_required"],
    [turnkeyOwnerBindingSource, "getWalletAccounts", "lighter_turnkey_query_account_lookup_required"],
    [authorizationSource, "Ghola Lighter deposit address authorization", "lighter_uda_fixed_authorization_header_required"],
    [authorizationSource, "Source chain: Base (${LIGHTER_DEPOSIT_SOURCE_CHAIN_ID})", "lighter_uda_fixed_base_scope_required"],
    [authorizationSource, "Source asset: ${LIGHTER_DEPOSIT_SOURCE_ASSET}", "lighter_uda_fixed_asset_scope_required"],
    [authorizationSource, "Destination: Lighter perps", "lighter_uda_fixed_market_scope_required"],
    [authorizationSource, "This authorizes address generation only.", "lighter_uda_generation_only_disclosure_required"],
    [authorizationSource, "It does not authorize a transfer, withdrawal, or trade.", "lighter_uda_no_money_movement_disclosure_required"],
    [storeSource, "claimPrivateLighterUdaAttempt", "lighter_uda_durable_claim_required"],
    [storeSource, "owner_commitment TEXT NOT NULL UNIQUE", "lighter_uda_session_owner_quota_required"],
    [storeSource, "private_account_lighter_uda_wallet_commitment_unique", "lighter_uda_wallet_quota_required"],
    [storeSource, "lighterUdaAttemptByWalletBlobPath", "lighter_uda_wallet_blob_claim_required"],
    [storeSource, 'lighterUdaLedgerError("lighter_uda_transactional_store_required", 503)', "lighter_uda_transactional_store_required"],
    [storeSource, "allowOverwrite: false", "lighter_uda_atomic_blob_claim_required"],
    [storeSource, '"pending" | "verified" | "ambiguous"', "lighter_uda_durable_ambiguity_state_required"],
    [challengeRouteSource, "sameOrigin(req)", "lighter_uda_challenge_same_origin_required"],
    [challengeRouteSource, "fetchSessionUser(token)", "lighter_uda_challenge_session_required"],
    [challengeRouteSource, "gholaCommitment(\"owner\", session.userId)", "lighter_uda_challenge_session_binding_required"],
    [challengeRouteSource, "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET", "lighter_uda_challenge_secret_required"],
    [destinationRouteSource, "sameOrigin(req)", "lighter_uda_destination_same_origin_required"],
    [destinationRouteSource, "fetchSessionUser(token)", "lighter_uda_destination_session_required"],
    [destinationRouteSource, "verifyLighterDepositAuthorizationToken", "lighter_uda_token_verification_required"],
    [destinationRouteSource, "verifyLighterDepositAuthorizationSignature", "lighter_uda_signature_verification_required"],
    [destinationRouteSource, "assertLighterUdaCreateConfigured()", "lighter_uda_preclaim_configuration_check_required"],
    [destinationRouteSource, 'gholaCommitment("wallet", ownerAddress.toLowerCase())', "lighter_uda_wallet_commitment_required"],
    [destinationRouteSource, "claimPrivateLighterUdaAttempt", "lighter_uda_destination_durable_claim_required"],
    [destinationRouteSource, "settlePrivateLighterUdaAttempt", "lighter_uda_destination_durable_settlement_required"],
    [destinationRouteSource, "if (!claim.acquired)", "lighter_uda_duplicate_claim_lock_required"],
    [destinationRouteSource, "claim.record.wallet_commitment !== walletCommitment", "lighter_uda_cross_session_binding_required"],
    [destinationRouteSource, '"lighter_uda_attempt_binding_mismatch"', "lighter_uda_binding_failure_required"],
    [destinationRouteSource, 'claim.record.status === "verified"', "lighter_uda_idempotent_verified_result_required"],
    [destinationRouteSource, "manual_reconciliation_required: true", "lighter_uda_manual_reconciliation_required"],
    [destinationRouteSource, 'status: "ambiguous"', "lighter_uda_destination_ambiguity_settlement_required"],
    [destinationRouteSource, "readLighterUdaOwnerAccountBinding({ ownerAddress })", "lighter_uda_owner_account_lookup_required"],
    [destinationRouteSource, "deposit_destination_verified: false", "lighter_uda_destination_failure_lock_required"],
    [destinationRouteSource, "funding_action_enabled: false", "lighter_uda_funding_failure_lock_required"],
    [clientSource, "validateLighterDepositAuthorizationChallenge", "lighter_uda_client_challenge_validation_required"],
    [clientSource, "validateVerifiedLighterDepositDestination", "lighter_uda_client_destination_validation_required"],
    [clientSource, "credentials: \"same-origin\"", "lighter_uda_client_same_origin_required"],
    [clientSource, "ambiguousDestinationError()", "lighter_uda_client_ambiguous_transport_lock_required"],
    [clientSource, "!RETRYABLE_DESTINATION_REJECTIONS.has(code)", "lighter_uda_client_unknown_failure_lock_required"],
    [providerSource, "const signLighterDepositAuthorization = useCallback", "lighter_uda_specific_turnkey_signer_required"],
    [providerSource, "withOneStableTurnkeyRefresh", "lighter_uda_stable_turnkey_owner_required"],
    [providerSource, "pair.owner.address.toLowerCase() !== expectedOwnerAddress.toLowerCase()", "lighter_uda_exact_turnkey_owner_required"],
    [setupSource, "Generate verified deposit address", "lighter_uda_explicit_generation_action_required"],
    [setupSource, 'data-lighter-deposit-verified="false"', "lighter_uda_locked_ui_state_required"],
    [setupSource, 'data-lighter-deposit-verified="true"', "lighter_uda_verified_ui_state_required"],
    [setupSource, "Copy verified Lighter deposit address", "lighter_uda_verified_copy_required"],
    [setupSource, "Never send to the owner address.", "lighter_uda_owner_deposit_warning_required"],
    [setupSource, 'scopedActivationNeeded.venue === "aster" && (', "lighter_uda_owner_copy_must_be_aster_only"],
    [envSource, "GHOLA_LIGHTER_BUILDER_KEY=", "lighter_uda_builder_env_documentation_required"],
    [envSource, "GHOLA_TURNKEY_QUERY_ORGANIZATION_ID=", "lighter_turnkey_query_organization_env_required"],
    [envSource, "GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY=", "lighter_turnkey_query_public_key_env_required"],
    [envSource, "GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY=", "lighter_turnkey_query_private_key_env_required"],
  ];
  for (const [source, value, code] of required) if (!source.includes(value)) failures.push(code);
  const retryBranch = setupSource.indexOf("{retryForbidden ? (");
  const reconcileButton = setupSource.indexOf("onClick={onReconcile}", retryBranch);
  const generationBranch = setupSource.indexOf(") : (", retryBranch);
  const generationButton = setupSource.indexOf("onClick={onGenerate}", generationBranch);
  const reconciliationGuarded = /if\s*\(\s*!expectedOwner\s*\|\|\s*!lighterFundingEligibilityAccepted\s*\|\|\s*!lighterDepositRetryForbidden\s*\|\|\s*lighterDepositDestination\s*\)\s*return;/.test(setupSource);
  const exactReconciliationCall = /reconcileExistingLighterDepositDestination\(\s*expectedOwner,\s*LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,?\s*\)/.test(setupSource);
  if (
    !setupSource.includes("if (lighterDepositRetryForbidden) return;") ||
    !setupSource.includes("canGenerateDepositAddress={perpsTurnkey.authenticated && !lighterDepositRetryForbidden}") ||
    !setupSource.includes("canReconcileDepositAddress={perpsTurnkey.authenticated && lighterDepositRetryForbidden}") ||
    !reconciliationGuarded ||
    !exactReconciliationCall ||
    !setupSource.includes("Check provider status") ||
    !setupSource.includes("provider history alone never unlocks funding.") ||
    retryBranch < 0 ||
    reconcileButton < retryBranch ||
    generationBranch < reconcileButton ||
    generationButton < generationBranch
  ) {
    failures.push("lighter_uda_retry_forbidden_button_lock_required");
  }
  const verifyToken = destinationRouteSource.indexOf("const authorization = verifyLighterDepositAuthorizationToken");
  const verifySignature = destinationRouteSource.indexOf("ownerAddress = await verifyLighterDepositAuthorizationSignature");
  const configureDestination = destinationRouteSource.indexOf("assertLighterUdaCreateConfigured()");
  const bindOwnerAccount = destinationRouteSource.indexOf("ownerAccountBinding = await readLighterUdaOwnerAccountBinding({ ownerAddress })");
  const claimDestination = destinationRouteSource.indexOf("claim = await claimPrivateLighterUdaAttempt");
  const createDestination = destinationRouteSource.indexOf("const destination = await createLighterUniversalDepositAddress({");
  const exactCreateCall = /const destination = await createLighterUniversalDepositAddress\(\{\s*ownerAddress,\s*ownerAccountBinding,\s*\}\);/.test(destinationRouteSource);
  if (
    verifyToken < 0 ||
    verifySignature < verifyToken ||
    configureDestination < verifySignature ||
    bindOwnerAccount < configureDestination ||
    claimDestination < bindOwnerAccount ||
    createDestination < claimDestination ||
    !exactCreateCall
  ) {
    failures.push("lighter_uda_verify_before_create_order_required");
  }
  if ((destinationRouteSource.match(/createLighterUniversalDepositAddress\s*\(\s*\{/g) || []).length !== 1) {
    failures.push("lighter_uda_exactly_one_create_site_required");
  }
  if ((serverSource.match(/redirect: "error"/g) || []).length !== 4) {
    failures.push("lighter_uda_all_authenticated_redirects_must_fail_closed");
  }
  if ([serverSource, authorizationSource, storeSource, challengeRouteSource, destinationRouteSource, clientSource, providerSource, setupSource, envSource]
    .some((source) => source.includes("NEXT_PUBLIC_GHOLA_LIGHTER_BUILDER_KEY"))) {
    failures.push("lighter_uda_public_builder_key_forbidden");
  }
  if (
    turnkeyOwnerBindingSource.includes("env.TURNKEY_API_PUBLIC_KEY") ||
    turnkeyOwnerBindingSource.includes("env.TURNKEY_API_PRIVATE_KEY") ||
    turnkeyOwnerBindingSource.includes("env.TURNKEY_ORG_ID")
  ) {
    failures.push("lighter_turnkey_query_must_not_reuse_generic_credentials");
  }
  if (failures.length > 0) {
    throw new Error(`Lighter Universal Deposit boundary failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

export function stripCodeComments(source) {
  const sourceFile = ts.createSourceFile(
    "release-boundary.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ranges = [];
  const collectRanges = (node) => {
    const start = node.getStart(sourceFile, false);
    if (start > node.pos) ranges.push({ pos: node.pos, end: start });
    if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression && node.end > node.pos + 1) {
      ranges.push({ pos: node.pos + 1, end: node.end - 1 });
    }
    ts.forEachChild(node, collectRanges);
  };
  collectRanges(sourceFile);
  let cursor = 0;
  let output = "";
  for (const { pos: start, end } of ranges.sort((left, right) => left.pos - right.pos)) {
    if (start < cursor) continue;
    output += source.slice(cursor, start);
    output += source.slice(start, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return output + source.slice(cursor);
}

function stripEnvComments(source) {
  return source.replace(/^\s*#.*$/gm, "");
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

export function checkTurnkeyPerpsWalletSelectionBoundary(providerSource, identitySource) {
  const failures = [];
  const providerRequired = [
    ["TURNKEY_WALLET_BINDINGS_STORAGE_KEY", "turnkey_wallet_binding_storage_required"],
    ["bindExactPerpsWalletIdentity", "turnkey_wallet_account_binding_required"],
    ["withOneStableTurnkeyRefresh", "turnkey_stable_identity_refresh_required"],
    ["useCallback(() => ensureWalletPair()", "turnkey_repair_must_preserve_identity"],
  ];
  const identityRequired = [
    ["wallet.walletId === boundWalletId", "turnkey_exact_bound_wallet_selection_required"],
    ["Multiple Ghola perps wallets are active", "turnkey_duplicate_wallet_fail_closed_required"],
    ["walletAccountId", "turnkey_wallet_account_id_binding_required"],
    ["sameWalletAccountIdentity", "turnkey_refresh_identity_comparison_required"],
    ["return input.execute(refreshed)", "turnkey_single_refresh_retry_required"],
  ];
  for (const [value, code] of providerRequired) if (!providerSource.includes(value)) failures.push(code);
  for (const [value, code] of identityRequired) if (!identitySource.includes(value)) failures.push(code);
  if (failures.length > 0) {
    throw new Error(`Turnkey perps wallet selection boundary failed: ${failures.join(", ")}`);
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
    readFileSync(resolve(HERE, "../src/lib/aster-agent-onboarding.ts"), "utf8"),
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
  checkLighterActivationReadinessBoundary(
    readFileSync(resolve(HERE, "../src/lib/lighter-activation-readiness.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/lighter-activation-readiness.server.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/components/carry/CarryAccountSetup.tsx"), "utf8"),
  );
  checkLighterUniversalDepositBoundary({
    serverSource: readFileSync(resolve(HERE, "../src/lib/lighter-universal-deposit-address.server.ts"), "utf8"),
    authorizationSource: readFileSync(resolve(HERE, "../src/lib/lighter-deposit-authorization.server.ts"), "utf8"),
    turnkeyOwnerBindingSource: readFileSync(resolve(HERE, "../src/lib/lighter-turnkey-owner-binding.server.ts"), "utf8"),
    storeSource: readFileSync(resolve(HERE, "../src/lib/private-account-store.ts"), "utf8"),
    challengeRouteSource: readFileSync(resolve(HERE, "../src/app/api/carry/lighter-deposit-authorization/route.ts"), "utf8"),
    destinationRouteSource: readFileSync(resolve(HERE, "../src/app/api/carry/lighter-deposit-destination/route.ts"), "utf8"),
    clientSource: readFileSync(resolve(HERE, "../src/lib/lighter-universal-deposit-address.client.ts"), "utf8"),
    providerSource: readFileSync(resolve(HERE, "../src/lib/perps-turnkey-provider.tsx"), "utf8"),
    setupSource: readFileSync(resolve(HERE, "../src/components/carry/CarryAccountSetup.tsx"), "utf8"),
    envSource: readFileSync(resolve(HERE, "../.env.example"), "utf8"),
  });
  checkVenueOnboardingLiveProofBoundary(
    readFileSync(resolve(HERE, "../src/lib/private-account-client.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/private-account-live-routes.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/app/api/private-account/live-proxy/route.ts"), "utf8"),
  );
  checkTurnkeyVenueOwnerAddressBoundary(
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-aster-signing.ts"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-lighter-signing.ts"), "utf8"),
  );
  checkTurnkeyPerpsWalletSelectionBoundary(
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-provider.tsx"), "utf8"),
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-wallet-identity.ts"), "utf8"),
  );
  console.log("[venue-execution-credential-contract] verified");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
