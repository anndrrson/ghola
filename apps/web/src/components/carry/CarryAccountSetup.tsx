"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, KeyRound, LockKeyhole } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
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
} from "@/lib/private-account-client";
import { classifyAsterOnboardingFailure } from "@/lib/aster-onboarding-recovery";
import {
  getCurrentVenueCredentialOnboardingPath,
  type VenueCredentialOnboardingPath,
} from "@/lib/venue-credential-onboarding";
import {
  readCarryOnboardingRecovery,
  updateCarryOnboardingRecovery,
  type PendingAsterOnboarding,
  type PendingLighterOnboarding,
} from "@/lib/carry-onboarding-recovery";
import { carryAccountConnections } from "@/lib/carry-account-connections";

type VenueState = "connected" | "needed" | "unavailable";
type PendingAsterLinkRecovery = PendingAsterOnboarding;
type PendingLighterAssociation = PendingLighterOnboarding;

const HYPERLIQUID_ONBOARDING = getCurrentVenueCredentialOnboardingPath("hyperliquid");
const ASTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("aster");
const LIGHTER_ONBOARDING = getCurrentVenueCredentialOnboardingPath("lighter");

export function CarryAccountSetup({ returnTo = "/carry" }: { returnTo?: string }) {
  const auth = useThumperAuth();
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
  const [pendingAsterLinkRecovery, setPendingAsterLinkRecovery] = useState<PendingAsterLinkRecovery | null>(null);
  const [asterReprepareRequired, setAsterReprepareRequired] = useState(false);
  const [asterRegistrationAmbiguous, setAsterRegistrationAmbiguous] = useState(false);
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
  const safeReturnTo = returnTo === "/carry" || returnTo.startsWith("/trade?") ? returnTo : "/carry";
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
      setAster(connections.aster ? "connected" : "needed");
      setLighter(connections.lighter ? "connected" : "needed");
      setHyperliquid(connections.hyperliquid ? "connected" : "needed");
      setError(null);
    } catch {
      setError("Account readiness could not be refreshed.");
    }
  }, [auth.authenticated]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!accountCommitment) return;
    try {
      const recovered = readCarryOnboardingRecovery(window.localStorage, accountCommitment);
      if (recovered?.aster) setPendingAsterLinkRecovery(recovered.aster);
      if (recovered?.lighter) setPendingLighterAssociation(recovered.lighter);
    } catch {
      // Storage may be unavailable; worker-side one-shot guards still apply.
    }
  }, [accountCommitment]);

  const connectAsterProgrammatic = useCallback(async () => {
    setWorking(true);
    setError(null);
    let prepared: AsterProgrammaticPreparation | null = null;
    let signature: `0x${string}` | null = null;
    let completionAttempted = false;
    try {
      const pair = await perpsTurnkey.ensureWalletPair();
      prepared = await prepareAsterProgrammaticCredential({
        owner_address: pair.owner.address,
        agent_name: "ghola-perps",
      });
      signature = await perpsTurnkey.signAsterAgentApproval(prepared.contract.approval.typedData);
      const pending = { preparation: prepared, signature };
      setPendingAsterLinkRecovery(pending);
      persistRecovery(accountCommitment, { aster: pending });
      completionAttempted = true;
      const completed = asRecord(await completeAsterProgrammaticCredential({ preparation: prepared, signature }));
      if (completed.status !== "ready") throw new Error("Aster authorization did not become ready.");
      setPendingAsterLinkRecovery(null);
      persistRecovery(accountCommitment, { aster: null });
      setAsterReprepareRequired(false);
      setAsterRegistrationAmbiguous(false);
      setAster("connected");
      await refresh();
    } catch (caught) {
      if (prepared && signature && completionAttempted) {
        const disposition = classifyAsterOnboardingFailure(caught, prepared);
        if (disposition.action === "finish_link" && signature) {
          const pending = { preparation: prepared, signature, receipt: disposition.receipt };
          setPendingAsterLinkRecovery(pending);
          persistRecovery(accountCommitment, { aster: pending });
        } else if (disposition.action === "reprepare") {
          setAsterReprepareRequired(true);
          setPendingAsterLinkRecovery(null);
          persistRecovery(accountCommitment, { aster: null });
        } else if (disposition.action === "hold_ambiguous") {
          setAsterRegistrationAmbiguous(true);
        }
        setError(disposition.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Aster authorization failed.");
      }
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, perpsTurnkey, refresh]);

  const finishAsterLinkRecovery = useCallback(async () => {
    if (!pendingAsterLinkRecovery) return;
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
      persistRecovery(accountCommitment, { aster: null });
      setAsterRegistrationAmbiguous(false);
      setAster("connected");
      await refresh();
    } catch (caught) {
      const disposition = classifyAsterOnboardingFailure(caught, pendingAsterLinkRecovery.preparation);
      if (disposition.action === "hold_ambiguous") setAsterRegistrationAmbiguous(true);
      setError(disposition.message);
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, pendingAsterLinkRecovery, refresh]);

  useEffect(() => {
    if (!pendingAsterAuthorization || !perpsTurnkey.authenticated) return;
    setPendingAsterAuthorization(false);
    void connectAsterProgrammatic();
  }, [connectAsterProgrammatic, pendingAsterAuthorization, perpsTurnkey.authenticated]);

  async function beginAsterProgrammatic() {
    if (!auth.authenticated) {
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    if (pendingAsterLinkRecovery) {
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
      setError(null);
      try {
        await perpsTurnkey.login();
      } catch (caught) {
        setPendingAsterAuthorization(false);
        setError(caught instanceof Error ? caught.message : "Secure wallet authentication failed.");
      } finally {
        setWorking(false);
      }
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
    let last: Record<string, unknown> = {};
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = asRecord(await completeLighterProgrammaticCredential({
        ...pending,
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
    let pending: PendingLighterAssociation | null = null;
    try {
      const pair = await perpsTurnkey.ensureWalletPair();
      const preparation = await prepareLighterProgrammaticCredential({
        owner_address: pair.owner.address,
      });
      const authorization = await perpsTurnkey.signLighterKeyAssociation(preparation.transaction_plan);
      pending = { preparation, authorization };
      setPendingLighterAssociation(pending);
      persistRecovery(accountCommitment, { lighter: pending });
      const completed = asRecord(await completeLighterProgrammaticCredential(pending));
      const ready = completed.status === "ready"
        ? completed
        : await reconcileLighterAssociation(pending);
      if (ready.status !== "ready") {
        setError("Lighter association is still confirming. Resume verification; Ghola will not submit it again.");
        return;
      }
      setPendingLighterAssociation(null);
      persistRecovery(accountCommitment, { lighter: null });
      setLighter("connected");
      await refresh();
    } catch (caught) {
      if (pending) {
        setError("Lighter association needs reconciliation. Ghola will not create or submit another key.");
      } else {
        setError(caught instanceof Error ? caught.message : "Lighter authorization failed.");
      }
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, perpsTurnkey, reconcileLighterAssociation, refresh]);

  const finishLighterAssociation = useCallback(async () => {
    if (!pendingLighterAssociation) return;
    setWorking(true);
    setError(null);
    try {
      const completed = await reconcileLighterAssociation(pendingLighterAssociation);
      if (completed.status !== "ready") {
        setError("Lighter association is still confirming. No transaction was resubmitted.");
        return;
      }
      setPendingLighterAssociation(null);
      persistRecovery(accountCommitment, { lighter: null });
      setLighter("connected");
      await refresh();
    } catch {
      setError("Lighter association still needs reconciliation. No transaction was resubmitted.");
    } finally {
      setWorking(false);
    }
  }, [accountCommitment, pendingLighterAssociation, reconcileLighterAssociation, refresh]);

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
    if (pendingLighterAssociation) {
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

  const enoughConnected = [hyperliquid, aster, lighter].filter((state) => state === "connected").length >= 2;
  return (
    <main className="min-h-screen bg-[#06080c] px-4 pb-20 pt-24 text-[#eef1f8] sm:px-6">
      <AuthModal mode={authMode} open={authOpen} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} redirectTo={setupReturnTo} />
      <section className="mx-auto max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#5aa7ff]">Carry setup</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Connect once. Trade as one position.</h1>
        <p className="mt-3 text-sm leading-6 text-[#8f9aae]">Ghola&apos;s execution policy permits reads, orders, cancellation, and reconciliation only.</p>

        {!auth.authenticated && !auth.loading && (
          <button type="button" onClick={() => setAuthOpen(true)} className="mt-8 h-12 w-full rounded-lg bg-[#4aaef8] font-semibold text-[#06111d]">
            Sign in to continue
          </button>
        )}

        {auth.authenticated && (
          <div className="mt-8 space-y-3">
            <VenueCard name="Hyperliquid" state={hyperliquid} onboarding={HYPERLIQUID_ONBOARDING}>
              {hyperliquid !== "connected" && (
                <Link href={`/account?setup=hyperliquid&return_to=${encodeURIComponent(setupReturnTo)}`} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff]">
                  {HYPERLIQUID_ONBOARDING.ux.action_label}
                </Link>
              )}
            </VenueCard>
            <VenueCard name="Aster" state={aster} onboarding={ASTER_ONBOARDING}>
              {aster !== "connected" && (
                <button type="button" disabled={working || perpsTurnkey.loading || asterRegistrationAmbiguous} onClick={() => void beginAsterProgrammatic()} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff] disabled:opacity-50">
                  {pendingAsterAuthorization
                    ? "Authenticating…"
                    : perpsTurnkey.loading
                      ? "Restoring secure wallet…"
                    : working
                      ? "Authorizing…"
                      : asterRegistrationAmbiguous
                        ? "Aster reconciliation required"
                        : pendingAsterLinkRecovery
                          ? pendingAsterLinkRecovery.receipt ? "Finish Aster linking" : "Resume Aster verification"
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
                <button type="button" disabled={working || perpsTurnkey.loading} onClick={() => void beginLighterProgrammatic()} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff] disabled:opacity-50">
                  {pendingLighterAuthorization
                    ? "Authenticating…"
                    : perpsTurnkey.loading
                      ? "Restoring secure wallet…"
                    : working
                      ? pendingLighterAssociation ? "Verifying…" : "Authorizing…"
                      : pendingLighterAssociation
                        ? "Resume verification"
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
        {enoughConnected && (
          <Link href={safeReturnTo} className="mt-6 block h-12 rounded-lg bg-[#56d6a0] px-4 py-3 text-center font-semibold text-[#06130e]">Continue to route verification</Link>
        )}
        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-[#657188]"><LockKeyhole className="h-4 w-4" /> Secrets are sealed to the attested worker.</div>
      </section>
    </main>
  );
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function persistRecovery(
  accountCommitment: string | null,
  update: { aster?: PendingAsterOnboarding | null; lighter?: PendingLighterOnboarding | null },
) {
  if (!accountCommitment) return;
  try {
    updateCarryOnboardingRecovery(window.localStorage, accountCommitment, update);
  } catch {
    // Storage is a convenience layer; the worker remains the submission authority.
  }
}
