"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Fingerprint, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, X } from "lucide-react";
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
  completeAsterProgrammaticCredential,
  completeLighterProgrammaticCredential,
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
  type LighterActivationReadiness,
} from "@/lib/lighter-activation-readiness";
import { shouldResumeUnsignedTurnkeySetup } from "@/lib/carry-setup-auth-recovery";
import { hyperliquidMarketFromTradeReturn } from "@/lib/hyperliquid-trade-return";

type VenueState = "connected" | "needed" | "unavailable";
type VenueActivation = { venue: "aster" | "lighter"; ownerAddress: string };
type PendingAsterLinkRecovery = PendingAsterOnboarding;
type PendingLighterAssociation = PendingLighterOnboarding;

const HYPERLIQUID_ONBOARDING = getCurrentVenueCredentialOnboardingPath("hyperliquid");
const ASTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("aster");
const LIGHTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("lighter");
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
  const [touchIdEnrollment, setTouchIdEnrollment] = useState<"idle" | "adding" | "success" | "error">("idle");
  const [touchIdError, setTouchIdError] = useState<string | null>(null);
  const [copiedOwnerAddress, setCopiedOwnerAddress] = useState<string | null>(null);
  const [ownerAddressCopyError, setOwnerAddressCopyError] = useState<string | null>(null);
  const [showHyperliquidSetup, setShowHyperliquidSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationNeeded, setActivationNeeded] = useState<VenueActivation | null>(null);
  const [lighterReadiness, setLighterReadiness] = useState<LighterActivationReadiness | null>(null);
  const [lighterReadinessError, setLighterReadinessError] = useState<string | null>(null);
  const [checkingLighterReadiness, setCheckingLighterReadiness] = useState(false);
  const lighterReadinessRequestRef = useRef<Promise<void> | null>(null);
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
  const recoveryUserScope = opaqueTurnkeyWalletScope(auth.user?.id || "");
  const asterWalletRepairRequested = asterWalletRepairRequired ||
    (!asterWalletRepairCompleted && searchParams.get("repair") === "aster-wallet");
  const setupReturnTo = `/account?${new URLSearchParams({
    setup: "carry",
    ...(pairScoped ? { long_venue: requestedLongVenue, short_venue: requestedShortVenue } : {}),
    return_to: safeReturnTo,
  }).toString()}`;

  const refresh = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const [passportRaw, hyperliquidRaw, runtimeRaw] = await Promise.all([
        getPrivateAgentPassport(),
        getHyperliquidExecutionVaultStatus().catch(() => null),
        fetchPrivateAgentRuntimeStatus().catch(() => null),
      ]);
      const connections = carryAccountConnections({ passport: passportRaw, hyperliquidStatus: hyperliquidRaw });
      setWorkerPlatform(carryWorkerPlatformGate(runtimeRaw));
      setAccountCommitment(connections.accountCommitment);
      setAster(connections.venues.aster ? "connected" : "needed");
      setLighter(connections.venues.lighter ? "connected" : "needed");
      setHyperliquid(connections.venues.hyperliquid ? "connected" : "needed");
      setError(null);
    } catch {
      setError("Account readiness could not be refreshed.");
    }
  }, [auth.authenticated]);

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

  useEffect(() => {
    if (scopedActivationNeeded?.venue === "lighter") {
      void refreshLighterReadiness(scopedActivationNeeded.ownerAddress);
    } else {
      setLighterReadiness(null);
      setLighterReadinessError(null);
    }
  }, [scopedActivationNeeded, refreshLighterReadiness]);

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

  const connectAsterProgrammatic = useCallback(async (refreshExistingSigner = false) => {
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
  }, [accountCommitment, pendingAsterLinkRecovery, perpsTurnkey, recoveryUserScope, refresh]);

  const repairAsterWallet = useCallback(async () => {
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
  }, [accountCommitment, connectAsterProgrammatic, pendingAsterLinkRecovery, perpsTurnkey, recoveryUserScope]);

  const finishAsterLinkRecovery = useCallback(async () => {
    if (!pendingAsterLinkRecovery?.signature) return;
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
  }, [accountCommitment, pendingAsterLinkRecovery, recoveryUserScope, refresh]);

  useEffect(() => {
    if (!pendingAsterAuthorization || !perpsTurnkey.authenticated) return;
    const repairRequested = pendingAsterWalletRepair;
    setPendingAsterAuthorization(false);
    setPendingAsterWalletRepair(false);
    if (repairRequested) void repairAsterWallet();
    else void connectAsterProgrammatic(asterReprepareRequired);
  }, [asterReprepareRequired, connectAsterProgrammatic, pendingAsterAuthorization, pendingAsterWalletRepair, perpsTurnkey.authenticated, repairAsterWallet]);

  async function beginAsterProgrammatic() {
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
          setError(null);
        } else {
          setError(failure.message);
        }
      }
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, pendingLighterAssociation, perpsTurnkey, reconcileLighterAssociation, recoveryUserScope, refresh]);

  const finishLighterAssociation = useCallback(async () => {
    if (!pendingLighterAssociation?.authorization) return;
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
  }, [accountCommitment, pendingLighterAssociation, reconcileLighterAssociation, recoveryUserScope, refresh]);

  useEffect(() => {
    if (!pendingLighterAuthorization || !perpsTurnkey.authenticated) return;
    setPendingLighterAuthorization(false);
    void connectLighterProgrammatic();
  }, [connectLighterProgrammatic, pendingLighterAuthorization, perpsTurnkey.authenticated]);

  async function beginLighterProgrammatic() {
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
    if (working || showHyperliquidSetup || touchIdEnrollment === "adding") return;
    setTouchIdEnrollment("adding");
    setTouchIdError(null);
    try {
      await perpsTurnkey.addPasskey();
      setTouchIdEnrollment("success");
    } catch (caught) {
      const failure = caught && typeof caught === "object"
        ? caught as { name?: unknown; code?: unknown }
        : {};
      const failureName = typeof failure.name === "string" ? failure.name : "unknown";
      const failureCode = typeof failure.code === "string" ? failure.code : "unknown";
      const cancelled = touchIdEnrollmentWasCancelled(caught);
      console.warn("[carry] Touch ID enrollment did not complete", {
        error_name: failureName,
        error_code: failureCode,
      });
      setTouchIdEnrollment("error");
      setTouchIdError(cancelled
        ? "Touch ID wasn’t added. Try again when you’re ready."
        : "Touch ID couldn’t be added. Check this device’s Touch ID and passkey settings, then retry.");
    }
  }

  async function copyActivationOwnerAddress() {
    if (!scopedActivationNeeded) return;
    try {
      await navigator.clipboard.writeText(scopedActivationNeeded.ownerAddress);
      setCopiedOwnerAddress(scopedActivationNeeded.ownerAddress);
      setOwnerAddressCopyError(null);
    } catch {
      setOwnerAddressCopyError("The wallet address could not be copied. Select it and copy it manually.");
    }
  }

  async function retryAfterVenueActivation() {
    if (touchIdEnrollment === "adding") return;
    const requirement = activationNeeded;
    if (!requirement) return;
    setActivationNeeded(null);
    persistRecovery(accountCommitment, recoveryUserScope, requirement.venue === "aster"
      ? { asterActivation: null }
      : { lighterActivation: null });
    if (requirement.venue === "aster") await connectAsterProgrammatic(true);
    else await connectLighterProgrammatic();
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
  const activeActivationNeeded = scopedActivationNeeded && nextSetupAction.kind === "connect_venue" &&
    nextSetupAction.venueId === scopedActivationNeeded.venue
    ? scopedActivationNeeded
    : null;
  const venueStates: Readonly<Record<CarryExecutionVenue, VenueState>> = {
    hyperliquid,
    aster,
    lighter,
  };
  const routeVerificationEnabled = workerPlatform?.status === "ready";
  const touchIdBusy = touchIdEnrollment === "adding";
  const nextSetupDisabled = nextSetupAction.kind === "connect_venue" && (
    working || touchIdBusy ||
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
        ? working ? "Opening secure sign-in…" : "Authenticate by email"
        : !perpsTurnkey.configured ? "Secure wallet unavailable"
        : perpsTurnkey.loading ? "Restoring secure wallet…"
        : !perpsTurnkey.authenticated ? "Authenticate by email"
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
        ? working ? "Opening secure sign-in…" : "Authenticate by email"
        : !perpsTurnkey.configured ? "Secure wallet unavailable"
        : perpsTurnkey.loading ? "Restoring secure wallet…"
        : !perpsTurnkey.authenticated ? "Authenticate by email"
        : pendingLighterAssociation?.submission_ambiguous ? "Reconciliation required"
        : scopedActivationNeeded?.venue === "lighter" ? "Check Lighter activation"
        : working ? "Authorizing…"
        : pendingLighterAssociation ? "Resume Lighter setup"
        : "Create & associate key";
  function continueGuidedSetup() {
    if (nextSetupAction.kind !== "connect_venue" || touchIdBusy) return;
    if (nextSetupAction.venueId === "hyperliquid") setShowHyperliquidSetup(true);
    else if (nextSetupAction.venueId === "aster") void beginAsterProgrammatic();
    else if (nextSetupAction.venueId === "lighter") void beginLighterProgrammatic();
  }
  const activeVenueName = nextSetupAction.kind === "connect_venue"
    ? venueLabel(nextSetupAction.venueId)
    : null;
  return (
    <main className="min-h-screen bg-[#07090d] px-4 pb-16 pt-20 text-[#eef1f8] sm:px-6 sm:pt-24">
      <AuthModal mode={authMode} open={authOpen} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} redirectTo={setupReturnTo} />
      <section className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-4 border-b border-[#1d2634] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#62aef5]">Carry / setup</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-[34px]">Finish your Carry setup</h1>
            <p className="mt-2 text-sm text-[#8d98aa]">
              {auth.authenticated
                ? `${connectionProgress.connectedCount} of ${connectionProgress.requiredCount} venues connected.`
                : "Sign in, connect your venues, then verify the route."}
            </p>
          </div>
          <Link href={safeReturnTo} className="text-sm font-semibold text-[#8fcaff] hover:text-[#c4e5ff]">Explore routes →</Link>
        </header>

        <SetupProgress connectionsReady={connectionProgress.ready} />

        {!auth.authenticated && !auth.loading && (
          <button type="button" onClick={() => setAuthOpen(true)} className="mt-6 h-12 w-full rounded-lg bg-[#4aaef8] font-semibold text-[#06111d] sm:w-auto sm:px-8">
            Sign in to continue
          </button>
        )}

        {auth.authenticated && (
          <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.85fr)] lg:items-start">
            <div className="space-y-3">
              <section className={`rounded-xl border p-5 sm:p-6 ${activeActivationNeeded ? "border-[#5c4928] bg-[#141107]" : "border-[#26364b] bg-[#0e1219]"}`}>
                {activeActivationNeeded ? (
                  <>
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[#e0b15c]">
                      {venueLabel(activeActivationNeeded.venue)} · action required
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">Activate this wallet</h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-[#a7a08f]">
                      You’re signed in. This wallet needs a {venueLabel(activeActivationNeeded.venue)} account before Ghola can connect it.
                    </p>
                    <div className="mt-5 flex items-center gap-2 rounded-lg border border-[#3b3424] bg-[#0b0c0e] px-3 py-2.5">
                      <p className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-[#d8c79f]">{activeActivationNeeded.ownerAddress}</p>
                      <button type="button" aria-label={copiedOwnerAddress === activeActivationNeeded.ownerAddress ? "Owner address copied" : "Copy owner address"} onClick={() => void copyActivationOwnerAddress()} className="inline-flex shrink-0 items-center gap-1.5 rounded-md p-1.5 text-xs font-semibold text-[#8f866f] hover:bg-[#242016] hover:text-[#f2dfb4]">
                        {copiedOwnerAddress === activeActivationNeeded.ownerAddress ? <Check className="h-3.5 w-3.5 text-[#72dfb2]" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedOwnerAddress === activeActivationNeeded.ownerAddress ? "Copied" : null}
                      </button>
                    </div>
                    {ownerAddressCopyError ? <p role="alert" className="mt-2 text-xs leading-5 text-[#e6b86a]">{ownerAddressCopyError}</p> : null}
                    {activeActivationNeeded.venue === "lighter" ? (
                      <LighterReadinessPanel
                        readiness={lighterReadiness}
                        error={lighterReadinessError}
                        checking={checkingLighterReadiness}
                      />
                    ) : (
                      <p className="mt-4 text-xs leading-5 text-[#a7a08f]">Activate this exact wallet on Aster, then return here for one owner approval.</p>
                    )}
                    <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <a href={activeActivationNeeded.venue === "aster" ? "https://www.asterdex.com/en" : "https://app.lighter.xyz/"} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d]">
                        Open {venueLabel(activeActivationNeeded.venue)} ↗
                      </a>
                      {activeActivationNeeded.venue === "lighter" ? (
                        <>
                          <button type="button" disabled={checkingLighterReadiness} onClick={() => void refreshLighterReadiness()} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#4a493f] px-4 text-sm font-semibold text-[#ddd4bf] hover:border-[#77705e] disabled:opacity-50">
                            {checkingLighterReadiness ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            Check status
                          </button>
                          {lighterReadiness?.ready && (
                            <button type="button" disabled={working || touchIdBusy} onClick={() => void retryAfterVenueActivation()} className="inline-flex h-10 items-center justify-center rounded-md bg-[#56d6a0] px-4 text-sm font-semibold text-[#06130e] disabled:opacity-50">
                              Finish connection
                            </button>
                          )}
                        </>
                      ) : (
                        <button type="button" disabled={working || touchIdBusy} onClick={() => void retryAfterVenueActivation()} className="inline-flex h-10 items-center justify-center rounded-md border border-[#4a493f] px-4 text-sm font-semibold text-[#ddd4bf] hover:border-[#77705e] disabled:opacity-50">
                          I activated it
                        </button>
                      )}
                    </div>
                    <p className="mt-4 text-xs leading-5 text-[#7e7869]">{activeActivationNeeded.venue === "lighter"
                      ? "No Lighter key or transaction was created. You can keep exploring routes without funding anything."
                      : "No order was submitted and no funds moved. You can keep exploring routes."}</p>
                  </>
                ) : (
                  <>
                    <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8fcaff]">Current step</p>
                    <div className="mt-2 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="text-2xl font-semibold tracking-[-0.025em]">{nextSetupAction.kind === "verify_routes"
                          ? "Verify your route"
                          : `Connect ${activeVenueName}`}</h2>
                        <p className="mt-2 max-w-xl text-sm leading-6 text-[#8f9aae]">{nextSetupAction.kind === "verify_routes"
                          ? routeVerificationEnabled
                            ? pairScoped ? "Run one no-submit check across this pair." : "Run one no-submit check across every venue and pair."
                            : workerPlatform?.message || "Checking the platform before route verification."
                          : `${connectionProgress.missingVenueIds.length} connection${connectionProgress.missingVenueIds.length === 1 ? "" : "s"} left. Ghola will resume the next safe step.`}</p>
                        {nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "lighter" && perpsTurnkey.authenticated && !pendingLighterAssociation && (
                          <p className="mt-3 max-w-xl rounded-md border border-[#433922] bg-[#171307] px-3 py-2 text-xs leading-5 text-[#d2b77d]">
                            Ghola will create the Lighter key inside the attested worker. Your approval then broadcasts its Ethereum association and spends network gas. It does not place an order or deposit funds.
                          </p>
                        )}
                        {nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId !== "hyperliquid" && !perpsTurnkey.authenticated && (
                          <p className="mt-2 text-xs leading-5 text-[#a8d8ff]">Enter your email in the secure window. Use Ghola Touch ID only if you already added it here.</p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {nextSetupAction.kind === "verify_routes" && routeVerificationEnabled && !touchIdBusy ? (
                          <Link href={noSubmitReturnTo} className="inline-flex h-10 w-full items-center justify-center rounded-md bg-[#56d6a0] px-4 text-sm font-semibold text-[#06130e] sm:w-auto">
                            {nextSetupLabel}
                          </Link>
                        ) : nextSetupAction.kind === "verify_routes" ? (
                          <button type="button" disabled data-worker-platform-status={workerPlatform?.status || "checking"} className="inline-flex h-10 w-full items-center justify-center rounded-md bg-[#25344b] px-4 text-sm font-semibold text-[#8f9aae] opacity-70 sm:w-auto">
                            {touchIdBusy ? "Finish Touch ID first" : workerPlatform ? "Platform check required" : "Checking platform…"}
                          </button>
                        ) : nextSetupAction.venueId === "hyperliquid" ? (
                          <button type="button" disabled={working || touchIdBusy} aria-expanded={showHyperliquidSetup} aria-controls="carry-hyperliquid-setup" onClick={continueGuidedSetup} className="inline-flex h-10 w-full items-center justify-center rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d] disabled:opacity-50 sm:w-auto">
                            Continue
                          </button>
                        ) : (
                          <button type="button" disabled={nextSetupDisabled} onClick={continueGuidedSetup} className="h-10 w-full rounded-md bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d] disabled:opacity-50 sm:w-auto">
                            {nextSetupLabel}
                          </button>
                        )}
                      </div>
                    </div>
                    {showHyperliquidSetup && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "hyperliquid" ? (
                      <div id="carry-hyperliquid-setup" aria-label="Connect Hyperliquid" className="mt-5 border-t border-[#25344b] pt-5">
                        <div className="flex items-start justify-between gap-4">
                          <p className="text-xs leading-5 text-[#8f9aae]">Complete this connection here. Your selected pair and return path stay intact.</p>
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
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              {scopedActivationNeeded && !activeActivationNeeded && (
                <section className="flex flex-col gap-3 rounded-lg border border-[#4b3f25] bg-[#121006] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[#dcc48e]">{venueLabel(scopedActivationNeeded.venue)} activation is waiting</p>
                    <p className="mt-1 text-xs leading-5 text-[#8f876f]">Finish the current venue first, or activate this wallet now and Ghola will remember it.</p>
                  </div>
                  <a href={scopedActivationNeeded.venue === "aster" ? "https://www.asterdex.com/en" : "https://app.lighter.xyz/"} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-[#665630] px-3 text-xs font-semibold text-[#e3c987]">
                    Open {venueLabel(scopedActivationNeeded.venue)} ↗
                  </a>
                </section>
              )}

              {workerPlatform && workerPlatform.status !== "ready" && (
                <div data-worker-platform-status={workerPlatform.status} className="flex items-center justify-between gap-4 rounded-lg border border-[#60303a] bg-[#251116] px-4 py-3 text-xs text-[#ee9da8]">
                  <span>{workerPlatform.message}</span>
                  <button type="button" disabled={working} onClick={() => void refresh()} className="shrink-0 font-semibold text-[#ffc1c8] hover:text-white disabled:opacity-50">Recheck</button>
                </div>
              )}

              {error && !activeActivationNeeded && <p role="alert" className="rounded-lg border border-[#60303a] bg-[#251116] px-4 py-3 text-sm text-[#ee9da8]">{error}</p>}

              {aster !== "connected" && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "aster" && (
              <div className="px-1">
                <p className="mb-2 text-xs leading-5 text-[#718097]">Advanced · one owner approval enables 30 days of perpetual trading. Withdrawals stay disabled.</p>
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
                    <button type="button" disabled={working || touchIdBusy} onClick={() => void connectAsterManual()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                      {working ? "Verifying…" : "Verify existing wallet"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {lighter !== "connected" && nextSetupAction.kind === "connect_venue" && nextSetupAction.venueId === "lighter" && (
              <div className="px-1">
                <p className="mb-2 text-xs leading-5 text-[#718097]">Advanced · use an existing Lighter key only if you already have one.</p>
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
                <button type="button" disabled={working || touchIdBusy} onClick={() => void connectLighterManual()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                  {working ? "Sealing…" : "Seal and connect"}
                </button>
              </div>
            )}
            </div>

            <aside className="space-y-3">
              <ExecutionAccessRail
                venueIds={requiredVenueIds}
                states={venueStates}
                longVenueId={pairScoped ? returnPair?.longVenueId || null : null}
                shortVenueId={pairScoped ? returnPair?.shortVenueId || null : null}
              />
              {perpsTurnkey.authenticated && (
                <AccountSecurityPanel
                  accountHasPasskey={perpsTurnkey.hasPasskey}
                  enrollment={touchIdEnrollment}
                  error={touchIdError}
                  blocked={working || showHyperliquidSetup}
                  onAdd={() => void enableGholaTouchId()}
                />
              )}
            </aside>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-[#657188]">
          <span>No deposit required</span><span aria-hidden="true">·</span>
          <span>No order submitted</span><span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5"><LockKeyhole className="h-3.5 w-3.5" /> Secrets sealed</span>
        </div>
      </section>
    </main>
  );
}

function SetupProgress({ connectionsReady }: { connectionsReady: boolean }) {
  const steps = [
    { index: 1, label: "Connect venues", state: connectionsReady ? "complete" : "active" },
    { index: 2, label: "Verify route", state: connectionsReady ? "active" : "pending" },
    { index: 3, label: "Ready", state: "pending" },
  ] as const;
  return (
    <ol aria-label="Carry setup progress" className="mt-5 grid grid-cols-3 overflow-hidden rounded-lg border border-[#1d2634] bg-[#0c0f14]">
      {steps.map((step) => (
        <li key={step.index} data-state={step.state} className="flex min-w-0 items-center gap-2 border-r border-[#1d2634] px-3 py-2.5 last:border-r-0 sm:px-4">
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold ${step.state === "complete"
            ? "bg-[#12362b] text-[#72dfb2]"
            : step.state === "active" ? "bg-[#16314e] text-[#8fcaff]" : "bg-[#171b23] text-[#626d7e]"}`}>
            {step.state === "complete" ? <Check className="h-3 w-3" /> : step.index}
          </span>
          <span className={`truncate text-[11px] font-semibold sm:text-xs ${step.state === "pending" ? "text-[#626d7e]" : "text-[#cbd5e3]"}`}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function AccountSecurityPanel({
  accountHasPasskey,
  enrollment,
  error,
  blocked,
  onAdd,
}: {
  accountHasPasskey: boolean;
  enrollment: "idle" | "adding" | "success" | "error";
  error: string | null;
  blocked: boolean;
  onAdd: () => void;
}) {
  const addedHere = enrollment === "success";
  const ready = addedHere || accountHasPasskey;
  const status = addedHere
    ? "Added on this device"
    : accountHasPasskey ? "Enabled for account" : "Not added";
  return (
    <section aria-label="Account security" className="rounded-xl border border-[#202b3a] bg-[#0d1117] p-4">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[#718097]">Account security</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-[#aab5c5]">Signed in</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#72dfb2]"><Check className="h-3.5 w-3.5" /> Ready</span>
      </div>
      <div className="mt-3 border-t border-[#1d2634] pt-3">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md ${ready ? "bg-[#12362b] text-[#72dfb2]" : "bg-[#151e2a] text-[#8fcaff]"}`}>
            <Fingerprint className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[#d8e1ed]">Touch ID</p>
              <p role="status" aria-live="polite" className={`text-[11px] font-semibold ${ready ? "text-[#72dfb2]" : "text-[#8f9aae]"}`}>
                {enrollment === "adding" ? "Waiting for Touch ID…" : status}
              </p>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#778396]">{addedHere
              ? "Touch ID was added successfully on this device."
              : accountHasPasskey
                ? "A Ghola passkey is enabled for this account. Add this device if needed."
                : "Optional — use Touch ID for faster sign-in on this device."}</p>
            {enrollment === "error" && error ? <p role="alert" className="mt-2 text-xs leading-5 text-[#e6b86a]">{error}</p> : null}
            {!addedHere && (
              <button type="button" disabled={blocked || enrollment === "adding"} onClick={onAdd} className="mt-3 inline-flex h-9 items-center justify-center rounded-md border border-[#315277] px-3 text-xs font-semibold text-[#a8d8ff] hover:bg-[#132238] disabled:opacity-50">
                {enrollment === "adding"
                  ? "Adding…"
                  : enrollment === "error" ? "Retry Touch ID" : accountHasPasskey ? "Add this device" : "Add Touch ID"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function touchIdEnrollmentWasCancelled(error: unknown) {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const failure = current as { name?: unknown; code?: unknown; cause?: unknown };
    const name = typeof failure.name === "string" ? failure.name : "";
    const code = typeof failure.code === "string" ? failure.code : "";
    if (name === "NotAllowedError" || code.toLowerCase().includes("cancel")) return true;
    current = failure.cause;
  }
  return false;
}

function venueLabel(venueId: string) {
  return executionVenueLabel(venueId);
}

function LighterReadinessPanel({
  readiness,
  error,
  checking,
}: {
  readiness: LighterActivationReadiness | null;
  error: string | null;
  checking: boolean;
}) {
  const baseCollateralReady = readiness
    ? BigInt(readiness.base_usdc_microunits) >= BigInt(3_000_000)
    : false;
  const baseGasReady = readiness
    ? !readiness.blockers.includes("lighter_base_gas_required")
    : false;
  return (
    <div className="mt-4 rounded-lg border border-[#3b3424] bg-[#0b0c0e] p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#cba45f]">What Lighter needs</p>
      {readiness ? (
        <>
          <p className="mt-2 text-xs leading-5 text-[#d8eaff]">{describeLighterActivationNextStep(readiness)}</p>
          <div className="mt-2 divide-y divide-[#1b283b]">
            {!readiness.lighter_owner_account_ready && <>
              <ReadinessRow label="Lighter collateral" value={`${formatDecimalUnits(readiness.base_usdc_microunits, 6, 2)} USDC on Base`} ready={baseCollateralReady} />
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

function ReadinessRow({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-xs">
      <span className="text-[#8f9aae]">{label}</span>
      <span className={`inline-flex items-center gap-1.5 text-right font-medium ${ready ? "text-[#72dfb2]" : "text-[#e6b86a]"}`}>
        {ready ? <Check className="h-3.5 w-3.5" /> : <span aria-hidden="true" className="text-[#e6b86a]">•</span>}
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
    <section
      aria-label={pairScoped ? "Selected Carry execution pair" : "Carry execution fleet"}
      className="rounded-xl border border-[#202b3a] bg-[#0d1117] p-4"
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-[#718097]">
        {pairScoped ? "Selected route" : "Execution venues"}
      </p>
      <div className="mt-2 divide-y divide-[#1d2634]">
        {venueIds.map((venueId) => {
          const state = states[venueId];
          const role = venueId === longVenueId ? "LONG" : venueId === shortVenueId ? "SHORT" : null;
          return (
            <div
              key={venueId}
              data-carry-venue={venueId}
              data-carry-role={role?.toLowerCase() || "fleet"}
              className="flex min-w-0 items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                {role ? <p className="font-mono text-[9px] font-semibold tracking-[0.1em] text-[#657188]">{role}</p> : null}
                <p className="mt-0.5 truncate text-sm font-semibold text-[#d8e1ed]">{venueLabel(venueId)}</p>
              </div>
              <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold ${state === "connected" ? "text-[#72dfb2]" : "text-[#9cadc3]"}`}>
                {state === "connected" ? <Check className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                {state === "connected" ? "Connected" : state === "needed" ? ONBOARDING_BY_VENUE[venueId].ux.badge : "Unavailable"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
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
