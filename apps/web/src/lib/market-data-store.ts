"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createCoinbaseLiveMarketStream,
  type CoinbaseLiveMarketStatus,
} from "./coinbase-live-market";
import {
  createHyperliquidLiveMarketStream,
  type HyperliquidLiveMarketStatus,
} from "./hyperliquid-live-market";
import {
  createPhoenixLiveMarketStream,
  type PhoenixLiveMarketStatus,
} from "./phoenix-live-market";
import type {
  CoinbaseCandleInterval,
  CoinbaseMarketSnapshot,
  CoinbaseProductId,
} from "./coinbase-market-data";
import type {
  PhoenixCandleInterval,
  PhoenixMarketSnapshot,
  PhoenixMarketSymbol,
} from "./phoenix-market-data";
import type { HyperliquidMarketSnapshot } from "./private-account-client";
import {
  gholaFrameFromCoinbase,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaMarketFrame,
} from "./ghola-market-chart";

export type MarketDataStatus = CoinbaseLiveMarketStatus | HyperliquidLiveMarketStatus | PhoenixLiveMarketStatus;

export type MarketDataKey =
  | { venue: "coinbase"; productId: CoinbaseProductId; interval: CoinbaseCandleInterval }
  | { venue: "hyperliquid"; network: "mainnet" | "testnet"; coin: string; interval: "1m" | "5m" | "15m" | "1h" }
  | { venue: "phoenix"; network: "mainnet"; symbol: PhoenixMarketSymbol; interval: PhoenixCandleInterval };

export type MarketDataSnapshot = CoinbaseMarketSnapshot | HyperliquidMarketSnapshot | PhoenixMarketSnapshot;

export interface MarketDataRecord {
  id: string;
  key: MarketDataKey;
  snapshot: MarketDataSnapshot | null;
  frame: GholaMarketFrame | null;
  lastGoodFrame: GholaMarketFrame | null;
  status: MarketDataStatus;
  connected: boolean;
  cached: boolean;
  revision: number;
  updatedAt: number | null;
}

type StreamHandle = { start: () => void; stop: () => void };
type Listener = () => void;
type Entry = {
  record: MarketDataRecord;
  listeners: Set<Listener>;
  leases: number;
  stream: StreamHandle | null;
  warmTimer: ReturnType<typeof setTimeout> | null;
  pendingSnapshot: MarketDataSnapshot | null;
  lastAccess: number;
  demand: "foreground" | "warm" | "dormant";
};

const WARM_TTL_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_ENTRIES = 8;

const entries = new Map<string, Entry>();
const pendingNotifications = new Set<Entry>();
let visibilityInstalled = false;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let storeFrame: number | null = null;

export function marketDataKeyId(key: MarketDataKey) {
  if (key.venue === "coinbase") return `coinbase:${key.productId}:${key.interval}`;
  if (key.venue === "hyperliquid") return `hyperliquid:${key.network}:${key.coin}:${key.interval}`;
  return `phoenix:${key.network}:${key.symbol}:${key.interval}`;
}

export function acquireMarketData(key: MarketDataKey) {
  installVisibilityPolicy();
  const entry = ensureEntry(key);
  entry.leases += 1;
  entry.lastAccess = Date.now();
  entry.demand = "foreground";
  if (entry.warmTimer) clearTimeout(entry.warmTimer);
  entry.warmTimer = null;
  startEntry(entry);
  publish(entry, { cached: entry.record.snapshot != null });
  return () => releaseEntry(entry);
}

export function subscribeMarketData(key: MarketDataKey, listener: Listener) {
  const entry = ensureEntry(key);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function getMarketDataRecord(key: MarketDataKey) {
  return ensureEntry(key).record;
}

export function useMarketData(key: MarketDataKey, enabled = true): MarketDataRecord {
  return useMarketDataSelector(key, (record) => record, enabled);
}

export function useMarketDataSelector<T>(
  key: MarketDataKey,
  selector: (record: MarketDataRecord) => T,
  enabled = true,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const id = marketDataKeyId(key);
  // The serialized id contains every field and is the key's semantic identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableKey = useMemo(() => key, [id]);
  useEffect(() => enabled ? acquireMarketData(stableKey) : undefined, [enabled, stableKey]);
  const selectorRef = useRef(selector);
  const equalityRef = useRef(isEqual);
  const selectedRef = useRef<T | undefined>(undefined);
  const initializedRef = useRef(false);
  selectorRef.current = selector;
  equalityRef.current = isEqual;
  const getSnapshot = useCallback(() => {
    const selected = selectorRef.current(getMarketDataRecord(stableKey));
    if (initializedRef.current && equalityRef.current(selectedRef.current as T, selected)) {
      return selectedRef.current as T;
    }
    initializedRef.current = true;
    selectedRef.current = selected;
    return selected;
  }, [stableKey]);
  const subscribe = useCallback((listener: Listener) => {
    if (!enabled) return () => {};
    let previous = getSnapshot();
    return subscribeMarketData(stableKey, () => {
      const next = getSnapshot();
      if (equalityRef.current(previous, next)) return;
      previous = next;
      listener();
    });
  }, [enabled, getSnapshot, stableKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function marketDataDiagnostics() {
  return Array.from(entries.values()).map((entry) => ({
    id: entry.record.id,
    leases: entry.leases,
    demand: entry.demand,
    connected: Boolean(entry.stream),
    cached: Boolean(entry.record.snapshot),
  }));
}

export function resetMarketDataStoreForTests() {
  for (const entry of entries.values()) stopEntry(entry);
  entries.clear();
  if (hiddenTimer) clearTimeout(hiddenTimer);
  hiddenTimer = null;
  pendingNotifications.clear();
  if (storeFrame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(storeFrame);
  storeFrame = null;
}

function ensureEntry(key: MarketDataKey): Entry {
  const id = marketDataKeyId(key);
  const existing = entries.get(id);
  if (existing) return existing;
  const record: MarketDataRecord = {
    id,
    key,
    snapshot: null,
    frame: null,
    lastGoodFrame: null,
    status: "connecting",
    connected: false,
    cached: false,
    revision: 0,
    updatedAt: null,
  };
  const entry: Entry = {
    record,
    listeners: new Set(),
    leases: 0,
    stream: null,
    warmTimer: null,
    pendingSnapshot: null,
    lastAccess: Date.now(),
    demand: "dormant",
  };
  entries.set(id, entry);
  pruneCache();
  return entry;
}

function startEntry(entry: Entry) {
  if (entry.stream || (typeof document !== "undefined" && document.hidden)) return;
  const onStatus = (status: MarketDataStatus) => publish(entry, { status, connected: status === "live" || status === "fallback_polling" });
  const onSnapshot = (snapshot: MarketDataSnapshot) => {
    queueSnapshot(entry, snapshot);
  };
  const fallbackAllowed = () => entry.demand === "foreground" && (typeof document === "undefined" || !document.hidden);
  if (entry.record.key.venue === "coinbase") {
    const key = entry.record.key;
    entry.stream = createCoinbaseLiveMarketStream({
      productId: key.productId,
      interval: key.interval,
      initialSnapshot: entry.record.snapshot as CoinbaseMarketSnapshot | null,
      isDocumentHidden: () => typeof document !== "undefined" && document.hidden,
      getFallbackSnapshot: () => fallbackAllowed()
        ? fetchCoinbaseSnapshot(key.productId, key.interval)
        : cachedSnapshot<CoinbaseMarketSnapshot>(entry),
      onSnapshot: onSnapshot as (snapshot: CoinbaseMarketSnapshot) => void,
      onStatus,
    });
  } else if (entry.record.key.venue === "hyperliquid") {
    const key = entry.record.key;
    entry.stream = createHyperliquidLiveMarketStream({
      network: key.network,
      coin: key.coin,
      interval: key.interval,
      initialSnapshot: entry.record.snapshot as HyperliquidMarketSnapshot | null,
      isDocumentHidden: () => typeof document !== "undefined" && document.hidden,
      getFallbackSnapshot: () => fallbackAllowed()
        ? fetchHyperliquidSnapshot(key)
        : cachedSnapshot<HyperliquidMarketSnapshot>(entry),
      onSnapshot: onSnapshot as (snapshot: HyperliquidMarketSnapshot) => void,
      onStatus,
    });
  } else {
    const key = entry.record.key;
    entry.stream = createPhoenixLiveMarketStream({
      symbol: key.symbol,
      interval: key.interval,
      initialSnapshot: entry.record.snapshot as PhoenixMarketSnapshot | null,
      isDocumentHidden: () => typeof document !== "undefined" && document.hidden,
      getFallbackSnapshot: () => fallbackAllowed()
        ? fetchPhoenixSnapshot(key.symbol, key.interval)
        : cachedSnapshot<PhoenixMarketSnapshot>(entry),
      onSnapshot: onSnapshot as (snapshot: PhoenixMarketSnapshot) => void,
      onStatus,
    });
  }
  entry.stream.start();
  publish(entry, { connected: true, cached: Boolean(entry.record.snapshot) });
}

function releaseEntry(entry: Entry) {
  entry.leases = Math.max(0, entry.leases - 1);
  entry.lastAccess = Date.now();
  if (entry.leases > 0) return;
  entry.demand = "warm";
  demoteOtherWarmEntry(entry);
  entry.warmTimer = setTimeout(() => {
    entry.warmTimer = null;
    if (entry.leases > 0) return;
    entry.demand = "dormant";
    stopEntry(entry);
    publish(entry, { connected: false, cached: Boolean(entry.record.snapshot), status: entry.record.snapshot ? "stale" : "connecting" });
    pruneCache();
  }, WARM_TTL_MS);
}

function demoteOtherWarmEntry(current: Entry) {
  for (const entry of entries.values()) {
    if (entry === current || entry.leases > 0 || entry.demand !== "warm") continue;
    if (entry.warmTimer) clearTimeout(entry.warmTimer);
    entry.warmTimer = null;
    entry.demand = "dormant";
    stopEntry(entry);
    publish(entry, { connected: false, cached: Boolean(entry.record.snapshot), status: entry.record.snapshot ? "stale" : "connecting" });
  }
}

function stopEntry(entry: Entry) {
  entry.stream?.stop();
  entry.stream = null;
}

function cachedSnapshot<T extends MarketDataSnapshot>(entry: Entry): Promise<T> {
  if (entry.record.snapshot) return Promise.resolve(entry.record.snapshot as T);
  return Promise.reject(new Error("market_data_warm_without_snapshot"));
}

function publish(entry: Entry, patch: Partial<MarketDataRecord>) {
  entry.record = { ...entry.record, ...patch, revision: entry.record.revision + 1 };
  queueNotification(entry);
}

function queueNotification(entry: Entry) {
  pendingNotifications.add(entry);
  scheduleStoreFrame();
}

function queueSnapshot(entry: Entry, snapshot: MarketDataSnapshot) {
  entry.pendingSnapshot = snapshot;
  scheduleStoreFrame();
}

function scheduleStoreFrame() {
  if (storeFrame != null) return;
  if (typeof requestAnimationFrame !== "function") {
    flushStoreFrame();
    return;
  }
  storeFrame = requestAnimationFrame(flushStoreFrame);
}

function flushStoreFrame() {
  storeFrame = null;
  for (const entry of entries.values()) {
    const snapshot = entry.pendingSnapshot;
    if (!snapshot) continue;
    entry.pendingSnapshot = null;
    const frame = frameForSnapshot(snapshot);
    entry.record = {
      ...entry.record,
      snapshot,
      frame,
      lastGoodFrame: frame ?? entry.record.lastGoodFrame,
      cached: entry.demand !== "foreground",
      updatedAt: Date.now(),
      revision: entry.record.revision + 1,
    };
    pendingNotifications.add(entry);
  }
  const queued = Array.from(pendingNotifications);
  pendingNotifications.clear();
  for (const entry of queued) {
    for (const listener of entry.listeners) listener();
  }
}

function frameForSnapshot(snapshot: MarketDataSnapshot) {
  if (snapshot.platform === "coinbase") return gholaFrameFromCoinbase(snapshot);
  if (snapshot.platform === "hyperliquid") return gholaFrameFromHyperliquid(snapshot);
  return gholaFrameFromPhoenix(snapshot);
}

function pruneCache() {
  const now = Date.now();
  const dormant = Array.from(entries.values())
    .filter((entry) => entry.leases === 0 && entry.demand === "dormant")
    .sort((a, b) => b.lastAccess - a.lastAccess);
  for (const entry of dormant) {
    const expired = now - entry.lastAccess > CACHE_TTL_MS;
    const overflow = dormant.indexOf(entry) >= MAX_CACHED_ENTRIES;
    if (!expired && !overflow) continue;
    stopEntry(entry);
    entries.delete(entry.record.id);
  }
}

function installVisibilityPolicy() {
  if (visibilityInstalled || typeof document === "undefined") return;
  visibilityInstalled = true;
  document.addEventListener("visibilitychange", () => {
    applyMarketDataVisibility(document.hidden);
  });
}

export function applyMarketDataVisibility(hidden: boolean) {
  if (hidden) {
    for (const entry of entries.values()) if (entry.leases === 0) stopEntry(entry);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      for (const entry of entries.values()) stopEntry(entry);
    }, WARM_TTL_MS);
    return;
  }
  if (hiddenTimer) clearTimeout(hiddenTimer);
  hiddenTimer = null;
  for (const entry of entries.values()) if (entry.leases > 0) startEntry(entry);
}

async function fetchCoinbaseSnapshot(productId: CoinbaseProductId, interval: CoinbaseCandleInterval) {
  const params = new URLSearchParams({ product_id: productId, interval });
  const response = await fetch(`/v1/private-account/coinbase/market-snapshot?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("coinbase_market_snapshot_unavailable");
  return response.json() as Promise<CoinbaseMarketSnapshot>;
}

async function fetchHyperliquidSnapshot(key: Extract<MarketDataKey, { venue: "hyperliquid" }>) {
  const params = new URLSearchParams({ network: key.network, coin: key.coin, interval: key.interval });
  const response = await fetch(`/v1/private-account/hyperliquid/market-snapshot?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("hyperliquid_market_snapshot_unavailable");
  return response.json() as Promise<HyperliquidMarketSnapshot>;
}

async function fetchPhoenixSnapshot(symbol: PhoenixMarketSymbol, interval: PhoenixCandleInterval) {
  const params = new URLSearchParams({ symbol, interval });
  const response = await fetch(`/v1/private-account/phoenix/market-snapshot?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("phoenix_market_snapshot_unavailable");
  return response.json() as Promise<PhoenixMarketSnapshot>;
}
