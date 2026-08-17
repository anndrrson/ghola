"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, Loader2, LockKeyhole, RefreshCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { ConnectHyperliquidButton } from "./ConnectHyperliquidButton";
import {
  getHyperliquidLiveAccess,
  getPublicAgentStartupStatus,
  verifyVenueEligibility,
  wakePublicAgentWorker,
  type PublicAgentStartupStatus,
} from "@/lib/private-account-client";
import {
  LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
} from "@/lib/live-trading-contract";
import { hasPrivateAgentEntitlement } from "@/lib/private-agent-runtime";
import { getThumperBillingStatus } from "@/lib/thumper-api";
import type { ThumperBillingStatusResponse } from "@/lib/thumper-types";
import { useThumperAuth } from "@/lib/thumper-auth-context";

type LiveAccess = {
  eligibility_ready?: boolean;
  vault_ready?: boolean;
};

type WakeState = "idle" | "waking" | "warming" | "ready" | "error";

export function HyperliquidAccountSetup() {
  const auth = useThumperAuth();
  const [billing, setBilling] = useState<ThumperBillingStatusResponse | null>(null);
  const [access, setAccess] = useState<LiveAccess | null>(null);
  const [startup, setStartup] = useState<PublicAgentStartupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wakeState, setWakeState] = useState<WakeState>("idle");
  const [wakeMessage, setWakeMessage] = useState<string | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [network, setNetwork] = useState<"mainnet" | "testnet">("mainnet");

  const refresh = useCallback(async () => {
    if (!auth.authenticated) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [nextBilling, nextAccess, nextStartup] = await Promise.all([
        getThumperBillingStatus(),
        getHyperliquidLiveAccess() as Promise<LiveAccess>,
        getPublicAgentStartupStatus(),
      ]);
      setBilling(nextBilling);
      setAccess(nextAccess);
      setStartup(nextStartup);
      if (nextStartup.runtime.ready) setWakeState("ready");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Setup status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [auth.authenticated]);

  useEffect(() => {
    if (!auth.loading && auth.authenticated) void refresh();
  }, [auth.authenticated, auth.loading, refresh]);

  useEffect(() => {
    if (wakeState !== "warming") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getPublicAgentStartupStatus().then((next) => {
        if (cancelled) return;
        setStartup(next);
        if (next.runtime.ready) {
          setWakeState("ready");
          setWakeMessage("Secure worker is ready.");
          setConnectionEpoch((value) => value + 1);
          window.clearInterval(timer);
        }
      }).catch(() => undefined);
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [wakeState]);

  const entitled = hasPrivateAgentEntitlement(billing?.tier);
  const eligibilityReady = access?.eligibility_ready === true;
  const runtimeReady = startup?.runtime.ready === true || wakeState === "ready";

  async function wakeForSetup() {
    if (!entitled || !eligibilityReady || wakeState === "waking") return;
    setWakeState("waking");
    setWakeMessage("Starting attested setup compute. This can take about a minute.");
    try {
      const wake = await wakePublicAgentWorker();
      setWakeMessage(wake.message);
      setWakeState(wake.ready ? "ready" : wake.status === "warming" ? "warming" : "error");
      const next = await getPublicAgentStartupStatus();
      setStartup(next);
      if (wake.ready || next.runtime.ready) {
        setWakeState("ready");
        setConnectionEpoch((value) => value + 1);
      }
    } catch (error) {
      setWakeState("error");
      setWakeMessage(error instanceof Error ? error.message : "Secure worker start failed.");
    }
  }

  if (auth.loading) return <SetupNotice message="Checking your account…" loading />;
  if (!auth.authenticated) {
    return (
      <SetupNotice message="Sign in before connecting venue access.">
        {/* A full navigation is required so /signin receives its scoped
            Google OAuth COOP/COEP response headers. */}
        <a href="/signin?redirect=%2Faccount%3Fflow%3Dtrade" className="trade-action inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-semibold">
          Sign in
        </a>
      </SetupNotice>
    );
  }

  return (
    <section id="hyperliquid-setup" className="scroll-mt-6 space-y-3">
      <SetupStep number="1" title="Account access" complete={entitled}>
        {loading && !billing ? (
          <p className="flex items-center gap-2 text-xs text-[#8b95a8]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking access…</p>
        ) : entitled ? (
          <p className="text-xs leading-5 text-emerald-200">Private-agent access is active{billing?.expires_at ? ` through ${new Date(billing.expires_at).toLocaleDateString()}` : ""}.</p>
        ) : (
          <p className="text-xs leading-5 text-amber-100">
            Active private-agent access is required for setup compute. Review access in <Link href="/settings" className="underline underline-offset-2">Settings</Link>.
          </p>
        )}
      </SetupStep>

      <SetupStep number="2" title="Eligibility, terms, and risk" complete={eligibilityReady} id="eligibility-consent">
        {eligibilityReady ? (
          <p className="text-xs leading-5 text-emerald-200">
            Current acceptance recorded: terms {LIVE_TRADING_TERMS_VERSION} · risk {LIVE_TRADING_RISK_DISCLOSURE_VERSION}.
          </p>
        ) : entitled ? (
          <EligibilityConsent onAccepted={async () => {
            const next = await getHyperliquidLiveAccess() as LiveAccess;
            setAccess(next);
          }} />
        ) : (
          <p className="text-xs text-[#69758a]">Activate account access before accepting live-trading eligibility.</p>
        )}
      </SetupStep>

      <SetupStep number="3" title="Attested worker" complete={runtimeReady}>
        {!eligibilityReady ? (
          <p className="text-xs text-[#69758a]">Complete eligibility before starting setup compute.</p>
        ) : runtimeReady ? (
          <p className="flex items-center gap-2 text-xs text-emerald-200"><Check className="h-3.5 w-3.5" /> Secure worker is ready.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <p className={`text-xs leading-5 ${wakeState === "error" ? "text-rose-300" : "text-[#8b95a8]"}`}>
              {wakeMessage ?? "Start the worker explicitly so your credential can be sealed to its attested recipient. No trade is submitted."}
            </p>
            <button
              type="button"
              onClick={() => void wakeForSetup()}
              disabled={!entitled || wakeState === "waking" || wakeState === "warming"}
              className="trade-action inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              {wakeState === "waking" || wakeState === "warming" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {wakeState === "waking" || wakeState === "warming" ? "Starting worker" : "Start secure worker"}
            </button>
          </div>
        )}
      </SetupStep>

      <SetupStep number="4" title="Seal trade-only access" complete={access?.vault_ready === true}>
        {!eligibilityReady ? (
          <p className="text-xs text-[#69758a]">The credential form stays hidden until current eligibility and terms are accepted.</p>
        ) : entitled ? (
          <div key={connectionEpoch}>
            <ConnectHyperliquidButton ready network={network} onNetworkChange={setNetwork} />
          </div>
        ) : (
          <p className="text-xs text-[#69758a]">Active private-agent access is required to connect a new credential.</p>
        )}
      </SetupStep>

      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-400/25 bg-rose-400/[0.05] px-4 py-3 text-xs text-rose-200">
          <span className="flex items-center gap-2"><TriangleAlert className="h-3.5 w-3.5" /> {loadError}</span>
          <button type="button" onClick={() => void refresh()} className="trade-chip h-8 rounded px-3">Retry</button>
        </div>
      ) : null}

      <div className="flex justify-end pt-2">
        <Link href="/trade" className="trade-chip inline-flex h-10 items-center justify-center rounded-md px-4 text-sm">Return to terminal</Link>
      </div>
    </section>
  );
}

function EligibilityConsent({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const [eligible, setEligible] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eligible || !accepted || working) return;
    setWorking(true);
    setError(null);
    try {
      await verifyVenueEligibility({
        venue_id: "hyperliquid",
        credential_type: "self_attested_eligible_user",
        eligible_non_us: true,
        terms_version: LIVE_TRADING_TERMS_VERSION,
        risk_disclosure_version: LIVE_TRADING_RISK_DISCLOSURE_VERSION,
        confirmation: LIVE_TRADING_ELIGIBILITY_CONFIRMATION,
      });
      await onAccepted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Eligibility acceptance failed.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <p className="text-xs leading-5 text-[#8b95a8]">
        Live trading is limited to eligible non-US users. Ghola is software, not investment advice; digital-asset trading can cause total loss.
      </p>
      <label className="flex items-start gap-2 text-xs leading-5 text-[#c5cfde]">
        <input type="checkbox" checked={eligible} onChange={(event) => setEligible(event.target.checked)} className="mt-1" />
        <span>I attest that I am an eligible non-US user and am not prohibited from using Hyperliquid or Ghola.</span>
      </label>
      <label className="flex items-start gap-2 text-xs leading-5 text-[#c5cfde]">
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1" />
        <span>
          I accept the <Link href="/terms" className="text-[#8ec7ff] underline underline-offset-2">Terms of Service</Link> and live-trading risk disclosure (terms {LIVE_TRADING_TERMS_VERSION}; risk {LIVE_TRADING_RISK_DISCLOSURE_VERSION}) and acknowledge the <Link href="/privacy" className="text-[#8ec7ff] underline underline-offset-2">Privacy Policy</Link>.
        </span>
      </label>
      {error ? <p role="alert" className="text-xs text-rose-300">{error}</p> : null}
      <button type="submit" disabled={!eligible || !accepted || working} className="trade-action inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit">
        {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {working ? "Recording acceptance" : "Accept and continue"}
      </button>
    </form>
  );
}

function SetupStep({
  number,
  title,
  complete,
  id,
  children,
}: {
  number: string;
  title: string;
  complete: boolean;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="trade-panel scroll-mt-6 rounded-md p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded border border-[#273142] bg-[#0b0f15] font-mono text-[10px] text-[#8ec7ff]">{number}</span>
          {title}
        </h2>
        <span className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${complete ? "text-emerald-300" : "text-[#69758a]"}`}>
          {complete ? <Check className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />}
          {complete ? "complete" : "required"}
        </span>
      </div>
      {children}
    </section>
  );
}

function SetupNotice({ message, loading = false, children }: { message: string; loading?: boolean; children?: ReactNode }) {
  return (
    <div className="trade-panel grid gap-3 rounded-md p-5 text-sm text-[#8b95a8]">
      <p className="flex items-center gap-2">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{message}</p>
      {children}
    </div>
  );
}
