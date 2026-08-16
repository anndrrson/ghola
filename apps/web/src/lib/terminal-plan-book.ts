import { terminalRewardTargetPrice, type TerminalRewardMultiple } from "./terminal-reward-ladder";

export const TERMINAL_PLAN_BOOK_VERSION = 1 as const;
export const TERMINAL_PLAN_BOOK_STORAGE_PREFIX = "ghola.terminal-plan-book.v1:";
export const TERMINAL_PLAN_BOOK_LIMIT = 24;
export const TERMINAL_PLAN_BOOK_IDENTITY_LIMIT = 6;
export const TERMINAL_PLAN_BOOK_NAME_LIMIT = 32;
export const TERMINAL_PLAN_BOOK_THESIS_LIMIT = 240;
export const TERMINAL_PLAN_BOOK_INVALIDATION_NOTE_LIMIT = 160;
const TERMINAL_PLAN_BOOK_TOMBSTONE_LIMIT = 48;
const FUTURE_TOLERANCE_MS = 300_000;
const RESTORE_FRESH_AGE_MS = 60 * 60_000;
const RESTORE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const RESTORE_FRESH_DRIFT_BPS = 100;
const RESTORE_MAX_DRIFT_BPS = 5_000;
const PERSISTENCE_SCOPE_PATTERN = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export interface TerminalPlanBookIdentity {
  venue: "hyperliquid" | "phoenix" | "coinbase";
  network: "mainnet" | "testnet";
  product: string;
  interval: "1m" | "5m" | "15m" | "1h";
}

export type TerminalPlanSetup = "breakout" | "pullback" | "reversal" | "range" | "event" | "other";

export interface TerminalPlanDecisionContext {
  setup: TerminalPlanSetup;
  thesis: string;
  invalidationNote: string;
}

export interface TerminalPlanSnapshot {
  id: string;
  name: string;
  identity: TerminalPlanBookIdentity;
  side: "buy" | "sell";
  entryPrice: number;
  invalidationPrice: number;
  targetRewardMultiple: TerminalRewardMultiple;
  notionalUsd: number;
  riskBudgetUsd: number;
  slippageBps: 25 | 50 | 100;
  certifiedReferencePrice: number;
  /** Null only for snapshots written before decision context existed. */
  setup: TerminalPlanSetup | null;
  thesis: string | null;
  invalidationNote: string | null;
  savedAt: number;
}

export type TerminalPlanDraft = Omit<TerminalPlanSnapshot, "id" | "name" | "setup" | "thesis" | "invalidationNote" | "savedAt">;

export interface TerminalPlanBookTombstone {
  id: string;
  identityKey: string;
  nameKey: string;
  deletedAt: number;
}

export interface TerminalPlanBookStore {
  version: typeof TERMINAL_PLAN_BOOK_VERSION;
  plans: TerminalPlanSnapshot[];
  tombstones: TerminalPlanBookTombstone[];
  clearedAt: number;
}

export interface TerminalPlanEconomics {
  targetPrice: number;
  stopDistanceBps: number;
  totalRiskBps: number;
  modeledLossUsd: number;
  targetProfitUsd: number;
  budgetUtilizationPct: number;
  netRewardRisk: number;
  withinBudget: boolean;
}

export type TerminalPlanBookInspection =
  | { status: "absent"; store: TerminalPlanBookStore; raw: null }
  | { status: "ready"; store: TerminalPlanBookStore; raw: string }
  | { status: "blocked"; store: null; raw: string };

export type TerminalPlanRestoreDecision =
  | { status: "ready" | "confirm"; blocker: null; ageMs: number; driftBps: number; targetPrice: number }
  | { status: "blocked"; blocker: "identity_mismatch" | "reference_unavailable" | "snapshot_future" | "snapshot_expired" | "market_drift_excessive" | "plan_invalid"; ageMs: number | null; driftBps: number | null; targetPrice: number | null };

export function terminalPlanBookStorageKey(scope: string | null | undefined) {
  return typeof scope === "string" && PERSISTENCE_SCOPE_PATTERN.test(scope)
    ? `${TERMINAL_PLAN_BOOK_STORAGE_PREFIX}${scope}`
    : null;
}

export function terminalPlanBookClockNow() {
  return Date.now();
}

export function terminalPlanBookIdentityKey(identity: TerminalPlanBookIdentity): string | null {
  const valid = validIdentity(identity);
  return valid ? `${valid.venue}:${valid.network}:${valid.product}:${valid.interval}` : null;
}

export function emptyTerminalPlanBookStore(): TerminalPlanBookStore {
  return { version: TERMINAL_PLAN_BOOK_VERSION, plans: [], tombstones: [], clearedAt: 0 };
}

export function inspectTerminalPlanBookStore(
  raw: string | null | undefined,
  nowMs = Date.now(),
): TerminalPlanBookInspection {
  if (raw == null || raw === "") return { status: "absent", store: emptyTerminalPlanBookStore(), raw: null };
  try {
    const store = validateStore(JSON.parse(raw), nowMs);
    return store ? { status: "ready", store, raw } : { status: "blocked", store: null, raw };
  } catch {
    return { status: "blocked", store: null, raw };
  }
}

export function serializeTerminalPlanBookStore(store: TerminalPlanBookStore, nowMs = Date.now()) {
  const valid = validateStore(store, nowMs);
  if (!valid) throw new Error("terminal_plan_book_invalid");
  return JSON.stringify(valid);
}

export function terminalPlanBookStoresEqual(left: TerminalPlanBookStore, right: TerminalPlanBookStore) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function terminalPlansForIdentity(store: TerminalPlanBookStore, identity: TerminalPlanBookIdentity) {
  const identityKey = terminalPlanBookIdentityKey(identity);
  if (!identityKey) return [];
  return store.plans.filter((plan) => terminalPlanBookIdentityKey(plan.identity) === identityKey);
}

export function terminalPlansOutsideIdentity(store: TerminalPlanBookStore, identity: TerminalPlanBookIdentity) {
  const identityKey = terminalPlanBookIdentityKey(identity);
  if (!identityKey) return [];
  return store.plans.filter((plan) => terminalPlanBookIdentityKey(plan.identity) !== identityKey);
}

export function mergeTerminalPlanBookStores(
  left: TerminalPlanBookStore,
  right: TerminalPlanBookStore,
  nowMs = Date.now(),
): TerminalPlanBookStore {
  const a = requireStore(left, nowMs);
  const b = requireStore(right, nowMs);
  return normalizeStore(
    [...a.plans, ...b.plans],
    [...a.tombstones, ...b.tombstones],
    Math.max(a.clearedAt, b.clearedAt),
  );
}

export function upsertTerminalPlanSnapshot(
  store: TerminalPlanBookStore,
  input: Omit<TerminalPlanSnapshot, "savedAt">,
  nowMs = Date.now(),
): TerminalPlanBookStore {
  const current = requireStore(store, nowMs);
  const plan = validatePlan({ ...input, savedAt: nowMs }, nowMs);
  if (!plan) throw new Error("terminal_plan_snapshot_invalid");
  const identityKey = terminalPlanBookIdentityKey(plan.identity) as string;
  const nameKey = normalizeNameKey(plan.name);
  const existing = current.plans.find((candidate) => (
    terminalPlanBookIdentityKey(candidate.identity) === identityKey
    && normalizeNameKey(candidate.name) === nameKey
  ));
  const identityCount = terminalPlansForIdentity(current, plan.identity).length;
  if (!existing && (current.plans.length >= TERMINAL_PLAN_BOOK_LIMIT || identityCount >= TERMINAL_PLAN_BOOK_IDENTITY_LIMIT)) {
    throw new Error("terminal_plan_book_limit");
  }
  const revision = Math.max(
    nowMs,
    current.clearedAt + 1,
    (existing?.savedAt ?? -1) + 1,
    ...current.tombstones
      .filter((tombstone) => tombstone.id === (existing?.id ?? plan.id) || (tombstone.identityKey === identityKey && tombstone.nameKey === nameKey))
      .map((tombstone) => tombstone.deletedAt + 1),
  );
  const next = { ...plan, id: existing?.id ?? plan.id, savedAt: revision };
  return normalizeStore(
    current.plans.filter((candidate) => candidate.id !== next.id).concat(next),
    current.tombstones.filter((tombstone) => !(
      (tombstone.id === next.id || (tombstone.identityKey === identityKey && tombstone.nameKey === nameKey))
      && tombstone.deletedAt < revision
    )),
    current.clearedAt,
  );
}

export function removeTerminalPlanSnapshot(
  store: TerminalPlanBookStore,
  id: string,
  nowMs = Date.now(),
): TerminalPlanBookStore {
  const current = requireStore(store, nowMs);
  const normalizedId = validId(id);
  if (!normalizedId) throw new Error("terminal_plan_snapshot_invalid");
  const target = current.plans.find((plan) => plan.id === normalizedId);
  if (!target) return current;
  const deletedAt = Math.max(nowMs, target.savedAt + 1);
  return normalizeStore(
    current.plans.filter((plan) => plan.id !== normalizedId),
    current.tombstones.concat({
      id: target.id,
      identityKey: terminalPlanBookIdentityKey(target.identity) as string,
      nameKey: normalizeNameKey(target.name),
      deletedAt,
    }),
    current.clearedAt,
  );
}

export function resetTerminalPlanBookStore(nowMs = Date.now()): TerminalPlanBookStore {
  if (!validNow(nowMs)) throw new Error("terminal_plan_book_invalid");
  return { ...emptyTerminalPlanBookStore(), clearedAt: nowMs };
}

export function deriveTerminalPlanRestoreDecision(input: {
  plan: TerminalPlanSnapshot;
  identity: TerminalPlanBookIdentity;
  currentReferencePrice: number | null;
  nowMs?: number;
}): TerminalPlanRestoreDecision {
  const nowMs = input.nowMs ?? Date.now();
  const targetPrice = terminalRewardTargetPrice({
    side: input.plan.side,
    entryPrice: input.plan.entryPrice,
    stopPrice: input.plan.invalidationPrice,
    rewardMultiple: input.plan.targetRewardMultiple,
  });
  if (!validatePlan(input.plan, nowMs) || targetPrice == null) return blocked("plan_invalid");
  if (terminalPlanBookIdentityKey(input.plan.identity) !== terminalPlanBookIdentityKey(input.identity)) {
    return blocked("identity_mismatch", null, null, targetPrice);
  }
  const referencePrice = positive(input.currentReferencePrice);
  if (referencePrice == null) return blocked("reference_unavailable", null, null, targetPrice);
  const ageMs = nowMs - input.plan.savedAt;
  if (ageMs < -30_000) return blocked("snapshot_future", ageMs, null, targetPrice);
  if (ageMs > RESTORE_MAX_AGE_MS) return blocked("snapshot_expired", ageMs, null, targetPrice);
  const driftBps = Math.abs(referencePrice - input.plan.certifiedReferencePrice) / input.plan.certifiedReferencePrice * 10_000;
  if (!Number.isFinite(driftBps) || driftBps > RESTORE_MAX_DRIFT_BPS) {
    return blocked("market_drift_excessive", ageMs, finite(driftBps), targetPrice);
  }
  return {
    status: ageMs <= RESTORE_FRESH_AGE_MS && driftBps <= RESTORE_FRESH_DRIFT_BPS ? "ready" : "confirm",
    blocker: null,
    ageMs: Math.max(0, ageMs),
    driftBps,
    targetPrice,
  };
}

/** Derives saved-ticket economics only from immutable snapshot inputs. */
export function deriveTerminalPlanEconomics(
  plan: Pick<TerminalPlanSnapshot,
    "side" | "entryPrice" | "invalidationPrice" | "targetRewardMultiple" | "notionalUsd" | "riskBudgetUsd" | "slippageBps"
  >,
): TerminalPlanEconomics | null {
  const entryPrice = positive(plan.entryPrice);
  const invalidationPrice = positive(plan.invalidationPrice);
  const notionalUsd = boundedCents(plan.notionalUsd, 1, 100);
  const riskBudgetUsd = boundedCents(plan.riskBudgetUsd, 0.01, 100);
  const slippageBps = enumValue(plan.slippageBps, [25, 50, 100] as const);
  const rewardMultiple = enumValue(plan.targetRewardMultiple, [1, 1.5, 2, 3] as const);
  const stopValid = entryPrice != null && invalidationPrice != null
    && (plan.side === "buy" ? invalidationPrice < entryPrice : plan.side === "sell" && invalidationPrice > entryPrice);
  if (!stopValid || notionalUsd == null || riskBudgetUsd == null || slippageBps == null || rewardMultiple == null) {
    return null;
  }
  const targetPrice = terminalRewardTargetPrice({
    side: plan.side,
    entryPrice,
    stopPrice: invalidationPrice,
    rewardMultiple,
  });
  if (targetPrice == null) return null;
  const stopDistanceBps = Math.abs(entryPrice - invalidationPrice) / entryPrice * 10_000;
  const totalRiskBps = stopDistanceBps + slippageBps;
  const targetDistanceBps = stopDistanceBps * rewardMultiple;
  const modeledLossUsd = notionalUsd * totalRiskBps / 10_000;
  const targetProfitUsd = notionalUsd * Math.max(0, targetDistanceBps - slippageBps) / 10_000;
  const budgetUtilizationPct = modeledLossUsd / riskBudgetUsd * 100;
  const netRewardRisk = modeledLossUsd > 0 ? targetProfitUsd / modeledLossUsd : 0;
  if (![stopDistanceBps, totalRiskBps, modeledLossUsd, targetProfitUsd, budgetUtilizationPct, netRewardRisk].every(Number.isFinite)) {
    return null;
  }
  const tolerance = Math.max(1e-9, riskBudgetUsd * 1e-9);
  return {
    targetPrice,
    stopDistanceBps,
    totalRiskBps,
    modeledLossUsd,
    targetProfitUsd,
    budgetUtilizationPct,
    netRewardRisk,
    withinBudget: modeledLossUsd <= riskBudgetUsd + tolerance,
  };
}

function validateStore(value: unknown, nowMs: number): TerminalPlanBookStore | null {
  if (!validNow(nowMs)) return null;
  const row = record(value);
  if (!row || row.version !== TERMINAL_PLAN_BOOK_VERSION || !Array.isArray(row.plans) || !Array.isArray(row.tombstones)) return null;
  const clearedAt = validRevision(row.clearedAt, nowMs);
  if (clearedAt == null || row.plans.length > TERMINAL_PLAN_BOOK_LIMIT || row.tombstones.length > TERMINAL_PLAN_BOOK_TOMBSTONE_LIMIT) return null;
  const plans: TerminalPlanSnapshot[] = [];
  for (const candidate of row.plans) {
    const plan = validatePlan(candidate, nowMs);
    if (!plan) return null;
    plans.push(plan);
  }
  const tombstones: TerminalPlanBookTombstone[] = [];
  for (const candidate of row.tombstones) {
    const tombstone = record(candidate);
    const id = validId(tombstone?.id);
    const identityKey = validIdentityKey(tombstone?.identityKey);
    const nameKey = validNameKey(tombstone?.nameKey);
    const deletedAt = validRevision(tombstone?.deletedAt, nowMs);
    if (!id || !identityKey || !nameKey || deletedAt == null) return null;
    tombstones.push({ id, identityKey, nameKey, deletedAt });
  }
  const normalized = normalizeStore(plans, tombstones, clearedAt);
  if (normalized.plans.length !== plans.length || normalized.tombstones.length !== tombstones.length) return null;
  return normalized;
}

function validatePlan(value: unknown, nowMs: number): TerminalPlanSnapshot | null {
  const row = record(value);
  const id = validId(row?.id);
  const name = normalizeName(row?.name);
  const identity = validIdentity(row?.identity);
  const side = row?.side === "buy" || row?.side === "sell" ? row.side : null;
  const entryPrice = positive(row?.entryPrice);
  const invalidationPrice = positive(row?.invalidationPrice);
  const targetRewardMultiple = enumValue(row?.targetRewardMultiple, [1, 1.5, 2, 3] as const);
  const notionalUsd = boundedCents(row?.notionalUsd, 1, 100);
  const riskBudgetUsd = boundedCents(row?.riskBudgetUsd, 0.01, 100);
  const slippageBps = enumValue(row?.slippageBps, [25, 50, 100] as const);
  const certifiedReferencePrice = positive(row?.certifiedReferencePrice);
  const decisionContext = row ? validDecisionContext(row) : null;
  const savedAt = validRevision(row?.savedAt, nowMs);
  if (!id || !name || !identity || !side || entryPrice == null || invalidationPrice == null || !targetRewardMultiple || notionalUsd == null || riskBudgetUsd == null || !slippageBps || certifiedReferencePrice == null || !decisionContext || savedAt == null) return null;
  if (side === "buy" ? invalidationPrice >= entryPrice : invalidationPrice <= entryPrice) return null;
  return { id, name, identity, side, entryPrice, invalidationPrice, targetRewardMultiple, notionalUsd, riskBudgetUsd, slippageBps, certifiedReferencePrice, ...decisionContext, savedAt };
}

function validDecisionContext(row: Record<string, unknown>): Pick<TerminalPlanSnapshot, "setup" | "thesis" | "invalidationNote"> | null {
  const keys = ["setup", "thesis", "invalidationNote"] as const;
  const present = keys.filter((key) => Object.hasOwn(row, key)).length;
  if (present === 0) return { setup: null, thesis: null, invalidationNote: null };
  if (present !== keys.length) return null;
  if (row.setup === null && row.thesis === null && row.invalidationNote === null) {
    return { setup: null, thesis: null, invalidationNote: null };
  }
  const setup = enumValue(row.setup, ["breakout", "pullback", "reversal", "range", "event", "other"] as const);
  const thesis = normalizeDecisionText(row.thesis, TERMINAL_PLAN_BOOK_THESIS_LIMIT);
  const invalidationNote = normalizeDecisionText(row.invalidationNote, TERMINAL_PLAN_BOOK_INVALIDATION_NOTE_LIMIT);
  return setup && thesis && invalidationNote ? { setup, thesis, invalidationNote } : null;
}

function normalizeStore(
  planCandidates: readonly TerminalPlanSnapshot[],
  tombstoneCandidates: readonly TerminalPlanBookTombstone[],
  clearedAt: number,
): TerminalPlanBookStore {
  const tombstonesByIdentity = new Map<string, TerminalPlanBookTombstone>();
  for (const tombstone of tombstoneCandidates) {
    const key = `${tombstone.id}:${tombstone.identityKey}:${tombstone.nameKey}`;
    const current = tombstonesByIdentity.get(key);
    if (!current || tombstone.deletedAt > current.deletedAt) tombstonesByIdentity.set(key, { ...tombstone });
  }
  const tombstones = [...tombstonesByIdentity.values()]
    .filter((tombstone) => tombstone.deletedAt > clearedAt)
    .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id))
    .slice(0, TERMINAL_PLAN_BOOK_TOMBSTONE_LIMIT);
  const byId = new Map<string, TerminalPlanSnapshot>();
  for (const candidate of planCandidates) {
    const current = byId.get(candidate.id);
    if (!current || newerPlan(candidate, current)) byId.set(candidate.id, clonePlan(candidate));
  }
  const byName = new Map<string, TerminalPlanSnapshot>();
  for (const candidate of byId.values()) {
    if (candidate.savedAt <= clearedAt) continue;
    const identityKey = terminalPlanBookIdentityKey(candidate.identity) as string;
    const nameKey = normalizeNameKey(candidate.name);
    const deleted = tombstones.some((tombstone) => tombstone.deletedAt >= candidate.savedAt && (
      tombstone.id === candidate.id || (tombstone.identityKey === identityKey && tombstone.nameKey === nameKey)
    ));
    if (deleted) continue;
    const key = `${identityKey}:${nameKey}`;
    const current = byName.get(key);
    if (!current || newerPlan(candidate, current)) byName.set(key, candidate);
  }
  const plans = [...byName.values()]
    .sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name))
    .slice(0, TERMINAL_PLAN_BOOK_LIMIT);
  return { version: TERMINAL_PLAN_BOOK_VERSION, plans, tombstones, clearedAt };
}

function requireStore(value: unknown, nowMs: number) {
  const store = validateStore(value, nowMs);
  if (!store) throw new Error("terminal_plan_book_invalid");
  return store;
}

function newerPlan(left: TerminalPlanSnapshot, right: TerminalPlanSnapshot) {
  return left.savedAt > right.savedAt || (left.savedAt === right.savedAt && planFingerprint(left) > planFingerprint(right));
}

function planFingerprint(plan: TerminalPlanSnapshot) {
  return JSON.stringify(plan);
}

function clonePlan(plan: TerminalPlanSnapshot): TerminalPlanSnapshot {
  return { ...plan, identity: { ...plan.identity } };
}

function validIdentity(value: unknown): TerminalPlanBookIdentity | null {
  const row = record(value);
  const venue = enumValue(row?.venue, ["hyperliquid", "phoenix", "coinbase"] as const);
  const network = enumValue(row?.network, ["mainnet", "testnet"] as const);
  const product = typeof row?.product === "string" && /^[A-Z0-9/_-]{1,32}$/u.test(row.product) ? row.product : null;
  const interval = enumValue(row?.interval, ["1m", "5m", "15m", "1h"] as const);
  if (!venue || !network || !product || !interval || (network === "testnet" && venue !== "hyperliquid")) return null;
  return { venue, network, product, interval };
}

function validIdentityKey(value: unknown) {
  if (typeof value !== "string") return null;
  const [venue, network, product, interval, ...extra] = value.split(":");
  return extra.length === 0 && terminalPlanBookIdentityKey({ venue, network, product, interval } as TerminalPlanBookIdentity) === value ? value : null;
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/gu, " ");
  return name.length > 0 && name.length <= TERMINAL_PLAN_BOOK_NAME_LIMIT ? name : null;
}

function normalizeDecisionText(value: unknown, limit: number) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > 0 && text.length <= limit ? text : null;
}

function normalizeNameKey(value: string) {
  return value.toLocaleLowerCase();
}

function validNameKey(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = normalizeName(value);
  return normalized && normalized === value && value === value.toLocaleLowerCase() ? value : null;
}

function validId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
}

function validRevision(value: unknown, nowMs: number) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 && revision <= nowMs + FUTURE_TOLERANCE_MS ? revision : null;
}

function validNow(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedCents(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max && Math.abs(parsed * 100 - Math.round(parsed * 100)) <= 1e-8 ? parsed : null;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finite(value: number) {
  return Number.isFinite(value) ? value : null;
}

function enumValue<T extends string | number>(value: unknown, values: readonly T[]): T | null {
  return values.includes(value as T) ? value as T : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function blocked(
  blocker: Extract<TerminalPlanRestoreDecision, { status: "blocked" }>["blocker"],
  ageMs: number | null = null,
  driftBps: number | null = null,
  targetPrice: number | null = null,
): TerminalPlanRestoreDecision {
  return { status: "blocked", blocker, ageMs, driftBps, targetPrice };
}
