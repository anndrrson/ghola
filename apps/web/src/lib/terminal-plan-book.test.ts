import { describe, expect, it } from "vitest";
import {
  deriveTerminalPlanEconomics,
  deriveTerminalPlanRestoreDecision,
  emptyTerminalPlanBookStore,
  inspectTerminalPlanBookStore,
  mergeTerminalPlanBookStores,
  removeTerminalPlanSnapshot,
  serializeTerminalPlanBookStore,
  terminalPlanBookIdentityKey,
  terminalPlanBookStorageKey,
  terminalPlansOutsideIdentity,
  terminalPlansForIdentity,
  upsertTerminalPlanSnapshot,
  type TerminalPlanBookIdentity,
  type TerminalPlanSnapshot,
} from "./terminal-plan-book";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const IDENTITY: TerminalPlanBookIdentity = {
  venue: "hyperliquid",
  network: "mainnet",
  product: "BTC-PERP",
  interval: "5m",
};

describe("terminal plan book", () => {
  it("uses exact account namespaces and canonical instrument identity", () => {
    expect(terminalPlanBookStorageKey("device_guest")).toBe("ghola.terminal-plan-book.v1:device_guest");
    expect(terminalPlanBookStorageKey(`subject_${"a".repeat(32)}`)).not.toBe(terminalPlanBookStorageKey(`subject_${"b".repeat(32)}`));
    expect(terminalPlanBookStorageKey("subject_short")).toBeNull();
    expect(terminalPlanBookIdentityKey(IDENTITY)).toBe("hyperliquid:mainnet:BTC-PERP:5m");
    expect(terminalPlanBookIdentityKey({ ...IDENTITY, venue: "coinbase", network: "testnet" })).toBeNull();
  });

  it("round trips bounded plans and updates a same-name instrument plan monotonically", () => {
    const first = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), draft(), NOW);
    const second = upsertTerminalPlanSnapshot(first, { ...draft("different-id"), entryPrice: 101, invalidationPrice: 99 }, NOW);
    expect(second.plans).toHaveLength(1);
    expect(second.plans[0]).toMatchObject({ id: "plan-1", entryPrice: 101, savedAt: NOW + 1 });
    const raw = serializeTerminalPlanBookStore(second, NOW + 1);
    expect(inspectTerminalPlanBookStore(raw, NOW + 1)).toMatchObject({ status: "ready", store: second });
    expect(terminalPlansForIdentity(second, IDENTITY)).toHaveLength(1);
    expect(terminalPlansForIdentity(second, { ...IDENTITY, product: "ETH-PERP" })).toEqual([]);
    expect(terminalPlansOutsideIdentity(second, IDENTITY)).toEqual([]);
  });

  it("migrates legacy snapshots without inventing a thesis and rejects partial context", () => {
    const current = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), draft(), NOW);
    const legacyPlan = { ...current.plans[0] } as Record<string, unknown>;
    delete legacyPlan.setup;
    delete legacyPlan.thesis;
    delete legacyPlan.invalidationNote;
    const legacy = inspectTerminalPlanBookStore(JSON.stringify({ ...current, plans: [legacyPlan] }), NOW);
    expect(legacy).toMatchObject({
      status: "ready",
      store: { plans: [{ setup: null, thesis: null, invalidationNote: null }] },
    });
    expect(inspectTerminalPlanBookStore(JSON.stringify({ ...current, plans: [{ ...legacyPlan, setup: "pullback" }] }), NOW).status).toBe("blocked");
  });

  it("normalizes bounded decision context and rejects missing or oversized rationale", () => {
    const normalized = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      thesis: "  Buyers   defended support.  ",
      invalidationNote: "  Support fails. ",
    }, NOW);
    expect(normalized.plans[0]).toMatchObject({ thesis: "Buyers defended support.", invalidationNote: "Support fails." });
    expect(() => upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), { ...draft(), thesis: "" }, NOW)).toThrow("terminal_plan_snapshot_invalid");
    expect(() => upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), { ...draft(), thesis: "x".repeat(241) }, NOW)).toThrow("terminal_plan_snapshot_invalid");
  });

  it("enforces six plans per identity and preserves separate instruments", () => {
    let store = emptyTerminalPlanBookStore();
    for (let index = 0; index < 6; index += 1) {
      store = upsertTerminalPlanSnapshot(store, { ...draft(`p${index}`), name: `Plan ${index}` }, NOW + index);
    }
    expect(() => upsertTerminalPlanSnapshot(store, { ...draft("overflow"), name: "Overflow" }, NOW + 10)).toThrow("terminal_plan_book_limit");
    const other = upsertTerminalPlanSnapshot(store, {
      ...draft("eth"),
      name: "ETH plan",
      identity: { ...IDENTITY, product: "ETH-PERP" },
    }, NOW + 10);
    expect(other.plans).toHaveLength(7);
    expect(terminalPlansOutsideIdentity(other, IDENTITY).map((plan) => plan.name)).toEqual(["ETH plan"]);
  });

  it("merges concurrent saves and deletion tombstones without resurrection", () => {
    const base = emptyTerminalPlanBookStore();
    const left = upsertTerminalPlanSnapshot(base, draft("left"), NOW);
    const right = upsertTerminalPlanSnapshot(base, { ...draft("right"), name: "Breakout" }, NOW + 1);
    const merged = mergeTerminalPlanBookStores(left, right, NOW + 1);
    expect(merged.plans.map((plan) => plan.name)).toEqual(["Breakout", "Pullback"]);
    const deleted = removeTerminalPlanSnapshot(merged, "left", NOW + 2);
    expect(mergeTerminalPlanBookStores(deleted, left, NOW + 3).plans.map((plan) => plan.id)).toEqual(["right"]);
    expect(left.plans[0]?.name).toBe("Pullback");
  });

  it("preserves malformed or future storage as blocked", () => {
    expect(inspectTerminalPlanBookStore("{bad", NOW)).toMatchObject({ status: "blocked", raw: "{bad" });
    const valid = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), draft(), NOW);
    const corrupt = { ...valid, plans: [{ ...valid.plans[0], targetRewardMultiple: 2.5 }] };
    expect(inspectTerminalPlanBookStore(JSON.stringify(corrupt), NOW).status).toBe("blocked");
    const future = { ...valid, plans: [{ ...valid.plans[0], savedAt: NOW + 300_001 }] };
    expect(inspectTerminalPlanBookStore(JSON.stringify(future), NOW).status).toBe("blocked");
  });

  it("classifies exact restore freshness, review, and fail-closed blockers", () => {
    const plan = snapshot();
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: 100.5, nowMs: NOW + 30_000 })).toMatchObject({
      status: "ready",
      ageMs: 30_000,
      driftBps: 50,
      targetPrice: 104,
    });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: 103, nowMs: NOW + 2 * 60 * 60_000 })).toMatchObject({ status: "confirm", driftBps: 300 });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: { ...IDENTITY, product: "ETH-PERP" }, currentReferencePrice: 100, nowMs: NOW })).toMatchObject({ status: "blocked", blocker: "identity_mismatch" });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: null, nowMs: NOW })).toMatchObject({ status: "blocked", blocker: "reference_unavailable" });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: 151, nowMs: NOW })).toMatchObject({ status: "blocked", blocker: "market_drift_excessive" });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: 100, nowMs: NOW + 31 * 24 * 60 * 60_000 })).toMatchObject({ status: "blocked", blocker: "snapshot_expired" });
    expect(deriveTerminalPlanRestoreDecision({ plan, identity: IDENTITY, currentReferencePrice: 100, nowMs: NOW - 31_000 })).toMatchObject({ status: "blocked", blocker: "snapshot_future" });
  });

  it("derives side-symmetric saved-plan dollar risk, target, and budget utilization", () => {
    expect(deriveTerminalPlanEconomics(snapshot())).toMatchObject({
      targetPrice: 104,
      stopDistanceBps: 200,
      totalRiskBps: 250,
      modeledLossUsd: 0.25,
      targetProfitUsd: 0.35,
      budgetUtilizationPct: 25,
      netRewardRisk: 1.4,
      withinBudget: true,
    });
    expect(deriveTerminalPlanEconomics({
      ...snapshot(),
      side: "sell",
      invalidationPrice: 102,
    })).toMatchObject({ targetPrice: 96, modeledLossUsd: 0.25, targetProfitUsd: 0.35 });
    expect(deriveTerminalPlanEconomics({ ...snapshot(), notionalUsd: 100, riskBudgetUsd: 1 })).toMatchObject({
      modeledLossUsd: 2.5,
      budgetUtilizationPct: 250,
      withinBudget: false,
    });
  });

  it("fails saved-plan economics closed for invalid runtime values", () => {
    expect(deriveTerminalPlanEconomics({ ...snapshot(), invalidationPrice: 101 })).toBeNull();
    expect(deriveTerminalPlanEconomics({ ...snapshot(), notionalUsd: Number.NaN })).toBeNull();
  });
});

function draft(id = "plan-1"): Omit<TerminalPlanSnapshot, "savedAt"> {
  return {
    id,
    name: "Pullback",
    identity: IDENTITY,
    side: "buy",
    entryPrice: 100,
    invalidationPrice: 98,
    targetRewardMultiple: 2,
    notionalUsd: 10,
    riskBudgetUsd: 1,
    slippageBps: 50,
    certifiedReferencePrice: 100,
    setup: "pullback",
    thesis: "Bid support should hold after the retracement.",
    invalidationNote: "Support fails on accepted trade below the planned level.",
  };
}

function snapshot(): TerminalPlanSnapshot {
  return { ...draft(), savedAt: NOW };
}
