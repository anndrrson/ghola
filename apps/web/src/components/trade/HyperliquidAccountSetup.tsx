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
import {
  InvestorAccessGate,
  type InvestorAccessControl,
} from "./InvestorAccessGate";
import { investorFacingErrorMessage } from "@/lib/investor-facing-error";

type LiveAccess = {
  eligibility_ready?: boolean;
  vault_ready?: boolean;
  graduation_ready?: boolean;
  proof_completed_at?: string | null;
};

type WakeState = "idle" | "waking" | "warming" | "ready" | "error";
const WORKER_WARM_POLL_MS = 5_000;
const WORKER_WARM_MAX_POLLS = 18;

export function HyperliquidAccountSetup() {
  return (
    <InvestorAccessGate requireComplimentaryPass>
      {(investorAccess) => <HyperliquidAccountSetupContent investorAccess={investorAccess} />}
    </InvestorAccessGate>
  );
}

function HyperliquidAccountSetupContent({ investorAccess }: { investorAccess: InvestorAccessControl }) {
  const [access, setAccess] = useState<LiveAccess | null>(null);
  const [startup, setStartup] = useState<PublicAgentStartupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wakeState, setWakeState] = useState<WakeState>("idle");
  const [wakeMessage, setWakeMessage] = useState<string | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [network, setNetwork] = useState<"mainnet" | "testnet">("mainnet");

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextAccess, nextStartup] = await Promise.all([
        getHyperliquidLiveAccess() as Promise<LiveAccess>,
        getPublicAgentStartupStatus(),
      ]);
      setAccess(nextAccess);
      setStartup(nextStartup);
      if (nextStartup.runtime.ready) {
        setWakeState("ready");
        setWakeMessage("Secure worker is ready.");
      } else if (nextStartup.runtime.status === "blocked") {
        setWakeState("error");
        setWakeMessage(investorFacingErrorMessage(nextStartup.runtime.message, "Secure worker setup is blocked. Recheck access, then retry."));
      }
    } catch (error) {
      setLoadError(investorFacingErrorMessage(error, "Setup status is unavailable."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (wakeState !== "warming") return;
    let cancelled = false;
    let timer: number | null = null;
    let pollCount = 0;
    const poll = () => {
      timer = window.setTimeout(() => {
        void getPublicAgentStartupStatus().then((next) => {
          if (cancelled) return;
          setStartup(next);
          if (next.runtime.ready) {
            setWakeState("ready");
            setWakeMessage("Secure worker is ready.");
            setConnectionEpoch((value) => value + 1);
            return;
          }
          if (next.runtime.status === "blocked") {
            setWakeState("error");
            setWakeMessage(investorFacingErrorMessage(next.runtime.message, "Secure worker setup is blocked. Recheck access, then retry."));
            return;
          }
          pollCount += 1;
          if (pollCount >= WORKER_WARM_MAX_POLLS) {
            setWakeState("error");
            setWakeMessage("Secure worker did not become ready in time. Recheck access, then retry.");
            return;
          }
          poll();
        }).catch((error) => {
          if (cancelled) return;
          setWakeState("error");
          setWakeMessage(investorFacingErrorMessage(error, "Secure worker status could not be checked. Retry when ready."));
        });
      }, WORKER_WARM_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [wakeState]);

  const eligibilityReady = access?.eligibility_ready === true;
  const runtimeReady = startup?.runtime.ready === true || wakeState === "ready";

  async function wakeForSetup() {
    if (!eligibilityReady || wakeState === "waking") return;
    if (!await investorAccess.ensureReady()) return;
    setWakeState("waking");
    setWakeMessage("Starting attested setup compute. This can take about a minute.");
    try {
      const wake = await wakePublicAgentWorker();
      setWakeMessage(wake.message);
      const next = await getPublicAgentStartupStatus();
      setStartup(next);
      if (wake.ready || next.runtime.ready) {
        setWakeState("ready");
        setWakeMessage("Secure worker is ready.");
        setConnectionEpoch((value) => value + 1);
      } else if (wake.status === "blocked" || next.runtime.status === "blocked") {
        setWakeState("error");
        setWakeMessage(investorFacingErrorMessage(next.runtime.message || wake.message, "Secure worker setup is blocked. Recheck access, then retry."));
      } else {
        setWakeState("warming");
      }
    } catch (error) {
      setWakeState("error");
      setWakeMessage(investorFacingErrorMessage(error, "Secure worker start failed. Recheck access, then retry."));
    }
  }

  if (loading && !access && !startup) {
    return <SetupNotice message="Checking venue and worker readiness…" loading />;
  }

  return (
    <section id="hyperliquid-setup" className="scroll-mt-6 space-y-3">
      <SetupStep number="1" title="Account access" complete>
        <p className="text-xs leading-5 text-emerald-200">
          Access was rechecked before setup
          {investorAccess.readiness.expires_at
            ? <> and expires <time dateTime={investorAccess.readiness.expires_at}>{new Date(investorAccess.readiness.expires_at).toLocaleString()}</time></>
            : ""}.
        </p>
      </SetupStep>

      <SetupStep number="2" title="Eligibility, terms, and risk" complete={eligibilityReady} id="eligibility-consent">
        {eligibilityReady ? (
          <p className="text-xs leading-5 text-emerald-200">
            Current acceptance recorded: terms {LIVE_TRADING_TERMS_VERSION} · risk {LIVE_TRADING_RISK_DISCLOSURE_VERSION}.
          </p>
        ) : (
          <EligibilityConsent onAccepted={async () => {
            const next = await getHyperliquidLiveAccess() as LiveAccess;
            setAccess(next);
          }} beforeSubmit={investorAccess.ensureReady} />
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
              disabled={wakeState === "waking" || wakeState === "warming"}
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
        ) : (
          <div key={connectionEpoch}>
            <ConnectHyperliquidButton
              ready
              network={network}
              onNetworkChange={setNetwork}
              beforeWalletAction={investorAccess.ensureReady}
              onVaultStatusChange={refresh}
            />
          </div>
        )}
      </SetupStep>

      <SetupStep number="5" title="Prove account and unlock terminal" complete={access?.graduation_ready === true}>
        {access?.graduation_ready === true ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-emerald-200">
              This account passed the current-release mainnet proof
              {access.proof_completed_at ? <> at <time dateTime={access.proof_completed_at}>{new Date(access.proof_completed_at).toLocaleString()}</time></> : ""}.
            </p>
            <Link href="/trade?flow=hyperliquid-live" className="trade-action inline-flex h-10 items-center rounded-md px-4 text-xs font-semibold">
              Open live terminal
            </Link>
          </div>
        ) : access?.vault_ready === true ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <p className="text-xs leading-5 text-[#8b95a8]">
              Run one protected real $11.00 HYPE round trip. It must fill, close reduce-only, clean its TP/SL orders, and finish flat before opening orders unlock.
            </p>
            <Link href="/trade/mainnet-e2e" className="trade-action inline-flex h-10 items-center justify-center rounded-md px-4 text-xs font-semibold">
              Run $11 proof
            </Link>
          </div>
        ) : (
          <p className="text-xs text-[#69758a]">Seal a mainnet trade-only API wallet before running the proof.</p>
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

function EligibilityConsent({
  onAccepted,
  beforeSubmit,
}: {
  onAccepted: () => Promise<void>;
  beforeSubmit: () => Promise<boolean>;
}) {
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
      if (!await beforeSubmit()) return;
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
      setError(investorFacingErrorMessage(cause, "Eligibility acceptance failed."));
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
