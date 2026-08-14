"use client";

import { useEffect, useRef, useState } from "react";

type E2EState = "idle" | "arming" | "watching" | "executed" | "killing" | "killed" | "error";
type EventRecord = { event_id?: string; type?: string; message?: string; data?: Record<string, unknown> };

const PLAN = {
  strategy_id: "level_trigger_v1",
  agent_side: "buy",
  agent_mandate: {
    strategy_profile: "breakout_retest",
    entry_trigger: "break_level",
    exit_rule: "exit_on_invalidation",
    time_horizon: "until_invalidated",
    trigger_level: "100",
    invalidation_level: "95",
  },
  venue_allowlist: ["hyperliquid"],
  market_allowlist: ["HYPE-USD"],
  execution_network: "testnet",
  exact_notional_usd: "26",
  max_notional_bucket: "50",
  max_daily_notional_bucket: "100",
  max_order_count: 2,
  max_slippage_bps: 25,
  data_max_age_ms: 5_000,
};

export function LocalExecutionE2E({ claimStore }: { claimStore: "Postgres" | "SQLite" }) {
  const [state, setState] = useState<E2EState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workerSessionId, setWorkerSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => () => { stopped.current = true; }, []);

  async function request(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer ghola-local-e2e",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
    return payload;
  }

  async function arm() {
    stopped.current = false;
    setState("arming");
    setError(null);
    setEvents([]);
    try {
      const created = await request("/v1/private-account/autopilot/sessions", {
        session_policy: PLAN,
        venue_access: {
          hyperliquid: { status: "ready", execution_mode: "byo_api_key", reason: "local_e2e_dry_run" },
        },
      });
      const session = created.session as Record<string, unknown>;
      const id = String(session.autopilot_session_id || "");
      if (!id) throw new Error("session_id_missing");
      setSessionId(id);
      setWorkerSessionId(String(session.worker_autopilot_session_id || ""));
      setState("watching");
      await pollUntilExecuted(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "arm_failed");
      setState("error");
    }
  }

  async function pollUntilExecuted(id: string) {
    for (let attempt = 0; attempt < 30 && !stopped.current; attempt += 1) {
      const payload = await request(`/v1/private-account/autopilot/sessions/${encodeURIComponent(id)}`);
      const nextEvents = Array.isArray(payload.events) ? payload.events as EventRecord[] : [];
      setEvents(nextEvents);
      if (nextEvents.some((event) => event.type === "live_order_submitted")) {
        setState("executed");
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error("execution_receipt_timeout");
  }

  async function kill() {
    if (!sessionId) return;
    setState("killing");
    setError(null);
    try {
      const payload = await request(`/v1/private-account/autopilot/sessions/${encodeURIComponent(sessionId)}/kill`, {});
      const session = payload.session as Record<string, unknown>;
      if (session.status !== "killed" || session.execution_enabled !== false) throw new Error("kill_not_acknowledged");
      setState("killed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "kill_failed");
      setState("error");
    }
  }

  const receipt = events.find((event) => event.type === "receipt");
  return (
    <main className="min-h-screen bg-[#05070b] p-6 font-mono text-[#dce6f4]">
      <section className="mx-auto max-w-4xl rounded-lg border border-[#223149] bg-[#090d14] p-6">
        <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">Local execution proof · zero broadcast</p>
        <h1 className="mt-2 text-2xl font-semibold">HYPE testnet level-trigger E2E</h1>
        <p className="mt-2 text-sm text-[#8d9bb1]">UI → Next guard → worker → {claimStore} claim → Hyperliquid dry-run adapter → receipt → kill ACK.</p>
        <dl className="mt-6 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Network" value="testnet" />
          <Metric label="Market" value="HYPE" />
          <Metric label="Exact notional" value="$26" />
          <Metric label="Trigger / invalidation" value="100 / 95" />
        </dl>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={arm} disabled={["arming", "watching", "killing"].includes(state)} className="rounded bg-cyan-400 px-4 py-2 font-semibold text-black disabled:opacity-40">Arm and prove</button>
          <button type="button" onClick={kill} disabled={!sessionId || state === "killing" || state === "killed"} className="rounded border border-rose-300/50 px-4 py-2 text-rose-200 disabled:opacity-40">Kill and require ACK</button>
        </div>
        <p role="status" className="mt-4 text-sm">State: <strong data-testid="e2e-state">{state}</strong></p>
        {error ? <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p> : null}
        <div className="mt-6 grid gap-2 text-xs">
          <p>Local session: {sessionId || "—"}</p>
          <p>Worker session: {workerSessionId || "—"}</p>
          <p>Receipt: {receipt ? String(receipt.data?.work_order_commitment || "recorded") : "—"}</p>
        </div>
        <ol className="mt-6 max-h-80 overflow-auto border-t border-[#223149] pt-4 text-xs">
          {events.map((event, index) => <li key={event.event_id || index} className="mb-2"><span className="text-cyan-300">{event.type}</span> · {event.message}</li>)}
        </ol>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-[#223149] p-3"><dt className="text-[9px] uppercase text-[#66738c]">{label}</dt><dd className="mt-1 text-cyan-100">{value}</dd></div>;
}
