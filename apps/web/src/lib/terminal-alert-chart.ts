import type { GholaChartOverlay } from "./ghola-market-chart";
import type { TerminalAlertRule } from "./terminal-alerts";

export const TERMINAL_CHART_PRICE_ALERT_LIMIT = 4;

export interface TerminalChartPriceAlertSnapshot {
  scope: string | null;
  rules: TerminalAlertRule[];
}

export interface TerminalChartPriceAlertLevel {
  id: string;
  label: string;
  operator: "above" | "below";
  threshold: number;
}

export interface TerminalChartPriceAlertProjection {
  status: "ready" | "unavailable";
  blocker: "scope_unavailable" | "scope_mismatch" | null;
  total: number;
  hidden: number;
  levels: TerminalChartPriceAlertLevel[];
  overlays: GholaChartOverlay[];
}

const EMPTY_CHART_PRICE_ALERT_RULES: TerminalAlertRule[] = [];
Object.freeze(EMPTY_CHART_PRICE_ALERT_RULES);

export const EMPTY_TERMINAL_CHART_PRICE_ALERT_SNAPSHOT: TerminalChartPriceAlertSnapshot = Object.freeze({
  scope: null,
  rules: EMPTY_CHART_PRICE_ALERT_RULES,
});

export function terminalChartPriceAlertSnapshot(
  scope: string | null,
  rules: readonly TerminalAlertRule[],
  ready: boolean,
): TerminalChartPriceAlertSnapshot {
  if (!ready || !validScope(scope)) return EMPTY_TERMINAL_CHART_PRICE_ALERT_SNAPSHOT;
  const seen = new Set<string>();
  const priceRules: TerminalAlertRule[] = [];
  for (const rule of rules) {
    if (!validChartPriceRule(rule) || seen.has(rule.id)) continue;
    seen.add(rule.id);
    priceRules.push(rule);
  }
  return { scope, rules: priceRules };
}

export function terminalChartPriceAlertSnapshotEqual(
  left: TerminalChartPriceAlertSnapshot,
  right: TerminalChartPriceAlertSnapshot,
) {
  return left === right || (
    left.scope === right.scope
    && left.rules.length === right.rules.length
    && left.rules.every((rule, index) => terminalAlertRuleEqual(rule, right.rules[index]))
  );
}

export function deriveTerminalChartPriceAlerts(input: {
  snapshot: TerminalChartPriceAlertSnapshot;
  expectedScope: string | null;
}): TerminalChartPriceAlertProjection {
  const expectedScope = validScope(input.expectedScope) ? input.expectedScope : null;
  const snapshotScope = validScope(input.snapshot.scope) ? input.snapshot.scope : null;
  if (!expectedScope || !snapshotScope) return unavailable("scope_unavailable");
  if (expectedScope !== snapshotScope) return unavailable("scope_mismatch");

  const seen = new Set<string>();
  const rules: TerminalAlertRule[] = [];
  for (const rule of input.snapshot.rules) {
    if (!validChartPriceRule(rule) || seen.has(rule.id)) continue;
    seen.add(rule.id);
    rules.push(rule);
  }
  rules.sort(compareChartPriceRules);
  const visible = rules.slice(0, TERMINAL_CHART_PRICE_ALERT_LIMIT);
  const levels = visible.map((rule) => ({
    id: rule.id,
    label: rule.label,
    operator: rule.operator,
    threshold: rule.threshold,
  }));
  return {
    status: "ready",
    blocker: null,
    total: rules.length,
    hidden: Math.max(0, rules.length - levels.length),
    levels,
    overlays: levels.map((level) => ({
      id: `terminal-alert:${level.id}`,
      kind: "price_line",
      label: `${level.operator === "above" ? "↑" : "↓"} alert ${formatChartAlertPrice(level.threshold)}`,
      tone: "warn",
      price: level.threshold,
      status: "enabled local alert",
      detail: level.label,
      rangeBehavior: "exclude",
    })),
  };
}

function compareChartPriceRules(left: TerminalAlertRule, right: TerminalAlertRule) {
  const priority = chartPriceRulePriority(left) - chartPriceRulePriority(right);
  if (priority !== 0) return priority;
  if (left.threshold !== right.threshold) return left.threshold - right.threshold;
  return left.id.localeCompare(right.id);
}

function chartPriceRulePriority(rule: TerminalAlertRule) {
  if (rule.id.startsWith("plan-")) return 0;
  if (rule.id.startsWith("saved-plan-")) return 1;
  if (rule.id.startsWith("custom-")) return 2;
  return 3;
}

function validChartPriceRule(rule: TerminalAlertRule) {
  return rule.enabled
    && rule.metric === "price"
    && (rule.operator === "above" || rule.operator === "below")
    && typeof rule.id === "string"
    && rule.id.length > 0
    && rule.id.length <= 96
    && typeof rule.label === "string"
    && rule.label.length > 0
    && rule.label.length <= 160
    && Number.isFinite(rule.threshold)
    && rule.threshold > 0;
}

function terminalAlertRuleEqual(left: TerminalAlertRule, right: TerminalAlertRule | undefined) {
  return right != null
    && left.id === right.id
    && left.label === right.label
    && left.metric === right.metric
    && left.operator === right.operator
    && left.threshold === right.threshold
    && left.enabled === right.enabled
    && left.cooldownMs === right.cooldownMs
    && left.rearmDelta === right.rearmDelta;
}

function validScope(value: string | null): value is string {
  return typeof value === "string" && /^[A-Z0-9][A-Z0-9._-]{0,63}$/u.test(value);
}

function formatChartAlertPrice(value: number) {
  if (value >= 1_000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

function unavailable(
  blocker: Exclude<TerminalChartPriceAlertProjection["blocker"], null>,
): TerminalChartPriceAlertProjection {
  return { status: "unavailable", blocker, total: 0, hidden: 0, levels: [], overlays: [] };
}
