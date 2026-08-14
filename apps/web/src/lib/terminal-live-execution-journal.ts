import { sha256 } from "@noble/hashes/sha256";
import type { TerminalLiveExecutionReceipt } from "./terminal-live-execution-receipt";
import { validateTradeOrderPlan, type TradeOrderPlan } from "./trade-order-plan";

export const TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT = 12;
export const TERMINAL_LIVE_EXECUTION_LEGACY_JOURNAL_STORAGE_KEY = "ghola.terminal.live-execution-journal.v1";
export const TERMINAL_LIVE_EXECUTION_LEGACY_LOCK_STORAGE_PREFIX = "ghola.terminal.live-execution-lock.v1:";
export const TERMINAL_LIVE_EXECUTION_JOURNAL_STORAGE_PREFIX = "ghola.terminal.live-execution-journal.v2:";
export const TERMINAL_LIVE_EXECUTION_LOCK_STORAGE_PREFIX = "ghola.terminal.live-execution-lock.v2:";
export type TerminalLiveExecutionJournalStorageStatus = "loading" | "ready" | "blocked";
export type TerminalLiveExecutionJournalSafetyState = "ready" | "loading" | "blocked" | "unresolved";
export type TerminalLiveExecutionJournalSummaryState =
  | "loading"
  | "blocked"
  | "empty"
  | "unknown"
  | "submitted"
  | "reconciled"
  | "externally_reviewed";
export type TerminalLiveExecutionExternalReviewBlocker =
  | "account_context_mismatch"
  | "account_stream_not_current"
  | "account_snapshot_predates_submit";

export interface TerminalLiveExecutionJournalEntry {
  planDigest: string;
  outcome: "acknowledged" | "unknown" | "externally_reviewed";
  status: "submitted" | "reconciled" | "unknown" | "externally_reviewed";
  commitment: string | null;
  orderId: string | null;
  venue: TradeOrderPlan["venue_id"];
  network: TradeOrderPlan["network"];
  product: string;
  side: TradeOrderPlan["side"];
  /** Added without invalidating legacy v1 evidence rows. */
  orderType?: TradeOrderPlan["order_type"];
  timeInForce?: TradeOrderPlan["time_in_force"];
  baseSize?: string;
  executionReferencePrice?: string;
  /** HMAC-bound risk evidence. Absent only on legacy journal rows. */
  riskBudgetUsd?: string;
  stopAndSlippageLossUsd?: string;
  roundTripCostLossUsd?: string;
  allInLossUsd?: string;
  feeBps?: number;
  bufferBps?: number;
  feeEvidenceAt?: string;
  bufferEvidenceAt?: string;
  quoteNotionalUsd: string;
  limitPrice: string;
  recordedAt: string;
  reviewedAt: string | null;
  reason: string | null;
}

export interface TerminalLiveExecutionJournalSummary {
  state: TerminalLiveExecutionJournalSummaryState;
  unresolvedCount: number;
  unknownCount: number;
  submittedCount: number;
  primaryUnresolved: TerminalLiveExecutionJournalEntry | null;
  latest: TerminalLiveExecutionJournalEntry | null;
  orderedEntries: TerminalLiveExecutionJournalEntry[];
}

const SAFE_REASON = /^[a-z0-9_:-]{3,100}$/u;
const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SUBJECT_SCOPE = /^subject_[a-f0-9]{32}$/u;

export function terminalLiveExecutionSubjectScope(subject: string | null | undefined) {
  const canonical = subject?.trim();
  if (!canonical || canonical.length > 512) return null;
  return `subject_${hex(sha256(new TextEncoder().encode(`ghola:terminal-live-execution:v2:${canonical}`))).slice(0, 32)}`;
}

export function terminalLiveExecutionJournalStorageKey(subjectScope: string) {
  return SUBJECT_SCOPE.test(subjectScope)
    ? `${TERMINAL_LIVE_EXECUTION_JOURNAL_STORAGE_PREFIX}${subjectScope}`
    : null;
}

export function terminalLiveExecutionLockStoragePrefix(subjectScope: string) {
  return SUBJECT_SCOPE.test(subjectScope)
    ? `${TERMINAL_LIVE_EXECUTION_LOCK_STORAGE_PREFIX}${subjectScope}:`
    : null;
}

export function terminalLiveExecutionJournalEntryFromReceipt(
  receipt: TerminalLiveExecutionReceipt,
  plan: TradeOrderPlan,
): TerminalLiveExecutionJournalEntry | null {
  const common = planSummary(receipt.planDigest, plan);
  if (!common) return null;
  return {
    ...common,
    outcome: "acknowledged",
    status: receipt.status,
    commitment: receipt.commitment,
    orderId: receipt.orderId,
    recordedAt: receipt.receivedAt,
    reviewedAt: null,
    reason: null,
  };
}

export function terminalLiveExecutionUnknownJournalEntry(input: {
  planDigest: string;
  plan: TradeOrderPlan;
  reason: string;
  recordedAt?: string;
}): TerminalLiveExecutionJournalEntry | null {
  const common = planSummary(input.planDigest, input.plan);
  const recordedAt = canonicalIso(input.recordedAt ?? new Date().toISOString());
  if (!common || !recordedAt || !SAFE_REASON.test(input.reason)) return null;
  return {
    ...common,
    outcome: "unknown",
    status: "unknown",
    commitment: null,
    orderId: null,
    recordedAt,
    reviewedAt: null,
    reason: input.reason,
  };
}

export function terminalLiveExecutionJournalHasUnresolved(
  entries: readonly TerminalLiveExecutionJournalEntry[],
) {
  return entries.some((entry) => entry.status === "unknown" || entry.status === "submitted");
}

export function terminalLiveExecutionJournalSafetyState(
  storageStatus: TerminalLiveExecutionJournalStorageStatus,
  entries: readonly TerminalLiveExecutionJournalEntry[],
): TerminalLiveExecutionJournalSafetyState {
  if (storageStatus !== "ready") return storageStatus;
  return terminalLiveExecutionJournalHasUnresolved(entries) ? "unresolved" : "ready";
}

/** Summarizes the whole ledger so a newer resolved row cannot mask an older lock. */
export function terminalLiveExecutionJournalSummary(
  storageStatus: TerminalLiveExecutionJournalStorageStatus,
  entries: readonly TerminalLiveExecutionJournalEntry[],
): TerminalLiveExecutionJournalSummary {
  const byNewest = entries.slice().sort((left, right) => (
    Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || right.planDigest.localeCompare(left.planDigest)
  ));
  const unresolved = byNewest.filter((entry) => entry.status === "unknown" || entry.status === "submitted");
  const unknownCount = unresolved.filter((entry) => entry.status === "unknown").length;
  const submittedCount = unresolved.length - unknownCount;
  const primaryUnresolved = unresolved.slice().sort((left, right) => (
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.planDigest.localeCompare(right.planDigest)
  ))[0] ?? null;
  const latest = byNewest[0] ?? null;
  const state: TerminalLiveExecutionJournalSummaryState = storageStatus === "loading"
    ? "loading"
    : storageStatus === "blocked"
      ? "blocked"
      : unknownCount > 0
        ? "unknown"
        : submittedCount > 0
          ? "submitted"
          : latest?.status === "reconciled"
            ? "reconciled"
            : latest?.status === "externally_reviewed"
              ? "externally_reviewed"
              : "empty";
  return { state, unresolvedCount: unresolved.length, unknownCount, submittedCount, primaryUnresolved, latest, orderedEntries: byNewest };
}

export function terminalLiveExecutionExternalReviewDecision(input: {
  entry: TerminalLiveExecutionJournalEntry;
  selectedVenue: string;
  selectedNetwork: "mainnet" | "testnet";
  accountStreamCurrent: boolean;
  accountStreamObservedAtMs: number | null;
}): { allowed: boolean; blocker: TerminalLiveExecutionExternalReviewBlocker | null } {
  if (input.selectedVenue !== input.entry.venue || input.selectedNetwork !== input.entry.network) {
    return { allowed: false, blocker: "account_context_mismatch" };
  }
  if (input.entry.venue !== "hyperliquid") return { allowed: true, blocker: null };
  if (!input.accountStreamCurrent) return { allowed: false, blocker: "account_stream_not_current" };
  const accountCheckedAt = input.accountStreamObservedAtMs ?? Number.NaN;
  const submittedAt = Date.parse(input.entry.recordedAt);
  if (!Number.isFinite(accountCheckedAt) || accountCheckedAt < submittedAt) {
    return { allowed: false, blocker: "account_snapshot_predates_submit" };
  }
  return { allowed: true, blocker: null };
}

export function terminalLiveExecutionReviewEvidenceCrossed(
  entries: readonly TerminalLiveExecutionJournalEntry[],
  previousObservedAtMs: number | null,
  nextObservedAtMs: number | null,
) {
  if (nextObservedAtMs == null || !Number.isFinite(nextObservedAtMs)) return false;
  const previous = previousObservedAtMs != null && Number.isFinite(previousObservedAtMs)
    ? previousObservedAtMs
    : Number.NEGATIVE_INFINITY;
  return entries.some((entry) => {
    if (entry.venue !== "hyperliquid" || (entry.status !== "unknown" && entry.status !== "submitted")) return false;
    const submittedAt = Date.parse(entry.recordedAt);
    return Number.isFinite(submittedAt) && previous < submittedAt && nextObservedAtMs >= submittedAt;
  });
}

export function externallyReviewTerminalLiveExecutionJournalEntry(
  entries: readonly TerminalLiveExecutionJournalEntry[],
  planDigest: string,
  reviewedAt = new Date().toISOString(),
) {
  const canonicalReviewedAt = canonicalIso(reviewedAt);
  if (!PLAN_DIGEST.test(planDigest) || !canonicalReviewedAt) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (
      entry.planDigest !== planDigest
      || (entry.status !== "unknown" && entry.status !== "submitted")
    ) return entry;
    changed = true;
    return {
      ...entry,
      outcome: "externally_reviewed" as const,
      status: "externally_reviewed" as const,
      reviewedAt: canonicalReviewedAt,
      reason: "external_account_review",
    };
  });
  return changed ? next : entries;
}

export function serializeTerminalLiveExecutionJournal(
  entries: readonly TerminalLiveExecutionJournalEntry[],
) {
  if (!validJournal(entries)) throw new Error("terminal live execution journal is invalid");
  return JSON.stringify({ version: 1, entries });
}

export function parseTerminalLiveExecutionJournal(raw: string | null) {
  if (raw == null) return [] as TerminalLiveExecutionJournalEntry[];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = record(value);
  if (root?.version !== 1 || !Array.isArray(root.entries)) return null;
  if (root.entries.length > TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT) return null;
  const entries = root.entries.flatMap((entry) => {
    const inspected = inspectJournalEntry(entry);
    return inspected ? [inspected] : [];
  });
  return entries.length === root.entries.length && validJournal(entries) ? entries : null;
}

export function terminalLiveExecutionLockStorageKey(subjectScope: string, planDigest: string) {
  const prefix = terminalLiveExecutionLockStoragePrefix(subjectScope);
  return prefix && PLAN_DIGEST.test(planDigest)
    ? `${prefix}${planDigest.slice("sha256:".length)}`
    : null;
}

export function serializeTerminalLiveExecutionLock(entry: TerminalLiveExecutionJournalEntry) {
  if (entry.status !== "unknown" && entry.status !== "submitted") {
    throw new Error("terminal live execution lock must be unresolved");
  }
  return serializeTerminalLiveExecutionJournal([entry]);
}

export function parseTerminalLiveExecutionLock(key: string, raw: string | null, subjectScope: string) {
  const prefix = terminalLiveExecutionLockStoragePrefix(subjectScope);
  if (!prefix || !key.startsWith(prefix)) return null;
  const digest = `sha256:${key.slice(prefix.length)}`;
  const entries = parseTerminalLiveExecutionJournal(raw);
  if (
    !PLAN_DIGEST.test(digest)
    || !entries
    || entries.length !== 1
    || entries[0].planDigest !== digest
    || (entries[0].status !== "unknown" && entries[0].status !== "submitted")
  ) return null;
  return entries[0];
}

export function terminalLiveExecutionLegacyStorageRequiresReview(input: {
  journalRaw: string | null;
  hasLock: boolean;
}) {
  if (input.hasLock) return true;
  if (input.journalRaw == null) return false;
  const parsed = parseTerminalLiveExecutionJournal(input.journalRaw);
  return parsed == null || terminalLiveExecutionJournalHasUnresolved(parsed);
}

export function readTerminalLiveExecutionJournalStorage(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  subjectScope: string,
): { status: "ready"; entries: TerminalLiveExecutionJournalEntry[] } | { status: "blocked"; entries: [] } {
  const journalKey = terminalLiveExecutionJournalStorageKey(subjectScope);
  const lockPrefix = terminalLiveExecutionLockStoragePrefix(subjectScope);
  if (!journalKey || !lockPrefix) return { status: "blocked", entries: [] };
  let hasLegacyLock = false;
  for (let index = 0; index < storage.length; index += 1) {
    if (storage.key(index)?.startsWith(TERMINAL_LIVE_EXECUTION_LEGACY_LOCK_STORAGE_PREFIX)) {
      hasLegacyLock = true;
      break;
    }
  }
  if (terminalLiveExecutionLegacyStorageRequiresReview({
    journalRaw: storage.getItem(TERMINAL_LIVE_EXECUTION_LEGACY_JOURNAL_STORAGE_KEY),
    hasLock: hasLegacyLock,
  })) return { status: "blocked", entries: [] };
  const journalRaw = storage.getItem(journalKey);
  if (journalRaw == null) return { status: "blocked", entries: [] };
  const journal = parseTerminalLiveExecutionJournal(journalRaw);
  if (!journal) return { status: "blocked", entries: [] };
  const locks: TerminalLiveExecutionJournalEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(lockPrefix)) continue;
    const lock = parseTerminalLiveExecutionLock(key, storage.getItem(key), subjectScope);
    if (!lock || locks.length >= TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT) return { status: "blocked", entries: [] };
    locks.push(lock);
  }
  locks.sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
  const lockedDigests = new Set(locks.map((entry) => entry.planDigest));
  return {
    status: "ready",
    entries: [...locks, ...journal.filter((entry) => !lockedDigests.has(entry.planDigest))]
      .slice(0, TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT),
  };
}

export function terminalLiveExecutionScopedJournalView(input: {
  subjectScope: string | null;
  loadedScope: string | null;
  entries: readonly TerminalLiveExecutionJournalEntry[];
  storageStatus: TerminalLiveExecutionJournalStorageStatus;
}) {
  return input.subjectScope != null && input.loadedScope === input.subjectScope
    ? { entries: input.entries, storageStatus: input.storageStatus }
    : { entries: [] as readonly TerminalLiveExecutionJournalEntry[], storageStatus: "loading" as const };
}

export function terminalLiveExecutionSessionSubjectMatches(
  expectedScope: string | null,
  receivedScope: string | null | undefined,
) {
  return expectedScope != null
    && SUBJECT_SCOPE.test(expectedScope)
    && receivedScope === expectedScope;
}

export function persistTerminalLiveExecutionJournalEntry(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
  subjectScope: string,
  entry: TerminalLiveExecutionJournalEntry,
): { ok: true; entries: readonly TerminalLiveExecutionJournalEntry[] } | { ok: false; entries: [] } {
  const journalKey = terminalLiveExecutionJournalStorageKey(subjectScope);
  const lockKey = terminalLiveExecutionLockStorageKey(subjectScope, entry.planDigest);
  if (!journalKey || !lockKey || !inspectJournalEntry(entry)) return { ok: false, entries: [] };
  const unresolved = entry.status === "unknown" || entry.status === "submitted";
  try {
    if (unresolved) storage.setItem(lockKey, serializeTerminalLiveExecutionLock(entry));
    const stored = readTerminalLiveExecutionJournalStorage(storage, subjectScope);
    if (stored.status !== "ready") return { ok: false, entries: [] };
    const entries = appendTerminalLiveExecutionJournal(stored.entries, entry);
    storage.setItem(journalKey, serializeTerminalLiveExecutionJournal(entries));
    if (!unresolved) storage.removeItem(lockKey);
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

/** Clears only a locally persisted pre-dispatch lock after authoritative non-dispatch evidence. */
export function discardTerminalLiveExecutionPendingEntry(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
  subjectScope: string,
  planDigest: string,
): { ok: true; entries: readonly TerminalLiveExecutionJournalEntry[] } | { ok: false; entries: [] } {
  const journalKey = terminalLiveExecutionJournalStorageKey(subjectScope);
  const lockKey = terminalLiveExecutionLockStorageKey(subjectScope, planDigest);
  if (!journalKey || !lockKey || !PLAN_DIGEST.test(planDigest)) return { ok: false, entries: [] };
  try {
    const stored = readTerminalLiveExecutionJournalStorage(storage, subjectScope);
    if (stored.status !== "ready") return { ok: false, entries: [] };
    const target = stored.entries.find((entry) => entry.planDigest === planDigest);
    if (!target || target.status !== "unknown" || target.reason !== "execution_dispatch_pending") {
      return { ok: false, entries: [] };
    }
    const entries = stored.entries.filter((entry) => entry.planDigest !== planDigest);
    storage.setItem(journalKey, serializeTerminalLiveExecutionJournal(entries));
    storage.removeItem(lockKey);
    const verified = readTerminalLiveExecutionJournalStorage(storage, subjectScope);
    return verified.status === "ready" && !verified.entries.some((entry) => entry.planDigest === planDigest)
      ? { ok: true, entries: verified.entries }
      : { ok: false, entries: [] };
  } catch {
    return { ok: false, entries: [] };
  }
}

export function appendTerminalLiveExecutionJournal(
  current: readonly TerminalLiveExecutionJournalEntry[],
  next: TerminalLiveExecutionJournalEntry,
) {
  const existing = current.find((entry) => entry.planDigest === next.planDigest);
  if (existing && outcomeRank(existing) > outcomeRank(next)) return current;
  if (existing && entryEqual(existing, next)) return current;
  return [next, ...current.filter((entry) => entry.planDigest !== next.planDigest)]
    .slice(0, TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT);
}

function planSummary(planDigest: string, plan: TradeOrderPlan) {
  if (!PLAN_DIGEST.test(planDigest)) return null;
  const validation = validateTradeOrderPlan(plan, {
    requireFresh: false,
    allowLegacySlippageReference: true,
  });
  if (!validation.ok) return null;
  return {
    planDigest,
    venue: validation.plan.venue_id,
    network: validation.plan.network,
    product: validation.plan.product,
    side: validation.plan.side,
    orderType: validation.plan.order_type,
    timeInForce: validation.plan.time_in_force,
    baseSize: validation.plan.base_size,
    ...(validation.plan.market_context.execution_reference_price
      ? { executionReferencePrice: validation.plan.market_context.execution_reference_price }
      : {}),
    ...(validation.plan.risk_envelope ? {
      riskBudgetUsd: validation.plan.risk_envelope.risk_budget_usd,
      stopAndSlippageLossUsd: validation.plan.risk_envelope.stop_and_slippage_loss_usd,
      roundTripCostLossUsd: validation.plan.risk_envelope.round_trip_cost_loss_usd,
      allInLossUsd: validation.plan.risk_envelope.all_in_loss_usd,
      feeBps: validation.plan.risk_envelope.fee_bps,
      bufferBps: validation.plan.risk_envelope.buffer_bps,
      ...(validation.plan.risk_envelope.fee_evidence_at && validation.plan.risk_envelope.buffer_evidence_at ? {
        feeEvidenceAt: validation.plan.risk_envelope.fee_evidence_at,
        bufferEvidenceAt: validation.plan.risk_envelope.buffer_evidence_at,
      } : {}),
    } : {}),
    quoteNotionalUsd: validation.plan.quote_notional_usd,
    limitPrice: validation.plan.limit_price,
  };
}

function outcomeRank(entry: TerminalLiveExecutionJournalEntry) {
  if (entry.status === "reconciled") return 4;
  if (entry.status === "externally_reviewed") return 3;
  if (entry.status === "submitted") return 2;
  return 1;
}

function entryEqual(left: TerminalLiveExecutionJournalEntry, right: TerminalLiveExecutionJournalEntry) {
  return left.planDigest === right.planDigest
    && left.outcome === right.outcome
    && left.status === right.status
    && left.commitment === right.commitment
    && left.orderId === right.orderId
    && left.orderType === right.orderType
    && left.timeInForce === right.timeInForce
    && left.baseSize === right.baseSize
    && left.executionReferencePrice === right.executionReferencePrice
    && left.riskBudgetUsd === right.riskBudgetUsd
    && left.stopAndSlippageLossUsd === right.stopAndSlippageLossUsd
    && left.roundTripCostLossUsd === right.roundTripCostLossUsd
    && left.allInLossUsd === right.allInLossUsd
    && left.feeBps === right.feeBps
    && left.bufferBps === right.bufferBps
    && left.feeEvidenceAt === right.feeEvidenceAt
    && left.bufferEvidenceAt === right.bufferEvidenceAt
    && left.recordedAt === right.recordedAt
    && left.reviewedAt === right.reviewedAt
    && left.reason === right.reason;
}

function validJournal(entries: readonly TerminalLiveExecutionJournalEntry[]) {
  return entries.length <= TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT
    && new Set(entries.map((entry) => entry.planDigest)).size === entries.length
    && entries.every((entry) => inspectJournalEntry(entry) != null);
}

function inspectJournalEntry(value: unknown): TerminalLiveExecutionJournalEntry | null {
  const row = record(value);
  if (!row || !PLAN_DIGEST.test(string(row.planDigest))) return null;
  const outcome = row.outcome === "acknowledged" || row.outcome === "unknown" || row.outcome === "externally_reviewed" ? row.outcome : null;
  const status = row.status === "submitted" || row.status === "reconciled" || row.status === "unknown" || row.status === "externally_reviewed" ? row.status : null;
  const commitment = nullableIdentifier(row.commitment);
  const orderId = nullableIdentifier(row.orderId);
  const venue = row.venue === "hyperliquid" || row.venue === "phoenix" || row.venue === "coinbase" ? row.venue : null;
  const network = row.network === "mainnet" || row.network === "testnet" ? row.network : null;
  const product = typeof row.product === "string" && /^[A-Z0-9]{1,12}-(?:PERP|USD)$/u.test(row.product) ? row.product : null;
  const side = row.side === "buy" || row.side === "sell" ? row.side : null;
  const orderType = row.orderType === undefined ? undefined : row.orderType === "limit" ? "limit" as const : null;
  const timeInForce = row.timeInForce === undefined
    ? undefined
    : row.timeInForce === "gtc" || row.timeInForce === "ioc" || row.timeInForce === "fok"
      ? row.timeInForce
      : null;
  const baseSize = row.baseSize === undefined ? undefined : decimal(row.baseSize);
  const executionReferencePrice = row.executionReferencePrice === undefined
    ? undefined
    : decimal(row.executionReferencePrice);
  const riskEvidence = inspectRiskEvidence(row);
  const quoteNotionalUsd = decimal(row.quoteNotionalUsd);
  const limitPrice = decimal(row.limitPrice);
  const recordedAt = typeof row.recordedAt === "string" ? canonicalIso(row.recordedAt) : null;
  const reviewedAt = row.reviewedAt == null ? null : typeof row.reviewedAt === "string" ? canonicalIso(row.reviewedAt) : null;
  const reason = row.reason == null ? null : typeof row.reason === "string" && SAFE_REASON.test(row.reason) ? row.reason : null;
  if (!outcome || !status || commitment === undefined || orderId === undefined || !venue || !network || !product || !side || orderType === null || timeInForce === null || baseSize === null || executionReferencePrice === null || riskEvidence === null || !quoteNotionalUsd || !limitPrice || !recordedAt || (row.reviewedAt != null && !reviewedAt) || (row.reason != null && !reason)) return null;
  const shapeValid = outcome === "acknowledged"
    ? (status === "submitted" || status === "reconciled") && commitment != null && reason == null && reviewedAt == null
    : outcome === "unknown"
      ? status === "unknown" && commitment == null && orderId == null && reason != null && reviewedAt == null
      : status === "externally_reviewed" && reason === "external_account_review" && reviewedAt != null;
  if (!shapeValid) return null;
  return {
    planDigest: string(row.planDigest),
    outcome,
    status,
    commitment,
    orderId,
    venue,
    network,
    product,
    side,
    ...(orderType ? { orderType } : {}),
    ...(timeInForce ? { timeInForce } : {}),
    ...(baseSize ? { baseSize } : {}),
    ...(executionReferencePrice ? { executionReferencePrice } : {}),
    ...(riskEvidence ?? {}),
    quoteNotionalUsd,
    limitPrice,
    recordedAt,
    reviewedAt,
    reason,
  };
}

function inspectRiskEvidence(row: Record<string, unknown>): Pick<TerminalLiveExecutionJournalEntry,
  "riskBudgetUsd" | "stopAndSlippageLossUsd" | "roundTripCostLossUsd" | "allInLossUsd" | "feeBps" | "bufferBps" | "feeEvidenceAt" | "bufferEvidenceAt"
> | undefined | null {
  const coreKeys = ["riskBudgetUsd", "stopAndSlippageLossUsd", "roundTripCostLossUsd", "allInLossUsd", "feeBps", "bufferBps"] as const;
  const timeKeys = ["feeEvidenceAt", "bufferEvidenceAt"] as const;
  const corePresent = coreKeys.filter((key) => row[key] !== undefined).length;
  const timePresent = timeKeys.filter((key) => row[key] !== undefined).length;
  if (corePresent === 0 && timePresent === 0) return undefined;
  if (corePresent !== coreKeys.length || (timePresent !== 0 && timePresent !== timeKeys.length)) return null;
  const riskBudgetUsd = decimal(row.riskBudgetUsd);
  const stopAndSlippageLossUsd = decimal(row.stopAndSlippageLossUsd);
  const roundTripCostLossUsd = nonNegativeDecimal(row.roundTripCostLossUsd);
  const allInLossUsd = decimal(row.allInLossUsd);
  const feeBps = costBps(row.feeBps);
  const bufferBps = costBps(row.bufferBps);
  const feeEvidenceAt = timePresent ? typeof row.feeEvidenceAt === "string" ? canonicalIso(row.feeEvidenceAt) : null : undefined;
  const bufferEvidenceAt = timePresent ? typeof row.bufferEvidenceAt === "string" ? canonicalIso(row.bufferEvidenceAt) : null : undefined;
  if (!riskBudgetUsd || !stopAndSlippageLossUsd || roundTripCostLossUsd == null || !allInLossUsd || feeBps == null || bufferBps == null || feeEvidenceAt === null || bufferEvidenceAt === null) return null;
  const budget = Number(riskBudgetUsd);
  const stopLoss = Number(stopAndSlippageLossUsd);
  const costLoss = Number(roundTripCostLossUsd);
  const allIn = Number(allInLossUsd);
  if (allIn > budget + arithmeticTolerance(budget) || Math.abs(allIn - stopLoss - costLoss) > arithmeticTolerance(allIn)) return null;
  return {
    riskBudgetUsd,
    stopAndSlippageLossUsd,
    roundTripCostLossUsd,
    allInLossUsd,
    feeBps,
    bufferBps,
    ...(feeEvidenceAt && bufferEvidenceAt ? { feeEvidenceAt, bufferEvidenceAt } : {}),
  };
}

function canonicalIso(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function string(value: unknown) { return typeof value === "string" ? value : ""; }
function nullableIdentifier(value: unknown): string | null | undefined { return value == null ? null : typeof value === "string" && /^[A-Za-z0-9._:-]{8,200}$/u.test(value) ? value : undefined; }
function decimal(value: unknown) { return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && Number(value) > 0 && Number.isFinite(Number(value)) ? value : null; }
function nonNegativeDecimal(value: unknown) { return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && Number(value) >= 0 && Number.isFinite(Number(value)) ? value : null; }
function costBps(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 500 ? value : null; }
function arithmeticTolerance(value: number) { return Math.max(1e-6, Math.abs(value) * 1e-8); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function hex(value: Uint8Array) { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
