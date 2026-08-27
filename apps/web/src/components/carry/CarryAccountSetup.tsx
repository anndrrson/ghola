"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, X } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
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
import { carryAccountConnectionProgress, carryAccountConnections } from "@/lib/carry-account-connections";
import {
  connectInjectedHyperliquidOwner,
  injectedWalletErrorMessage,
  resolveInjectedEvmProvider,
} from "@/lib/hyperliquid-owner-authorization";
import {
  sendLighterKeyAssociationWithInjectedOwner,
  signAsterAgentApprovalWithInjectedOwner,
} from "@/lib/injected-venue-owner";
import {
  fetchLighterActivationReadiness,
  type LighterActivationReadiness,
} from "@/lib/lighter-activation-readiness";

type VenueState = "connected" | "needed" | "unavailable";
type VenueActivation = { venue: "aster" | "lighter"; ownerAddress: string };
type PendingAsterLinkRecovery = PendingAsterOnboarding;
type PendingLighterAssociation = PendingLighterOnboarding;

const HYPERLIQUID_ONBOARDING = getCurrentVenueCredentialOnboardingPath("hyperliquid");
const ASTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("aster");
const LIGHTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("lighter");

export function CarryAccountSetup({ returnTo = "/carry" }: { returnTo?: string }) {
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
  const [error, setError] = useState<string | null>(null);
  const [activationNeeded, setActivationNeeded] = useState<VenueActivation | null>(null);
  const [lighterReadiness, setLighterReadiness] = useState<LighterActivationReadiness | null>(null);
  const [lighterReadinessError, setLighterReadinessError] = useState<string | null>(null);
  const [checkingLighterReadiness, setCheckingLighterReadiness] = useState(false);
  const [injectedOwnerAvailable, setInjectedOwnerAvailable] = useState(false);
  const safeReturnTo = returnTo === "/carry" || returnTo.startsWith("/trade?") ? returnTo : "/carry";
  const recoveryUserScope = opaqueTurnkeyWalletScope(auth.user?.id || "");
  const asterWalletRepairRequested = asterWalletRepairRequired ||
    (!asterWalletRepairCompleted && searchParams.get("repair") === "aster-wallet");
  const setupReturnTo = `/account?setup=carry&return_to=${encodeURIComponent(safeReturnTo)}`;

  const refresh = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const [passportRaw, hyperliquidRaw] = await Promise.all([
        getPrivateAgentPassport(),
        getHyperliquidExecutionVaultStatus().catch(() => null),
      ]);
      const connections = carryAccountConnections({ passport: passportRaw, hyperliquidStatus: hyperliquidRaw });
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
    setInjectedOwnerAvailable(Boolean(resolveInjectedEvmProvider()));
  }, []);

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
      if (recovered?.aster_activation) {
        setActivationNeeded({ venue: "aster", ownerAddress: recovered.aster_activation.owner_address });
        setAsterReprepareRequired(true);
      } else if (recovered?.lighter_activation) {
        setActivationNeeded({ venue: "lighter", ownerAddress: recovered.lighter_activation.owner_address });
      }
    } catch {
      // Storage may be unavailable; worker-side one-shot guards still apply.
    }
  }, [accountCommitment, recoveryUserScope]);

  const refreshLighterReadiness = useCallback(async (ownerAddress?: string) => {
    const owner = ownerAddress || (activationNeeded?.venue === "lighter" ? activationNeeded.ownerAddress : "");
    if (!owner) return;
    setCheckingLighterReadiness(true);
    setLighterReadinessError(null);
    try {
      setLighterReadiness(await fetchLighterActivationReadiness(owner));
    } catch (caught) {
      setLighterReadiness(null);
      setLighterReadinessError(caught instanceof Error ? caught.message : "Readiness check unavailable.");
    } finally {
      setCheckingLighterReadiness(false);
    }
  }, [activationNeeded]);

  useEffect(() => {
    if (activationNeeded?.venue === "lighter") {
      void refreshLighterReadiness(activationNeeded.ownerAddress);
    } else {
      setLighterReadiness(null);
      setLighterReadinessError(null);
    }
  }, [activationNeeded, refreshLighterReadiness]);

  const connectAsterProgrammatic = useCallback(async (forceReprepare = false) => {
    setWorking(true);
    setError(null);
    setActivationNeeded(null);
    let ownerAddress = "";
    let prepared: AsterProgrammaticPreparation | null = forceReprepare || pendingAsterLinkRecovery?.signature
      ? null
      : pendingAsterLinkRecovery?.preparation || null;
    let signature: `0x${string}` | null = null;
    let completionAttempted = false;
    let usingTurnkeyOwner = false;
    try {
      const provider = resolveInjectedEvmProvider();
      let pair: Awaited<ReturnType<typeof perpsTurnkey.ensureWalletPair>> | null = null;
      if (provider) {
        ownerAddress = await connectInjectedHyperliquidOwner(provider);
      } else {
        usingTurnkeyOwner = true;
        pair = await perpsTurnkey.ensureWalletPair();
        ownerAddress = pair.owner.address;
      }
      const preparedOwner = prepared?.contract.ownerAuthorization.ownerAddress.toLowerCase();
      if (preparedOwner && preparedOwner !== ownerAddress.toLowerCase()) {
        prepared = null;
        setPendingAsterLinkRecovery(null);
        persistRecovery(accountCommitment, recoveryUserScope, { aster: null });
      }
      if (!prepared) {
        prepared = await prepareAsterProgrammaticCredential({
          owner_address: ownerAddress,
          agent_name: "ghola-perps",
        });
        const unsignedPending = { preparation: prepared };
        setPendingAsterLinkRecovery(unsignedPending);
        persistRecovery(accountCommitment, recoveryUserScope, { aster: unsignedPending });
      }
      signature = provider
        ? await signAsterAgentApprovalWithInjectedOwner({
          provider,
          ownerAddress: ownerAddress as `0x${string}`,
          typedData: prepared.contract.approval.typedData,
        })
        : await perpsTurnkey.signAsterAgentApproval(prepared.contract.approval.typedData);
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
      if (usingTurnkeyOwner && !completionAttempted && isExpiredPerpsSession(caught)) {
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
          setActivationNeeded({ venue: "aster", ownerAddress });
          setPendingAsterLinkRecovery(null);
          persistRecovery(accountCommitment, recoveryUserScope, {
            aster: null,
            asterActivation: activationRequirement(ownerAddress),
          });
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
        const message = resolveInjectedEvmProvider()
          ? injectedWalletErrorMessage(caught)
          : caught instanceof Error ? caught.message : "Aster authorization failed.";
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
        setPendingAsterLinkRecovery(null);
        persistRecovery(accountCommitment, recoveryUserScope, { aster: null });
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
    else void connectAsterProgrammatic();
  }, [connectAsterProgrammatic, pendingAsterAuthorization, pendingAsterWalletRepair, perpsTurnkey.authenticated, repairAsterWallet]);

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
    if (!injectedOwnerAvailable && !perpsTurnkey.configured) {
      setError("Secure perps wallet setup is unavailable in this preview.");
      return;
    }
    if (!injectedOwnerAvailable && !perpsTurnkey.authenticated) {
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
    if (!injectedOwnerAvailable && asterWalletRepairRequested) {
      await repairAsterWallet();
      return;
    }
    setAsterReprepareRequired(false);
    await connectAsterProgrammatic();
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
    let usingTurnkeyOwner = false;
    let walletSubmissionStarted = false;
    try {
      if (pending?.submission_ambiguous) {
        setError("Lighter wallet submission is ambiguous. Ghola will not submit it again; reconcile the wallet activity first.");
        return;
      }
      const provider = resolveInjectedEvmProvider();
      let ownerAddress = "";
      if (provider) {
        ownerAddress = await connectInjectedHyperliquidOwner(provider);
      } else {
        usingTurnkeyOwner = true;
        ownerAddress = (await perpsTurnkey.ensureWalletPair()).owner.address;
      }
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
      walletSubmissionStarted = true;
      const authorization = provider
        ? await sendLighterKeyAssociationWithInjectedOwner({
          provider,
          ownerAddress: ownerAddress as `0x${string}`,
          transactionPlan: preparation.transaction_plan,
        })
        : await perpsTurnkey.signLighterKeyAssociation(preparation.transaction_plan);
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
      if (usingTurnkeyOwner && !pending && isExpiredPerpsSession(caught)) {
        await perpsTurnkey.logout().catch(() => {});
        setPendingLighterAuthorization(true);
        setError("Secure wallet session expired. Continue authentication below; no Lighter key was submitted.");
        return;
      }
      if (pending?.authorization) {
        setError("Lighter association needs reconciliation. Ghola will not create or submit another key.");
      } else if (walletSubmissionStarted) {
        const code = walletErrorCode(caught);
        if ([4001, 4100].includes(code)) {
          setError(injectedWalletErrorMessage(caught));
        } else if (preparation) {
          const ambiguous = { preparation, submission_ambiguous: true as const };
          setPendingLighterAssociation(ambiguous);
          persistRecovery(accountCommitment, recoveryUserScope, { lighter: ambiguous });
          setError("Lighter wallet outcome is ambiguous. Ghola froze this preparation and will not submit it again.");
        }
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
    if (!injectedOwnerAvailable && !perpsTurnkey.configured) {
      setError("Secure perps wallet setup is unavailable in this preview.");
      return;
    }
    if (!injectedOwnerAvailable && !perpsTurnkey.authenticated) {
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
    const requirement = activationNeeded;
    if (!requirement) return;
    setActivationNeeded(null);
    persistRecovery(accountCommitment, recoveryUserScope, requirement.venue === "aster"
      ? { asterActivation: null }
      : { lighterActivation: null });
    if (requirement.venue === "aster") await connectAsterProgrammatic(true);
    else await connectLighterProgrammatic();
  }

  const connectionProgress = carryAccountConnectionProgress({
    accountCommitment,
    venues: {
      hyperliquid: hyperliquid === "connected",
      aster: aster === "connected",
      lighter: lighter === "connected",
    },
  });
  return (
    <main className="min-h-screen bg-[#06080c] px-4 pb-20 pt-24 text-[#eef1f8] sm:px-6">
      <AuthModal mode={authMode} open={authOpen} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} redirectTo={setupReturnTo} />
      <section className="mx-auto max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#5aa7ff]">Carry setup</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Connect once. Trade as one position.</h1>
        <p className="mt-3 text-sm leading-6 text-[#8f9aae]">Ghola&apos;s execution policy permits reads, orders, cancellation, and reconciliation only.</p>
        <p className="mt-1 text-sm leading-6 text-[#8f9aae]">Verify every connection before depositing. Ghola shows the exact owner-funded requirement before live execution can unlock.</p>

        {!auth.authenticated && !auth.loading && (
          <button type="button" onClick={() => setAuthOpen(true)} className="mt-8 h-12 w-full rounded-lg bg-[#4aaef8] font-semibold text-[#06111d]">
            Sign in to continue
          </button>
        )}

        {auth.authenticated && (
          <div className="mt-8 space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-[#25344b] bg-[#090e16] px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#718097]">Execution access</p>
                <p className="mt-1 text-sm text-[#c9d2df]">{connectionProgress.ready
                  ? "All venues connected. Route verification is unlocked."
                  : `Connect ${connectionProgress.missingVenueIds.map(venueLabel).join(" + ")} to unlock route verification.`}</p>
              </div>
              <p className={`font-mono text-sm font-semibold ${connectionProgress.ready ? "text-[#72dfb2]" : "text-[#d9bd74]"}`}>
                {connectionProgress.connectedCount}/{connectionProgress.requiredCount}
              </p>
            </div>
            {perpsTurnkey.authenticated && !perpsTurnkey.hasPasskey && (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[#315277] bg-[#0b1624] p-4">
                <div>
                  <p className="font-semibold">Make future sign-ins one click</p>
                  <p className="mt-1 text-xs leading-5 text-[#8f9aae]">Add Touch ID for this Ghola address. Turnkey Dashboard passkeys cannot cross domains.</p>
                </div>
                <button type="button" disabled={working} onClick={() => void enableGholaTouchId()} className="shrink-0 rounded-md bg-[#4aaef8] px-3 py-2 text-sm font-semibold text-[#06111d] disabled:opacity-50">
                  {working ? "Enabling…" : "Enable Touch ID"}
                </button>
              </div>
            )}
            <VenueCard name="Hyperliquid" state={hyperliquid} onboarding={HYPERLIQUID_ONBOARDING}>
              {hyperliquid !== "connected" && (
                <Link href={`/account?setup=hyperliquid&return_to=${encodeURIComponent(setupReturnTo)}`} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff]">
                  {HYPERLIQUID_ONBOARDING.ux.action_label}
                </Link>
              )}
            </VenueCard>
            <VenueCard name="Aster" state={aster} onboarding={ASTER_ONBOARDING}>
              {aster !== "connected" && (
                <button type="button" disabled={working || (!injectedOwnerAvailable && (perpsTurnkey.loading || !perpsTurnkey.configured)) || asterRegistrationAmbiguous || (!injectedOwnerAvailable && activationNeeded?.venue === "aster")} onClick={() => void beginAsterProgrammatic()} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff] disabled:opacity-50">
                  {pendingAsterAuthorization
                    ? working ? "Authenticating…" : "Continue secure authentication"
                    : !injectedOwnerAvailable && !perpsTurnkey.configured
                      ? "Secure wallet unavailable"
                    : !injectedOwnerAvailable && perpsTurnkey.loading
                      ? "Restoring secure wallet…"
                    : working
                      ? "Authorizing…"
                      : asterWalletRepairRequested
                        ? "Repair secure wallet"
                      : asterRegistrationAmbiguous
                        ? "Aster reconciliation required"
                        : pendingAsterLinkRecovery
                          ? pendingAsterLinkRecovery.signature
                            ? pendingAsterLinkRecovery.receipt ? "Finish Aster linking" : "Resume Aster verification"
                            : "Resume Aster signing"
                        : activationNeeded?.venue === "aster"
                          ? injectedOwnerAvailable ? "Check connected wallet" : "Activate owner first"
                        : asterReprepareRequired
                          ? "Re-prepare Aster approval"
                          : ASTER_ONBOARDING.ux.action_label}
                </button>
              )}
            </VenueCard>
            {aster !== "connected" && (
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
            <VenueCard name="Lighter" state={lighter} onboarding={LIGHTER_ONBOARDING}>
              {lighter !== "connected" && (
                <button type="button" disabled={working || (!injectedOwnerAvailable && (perpsTurnkey.loading || !perpsTurnkey.configured)) || (!injectedOwnerAvailable && activationNeeded?.venue === "lighter") || pendingLighterAssociation?.submission_ambiguous === true} onClick={() => void beginLighterProgrammatic()} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff] disabled:opacity-50">
                  {pendingLighterAuthorization
                    ? working ? "Authenticating…" : "Continue secure authentication"
                    : !injectedOwnerAvailable && !perpsTurnkey.configured
                      ? "Secure wallet unavailable"
                    : !injectedOwnerAvailable && perpsTurnkey.loading
                      ? "Restoring secure wallet…"
                    : pendingLighterAssociation?.submission_ambiguous
                      ? "Reconciliation required"
                    : activationNeeded?.venue === "lighter"
                      ? injectedOwnerAvailable ? "Check connected wallet" : "Activate owner first"
                    : working
                      ? pendingLighterAssociation?.authorization ? "Verifying…" : "Authorizing…"
                      : pendingLighterAssociation?.authorization
                        ? "Resume verification"
                        : pendingLighterAssociation
                          ? "Continue owner approval"
                        : LIGHTER_ONBOARDING.ux.action_label}
                </button>
              )}
            </VenueCard>
            {lighter !== "connected" && (
              <div className="px-1">
                <p className="mb-2 text-xs leading-5 text-[#718097]">One owner approval. The key is created inside the worker; Ethereum and Lighter must both confirm it before use.</p>
                <button type="button" onClick={() => setShowLighterManual((value) => !value)} className="text-xs font-semibold text-[#718097] hover:text-[#8fcaff]">
                  {showLighterManual ? "Hide existing-key option" : "Use an existing Lighter key instead"}
                </button>
              </div>
            )}
            {showLighterManual && lighter !== "connected" && (
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
        {activationNeeded && (
          <div className="mt-4 rounded-lg border border-[#315277] bg-[#0b1624] p-4 text-sm">
            <p className="font-semibold text-[#d8eaff]">Activate this connected owner wallet on {activationNeeded.venue === "aster" ? "Aster" : "Lighter"}</p>
            <div className="mt-2 flex items-center gap-2">
              <p className="min-w-0 break-all font-mono text-xs text-[#8fcaff]">{activationNeeded.ownerAddress}</p>
              <button type="button" aria-label="Copy owner address" onClick={() => void navigator.clipboard.writeText(activationNeeded.ownerAddress)} className="shrink-0 rounded-md p-1.5 text-[#718097] hover:bg-[#132238] hover:text-[#a8d8ff]">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            {activationNeeded.venue === "lighter" ? (
              <LighterReadinessPanel
                readiness={lighterReadiness}
                error={lighterReadinessError}
                checking={checkingLighterReadiness}
                onRefresh={() => void refreshLighterReadiness()}
              />
            ) : (
              <p className="mt-2 text-xs leading-5 text-[#8f9aae]">The venue must recognize this exact address before Ghola can create its sealed trading key. No order, key, deposit, or transfer was submitted.</p>
            )}
            <a href={activationNeeded.venue === "aster" ? "https://www.asterdex.com/en" : "https://app.lighter.xyz/"} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-md border border-[#315277] px-3 py-2 text-xs font-semibold text-[#a8d8ff]">
              {activationNeeded.venue === "aster" ? "Open Aster" : "Open Lighter deposit"}
            </a>
            <button type="button" disabled={working || (activationNeeded.venue === "lighter" && !lighterReadiness?.ready)} onClick={() => void retryAfterVenueActivation()} className="ml-2 mt-3 inline-flex rounded-md bg-[#4aaef8] px-3 py-2 text-xs font-semibold text-[#06111d] disabled:opacity-50">
              I activated it — recheck once
            </button>
          </div>
        )}
        {connectionProgress.ready && (
          <Link href={safeReturnTo} className="mt-6 block h-12 rounded-lg bg-[#56d6a0] px-4 py-3 text-center font-semibold text-[#06130e]">Continue to route verification</Link>
        )}
        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-[#657188]"><LockKeyhole className="h-4 w-4" /> Secrets are sealed to the attested worker.</div>
      </section>
    </main>
  );
}

function venueLabel(venueId: string) {
  return venueId === "hyperliquid" ? "Hyperliquid" : venueId === "lighter" ? "Lighter" : venueId === "aster" ? "Aster" : venueId;
}

function LighterReadinessPanel({
  readiness,
  error,
  checking,
  onRefresh,
}: {
  readiness: LighterActivationReadiness | null;
  error: string | null;
  checking: boolean;
  onRefresh: () => void;
}) {
  const baseCollateralReady = readiness
    ? BigInt(readiness.base_usdc_microunits) >= BigInt(3_000_000)
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
        <div className="mt-2 divide-y divide-[#1b283b]">
          <ReadinessRow label="Lighter collateral" value={`${formatDecimalUnits(readiness.base_usdc_microunits, 6, 2)} USDC on Base`} ready={baseCollateralReady} />
          <ReadinessRow label="Base network fee" value={baseGasReady ? "Funded" : `${formatDecimalUnits(readiness.estimated_base_gas_wei, 18, 6)} ETH required`} ready={baseGasReady} />
          <ReadinessRow label="Ethereum owner association" value={readiness.ethereum_association_ready ? "Funded" : `${formatDecimalUnits(readiness.estimated_ethereum_association_gas_wei, 18, 6)} ETH required`} ready={readiness.ethereum_association_ready} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-[#8f9aae]">{checking ? "Checking both networks…" : error || "Readiness has not been checked."}</p>
      )}
      <p className="mt-2 text-[11px] leading-4 text-[#657188]">Read-only balances and current gas estimates. No payment, transfer, key, or order is submitted by this check.</p>
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

function VenueCard({
  name,
  state,
  onboarding,
  children,
}: {
  name: string;
  state: VenueState;
  onboarding: VenueCredentialOnboardingPath;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#1f2c41] bg-[#0a0f17] p-4">
      <div className="flex items-center gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-lg ${state === "connected" ? "bg-[#0d2a21] text-[#72dfb2]" : "bg-[#101b2a] text-[#8fcaff]"}`}>
          {state === "connected" ? <Check className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
        </span>
        <div>
          <p className="font-semibold">{name}</p>
          <p className="mt-0.5 text-xs text-[#718097]">{state === "connected" ? "Trading access connected" : state === "needed" ? onboarding.ux.badge : "Not yet execution-ready"}</p>
        </div>
      </div>
      {children}
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

function isExpiredPerpsSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /no active session found|requires a valid session/i.test(message);
}

function walletErrorCode(error: unknown): number {
  return error && typeof error === "object" && "code" in error
    ? Number((error as { code?: unknown }).code)
    : Number.NaN;
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
