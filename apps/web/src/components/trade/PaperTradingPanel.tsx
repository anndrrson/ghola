"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, NotebookPen, Pencil, RotateCcw, X } from "lucide-react";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import { normalizeMarketTimestamp } from "@/lib/market-component-clock";
import {
  activatePaperKillSwitch,
  addPaperJournalNote,
  advancePaperTrading,
  cancelAllPaperOrders,
  cancelPaperOrder,
  createPaperTradingState,
  evaluatePaperOrderRisk,
  exportPaperTradingJournal,
  paperAccountSummary,
  paperPositionKey,
  paperTradingStorageKey,
  paperRiskMetrics,
  parsePaperTradingState,
  placePaperOrder,
  rearmPaperRiskControl,
  replacePaperOrder,
  resetPaperTradingState,
  serializePaperTradingState,
  updatePaperRiskPolicy,
  updatePaperOcoDefaults,
  updatePaperTradingAssumptions,
  validatePaperAttachedOco,
  PAPER_TRADING_STATE_VERSION,
  PAPER_TRADING_HISTORY_CAP,
  type PaperOrder,
  type PaperOrderInput,
  type PaperOrderStatus,
  type PaperOrderType,
  type MarkedPaperPosition,
  type PaperRiskDecision,
  type PaperRiskMetrics,
  type PaperRiskPolicy,
  type PaperTradingState,
  type PaperTimeInForce,
} from "@/lib/paper-trading-engine";
import {
  createLatestStatePersistence,
  type LatestStatePersistence,
} from "@/lib/latest-state-persistence";
import { deriveTerminalPerformance, type TerminalPerformanceMetrics } from "@/lib/terminal-performance";
import { PaperRiskDesk } from "@/components/trade/PaperRiskDesk";
import { PaperExecutionAnalytics } from "@/components/trade/PaperExecutionAnalytics";
import { PaperRealizedCurve } from "@/components/trade/PaperRealizedCurve";
import {
  createTerminalPaperMarkRefreshRequest,
  restoreTerminalPaperPositionMark,
  terminalPaperMarkRefreshComplete,
  type TerminalPaperMarketTarget,
  type TerminalPaperMarkRefreshRequest,
} from "@/lib/terminal-paper-risk-desk";

export interface PaperTradingPanelProps {
  persistenceScope: string | null;
  frame: GholaMarketFrame | null;
  venueId: "hyperliquid" | "phoenix" | "coinbase";
  network: "mainnet" | "testnet";
  product: string;
  side: "buy" | "sell";
  limitPrice: number | null;
  quoteNotionalUsd: number;
  stopLevel: number | null;
  targetPrice: number | null;
  targetRewardMultiple: 1 | 1.5 | 2 | 3;
  marketDataLive: boolean;
  marketMaxAgeMs: number;
  onSelectMarkMarket: (target: TerminalPaperMarketTarget) => boolean;
}

const INITIAL_TIME = "1970-01-01T00:00:00.000Z";
const PAPER_PERSISTENCE_DELAY_MS = 500;
const PAPER_PERSISTENCE_IDLE_TIMEOUT_MS = 250;
const PAPER_BBO_BLOCKED_MESSAGE = "A fresh, uncrossed executable BBO from the exact market is required for PAPER placement or replacement.";

type PaperStorageBlock =
  | { reason: "corrupt" | "future"; raw: string }
  | { reason: "conflict"; raw: string | null };

export type PaperStorageLoadResult =
  | { status: "absent" }
  | { status: "ready"; state: PaperTradingState }
  | { status: "blocked"; block: PaperStorageBlock };

export function classifyPaperTradingStorage(raw: string | null): PaperStorageLoadResult {
  if (raw === null) return { status: "absent" };
  const state = parsePaperTradingState(raw);
  if (state) return { status: "ready", state };
  let reason: PaperStorageBlock["reason"] = "corrupt";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed != null
      && typeof parsed === "object"
      && Number.isInteger((parsed as { version?: unknown }).version)
      && Number((parsed as { version?: unknown }).version) > PAPER_TRADING_STATE_VERSION
    ) reason = "future";
  } catch {
    // Invalid JSON is preserved as corrupt storage.
  }
  return { status: "blocked", block: { reason, raw } };
}

export function replaceBlockedPaperTradingStorage(input: {
  confirmed: boolean;
  now: string;
  write: (serialized: string) => void;
}) {
  if (!input.confirmed) return null;
  const state = createPaperTradingState({ now: input.now });
  input.write(serializePaperTradingState(state));
  return state;
}

export function paperStorageValuesConflict(expectedRaw: string | null, currentRaw: string | null) {
  return expectedRaw !== currentRaw;
}

type IdlePersistenceWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdlePersistence(callback: () => void, delayMs: number) {
  const browser = window as IdlePersistenceWindow;
  let cancelled = false;
  let idleHandle: number | null = null;
  const timerHandle = browser.setTimeout(() => {
    if (cancelled) return;
    if (browser.requestIdleCallback) {
      idleHandle = browser.requestIdleCallback(() => {
        if (cancelled) return;
        cancelled = true;
        callback();
      }, { timeout: PAPER_PERSISTENCE_IDLE_TIMEOUT_MS });
      return;
    }
    cancelled = true;
    callback();
  }, delayMs);
  return () => {
    if (cancelled) return;
    cancelled = true;
    browser.clearTimeout(timerHandle);
    if (idleHandle != null) browser.cancelIdleCallback?.(idleHandle);
  };
}

export function PaperTradingPanel({
  persistenceScope,
  frame,
  venueId,
  network,
  product,
  side,
  limitPrice,
  quoteNotionalUsd,
  stopLevel,
  targetPrice,
  targetRewardMultiple,
  marketDataLive,
  marketMaxAgeMs,
  onSelectMarkMarket,
}: PaperTradingPanelProps) {
  const storageKey = paperTradingStorageKey(persistenceScope);
  const [state, setState] = useState<PaperTradingState>(() => createPaperTradingState({ now: INITIAL_TIME }));
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("Browser-only simulation. No order leaves this device.");
  const [paperAnnouncement, setPaperAnnouncement] = useState("");
  const [markRefreshRequest, setMarkRefreshRequest] = useState<TerminalPaperMarkRefreshRequest | null>(null);
  const [note, setNote] = useState("");
  const [paperOrderType, setPaperOrderType] = useState<PaperOrderType>("limit");
  const [paperTimeInForce, setPaperTimeInForce] = useState<PaperTimeInForce>("GTC");
  const [paperReduceOnly, setPaperReduceOnly] = useState(false);
  const [paperLimitOverride, setPaperLimitDraft] = useState<string | null>(null);
  const [paperStopOverride, setPaperStopDraft] = useState<string | null>(null);
  const [paperTrailDraft, setPaperTrailDraft] = useState("100");
  const [paperNotionalOverride, setPaperNotionalDraft] = useState<string | null>(null);
  const [amendingOrderId, setAmendingOrderId] = useState<string | null>(null);
  const [paperCloseNowMs, setPaperCloseNowMs] = useState(0);
  const [storageBlock, setStorageBlock] = useState<PaperStorageBlock | null>(null);
  const [persistenceGeneration, setPersistenceGeneration] = useState(0);
  const lifecycleStatusesRef = useRef<Map<string, PaperOrderStatus> | null>(null);
  const suppressedLifecycleTransitionsRef = useRef(new Set<string>());
  const persistenceRef = useRef<LatestStatePersistence<PaperTradingState> | null>(null);
  const persistenceInitializedRef = useRef(false);
  const latestStateRef = useRef(state);
  const loadedRef = useRef(loaded);
  const persistenceAllowedRef = useRef(false);
  const storageBlockRef = useRef<PaperStorageBlock | null>(storageBlock);
  const expectedStorageRawRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    latestStateRef.current = state;
    loadedRef.current = loaded;
    storageBlockRef.current = storageBlock;
  }, [loaded, state, storageBlock]);

  const lockForStorageConflict = useCallback((raw: string | null) => {
    const blocked: PaperStorageBlock = { reason: "conflict", raw };
    persistenceAllowedRef.current = false;
    persistenceRef.current?.dispose({ flush: false });
    persistenceRef.current = null;
    storageBlockRef.current = blocked;
    expectedStorageRawRef.current = raw;
    const conflict = "Another tab changed this PAPER account. This tab stopped before overwriting stored orders, fills, positions, or journal history.";
    setStorageBlock(blocked);
    setMessage(conflict);
    setPaperAnnouncement(conflict);
  }, []);

  useEffect(() => {
    if (!storageKey) {
      persistenceAllowedRef.current = false;
      persistenceInitializedRef.current = false;
      persistenceRef.current = null;
      return;
    }
    const activeStorageKey = storageKey;
    persistenceAllowedRef.current = loadedRef.current && storageBlockRef.current == null;
    persistenceInitializedRef.current = false;
    const persistence = createLatestStatePersistence<PaperTradingState>({
      delayMs: PAPER_PERSISTENCE_DELAY_MS,
      schedule: scheduleIdlePersistence,
      cancel: (handle) => (handle as () => void)(),
      write(value) {
        if (!persistenceAllowedRef.current) return;
        const currentRaw = window.localStorage.getItem(activeStorageKey);
        if (paperStorageValuesConflict(expectedStorageRawRef.current, currentRaw)) {
          lockForStorageConflict(currentRaw);
          throw new Error("paper_storage_conflict");
        }
        const serialized = serializePaperTradingState(value);
        window.localStorage.setItem(activeStorageKey, serialized);
        expectedStorageRawRef.current = serialized;
      },
    });
    persistenceRef.current = persistence;
    const flushLatest = () => {
      if (!loadedRef.current || !persistenceAllowedRef.current) return;
      persistence.update(latestStateRef.current);
      persistence.flush();
    };
    window.addEventListener("pagehide", flushLatest);
    return () => {
      window.removeEventListener("pagehide", flushLatest);
      flushLatest();
      persistence.dispose();
      if (persistenceRef.current === persistence) persistenceRef.current = null;
    };
  }, [lockForStorageConflict, persistenceGeneration, storageKey]);

  useEffect(() => {
    if (!storageKey) {
      persistenceAllowedRef.current = false;
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setLoaded(false);
      });
      return () => {
        cancelled = true;
      };
    }
    let loadedStorage: PaperStorageLoadResult = { status: "absent" };
    try {
      const raw = window.localStorage.getItem(storageKey);
      expectedStorageRawRef.current = raw;
      loadedStorage = classifyPaperTradingStorage(raw);
    } catch {
      // Storage can be unavailable in private browsing; in-memory paper mode still works.
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (loadedStorage.status === "blocked") {
        persistenceAllowedRef.current = false;
        storageBlockRef.current = loadedStorage.block;
        setStorageBlock(loadedStorage.block);
        const blockedMessage = paperStorageBlockedMessage(loadedStorage.block.reason);
        setMessage(blockedMessage);
        setPaperAnnouncement(blockedMessage);
      } else {
        persistenceAllowedRef.current = true;
        storageBlockRef.current = null;
        setStorageBlock(null);
        setState(loadedStorage.status === "ready" ? loadedStorage.state : createPaperTradingState());
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    const activeStorageKey = storageKey;
    function detectExternalPaperWrite(event: StorageEvent) {
      if (event.key !== activeStorageKey || (event.storageArea && event.storageArea !== window.localStorage)) return;
      if (!paperStorageValuesConflict(expectedStorageRawRef.current, event.newValue)) return;
      lockForStorageConflict(event.newValue);
    }
    window.addEventListener("storage", detectExternalPaperWrite);
    return () => window.removeEventListener("storage", detectExternalPaperWrite);
  }, [lockForStorageConflict, storageKey]);

  useEffect(() => {
    if (!loaded || !persistenceAllowedRef.current) return;
    const persistence = persistenceRef.current;
    if (!persistence) return;
    const immediate = !persistenceInitializedRef.current;
    persistenceInitializedRef.current = true;
    persistence.update(state, { immediate });
  }, [loaded, persistenceGeneration, state]);

  useEffect(() => {
    if (!loaded) return;
    const statuses = new Map(state.orders.map((order) => [order.order_id, order.status]));
    const previous = lifecycleStatusesRef.current;
    lifecycleStatusesRef.current = statuses;
    if (!previous) return;
    const announcement = paperLifecycleAnnouncement(previous, state.orders, suppressedLifecycleTransitionsRef.current);
    if (announcement) queueMicrotask(() => setPaperAnnouncement(announcement));
  }, [loaded, state.orders]);

  useEffect(() => {
    if (!loaded || storageBlock || !frame?.fetchedAt || !marketDataLive) return;
    if (markRefreshRequest && (
      venueId !== markRefreshRequest.target.venueId ||
      network !== markRefreshRequest.target.network ||
      product !== markRefreshRequest.target.product
    )) return;
    const observedAt = new Date().toISOString();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setState((current) => markRefreshRequest
        ? restoreTerminalPaperPositionMark(current, markRefreshRequest, {
          frame,
          selectedVenueId: venueId,
          selectedNetwork: network,
          selectedProduct: product,
          marketDataLive,
          observedAt,
          maxAgeMs: marketMaxAgeMs,
        }).state
        : advancePaperTrading(current, paperObservation({
          frame,
          venueId,
          network,
          product,
          observedAt,
          marketMaxAgeMs,
        })));
    });
    return () => {
      cancelled = true;
    };
  }, [frame, loaded, markRefreshRequest, marketDataLive, marketMaxAgeMs, network, product, storageBlock, venueId]);

  useEffect(() => {
    if (!markRefreshRequest || !terminalPaperMarkRefreshComplete(
      state,
      markRefreshRequest,
      state.updated_at,
      marketMaxAgeMs,
    )) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMarkRefreshRequest((current) => current?.positionKey === markRefreshRequest.positionKey ? null : current);
      const refreshedMessage = `PAPER ${markRefreshRequest.target.product} mark refreshed from the exact live market. No order was submitted or auto-closed.`;
      setMessage(refreshedMessage);
      setPaperAnnouncement(refreshedMessage);
    });
    return () => {
      cancelled = true;
    };
  }, [markRefreshRequest, marketMaxAgeMs, state]);

  useEffect(() => {
    let cancelled = false;
    let expiryTimer: number | null = null;
    const markByKey = new Map(state.marks.map((mark) => [mark.position_key, mark]));
    const expiryTimes = state.positions
      .filter((position) => Math.abs(position.quantity_base) > 1e-12)
      .map((position) => markByKey.get(position.position_key))
      .filter((mark) => mark != null)
      .map((mark) => Math.min(Date.parse(mark.fetched_at), Date.parse(mark.observed_at)) + marketMaxAgeMs);
    const frameQuoteTimestampMs = normalizeMarketTimestamp(frame?.componentTimestamps?.quote);
    if (frameQuoteTimestampMs != null) expiryTimes.push(frameQuoteTimestampMs + marketMaxAgeMs);
    const scheduleNextExpiry = () => {
      if (cancelled) return;
      const nowMs = Date.now();
      setPaperCloseNowMs(nowMs);
      const nextExpiryAtMs = Math.min(...expiryTimes.filter((expiryAtMs) => (
        Number.isFinite(expiryAtMs) && expiryAtMs >= nowMs
      )));
      if (!Number.isFinite(nextExpiryAtMs)) return;
      expiryTimer = window.setTimeout(scheduleNextExpiry, Math.max(1, nextExpiryAtMs - nowMs + 1));
    };
    queueMicrotask(scheduleNextExpiry);
    return () => {
      cancelled = true;
      if (expiryTimer != null) window.clearTimeout(expiryTimer);
    };
  }, [frame?.componentTimestamps?.quote, marketMaxAgeMs, state.marks, state.positions]);

  const paperMarksNow = paperCloseNowMs > 0 ? new Date(paperCloseNowMs).toISOString() : state.updated_at;
  const markFreshness = useMemo(() => ({
    now: paperMarksNow,
    maxAgeMs: marketMaxAgeMs,
  }), [marketMaxAgeMs, paperMarksNow]);
  const summary = useMemo(() => paperAccountSummary(state, {}, markFreshness), [markFreshness, state]);
  const performance = useMemo(() => deriveTerminalPerformance(
    state.fills,
    {
      startingEquityUsd: state.assumptions.starting_equity_usd,
      historyAtCapacity: state.fills.length >= PAPER_TRADING_HISTORY_CAP,
    },
  ), [state.assumptions.starting_equity_usd, state.fills]);
  const riskMetrics = useMemo(() => paperRiskMetrics(state, markFreshness), [markFreshness, state]);
  const amendingOrder = amendingOrderId == null ? null : state.orders.find((order) => order.order_id === amendingOrderId) ?? null;
  const effectivePaperSide = amendingOrder?.side ?? side;
  const paperLimitDraft = paperLimitOverride ?? (limitPrice == null ? "" : String(limitPrice));
  const paperStopDraft = paperStopOverride ?? (stopLevel == null ? "" : String(stopLevel));
  const paperNotionalDraft = paperNotionalOverride ?? (quoteNotionalUsd > 0 ? String(quoteNotionalUsd) : "");
  const paperLimitPrice = positiveNumber(paperLimitDraft);
  const paperStopPrice = positiveNumber(paperStopDraft);
  const paperTrailBps = positiveNumber(paperTrailDraft);
  const paperNotionalUsd = positiveNumber(paperNotionalDraft);
  const paperReferences = paperOrderReferencePrices({
    orderType: paperOrderType,
    side: effectivePaperSide,
    limitPrice: paperLimitPrice,
    stopPrice: paperStopPrice,
    frame,
    venueId,
    network,
    product,
    marketDataLive,
    marketMaxAgeMs,
    nowMs: Date.parse(paperMarksNow),
  });
  const paperEntryReference = paperReferences.sizingReference;
  const ocoValidation = useMemo(() => validatePaperAttachedOco({
    side: effectivePaperSide,
    entry_price: paperEntryReference ?? 0,
    target_price: targetPrice,
    invalidation_price: stopLevel,
  }), [effectivePaperSide, paperEntryReference, stopLevel, targetPrice]);
  const attachedOco = useMemo(() => !paperReduceOnly && state.oco_defaults.enabled && ocoValidation.valid && stopLevel != null && targetPrice != null
    ? { target_price: targetPrice, invalidation_price: stopLevel }
    : null, [ocoValidation.valid, paperReduceOnly, state.oco_defaults.enabled, stopLevel, targetPrice]);
  const paperDraft = useMemo((): PaperOrderInput | null => {
    if (paperNotionalUsd == null || paperEntryReference == null) return null;
    return {
      venue_id: venueId,
      network,
      product,
      side: effectivePaperSide,
      order_type: paperOrderType,
      time_in_force: paperTimeInForce,
      limit_price: paperOrderType === "limit" || paperOrderType === "stop_limit" ? paperLimitPrice : null,
      stop_price: paperOrderType === "stop" || paperOrderType === "stop_limit" ? paperStopPrice : null,
      trail_offset_bps: paperOrderType === "trailing_stop" ? paperTrailBps : null,
      reference_price: paperReferences.arrivalReference,
      quote_notional_usd: paperNotionalUsd,
      base_size: paperNotionalUsd / paperEntryReference,
      reduce_only: paperReduceOnly,
      attached_oco: attachedOco,
      submitted_at: paperMarksNow,
    };
  }, [attachedOco, effectivePaperSide, network, paperEntryReference, paperLimitPrice, paperMarksNow, paperNotionalUsd, paperOrderType, paperReduceOnly, paperReferences.arrivalReference, paperStopPrice, paperTimeInForce, paperTrailBps, product, venueId]);
  const orderRisk = useMemo(() => {
    if (!paperDraft) return null;
    try {
      return evaluatePaperOrderRisk(state, paperDraft, markFreshness);
    } catch {
      return null;
    }
  }, [markFreshness, paperDraft, state]);
  const ocoReady = paperReduceOnly || !state.oco_defaults.enabled || ocoValidation.valid;
  const canPlace = loaded && marketDataLive && paperReferences.arrivalReference != null && Boolean(paperDraft && orderRisk?.allowed) && ocoReady;
  const currentPosition = state.positions.find((position) => position.position_key === paperPositionKey({
    venue_id: venueId,
    network,
    product,
  })) ?? null;
  const closePaperBlocker = paperClosePositionBlocker({
    loaded,
    frame,
    venueId,
    network,
    product,
    positionQuantity: currentPosition?.quantity_base ?? 0,
    marketDataLive,
    marketMaxAgeMs,
    nowMs: paperCloseNowMs,
  });

  const placeOrder = useCallback(() => {
    if (!canPlace || !paperDraft) {
      setMessage(state.oco_defaults.enabled && !paperReduceOnly && !ocoValidation.valid ? ocoValidation.message : "A fresh live frame and valid PAPER order fields are required.");
      return;
    }
    const now = new Date().toISOString();
    try {
      const placed = submitPaperOrderWithExecutableArrival({
        state,
        draft: paperDraft,
        amendingOrderId,
        arrivalReference: paperExecutableArrivalReference({
          side: effectivePaperSide,
          frame,
          venueId,
          network,
          product,
          marketDataLive,
          marketMaxAgeMs,
          nowMs: Date.parse(now),
        }),
        now,
        marketMaxAgeMs,
      });
      if (!placed) {
        setMessage(`PAPER order blocked: ${PAPER_BBO_BLOCKED_MESSAGE}`);
        return;
      }
      const next = frame?.fetchedAt ? advancePaperTrading(placed, paperObservation({
        frame,
        venueId,
        network,
        product,
        observedAt: now,
        marketMaxAgeMs,
      })) : placed;
      setState(next);
      setMessage(`PAPER ${effectivePaperSide.toUpperCase()} ${paperOrderTypeLabel(paperOrderType)} ${amendingOrderId ? "replaced" : "accepted"} locally.`);
      setAmendingOrderId(null);
      setPaperLimitDraft(null);
      setPaperStopDraft(null);
      setPaperNotionalDraft(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Paper risk policy rejected this order.");
    }
  }, [amendingOrderId, canPlace, effectivePaperSide, frame, marketDataLive, marketMaxAgeMs, network, ocoValidation, paperDraft, paperOrderType, paperReduceOnly, product, state, venueId]);

  function selectPaperOrderType(nextType: PaperOrderType) {
    setPaperOrderType(nextType);
    if (nextType === "market" && paperTimeInForce === "GTC") setPaperTimeInForce("IOC");
  }

  function beginAmend(orderId: string) {
    const target = state.orders.find((order) => order.order_id === orderId);
    if (!target || target.status !== "pending" || target.order_kind !== "entry" || target.oco_group_id != null) {
      setMessage("Only standalone pending PAPER orders can be amended.");
      return;
    }
    if (target.venue_id !== venueId || target.network !== network || target.product !== product) {
      setMessage(`Switch the terminal to ${target.product} on ${target.venue_id} before amending this PAPER order.`);
      return;
    }
    setAmendingOrderId(orderId);
    setPaperOrderType(target.order_type);
    setPaperTimeInForce(target.time_in_force);
    setPaperReduceOnly(target.reduce_only);
    setPaperLimitDraft(target.limit_price == null ? "" : String(target.limit_price));
    setPaperStopDraft(target.stop_price == null ? "" : String(target.stop_price));
    setPaperTrailDraft(target.trail_offset_bps == null ? "100" : String(target.trail_offset_bps));
    setPaperNotionalDraft(String(target.quote_notional_usd));
    setMessage(`Amending PAPER order ${orderId}. Replace creates a new order ID and preserves lineage.`);
  }

  function cancelAmend() {
    setAmendingOrderId(null);
    setPaperLimitDraft(null);
    setPaperStopDraft(null);
    setPaperNotionalDraft(null);
    setMessage("PAPER amendment discarded; the resting order is unchanged.");
  }

  function cancelAllOrders() {
    const pending = state.orders.filter((order) => order.status === "pending");
    if (!pending.length) return;
    if (!window.confirm(`Cancel all ${pending.length} resting PAPER orders on this device?`)) return;
    pending.forEach((order) => suppressedLifecycleTransitionsRef.current.add(`${order.order_id}:cancelled`));
    setState((current) => cancelAllPaperOrders(current, new Date().toISOString()));
    setAmendingOrderId(null);
    setMessage(`${pending.length} resting PAPER order${pending.length === 1 ? "" : "s"} cancelled locally.`);
  }

  function cancelOrder(orderId: string) {
    try {
      const target = state.orders.find((order) => order.order_id === orderId);
      const cancelledIds = target?.oco_group_id
        ? state.orders.filter((order) => order.status === "pending" && order.oco_group_id === target.oco_group_id).map((order) => order.order_id)
        : [orderId];
      cancelledIds.forEach((id) => suppressedLifecycleTransitionsRef.current.add(`${id}:cancelled`));
      setState((current) => cancelPaperOrder(current, orderId, new Date().toISOString()));
      setMessage("PAPER order cancelled locally.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Paper cancel failed.");
    }
  }

  function addNote() {
    if (!note.trim()) return;
    try {
      setState((current) => addPaperJournalNote(current, {
        message: note,
        created_at: new Date().toISOString(),
        product,
      }));
      setNote("");
      setMessage("Journal note saved on this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Note was not saved.");
    }
  }

  function updateAssumption(key: "fee_bps" | "slippage_bps", value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 500) return;
    setState((current) => updatePaperTradingAssumptions(current, { [key]: value }, new Date().toISOString()));
  }

  function setOcoEnabled(enabled: boolean) {
    try {
      const next = updatePaperOcoDefaults(state, { enabled }, new Date().toISOString());
      setState(next);
      setMessage(`Simulated PAPER OCO attachment ${enabled ? "enabled" : "disabled"} for future entries.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "OCO preference was not saved.");
    }
  }

  function updateRiskLimit(key: keyof PaperRiskPolicy, value: number) {
    try {
      const next = updatePaperRiskPolicy(state, { [key]: value }, new Date().toISOString());
      setState(next);
      setMessage("PAPER risk limits saved locally.");
      return true;
    } catch {
      setMessage("Risk limit not saved. Use positive values, 1–100 open orders, and keep the position cap at least as large as the order cap.");
      return false;
    }
  }

  function killPaperTrading() {
    if (!window.confirm("Activate the LOCAL PAPER kill switch? Exposure-increasing resting orders will be cancelled and blocked. Reduce-only protective exits remain active, and a validated reduce-only market exit can still flatten a position.")) return;
    state.orders.filter((order) => order.status === "pending" && !order.reduce_only).forEach((order) => {
      suppressedLifecycleTransitionsRef.current.add(`${order.order_id}:cancelled`);
    });
    const next = activatePaperKillSwitch(state, new Date().toISOString());
    setState(next);
    setMessage(next.risk_control.message ?? "Local PAPER kill switch activated.");
  }

  function closeCurrentPaperPosition() {
    const position = state.positions.find((item) => item.position_key === paperPositionKey({
      venue_id: venueId,
      network,
      product,
    })) ?? null;
    const beforeConfirmBlocker = paperClosePositionBlocker({
      loaded,
      frame,
      venueId,
      network,
      product,
      positionQuantity: position?.quantity_base ?? 0,
      marketDataLive,
      marketMaxAgeMs,
      nowMs: Date.now(),
    });
    if (beforeConfirmBlocker || !position || !frame) {
      setMessage(beforeConfirmBlocker ?? "Close PAPER unavailable: no current position.");
      return;
    }
    const exitSide = position.quantity_base > 0 ? "sell" : "buy";
    const baseSize = Math.abs(position.quantity_base);
    if (!window.confirm(`Close the full ${formatBase(baseSize)} ${product} PAPER position with an opposite-side reduce-only market IOC? Displayed depth may partially fill; it can never reverse the position.`)) return;
    const now = new Date().toISOString();
    const afterConfirmBlocker = paperClosePositionBlocker({
      loaded,
      frame,
      venueId,
      network,
      product,
      positionQuantity: position.quantity_base,
      marketDataLive,
      marketMaxAgeMs,
      nowMs: Date.parse(now),
    });
    const referencePrice = positiveNumber(exitSide === "sell" ? frame.bestBid : frame.bestAsk);
    if (afterConfirmBlocker || referencePrice == null) {
      setMessage(afterConfirmBlocker ?? "Close PAPER unavailable: executable top-of-book quote is missing.");
      return;
    }
    try {
      const placed = placePaperOrder(state, {
        venue_id: venueId,
        network,
        product,
        side: exitSide,
        order_type: "market",
        time_in_force: "IOC",
        reference_price: referencePrice,
        quote_notional_usd: baseSize * referencePrice,
        base_size: baseSize,
        reduce_only: true,
        submitted_at: now,
      }, { now, maxAgeMs: marketMaxAgeMs });
      const next = advancePaperTrading(placed, paperObservation({
        frame,
        venueId,
        network,
        product,
        observedAt: now,
        marketMaxAgeMs,
      }));
      const remaining = Math.abs(next.positions.find((item) => item.position_key === position.position_key)?.quantity_base ?? 0);
      setState(next);
      setMessage(remaining <= 1e-12
        ? `PAPER ${product} position closed locally; the risk latch is unchanged.`
        : `PAPER close partially filled; ${formatBase(remaining)} ${product} remains. The order cannot reverse exposure.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PAPER position close was rejected.");
    }
  }

  function rearmPaperTrading() {
    if (!window.confirm("Deliberately re-arm PAPER trading? This starts a new loss/drawdown session from current paper equity. It does not erase positions, P&L, or history.")) return;
    try {
      const next = rearmPaperRiskControl(state, { confirmed: true, rearmed_at: new Date().toISOString() });
      setState(next);
      setMessage("PAPER risk controls re-armed from current equity.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Paper risk controls were not re-armed.");
    }
  }

  function restartPaperPersistence() {
    persistenceAllowedRef.current = false;
    persistenceRef.current?.dispose({ flush: false });
    persistenceRef.current = null;
    persistenceInitializedRef.current = false;
    storageBlockRef.current = null;
    setStorageBlock(null);
    setPersistenceGeneration((current) => current + 1);
  }

  function resolvePaperStorageConflict(source: "stored" | "local") {
    if (storageBlock?.reason !== "conflict" || !storageKey) return;
    const confirmation = source === "stored"
      ? "Use the PAPER account currently stored by the other tab? Unpersisted changes in this tab will be discarded."
      : "Replace the other tab's stored PAPER account with this tab's current orders, fills, positions, and journal?";
    if (!window.confirm(confirmation)) return;
    try {
      if (source === "stored") {
        const raw = window.localStorage.getItem(storageKey);
        const loadedStorage = classifyPaperTradingStorage(raw);
        if (loadedStorage.status === "blocked") throw new Error("paper_storage_conflict_target_invalid");
        const next = loadedStorage.status === "ready" ? loadedStorage.state : createPaperTradingState();
        expectedStorageRawRef.current = raw;
        latestStateRef.current = next;
        setState(next);
      } else {
        const next = latestStateRef.current;
        const serialized = serializePaperTradingState(next);
        window.localStorage.setItem(storageKey, serialized);
        expectedStorageRawRef.current = serialized;
      }
      restartPaperPersistence();
      const resolved = source === "stored"
        ? "Loaded the PAPER account stored by the other tab. Local simulation can continue."
        : "This tab's PAPER account replaced the conflicting stored version. Local simulation can continue.";
      setMessage(resolved);
      setPaperAnnouncement(resolved);
    } catch {
      const blocked = "PAPER conflict recovery failed. Storage remains locked and no version was overwritten.";
      persistenceAllowedRef.current = false;
      setMessage(blocked);
      setPaperAnnouncement(blocked);
    }
  }

  function reset() {
    if (storageBlock) {
      if (storageBlock.reason === "conflict") return;
      if (!storageKey) return;
      const confirmed = window.confirm("Reset the preserved PAPER data? This permanently replaces the unreadable or newer raw browser payload with an empty PAPER account. This cannot be undone.");
      try {
        persistenceRef.current?.dispose({ flush: false });
        persistenceRef.current = null;
        const next = replaceBlockedPaperTradingStorage({
          confirmed,
          now: new Date().toISOString(),
          write: (serialized) => {
            window.localStorage.setItem(storageKey, serialized);
            expectedStorageRawRef.current = serialized;
          },
        });
        if (!next) return;
        latestStateRef.current = next;
        setState(next);
        restartPaperPersistence();
        const recovered = "Preserved PAPER data was explicitly reset. A new empty local PAPER account is ready.";
        setMessage(recovered);
        setPaperAnnouncement(recovered);
      } catch {
        const blocked = "PAPER reset failed because browser storage could not be replaced. The original raw payload remains preserved; storage stays locked.";
        persistenceAllowedRef.current = false;
        setMessage(blocked);
        setPaperAnnouncement(blocked);
      }
      return;
    }
    if (!window.confirm("Reset every paper order, fill, position, and journal entry on this device? Configured risk limits and the OCO preference stay in place; the risk session re-arms.")) return;
    setState((current) => resetPaperTradingState(current, new Date().toISOString(), { confirmed: true }));
    setMessage("Paper account reset. No venue or remote system was contacted.");
  }

  function exportJournal() {
    const blob = new Blob([exportPaperTradingJournal(state, new Date().toISOString())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ghola-paper-journal-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Paper journal exported as JSON.");
  }

  function loadPaperMarkMarket(positionKey: string, target: TerminalPaperMarketTarget) {
    const request = createTerminalPaperMarkRefreshRequest(state, positionKey);
    if (!request || !samePaperMarkTarget(request.target, target)) {
      const blocked = "PAPER mark recovery blocked: persisted market identity is not an exact supported terminal target.";
      setMessage(blocked);
      setPaperAnnouncement(blocked);
      return;
    }
    if (!onSelectMarkMarket(request.target)) {
      const blocked = `PAPER ${request.target.product} mark recovery was not loaded; no order was submitted.`;
      setMessage(blocked);
      setPaperAnnouncement(blocked);
      return;
    }
    setMarkRefreshRequest(request);
    setAmendingOrderId(null);
    setPaperLimitDraft(null);
    setPaperStopDraft(null);
    setPaperNotionalDraft(null);
    const progress = `Loading exact ${request.target.product} market on ${request.target.venueId} ${request.target.network}. Awaiting a new fresh mark; no order will be submitted or auto-closed.`;
    setMessage(progress);
    setPaperAnnouncement(progress);
  }

  if (storageBlock) {
    return (
      <section className="border-t border-rose-400/25 bg-[#06090f] px-4 py-5 sm:px-6" aria-labelledby="paper-trading-heading">
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{paperAnnouncement}</p>
        <div role="alert" className="rounded border border-rose-400/40 bg-rose-400/[0.07] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <span className="rounded border border-amber-300/45 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.16em] text-amber-200">PAPER LOCKED</span>
                <h2 id="paper-trading-heading" className="text-sm font-semibold text-[#eef1f8]">Preserved local PAPER data needs attention</h2>
              </div>
              <p className="mt-2 text-[10px] leading-5 text-rose-100">{paperStorageBlockedMessage(storageBlock.reason)}</p>
              <p className="mt-1 text-[9px] leading-4 text-[#9aa7ba]">
                {storageBlock.reason === "conflict"
                  ? "Orders, fills, mark updates, journal changes, and automatic persistence are paused until you explicitly keep the stored account or this tab's complete account."
                  : "Orders, fills, mark updates, journal changes, and automatic persistence are disabled. Reload with a compatible app version, recover the raw local-storage value manually, or explicitly reset it below."}
              </p>
            </div>
            {storageBlock.reason === "conflict" ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => resolvePaperStorageConflict("stored")} className="inline-flex h-9 items-center rounded-md border border-sky-300/45 bg-sky-300/10 px-3 text-[10px] font-semibold text-sky-100 hover:bg-sky-300/15">
                  Use stored version
                </button>
                <button type="button" onClick={() => resolvePaperStorageConflict("local")} className="inline-flex h-9 items-center rounded-md border border-amber-300/45 bg-amber-300/10 px-3 text-[10px] font-semibold text-amber-100 hover:bg-amber-300/15">
                  Keep this tab
                </button>
              </div>
            ) : (
              <button type="button" onClick={reset} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rose-400/50 bg-rose-400/10 px-3 text-[10px] font-semibold text-rose-100 hover:bg-rose-400/15">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset preserved PAPER data
              </button>
            )}
          </div>
          <p role="status" className="mt-3 min-h-4 text-[9px] leading-4 text-[#9aa7ba]">{message}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="border-t border-amber-300/20 bg-gradient-to-b from-amber-300/[0.035] to-[#06090f]" aria-labelledby="paper-trading-heading">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{paperAnnouncement}</p>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#182234] px-4 py-4 sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded border border-amber-300/45 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.16em] text-amber-200">PAPER</span>
            <h2 id="paper-trading-heading" className="text-sm font-semibold text-[#eef1f8]">Trading simulator & journal</h2>
            {!summary.portfolio_fully_priced ? (
              <span role="alert" title="Aggregate equity and P&L exclude unpriced open positions." className="rounded border border-rose-400/45 bg-rose-400/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.1em] text-rose-200">
                {summary.unpriced_position_count} MARK{summary.unpriced_position_count === 1 ? "" : "S"} UNPRICED
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[10px] text-[#7d8ba5]">Local storage · deterministic fills · zero venue submission, wallet signing, worker use, or remote mutation.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportJournal} disabled={!loaded} className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[10px] disabled:opacity-40">
            <Download className="h-3 w-3" aria-hidden /> Export JSON
          </button>
          <button type="button" onClick={reset} disabled={!loaded} className="trade-chip inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[10px] disabled:opacity-40">
            <RotateCcw className="h-3 w-3" aria-hidden /> Reset
          </button>
        </div>
      </div>

      <div className="grid gap-px bg-[#182234] xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="bg-[#070a10] p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2">
            <PaperMetric label={summary.portfolio_fully_priced ? "Equity" : "Priced equity"} value={`${formatUsd(summary.equity_usd)}${summary.portfolio_fully_priced ? "" : " · partial"}`} />
            <PaperMetric label={summary.portfolio_fully_priced ? "Net P&L" : "Priced net P&L"} value={`${formatSignedUsd(summary.net_pnl_usd)}${summary.portfolio_fully_priced ? "" : " · partial"}`} tone={summary.portfolio_fully_priced ? (summary.net_pnl_usd >= 0 ? "good" : "bad") : "neutral"} />
            <PaperMetric label={summary.portfolio_fully_priced ? "Unrealized" : "Priced unrealized"} value={`${formatSignedUsd(summary.unrealized_pnl_usd)}${summary.portfolio_fully_priced ? "" : " · partial"}`} tone={summary.portfolio_fully_priced ? (summary.unrealized_pnl_usd >= 0 ? "good" : "bad") : "neutral"} />
            <PaperMetric label="Realized net" value={formatSignedUsd(summary.realized_pnl_gross_usd - summary.fees_paid_usd)} tone={summary.realized_pnl_gross_usd - summary.fees_paid_usd >= 0 ? "good" : "bad"} />
            <PaperMetric label="Fees paid" value={formatUsd(summary.fees_paid_usd)} />
            <PaperMetric label="Pending / fills" value={`${summary.pending_order_count} / ${summary.fill_count}`} />
          </div>
          {!summary.portfolio_fully_priced ? (
            <p role="alert" className="mt-2 rounded border border-rose-400/25 bg-rose-400/[0.06] px-2.5 py-2 text-[9px] leading-4 text-rose-200">
              Portfolio totals are partial: {summary.unpriced_position_count} open position{summary.unpriced_position_count === 1 ? "" : "s"} {summary.stale_mark_count ? `stale ${summary.stale_mark_count}` : ""}{summary.missing_mark_count ? `${summary.stale_mark_count ? " · " : ""}missing ${summary.missing_mark_count}` : ""}{summary.future_mark_count ? `${summary.stale_mark_count || summary.missing_mark_count ? " · " : ""}future ${summary.future_mark_count}` : ""}. New exposure is blocked; switch to each market to refresh. Reduce-only exits remain available.
            </p>
          ) : null}

          <PaperPerformanceSummary performance={performance} />

          <PaperRiskControlPanel
            state={state}
            metrics={riskMetrics}
            orderRisk={orderRisk}
            marketDataLive={marketDataLive}
            onUpdateLimit={updateRiskLimit}
            onKill={killPaperTrading}
            onRearm={rearmPaperTrading}
          />

          <section className="mt-3 rounded border border-[#1b2638] bg-[#080c13] p-3" aria-labelledby="paper-oco-heading">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="paper-oco-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Attached simulated OCO</h3>
              <p className="mt-1 text-[9px] leading-4 text-[#738099]">Optional reduce-only target + invalidation, created only after a PAPER entry fills. First later fresh crossing cancels its sibling.</p>
              </div>
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[9px] text-[#aeb9cb]">
                <input
                  type="checkbox"
                  checked={state.oco_defaults.enabled}
                  onChange={(event) => setOcoEnabled(event.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-300"
                />
                Attach
              </label>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <PaperMetric label={`${targetRewardMultiple.toFixed(1)}R target`} value={formatPrice(targetPrice)} tone={state.oco_defaults.enabled && ocoValidation.valid ? "good" : "neutral"} />
              <PaperMetric label="Invalidation" value={formatPrice(stopLevel)} tone={state.oco_defaults.enabled && ocoValidation.valid ? "good" : "neutral"} />
            </div>
            <p role={state.oco_defaults.enabled && !ocoValidation.valid ? "alert" : "status"} className={`mt-2 text-[9px] leading-4 ${state.oco_defaults.enabled && !ocoValidation.valid ? "text-rose-300" : state.oco_defaults.enabled ? "text-emerald-300" : "text-[#738099]"}`}>
              {state.oco_defaults.enabled ? ocoValidation.message : `Off by default. Enable to mirror the analytical ${targetRewardMultiple.toFixed(1)}R target and invalidation for future PAPER entries only.`}
            </p>
          </section>

          <div className="mt-4 rounded border border-[#1b2638] bg-[#080c13] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] uppercase tracking-[0.14em] text-[#7d8ba5]">Paper order ticket</span>
              <span className="font-mono text-[9px] text-amber-200">PAPER ONLY</span>
            </div>
            {amendingOrder ? <div role="status" className="mt-2 flex items-center justify-between gap-2 rounded border border-sky-400/25 bg-sky-400/[0.06] px-2 py-1.5 text-[9px] text-sky-200"><span>Replacing {amendingOrder.order_id} · side and market locked</span><button type="button" onClick={cancelAmend} className="underline underline-offset-2">Discard</button></div> : null}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label>
                <span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#738099]">Order type</span>
                <select value={paperOrderType} onChange={(event) => selectPaperOrderType(event.target.value as PaperOrderType)} className="trade-field h-8 w-full rounded-md px-2 text-[10px] text-[#dce6f4] outline-none">
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                  <option value="stop">Stop market</option>
                  <option value="stop_limit">Stop limit</option>
                  <option value="trailing_stop">Trailing stop</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#738099]">Time in force</span>
                <select value={paperTimeInForce} onChange={(event) => setPaperTimeInForce(event.target.value as PaperTimeInForce)} className="trade-field h-8 w-full rounded-md px-2 text-[10px] text-[#dce6f4] outline-none">
                  <option value="GTC" disabled={paperOrderType === "market"}>GTC · rest</option>
                  <option value="IOC">IOC · partial/cancel</option>
                  <option value="FOK">FOK · all-or-none</option>
                </select>
              </label>
              {(paperOrderType === "limit" || paperOrderType === "stop_limit") ? <PaperTicketInput label="Limit price" value={paperLimitDraft} onChange={setPaperLimitDraft} /> : null}
              {(paperOrderType === "stop" || paperOrderType === "stop_limit") ? <PaperTicketInput label="Stop trigger" value={paperStopDraft} onChange={setPaperStopDraft} /> : null}
              {paperOrderType === "trailing_stop" ? <PaperTicketInput label="Trail offset (bps)" value={paperTrailDraft} onChange={setPaperTrailDraft} min={1} max={5_000} /> : null}
              <PaperTicketInput label="Notional (USD)" value={paperNotionalDraft} onChange={setPaperNotionalDraft} />
            </div>
            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-[#182234] px-2 py-2 text-[9px] text-[#9aa7ba]">
              <input type="checkbox" checked={paperReduceOnly} onChange={(event) => setPaperReduceOnly(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-amber-300" />
              <span><b className="font-medium text-[#c7d0df]">Reduce only</b><span className="block text-[#718097]">Requires a matching position; wrong side or oversize is rejected before placement and rechecked at fill.</span></span>
            </label>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <span className={effectivePaperSide === "buy" ? "text-sm font-semibold text-emerald-300" : "text-sm font-semibold text-rose-300"}>{effectivePaperSide.toUpperCase()} {product}</span>
              <span className="font-mono text-xs tabular-nums text-[#dce6f4]">{paperNotionalUsd == null ? "-" : formatUsd(paperNotionalUsd)} · {paperOrderPriceLabel(paperOrderType, paperLimitPrice, paperStopPrice, paperTrailBps)}</span>
            </div>
            <button
              type="button"
              onClick={placeOrder}
              disabled={!canPlace}
              className={`mt-3 h-10 w-full rounded-md text-xs font-semibold tracking-[0.06em] disabled:cursor-not-allowed disabled:border-[#263145] disabled:bg-[#101620] disabled:text-[#738099] ${effectivePaperSide === "buy" ? "border border-emerald-400/55 bg-emerald-400/15 text-emerald-200" : "border border-rose-400/55 bg-rose-400/15 text-rose-200"}`}
            >
              {amendingOrderId ? "REPLACE" : "PLACE"} PAPER {effectivePaperSide.toUpperCase()} {paperOrderTypeLabel(paperOrderType).toUpperCase()}
            </button>
            <p
              role={paperReferences.arrivalReference == null || orderRisk && !orderRisk.allowed ? "alert" : "status"}
              className={`mt-2 text-[9px] leading-4 ${!marketDataLive || paperReferences.arrivalReference == null || !orderRisk?.allowed ? "text-rose-300" : "text-emerald-300"}`}
            >
              {!marketDataLive
                ? "Blocked: a fresh live market frame is required for paper placement and fills."
                : paperReferences.arrivalReference == null
                  ? `Blocked: ${PAPER_BBO_BLOCKED_MESSAGE}`
                : state.oco_defaults.enabled && !paperReduceOnly && !ocoValidation.valid
                  ? `Blocked: ${ocoValidation.message}`
                : orderRisk?.message ?? "Blocked: complete the required PAPER order fields."}
            </p>
            <p role="status" className="mt-2 min-h-4 text-[9px] leading-4 text-[#738099]">{message}</p>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <PaperAssumption label="Fee" value={state.assumptions.fee_bps} onChange={(value) => updateAssumption("fee_bps", value)} />
            <PaperAssumption label="Slippage" value={state.assumptions.slippage_bps} onChange={(value) => updateAssumption("slippage_bps", value)} />
          </div>
          <p className="mt-1.5 text-[9px] text-[#738099]">bps · unfavorable fill adjustment, capped at the limit. Fees reduce realized account P&L.</p>
        </div>

        <div className="min-w-0 bg-[#070a10]">
          <PaperPositions
            state={state}
            summary={summary}
            currentPositionKey={paperPositionKey({ venue_id: venueId, network, product })}
            closeBlocker={closePaperBlocker}
            onCloseCurrent={closeCurrentPaperPosition}
          />
          <PaperRiskDesk
            state={state}
            now={paperMarksNow}
            maxAgeMs={marketMaxAgeMs}
            pendingPositionKey={markRefreshRequest?.positionKey ?? null}
            onLoadMarket={loadPaperMarkMarket}
          />
          <PaperExecutionAnalytics orders={state.orders} fills={state.fills} />
          <PaperRealizedCurve assumptions={state.assumptions} fills={state.fills} positions={state.positions} />
          <PaperBlotter state={state} onCancel={cancelOrder} onAmend={beginAmend} onCancelAll={cancelAllOrders} />
          <div className="border-t border-[#182234] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">
              <NotebookPen className="h-3 w-3" aria-hidden /> Trade journal
            </div>
            <div className="mt-2 flex gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Paper trade journal note</span>
                <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addNote(); }} placeholder="Write setup, catalyst, invalidation, or review…" className="trade-field h-8 w-full rounded-md px-2.5 text-[10px] text-[#dce6f4] outline-none" />
              </label>
              <button type="button" onClick={addNote} disabled={!note.trim()} className="trade-chip h-8 rounded-md px-3 text-[10px] disabled:opacity-40">Add note</button>
            </div>
            {state.journal.length ? (
              <ol className="mt-3 grid max-h-28 gap-1 overflow-y-auto font-mono text-[9px] text-[#7d8ba5]" aria-label="Paper trade journal">
                {state.journal.slice(0, 12).map((entry) => (
                  <li key={entry.journal_id} className="flex gap-2">
                    <time className="shrink-0 text-[#718097]" dateTime={entry.created_at}>{formatTime(entry.created_at)}</time>
                    <span className="min-w-0 truncate">{entry.message}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="mt-3 text-[10px] text-[#738099]">Orders, fills, cancels, assumptions, and notes appear here.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function PaperPositions({
  state,
  summary,
  currentPositionKey,
  closeBlocker,
  onCloseCurrent,
}: {
  state: PaperTradingState;
  summary: ReturnType<typeof paperAccountSummary>;
  currentPositionKey: string;
  closeBlocker: string | null;
  onCloseCurrent: () => void;
}) {
  const positions = summary.marked_positions.filter((position) => position.quantity_base !== 0 || position.realized_pnl_gross_usd !== 0);
  return (
    <div className="border-b border-[#182234] px-4 py-3 sm:px-5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Positions</h3>
      {positions.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left font-mono text-[9px] tabular-nums">
            <thead className="text-[#718097]"><tr><th className="pb-1 font-normal">Market</th><th className="pb-1 font-normal">Position</th><th className="pb-1 text-right font-normal">Average</th><th className="pb-1 text-right font-normal">Mark / age</th><th className="pb-1 text-right font-normal">uPnL</th><th className="pb-1 text-right font-normal">Realized net</th><th className="pb-1 text-right font-normal">Action</th></tr></thead>
            <tbody>{positions.map((position) => (
              <tr key={position.position_key} className="border-t border-[#141d2e] text-[#aeb9cb]">
                <td className="py-2">{position.product}<span className="ml-1 text-[#718097]">{position.venue_id}</span></td>
                <td className={position.quantity_base >= 0 ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{position.quantity_base >= 0 ? "LONG" : "SHORT"} {formatBase(Math.abs(position.quantity_base))}</td>
                <td className="py-2 text-right">{formatPrice(position.average_entry_price)}</td>
                <td className="py-2 text-right" title={paperMarkDetail(position)}>
                  <span className="block">{formatPrice(position.mark_price)}</span>
                  <span className={`block text-[8px] ${position.mark_status === "fresh" || position.mark_status === "closed" ? "text-[#718097]" : "text-rose-300"}`}>
                    {position.mark_status.toUpperCase()} · {formatMarkAge(position.mark_age_ms)}
                  </span>
                </td>
                <td className={`py-2 text-right ${pnlTone(position.unrealized_pnl_usd)}`}>{position.unrealized_pnl_usd == null ? "UNPRICED" : formatSignedUsd(position.unrealized_pnl_usd)}</td>
                <td className={`py-2 text-right ${pnlTone(position.realized_pnl_net_usd)}`}>{formatSignedUsd(position.realized_pnl_net_usd)}</td>
                <td className="py-2 pl-2 text-right">{position.position_key === currentPositionKey && position.quantity_base !== 0 ? <button type="button" onClick={onCloseCurrent} disabled={closeBlocker != null} title={closeBlocker ?? "Full opposite-side reduce-only market IOC"} className="rounded border border-rose-400/35 bg-rose-400/[0.07] px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.08em] text-rose-200 disabled:cursor-not-allowed disabled:border-[#1b2638] disabled:bg-transparent disabled:text-[#718097]">Close PAPER</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
          {positions.some((position) => position.position_key === currentPositionKey && position.quantity_base !== 0) && closeBlocker ? (
            <p role="status" className="mt-2 text-[9px] text-amber-200/80">{closeBlocker}</p>
          ) : null}
        </div>
      ) : <p className="mt-2 text-[10px] text-[#738099]">No paper position. A fresh quote or post-submission trade must cross a resting limit.</p>}
      <span className="sr-only">{state.fills.length} paper fills</span>
    </div>
  );
}

function PaperBlotter({
  state,
  onCancel,
  onAmend,
  onCancelAll,
}: {
  state: PaperTradingState;
  onCancel: (orderId: string) => void;
  onAmend: (orderId: string) => void;
  onCancelAll: () => void;
}) {
  const pendingCount = state.orders.filter((order) => order.status === "pending").length;
  return (
    <div className="border-b border-[#182234] px-4 py-3 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Order blotter</h3>
        <button type="button" onClick={onCancelAll} disabled={!pendingCount} className="rounded border border-rose-400/25 px-2 py-1 text-[8px] uppercase tracking-[0.08em] text-rose-300 disabled:cursor-not-allowed disabled:border-[#1b2638] disabled:text-[#718097]">Cancel all ({pendingCount})</button>
      </div>
      {state.orders.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[54rem] text-left font-mono text-[9px] tabular-nums">
            <thead className="text-[#718097]"><tr><th className="pb-1 font-normal">Time</th><th className="pb-1 font-normal">Market</th><th className="pb-1 font-normal">Type / TIF</th><th className="pb-1 font-normal">Side</th><th className="pb-1 text-right font-normal">Filled / total</th><th className="pb-1 text-right font-normal">Trigger / limit</th><th className="pb-1 text-right font-normal">Avg fill</th><th className="pb-1 text-right font-normal">Fee</th><th className="pb-1 text-right font-normal">Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{state.orders.slice(0, 20).map((order) => <tr key={order.order_id} className="border-t border-[#141d2e] text-[#aeb9cb]" title={paperOrderStatusDetail(order)}><td className="py-2 text-[#738099]">{formatTime(order.submitted_at)}</td><td className="py-2">{order.product}</td><td className={`py-2 ${order.reduce_only ? "text-amber-200" : "text-[#8390a6]"}`}><span className="block">{order.order_kind === "entry" ? paperOrderTypeLabel(order.order_type).toUpperCase() : order.order_kind === "oco_target" ? "OCO TARGET" : "OCO INVALID"}</span><span className="text-[8px] text-[#738099]">{order.time_in_force}{order.reduce_only ? " · RO" : ""}</span></td><td className={order.side === "buy" ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{order.side.toUpperCase()}</td><td className="py-2 text-right">{formatBase(order.filled_base_size)} / {formatBase(order.base_size)}</td><td className="py-2 text-right">{paperOrderPriceLabel(order.order_type, order.limit_price, order.stop_price, order.trail_offset_bps)}</td><td className="py-2 text-right">{formatPrice(order.fill_price)}</td><td className="py-2 text-right">{formatUsd(order.fee_usd)}</td><td className={`py-2 text-right ${order.status === "filled" ? "text-sky-300" : order.status === "cancelled" || order.status === "replaced" ? "text-[#738099]" : "text-amber-200"}`}>{order.status.toUpperCase()}</td><td className="py-2 pl-2 text-right">{order.status === "pending" ? <span className="inline-flex"><button type="button" aria-label={`Amend paper order ${order.order_id}`} disabled={order.order_kind !== "entry" || order.oco_group_id != null} onClick={() => onAmend(order.order_id)} className="rounded p-1 text-[#7d8ba5] hover:bg-sky-400/10 hover:text-sky-300 disabled:hidden"><Pencil className="h-3 w-3" aria-hidden /></button><button type="button" aria-label={`Cancel ${order.reduce_only ? "simulated OCO group for" : "paper order"} ${order.order_id}`} onClick={() => onCancel(order.order_id)} className="rounded p-1 text-[#7d8ba5] hover:bg-rose-400/10 hover:text-rose-300"><X className="h-3 w-3" aria-hidden /></button></span> : null}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-[10px] text-[#738099]">No paper orders yet.</p>}
    </div>
  );
}

function PaperMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" }) {
  return <div className="rounded border border-[#1b2638] bg-[#080c13] px-2.5 py-2"><span className="block text-[9px] uppercase tracking-[0.12em] text-[#738099]">{label}</span><span className={`mt-1 block font-mono text-xs tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#dce6f4]"}`}>{value}</span></div>;
}

function PaperRiskControlPanel({
  state,
  metrics,
  orderRisk,
  marketDataLive,
  onUpdateLimit,
  onKill,
  onRearm,
}: {
  state: PaperTradingState;
  metrics: PaperRiskMetrics;
  orderRisk: PaperRiskDecision | null;
  marketDataLive: boolean;
  onUpdateLimit: (key: keyof PaperRiskPolicy, value: number) => boolean;
  onKill: () => void;
  onRearm: () => void;
}) {
  const stopped = state.risk_control.status !== "armed";
  const statusTone = stopped ? "border-rose-400/45 bg-rose-400/10 text-rose-200" : "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
  return (
    <section className={`mt-3 rounded border p-3 ${stopped ? "border-rose-400/35 bg-rose-400/[0.04]" : "border-[#1b2638] bg-[#080c13]"}`} aria-labelledby="paper-risk-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 id="paper-risk-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Local risk controls</h3>
            <span role="status" aria-live="polite" className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.12em] ${statusTone}`}>
              {state.risk_control.status.toUpperCase()}
            </span>
          </div>
            <p className="mt-1 text-[9px] leading-4 text-[#738099]">
            {state.risk_control.message ?? "Armed for this paper session. Breaches latch, cancel exposure-increasing orders, and preserve reduce-only exits."}
          </p>
        </div>
        {stopped ? (
          <button type="button" onClick={onRearm} className="rounded border border-amber-300/45 bg-amber-300/10 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-100 hover:bg-amber-300/15">
            Deliberately re-arm
          </button>
        ) : (
          <button type="button" onClick={onKill} className="rounded border border-rose-400/45 bg-rose-400/10 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-rose-200 hover:bg-rose-400/15">
            Local kill switch
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <RiskUsage label="Session loss" value={metrics.session_loss_usd} limit={state.risk_policy.max_session_loss_usd} />
        <RiskUsage label="Drawdown" value={metrics.drawdown_usd} limit={state.risk_policy.max_drawdown_usd} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] font-mono text-[8px] tabular-nums">
        <span className="bg-[#070a10] px-2 py-1.5 text-[#718097]">Open <b className="font-normal text-[#c1cada]">{metrics.open_order_count}/{state.risk_policy.max_open_orders}</b></span>
        <span className="bg-[#070a10] px-2 py-1.5 text-[#718097]">Order <b className="font-normal text-[#c1cada]">{orderRisk?.metrics.order_notional_usd == null ? "-" : formatUsd(orderRisk.metrics.order_notional_usd)}</b></span>
        <span className="bg-[#070a10] px-2 py-1.5 text-[#718097]">Projected <b className="font-normal text-[#c1cada]">{orderRisk?.metrics.projected_position_notional_usd == null ? "-" : formatUsd(orderRisk.metrics.projected_position_notional_usd)}</b></span>
      </div>

      <details className="mt-3 border-t border-[#182234] pt-2">
        <summary className="cursor-pointer text-[9px] font-medium text-[#8d9bb1] hover:text-[#dce6f4]">Configure local PAPER limits</summary>
        <fieldset className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <legend className="sr-only">Paper risk policy limits</legend>
          <RiskLimitInput key={`order-${state.risk_policy.max_order_notional_usd}`} label="Max order" prefix="$" value={state.risk_policy.max_order_notional_usd} min={1} max={1_000_000} step={10} onCommit={(value) => onUpdateLimit("max_order_notional_usd", value)} />
          <RiskLimitInput key={`position-${state.risk_policy.max_position_notional_usd}`} label="Max position" prefix="$" value={state.risk_policy.max_position_notional_usd} min={1} max={10_000_000} step={10} onCommit={(value) => onUpdateLimit("max_position_notional_usd", value)} />
          <RiskLimitInput key={`orders-${state.risk_policy.max_open_orders}`} label="Max open orders" value={state.risk_policy.max_open_orders} min={1} max={100} step={1} onCommit={(value) => onUpdateLimit("max_open_orders", value)} />
          <RiskLimitInput key={`loss-${state.risk_policy.max_session_loss_usd}`} label="Session loss stop" prefix="$" value={state.risk_policy.max_session_loss_usd} min={1} max={100_000_000} step={10} onCommit={(value) => onUpdateLimit("max_session_loss_usd", value)} />
          <RiskLimitInput key={`drawdown-${state.risk_policy.max_drawdown_usd}`} label="Drawdown stop" prefix="$" value={state.risk_policy.max_drawdown_usd} min={1} max={100_000_000} step={10} onCommit={(value) => onUpdateLimit("max_drawdown_usd", value)} />
        </fieldset>
        <p className="mt-2 text-[8px] leading-3 text-[#738099]">Limits persist only in this browser. Lower loss/drawdown limits can trip immediately. Changing limits never re-arms a stopped session.</p>
      </details>

      {!marketDataLive || orderRisk?.allowed === false ? (
        <p role="alert" className="mt-2 border-t border-rose-400/15 pt-2 text-[9px] leading-4 text-rose-300">
          {!marketDataLive ? "Paper entry blocked: market data is not fresh and live." : orderRisk?.message}
        </p>
      ) : null}
    </section>
  );
}

function RiskUsage({ label, value, limit }: { label: string; value: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, value / limit)) : 1;
  const tone = ratio >= 0.8 ? "bg-rose-400" : ratio >= 0.5 ? "bg-amber-300" : "bg-emerald-400";
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 font-mono text-[8px] tabular-nums text-[#718097]"><span>{label}</span><span>{formatUsd(value)} / {formatUsd(limit)}</span></div>
      <div role="progressbar" aria-label={`${label} paper risk usage`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(value, limit)} className="h-1 overflow-hidden rounded bg-[#1b2638]">
        <span className={`block h-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function RiskLimitInput({ label, prefix, value, min, max, step, onCommit }: { label: string; prefix?: string; value: number; min: number; max: number; step: number; onCommit: (value: number) => boolean }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block truncate text-[8px] uppercase tracking-[0.08em] text-[#738099]">{label}</span>
      <span className="trade-field flex h-8 items-center rounded-md px-2 text-[#738099]">
        {prefix ? <span aria-hidden className="mr-1 font-mono text-[9px]">{prefix}</span> : null}
        <input
          type="number"
          defaultValue={value}
          min={min}
          max={max}
          step={step}
          onBlur={(event) => {
            const next = Number(event.currentTarget.value);
            if (!onCommit(next)) event.currentTarget.value = String(value);
          }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="min-w-0 flex-1 bg-transparent text-right font-mono text-[9px] tabular-nums text-[#dce6f4] outline-none"
        />
      </span>
    </label>
  );
}

function PerformanceMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-[#080c13] px-2 py-1.5"><span className="block truncate text-[8px] uppercase tracking-[0.1em] text-[#738099]">{label}</span><span className="mt-0.5 block truncate font-mono text-[9px] tabular-nums text-[#aeb9cb]" title={value}>{value}</span></div>;
}

const PaperPerformanceSummary = memo(function PaperPerformanceSummary({
  performance,
}: {
  performance: TerminalPerformanceMetrics;
}) {
  if (performance.sampleStatus === "invalid") {
    return (
      <div role="alert" className="mt-3 rounded border border-rose-400/30 bg-rose-400/[0.05] px-2.5 py-2 text-[9px] leading-4 text-rose-200">
        Closed-trade performance withheld: retained fills do not reconcile to persisted realized P&amp;L or accounting arithmetic.
      </div>
    );
  }
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-[8px] uppercase tracking-[0.08em] text-[#718097]">
        <span>Closed-trade performance</span>
        <span>{performance.closedTrades.length} matched · {performance.sampleStatus === "retained_window" ? "capacity-bounded window" : "validated ledger"}</span>
      </div>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638]" aria-label="Closed paper trade performance">
        <PerformanceMetric label="Win rate" value={formatPercent(performance.winRatePct)} />
        <PerformanceMetric label="Profit factor" value={formatProfitFactor(performance.profitFactor)} />
        <PerformanceMetric label="Expectancy" value={performance.expectancyUsd == null ? "-" : formatSignedUsd(performance.expectancyUsd)} />
        <PerformanceMetric label="Max drawdown" value={`${formatUsd(performance.maxDrawdownUsd)} · ${formatPercent(performance.maxDrawdownPct)}`} />
        <PerformanceMetric label="Avg duration" value={formatDuration(performance.averageDurationMs)} />
        <PerformanceMetric label="Loss streak" value={`${performance.longestLosingStreak}`} />
      </div>
      {performance.sampleStatus === "retained_window" ? (
        <p className="mt-1 text-[8px] leading-3 text-amber-200">Metrics cover the retained average-cost fill window, not lifetime activity; every included closure reconciles to persisted realized P&amp;L.</p>
      ) : null}
    </div>
  );
});

function PaperTicketInput({
  label,
  value,
  onChange,
  min = 0.00000001,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
}) {
  return <label><span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#738099]">{label}</span><input type="number" inputMode="decimal" min={min} max={max} step="any" value={value} onChange={(event) => onChange(event.target.value)} className="trade-field h-8 w-full rounded-md px-2 text-right font-mono text-[10px] tabular-nums text-[#dce6f4] outline-none" /></label>;
}

function PaperAssumption({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label><span className="mb-1 block text-[9px] uppercase tracking-[0.12em] text-[#738099]">{label} bps</span><input type="number" min={0} max={500} step={0.5} value={value} onChange={(event) => onChange(Number(event.target.value))} className="trade-field h-8 w-full rounded-md px-2 text-right font-mono text-[10px] tabular-nums text-[#dce6f4] outline-none" /></label>;
}

function positiveNumber(value: string | number | null | undefined) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function paperStorageBlockedMessage(reason: PaperStorageBlock["reason"]) {
  if (reason === "conflict") {
    return "Another browser tab changed this PAPER account. Automatic writes stopped before this tab could overwrite that stored version. Choose which complete local account to keep.";
  }
  return reason === "future"
    ? "A newer PAPER storage version was found. This app cannot safely read it, so the raw payload was preserved unchanged."
    : "Local PAPER storage failed integrity validation. The raw payload was preserved unchanged instead of being silently replaced.";
}

export function paperOrderReferencePrices(input: {
  orderType: PaperOrderType;
  side: "buy" | "sell";
  limitPrice: number | null;
  stopPrice: number | null;
  frame: GholaMarketFrame | null;
  venueId: PaperTradingPanelProps["venueId"];
  network: PaperTradingPanelProps["network"];
  product: string;
  marketDataLive: boolean;
  marketMaxAgeMs: number;
  nowMs: number;
}) {
  const arrivalReference = paperExecutableArrivalReference(input);
  const sizingReference = input.orderType === "limit" || input.orderType === "stop_limit"
    ? input.limitPrice
    : input.orderType === "stop" ? input.stopPrice : arrivalReference;
  return { arrivalReference, sizingReference };
}

function paperExecutableArrivalReference(input: {
  side: "buy" | "sell";
  frame: GholaMarketFrame | null;
  venueId: PaperTradingPanelProps["venueId"];
  network: PaperTradingPanelProps["network"];
  product: string;
  marketDataLive: boolean;
  marketMaxAgeMs: number;
  nowMs: number;
}) {
  const frame = input.frame;
  if (
    !input.marketDataLive
    || !frame
    || frame.stale
    || frame.venue !== input.venueId
    || frame.network !== input.network
    || normalizePaperInstrument(frame.product) !== normalizePaperInstrument(input.product)
    || !Number.isFinite(input.marketMaxAgeMs)
    || input.marketMaxAgeMs <= 0
    || !Number.isFinite(input.nowMs)
  ) return null;
  const quoteTimestampMs = normalizeMarketTimestamp(frame.componentTimestamps?.quote);
  const bestBid = positiveNumber(frame.bestBid);
  const bestAsk = positiveNumber(frame.bestAsk);
  if (
    quoteTimestampMs == null
    || quoteTimestampMs > input.nowMs
    || input.nowMs - quoteTimestampMs > input.marketMaxAgeMs
    || bestBid == null
    || bestAsk == null
    || bestBid >= bestAsk
  ) {
    return null;
  }
  return input.side === "buy" ? bestAsk : bestBid;
}

export function submitPaperOrderWithExecutableArrival(input: {
  state: PaperTradingState;
  draft: PaperOrderInput;
  amendingOrderId: string | null;
  arrivalReference: number | null;
  now: string;
  marketMaxAgeMs: number;
}) {
  const arrivalReference = positiveNumber(input.arrivalReference);
  if (arrivalReference == null) return null;
  const submissionDraft = { ...input.draft, reference_price: arrivalReference };
  return input.amendingOrderId
    ? replacePaperOrder(input.state, input.amendingOrderId, submissionDraft, input.now, { now: input.now, maxAgeMs: input.marketMaxAgeMs })
    : placePaperOrder(input.state, { ...submissionDraft, submitted_at: input.now }, { now: input.now, maxAgeMs: input.marketMaxAgeMs });
}

export function paperClosePositionBlocker(input: {
  loaded: boolean;
  frame: GholaMarketFrame | null;
  venueId: PaperTradingPanelProps["venueId"];
  network: PaperTradingPanelProps["network"];
  product: string;
  positionQuantity: number;
  marketDataLive: boolean;
  marketMaxAgeMs: number;
  nowMs: number;
}) {
  if (!input.loaded) return "Close PAPER unavailable: local paper state is still loading.";
  if (!Number.isFinite(input.positionQuantity) || Math.abs(input.positionQuantity) <= 1e-12) {
    return "Close PAPER unavailable: no current position.";
  }
  const exitQuote = paperExecutableArrivalReference({
    side: input.positionQuantity > 0 ? "sell" : "buy",
    frame: input.frame,
    venueId: input.venueId,
    network: input.network,
    product: input.product,
    marketDataLive: input.marketDataLive,
    marketMaxAgeMs: input.marketMaxAgeMs,
    nowMs: input.nowMs,
  });
  return exitQuote == null
    ? `Close PAPER unavailable: ${PAPER_BBO_BLOCKED_MESSAGE}`
    : null;
}

function normalizePaperInstrument(value: string) {
  return value.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
}

function paperLifecycleAnnouncement(
  previous: Map<string, PaperOrderStatus>,
  orders: PaperOrder[],
  suppressedTransitions: Set<string>,
) {
  const transitioned = (order: PaperOrder, status: PaperOrderStatus) => {
    const key = `${order.order_id}:${status}`;
    if (!suppressedTransitions.has(key)) return true;
    suppressedTransitions.delete(key);
    return false;
  };
  const filled = orders.filter((order) =>
    order.status === "filled" && previous.get(order.order_id) !== "filled" && transitioned(order, "filled"));
  const cancelled = orders.filter((order) =>
    order.status === "cancelled" && previous.get(order.order_id) === "pending" && transitioned(order, "cancelled"));
  if (!filled.length && !cancelled.length) return "";
  const messages: string[] = [];
  if (filled.length === 1) {
    const order = filled[0];
    messages.push(`PAPER order ${order.order_id.slice(-4)}, ${paperOrderKindLabel(order)}, filled: ${order.side} ${formatBase(order.filled_base_size)} ${order.product} at ${formatPrice(order.fill_price)}.`);
  } else if (filled.length > 1) {
    messages.push(`${filled.length} PAPER orders filled, through order ${filled[filled.length - 1].order_id.slice(-4)}.`);
  }
  if (cancelled.length === 1) {
    const order = cancelled[0];
    messages.push(`PAPER order ${order.order_id.slice(-4)}, ${paperOrderKindLabel(order)}, ${order.filled_base_size > 0 ? `partially filled ${formatBase(order.filled_base_size)} then ` : ""}cancelled${order.cancel_reason ? `: ${paperCancelReasonLabel(order.cancel_reason)}` : ""}.`);
  } else if (cancelled.length > 1) {
    messages.push(`${cancelled.length} PAPER orders cancelled, through order ${cancelled[cancelled.length - 1].order_id.slice(-4)}.`);
  }
  return messages.join(" ");
}

function paperOrderKindLabel(order: PaperOrder) {
  if (order.order_kind === "oco_target") return `simulated OCO target for ${order.product}`;
  if (order.order_kind === "oco_invalidation") return `simulated OCO invalidation for ${order.product}`;
  return `${paperOrderTypeLabel(order.order_type)} entry for ${order.product}`;
}

function paperOrderTypeLabel(type: PaperOrderType) {
  if (type === "stop_limit") return "stop limit";
  if (type === "trailing_stop") return "trailing stop";
  if (type === "stop") return "stop market";
  return type;
}

function paperOrderPriceLabel(
  type: PaperOrderType,
  limitPrice: number | null,
  stopPrice: number | null,
  trailBps: number | null,
) {
  if (type === "market") return "MARKET";
  if (type === "trailing_stop") return `${trailBps == null ? "-" : formatPrice(trailBps)} bps`;
  if (type === "stop_limit") return `${formatPrice(stopPrice)} / ${formatPrice(limitPrice)}`;
  return formatPrice(type === "stop" ? stopPrice : limitPrice);
}

function paperCancelReasonLabel(reason: NonNullable<PaperOrder["cancel_reason"]>) {
  const labels: Record<NonNullable<PaperOrder["cancel_reason"]>, string> = {
    user_cancelled: "cancelled by trader",
    cancel_all: "cancel-all",
    ioc_not_marketable: "IOC not marketable",
    ioc_remainder_cancelled: "IOC remainder",
    fok_not_fillable: "FOK unavailable",
    risk_control: "risk control",
    oco_sibling: "OCO sibling",
    position_unavailable: "reduce-only position unavailable",
  };
  return labels[reason];
}

function paperOrderStatusDetail(order: PaperOrder) {
  const lineage = order.replaces_order_id
    ? ` Replaces ${order.replaces_order_id}.`
    : order.replaced_by_order_id ? ` Replaced by ${order.replaced_by_order_id}.` : "";
  const cancellation = order.cancel_reason ? ` ${paperCancelReasonLabel(order.cancel_reason)}.` : "";
  return `${paperOrderTypeLabel(order.order_type)} ${order.time_in_force}; ${formatBase(order.remaining_base_size)} remaining.${cancellation}${lineage}`;
}

function paperObservation(input: {
  frame: GholaMarketFrame;
  venueId: PaperTradingPanelProps["venueId"];
  network: PaperTradingPanelProps["network"];
  product: string;
  observedAt: string;
  marketMaxAgeMs: number;
}) {
  if (!input.frame.fetchedAt) throw new Error("paper_market_time_invalid");
  const quoteFetchedAt = paperComponentTimestampIso(input.frame.componentTimestamps?.quote);
  const bookFetchedAt = paperComponentTimestampIso(input.frame.componentTimestamps?.book);
  return {
    venue_id: input.venueId,
    network: input.network,
    product: input.product,
    market_state: "live" as const,
    fetched_at: input.frame.fetchedAt,
    quote_fetched_at: quoteFetchedAt,
    book_fetched_at: bookFetchedAt,
    observed_at: input.observedAt,
    book_revision: normalizeMarketTimestamp(input.frame.componentTimestamps?.book),
    max_age_ms: input.marketMaxAgeMs,
    best_bid: positiveNumber(input.frame.bestBid),
    best_ask: positiveNumber(input.frame.bestAsk),
    mark_price: positiveNumber(input.frame.markPrice) ?? positiveNumber(input.frame.mid),
    bids: input.frame.bids.map((level) => ({ price: positiveNumber(level.px) ?? 0, size: positiveNumber(level.sz) ?? 0 })),
    asks: input.frame.asks.map((level) => ({ price: positiveNumber(level.px) ?? 0, size: positiveNumber(level.sz) ?? 0 })),
    trades: input.frame.trades.map((trade) => ({
      id: trade.id,
      price: positiveNumber(trade.px) ?? 0,
      side: trade.side,
      time: trade.time,
      size: positiveNumber(trade.sz) ?? undefined,
    })),
  };
}

function paperComponentTimestampIso(value: unknown) {
  const timestamp = normalizeMarketTimestamp(value);
  if (timestamp == null) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function samePaperMarkTarget(left: TerminalPaperMarketTarget, right: TerminalPaperMarketTarget) {
  return left.venueId === right.venueId &&
    left.network === right.network &&
    left.market === right.market &&
    left.product === right.product;
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { minimumFractionDigits: value >= 1_000 ? 1 : 2, maximumFractionDigits: value >= 1_000 ? 1 : 4 });
}

function formatUsd(value: number) {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedUsd(value: number) {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "-" : `${value.toFixed(1)}%`;
}

function formatProfitFactor(value: number | null) {
  if (value == null) return "-";
  return Number.isFinite(value) ? value.toFixed(2) : "∞";
}

function formatDuration(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

function formatMarkAge(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "NO TIME";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

function paperMarkDetail(position: MarkedPaperPosition) {
  if (position.mark_status === "closed") return "Closed position; no live mark is required.";
  if (position.mark_status === "missing") return "No timestamped mark is available for this open position.";
  if (position.mark_status === "future") return "Mark timestamps are ahead of the local portfolio clock and are not trusted.";
  return `${position.mark_status === "fresh" ? "Fresh" : "Stale"} mark · source ${position.mark_fetched_at ?? "unknown"} · received ${position.mark_observed_at ?? "unknown"}.`;
}

function formatBase(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pnlTone(value: number | null) {
  if (value == null) return "text-[#738099]";
  return value >= 0 ? "text-emerald-300" : "text-rose-300";
}
