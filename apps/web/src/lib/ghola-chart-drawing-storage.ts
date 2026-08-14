import type {
  GholaChartCandle,
  GholaChartVenue,
  GholaMarketFrame,
} from "./ghola-market-chart";

export const GHOLA_CHART_DRAWING_STORAGE_VERSION = 1 as const;
export const GHOLA_CHART_DRAWING_LEGACY_STORAGE_KEY = "ghola.chart-drawings.v1";
export const GHOLA_CHART_DRAWING_STORAGE_PREFIX = "ghola.chart-drawings.v2:";
export const GHOLA_CHART_DRAWING_GUEST_SCOPE = "device_guest";
export const GHOLA_CHART_DRAWING_RECORD_LIMIT = 24;
export const GHOLA_CHART_TREND_LINE_LIMIT = 8;
export const GHOLA_CHART_DRAWING_REPLAY_READ_ONLY_REASON =
  "Drawings are read-only during historical replay.";
export const GHOLA_CHART_DRAWING_UNCERTIFIED_READ_ONLY_REASON =
  "Drawings are read-only until public candle history is certified.";
export const GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON =
  "Drawings are locked because saved drawing data is unreadable.";
export const GHOLA_CHART_DRAWING_STORAGE_CONFLICT_REASON =
  "Drawings are locked because another tab changed this exact chart concurrently.";

const MAX_IDENTITY_LENGTH = 192;
const MAX_DRAWING_ID_LENGTH = 96;
const MAX_PRICE = 1_000_000_000_000_000;
const RECORD_SCAN_LIMIT = GHOLA_CHART_DRAWING_RECORD_LIMIT * 8;
const DRAWING_SCAN_LIMIT = GHOLA_CHART_TREND_LINE_LIMIT * 8;
const PERSISTENCE_SCOPE_PATTERN = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export interface GholaChartDrawingIdentity {
  persistenceScope: string;
  replayIdentityKey: string;
  venue: GholaChartVenue;
  product: string;
  interval: string;
}

export interface GholaStoredTrendLine {
  id: string;
  kind: "segment" | "ray";
  first: { time: number; price: number };
  second: { time: number; price: number };
}

export interface GholaChartDrawingPayload {
  anchoredVwap: { anchorTime: number; showBands: boolean } | null;
  trendLines: GholaStoredTrendLine[];
}

export interface GholaChartDrawingRecord extends GholaChartDrawingPayload {
  identity: GholaChartDrawingIdentity;
  updatedAt: number;
}

export interface GholaChartDrawingStorage {
  version: typeof GHOLA_CHART_DRAWING_STORAGE_VERSION;
  records: GholaChartDrawingRecord[];
}

export interface GholaChartDrawingStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type GholaChartDrawingGuardedWriteResult =
  | { status: "written"; document: GholaChartDrawingStorage }
  | { status: "unchanged"; document: GholaChartDrawingStorage }
  | { status: "stale"; document: GholaChartDrawingStorage; payload: GholaChartDrawingPayload }
  | { status: "conflict"; document: GholaChartDrawingStorage }
  | { status: "blocked" | "failed"; document: null };

export type GholaChartDrawingStorageInspection =
  | { status: "absent"; storage: GholaChartDrawingStorage; raw: null }
  | { status: "ready"; storage: GholaChartDrawingStorage; raw: string }
  | { status: "blocked"; storage: null; raw: string };

export function gholaChartDrawingMutationPolicy(input: {
  replayActive: boolean;
  sourceCertified: boolean;
  storageBlocked?: boolean;
}): {
  allowed: boolean;
  disabledReason: string | null;
} {
  if (input.storageBlocked) {
    return { allowed: false, disabledReason: GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON };
  }
  if (input.replayActive) {
    return { allowed: false, disabledReason: GHOLA_CHART_DRAWING_REPLAY_READ_ONLY_REASON };
  }
  return input.sourceCertified
    ? { allowed: true, disabledReason: null }
    : { allowed: false, disabledReason: GHOLA_CHART_DRAWING_UNCERTIFIED_READ_ONLY_REASON };
}

export function emptyGholaChartDrawingPayload(): GholaChartDrawingPayload {
  return { anchoredVwap: null, trendLines: [] };
}

export function emptyGholaChartDrawingStorage(): GholaChartDrawingStorage {
  return { version: GHOLA_CHART_DRAWING_STORAGE_VERSION, records: [] };
}

/**
 * Persistence is enabled only when the caller supplies its full replay identity.
 * TradePage includes the Hyperliquid network in that key; binding it alongside
 * the frame fields keeps otherwise identical mainnet and testnet charts apart.
 */
export function gholaChartDrawingIdentity(
  frame: Pick<GholaMarketFrame, "venue" | "product" | "interval"> | null,
  replayIdentityKey: string | null | undefined,
  persistenceScope: string | null | undefined,
): GholaChartDrawingIdentity | null {
  if (!frame) return null;
  return validateIdentity({
    persistenceScope,
    replayIdentityKey,
    venue: frame.venue,
    product: frame.product,
    interval: frame.interval,
  });
}

export function gholaChartDrawingStorageKey(
  persistenceScope: string | null | undefined,
): string | null {
  return typeof persistenceScope === "string" && PERSISTENCE_SCOPE_PATTERN.test(persistenceScope)
    ? `${GHOLA_CHART_DRAWING_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export function gholaChartDrawingScope(identity: GholaChartDrawingIdentity): string {
  const valid = validateIdentity(identity);
  if (!valid) throw new Error("ghola_chart_drawing_identity_invalid");
  return JSON.stringify([
    GHOLA_CHART_DRAWING_STORAGE_VERSION,
    valid.persistenceScope,
    valid.replayIdentityKey,
    valid.venue,
    valid.product,
    valid.interval,
  ]);
}

export function parseGholaChartDrawingStorage(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): GholaChartDrawingStorage {
  if (!value) return emptyGholaChartDrawingStorage();
  try {
    return validateStorage(JSON.parse(value), validNow(nowMs));
  } catch {
    return emptyGholaChartDrawingStorage();
  }
}

/**
 * Strict UI-facing inspection. Unlike the tolerant migration parser, this
 * preserves unreadable current storage instead of silently replacing it.
 */
export function inspectGholaChartDrawingStorage(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): GholaChartDrawingStorageInspection {
  if (value == null) {
    return { status: "absent", storage: emptyGholaChartDrawingStorage(), raw: null };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    const now = validNow(nowMs);
    if (!strictStorageDocument(parsed, now)) {
      return { status: "blocked", storage: null, raw: value };
    }
    return { status: "ready", storage: validateStorage(parsed, now), raw: value };
  } catch {
    return { status: "blocked", storage: null, raw: value };
  }
}

export function serializeGholaChartDrawingStorage(
  value: GholaChartDrawingStorage,
  nowMs: number = Date.now(),
): string {
  if (value.version !== GHOLA_CHART_DRAWING_STORAGE_VERSION || !Array.isArray(value.records)) {
    throw new Error("ghola_chart_drawing_storage_invalid");
  }
  return JSON.stringify(validateStorage(value, validNow(nowMs)));
}

export function gholaChartDrawingRecordForIdentity(
  storage: GholaChartDrawingStorage,
  identity: GholaChartDrawingIdentity,
): GholaChartDrawingRecord | null {
  const scope = gholaChartDrawingScope(identity);
  return storage.records.find((record) => gholaChartDrawingScope(record.identity) === scope) ?? null;
}

export function gholaChartDrawingPayloadEqual(
  left: GholaChartDrawingPayload,
  right: GholaChartDrawingPayload,
): boolean {
  return payloadTieKey(left) === payloadTieKey(right);
}

export function gholaChartDrawingStorageEqual(
  left: GholaChartDrawingStorage,
  right: GholaChartDrawingStorage,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Deterministically joins documents read by different tabs. Newer scope
 * revisions win; an exact-time clear wins ties so deleted drawings cannot be
 * resurrected by a concurrent stale writer.
 */
export function mergeGholaChartDrawingStorage(
  left: GholaChartDrawingStorage,
  right: GholaChartDrawingStorage,
  nowMs: number = Date.now(),
): GholaChartDrawingStorage {
  const now = validNow(nowMs);
  const candidates = [
    ...validateStorage(left, now).records,
    ...validateStorage(right, now).records,
  ];
  return {
    version: GHOLA_CHART_DRAWING_STORAGE_VERSION,
    records: normalizeRecords(candidates),
  };
}

export function reconcileGholaChartDrawingStorage(input: {
  local: GholaChartDrawingStorage;
  incomingValue: string | null;
  identity: GholaChartDrawingIdentity;
  candles: readonly GholaChartCandle[];
  nowMs?: number;
}): {
  document: GholaChartDrawingStorage;
  payload: GholaChartDrawingPayload;
  repairRequired: boolean;
} {
  const nowMs = validNow(input.nowMs ?? Date.now());
  const incoming = parseGholaChartDrawingStorage(input.incomingValue, nowMs);
  const document = mergeGholaChartDrawingStorage(input.local, incoming, nowMs);
  const winner = gholaChartDrawingRecordForIdentity(document, input.identity);
  return {
    document,
    payload: winner
      ? gholaChartDrawingPayloadForCandles(winner, input.candles)
      : emptyGholaChartDrawingPayload(),
    repairRequired: !gholaChartDrawingStorageEqual(incoming, document),
  };
}

/** Detects only divergent same-chart edits based on the browser event's prior document. */
export function gholaChartDrawingConcurrentScopeConflict(input: {
  local: GholaChartDrawingStorage;
  previousValue: string | null;
  incoming: GholaChartDrawingStorage;
  identity: GholaChartDrawingIdentity;
  localPayload?: GholaChartDrawingPayload;
  nowMs?: number;
}): boolean {
  const nowMs = validNow(input.nowMs ?? Date.now());
  const previousInspection = inspectGholaChartDrawingStorage(input.previousValue, nowMs);
  if (previousInspection.status === "blocked") return true;
  const previous = previousInspection.storage;
  const localRecord = gholaChartDrawingRecordForIdentity(validateStorage(input.local, nowMs), input.identity);
  const previousRecord = gholaChartDrawingRecordForIdentity(previous, input.identity);
  const incomingRecord = gholaChartDrawingRecordForIdentity(validateStorage(input.incoming, nowMs), input.identity);
  const localPayload = input.localPayload ?? localRecord ?? emptyGholaChartDrawingPayload();
  const previousPayload = previousRecord ?? emptyGholaChartDrawingPayload();
  const incomingPayload = incomingRecord ?? emptyGholaChartDrawingPayload();
  const localChanged = !gholaChartDrawingPayloadEqual(localPayload, previousPayload);
  const incomingChanged = !gholaChartDrawingPayloadEqual(incomingPayload, previousPayload);
  return localChanged && incomingChanged && !gholaChartDrawingPayloadEqual(localPayload, incomingPayload);
}

export function updateGholaChartDrawingRecord(
  storage: GholaChartDrawingStorage,
  identity: GholaChartDrawingIdentity,
  payload: GholaChartDrawingPayload,
  nowMs: number = Date.now(),
): GholaChartDrawingStorage {
  const now = validNow(nowMs);
  const validIdentity = validateIdentity(identity);
  const validPayload = validatePayload(payload);
  if (!validIdentity || !validPayload) throw new Error("ghola_chart_drawing_state_invalid");
  const scope = gholaChartDrawingScope(validIdentity);
  const remaining = storage.records.filter(
    (record) => gholaChartDrawingScope(record.identity) !== scope,
  );
  const records = [{ ...validPayload, identity: validIdentity, updatedAt: now }, ...remaining];
  return {
    version: GHOLA_CHART_DRAWING_STORAGE_VERSION,
    records: normalizeRecords(records),
  };
}

export function readGholaChartDrawingStorage(
  storage: Pick<GholaChartDrawingStorageLike, "getItem">,
  persistenceScope: string | null | undefined,
  nowMs: number = Date.now(),
): GholaChartDrawingStorage | null {
  const storageKey = gholaChartDrawingStorageKey(persistenceScope);
  if (!storageKey) return null;
  try {
    return parseGholaChartDrawingStorage(
      storage.getItem(storageKey),
      nowMs,
    );
  } catch {
    return null;
  }
}

export function loadGholaChartDrawingPayload(
  storage: GholaChartDrawingStorageLike,
  identity: GholaChartDrawingIdentity,
  candles: readonly GholaChartCandle[],
  nowMs: number = Date.now(),
): GholaChartDrawingPayload | null {
  const document = readGholaChartDrawingStorage(storage, identity.persistenceScope, nowMs);
  if (!document) return null;
  const record = gholaChartDrawingRecordForIdentity(document, identity);
  return record ? gholaChartDrawingPayloadForCandles(record, candles) : null;
}

export function writeGholaChartDrawingPayload(
  storage: GholaChartDrawingStorageLike,
  identity: GholaChartDrawingIdentity,
  payload: GholaChartDrawingPayload,
  candles: readonly GholaChartCandle[],
  baseStorage?: GholaChartDrawingStorage | null,
  nowMs: number = Date.now(),
): GholaChartDrawingStorage | null {
  const storageKey = gholaChartDrawingStorageKey(identity.persistenceScope);
  if (!storageKey) return null;
  try {
    const current = readGholaChartDrawingStorage(storage, identity.persistenceScope, nowMs);
    if (!current) return null;
    const reconciled = baseStorage
      ? mergeGholaChartDrawingStorage(current, baseStorage, nowMs)
      : current;
    const updated = updateGholaChartDrawingRecord(
      reconciled,
      identity,
      gholaChartDrawingPayloadForCandles(payload, candles),
      nowMs,
    );
    storage.setItem(
      storageKey,
      serializeGholaChartDrawingStorage(updated, nowMs),
    );
    return updated;
  } catch {
    return null;
  }
}

/**
 * Compare-and-write protection for an actively edited chart. A tab may only
 * replace its exact scope when the stored scope still matches its last known
 * base. Sibling-scope changes remain mergeable; divergent same-scope changes
 * stop before setItem so the newer stored revision is never silently lost.
 */
export function writeGholaChartDrawingPayloadGuarded(input: {
  storage: GholaChartDrawingStorageLike;
  identity: GholaChartDrawingIdentity;
  payload: GholaChartDrawingPayload;
  candles: readonly GholaChartCandle[];
  baseStorage: GholaChartDrawingStorage;
  nowMs?: number;
}): GholaChartDrawingGuardedWriteResult {
  const nowMs = validNow(input.nowMs ?? Date.now());
  const storageKey = gholaChartDrawingStorageKey(input.identity.persistenceScope);
  if (!storageKey) return { status: "failed", document: null };
  try {
    const inspection = inspectGholaChartDrawingStorage(input.storage.getItem(storageKey), nowMs);
    if (inspection.status === "blocked") return { status: "blocked", document: null };
    const current = inspection.storage;
    const base = validateStorage(input.baseStorage, nowMs);
    const localPayload = gholaChartDrawingPayloadForCandles(input.payload, input.candles);
    const basePayload = gholaChartDrawingRecordForIdentity(base, input.identity)
      ?? emptyGholaChartDrawingPayload();
    const currentRecord = gholaChartDrawingRecordForIdentity(current, input.identity);
    const currentPayload = currentRecord
      ? gholaChartDrawingPayloadForCandles(currentRecord, input.candles)
      : emptyGholaChartDrawingPayload();
    const localChanged = !gholaChartDrawingPayloadEqual(localPayload, basePayload);
    const storedChanged = !gholaChartDrawingPayloadEqual(currentPayload, basePayload);
    if (localChanged && storedChanged && !gholaChartDrawingPayloadEqual(localPayload, currentPayload)) {
      return { status: "conflict", document: current };
    }
    if (!localChanged && storedChanged) {
      return { status: "stale", document: current, payload: currentPayload };
    }
    if (!localChanged) return { status: "unchanged", document: current };
    const updated = updateGholaChartDrawingRecord(
      mergeGholaChartDrawingStorage(current, base, nowMs),
      input.identity,
      localPayload,
      nowMs,
    );
    input.storage.setItem(storageKey, serializeGholaChartDrawingStorage(updated, nowMs));
    return { status: "written", document: updated };
  } catch {
    return { status: "failed", document: null };
  }
}

export function writeGholaChartDrawingStorage(
  storage: Pick<GholaChartDrawingStorageLike, "setItem">,
  persistenceScope: string | null | undefined,
  document: GholaChartDrawingStorage,
  nowMs: number = Date.now(),
): boolean {
  const storageKey = gholaChartDrawingStorageKey(persistenceScope);
  if (!storageKey) return false;
  try {
    storage.setItem(
      storageKey,
      serializeGholaChartDrawingStorage(document, nowMs),
    );
    return true;
  } catch {
    return false;
  }
}

export function persistGholaChartDrawingPayload(
  storage: GholaChartDrawingStorageLike,
  identity: GholaChartDrawingIdentity,
  payload: GholaChartDrawingPayload,
  candles: readonly GholaChartCandle[],
  nowMs: number = Date.now(),
): boolean {
  return writeGholaChartDrawingPayload(
    storage,
    identity,
    payload,
    candles,
    null,
    nowMs,
  ) !== null;
}

/**
 * Returns only drawings whose required anchors exist in the supplied candle
 * prefix. Replay callers can therefore retain a full local record without
 * exposing future drawing existence, endpoints, prices, or derived values.
 */
export function gholaChartDrawingPayloadForCandles(
  payload: GholaChartDrawingPayload,
  candles: readonly GholaChartCandle[],
): GholaChartDrawingPayload {
  const revealedTimes = new Map<number, number>();
  for (const candle of candles) {
    const normalized = normalizedStoredTime(candle.t);
    if (normalized != null && !revealedTimes.has(normalized)) revealedTimes.set(normalized, candle.t);
  }
  const anchorTime = payload.anchoredVwap
    ? normalizedStoredTime(payload.anchoredVwap.anchorTime)
    : null;
  const canonicalAnchorTime = anchorTime == null ? null : revealedTimes.get(anchorTime);
  return {
    anchoredVwap: payload.anchoredVwap && canonicalAnchorTime != null
      ? { ...payload.anchoredVwap, anchorTime: canonicalAnchorTime }
      : null,
    trendLines: payload.trendLines
      .flatMap((drawing) => {
        const firstTime = normalizedStoredTime(drawing.first.time);
        const secondTime = normalizedStoredTime(drawing.second.time);
        const canonicalFirstTime = firstTime == null ? null : revealedTimes.get(firstTime);
        const canonicalSecondTime = secondTime == null ? null : revealedTimes.get(secondTime);
        return canonicalFirstTime == null || canonicalSecondTime == null
          ? []
          : [{
              ...drawing,
              first: { ...drawing.first, time: canonicalFirstTime },
              second: { ...drawing.second, time: canonicalSecondTime },
            }];
      })
      .slice(-GHOLA_CHART_TREND_LINE_LIMIT)
      .map(cloneTrendLine),
  };
}

function validateStorage(value: unknown, nowMs: number): GholaChartDrawingStorage {
  const row = record(value);
  if (
    !row
    || row.version !== GHOLA_CHART_DRAWING_STORAGE_VERSION
    || !Array.isArray(row.records)
  ) return emptyGholaChartDrawingStorage();

  const candidates = row.records
    .slice(0, RECORD_SCAN_LIMIT)
    .flatMap((candidate) => {
      const valid = validateRecord(candidate, nowMs);
      return valid ? [valid] : [];
    });
  return { version: GHOLA_CHART_DRAWING_STORAGE_VERSION, records: normalizeRecords(candidates) };
}

function strictStorageDocument(value: unknown, nowMs: number): boolean {
  const row = record(value);
  if (
    !row
    || row.version !== GHOLA_CHART_DRAWING_STORAGE_VERSION
    || !Array.isArray(row.records)
  ) return false;
  return row.records.slice(0, RECORD_SCAN_LIMIT).every((candidate) => {
    const recordRow = record(candidate);
    if (!recordRow || validateRecord(candidate, nowMs) == null) return false;
    if (
      recordRow.anchoredVwap != null
      && validateAnchoredVwap(recordRow.anchoredVwap) == null
    ) return false;
    return Array.isArray(recordRow.trendLines)
      && recordRow.trendLines
        .slice(-DRAWING_SCAN_LIMIT)
        .every((drawing) => validateTrendLine(drawing) != null);
  });
}

function validateRecord(value: unknown, nowMs: number): GholaChartDrawingRecord | null {
  const row = record(value);
  if (!row) return null;
  const identity = validateIdentity(row.identity);
  const updatedAt = validUpdatedAt(row.updatedAt, nowMs);
  const payload = validatePayload(row);
  if (!identity || updatedAt == null || !payload) return null;
  return { identity, updatedAt, ...payload };
}

function validatePayload(value: unknown): GholaChartDrawingPayload | null {
  const row = record(value);
  if (!row || !Array.isArray(row.trendLines)) return null;
  const anchoredVwap = validateAnchoredVwap(row.anchoredVwap);
  const candidates = row.trendLines
    .slice(-DRAWING_SCAN_LIMIT)
    .flatMap((drawing) => {
      const valid = validateTrendLine(drawing);
      return valid ? [valid] : [];
    });
  const ids = new Set<string>();
  const trendLines: GholaStoredTrendLine[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    trendLines.unshift(candidate);
    if (trendLines.length >= GHOLA_CHART_TREND_LINE_LIMIT) break;
  }
  return { anchoredVwap, trendLines };
}

function validateIdentity(value: unknown): GholaChartDrawingIdentity | null {
  const row = record(value);
  if (!row) return null;
  const persistenceScope = typeof row.persistenceScope === "string"
    && PERSISTENCE_SCOPE_PATTERN.test(row.persistenceScope)
    ? row.persistenceScope
    : null;
  const replayIdentityKey = identityToken(row.replayIdentityKey);
  const venue = chartVenue(row.venue);
  const product = identityToken(row.product);
  const interval = identityToken(row.interval);
  return persistenceScope && replayIdentityKey && venue && product && interval
    ? { persistenceScope, replayIdentityKey, venue, product, interval }
    : null;
}

function validateAnchoredVwap(value: unknown): GholaChartDrawingPayload["anchoredVwap"] {
  if (value == null) return null;
  const row = record(value);
  if (!row || typeof row.showBands !== "boolean") return null;
  const anchorTime = validStoredTime(row.anchorTime);
  return anchorTime == null ? null : { anchorTime, showBands: row.showBands };
}

function validateTrendLine(value: unknown): GholaStoredTrendLine | null {
  const row = record(value);
  if (!row) return null;
  const id = drawingId(row.id);
  const kind = row.kind === "segment" || row.kind === "ray" ? row.kind : null;
  const first = validateAnchor(row.first);
  const second = validateAnchor(row.second);
  if (!id || !kind || !first || !second || timestampMs(first.time) === timestampMs(second.time)) {
    return null;
  }
  return { id, kind, first, second };
}

function validateAnchor(value: unknown) {
  const row = record(value);
  if (!row) return null;
  const time = validStoredTime(row.time);
  const price = positivePrice(row.price);
  return time == null || price == null ? null : { time, price };
}

function cloneTrendLine(drawing: GholaStoredTrendLine): GholaStoredTrendLine {
  return {
    ...drawing,
    first: { ...drawing.first },
    second: { ...drawing.second },
  };
}

function normalizeRecords(records: GholaChartDrawingRecord[]) {
  const byScope = new Map<string, GholaChartDrawingRecord>();
  for (const record of records) {
    const scope = gholaChartDrawingScope(record.identity);
    const current = byScope.get(scope);
    if (!current || preferredRecord(record, current) === record) byScope.set(scope, record);
  }
  return [...byScope.entries()]
    .sort(([leftScope, left], [rightScope, right]) => (
      right.updatedAt - left.updatedAt || leftScope.localeCompare(rightScope)
    ))
    .slice(0, GHOLA_CHART_DRAWING_RECORD_LIMIT)
    .map(([, record]) => record);
}

function preferredRecord(
  left: GholaChartDrawingRecord,
  right: GholaChartDrawingRecord,
) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  const leftEmpty = payloadIsEmpty(left);
  const rightEmpty = payloadIsEmpty(right);
  if (leftEmpty !== rightEmpty) return leftEmpty ? left : right;
  return payloadTieKey(left) >= payloadTieKey(right) ? left : right;
}

function payloadTieKey(payload: GholaChartDrawingPayload) {
  return JSON.stringify({
    anchoredVwap: payload.anchoredVwap,
    trendLines: payload.trendLines,
  });
}

function payloadIsEmpty(payload: GholaChartDrawingPayload) {
  return payload.anchoredVwap == null && payload.trendLines.length === 0;
}

function identityToken(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return null;
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function drawingId(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DRAWING_ID_LENGTH
    && /^[a-zA-Z0-9:_-]+$/u.test(value)
    ? value
    : null;
}

function chartVenue(value: unknown): GholaChartVenue | null {
  return ["hyperliquid", "phoenix", "backpack", "coinbase", "jupiter"].includes(value as string)
    ? value as GholaChartVenue
    : null;
}

function positivePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PRICE
    ? value
    : null;
}

function validStoredTime(value: unknown): number | null {
  return normalizedStoredTime(value) == null ? null : value as number;
}

function normalizedStoredTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const normalized = timestampMs(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function validUpdatedAt(value: unknown, nowMs: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= nowMs
    ? value
    : null;
}

function validNow(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function timestampMs(value: number) {
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
