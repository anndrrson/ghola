import type { TerminalAlertMetric, TerminalAlertRule, TerminalAlertSnapshot } from "./terminal-alerts";

const AGE_METRICS = new Set<TerminalAlertMetric>([
  "market_age_ms",
  "book_age_ms",
  "trades_age_ms",
  "candles_age_ms",
]);

export function advanceTerminalAlertAgeSnapshot(input: {
  snapshot: TerminalAlertSnapshot;
  capturedAtMs: number | null;
  nowMs: number;
}): TerminalAlertSnapshot {
  if (!validTime(input.nowMs) || !validTime(input.capturedAtMs) || input.nowMs < input.capturedAtMs) {
    return clearAgeMetrics(input.snapshot);
  }
  const elapsedMs = input.nowMs - input.capturedAtMs;
  let changed = false;
  const next = { ...input.snapshot };
  for (const metric of AGE_METRICS) {
    const baseAgeMs = finiteNonNegative(input.snapshot[metric]);
    if (baseAgeMs == null) continue;
    next[metric] = baseAgeMs + elapsedMs;
    changed ||= elapsedMs > 0;
  }
  return changed ? next : input.snapshot;
}

export function terminalAlertNextAgeThresholdAt(input: {
  rules: readonly TerminalAlertRule[];
  snapshot: TerminalAlertSnapshot;
  capturedAtMs: number | null;
  nowMs: number;
}): number | null {
  if (!validTime(input.nowMs) || !validTime(input.capturedAtMs) || input.nowMs < input.capturedAtMs) return null;
  let deadline: number | null = null;
  for (const rule of input.rules) {
    if (!rule.enabled || rule.operator !== "above" || !AGE_METRICS.has(rule.metric)) continue;
    const baseAgeMs = finiteNonNegative(input.snapshot[rule.metric]);
    if (baseAgeMs == null || !Number.isFinite(rule.threshold) || rule.threshold < 0) continue;
    const thresholdAt = input.capturedAtMs + Math.max(0, rule.threshold - baseAgeMs);
    if (thresholdAt <= input.nowMs) continue;
    deadline = deadline == null ? thresholdAt : Math.min(deadline, thresholdAt);
  }
  return deadline;
}

function clearAgeMetrics(snapshot: TerminalAlertSnapshot): TerminalAlertSnapshot {
  const next = { ...snapshot };
  let changed = false;
  for (const metric of AGE_METRICS) {
    if (next[metric] == null) continue;
    next[metric] = null;
    changed = true;
  }
  return changed ? next : snapshot;
}

function validTime(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}
