import { describe, expect, it } from "vitest";
import type { TerminalAlertEvent, TerminalAlertRule } from "./terminal-alerts";
import {
  TERMINAL_ALERT_HISTORY_LIMIT,
  TERMINAL_ALERT_GUEST_SCOPE,
  TERMINAL_ALERT_LEGACY_STORAGE_KEY,
  TERMINAL_ALERT_STORAGE_KEY,
  clearTerminalAlertStorage,
  emptyTerminalAlertStorage,
  inspectTerminalAlertStorage,
  mergeTerminalAlertStorage,
  parseTerminalAlertStorage,
  serializeTerminalAlertStorage,
  terminalAlertInstrumentScope,
  terminalAlertStorageKey,
  terminalAlertStorageViewReady,
  terminalAlertsForInstrument,
  updateTerminalAlertsForInstrument,
} from "./terminal-alert-storage";

const RULE: TerminalAlertRule = {
  id: "price-up",
  label: "Price up",
  metric: "price",
  operator: "above",
  threshold: 101,
  enabled: true,
  cooldownMs: 60_000,
  rearmDelta: 1,
};

describe("terminal alert storage", () => {
  it("derives isolated account and guest keys without reusing legacy storage", () => {
    const left = `subject_${"a".repeat(32)}`;
    const right = `subject_${"b".repeat(32)}`;
    expect(terminalAlertStorageKey(left)).not.toBe(terminalAlertStorageKey(right));
    expect(terminalAlertStorageKey(TERMINAL_ALERT_GUEST_SCOPE)).toBe(TERMINAL_ALERT_STORAGE_KEY);
    expect(TERMINAL_ALERT_STORAGE_KEY).not.toBe(TERMINAL_ALERT_LEGACY_STORAGE_KEY);
    expect(terminalAlertStorageKey("subject_user-a")).toBeNull();
    expect(terminalAlertStorageViewReady({
      storageKey: terminalAlertStorageKey(left),
      hydratedStorageKey: terminalAlertStorageKey(right),
      instrumentScope: "BTC",
      hydratedInstrumentScope: "BTC",
    })).toBe(false);
    expect(terminalAlertStorageViewReady({
      storageKey: terminalAlertStorageKey(left),
      hydratedStorageKey: terminalAlertStorageKey(left),
      instrumentScope: "BTC",
      hydratedInstrumentScope: "BTC",
    })).toBe(true);
  });

  it("normalizes product labels to an isolated instrument scope", () => {
    expect(terminalAlertInstrumentScope(" btc-usd ")).toBe("BTC");
    expect(terminalAlertInstrumentScope("SOL-PERP")).toBe("SOL");
    expect(terminalAlertInstrumentScope("ETH/USDC")).toBe("ETH");
    expect(terminalAlertInstrumentScope("../BTC")).toBeNull();
  });

  it("round trips independent BTC and SOL rules without threshold leakage", () => {
    let storage = emptyTerminalAlertStorage();
    storage = updateTerminalAlertsForInstrument(storage, "BTC-USD", {
      rules: [RULE],
      events: [],
      browserNotifications: true,
    }, 10);
    storage = updateTerminalAlertsForInstrument(storage, "SOL-PERP", {
      rules: [{ ...RULE, threshold: 159 }],
      events: [],
      browserNotifications: false,
    }, 20);
    const parsed = parseTerminalAlertStorage(serializeTerminalAlertStorage(storage));

    expect(terminalAlertsForInstrument(parsed, "BTC")?.rules[0].threshold).toBe(101);
    expect(terminalAlertsForInstrument(parsed, "SOL")?.rules[0].threshold).toBe(159);
    expect(terminalAlertsForInstrument(parsed, "BTC")?.browserNotifications).toBe(true);
    expect(terminalAlertsForInstrument(parsed, "SOL")?.browserNotifications).toBe(false);
  });

  it("persists the certified route-improvement metric", () => {
    const routeRule: TerminalAlertRule = {
      ...RULE,
      id: "route-improvement",
      label: "Full-fill peer route improves by 5 bp",
      metric: "route_improvement_bps",
      threshold: 5,
      rearmDelta: 2,
    };
    const storage = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [routeRule],
      events: [],
      browserNotifications: false,
    }, 10);
    expect(parseTerminalAlertStorage(serializeTerminalAlertStorage(storage)).instruments.BTC.rules).toEqual([routeRule]);
  });

  it("persists signed certified funding-rate rules", () => {
    const fundingRule: TerminalAlertRule = {
      ...RULE,
      id: "funding-negative",
      label: "Funding below -1 bp",
      metric: "funding_rate_bps",
      operator: "below",
      threshold: -1,
      rearmDelta: 0.25,
    };
    const storage = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [fundingRule],
      events: [],
      browserNotifications: false,
    }, 10);

    expect(parseTerminalAlertStorage(serializeTerminalAlertStorage(storage)).instruments.BTC.rules).toEqual([fundingRule]);
  });

  it("persists signed certified microprice-edge rules", () => {
    const micropriceRule: TerminalAlertRule = {
      ...RULE,
      id: "microprice-ask-edge",
      label: "Microprice edge below -5 bp",
      metric: "microprice_edge_bps",
      operator: "below",
      threshold: -5,
      rearmDelta: 1,
    };
    const storage = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [micropriceRule],
      events: [],
      browserNotifications: false,
    }, 10);

    expect(parseTerminalAlertStorage(serializeTerminalAlertStorage(storage)).instruments.BTC.rules).toEqual([micropriceRule]);
  });

  it("migrates explicitly scoped v1 state and rejects unscoped legacy state", () => {
    const migrated = parseTerminalAlertStorage(JSON.stringify({
      version: 1,
      instrument: "BTC-USD",
      rules: [RULE],
      events: [],
      updatedAt: 5,
    }));
    expect(terminalAlertsForInstrument(migrated, "BTC")?.rules).toEqual([RULE]);
    expect(migrated.version).toBe(5);

    const unscoped = parseTerminalAlertStorage(JSON.stringify({ version: 1, rules: [RULE], events: [] }));
    expect(unscoped.instruments).toEqual({});
  });

  it("drops malformed entries, orphan events and caps validated history", () => {
    const events = Array.from({ length: TERMINAL_ALERT_HISTORY_LIMIT + 5 }, (_, index) => alertEvent(index));
    const raw = JSON.stringify({
      version: 3,
      instruments: {
        BTC: {
          rules: [RULE, { ...RULE, id: "", threshold: Number.NaN }],
          events: [...events, { ...alertEvent(99), ruleId: "missing" }],
          browserNotifications: false,
          updatedAt: 10,
        },
        "../SOL": { rules: [RULE], events: [], browserNotifications: false, updatedAt: 11 },
      },
    });
    const parsed = parseTerminalAlertStorage(raw);

    expect(parsed.instruments.BTC.rules).toEqual([RULE]);
    expect(parsed.instruments.BTC.events).toHaveLength(TERMINAL_ALERT_HISTORY_LIMIT);
    expect(parsed.instruments["../SOL"]).toBeUndefined();
  });

  it("fails closed on corrupt or unsupported documents", () => {
    expect(parseTerminalAlertStorage("not-json")).toEqual(emptyTerminalAlertStorage());
    expect(parseTerminalAlertStorage(JSON.stringify({ version: 99, instruments: {} }))).toEqual(emptyTerminalAlertStorage());
    expect(inspectTerminalAlertStorage("not-json")).toEqual({ status: "blocked", storage: null, raw: "not-json" });
    const unsupported = JSON.stringify({ version: 99, instruments: {} });
    expect(inspectTerminalAlertStorage(unsupported)).toEqual({ status: "blocked", storage: null, raw: unsupported });
    expect(inspectTerminalAlertStorage(null)).toMatchObject({ status: "absent", storage: emptyTerminalAlertStorage(), raw: null });
    expect(() => updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "../BTC", {
      rules: [RULE], events: [], browserNotifications: false,
    })).toThrow("terminal_alert_scope_invalid");
  });

  it("migrates v2 events as unread and persists acknowledgement", () => {
    const legacyEvent = { ...alertEvent(1) };
    delete (legacyEvent as Partial<TerminalAlertEvent>).acknowledgedAt;
    const migrated = parseTerminalAlertStorage(JSON.stringify({
      version: 2,
      instruments: {
        BTC: { rules: [RULE], events: [legacyEvent], browserNotifications: false, updatedAt: 10 },
      },
    }));
    expect(migrated.version).toBe(5);
    expect(migrated.instruments.BTC.events[0].acknowledgedAt).toBeNull();

    const acknowledged = updateTerminalAlertsForInstrument(migrated, "BTC", {
      ...migrated.instruments.BTC,
      events: [{ ...migrated.instruments.BTC.events[0], acknowledgedAt: 20 }],
    }, 30);
    expect(parseTerminalAlertStorage(serializeTerminalAlertStorage(acknowledged)).instruments.BTC.events[0].acknowledgedAt).toBe(20);
  });

  it("merges concurrent rule additions and independent field edits", () => {
    const base = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [], browserNotifications: false,
    }, 10);
    const added = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [RULE, { ...RULE, id: "spread", label: "Spread", metric: "spread_bps", threshold: 12 }],
      events: [], browserNotifications: false,
    }, 20);
    const thresholdEdit = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [{ ...RULE, threshold: 110 }], events: [], browserNotifications: false,
    }, 30);
    const enabledEdit = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [{ ...RULE, enabled: false }], events: [], browserNotifications: false,
    }, 40);
    const merged = mergeTerminalAlertStorage(added, mergeTerminalAlertStorage(thresholdEdit, enabledEdit));

    expect(merged.instruments.BTC.rules.map((rule) => rule.id)).toEqual(["price-up", "spread"]);
    expect(merged.instruments.BTC.rules.find((rule) => rule.id === RULE.id)).toMatchObject({ threshold: 110, enabled: false });
  });

  it("uses tombstones to prevent stale rule and history resurrection", () => {
    const event = alertEvent(5);
    const base = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [event], browserNotifications: false,
    }, 10);
    const staleEdit = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [{ ...RULE, threshold: 120 }], events: [event], browserNotifications: false,
    }, 20);
    const deletedAndCleared = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [], events: [], browserNotifications: false,
    }, 30);
    const merged = mergeTerminalAlertStorage(staleEdit, deletedAndCleared);

    expect(merged.instruments.BTC.rules).toEqual([]);
    expect(merged.instruments.BTC.events).toEqual([]);

    const recreated = updateTerminalAlertsForInstrument(deletedAndCleared, "BTC", {
      rules: [{ ...RULE, threshold: 130 }], events: [alertEvent(35)], browserNotifications: false,
    }, 40);
    const final = mergeTerminalAlertStorage(merged, recreated);
    expect(final.instruments.BTC.rules[0].threshold).toBe(130);
    expect(final.instruments.BTC.events.map((item) => item.triggeredAt)).toEqual([35]);
  });

  it("uses a durable clear barrier to prevent a stale tab from restoring any instrument", () => {
    let stale = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [alertEvent(5)], browserNotifications: true,
    }, 10);
    stale = updateTerminalAlertsForInstrument(stale, "SOL", {
      rules: [{ ...RULE, threshold: 150 }], events: [], browserNotifications: false,
    }, 20);
    const cleared = clearTerminalAlertStorage(30);

    expect(mergeTerminalAlertStorage(stale, cleared)).toEqual(cleared);
    expect(mergeTerminalAlertStorage(cleared, stale)).toEqual(cleared);

    const recreated = updateTerminalAlertsForInstrument(cleared, "BTC", {
      rules: [{ ...RULE, threshold: 130 }], events: [], browserNotifications: false,
    }, 30);
    const merged = mergeTerminalAlertStorage(recreated, stale);
    expect(merged.clearedAt).toBe(30);
    expect(Object.keys(merged.instruments)).toEqual(["BTC"]);
    expect(merged.instruments.BTC.rules[0].threshold).toBe(130);
  });

  it("fails closed instead of silently dropping an impossible current-version pre-clear entry", () => {
    const stored = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [], browserNotifications: false,
    }, 10);
    const raw = JSON.parse(serializeTerminalAlertStorage(stored));
    raw.clearedAt = 20;

    expect(inspectTerminalAlertStorage(JSON.stringify(raw))).toMatchObject({ status: "blocked" });
  });

  it("preserves acknowledgement and applies the latest notification preference", () => {
    const event = alertEvent(5);
    const base = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [event], browserNotifications: false,
    }, 10);
    const acknowledged = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [RULE], events: [{ ...event, acknowledgedAt: 20 }], browserNotifications: false,
    }, 20);
    const notificationsOn = updateTerminalAlertsForInstrument(base, "BTC", {
      rules: [RULE], events: [event], browserNotifications: true,
    }, 30);
    const merged = mergeTerminalAlertStorage(acknowledged, notificationsOn);

    expect(merged.instruments.BTC.events[0].acknowledgedAt).toBe(20);
    expect(merged.instruments.BTC.browserNotifications).toBe(true);
  });

  it("fails closed on incomplete v5 revision metadata", () => {
    const stored = updateTerminalAlertsForInstrument(emptyTerminalAlertStorage(), "BTC", {
      rules: [RULE], events: [], browserNotifications: false,
    }, 10);
    const raw = JSON.parse(serializeTerminalAlertStorage(stored));
    delete raw.instruments.BTC.ruleUpdatedAt[RULE.id].threshold;
    expect(inspectTerminalAlertStorage(JSON.stringify(raw)).status).toBe("blocked");
  });
});

function alertEvent(index: number): TerminalAlertEvent {
  return {
    id: `price-up:${index}`,
    ruleId: RULE.id,
    label: RULE.label,
    metric: RULE.metric,
    operator: RULE.operator,
    threshold: RULE.threshold,
    observed: 102 + index,
    triggeredAt: index,
    acknowledgedAt: null,
  };
}
