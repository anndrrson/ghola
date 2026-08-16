import { MARKET_COMPONENTS } from "./market-component-clock";
import type { TerminalWatchlistInstrument, TerminalWatchlistSource, TerminalWatchlistVenue } from "./terminal-market-watchlist";
import {
  inspectUnifiedMarketSnapshot,
  unifiedMarketSnapshotUrl,
  type UnifiedMarketInterval,
  type UnifiedMarketSelection,
} from "./unified-live-market";

export const TERMINAL_MARKET_SCANNER_TARGET_LIMIT = 4;
export const TERMINAL_MARKET_SCANNER_CADENCE_MS = 4_000;
export const TERMINAL_MARKET_SCANNER_FETCH_TIMEOUT_MS = 6_000;

export interface TerminalMarketScannerTarget {
  venue: TerminalWatchlistVenue;
  instrument: TerminalWatchlistInstrument;
  interval: UnifiedMarketInterval;
  network: "mainnet" | "testnet";
}

export interface TerminalMarketScannerController {
  start(): void;
  stop(): void;
}

export function terminalMarketScannerTargetKey(target: TerminalMarketScannerTarget) {
  return `${target.venue}:${target.network}:${target.instrument}:${target.interval}`;
}

export function terminalMarketScannerUrl(target: TerminalMarketScannerTarget) {
  return unifiedMarketSnapshotUrl(targetSelection(target));
}

export function inspectTerminalMarketScannerSnapshot(
  target: TerminalMarketScannerTarget,
  value: unknown,
  receivedAtMs: number,
): TerminalWatchlistSource | null {
  if (!Number.isFinite(receivedAtMs) || receivedAtMs <= 0) return null;
  const inspected = inspectUnifiedMarketSnapshot(targetSelection(target), value, receivedAtMs);
  if (!inspected) return null;
  const componentAgesMs: TerminalWatchlistSource["componentAgesMs"] = {};
  for (const component of MARKET_COMPONENTS) {
    const timestamp = inspected.componentTimestamps[component];
    if (timestamp != null) componentAgesMs[component] = Math.max(0, receivedAtMs - timestamp);
  }
  return {
    frame: inspected.frame,
    status: inspected.stale ? "stale" : "fallback_polling",
    stale: inspected.stale,
    provenance: "public_live",
    healthGrade: null,
    transport: "polling",
    componentAgesMs,
    telemetryCapturedAtMs: receivedAtMs,
  };
}

export function createTerminalMarketScanner(options: {
  targets: TerminalMarketScannerTarget[];
  onSource: (source: TerminalWatchlistSource) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  isDocumentHidden?: () => boolean;
  cadenceMs?: number;
  fetchTimeoutMs?: number;
}): TerminalMarketScannerController {
  const targets = normalizeTargets(options.targets);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const isDocumentHidden = options.isDocumentHidden ?? (() => document.hidden);
  const cadenceMs = boundedDuration(options.cadenceMs, TERMINAL_MARKET_SCANNER_CADENCE_MS, 1_000, 30_000);
  const fetchTimeoutMs = boundedDuration(options.fetchTimeoutMs, TERMINAL_MARKET_SCANNER_FETCH_TIMEOUT_MS, 500, 15_000);
  let running = false;
  let nextIndex = 0;
  let cadenceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  let requestAbort: AbortController | null = null;

  const schedule = () => {
    if (!running || cadenceTimer != null) return;
    cadenceTimer = setTimeout(() => {
      cadenceTimer = null;
      void pollNext();
    }, cadenceMs);
  };
  const pollNext = async () => {
    if (!running) return;
    if (targets.length === 0 || isDocumentHidden()) {
      schedule();
      return;
    }
    const target = targets[nextIndex % targets.length];
    nextIndex = (nextIndex + 1) % targets.length;
    const controller = new AbortController();
    requestAbort = controller;
    requestTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetchImpl(terminalMarketScannerUrl(target), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const source = inspectTerminalMarketScannerSnapshot(target, await response.json(), now());
      if (running && source) options.onSource(source);
    } catch {
      // A failed public snapshot leaves the prior bounded row to expire.
    } finally {
      if (requestTimer != null) clearTimeout(requestTimer);
      requestTimer = null;
      if (requestAbort === controller) requestAbort = null;
      schedule();
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void pollNext();
    },
    stop() {
      running = false;
      if (cadenceTimer != null) clearTimeout(cadenceTimer);
      if (requestTimer != null) clearTimeout(requestTimer);
      cadenceTimer = null;
      requestTimer = null;
      requestAbort?.abort();
      requestAbort = null;
    },
  };
}

function targetSelection(target: TerminalMarketScannerTarget): UnifiedMarketSelection {
  return {
    venue: target.venue,
    market: target.instrument,
    interval: target.interval,
    hyperliquidNetwork: target.venue === "hyperliquid" ? target.network : undefined,
  };
}

function normalizeTargets(targets: TerminalMarketScannerTarget[]) {
  const unique = new Map<string, TerminalMarketScannerTarget>();
  for (const target of targets.slice(0, TERMINAL_MARKET_SCANNER_TARGET_LIMIT * 2)) {
    try {
      const key = terminalMarketScannerTargetKey(target);
      terminalMarketScannerUrl(target);
      if (!unique.has(key)) unique.set(key, { ...target });
    } catch {
      // Unsupported venue/instrument pairs never enter the polling rotation.
    }
    if (unique.size >= TERMINAL_MARKET_SCANNER_TARGET_LIMIT) break;
  }
  return [...unique.values()];
}

function boundedDuration(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
}
