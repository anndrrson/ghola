import type { TerminalRouteCandidate, TerminalRouteDecision } from "./terminal-route-decision";

export interface TerminalRouteImprovement {
  improvementBps: number;
  improvementUsd: number;
  selectedVenue: string;
  selectedVwap: number;
  peerVenue: string;
  peerVwap: number;
}

/**
 * Compares only fresh, compatible candidates already certified by the route
 * decision. Both selected and peer routes must visibly fill the entire order.
 */
export function deriveTerminalRouteImprovement(
  decision: TerminalRouteDecision,
  selectedVenue: string,
): TerminalRouteImprovement | null {
  if (decision.blocker || !selectedVenue.trim()) return null;
  const selected = fullCandidate(decision.candidates.find((candidate) => candidate.venue === selectedVenue));
  if (!selected) return null;
  const peers = decision.candidates.filter((candidate) => candidate.venue !== selectedVenue).flatMap((candidate) => {
    const full = fullCandidate(candidate);
    return full ? [full] : [];
  });
  if (peers.length === 0) return null;
  const peer = peers.reduce((best, candidate) => better(decision.side, candidate, best) ? candidate : best);
  const rawBps = decision.side === "buy"
    ? ((selected.vwap - peer.vwap) / selected.vwap) * 10_000
    : ((peer.vwap - selected.vwap) / selected.vwap) * 10_000;
  const targetBaseSize = decision.requestedNotionalUsd / decision.limitPrice;
  const rawUsd = decision.side === "buy"
    ? (selected.vwap - peer.vwap) * targetBaseSize
    : (peer.vwap - selected.vwap) * targetBaseSize;
  if (!Number.isFinite(rawBps) || !Number.isFinite(rawUsd) || targetBaseSize <= 0) return null;
  return {
    improvementBps: Math.max(0, rawBps),
    improvementUsd: Math.max(0, rawUsd),
    selectedVenue: selected.venue,
    selectedVwap: selected.vwap,
    peerVenue: peer.venue,
    peerVwap: peer.vwap,
  };
}

function fullCandidate(candidate: TerminalRouteCandidate | undefined) {
  return candidate
    && candidate.status === "full"
    && candidate.fillPct >= 99.999999
    && Number.isFinite(candidate.vwap)
    && candidate.vwap != null
    && candidate.vwap > 0
    ? candidate as TerminalRouteCandidate & { vwap: number }
    : null;
}

function better(
  side: TerminalRouteDecision["side"],
  candidate: TerminalRouteCandidate & { vwap: number },
  current: TerminalRouteCandidate & { vwap: number },
) {
  return side === "buy" ? candidate.vwap < current.vwap : candidate.vwap > current.vwap;
}
