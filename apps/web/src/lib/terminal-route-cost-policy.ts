import type { TerminalRouteCandidate, TerminalRouteDecision } from "./terminal-route-decision";
import type { TerminalMarketVenue } from "./terminal-market-identity";

export const TERMINAL_ROUTE_COST_POLICY_VERSION = 1 as const;
export const TERMINAL_ROUTE_COST_POLICY_PREFIX = "ghola.terminal-route-cost.v1:";
export const TERMINAL_ROUTE_COST_MAX_BPS = 500;
export const TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const TERMINAL_ROUTE_COST_VENUES = ["hyperliquid", "phoenix", "coinbase"] as const;

export type TerminalRouteCostVenue = (typeof TERMINAL_ROUTE_COST_VENUES)[number];
export type TerminalRouteCostField = "feeBps" | "bufferBps";

export interface TerminalRouteCostAssumption {
  feeBps: number;
  bufferBps: number;
}

export interface TerminalRouteCostEvidence extends TerminalRouteCostAssumption {
  status: "ready" | "missing" | "expired" | "invalid" | "blocked" | "unavailable";
  feeConfigured: boolean;
  bufferConfigured: boolean;
  feeCurrent: boolean;
  bufferCurrent: boolean;
  feeUpdatedAtMs: number | null;
  bufferUpdatedAtMs: number | null;
  ageMs: number | null;
  expiresAtMs: number | null;
}

interface TerminalRouteCostVenuePolicy extends TerminalRouteCostAssumption {
  feeUpdatedAt: number;
  bufferUpdatedAt: number;
}

export interface TerminalRouteCostPolicy {
  version: typeof TERMINAL_ROUTE_COST_POLICY_VERSION;
  clearedAt: number;
  venues: Partial<Record<TerminalRouteCostVenue, TerminalRouteCostVenuePolicy>>;
}

export type TerminalRouteCostPolicyInspection =
  | { status: "absent"; policy: TerminalRouteCostPolicy; raw: null }
  | { status: "ready"; policy: TerminalRouteCostPolicy; raw: string }
  | { status: "blocked"; policy: null; raw: string };

export interface TerminalAllInRouteRow {
  rank: number;
  candidate: TerminalRouteCandidate;
  feeBps: number;
  bufferBps: number;
  frictionBps: number;
  frictionUsd: number;
  netVwap: number | null;
}

export interface TerminalAllInRouteModel {
  status: "unavailable" | "ready";
  rows: TerminalAllInRouteRow[];
  best: TerminalAllInRouteRow | null;
  bestPeer: TerminalAllInRouteRow | null;
  selected: TerminalAllInRouteRow | null;
  improvementBps: number | null;
  improvementUsd: number | null;
}

const PERSISTENCE_SCOPE = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export function emptyTerminalRouteCostPolicy(): TerminalRouteCostPolicy {
  return { version: TERMINAL_ROUTE_COST_POLICY_VERSION, clearedAt: 0, venues: {} };
}

export function terminalRouteCostPolicyStorageKey(scope: string | null | undefined): string | null {
  return typeof scope === "string" && PERSISTENCE_SCOPE.test(scope)
    ? `${TERMINAL_ROUTE_COST_POLICY_PREFIX}${scope}`
    : null;
}

export function inspectTerminalRouteCostPolicy(raw: string | null | undefined): TerminalRouteCostPolicyInspection {
  if (!raw) return { status: "absent", policy: emptyTerminalRouteCostPolicy(), raw: null };
  try {
    const policy = validatePolicy(JSON.parse(raw));
    return policy ? { status: "ready", policy, raw } : { status: "blocked", policy: null, raw };
  } catch {
    return { status: "blocked", policy: null, raw };
  }
}

export function serializeTerminalRouteCostPolicy(policy: TerminalRouteCostPolicy): string {
  const valid = validatePolicy(policy);
  if (!valid) throw new Error("terminal_route_cost_policy_invalid");
  return JSON.stringify(valid);
}

export function mergeTerminalRouteCostPolicies(
  left: TerminalRouteCostPolicy,
  right: TerminalRouteCostPolicy,
): TerminalRouteCostPolicy {
  const validLeft = validatePolicy(left);
  const validRight = validatePolicy(right);
  if (!validLeft || !validRight) throw new Error("terminal_route_cost_policy_invalid");
  const clearedAt = Math.max(validLeft.clearedAt, validRight.clearedAt);
  const venues: TerminalRouteCostPolicy["venues"] = {};
  for (const venue of TERMINAL_ROUTE_COST_VENUES) {
    const leftValue = validLeft.venues[venue];
    const rightValue = validRight.venues[venue];
    const fee = winningField(leftValue, rightValue, "feeBps", "feeUpdatedAt", clearedAt);
    const buffer = winningField(leftValue, rightValue, "bufferBps", "bufferUpdatedAt", clearedAt);
    if (!fee && !buffer) continue;
    venues[venue] = {
      feeBps: fee?.value ?? 0,
      feeUpdatedAt: fee?.updatedAt ?? 0,
      bufferBps: buffer?.value ?? 0,
      bufferUpdatedAt: buffer?.updatedAt ?? 0,
    };
  }
  return { version: TERMINAL_ROUTE_COST_POLICY_VERSION, clearedAt, venues };
}

export function updateTerminalRouteCostPolicy(input: {
  policy: TerminalRouteCostPolicy;
  venue: TerminalRouteCostVenue;
  field: TerminalRouteCostField;
  value: unknown;
  nowMs?: number;
}): TerminalRouteCostPolicy {
  const policy = validatePolicy(input.policy);
  const value = boundedBps(input.value);
  const requestedNow = validRevision(input.nowMs ?? Date.now());
  if (!policy || value == null || requestedNow == null || !TERMINAL_ROUTE_COST_VENUES.includes(input.venue)) {
    throw new Error("terminal_route_cost_policy_input_invalid");
  }
  const current = policy.venues[input.venue] ?? {
    feeBps: 0,
    bufferBps: 0,
    feeUpdatedAt: 0,
    bufferUpdatedAt: 0,
  };
  const revisionField = input.field === "feeBps" ? "feeUpdatedAt" : "bufferUpdatedAt";
  const revision = Math.max(requestedNow, current[revisionField] + 1, policy.clearedAt + 1);
  if (!Number.isSafeInteger(revision)) throw new Error("terminal_route_cost_policy_revision_exhausted");
  return {
    ...policy,
    venues: {
      ...policy.venues,
      [input.venue]: { ...current, [input.field]: value, [revisionField]: revision },
    },
  };
}

export function resetTerminalRouteCostPolicy(nowMs: number = Date.now()): TerminalRouteCostPolicy {
  const clearedAt = validRevision(nowMs);
  if (clearedAt == null) throw new Error("terminal_route_cost_policy_reset_invalid");
  return { version: TERMINAL_ROUTE_COST_POLICY_VERSION, clearedAt, venues: {} };
}

export function terminalRouteCostAssumption(
  policy: TerminalRouteCostPolicy,
  venue: TerminalRouteCostVenue,
): TerminalRouteCostAssumption {
  const valid = validatePolicy(policy);
  if (!valid) throw new Error("terminal_route_cost_policy_invalid");
  const row = valid.venues[venue];
  return { feeBps: row?.feeBps ?? 0, bufferBps: row?.bufferBps ?? 0 };
}

/** Distinguishes an explicit zero assumption from an untouched default. */
export function terminalRouteCostEvidence(
  inspection: TerminalRouteCostPolicyInspection,
  venue: TerminalRouteCostVenue,
  nowMs: number = Date.now(),
): TerminalRouteCostEvidence {
  const empty = (status: TerminalRouteCostEvidence["status"]): TerminalRouteCostEvidence => ({
    status,
    feeBps: 0,
    bufferBps: 0,
    feeConfigured: false,
    bufferConfigured: false,
    feeCurrent: false,
    bufferCurrent: false,
    feeUpdatedAtMs: null,
    bufferUpdatedAtMs: null,
    ageMs: null,
    expiresAtMs: null,
  });
  if (inspection.status === "blocked") {
    return empty("blocked");
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) return empty("unavailable");
  const row = inspection.policy.venues[venue];
  const feeConfigured = (row?.feeUpdatedAt ?? 0) > inspection.policy.clearedAt;
  const bufferConfigured = (row?.bufferUpdatedAt ?? 0) > inspection.policy.clearedAt;
  const feeUpdatedAt = row?.feeUpdatedAt ?? 0;
  const bufferUpdatedAt = row?.bufferUpdatedAt ?? 0;
  const clockFuture = feeConfigured && feeUpdatedAt > nowMs + 30_000
    || bufferConfigured && bufferUpdatedAt > nowMs + 30_000;
  const feeAgeMs = feeConfigured ? Math.max(0, nowMs - feeUpdatedAt) : null;
  const bufferAgeMs = bufferConfigured ? Math.max(0, nowMs - bufferUpdatedAt) : null;
  const feeCurrent = feeAgeMs != null && feeAgeMs <= TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS;
  const bufferCurrent = bufferAgeMs != null && bufferAgeMs <= TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS;
  const configuredAges = [feeAgeMs, bufferAgeMs].filter((value): value is number => value != null);
  const configuredTimes = [feeConfigured ? feeUpdatedAt : null, bufferConfigured ? bufferUpdatedAt : null]
    .filter((value): value is number => value != null);
  return {
    status: clockFuture
      ? "invalid"
      : !feeConfigured || !bufferConfigured
        ? "missing"
        : feeCurrent && bufferCurrent
          ? "ready"
          : "expired",
    feeBps: row?.feeBps ?? 0,
    bufferBps: row?.bufferBps ?? 0,
    feeConfigured,
    bufferConfigured,
    feeCurrent,
    bufferCurrent,
    feeUpdatedAtMs: feeConfigured ? feeUpdatedAt : null,
    bufferUpdatedAtMs: bufferConfigured ? bufferUpdatedAt : null,
    ageMs: configuredAges.length ? Math.max(...configuredAges) : null,
    expiresAtMs: configuredTimes.length
      ? Math.min(...configuredTimes) + TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 1
      : null,
  };
}

export function terminalRouteCostPolicyNextExpiry(policy: TerminalRouteCostPolicy, nowMs: number) {
  const valid = validatePolicy(policy);
  if (!valid || !Number.isFinite(nowMs) || nowMs < 0) return null;
  const deadlines = Object.values(valid.venues)
    .flatMap((row) => [row?.feeUpdatedAt ?? 0, row?.bufferUpdatedAt ?? 0])
    .filter((updatedAt) => updatedAt > valid.clearedAt)
    .map((updatedAt) => updatedAt + TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 1)
    .filter((deadline) => deadline > nowMs);
  return deadlines.length ? Math.min(...deadlines) : null;
}

/** Ranks certified visible fills by user-supplied friction after preserving fill priority. */
export function deriveTerminalAllInRouteModel(input: {
  decision: TerminalRouteDecision;
  policy: TerminalRouteCostPolicy;
  selectedVenue: string;
  nowMs?: number;
}): TerminalAllInRouteModel {
  const policy = validatePolicy(input.policy);
  if (!policy || input.decision.blocker != null || input.decision.candidates.length === 0) return unavailableModel();
  const inspection: TerminalRouteCostPolicyInspection = { status: "ready", policy, raw: "" };
  if (input.decision.candidates.some((candidate) => {
    const venue = routeCostVenue(candidate.venue);
    return venue == null || terminalRouteCostEvidence(inspection, venue, input.nowMs).status !== "ready";
  })) return unavailableModel();
  const rows = input.decision.candidates.map((candidate) => {
    const venue = routeCostVenue(candidate.venue);
    const assumption = venue ? terminalRouteCostAssumption(policy, venue) : { feeBps: 0, bufferBps: 0 };
    const frictionBps = assumption.feeBps + assumption.bufferBps;
    const vwap = positive(candidate.vwap);
    const netVwap = vwap == null
      ? null
      : input.decision.side === "buy"
        ? vwap * (1 + frictionBps / 10_000)
        : vwap * (1 - frictionBps / 10_000);
    return {
      rank: 0,
      candidate,
      ...assumption,
      frictionBps,
      frictionUsd: candidate.filledNotionalUsd * frictionBps / 10_000,
      netVwap,
    };
  }).sort(allInComparator(input.decision.side)).map((row, index) => ({ ...row, rank: index + 1 }));
  const best = rows.find((row) => row.candidate.fillPct > 0 && row.netVwap != null) ?? null;
  const selected = rows.find((row) => row.candidate.venue === input.selectedVenue) ?? null;
  const bestPeer = rows.find((row) => row.candidate.venue !== input.selectedVenue && row.candidate.status === "full" && row.netVwap != null) ?? null;
  const improvement = fullFillImprovement(input.decision.side, bestPeer, selected);
  return {
    status: "ready",
    rows,
    best,
    bestPeer,
    selected,
    improvementBps: improvement?.bps ?? null,
    improvementUsd: improvement?.usd ?? null,
  };
}

function fullFillImprovement(
  side: "buy" | "sell",
  peer: TerminalAllInRouteRow | null,
  selected: TerminalAllInRouteRow | null,
) {
  if (
    !peer
    || !selected
    || peer.candidate.status !== "full"
    || selected.candidate.status !== "full"
    || peer.netVwap == null
    || selected.netVwap == null
  ) return null;
  const priceAdvantage = side === "buy"
    ? selected.netVwap - peer.netVwap
    : peer.netVwap - selected.netVwap;
  const baseSize = selected.candidate.vwap == null || selected.candidate.vwap <= 0
    ? null
    : selected.candidate.filledNotionalUsd / selected.candidate.vwap;
  if (baseSize == null || !Number.isFinite(baseSize)) return null;
  return {
    bps: Math.max(0, priceAdvantage / selected.netVwap * 10_000),
    usd: Math.max(0, priceAdvantage * baseSize),
  };
}

function allInComparator(side: "buy" | "sell") {
  return (left: Omit<TerminalAllInRouteRow, "rank">, right: Omit<TerminalAllInRouteRow, "rank">) => {
    if (left.candidate.fillPct !== right.candidate.fillPct) return right.candidate.fillPct - left.candidate.fillPct;
    if (left.netVwap == null || right.netVwap == null) {
      if (left.netVwap == null && right.netVwap != null) return 1;
      if (right.netVwap == null && left.netVwap != null) return -1;
    } else if (left.netVwap !== right.netVwap) {
      return side === "buy" ? left.netVwap - right.netVwap : right.netVwap - left.netVwap;
    }
    if (left.candidate.bookAgeMs !== right.candidate.bookAgeMs) return left.candidate.bookAgeMs - right.candidate.bookAgeMs;
    return left.candidate.rank - right.candidate.rank;
  };
}

function unavailableModel(): TerminalAllInRouteModel {
  return { status: "unavailable", rows: [], best: null, bestPeer: null, selected: null, improvementBps: null, improvementUsd: null };
}

function winningField(
  left: TerminalRouteCostVenuePolicy | undefined,
  right: TerminalRouteCostVenuePolicy | undefined,
  valueField: TerminalRouteCostField,
  revisionField: "feeUpdatedAt" | "bufferUpdatedAt",
  clearedAt: number,
) {
  const candidates = [left, right]
    .filter((value): value is TerminalRouteCostVenuePolicy => value != null && value[revisionField] > clearedAt)
    .sort((a, b) => b[revisionField] - a[revisionField] || b[valueField] - a[valueField]);
  const winner = candidates[0];
  return winner ? { value: winner[valueField], updatedAt: winner[revisionField] } : null;
}

function validatePolicy(value: unknown): TerminalRouteCostPolicy | null {
  const row = record(value);
  const venuesRow = record(row?.venues);
  const clearedAt = validRevision(row?.clearedAt);
  if (!row || row.version !== TERMINAL_ROUTE_COST_POLICY_VERSION || !venuesRow || clearedAt == null) return null;
  if (Object.keys(venuesRow).some((venue) => !TERMINAL_ROUTE_COST_VENUES.includes(venue as TerminalRouteCostVenue))) return null;
  const venues: TerminalRouteCostPolicy["venues"] = {};
  for (const venue of TERMINAL_ROUTE_COST_VENUES) {
    const raw = venuesRow[venue];
    if (raw == null) continue;
    const candidate = record(raw);
    const feeBps = boundedBps(candidate?.feeBps);
    const bufferBps = boundedBps(candidate?.bufferBps);
    const feeUpdatedAt = validRevision(candidate?.feeUpdatedAt);
    const bufferUpdatedAt = validRevision(candidate?.bufferUpdatedAt);
    if (!candidate || feeBps == null || bufferBps == null || feeUpdatedAt == null || bufferUpdatedAt == null) return null;
    if ((feeUpdatedAt !== 0 && feeUpdatedAt <= clearedAt) || (bufferUpdatedAt !== 0 && bufferUpdatedAt <= clearedAt)) return null;
    if (feeUpdatedAt === 0 && feeBps !== 0 || bufferUpdatedAt === 0 && bufferBps !== 0) return null;
    if (feeUpdatedAt === 0 && bufferUpdatedAt === 0) continue;
    venues[venue] = { feeBps, bufferBps, feeUpdatedAt, bufferUpdatedAt };
  }
  return { version: TERMINAL_ROUTE_COST_POLICY_VERSION, clearedAt, venues };
}

function routeCostVenue(value: TerminalMarketVenue): TerminalRouteCostVenue | null {
  return TERMINAL_ROUTE_COST_VENUES.includes(value as TerminalRouteCostVenue) ? value as TerminalRouteCostVenue : null;
}

function boundedBps(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= TERMINAL_ROUTE_COST_MAX_BPS
    ? value
    : null;
}

function validRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
