export const TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT = 20;
export const TERMINAL_LIVE_ACCOUNT_EVENT_BATCH_LIMIT = 8;

export interface TerminalLiveAccountOrderEvent {
  orderHandleCommitment: string;
  market: string;
  status: string;
  side: "buy" | "sell" | "unknown";
  sizeBucket: string;
  priceBucket: string;
  timeBucket: string;
  observedAtMs: number;
}

export function terminalLiveAccountOrderEventKey(event: TerminalLiveAccountOrderEvent) {
  return JSON.stringify([
    event.orderHandleCommitment,
    event.timeBucket,
    event.status,
    event.side,
    event.sizeBucket,
    event.priceBucket,
  ]);
}

/** Strictly ingests privacy-sanitized worker events; malformed batches fail closed. */
export function ingestTerminalLiveAccountOrderEvent(
  current: readonly TerminalLiveAccountOrderEvent[],
  raw: unknown,
  observedAtMs: number,
): readonly TerminalLiveAccountOrderEvent[] {
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0) return current;
  const event = record(raw);
  if (event?.type !== "order_update" || !Array.isArray(event.updates) || event.updates.length === 0 || event.updates.length > TERMINAL_LIVE_ACCOUNT_EVENT_BATCH_LIMIT) {
    return current;
  }
  const updatedAt = isoValue(event.updated_at);
  if (updatedAt == null || Date.parse(updatedAt) > observedAtMs + 30_000) return current;
  const incoming: TerminalLiveAccountOrderEvent[] = [];
  for (const value of event.updates) {
    const row = record(value);
    const orderHandleCommitment = commitmentValue(row?.order_handle_commitment);
    const market = marketValue(row?.market);
    const status = statusValue(row?.status);
    const side = sideValue(row?.side);
    const sizeBucket = bucketValue(row?.size_bucket);
    const priceBucket = bucketValue(row?.price_bucket);
    const timeBucket = isoValue(row?.time_bucket);
    if (!orderHandleCommitment || !market || !status || !side || !sizeBucket || !priceBucket || !timeBucket || Date.parse(timeBucket) > observedAtMs + 30_000) {
      return current;
    }
    incoming.push({ orderHandleCommitment, market, status, side, sizeBucket, priceBucket, timeBucket, observedAtMs });
  }
  const byEvent = new Map(current.map((row) => [terminalLiveAccountOrderEventKey(row), row]));
  let changed = false;
  for (const candidate of incoming) {
    const key = terminalLiveAccountOrderEventKey(candidate);
    if (byEvent.has(key)) continue;
    byEvent.set(key, candidate);
    changed = true;
  }
  if (!changed) return current;
  return [...byEvent.values()]
    .sort((left, right) => compareEventChronology(right, left) || terminalLiveAccountOrderEventKey(right).localeCompare(terminalLiveAccountOrderEventKey(left)))
    .slice(0, TERMINAL_LIVE_ACCOUNT_EVENT_LIMIT);
}

function compareEventChronology(left: TerminalLiveAccountOrderEvent, right: TerminalLiveAccountOrderEvent) {
  return Date.parse(left.timeBucket) - Date.parse(right.timeBucket)
    || left.observedAtMs - right.observedAtMs;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function commitmentValue(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9._:-]{8,180}$/u.test(value) ? value : null; }
function marketValue(value: unknown) { return typeof value === "string" && /^[A-Z0-9/_:-]{1,32}$/u.test(value) ? value : null; }
function statusValue(value: unknown) { return typeof value === "string" && /^[a-z0-9_:-]{1,32}$/u.test(value) ? value : null; }
function sideValue(value: unknown) { return value === "buy" || value === "sell" || value === "unknown" ? value : null; }
function bucketValue(value: unknown) { return typeof value === "string" && /^(none|<0\.001|0\.001-0\.01|0\.01-0\.1|0\.1-1|1-10|10-100|100-1k|1k-10k|10k\+)$/u.test(value) ? value : null; }
function isoValue(value: unknown) { if (typeof value !== "string") return null; const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null; }
