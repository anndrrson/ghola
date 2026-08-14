"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  openHyperliquidAccountStream,
} from "./private-account-client";
import {
  deriveTerminalLiveAccountView,
  terminalLiveAccountFreshnessDeadline,
} from "./terminal-live-account";
import {
  terminalLiveAccountPublicationPriority,
  terminalLiveAccountSubjectScopeValid,
  terminalLiveAccountStreamKey,
  transitionTerminalLiveAccountStreamState,
  type TerminalLiveAccountStreamState,
} from "./terminal-live-account-stream";

export function useTerminalLiveAccount(input: {
  authenticated: boolean;
  subjectScope: string | null;
  selectedVenue: string;
  expectedNetwork: "mainnet" | "testnet";
  coin: "BTC" | "ETH" | "SOL" | "HYPE";
  restartKey?: number;
}) {
  const key = terminalLiveAccountStreamKey(input);
  const subjectCurrent = terminalLiveAccountSubjectScopeValid(input.subjectScope);
  const token = useMemo(() => Symbol(key), [key]);
  const selectedTokenRef = useRef(token);
  selectedTokenRef.current = token;
  const [state, setState] = useState<TerminalLiveAccountStreamState>(() => ({
    token,
    key,
    snapshot: null,
    status: null,
    snapshotObservedAtMs: null,
    orderEvents: [],
  }));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!input.authenticated || !subjectCurrent || input.selectedVenue !== "hyperliquid") return;
    let timer: number | null = null;
    const schedule = () => {
      if (timer != null) window.clearTimeout(timer);
      if (document.hidden) return;
      const now = Date.now();
      setNowMs(now);
      const activeSnapshot = state.token === token ? state.snapshot : null;
      const activeObservedAt = state.token === token ? state.snapshotObservedAtMs : null;
      const deadline = terminalLiveAccountFreshnessDeadline({
        snapshotCheckedAt: activeSnapshot?.last_checked_at,
        streamObservedAtMs: activeObservedAt,
      });
      const delay = deadline != null && deadline > now ? deadline - now : 5_000;
      timer = window.setTimeout(schedule, Math.max(1, delay));
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [input.authenticated, input.selectedVenue, state.snapshot, state.snapshotObservedAtMs, state.token, subjectCurrent, token]);

  useEffect(() => {
    if (!input.authenticated || !subjectCurrent || input.selectedVenue !== "hyperliquid") return;
    let active = true;
    const stream = openHyperliquidAccountStream({
      coin: input.coin,
      onState: (snapshot) => {
        if (!active) return;
        const observedAtMs = Date.now();
        setNowMs(observedAtMs);
        const update = (current: TerminalLiveAccountStreamState) => transitionTerminalLiveAccountStreamState({
          current,
          selectedToken: selectedTokenRef.current,
          eventToken: token,
          key,
          event: { type: "snapshot", snapshot, observedAtMs },
        });
        if (terminalLiveAccountPublicationPriority("snapshot") === "urgent") setState(update);
      },
      onStatus: (status) => {
        if (!active) return;
        setState((current) => transitionTerminalLiveAccountStreamState({
          current,
          selectedToken: selectedTokenRef.current,
          eventToken: token,
          key,
          event: { type: "status", status },
        }));
      },
      onEvent: (raw) => {
        if (!active) return;
        const observedAtMs = Date.now();
        const update = (current: TerminalLiveAccountStreamState) => transitionTerminalLiveAccountStreamState({
          current,
          selectedToken: selectedTokenRef.current,
          eventToken: token,
          key,
          event: { type: "account_event", raw, observedAtMs },
        });
        if (terminalLiveAccountPublicationPriority("account_event") === "deferred") {
          startTransition(() => setState(update));
        }
      },
      onError: () => {
        if (!active) return;
        setState((current) => transitionTerminalLiveAccountStreamState({
          current,
          selectedToken: selectedTokenRef.current,
          eventToken: token,
          key,
          event: { type: "status", status: "reconnecting" },
        }));
      },
    });
    return () => {
      active = false;
      stream.close();
    };
  }, [input.authenticated, input.coin, input.selectedVenue, key, subjectCurrent, token]);

  const current = state.token === token
    ? state
    : { token, key, snapshot: null, status: null, snapshotObservedAtMs: null, orderEvents: [] };
  return useMemo(() => deriveTerminalLiveAccountView({
    authenticated: input.authenticated,
    selectedVenue: input.selectedVenue,
    expectedNetwork: input.expectedNetwork,
    snapshot: current.snapshot,
    streamStatus: current.status,
    streamObservedAtMs: current.snapshotObservedAtMs,
    nowMs,
    orderEvents: current.orderEvents,
  }), [current.orderEvents, current.snapshot, current.snapshotObservedAtMs, current.status, input.authenticated, input.expectedNetwork, input.selectedVenue, nowMs]);
}
