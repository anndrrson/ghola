import { describe, expect, it } from "vitest";
import {
  acknowledgeTerminalAlertEvents,
  createTerminalCustomAlertRule,
  defaultTerminalAlertRules,
  deriveTerminalPlanLevelAlert,
  deriveTerminalSavedPlanAlertRules,
  evaluateTerminalAlerts,
  removeTerminalSavedPlanAlertRules,
  reconcileTerminalAlertRules,
  terminalSavedPlanIdFromAlertRuleId,
  terminalSavedPlanWatchIds,
  terminalAlertActiveBreaches,
  terminalAlertActiveBreachesEqual,
  type TerminalAlertRule,
  unacknowledgedTerminalAlertCount,
  validTerminalSavedPlanAlertRemovalRequest,
  terminalAlertSummaryEqual,
  upsertTerminalAlertRule,
} from "./terminal-alerts";

const ABOVE: TerminalAlertRule = {
  id: "spread",
  label: "Spread wide",
  metric: "spread_bps",
  operator: "above",
  threshold: 10,
  enabled: true,
  cooldownMs: 1_000,
  rearmDelta: 2,
};

describe("terminal alerts", () => {
  it("establishes a baseline and triggers only on a threshold crossing", () => {
    const baseline = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 9 }, nowMs: 1_000 });
    expect(baseline.events).toEqual([]);
    const crossed = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 11 }, states: baseline.states, nowMs: 1_100 });
    expect(crossed.events).toMatchObject([{ ruleId: "spread", observed: 11 }]);
    expect(crossed.events[0].acknowledgedAt).toBeNull();
    const stillWide = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 12 }, states: crossed.states, nowMs: 3_000 });
    expect(stillWide.events).toEqual([]);
  });

  it("re-arms only after hysteresis and respects cooldown", () => {
    const fired = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 11 },
      states: { spread: { armed: true, previousValue: 9, lastTriggeredAt: null } },
      nowMs: 1_000,
    });
    const notRearmed = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 9 }, states: fired.states, nowMs: 1_200 });
    expect(notRearmed.states.spread.armed).toBe(false);
    const rearmed = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 8 }, states: notRearmed.states, nowMs: 1_300 });
    expect(rearmed.states.spread.armed).toBe(true);
    const cooled = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 11 }, states: rearmed.states, nowMs: 1_500 });
    expect(cooled.events).toEqual([]);
    const safeAgain = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 8 }, states: cooled.states, nowMs: 2_100 });
    const firedAgain = evaluateTerminalAlerts({ rules: [ABOVE], snapshot: { spread_bps: 11 }, states: safeAgain.states, nowMs: 2_200 });
    expect(firedAgain.events).toHaveLength(1);
  });

  it("supports below rules and ignores missing, disabled, invalid, and duplicate inputs", () => {
    const below: TerminalAlertRule = { ...ABOVE, id: "ask-heavy", metric: "book_imbalance_pct", operator: "below", threshold: -35, rearmDelta: 5 };
    const baseline = evaluateTerminalAlerts({ rules: [below], snapshot: { book_imbalance_pct: -20 }, nowMs: 1 });
    const fired = evaluateTerminalAlerts({ rules: [below], snapshot: { book_imbalance_pct: -40 }, states: baseline.states, nowMs: 2 });
    expect(fired.events).toHaveLength(1);
    const invalid = { ...ABOVE, id: "", threshold: Number.NaN };
    const ignored = evaluateTerminalAlerts({
      rules: [{ ...ABOVE, enabled: false }, ABOVE, ABOVE, invalid],
      snapshot: {},
      nowMs: 3,
    });
    expect(Object.keys(ignored.states)).toEqual(["spread"]);
    expect(ignored.events).toEqual([]);
  });

  it("resets crossing continuity across missing data", () => {
    const baseline = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 9 },
      nowMs: 1_000,
    });
    const missing = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: null },
      states: baseline.states,
      nowMs: 1_100,
    });
    expect(missing.states.spread).toMatchObject({ armed: true, previousValue: null });

    const resumedAbove = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 11 },
      states: missing.states,
      nowMs: 1_200,
    });
    expect(resumedAbove.events).toEqual([]);
    expect(resumedAbove.states.spread.previousValue).toBe(11);

    const safe = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 8 },
      states: resumedAbove.states,
      nowMs: 1_300,
    });
    const trueCrossing = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 11 },
      states: safe.states,
      nowMs: 1_400,
    });
    expect(trueCrossing.events).toMatchObject([{ ruleId: "spread", observed: 11 }]);
  });

  it("builds a complete default professional rule set", () => {
    const rules = defaultTerminalAlertRules(100);
    expect(rules).toHaveLength(16);
    expect(rules.map((rule) => rule.metric)).toEqual(expect.arrayContaining([
      "price",
      "spread_bps",
      "book_imbalance_pct",
      "microprice_edge_bps",
      "realized_volatility_bps",
      "funding_rate_bps",
      "route_improvement_bps",
      "feed_health_score",
      "receipt_latency_ms",
      "market_age_ms",
      "book_age_ms",
      "trades_age_ms",
    ]));
    expect(defaultTerminalAlertRules(null)).toHaveLength(14);
  });

  it("alerts when feed health degrades or receipt latency crosses its budget", () => {
    const rules = defaultTerminalAlertRules(null).filter((rule) => rule.id === "feed-health-low" || rule.id === "receipt-latency-high");
    const baseline = evaluateTerminalAlerts({
      rules,
      snapshot: { feed_health_score: 90, receipt_latency_ms: 500 },
      nowMs: 1_000,
    });
    const degraded = evaluateTerminalAlerts({
      rules,
      snapshot: { feed_health_score: 59, receipt_latency_ms: 1_001 },
      states: baseline.states,
      nowMs: 1_100,
    });
    expect(degraded.events).toMatchObject([
      { metric: "feed_health_score", observed: 59 },
      { metric: "receipt_latency_ms", observed: 1_001 },
    ]);
  });

  it("projects already-active conditions without creating crossing history", () => {
    const rules = defaultTerminalAlertRules(null).filter((rule) => rule.id === "feed-health-low" || rule.id === "receipt-latency-high");
    const breaches = terminalAlertActiveBreaches({
      rules,
      snapshot: { feed_health_score: 35, receipt_latency_ms: 1_500 },
    });
    expect(breaches).toMatchObject([
      { ruleId: "feed-health-low", observed: 35 },
      { ruleId: "receipt-latency-high", observed: 1_500 },
    ]);
    expect(evaluateTerminalAlerts({ rules, snapshot: { feed_health_score: 35, receipt_latency_ms: 1_500 }, nowMs: 1 }).events).toEqual([]);
    expect(terminalAlertActiveBreachesEqual(breaches, breaches.map((item) => ({ ...item })))).toBe(true);
    expect(terminalAlertActiveBreaches({ rules, snapshot: { feed_health_score: null, receipt_latency_ms: 999 } })).toEqual([]);
  });

  it("alerts on an independently stale executable book after a certified crossing", () => {
    const rule = defaultTerminalAlertRules(null).find((candidate) => candidate.id === "book-stale")!;
    const baseline = evaluateTerminalAlerts({ rules: [rule], snapshot: { book_age_ms: 19_000 }, nowMs: 1_000 });
    const crossed = evaluateTerminalAlerts({ rules: [rule], snapshot: { book_age_ms: 20_001 }, states: baseline.states, nowMs: 2_000 });
    expect(crossed.events).toMatchObject([{ metric: "book_age_ms", observed: 20_001 }]);
  });

  it("adds missing built-ins without overwriting stored customization", () => {
    const customized = { ...ABOVE, threshold: 17, enabled: false };
    const reconciled = reconcileTerminalAlertRules([customized], defaultTerminalAlertRules(100));
    expect(reconciled.find((rule) => rule.id === ABOVE.id)).toEqual(customized);
    expect(reconciled.find((rule) => rule.id === "route-improvement")).toMatchObject({ metric: "route_improvement_bps", threshold: 5 });
    expect(reconciled.filter((rule) => rule.id === ABOVE.id)).toHaveLength(1);
  });

  it("migrates the legacy gross-route label to the all-in contract", () => {
    const legacy = {
      ...defaultTerminalAlertRules(100).find((rule) => rule.id === "route-improvement")!,
      label: "Full-fill peer route improves by 5 bp",
      threshold: 7,
      enabled: false,
    };
    expect(reconcileTerminalAlertRules([legacy], defaultTerminalAlertRules(100))[0]).toMatchObject({
      id: "route-improvement",
      label: "All-in full-fill peer improves by 5 bp",
      threshold: 7,
      enabled: false,
    });
  });

  it("alerts only on a certified peer-route improvement crossing", () => {
    const rule = defaultTerminalAlertRules(100).find((item) => item.metric === "route_improvement_bps")!;
    const baseline = evaluateTerminalAlerts({ rules: [rule], snapshot: { route_improvement_bps: 0 }, nowMs: 1_000 });
    const crossed = evaluateTerminalAlerts({ rules: [rule], snapshot: { route_improvement_bps: 6 }, states: baseline.states, nowMs: 1_100 });
    expect(crossed.events).toMatchObject([{ ruleId: "route-improvement", observed: 6 }]);

    const missing = evaluateTerminalAlerts({ rules: [rule], snapshot: { route_improvement_bps: null }, states: baseline.states, nowMs: 1_100 });
    const resumedAbove = evaluateTerminalAlerts({ rules: [rule], snapshot: { route_improvement_bps: 6 }, states: missing.states, nowMs: 1_200 });
    expect(resumedAbove.events).toEqual([]);
  });

  it("alerts on signed funding extremes and resets continuity when certification disappears", () => {
    const positive = defaultTerminalAlertRules(null).find((item) => item.id === "funding-positive")!;
    const baseline = evaluateTerminalAlerts({ rules: [positive], snapshot: { funding_rate_bps: 0.8 }, nowMs: 1_000 });
    const crossed = evaluateTerminalAlerts({ rules: [positive], snapshot: { funding_rate_bps: 1.25 }, states: baseline.states, nowMs: 1_100 });
    expect(crossed.events).toMatchObject([{ ruleId: "funding-positive", observed: 1.25 }]);

    const negative = defaultTerminalAlertRules(null).find((item) => item.id === "funding-negative")!;
    const negativeBaseline = evaluateTerminalAlerts({ rules: [negative], snapshot: { funding_rate_bps: -0.8 }, nowMs: 2_000 });
    const missing = evaluateTerminalAlerts({ rules: [negative], snapshot: { funding_rate_bps: null }, states: negativeBaseline.states, nowMs: 2_100 });
    const resumedBeyond = evaluateTerminalAlerts({ rules: [negative], snapshot: { funding_rate_bps: -1.25 }, states: missing.states, nowMs: 2_200 });
    expect(resumedBeyond.events).toEqual([]);
  });

  it("alerts on signed microprice edges without bridging an uncertified book gap", () => {
    const positive = defaultTerminalAlertRules(null).find((item) => item.id === "microprice-bid-edge")!;
    const baseline = evaluateTerminalAlerts({ rules: [positive], snapshot: { microprice_edge_bps: 4 }, nowMs: 1_000 });
    const crossed = evaluateTerminalAlerts({ rules: [positive], snapshot: { microprice_edge_bps: 6 }, states: baseline.states, nowMs: 1_100 });
    expect(crossed.events).toMatchObject([{ ruleId: "microprice-bid-edge", observed: 6 }]);

    const negative = defaultTerminalAlertRules(null).find((item) => item.id === "microprice-ask-edge")!;
    const negativeBaseline = evaluateTerminalAlerts({ rules: [negative], snapshot: { microprice_edge_bps: -4 }, nowMs: 2_000 });
    const missing = evaluateTerminalAlerts({ rules: [negative], snapshot: { microprice_edge_bps: null }, states: negativeBaseline.states, nowMs: 2_100 });
    const resumedBeyond = evaluateTerminalAlerts({ rules: [negative], snapshot: { microprice_edge_bps: -6 }, states: missing.states, nowMs: 2_200 });
    expect(resumedBeyond.events).toEqual([]);
  });

  it("builds strict custom rules with metric-specific hysteresis", () => {
    expect(createTerminalCustomAlertRule({
      id: "custom-funding-1",
      metric: "funding_rate_bps",
      operator: "below",
      threshold: -1.25,
    })).toEqual({
      id: "custom-funding-1",
      label: "Funding rate below",
      metric: "funding_rate_bps",
      operator: "below",
      threshold: -1.25,
      enabled: true,
      cooldownMs: 60_000,
      rearmDelta: 0.25,
    });
    expect(createTerminalCustomAlertRule({
      id: "custom-price-1",
      metric: "price",
      operator: "above",
      threshold: 100,
    })?.rearmDelta).toBeCloseTo(0.1);
  });

  it("rejects malformed custom identifiers, invalid price thresholds, and nonfinite values", () => {
    expect(createTerminalCustomAlertRule({ id: "preset", metric: "spread_bps", operator: "above", threshold: 10 })).toBeNull();
    expect(createTerminalCustomAlertRule({ id: "custom-price", metric: "price", operator: "below", threshold: 0 })).toBeNull();
    expect(createTerminalCustomAlertRule({ id: "custom-nan", metric: "spread_bps", operator: "above", threshold: Number.NaN })).toBeNull();
  });

  it("acknowledges one event or all unread events without mutating history", () => {
    const first = evaluateTerminalAlerts({
      rules: [ABOVE],
      snapshot: { spread_bps: 11 },
      states: { spread: { armed: true, previousValue: 9, lastTriggeredAt: null } },
      nowMs: 1_000,
    }).events[0];
    const second = { ...first, id: "spread:2000", triggeredAt: 2_000 };
    const original = [first, second];

    const one = acknowledgeTerminalAlertEvents(original, first.id, 3_000);
    expect(original.every((event) => event.acknowledgedAt == null)).toBe(true);
    expect(one.map((event) => event.acknowledgedAt)).toEqual([3_000, null]);
    expect(unacknowledgedTerminalAlertCount(one)).toBe(1);

    const all = acknowledgeTerminalAlertEvents(one, null, 4_000);
    expect(all.map((event) => event.acknowledgedAt)).toEqual([3_000, 4_000]);
    expect(unacknowledgedTerminalAlertCount(all)).toBe(0);
    expect(() => acknowledgeTerminalAlertEvents(all, null, Number.NaN)).toThrow("terminal_alert_ack_time_invalid");
  });

  it("builds directional staged-plan alerts and upserts them without duplication", () => {
    const entry = deriveTerminalPlanLevelAlert({ kind: "entry", level: 101, referencePrice: 100 });
    const target = deriveTerminalPlanLevelAlert({ kind: "target", level: 104, referencePrice: 100 });
    const invalidation = deriveTerminalPlanLevelAlert({ kind: "invalidation", level: 98, referencePrice: 100 });
    expect(entry).toMatchObject({ blocker: null, rule: { id: "plan-entry", operator: "above", threshold: 101 } });
    expect(target).toMatchObject({ blocker: null, rule: { id: "plan-target", label: "Plan target crossed above", operator: "above", threshold: 104 } });
    expect(invalidation).toMatchObject({ blocker: null, rule: { id: "plan-invalidation", operator: "below", threshold: 98 } });

    const first = upsertTerminalAlertRule([ABOVE], entry.rule!);
    const updatedRule = deriveTerminalPlanLevelAlert({ kind: "entry", level: 102, referencePrice: 100 }).rule!;
    const updated = upsertTerminalAlertRule(first, updatedRule);
    expect(updated.filter((rule) => rule.id === "plan-entry")).toEqual([updatedRule]);
    expect(updated.find((rule) => rule.id === ABOVE.id)).toBe(ABOVE);
  });

  it("fails staged-plan alert creation closed without a distinct certified level", () => {
    expect(deriveTerminalPlanLevelAlert({ kind: "entry", level: 101, referencePrice: null }).blocker).toBe("reference_unavailable");
    expect(deriveTerminalPlanLevelAlert({ kind: "entry", level: 0, referencePrice: 100 }).blocker).toBe("level_invalid");
    expect(deriveTerminalPlanLevelAlert({ kind: "entry", level: 100, referencePrice: 100 }).blocker).toBe("direction_ambiguous");
  });

  it("atomically derives uniquely scoped saved-plan instrument watches", () => {
    const request = {
      requestId: "saved-plan:plan_1:1",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
      entryPrice: 101,
      targetPrice: 104,
      invalidationPrice: 98,
    };
    expect(deriveTerminalSavedPlanAlertRules({ request, referencePrice: 100 })).toMatchObject({
      blocker: null,
      rules: [
        { id: "saved-plan-plan_1-entry", label: "Pullback A · instrument plan entry crossed above", threshold: 101 },
        { id: "saved-plan-plan_1-target", threshold: 104 },
        { id: "saved-plan-plan_1-invalidation", operator: "below", threshold: 98 },
      ],
    });
    expect(deriveTerminalSavedPlanAlertRules({ request, referencePrice: null }).blocker).toBe("reference_unavailable");
    expect(deriveTerminalSavedPlanAlertRules({ request: { ...request, requestId: "bad" }, referencePrice: 100 }).blocker).toBe("request_invalid");
    expect(deriveTerminalSavedPlanAlertRules({ request: { ...request, entryPrice: 100 }, referencePrice: 100 }).blocker).toBe("direction_ambiguous");
  });

  it("tracks only complete saved-plan watches and removes one plan atomically", () => {
    const request = {
      requestId: "saved-plan:plan_1:1",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
      entryPrice: 101,
      targetPrice: 104,
      invalidationPrice: 98,
    };
    const first = deriveTerminalSavedPlanAlertRules({ request, referencePrice: 100 }).rules ?? [];
    const second = deriveTerminalSavedPlanAlertRules({
      request: { ...request, requestId: "saved-plan:plan_2:2", planId: "plan_2", planName: "Breakout B" },
      referencePrice: 100,
    }).rules ?? [];
    const rules = [ABOVE, ...first, ...second];

    expect(terminalSavedPlanWatchIds(rules)).toEqual(["plan_1", "plan_2"]);
    expect(terminalSavedPlanWatchIds(rules.filter((rule) => rule.id !== "saved-plan-plan_2-target"))).toEqual(["plan_1"]);
    expect(removeTerminalSavedPlanAlertRules(rules, new Set(["plan_1"]))).toEqual([ABOVE, ...second]);
    expect(terminalSavedPlanIdFromAlertRuleId("saved-plan-plan_1-entry")).toBe("plan_1");
    expect(terminalSavedPlanIdFromAlertRuleId("custom-plan_1-entry")).toBeNull();
  });

  it("validates saved-plan removal commands exactly", () => {
    const request = {
      requestId: "saved-plan-remove:plan_1:3",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
    };
    expect(validTerminalSavedPlanAlertRemovalRequest(request)).toBe(true);
    expect(validTerminalSavedPlanAlertRemovalRequest({ ...request, requestId: "remove:plan_1:3" })).toBe(false);
    expect(validTerminalSavedPlanAlertRemovalRequest({ ...request, planId: "bad id" })).toBe(false);
  });

  it("compares cold alert summaries by exact annunciator fields", () => {
    const summary = { scope: "BTC", activeCount: 1, primaryActiveLabel: "Spread", unreadCount: 1, latestUnreadLabel: "Entry", latestTriggeredAt: 10 };
    expect(terminalAlertSummaryEqual(summary, { ...summary })).toBe(true);
    expect(terminalAlertSummaryEqual(summary, { ...summary, unreadCount: 2 })).toBe(false);
    expect(terminalAlertSummaryEqual(summary, { ...summary, activeCount: 2 })).toBe(false);
    expect(terminalAlertSummaryEqual(summary, { ...summary, scope: "ETH" })).toBe(false);
  });
});
