"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  acknowledgeTerminalAlertEvents,
  createTerminalCustomAlertRule,
  defaultTerminalAlertRules,
  deriveTerminalPlanLevelAlert,
  deriveTerminalSavedPlanAlertRules,
  evaluateTerminalAlerts,
  removeTerminalSavedPlanAlertRules,
  reconcileTerminalAlertRules,
  TERMINAL_CUSTOM_ALERT_LIMIT,
  terminalAlertMetricLabel,
  terminalAlertActiveBreaches,
  type TerminalAlertEvent,
  type TerminalAlertMetric,
  type TerminalAlertOperator,
  type TerminalPlanAlertKind,
  type TerminalAlertRule,
  type TerminalAlertRuleState,
  type TerminalAlertSnapshot,
  type TerminalAlertSummary,
  type TerminalSavedPlanAlertRequest,
  type TerminalSavedPlanAlertRemovalRequest,
  type TerminalSavedPlanInventoryItem,
  terminalSavedPlanIdFromAlertRuleId,
  terminalSavedPlanWatchIds,
  unacknowledgedTerminalAlertCount,
  upsertTerminalAlertRule,
  validTerminalSavedPlanAlertRemovalRequest,
} from "@/lib/terminal-alerts";
import type { TerminalCertifiedSignalSurface } from "@/lib/terminal-certified-market-signals";
import {
  advanceTerminalAlertAgeSnapshot,
  terminalAlertNextAgeThresholdAt,
} from "@/lib/terminal-alert-clock";
import {
  terminalChartPriceAlertSnapshot,
  type TerminalChartPriceAlertSnapshot,
} from "@/lib/terminal-alert-chart";
import {
  TERMINAL_ALERT_HISTORY_LIMIT,
  TERMINAL_ALERT_RULE_LIMIT,
  clearTerminalAlertStorage,
  emptyTerminalAlertStorage,
  inspectTerminalAlertStorage,
  mergeTerminalAlertStorage,
  serializeTerminalAlertStorage,
  terminalAlertStoragesEqual,
  terminalAlertInstrumentScope,
  terminalAlertStorageKey,
  terminalAlertStorageViewReady,
  terminalAlertsForInstrument,
  updateTerminalAlertsForInstrument,
} from "@/lib/terminal-alert-storage";

export interface TerminalAlertCenterProps {
  persistenceScope: string | null;
  instrument: string;
  snapshotInstrument: string | null;
  evaluationIdentityKey: string | null;
  referencePrice: number | null;
  snapshot: TerminalAlertSnapshot;
  snapshotCapturedAtMs?: number | null;
  availableMetrics: TerminalAlertMetric[];
  feed: TerminalCertifiedSignalSurface;
  planEntryPrice: number | null;
  planTargetPrice: number | null;
  planInvalidationPrice: number | null;
  onSummaryChange: (summary: TerminalAlertSummary) => void;
  onPriceAlertsChange: (snapshot: TerminalChartPriceAlertSnapshot) => void;
  savedPlanWatchRequest?: TerminalSavedPlanAlertRequest | null;
  savedPlanRemovalRequest?: TerminalSavedPlanAlertRemovalRequest | null;
  savedPlanInventory?: readonly TerminalSavedPlanInventoryItem[] | null;
  onSavedPlanWatchIdsChange?: (planIds: readonly string[]) => void;
}

type NotificationPermissionState = NotificationPermission | "unsupported";
const EMPTY_TERMINAL_ALERT_RULES: TerminalAlertRule[] = [];

export const TerminalAlertCenter = memo(function TerminalAlertCenter({
  persistenceScope,
  instrument,
  snapshotInstrument,
  evaluationIdentityKey,
  referencePrice,
  snapshot,
  snapshotCapturedAtMs = null,
  availableMetrics,
  feed,
  planEntryPrice,
  planTargetPrice,
  planInvalidationPrice,
  onSummaryChange,
  onPriceAlertsChange,
  savedPlanWatchRequest = null,
  savedPlanRemovalRequest = null,
  savedPlanInventory = null,
  onSavedPlanWatchIdsChange,
}: TerminalAlertCenterProps) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<TerminalAlertRule[]>(() => defaultTerminalAlertRules(referencePrice));
  const [events, setEvents] = useState<TerminalAlertEvent[]>([]);
  const [browserNotifications, setBrowserNotifications] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [ruleMessage, setRuleMessage] = useState("");
  const [ageEvaluationTick, setAgeEvaluationTick] = useState(0);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() => (
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  ));
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(null);
  const [storageBlock, setStorageBlock] = useState<string | null>(null);
  const storageDocumentRef = useRef(emptyTerminalAlertStorage());
  const statesRef = useRef<Record<string, TerminalAlertRuleState>>({});
  const sectionRef = useRef<HTMLElement | null>(null);
  const evaluationIdentityRef = useRef<string | null>(null);
  const defaultScopeRef = useRef<string | null>(null);
  const handledSavedPlanRequestRef = useRef<string | null>(null);
  const handledSavedPlanRemovalRef = useRef<string | null>(null);
  const scope = useMemo(() => terminalAlertInstrumentScope(instrument), [instrument]);
  const storageKey = terminalAlertStorageKey(persistenceScope);
  const snapshotScope = useMemo(() => terminalAlertInstrumentScope(snapshotInstrument), [snapshotInstrument]);
  const snapshotMatchesScope = scope != null && snapshotScope === scope;
  const scopedReferencePrice = snapshotMatchesScope ? referencePrice : null;
  const scopedReferencePriceRef = useRef(scopedReferencePrice);
  const hydrationReady = terminalAlertStorageViewReady({
    storageKey,
    hydratedStorageKey,
    instrumentScope: scope,
    hydratedInstrumentScope: hydratedScope,
  });
  const inventoryPlanIds = useMemo(() => {
    if (!scope || savedPlanInventory == null) return null;
    return new Set(savedPlanInventory
      .filter((item) => terminalAlertInstrumentScope(item.instrument) === scope)
      .map((item) => item.planId));
  }, [savedPlanInventory, scope]);

  useEffect(() => {
    scopedReferencePriceRef.current = scopedReferencePrice;
  }, [scopedReferencePrice]);

  useEffect(() => {
    if (!scope || !storageKey) return;
    let cancelled = false;
    let stored = null;
    let blockedRaw: string | null = null;
    try {
      const inspection = inspectTerminalAlertStorage(window.localStorage.getItem(storageKey));
      if (inspection.status === "blocked") blockedRaw = inspection.raw;
      else {
        storageDocumentRef.current = inspection.storage;
        stored = terminalAlertsForInstrument(inspection.storage, scope);
      }
    } catch {
      blockedRaw = "storage_unavailable";
    }
    const defaults = defaultTerminalAlertRules(scopedReferencePriceRef.current);
    const initialRules = blockedRaw ? [] : stored ? reconcileTerminalAlertRules(stored.rules, defaults) : defaults;
    queueMicrotask(() => {
      if (cancelled) return;
      setRules(initialRules);
      setEvents(blockedRaw ? [] : stored?.events ?? []);
      setBrowserNotifications(blockedRaw ? false : Boolean(stored?.browserNotifications));
      setStorageBlock(blockedRaw);
      setRuleMessage("");
      statesRef.current = {};
      evaluationIdentityRef.current = null;
      defaultScopeRef.current = stored ? null : scope;
      setHydratedScope(scope);
      setHydratedStorageKey(storageKey);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, storageKey]);

  useEffect(() => {
    if (!scope || !storageKey || !hydrationReady || storageBlock != null) return;
    try {
      const inspection = inspectTerminalAlertStorage(window.localStorage.getItem(storageKey));
      if (inspection.status === "blocked") {
        queueMicrotask(() => setStorageBlock(inspection.raw));
        return;
      }
      const current = mergeTerminalAlertStorage(storageDocumentRef.current, inspection.storage);
      const updated = updateTerminalAlertsForInstrument(current, scope, {
        rules,
        events,
        browserNotifications,
      });
      window.localStorage.setItem(storageKey, serializeTerminalAlertStorage(updated));
      storageDocumentRef.current = updated;
    } catch {
      // Alerts continue in memory when persistence is unavailable.
    }
  }, [browserNotifications, events, hydrationReady, rules, scope, storageBlock, storageKey]);

  useEffect(() => {
    if (!scope || !storageKey) return;
    const activeScope = scope;
    const activeStorageKey = storageKey;
    function reconcileStorage(event: StorageEvent) {
      if (event.key !== activeStorageKey || (event.storageArea && event.storageArea !== window.localStorage)) return;
      const incoming = inspectTerminalAlertStorage(event.newValue);
      if (incoming.status === "blocked") {
        setStorageBlock(incoming.raw);
        setRules([]);
        setEvents([]);
        setBrowserNotifications(false);
        statesRef.current = {};
        return;
      }
      const merged = event.newValue == null
        ? incoming.storage
        : mergeTerminalAlertStorage(storageDocumentRef.current, incoming.storage);
      const raw = serializeTerminalAlertStorage(merged);
      if (event.newValue != null && !terminalAlertStoragesEqual(merged, incoming.storage)) {
        try {
          window.localStorage.setItem(activeStorageKey, raw);
        } catch {
          setStorageBlock(event.newValue ?? "storage_unavailable");
          return;
        }
      }
      storageDocumentRef.current = merged;
      const stored = terminalAlertsForInstrument(merged, activeScope);
      const defaults = defaultTerminalAlertRules(scopedReferencePrice);
      setRules(stored ? reconcileTerminalAlertRules(stored.rules, defaults) : defaults);
      setEvents(stored?.events ?? []);
      setBrowserNotifications(Boolean(stored?.browserNotifications));
      setStorageBlock(null);
      statesRef.current = {};
      evaluationIdentityRef.current = null;
    }
    window.addEventListener("storage", reconcileStorage);
    return () => window.removeEventListener("storage", reconcileStorage);
  }, [scope, scopedReferencePrice, storageKey]);

  useEffect(() => {
    if (!scope || !hydrationReady || storageBlock != null || defaultScopeRef.current !== scope) return;
    if (scopedReferencePrice == null || !Number.isFinite(scopedReferencePrice) || scopedReferencePrice <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || defaultScopeRef.current !== scope) return;
      defaultScopeRef.current = null;
      setRules((current) => {
        if (current.some((rule) => rule.metric === "price")) return current;
        const priceRules = defaultTerminalAlertRules(scopedReferencePrice).filter((rule) => rule.metric === "price");
        return [...priceRules, ...current];
      });
      statesRef.current = {};
    });
    return () => {
      cancelled = true;
    };
  }, [hydrationReady, scope, scopedReferencePrice, storageBlock]);

  useEffect(() => {
    if (
      !savedPlanWatchRequest
      || !scope
      || !hydrationReady
      || storageBlock != null
      || handledSavedPlanRequestRef.current === savedPlanWatchRequest.requestId
    ) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || handledSavedPlanRequestRef.current === savedPlanWatchRequest.requestId) return;
      const requestScope = terminalAlertInstrumentScope(savedPlanWatchRequest.instrument);
      if (requestScope !== scope) {
        handledSavedPlanRequestRef.current = savedPlanWatchRequest.requestId;
        setOpen(true);
        setRuleMessage("Saved-plan watch blocked: the selected instrument changed before alerts were armed");
        return;
      }
      const decision = deriveTerminalSavedPlanAlertRules({ request: savedPlanWatchRequest, referencePrice: scopedReferencePrice });
      if (!decision.rules) {
        handledSavedPlanRequestRef.current = savedPlanWatchRequest.requestId;
        setOpen(true);
        setRuleMessage(savedPlanWatchBlockerLabel(decision.blocker));
        return;
      }
      const existingIds = new Set(rules.map((rule) => rule.id));
      const additions = decision.rules.filter((rule) => !existingIds.has(rule.id)).length;
      if (rules.length + additions > TERMINAL_ALERT_RULE_LIMIT) {
        handledSavedPlanRequestRef.current = savedPlanWatchRequest.requestId;
        setOpen(true);
        setRuleMessage(`Saved-plan watch blocked: alert capacity is ${TERMINAL_ALERT_RULE_LIMIT} rules`);
        return;
      }
      handledSavedPlanRequestRef.current = savedPlanWatchRequest.requestId;
      statesRef.current = decision.rules.reduce((states, rule) => ({
        ...states,
        [rule.id]: { armed: true, previousValue: null, lastTriggeredAt: null },
      }), statesRef.current);
      setRules((current) => decision.rules.reduce(upsertTerminalAlertRule, current));
      setOpen(true);
      setRuleMessage(`${savedPlanWatchRequest.planName}: entry, target, and invalidation instrument-price watches armed; venue and account identity are not inferred`);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrationReady, rules, savedPlanWatchRequest, scope, scopedReferencePrice, storageBlock]);

  useEffect(() => {
    if (
      !savedPlanRemovalRequest
      || !scope
      || !hydrationReady
      || storageBlock != null
      || handledSavedPlanRemovalRef.current === savedPlanRemovalRequest.requestId
    ) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || handledSavedPlanRemovalRef.current === savedPlanRemovalRequest.requestId) return;
      handledSavedPlanRemovalRef.current = savedPlanRemovalRequest.requestId;
      if (
        !validTerminalSavedPlanAlertRemovalRequest(savedPlanRemovalRequest)
        || terminalAlertInstrumentScope(savedPlanRemovalRequest.instrument) !== scope
      ) {
        setOpen(true);
        setRuleMessage("Saved-plan unwatch blocked: the alert request no longer matches this instrument");
        return;
      }
      const planIds = new Set([savedPlanRemovalRequest.planId]);
      setRules((current) => removeTerminalSavedPlanAlertRules(current, planIds));
      const nextStates = { ...statesRef.current };
      for (const ruleId of Object.keys(nextStates)) {
        if (terminalSavedPlanIdFromAlertRuleId(ruleId) === savedPlanRemovalRequest.planId) delete nextStates[ruleId];
      }
      statesRef.current = nextStates;
      setOpen(true);
      setRuleMessage(`${savedPlanRemovalRequest.planName}: active entry, target, and invalidation watches removed; triggered history retained`);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrationReady, savedPlanRemovalRequest, scope, storageBlock]);

  useEffect(() => {
    if (!scope || !hydrationReady || storageBlock != null || inventoryPlanIds == null) return;
    const orphanPlanIds = new Set<string>();
    for (const rule of rules) {
      const planId = terminalSavedPlanIdFromAlertRuleId(rule.id);
      if (planId != null && !inventoryPlanIds.has(planId)) orphanPlanIds.add(planId);
    }
    if (orphanPlanIds.size === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRules((current) => removeTerminalSavedPlanAlertRules(current, orphanPlanIds));
      const nextStates = { ...statesRef.current };
      for (const ruleId of Object.keys(nextStates)) {
        const planId = terminalSavedPlanIdFromAlertRuleId(ruleId);
        if (planId != null && orphanPlanIds.has(planId)) delete nextStates[ruleId];
      }
      statesRef.current = nextStates;
      setRuleMessage(`${orphanPlanIds.size} deleted saved-plan watch${orphanPlanIds.size === 1 ? "" : "es"} removed; triggered history retained`);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrationReady, inventoryPlanIds, rules, scope, storageBlock]);

  useEffect(() => {
    function openAlerts() {
      setFocusRequest((current) => current + 1);
      setOpen(true);
    }
    window.addEventListener("ghola:open-alerts", openAlerts);
    return () => window.removeEventListener("ghola:open-alerts", openAlerts);
  }, []);

  useEffect(() => {
    if (!open || focusRequest === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const target = sectionRef.current?.querySelector<HTMLElement>("[data-terminal-alert-unread='true']")
        ?? sectionRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, open]);

  useEffect(() => {
    if (!scope || !hydrationReady || storageBlock != null) return;
    const nowMs = Date.now();
    statesRef.current = terminalAlertStatesForEvaluationIdentity(
      evaluationIdentityRef.current,
      evaluationIdentityKey,
      statesRef.current,
    );
    evaluationIdentityRef.current = evaluationIdentityKey;
    const evaluatedSnapshot = snapshotMatchesScope
      ? advanceTerminalAlertAgeSnapshot({ snapshot, capturedAtMs: snapshotCapturedAtMs, nowMs })
      : {};
    const evaluation = evaluateTerminalAlerts({
      rules,
      snapshot: evaluatedSnapshot,
      states: statesRef.current,
      nowMs,
    });
    statesRef.current = evaluation.states;
    if (evaluation.events.length) {
      setEvents((current) => [...evaluation.events, ...current].slice(0, TERMINAL_ALERT_HISTORY_LIMIT));
      if (browserNotifications && notificationPermission === "granted" && typeof Notification !== "undefined") {
        for (const event of evaluation.events) {
          try {
            new Notification(`${scope} · ${event.label}`, {
              body: `${formatAlertValue(event.metric, event.observed)} crossed ${formatAlertValue(event.metric, event.threshold)}`,
              tag: `ghola-alert:${scope}:${event.ruleId}`,
            });
          } catch {
            // Permission or platform state can change between evaluation and delivery.
          }
        }
      }
    }
  }, [ageEvaluationTick, browserNotifications, evaluationIdentityKey, hydrationReady, notificationPermission, rules, scope, snapshot, snapshotCapturedAtMs, snapshotMatchesScope, storageBlock]);

  useEffect(() => {
    if (!scope || !hydrationReady || storageBlock != null || !snapshotMatchesScope) return;
    const nowMs = Date.now();
    const thresholdAt = terminalAlertNextAgeThresholdAt({ rules, snapshot, capturedAtMs: snapshotCapturedAtMs, nowMs });
    if (thresholdAt == null) return;
    const delayMs = Math.min(2_147_000_000, Math.max(1, thresholdAt - nowMs + 1));
    const timer = window.setTimeout(() => setAgeEvaluationTick(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [ageEvaluationTick, hydrationReady, rules, scope, snapshot, snapshotCapturedAtMs, snapshotMatchesScope, storageBlock]);

  async function requestNotifications() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    setBrowserNotifications(permission === "granted");
  }

  function resetDefaults() {
    setRules(defaultTerminalAlertRules(scopedReferencePrice));
    setEvents([]);
    statesRef.current = {};
    defaultScopeRef.current = scopedReferencePrice == null ? scope : null;
    setRuleMessage("Default alert rules restored; custom rules and history cleared");
  }

  function addCustomRule(metric: TerminalAlertMetric, operator: TerminalAlertOperator, threshold: number) {
    const customCount = rules.filter((rule) => rule.id.startsWith("custom-")).length;
    if (customCount >= TERMINAL_CUSTOM_ALERT_LIMIT) {
      setRuleMessage(`Custom alert limit reached (${TERMINAL_CUSTOM_ALERT_LIMIT})`);
      return false;
    }
    const rule = createTerminalCustomAlertRule({
      id: createCustomAlertId(),
      metric,
      operator,
      threshold,
    });
    if (!rule) {
      setRuleMessage("Enter a valid finite threshold");
      return false;
    }
    statesRef.current = {
      ...statesRef.current,
      [rule.id]: { armed: true, previousValue: null, lastTriggeredAt: null },
    };
    setRules((current) => [rule, ...current]);
    setRuleMessage(`${rule.label} added; the next certified sample establishes its baseline`);
    return true;
  }

  function removeUserRule(rule: TerminalAlertRule) {
    if ((!rule.id.startsWith("custom-") && !rule.id.startsWith("saved-plan-")) || !window.confirm(`Delete local alert “${rule.label}”? Triggered history remains as an audit trail.`)) return;
    setRules((current) => current.filter((item) => item.id !== rule.id));
    const nextStates = { ...statesRef.current };
    delete nextStates[rule.id];
    statesRef.current = nextStates;
    setRuleMessage(`${rule.label} deleted`);
  }

  function resetBlockedStorage() {
    if (storageBlock == null || !scope || !storageKey || !hydrationReady || !window.confirm("Reset unreadable local alert storage? Existing rules and history cannot be recovered after this.")) return;
    try {
      const cleared = clearTerminalAlertStorage();
      window.localStorage.setItem(storageKey, serializeTerminalAlertStorage(cleared));
      storageDocumentRef.current = cleared;
      const defaults = defaultTerminalAlertRules(scopedReferencePrice);
      setRules(defaults);
      setEvents([]);
      setBrowserNotifications(false);
      statesRef.current = {};
      evaluationIdentityRef.current = null;
      defaultScopeRef.current = scopedReferencePrice == null ? scope : null;
      setStorageBlock(null);
    } catch {
      // Keep the raw storage locked and preserved when localStorage is unavailable.
    }
  }

  const activeRules = hydrationReady ? rules : EMPTY_TERMINAL_ALERT_RULES;
  const activeEvents = hydrationReady ? events : [];
  const activeBrowserNotifications = hydrationReady && browserNotifications;
  const activeStorageBlock = hydrationReady ? storageBlock : null;
  const activeBreachSnapshot = useMemo(() => {
    if (!scope || !hydrationReady || activeStorageBlock != null || !snapshotMatchesScope) return {};
    const capturedAtMs = snapshotCapturedAtMs ?? null;
    const nowMs = Math.max(ageEvaluationTick, capturedAtMs ?? 0);
    return advanceTerminalAlertAgeSnapshot({ snapshot, capturedAtMs, nowMs });
  }, [activeStorageBlock, ageEvaluationTick, hydrationReady, scope, snapshot, snapshotCapturedAtMs, snapshotMatchesScope]);
  const activeBreaches = useMemo(
    () => terminalAlertActiveBreaches({ rules: activeRules, snapshot: activeBreachSnapshot }),
    [activeBreachSnapshot, activeRules],
  );
  const activeCount = activeBreaches.length;
  const primaryActiveLabel = activeBreaches[0]?.label ?? null;
  const enabledCount = activeRules.filter((rule) => rule.enabled).length;
  const availableMetricSet = new Set(availableMetrics);
  const monitoringCount = activeRules.filter((rule) => rule.enabled && availableMetricSet.has(rule.metric)).length;
  const unreadCount = unacknowledgedTerminalAlertCount(activeEvents);
  const latestUnread = activeEvents.find((event) => event.acknowledgedAt == null) ?? null;
  const summaryReady = hydrationReady && activeStorageBlock == null;
  const chartPriceAlerts = useMemo(
    () => terminalChartPriceAlertSnapshot(scope, activeRules, summaryReady),
    [activeRules, scope, summaryReady],
  );
  const watchedSavedPlanIds = useMemo(() => terminalSavedPlanWatchIds(activeRules), [activeRules]);
  useEffect(() => {
    onSummaryChange(summaryReady ? {
      scope,
      activeCount,
      primaryActiveLabel,
      unreadCount,
      latestUnreadLabel: latestUnread?.label ?? null,
      latestTriggeredAt: latestUnread?.triggeredAt ?? null,
    } : {
      scope: null,
      activeCount: 0,
      primaryActiveLabel: null,
      unreadCount: 0,
      latestUnreadLabel: null,
      latestTriggeredAt: null,
    });
  }, [activeCount, latestUnread?.label, latestUnread?.triggeredAt, onSummaryChange, primaryActiveLabel, scope, summaryReady, unreadCount]);
  useEffect(() => {
    onPriceAlertsChange(chartPriceAlerts);
  }, [chartPriceAlerts, onPriceAlertsChange]);
  useEffect(() => {
    onSavedPlanWatchIdsChange?.(watchedSavedPlanIds);
  }, [onSavedPlanWatchIdsChange, watchedSavedPlanIds]);
  const entryAlert = deriveTerminalPlanLevelAlert({ kind: "entry", level: planEntryPrice, referencePrice: scopedReferencePrice });
  const targetAlert = deriveTerminalPlanLevelAlert({ kind: "target", level: planTargetPrice, referencePrice: scopedReferencePrice });
  const invalidationAlert = deriveTerminalPlanLevelAlert({ kind: "invalidation", level: planInvalidationPrice, referencePrice: scopedReferencePrice });
  function acknowledge(eventId: string | null) {
    setEvents((current) => acknowledgeTerminalAlertEvents(current, eventId));
  }
  function armPlanAlert(decision: ReturnType<typeof deriveTerminalPlanLevelAlert>) {
    const rule = decision.rule;
    if (!rule || !scope || !hydrationReady || scopedReferencePrice == null) return;
    statesRef.current = {
      ...statesRef.current,
      [rule.id]: { armed: true, previousValue: scopedReferencePrice, lastTriggeredAt: null },
    };
    setRules((current) => upsertTerminalAlertRule(current, rule));
    setRuleMessage(`${rule.label} armed at ${formatAlertValue("price", rule.threshold)}; later plan edits will not move it`);
  }
  function armAllPlanAlerts() {
    const decisions = [entryAlert, targetAlert, invalidationAlert];
    const planRules = decisions.map((decision) => decision.rule);
    if (!scope || !hydrationReady || scopedReferencePrice == null || planRules.some((rule) => rule == null)) return;
    const readyRules = planRules as TerminalAlertRule[];
    const nextStates = { ...statesRef.current };
    for (const rule of readyRules) {
      nextStates[rule.id] = { armed: true, previousValue: scopedReferencePrice, lastTriggeredAt: null };
    }
    statesRef.current = nextStates;
    setRules((current) => readyRules.reduce(upsertTerminalAlertRule, current));
    setRuleMessage("Entry, target, and invalidation alerts armed from the exact current plan; later edits will not move them");
  }
  const allPlanAlertsReady = hydrationReady && entryAlert.rule != null && targetAlert.rule != null && invalidationAlert.rule != null;
  const allPlanAlertsExist = ["plan-entry", "plan-target", "plan-invalidation"].every((id) => activeRules.some((rule) => rule.id === id));
  return (
    <section
      ref={sectionRef}
      id="terminal-alerts"
      tabIndex={-1}
      className="border-t border-[#182234] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300/60"
      aria-labelledby="terminal-alerts-heading"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-keyshortcuts="L"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[#0b111b]"
      >
        <span>
          <span id="terminal-alerts-heading" className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
            {scope ?? "Market"} local alerts
          </span>
          <span className="mt-0.5 block text-[10px] text-[#8b95a8]">{monitoringCount}/{enabledCount} monitoring · {activeBreaches.length} active · {unreadCount} unread · {activeEvents.length} history</span>
        </span>
        <span className="font-mono text-[10px] uppercase text-[#7f91aa]">{open ? "Hide" : "Manage"}</span>
      </button>
      <div
        role="status"
        className={`border-t border-[#141d2e] px-4 py-2 text-[9px] leading-4 ${feedStatusTone(feed.status)}`}
      >
        {!hydrationReady
          ? "Paused · restoring account-scoped local alerts before evaluation."
          : activeStorageBlock != null
          ? "Locked · unreadable local alert storage is preserved; no rules evaluate or write."
          : `${feed.status === "ready" ? "Certified" : feed.status === "degraded" ? "Degraded" : "Paused"} · ${feed.message}. Synthetic and uncertified retained values never evaluate.`}
      </div>
      {activeBreaches.length > 0 ? (
        <div aria-label="Current active alert conditions" className="border-t border-rose-300/15 bg-rose-300/[0.04] px-4 py-2 text-[10px] leading-4 text-rose-100">
          <span className="font-semibold">Active now · </span>
          {activeBreaches.slice(0, 3).map((breach) => `${breach.label} (${formatAlertValue(breach.metric, breach.observed)})`).join(" · ")}
          {activeBreaches.length > 3 ? ` · +${activeBreaches.length - 3} more` : ""}
          <span className="block text-[8px] text-[#8b95a8]">Live conditions are separate from crossing events and do not create browser notifications.</span>
        </div>
      ) : null}
      {latestUnread ? (
        <div role="alert" className="flex items-center justify-between gap-3 border-t border-[#141d2e] bg-amber-300/[0.04] px-4 py-2 text-[10px] text-amber-100">
          <span>{latestUnread.label} · {formatAlertCrossing(latestUnread)}</span>
          <button
            type="button"
            data-terminal-alert-unread="true"
            onClick={() => acknowledge(latestUnread.id)}
            className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase"
          >
            Acknowledge
          </button>
        </div>
      ) : null}
      {open ? (
        <div className="border-t border-[#182234] px-4 py-3">
          {!hydrationReady ? (
            <div role="status" className="rounded border border-amber-300/25 bg-amber-300/[0.04] p-2.5 text-[10px] leading-4 text-amber-100">
              Restoring this account&apos;s browser-local alert rules and history. Monitoring remains paused.
            </div>
          ) : activeStorageBlock != null ? (
            <div role="alert" className="rounded border border-rose-300/25 bg-rose-300/[0.04] p-2.5 text-[10px] leading-4 text-rose-200">
              Existing local alert rules and history are unreadable and remain untouched. Monitoring is locked to prevent silent data loss.
              <button type="button" onClick={resetBlockedStorage} className="term-chip mt-2 block h-7 px-2 text-[9px]">Reset alert storage</button>
            </div>
          ) : (
          <>
          <div className="mb-3 rounded border border-[#141d2e] bg-[#080c13] p-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#9aa7ba]">Staged plan alerts</p>
                <p className="mt-0.5 text-[8px] leading-3 text-[#66738c]">Snapshots current levels; later plan edits do not move an armed alert. Saved-plan watches are labeled instrument-price signals.</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                <button
                  type="button"
                  disabled={!allPlanAlertsReady}
                  title={allPlanAlertsReady ? "Snapshot all three exact plan levels" : "Entry, target, invalidation, and certified reference price are required."}
                  onClick={armAllPlanAlerts}
                  className="term-chip h-8 px-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {allPlanAlertsExist ? "Update all" : "Arm all"}
                </button>
                <PlanAlertButton
                  kind="entry"
                  decision={entryAlert}
                  exists={activeRules.some((rule) => rule.id === "plan-entry")}
                  ready={hydrationReady}
                  onArm={armPlanAlert}
                />
                <PlanAlertButton
                  kind="target"
                  decision={targetAlert}
                  exists={activeRules.some((rule) => rule.id === "plan-target")}
                  ready={hydrationReady}
                  onArm={armPlanAlert}
                />
                <PlanAlertButton
                  kind="invalidation"
                  decision={invalidationAlert}
                  exists={activeRules.some((rule) => rule.id === "plan-invalidation")}
                  ready={hydrationReady}
                  onArm={armPlanAlert}
                />
              </div>
            </div>
          </div>
          <CustomAlertBuilder
            availableMetrics={availableMetrics}
            customCount={activeRules.filter((rule) => rule.id.startsWith("custom-")).length}
            snapshot={snapshotMatchesScope ? snapshot : {}}
            onCreate={addCustomRule}
          />
          <p aria-live="polite" className="mb-2 min-h-4 text-[9px] leading-4 text-amber-100">{ruleMessage}</p>
          <div className="grid gap-1.5">
            {activeRules.map((rule) => (
              <AlertRuleRow key={rule.id} rule={rule} available={availableMetricSet.has(rule.metric)} onChange={(next) => {
                statesRef.current = { ...statesRef.current, [rule.id]: { armed: true, previousValue: null, lastTriggeredAt: null } };
                setRules((current) => current.map((item) => item.id === rule.id ? next : item));
              }} onRemove={rule.id.startsWith("custom-") || rule.id.startsWith("saved-plan-") ? () => removeUserRule(rule) : undefined} />
            ))}
          </div>
          <div className="mt-3 rounded border border-[#141d2e] bg-[#080c13] px-2 py-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] text-[#aeb9cb]">Browser notifications</p>
                <p className="mt-0.5 text-[9px] text-[#8b95a8]" role="status" aria-live="polite">
                  {notificationStatus(notificationPermission, browserNotifications)}
                </p>
              </div>
              {notificationPermission === "granted" ? (
                <label className="flex items-center gap-2 text-[9px] uppercase text-[#7f91aa]">
                  <input
                    type="checkbox"
                    checked={activeBrowserNotifications}
                    onChange={(event) => setBrowserNotifications(event.target.checked)}
                    className="h-3 w-3 accent-sky-400"
                  />
                  Enabled
                </label>
              ) : notificationPermission === "denied" || notificationPermission === "unsupported" ? null : (
                <button type="button" onClick={() => void requestNotifications()} className="term-chip h-7 px-2 text-[10px]">
                  Enable
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[#141d2e] pt-3">
            <p className="text-[9px] leading-4 text-[#8b95a8]">Browser-local only. No worker or remote runtime.</p>
            <div className="flex gap-1.5">
              <button type="button" onClick={resetDefaults} className="term-chip h-7 px-2 text-[10px]">
                Reset defaults
              </button>
              <button type="button" onClick={() => acknowledge(null)} disabled={!unreadCount} className="term-chip h-7 px-2 text-[10px] disabled:opacity-40">
                Acknowledge all
              </button>
              <button type="button" onClick={() => setEvents([])} disabled={!activeEvents.length} className="term-chip h-7 px-2 text-[10px] disabled:opacity-40">
                Clear history
              </button>
            </div>
          </div>
          {activeEvents.length ? (
            <ol className="mt-3 max-h-32 space-y-1 overflow-y-auto font-mono text-[9px] text-[#8390a6]" aria-label="Recent local alerts">
              {activeEvents.slice(0, 12).map((event) => (
                <li key={event.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded px-1 py-1 ${event.acknowledgedAt == null ? "bg-amber-300/[0.04] text-amber-100" : "text-[#8390a6]"}`}>
                  <span className="truncate">{event.label}</span>
                  <time className="shrink-0 tabular-nums" dateTime={new Date(event.triggeredAt).toISOString()}>
                    {new Date(event.triggeredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                  <span className="col-span-1 truncate text-[8px]">{formatAlertCrossing(event)}</span>
                  {event.acknowledgedAt == null ? (
                    <button
                      type="button"
                      data-terminal-alert-unread="true"
                      onClick={() => acknowledge(event.id)}
                      className="col-start-2 row-start-2 text-right text-[8px] uppercase text-sky-200 hover:text-sky-100"
                    >
                      Acknowledge
                    </button>
                  ) : (
                    <span className="col-start-2 row-start-2 text-right text-[8px] uppercase text-[#6f7d9a]">Acknowledged</span>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          </>
          )}
        </div>
      ) : null}
    </section>
  );
});

function CustomAlertBuilder({
  availableMetrics,
  customCount,
  snapshot,
  onCreate,
}: {
  availableMetrics: TerminalAlertMetric[];
  customCount: number;
  snapshot: TerminalAlertSnapshot;
  onCreate: (metric: TerminalAlertMetric, operator: TerminalAlertOperator, threshold: number) => boolean;
}) {
  const [selectedMetric, setSelectedMetric] = useState<TerminalAlertMetric>("price");
  const [operator, setOperator] = useState<TerminalAlertOperator>("above");
  const [threshold, setThreshold] = useState("");
  const metric = availableMetrics.includes(selectedMetric)
    ? selectedMetric
    : availableMetrics[0] ?? null;
  const currentValue = metric ? snapshot[metric] : null;
  const thresholdValue = Number(threshold);
  const validThreshold = threshold.trim() !== ""
    && metric != null
    && Number.isFinite(thresholdValue)
    && (metric !== "price" || thresholdValue > 0);
  const atLimit = customCount >= TERMINAL_CUSTOM_ALERT_LIMIT;

  return (
    <fieldset className="mb-2 rounded border border-[#141d2e] bg-[#080c13] p-2" disabled={metric == null || atLimit}>
      <legend className="px-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#9aa7ba]">Custom certified alert</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_5.25rem] gap-1.5 sm:grid-cols-[minmax(0,1fr)_5.25rem_6.5rem_auto]">
        <label className="sr-only" htmlFor="terminal-alert-metric">Metric</label>
        <select
          id="terminal-alert-metric"
          value={metric ?? ""}
          onChange={(event) => {
            const next = event.target.value as TerminalAlertMetric;
            setSelectedMetric(next);
            setThreshold("");
          }}
          className="trade-field h-8 min-w-0 rounded px-2 text-[9px] text-[#dce6f4] outline-none"
        >
          {availableMetrics.map((item) => <option key={item} value={item}>{terminalAlertMetricLabel(item)}</option>)}
        </select>
        <label className="sr-only" htmlFor="terminal-alert-operator">Operator</label>
        <select id="terminal-alert-operator" value={operator} onChange={(event) => setOperator(event.target.value as TerminalAlertOperator)} className="trade-field h-8 rounded px-2 text-[9px] text-[#dce6f4] outline-none">
          <option value="above">Above</option>
          <option value="below">Below</option>
        </select>
        <label className="sr-only" htmlFor="terminal-alert-threshold">Threshold</label>
        <input
          id="terminal-alert-threshold"
          type="number"
          value={threshold}
          step={metric ? metricStep(metric, thresholdValue) : 1}
          onChange={(event) => setThreshold(event.target.value)}
          placeholder={currentValue != null && Number.isFinite(currentValue) ? String(currentValue) : "Threshold"}
          className="trade-field h-8 rounded px-2 text-right font-mono text-[9px] tabular-nums text-[#dce6f4] outline-none"
        />
        <button
          type="button"
          disabled={!validThreshold}
          onClick={() => {
            if (metric && onCreate(metric, operator, thresholdValue)) setThreshold("");
          }}
          className="term-chip h-8 px-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add alert
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[8px] leading-3 text-[#66738c]">
        <span>{metric && currentValue != null && Number.isFinite(currentValue) ? `Current ${formatAlertValue(metric, currentValue)}` : "Only currently certified metrics are offered"}</span>
        <span className="shrink-0 font-mono">{customCount}/{TERMINAL_CUSTOM_ALERT_LIMIT}</span>
      </div>
    </fieldset>
  );
}

function PlanAlertButton({
  kind,
  decision,
  exists,
  ready,
  onArm,
}: {
  kind: TerminalPlanAlertKind;
  decision: ReturnType<typeof deriveTerminalPlanLevelAlert>;
  exists: boolean;
  ready: boolean;
  onArm: (decision: ReturnType<typeof deriveTerminalPlanLevelAlert>) => void;
}) {
  const disabled = !ready || decision.rule == null;
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? planAlertBlockerLabel(decision.blocker) : `${decision.rule!.label} at ${formatAlertValue("price", decision.rule!.threshold)}`}
      onClick={() => onArm(decision)}
      className="term-chip h-8 px-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {exists ? "Update" : "Arm"} {kind}
    </button>
  );
}

function planAlertBlockerLabel(blocker: ReturnType<typeof deriveTerminalPlanLevelAlert>["blocker"]) {
  if (blocker === "reference_unavailable") return "A certified reference price is required.";
  if (blocker === "level_invalid") return "Set a positive staged level first.";
  if (blocker === "direction_ambiguous") return "Move the staged level away from the current reference price.";
  return "Alert storage is still loading.";
}

function savedPlanWatchBlockerLabel(blocker: ReturnType<typeof deriveTerminalSavedPlanAlertRules>["blocker"]) {
  if (blocker === "reference_unavailable") return "Saved-plan watch blocked: a certified current instrument price is required";
  if (blocker === "level_invalid") return "Saved-plan watch blocked: one or more saved levels are invalid";
  if (blocker === "direction_ambiguous") return "Saved-plan watch blocked: a saved level equals the current reference price";
  return "Saved-plan watch blocked: the saved request failed validation";
}

export function terminalAlertStatesForEvaluationIdentity(
  previousIdentityKey: string | null,
  nextIdentityKey: string | null,
  states: Record<string, TerminalAlertRuleState>,
): Record<string, TerminalAlertRuleState> {
  return previousIdentityKey === nextIdentityKey ? states : {};
}

function feedStatusTone(status: TerminalCertifiedSignalSurface["status"]) {
  if (status === "ready") return "bg-emerald-300/[0.03] text-emerald-200";
  if (status === "degraded") return "bg-amber-300/[0.04] text-amber-100";
  return "bg-rose-300/[0.03] text-rose-200";
}

function notificationStatus(permission: NotificationPermissionState, enabled: boolean) {
  if (permission === "unsupported") return "Unavailable in this browser";
  if (permission === "denied") return "Blocked in browser settings";
  if (permission === "default") return "Off · permission requested only when you enable it";
  return enabled ? "On for this instrument" : "Permission granted · off for this instrument";
}

function AlertRuleRow({
  rule,
  available,
  onChange,
  onRemove,
}: {
  rule: TerminalAlertRule;
  available: boolean;
  onChange: (rule: TerminalAlertRule) => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`grid items-center gap-2 rounded border border-[#141d2e] bg-[#080c13] px-2 py-1.5 ${onRemove ? "grid-cols-[minmax(0,1fr)_5.25rem_2.5rem_auto]" : "grid-cols-[minmax(0,1fr)_5.25rem_2.5rem]"}`}>
      <label className="flex min-w-0 items-center gap-2 text-[10px] text-[#aeb9cb]">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(event) => onChange({ ...rule, enabled: event.target.checked })}
          className="h-3 w-3 accent-sky-400"
        />
        <span className="min-w-0 truncate">{rule.label}</span>
        {!available ? <span className="shrink-0 font-mono text-[8px] uppercase text-amber-200/70">paused</span> : null}
      </label>
      <input
        aria-label={`${rule.label} threshold`}
        type="number"
        value={rule.threshold}
        step={alertStep(rule)}
        onChange={(event) => {
          const threshold = Number(event.target.value);
          if (Number.isFinite(threshold)) onChange({ ...rule, threshold });
        }}
        className="trade-field h-7 w-full rounded px-1.5 text-right font-mono text-[10px] tabular-nums text-[#dce6f4] outline-none"
      />
      <span className="text-right font-mono text-[9px] uppercase text-[#8b95a8]">{alertUnit(rule.metric)}</span>
      {onRemove ? <button type="button" onClick={onRemove} aria-label={`Delete ${rule.label}`} className="rounded px-1 text-[11px] text-[#7f8da7] hover:text-rose-200">×</button> : null}
    </div>
  );
}

function alertStep(rule: TerminalAlertRule) {
  return metricStep(rule.metric, rule.threshold);
}

function metricStep(metric: TerminalAlertMetric, threshold: number) {
  if (metric === "market_age_ms" || metric === "book_age_ms" || metric === "trades_age_ms" || metric === "candles_age_ms") return 1_000;
  if (metric === "receipt_latency_ms") return 100;
  if (metric === "price") return Math.max(0.01, Math.abs(threshold) / 1_000);
  if (metric === "funding_rate_bps") return 0.1;
  return 1;
}

function alertUnit(metric: TerminalAlertRule["metric"]) {
  if (metric === "price") return "px";
  if (metric === "book_imbalance_pct") return "%";
  if (metric === "market_age_ms" || metric === "book_age_ms" || metric === "trades_age_ms" || metric === "candles_age_ms" || metric === "receipt_latency_ms") return "ms";
  if (metric === "feed_health_score") return "score";
  return "bp";
}

function formatAlertValue(metric: TerminalAlertRule["metric"], value: number) {
  if (metric === "price") return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (metric === "market_age_ms" || metric === "book_age_ms" || metric === "trades_age_ms" || metric === "candles_age_ms" || metric === "receipt_latency_ms") return `${(value / 1_000).toFixed(1)}s`;
  if (metric === "feed_health_score") return `${Math.round(value)}/100`;
  if (metric === "book_imbalance_pct") return `${value.toFixed(1)}%`;
  return `${value.toFixed(1)} bp`;
}

function formatAlertCrossing(event: TerminalAlertEvent) {
  return `${formatAlertValue(event.metric, event.observed)} ${event.operator === "above" ? "≥" : "≤"} ${formatAlertValue(event.metric, event.threshold)}`;
}

function createCustomAlertId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `custom-${crypto.randomUUID().replaceAll("-", "")}`;
  }
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
