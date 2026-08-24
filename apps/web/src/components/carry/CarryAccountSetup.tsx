"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, KeyRound, LockKeyhole } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
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
} from "@/lib/private-account-client";

type VenueState = "connected" | "needed" | "unavailable";

export function CarryAccountSetup() {
  const auth = useThumperAuth();
  const wallet = useTurnkeyWallet();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [accountCommitment, setAccountCommitment] = useState<string | null>(null);
  const [hyperliquid, setHyperliquid] = useState<VenueState>("needed");
  const [aster, setAster] = useState<VenueState>("needed");
  const [lighter, setLighter] = useState<VenueState>("needed");
  const [showAster, setShowAster] = useState(false);
  const [showLighter, setShowLighter] = useState(false);
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

  const refresh = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const [passportRaw, hyperliquidRaw] = await Promise.all([
        getPrivateAgentPassport(),
        getHyperliquidExecutionVaultStatus().catch(() => null),
      ]);
      const passport = asRecord(passportRaw).passport ? asRecord(asRecord(passportRaw).passport) : asRecord(passportRaw);
      setAccountCommitment(stringValue(passport.account_commitment));
      const venues = Array.isArray(passport.venues) ? passport.venues.map(asRecord) : [];
      setAster(venues.some((venue) => venue.venue_id === "aster" && venue.status === "ready") ? "connected" : "needed");
      setLighter(venues.some((venue) => venue.venue_id === "lighter" && venue.status === "ready") ? "connected" : "needed");
      const hyperliquidStatus = asRecord(hyperliquidRaw);
      setHyperliquid(
        hyperliquidStatus.status === "sealed" ||
        Boolean(hyperliquidStatus.vault_commitment) ||
        venues.some((venue) => venue.venue_id === "hyperliquid" && venue.status === "ready")
          ? "connected"
          : "needed",
      );
      setError(null);
    } catch {
      setError("Account readiness could not be refreshed.");
    }
  }, [auth.authenticated]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connectAster() {
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
      setShowAster(false);
      setAster("connected");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Aster connection failed.");
    } finally {
      setWorking(false);
    }
  }

  async function connectLighter() {
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
      setShowLighter(false);
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
      <AuthModal mode={authMode} open={authOpen} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} redirectTo="/account?setup=carry" />
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
            <VenueCard name="Hyperliquid" state={hyperliquid}>
              {hyperliquid !== "connected" && (
                <Link href="/account?setup=hyperliquid&return_to=%2Fcarry" className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff]">
                  Connect
                </Link>
              )}
            </VenueCard>
            <VenueCard name="Aster" state={aster}>
              {aster !== "connected" && (
                <button type="button" onClick={() => setShowAster((value) => !value)} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff]">
                  Connect
                </button>
              )}
            </VenueCard>
            {showAster && aster !== "connected" && (
              <div className="rounded-xl border border-[#25344b] bg-[#0b111b] p-5">
                <p className="text-sm font-semibold">Aster trade-only wallet</p>
                <p className="mt-1 text-xs leading-5 text-[#718097]">Use an API wallet already authorized on your Aster account. Its address is derived automatically.</p>
                <label className="mt-4 block text-xs text-[#8f9aae]">Collateral account
                  <input value={draft.user_address} onChange={(event) => setDraft((value) => ({ ...value, user_address: event.target.value }))} placeholder="0x account address" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                </label>
                <label className="mt-3 block text-xs text-[#8f9aae]">Trade-only private key
                  <input type="password" value={draft.api_wallet_private_key} onChange={(event) => setDraft((value) => ({ ...value, api_wallet_private_key: event.target.value }))} placeholder="0x…" autoComplete="off" className="mt-2 h-11 w-full rounded-md border border-[#263851] bg-[#070b12] px-3 font-mono text-sm outline-none focus:border-[#4a78a9]" />
                </label>
                <button type="button" disabled={working} onClick={() => void connectAster()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                  {working ? "Verifying…" : "Verify and connect"}
                </button>
              </div>
            )}
            <VenueCard name="Lighter" state={lighter}>
              {lighter !== "connected" && (
                <button type="button" onClick={() => setShowLighter((value) => !value)} className="rounded-md border border-[#315277] px-3 py-2 text-sm font-semibold text-[#a8d8ff]">
                  Connect
                </button>
              )}
            </VenueCard>
            {showLighter && lighter !== "connected" && (
              <div className="rounded-xl border border-[#25344b] bg-[#0b111b] p-5">
                <p className="text-sm font-semibold">Lighter API key</p>
                <p className="mt-1 text-xs leading-5 text-[#718097]">Lighter keys are not trade-only. Ghola permits only read, trade, cancel, and reconcile; transfers or withdrawals elsewhere require your owner wallet key, which Ghola never receives.</p>
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
                <button type="button" disabled={working} onClick={() => void connectLighter()} className="mt-4 h-11 w-full rounded-md bg-[#4aaef8] text-sm font-semibold text-[#06111d] disabled:opacity-50">
                  {working ? "Sealing…" : "Seal and connect"}
                </button>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-4 rounded-lg border border-[#60303a] bg-[#251116] px-4 py-3 text-sm text-[#ee9da8]">{error}</p>}
        {enoughConnected && (
          <Link href="/carry" className="mt-6 block h-12 rounded-lg bg-[#56d6a0] px-4 py-3 text-center font-semibold text-[#06130e]">Continue to Carry</Link>
        )}
        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-[#657188]"><LockKeyhole className="h-4 w-4" /> Secrets are sealed to the attested worker.</div>
      </section>
    </main>
  );
}

function VenueCard({ name, state, children }: { name: string; state: VenueState; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#1f2c41] bg-[#0a0f17] p-4">
      <div className="flex items-center gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-lg ${state === "connected" ? "bg-[#0d2a21] text-[#72dfb2]" : "bg-[#101b2a] text-[#8fcaff]"}`}>
          {state === "connected" ? <Check className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
        </span>
        <div><p className="font-semibold">{name}</p><p className="mt-0.5 text-xs text-[#718097]">{state === "connected" ? "Connected and verified" : state === "needed" ? "Connection required" : "Not yet execution-ready"}</p></div>
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
