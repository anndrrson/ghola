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
  checkLighterUniversalDepositBoundary,
  checkLighterOnboardingUiBoundary,
  checkVenueOnboardingLiveProofBoundary,
  checkTurnkeyVenueOwnerAddressBoundary,
  checkTurnkeyPerpsWalletSelectionBoundary,
  checkVenueExecutionCredentialBoundary,
  checkVenueExecutionCredentialContract,
  stripCodeComments,
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
const lighterUdaServer = readFileSync(resolve(HERE, "../src/lib/lighter-universal-deposit-address.server.ts"), "utf8");
const lighterUdaAuthorization = readFileSync(resolve(HERE, "../src/lib/lighter-deposit-authorization.server.ts"), "utf8");
const lighterTurnkeyOwnerBinding = readFileSync(resolve(HERE, "../src/lib/lighter-turnkey-owner-binding.server.ts"), "utf8");
const privateAccountStore = readFileSync(resolve(HERE, "../src/lib/private-account-store.ts"), "utf8");
const lighterUdaChallengeRoute = readFileSync(resolve(HERE, "../src/app/api/carry/lighter-deposit-authorization/route.ts"), "utf8");
const lighterUdaDestinationRoute = readFileSync(resolve(HERE, "../src/app/api/carry/lighter-deposit-destination/route.ts"), "utf8");
const lighterUdaClient = readFileSync(resolve(HERE, "../src/lib/lighter-universal-deposit-address.client.ts"), "utf8");
const envExample = readFileSync(resolve(HERE, "../.env.example"), "utf8");

function lighterUdaBoundary(overrides = {}) {
  return checkLighterUniversalDepositBoundary({
    serverSource: lighterUdaServer,
    authorizationSource: lighterUdaAuthorization,
    turnkeyOwnerBindingSource: lighterTurnkeyOwnerBinding,
    storeSource: privateAccountStore,
    challengeRouteSource: lighterUdaChallengeRoute,
    destinationRouteSource: lighterUdaDestinationRoute,
    clientSource: lighterUdaClient,
    providerSource: turnkeyProvider,
    setupSource: asterUi,
    envSource: envExample,
    ...overrides,
  });
}

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
  assert.equal(lighterUdaBoundary().ok, true);
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
      asterUi.replace("Owner wallet staging balance", "Lighter collateral"),
    ),
    /lighter_new_account_five_usdc_minimum_required|lighter_deposit_source_required|lighter_owner_balance_must_not_be_labeled_deposited_collateral|lighter_stale_three_usdc_minimum_forbidden/,
  );
});

test("rejects directing Lighter USDC to the owner without a verified deposit destination", () => {
  assert.throws(
    () => checkLighterActivationReadinessBoundary(
      lighterReadiness
        .replace(
          "Funding is blocked until Ghola verifies an official Lighter deposit destination.",
          "Send at least 5 USDC on Base to the owner address above.",
        )
        .replace("Do not send USDC directly to the owner address.", ""),
      lighterReadinessServer,
      asterUi,
    ),
    /lighter_unverified_deposit_destination_must_fail_closed|lighter_direct_owner_deposit_warning_required|lighter_direct_owner_usdc_deposit_forbidden/,
  );
});

test("rejects exposing the Lighter builder key or bypassing owner proof", () => {
  assert.throws(
    () => lighterUdaBoundary({
      serverSource: lighterUdaServer.replace("GHOLA_LIGHTER_BUILDER_KEY", "NEXT_PUBLIC_GHOLA_LIGHTER_BUILDER_KEY"),
      authorizationSource: lighterUdaAuthorization.replace('import "server-only";', ""),
      destinationRouteSource: lighterUdaDestinationRoute
        .replaceAll("verifyLighterDepositAuthorizationToken", "skipTokenVerification")
        .replaceAll("verifyLighterDepositAuthorizationSignature", "skipSignatureVerification"),
    }),
    /lighter_uda_server_builder_key_required|lighter_uda_authorization_server_only_marker_required|lighter_uda_token_verification_required|lighter_uda_signature_verification_required|lighter_uda_public_builder_key_forbidden/,
  );
});

test("rejects generic mutation-capable credentials at the Turnkey query boundary", () => {
  assert.throws(
    () => lighterUdaBoundary({
      turnkeyOwnerBindingSource: lighterTurnkeyOwnerBinding
        .replaceAll("GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY", "TURNKEY_API_PUBLIC_KEY")
        .replaceAll("GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY", "TURNKEY_API_PRIVATE_KEY")
        .replaceAll("GHOLA_TURNKEY_QUERY_ORGANIZATION_ID", "TURNKEY_ORG_ID"),
    }),
    /lighter_turnkey_query_public_key_required|lighter_turnkey_query_private_key_required|lighter_turnkey_query_organization_binding_required|lighter_turnkey_query_must_not_reuse_generic_credentials/,
  );
});

test("rejects retrying or creating a Lighter destination before owner verification", () => {
  assert.throws(
    () => lighterUdaBoundary({
      destinationRouteSource: lighterUdaDestinationRoute
        .replace(
          "ownerAddress = await verifyLighterDepositAuthorizationSignature({",
          "await createLighterUniversalDepositAddress({ ownerAddress });\n    ownerAddress = await verifyLighterDepositAuthorizationSignature({",
        ),
    }),
    /lighter_uda_verify_before_create_order_required|lighter_uda_exactly_one_create_site_required/,
  );
});

test("rejects removing the Lighter UDA destination-chain drift guard", () => {
  assert.throws(
    () => lighterUdaBoundary({
      serverSource: lighterUdaServer.replace(
        "normalizeChainId(resolved.toChainId) !== LIGHTER_UDA_CHAIN_ID",
        "false",
      ),
    }),
    /lighter_uda_destination_chain_drift_guard_required/,
  );
});

test("rejects removing the durable one-shot Lighter destination claim", () => {
  assert.throws(
    () => lighterUdaBoundary({
      storeSource: privateAccountStore
        .replaceAll("claimPrivateLighterUdaAttempt", "removedDurableClaim")
        .replace("owner_commitment TEXT NOT NULL UNIQUE", "owner_commitment TEXT NOT NULL"),
      destinationRouteSource: lighterUdaDestinationRoute
        .replaceAll("claimPrivateLighterUdaAttempt", "removedDurableClaim")
        .replace("if (!claim.acquired)", "if (false)"),
    }),
    /lighter_uda_durable_claim_required|lighter_uda_session_owner_quota_required|lighter_uda_destination_durable_claim_required|lighter_uda_duplicate_claim_lock_required/,
  );
});

test("rejects a Lighter claim that is not globally wallet-bound", () => {
  assert.throws(
    () => lighterUdaBoundary({
      storeSource: privateAccountStore
        .replaceAll("private_account_lighter_uda_wallet_commitment_unique", "removedWalletUniqueIndex")
        .replaceAll("lighterUdaAttemptByWalletBlobPath", "removedWalletBlobClaim")
        .replaceAll('lighterUdaLedgerError("lighter_uda_transactional_store_required", 503)', 'lighterUdaLedgerError("blob_store_allowed", 503)'),
      destinationRouteSource: lighterUdaDestinationRoute
        .replace('gholaCommitment("wallet", ownerAddress.toLowerCase())', 'gholaCommitment("wallet", ownerCommitment)')
        .replace("claim.record.wallet_commitment !== walletCommitment", "false")
        .replaceAll('"lighter_uda_attempt_binding_mismatch"', '"lighter_uda_attempt_owner_mismatch"'),
    }),
    /lighter_uda_wallet_quota_required|lighter_uda_wallet_blob_claim_required|lighter_uda_transactional_store_required|lighter_uda_wallet_commitment_required|lighter_uda_cross_session_binding_required|lighter_uda_binding_failure_required/,
  );
});

test("rejects forwarding the Lighter builder key through redirects", () => {
  assert.throws(
    () => lighterUdaBoundary({
      serverSource: `${lighterUdaServer.replaceAll('redirect: "error"', 'redirect: "follow"')}\nconst bypass = /* redirect: "error" redirect: "error" redirect: "error" */ 1;`,
    }),
    /lighter_uda_redirect_rejection_required|lighter_uda_all_authenticated_redirects_must_fail_closed/,
  );
});

test("rejects a server-only marker that exists only in a comment", () => {
  assert.throws(
    () => lighterUdaBoundary({
      authorizationSource: `${lighterUdaAuthorization.replace('import "server-only";', "")}\n/* import "server-only"; */`,
    }),
    /lighter_uda_authorization_server_only_marker_required/,
  );
});

test("rejects a funding lock marker that exists only in a JSX comment", () => {
  assert.throws(
    () => lighterUdaBoundary({
      setupSource: `${asterUi
        .replace("if (lighterDepositRetryForbidden) return;", "")
        .replace(
          "canGenerateDepositAddress={perpsTurnkey.authenticated && !lighterDepositRetryForbidden}",
          "canGenerateDepositAddress={perpsTurnkey.authenticated}",
        )}\nconst GuardComment = () => <>{/* if (lighterDepositRetryForbidden) return; canGenerateDepositAddress={perpsTurnkey.authenticated && !lighterDepositRetryForbidden} */}</>;`,
    }),
    /lighter_uda_retry_forbidden_button_lock_required/,
  );
});

test("rejects turning the manual reconciliation action into a generation retry", () => {
  assert.throws(
    () => lighterUdaBoundary({
      setupSource: asterUi.replace("onClick={onReconcile}", "onClick={onGenerate}"),
    }),
    /lighter_uda_retry_forbidden_button_lock_required/,
  );
});

test("rejects an environment marker that exists only in a comment", () => {
  assert.throws(
    () => lighterUdaBoundary({
      envSource: `${envExample.replace("GHOLA_LIGHTER_BUILDER_KEY=", "GHOLA_LIGHTER_BUILDER_KEY_REMOVED=")}\n# GHOLA_LIGHTER_BUILDER_KEY=`,
    }),
    /lighter_uda_builder_env_documentation_required/,
  );
});

test("comment stripping preserves comment-like string content and offsets", () => {
  const source = 'const url = "https://bridge.lighter.xyz"; const n = /* fake */ 1; const value = "// real string"; const View = () => <>{/* jsx fake */}</>;';
  const stripped = stripCodeComments(source);
  assert.equal(stripped.length, source.length);
  assert.match(stripped, /https:\/\/bridge\.lighter\.xyz/);
  assert.match(stripped, /\/\/ real string/);
  assert.doesNotMatch(stripped, /fake/);
  assert.doesNotMatch(stripped, /jsx fake/);
});

test("rejects retrying after an unknown or lost destination response", () => {
  assert.throws(
    () => lighterUdaBoundary({
      clientSource: lighterUdaClient
        .replace("ambiguousDestinationError()", "new Error()")
        .replace("!RETRYABLE_DESTINATION_REJECTIONS.has(code)", "false"),
      setupSource: asterUi.replace(
        "if (lighterDepositRetryForbidden) return;",
        "",
      ),
    }),
    /lighter_uda_client_ambiguous_transport_lock_required|lighter_uda_client_unknown_failure_lock_required|lighter_uda_retry_forbidden_button_lock_required/,
  );
});

test("rejects a generic or non-explicit Lighter funding UI", () => {
  assert.throws(
    () => lighterUdaBoundary({
      providerSource: turnkeyProvider.replaceAll("signLighterDepositAuthorization", "signOwnerMessage"),
      setupSource: asterUi
        .replaceAll("Generate verified deposit address", "Continue")
        .replaceAll('data-lighter-deposit-verified="false"', 'data-lighter-deposit-verified="unknown"'),
    }),
    /lighter_uda_specific_turnkey_signer_required|lighter_uda_explicit_generation_action_required|lighter_uda_locked_ui_state_required/,
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
