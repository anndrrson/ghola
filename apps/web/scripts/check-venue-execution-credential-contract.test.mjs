import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkAsterCredentialProvisioningBoundary,
  checkAsterOnboardingUiBoundary,
  checkLighterCredentialProvisioningBoundary,
  checkLighterActivationReadinessBoundary,
  checkLighterOnboardingUiBoundary,
  checkVenueOnboardingLiveProofBoundary,
  checkTurnkeyVenueOwnerAddressBoundary,
  checkTurnkeyPerpsWalletSelectionBoundary,
  checkVenueExecutionCredentialBoundary,
  checkVenueExecutionCredentialContract,
} from "./check-venue-execution-credential-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(
  resolve(HERE, "../src/lib/venue-execution-credential-contract.json"),
  "utf8",
));
const boundary = readFileSync(resolve(HERE, "../src/lib/private-agent-passport.ts"), "utf8");
const asterPrepare = readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/aster/prepare/route.ts"), "utf8");
const asterComplete = readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/aster/complete/route.ts"), "utf8");
const asterWorker = readFileSync(resolve(HERE, "../../private-agent-worker/src/venues/aster-provisioning.js"), "utf8");
const asterContract = readFileSync(resolve(HERE, "../src/lib/aster-agent-onboarding.ts"), "utf8");
const asterUi = readFileSync(resolve(HERE, "../src/components/carry/CarryAccountSetup.tsx"), "utf8");
const lighterPrepare = readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/lighter/prepare/route.ts"), "utf8");
const lighterComplete = readFileSync(resolve(HERE, "../src/app/v1/private-account/platforms/lighter/complete/route.ts"), "utf8");
const lighterWorker = readFileSync(resolve(HERE, "../../private-agent-worker/src/venues/lighter-provisioning.js"), "utf8");
const lighterSigning = readFileSync(resolve(HERE, "../src/lib/perps-turnkey-lighter-signing.ts"), "utf8");
const lighterReadiness = readFileSync(resolve(HERE, "../src/lib/lighter-activation-readiness.ts"), "utf8");
const lighterReadinessServer = readFileSync(resolve(HERE, "../src/lib/lighter-activation-readiness.server.ts"), "utf8");
const turnkeyProvider = readFileSync(resolve(HERE, "../src/lib/perps-turnkey-provider.tsx"), "utf8");
const turnkeyWalletIdentity = readFileSync(resolve(HERE, "../src/lib/perps-turnkey-wallet-identity.ts"), "utf8");
const liveClient = readFileSync(resolve(HERE, "../src/lib/private-account-client.ts"), "utf8");
const liveRoutes = readFileSync(resolve(HERE, "../src/lib/private-account-live-routes.ts"), "utf8");
const liveProxy = readFileSync(resolve(HERE, "../src/app/api/private-account/live-proxy/route.ts"), "utf8");

function changed(mutator) {
  const value = structuredClone(contract);
  mutator(value);
  return value;
}

test("accepts the fail-closed venue execution credential contract", () => {
  assert.equal(checkVenueExecutionCredentialContract(contract).ok, true);
  assert.equal(checkVenueExecutionCredentialBoundary(boundary).ok, true);
  assert.equal(checkAsterCredentialProvisioningBoundary(asterPrepare, asterComplete, asterWorker, asterContract).ok, true);
  assert.equal(checkAsterOnboardingUiBoundary(asterUi).ok, true);
  assert.equal(checkLighterCredentialProvisioningBoundary(
    lighterPrepare,
    lighterComplete,
    lighterWorker,
    lighterSigning,
  ).ok, true);
  assert.equal(checkLighterOnboardingUiBoundary(asterUi).ok, true);
  assert.equal(checkLighterActivationReadinessBoundary(
    lighterReadiness,
    lighterReadinessServer,
    asterUi,
  ).ok, true);
  assert.equal(checkVenueOnboardingLiveProofBoundary(liveClient, liveRoutes, liveProxy).ok, true);
  assert.equal(checkTurnkeyVenueOwnerAddressBoundary(
    readFileSync(resolve(HERE, "../src/lib/perps-turnkey-aster-signing.ts"), "utf8"),
    lighterSigning,
  ).ok, true);
  assert.equal(checkTurnkeyPerpsWalletSelectionBoundary(turnkeyProvider, turnkeyWalletIdentity).ok, true);
});

test("rejects venue onboarding that bypasses server-side live request proof", () => {
  assert.throws(
    () => checkVenueOnboardingLiveProofBoundary(
      liveClient.replace("isPrivateAccountLiveMutationPath(pathname)", "false"),
      liveRoutes.replace("platforms\\/(?:aster|lighter)\\/(?:prepare|complete)", "platforms\\/removed"),
      liveProxy,
    ),
    /venue_onboarding_live_route_required|venue_client_live_proxy_routing_required/,
  );
});

test("rejects changing Turnkey's exact case-sensitive owner resource address", () => {
  const asterSigning = readFileSync(resolve(HERE, "../src/lib/perps-turnkey-aster-signing.ts"), "utf8");
  assert.throws(
    () => checkTurnkeyVenueOwnerAddressBoundary(
      asterSigning.replaceAll("signWith: turnkeyOwnerAddress", "signWith: ownerAddress"),
      lighterSigning.replaceAll("signWith: turnkeyOwnerAddress", "signWith: ownerAddress"),
    ),
    /turnkey_resource_address_case_must_be_preserved/,
  );
});

test("rejects nondeterministic selection among duplicate Turnkey wallets", () => {
  assert.throws(
    () => checkTurnkeyPerpsWalletSelectionBoundary(turnkeyProvider
      .replace("bindExactPerpsWalletIdentity", "bindAnyWallet"), turnkeyWalletIdentity
      .replace("wallet.walletId === boundWalletId", "wallet.walletName === walletName")
      .replace("Multiple Ghola perps wallets are active", "Using the first wallet")),
    /turnkey_exact_bound_wallet_selection_required|turnkey_duplicate_wallet_fail_closed_required/,
  );
});

test("rejects Turnkey signing repair that can change account identity or retry repeatedly", () => {
  assert.throws(
    () => checkTurnkeyPerpsWalletSelectionBoundary(turnkeyProvider, turnkeyWalletIdentity
      .replaceAll("walletAccountId", "removedAccountId")
      .replace("return input.execute(refreshed)", "return withOneStableTurnkeyRefresh(input)")),
    /turnkey_wallet_account_id_binding_required|turnkey_single_refresh_retry_required/,
  );
});

test("rejects a generic link boundary that skips credential evaluation", () => {
  assert.throws(
    () => checkVenueExecutionCredentialBoundary(boundary.replaceAll(
      "evaluateVenueExecutionCredential",
      "removedCredentialEvaluator",
    )),
    /agent_passport_capability_evaluator_required|credential_evaluation_must_precede_persistence/,
  );
});

test("rejects sending a sealed vault to the worker before client preflight", () => {
  assert.throws(
    () => checkVenueExecutionCredentialBoundary(boundary.replace(
      "const preflightDecision = evaluateVenueExecutionCredential",
      "const removedPreflightDecision = evaluateVenueExecutionCredential",
    )),
    /client_preflight_evaluator_required|client_preflight_must_precede_worker_verification/,
  );
});

test("rejects persisting a vault before capability evaluation", () => {
  const changed = boundary.replace(
    "if (vaultToStore) await putVenueExecutionVault(vaultToStore);",
    "const removedVerifiedPersistence = vaultToStore;",
  );
  assert.throws(
    () => checkVenueExecutionCredentialBoundary(changed),
    /verified_before_vault_persistence_required|credential_evaluation_must_precede_persistence/,
  );
});

test("rejects silent provisioning or withdrawal-capable credential claims", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.silent_provisioning_allowed = true;
      value.unsafe_execution_permissions = ["transfer", "credential_admin", "secret_export"];
    })),
    /silent_provisioning_must_be_blocked|withdraw_permission_guard_required/,
  );
});

test("rejects programmatic provisioning without owner-bound Turnkey custody", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.venues.aster.programmatic_authorizers = ["turnkey_venue_owner"];
      value.venues.aster.generated_secret_custody = ["raw_exportable"];
    })),
    /aster_owner_authorizer_contract_invalid|aster_generated_secret_custody_invalid/,
  );
});

test("rejects removing the verified Aster implementation claim", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.venues.aster.implemented_provisioning_modes = ["manual_sealed_import"];
    })),
    /aster_programmatic_implementation_required/,
  );
});

test("rejects Aster provisioning without durable ambiguity or owner-signature guards", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare,
      asterComplete.replaceAll("authorizeAsterV3AgentRegistration", "removedOwnerSignatureVerification"),
      asterWorker
        .replaceAll("state.claimExecutionAttempt", "removedAtomicAttemptClaim")
        .replaceAll("reconcile it instead of retrying", "retry allowed"),
      asterContract,
    ),
    /aster_owner_signature_verification_required|aster_atomic_attempt_claim_required|aster_no_retry_guard_required/,
  );
});

test("rejects Aster refresh that can replace a signer or follow an ambiguous attempt", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare
        .replaceAll("prepared.signerAddress !== string(reuse.signer_address).toLowerCase()", "false")
        .replaceAll("signer_reused: reuseRequested", "signer_reused: false"),
      asterComplete,
      asterWorker
        .replaceAll("prior && prior.status !== \"rejected\"", "false")
        .replaceAll("never generates a second signer and never contacts Aster", "may generate or submit"),
      asterContract,
    ),
    /aster_refresh_signer_binding_required|aster_refresh_disclosure_required|aster_refresh_rejected_only_required|aster_refresh_non_submit_boundary_required/,
  );
});

test("rejects Aster's retired approval endpoint or signing schema", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare,
      asterComplete,
      asterWorker
        .replaceAll("/fapi/v3/registerAndApproveAgent", "/fapi/v3/approveAgent")
        .replaceAll('primaryType: "Message"', 'primaryType: "ApproveAgent"')
        .replaceAll("chainId: 56", "chainId: 1666"),
      asterContract
        .replaceAll("/fapi/v3/registerAndApproveAgent", "/fapi/v3/approveAgent")
        .replaceAll('primaryType: "Message"', 'primaryType: "ApproveAgent"')
        .replaceAll("chainId: 56", "chainId: 1666"),
    ),
    /aster_current_approval_endpoint_required|aster_current_primary_type_required|aster_current_signature_domain_required|aster_retired_approval_endpoint_forbidden/,
  );
});

test("rejects changing Aster's canonical signed and submitted field order", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare,
      asterComplete,
      asterWorker.replace(
        '["user", parameters.user],\n    ["nonce", String(parameters.nonce)]',
        '["nonce", String(parameters.nonce)],\n    ["user", parameters.user]',
      ),
      asterContract,
    ),
    /aster_canonical_registration_order_required/,
  );
});

test("rejects breaking the Aster prepare, owner-sign, complete, ready UI sequence", () => {
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi.replace(
      "await perpsTurnkey.signAsterAgentApproval",
      "await removedOwnerSignature",
    )),
    /aster_prepare_persist_sign_complete_ready_order_required/,
  );
});

test("rejects signing an Aster preparation before it is durably resumable", () => {
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi.replace(
      "persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending })",
      "removedUnsignedPreparationPersistence(accountCommitment)",
    )),
    /aster_prepare_persist_sign_complete_ready_order_required/,
  );
});

test("rejects removing receipt-only Aster link recovery or its explicit UI action", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare,
      asterComplete.replaceAll("WORKER_RECEIPT_PATH", "removedReceiptRecoveryPath"),
      asterWorker.replaceAll("recoverAsterCredentialRegistration", "removedReceiptRecovery"),
      asterContract,
    ),
    /aster_link_recovery_receipt_path_required|aster_receipt_only_recovery_required/,
  );
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi.replaceAll("Finish Aster linking", "Retry Aster")),
    /aster_link_recovery_action_required/,
  );
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi.replaceAll("Aster reconciliation required", "Retry Aster")),
    /aster_ambiguous_retry_block_required/,
  );
});

test("rejects an Aster completion path that does not freeze ambiguity", () => {
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi.replace("setAsterRegistrationAmbiguous(true);", "ambiguityNotPersisted();")),
    /aster_ambiguous_all_completion_paths_required/,
  );
});

test("rejects hiding the bounded Aster expiry or deliberate stale re-prepare", () => {
  assert.throws(
    () => checkAsterCredentialProvisioningBoundary(
      asterPrepare.replaceAll("authorization_expires_at", "hidden_expiry"),
      asterComplete,
      asterWorker,
      asterContract,
    ),
    /aster_expiry_visibility_required/,
  );
  assert.throws(
    () => checkAsterOnboardingUiBoundary(asterUi
      .replaceAll("Refresh same Aster signer", "Authorizing…")
      .replaceAll("30 days of perpetual trading", "perpetual trading")),
    /aster_deliberate_reprepare_action_required|aster_expiry_disclosure_required/,
  );
});

test("rejects exposing manual Aster key entry as the default path", () => {
  const exposed = asterUi
    .replace("const [showAsterManual, setShowAsterManual] = useState(false)", "const [showAsterManual, setShowAsterManual] = useState(true)")
    .replace("showAsterManual && (", "true && (")
    .replace(
      "if (nextSetupAction.venueId === \"aster\") void beginAsterProgrammatic();",
      "if (nextSetupAction.venueId === \"aster\") void connectAsterManual();",
    );
  assert.throws(
    () => checkAsterOnboardingUiBoundary(exposed),
    /aster_programmatic_primary_action_required|aster_manual_fallback_must_default_hidden|aster_manual_fallback_visibility_guard_required/,
  );
});

test("rejects unsafe Lighter authorization sources or owner-key handling", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.venues.lighter.programmatic_authorizers.push("unverified_browser_wallet");
      value.venues.lighter.owner_private_key_handling = "accepted";
    })),
    /lighter_owner_authorizer_contract_invalid|lighter_non_exportable_owner_transaction_required/,
  );
});

test("rejects Lighter authorization that can rebroadcast or skip exact Turnkey verification", () => {
  assert.throws(
    () => checkLighterCredentialProvisioningBoundary(
      lighterPrepare,
      lighterComplete.replaceAll("verifyLighterChangePubKeyTransaction", "removedSignedTransactionVerification"),
      lighterWorker
        .replaceAll("state.claimExecutionAttempt", "removedAtomicAttemptClaim")
        .replaceAll("return reconcileLighterCredential", "return retryLighterCredential"),
      lighterSigning.replaceAll("TURNKEY_PERPS_OWNER_PATH", "removedTurnkeyOwnerPath"),
    ),
    /lighter_signed_transaction_verification_required|lighter_atomic_attempt_claim_required|lighter_prior_attempt_reconcile_required|lighter_turnkey_owner_path_required/,
  );
});

test("rejects exposing manual Lighter keys or removing reconcile-only recovery", () => {
  const exposed = asterUi
    .replace("const [showLighterManual, setShowLighterManual] = useState(false)", "const [showLighterManual, setShowLighterManual] = useState(true)")
    .replace("showLighterManual && lighter !== \"connected\"", "true && lighter !== \"connected\"")
    .replace(
      "else if (nextSetupAction.venueId === \"lighter\") void beginLighterProgrammatic();",
      "else if (nextSetupAction.venueId === \"lighter\") void connectLighterManual();",
    )
    .replace("reconcile_only: true", "reconcile_only: false");
  assert.throws(
    () => checkLighterOnboardingUiBoundary(exposed),
    /lighter_programmatic_primary_action_required|lighter_manual_fallback_must_default_hidden|lighter_manual_fallback_visibility_guard_required|lighter_reconcile_only_polling_required/,
  );
});

test("rejects a stale or unsourced Lighter new-account minimum", () => {
  assert.throws(
    () => checkLighterActivationReadinessBoundary(
      lighterReadiness
        .replace("BigInt(5_000_000)", "BigInt(3_000_000)")
        .replace("https://apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals", "removed"),
      lighterReadinessServer,
      asterUi.replace("Lighter collateral · ≥5 USDC", "Lighter collateral"),
    ),
    /lighter_new_account_five_usdc_minimum_required|lighter_deposit_source_required|lighter_ui_five_usdc_disclosure_required|lighter_stale_three_usdc_minimum_forbidden/,
  );
});

test("rejects undocumented programmatic provisioning for unsupported venues", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.venues.backpack.provisioning_modes.push("programmatic_generated");
      value.venues.backpack.implemented_provisioning_modes.push("programmatic_generated");
    })),
    /backpack_undocumented_programmatic_provisioning|backpack_must_remain_unsupported/,
  );
});

test("rejects manual credential paths that do not seal directly to an attested runtime", () => {
  assert.throws(
    () => checkVenueExecutionCredentialContract(changed((value) => {
      value.venues.coinbase_advanced.manual_secret_handling = "plaintext_persisted";
    })),
    /coinbase_advanced_direct_sealed_import_required/,
  );
});
