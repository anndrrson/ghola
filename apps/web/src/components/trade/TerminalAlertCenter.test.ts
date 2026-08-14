import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTerminalAlertRules,
  type TerminalAlertMetric,
  type TerminalAlertRuleState,
  type TerminalAlertSnapshot,
  type TerminalSavedPlanAlertRemovalRequest,
  type TerminalSavedPlanAlertRequest,
  type TerminalSavedPlanInventoryItem,
} from "@/lib/terminal-alerts";
import {
  TERMINAL_ALERT_GUEST_SCOPE,
  TERMINAL_ALERT_STORAGE_KEY,
  emptyTerminalAlertStorage,
  parseTerminalAlertStorage,
  serializeTerminalAlertStorage,
  terminalAlertStorageKey,
  updateTerminalAlertsForInstrument,
} from "@/lib/terminal-alert-storage";
import { TerminalAlertCenter, terminalAlertStatesForEvaluationIdentity } from "./TerminalAlertCenter";

describe("TerminalAlertCenter evaluation identity", () => {
  const states: Record<string, TerminalAlertRuleState> = {
    price_above: { armed: false, previousValue: 101, lastTriggeredAt: 1_000 },
  };

  it("preserves ephemeral continuity only for the same exact market identity", () => {
    expect(terminalAlertStatesForEvaluationIdentity(
      "hyperliquid:mainnet:btc:1m",
      "hyperliquid:mainnet:btc:1m",
      states,
    )).toBe(states);
  });

  it("resets ephemeral continuity across network, interval, or unavailable identity", () => {
    expect(terminalAlertStatesForEvaluationIdentity(
      "hyperliquid:mainnet:btc:1m",
      "hyperliquid:testnet:btc:1m",
      states,
    )).toEqual({});
    expect(terminalAlertStatesForEvaluationIdentity(
      "hyperliquid:mainnet:btc:1m",
      "hyperliquid:mainnet:btc:5m",
      states,
    )).toEqual({});
    expect(terminalAlertStatesForEvaluationIdentity(
      "hyperliquid:mainnet:btc:1m",
      null,
      states,
    )).toEqual({});
  });
});

describe("TerminalAlertCenter triage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires an exact component-age alert while the feed is silent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, {
        snapshot: { price: 100, book_age_ms: 19_000 },
        availableMetrics: ["price", "book_age_ms"],
        snapshotCapturedAtMs: 100_000,
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("0 unread");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(container.textContent).toContain("1 unread");
    expect(container.textContent).toContain("Book older than 20s");
  });

  it("shows a hazardous condition present at load without fabricating an unread crossing", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, {
        snapshot: { price: 100, feed_health_score: 35, receipt_latency_ms: 1_500 },
        availableMetrics: ["price", "feed_health_score", "receipt_latency_ms"],
        snapshotCapturedAtMs: Date.now(),
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("2 active · 0 unread");
    expect(container.textContent).toContain("Active now · Feed health below 60 (35/100)");
    expect(container.textContent).toContain("Receipt latency above 1s (1.5s)");
    expect(container.querySelector('[data-terminal-alert-unread="true"]')).toBeNull();
  });

  it("focuses the latest unread alert and acknowledges it without clearing history", async () => {
    const onSummaryChange = vi.fn();
    const rules = defaultTerminalAlertRules(100);
    window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, JSON.stringify({
      version: 3,
      instruments: {
        BTC: {
          rules,
          events: [{
            id: "price-up:1000",
            ruleId: "price-up",
            label: "Price +1%",
            metric: "price",
            operator: "above",
            threshold: 101,
            observed: 102,
            triggeredAt: 1_000,
            acknowledgedAt: null,
          }],
          browserNotifications: false,
          updatedAt: 1_000,
        },
      },
    }));
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(102, { onSummaryChange })));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("1 unread · 1 history");
    expect(onSummaryChange).toHaveBeenLastCalledWith({ scope: "BTC", activeCount: 1, primaryActiveLabel: "Price +1%", unreadCount: 1, latestUnreadLabel: "Price +1%", latestTriggeredAt: 1_000 });

    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));

    const acknowledge = requiredElement<HTMLButtonElement>(container, "[data-terminal-alert-unread='true']");
    expect(document.activeElement).toBe(acknowledge);
    expect(container.textContent).toContain("102 ≥ 101");
    act(() => acknowledge.click());
    expect(container.textContent).toContain("0 unread · 1 history");
    expect(container.textContent).toContain("Acknowledged");
    expect(onSummaryChange).toHaveBeenLastCalledWith({ scope: "BTC", activeCount: 1, primaryActiveLabel: "Price +1%", unreadCount: 0, latestUnreadLabel: null, latestTriggeredAt: null });
  });

  it("atomically snapshots staged entry, target, and invalidation levels without duplication", async () => {
    const onPriceAlertsChange = vi.fn();
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, {
        planEntryPrice: 101,
        planTargetPrice: 104,
        planInvalidationPrice: 98,
        onPriceAlertsChange,
      })));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));

    act(() => requiredButton(container, "Arm all").click());
    expect(onPriceAlertsChange).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: "BTC",
      rules: expect.arrayContaining([
        expect.objectContaining({ id: "plan-entry", threshold: 101 }),
        expect.objectContaining({ id: "plan-target", threshold: 104 }),
        expect.objectContaining({ id: "plan-invalidation", threshold: 98 }),
      ]),
    }));
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Plan entry crossed above threshold"]').value).toBe("101");
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Plan target crossed above threshold"]').value).toBe("104");
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Plan invalidation crossed below threshold"]').value).toBe("98");
    expect(container.textContent).toContain("later edits will not move them");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(105, { planEntryPrice: 101, planTargetPrice: 104, planInvalidationPrice: 98 })));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("3 unread");
    expect(container.textContent).toContain("Plan target crossed above · 105 ≥ 104");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { planEntryPrice: 102, planTargetPrice: 106, planInvalidationPrice: 98 })));
      await Promise.resolve();
    });
    act(() => requiredButton(container, "Update entry").click());
    expect(container.querySelectorAll('input[aria-label^="Plan entry crossed"]').length).toBe(1);
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Plan entry crossed above threshold"]').value).toBe("102");
    act(() => requiredButton(container, "Update all").click());
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Plan target crossed above threshold"]').value).toBe("106");
  });

  it("atomically arms a uniquely named saved-plan instrument watch once", async () => {
    seedStoredAlerts();
    const request: TerminalSavedPlanAlertRequest = {
      requestId: "saved-plan:plan_1:1",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
      entryPrice: 101,
      targetPrice: 104,
      invalidationPrice: 98,
    };
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { savedPlanWatchRequest: request })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("entry, target, and invalidation instrument-price watches armed");
    expect(requiredInputByLabel(container, "Pullback A · instrument plan entry crossed above threshold").value).toBe("101");
    expect(requiredInputByLabel(container, "Pullback A · instrument plan target crossed above threshold").value).toBe("104");
    expect(requiredInputByLabel(container, "Pullback A · instrument plan invalidation crossed below threshold").value).toBe("98");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { savedPlanWatchRequest: request })));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('input[aria-label^="Pullback A · instrument plan"]')).toHaveLength(3);
  });

  it("unwatches all saved-plan rules while retaining triggered audit history", async () => {
    seedStoredAlerts();
    const onSavedPlanWatchIdsChange = vi.fn();
    const watch: TerminalSavedPlanAlertRequest = {
      requestId: "saved-plan:plan_1:1",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
      entryPrice: 101,
      targetPrice: 104,
      invalidationPrice: 98,
    };
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { savedPlanWatchRequest: watch, onSavedPlanWatchIdsChange })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSavedPlanWatchIdsChange).toHaveBeenLastCalledWith(["plan_1"]);
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(105, { savedPlanWatchRequest: watch, onSavedPlanWatchIdsChange })));
      await Promise.resolve();
    });
    const removal: TerminalSavedPlanAlertRemovalRequest = {
      requestId: "saved-plan-remove:plan_1:2",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
    };
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(105, { savedPlanWatchRequest: watch, savedPlanRemovalRequest: removal, onSavedPlanWatchIdsChange })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('input[aria-label^="Pullback A · instrument plan"]')).toHaveLength(0);
    expect(container.textContent).toContain("triggered history retained");
    expect(container.textContent).toContain("history");
    expect(onSavedPlanWatchIdsChange).toHaveBeenLastCalledWith([]);
  });

  it("prunes watches for deleted plans from the authoritative plan inventory", async () => {
    seedStoredAlerts();
    const watch: TerminalSavedPlanAlertRequest = {
      requestId: "saved-plan:plan_1:1",
      planId: "plan_1",
      planName: "Pullback A",
      instrument: "BTC-PERP",
      entryPrice: 101,
      targetPrice: 104,
      invalidationPrice: 98,
    };
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, {
        savedPlanWatchRequest: watch,
        savedPlanInventory: [{ planId: "plan_1", instrument: "BTC-PERP" }],
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('input[aria-label^="Pullback A · instrument plan"]')).toHaveLength(3);
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, {
        savedPlanWatchRequest: watch,
        savedPlanInventory: [],
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('input[aria-label^="Pullback A · instrument plan"]')).toHaveLength(0);
    expect(container.textContent).toContain("deleted saved-plan watch removed");
  });

  it("labels the route alert paused until a certified peer metric exists", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    const routeInput = requiredElement<HTMLInputElement>(container, 'input[aria-label="All-in full-fill peer improves by 5 bp threshold"]');
    expect(routeInput.closest("div")?.textContent).toContain("paused");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, {
        ...alertProps(100),
        snapshot: { price: 100, route_improvement_bps: 0 },
        availableMetrics: ["price", "route_improvement_bps"],
      }));
      await Promise.resolve();
    });
    expect(routeInput.closest("div")?.textContent).not.toContain("paused");
  });

  it("exposes signed funding alerts only while the certified rate exists", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    const fundingInput = requiredInputByLabel(container, "Funding above +1 bp threshold");
    expect(fundingInput.step).toBe("0.1");
    expect(fundingInput.closest("div")?.textContent).toContain("paused");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, {
        ...alertProps(100),
        snapshot: { price: 100, funding_rate_bps: 1.25 },
        availableMetrics: ["price", "funding_rate_bps"],
      }));
      await Promise.resolve();
    });
    expect(fundingInput.closest("div")?.textContent).not.toContain("paused");
    expect(fundingInput.closest("div")?.textContent).toContain("bp");
  });

  it("exposes microprice-edge alerts only while certified book depth exists", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    const edgeInput = requiredInputByLabel(container, "Microprice edge above +5 bp threshold");
    expect(edgeInput.closest("div")?.textContent).toContain("paused");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, {
        ...alertProps(100),
        snapshot: { price: 100, microprice_edge_bps: 3.5 },
        availableMetrics: ["price", "microprice_edge_bps"],
      }));
      await Promise.resolve();
    });
    expect(edgeInput.closest("div")?.textContent).not.toContain("paused");
    expect(edgeInput.closest("div")?.textContent).toContain("bp");
  });

  it("creates and removes a custom certified rule without remote work", async () => {
    seedStoredAlerts();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, {
        ...alertProps(100),
        snapshot: { price: 100, funding_rate_bps: -0.5 },
        availableMetrics: ["price", "funding_rate_bps"],
      }));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));

    const metric = requiredElement<HTMLSelectElement>(container, "#terminal-alert-metric");
    const operator = requiredElement<HTMLSelectElement>(container, "#terminal-alert-operator");
    const threshold = requiredElement<HTMLInputElement>(container, "#terminal-alert-threshold");
    await act(async () => {
      metric.value = "funding_rate_bps";
      metric.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      operator.value = "below";
      operator.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing HTMLInputElement value setter");
      setter.call(threshold, "-1.5");
      threshold.dispatchEvent(new Event("input", { bubbles: true }));
      threshold.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    act(() => requiredButton(container, "Add alert").click());

    expect(container.textContent).toContain("Funding rate below added");
    const customThreshold = requiredInputByLabel(container, "Funding rate below threshold");
    expect(customThreshold.value).toBe("-1.5");
    expect(container.textContent).toContain("1/12");

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, 'button[aria-label="Delete Funding rate below"]').click();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Funding rate below deleted");
    expect(container.querySelector('input[aria-label="Funding rate below threshold"]')).toBeNull();
  });

  it("preserves corrupt storage and locks evaluation until confirmed reset", async () => {
    const raw = "{broken-alert-storage";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSummaryChange = vi.fn();
    const onPriceAlertsChange = vi.fn();
    window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, raw);
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(102, { onSummaryChange, onPriceAlertsChange })));
      await Promise.resolve();
    });
    expect(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY)).toBe(raw);
    expect(onSummaryChange).toHaveBeenLastCalledWith({ scope: null, activeCount: 0, primaryActiveLabel: null, unreadCount: 0, latestUnreadLabel: null, latestTriggeredAt: null });
    expect(onPriceAlertsChange).toHaveBeenLastCalledWith({ scope: null, rules: [] });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    expect(container.textContent).toContain("Monitoring is locked to prevent silent data loss");

    act(() => requiredButton(container, "Reset alert storage").click());
    expect(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY)).toBe(raw);
    confirm.mockReturnValue(true);
    await act(async () => {
      requiredButton(container, "Reset alert storage").click();
      await Promise.resolve();
    });
    expect(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY)).not.toBe(raw);
    expect(parseTerminalAlertStorage(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY)).clearedAt).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Monitoring is locked to prevent silent data loss");
    expect(onPriceAlertsChange).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "BTC" }));
  });

  it("adds newly shipped built-ins without changing stored thresholds", async () => {
    window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, JSON.stringify({
      version: 3,
      instruments: {
        BTC: {
          rules: [{ ...defaultTerminalAlertRules(100).find((rule) => rule.id === "spread-wide")!, threshold: 17 }],
          events: [],
          browserNotifications: false,
          updatedAt: 1_000,
        },
      },
    }));
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Spread above 10 bp threshold"]').value).toBe("17");
    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="All-in full-fill peer improves by 5 bp threshold"]').value).toBe("5");
  });

  it("reconciles a valid cross-tab rule update", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
      await Promise.resolve();
    });
    const current = parseTerminalAlertStorage(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY));
    const stored = current.instruments.BTC;
    const remote = updateTerminalAlertsForInstrument(current, "BTC", {
      rules: [...stored.rules, {
        id: "custom-spread",
        label: "Custom spread",
        metric: "spread_bps",
        operator: "above",
        threshold: 21,
        enabled: true,
        cooldownMs: 30_000,
        rearmDelta: 2,
      }],
      events: stored.events,
      browserNotifications: stored.browserNotifications,
    }, Date.now() + 1_000);
    const raw = serializeTerminalAlertStorage(remote);
    window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, raw);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_ALERT_STORAGE_KEY, newValue: raw }));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("ghola:open-alerts")));

    expect(requiredElement<HTMLInputElement>(container, 'input[aria-label="Custom spread threshold"]').value).toBe("21");
  });

  it("locks when another tab replaces storage with corrupt data", async () => {
    seedStoredAlerts();
    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100)));
      await Promise.resolve();
    });
    const raw = "{cross-tab-corrupt";
    window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, raw);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_ALERT_STORAGE_KEY, newValue: raw }));
      await Promise.resolve();
    });

    expect(window.localStorage.getItem(TERMINAL_ALERT_STORAGE_KEY)).toBe(raw);
    expect(container.textContent).toContain("Locked · unreadable local alert storage is preserved");
  });

  it("isolates rules and cross-tab events across authenticated account scopes", async () => {
    const leftScope = `subject_${"a".repeat(32)}`;
    const rightScope = `subject_${"b".repeat(32)}`;
    const leftKey = terminalAlertStorageKey(leftScope)!;
    const rightKey = terminalAlertStorageKey(rightScope)!;
    window.localStorage.setItem(leftKey, storedAlertsWithPriceThreshold(111));
    window.localStorage.setItem(rightKey, storedAlertsWithPriceThreshold(222));

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { persistenceScope: leftScope })));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event("ghola:open-alerts"));
      await Promise.resolve();
    });
    expect(requiredInputByLabel(container, "Price +1% threshold").value).toBe("111");

    await act(async () => {
      root.render(createElement(TerminalAlertCenter, alertProps(100, { persistenceScope: rightScope })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requiredInputByLabel(container, "Price +1% threshold").value).toBe("222");

    const changedLeft = storedAlertsWithPriceThreshold(333);
    window.localStorage.setItem(leftKey, changedLeft);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: leftKey, newValue: changedLeft }));
      await Promise.resolve();
    });
    expect(requiredInputByLabel(container, "Price +1% threshold").value).toBe("222");
  });
});

function alertProps(price: number, overrides: {
  persistenceScope?: string | null;
  planEntryPrice?: number | null;
  planTargetPrice?: number | null;
  planInvalidationPrice?: number | null;
  savedPlanWatchRequest?: TerminalSavedPlanAlertRequest | null;
  savedPlanRemovalRequest?: TerminalSavedPlanAlertRemovalRequest | null;
  savedPlanInventory?: readonly TerminalSavedPlanInventoryItem[] | null;
  onSavedPlanWatchIdsChange?: (planIds: readonly string[]) => void;
  onSummaryChange?: (summary: import("@/lib/terminal-alerts").TerminalAlertSummary) => void;
  onPriceAlertsChange?: (snapshot: import("@/lib/terminal-alert-chart").TerminalChartPriceAlertSnapshot) => void;
  snapshot?: TerminalAlertSnapshot;
  availableMetrics?: TerminalAlertMetric[];
  snapshotCapturedAtMs?: number | null;
} = {}) {
  return {
    persistenceScope: overrides.persistenceScope === undefined ? TERMINAL_ALERT_GUEST_SCOPE : overrides.persistenceScope,
    instrument: "BTC",
    snapshotInstrument: "BTC",
    evaluationIdentityKey: "coinbase:mainnet:btc:1m",
    referencePrice: 100,
    snapshot: overrides.snapshot ?? { price },
    availableMetrics: overrides.availableMetrics ?? ["price" as const],
    snapshotCapturedAtMs: overrides.snapshotCapturedAtMs,
    feed: { status: "ready" as const, message: "Certified quote" },
    planEntryPrice: overrides.planEntryPrice === undefined ? 101 : overrides.planEntryPrice,
    planTargetPrice: overrides.planTargetPrice === undefined ? 104 : overrides.planTargetPrice,
    planInvalidationPrice: overrides.planInvalidationPrice === undefined ? 99 : overrides.planInvalidationPrice,
    savedPlanWatchRequest: overrides.savedPlanWatchRequest,
    savedPlanRemovalRequest: overrides.savedPlanRemovalRequest,
    savedPlanInventory: overrides.savedPlanInventory,
    onSavedPlanWatchIdsChange: overrides.onSavedPlanWatchIdsChange,
    onSummaryChange: overrides.onSummaryChange ?? vi.fn(),
    onPriceAlertsChange: overrides.onPriceAlertsChange ?? vi.fn(),
  };
}

function storedAlertsWithPriceThreshold(threshold: number) {
  const rules = defaultTerminalAlertRules(100).map((rule) => (
    rule.id === "price-up" ? { ...rule, threshold } : rule
  ));
  return serializeTerminalAlertStorage(updateTerminalAlertsForInstrument(
    emptyTerminalAlertStorage(),
    "BTC",
    { rules, events: [], browserNotifications: false },
    1_000,
  ));
}

function seedStoredAlerts() {
  window.localStorage.setItem(TERMINAL_ALERT_STORAGE_KEY, JSON.stringify({
    version: 3,
    instruments: {
      BTC: {
        rules: defaultTerminalAlertRules(100),
        events: [],
        browserNotifications: false,
        updatedAt: 1_000,
      },
    },
  }));
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing test element: ${selector}`);
  return value;
}

function requiredButton(root: ParentNode, text: string) {
  const value = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === text);
  if (!value) throw new Error(`Missing test button: ${text}`);
  return value;
}

function requiredInputByLabel(root: ParentNode, label: string) {
  const value = Array.from(root.querySelectorAll<HTMLInputElement>("input"))
    .find((input) => input.getAttribute("aria-label") === label);
  if (!value) throw new Error(`Missing test input: ${label}`);
  return value;
}
