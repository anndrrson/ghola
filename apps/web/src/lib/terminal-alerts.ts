export const TERMINAL_ALERT_METRICS = [
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
  "candles_age_ms",
] as const;
export const TERMINAL_CUSTOM_ALERT_LIMIT = 12;

export type TerminalAlertMetric = (typeof TERMINAL_ALERT_METRICS)[number];

export type TerminalAlertOperator = "above" | "below";

export interface TerminalAlertRule {
  id: string;
  label: string;
  metric: TerminalAlertMetric;
  operator: TerminalAlertOperator;
  threshold: number;
  enabled: boolean;
  cooldownMs: number;
  rearmDelta: number;
}

export type TerminalAlertSnapshot = Partial<Record<TerminalAlertMetric, number | null>>;

export interface TerminalAlertRuleState {
  armed: boolean;
  previousValue: number | null;
  lastTriggeredAt: number | null;
}

export interface TerminalAlertEvent {
  id: string;
  ruleId: string;
  label: string;
  metric: TerminalAlertMetric;
  operator: TerminalAlertOperator;
  threshold: number;
  observed: number;
  triggeredAt: number;
  acknowledgedAt: number | null;
}

export interface TerminalAlertEvaluation {
  states: Record<string, TerminalAlertRuleState>;
  events: TerminalAlertEvent[];
}

export interface TerminalAlertActiveBreach {
  ruleId: string;
  label: string;
  metric: TerminalAlertMetric;
  operator: TerminalAlertOperator;
  threshold: number;
  observed: number;
}

export interface TerminalAlertSummary {
  scope: string | null;
  activeCount: number;
  primaryActiveLabel: string | null;
  unreadCount: number;
  latestUnreadLabel: string | null;
  latestTriggeredAt: number | null;
}

export type TerminalPlanAlertKind = "entry" | "target" | "invalidation";
export type TerminalPlanAlertBlocker = "reference_unavailable" | "level_invalid" | "direction_ambiguous";

export interface TerminalPlanAlertDecision {
  rule: TerminalAlertRule | null;
  blocker: TerminalPlanAlertBlocker | null;
}

export interface TerminalSavedPlanAlertRequest {
  requestId: string;
  planId: string;
  planName: string;
  instrument: string;
  entryPrice: number;
  targetPrice: number;
  invalidationPrice: number;
}

export interface TerminalSavedPlanAlertRemovalRequest {
  requestId: string;
  planId: string;
  planName: string;
  instrument: string;
}

export interface TerminalSavedPlanInventoryItem {
  planId: string;
  instrument: string;
}

export type TerminalSavedPlanAlertsDecision =
  | { rules: [TerminalAlertRule, TerminalAlertRule, TerminalAlertRule]; blocker: null }
  | { rules: null; blocker: "request_invalid" | TerminalPlanAlertBlocker };

export function createTerminalCustomAlertRule(input: {
  id: string;
  metric: TerminalAlertMetric;
  operator: TerminalAlertOperator;
  threshold: number;
}): TerminalAlertRule | null {
  if (!/^custom-[a-zA-Z0-9_-]{1,80}$/u.test(input.id)) return null;
  if (!TERMINAL_ALERT_METRICS.includes(input.metric)) return null;
  if (input.operator !== "above" && input.operator !== "below") return null;
  const threshold = finiteNumber(input.threshold);
  if (threshold == null || Math.abs(threshold) > 1_000_000_000_000) return null;
  if (input.metric === "price" && threshold <= 0) return null;
  return {
    id: input.id,
    label: `${terminalAlertMetricLabel(input.metric)} ${input.operator}`,
    metric: input.metric,
    operator: input.operator,
    threshold,
    enabled: true,
    cooldownMs: 60_000,
    rearmDelta: terminalAlertMetricRearmDelta(input.metric, threshold),
  };
}

export function terminalAlertMetricLabel(metric: TerminalAlertMetric): string {
  if (metric === "price") return "Price";
  if (metric === "spread_bps") return "Spread";
  if (metric === "book_imbalance_pct") return "Book imbalance";
  if (metric === "microprice_edge_bps") return "Microprice edge";
  if (metric === "realized_volatility_bps") return "Realized volatility";
  if (metric === "funding_rate_bps") return "Funding rate";
  if (metric === "route_improvement_bps") return "All-in route improvement";
  if (metric === "feed_health_score") return "Feed health score";
  if (metric === "receipt_latency_ms") return "Receipt latency";
  if (metric === "market_age_ms") return "Quote age";
  if (metric === "book_age_ms") return "Book age";
  if (metric === "trades_age_ms") return "Trades age";
  return "Candles age";
}

export function terminalAlertMetricRearmDelta(metric: TerminalAlertMetric, threshold: number): number {
  if (metric === "price") return Math.max(Math.abs(threshold) * 0.001, Number.EPSILON);
  if (metric === "market_age_ms" || metric === "book_age_ms" || metric === "trades_age_ms" || metric === "candles_age_ms") return 5_000;
  if (metric === "receipt_latency_ms") return 250;
  if (metric === "feed_health_score") return 10;
  if (metric === "book_imbalance_pct") return 5;
  if (metric === "microprice_edge_bps") return 1;
  if (metric === "realized_volatility_bps") return 10;
  if (metric === "funding_rate_bps") return 0.25;
  return 2;
}

export function evaluateTerminalAlerts(input: {
  rules: TerminalAlertRule[];
  snapshot: TerminalAlertSnapshot;
  states?: Record<string, TerminalAlertRuleState>;
  nowMs?: number;
}): TerminalAlertEvaluation {
  const nowMs = finiteTime(input.nowMs) ?? Date.now();
  const states: Record<string, TerminalAlertRuleState> = {};
  const events: TerminalAlertEvent[] = [];
  const seen = new Set<string>();

  for (const rule of input.rules) {
    if (!validRule(rule) || seen.has(rule.id)) continue;
    seen.add(rule.id);
    const current = normalizedState(input.states?.[rule.id]);
    const observed = finiteNumber(input.snapshot[rule.metric]);
    if (!rule.enabled) {
      states[rule.id] = current;
      continue;
    }
    if (observed == null) {
      // Missing certification breaks crossing continuity. Preserve re-arm and
      // cooldown state, but require the next valid sample to establish a new
      // baseline instead of inferring a threshold crossing across an outage.
      states[rule.id] = { ...current, previousValue: null };
      continue;
    }

    const onTriggerSide = crossed(rule.operator, observed, rule.threshold);
    const rearmLevel = rule.operator === "above"
      ? rule.threshold - rule.rearmDelta
      : rule.threshold + rule.rearmDelta;
    let armed = current.armed;
    if (!armed && crossed(rule.operator === "above" ? "below" : "above", observed, rearmLevel)) {
      armed = true;
    }
    const crossedFromSafeSide = current.previousValue != null
      && !crossed(rule.operator, current.previousValue, rule.threshold)
      && onTriggerSide;
    const cooldownReady = current.lastTriggeredAt == null || nowMs - current.lastTriggeredAt >= rule.cooldownMs;
    const trigger = armed && crossedFromSafeSide && cooldownReady;
    const lastTriggeredAt = trigger ? nowMs : current.lastTriggeredAt;
    if (trigger) {
      events.push({
        id: `${rule.id}:${nowMs}`,
        ruleId: rule.id,
        label: rule.label,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        observed,
        triggeredAt: nowMs,
        acknowledgedAt: null,
      });
    }
    states[rule.id] = {
      armed: trigger ? false : armed,
      previousValue: observed,
      lastTriggeredAt,
    };
  }
  return { states, events };
}

/** Current conditions only; never creates history or browser notifications. */
export function terminalAlertActiveBreaches(input: {
  rules: readonly TerminalAlertRule[];
  snapshot: TerminalAlertSnapshot;
}): TerminalAlertActiveBreach[] {
  const breaches: TerminalAlertActiveBreach[] = [];
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!validRule(rule) || seen.has(rule.id)) continue;
    seen.add(rule.id);
    if (!rule.enabled) continue;
    const observed = finiteNumber(input.snapshot[rule.metric]);
    if (observed == null || !crossed(rule.operator, observed, rule.threshold)) continue;
    breaches.push({
      ruleId: rule.id,
      label: rule.label,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      observed,
    });
  }
  return breaches;
}

export function terminalAlertActiveBreachesEqual(
  left: readonly TerminalAlertActiveBreach[],
  right: readonly TerminalAlertActiveBreach[],
) {
  return left === right || (
    left.length === right.length
    && left.every((breach, index) => {
      const candidate = right[index];
      return candidate != null
        && breach.ruleId === candidate.ruleId
        && breach.label === candidate.label
        && breach.metric === candidate.metric
        && breach.operator === candidate.operator
        && breach.threshold === candidate.threshold
        && breach.observed === candidate.observed;
    })
  );
}

export function acknowledgeTerminalAlertEvents(
  events: readonly TerminalAlertEvent[],
  eventId: string | null,
  nowMs: number = Date.now(),
): TerminalAlertEvent[] {
  const acknowledgedAt = finiteTime(nowMs);
  if (acknowledgedAt == null) throw new Error("terminal_alert_ack_time_invalid");
  let changed = false;
  const next = events.map((event) => {
    if (event.acknowledgedAt != null || (eventId != null && event.id !== eventId)) return event;
    changed = true;
    return { ...event, acknowledgedAt };
  });
  return changed ? next : events.slice();
}

export function unacknowledgedTerminalAlertCount(events: readonly TerminalAlertEvent[]) {
  let count = 0;
  for (const event of events) {
    if (event.acknowledgedAt == null) count += 1;
  }
  return count;
}

export function terminalAlertSummaryEqual(left: TerminalAlertSummary, right: TerminalAlertSummary) {
  return left.scope === right.scope
    && left.activeCount === right.activeCount
    && left.primaryActiveLabel === right.primaryActiveLabel
    && left.unreadCount === right.unreadCount
    && left.latestUnreadLabel === right.latestUnreadLabel
    && left.latestTriggeredAt === right.latestTriggeredAt;
}

export function deriveTerminalPlanLevelAlert(input: {
  kind: TerminalPlanAlertKind;
  level: number | null;
  referencePrice: number | null;
}): TerminalPlanAlertDecision {
  const referencePrice = finitePositive(input.referencePrice);
  if (referencePrice == null) return { rule: null, blocker: "reference_unavailable" };
  const level = finitePositive(input.level);
  if (level == null) return { rule: null, blocker: "level_invalid" };
  if (Math.abs(level - referencePrice) <= Math.max(Number.EPSILON, referencePrice * 1e-9)) {
    return { rule: null, blocker: "direction_ambiguous" };
  }
  const operator: TerminalAlertOperator = level > referencePrice ? "above" : "below";
  const subject = input.kind === "entry"
    ? "Plan entry"
    : input.kind === "target"
      ? "Plan target"
      : "Plan invalidation";
  return {
    blocker: null,
    rule: {
      id: `plan-${input.kind}`,
      label: `${subject} crossed ${operator}`,
      metric: "price",
      operator,
      threshold: level,
      enabled: true,
      cooldownMs: 60_000,
      rearmDelta: Math.max(level * 0.0005, Number.EPSILON),
    },
  };
}

/** Builds one immutable instrument-price watch from a saved plan. */
export function deriveTerminalSavedPlanAlertRules(input: {
  request: TerminalSavedPlanAlertRequest;
  referencePrice: number | null;
}): TerminalSavedPlanAlertsDecision {
  const request = input.request;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/u.test(request.planId)
    || !/^saved-plan:[A-Za-z0-9_-]{1,64}:\d+$/u.test(request.requestId)
    || typeof request.planName !== "string"
    || request.planName.trim().length === 0
    || request.planName.trim().length > 32
    || typeof request.instrument !== "string"
    || request.instrument.length < 2
    || request.instrument.length > 32
  ) return { rules: null, blocker: "request_invalid" };
  const decisions = [
    ["entry", request.entryPrice] as const,
    ["target", request.targetPrice] as const,
    ["invalidation", request.invalidationPrice] as const,
  ].map(([kind, level]) => ({ kind, decision: deriveTerminalPlanLevelAlert({ kind, level, referencePrice: input.referencePrice }) }));
  const blocked = decisions.find(({ decision }) => !decision.rule);
  if (blocked) return { rules: null, blocker: blocked.decision.blocker ?? "request_invalid" };
  const planName = request.planName.trim();
  const rules = decisions.map(({ kind, decision }) => ({
    ...decision.rule!,
    id: `saved-plan-${request.planId}-${kind}`,
    label: `${planName} · instrument ${decision.rule!.label.toLowerCase()}`,
  })) as [TerminalAlertRule, TerminalAlertRule, TerminalAlertRule];
  return { rules, blocker: null };
}

export function terminalSavedPlanIdFromAlertRuleId(ruleId: string): string | null {
  const match = /^saved-plan-([A-Za-z0-9_-]{1,64})-(?:entry|target|invalidation)$/u.exec(ruleId);
  return match?.[1] ?? null;
}

export function terminalSavedPlanWatchIds(rules: readonly TerminalAlertRule[]): string[] {
  const kindsByPlan = new Map<string, Set<TerminalPlanAlertKind>>();
  for (const rule of rules) {
    const match = /^saved-plan-([A-Za-z0-9_-]{1,64})-(entry|target|invalidation)$/u.exec(rule.id);
    if (!match) continue;
    const planId = match[1];
    const kind = match[2] as TerminalPlanAlertKind;
    const kinds = kindsByPlan.get(planId) ?? new Set<TerminalPlanAlertKind>();
    kinds.add(kind);
    kindsByPlan.set(planId, kinds);
  }
  return [...kindsByPlan.entries()]
    .filter(([, kinds]) => kinds.size === 3)
    .map(([planId]) => planId)
    .sort();
}

export function removeTerminalSavedPlanAlertRules(
  rules: readonly TerminalAlertRule[],
  planIds: ReadonlySet<string>,
): TerminalAlertRule[] {
  if (planIds.size === 0) return rules.slice();
  return rules.filter((rule) => {
    const planId = terminalSavedPlanIdFromAlertRuleId(rule.id);
    return planId == null || !planIds.has(planId);
  });
}

export function validTerminalSavedPlanAlertRemovalRequest(
  request: TerminalSavedPlanAlertRemovalRequest,
): boolean {
  return /^saved-plan-remove:[A-Za-z0-9_-]{1,64}:\d+$/u.test(request.requestId)
    && /^[A-Za-z0-9_-]{1,64}$/u.test(request.planId)
    && typeof request.planName === "string"
    && request.planName.trim().length > 0
    && request.planName.trim().length <= 32
    && typeof request.instrument === "string"
    && request.instrument.length >= 2
    && request.instrument.length <= 32;
}

export function upsertTerminalAlertRule(
  rules: readonly TerminalAlertRule[],
  rule: TerminalAlertRule,
): TerminalAlertRule[] {
  const index = rules.findIndex((current) => current.id === rule.id);
  if (index < 0) return [rule, ...rules];
  return rules.map((current, currentIndex) => currentIndex === index ? rule : current);
}

export function reconcileTerminalAlertRules(
  stored: readonly TerminalAlertRule[],
  defaults: readonly TerminalAlertRule[],
): TerminalAlertRule[] {
  const migratedStored = stored.map(migrateBuiltInRuleCopy);
  const ids = new Set(migratedStored.map((rule) => rule.id));
  return [
    ...migratedStored,
    ...defaults.filter((rule) => !ids.has(rule.id)).map((rule) => ({ ...rule })),
  ];
}

export function defaultTerminalAlertRules(referencePrice: number | null): TerminalAlertRule[] {
  const price = finitePositive(referencePrice);
  return [
    ...(price == null ? [] : [
      alertRule("price-up", "Price +1%", "price", "above", price * 1.01, Math.max(price * 0.001, Number.EPSILON)),
      alertRule("price-down", "Price -1%", "price", "below", price * 0.99, Math.max(price * 0.001, Number.EPSILON)),
    ]),
    alertRule("spread-wide", "Spread above 10 bp", "spread_bps", "above", 10, 2),
    alertRule("book-bid-heavy", "Bid imbalance above 35%", "book_imbalance_pct", "above", 35, 5),
    alertRule("book-ask-heavy", "Ask imbalance below -35%", "book_imbalance_pct", "below", -35, 5),
    alertRule("microprice-bid-edge", "Microprice edge above +5 bp", "microprice_edge_bps", "above", 5, 1),
    alertRule("microprice-ask-edge", "Microprice edge below -5 bp", "microprice_edge_bps", "below", -5, 1),
    alertRule("volatility-high", "Realized volatility above 100 bp", "realized_volatility_bps", "above", 100, 10),
    alertRule("funding-positive", "Funding above +1 bp", "funding_rate_bps", "above", 1, 0.25),
    alertRule("funding-negative", "Funding below -1 bp", "funding_rate_bps", "below", -1, 0.25),
    alertRule("route-improvement", "All-in full-fill peer improves by 5 bp", "route_improvement_bps", "above", 5, 2),
    alertRule("feed-health-low", "Feed health below 60", "feed_health_score", "below", 60, 10),
    alertRule("receipt-latency-high", "Receipt latency above 1s", "receipt_latency_ms", "above", 1_000, 250),
    alertRule("market-stale", "Quote older than 20s", "market_age_ms", "above", 20_000, 5_000),
    alertRule("book-stale", "Book older than 20s", "book_age_ms", "above", 20_000, 5_000),
    alertRule("trades-stale", "Trades older than 20s", "trades_age_ms", "above", 20_000, 5_000),
  ];
}

function migrateBuiltInRuleCopy(rule: TerminalAlertRule): TerminalAlertRule {
  if (rule.id === "route-improvement" && rule.label === "Full-fill peer route improves by 5 bp") {
    return { ...rule, label: "All-in full-fill peer improves by 5 bp" };
  }
  return { ...rule };
}

function alertRule(
  id: string,
  label: string,
  metric: TerminalAlertMetric,
  operator: TerminalAlertOperator,
  threshold: number,
  rearmDelta: number,
): TerminalAlertRule {
  return { id, label, metric, operator, threshold, enabled: true, cooldownMs: 60_000, rearmDelta };
}

function validRule(rule: TerminalAlertRule): boolean {
  return typeof rule.id === "string"
    && rule.id.length > 0
    && rule.id.length <= 96
    && typeof rule.label === "string"
    && rule.label.length > 0
    && TERMINAL_ALERT_METRICS.includes(rule.metric)
    && (rule.operator === "above" || rule.operator === "below")
    && finiteNumber(rule.threshold) != null
    && finiteNumber(rule.cooldownMs) != null
    && rule.cooldownMs >= 0
    && finiteNumber(rule.rearmDelta) != null
    && rule.rearmDelta >= 0;
}

function normalizedState(state: TerminalAlertRuleState | undefined): TerminalAlertRuleState {
  return {
    armed: state?.armed !== false,
    previousValue: finiteNumber(state?.previousValue),
    lastTriggeredAt: finiteTime(state?.lastTriggeredAt),
  };
}

function crossed(operator: TerminalAlertOperator, value: number, threshold: number): boolean {
  return operator === "above" ? value >= threshold : value <= threshold;
}

function finitePositive(value: number | null | undefined): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function finiteTime(value: number | null | undefined): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
