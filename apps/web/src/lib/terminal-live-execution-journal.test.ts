import { describe, expect, it } from "vitest";
import type { TerminalLiveExecutionReceipt } from "./terminal-live-execution-receipt";
import {
  appendTerminalLiveExecutionJournal,
  discardTerminalLiveExecutionPendingEntry,
  externallyReviewTerminalLiveExecutionJournalEntry,
  parseTerminalLiveExecutionJournal,
  parseTerminalLiveExecutionLock,
  persistTerminalLiveExecutionJournalEntry,
  readTerminalLiveExecutionJournalStorage,
  serializeTerminalLiveExecutionJournal,
  serializeTerminalLiveExecutionLock,
  terminalLiveExecutionJournalHasUnresolved,
  terminalLiveExecutionJournalSafetyState,
  terminalLiveExecutionJournalSummary,
  terminalLiveExecutionExternalReviewDecision,
  terminalLiveExecutionReviewEvidenceCrossed,
  terminalLiveExecutionLockStorageKey,
  terminalLiveExecutionJournalEntryFromReceipt,
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

  it("strictly persists unresolved safety state and supports explicit external review", () => {
    const unknown = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(0) })!;
    const hydrated = parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal([unknown]));
    expect(hydrated).toEqual([unknown]);
    expect(terminalLiveExecutionJournalHasUnresolved(hydrated!)).toBe(true);
    const reviewed = externallyReviewTerminalLiveExecutionJournalEntry(hydrated!, digest(0), iso(3));
    expect(reviewed[0]).toMatchObject({ outcome: "externally_reviewed", status: "externally_reviewed", reviewedAt: iso(3), reason: "external_account_review" });
    expect(terminalLiveExecutionJournalHasUnresolved(reviewed)).toBe(false);
    expect(terminalLiveExecutionJournalSafetyState("ready", reviewed)).toBe("ready");
    expect(terminalLiveExecutionJournalSafetyState("ready", hydrated!)).toBe("unresolved");
    expect(terminalLiveExecutionJournalSafetyState("loading", [])).toBe("loading");
    expect(parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal(reviewed))).toEqual(reviewed);
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

  it("requires a current post-submit Hyperliquid account snapshot before external review", () => {
    const entry = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(2) })!;
    const decide = (overrides: Partial<Parameters<typeof terminalLiveExecutionExternalReviewDecision>[0]> = {}) => terminalLiveExecutionExternalReviewDecision({
      entry,
      selectedVenue: "hyperliquid",
      selectedNetwork: "mainnet",
      accountStreamCurrent: true,
      accountStreamObservedAtMs: Date.parse(iso(3)),
      ...overrides,
    });
    expect(decide()).toEqual({ allowed: true, blocker: null });
    expect(decide({ selectedNetwork: "testnet" }).blocker).toBe("account_context_mismatch");
    expect(decide({ accountStreamCurrent: false }).blocker).toBe("account_stream_not_current");
    expect(decide({ accountStreamObservedAtMs: Date.parse(iso(1)) }).blocker).toBe("account_snapshot_predates_submit");
    expect(decide({ accountStreamObservedAtMs: null }).blocker).toBe("account_snapshot_predates_submit");
    expect(decide({ entry: { ...entry, venue: "coinbase" }, selectedVenue: "coinbase" })).toEqual({ allowed: true, blocker: null });
    expect(decide({ entry: { ...entry, venue: "coinbase" }, selectedVenue: "hyperliquid" }).blocker).toBe("account_context_mismatch");
    expect(decide({ entry: { ...entry, venue: "phoenix" }, selectedVenue: "phoenix", selectedNetwork: "testnet" }).blocker).toBe("account_context_mismatch");
  });

  it("signals only the first account-observation crossing of an unresolved Hyperliquid submit", () => {
    const entry = terminalLiveExecutionUnknownJournalEntry({ planDigest: digest(0), plan: plan(), reason: "execution_transport_outcome_unknown", recordedAt: iso(2) })!;
    expect(terminalLiveExecutionReviewEvidenceCrossed([entry], Date.parse(iso(1)), Date.parse(iso(2)))).toBe(true);
    expect(terminalLiveExecutionReviewEvidenceCrossed([entry], Date.parse(iso(2)), Date.parse(iso(3)))).toBe(false);
    expect(terminalLiveExecutionReviewEvidenceCrossed([{ ...entry, venue: "coinbase" }], null, Date.parse(iso(3)))).toBe(false);
    expect(terminalLiveExecutionReviewEvidenceCrossed([{ ...entry, status: "externally_reviewed", outcome: "externally_reviewed" }], null, Date.parse(iso(3)))).toBe(false);
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
    const reviewed = externallyReviewTerminalLiveExecutionJournalEntry([unknown], unknown.planDigest, iso(3))[0];
    expect(() => serializeTerminalLiveExecutionLock(reviewed)).toThrow();
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

function receipt(status: "submitted" | "reconciled"): TerminalLiveExecutionReceipt {
  return { status, commitment: "run_commitment_123", orderId: "venue_order_456", planDigest: digest(0), receivedAt: iso(status === "submitted" ? 1 : 2) };
}

function digest(index: number) { return `sha256:${index.toString(16).padStart(64, "0")}`; }
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
