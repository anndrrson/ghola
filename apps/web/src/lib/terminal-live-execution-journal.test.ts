import { describe, expect, it } from "vitest";
import type { TerminalLiveExecutionReceipt } from "./terminal-live-execution-receipt";
import {
  appendTerminalLiveExecutionJournal,
  discardTerminalLiveExecutionAfterAbsenceProof,
  discardTerminalLiveExecutionPendingEntry,
  parseTerminalLiveExecutionJournal,
  parseTerminalLiveExecutionLock,
  persistTerminalLiveExecutionJournalEntry,
  readTerminalLiveExecutionJournalStorage,
  serializeTerminalLiveExecutionJournal,
  serializeTerminalLiveExecutionLock,
  terminalLiveExecutionJournalHasUnresolved,
  terminalLiveExecutionJournalSafetyState,
  terminalLiveExecutionJournalSummary,
  terminalLiveExecutionLockStorageKey,
  terminalLiveExecutionJournalEntryFromReceipt,
  terminalLiveExecutionJournalEntryFromReconciliationReceipt,
  terminalLiveExecutionJournalStorageKey,
  terminalLiveExecutionLegacyStorageRequiresReview,
  terminalLiveExecutionLockStoragePrefix,
  terminalLiveExecutionScopedJournalView,
  terminalLiveExecutionSessionSubjectMatches,
  terminalLiveExecutionSubjectScope,
  terminalLiveExecutionUnknownJournalEntry,
  TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT,
  type TerminalLiveExecutionJournalEntry,
} from "./terminal-live-execution-journal";
import type { TradeOrderPlan } from "./trade-order-plan";

describe("terminal live execution journal", () => {
  it("never lets a newer resolved row mask an older unresolved lock", () => {
    const unresolved = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(1) })!;
    const resolved = terminalLiveExecutionJournalEntryFromReceipt({ ...receipt("reconciled"), planDigest: digest(2), receivedAt: iso(2) }, plan())!;
    expect(terminalLiveExecutionJournalSummary("ready", [resolved, unresolved])).toMatchObject({
      state: "unknown",
      unresolvedCount: 1,
      unknownCount: 1,
      submittedCount: 0,
      primaryUnresolved: unresolved,
      latest: resolved,
    });
  });

  it("prioritizes the oldest lock and counts mixed unresolved states", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(1) })!;
    const submitted = terminalLiveExecutionJournalEntryFromReceipt({ ...receipt("submitted"), planDigest: digest(2), receivedAt: iso(2) }, plan())!;
    expect(terminalLiveExecutionJournalSummary("ready", [submitted, unknown])).toMatchObject({
      state: "unknown",
      unresolvedCount: 2,
      unknownCount: 1,
      submittedCount: 1,
      primaryUnresolved: unknown,
    });
    expect(terminalLiveExecutionJournalSummary("blocked", [submitted]).state).toBe("blocked");
    expect(terminalLiveExecutionJournalSummary("loading", []).state).toBe("loading");
  });
  it("captures only sanitized plan and receipt fields", () => {
    const entry = terminalLiveExecutionJournalEntryFromReceipt(receipt("submitted"), plan());
    expect(entry).toMatchObject({
      outcome: "acknowledged",
      status: "submitted",
      product: "BTC-PERP",
      orderType: "limit",
      timeInForce: "gtc",
      baseSize: "0.1",
      executionReferencePrice: "100",
      quoteNotionalUsd: "10",
      riskBudgetUsd: "1",
      stopAndSlippageLossUsd: "0.55",
      roundTripCostLossUsd: "0.02",
      allInLossUsd: "0.57",
      feeBps: 5,
      bufferBps: 5,
      feeEvidenceAt: "2026-08-13T11:59:59.000Z",
      bufferEvidenceAt: "2026-08-13T11:59:59.000Z",
    });
    expect(entry).not.toHaveProperty("token");
    expect(entry).not.toHaveProperty("preview_commitment");
  });

  it("records terminal IOC no-fill as resolved and safe to retry", () => {
    const entry = terminalLiveExecutionJournalEntryFromReceipt(receipt("no_fill"), plan())!;
    expect(entry).toMatchObject({ status: "no_fill", outcome: "acknowledged" });
    expect(terminalLiveExecutionJournalHasUnresolved([entry])).toBe(false);
    expect(terminalLiveExecutionJournalSafetyState("ready", [entry])).toBe("ready");
    expect(terminalLiveExecutionJournalSummary("ready", [entry])).toMatchObject({
      state: "reconciled",
      unresolvedCount: 0,
      latest: { status: "no_fill" },
    });
    expect(parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal([entry])))
      .toEqual([entry]);
  });

  it("persists only validated venue-proven fill details", () => {
    const entry = terminalLiveExecutionJournalEntryFromReceipt({
      ...receipt("reconciled"),
      provenFill: {
        filledBaseSize: "0.00016",
        averageFillPrice: "62500",
        feeUsd: "0.005",
        protection: { status: "not_requested" },
      },
    }, plan())!;
    expect(parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal([entry])))
      .toEqual([entry]);
    expect(entry.provenFill).toMatchObject({ filledBaseSize: "0.00016", feeUsd: "0.005" });
  });

  it("upgrades unknown to submitted to reconciled and never downgrades", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const submitted = terminalLiveExecutionJournalEntryFromReceipt(receipt("submitted"), plan())!;
    const reconciled = terminalLiveExecutionJournalEntryFromReceipt(receipt("reconciled"), plan())!;
    let journal = appendTerminalLiveExecutionJournal([], unknown);
    journal = appendTerminalLiveExecutionJournal(journal, submitted);
    journal = appendTerminalLiveExecutionJournal(journal, reconciled);
    journal = appendTerminalLiveExecutionJournal(journal, unknown);
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe("reconciled");
  });

  it("keeps a newest-first bounded journal", () => {
    let journal = [] as ReturnType<typeof appendTerminalLiveExecutionJournal>;
    for (let index = 0; index < TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT + 3; index += 1) {
      const entry = terminalLiveExecutionUnknownJournalEntry({
        planDigest: digest(index),
        plan: plan({ quote_notional_usd: String(10 + index), base_size: String((10 + index) / 100), risk_envelope: undefined }),
        reason: "execution_http_outcome_unknown",
        recordedAt: iso(index),
      })!;
      journal = appendTerminalLiveExecutionJournal(journal, entry);
    }
    expect(journal).toHaveLength(TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT);
    expect(journal[0].planDigest).toBe(digest(TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT + 2));
  });

  it("keeps legacy external-review rows locked until authoritative terminal evidence arrives", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const hydrated = parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal([unknown]));
    expect(hydrated).toEqual([unknown]);
    expect(terminalLiveExecutionJournalHasUnresolved(hydrated!)).toBe(true);
    const legacyReviewed: TerminalLiveExecutionJournalEntry = {
      ...unknown,
      outcome: "externally_reviewed",
      status: "externally_reviewed",
      reviewedAt: iso(3),
      reason: "external_account_review",
    };
    expect(terminalLiveExecutionJournalHasUnresolved([legacyReviewed])).toBe(true);
    expect(terminalLiveExecutionJournalSafetyState("ready", [legacyReviewed])).toBe("unresolved");
    expect(terminalLiveExecutionJournalSafetyState("ready", hydrated!)).toBe("unresolved");
    expect(terminalLiveExecutionJournalSafetyState("loading", [])).toBe("loading");
    expect(parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal([legacyReviewed]))).toEqual([legacyReviewed]);
    const terminal = terminalLiveExecutionJournalEntryFromReconciliationReceipt(receipt("reconciled"), legacyReviewed);
    expect(terminal).toMatchObject({ outcome: "acknowledged", status: "reconciled", reason: null });
    expect(terminalLiveExecutionJournalHasUnresolved([terminal!])).toBe(false);
  });

  it("preserves legacy evidence rows while rejecting malformed optional ticket fields", () => {
    const current = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const legacyRiskTime = { ...current };
    delete legacyRiskTime.feeEvidenceAt;
    delete legacyRiskTime.bufferEvidenceAt;
    expect(parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: [legacyRiskTime] }))).toEqual([legacyRiskTime]);
    const legacy = legacyEntry(current);
    const legacyRaw = JSON.stringify({ version: 1, entries: [legacy] });
    expect(parseTerminalLiveExecutionJournal(legacyRaw)).toEqual([legacy]);
    expect(parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: [{ ...current, timeInForce: "day" }] }))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: [{ ...current, baseSize: "0" }] }))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: [{ ...current, feeBps: undefined }] }))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: [{ ...current, allInLossUsd: "0.58" }] }))).toBeNull();
  });

  it("accepts only terminal evidence bound to the exact plan and original work order", () => {
    const submitted = terminalLiveExecutionJournalEntryFromReceipt(receipt("submitted"), plan())!;
    expect(terminalLiveExecutionJournalEntryFromReconciliationReceipt(receipt("submitted"), submitted)).toBeNull();
    expect(terminalLiveExecutionJournalEntryFromReconciliationReceipt({ ...receipt("reconciled"), planDigest: digest(1) }, submitted)).toBeNull();
    expect(terminalLiveExecutionJournalEntryFromReconciliationReceipt({ ...receipt("reconciled"), workOrderCommitment: workOrder(1) }, submitted)).toBeNull();
    expect(terminalLiveExecutionJournalEntryFromReconciliationReceipt(receipt("reconciled"), submitted)).toMatchObject({
      status: "reconciled",
      workOrderCommitment: workOrder(0),
    });
  });

  it("rejects malformed, duplicated, oversized, or contradictory persisted ledgers", () => {
    const valid = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const envelope = (entries: unknown[]) => JSON.stringify({ version: 1, entries });
    expect(parseTerminalLiveExecutionJournal("not json")).toBeNull();
    expect(parseTerminalLiveExecutionJournal(envelope([{ ...valid, product: "raw product" }]))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(envelope([{ ...valid, outcome: "acknowledged" }]))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(envelope([valid, valid]))).toBeNull();
    expect(parseTerminalLiveExecutionJournal(envelope(Array.from({ length: TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT + 1 }, (_, index) => ({ ...valid, planDigest: digest(index) }))))).toBeNull();
  });

  it("uses one strict unresolved lock record per plan digest", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    const otherScope = terminalLiveExecutionSubjectScope("user-b")!;
    const key = terminalLiveExecutionLockStorageKey(scope, unknown.planDigest)!;
    expect(parseTerminalLiveExecutionLock(key, serializeTerminalLiveExecutionLock(unknown), scope)).toEqual(unknown);
    expect(parseTerminalLiveExecutionLock(key, serializeTerminalLiveExecutionLock(unknown), otherScope)).toBeNull();
    expect(parseTerminalLiveExecutionLock(`${key}0`, serializeTerminalLiveExecutionLock(unknown), scope)).toBeNull();
    const legacyReviewed: TerminalLiveExecutionJournalEntry = { ...unknown, outcome: "externally_reviewed", status: "externally_reviewed", reviewedAt: iso(3), reason: "external_account_review" };
    expect(() => serializeTerminalLiveExecutionLock(legacyReviewed)).toThrow();
  });

  it("derives opaque deterministic subject-isolated storage keys", () => {
    const left = terminalLiveExecutionSubjectScope(" user-a ")!;
    const same = terminalLiveExecutionSubjectScope("user-a")!;
    const right = terminalLiveExecutionSubjectScope("user-b")!;
    expect(left).toBe(same);
    expect(left).not.toBe(right);
    expect(left).not.toContain("user-a");
    expect(terminalLiveExecutionJournalStorageKey(left)).not.toBe(terminalLiveExecutionJournalStorageKey(right));
    expect(terminalLiveExecutionLockStoragePrefix(left)).not.toBe(terminalLiveExecutionLockStoragePrefix(right));
    expect(terminalLiveExecutionSubjectScope(" ")).toBeNull();
  });

  it("quarantines ambiguous nonempty legacy ledgers but permits empty migration", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const reconciled = terminalLiveExecutionJournalEntryFromReceipt(receipt("reconciled"), plan())!;
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: null, hasLock: false })).toBe(false);
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: serializeTerminalLiveExecutionJournal([]), hasLock: false })).toBe(false);
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: serializeTerminalLiveExecutionJournal([unknown]), hasLock: false })).toBe(true);
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: serializeTerminalLiveExecutionJournal([reconciled]), hasLock: false })).toBe(false);
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: "bad", hasLock: false })).toBe(true);
    expect(terminalLiveExecutionLegacyStorageRequiresReview({ journalRaw: null, hasLock: true })).toBe(true);
  });

  it("hydrates only the exact subject journal and locks", () => {
    const leftScope = terminalLiveExecutionSubjectScope("user-a")!;
    const rightScope = terminalLiveExecutionSubjectScope("user-b")!;
    const left = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const right = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(1), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(1) })!;
    const storage = memoryStorage(new Map([
      [terminalLiveExecutionJournalStorageKey(leftScope)!, serializeTerminalLiveExecutionJournal([left])],
      [terminalLiveExecutionLockStorageKey(leftScope, left.planDigest)!, serializeTerminalLiveExecutionLock(left)],
      [terminalLiveExecutionJournalStorageKey(rightScope)!, serializeTerminalLiveExecutionJournal([right])],
      [terminalLiveExecutionLockStorageKey(rightScope, right.planDigest)!, serializeTerminalLiveExecutionLock(right)],
    ]));
    expect(readTerminalLiveExecutionJournalStorage(storage, leftScope)).toEqual({ status: "ready", entries: [left] });
    expect(readTerminalLiveExecutionJournalStorage(storage, rightScope)).toEqual({ status: "ready", entries: [right] });
  });

  it("fails closed before a newly authenticated subject has hydrated", () => {
    const leftScope = terminalLiveExecutionSubjectScope("user-a")!;
    const rightScope = terminalLiveExecutionSubjectScope("user-b")!;
    const left = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    expect(terminalLiveExecutionScopedJournalView({
      subjectScope: rightScope,
      loadedScope: leftScope,
      entries: [left],
      storageStatus: "ready",
    })).toEqual({ entries: [], storageStatus: "loading" });
    expect(terminalLiveExecutionSessionSubjectMatches(leftScope, leftScope)).toBe(true);
    expect(terminalLiveExecutionSessionSubjectMatches(leftScope, rightScope)).toBe(false);
    expect(terminalLiveExecutionSessionSubjectMatches(null, null)).toBe(false);
  });

  it("persists an in-flight outcome only inside its captured subject scope", () => {
    const leftScope = terminalLiveExecutionSubjectScope("user-a")!;
    const rightScope = terminalLiveExecutionSubjectScope("user-b")!;
    const left = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const storage = memoryStorage(new Map([
      [terminalLiveExecutionJournalStorageKey(leftScope)!, serializeTerminalLiveExecutionJournal([])],
      [terminalLiveExecutionJournalStorageKey(rightScope)!, serializeTerminalLiveExecutionJournal([])],
    ]));

    expect(persistTerminalLiveExecutionJournalEntry(storage, leftScope, left).ok).toBe(true);
    expect(readTerminalLiveExecutionJournalStorage(storage, leftScope)).toEqual({ status: "ready", entries: [left] });
    expect(readTerminalLiveExecutionJournalStorage(storage, rightScope)).toEqual({ status: "ready", entries: [] });
  });

  it("retains an unresolved lock without overwriting a corrupt journal", () => {
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const journalKey = terminalLiveExecutionJournalStorageKey(scope)!;
    const lockKey = terminalLiveExecutionLockStorageKey(scope, unknown.planDigest)!;
    const storage = memoryStorage(new Map([[journalKey, "corrupt"]]));

    expect(persistTerminalLiveExecutionJournalEntry(storage, scope, unknown)).toEqual({ ok: false, entries: [] });
    expect(storage.getItem(journalKey)).toBe("corrupt");
    expect(parseTerminalLiveExecutionLock(lockKey, storage.getItem(lockKey), scope)).toEqual(unknown);
  });

  it("clears only an exact pre-dispatch lock after authoritative rejection", () => {
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    const pending = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_dispatch_pending", recordedAt: iso(0) })!;
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(1), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(1) })!;
    const storage = memoryStorage(new Map([
      [terminalLiveExecutionJournalStorageKey(scope)!, serializeTerminalLiveExecutionJournal([])],
    ]));
    expect(persistTerminalLiveExecutionJournalEntry(storage, scope, pending).ok).toBe(true);
    expect(discardTerminalLiveExecutionPendingEntry(storage, scope, pending.planDigest)).toEqual({ ok: true, entries: [] });
    expect(readTerminalLiveExecutionJournalStorage(storage, scope)).toEqual({ status: "ready", entries: [] });

    expect(persistTerminalLiveExecutionJournalEntry(storage, scope, unknown).ok).toBe(true);
    expect(discardTerminalLiveExecutionPendingEntry(storage, scope, unknown.planDigest)).toEqual({ ok: false, entries: [] });
    expect(readTerminalLiveExecutionJournalStorage(storage, scope)).toEqual({ status: "ready", entries: [unknown] });
  });

  it("clears only a current-protocol unknown after a delayed server absence proof", () => {
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const storage = memoryStorage(new Map([[terminalLiveExecutionJournalStorageKey(scope)!, serializeTerminalLiveExecutionJournal([])]]));
    expect(persistTerminalLiveExecutionJournalEntry(storage, scope, unknown).ok).toBe(true);
    const baseProof = {
      planDigest: unknown.planDigest,
      proofCommitment: `live_trade_absence_proof_${"a".repeat(48)}`,
      firstCheckedAt: iso(0),
    };
    expect(discardTerminalLiveExecutionAfterAbsenceProof(storage, scope, { ...baseProof, checkedAt: new Date(Date.parse(iso(0)) + 29_999).toISOString() }).ok).toBe(false);
    expect(readTerminalLiveExecutionJournalStorage(storage, scope)).toEqual({ status: "ready", entries: [unknown] });
    expect(discardTerminalLiveExecutionAfterAbsenceProof(storage, scope, { ...baseProof, checkedAt: new Date(Date.parse(iso(0)) + 30_000).toISOString() })).toEqual({ ok: true, entries: [] });

    const legacy = { ...unknown };
    delete legacy.recoveryProtocol;
    expect(persistTerminalLiveExecutionJournalEntry(storage, scope, legacy).ok).toBe(true);
    expect(discardTerminalLiveExecutionAfterAbsenceProof(storage, scope, { ...baseProof, checkedAt: new Date(Date.parse(iso(0)) + 60_000).toISOString() }).ok).toBe(false);
  });

  it("blocks when the exact subject journal is absent", () => {
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    expect(readTerminalLiveExecutionJournalStorage(memoryStorage(new Map()), scope)).toEqual({ status: "blocked", entries: [] });
  });

  it("blocks every subject without exposing ambiguous nonempty legacy data", () => {
    const scope = terminalLiveExecutionSubjectScope("user-a")!;
    const legacy = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const storage = memoryStorage(new Map([
      [terminalLiveExecutionJournalStorageKey(scope)!, serializeTerminalLiveExecutionJournal([])],
      ["ghola.terminal.live-execution-journal.v1", serializeTerminalLiveExecutionJournal([legacy])],
    ]));
    expect(readTerminalLiveExecutionJournalStorage(storage, scope)).toEqual({ status: "blocked", entries: [] });
  });
});

function receipt(status: "submitted" | "reconciled" | "no_fill"): TerminalLiveExecutionReceipt {
  return { status, commitment: "run_commitment_123", orderId: "venue_order_456", workOrderCommitment: workOrder(0), planDigest: digest(0), receivedAt: iso(status === "submitted" ? 1 : 2) };
}

function digest(index: number) { return `sha256:${index.toString(16).padStart(64, "0")}`; }
function workOrder(index: number) { return `live_trade_work_order_${index.toString(16).padStart(48, "0")}`; }
function iso(index: number) { return new Date(Date.parse("2026-08-13T12:00:00.000Z") + index * 1_000).toISOString(); }

function plan(overrides: Partial<TradeOrderPlan> = {}): TradeOrderPlan {
  const base: TradeOrderPlan = {
    version: 1,
    kind: "ghola_trade_order_plan",
    venue_id: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    order_type: "limit",
    time_in_force: "gtc",
    quote_notional_usd: "10",
    base_size: "0.1",
    limit_price: "100",
    max_slippage_bps: 50,
    risk_envelope: {
      risk_budget_usd: "1",
      stop_and_slippage_loss_usd: "0.55",
      round_trip_cost_loss_usd: "0.02",
      all_in_loss_usd: "0.57",
      fee_bps: 5,
      buffer_bps: 5,
      fee_evidence_at: "2026-08-13T11:59:59.000Z",
      buffer_evidence_at: "2026-08-13T11:59:59.000Z",
      scope: "account_local_cost_assumption_v1",
    },
    stop_intent: { stop_level: "95", scope: "agent_plan_invalidation_only" },
    agent_mandate: { strategy_profile: "trend_following", entry_trigger: "preview_now", exit_rule: "manual_approval", time_horizon: "scalp", trigger_level: null, invalidation_level: "95" },
    execution_policy: { submit: true, refresh_after_submit: true, fetch_fills: true, cancel_if_open: false, reduce_only: false },
    market_context: { frame_version: 1, interval: "1m", fetched_at: "2026-08-13T12:00:00.000Z", max_age_ms: 30_000, source_state: "live", execution_reference_price: "100" },
  };
  return { ...base, ...overrides };
}

function memoryStorage(values: Map<string, string>): Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem"> {
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function legacyEntry(entry: TerminalLiveExecutionJournalEntry): TerminalLiveExecutionJournalEntry {
  const legacy = { ...entry };
  delete legacy.orderType;
  delete legacy.timeInForce;
  delete legacy.baseSize;
  delete legacy.executionReferencePrice;
  delete legacy.riskBudgetUsd;
  delete legacy.stopAndSlippageLossUsd;
  delete legacy.roundTripCostLossUsd;
  delete legacy.allInLossUsd;
  delete legacy.feeBps;
  delete legacy.bufferBps;
  delete legacy.feeEvidenceAt;
  delete legacy.bufferEvidenceAt;
  return legacy;
}
