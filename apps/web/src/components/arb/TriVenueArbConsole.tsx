"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Crosshair,
  KeyRound,
  LockKeyhole,
  Power,
  Radar,
  Send,
  ShieldCheck,
  Square,
  Wallet,
} from "lucide-react";
import { GholaMarketChart } from "@/components/private-account/GholaMarketChart";
import {
  gholaFrameFromBackpack,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaChartMode,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";
import type {
  TriVenueMarketBundle,
  TriVenueOpportunity,
  TriVenueStatus,
  TriVenueQuote,
} from "@/lib/private-account-tri-venue-arb";

type SolanaProvider = {
  connect?: () => Promise<{ publicKey?: unknown } | unknown>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<Uint8Array | { signature?: Uint8Array | number[]; publicKey?: unknown }>;
  publicKey?: unknown;
};

type ArbWindow = Window & {
  solana?: SolanaProvider;
};

type Challenge = {
  wallet_pubkey: string;
  message: string;
};

type LiveResult = {
  version: 1;
  error?: string;
  access_mode?: string;
  session?: {
    autopilot_session_id?: string;
    status?: string;
    worker_autopilot_session_id?: string | null;
    worker_session_commitment?: string | null;
    next_step?: string;
  };
  result?: Record<string, unknown> | null;
  status?: TriVenueStatus;
};

const VENUES = ["phoenix", "hyperliquid", "backpack"] as const;
type VenueId = (typeof VENUES)[number];

export function TriVenueArbConsole() {
  const [status, setStatus] = useState<TriVenueStatus | null>(null);
  const [bundle, setBundle] = useState<TriVenueMarketBundle | null>(null);
  const [wallet, setWallet] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [notProhibited, setNotProhibited] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<VenueId>("phoenix");
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [workerProbeEnabled, setWorkerProbeEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const statusPath = workerProbeEnabled
      ? "/v1/private-account/arb/tri-venue/status?probe_worker=1"
      : "/v1/private-account/arb/tri-venue/status";
    async function load() {
      try {
        const [nextStatus, nextBundle] = await Promise.all([
          fetchJson<TriVenueStatus>(statusPath),
          fetchJson<TriVenueMarketBundle>("/v1/private-account/arb/tri-venue/opportunities?market=SOL-USD&interval=1m"),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setBundle(nextBundle);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load tri-venue state.");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workerProbeEnabled]);

  const frames = useMemo(() => {
    if (!bundle) return {} as Record<VenueId, GholaMarketFrame | null>;
    return {
      phoenix: gholaFrameFromPhoenix(bundle.snapshots.phoenix),
      hyperliquid: gholaFrameFromHyperliquid(bundle.snapshots.hyperliquid),
      backpack: gholaFrameFromBackpack(bundle.snapshots.backpack),
    };
  }, [bundle]);
  const selectedFrame = frames[selectedVenue] ?? null;
  const compareFrames = VENUES
    .filter((venue) => venue !== selectedVenue)
    .map((venue) => frames[venue])
    .filter(Boolean) as GholaMarketFrame[];
  const quotes = bundle?.quotes ?? [];
  const opportunities = bundle?.opportunities ?? [];
  const bestOpportunity = opportunities.find((item) => item.status === "preflight_pass") ?? opportunities[0] ?? null;
  const ready = status?.can_live_submit === true;
  const workerStandby = status?.worker_readiness.endpoint_configured === true && status?.worker_readiness.status !== "ready";
  const workerReady = status?.worker_readiness.status === "ready";
  const workerOnline = workerReady || workerStandby;
  const liveQuoteCount = quotes.filter((quote) => quote.status === "live").length;
  const marketLive = status?.public_market_data_enabled === true || liveQuoteCount > 0;
  const phoenixGate = status?.gates.find((gate) => gate.id === "phoenix");
  const hyperliquidGate = status?.gates.find((gate) => gate.id === "hyperliquid");
  const backpackGate = status?.gates.find((gate) => gate.id === "backpack");
  const phoenixConfigured = phoenixGate
    ? phoenixGate.status === "green" || phoenixGate.reason_codes.every((reason) => reason === "worker_probe_not_requested")
    : workerOnline;
  const venueCredentialGateCount = [hyperliquidGate, backpackGate].filter((gate) => gate?.status === "red").length;
  const launchTone = ready ? "good" : marketLive && (workerOnline || phoenixConfigured) ? "accent" : "warn";
  const launchTitle = ready
    ? "Tri-venue tiny-live enabled"
    : phoenixConfigured
      ? "Live scanner plus Phoenix path online"
      : "Live scanner online; execution fail-closed";
  const launchBadge = ready
    ? "end-to-end enabled"
    : phoenixConfigured
      ? "public live path"
      : "credential gated";
  const launchCopy = ready
    ? "The agent can sign, arm, submit one bounded arb, start maker quotes, and kill resting orders under the public $5 cap."
    : "Ghola is reading live Phoenix, Hyperliquid, and Backpack books, building arb and market-maker plans, and keeping multi-venue submit fail-closed until real venue credentials are sealed into the worker.";
  const acknowledgementsReady = acceptedTerms && acceptedRisk && notProhibited;
  const canSign = Boolean(wallet && acknowledgementsReady);
  const gateReasons = status?.gates.flatMap((gate) => gate.reason_codes.map((reason) => `${gate.id}:${reason}`)) ?? [];

  async function connectWallet() {
    setWorking("wallet");
    setError(null);
    try {
      const provider = solanaProvider();
      if (!provider?.connect) throw new Error("Open this page with a Solana wallet installed.");
      const connected = await provider.connect();
      const pubkey = publicKeyString((connected as { publicKey?: unknown })?.publicKey || provider.publicKey);
      if (!pubkey) throw new Error("No Solana public key was returned.");
      setWallet(pubkey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setWorking(null);
    }
  }

  async function wakeWorker() {
    setWorking("wake");
    setError(null);
    try {
      await postJson("/v1/private-account/public-live/phoenix/wake", { venue_id: "tri_venue_sol" });
      setWorkerProbeEnabled(true);
      setStatus(await fetchJson<TriVenueStatus>("/v1/private-account/arb/tri-venue/status?probe_worker=1"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the secure worker.");
    } finally {
      setWorking(null);
    }
  }

  async function runLive(action: "arm" | "run" | "market-maker/start" | "kill") {
    if (!canSign) {
      setError("Connect a wallet and accept the live execution checks.");
      return;
    }
    if (action !== "kill" && !ready) {
      setError(`Tri-venue live is not green: ${gateReasons.slice(0, 4).map(formatReason).join(", ") || "gate unavailable"}.`);
      return;
    }
    setWorking(action);
    setError(null);
    try {
      const proof = await signFreshChallenge(wallet);
      const path = `/v1/private-account/arb/tri-venue/${action}`;
      const response = await postJson<LiveResult>(path, {
        ...proof,
        accepted_terms: acceptedTerms,
        accepted_risk: acceptedRisk,
        not_prohibited_person: notProhibited,
        jurisdiction_assertion: "self_attested_eligible",
        market: "SOL-USD",
        max_leg_notional_usd: "5",
        selected_opportunity_commitment: bestOpportunity?.commitment ?? null,
      });
      setResult(response);
      if (response.error) setError(response.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live command failed.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070b] pt-14 text-[#edf2f8]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-4 border-b border-[#172033] pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-[#91a2bc]">
              <Radar className="h-4 w-4 text-[#8bd3ff]" />
              <span>Cross-venue live agent</span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">
              Ghola Live Agent
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#aebbd0]">
              Live SOL markets feed an attested worker that turns captured intent into bounded arb plans, market-maker quotes, and a capped Phoenix execution path.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[680px] lg:grid-cols-4">
            <StatusPill label="Market" value={marketLive ? `${liveQuoteCount || 3} live feeds` : "loading"} tone={marketLive ? "good" : "warn"} />
            <StatusPill label="Worker" value={workerReady ? "ready" : workerStandby ? "on demand" : "not started"} tone={workerReady ? "good" : workerStandby ? "accent" : "muted"} />
            <StatusPill label="Phoenix" value={phoenixConfigured ? "live path" : "checking"} tone={phoenixConfigured ? "good" : "warn"} />
            <StatusPill label="Wallet" value={wallet ? short(wallet) : "not connected"} tone={wallet ? "good" : "muted"} />
          </div>
        </header>

        <section className={railClass(launchTone)}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <span className={iconClass(launchTone)}>
                {ready ? <CheckCircle2 className="h-4 w-4" /> : phoenixConfigured ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-white">
                    {launchTitle}
                  </h2>
                  <span className={badgeClass(launchTone)}>
                    {launchBadge}
                  </span>
                </div>
                <p className="mt-1 max-w-4xl text-sm leading-6 text-[#aebbd0]">
                  {launchCopy}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/trade"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-emerald-300/30 bg-emerald-300/10 px-4 text-sm font-medium text-emerald-50 transition hover:bg-emerald-300/15"
              >
                <ArrowRight className="h-4 w-4" />
                Open live trade
              </Link>
              <button
                type="button"
                onClick={() => void wakeWorker()}
                disabled={working !== null}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-sky-300/30 bg-sky-300/10 px-4 text-sm font-medium text-sky-50 transition hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                {working === "wake" ? "Starting worker" : "Start worker"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <GateMetric label="Market data" value={marketLive ? "live" : "loading"} tone={marketLive ? "good" : "warn"} />
            <GateMetric label="Phoenix path" value={phoenixConfigured ? "available" : "checking"} tone={phoenixConfigured ? "good" : "warn"} />
            <GateMetric label="Worker" value={workerReady ? "attested" : workerStandby ? "standby" : "sleeping"} tone={workerReady ? "good" : workerStandby ? "accent" : "warn"} />
            <GateMetric label="Multi-venue" value={ready ? "submit live" : `${venueCredentialGateCount || 2} gates`} tone={ready ? "good" : "warn"} />
            <GateMetric label="Public cap" value="$5 / leg" tone="good" />
          </div>

          {!ready && gateReasons.length > 0 && (
            <details className="mt-4 border-t border-amber-300/20 pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm text-amber-100">
                <span className="inline-flex items-center gap-2">
                  <LockKeyhole className="h-4 w-4" />
                  Operator credential gates
                </span>
                <span className="font-mono text-xs text-amber-100/80">{gateReasons.length} open</span>
              </summary>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {gateReasons.slice(0, 12).map((reason) => (
                  <span key={reason} className="rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-xs text-amber-100">
                    {formatReason(reason)}
                  </span>
                ))}
              </div>
            </details>
          )}

          {status?.gate_commitment && (
            <p className="mt-3 truncate font-mono text-[11px] text-[#7f90aa]">
              gate {status.gate_commitment}
              {status.checked_at ? ` · checked ${new Date(status.checked_at).toLocaleTimeString()}` : ""}
            </p>
          )}
        </section>

        <section className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#172033] bg-[#08090d] shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
            <div className="grid gap-4 border-b border-[#172033] bg-[#0b111b] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">Live venue canvas</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {VENUES.map((venue) => (
                    <button
                      key={venue}
                      type="button"
                      onClick={() => setSelectedVenue(venue)}
                      className={venue === selectedVenue ? tabClass("active") : tabClass("idle")}
                    >
                      {venueLabel(venue)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["candles", "line", "depth", "compare"] as GholaChartMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setChartMode(mode)}
                    className={mode === chartMode ? smallTabClass("active") : smallTabClass("idle")}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <GholaMarketChart
              frame={selectedFrame}
              compareFrames={compareFrames}
              mode={chartMode}
              onModeChange={setChartMode}
              size="large"
              height={520}
              label={`${venueLabel(selectedVenue)} SOL`}
            />
          </div>

          <aside className="grid gap-5">
            <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Crosshair className="h-4 w-4 text-[#8bd3ff]" />
                    Agent plan
                  </div>
                  <p className="mt-1 text-sm text-[#9fb1ca]">Delta-neutral arb first; maker quotes stay post-only and capped.</p>
                </div>
                <span className="rounded border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100">
                  $5 cap
                </span>
              </div>

              <div className="mt-4 grid gap-2">
                <PlanRow label="Market" value="SOL-USD" />
                <PlanRow label="Venues" value="Phoenix + Hype + Backpack" />
                <PlanRow label="Live submit" value={ready ? "tri-venue enabled" : "Phoenix path; multi-venue gated"} />
                <PlanRow label="Edge filter" value="25 bps net" />
                <PlanRow label="Hedge state" value="zero net SOL target" />
                <PlanRow label="Maker loop" value="2 orders, 10s TTL" />
              </div>
            </section>

            <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Wallet className="h-4 w-4 text-[#8bd3ff]" />
                  Live signer
                </div>
                <button
                  type="button"
                  onClick={() => void connectWallet()}
                  disabled={working === "wallet"}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[#2a3a55] bg-[#111827] px-3 text-sm font-medium text-white transition hover:border-[#3b5174] hover:bg-[#151f31] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Wallet className="h-4 w-4" />
                  {wallet ? "Connected" : "Connect"}
                </button>
              </div>

              <div className="mt-4 grid gap-2">
                <CheckRow checked={acceptedTerms} onChange={setAcceptedTerms} label="I accept Ghola public beta terms for live execution." />
                <CheckRow checked={acceptedRisk} onChange={setAcceptedRisk} label="I understand this can submit real orders through supported venues." />
                <CheckRow checked={notProhibited} onChange={setNotProhibited} label="I self-attest that I am legally allowed to use this feature." />
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <ActionButton icon={<KeyRound className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("arm")}>
                  {working === "arm" ? "Arming" : "Arm tiny live"}
                </ActionButton>
                <ActionButton icon={<Send className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("run")}>
                  {working === "run" ? "Running" : "Run one arb"}
                </ActionButton>
                <ActionButton icon={<Activity className="h-4 w-4" />} disabled={!ready || !canSign || working !== null} onClick={() => void runLive("market-maker/start")}>
                  {working === "market-maker/start" ? "Starting" : "Start maker"}
                </ActionButton>
                <ActionButton icon={<Square className="h-4 w-4" />} disabled={!canSign || working !== null} onClick={() => void runLive("kill")}>
                  {working === "kill" ? "Stopping" : "Kill orders"}
                </ActionButton>
              </div>

              {(error || result) && (
                <div className="mt-4 rounded-md border border-[#24324a] bg-[#070a10] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">Live result</div>
                  <p className={error ? "mt-2 text-sm text-amber-100" : "mt-2 text-sm text-emerald-100"}>
                    {error ?? result?.session?.next_step ?? result?.session?.status ?? "Command accepted."}
                  </p>
                  {result?.session?.autopilot_session_id && (
                    <p className="mt-2 truncate font-mono text-xs text-[#8ea1bf]">{result.session.autopilot_session_id}</p>
                  )}
                </div>
              )}
            </section>
          </aside>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.65fr)]">
          <VenueMatrix quotes={quotes} />
          <OpportunityRail opportunities={opportunities} />
        </section>
      </div>
    </main>
  );
}

function VenueMatrix({ quotes }: { quotes: TriVenueQuote[] }) {
  return (
    <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Venue matrix</h2>
        <span className="font-mono text-xs text-[#8ea1bf]">SOL only</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {quotes.map((quote) => (
          <article key={quote.venue_id} className="rounded-md border border-[#1a2639] bg-[#070a10] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">{quote.label}</h3>
                <p className="mt-1 font-mono text-xs text-[#7f90aa]">{quote.venue_symbol}</p>
              </div>
              <span className={quote.status === "live" ? badgeClass("good") : badgeClass("warn")}>{quote.status}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Metric label="Bid" value={quote.best_bid ?? "n/a"} tone="good" />
              <Metric label="Ask" value={quote.best_ask ?? "n/a"} tone="bad" />
              <Metric label="Spread" value={quote.spread_bps === null ? "n/a" : `${quote.spread_bps} bps`} />
              <Metric label="Funding" value={quote.funding_rate ?? "n/a"} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function OpportunityRail({ opportunities }: { opportunities: TriVenueOpportunity[] }) {
  return (
    <section className="rounded-lg border border-[#172033] bg-[#090d14] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Opportunity rail</h2>
        <span className="font-mono text-xs text-[#8ea1bf]">{opportunities.length} plans</span>
      </div>
      <div className="grid gap-3">
        {opportunities.length === 0 && (
          <div className="rounded-md border border-[#1a2639] bg-[#070a10] p-4 text-sm text-[#9fb1ca]">
            Waiting for live venue data.
          </div>
        )}
        {opportunities.slice(0, 5).map((item) => (
          <article key={item.commitment} className="rounded-md border border-[#1a2639] bg-[#070a10] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={item.status === "preflight_pass" ? badgeClass("good") : item.strategy === "market_making" ? badgeClass("accent") : badgeClass("warn")}>
                    {item.strategy === "market_making" ? "maker" : "delta-neutral"}
                  </span>
                  <span className="font-mono text-sm text-white">{item.net_edge_bps} bps net</span>
                </div>
                <p className="mt-2 text-sm text-[#9fb1ca]">
                  {item.strategy === "market_making" && item.quote_plan
                    ? `Post ${item.quote_plan.symbol} quotes on ${venueLabel(item.quote_plan.venue_id)} for 10s.`
                    : `${venueLabel(item.buy_venue)} buy / ${venueLabel(item.sell_venue)} sell under $5 cap.`}
                </p>
              </div>
              <span className={item.status === "preflight_pass" ? "text-xs text-emerald-100" : "text-xs text-amber-100"}>
                {item.status.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-3 truncate font-mono text-[11px] text-[#7f90aa]">{item.commitment}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-12 items-center gap-3 rounded-md border border-[#172033] bg-[#070a10] px-3 py-2 text-sm text-[#c4cedf]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 accent-[#8bd3ff]"
      />
      <span>{label}</span>
    </label>
  );
}

function ActionButton({
  children,
  disabled,
  icon,
  onClick,
}: {
  children: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[#2a3a55] bg-[#111827] px-3 text-sm font-medium text-white transition hover:border-[#3b5174] hover:bg-[#151f31] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      {children}
    </button>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "accent" | "muted" }) {
  return (
    <div className="rounded-md border border-[#1b2940] bg-[#090d14] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={toneText(tone)}>{value}</div>
    </div>
  );
}

function GateMetric({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "accent" }) {
  return (
    <div className="rounded-md border border-[#1a2639] bg-[#060910] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={toneText(tone)}>{value}</div>
    </div>
  );
}

function Metric({ label, value, tone = "muted" }: { label: string; value: string; tone?: "good" | "bad" | "muted" }) {
  const color = tone === "good" ? "text-emerald-100" : tone === "bad" ? "text-rose-100" : "text-white";
  return (
    <div className="rounded border border-[#172033] bg-[#05070b] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[#7f90aa]">{label}</div>
      <div className={`mt-1 truncate font-mono text-sm ${color}`}>{value}</div>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-[#172033] bg-[#070a10] px-3 py-2">
      <span className="text-sm text-[#91a2bc]">{label}</span>
      <span className="text-right font-mono text-sm text-white">{value}</span>
    </div>
  );
}

async function signFreshChallenge(wallet: string) {
  const challenge = await fetchJson<Challenge>(`/v1/private-account/arb/tri-venue/challenge?wallet_pubkey=${encodeURIComponent(wallet)}`);
  const provider = solanaProvider();
  if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
  const signature = await walletSignBytes(provider, new TextEncoder().encode(challenge.message));
  return {
    wallet_pubkey: wallet,
    message: challenge.message,
    signature_b64: bytesToBase64(signature),
  };
}

async function walletSignBytes(provider: SolanaProvider, bytes: Uint8Array): Promise<Uint8Array> {
  if (!provider.signMessage) throw new Error("Wallet message signing is required.");
  const signed = await provider.signMessage(bytes, "utf8");
  if (signed instanceof Uint8Array) return signed;
  if (signed?.signature instanceof Uint8Array) return signed.signature;
  if (Array.isArray(signed?.signature)) return Uint8Array.from(signed.signature);
  throw new Error("Wallet did not return a message signature.");
}

function solanaProvider(): SolanaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as ArbWindow).solana;
}

function publicKeyString(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: unknown }).toBase58 === "function") {
    return String((value as { toBase58: () => string }).toBase58());
  }
  if (typeof (value as { toString?: unknown }).toString === "function") return String(value);
  return "";
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(body) ?? `${res.status} ${res.statusText}`);
  return body as T;
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(responseBody) ?? `${res.status} ${res.statusText}`);
  return responseBody as T;
}

function errorMessage(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { error?: unknown }).error === "string"
    ? String((value as { error: string }).error)
    : null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function venueLabel(venue?: string) {
  if (venue === "phoenix") return "Phoenix";
  if (venue === "hyperliquid") return "Hyperliquid";
  if (venue === "backpack") return "Backpack";
  return "venue";
}

function formatReason(value: string) {
  return value.replace(/_/g, " ").replace(/:/g, " · ");
}

function short(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function railClass(tone: "good" | "warn" | "accent") {
  const toneClass = tone === "good"
    ? "border-emerald-300/30 bg-emerald-300/10"
    : tone === "accent"
      ? "border-sky-300/25 bg-sky-300/10"
      : "border-amber-300/25 bg-amber-300/10";
  return `rounded-lg border p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)] ${toneClass}`;
}

function iconClass(tone: "good" | "warn" | "accent") {
  const toneClass = tone === "good"
    ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
    : tone === "accent"
      ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
      : "border-amber-300/30 bg-amber-300/10 text-amber-100";
  return `mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${toneClass}`;
}

function badgeClass(tone: "good" | "warn" | "accent") {
  if (tone === "good") return "rounded border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100";
  if (tone === "accent") return "rounded border border-sky-300/20 bg-sky-300/10 px-2 py-1 text-xs font-medium text-sky-100";
  return "rounded border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-xs font-medium text-amber-100";
}

function tabClass(state: "active" | "idle") {
  return state === "active"
    ? "rounded-md border border-sky-300/40 bg-sky-300/15 px-3 py-2 text-sm font-medium text-white"
    : "rounded-md border border-[#24324a] bg-[#070a10] px-3 py-2 text-sm font-medium text-[#91a2bc] transition hover:text-white";
}

function smallTabClass(state: "active" | "idle") {
  return state === "active"
    ? "rounded-md border border-[#9fcfff] bg-[#b7dcff] px-3 py-2 text-sm font-medium text-[#07111c]"
    : "rounded-md border border-[#24324a] bg-[#070a10] px-3 py-2 text-sm font-medium text-[#91a2bc] transition hover:text-white";
}

function toneText(tone: "good" | "warn" | "accent" | "muted") {
  if (tone === "good") return "mt-1 truncate font-mono text-sm text-emerald-100";
  if (tone === "warn") return "mt-1 truncate font-mono text-sm text-amber-100";
  if (tone === "accent") return "mt-1 truncate font-mono text-sm text-sky-100";
  return "mt-1 truncate font-mono text-sm text-[#c4cedf]";
}
