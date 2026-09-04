import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "./private-execution-instruction-seal";
import {
  deriveLiveReadinessDisplay,
  deriveAutopilotExecutionDisplay,
  deriveHyperliquidVerificationAction,
  deriveLiveTradingExecutionDisplay,
  deriveMarketFeedFreshness,
  deriveOrderTicketDisplayState,
  deriveTradingNextAction,
  deriveVenueReadinessSteps,
  hyperliquidAccountAddressDraftValue,
  isHyperliquidAgentKeyConfirmed,
  phoenixOrderbookClickSide,
  requiresHyperliquidPoolTerms,
  requiresHyperliquidOwnerAuthentication,
  shouldAuthenticateHyperliquidOwner,
  shouldContinueHyperliquidAfterOwnerAuthentication,
  shouldResetHyperliquidConnectionError,
  shouldReconnectHyperliquidApiWallet,
  shouldProvisionFocusedHyperliquidWallet,
  shouldShowHyperliquidSetupProgress,
  shouldWaitForHyperliquidOwnerSession,
  type TradingUiStateInput,
} from "./private-account-trading-ui";

const base: TradingUiStateInput = {
  authenticated: true,
  actionClass: "trade_on_platform",
  platformClass: "solana_perps_market",
  hasPreview: false,
  canApprovePrivate: false,
  canApproveDegraded: false,
  waiting: false,
  blocked: false,
  phoenix: { connected: false, armed: false, accessLabel: "not connected" },
  jupiter: { connected: false, armed: false, accessLabel: "not connected" },
  hyperliquid: { connected: false, armed: false, accessLabel: "not connected" },
  coinbase: { connected: false, armed: false, accessLabel: "not connected" },
};

const validOrder: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "BTC",
  side: "buy",
  base_size: "0.001",
  limit_price: "65000",
  order_type: "limit",
  size_mode: "base",
  tif: "Gtc",
};

describe("private account trading UI derivation", () => {
  it("rejects browser autofill values from the Hyperliquid owner-address draft", () => {
    expect(hyperliquidAccountAddressDraftValue("anndrrson@proton.me")).toBeNull();
    expect(hyperliquidAccountAddressDraftValue("0")).toBe("0");
    expect(hyperliquidAccountAddressDraftValue("0xa058")).toBe("0xa058");
    expect(hyperliquidAccountAddressDraftValue(`0x${"a".repeat(40)}`)).toHaveLength(42);
    expect(hyperliquidAccountAddressDraftValue(`0x${"a".repeat(41)}`)).toBeNull();
  });

  it("keeps focused Hyperliquid setup inside one guided surface", () => {
    expect(shouldShowHyperliquidSetupProgress({
      initialSetup: true,
      connectOpen: false,
      working: false,
      error: null,
      notice: null,
    })).toBe(true);
    expect(shouldShowHyperliquidSetupProgress({
      initialSetup: true,
      connectOpen: false,
      working: true,
    })).toBe(true);
    expect(shouldShowHyperliquidSetupProgress({
      initialSetup: true,
      connectOpen: false,
      working: false,
      error: "Connection needs attention",
    })).toBe(true);
    expect(shouldShowHyperliquidSetupProgress({
      initialSetup: true,
      connectOpen: true,
      working: false,
    })).toBe(false);
  });

  it("provisions one signing wallet after focused Google auth settles", () => {
    const ready = {
      initialSetup: true,
      authLoading: false,
      authenticated: true,
      walletLoading: false,
      walletAddress: null,
      provisioning: false,
    };
    expect(shouldProvisionFocusedHyperliquidWallet(ready)).toBe(true);
    expect(shouldProvisionFocusedHyperliquidWallet({ ...ready, authLoading: true })).toBe(false);
    expect(shouldProvisionFocusedHyperliquidWallet({ ...ready, authenticated: false })).toBe(false);
    expect(shouldProvisionFocusedHyperliquidWallet({ ...ready, walletLoading: true })).toBe(false);
    expect(shouldProvisionFocusedHyperliquidWallet({ ...ready, walletAddress: "did:key:ready" })).toBe(false);
    expect(shouldProvisionFocusedHyperliquidWallet({ ...ready, provisioning: true })).toBe(false);
  });

  it("accepts locally generated Hyperliquid agent keys without the import-only checkbox", () => {
    expect(isHyperliquidAgentKeyConfirmed({
      generatedAgentAddress: "0xabc",
      confirmedImportedAgentKey: false,
    })).toBe(true);
    expect(isHyperliquidAgentKeyConfirmed({
      generatedAgentAddress: "",
      confirmedImportedAgentKey: true,
    })).toBe(true);
    expect(isHyperliquidAgentKeyConfirmed({
      generatedAgentAddress: "",
      confirmedImportedAgentKey: false,
    })).toBe(false);

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    expect(cockpitSource).toContain("authorizationStatus?.authorized === true");
    expect(cockpitSource).toContain("if (!authorizationReady)");
    expect(cockpitSource).not.toContain("if (!confirmedAgentKey)");
    expect(cockpitSource).not.toContain("generatedAgentAddress ? authorizationOpened : agentKeyConfirmed");
  });

  it("keeps focused onboarding to sign-in plus two visible Hyperliquid steps", () => {
    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    const authModalSource = readFileSync(
      resolve(process.cwd(), "src/components/AuthModal.tsx"),
      "utf8",
    );
    const perpsTurnkeySource = readFileSync(
      resolve(process.cwd(), "src/lib/perps-turnkey-provider.tsx"),
      "utf8",
    );
    const carryAccountSetupSource = readFileSync(
      resolve(process.cwd(), "src/components/carry/CarryAccountSetup.tsx"),
      "utf8",
    );
    const turnkeyCorePatch = readFileSync(
      resolve(process.cwd(), "patches/@turnkey__core@2.8.0.patch"),
      "utf8",
    );
    const turnkeyWalletKitPatch = readFileSync(
      resolve(process.cwd(), "patches/@turnkey__react-wallet-kit@2.4.2.patch"),
      "utf8",
    );
    expect(cockpitSource).toContain("Start trading on Hyperliquid");
    expect(cockpitSource).toContain('reason="hyperliquid-setup"');
    expect(cockpitSource).toContain("focusedHyperliquidAuthPrompted.current = true;");
    expect(cockpitSource).toContain("focusedHyperliquidWalletProvisioning.current = true;");
    expect(cockpitSource).toContain("void ensureHyperliquidSigningWallet().finally");
    expect(cockpitSource).toContain("Retry secure setup");
    expect(cockpitSource).toContain("setAuthOpen(true);");
    expect(cockpitSource).toContain("Connect wallet & authorize");
    expect(cockpitSource).toContain("authorizeHyperliquidAgentWithInjectedOwner");
    expect(cockpitSource).toContain("Ghola detects the venue state automatically");
    expect(cockpitSource).toContain("named_slot_available");
    expect(cockpitSource).toContain("Finish secure connection");
    expect(cockpitSource).toContain("hyperliquidSetupAuthRedirect(initialReturnTo)");
    expect(cockpitSource).not.toContain("Return here, confirm authorization, then secure and verify.");
    expect(authModalSource).toContain('reason?: "chat-private" | "hyperliquid-setup";');
    expect(authModalSource).toContain("Continue directly to one trade-only Hyperliquid authorization.");
    expect(authModalSource).toContain("isSignup && !isHyperliquidSetup");
    expect(authModalSource).toContain("initializeGoogleRedirect");
    expect(authModalSource).toContain('z-[110]');
    expect(perpsTurnkeySource).toContain("passkeyAuthEnabled: true");
    expect(perpsTurnkeySource).toContain("withPlatformKey: true");
    expect(perpsTurnkeySource).toContain("emailOtpAuthEnabled: true");
    expect(perpsTurnkeySource).toContain("googleOauthEnabled: false");
    expect(perpsTurnkeySource).toContain(
      'await turnkey.handleLogin({ title: "Secure Ghola trading access" });',
    );
    expect(perpsTurnkeySource).toContain("TURNKEY_PENDING_BINDING_STORAGE_KEY");
    expect(perpsTurnkeySource).not.toContain("await turnkey.handleGoogleOauth(");
    expect(perpsTurnkeySource).toContain("await turnkey.handleAddPasskey({");
    expect(perpsTurnkeySource).toContain("displayName: GHOLA_TOUCH_ID_AUTHENTICATOR_NAME");
    expect(perpsTurnkeySource).toContain("hasGholaTouchIdAuthenticator(turnkey.user?.authenticators)");
    expect(carryAccountSetupSource).toContain("await perpsTurnkey.login();");
    expect(carryAccountSetupSource).not.toContain("void perpsTurnkey.login().catch");
    expect(carryAccountSetupSource).toContain("Authenticate by email");
    expect(carryAccountSetupSource).toContain("A secure sign-in window will open.");
    expect(carryAccountSetupSource).toContain("Optional for faster sign-in on this device.");
    expect(carryAccountSetupSource).toContain("A Ghola passkey is enabled for this account.");
    expect(carryAccountSetupSource).toContain('perpsTurnkey.authenticated && (');
    expect(carryAccountSetupSource).toContain('setTouchIdEnrollment("success")');
    expect(carryAccountSetupSource).toContain('role="status"');
    expect(carryAccountSetupSource).toContain("Back to routes");
    expect(carryAccountSetupSource).not.toContain("Capital · later");
    expect(carryAccountSetupSource).toContain("broadcasts its Ethereum association and spends network gas");
    expect(carryAccountSetupSource).toContain("Create & associate key");
    expect(carryAccountSetupSource).toContain("Setup never places an order.");
    expect(carryAccountSetupSource).not.toContain("SetupProgress");
    expect(carryAccountSetupSource).not.toContain("<span>No funds moved</span>");
    expect(turnkeyCorePatch).toContain("this.config.withPlatformKey");
    expect(turnkeyCorePatch).toContain('? "platform"');
    expect(turnkeyWalletKitPatch).toContain("withPlatformKey: masterConfig.passkeyConfig?.withPlatformKey");
    expect(turnkeyWalletKitPatch).toContain("Use existing Ghola Touch ID");
    expect(turnkeyWalletKitPatch).toContain('-      children: "Sign up with passkey"');
    expect(turnkeyWalletKitPatch).not.toContain('+      children: "Sign up with passkey"');
  });

  it("keeps a Hyperliquid connection error visible until the dialog is reopened", () => {
    expect(shouldResetHyperliquidConnectionError(false, true)).toBe(true);
    expect(shouldResetHyperliquidConnectionError(true, true)).toBe(false);
    expect(shouldResetHyperliquidConnectionError(true, false)).toBe(false);

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    expect(cockpitSource).toContain(
      "if (shouldResetHyperliquidConnectionError(previousOpenRef.current, open)) setError(null);",
    );
  });

  it("routes Turnkey owner-auth errors to authentication instead of retry", () => {
    expect(requiresHyperliquidOwnerAuthentication(
      "Authenticate with the Turnkey owner wallet first.",
    )).toBe(true);
    expect(requiresHyperliquidOwnerAuthentication("Could not verify Hyperliquid connection.")).toBe(false);
    expect(shouldAuthenticateHyperliquidOwner({
      legacyApiKeysEnabled: false,
      authenticated: false,
      error: "Could not verify Hyperliquid connection.",
    })).toBe(true);
    expect(shouldAuthenticateHyperliquidOwner({
      legacyApiKeysEnabled: false,
      authenticated: true,
      error: "Authenticate with the Turnkey owner wallet first.",
    })).toBe(true);
    expect(shouldAuthenticateHyperliquidOwner({
      legacyApiKeysEnabled: false,
      authenticated: true,
      error: "Could not verify Hyperliquid connection.",
    })).toBe(false);
    expect(shouldAuthenticateHyperliquidOwner({
      legacyApiKeysEnabled: true,
      authenticated: false,
      error: "Authenticate with the Turnkey owner wallet first.",
    })).toBe(false);

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    expect(cockpitSource).toContain("if (shouldAuthenticateHyperliquidOwner({");
    expect(cockpitSource).toContain('? "Continue with passkey or email"');
  });

  it("waits for the saved Turnkey session before focused verification", () => {
    expect(shouldWaitForHyperliquidOwnerSession({
      initialSetup: true,
      legacyApiKeysEnabled: false,
      loading: true,
    })).toBe(true);
    expect(shouldWaitForHyperliquidOwnerSession({
      initialSetup: true,
      legacyApiKeysEnabled: false,
      loading: false,
    })).toBe(false);
    expect(shouldWaitForHyperliquidOwnerSession({
      initialSetup: false,
      legacyApiKeysEnabled: false,
      loading: true,
    })).toBe(false);
    expect(shouldWaitForHyperliquidOwnerSession({
      initialSetup: true,
      legacyApiKeysEnabled: true,
      loading: true,
    })).toBe(false);
  });

  it("continues to no-submit exactly after owner authentication settles", () => {
    const ready = {
      requested: true,
      loading: false,
      authenticated: true,
      executionAccessReady: true,
      signingWalletReady: true,
      referencePriceReady: true,
    };
    expect(shouldContinueHyperliquidAfterOwnerAuthentication(ready)).toBe(true);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, requested: false })).toBe(false);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, loading: true })).toBe(false);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, authenticated: false })).toBe(false);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, executionAccessReady: false })).toBe(false);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, signingWalletReady: false })).toBe(false);
    expect(shouldContinueHyperliquidAfterOwnerAuthentication({ ...ready, referencePriceReady: false })).toBe(false);

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    const consume = cockpitSource.indexOf("setContinueHyperliquidAfterOwnerAuth(false);");
    const submit = cockpitSource.indexOf("void armAndVerifyHyperliquid(hyperliquidVault || undefined);");
    expect(consume).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(consume);
  });

  it("opens wallet replacement only for Hyperliquid access failures that require resealing", () => {
    expect(shouldReconnectHyperliquidApiWallet(new Error("hyperliquid_agent_binding_required"))).toBe(true);
    expect(shouldReconnectHyperliquidApiWallet("hyperliquid_agent_not_authorized")).toBe(true);
    expect(shouldReconnectHyperliquidApiWallet(new Error("hyperliquid_execution_vault_not_ready"))).toBe(true);
    expect(shouldReconnectHyperliquidApiWallet(new Error("venue_access_required"))).toBe(true);
    expect(shouldReconnectHyperliquidApiWallet(new Error("hyperliquid_binding_check_unavailable"))).toBe(false);
    expect(shouldReconnectHyperliquidApiWallet(new Error("connector_submit_ambiguous"))).toBe(false);

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    expect(cockpitSource.match(/if \(reconnectRequired\) setHyperliquidConnectOpen\(true\);/g)).toHaveLength(2);
  });

  it("requires pooled-account terms only for the Ghola Hyperliquid pool", () => {
    expect(requiresHyperliquidPoolTerms({
      liveHyperliquidFlow: true,
      executionMode: "ghola_pooled",
    })).toBe(true);
    expect(requiresHyperliquidPoolTerms({
      liveHyperliquidFlow: true,
      executionMode: "byo_api_key",
    })).toBe(false);
    expect(requiresHyperliquidPoolTerms({
      liveHyperliquidFlow: true,
      executionMode: "managed_testnet",
    })).toBe(false);
    expect(requiresHyperliquidPoolTerms({
      liveHyperliquidFlow: false,
      executionMode: "ghola_pooled",
    })).toBe(false);
  });

  it("exposes owner authentication before the Hyperliquid no-submit check", () => {
    const input = {
      liveHyperliquidFlow: true,
      connected: true,
      armed: false,
      turnkeyConfigured: true,
      turnkeyLoading: false,
      working: false,
      verified: false,
    };
    expect(deriveHyperliquidVerificationAction({
      ...input,
      turnkeyAuthenticated: false,
    })).toMatchObject({
      kind: "authenticate_owner",
      label: "Authenticate owner wallet",
      disabled: false,
    });
    expect(deriveHyperliquidVerificationAction({
      ...input,
      turnkeyAuthenticated: true,
    })).toBeNull();
    expect(deriveHyperliquidVerificationAction({
      ...input,
      armed: true,
      turnkeyAuthenticated: true,
    })).toMatchObject({
      kind: "verify_connection",
      label: "Check connection",
    });
    expect(deriveHyperliquidVerificationAction({
      ...input,
      armed: true,
      ownerAuthRequired: false,
      turnkeyConfigured: false,
      turnkeyAuthenticated: false,
    })).toMatchObject({
      kind: "verify_connection",
      label: "Check connection",
    });

    const cockpitSource = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    expect(cockpitSource).toContain("!LEGACY_HYPERLIQUID_API_KEYS_ENABLED");
    expect(cockpitSource).toContain("let sealingAddress = turnkeyWallet.walletAddress");
    expect(cockpitSource).toContain("let signInstructionBytes = turnkeyWallet.signBytes");
    expect(cockpitSource).toContain("await perpsTurnkey.login()");
    expect(cockpitSource).not.toContain("hyperliquidOwnerAuthConfirmed");
    expect(cockpitSource).toContain("ownerAuthRequired={!LEGACY_HYPERLIQUID_API_KEYS_ENABLED}");
    expect(cockpitSource).toContain("onAuthenticateTurnkey={authenticateHyperliquidOwner}");
    expect(cockpitSource).toContain("verificationAction.kind === \"authenticate_owner\"");
    expect(cockpitSource).toContain("async function armAndVerifyHyperliquid");
    expect(cockpitSource).toContain("await verifyHyperliquidNoSubmit(vaultOverride, { armSession: true })");
    expect(cockpitSource).toContain("hyperliquid_session:");
    expect(cockpitSource).toContain("setHyperliquidAgent(result.hyperliquid_agent_session)");
  });

  it("wakes and renews the private worker for every Hyperliquid user-action path", () => {
    const serverSource = readFileSync(
      resolve(process.cwd(), "src/app/v1/private-account/_lib.ts"),
      "utf8",
    );

    expect(serverSource).toContain('await wakePrivateWorkerForUse("hyperliquid_session_create")');
    expect(serverSource).toContain('await wakePrivateWorkerForUse("hyperliquid_account_snapshot")');
    expect(serverSource).toContain('await wakePrivateWorkerForUse("hyperliquid_account_stream")');
    expect(serverSource).toContain("verified_runtime_ready: runtimeHealth.status === \"green\"");
    expect(serverSource).toContain("configuredMeasurement === expectedMeasurement");
    expect(serverSource).toContain("hyperliquid_${executionMode}_no_submit_check");
    expect(serverSource).toContain("hyperliquid_${venueExecutionMode ?? \"unknown\"}_submit");
    expect(serverSource).toContain('process.env.GHOLA_PRIVATE_WORKER_WAKE_ON_USE === "false"');
    expect(serverSource).toContain("skip_worker_wake: true");

    const noSubmitRouteSource = readFileSync(
      resolve(process.cwd(), "src/app/v1/private-account/connectors/verify-no-submit/route.ts"),
      "utf8",
    );
    expect(noSubmitRouteSource).toContain('import { after } from "next/server"');
    expect(noSubmitRouteSource).toContain("after(task)");
  });

  it("uses clearer signed-out and venue-access calls to action", () => {
    expect(deriveTradingNextAction({ ...base, authenticated: false }).label).toBe("Sign in to trade");
    expect(deriveTradingNextAction(base).label).toBe("Connect Phoenix authority");
    expect(deriveTradingNextAction(base).secondary).toMatchObject({
      label: "Ghola pool unavailable",
      disabled: true,
    });
    const hyperliquidAccess = deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      hyperliquid: { connected: false, armed: false, accessLabel: "not connected" },
    });
    expect(hyperliquidAccess.label).toBe("Connect API wallet");
    expect(hyperliquidAccess.secondary).toMatchObject({
      label: "Ghola pool unavailable",
      disabled: true,
    });
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      hyperliquid: { connected: false, armed: false, pooledAvailable: true },
    }).secondary).toMatchObject({
      label: "Use Ghola pool",
      disabled: false,
    });
  });

  it("guides Phoenix from access to live verification and preview", () => {
    expect(deriveTradingNextAction(base).kind).toBe("connect_phoenix_byo");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("arm_phoenix");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_phoenix");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Check connection");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("preview");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Preview intent");
  });

  it("does not consider Phoenix approval ready without no-submit verification", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_phoenix");
  });

  it("places or accepts a Phoenix trade after verification and preview", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Place capped trade");
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApproveDegraded: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("accept_visibility");
  });

  it("routes waiting and blocked privacy states to the right action", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      waiting: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("wait_for_privacy");
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      blocked: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("blocked");
  });

  it("requires Hyperliquid live connection verification before approval", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hyperliquid: { connected: true, armed: false, verified: false, ownerAuthConfigured: true, ownerAuthenticated: false },
    })).toMatchObject({
      kind: "authenticate_hyperliquid_owner",
      label: "Authenticate owner wallet",
    });
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hyperliquid: { connected: true, armed: false, verified: false, ownerAuthConfigured: true, ownerAuthenticated: true },
    })).toMatchObject({
      kind: "arm_hyperliquid",
      label: "Create agent",
    });
    expect(deriveVenueReadinessSteps({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hyperliquid: { connected: true, armed: true, verified: false, ownerAuthConfigured: true, ownerAuthenticated: false },
    }).find((step) => step.id === "privacy")).toMatchObject({
      value: "Authenticate owner wallet",
      status: "current",
    });
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hyperliquid: {
        connected: true,
        armed: true,
        verified: false,
        ownerAuthRequired: false,
        ownerAuthConfigured: false,
        ownerAuthenticated: false,
      },
    })).toMatchObject({
      kind: "verify_hyperliquid",
      label: "Check connection",
    });
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: true, ownerAuthenticated: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_hyperliquid");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: true, workerUnavailable: true, ownerAuthenticated: true, accessLabel: "Ghola Vault Mode" },
    }).description).toContain("Worker unavailable");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: false, needsFunds: true, ownerAuthenticated: true, accessLabel: "Ghola Vault Mode" },
    }).description).toContain("Needs funds");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: true, accountReady: true, ownerAuthenticated: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("place_trade");
  });

  it("guides Jupiter through swap authority, live verification, and preview", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
    }).kind).toBe("connect_jupiter_byo");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("arm_jupiter");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_jupiter");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("preview");
  });

  it("guides Coinbase through scoped API key connection and agent arming", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
    }).kind).toBe("connect_coinbase_byo");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: false, accessLabel: "partner omnibus" },
    }).kind).toBe("arm_coinbase");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: true, verified: false, accessLabel: "partner omnibus" },
    }).kind).toBe("verify_coinbase");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: true, verified: true, accessLabel: "partner omnibus" },
    }).kind).toBe("preview");
  });

  it("derives shared all-live readiness status and receipts", () => {
    expect(deriveLiveReadinessDisplay({
      venue: "hyperliquid",
      authenticated: false,
      connected: false,
      armed: false,
    })).toMatchObject({
      status: "signed_out",
      statusLabel: "Sign in required",
      nextActionLabel: "Sign in to connect account",
      broadcastPerformed: false,
    });
    expect(deriveLiveReadinessDisplay({
      venue: "phoenix",
      authenticated: true,
      connected: false,
      armed: false,
    })).toMatchObject({
      status: "connect_account",
      blockerCode: "venue_access_required",
      blockerLabel: "Connect Phoenix access before preview.",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "jupiter",
      authenticated: true,
      connected: true,
      armed: true,
      workerUnavailable: true,
    })).toMatchObject({
      status: "worker_unavailable",
      statusLabel: "Worker unavailable",
      blockerCode: "worker_unavailable",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "coinbase",
      authenticated: true,
      connected: true,
      armed: true,
      needsFunds: true,
    })).toMatchObject({
      status: "needs_funds",
      nextActionLabel: "Check connection",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "hyperliquid",
      authenticated: true,
      marketStatus: "stale",
      connected: true,
      armed: true,
      verified: true,
    })).toMatchObject({
      status: "market_stale",
      blockerCode: "market_stale",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "jupiter",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: false,
      certificateCommitment: "live_readiness_certificate_test",
    })).toMatchObject({
      status: "ready_to_preview",
      statusLabel: "Ready to preview",
      proofCommitments: { certificateCommitment: "live_readiness_certificate_test" },
    });
    expect(deriveLiveReadinessDisplay({
      venue: "coinbase",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: true,
      liveSubmitEnabled: false,
    })).toMatchObject({
      status: "live_submit_locked",
      nextActionLabel: "Preview mode",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "phoenix",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: true,
      canSubmit: true,
    })).toMatchObject({
      status: "ready_to_place_capped_trade",
      receiptSummary: "Phoenix readiness passed. No broadcast happened during the check.",
    });
  });

  it("derives readiness step status from venue and preview state", () => {
    const steps = deriveVenueReadinessSteps({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    });
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ["venue", "done"],
      ["access", "done"],
      ["limits", "done"],
      ["privacy", "done"],
      ["submit", "current"],
    ]);
    expect(steps.find((step) => step.id === "privacy")?.value).toBe("Checked");
  });

  it("derives confident execution display without leaking internal flags", () => {
    const display = deriveAutopilotExecutionDisplay({
      product_id: "BTC-USD",
      can_arm: true,
      can_live_submit: false,
      blockers: ["private_worker_not_configured", "tiny_live_order_gate_not_ready", "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=false"],
      venue_readiness: [{
        venue_id: "hyperliquid",
        status: "blocked",
        reason_codes: ["hyperliquid_tiny_fill_disabled"],
      }],
    });
    expect(display).toMatchObject({
      mode: "needs_setup",
      label: "Needs setup",
      can_trade: false,
      next_action_label: "Finish setup",
    });
    const customerCopy = [display.label, display.detail, display.plain_reason].join(" ");
    expect(customerCopy).not.toMatch(/tiny|gate|PRIVATE_AGENT|live_submit|dry_run|kill_switch/i);

    const live = deriveAutopilotExecutionDisplay({
      session: {
        status: "running",
        execution_enabled: true,
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "50",
          max_daily_notional_bucket: "250",
          max_slippage_bps: 50,
        },
      },
    });
    expect(live).toMatchObject({
      mode: "live_capped",
      label: "Live Capped",
      can_trade: true,
      limits: {
        venues: ["Hyperliquid"],
        markets: ["BTC"],
        max_order_usd: "$50",
        daily_cap_usd: "$250",
        slippage_bps: 50,
      },
    });
  });

  it("derives live trading display from launch status", () => {
    expect(deriveLiveTradingExecutionDisplay({
      live_trading_enabled: true,
      pooled_live_trading_enabled: true,
      required_venues: [{ id: "hyperliquid", label: "Hyperliquid", status: "green", reason_codes: [] }],
    })).toMatchObject({
      mode: "live_capped",
      label: "Live Capped available",
      can_trade: true,
      limits: { venues: ["Hyperliquid"] },
    });
    const blocked = deriveLiveTradingExecutionDisplay({
      live_trading_enabled: false,
      reason_codes: ["venue_dry_run_enabled", "hyperliquid:hyperliquid_live_mode_disabled"],
    });
    expect(blocked.mode).toBe("needs_setup");
    expect([blocked.label, blocked.detail, blocked.plain_reason].join(" ")).not.toMatch(/dry_run|live_mode|hyperliquid:/i);
  });

  it("uses conventional Phoenix book click sides", () => {
    expect(phoenixOrderbookClickSide("ask")).toBe("buy");
    expect(phoenixOrderbookClickSide("bid")).toBe("sell");
  });

  it("derives human market feed freshness labels", () => {
    const nowMs = Date.parse("2026-05-30T12:00:10.000Z");
    expect(deriveMarketFeedFreshness({
      status: "live",
      fetchedAt: "2026-05-30T12:00:08.000Z",
      stale: false,
      nowMs,
    })).toEqual({ label: "Live · updated 2s ago", tone: "good" });
    expect(deriveMarketFeedFreshness({
      status: "fallback_polling",
      fetchedAt: "2026-05-30T12:00:02.000Z",
      nowMs,
    })).toEqual({ label: "Polling · last good 8s ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({
      status: "reconnecting",
      fetchedAt: "2026-05-30T11:59:00.000Z",
      nowMs,
    })).toEqual({ label: "Reconnecting · last good 1m ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({
      status: "stale",
      fetchedAt: "2026-05-30T10:00:00.000Z",
      nowMs,
    })).toEqual({ label: "Stale · last good 2h ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({ status: null, fetchedAt: null, nowMs }))
      .toEqual({ label: "Waiting for data", tone: "neutral" });
  });

  it("maps order validation errors to inline ticket fields", () => {
    const missingUsd = validatePrivateExecutionOrderDraft({
      ...validOrder,
      base_size: "",
      quote_size: "",
      size_mode: "quote",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingUsd }).fieldHints.size)
      .toContain("Enter a USD amount greater than 0.");

    const missingBase = validatePrivateExecutionOrderDraft({
      ...validOrder,
      base_size: "",
      size_mode: "base",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingBase }).fieldHints.size)
      .toContain("Enter a base size greater than 0.");

    const missingLimit = validatePrivateExecutionOrderDraft({
      ...validOrder,
      limit_price: "",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingLimit }).fieldHints.price)
      .toContain("Enter a limit price greater than 0.");

    const missingPhoenixLimit = validatePrivateExecutionOrderDraft({
      ...validOrder,
      venue_id: "phoenix",
      operation_class: "perp_limit_order",
      order_type: "market",
      size_mode: "quote",
      quote_size: "5",
      limit_price: "",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingPhoenixLimit }).fieldHints.price)
      .toContain("Enter a Phoenix market price limit greater than 0.");

    const invalidSlippage = validatePrivateExecutionOrderDraft({
      ...validOrder,
      live_order_mode: "tiny_fill",
      quote_size: "5",
      max_slippage_bps: "101",
    });
    expect(deriveOrderTicketDisplayState({ errors: invalidSlippage }).fieldHints.slippage)
      .toContain("Set slippage between 1 and 100 bps.");
  });

  it("maps live cap and ticket status labels", () => {
    const capErrors = validatePrivateExecutionOrderDraft({
      ...validOrder,
      live_order_mode: "tiny_fill",
      quote_size: "26",
      max_slippage_bps: "50",
    });
    const blocked = deriveOrderTicketDisplayState({ errors: capErrors });
    expect(blocked.statusLabel).toBe("Needs fields");
    expect(blocked.primaryBlockerText).toBe("Fix order fields before preview");
    expect(blocked.fieldHints.size).toContain("Live orders are capped at $25.");
    expect(deriveOrderTicketDisplayState({ errors: [] }).statusLabel).toBe("Ready");
    expect(deriveOrderTicketDisplayState({ errors: [], hasPreview: true }).statusLabel).toBe("Checked");
  });
});
