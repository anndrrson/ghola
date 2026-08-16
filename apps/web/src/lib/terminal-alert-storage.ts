import type {
  TerminalAlertEvent,
  TerminalAlertMetric,
  TerminalAlertOperator,
  TerminalAlertRule,
} from "./terminal-alerts";
import { TERMINAL_ALERT_METRICS } from "./terminal-alerts";

export const TERMINAL_ALERT_STORAGE_VERSION = 5 as const;
export const TERMINAL_ALERT_LEGACY_STORAGE_KEY = "ghola.terminal-alerts";
export const TERMINAL_ALERT_STORAGE_PREFIX = "ghola.terminal-alerts.v5:";
export const TERMINAL_ALERT_GUEST_SCOPE = "device_guest";
export const TERMINAL_ALERT_STORAGE_KEY = `${TERMINAL_ALERT_STORAGE_PREFIX}${TERMINAL_ALERT_GUEST_SCOPE}`;
export const TERMINAL_ALERT_HISTORY_LIMIT = 40;
export const TERMINAL_ALERT_RULE_LIMIT = 32;
const TERMINAL_ALERT_RULE_TOMBSTONE_LIMIT = 64;
const TERMINAL_ALERT_INSTRUMENT_LIMIT = 32;
const MAX_NUMBER = 1_000_000_000_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const ALERT_PERSISTENCE_SCOPE = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export interface StoredTerminalAlerts {
  rules: TerminalAlertRule[];
  ruleUpdatedAt: Record<string, RuleFieldRevisions>;
  deletedRuleIds: Record<string, number>;
  events: TerminalAlertEvent[];
  historyClearedAt: number;
  browserNotifications: boolean;
  notificationsUpdatedAt: number;
  updatedAt: number;
}

export interface TerminalAlertStorage {
  version: typeof TERMINAL_ALERT_STORAGE_VERSION;
  clearedAt: number;
  instruments: Record<string, StoredTerminalAlerts>;
}

export type TerminalAlertStorageInspection =
  | { status: "absent"; storage: TerminalAlertStorage; raw: null }
  | { status: "ready"; storage: TerminalAlertStorage; raw: string }
  | { status: "blocked"; storage: null; raw: string };

interface TerminalAlertClientState {
  rules: TerminalAlertRule[];
  events: TerminalAlertEvent[];
  browserNotifications: boolean;
}

const RULE_FIELDS = ["label", "metric", "operator", "threshold", "enabled", "cooldownMs", "rearmDelta"] as const;
type RuleField = (typeof RULE_FIELDS)[number];
type RuleFieldRevisions = Record<RuleField, number>;

export function emptyTerminalAlertStorage(): TerminalAlertStorage {
  return { version: TERMINAL_ALERT_STORAGE_VERSION, clearedAt: 0, instruments: {} };
}

export function clearTerminalAlertStorage(nowMs: number = Date.now()): TerminalAlertStorage {
  const clearedAt = validTime(nowMs);
  if (clearedAt == null) throw new Error("terminal_alert_clear_time_invalid");
  return { version: TERMINAL_ALERT_STORAGE_VERSION, clearedAt, instruments: {} };
}

export function terminalAlertStorageKey(persistenceScope: string | null | undefined): string | null {
  return typeof persistenceScope === "string" && ALERT_PERSISTENCE_SCOPE.test(persistenceScope)
    ? `${TERMINAL_ALERT_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export function terminalAlertStorageViewReady(input: {
  storageKey: string | null;
  hydratedStorageKey: string | null;
  instrumentScope: string | null;
  hydratedInstrumentScope: string | null;
}) {
  return input.storageKey != null
    && input.storageKey === input.hydratedStorageKey
    && input.instrumentScope != null
    && input.instrumentScope === input.hydratedInstrumentScope;
}

export function terminalAlertInstrumentScope(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/gu, "");
  const match = /^([A-Z0-9]{2,16})(?:[-/](?:USD|USDC|USDT|PERP))?$/u.exec(normalized);
  return match?.[1] ?? null;
}

export function parseTerminalAlertStorage(value: string | null | undefined): TerminalAlertStorage {
  return inspectTerminalAlertStorage(value).storage ?? emptyTerminalAlertStorage();
}

export function inspectTerminalAlertStorage(value: string | null | undefined): TerminalAlertStorageInspection {
  if (!value) return { status: "absent", storage: emptyTerminalAlertStorage(), raw: null };
  try {
    const storage = validateStorage(JSON.parse(value));
    return storage ? { status: "ready", storage, raw: value } : { status: "blocked", storage: null, raw: value };
  } catch {
    return { status: "blocked", storage: null, raw: value };
  }
}

export function serializeTerminalAlertStorage(value: TerminalAlertStorage): string {
  const valid = validateStorage(value);
  if (!valid) throw new Error("terminal_alert_storage_invalid");
  return JSON.stringify(valid);
}

export function terminalAlertStoragesEqual(left: TerminalAlertStorage, right: TerminalAlertStorage) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeTerminalAlertStorage(
  left: TerminalAlertStorage,
  right: TerminalAlertStorage,
): TerminalAlertStorage {
  const validLeft = validateStorage(left);
  const validRight = validateStorage(right);
  if (!validLeft || !validRight) throw new Error("terminal_alert_storage_invalid");
  if (validLeft.clearedAt > validRight.clearedAt) return cloneStorage(validLeft);
  if (validRight.clearedAt > validLeft.clearedAt) return cloneStorage(validRight);
  const scopes = new Set([...Object.keys(validLeft.instruments), ...Object.keys(validRight.instruments)]);
  const instruments: Record<string, StoredTerminalAlerts> = {};
  for (const scope of scopes) {
    const leftEntry = validLeft.instruments[scope];
    const rightEntry = validRight.instruments[scope];
    instruments[scope] = leftEntry && rightEntry
      ? mergeStoredAlerts(leftEntry, rightEntry)
      : cloneStoredAlerts(leftEntry ?? rightEntry!);
  }
  return boundedStorage(instruments, validLeft.clearedAt);
}

export function terminalAlertsForInstrument(
  storage: TerminalAlertStorage,
  instrument: string,
): StoredTerminalAlerts | null {
  const scope = terminalAlertInstrumentScope(instrument);
  return scope ? storage.instruments[scope] ?? null : null;
}

export function updateTerminalAlertsForInstrument(
  storage: TerminalAlertStorage,
  instrument: string,
  value: TerminalAlertClientState,
  nowMs: number = Date.now(),
): TerminalAlertStorage {
  const validStorage = validateStorage(storage);
  const scope = terminalAlertInstrumentScope(instrument);
  const requestedNow = validTime(nowMs);
  const client = validateClientState(value);
  if (!validStorage || !scope || requestedNow == null) throw new Error("terminal_alert_scope_invalid");
  if (!client) throw new Error("terminal_alert_state_invalid");
  const now = Math.max(requestedNow, validStorage.clearedAt + 1);
  if (!Number.isSafeInteger(now)) throw new Error("terminal_alert_revision_exhausted");
  const current = validStorage.instruments[scope] ?? emptyStoredAlerts();
  const currentRules = new Map(current.rules.map((rule) => [rule.id, rule]));
  const incomingIds = new Set(client.rules.map((rule) => rule.id));
  const deletedRuleIds = { ...current.deletedRuleIds };
  const ruleUpdatedAt: Record<string, RuleFieldRevisions> = {};
  for (const rule of client.rules) {
    const previous = currentRules.get(rule.id);
    const previousRevisions = current.ruleUpdatedAt[rule.id];
    const deletedRevision = deletedRuleIds[rule.id] ?? 0;
    ruleUpdatedAt[rule.id] = Object.fromEntries(RULE_FIELDS.map((field) => {
      const previousRevision = previousRevisions?.[field] ?? 0;
      const unchanged = previous && fieldFingerprint(previous[field]) === fieldFingerprint(rule[field]);
      return [field, unchanged
        ? previousRevision
        : Math.max(now, previousRevision + 1, deletedRevision + 1)];
    })) as RuleFieldRevisions;
    if (minRuleRevision(ruleUpdatedAt[rule.id]) > deletedRevision) delete deletedRuleIds[rule.id];
  }
  for (const rule of current.rules) {
    if (!incomingIds.has(rule.id)) {
      deletedRuleIds[rule.id] = Math.max(now, maxRuleRevision(current.ruleUpdatedAt[rule.id]) + 1, deletedRuleIds[rule.id] ?? 0);
    }
  }
  const explicitHistoryClear = current.events.length > 0 && client.events.length === 0;
  const historyClearedAt = explicitHistoryClear
    ? Math.max(now, current.historyClearedAt, ...current.events.map((event) => event.triggeredAt + 1))
    : current.historyClearedAt;
  const events = explicitHistoryClear
    ? []
    : mergeEvents(current.events, client.events, historyClearedAt);
  const notificationsUpdatedAt = client.browserNotifications === current.browserNotifications
    ? current.notificationsUpdatedAt
    : Math.max(now, current.notificationsUpdatedAt + 1);
  const entry = normalizeStoredAlerts({
    rules: client.rules,
    ruleUpdatedAt,
    deletedRuleIds,
    events,
    historyClearedAt,
    browserNotifications: client.browserNotifications,
    notificationsUpdatedAt,
    updatedAt: Math.max(now, historyClearedAt, notificationsUpdatedAt, ...ruleRevisionValues(ruleUpdatedAt), ...Object.values(deletedRuleIds)),
  });
  if (!entry) throw new Error("terminal_alert_state_invalid");
  return boundedStorage({ ...validStorage.instruments, [scope]: entry }, validStorage.clearedAt);
}

function validateStorage(value: unknown): TerminalAlertStorage | null {
  const row = record(value);
  if (!row) return null;
  if (row.version === 1) return migrateV1(row);
  if (row.version === 2 || row.version === 3) return migrateLegacyInstruments(row);
  if (row.version === 4) return migrateV4(row);
  if (row.version !== TERMINAL_ALERT_STORAGE_VERSION) return null;
  const clearedAt = validTime(row.clearedAt);
  const rawInstruments = record(row.instruments);
  if (clearedAt == null || !rawInstruments) return null;
  const instruments: Record<string, StoredTerminalAlerts> = {};
  for (const [rawScope, rawValue] of Object.entries(rawInstruments)) {
    const scope = terminalAlertInstrumentScope(rawScope);
    const entry = normalizeStoredAlerts(rawValue);
    if (!scope || scope !== rawScope || !entry || (clearedAt > 0 && entry.updatedAt <= clearedAt) || instruments[scope]) return null;
    instruments[scope] = entry;
  }
  return boundedStorage(instruments, clearedAt);
}

function migrateV4(row: Record<string, unknown>): TerminalAlertStorage | null {
  const rawInstruments = record(row.instruments);
  if (!rawInstruments) return null;
  const instruments: Record<string, StoredTerminalAlerts> = {};
  for (const [rawScope, rawValue] of Object.entries(rawInstruments)) {
    const scope = terminalAlertInstrumentScope(rawScope);
    const entry = normalizeStoredAlerts(rawValue);
    if (!scope || scope !== rawScope || !entry || instruments[scope]) return null;
    instruments[scope] = entry;
  }
  return boundedStorage(instruments, 0);
}

function migrateV1(row: Record<string, unknown>): TerminalAlertStorage | null {
  const scope = terminalAlertInstrumentScope(typeof row.instrument === "string" ? row.instrument : null);
  const entry = migrateLegacyEntry({
    rules: row.rules,
    events: row.events,
    browserNotifications: false,
    updatedAt: row.updatedAt ?? 0,
  });
  return scope && entry ? boundedStorage({ [scope]: entry }, 0) : null;
}

function migrateLegacyInstruments(row: Record<string, unknown>): TerminalAlertStorage | null {
  const rawInstruments = record(row.instruments);
  if (!rawInstruments) return null;
  const instruments: Record<string, StoredTerminalAlerts> = {};
  for (const [rawScope, rawValue] of Object.entries(rawInstruments)) {
    const scope = terminalAlertInstrumentScope(rawScope);
    const entry = migrateLegacyEntry(rawValue);
    if (!scope || scope !== rawScope || !entry || instruments[scope]) continue;
    instruments[scope] = entry;
  }
  return boundedStorage(instruments, 0);
}

function migrateLegacyEntry(value: unknown): StoredTerminalAlerts | null {
  const row = record(value);
  if (!row || !Array.isArray(row.rules) || !Array.isArray(row.events)) return null;
  const rules = uniqueById(row.rules.flatMap((rule) => {
    const valid = validateRule(rule);
    return valid ? [valid] : [];
  })).slice(0, TERMINAL_ALERT_RULE_LIMIT);
  const events = uniqueById(row.events.flatMap((event) => {
    const valid = validateEvent(event);
    return valid ? [valid] : [];
  })).slice(0, TERMINAL_ALERT_HISTORY_LIMIT);
  const updatedAt = validTime(row.updatedAt);
  if (updatedAt == null || typeof row.browserNotifications !== "boolean") return null;
  return normalizeStoredAlerts({
    rules,
    ruleUpdatedAt: Object.fromEntries(rules.map((rule) => [rule.id, uniformRuleRevisions(updatedAt)])),
    deletedRuleIds: {},
    events,
    historyClearedAt: 0,
    browserNotifications: row.browserNotifications,
    notificationsUpdatedAt: updatedAt,
    updatedAt,
  });
}

function normalizeStoredAlerts(value: unknown): StoredTerminalAlerts | null {
  const row = record(value);
  if (!row || !Array.isArray(row.rules) || !Array.isArray(row.events)) return null;
  const rules = row.rules.map(validateRule);
  const events = row.events.map(validateEvent);
  if (rules.some((rule) => rule == null) || events.some((event) => event == null)) return null;
  const uniqueRules = uniqueById(rules as TerminalAlertRule[]);
  const uniqueEvents = uniqueById(events as TerminalAlertEvent[]);
  if (uniqueRules.length !== rules.length || uniqueEvents.length !== events.length || uniqueRules.length > TERMINAL_ALERT_RULE_LIMIT || uniqueEvents.length > TERMINAL_ALERT_HISTORY_LIMIT) return null;
  const ruleUpdatedAt = ruleRevisionMap(row.ruleUpdatedAt);
  const deletedRuleIds = revisionMap(row.deletedRuleIds, TERMINAL_ALERT_RULE_TOMBSTONE_LIMIT);
  const historyClearedAt = validTime(row.historyClearedAt);
  const notificationsUpdatedAt = validTime(row.notificationsUpdatedAt);
  const updatedAt = validTime(row.updatedAt);
  if (!ruleUpdatedAt || !deletedRuleIds || historyClearedAt == null || notificationsUpdatedAt == null || updatedAt == null || typeof row.browserNotifications !== "boolean") return null;
  if (uniqueRules.some((rule) => {
    const revisions = ruleUpdatedAt[rule.id];
    return revisions == null
      || RULE_FIELDS.some((field) => revisions[field] > updatedAt)
      || (deletedRuleIds[rule.id] ?? -1) >= minRuleRevision(revisions);
  })) return null;
  if (Object.keys(ruleUpdatedAt).some((id) => !uniqueRules.some((rule) => rule.id === id))) return null;
  if (Object.values(deletedRuleIds).some((revision) => revision > updatedAt) || historyClearedAt > updatedAt || notificationsUpdatedAt > updatedAt) return null;
  if (historyClearedAt > 0 && uniqueEvents.some((event) => event.triggeredAt <= historyClearedAt)) return null;
  return {
    rules: uniqueRules.map((rule) => ({ ...rule })),
    ruleUpdatedAt: { ...ruleUpdatedAt },
    deletedRuleIds: boundedRevisionMap(deletedRuleIds, TERMINAL_ALERT_RULE_TOMBSTONE_LIMIT),
    events: uniqueEvents.map((event) => ({ ...event })).sort((a, b) => b.triggeredAt - a.triggeredAt || a.id.localeCompare(b.id)),
    historyClearedAt,
    browserNotifications: row.browserNotifications,
    notificationsUpdatedAt,
    updatedAt,
  };
}

function mergeStoredAlerts(left: StoredTerminalAlerts, right: StoredTerminalAlerts): StoredTerminalAlerts {
  const deletedRuleIds = mergeRevisionMaps(left.deletedRuleIds, right.deletedRuleIds);
  const leftRules = new Map(left.rules.map((rule) => [rule.id, rule]));
  const rightRules = new Map(right.rules.map((rule) => [rule.id, rule]));
  const ruleIds = new Set([...leftRules.keys(), ...rightRules.keys()]);
  const rules: TerminalAlertRule[] = [];
  const ruleUpdatedAt: Record<string, RuleFieldRevisions> = {};
  for (const id of ruleIds) {
    const leftRule = leftRules.get(id);
    const rightRule = rightRules.get(id);
    const leftRevisions = left.ruleUpdatedAt[id];
    const rightRevisions = right.ruleUpdatedAt[id];
    const fallback = leftRule ?? rightRule!;
    const mergedRevisions = {} as RuleFieldRevisions;
    for (const field of RULE_FIELDS) {
      mergedRevisions[field] = Math.max(leftRevisions?.[field] ?? -1, rightRevisions?.[field] ?? -1);
    }
    if ((deletedRuleIds[id] ?? -1) >= minRuleRevision(mergedRevisions)) continue;
    rules.push({
      id,
      label: mergedRuleField("label", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      metric: mergedRuleField("metric", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      operator: mergedRuleField("operator", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      threshold: mergedRuleField("threshold", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      enabled: mergedRuleField("enabled", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      cooldownMs: mergedRuleField("cooldownMs", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
      rearmDelta: mergedRuleField("rearmDelta", leftRule, rightRule, fallback, leftRevisions, rightRevisions),
    });
    ruleUpdatedAt[id] = mergedRevisions;
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));
  const historyClearedAt = Math.max(left.historyClearedAt, right.historyClearedAt);
  const notificationsFromRight = right.notificationsUpdatedAt > left.notificationsUpdatedAt
    || (right.notificationsUpdatedAt === left.notificationsUpdatedAt && left.browserNotifications && !right.browserNotifications);
  const notificationsUpdatedAt = Math.max(left.notificationsUpdatedAt, right.notificationsUpdatedAt);
  const entry = normalizeStoredAlerts({
    rules,
    ruleUpdatedAt,
    deletedRuleIds,
    events: mergeEvents(left.events, right.events, historyClearedAt),
    historyClearedAt,
    browserNotifications: notificationsFromRight ? right.browserNotifications : left.browserNotifications,
    notificationsUpdatedAt,
    updatedAt: Math.max(left.updatedAt, right.updatedAt, historyClearedAt, notificationsUpdatedAt, ...ruleRevisionValues(ruleUpdatedAt), ...Object.values(deletedRuleIds)),
  });
  if (!entry) throw new Error("terminal_alert_storage_invalid");
  return entry;
}

function mergedRuleField<K extends RuleField>(
  field: K,
  leftRule: TerminalAlertRule | undefined,
  rightRule: TerminalAlertRule | undefined,
  fallback: TerminalAlertRule,
  leftRevisions: RuleFieldRevisions | undefined,
  rightRevisions: RuleFieldRevisions | undefined,
): TerminalAlertRule[K] {
  const leftRevision = leftRevisions?.[field] ?? -1;
  const rightRevision = rightRevisions?.[field] ?? -1;
  const useRight = rightRevision > leftRevision
    || (rightRevision === leftRevision && rightRule != null && leftRule != null && fieldFingerprint(rightRule[field]) > fieldFingerprint(leftRule[field]));
  return (useRight ? rightRule?.[field] : leftRule?.[field]) ?? fallback[field];
}

function mergeEvents(
  left: readonly TerminalAlertEvent[],
  right: readonly TerminalAlertEvent[],
  historyClearedAt: number,
) {
  const byId = new Map<string, TerminalAlertEvent>();
  for (const event of [...left, ...right]) {
    if (historyClearedAt > 0 && event.triggeredAt <= historyClearedAt) continue;
    const current = byId.get(event.id);
    if (!current || eventWinner(event, current)) byId.set(event.id, { ...event });
  }
  return [...byId.values()]
    .sort((a, b) => b.triggeredAt - a.triggeredAt || a.id.localeCompare(b.id))
    .slice(0, TERMINAL_ALERT_HISTORY_LIMIT);
}

function eventWinner(left: TerminalAlertEvent, right: TerminalAlertEvent) {
  const leftAck = left.acknowledgedAt ?? -1;
  const rightAck = right.acknowledgedAt ?? -1;
  return leftAck > rightAck || (leftAck === rightAck && JSON.stringify(left) > JSON.stringify(right));
}

function validateClientState(value: unknown): TerminalAlertClientState | null {
  const row = record(value);
  if (!row || !Array.isArray(row.rules) || !Array.isArray(row.events) || typeof row.browserNotifications !== "boolean") return null;
  const rules = row.rules.map(validateRule);
  const events = row.events.map(validateEvent);
  if (rules.some((rule) => rule == null) || events.some((event) => event == null)) return null;
  const uniqueRules = uniqueById(rules as TerminalAlertRule[]);
  const uniqueEvents = uniqueById(events as TerminalAlertEvent[]);
  if (uniqueRules.length !== rules.length || uniqueEvents.length !== events.length || uniqueRules.length > TERMINAL_ALERT_RULE_LIMIT || uniqueEvents.length > TERMINAL_ALERT_HISTORY_LIMIT) return null;
  return { rules: uniqueRules, events: uniqueEvents, browserNotifications: row.browserNotifications };
}

function emptyStoredAlerts(): StoredTerminalAlerts {
  return {
    rules: [],
    ruleUpdatedAt: {},
    deletedRuleIds: {},
    events: [],
    historyClearedAt: 0,
    browserNotifications: false,
    notificationsUpdatedAt: 0,
    updatedAt: 0,
  };
}

function boundedStorage(instruments: Record<string, StoredTerminalAlerts>, clearedAt: number): TerminalAlertStorage {
  return {
    version: TERMINAL_ALERT_STORAGE_VERSION,
    clearedAt,
    instruments: Object.fromEntries(
      Object.entries(instruments)
        .filter(([, entry]) => clearedAt === 0 || entry.updatedAt > clearedAt)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, TERMINAL_ALERT_INSTRUMENT_LIMIT)
        .map(([scope, entry]) => [scope, cloneStoredAlerts(entry)]),
    ),
  };
}

function cloneStorage(storage: TerminalAlertStorage): TerminalAlertStorage {
  return boundedStorage(storage.instruments, storage.clearedAt);
}

function cloneStoredAlerts(entry: StoredTerminalAlerts): StoredTerminalAlerts {
  return {
    ...entry,
    rules: entry.rules.map((rule) => ({ ...rule })),
    ruleUpdatedAt: Object.fromEntries(Object.entries(entry.ruleUpdatedAt).map(([id, revisions]) => [id, { ...revisions }])),
    deletedRuleIds: { ...entry.deletedRuleIds },
    events: entry.events.map((event) => ({ ...event })),
  };
}

function ruleRevisionMap(value: unknown): Record<string, RuleFieldRevisions> | null {
  const row = record(value);
  if (!row || Object.keys(row).length > TERMINAL_ALERT_RULE_LIMIT) return null;
  const output: Record<string, RuleFieldRevisions> = {};
  for (const [id, rawRevisions] of Object.entries(row)) {
    if (!identifier(id, 96)) return null;
    const revisions = record(rawRevisions);
    if (!revisions || Object.keys(revisions).length !== RULE_FIELDS.length || Object.keys(revisions).some((field) => !RULE_FIELDS.includes(field as RuleField))) return null;
    const normalized = {} as RuleFieldRevisions;
    for (const field of RULE_FIELDS) {
      const revision = validTime(revisions[field]);
      if (revision == null) return null;
      normalized[field] = revision;
    }
    output[id] = normalized;
  }
  return output;
}

function revisionMap(value: unknown, limit: number): Record<string, number> | null {
  const row = record(value);
  if (!row || Object.keys(row).length > limit) return null;
  const output: Record<string, number> = {};
  for (const [id, revision] of Object.entries(row)) {
    const validId = identifier(id, 96);
    const validRevision = validTime(revision);
    if (!validId || validRevision == null) return null;
    output[validId] = validRevision;
  }
  return output;
}

function mergeRevisionMaps(left: Record<string, number>, right: Record<string, number>) {
  const merged = { ...left };
  for (const [id, revision] of Object.entries(right)) merged[id] = Math.max(merged[id] ?? 0, revision);
  return boundedRevisionMap(merged, TERMINAL_ALERT_RULE_TOMBSTONE_LIMIT);
}

function boundedRevisionMap(value: Record<string, number>, limit: number) {
  return Object.fromEntries(Object.entries(value).sort(([, a], [, b]) => b - a).slice(0, limit));
}

function validateRule(value: unknown): TerminalAlertRule | null {
  const row = record(value);
  if (!row) return null;
  const id = identifier(row.id, 96);
  const label = text(row.label, 120);
  const metric = alertMetric(row.metric);
  const operator = alertOperator(row.operator);
  const threshold = boundedNumber(row.threshold);
  const cooldownMs = boundedNumber(row.cooldownMs, 0, MAX_COOLDOWN_MS);
  const rearmDelta = boundedNumber(row.rearmDelta, 0);
  if (!id || !label || !metric || !operator || threshold == null || cooldownMs == null || rearmDelta == null || typeof row.enabled !== "boolean") return null;
  if (metric === "price" && threshold <= 0) return null;
  return { id, label, metric, operator, threshold, enabled: row.enabled, cooldownMs, rearmDelta };
}

function validateEvent(value: unknown): TerminalAlertEvent | null {
  const row = record(value);
  if (!row) return null;
  const id = identifier(row.id, 160);
  const ruleId = identifier(row.ruleId, 96);
  const label = text(row.label, 120);
  const metric = alertMetric(row.metric);
  const operator = alertOperator(row.operator);
  const threshold = boundedNumber(row.threshold);
  const observed = boundedNumber(row.observed);
  const triggeredAt = validTime(row.triggeredAt);
  const acknowledgedAt = row.acknowledgedAt == null ? null : validTime(row.acknowledgedAt);
  if (!id || !ruleId || !label || !metric || !operator || threshold == null || observed == null || triggeredAt == null || (row.acknowledgedAt != null && acknowledgedAt == null)) return null;
  return { id, ruleId, label, metric, operator, threshold, observed, triggeredAt, acknowledgedAt };
}

function alertMetric(value: unknown): TerminalAlertMetric | null {
  return TERMINAL_ALERT_METRICS.includes(value as TerminalAlertMetric)
    ? value as TerminalAlertMetric
    : null;
}

function alertOperator(value: unknown): TerminalAlertOperator | null {
  return value === "above" || value === "below" ? value : null;
}

function fieldFingerprint(value: TerminalAlertRule[RuleField]) {
  return JSON.stringify(value);
}

function uniformRuleRevisions(revision: number): RuleFieldRevisions {
  return Object.fromEntries(RULE_FIELDS.map((field) => [field, revision])) as RuleFieldRevisions;
}

function maxRuleRevision(revisions: RuleFieldRevisions | undefined) {
  return revisions ? Math.max(...RULE_FIELDS.map((field) => revisions[field])) : 0;
}

function minRuleRevision(revisions: RuleFieldRevisions) {
  return Math.min(...RULE_FIELDS.map((field) => revisions[field]));
}

function ruleRevisionValues(value: Record<string, RuleFieldRevisions>) {
  return Object.values(value).flatMap((revisions) => RULE_FIELDS.map((field) => revisions[field]));
}

function identifier(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= limit && /^[a-zA-Z0-9:_-]+$/u.test(value) ? value : null;
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : null;
}

function boundedNumber(value: unknown, minimum = -MAX_NUMBER, maximum = MAX_NUMBER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function validTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}
