import type {
  HyperliquidAccountSnapshot,
  HyperliquidAccountStreamStatus,
} from "./private-account-client";
import {
  ingestTerminalLiveAccountOrderEvent,
  type TerminalLiveAccountOrderEvent,
} from "./terminal-live-account-events";

export interface TerminalLiveAccountStreamState {
  token: symbol;
  key: string;
  snapshot: HyperliquidAccountSnapshot | null;
  status: HyperliquidAccountStreamStatus | null;
  snapshotObservedAtMs: number | null;
  orderEvents: readonly TerminalLiveAccountOrderEvent[];
}

export type TerminalLiveAccountStreamEvent =
  | { type: "snapshot"; snapshot: HyperliquidAccountSnapshot; observedAtMs: number }
  | { type: "status"; status: HyperliquidAccountStreamStatus }
  | { type: "account_event"; raw: unknown; observedAtMs: number };

export function terminalLiveAccountPublicationPriority(
  type: TerminalLiveAccountStreamEvent["type"] | "freshness_clock",
) {
  return type === "account_event" ? "deferred" as const : "urgent" as const;
}

export function terminalLiveAccountStreamKey(input: {
  authenticated: boolean;
  subjectScope: string | null;
  selectedVenue: string;
  expectedNetwork: "mainnet" | "testnet";
  coin: "BTC" | "ETH" | "SOL" | "HYPE";
  restartKey?: number;
}) {
  const subject = terminalLiveAccountSubjectScopeValid(input.subjectScope)
    ? input.subjectScope
    : "subject_unavailable";
  return `${subject}:${input.authenticated}:${input.selectedVenue}:${input.expectedNetwork}:${input.coin}:${input.restartKey ?? 0}`;
}

export function terminalLiveAccountSubjectScopeValid(value: string | null | undefined): value is string {
  return typeof value === "string" && /^subject_[a-f0-9]{32}$/u.test(value);
}

/** Selection-token equality prevents delayed A→B→A stream callbacks from publishing. */
export function transitionTerminalLiveAccountStreamState(input: {
  current: TerminalLiveAccountStreamState;
  selectedToken: symbol;
  eventToken: symbol;
  key: string;
  event: TerminalLiveAccountStreamEvent;
}): TerminalLiveAccountStreamState {
  if (input.eventToken !== input.selectedToken) return input.current;
  if (input.event.type === "account_event") {
    return {
      token: input.eventToken,
      key: input.key,
      snapshot: input.current.token === input.eventToken ? input.current.snapshot : null,
      status: input.current.token === input.eventToken ? input.current.status : null,
      snapshotObservedAtMs: input.current.token === input.eventToken ? input.current.snapshotObservedAtMs : null,
      orderEvents: ingestTerminalLiveAccountOrderEvent(
        input.current.token === input.eventToken ? input.current.orderEvents : [],
        input.event.raw,
        input.event.observedAtMs,
      ),
    };
  }
  if (input.event.type === "snapshot") {
    if (!Number.isFinite(input.event.observedAtMs) || input.event.observedAtMs < 0) return input.current;
    return {
      token: input.eventToken,
      key: input.key,
      snapshot: input.event.snapshot,
      status: input.event.snapshot.stream_status ?? (input.current.token === input.eventToken ? input.current.status : null),
      snapshotObservedAtMs: input.event.observedAtMs,
      orderEvents: input.current.token === input.eventToken ? input.current.orderEvents : [],
    };
  }
  return {
    token: input.eventToken,
    key: input.key,
    snapshot: input.current.token === input.eventToken ? input.current.snapshot : null,
    status: input.event.status,
    snapshotObservedAtMs: input.current.token === input.eventToken
      ? input.current.snapshotObservedAtMs
      : null,
    orderEvents: input.current.token === input.eventToken ? input.current.orderEvents : [],
  };
}
