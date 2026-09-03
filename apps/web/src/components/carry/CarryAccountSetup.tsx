"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, X } from "lucide-react";
import { executionVenueLabel } from "@ghola/execution-core";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { TurnkeyPerpsManager } from "@/components/trade/TurnkeyPerpsManager";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { opaqueTurnkeyWalletScope, useTurnkeyWallet } from "@/lib/turnkey-provider";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";
import {
  buildAsterExecutionVaultBundle,
  validateAsterExecutionCredentialDraft,
  type AsterExecutionCredentialDraft,
} from "@/lib/aster-vault-seal";
import {
  buildLighterExecutionVaultBundle,
  validateLighterExecutionCredentialDraft,
  type LighterExecutionCredentialDraft,
} from "@/lib/lighter-vault-seal";
import {
  getHyperliquidExecutionVaultStatus,
  getPrivateAgentPassport,
  linkPrivateAgentPlatform,
  completeAsterOwnerActivation,
  completeAsterProgrammaticCredential,
  completeLighterProgrammaticCredential,
  prepareAsterOwnerActivation,
  prepareAsterProgrammaticCredential,
  prepareLighterProgrammaticCredential,
  type AsterProgrammaticPreparation,
  type LighterProgrammaticPreparation,
} from "@/lib/private-account-client";
import { classifyAsterOnboardingFailure } from "@/lib/aster-onboarding-recovery";
import {
  getCurrentVenueCredentialOnboardingPath,
  type VenueCredentialOnboardingPath,
} from "@/lib/venue-credential-onboarding";
import {
  readCarryOnboardingRecovery,
  readCarryOnboardingRecoveryForUser,
  updateCarryOnboardingRecoveryForUser,
  type PendingAsterOnboarding,
  type PendingLighterOnboarding,
  type VenueAccountActivationRequirement,
} from "@/lib/carry-onboarding-recovery";
import {
  carryAccountConnectionProgressForVenues,
  carryAccountConnections,
  carryExecutionPairFromReturnTo,
  carryNoSubmitVerificationHref,
  carryPairSetupHref,
  carryAccountSetupNextAction,
  carryWorkerPlatformGate,
  type CarryWorkerPlatformGate,
} from "@/lib/carry-account-connections";
import { fetchPrivateAgentRuntimeStatus } from "@/lib/hyperliquid-vault-seal";
import {
  CARRY_EXECUTION_VENUES,
  isCarryExecutionVenue,
  type CarryExecutionVenue,
} from "@/lib/carry-venues";
import {
  describeLighterActivationNextStep,
  fetchLighterActivationReadiness,
  LIGHTER_NEW_ACCOUNT_DEPOSIT_SOURCE,
  LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS,
  type LighterActivationReadiness,
} from "@/lib/lighter-activation-readiness";
import {
  fetchVerifiedLighterDepositDestination,
  isLighterDepositRetryForbidden,
  LIGHTER_UDA_CLIENT_MAX_AGE_MS,
  reconcileExistingLighterDepositDestination,
  validateVerifiedLighterDepositDestination,
  type VerifiedLighterDepositDestination,
} from "@/lib/lighter-universal-deposit-address.client";
import {
  checkLighterDepositReconciliation,
  lighterUsdcToMicrounits,
  LIGHTER_DEPOSIT_DEFAULT_USDC,
  LighterDepositReconciliationError,
  type LighterDepositReconciliation,
} from "@/lib/lighter-deposit-reconciliation.client";
import {
  LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
  type LighterFundingEligibilityAttestationV1,
} from "@/lib/lighter-funding-eligibility";
import {
  verifyLighterOwnerRecoveryReadiness,
  type VerifiedLighterOwnerRecoveryReadiness,
} from "@/lib/lighter-owner-recovery-readiness.client";
import { shouldResumeUnsignedTurnkeySetup } from "@/lib/carry-setup-auth-recovery";
import { hyperliquidMarketFromTradeReturn } from "@/lib/hyperliquid-trade-return";

type VenueState = "connected" | "needed" | "unavailable";
type AccountReadinessState = "unknown" | "loading" | "ready" | "failed";
type VenueActivation = { venue: "aster" | "lighter"; ownerAddress: string };
type PendingAsterLinkRecovery = PendingAsterOnboarding;
type PendingLighterAssociation = PendingLighterOnboarding;

const HYPERLIQUID_ONBOARDING = getCurrentVenueCredentialOnboardingPath("hyperliquid");
const ASTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("aster");
const LIGHTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("lighter");
const LIGHTER_UDA_RETRY_FORBIDDEN_STORAGE_PREFIX = "ghola_lighter_uda_retry_forbidden_v1:";
const ASTER_ACTIVATION_SUBMISSION_STORAGE_PREFIX = "ghola:aster-owner-activation-submission:v1:";

function lighterUdaRetryForbiddenStorageKey(ownerAddress: string) {
  return `${LIGHTER_UDA_RETRY_FORBIDDEN_STORAGE_PREFIX}${ownerAddress.toLowerCase()}`;
}

function lighterDepositDestinationFailureMessage(caught: unknown) {
  const code = caught instanceof Error ? caught.message : "";
  if (code === "lighter_uda_eligibility_country_restricted") {
    return "Lighter funding is unavailable in your jurisdiction. Do not send USDC.";
  }
  if (code === "lighter_uda_eligibility_country_unavailable" || code === "lighter_uda_eligibility_country_mismatch") {
    return "Funding eligibility could not be verified. Do not send USDC.";
  }
  if (code === "lighter_uda_builder_key_unconfigured") {
    return "Ghola's Lighter funding connection is not enabled yet. Do not send USDC.";
  }
  return "Verified deposit destination unavailable. Do not send USDC.";
}

function lighterOwnerRecoveryReadinessFailureMessage(caught: unknown) {
  const code = caught instanceof Error ? caught.message : "";
  if (code === "lighter_recovery_owner_gas_insufficient") {
    return "Owner recovery capability needs Ethereum gas on the exact Turnkey owner.";
  }
  if (code === "lighter_recovery_owner_account_not_found") {
    return "The reconciled Lighter owner account is not available for recovery verification yet.";
  }
  return "Owner recovery capability could not be verified.";
}
const ONBOARDING_BY_VENUE: Readonly<Record<CarryExecutionVenue, VenueCredentialOnboardingPath>> = Object.freeze({
  hyperliquid: HYPERLIQUID_ONBOARDING,
  aster: ASTER_ONBOARDING,
  lighter: LIGHTER_ONBOARDING,
});

export function CarryAccountSetup({
  returnTo = "/carry",
  hyperliquidNetwork,
}: {
  returnTo?: string;
  hyperliquidNetwork: "mainnet" | "testnet";
}) {
  const auth = useThumperAuth();
  const searchParams = useSearchParams();
  const wallet = useTurnkeyWallet();
  const perpsTurnkey = usePerpsTurnkey();
  const recoveryUserScope = opaqueTurnkeyWalletScope(auth.user?.id || "") || "";
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [accountCommitment, setAccountCommitment] = useState<string | null>(null);
  const [hyperliquid, setHyperliquid] = useState<VenueState>("needed");
  const [aster, setAster] = useState<VenueState>("needed");
  const [lighter, setLighter] = useState<VenueState>("needed");
  const [showAsterManual, setShowAsterManual] = useState(false);
  const [pendingAsterAuthorization, setPendingAsterAuthorization] = useState(false);
  const [pendingAsterWalletRepair, setPendingAsterWalletRepair] = useState(false);
  const [pendingAsterLinkRecovery, setPendingAsterLinkRecovery] = useState<PendingAsterLinkRecovery | null>(null);
  const [asterReprepareRequired, setAsterReprepareRequired] = useState(false);
  const [asterRegistrationAmbiguous, setAsterRegistrationAmbiguous] = useState(false);
  const [asterWalletRepairRequired, setAsterWalletRepairRequired] = useState(false);
  const [asterWalletRepairCompleted, setAsterWalletRepairCompleted] = useState(false);
  const [showLighterManual, setShowLighterManual] = useState(false);
  const [pendingLighterAuthorization, setPendingLighterAuthorization] = useState(false);
  const [pendingLighterAssociation, setPendingLighterAssociation] = useState<PendingLighterAssociation | null>(null);
  const [accountReadinessState, setAccountReadinessState] = useState<AccountReadinessState>("unknown");
  const [accountReadinessResolvedScope, setAccountReadinessResolvedScope] = useState<string | null>(null);
  const accountReadinessRequestRef = useRef<{
    scope: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);
  const accountReadinessGenerationRef = useRef(0);
  const accountReadinessScopeRef = useRef("");
  const asterActivationInFlightRef = useRef(false);
  const asterActivationSubmissionRef = useRef<string | null>(null);
  const accountReadinessReady = accountReadinessState === "ready"
    && Boolean(recoveryUserScope)
    && accountReadinessResolvedScope === recoveryUserScope;
  const [draft, setDraft] = useState<AsterExecutionCredentialDraft>({
    user_address: "",
    api_wallet_private_key: "",
  });
  const [lighterDraft, setLighterDraft] = useState<LighterExecutionCredentialDraft>({
    account_index: "",
    api_key_index: "",
    api_private_key: "",
  });
  const [working, setWorking] = useState(false);
  const [showHyperliquidSetup, setShowHyperliquidSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationNeeded, setActivationNeeded] = useState<VenueActivation | null>(null);
  const [lighterReadiness, setLighterReadiness] = useState<LighterActivationReadiness | null>(null);
  const [lighterReadinessError, setLighterReadinessError] = useState<string | null>(null);
  const [checkingLighterReadiness, setCheckingLighterReadiness] = useState(false);
  const lighterReadinessRequestRef = useRef<Promise<void> | null>(null);
  const [lighterDepositDestination, setLighterDepositDestination] = useState<VerifiedLighterDepositDestination | null>(null);
  const [lighterDepositDestinationError, setLighterDepositDestinationError] = useState<string | null>(null);
  const [lighterDepositRetryForbidden, setLighterDepositRetryForbidden] = useState(false);
  const [checkingLighterDepositDestination, setCheckingLighterDepositDestination] = useState(false);
  const [lighterDepositAddressCopied, setLighterDepositAddressCopied] = useState(false);
  const [lighterFundingEligibilityAccepted, setLighterFundingEligibilityAccepted] = useState(false);
  const lighterDepositDestinationRequestRef = useRef<Promise<void> | null>(null);
  const [workerPlatform, setWorkerPlatform] = useState<CarryWorkerPlatformGate | null>(null);
  const safeReturnTo = returnTo === "/carry" || returnTo.startsWith("/trade?") ? returnTo : "/carry";
  const requestedLongVenue = searchParams.get("long_venue");
  const requestedShortVenue = searchParams.get("short_venue");
  const returnPair = carryExecutionPairFromReturnTo(safeReturnTo);
  const pairScoped = isCarryExecutionVenue(requestedLongVenue)
    && isCarryExecutionVenue(requestedShortVenue)
    && requestedLongVenue !== requestedShortVenue
    && returnPair?.longVenueId === requestedLongVenue
    && returnPair.shortVenueId === requestedShortVenue;
  const requiredVenueIds = useMemo<readonly CarryExecutionVenue[]>(() => pairScoped
    ? [requestedLongVenue as CarryExecutionVenue, requestedShortVenue as CarryExecutionVenue]
    : CARRY_EXECUTION_VENUES,
  [pairScoped, requestedLongVenue, requestedShortVenue]);
  const scopedActivationNeeded = activationNeeded && requiredVenueIds.includes(activationNeeded.venue)
    ? activationNeeded
    : null;
  const hyperliquidMarket = hyperliquidMarketFromTradeReturn(safeReturnTo) || "BTC";
  const noSubmitReturnTo = carryNoSubmitVerificationHref(safeReturnTo);
  const firstProofSetupHref = carryPairSetupHref(safeReturnTo, {
    longVenueId: "hyperliquid",
    shortVenueId: "aster",
  });
  const asterWalletRepairRequested = asterWalletRepairRequired ||
    (!asterWalletRepairCompleted && searchParams.get("repair") === "aster-wallet");
  const setupReturnTo = `/account?${new URLSearchParams({
    setup: "carry",
    ...(pairScoped ? { long_venue: requestedLongVenue, short_venue: requestedShortVenue } : {}),
    return_to: safeReturnTo,
  }).toString()}`;

  const refresh = useCallback(() => {
    const scope = auth.authenticated ? recoveryUserScope : "";
    if (accountReadinessScopeRef.current !== scope) {
      accountReadinessGenerationRef.current += 1;
      accountReadinessRequestRef.current = null;
      accountReadinessScopeRef.current = scope;
      setAccountReadinessResolvedScope(null);
      setAccountReadinessState("unknown");
      setAccountCommitment(null);
      setWorkerPlatform(null);
      setAster("needed");
      setLighter("needed");
      setHyperliquid("needed");
      setActivationNeeded(null);
      setPendingAsterAuthorization(false);
      setPendingAsterWalletRepair(false);
      setPendingAsterLinkRecovery(null);
      setPendingLighterAuthorization(false);
      setPendingLighterAssociation(null);
    }
    if (!scope) {
      return Promise.resolve();
    }
    if (accountReadinessRequestRef.current?.scope === scope) {
      return accountReadinessRequestRef.current.promise;
    }
    const generation = accountReadinessGenerationRef.current + 1;
    accountReadinessGenerationRef.current = generation;
    setAccountReadinessResolvedScope(null);
    const request = (async () => {
      setAccountReadinessState("loading");
      setError(null);
      try {
        const [passportRaw, hyperliquidRaw, runtimeRaw] = await Promise.all([
          getPrivateAgentPassport(),
          getHyperliquidExecutionVaultStatus(),
          fetchPrivateAgentRuntimeStatus().catch(() => null),
        ]);
        if (generation !== accountReadinessGenerationRef.current
          || accountReadinessScopeRef.current !== scope) return;
        const connections = carryAccountConnections({ passport: passportRaw, hyperliquidStatus: hyperliquidRaw });
        setWorkerPlatform(carryWorkerPlatformGate(runtimeRaw));
        setAccountCommitment(connections.accountCommitment);
        setAster(connections.venues.aster ? "connected" : "needed");
        setLighter(connections.venues.lighter ? "connected" : "needed");
        setHyperliquid(connections.venues.hyperliquid ? "connected" : "needed");
        setAccountReadinessResolvedScope(scope);
        setAccountReadinessState("ready");
      } catch {
        if (generation !== accountReadinessGenerationRef.current
          || accountReadinessScopeRef.current !== scope) return;
        setWorkerPlatform(null);
        setAccountReadinessResolvedScope(null);
        setAccountReadinessState("failed");
        setError("Account readiness could not be refreshed. No wallet action was enabled.");
      } finally {
        if (accountReadinessRequestRef.current?.scope === scope
          && accountReadinessRequestRef.current.generation === generation) {
          accountReadinessRequestRef.current = null;
        }
      }
    })();
    accountReadinessRequestRef.current = { scope, generation, promise: request };
    return request;
  }, [auth.authenticated, recoveryUserScope]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!recoveryUserScope) return;
    try {
      const recovered = accountCommitment
        ? readCarryOnboardingRecovery(window.localStorage, accountCommitment)
        : readCarryOnboardingRecoveryForUser(window.localStorage, recoveryUserScope);
      if (!accountCommitment && recovered?.account_commitment) {
        setAccountCommitment(recovered.account_commitment);
      }
      if (recovered?.aster) setPendingAsterLinkRecovery(recovered.aster);
      if (recovered?.lighter) setPendingLighterAssociation(recovered.lighter);
      if (recovered?.aster_activation && requiredVenueIds.includes("aster")) {
        setActivationNeeded({ venue: "aster", ownerAddress: recovered.aster_activation.owner_address });
        setAsterReprepareRequired(true);
      } else if (recovered?.lighter_activation && requiredVenueIds.includes("lighter")) {
        setActivationNeeded({ venue: "lighter", ownerAddress: recovered.lighter_activation.owner_address });
      }
    } catch {
      // Storage may be unavailable; worker-side one-shot guards still apply.
    }
  }, [accountCommitment, recoveryUserScope, requiredVenueIds]);

  const refreshLighterReadiness = useCallback(async (ownerAddress?: string) => {
    const owner = ownerAddress || (scopedActivationNeeded?.venue === "lighter" ? scopedActivationNeeded.ownerAddress : "");
    if (!owner) return;
    if (lighterReadinessRequestRef.current) return lighterReadinessRequestRef.current;
    const request = (async () => {
      setCheckingLighterReadiness(true);
      setLighterReadinessError(null);
      try {
        setLighterReadiness(await fetchLighterActivationReadiness(owner));
      } catch (caught) {
        setLighterReadiness(null);
        setLighterReadinessError(caught instanceof Error ? caught.message : "Readiness check unavailable.");
      } finally {
        setCheckingLighterReadiness(false);
        lighterReadinessRequestRef.current = null;
      }
    })();
    lighterReadinessRequestRef.current = request;
    return request;
  }, [scopedActivationNeeded]);

  const refreshLighterDepositDestination = useCallback(async (
    eligibilityAttestation: LighterFundingEligibilityAttestationV1,
    ownerAddress?: string,
  ) => {
    if (!accountReadinessReady) return;
    const expectedOwner = ownerAddress || (scopedActivationNeeded?.venue === "lighter" ? scopedActivationNeeded.ownerAddress : "");
    if (!expectedOwner || !perpsTurnkey.authenticated) return;
    if (lighterDepositRetryForbidden) return;
    if (lighterDepositDestination) return;
    if (lighterDepositDestinationRequestRef.current) return lighterDepositDestinationRequestRef.current;
    const request = (async () => {
      setCheckingLighterDepositDestination(true);
      setLighterDepositDestination(null);
      setLighterDepositDestinationError(null);
      setLighterDepositAddressCopied(false);
      try {
        setLighterDepositDestination(await fetchVerifiedLighterDepositDestination({
          ownerAddress: expectedOwner,
          eligibilityAttestation,
          signLighterDepositAuthorization: perpsTurnkey.signLighterDepositAuthorization,
        }));
      } catch (caught) {
        setLighterDepositDestination(null);
        if (isLighterDepositRetryForbidden(caught)) {
          setLighterDepositRetryForbidden(true);
          try {
            window.localStorage.setItem(lighterUdaRetryForbiddenStorageKey(expectedOwner), "1");
          } catch {
            // In-memory lock still prevents another attempt in this session.
          }
          setLighterDepositDestinationError(
            caught instanceof Error && caught.message === "lighter_uda_create_destination_chain_mismatch"
              ? "Lighter returned an unverified destination chain. Ghola sign-in succeeded and is not the issue. Funding is locked; do not retry or send USDC."
              : "Address generation returned an ambiguous result. Generation is locked. A read-only status check can restore only a previously saved direct verification; provider history alone stays locked. Do not send USDC.",
          );
        } else {
          setLighterDepositDestinationError(lighterDepositDestinationFailureMessage(caught));
        }
      } finally {
        setCheckingLighterDepositDestination(false);
        lighterDepositDestinationRequestRef.current = null;
      }
    })();
    lighterDepositDestinationRequestRef.current = request;
    return request;
  }, [accountReadinessReady, lighterDepositDestination, lighterDepositRetryForbidden, perpsTurnkey, scopedActivationNeeded]);

  const reconcileLighterDepositDestination = useCallback(async () => {
    const expectedOwner = scopedActivationNeeded?.venue === "lighter"
      ? scopedActivationNeeded.ownerAddress
      : "";
    if (
      !expectedOwner ||
      !lighterFundingEligibilityAccepted ||
      !lighterDepositRetryForbidden ||
      lighterDepositDestination
    ) return;
    if (lighterDepositDestinationRequestRef.current) return lighterDepositDestinationRequestRef.current;
    const request = (async () => {
      setCheckingLighterDepositDestination(true);
      setLighterDepositDestinationError(null);
      setLighterDepositAddressCopied(false);
      try {
        const reconciled = await reconcileExistingLighterDepositDestination(
          expectedOwner,
          LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
        );
        const verified = validateVerifiedLighterDepositDestination(reconciled, expectedOwner);
        setLighterDepositDestination(verified);
        setLighterDepositRetryForbidden(false);
        try {
          window.localStorage.removeItem(lighterUdaRetryForbiddenStorageKey(expectedOwner));
        } catch {
          // Verified state is sufficient for this session when storage is unavailable.
        }
      } catch (caught) {
        setLighterDepositDestination(null);
        setLighterDepositRetryForbidden(true);
        const code = caught instanceof Error ? caught.message : "";
        setLighterDepositDestinationError(code.includes("Provider history was found")
          ? "Provider history was found, but it does not prove a current safe funding address. Generation remains locked; do not send USDC."
          : "No current safe funding address was proven. Generation remains locked; do not send USDC.");
      } finally {
        setCheckingLighterDepositDestination(false);
        lighterDepositDestinationRequestRef.current = null;
      }
    })();
    lighterDepositDestinationRequestRef.current = request;
    return request;
  }, [
    lighterDepositDestination,
    lighterDepositRetryForbidden,
    lighterFundingEligibilityAccepted,
    scopedActivationNeeded,
  ]);

  useEffect(() => {
    if (scopedActivationNeeded?.venue === "lighter") {
      void refreshLighterReadiness(scopedActivationNeeded.ownerAddress);
    } else {
      setLighterReadiness(null);
      setLighterReadinessError(null);
    }
  }, [scopedActivationNeeded, refreshLighterReadiness]);

  useEffect(() => {
    setLighterDepositDestination(null);
    setLighterDepositDestinationError(null);
    setLighterDepositAddressCopied(false);
    setLighterFundingEligibilityAccepted(false);
    let retryForbidden = false;
    if (scopedActivationNeeded?.venue === "lighter") {
      try {
        retryForbidden = window.localStorage.getItem(
          lighterUdaRetryForbiddenStorageKey(scopedActivationNeeded.ownerAddress),
        ) === "1";
      } catch {
        // Storage may be unavailable; retain only the current in-memory lock.
      }
    }
    setLighterDepositRetryForbidden(retryForbidden);
  }, [scopedActivationNeeded?.ownerAddress, scopedActivationNeeded?.venue]);

  useEffect(() => {
    if (!lighterDepositDestination) return;
    const expiresAt = Date.parse(lighterDepositDestination.checked_at) + LIGHTER_UDA_CLIENT_MAX_AGE_MS;
    const timeout = window.setTimeout(() => {
      setLighterDepositDestination(null);
      setLighterDepositDestinationError("Verified deposit destination expired. Refresh before copying.");
      setLighterDepositAddressCopied(false);
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [lighterDepositDestination]);

  useEffect(() => {
    if (scopedActivationNeeded?.venue !== "lighter") return;
    const ownerAddress = scopedActivationNeeded.ownerAddress;
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") void refreshLighterReadiness(ownerAddress);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [scopedActivationNeeded, refreshLighterReadiness]);

  const copyVerifiedLighterDepositAddress = useCallback(async () => {
    if (!lighterDepositDestination || scopedActivationNeeded?.venue !== "lighter") return;
    try {
      const verified = validateVerifiedLighterDepositDestination(
        lighterDepositDestination,
        scopedActivationNeeded.ownerAddress,
      );
      await navigator.clipboard.writeText(verified.destination.deposit_address);
      setLighterDepositAddressCopied(true);
      setLighterDepositDestinationError(null);
    } catch {
      setLighterDepositDestination(null);
      setLighterDepositDestinationError("Deposit destination could not be reverified. No USDC should be sent.");
      setLighterDepositAddressCopied(false);
    }
  }, [lighterDepositDestination, scopedActivationNeeded]);

  const connectAsterProgrammatic = useCallback(async (refreshExistingSigner = false) => {
    if (!accountReadinessReady) return;
    setWorking(true);
    setError(null);
    setActivationNeeded(null);
    let ownerAddress = "";
    let prepared: AsterProgrammaticPreparation | null = pendingAsterLinkRecovery?.preparation || null;
    let signature: `0x${string}` | null = null;
    let completionAttempted = false;
    const usingTurnkeyOwner = true;
    try {
      const pair = await perpsTurnkey.ensureWalletPair();
      ownerAddress = pair.owner.address;
      const preparedOwner = prepared?.contract.ownerAuthorization.ownerAddress.toLowerCase();
      if (preparedOwner && preparedOwner !== ownerAddress.toLowerCase()) {
        prepared = null;
        setPendingAsterLinkRecovery(null);
        persistRecovery(accountCommitment, recoveryUserScope, { aster: null });
      }
      if (refreshExistingSigner && prepared) {
        const prior = prepared;
        prepared = await prepareAsterProgrammaticCredential({
          owner_address: ownerAddress,
          agent_name: "ghola-perps",
          reuse_preparation: prior,
        });
        if (
          prepared.setup.signer_reused !== true ||
          prepared.refreshed_from_preparation_id !== prior.preparation_id ||
          prepared.contract.attestedSigner.publicAddress.toLowerCase() !==
            prior.contract.attestedSigner.publicAddress.toLowerCase()
        ) throw new Error("Aster signer refresh did not preserve the sealed signer.");
      } else if (!prepared) {
        prepared = await prepareAsterProgrammaticCredential({
          owner_address: ownerAddress,
          agent_name: "ghola-perps",
        });
      }
      const unsignedPending = { preparation: prepared };
      setPendingAsterLinkRecovery(unsignedPending);
      persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending });
      signature = await perpsTurnkey.signAsterAgentApproval(prepared.contract.approval.typedData);
      const pending = { preparation: prepared, signature };
      setPendingAsterLinkRecovery(pending);
      persistRecovery(accountCommitment, recoveryUserScope, { aster: pending });
      completionAttempted = true;
      const completed = asRecord(await completeAsterProgrammaticCredential({ preparation: prepared, signature }));
      if (completed.status !== "ready") throw new Error("Aster authorization did not become ready.");
      setPendingAsterLinkRecovery(null);
      persistRecovery(accountCommitment, recoveryUserScope, { aster: null });
      setAsterReprepareRequired(false);
      setAsterRegistrationAmbiguous(false);
      setAsterWalletRepairRequired(false);
      setAsterWalletRepairCompleted(true);
      setAster("connected");
      await refresh();
    } catch (caught) {
      if (shouldResumeUnsignedTurnkeySetup({
        usingTurnkeyOwner,
        authorizationProofCreated: completionAttempted,
        error: caught,
      })) {
        if (prepared && !signature) {
          const unsignedPending = { preparation: prepared };
          setPendingAsterLinkRecovery(unsignedPending);
          persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending });
        }
        await perpsTurnkey.logout().catch(() => {});
        setPendingAsterAuthorization(true);
        setError("Secure wallet session expired. Continue authentication below; no Aster approval was submitted.");
        return;
      }
      if (prepared && signature && completionAttempted) {
        const disposition = classifyAsterOnboardingFailure(caught, prepared);
        if (disposition.action === "finish_link" && signature) {
          const pending = { preparation: prepared, signature, receipt: disposition.receipt };
          setPendingAsterLinkRecovery(pending);
          persistRecovery(accountCommitment, recoveryUserScope, { aster: pending });
        } else if (disposition.action === "reprepare") {
          setAsterReprepareRequired(true);
          const unsignedPending = { preparation: prepared };
          setPendingAsterLinkRecovery(unsignedPending);
          setActivationNeeded(disposition.reason === "venue_activation"
            ? { venue: "aster", ownerAddress }
            : null);
          persistRecovery(accountCommitment, recoveryUserScope, disposition.reason === "venue_activation"
            ? { aster: unsignedPending, asterActivation: activationRequirement(ownerAddress) }
            : { aster: unsignedPending, asterActivation: null });
        } else if (disposition.action === "hold_ambiguous") {
          setAsterRegistrationAmbiguous(true);
        }
        setError(disposition.message);
      } else {
        if (prepared && !signature) {
          const unsignedPending = { preparation: prepared };
          setPendingAsterLinkRecovery(unsignedPending);
          persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending });
        }
        const message = caught instanceof Error ? caught.message : "Aster authorization failed.";
        if (isTurnkeyResourceMissing(message)) setAsterWalletRepairRequired(true);
        setError(message);
      }
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, accountReadinessReady, pendingAsterLinkRecovery, perpsTurnkey, recoveryUserScope, refresh]);

  const repairAsterWallet = useCallback(async () => {
    if (!accountReadinessReady) return;
    setWorking(true);
    setError(null);
    try {
      await perpsTurnkey.replaceWalletPair();
      const url = new URL(window.location.href);
      url.searchParams.delete("repair");
      window.history.replaceState(null, "", url);
      const staleCommitment = accountCommitment ||
        pendingAsterLinkRecovery?.preparation.account_commitment || null;
      setPendingAsterLinkRecovery(null);
      persistRecovery(staleCommitment, recoveryUserScope, { aster: null });
      setAsterWalletRepairRequired(false);
      setAsterWalletRepairCompleted(true);
      setAsterReprepareRequired(false);
      await connectAsterProgrammatic(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Secure wallet repair failed.");
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, accountReadinessReady, connectAsterProgrammatic, pendingAsterLinkRecovery, perpsTurnkey, recoveryUserScope]);

  const finishAsterLinkRecovery = useCallback(async () => {
    if (!accountReadinessReady || !pendingAsterLinkRecovery?.signature) return;
    setWorking(true);
    setError(null);
    try {
      const completed = asRecord(await completeAsterProgrammaticCredential({
        preparation: pendingAsterLinkRecovery.preparation,
        signature: pendingAsterLinkRecovery.signature,
        ...(pendingAsterLinkRecovery.receipt
          ? { link_recovery_receipt: pendingAsterLinkRecovery.receipt }
          : {}),
      }));
      if (completed.status !== "ready") throw new Error("Aster linking did not become ready.");
      setPendingAsterLinkRecovery(null);
      persistRecovery(accountCommitment, recoveryUserScope, { aster: null });
      setAsterRegistrationAmbiguous(false);
      setAster("connected");
      setActivationNeeded(null);
      persistRecovery(accountCommitment, recoveryUserScope, { asterActivation: null });
      await refresh();
    } catch (caught) {
      const disposition = classifyAsterOnboardingFailure(caught, pendingAsterLinkRecovery.preparation);
      if (disposition.action === "reprepare") {
        setAsterReprepareRequired(true);
        const unsignedPending = { preparation: pendingAsterLinkRecovery.preparation };
        setPendingAsterLinkRecovery(unsignedPending);
        setActivationNeeded(disposition.reason === "venue_activation"
          ? {
              venue: "aster",
              ownerAddress: pendingAsterLinkRecovery.preparation.contract.ownerAuthorization.ownerAddress,
            }
          : null);
        persistRecovery(accountCommitment, recoveryUserScope, disposition.reason === "venue_activation"
          ? {
              aster: unsignedPending,
              asterActivation: activationRequirement(
                pendingAsterLinkRecovery.preparation.contract.ownerAuthorization.ownerAddress,
              ),
            }
          : { aster: unsignedPending, asterActivation: null });
      } else if (disposition.action === "hold_ambiguous") {
        setAsterRegistrationAmbiguous(true);
      }
      setError(disposition.message);
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, accountReadinessReady, pendingAsterLinkRecovery, recoveryUserScope, refresh]);

  useEffect(() => {
    if (!accountReadinessReady || !pendingAsterAuthorization || !perpsTurnkey.authenticated) return;
    const repairRequested = pendingAsterWalletRepair;
    setPendingAsterAuthorization(false);
    setPendingAsterWalletRepair(false);
    if (repairRequested) void repairAsterWallet();
    else void connectAsterProgrammatic(asterReprepareRequired);
  }, [accountReadinessReady, asterReprepareRequired, connectAsterProgrammatic, pendingAsterAuthorization, pendingAsterWalletRepair, perpsTurnkey.authenticated, repairAsterWallet]);

  async function beginAsterProgrammatic() {
    if (!accountReadinessReady) return;
    if (!auth.authenticated) {
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    if (pendingAsterLinkRecovery?.signature) {
      await finishAsterLinkRecovery();
      return;
    }
    if (asterRegistrationAmbiguous) {
      setError("Aster registration needs reconciliation before another signer can be created.");
      return;
    }
    if (!perpsTurnkey.configured) {
      setError("Secure perps wallet setup is unavailable in this preview.");
      return;
    }
    if (!perpsTurnkey.authenticated) {
      setWorking(true);
      setPendingAsterAuthorization(true);
      setPendingAsterWalletRepair(asterWalletRepairRequested);
      setError(null);
      try {
        await perpsTurnkey.login();
      } catch (caught) {
        setPendingAsterAuthorization(false);
        setPendingAsterWalletRepair(false);
        setError(caught instanceof Error ? caught.message : "Secure wallet authentication failed.");
      } finally {
        setWorking(false);
      }
      return;
    }
    if (asterWalletRepairRequested) {
      await repairAsterWallet();
      return;
    }
    const refreshExistingSigner = asterReprepareRequired;
    setAsterReprepareRequired(false);
    await connectAsterProgrammatic(refreshExistingSigner);
  }

  async function connectAsterManual() {
    if (!accountReadinessReady) return;
    if (!auth.authenticated) {
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    const validation = validateAsterExecutionCredentialDraft(draft);
    if (validation.length) {
      setError(validation[0]);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      let sealingAddress = wallet.walletAddress;
      if (!sealingAddress) {
        const email = typeof auth.user?.email === "string" ? auth.user.email : "";
        if (!email) throw new Error("Sign in before connecting Aster.");
        sealingAddress = await wallet.createWallet(email);
      }
      const commitment = accountCommitment || stringValue(asRecord(await getPrivateAgentPassport()).account_commitment);
      if (!commitment) throw new Error("Private account is unavailable.");
      const sealed = await buildAsterExecutionVaultBundle({
        accountCommitment: commitment,
        sealingWalletAddress: sealingAddress,
        credential: draft,
        signBytes: wallet.signBytes,
      });
      await linkPrivateAgentPlatform({ venue_id: "aster", encrypted_execution_vault: sealed.encrypted_execution_vault });
      setDraft({ user_address: "", api_wallet_private_key: "" });
      setShowAsterManual(false);
      setAster("connected");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Aster connection failed.");
    } finally {
      setWorking(false);
    }
  }

  const reconcileLighterAssociation = useCallback(async (
    pending: PendingLighterAssociation,
    attempts = 8,
  ) => {
    if (!pending.authorization) throw new Error("Lighter association proof is unavailable.");
    const authorization = pending.authorization;
    let last: Record<string, unknown> = {};
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = asRecord(await completeLighterProgrammaticCredential({
        preparation: pending.preparation,
        authorization,
        reconcile_only: true,
      }));
      if (last.status === "ready") return last;
      if (!["submitted", "ambiguous", "confirmed_pending_index"].includes(stringValue(last.status) || "")) {
        throw new Error("Lighter returned an invalid association state.");
      }
      if (attempt + 1 < attempts) await delay(900);
    }
    return last;
  }, []);

  const connectLighterProgrammatic = useCallback(async () => {
    if (!accountReadinessReady) return;
    setWorking(true);
    setError(null);
    setActivationNeeded(null);
    let pending: PendingLighterAssociation | null = pendingLighterAssociation;
    let preparation: LighterProgrammaticPreparation | null = pending?.preparation || null;
    const usingTurnkeyOwner = true;
    try {
      if (pending?.submission_ambiguous) {
        setError("Lighter wallet submission is ambiguous. Ghola will not submit it again; reconcile the wallet activity first.");
        return;
      }
      const ownerAddress = (await perpsTurnkey.ensureWalletPair()).owner.address;
      if (preparation && preparation.transaction_plan.from.toLowerCase() !== ownerAddress.toLowerCase()) {
        preparation = null;
        pending = null;
        setPendingLighterAssociation(null);
        persistRecovery(accountCommitment, recoveryUserScope, {
          lighter: null,
          lighterActivation: null,
        });
      }
      if (!preparation) {
        preparation = await prepareLighterProgrammaticCredential({ owner_address: ownerAddress });
        pending = { preparation };
        setPendingLighterAssociation(pending);
        persistRecovery(accountCommitment, recoveryUserScope, { lighter: pending });
      }
      const authorization = await perpsTurnkey.signLighterKeyAssociation(preparation.transaction_plan);
      pending = { preparation, authorization };
      setPendingLighterAssociation(pending);
      persistRecovery(accountCommitment, recoveryUserScope, { lighter: pending });
      const completed = asRecord(await completeLighterProgrammaticCredential({ preparation, authorization }));
      const ready = completed.status === "ready"
        ? completed
        : await reconcileLighterAssociation(pending);
      if (ready.status !== "ready") {
        setError("Lighter association is still confirming. Resume verification; Ghola will not submit it again.");
        return;
      }
      setPendingLighterAssociation(null);
      persistRecovery(accountCommitment, recoveryUserScope, { lighter: null });
      setLighter("connected");
      await refresh();
    } catch (caught) {
      if (shouldResumeUnsignedTurnkeySetup({
        usingTurnkeyOwner,
        authorizationProofCreated: Boolean(pending?.authorization),
        error: caught,
      })) {
        await perpsTurnkey.logout().catch(() => {});
        setPendingLighterAuthorization(true);
        setError("Secure wallet session expired. Continue authentication below; no Lighter key was submitted.");
        return;
      }
      if (pending?.authorization) {
        setError("Lighter association needs reconciliation. Ghola will not create or submit another key.");
      } else {
        const failure = venueSetupFailure(caught, "Lighter authorization failed.");
        if (failure.code === "lighter_owner_account_not_found") {
          setActivationNeeded({ venue: "lighter", ownerAddress: failure.ownerAddress });
          persistRecovery(accountCommitment, recoveryUserScope, {
            lighterActivation: activationRequirement(failure.ownerAddress),
          });
        }
        setError(failure.message);
      }
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, accountReadinessReady, pendingLighterAssociation, perpsTurnkey, reconcileLighterAssociation, recoveryUserScope, refresh]);

  const finishLighterAssociation = useCallback(async () => {
    if (!accountReadinessReady || !pendingLighterAssociation?.authorization) return;
    setWorking(true);
    setError(null);
    try {
      const completed = await reconcileLighterAssociation(pendingLighterAssociation);
      if (completed.status !== "ready") {
        setError("Lighter association is still confirming. No transaction was resubmitted.");
        return;
      }
      setPendingLighterAssociation(null);
      persistRecovery(accountCommitment, recoveryUserScope, { lighter: null });
      setLighter("connected");
      setActivationNeeded(null);
      persistRecovery(accountCommitment, recoveryUserScope, { lighterActivation: null });
      await refresh();
    } catch {
      setError("Lighter association still needs reconciliation. No transaction was resubmitted.");
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, accountReadinessReady, pendingLighterAssociation, reconcileLighterAssociation, recoveryUserScope, refresh]);

  useEffect(() => {
    if (!accountReadinessReady || !pendingLighterAuthorization || !perpsTurnkey.authenticated) return;
    setPendingLighterAuthorization(false);
    void connectLighterProgrammatic();
  }, [accountReadinessReady, connectLighterProgrammatic, pendingLighterAuthorization, perpsTurnkey.authenticated]);

  async function beginLighterProgrammatic() {
    if (!accountReadinessReady) return;
    if (!auth.authenticated) {
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    if (pendingLighterAssociation?.submission_ambiguous) {
      setError("Lighter wallet submission is ambiguous. Ghola will not submit it again; reconcile the wallet activity first.");
      return;
    }
    if (pendingLighterAssociation?.authorization) {
      await finishLighterAssociation();
      return;
    }
    if (!perpsTurnkey.configured) {
      setError("Secure perps wallet setup is unavailable in this preview.");
      return;
    }
    if (!perpsTurnkey.authenticated) {
      setWorking(true);
      setPendingLighterAuthorization(true);
      setError(null);
      try {
        await perpsTurnkey.login();
      } catch (caught) {
        setPendingLighterAuthorization(false);
        setError(caught instanceof Error ? caught.message : "Secure wallet authentication failed.");
      } finally {
        setWorking(false);
      }
      return;
    }
    await connectLighterProgrammatic();
  }

  async function connectLighterManual() {
    if (!accountReadinessReady) return;
    if (!auth.authenticated) {
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    const validation = validateLighterExecutionCredentialDraft(lighterDraft);
    if (validation.length) {
      setError(validation[0]);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      let sealingAddress = wallet.walletAddress;
      if (!sealingAddress) {
        const email = typeof auth.user?.email === "string" ? auth.user.email : "";
        if (!email) throw new Error("Sign in before connecting Lighter.");
        sealingAddress = await wallet.createWallet(email);
      }
      const commitment = accountCommitment || stringValue(asRecord(await getPrivateAgentPassport()).account_commitment);
      if (!commitment) throw new Error("Private account is unavailable.");
      const sealed = await buildLighterExecutionVaultBundle({
        accountCommitment: commitment,
        sealingWalletAddress: sealingAddress,
        credential: lighterDraft,
        signBytes: wallet.signBytes,
      });
      await linkPrivateAgentPlatform({ venue_id: "lighter", encrypted_execution_vault: sealed.encrypted_execution_vault });
      setLighterDraft({ account_index: "", api_key_index: "", api_private_key: "" });
      setShowLighterManual(false);
      setLighter("connected");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Lighter connection failed.");
    } finally {
      setWorking(false);
    }
  }

  async function enableGholaTouchId() {
    if (!accountReadinessReady) return;
    setWorking(true);
    setError(null);
    try {
      await perpsTurnkey.addPasskey();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Touch ID enrollment failed.");
    } finally {
      setWorking(false);
    }
  }

  async function retryAfterVenueActivation() {
    if (!accountReadinessReady) return;
    const requirement = activationNeeded;
    if (!requirement) return;
    if (requirement.venue === "aster") {
      if (!perpsTurnkey.authenticated) {
        setWorking(true);
        setError(null);
        try {
          await perpsTurnkey.login();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Secure wallet authentication failed.");
        } finally {
          setWorking(false);
        }
        return;
      }
      const lockKey = asterActivationSubmissionStorageKey(recoveryUserScope, requirement.ownerAddress);
      let persistedAttempt = "";
      try {
        persistedAttempt = window.localStorage.getItem(lockKey) || "";
      } catch {
        // The in-memory lock remains authoritative for this page.
      }
      if (asterActivationInFlightRef.current) return;
      asterActivationInFlightRef.current = true;
      setWorking(true);
      setError(null);
      try {
        const pair = await perpsTurnkey.ensureWalletPair();
        if (pair.owner.address.toLowerCase() !== requirement.ownerAddress.toLowerCase()) {
          throw new Error("Aster activation is not bound to the current Ghola perps owner.");
        }
        const preparation = await prepareAsterOwnerActivation({ owner_address: requirement.ownerAddress });
        if (
          persistedAttempt &&
          persistedAttempt !== preparation.activation_id
        ) {
          asterActivationSubmissionRef.current = null;
        }
        const signature = await perpsTurnkey.signAsterOwnerActivation(preparation.challenge);
        asterActivationSubmissionRef.current = preparation.activation_id;
        try {
          window.localStorage.setItem(lockKey, preparation.activation_id);
        } catch {
          // The in-memory lock still prevents a same-page retry.
        }
        try {
          const completed = asRecord(await completeAsterOwnerActivation({ preparation, signature }));
          if (completed.status !== "owner_login_accepted") throw new Error("Aster owner login receipt was invalid.");
        } catch (caught) {
          if (asterActivationAllowsFreshPreparation(caught)) {
            asterActivationSubmissionRef.current = null;
            try { window.localStorage.removeItem(lockKey); } catch {}
          }
          throw caught;
        }
        asterActivationSubmissionRef.current = null;
        try { window.localStorage.removeItem(lockKey); } catch {}
        setActivationNeeded(null);
        setAsterReprepareRequired(true);
        persistRecovery(accountCommitment, recoveryUserScope, { asterActivation: null });
      } catch (caught) {
        if (asterActivationOwnerLoginAlreadyAccepted(caught)) {
          asterActivationSubmissionRef.current = null;
          try { window.localStorage.removeItem(lockKey); } catch {}
          setActivationNeeded(null);
          setAsterReprepareRequired(true);
          persistRecovery(accountCommitment, recoveryUserScope, { asterActivation: null });
          setError(null);
        } else {
          setError(caught instanceof Error ? caught.message : "Aster owner activation failed.");
        }
      } finally {
        asterActivationInFlightRef.current = false;
        setWorking(false);
      }
      return;
    }
    setActivationNeeded(null);
    persistRecovery(accountCommitment, recoveryUserScope, { lighterActivation: null });
    await connectLighterProgrammatic();
  }

  const connectionProgress = carryAccountConnectionProgressForVenues({
    accountCommitment,
    venues: {
      hyperliquid: hyperliquid === "connected",
      aster: aster === "connected",
      lighter: lighter === "connected",
    },
  }, requiredVenueIds);
  const nextSetupAction = carryAccountSetupNextAction(
    connectionProgress,
    scopedActivationNeeded ? [scopedActivationNeeded.venue] : [],
  );
  const routeVerificationAuthenticationRequired = nextSetupAction.kind === "verify_routes"
    && !perpsTurnkey.authenticated;
  const venueStates: Readonly<Record<CarryExecutionVenue, VenueState>> = {
    hyperliquid,
    aster,
    lighter,
  };
  const routeVerificationEnabled = workerPlatform?.status === "ready";
  const nextSetupDisabled = nextSetupAction.kind === "connect_venue" && (
    !accountReadinessReady ||
    working ||
    (nextSetupAction.venueId === "aster" && (
      (perpsTurnkey.loading || !perpsTurnkey.configured) ||
      asterRegistrationAmbiguous ||
      scopedActivationNeeded?.venue === "aster"
    )) ||
    (nextSetupAction.venueId === "lighter" && (
      (perpsTurnkey.loading || !perpsTurnkey.configured) ||
      scopedActivationNeeded?.venue === "lighter" ||
      pendingLighterAssociation?.submission_ambiguous === true
    ))
  );
  const nextSetupLabel = nextSetupAction.kind === "verify_routes" ? "Verify routes"
    : nextSetupAction.venueId === "hyperliquid" ? "Continue"
    : nextSetupAction.venueId === "aster"
      ? pendingAsterAuthorization
        ? working ? "Authenticating…" : "Continue secure authentication"
        : !perpsTurnkey.configured ? "Secure wallet unavailable"
        : perpsTurnkey.loading ? "Restoring secure wallet…"
        : working ? "Authorizing…"
        : asterWalletRepairRequested ? "Repair secure wallet"
        : asterRegistrationAmbiguous ? "Aster reconciliation required"
        : scopedActivationNeeded?.venue === "aster" ? "Check Aster activation"
        : asterReprepareRequired ? "Refresh same Aster signer"
        : pendingAsterLinkRecovery
          ? pendingAsterLinkRecovery.signature
            ? pendingAsterLinkRecovery.receipt ? "Finish Aster linking" : "Resume Aster verification"
            : "Resume Aster signing"
        : "Continue"
      : pendingLighterAuthorization
        ? working ? "Authenticating…" : "Continue secure authentication"
        : !perpsTurnkey.configured ? "Secure wallet unavailable"
        : perpsTurnkey.loading ? "Restoring secure wallet…"
        : pendingLighterAssociation?.submission_ambiguous ? "Reconciliation required"
        : scopedActivationNeeded?.venue === "lighter" ? "Check Lighter activation"
        : working ? "Authorizing…"
        : pendingLighterAssociation ? "Resume Lighter setup"
        : "Continue";
  function continueGuidedSetup() {
    if (!accountReadinessReady || nextSetupAction.kind !== "connect_venue") return;
    if (nextSetupAction.venueId === "hyperliquid") setShowHyperliquidSetup(true);
    else if (nextSetupAction.venueId === "aster") void beginAsterProgrammatic();
    else if (nextSetupAction.venueId === "lighter") void beginLighterProgrammatic();
  }
  async function authenticateForRouteVerification() {
    if (
      !accountReadinessReady ||
      nextSetupAction.kind !== "verify_routes" ||
      perpsTurnkey.authenticated ||
      perpsTurnkey.loading ||
      !perpsTurnkey.configured
    ) return;
    setWorking(true);
    setError(null);
    try {
      await perpsTurnkey.login();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Secure wallet authentication failed.");
    } finally {
      setWorking(false);
    }
  }
  return (
    <main className="min-h-screen bg-[#06080c] px-4 pb-20 pt-24 text-[#eef1f8] sm:px-6">
      <AuthModal mode={authMode} open={authOpen} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} redirectTo={setupReturnTo} />
      <section className="mx-auto max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#5aa7ff]">Carry setup</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Connect once. Trade as one position.</h1>
        <p className="mt-3 text-sm leading-6 text-[#8f9aae]">Live route intelligence works without a deposit. Connect execution access, pass one no-submit check, then fund only the venues you choose to activate.</p>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-[#172234] py-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#718097]">
          <span className="text-[#72dfb2]">Markets · explore now</span>
          <span>Access · {accountReadinessReady
            ? pairScoped ? `${connectionProgress.connectedCount}/${connectionProgress.requiredCount}` : "choose pair"
            : accountReadinessState === "failed" ? "check failed" : "checking"}</span>
          <span>Proof · {accountReadinessReady
            ? !pairScoped ? "choose pair" : connectionProgress.ready ? "next" : "after access"
            : "blocked"}</span>
          <span className={workerPlatform?.status === "ready" ? "text-[#72dfb2]" : workerPlatform ? "text-[#ee9da8]" : ""}>
            Platform · {workerPlatform?.status === "ready" ? "ready" : workerPlatform ? "repair" : "checking"}
          </span>
          <span>Capital · later</span>
          <Link href={safeReturnTo} className="ml-auto text-[#8fcaff] hover:text-[#c4e5ff]">Explore live routes</Link>
        </div>

        {!auth.authenticated && !auth.loading && (
          <button type="button" onClick={() => setAuthOpen(true)} className="mt-8 h-12 w-full rounded-lg bg-[#4aaef8] font-semibold text-[#06111d]">
            Sign in to continue
          </button>
        )}

        {auth.authenticated && !accountReadinessReady && (
          <div
            data-carry-account-readiness={accountReadinessState}
            className="mt-8 rounded-xl border border-[#60303a] bg-[#251116] p-4 sm:flex sm:items-center sm:justify-between sm:gap-5"
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#ee9da8]">Account readiness</p>
              <p className="mt-1 text-sm font-semibold text-[#ffd7dc]">
                {accountReadinessState === "loading" ? "Checking existing connections" : "Connection state is unknown"}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#d59aa2]">Wallet creation and venue authorization stay locked until Ghola confirms your existing account state.</p>
            </div>
            <button
              type="button"
              disabled={accountReadinessState === "loading"}
              onClick={() => void refresh()}
              className="mt-4 h-10 shrink-0 rounded-md border border-[#75434c] px-4 text-sm font-semibold text-[#ffc1c8] hover:bg-[#351820] disabled:opacity-50 sm:mt-0"
            >
              {accountReadinessState === "loading" ? "Checking…" : "Retry account check"}
            </button>
          </div>
        )}

        {auth.authenticated && accountReadinessReady && !pairScoped && (
          <section data-carry-pair-choice className="mt-8 rounded-xl border border-[#315277] bg-[#0b1624] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8fcaff]">First readiness proof</p>
            <h2 className="mt-2 text-xl font-semibold text-[#eef1f8]">Start with two venues—not the whole fleet.</h2>
            <p className="mt-2 text-sm leading-6 text-[#8f9aae]">Connect Hyperliquid and Aster, then run one exact no-submit check. The check moves no funds and sends no order; venue account activation may still be required. Lighter stays optional until a selected route needs it.</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Link href={firstProofSetupHref} className="inline-flex h-10 items-center rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d]">
                Start no-submit proof
              </Link>
              <Link href={safeReturnTo} className="text-sm font-semibold text-[#8fcaff] hover:text-white">
                Choose a live route instead
              </Link>
            </div>
          </section>
        )}

        {auth.authenticated && accountReadinessReady && pairScoped && (
          <div className="mt-8 space-y-3">
            <div className="rounded-xl border border-[#315277] bg-[#0b1624] p-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#718097]">Execution access</p>
                <p className="mt-1 text-sm font-semibold text-[#d8eaff]">{nextSetupAction.kind === "verify_routes"
                  ? routeVerificationAuthenticationRequired ? "Authenticate secure wallet" : "Connections complete"
                  : `Next: ${venueLabel(nextSetupAction.venueId)}`}</p>
                <p className="mt-1 text-xs leading-5 text-[#8f9aae]">{nextSetupAction.kind === "verify_routes"
                  ? routeVerificationAuthenticationRequired
                    ? "Your venue connections are complete. Reauthenticate the owner wallet before the no-submit check."
                    : routeVerificationEnabled
                    ? pairScoped ? "Run one no-submit check across this pair." : "Run one no-submit check across every venue and pair."
                    : workerPlatform?.message || "Checking the platform before route verification."
                  : `${connectionProgress.missingVenueIds.length} connection${connectionProgress.missingVenueIds.length === 1 ? "" : "s"} remain. Ghola resumes the next safe step.`}</p>
              </div>
              <div className="mt-4 flex shrink-0 items-center gap-3 sm:mt-0">
                <p className={`font-mono text-sm font-semibold ${connectionProgress.ready ? "text-[#72dfb2]" : "text-[#d9bd74]"}`}>
                  {connectionProgress.connectedCount}/{connectionProgress.requiredCount}
                </p>
                {nextSetupAction.kind === "verify_routes" && routeVerificationAuthenticationRequired ? (
                  <button
                    type="button"
                    disabled={working || perpsTurnkey.loading || !perpsTurnkey.configured}
                    onClick={() => void authenticateForRouteVerification()}
                    className="inline-flex h-10 items-center rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d] disabled:opacity-50"
                  >
                    {!perpsTurnkey.configured
                      ? "Secure wallet unavailable"
                      : perpsTurnkey.loading
                        ? "Restoring secure wallet…"
                        : working ? "Authenticating…" : "Authenticate secure wallet"}
                  </button>
                ) : nextSetupAction.kind === "verify_routes" && routeVerificationEnabled ? (
                  <Link href={noSubmitReturnTo} className="inline-flex h-10 items-center rounded-md bg-[#56d6a0] px-4 text-sm font-semibold text-[#06130e]">
                    {nextSetupLabel}
                  </Link>
                ) : nextSetupAction.kind === "verify_routes" ? (
                  <button
                    type="button"
                    disabled
                    data-worker-platform-status={workerPlatform?.status || "checking"}
                    className="inline-flex h-10 items-center rounded-md bg-[#25344b] px-4 text-sm font-semibold text-[#8f9aae] opacity-70"
                  >
                    {workerPlatform ? "Platform check required" : "Checking platform…"}
                  </button>
                ) : nextSetupAction.venueId === "hyperliquid" ? (
                  <button
                    type="button"
                    aria-expanded={showHyperliquidSetup}
                    aria-controls="carry-hyperliquid-setup"
                    onClick={continueGuidedSetup}
                    className="inline-flex h-10 items-center rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d]"
                  >
                    Continue
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={nextSetupDisabled}
                    onClick={continueGuidedSetup}
                    className="h-10 rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d] disabled:opacity-50"
                  >
                    {nextSetupLabel}
                  </button>
                )}
              </div>
            </div>
            {showHyperliquidSetup && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "hyperliquid" ? (
              <section id="carry-hyperliquid-setup" aria-label="Connect Hyperliquid" className="rounded-xl border border-[#315277] bg-[#0b111b] p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8fcaff]">Hyperliquid access</p>
                    <p className="mt-1 text-xs leading-5 text-[#8f9aae]">Complete this connection here. Your selected Carry pair and return path stay intact.</p>
                  </div>
                  <button type="button" aria-label="Close Hyperliquid setup" onClick={() => setShowHyperliquidSetup(false)} className="rounded-md p-1.5 text-[#718097] hover:bg-[#132238] hover:text-white">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <TurnkeyPerpsManager
                  network={hyperliquidNetwork}
                  market={hyperliquidMarket}
                  referencePrice={null}
                  onReady={() => {
                    setHyperliquid("connected");
                    setShowHyperliquidSetup(false);
                    void refresh();
                  }}
                />
              </section>
            ) : null}
            {workerPlatform && workerPlatform.status !== "ready" && (
              <div data-worker-platform-status={workerPlatform.status} className="flex items-center justify-between gap-4 rounded-lg border border-[#60303a] bg-[#251116] px-4 py-3 text-xs text-[#ee9da8]">
                <span>{workerPlatform.message}</span>
                <button type="button" disabled={working} onClick={() => void refresh()} className="shrink-0 font-semibold text-[#ffc1c8] hover:text-white disabled:opacity-50">
                  Recheck
                </button>
              </div>
            )}
            <ExecutionAccessRail
              venueIds={requiredVenueIds}
              states={venueStates}
              longVenueId={pairScoped ? returnPair?.longVenueId || null : null}
              shortVenueId={pairScoped ? returnPair?.shortVenueId || null : null}
            />
            {perpsTurnkey.authenticated && !perpsTurnkey.hasPasskey && (
              <details className="rounded-lg border border-[#1f2c41] bg-[#080d14] px-4 py-3 text-xs text-[#718097]">
                <summary className="cursor-pointer select-none font-semibold text-[#8f9aae] hover:text-[#c4e5ff]">
                  Optional: faster future sign-in
                </summary>
                <div className="mt-3 flex items-center justify-between gap-4 border-t border-[#172234] pt-3">
                  <p className="leading-5">Enable Touch ID for this Ghola address. Turnkey Dashboard passkeys cannot cross domains.</p>
                  <button type="button" disabled={working} onClick={() => void enableGholaTouchId()} className="shrink-0 rounded-md border border-[#315277] px-3 py-2 font-semibold text-[#a8d8ff] hover:bg-[#102033] disabled:opacity-50">
                    {working ? "Enabling…" : "Enable Touch ID"}
                  </button>
                </div>
              </details>
            )}
            {aster !== "connected" && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "aster" && (
              <div className="px-1">
                <p className="mb-2 text-xs leading-5 text-[#718097]">One owner approval enables 30 days of perpetual trading. Withdrawals stay disabled.</p>
                <button type="button" onClick={() => setShowAsterManual((value) => !value)} className="text-xs font-semibold text-[#718097] hover:text-[#8fcaff]">
                  {showAsterManual ? "Hide existing-wallet option" : "Use an existing Aster wallet instead"}
                </button>
                {showAsterManual && (
                  <div className="mt-3 rounded-xl border border-[#25344b] bg-[#0b111b] p-5">
                    <p className="text-xs leading-5 text-[#8f9aae]">Only enter a separate Aster trading wallet—never the collateral owner&apos;s private key.</p>
                    <label className="mt-3 block text-xs text-[#8f9aae]">Collateral account
                      <input value={draft.user_address} onChange={(event) => setDraft((value) => ({ ...value, user_address: event.target.value }))} placeholder="0x account address" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                    </label>
                    <label className="mt-3 block text-xs text-[#8f9aae]">Existing trade-only private key
                      <input type="password" value={draft.api_wallet_private_key} onChange={(event) => setDraft((value) => ({ ...value, api_wallet_private_key: event.target.value }))} placeholder="0x…" autoComplete="off" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                    </label>
                    <button type="button" disabled={working} onClick={() => void connectAsterManual()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                      {working ? "Verifying…" : "Verify existing wallet"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {lighter !== "connected" && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "lighter" && (
              <div className="px-1">
                <p className="mb-2 text-xs leading-5 text-[#718097]">One owner approval. The key is created inside the worker; Ethereum and Lighter must both confirm it before use.</p>
                <button type="button" onClick={() => setShowLighterManual((value) => !value)} className="text-xs font-semibold text-[#718097] hover:text-[#8fcaff]">
                  {showLighterManual ? "Hide existing-key option" : "Use an existing Lighter key instead"}
                </button>
              </div>
            )}
            {showLighterManual && lighter !== "connected" && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "lighter" && (
              <div className="rounded-xl border border-[#25344b] bg-[#0b111b] p-5">
                <p className="text-sm font-semibold">Use an existing Lighter key</p>
                <p className="mt-1 text-xs leading-5 text-[#718097]">Lighter keys are not venue-native trade-only. Ghola blocks transfers and withdrawals inside its attested worker.</p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="block text-xs text-[#8f9aae]">Account index
                    <input value={lighterDraft.account_index} onChange={(event) => setLighterDraft((value) => ({ ...value, account_index: event.target.value }))} inputMode="numeric" placeholder="123" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                  </label>
                  <label className="block text-xs text-[#8f9aae]">API key index
                    <input value={lighterDraft.api_key_index} onChange={(event) => setLighterDraft((value) => ({ ...value, api_key_index: event.target.value }))} inputMode="numeric" placeholder="4" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                  </label>
                </div>
                <label className="mt-3 block text-xs text-[#8f9aae]">API private key
                  <input type="password" value={lighterDraft.api_private_key} onChange={(event) => setLighterDraft((value) => ({ ...value, api_private_key: event.target.value }))} placeholder="64 hex characters" autoComplete="off" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                </label>
                <button type="button" disabled={working} onClick={() => void connectLighterManual()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                  {working ? "Sealing…" : "Seal and connect"}
                </button>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-4 rounded-lg border border-[#60303a] bg-[#251116] px-4 py-3 text-sm text-[#ee9da8]">{error}</p>}
        {accountReadinessReady && scopedActivationNeeded && (
          <div className="mt-4 rounded-lg border border-[#315277] bg-[#0b1624] p-4 text-sm">
            <p className="font-semibold text-[#d8eaff]">Activate this connected owner wallet on {scopedActivationNeeded.venue === "aster" ? "Aster" : "Lighter"}</p>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718097]">
              {scopedActivationNeeded.venue === "lighter" ? "Account identity · not a deposit address" : "Exact owner identity"}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <p className="min-w-0 break-all font-mono text-xs text-[#8fcaff]">{scopedActivationNeeded.ownerAddress}</p>
              {scopedActivationNeeded.venue === "aster" && (
                <button type="button" aria-label="Copy owner address" onClick={() => void navigator.clipboard.writeText(scopedActivationNeeded.ownerAddress)} className="shrink-0 rounded-md p-1.5 text-[#718097] hover:bg-[#132238] hover:text-[#a8d8ff]">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {scopedActivationNeeded.venue === "lighter" ? (
              <LighterReadinessPanel
                readiness={lighterReadiness}
                error={lighterReadinessError}
                checking={checkingLighterReadiness || checkingLighterDepositDestination}
                depositDestination={lighterDepositDestination}
                depositDestinationError={lighterDepositDestinationError}
                depositAddressCopied={lighterDepositAddressCopied}
                fundingEligibilityAccepted={lighterFundingEligibilityAccepted}
                onFundingEligibilityAcceptedChange={setLighterFundingEligibilityAccepted}
                onCopyDepositAddress={() => void copyVerifiedLighterDepositAddress()}
                onGenerateDepositAddress={(attestation) => void refreshLighterDepositDestination(attestation)}
                onReconcileDepositAddress={() => void reconcileLighterDepositDestination()}
                canGenerateDepositAddress={perpsTurnkey.authenticated && !lighterDepositRetryForbidden}
                canReconcileDepositAddress={perpsTurnkey.authenticated && lighterDepositRetryForbidden}
                depositRetryForbidden={lighterDepositRetryForbidden}
                onRefresh={() => void refreshLighterReadiness()}
              />
            ) : (
              <p className="mt-2 text-xs leading-5 text-[#8f9aae]">Aster must recognize this exact owner first. Ghola will preserve the same sealed signer, then request one fresh owner approval—never create another signer or retry an ambiguous submission.</p>
            )}
            {scopedActivationNeeded.venue === "lighter" && (
              <a href={LIGHTER_NEW_ACCOUNT_DEPOSIT_SOURCE} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-md border border-[#315277] px-3 py-2 text-xs font-semibold text-[#a8d8ff]">
                View official Lighter requirements
              </a>
            )}
            <button type="button" disabled={working || (scopedActivationNeeded.venue === "lighter" && !lighterReadiness?.ready)} onClick={() => void retryAfterVenueActivation()} className={`${scopedActivationNeeded.venue === "lighter" ? "ml-2" : ""} mt-3 inline-flex rounded-md bg-[#4aaef8] px-3 py-2 text-xs font-semibold text-[#06111d] disabled:opacity-50`}>
              {scopedActivationNeeded.venue === "aster"
                ? perpsTurnkey.authenticated ? "Activate Aster owner securely" : "Authenticate secure wallet"
                : "I activated it — recheck once"}
            </button>
            <Link href={safeReturnTo} className="ml-3 mt-3 inline-flex text-xs font-semibold text-[#8fcaff] hover:text-white">
              Continue modeling without funds
            </Link>
          </div>
        )}
        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-[#657188]"><LockKeyhole className="h-4 w-4" /> Secrets are sealed to the attested worker.</div>
      </section>
    </main>
  );
}

function venueLabel(venueId: string) {
  return executionVenueLabel(venueId);
}

function LighterReadinessPanel({
  readiness,
  error,
  checking,
  depositDestination,
  depositDestinationError,
  depositAddressCopied,
  fundingEligibilityAccepted,
  onFundingEligibilityAcceptedChange,
  onCopyDepositAddress,
  onGenerateDepositAddress,
  onReconcileDepositAddress,
  canGenerateDepositAddress,
  canReconcileDepositAddress,
  depositRetryForbidden,
  onRefresh,
}: {
  readiness: LighterActivationReadiness | null;
  error: string | null;
  checking: boolean;
  depositDestination: VerifiedLighterDepositDestination | null;
  depositDestinationError: string | null;
  depositAddressCopied: boolean;
  fundingEligibilityAccepted: boolean;
  onFundingEligibilityAcceptedChange: (accepted: boolean) => void;
  onCopyDepositAddress: () => void;
  onGenerateDepositAddress: (attestation: LighterFundingEligibilityAttestationV1) => void;
  onReconcileDepositAddress: () => void;
  canGenerateDepositAddress: boolean;
  canReconcileDepositAddress: boolean;
  depositRetryForbidden: boolean;
  onRefresh: () => void;
}) {
  const baseStagingBalanceReady = readiness
    ? BigInt(readiness.base_usdc_microunits) >= LIGHTER_NEW_ACCOUNT_MINIMUM_USDC_MICROUNITS
    : false;
  const baseGasReady = readiness
    ? !readiness.blockers.includes("lighter_base_gas_required")
    : false;
  return (
    <div className="mt-3 rounded-lg border border-[#263851] bg-[#080e17] p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#8fcaff]">Activation readiness</p>
        <button type="button" disabled={checking} onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8f9aae] hover:bg-[#132238] hover:text-[#d8eaff] disabled:opacity-50">
          {checking ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>
      {readiness ? (
        <>
          <p className="mt-2 text-xs leading-5 text-[#d8eaff]">
            {depositDestination
              ? "A fresh owner-bound Lighter deposit destination is verified. Use only USDC on Base and only the address shown below."
              : describeLighterActivationNextStep(readiness)}
          </p>
          {!depositDestination && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[#315277] bg-[#0b1624] p-3">
              <input
                id="lighter-funding-eligibility-consent"
                type="checkbox"
                checked={fundingEligibilityAccepted}
                onChange={(event) => onFundingEligibilityAcceptedChange(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#4aaef8]"
              />
              <label htmlFor="lighter-funding-eligibility-consent" className="text-[11px] leading-4 text-[#b8c8da]">
                I accept the <a href="https://lighter.xyz/terms" target="_blank" rel="noreferrer" className="font-semibold text-[#8fcaff] underline hover:text-white">Lighter Terms</a> and attest that neither I nor any entity I represent is a prohibited person.
              </label>
            </div>
          )}
          <LighterDepositDestinationPanel
            destination={depositDestination}
            error={depositDestinationError}
            checking={checking}
            copied={depositAddressCopied}
            onCopy={onCopyDepositAddress}
            onGenerate={() => {
              if (!fundingEligibilityAccepted) return;
              onGenerateDepositAddress(LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION);
            }}
            onReconcile={onReconcileDepositAddress}
            canGenerate={canGenerateDepositAddress && fundingEligibilityAccepted}
            canReconcile={canReconcileDepositAddress && fundingEligibilityAccepted}
            retryForbidden={depositRetryForbidden}
          />
          <div className="mt-2 divide-y divide-[#1b283b]">
            {!readiness.lighter_owner_account_ready && !depositDestination && <>
              <ReadinessRow label="Owner wallet staging balance" value={`${formatDecimalUnits(readiness.base_usdc_microunits, 6, 2)} USDC · not deposited`} ready={baseStagingBalanceReady} />
              <ReadinessRow label="Base network fee" value={baseGasReady ? "Funded" : `${formatDecimalUnits(readiness.estimated_base_gas_wei, 18, 6)} ETH required`} ready={baseGasReady} />
            </>}
            <ReadinessRow label="Lighter owner account" value={readiness.lighter_owner_account_ready ? `Verified · #${readiness.lighter_account_index}` : "Activation required"} ready={readiness.lighter_owner_account_ready} />
            <ReadinessRow label="Ethereum association fee" value={readiness.ethereum_association_gas_ready ? "Funded" : `${formatDecimalUnits(readiness.estimated_ethereum_association_gas_wei, 18, 6)} ETH required`} ready={readiness.ethereum_association_gas_ready} />
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-[#8f9aae]">{checking ? "Checking both networks…" : error || "Readiness has not been checked."}</p>
      )}
      <p className="mt-2 text-[11px] leading-4 text-[#657188]">Read-only balances, gas estimates, and owner-bound Lighter account lookup. No payment, transfer, key, or order is submitted by this check.</p>
    </div>
  );
}

function LighterDepositDestinationPanel({
  destination,
  error,
  checking,
  copied,
  onCopy,
  onGenerate,
  onReconcile,
  canGenerate,
  canReconcile,
  retryForbidden,
}: {
  destination: VerifiedLighterDepositDestination | null;
  error: string | null;
  checking: boolean;
  copied: boolean;
  onCopy: () => void;
  onGenerate: () => void;
  onReconcile: () => void;
  canGenerate: boolean;
  canReconcile: boolean;
  retryForbidden: boolean;
}) {
  if (!destination) {
    return (
      <div data-lighter-deposit-verified="false" className="mt-3 rounded-md border border-[#60303a] bg-[#251116] p-3">
        <p className="text-xs font-semibold text-[#ee9da8]">Funding locked</p>
        <p className="mt-1 text-[11px] leading-4 text-[#d58c96]">
          {checking ? "Verifying an owner-bound Lighter deposit destination…" : error || "No verified deposit destination is available. Do not send USDC."}
        </p>
        {retryForbidden ? (
          <>
            <button type="button" disabled={checking || !canReconcile} onClick={onReconcile} className="mt-2 rounded-md border border-[#315277] px-3 py-2 text-xs font-semibold text-[#a8d8ff] hover:bg-[#102033] disabled:opacity-60">
              {checking ? "Checking provider status…" : "Check provider status"}
            </button>
            <p className="mt-2 text-[10px] leading-4 text-[#9d6970]">Read-only. A previously saved direct verification can be restored; provider history alone never unlocks funding.</p>
          </>
        ) : (
          <button type="button" disabled={checking || !canGenerate} onClick={onGenerate} className="mt-2 rounded-md border border-[#315277] px-3 py-2 text-xs font-semibold text-[#a8d8ff] hover:bg-[#102033] disabled:border-[#60303a] disabled:text-[#9d6970] disabled:opacity-60">
            {checking ? "Verifying…" : "Generate verified deposit address"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div data-lighter-deposit-verified="true" className="mt-3 rounded-md border border-[#285d4e] bg-[#0b1b18] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#72dfb2]">Verified Lighter deposit address</p>
          <p className="mt-1 break-all font-mono text-xs text-[#d8eaff]">{destination.destination.deposit_address}</p>
        </div>
        <button type="button" aria-label="Copy verified Lighter deposit address" onClick={onCopy} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#285d4e] px-2.5 py-2 text-xs font-semibold text-[#9be8c9] hover:bg-[#123027]">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-[#8db4a5]">Base · USDC only · Lighter minimum 5 USDC · 5.5 USDC recommended. This address is bound to the exact Turnkey owner above. Never send to the owner address.</p>
      <LighterDepositReconciliationPanel destination={destination} />
    </div>
  );
}

function LighterDepositReconciliationPanel({
  destination,
}: {
  destination: VerifiedLighterDepositDestination;
}) {
  const perpsTurnkey = usePerpsTurnkey();
  const [transactionHash, setTransactionHash] = useState("");
  const [expectedUsdc, setExpectedUsdc] = useState(LIGHTER_DEPOSIT_DEFAULT_USDC);
  const [reconciliation, setReconciliation] = useState<LighterDepositReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retryForbidden, setRetryForbidden] = useState(false);
  const [recoveryReadiness, setRecoveryReadiness] = useState<VerifiedLighterOwnerRecoveryReadiness | null>(null);
  const [recoveryReadinessError, setRecoveryReadinessError] = useState<string | null>(null);
  const [verifyingRecoveryReadiness, setVerifyingRecoveryReadiness] = useState(false);
  const expectedAmountMicrounits = lighterUsdcToMicrounits(expectedUsdc);
  const validTransactionHash = /^0x[0-9a-f]{64}$/i.test(transactionHash.trim());
  const status = reconciliation?.status || "unseen";
  const expectationLocked = status === "PROCESSING" || status === "COMPLETED";

  const checkDeposit = async () => {
    if (checking || retryForbidden || !expectedAmountMicrounits || !validTransactionHash) return;
    setChecking(true);
    setError(null);
    try {
      setReconciliation(await checkLighterDepositReconciliation({
        ownerAddress: destination.owner_address,
        depositAddress: destination.destination.deposit_address,
        transactionHash: expectationLocked && reconciliation ? reconciliation.transaction_hash : transactionHash,
        expectedAmountMicrounits: expectationLocked && reconciliation
          ? reconciliation.expected_amount_microunits
          : expectedAmountMicrounits,
      }));
    } catch (caught) {
      const known = caught instanceof LighterDepositReconciliationError;
      setError(known
        ? caught.message
        : "The check outcome is uncertain. Do not submit it again; reconcile this exact transaction manually.");
      if (!known || caught.retryForbidden) setRetryForbidden(true);
    } finally {
      setChecking(false);
    }
  };

  const verifyOwnerRecovery = async () => {
    if (
      reconciliation?.status !== "COMPLETED" ||
      !reconciliation.reconciliation_complete ||
      verifyingRecoveryReadiness ||
      recoveryReadiness
    ) return;
    setVerifyingRecoveryReadiness(true);
    setRecoveryReadinessError(null);
    try {
      setRecoveryReadiness(await verifyLighterOwnerRecoveryReadiness({
        ownerAddress: destination.owner_address,
        signLighterRecoveryReadiness: perpsTurnkey.signLighterRecoveryReadiness,
      }));
    } catch (caught) {
      setRecoveryReadiness(null);
      setRecoveryReadinessError(lighterOwnerRecoveryReadinessFailureMessage(caught));
    } finally {
      setVerifyingRecoveryReadiness(false);
    }
  };

  return (
    <div data-lighter-deposit-reconciliation className="mt-3 rounded-md border border-[#315277] bg-[#07111e] p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-[#d8eaff]">Post-send deposit tracker</p>
        <span
          data-lighter-deposit-status={status}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            status === "COMPLETED"
              ? "border-[#285d4e] text-[#72dfb2]"
              : status === "PROCESSING"
                ? "border-[#725e2c] text-[#f0c96b]"
                : "border-[#3c4d64] text-[#9aabc0]"
          }`}
        >
          {status}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-[#8f9aae]">After sending USDC yourself, submit its exact Base transaction hash once. This read-only tracker never sends funds, signs transactions, retries an uncertain check, or polls automatically.</p>
      <label className="mt-3 block text-[11px] font-medium text-[#b8c8da]">
        Exact Base transaction hash
        <input
          aria-label="Exact Base transaction hash"
          type="text"
          value={expectationLocked && reconciliation ? reconciliation.transaction_hash : transactionHash}
          onChange={(event) => setTransactionHash(event.target.value)}
          disabled={expectationLocked || retryForbidden}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className="mt-1.5 h-10 w-full rounded-md border border-[#263851] bg-[#050a11] px-3 font-mono text-xs text-[#d8eaff] outline-none focus:border-[#4a78a9] disabled:opacity-70"
        />
      </label>
      <label className="mt-3 block text-[11px] font-medium text-[#b8c8da]">
        Expected USDC amount
        <input
          aria-label="Expected USDC amount"
          type="text"
          inputMode="decimal"
          value={expectationLocked && reconciliation
            ? formatExactUsdc(reconciliation.expected_amount_microunits)
            : expectedUsdc}
          onChange={(event) => setExpectedUsdc(event.target.value)}
          disabled={expectationLocked || retryForbidden}
          className="mt-1.5 h-10 w-full rounded-md border border-[#263851] bg-[#050a11] px-3 font-mono text-xs text-[#d8eaff] outline-none focus:border-[#4a78a9] disabled:opacity-70"
        />
        <span className="mt-1 block text-[10px] font-normal text-[#657188]">Default 5.5 USDC · minimum 5 USDC</span>
      </label>
      <button
        type="button"
        disabled={checking || retryForbidden || status === "COMPLETED" || !expectedAmountMicrounits || !validTransactionHash}
        onClick={() => void checkDeposit()}
        className="mt-3 rounded-md border border-[#315277] px-3 py-2 text-xs font-semibold text-[#a8d8ff] hover:bg-[#102033] disabled:opacity-50"
      >
        {checking
          ? "Checking exact deposit…"
          : retryForbidden
            ? "Check locked"
            : status === "COMPLETED"
              ? "Deposit completed"
              : reconciliation
                ? "Check exact deposit again"
                : "Check exact deposit"}
      </button>
      {reconciliation && (
        <p className="mt-2 break-all text-[10px] leading-4 text-[#8f9aae]">
          Bound to {reconciliation.transaction_hash} · {formatExactUsdc(reconciliation.expected_amount_microunits)} USDC
        </p>
      )}
      {error && <p className="mt-2 text-[11px] leading-4 text-[#ee9da8]">{error}</p>}
      {reconciliation?.status === "COMPLETED" && reconciliation.reconciliation_complete && (
        <div data-lighter-owner-recovery-readiness className="mt-3 rounded-md border border-[#285d4e] bg-[#0b1b18] p-3">
          <p className="text-xs font-semibold text-[#9be8c9]">Owner recovery capability</p>
          <p className="mt-1 text-[11px] leading-4 text-[#8db4a5]">Capability only: no Lighter balance or withdrawal execution is proven. No transaction is signed or broadcast, and no funds are moved.</p>
          <button
            type="button"
            disabled={verifyingRecoveryReadiness || Boolean(recoveryReadiness) || !perpsTurnkey.authenticated}
            onClick={() => void verifyOwnerRecovery()}
            className="mt-3 rounded-md border border-[#285d4e] px-3 py-2 text-xs font-semibold text-[#9be8c9] hover:bg-[#123027] disabled:opacity-50"
          >
            {verifyingRecoveryReadiness
              ? "Verifying owner recovery…"
              : recoveryReadiness
                ? "Owner recovery verified"
                : "Verify owner recovery"}
          </button>
          {recoveryReadiness && (
            <p className="mt-2 text-[11px] leading-4 text-[#72dfb2]">Post-account owner recovery capability verified. No balance or withdrawal execution was proven; no transaction was signed or broadcast; no funds were moved.</p>
          )}
          {recoveryReadinessError && <p className="mt-2 text-[11px] leading-4 text-[#ee9da8]">{recoveryReadinessError}</p>}
        </div>
      )}
    </div>
  );
}

function ReadinessRow({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-xs">
      <span className="text-[#8f9aae]">{label}</span>
      <span className={`inline-flex items-center gap-1.5 text-right font-medium ${ready ? "text-[#72dfb2]" : "text-[#ee9da8]"}`}>
        {ready ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        {value}
      </span>
    </div>
  );
}

function formatDecimalUnits(value: string, decimals: number, precision: number) {
  const amount = BigInt(value);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, "0").slice(0, precision);
  return `${whole}.${fraction.padEnd(precision, "0")}`;
}

function formatExactUsdc(microunits: string) {
  const padded = microunits.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function ExecutionAccessRail({
  venueIds,
  states,
  longVenueId,
  shortVenueId,
}: {
  venueIds: readonly CarryExecutionVenue[];
  states: Readonly<Record<CarryExecutionVenue, VenueState>>;
  longVenueId: CarryExecutionVenue | null;
  shortVenueId: CarryExecutionVenue | null;
}) {
  const pairScoped = longVenueId !== null && shortVenueId !== null;
  return (
    <div
      aria-label={pairScoped ? "Selected Carry execution pair" : "Carry execution fleet"}
      className="rounded-lg border border-[#1f2c41] bg-[#080d14] p-3"
    >
      <div className="flex items-center justify-between gap-3 px-1 pb-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#718097]">
          {pairScoped ? "Selected pair" : "Execution fleet"}
        </p>
        {pairScoped ? (
          <p className="font-mono text-[10px] text-[#8f9aae]">
            L {venueLabel(longVenueId)} <span className="text-[#3f4b5c]">/</span> S {venueLabel(shortVenueId)}
          </p>
        ) : null}
      </div>
      <div className={`grid gap-2 ${venueIds.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {venueIds.map((venueId) => {
          const state = states[venueId];
          const role = venueId === longVenueId ? "LONG" : venueId === shortVenueId ? "SHORT" : null;
          return (
            <div
              key={venueId}
              data-carry-venue={venueId}
              data-carry-role={role?.toLowerCase() || "fleet"}
              className="flex min-w-0 items-center gap-2.5 rounded-md border border-[#1b283b] bg-[#0a0f17] px-3 py-2.5"
            >
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded ${state === "connected" ? "bg-[#0d2a21] text-[#72dfb2]" : "bg-[#101b2a] text-[#8fcaff]"}`}>
                {state === "connected" ? <Check className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {role ? <span className="mr-1.5 font-mono text-[9px] text-[#657188]">{role}</span> : null}
                  {venueLabel(venueId)}
                </p>
                <p className="truncate text-[11px] text-[#718097]">
                  {state === "connected"
                    ? "Connected"
                    : state === "needed"
                      ? ONBOARDING_BY_VENUE[venueId].ux.badge
                      : "Unavailable"}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function venueSetupFailure(error: unknown, fallback: string) {
  const failure = error && typeof error === "object" ? error as { body?: unknown; message?: unknown } : {};
  const body = asRecord(failure.body);
  return {
    code: stringValue(body.error) || "",
    message: stringValue(body.message) || (typeof failure.message === "string" ? failure.message : fallback),
    ownerAddress: stringValue(body.owner_address) || "",
  };
}

function activationRequirement(ownerAddress: string): VenueAccountActivationRequirement {
  return {
    owner_address: ownerAddress as `0x${string}`,
    reason: "venue_account_not_found",
  };
}

function isTurnkeyResourceMissing(message: string): boolean {
  return message.includes("Could not find any resource to sign with") &&
    message.includes("Addresses are case sensitive");
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function persistRecovery(
  accountCommitment: string | null,
  userScope: string | null,
  update: {
    aster?: PendingAsterOnboarding | null;
    lighter?: PendingLighterOnboarding | null;
    asterActivation?: VenueAccountActivationRequirement | null;
    lighterActivation?: VenueAccountActivationRequirement | null;
  },
) {
  const updateCommitment = update.aster?.preparation.account_commitment ||
    update.lighter?.preparation.account_commitment || null;
  const recoveryCommitment = accountCommitment || updateCommitment;
  if (!recoveryCommitment || !userScope) return;
  try {
    updateCarryOnboardingRecoveryForUser(
      window.localStorage,
      userScope,
      recoveryCommitment,
      update,
    );
  } catch {
    // Storage is a convenience layer; the worker remains the submission authority.
  }
}

function asterActivationSubmissionStorageKey(userScope: string, ownerAddress: string) {
  return `${ASTER_ACTIVATION_SUBMISSION_STORAGE_PREFIX}${userScope}:${ownerAddress.toLowerCase()}`;
}

function asterActivationAllowsFreshPreparation(caught: unknown) {
  if (!caught || typeof caught !== "object") return false;
  const body = (caught as { body?: unknown }).body;
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    (body as Record<string, unknown>).new_preparation_allowed === true);
}

function asterActivationOwnerLoginAlreadyAccepted(caught: unknown) {
  if (!caught || typeof caught !== "object") return false;
  const body = (caught as { body?: unknown }).body;
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    (body as Record<string, unknown>).status === "accepted");
}
