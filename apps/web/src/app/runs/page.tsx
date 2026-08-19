"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Gauge,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Skull,
  Square,
  TrendingUp,
  Zap,
} from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import {
  controlPrivateAutopilotSession,
  createPrivateAutopilotSession,
  getPrivateAutopilotSession,
  killAndFlatPrivateAutopilotSession,
  listPrivateAutopilotSessions,
  openPrivateAutopilotEventStream,
  type PrivateAutopilotEvent,
  type PrivateAutopilotSession,
  type PrivateAutopilotSessionPolicy,
} from "@/lib/private-account-client";
import { authorizePrivateAccountWalletRequest } from "@/lib/private-account-wallet-step-up";
import { useThumperAuth } from "@/lib/thumper-auth-context";

type RunMode = "active" | "aggressive" | "unchained";
type CapitalBucket = "50" | "100" | "250" | "500";
type LossBucket = "5" | "10" | "25" | "50";

type FlattenControlState =
  | { phase: "confirming"; message?: string; restoreUncertain: boolean }
  | { phase: "pending"; message?: string }
  | { phase: "refreshing"; message: string }
  | { phase: "uncertain"; message: string };

const MODES: ReadonlyArray<{
  id: RunMode;
  label: string;
  description: string;
  detail: string;
  icon: typeof Gauge;
}> = [
  {
    id: "active",
    label: "Active",
    description: "Capped directional trades with deterministic screening.",
    detail: "3% stop · 6% target · 25 bps slippage",
    icon: Gauge,
  },
  {
    id: "aggressive",
    label: "Aggressive",
    description: "AI-scored momentum across BTC, ETH, and SOL.",
    detail: "5% stop · 10% target · 50 bps slippage",
    icon: Zap,
  },
  {
    id: "unchained",
    label: "Unchained",
    description: "Maximum current engine limits and full market scanning.",
    detail: "8% stop · 16% target · 100 bps slippage",
    icon: Skull,
  },
] as const;

const CAPITAL_BUCKETS: CapitalBucket[] = ["50", "100", "250", "500"];
const LOSS_BUCKETS: LossBucket[] = ["5", "10", "25", "50"];

export default function RunsPage() {
  const auth = useThumperAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [sessions, setSessions] = useState<PrivateAutopilotSession[]>([]);
  const [mode, setMode] = useState<RunMode>("aggressive");
  const [capital, setCapital] = useState<CapitalBucket>("100");
  const [maxLoss, setMaxLoss] = useState<LossBucket>("10");
  const [creating, setCreating] = useState(false);
  const [controlling, setControlling] = useState<string | null>(null);
  const [flattenControls, setFlattenControls] = useState<Record<string, FlattenControlState>>({});
  const [sessionListStatus, setSessionListStatus] = useState<"loading" | "ready" | "uncertain">("loading");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<PrivateAutopilotEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "reconnecting" | "closed">("closed");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.authenticated) {
      setSessionListStatus("loading");
      return;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const response = await listPrivateAutopilotSessions();
        if (!cancelled) {
          setSessions(response.autopilot_sessions);
          setSessionListStatus("ready");
          setError(null);
        }
      } catch (refreshError) {
        if (!cancelled) {
          setSessionListStatus("uncertain");
          setError(messageForError(refreshError));
        }
      }
    }
    void refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [auth.authenticated]);

  useEffect(() => {
    if (!auth.authenticated || !selectedRunId) {
      setSelectedEvents([]);
      setStreamStatus("closed");
      return;
    }
    setSelectedEvents([]);
    const stream = openPrivateAutopilotEventStream({
      autopilotSessionId: selectedRunId,
      onSession: (session) => setSessions((current) => current.map((item) =>
        item.autopilot_session_id === session.autopilot_session_id ? session : item)),
      onEvent: (event) => setSelectedEvents((current) => {
        if (current.some((item) => item.event_id === event.event_id)) return current;
        return [...current, event].slice(-40);
      }),
      onStatus: setStreamStatus,
      onError: (streamError) => setError(messageForError(streamError)),
    });
    return () => stream.close();
  }, [auth.authenticated, selectedRunId]);

  async function createRun() {
    if (!auth.authenticated) {
      setAuthOpen(true);
      return;
    }
    if (newRunBlockReason) {
      setError(newRunBlockReason);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await createPrivateAutopilotSession({
        session_policy: policyForRun(mode, capital, maxLoss),
      });
      setSessions((current) => [created.session, ...current.filter((item) => item.autopilot_session_id !== created.session.autopilot_session_id)]);
    } catch (createError) {
      setError(messageForError(createError));
    } finally {
      setCreating(false);
    }
  }

  async function controlRun(session: PrivateAutopilotSession, action: "pause" | "resume" | "kill") {
    if (action === "resume" && newRunBlockReason) {
      setError(newRunBlockReason);
      return;
    }
    setControlling(session.autopilot_session_id);
    setError(null);
    try {
      const response = await controlPrivateAutopilotSession(session.autopilot_session_id, action);
      setSessions((current) => current.map((item) => item.autopilot_session_id === response.session.autopilot_session_id ? response.session : item));
    } catch (controlError) {
      setError(messageForError(controlError));
    } finally {
      setControlling(null);
    }
  }

  function updateSession(next: PrivateAutopilotSession) {
    setSessions((current) => current.map((item) =>
      item.autopilot_session_id === next.autopilot_session_id ? next : item));
  }

  function requestKillAndFlat(session: PrivateAutopilotSession) {
    const id = session.autopilot_session_id;
    setFlattenControls((current) => {
      const previous = current[id];
      return {
        ...current,
        [id]: {
          phase: "confirming",
          message: previous?.message,
          restoreUncertain: previous?.phase === "uncertain" || previous?.phase === "refreshing",
        },
      };
    });
  }

  function cancelKillAndFlat(session: PrivateAutopilotSession) {
    const id = session.autopilot_session_id;
    setFlattenControls((current) => {
      const previous = current[id];
      const next = { ...current };
      if (previous?.phase === "confirming" && previous.restoreUncertain && previous.message) {
        next[id] = { phase: "uncertain", message: previous.message };
      } else {
        delete next[id];
      }
      return next;
    });
  }

  async function killAndFlat(session: PrivateAutopilotSession) {
    const id = session.autopilot_session_id;
    const path = `/v1/private-account/autopilot/sessions/${encodeURIComponent(id)}/kill-and-flat`;
    const priorMessage = flattenControls[id]?.message;
    setFlattenControls((current) => ({
      ...current,
      [id]: { phase: "pending", message: priorMessage },
    }));
    try {
      const proofHeaders = await authorizePrivateAccountWalletRequest({ path, body: {} });
      const response = await killAndFlatPrivateAutopilotSession(id, { proofHeaders });
      if (response.session.autopilot_session_id !== id || !finalFlatProven(response.session)) {
        throw new Error("Worker did not return venue-proven final-flat evidence.");
      }
      updateSession(response.session);
      setFlattenControls((current) => withoutKey(current, id));
    } catch (flattenError) {
      const message = messageForError(flattenError);
      let latest = session;
      try {
        const refreshed = await getPrivateAutopilotSession(id);
        latest = refreshed.session;
        updateSession(latest);
        if (finalFlatProven(latest)) {
          setFlattenControls((current) => withoutKey(current, id));
          return;
        }
      } catch {
        // Keep the last known session visible and fail closed until a later refresh.
      }
      setFlattenControls((current) => ({
        ...current,
        [id]: { phase: "uncertain", message },
      }));
    }
  }

  async function refreshFlattenOutcome(session: PrivateAutopilotSession) {
    const id = session.autopilot_session_id;
    const message = flattenControls[id]?.message ?? "Venue final-flat evidence is still unavailable.";
    setFlattenControls((current) => ({
      ...current,
      [id]: { phase: "refreshing", message },
    }));
    try {
      const refreshed = await getPrivateAutopilotSession(id);
      updateSession(refreshed.session);
      if (finalFlatProven(refreshed.session)) {
        setFlattenControls((current) => withoutKey(current, id));
        return;
      }
      setFlattenControls((current) => ({
        ...current,
        [id]: { phase: "uncertain", message: "The worker has not supplied venue final-flat evidence." },
      }));
    } catch (refreshError) {
      setFlattenControls((current) => ({
        ...current,
        [id]: { phase: "uncertain", message: messageForError(refreshError) },
      }));
    }
  }

  const liveRuns = sessions.filter((session) => !["killed", "expired"].includes(session.status));
  const totalOrders = liveRuns.reduce((sum, session) => sum + session.order_count, 0);
  const unresolvedFlatten = Object.entries(flattenControls).some(([id, control]) => {
    const session = sessions.find((item) => item.autopilot_session_id === id);
    if (control.phase === "pending" || control.phase === "refreshing") return true;
    return !session || !finalFlatProven(session);
  });
  const riskHalted = sessions.some((session) => session.status === "risk_halted" && !finalFlatProven(session));
  const newRunBlockReason = !auth.authenticated
    ? null
    : sessionListStatus !== "ready"
      ? "Run safety state is unavailable. Refresh before starting or resuming execution."
      : riskHalted
        ? "Resolve every risk-halted session with venue final-flat evidence before starting or resuming execution."
        : unresolvedFlatten
          ? "Finish or reconcile the pending kill-and-flat control before starting or resuming execution."
          : null;

  return (
    <main className="min-h-screen bg-[#05070b] pt-16 text-[#eef1f8]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo="/runs"
      />

      <section className="border-b border-[#172235] px-5 py-12 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6f7d9a]">Autonomous capital</p>
              <h1 className="mt-4 max-w-4xl text-5xl font-semibold leading-[0.98] tracking-tight text-[#f6f8ff] sm:text-7xl">
                Trade like a ghost.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-[#9aa8bf]">
                Give your connected Hyperliquid capital a bounded mandate, cap what the agent can deploy, and kill it whenever you want. Runs cannot grant withdrawal authority.
              </p>
            </div>
            <Link href="/trade" className="inline-flex items-center gap-2 text-sm font-medium text-[#8fbfff] transition hover:text-white">
              Open advanced terminal <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-[#172235] bg-[#172235] sm:grid-cols-3">
            <Metric label="Live runs" value={String(liveRuns.length)} />
            <Metric label="Orders submitted" value={String(totalOrders)} />
            <Metric label="Control" value="Kill anytime" />
          </div>
        </div>
      </section>

      <section className="px-5 py-10 sm:px-8 lg:px-10">
        <div className="mx-auto grid max-w-7xl gap-8 xl:grid-cols-[0.9fr_1.1fr]">
          <div>
            <div className="rounded-2xl border border-[#1a2639] bg-[#0a0e16] p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5aa7ff]/10 text-[#8fc4ff]"><Bot className="h-5 w-5" /></span>
                <div>
                  <h2 className="text-lg font-semibold">New run</h2>
                  <p className="text-sm text-[#748198]">The worker enforces these limits on every proposal.</p>
                </div>
              </div>

              <fieldset className="mt-7">
                <legend className="text-xs font-medium uppercase tracking-[0.16em] text-[#6f7d9a]">Mandate</legend>
                <div className="mt-3 grid gap-3">
                  {MODES.map((option) => {
                    const Icon = option.icon;
                    const selected = option.id === mode;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setMode(option.id)}
                        className={`grid grid-cols-[2rem_1fr] gap-3 rounded-xl border p-4 text-left transition ${selected ? "border-[#5aa7ff]/70 bg-[#5aa7ff]/10" : "border-[#1a2639] bg-[#080b12] hover:border-[#31445f]"}`}
                      >
                        <Icon className={`mt-0.5 h-5 w-5 ${selected ? "text-[#8fc4ff]" : "text-[#56657c]"}`} />
                        <span>
                          <span className="block text-sm font-semibold text-[#eef1f8]">{option.label}</span>
                          <span className="mt-1 block text-sm leading-5 text-[#8b98ad]">{option.description}</span>
                          <span className="mt-2 block font-mono text-[10px] uppercase tracking-[0.1em] text-[#59677d]">{option.detail}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="mt-7">
                <legend className="text-xs font-medium uppercase tracking-[0.16em] text-[#6f7d9a]">Loss circuit</legend>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {LOSS_BUCKETS.map((bucket) => (
                    <button
                      key={bucket}
                      type="button"
                      onClick={() => setMaxLoss(bucket)}
                      className={`rounded-lg border px-2 py-3 font-mono text-sm transition ${maxLoss === bucket ? "border-red-300/60 bg-red-300/10 text-red-100" : "border-[#1a2639] text-[#7f8da4] hover:border-[#31445f]"}`}
                    >
                      -${bucket}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-[#65738a]">
                  The worker blocks new orders when marked run P&amp;L reaches this loss. It fails closed if an open position cannot be marked.
                </p>
              </fieldset>

              <fieldset className="mt-7">
                <legend className="text-xs font-medium uppercase tracking-[0.16em] text-[#6f7d9a]">Capital ceiling</legend>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {CAPITAL_BUCKETS.map((bucket) => (
                    <button
                      key={bucket}
                      type="button"
                      onClick={() => setCapital(bucket)}
                      className={`rounded-lg border px-2 py-3 font-mono text-sm transition ${capital === bucket ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-200" : "border-[#1a2639] text-[#7f8da4] hover:border-[#31445f]"}`}
                    >
                      ${bucket}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-[#65738a]">
                  This is an exposure ceiling, not a guaranteed maximum loss. Gaps, liquidation, venue failure, and slippage can exceed estimates.
                </p>
              </fieldset>

              {error && <p role="alert" className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>}

              <button
                type="button"
                onClick={createRun}
                disabled={creating || Boolean(newRunBlockReason)}
                className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#eaf3ff] text-sm font-semibold text-[#07101e] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4 fill-current" />
                {creating ? "Sealing mandate…" : auth.authenticated ? "Start run" : "Create account to start"}
              </button>
              {newRunBlockReason && (
                <p role="status" className="mt-3 text-xs leading-5 text-amber-100">
                  {newRunBlockReason}
                </p>
              )}
            </div>

            <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                <p className="text-sm leading-6 text-[#9eb0c7]">
                  Production runs use sealed, trade-only Hyperliquid API credentials. Pooled deposits and Phoenix trading remain unavailable until their custody and withdrawal rails pass readiness.
                </p>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#6f7d9a]">Your agents</p>
                <h2 className="mt-2 text-2xl font-semibold">Runs</h2>
              </div>
              <Activity className="h-5 w-5 text-[#5aa7ff]" />
            </div>

            {!auth.authenticated ? (
              <EmptyState title="Sign in to see your runs" body="Your mandates and execution receipts are scoped to your account." action={() => setAuthOpen(true)} actionLabel="Sign in" />
            ) : sessions.length === 0 ? (
              <EmptyState title="No runs yet" body="Choose a mandate and capital ceiling to create your first autonomous session." />
            ) : (
              <div className="mt-5 space-y-3">
                {sessions.map((session) => (
                  <div key={session.autopilot_session_id}>
                    <RunCard
                      session={session}
                      busy={controlling === session.autopilot_session_id}
                      flattenControl={flattenControls[session.autopilot_session_id]}
                      resumeBlocked={Boolean(newRunBlockReason)}
                      selected={selectedRunId === session.autopilot_session_id}
                      onSelect={() => setSelectedRunId((current) => current === session.autopilot_session_id ? null : session.autopilot_session_id)}
                      onControl={(action) => controlRun(session, action)}
                      onRequestKillAndFlat={() => requestKillAndFlat(session)}
                      onCancelKillAndFlat={() => cancelKillAndFlat(session)}
                      onKillAndFlat={() => killAndFlat(session)}
                      onRefreshFlattenOutcome={() => refreshFlattenOutcome(session)}
                    />
                    {selectedRunId === session.autopilot_session_id && (
                      <RunActivity
                        events={selectedEvents}
                        streamStatus={streamStatus}
                        sessionStatus={session.status}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#080b12] px-5 py-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#58667c]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-[#eef1f8]">{value}</p>
    </div>
  );
}

function RunCard({
  session,
  busy,
  flattenControl,
  resumeBlocked,
  selected,
  onSelect,
  onControl,
  onRequestKillAndFlat,
  onCancelKillAndFlat,
  onKillAndFlat,
  onRefreshFlattenOutcome,
}: {
  session: PrivateAutopilotSession;
  busy: boolean;
  flattenControl?: FlattenControlState;
  resumeBlocked: boolean;
  selected: boolean;
  onSelect: () => void;
  onControl: (action: "pause" | "resume" | "kill") => void;
  onRequestKillAndFlat: () => void;
  onCancelKillAndFlat: () => void;
  onKillAndFlat: () => void;
  onRefreshFlattenOutcome: () => void;
}) {
  const active = ["armed", "watching", "running", "pending_worker", "pending_funding"].includes(session.status);
  const resumable = session.status === "paused";
  const riskHalted = session.status === "risk_halted";
  const finalFlat = finalFlatProven(session);
  const confirmingFlat = flattenControl?.phase === "confirming";
  const flattening = flattenControl?.phase === "pending";
  const refreshingFlat = flattenControl?.phase === "refreshing";
  const flattenUncertain = flattenControl?.phase === "uncertain" || refreshingFlat;
  const flatControlBusy = flattening || refreshingFlat;
  const hyperliquidSession = session.session_policy.venue_allowlist.includes("hyperliquid");
  return (
    <article className="rounded-xl border border-[#1a2639] bg-[#090d14] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${active ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : riskHalted ? "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)]" : resumable ? "bg-amber-300" : "bg-[#4b5668]"}`} />
            <h3 className="font-semibold text-[#f3f7ff]">{strategyLabel(session)}</h3>
          </div>
          <p className="mt-2 text-sm text-[#75839a]">{session.next_step}</p>
        </div>
        <span className="rounded-full border border-[#25344a] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8391a8]">{session.status.replaceAll("_", " ")}</span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 border-y border-[#172235] py-4 sm:grid-cols-3 xl:grid-cols-6">
        <RunMetric label="Per order" value={`$${session.session_policy.max_notional_bucket}`} />
        <RunMetric label="Position cap" value={`$${session.session_policy.max_position_notional_bucket}`} />
        <RunMetric label="Loss circuit" value={`-$${session.session_policy.max_loss_bucket}`} />
        <RunMetric label="Stop / target" value={`${bpsPercent(session.session_policy.stop_loss_bps)} / ${bpsPercent(session.session_policy.take_profit_bps)}`} />
        <RunMetric label="Marked P&L" value={formatPnl(session.risk_summary?.estimated_total_pnl_usd)} />
        <RunMetric label="Orders" value={`${session.order_count}/${session.session_policy.max_order_count}`} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {session.session_policy.market_allowlist.slice(0, 4).map((market) => <span key={market} className="rounded-md bg-[#111824] px-2 py-1 font-mono text-[10px] text-[#75839a]">{market}</span>)}
        <span className="ml-auto font-mono text-[10px] text-[#4e5b70]">{shortCommitment(session.autopilot_session_id)}</span>
      </div>

      <button type="button" onClick={onSelect} className="mt-4 text-xs font-medium text-[#8fbfff] hover:text-white">
        {selected ? "Hide live receipts" : "View live receipts"}
      </button>

      {!(["killed", "expired"].includes(session.status)) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {active && <ControlButton label="Pause" icon={Pause} disabled={busy || flatControlBusy} onClick={() => onControl("pause")} />}
          {resumable && <ControlButton label="Resume" icon={Play} disabled={busy || flatControlBusy || resumeBlocked} onClick={() => onControl("resume")} />}
          <ControlButton label="Kill execution" icon={Square} disabled={busy || flatControlBusy} destructive onClick={() => onControl("kill")} />
        </div>
      )}

      {!finalFlat && hyperliquidSession && !confirmingFlat && !flattenUncertain && !riskHalted && (
        <div className="mt-2">
          <ControlButton
            label={flattening ? "Flattening at venue" : "Kill + flatten"}
            icon={flattening ? Loader2 : ShieldAlert}
            disabled={busy || flatControlBusy}
            destructive
            onClick={onRequestKillAndFlat}
          />
        </div>
      )}

      {!finalFlat && ["killed", "expired"].includes(session.status) && !flattenUncertain && !riskHalted && (
        <p className="mt-3 text-xs leading-5 text-amber-100">
          Execution is stopped. Venue flatness is unconfirmed; a stopped run is not proof of zero positions or orders.
        </p>
      )}

      {confirmingFlat && !finalFlat && (
        <div role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3 text-xs leading-5 text-rose-100">
          <p>
            This disables execution, cancels allowed Hyperliquid orders, closes allowed positions reduce-only, and waits for venue proof of zero positions and zero open orders.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onKillAndFlat} className="rounded-md border border-rose-300/30 px-3 py-2 font-semibold hover:bg-rose-300/10">
              Sign + kill + flatten
            </button>
            <button type="button" onClick={onCancelKillAndFlat} className="rounded-md border border-[#293950] px-3 py-2 text-[#a8b6cb] hover:bg-[#111824]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {(flattenUncertain || riskHalted) && !finalFlat && (
        <div role="alert" className="mt-3 rounded-lg border border-rose-400/40 bg-rose-400/10 p-3 text-xs">
          <p className="font-semibold text-rose-100">Flatten outcome unconfirmed</p>
          <p className="mt-1 leading-5 text-rose-100/80">
            New runs and resumes remain disabled until this session has venue final-flat evidence.
          </p>
          {flattenControl?.message && (
            <p className="mt-2 font-mono text-[10px] text-rose-200/80">
              Last result: {flattenControl.message}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRefreshFlattenOutcome}
              disabled={flatControlBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-300/25 px-3 py-2 font-medium text-rose-100 disabled:opacity-50"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshingFlat ? "animate-spin" : ""}`} />
              {refreshingFlat ? "Checking venue safety" : "Refresh safety state"}
            </button>
            {hyperliquidSession && !confirmingFlat && !flatControlBusy && (
              <button type="button" onClick={onRequestKillAndFlat} className="rounded-md border border-rose-300/25 px-3 py-2 font-semibold text-rose-100">
                Retry kill + flatten
              </button>
            )}
          </div>
          <p className="mt-3 leading-5 text-amber-100">
            If retry cannot reconcile, open the terminal, use each position&apos;s Close · RO control, then verify zero positions and zero open orders at Hyperliquid.
          </p>
          <Link href="/trade" className="mt-2 inline-flex text-xs font-semibold text-[#8fbfff] hover:text-white">
            Open terminal for manual close
          </Link>
        </div>
      )}

      {finalFlat && session.final_flat_evidence && (
        <div role="status" className="mt-3 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-3 text-xs text-emerald-100">
          <p className="font-semibold">Venue final-flat proven · zero open orders</p>
          <p className="mt-1 font-mono text-[10px] text-emerald-200/80">
            {session.final_flat_evidence.closes.length} reduce-only fill{session.final_flat_evidence.closes.length === 1 ? "" : "s"} · evidence {shortCommitment(session.final_flat_evidence.evidence_commitment)}
          </p>
        </div>
      )}
    </article>
  );
}

function RunActivity({ events, streamStatus, sessionStatus }: {
  events: PrivateAutopilotEvent[];
  streamStatus: "connecting" | "live" | "reconnecting" | "closed";
  sessionStatus: PrivateAutopilotSession["status"];
}) {
  const visible = events.slice(-10).reverse();
  const waitingForFunding = sessionStatus === "pending_funding";
  const statusLabel = waitingForFunding ? "waiting for funding" : streamStatus;
  return (
    <div className="mx-2 border-x border-b border-[#1a2639] bg-[#060910] p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#6f7d9a]">Execution journal</p>
        <span className={`font-mono text-[10px] uppercase ${streamStatus === "live" && !waitingForFunding ? "text-emerald-300" : "text-amber-200"}`}>{statusLabel}</span>
      </div>
      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-[#65738a]">
          {waitingForFunding
            ? "Connect a trade-only venue vault or fund the isolated venue vault to begin execution."
            : "Waiting for the worker journal…"}
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {visible.map((event) => (
            <li key={event.event_id} className="rounded-lg border border-[#172235] bg-[#090d14] px-3 py-2.5">
              <div className="flex gap-3">
                <span className="mt-0.5 shrink-0 font-mono text-[9px] uppercase text-[#61708a]">{event.type.replaceAll("_", " ")}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-5 text-[#b7c4d8]">{event.message}</p>
                  <EventFillSummary event={event} />
                </div>
                <time className="shrink-0 font-mono text-[9px] text-[#4e5b70]">{new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EventFillSummary({ event }: { event: PrivateAutopilotEvent }) {
  const summary = event.data.fill_summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const fill = summary as Record<string, unknown>;
  const count = Number(fill.fill_count || 0);
  if (!Number.isFinite(count) || count <= 0) return <p className="mt-1 font-mono text-[10px] text-[#65738a]">No fill</p>;
  const notional = Number(fill.filled_notional_usd || 0);
  const price = Number(fill.average_fill_price || 0);
  const fee = Number(fill.fee_usd || 0);
  const feeText = fill.fee_status === "pending_reconciliation"
    ? "fee pending reconciliation"
    : `fee $${fee.toFixed(4)}`;
  return (
    <p className="mt-1 font-mono text-[10px] text-emerald-200">
      {count} fill{count === 1 ? "" : "s"} · ${notional.toFixed(2)} @ {price.toLocaleString(undefined, { maximumFractionDigits: 6 })} · {feeText}
    </p>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase tracking-[0.12em] text-[#556278]">{label}</p><p className="mt-1 font-mono text-sm text-[#d8e4f5]">{value}</p></div>;
}

function ControlButton({ label, icon: Icon, disabled, destructive = false, onClick }: {
  label: string;
  icon: typeof Play;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition disabled:opacity-40 ${destructive ? "border-red-400/25 text-red-200 hover:bg-red-400/10" : "border-[#293950] text-[#a8b6cb] hover:bg-[#111824]"}`}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function EmptyState({ title, body, action, actionLabel }: { title: string; body: string; action?: () => void; actionLabel?: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-[#25344a] px-6 py-16 text-center">
      <TrendingUp className="mx-auto h-7 w-7 text-[#506079]" />
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#718097]">{body}</p>
      {action && <button type="button" onClick={action} className="mt-5 rounded-md bg-[#eaf3ff] px-4 py-2 text-sm font-semibold text-[#07101e]">{actionLabel}</button>}
    </div>
  );
}

function policyForRun(mode: RunMode, capital: CapitalBucket, maxLoss: LossBucket): Partial<PrivateAutopilotSessionPolicy> {
  const config = mode === "active"
    ? { order: "10", daily: "50", slippage: 25, stop: 300, target: 600, orders: 6, ai: false, markets: ["SOL-USD"], venues: ["hyperliquid"] }
    : mode === "aggressive"
      ? { order: "25", daily: "100", slippage: 50, stop: 500, target: 1_000, orders: 12, ai: true, markets: ["BTC-USD", "ETH-USD", "SOL-USD"], venues: ["hyperliquid"] }
      : { order: "100", daily: "250", slippage: 100, stop: 800, target: 1_600, orders: 25, ai: true, markets: ["BTC-USD", "ETH-USD", "SOL-USD"], venues: ["hyperliquid"] };
  return {
    strategy_id: "momentum_micro_trader",
    decision_model: config.ai ? "ai_direct_order_v1" : "rules_plus_ai_score",
    ai_direct_enabled: config.ai,
    venue_allowlist: config.venues as PrivateAutopilotSessionPolicy["venue_allowlist"],
    market_allowlist: config.markets,
    max_notional_bucket: config.order as PrivateAutopilotSessionPolicy["max_notional_bucket"],
    max_position_notional_bucket: capital,
    max_loss_bucket: maxLoss,
    max_daily_notional_bucket: config.daily as PrivateAutopilotSessionPolicy["max_daily_notional_bucket"],
    max_order_count: config.orders,
    ttl_ms: mode === "unchained" ? 30 * 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000,
    max_slippage_bps: config.slippage,
    stop_loss_bps: config.stop,
    take_profit_bps: config.target,
    cooldown_ms: mode === "active" ? 5 * 60_000 : 60_000,
  };
}

function bpsPercent(value: number | undefined) {
  return `${((Number(value) || 0) / 100).toFixed(1)}%`;
}

function formatPnl(value: number | undefined) {
  if (!Number.isFinite(value)) return "$0.00";
  const amount = value ?? 0;
  return `${amount >= 0 ? "+" : "-"}$${Math.abs(amount).toFixed(2)}`;
}

function strategyLabel(session: PrivateAutopilotSession) {
  if (session.strategy.strategy_id === "hedged_spread_arbitrage_v1") return "Hedged spread run";
  if (session.strategy.strategy_id === "tri_venue_market_maker_v1") return "Market-making run";
  if (session.strategy.strategy_id === "level_trigger_v1") return "Level-trigger run";
  return session.session_policy.ai_direct_enabled ? "Aggressive momentum run" : "Active momentum run";
}

function shortCommitment(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function finalFlatProven(session: PrivateAutopilotSession) {
  const evidence = session.final_flat_evidence;
  return session.status === "killed" && session.execution_enabled === false &&
    session.control_plane === "worker" && Boolean(session.worker_autopilot_session_id) &&
    evidence?.proof_kind === "hyperliquid_kill_and_flat_v1" &&
    evidence.status === "reconciled" && evidence.final_flat_proven === true &&
    evidence.account_flat === true && evidence.open_order_count === 0 &&
    Array.isArray(evidence.cancellations) && Array.isArray(evidence.closes) &&
    Boolean(evidence.evidence_commitment) && Boolean(evidence.root_work_order_commitment) &&
    Boolean(evidence.reconciled_at) && Boolean(evidence.completed_at);
}

function withoutKey<T>(value: Record<string, T>, key: string): Record<string, T> {
  const next = { ...value };
  delete next[key];
  return next;
}

function messageForError(error: unknown) {
  const message = error instanceof Error ? error.message : "Run control is unavailable.";
  return message.replaceAll("_", " ");
}
