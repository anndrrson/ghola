import { describe, expect, it } from "vitest";
import type { TerminalAlertRule } from "./terminal-alerts";
import {
  deriveTerminalChartPriceAlerts,
  terminalChartPriceAlertSnapshot,
  terminalChartPriceAlertSnapshotEqual,
  TERMINAL_CHART_PRICE_ALERT_LIMIT,
} from "./terminal-alert-chart";

describe("terminal chart price alerts", () => {
  it("projects current-plan, saved-plan, and custom rules before defaults", () => {
    const snapshot = terminalChartPriceAlertSnapshot("BTC", [
      alertRule("price-up", "Default up", 101),
      alertRule("custom-far", "Custom far", 120),
      alertRule("plan-target", "Plan target", 110),
      alertRule("saved-plan-plan_1-entry", "Saved entry", 103),
      alertRule("custom-near", "Custom near", 102),
      alertRule("price-down", "Default down", 99, "below"),
    ], true);
    const result = deriveTerminalChartPriceAlerts({ snapshot, expectedScope: "BTC" });

    expect(result).toMatchObject({ status: "ready", total: 6, hidden: 2 });
    expect(result.levels.map((level) => level.id)).toEqual([
      "plan-target",
      "saved-plan-plan_1-entry",
      "custom-near",
      "custom-far",
    ]);
    expect(result.overlays).toHaveLength(TERMINAL_CHART_PRICE_ALERT_LIMIT);
    expect(result.overlays[0]).toMatchObject({
      id: "terminal-alert:plan-target",
      kind: "price_line",
      label: "↑ alert 110.00",
      price: 110,
      tone: "warn",
      rangeBehavior: "exclude",
    });
  });

  it("filters disabled, non-price, malformed, and duplicate rules", () => {
    const valid = alertRule("custom-one", "One", 101);
    const snapshot = terminalChartPriceAlertSnapshot("BTC", [
      valid,
      { ...valid },
      { ...alertRule("custom-off", "Off", 102), enabled: false },
      { ...alertRule("custom-spread", "Spread", 10), metric: "spread_bps" },
      { ...alertRule("custom-bad", "Bad", 103), threshold: Number.NaN },
    ], true);

    expect(snapshot.rules.map((rule) => rule.id)).toEqual(["custom-one"]);
    expect(deriveTerminalChartPriceAlerts({ snapshot, expectedScope: "BTC" })).toMatchObject({
      total: 1,
      hidden: 0,
      levels: [{ id: "custom-one", threshold: 101 }],
    });
  });

  it("fails closed across unavailable or mismatched instrument scopes", () => {
    const snapshot = terminalChartPriceAlertSnapshot("BTC", [alertRule("price-up", "Up", 101)], true);
    expect(deriveTerminalChartPriceAlerts({ snapshot, expectedScope: "ETH" }))
      .toEqual({ status: "unavailable", blocker: "scope_mismatch", total: 0, hidden: 0, levels: [], overlays: [] });
    expect(deriveTerminalChartPriceAlerts({ snapshot, expectedScope: null }).blocker).toBe("scope_unavailable");
    expect(terminalChartPriceAlertSnapshot("BTC", [alertRule("price-up", "Up", 101)], false).scope).toBeNull();
  });

  it("compares emitted snapshots semantically", () => {
    const left = terminalChartPriceAlertSnapshot("BTC", [alertRule("price-up", "Up", 101)], true);
    const right = terminalChartPriceAlertSnapshot("BTC", [alertRule("price-up", "Up", 101)], true);
    expect(terminalChartPriceAlertSnapshotEqual(left, right)).toBe(true);
    expect(terminalChartPriceAlertSnapshotEqual(left, {
      ...right,
      rules: [{ ...right.rules[0]!, threshold: 102 }],
    })).toBe(false);
  });

  it("does not mutate rule order", () => {
    const rules = [
      alertRule("price-up", "Up", 101),
      alertRule("plan-entry", "Entry", 100.5),
    ];
    const before = rules.map((rule) => rule.id);
    deriveTerminalChartPriceAlerts({ snapshot: { scope: "BTC", rules }, expectedScope: "BTC" });
    expect(rules.map((rule) => rule.id)).toEqual(before);
  });
});

function alertRule(
  id: string,
  label: string,
  threshold: number,
  operator: "above" | "below" = "above",
): TerminalAlertRule {
  return {
    id,
    label,
    metric: "price",
    operator,
    threshold,
    enabled: true,
    cooldownMs: 60_000,
    rearmDelta: 1,
  };
}
