"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  chartPointCount,
  defaultGholaChartViewport,
  GHOLA_CHART_WORKER_VISIBLE_TIMEOUT_MS,
  GholaChartEngineState,
  gholaChartCompareFramesCanPreserveVisibleData,
  gholaChartFrameCanUseScalarPatch,
  gholaChartCompareFramesCanUseScalarPatches,
  gholaChartFrameCanPreserveVisibleData,
  gholaChartFrameGeometryCanReuse,
  gholaChartFrameScalarPatch,
  gholaChartShouldAwaitWorkerVisibleData,
  gholaChartVisibleGeometryMatches,
  gholaChartWorkerRequestIsPending,
  gholaChartWorkerResponseIsCurrent,
  nearestGholaCandle,
  nearestGholaRouteQuote,
  panGholaViewport,
  resetGholaChartViewport,
  zoomGholaViewport,
  type GholaChartViewport,
  type GholaChartVisibleData,
  type GholaChartWorkerRequest,
  type GholaChartWorkerResponse,
  type GholaChartWorkerVisibleRequest,
  type GholaDepthPoint,
} from "@/lib/ghola-chart-engine";
import {
  gholaChartDragPriceAtY,
  gholaChartPriceDragCommit,
  gholaChartPriceDragAllowed,
  gholaDraggablePriceOverlayAtY,
  type GholaChartPriceDrag,
} from "@/lib/ghola-chart-price-drag";
import {
  gholaChartFullscreenElement,
  gholaChartFullscreenSupported,
  toggleGholaChartFullscreen,
} from "@/lib/ghola-chart-fullscreen";
import {
  captureGholaReplaySource,
  defaultGholaReplayCursor,
  gholaChartSessionMarkers,
  gholaReplayFrame,
  measureGholaCandleRange,
  type GholaChartRangeMeasurement,
} from "@/lib/ghola-chart-inspection";
import {
  buildGholaVolumeProfile,
  type GholaVolumeProfile,
} from "@/lib/ghola-volume-profile";
import {
  buildGholaMultiTimeframeStructure,
  type GholaMultiTimeframeStructure,
  type GholaStructureTrend,
} from "@/lib/ghola-market-structure";
import {
  analyzeGholaOrderFlow,
  type GholaOrderFlowAnalysis,
} from "@/lib/ghola-order-flow";
import {
  calculateGholaAnchoredVwap,
  type GholaAnchoredVwap,
} from "@/lib/ghola-anchored-vwap";
import {
  calculateGholaTrendLine,
  type GholaTrendLineAnchor,
  type GholaTrendLineGeometry,
  type GholaTrendLineKind,
} from "@/lib/ghola-trend-line";
import {
  removeGholaTrendDrawing,
  redoGholaTrendDrawing,
  undoGholaTrendDrawing,
} from "@/lib/ghola-chart-trend-history";
import {
  GHOLA_CHART_DRAWING_GUEST_SCOPE,
  GHOLA_CHART_DRAWING_STORAGE_CONFLICT_REASON,
  GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON,
  GHOLA_CHART_TREND_LINE_LIMIT,
  emptyGholaChartDrawingPayload,
  emptyGholaChartDrawingStorage,
  gholaChartDrawingConcurrentScopeConflict,
  gholaChartDrawingIdentity,
  gholaChartDrawingMutationPolicy,
  gholaChartDrawingPayloadEqual,
  gholaChartDrawingPayloadForCandles,
  gholaChartDrawingRecordForIdentity,
  gholaChartDrawingScope,
  gholaChartDrawingStorageKey,
  inspectGholaChartDrawingStorage,
  reconcileGholaChartDrawingStorage,
  writeGholaChartDrawingPayload,
  writeGholaChartDrawingPayloadGuarded,
  writeGholaChartDrawingStorage,
  type GholaChartDrawingPayload,
  type GholaChartDrawingStorage,
} from "@/lib/ghola-chart-drawing-storage";
import { buildGholaMultiTimeframeConfluence } from "@/lib/ghola-multi-timeframe-confluence";
import { GholaMultiTimeframeStrip } from "./GholaMultiTimeframeStrip";
import { GholaChartInspectionStrip } from "./GholaChartInspectionStrip";
import { GholaTrendDrawingManager } from "./GholaTrendDrawingManager";
import {
  frameMidNumber,
  gholaReplaySelectionMatches,
  type GholaChartMode,
  type GholaChartOverlay,
  type GholaChartCandle,
  type GholaRouteQuotePoint,
  type GholaChartTone,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";

export interface GholaMarketChartProps {
  frame: GholaMarketFrame | null;
  mode: GholaChartMode;
  onModeChange?: (mode: GholaChartMode) => void;
  overlays?: GholaChartOverlay[];
  compareFrames?: GholaMarketFrame[];
  size?: "compact" | "large";
  height?: number | "auto";
  label?: string;
  onSelectPrice?: (price: string, side: "buy" | "sell") => void;
  onOverlayPriceCommit?: (overlayId: string, price: number) => void;
  allowedModes?: GholaChartMode[];
  studies?: GholaChartStudyId[];
  onStudiesChange?: (studies: GholaChartStudyId[]) => void;
  levels?: GholaChartOverlay[];
  onLevelsChange?: (levels: GholaChartOverlay[]) => void;
  onReplayFrameChange?: (
    frame: GholaMarketFrame | null,
    active: boolean,
    context: GholaReplayContext | null,
  ) => void;
  replayIdentityKey?: string;
  drawingPersistenceScope?: string | null;
  toolbarActions?: ReactNode;
  drawingSourceCertified?: boolean;
}

export interface GholaReplayContext {
  source: GholaMarketFrame;
  cursor: number;
  totalBars: number;
}

export type GholaChartStudyId = "ema20" | "ema50" | "vwap" | "volumeProfile" | "structure" | "orderFlow" | "multiTimeframe";

type Renderer =
  | {
      kind: "webgl";
      gl: WebGL2RenderingContext;
      program: WebGLProgram;
      position: number;
      color: number;
      lineBuffer: WebGLBuffer;
      triangleBuffer: WebGLBuffer;
    }
  | { kind: "canvas"; ctx: CanvasRenderingContext2D };

type ChartLayout = {
  width: number;
  height: number;
  dpr: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotW: number;
  plotH: number;
  min: number;
  max: number;
};

type PointerState = { x: number; y: number; active: boolean };
type DragState = { active: boolean; pointerId: number | null; startX: number; startY: number; lastX: number; moved: boolean };
type ChartInspection = {
  key: string;
  scope: string;
  kind: "candle" | "depth" | "route";
  time: number | null;
  price: number | null;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  changePct?: number;
  side?: "bid" | "ask";
  size?: number;
  cumulative?: number;
  impactPct?: number;
  slippageBps?: number;
  inputAmount?: string | null;
  outputAmount?: string | null;
};
type ChartStat = { label: string; value: string; tone?: "good" | "bad" | "neutral" };
type ChartMeasurementSelection = {
  scope: string;
  anchorIndex: number;
  targetIndex: number;
  pinned: boolean;
};
type ChartAnchoredVwapSelection = { scope: string; anchorTime: number };
type ChartTrendLineDrawing = {
  id: string;
  scope: string;
  kind: GholaTrendLineKind;
  first: GholaTrendLineAnchor;
  second: GholaTrendLineAnchor;
};
type ChartTrendLineDraft = {
  scope: string;
  kind: GholaTrendLineKind;
  first: GholaTrendLineAnchor;
};
type ChartTrendLineRender = {
  drawing: ChartTrendLineDrawing;
  geometry: GholaTrendLineGeometry;
};

const CHART_STUDIES: ReadonlyArray<{ id: GholaChartStudyId; label: string; color: string }> = [
  { id: "ema20", label: "EMA 20", color: "#5bbcff" },
  { id: "ema50", label: "EMA 50", color: "#c17cff" },
  { id: "vwap", label: "VWAP", color: "#f3c957" },
  { id: "volumeProfile", label: "Profile", color: "#32c5d2" },
  { id: "structure", label: "Structure", color: "#ff9f43" },
  { id: "orderFlow", label: "Order flow", color: "#2dd4bf" },
  { id: "multiTimeframe", label: "MTF", color: "#a7b5ff" },
];
const COMPARE_COLORS = ["#5bbcff", "#c17cff", "#ff9f43", "#f472b6", "#2dd4bf", "#a3e635"] as const;
const MAX_TREND_LINES = GHOLA_CHART_TREND_LINE_LIMIT;
const EMPTY_CHART_OVERLAYS: GholaChartOverlay[] = [];
const EMPTY_COMPARE_FRAMES: GholaMarketFrame[] = [];
const EMPTY_CHART_CANDLES: GholaChartCandle[] = [];

const COLORS = {
  bg: "#030303",
  grid: "#182028",
  axis: "#78889b",
  text: "#d2d8e2",
  bull: "#35d399",
  bear: "#f06b80",
  accent: "#56a8ff",
  warn: "#f3bd55",
  neutral: "#b394f5",
  bid: "#35d399",
  ask: "#f06b80",
};

const TONE_COLOR: Record<GholaChartTone, string> = {
  good: COLORS.bull,
  bad: COLORS.bear,
  warn: COLORS.warn,
  accent: COLORS.accent,
  neutral: COLORS.neutral,
};

export const GholaMarketChart = memo(function GholaMarketChart({
  frame,
  mode,
  onModeChange,
  overlays = EMPTY_CHART_OVERLAYS,
  compareFrames = EMPTY_COMPARE_FRAMES,
  size = "large",
  height,
  label,
  onSelectPrice,
  onOverlayPriceCommit,
  allowedModes,
  studies,
  onStudiesChange,
  levels,
  onLevelsChange,
  onReplayFrameChange,
  toolbarActions,
  replayIdentityKey,
  drawingPersistenceScope = GHOLA_CHART_DRAWING_GUEST_SCOPE,
  drawingSourceCertified = frame?.stale === false,
}: GholaMarketChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const engineRef = useRef(new GholaChartEngineState());
  const workerRef = useRef<Worker | null>(null);
  const workerHealthyRef = useRef(false);
  const workerRequestIdRef = useRef(0);
  const workerInputRevisionRef = useRef(0);
  const workerPendingRequestRef = useRef<GholaChartWorkerVisibleRequest | null>(null);
  const workerRequestWatchdogRef = useRef<{ requestId: number; timerId: number } | null>(null);
  const visibleDataRef = useRef<GholaChartVisibleData | null>(null);
  const needsVisibleDataRef = useRef(true);
  const initialHeight = typeof height === "number" ? height : size === "large" ? 520 : 280;
  const sizeRef = useRef({ width: 1, height: initialHeight });
  const viewportRef = useRef<GholaChartViewport>(defaultGholaChartViewport());
  const frameRef = useRef<GholaMarketFrame | null>(frame);
  const workerFrameInputRef = useRef<GholaMarketFrame | null>(null);
  const compareRef = useRef<GholaMarketFrame[]>(compareFrames);
  const workerCompareInputRef = useRef<GholaMarketFrame[]>([]);
  const modeRef = useRef<GholaChartMode>(mode);
  const overlayDataRef = useRef<GholaChartOverlay[]>(overlays);
  const pointerRef = useRef<PointerState>({ x: 0, y: 0, active: false });
  const dragRef = useRef<DragState>({ active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false });
  const overlayPriceDragRef = useRef<GholaChartPriceDrag | null>(null);
  const cancelledOverlayPointerRef = useRef<number | null>(null);
  const layoutRef = useRef<ChartLayout | null>(null);
  const visibleRef = useRef(true);
  const baseDirtyRef = useRef(true);
  const overlayDirtyRef = useRef(true);
  const drawPendingRef = useRef(false);
  const scheduleDrawRef = useRef<() => void>(() => {});
  const onSelectPriceRef = useRef(onSelectPrice);
  const onOverlayPriceCommitRef = useRef(onOverlayPriceCommit);
  const inspectionKeyRef = useRef<string | null>(null);
  const measurementOverlayRef = useRef<GholaChartRangeMeasurement | null>(null);
  const volumeProfileRef = useRef<GholaVolumeProfile | null>(null);
  const volumeProfileSignatureRef = useRef("off");
  const structureRef = useRef<GholaMultiTimeframeStructure | null>(null);
  const structureSignatureRef = useRef("off");
  const orderFlowRef = useRef<GholaOrderFlowAnalysis | null>(null);
  const orderFlowSignatureRef = useRef("off");
  const anchoredVwapOverlayRef = useRef<GholaAnchoredVwap | null>(null);
  const trendLineOverlayRef = useRef<ChartTrendLineRender[]>([]);
  const trendLineDraftRef = useRef<ChartTrendLineDraft | null>(null);
  const trendLineIdRef = useRef(0);
  const loadedDrawingScopeRef = useRef<string | null>(null);
  const drawingStorageRef = useRef<GholaChartDrawingStorage>(emptyGholaChartDrawingStorage());
  const storedDrawingPayloadRef = useRef<GholaChartDrawingPayload>(emptyGholaChartDrawingPayload());
  const suppressDrawingPersistRef = useRef(false);
  const drawingSourceFrameRef = useRef(frame);
  const drawingIdentityRef = useRef<ReturnType<typeof gholaChartDrawingIdentity>>(null);
  const [rendererKind, setRendererKind] = useState<"webgl" | "canvas" | "loading">("loading");
  const [engineKind, setEngineKind] = useState<"worker" | "main" | "loading">("loading");
  const [showAgentOverlays, setShowAgentOverlays] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [internalLevels, setInternalLevels] = useState<GholaChartOverlay[]>([]);
  const [internalStudies, setInternalStudies] = useState<GholaChartStudyId[]>(["vwap"]);
  const [inspection, setInspection] = useState<ChartInspection | null>(null);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [replaySource, setReplaySource] = useState<GholaMarketFrame | null>(null);
  const [replaySourceIdentityKey, setReplaySourceIdentityKey] = useState<string | null>(null);
  const [replayCursor, setReplayCursor] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [measurementMode, setMeasurementMode] = useState(false);
  const [measurementSelection, setMeasurementSelection] = useState<ChartMeasurementSelection | null>(null);
  const [volumeProfileReadout, setVolumeProfileReadout] = useState<GholaVolumeProfile | null>(null);
  const [structureReadout, setStructureReadout] = useState<GholaMultiTimeframeStructure | null>(null);
  const [orderFlowReadout, setOrderFlowReadout] = useState<GholaOrderFlowAnalysis | null>(null);
  const [anchoredVwapArmed, setAnchoredVwapArmed] = useState(false);
  const [anchoredVwapSelection, setAnchoredVwapSelection] = useState<ChartAnchoredVwapSelection | null>(null);
  const [showAnchoredVwapBands, setShowAnchoredVwapBands] = useState(true);
  const [trendLineTool, setTrendLineTool] = useState(false);
  const [trendLineKind, setTrendLineKind] = useState<GholaTrendLineKind>("segment");
  const [trendLineDraft, setTrendLineDraft] = useState<ChartTrendLineDraft | null>(null);
  const [trendLines, setTrendLines] = useState<ChartTrendLineDrawing[]>([]);
  const [undoneTrendLines, setUndoneTrendLines] = useState<ChartTrendLineDrawing[]>([]);
  const [drawingStorageBlocked, setDrawingStorageBlocked] = useState(false);
  const [drawingStorageConflict, setDrawingStorageConflict] = useState(false);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(true);
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const activeStudies = studies ?? internalStudies;
  const savedLevels = levels ?? internalLevels;
  const activeStudiesRef = useRef(activeStudies);
  const showVolumeRef = useRef(showVolume);
  const drawingIdentity = useMemo(
    () => gholaChartDrawingIdentity(frame, replayIdentityKey, drawingPersistenceScope),
    [drawingPersistenceScope, frame, replayIdentityKey],
  );
  const drawingStorageKey = gholaChartDrawingStorageKey(drawingPersistenceScope);
  const drawingScope = useMemo(
    () => drawingIdentity ? gholaChartDrawingScope(drawingIdentity) : null,
    [drawingIdentity],
  );
  const activeDrawingScope = drawingScope ?? frameScope(frame);

  const chartHeight = chartFullscreen
    ? "max(280px, calc(100dvh - 11rem))"
    : height === "auto"
      ? "clamp(280px, 55dvh, 720px)"
    : height ?? (size === "large" ? 520 : 280);
  const modes = allowedModes ?? chartModesForFrame(frame, mode);
  const replayBaseFrame = replayEnabled ? replaySource : frame;
  const maxReplayIndex = Math.max(0, (replayBaseFrame?.candles.length ?? 1) - 1);
  const replayCanStart = isReplayMode(mode) && maxReplayIndex > 0 && replayBaseFrame?.stale === false;
  const currentReplayIdentityKey = replayIdentityKey ?? frameScope(frame);
  const replayIdentityMatches = gholaReplaySelectionMatches(
    replaySource,
    frame,
    replaySourceIdentityKey,
    currentReplayIdentityKey,
    mode,
  );
  const replayActive = replayEnabled && replaySource !== null && replayIdentityMatches;
  const replayAvailable = replayEnabled || replayCanStart;
  const effectiveReplayCursor = clamp(replayCursor, 0, maxReplayIndex);
  const boundedReplayFrame = useMemo(
    () => replayActive && replaySource ? gholaReplayFrame(replaySource, effectiveReplayCursor) : null,
    [effectiveReplayCursor, replayActive, replaySource],
  );
  const chartFrame = replayActive ? boundedReplayFrame : frame;
  const chartCandles = chartFrame?.candles ?? EMPTY_CHART_CANDLES;
  const replayContext = useMemo<GholaReplayContext | null>(
    () => replayActive && replaySource
      ? { source: replaySource, cursor: effectiveReplayCursor, totalBars: replaySource.candles.length }
      : null,
    [effectiveReplayCursor, replayActive, replaySource],
  );
  const displayedOverlays = useMemo(
    () => (showAgentOverlays && !replayActive ? overlays.concat(savedLevels) : savedLevels),
    [overlays, replayActive, savedLevels, showAgentOverlays],
  );
  const inspectionScope = frameScope(chartFrame);
  const inspectionKind = chartInspectionKind(mode);
  const currentInspection = inspection?.scope === inspectionScope && inspection.kind === inspectionKind
    ? inspection
    : latestInspection(chartFrame, mode);
  const marketStats = inspectionStats(currentInspection, chartFrame, mode);
  const measurement = useMemo(() => {
    if (!measurementSelection || !chartFrame || measurementSelection.scope !== frameScope(chartFrame)) return null;
    return measureGholaCandleRange(
      chartFrame.candles,
      measurementSelection.anchorIndex,
      measurementSelection.targetIndex,
    );
  }, [chartFrame, measurementSelection]);
  const storedDrawingPayload = useMemo<GholaChartDrawingPayload>(() => ({
    anchoredVwap: anchoredVwapSelection?.scope === activeDrawingScope
      ? { anchorTime: anchoredVwapSelection.anchorTime, showBands: showAnchoredVwapBands }
      : null,
    trendLines: trendLines
      .filter((drawing) => drawing.scope === activeDrawingScope)
      .map(({ id, kind, first, second }) => ({ id, kind, first, second })),
  }), [activeDrawingScope, anchoredVwapSelection, showAnchoredVwapBands, trendLines]);
  useLayoutEffect(() => {
    storedDrawingPayloadRef.current = storedDrawingPayload;
  }, [storedDrawingPayload]);
  const revealedDrawingPayload = useMemo(
    () => gholaChartDrawingPayloadForCandles(storedDrawingPayload, chartCandles),
    [chartCandles, storedDrawingPayload],
  );
  const anchoredVwap = useMemo(() => {
    if (!revealedDrawingPayload.anchoredVwap || chartCandles.length === 0) return null;
    const anchorIndex = chartCandles.findIndex(
      (candle) => candle.t === revealedDrawingPayload.anchoredVwap?.anchorTime,
    );
    if (anchorIndex < 0) return null;
    return calculateGholaAnchoredVwap(chartCandles, anchorIndex, {
      deviationMultipliers: showAnchoredVwapBands ? [1, 2] : [],
    });
  }, [chartCandles, revealedDrawingPayload.anchoredVwap, showAnchoredVwapBands]);
  const anchoredVwapSelected = revealedDrawingPayload.anchoredVwap !== null;
  const multiTimeframeContext = useMemo(
    () => activeStudies.includes("multiTimeframe") && chartCandles.length > 0
      ? buildGholaMultiTimeframeConfluence(chartCandles)
      : null,
    [activeStudies, chartCandles],
  );
  const scopedTrendLines = useMemo<ChartTrendLineDrawing[]>(
    () => revealedDrawingPayload.trendLines.map((drawing) => ({ ...drawing, scope: activeDrawingScope })),
    [activeDrawingScope, revealedDrawingPayload.trendLines],
  );
  const scopedUndoneTrendLines = useMemo(
    () => undoneTrendLines.filter((drawing) => drawing.scope === activeDrawingScope),
    [activeDrawingScope, undoneTrendLines],
  );
  const renderedTrendLines = useMemo<ChartTrendLineRender[]>(() => {
    if (chartCandles.length === 0) return [];
    return scopedTrendLines.flatMap((drawing) => {
      const geometry = calculateGholaTrendLine(
        chartCandles,
        drawing.first,
        drawing.second,
        drawing.kind,
      );
      return geometry ? [{ drawing, geometry }] : [];
    });
  }, [chartCandles, scopedTrendLines]);
  const hiddenTrendLineCount = 0;
  const drawingMutationPolicy = gholaChartDrawingMutationPolicy({
    replayActive,
    sourceCertified: drawingSourceCertified,
    storageBlocked: drawingStorageBlocked,
  });
  const deleteTrendLine = useCallback((drawingId: string) => {
    if (!drawingMutationPolicy.allowed) return;
    const next = removeGholaTrendDrawing(
      { drawings: trendLines, redo: undoneTrendLines },
      activeDrawingScope,
      drawingId,
      MAX_TREND_LINES,
    );
    if (next.drawings === trendLines) return;
    setTrendLines(next.drawings);
    setUndoneTrendLines(next.redo);
  }, [activeDrawingScope, drawingMutationPolicy.allowed, trendLines, undoneTrendLines]);

  useEffect(() => {
    const syncFullscreen = () => {
      const root = rootRef.current;
      setFullscreenSupported(gholaChartFullscreenSupported(document, root));
      setChartFullscreen(Boolean(root && gholaChartFullscreenElement(document) === root));
    };
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
    };
  }, []);

  const handleFullscreenToggle = useCallback(async () => {
    const result = await toggleGholaChartFullscreen(document, rootRef.current);
    if (result === "failed") setFullscreenMessage("Chart focus request was denied by the browser.");
    else if (result === "unsupported") setFullscreenMessage("Chart focus is unavailable in this browser.");
    else if (result === "occupied") setFullscreenMessage("Exit the other fullscreen surface before focusing the chart.");
    else setFullscreenMessage("");
  }, []);

  useLayoutEffect(() => {
    if (drawingSourceCertified) return;
    setAnchoredVwapArmed(false);
    setTrendLineTool(false);
    setTrendLineDraft(null);
  }, [drawingSourceCertified]);

  const clearWorkerRequestWatchdog = useCallback((requestId?: number) => {
    const watchdog = workerRequestWatchdogRef.current;
    if (!watchdog || (requestId != null && watchdog.requestId !== requestId)) return false;
    window.clearTimeout(watchdog.timerId);
    workerRequestWatchdogRef.current = null;
    return true;
  }, []);
  const markVisibleDataDirty = useCallback((clearSurface = true) => {
    workerInputRevisionRef.current += 1;
    needsVisibleDataRef.current = true;
    if (clearSurface) {
      visibleDataRef.current = null;
      layoutRef.current = null;
      baseDirtyRef.current = true;
      overlayDirtyRef.current = true;
      const { width, height: currentHeight } = sizeRef.current;
      const renderer = rendererRef.current;
      if (renderer) {
        const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
        clearRendererSurface(renderer, width, currentHeight, dpr);
      }
      overlayRef.current?.getContext("2d")?.clearRect(0, 0, width, currentHeight);
    }
    scheduleDrawRef.current();
  }, []);
  const cancelOverlayPriceDrag = useCallback((suppressPointerUp: boolean) => {
    const drag = overlayPriceDragRef.current;
    if (!drag) return;
    overlayPriceDragRef.current = null;
    if (suppressPointerUp) cancelledOverlayPointerRef.current = drag.pointerId;
    const canvas = overlayRef.current;
    if (canvas?.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, []);

  // Publish the replay-bounded frame before paint so downstream risk panels
  // never render a commit containing candles beyond the replay cursor.
  useLayoutEffect(() => {
    onReplayFrameChange?.(chartFrame, replayActive, replayContext);
  }, [chartFrame, onReplayFrameChange, replayActive, replayContext]);

  useEffect(() => {
    activeStudiesRef.current = activeStudies;
    baseDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [activeStudies]);

  useEffect(() => {
    showVolumeRef.current = showVolume;
    baseDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [showVolume]);

  useEffect(() => {
    measurementOverlayRef.current = measurement;
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [measurement]);

  useEffect(() => {
    anchoredVwapOverlayRef.current = anchoredVwap;
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [anchoredVwap]);

  useEffect(() => {
    trendLineOverlayRef.current = renderedTrendLines;
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [renderedTrendLines]);

  useEffect(() => {
    trendLineDraftRef.current = trendLineDraft;
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [trendLineDraft]);

  useLayoutEffect(() => {
    drawingSourceFrameRef.current = frame;
    drawingIdentityRef.current = drawingIdentity;
  }, [drawingIdentity, frame]);

  useEffect(() => {
    if (loadedDrawingScopeRef.current === drawingScope) return;
    loadedDrawingScopeRef.current = null;
    const sourceFrame = drawingSourceFrameRef.current;
    const identity = drawingIdentityRef.current;
    let raw: string | null = null;
    let storageUnavailable = false;
    try {
      raw = drawingStorageKey ? window.localStorage.getItem(drawingStorageKey) : null;
    } catch {
      storageUnavailable = true;
    }
    const inspection = storageUnavailable
      ? { status: "blocked" as const, storage: null, raw: "storage_unavailable" }
      : inspectGholaChartDrawingStorage(raw);
    const blockedRaw = inspection.status === "blocked" ? inspection.raw : null;
    const document = inspection.storage ?? emptyGholaChartDrawingStorage();
    drawingStorageRef.current = document;
    const record = blockedRaw == null && identity && drawingScope
      ? gholaChartDrawingRecordForIdentity(document, identity)
      : null;
    const payload = record && sourceFrame
      ? gholaChartDrawingPayloadForCandles(record, sourceFrame.candles)
      : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadedDrawingScopeRef.current = drawingScope;
      suppressDrawingPersistRef.current = blockedRaw != null;
      setDrawingStorageBlocked(blockedRaw != null);
      setDrawingStorageConflict(false);
      setAnchoredVwapArmed(false);
      setTrendLineDraft(null);
      setAnchoredVwapSelection(payload?.anchoredVwap && drawingScope
        ? { scope: drawingScope, anchorTime: payload.anchoredVwap.anchorTime }
        : null);
      setShowAnchoredVwapBands(payload?.anchoredVwap?.showBands ?? true);
      setTrendLines(drawingScope
        ? (payload?.trendLines ?? []).map((drawing) => ({ ...drawing, scope: drawingScope }))
        : []);
      setUndoneTrendLines([]);
    });
    return () => { cancelled = true; };
  }, [drawingScope, drawingStorageKey]);

  useEffect(() => {
    if (
      !drawingScope
      || loadedDrawingScopeRef.current !== drawingScope
      || drawingStorageBlocked
    ) return;
    if (suppressDrawingPersistRef.current) {
      suppressDrawingPersistRef.current = false;
      return;
    }
    const sourceFrame = drawingSourceFrameRef.current;
    const identity = drawingIdentityRef.current;
    if (!sourceFrame || !identity) return;
    const result = writeGholaChartDrawingPayloadGuarded({
      storage: window.localStorage,
      identity,
      payload: storedDrawingPayload,
      candles: sourceFrame.candles,
      baseStorage: drawingStorageRef.current,
    });
    if (result.status === "written" || result.status === "unchanged") {
      drawingStorageRef.current = result.document;
      return;
    }
    if (result.status === "stale") {
      drawingStorageRef.current = result.document;
      storedDrawingPayloadRef.current = result.payload;
      suppressDrawingPersistRef.current = true;
      setDrawingStorageBlocked(false);
      setDrawingStorageConflict(false);
      setAnchoredVwapArmed(false);
      setAnchoredVwapSelection(result.payload.anchoredVwap
        ? { scope: drawingScope, anchorTime: result.payload.anchoredVwap.anchorTime }
        : null);
      setShowAnchoredVwapBands(result.payload.anchoredVwap?.showBands ?? true);
      setTrendLineTool(false);
      setTrendLineDraft(null);
      setTrendLines(result.payload.trendLines.map((drawing) => ({ ...drawing, scope: drawingScope })));
      setUndoneTrendLines([]);
      return;
    }
    setDrawingStorageBlocked(true);
    setDrawingStorageConflict(result.status === "conflict");
    setAnchoredVwapArmed(false);
    setTrendLineTool(false);
    setTrendLineDraft(null);
  }, [drawingScope, drawingStorageBlocked, storedDrawingPayload]);

  useEffect(() => {
    if (!drawingScope || !drawingStorageKey) return;
    const scope = drawingScope;
    function reconcileDrawingStorage(event: StorageEvent) {
      if (
        event.key !== drawingStorageKey
        || loadedDrawingScopeRef.current !== scope
      ) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      const identity = drawingIdentityRef.current;
      const sourceFrame = drawingSourceFrameRef.current;
      if (!identity || !sourceFrame || gholaChartDrawingScope(identity) !== scope) return;
      const nowMs = Date.now();
      const inspection = inspectGholaChartDrawingStorage(event.newValue, nowMs);
      if (inspection.status === "blocked") {
        setDrawingStorageBlocked(true);
        setDrawingStorageConflict(false);
        setAnchoredVwapArmed(false);
        setTrendLineTool(false);
        setTrendLineDraft(null);
        return;
      }
      if (gholaChartDrawingConcurrentScopeConflict({
        local: drawingStorageRef.current,
        previousValue: event.oldValue,
        incoming: inspection.storage,
        identity,
        localPayload: storedDrawingPayloadRef.current,
        nowMs,
      })) {
        setDrawingStorageBlocked(true);
        setDrawingStorageConflict(true);
        setAnchoredVwapArmed(false);
        setTrendLineTool(false);
        setTrendLineDraft(null);
        return;
      }
      const reconciliation = reconcileGholaChartDrawingStorage({
        local: drawingStorageRef.current,
        incomingValue: event.newValue,
        identity,
        candles: sourceFrame.candles,
        nowMs,
      });
      drawingStorageRef.current = reconciliation.document;
      setDrawingStorageBlocked(false);
      setDrawingStorageConflict(false);
      if (reconciliation.repairRequired) {
        writeGholaChartDrawingStorage(
          window.localStorage,
          drawingPersistenceScope,
          reconciliation.document,
          nowMs,
        );
      }
      const { payload } = reconciliation;
      if (gholaChartDrawingPayloadEqual(payload, storedDrawingPayloadRef.current)) return;
      storedDrawingPayloadRef.current = payload;
      suppressDrawingPersistRef.current = true;
      setAnchoredVwapArmed(false);
      setTrendLineDraft(null);
      setAnchoredVwapSelection(payload.anchoredVwap
        ? { scope, anchorTime: payload.anchoredVwap.anchorTime }
        : null);
      setShowAnchoredVwapBands(payload.anchoredVwap?.showBands ?? true);
      setTrendLines(payload.trendLines.map((drawing) => ({ ...drawing, scope })));
      setUndoneTrendLines([]);
    }
    window.addEventListener("storage", reconcileDrawingStorage);
    return () => window.removeEventListener("storage", reconcileDrawingStorage);
  }, [drawingPersistenceScope, drawingScope, drawingStorageKey]);

  useEffect(() => {
    if (!replayEnabled || replayIdentityMatches) return;
    queueMicrotask(() => {
      setReplayEnabled(false);
      setReplaySource(null);
      setReplaySourceIdentityKey(null);
      setReplayPlaying(false);
      setMeasurementSelection(null);
      setTrendLineDraft(null);
    });
  }, [replayEnabled, replayIdentityMatches]);

  useEffect(() => {
    if (!replayActive || !replayPlaying) return;
    const timer = window.setInterval(() => {
      setReplayCursor((current) => {
        const next = Math.min(maxReplayIndex, current + 1);
        if (next >= maxReplayIndex) queueMicrotask(() => setReplayPlaying(false));
        return next;
      });
    }, Math.max(80, Math.round(800 / replaySpeed)));
    return () => window.clearInterval(timer);
  }, [maxReplayIndex, replayActive, replayPlaying, replaySpeed]);

  const postWorker = useCallback((request: GholaChartWorkerRequest) => {
    const worker = workerRef.current;
    if (!worker || !workerHealthyRef.current) return;
    worker.postMessage(request);
  }, []);

  const requestVisibleData = useCallback(() => {
    const { width, height: h } = sizeRef.current;
    const worker = workerRef.current;
    if (worker && workerHealthyRef.current) {
      if (workerPendingRequestRef.current) {
        needsVisibleDataRef.current = true;
        return;
      }
      needsVisibleDataRef.current = false;
      workerRequestIdRef.current += 1;
      const pending = {
        id: workerRequestIdRef.current,
        inputRevision: workerInputRevisionRef.current,
      };
      workerPendingRequestRef.current = pending;
      worker.postMessage({
        id: pending.id,
        type: "visible-data",
        width,
        height: h,
      } satisfies GholaChartWorkerRequest);
      const timerId = window.setTimeout(() => {
        if (
          workerRequestWatchdogRef.current?.requestId !== pending.id
          || !gholaChartWorkerRequestIsPending(pending.id, workerPendingRequestRef.current)
        ) return;
        workerRequestWatchdogRef.current = null;
        workerPendingRequestRef.current = null;
        workerHealthyRef.current = false;
        if (workerRef.current === worker) {
          worker.terminate();
          workerRef.current = null;
        }
        setEngineKind("main");
        markVisibleDataDirty();
      }, GHOLA_CHART_WORKER_VISIBLE_TIMEOUT_MS);
      workerRequestWatchdogRef.current = { requestId: pending.id, timerId };
      return;
    }
    visibleDataRef.current = engineRef.current.visibleData({
      width,
      height: h,
      mode: modeRef.current,
      viewport: viewportRef.current,
    });
    needsVisibleDataRef.current = false;
    baseDirtyRef.current = true;
    overlayDirtyRef.current = true;
  }, [markVisibleDataDirty]);

  const commitViewport = useCallback((viewport: GholaChartViewport) => {
    viewportRef.current = viewport;
    engineRef.current.setViewport(viewport);
    postWorker({ type: "set-viewport", viewport });
    markVisibleDataDirty(false);
  }, [markVisibleDataDirty, postWorker]);

  useEffect(() => {
    let cancelled = false;
    if (typeof Worker === "undefined") {
      queueMicrotask(() => { if (!cancelled) setEngineKind("main"); });
      return () => { cancelled = true; };
    }
    try {
      const worker = new Worker(new URL("../../lib/ghola-chart-worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      workerHealthyRef.current = true;
      queueMicrotask(() => { if (!cancelled && workerRef.current === worker) setEngineKind("worker"); });
      worker.onmessage = (event: MessageEvent<GholaChartWorkerResponse>) => {
        const response = event.data;
        if (response.type === "visible-data") {
          const pending = workerPendingRequestRef.current;
          if (response.id !== pending?.id) return;
          clearWorkerRequestWatchdog(response.id);
          workerPendingRequestRef.current = null;
          if (!gholaChartWorkerResponseIsCurrent(response, pending, workerInputRevisionRef.current)) {
            if (needsVisibleDataRef.current) requestVisibleData();
            return;
          }
          visibleDataRef.current = { ...response.data, overlays: overlayDataRef.current };
          baseDirtyRef.current = true;
          overlayDirtyRef.current = true;
          if (needsVisibleDataRef.current) requestVisibleData();
          scheduleDrawRef.current();
          return;
        }
        if (response.type === "error") {
          if (response.id != null) {
            const pending = workerPendingRequestRef.current;
            if (response.id !== pending?.id) return;
            clearWorkerRequestWatchdog(response.id);
            workerPendingRequestRef.current = null;
            if (!gholaChartWorkerResponseIsCurrent(response, pending, workerInputRevisionRef.current)) {
              requestVisibleData();
              return;
            }
          }
          workerHealthyRef.current = false;
          clearWorkerRequestWatchdog();
          workerPendingRequestRef.current = null;
          setEngineKind("main");
          markVisibleDataDirty();
        }
      };
      worker.onerror = () => {
        workerHealthyRef.current = false;
        clearWorkerRequestWatchdog();
        workerPendingRequestRef.current = null;
        setEngineKind("main");
        markVisibleDataDirty();
      };
      worker.postMessage({ type: "set-frame", frame: frameRef.current } satisfies GholaChartWorkerRequest);
      worker.postMessage({ type: "set-compare", frames: compareRef.current } satisfies GholaChartWorkerRequest);
      worker.postMessage({ type: "set-mode", mode: modeRef.current } satisfies GholaChartWorkerRequest);
      worker.postMessage({ type: "set-overlays", overlays: overlayDataRef.current } satisfies GholaChartWorkerRequest);
      worker.postMessage({ type: "set-viewport", viewport: viewportRef.current } satisfies GholaChartWorkerRequest);
      markVisibleDataDirty();
      return () => {
        cancelled = true;
        workerHealthyRef.current = false;
        clearWorkerRequestWatchdog();
        workerPendingRequestRef.current = null;
        worker.terminate();
        workerRef.current = null;
      };
    } catch {
      workerHealthyRef.current = false;
      clearWorkerRequestWatchdog();
      queueMicrotask(() => { if (!cancelled) setEngineKind("main"); });
      markVisibleDataDirty();
      return () => { cancelled = true; };
    }
  }, [clearWorkerRequestWatchdog, markVisibleDataDirty, requestVisibleData]);

  useLayoutEffect(() => {
    const previousWorkerFrame = workerFrameInputRef.current;
    const scalarOnly = chartFrame && gholaChartFrameCanUseScalarPatch(previousWorkerFrame, chartFrame);
    const geometryReusable = gholaChartFrameGeometryCanReuse(previousWorkerFrame, chartFrame, modeRef.current);
    const preserveVisibleData = gholaChartFrameCanPreserveVisibleData(previousWorkerFrame, chartFrame, replayActive);
    engineRef.current.ingestFrame(chartFrame);
    frameRef.current = engineRef.current.frame();
    if (scalarOnly || geometryReusable) {
      if (scalarOnly && chartFrame) {
        postWorker({ type: "patch-frame-scalars", patch: gholaChartFrameScalarPatch(chartFrame) });
      } else {
        postWorker({ type: "set-frame", frame: chartFrame });
      }
      workerInputRevisionRef.current += 1;
      const { width, height: currentHeight } = sizeRef.current;
      const previousVisibleData = visibleDataRef.current;
      const nextVisibleData = engineRef.current.visibleData({
        width,
        height: currentHeight,
        mode: modeRef.current,
        viewport: viewportRef.current,
      });
      visibleDataRef.current = nextVisibleData;
      needsVisibleDataRef.current = false;
      layoutRef.current = null;
      baseDirtyRef.current = baseDirtyRef.current
        || !gholaChartVisibleGeometryMatches(previousVisibleData, nextVisibleData)
        || (activeStudiesRef.current.includes("orderFlow") && previousWorkerFrame?.trades !== chartFrame?.trades);
      overlayDirtyRef.current = true;
      scheduleDrawRef.current();
    } else {
      postWorker({ type: "set-frame", frame: chartFrame });
      markVisibleDataDirty(!preserveVisibleData);
    }
    workerFrameInputRef.current = chartFrame;
  }, [chartFrame, markVisibleDataDirty, postWorker, replayActive]);
  useLayoutEffect(() => {
    const previousWorkerCompare = workerCompareInputRef.current;
    const scalarOnly = gholaChartCompareFramesCanUseScalarPatches(previousWorkerCompare, compareFrames);
    compareRef.current = compareFrames;
    engineRef.current.setCompareFrames(compareFrames);
    if (scalarOnly) {
      postWorker({ type: "patch-compare-scalars", patches: compareFrames.map(gholaChartFrameScalarPatch) });
      workerInputRevisionRef.current += 1;
      const { width, height: currentHeight } = sizeRef.current;
      visibleDataRef.current = engineRef.current.visibleData({
        width,
        height: currentHeight,
        mode: modeRef.current,
        viewport: viewportRef.current,
      });
      needsVisibleDataRef.current = false;
      layoutRef.current = null;
      baseDirtyRef.current = true;
      overlayDirtyRef.current = true;
      scheduleDrawRef.current();
    } else {
      postWorker({ type: "set-compare", frames: compareFrames });
      markVisibleDataDirty(!gholaChartCompareFramesCanPreserveVisibleData(previousWorkerCompare, compareFrames, replayActive));
    }
    workerCompareInputRef.current = compareFrames;
  }, [compareFrames, markVisibleDataDirty, postWorker, replayActive]);
  useLayoutEffect(() => {
    modeRef.current = mode;
    engineRef.current.setMode(mode);
    postWorker({ type: "set-mode", mode });
    markVisibleDataDirty();
  }, [mode, markVisibleDataDirty, postWorker]);
  useLayoutEffect(() => {
    const previousOverlays = overlayDataRef.current;
    overlayDataRef.current = displayedOverlays;
    engineRef.current.setOverlays(displayedOverlays);
    postWorker({ type: "set-overlays", overlays: displayedOverlays });
    if ([...previousOverlays, ...displayedOverlays].some((overlay) => overlay.rangeBehavior === "include")) {
      markVisibleDataDirty(false);
      return;
    }
    const visibleData = visibleDataRef.current;
    if (visibleData) visibleDataRef.current = { ...visibleData, overlays: displayedOverlays };
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, [displayedOverlays, markVisibleDataDirty, postWorker]);
  useEffect(() => {
    onSelectPriceRef.current = onSelectPrice;
  }, [onSelectPrice]);
  useEffect(() => {
    onOverlayPriceCommitRef.current = onOverlayPriceCommit;
  }, [onOverlayPriceCommit]);
  useEffect(() => {
    const drag = overlayPriceDragRef.current;
    if (
      drag
      && (
        !onOverlayPriceCommit
        || !gholaChartPriceDragAllowed(mode, replayActive)
        || !displayedOverlays.some((overlay) => overlay.id === drag.overlayId)
      )
    ) {
      cancelOverlayPriceDrag(true);
    }
  }, [cancelOverlayPriceDrag, displayedOverlays, mode, onOverlayPriceCommit, replayActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    setRendererKind(renderer.kind);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width, height: h };
      for (const target of [canvas, overlay]) {
        target.width = Math.floor(width * dpr);
        target.height = Math.floor(h * dpr);
      }
      if (rendererRef.current?.kind === "canvas") {
        rendererRef.current.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const overlayCtx = overlay.getContext("2d");
      overlayCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      markVisibleDataDirty();
    };

    const draw = () => {
      drawPendingRef.current = false;
      if (document.hidden || !visibleRef.current) return;
      const rendererState = rendererRef.current;
      const overlayCtx = overlay.getContext("2d");
      if (!rendererState || !overlayCtx) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width, height: h };
      if (needsVisibleDataRef.current || !visibleDataRef.current) requestVisibleData();
      if (gholaChartShouldAwaitWorkerVisibleData(
        Boolean(workerRef.current && workerHealthyRef.current),
        visibleDataRef.current !== null,
      )) {
        clearRendererSurface(rendererState, width, h, dpr);
        overlayCtx.clearRect(0, 0, width, h);
        return;
      }
      const visibleData = visibleDataRef.current ?? engineRef.current.visibleData({
        width,
        height: h,
        mode: modeRef.current,
        viewport: viewportRef.current,
      });
      const layout = buildLayout(width, h, dpr, visibleData.range);
      layoutRef.current = layout;
      const shouldDrawBase = baseDirtyRef.current;
      const shouldDrawOverlay = shouldDrawBase || overlayDirtyRef.current;
      if (shouldDrawBase) {
        const profileCandles = visibleData.frame?.candles ?? [];
        const sourceCandles = frameRef.current?.candles ?? [];
        const volumeProfile = isPriceMode(visibleData.mode) && activeStudiesRef.current.includes("volumeProfile")
          ? buildGholaVolumeProfile(profileCandles, volumeProfileBinCount(layout))
          : null;
        volumeProfileRef.current = volumeProfile;
        const profileSignature = volumeProfileSignature(volumeProfile, profileCandles);
        if (volumeProfileSignatureRef.current !== profileSignature) {
          volumeProfileSignatureRef.current = profileSignature;
          setVolumeProfileReadout(volumeProfile);
        }
        const structure = isPriceMode(visibleData.mode) && activeStudiesRef.current.includes("structure")
          ? buildGholaMultiTimeframeStructure(sourceCandles)
          : null;
        structureRef.current = structure;
        const nextStructureSignature = structureSignature(structure);
        if (structureSignatureRef.current !== nextStructureSignature) {
          structureSignatureRef.current = nextStructureSignature;
          setStructureReadout(structure);
        }
        const orderFlow = isPriceMode(visibleData.mode) && activeStudiesRef.current.includes("orderFlow")
          ? analyzeGholaOrderFlow(sourceCandles, frameRef.current?.trades ?? [])
          : null;
        orderFlowRef.current = orderFlow;
        const nextOrderFlowSignature = orderFlowSignature(orderFlow);
        if (orderFlowSignatureRef.current !== nextOrderFlowSignature) {
          orderFlowSignatureRef.current = nextOrderFlowSignature;
          setOrderFlowReadout(orderFlow);
        }
        if (rendererState.kind === "webgl") {
          drawWebGl(
            rendererState,
            layout,
            visibleData,
            activeStudiesRef.current,
            showVolumeRef.current,
            sourceCandles,
            volumeProfile,
          );
        } else {
          drawCanvas(
            rendererState.ctx,
            layout,
            visibleData,
            activeStudiesRef.current,
            showVolumeRef.current,
            sourceCandles,
            volumeProfile,
          );
        }
        baseDirtyRef.current = false;
      }
      if (shouldDrawOverlay) {
        drawOverlay(
          overlayCtx,
          layout,
          visibleData,
          pointerRef.current,
          measurementOverlayRef.current,
          volumeProfileRef.current,
          structureRef.current,
          orderFlowRef.current,
          anchoredVwapOverlayRef.current,
          trendLineOverlayRef.current,
          trendLineDraftRef.current,
          frameRef.current?.candles ?? [],
          overlayPriceDragRef.current,
        );
        overlayDirtyRef.current = false;
      }
    };

    let raf = 0;
    const scheduleDraw = () => {
      if (drawPendingRef.current) return;
      drawPendingRef.current = true;
      raf = requestAnimationFrame(draw);
    };
    scheduleDrawRef.current = scheduleDraw;
    const ro = new ResizeObserver(() => {
      resize();
      baseDirtyRef.current = true;
      overlayDirtyRef.current = true;
      scheduleDraw();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver((entries) => {
      visibleRef.current = entries.some((entry) => entry.isIntersecting) && !document.hidden;
      if (visibleRef.current) scheduleDraw();
    });
    io.observe(canvas);
    const onVisibility = () => {
      visibleRef.current = !document.hidden;
      if (visibleRef.current) scheduleDraw();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      rendererRef.current = null;
      setRendererKind("loading");
      baseDirtyRef.current = true;
      overlayDirtyRef.current = true;
    };
    const onContextRestored = () => {
      const restored = createRenderer(canvas);
      rendererRef.current = restored;
      setRendererKind(restored.kind);
      resize();
      baseDirtyRef.current = true;
      overlayDirtyRef.current = true;
      scheduleDraw();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const layout = layoutRef.current;
      if (event.shiftKey) {
        const sampleCount = chartPointCount(frameRef.current, modeRef.current);
        commitViewport(panGholaViewport(viewportRef.current, -event.deltaY, rect.width, sampleCount));
        return;
      }
      const factor = clamp(Math.exp(-event.deltaY * 0.0015), 0.72, 1.38);
      const left = layout?.left ?? 0;
      const plotW = layout?.plotW ?? rect.width;
      commitViewport(zoomGholaViewport(viewportRef.current, factor, event.clientX - rect.left - left, plotW));
    };
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    overlay.addEventListener("wheel", onWheel, { passive: false });
    resize();
    scheduleDraw();

    return () => {
      cancelAnimationFrame(raf);
      scheduleDrawRef.current = () => {};
      drawPendingRef.current = false;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      overlay.removeEventListener("wheel", onWheel);
      if (rendererRef.current) cleanupRenderer(rendererRef.current);
      rendererRef.current = null;
    };
  }, [commitViewport, markVisibleDataDirty, requestVisibleData]);

  function updateInspection(pointer: PointerState) {
    const data = visibleDataRef.current;
    const layout = layoutRef.current;
    if (!data || !layout || !pointer.active) return null;
    const next = inspectionAtPointer(data, pointer, layout);
    if (!next) return null;
    const scopedKey = `${next.scope}:${next.key}`;
    if (scopedKey !== inspectionKeyRef.current) {
      inspectionKeyRef.current = scopedKey;
      setInspection(next);
    }
    return next;
  }

  function updatePointer(pointer: PointerState) {
    pointerRef.current = pointer;
    const next = updateInspection(pointer);
    if (next?.kind === "candle" && measurementMode && measurementSelection && !measurementSelection.pinned) {
      const targetIndex = candleIndexForInspection(frameRef.current, next);
      if (targetIndex >= 0 && targetIndex !== measurementSelection.targetIndex) {
        setMeasurementSelection({ ...measurementSelection, targetIndex });
      }
    }
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
    return next;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    updatePointer({
      x: event.clientX - rect.left,
      y,
      active: true,
    });
    const overlayDrag = overlayPriceDragRef.current;
    if (overlayDrag?.pointerId === event.pointerId) {
      const layout = layoutRef.current;
      if (layout) {
        const price = gholaChartDragPriceAtY(y, chartPricePlot(layout));
        if (price != null) overlayPriceDragRef.current = { ...overlayDrag, price };
      }
      overlayDirtyRef.current = true;
      scheduleDrawRef.current();
      event.preventDefault();
      return;
    }
    const drag = dragRef.current;
    if (drag.active && drag.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.lastX;
      const moved = drag.moved || Math.abs(event.clientX - drag.startX) > 4 || Math.abs(event.clientY - drag.startY) > 4;
      dragRef.current = { ...drag, lastX: event.clientX, moved };
      if (moved) {
        const sampleCount = chartPointCount(frameRef.current, modeRef.current);
        commitViewport(panGholaViewport(viewportRef.current, deltaX, rect.width, sampleCount));
      }
    }
  }

  function handlePointerLeave() {
    inspectionKeyRef.current = null;
    setInspection(null);
    updatePointer({ ...pointerRef.current, active: false });
  }

  function handleChartBlur() {
    cancelOverlayPriceDrag(true);
    dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
    handlePointerLeave();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || overlayPriceDragRef.current) return;
    cancelledOverlayPointerRef.current = null;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    updatePointer({
      x,
      y,
      active: true,
    });
    const layout = layoutRef.current;
    const draggable = layout
      && x >= layout.left
      && x <= layout.left + layout.plotW
      && !trendLineTool
      && !anchoredVwapArmed
      && !measurementMode
      && onOverlayPriceCommitRef.current
      ? gholaDraggablePriceOverlayAtY(
          overlayDataRef.current,
          y,
          chartPricePlot(layout),
          modeRef.current,
          replayActive,
        )
      : null;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startPointerPrice = layout
      ? gholaChartDragPriceAtY(y, chartPricePlot(layout))
      : null;
    if (draggable?.price != null && startPointerPrice != null) {
      dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
      overlayPriceDragRef.current = {
        overlayId: draggable.id,
        pointerId: event.pointerId,
        startPointerY: y,
        startPointerPrice,
        price: draggable.price,
      };
      event.preventDefault();
      return;
    }
    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      moved: false,
    };
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (cancelledOverlayPointerRef.current === event.pointerId) {
      cancelledOverlayPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      return;
    }
    const overlayDrag = overlayPriceDragRef.current;
    if (overlayDrag) {
      if (overlayDrag.pointerId !== event.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const layout = layoutRef.current;
      const commit = gholaChartPriceDragCommit({
        drag: overlayDrag,
        pointerId: event.pointerId,
        pointerY: event.clientY - rect.top,
        plot: layout ? chartPricePlot(layout) : null,
        mode: modeRef.current,
        replayActive,
        overlays: overlayDataRef.current,
        cancelled: !onOverlayPriceCommitRef.current || trendLineTool || anchoredVwapArmed || measurementMode,
      });
      overlayPriceDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      overlayDirtyRef.current = true;
      scheduleDrawRef.current();
      if (commit) onOverlayPriceCommitRef.current?.(commit.overlayId, commit.price);
      event.preventDefault();
      return;
    }
    const drag = dragRef.current;
    dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) return;
    if (trendLineTool) {
      commitTrendLinePoint();
      return;
    }
    if (anchoredVwapArmed) {
      commitAnchoredVwapPoint();
      return;
    }
    if (measurementMode) {
      commitMeasurementPoint();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    pickPriceAt(event.clientY - rect.top);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (overlayPriceDragRef.current) {
      if (overlayPriceDragRef.current.pointerId !== event.pointerId) return;
      cancelOverlayPriceDrag(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function pickPriceAt(y: number) {
    const onPick = onSelectPriceRef.current;
    const layout = layoutRef.current;
    if (!onPick || !layout || replayActive || !canPickChartPrice(modeRef.current)) return;
    const price = priceAtY(y, layout);
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    const mid = frameMidNumber(frameRef.current);
    const side: "buy" | "sell" = mid != null && price > mid ? "sell" : "buy";
    onPick(formatPriceInput(price), side);
  }

  function handleChartFocus() {
    if (pointerRef.current.active) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const latest = latestPrice(frameRef.current);
    updatePointer({
      x: layout.left + layout.plotW,
      y: latest == null
        ? layout.top + layout.plotH / 2
        : clamp(yForPrice(latest, layout), layout.top, layout.top + layout.plotH),
      active: true,
    });
  }

  function handleChartKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    const key = event.key.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      cancelOverlayPriceDrag(true);
      setAnchoredVwapArmed(false);
      cancelTrendLineTool();
      clearMeasurement();
      handlePointerLeave();
      return;
    }
    const commandModifier = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (commandModifier && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoTrendLine();
      else undoTrendLine();
      return;
    }
    if (commandModifier && !event.shiftKey && key === "y") {
      event.preventDefault();
      redoTrendLine();
      return;
    }
    const layout = layoutRef.current;
    const data = visibleDataRef.current;
    if (!layout || !data) return;
    if (key === "t") {
      event.preventDefault();
      toggleTrendLineTool();
      return;
    }
    if (key === "a") {
      event.preventDefault();
      toggleAnchoredVwapTool();
      return;
    }
    if (key === "r") {
      event.preventDefault();
      toggleReplay();
      return;
    }
    if (key === "m") {
      event.preventDefault();
      toggleMeasurement();
      return;
    }
    if (replayActive && key === " ") {
      event.preventDefault();
      setReplayPlaying((current) => !current && effectiveReplayCursor < maxReplayIndex);
      return;
    }
    if (replayActive && (key === "[" || key === "]")) {
      event.preventDefault();
      stepReplay(key === "[" ? -1 : 1);
      return;
    }
    if (key === "f") {
      event.preventDefault();
      handleFit();
      return;
    }
    if (key === "+" || key === "=") {
      event.preventDefault();
      commitViewport(zoomGholaViewport(viewportRef.current, 1.25, pointerRef.current.x - layout.left, layout.plotW));
      return;
    }
    if (key === "-" || key === "_") {
      event.preventDefault();
      commitViewport(zoomGholaViewport(viewportRef.current, 0.8, pointerRef.current.x - layout.left, layout.plotW));
      return;
    }
    if (key === "enter") {
      event.preventDefault();
      if (trendLineTool) commitTrendLinePoint();
      else if (anchoredVwapArmed) commitAnchoredVwapPoint();
      else if (measurementMode) commitMeasurementPoint();
      else pickPriceAt(pointerRef.current.y);
      return;
    }
    const isHorizontal = key === "arrowleft" || key === "arrowright" || key === "home" || key === "end";
    const isVertical = key === "arrowup" || key === "arrowdown";
    if (!isHorizontal && !isVertical) return;
    event.preventDefault();
    const pointCount = visiblePointCount(data);
    const xStep = layout.plotW / Math.max(1, pointCount - 1);
    const yStep = Math.max(2, layout.plotH / 30);
    const current = pointerRef.current.active
      ? pointerRef.current
      : { x: layout.left + layout.plotW, y: layout.top + layout.plotH / 2, active: true };
    const x = key === "home"
      ? layout.left
      : key === "end"
        ? layout.left + layout.plotW
        : clamp(current.x + (key === "arrowleft" ? -xStep : key === "arrowright" ? xStep : 0), layout.left, layout.left + layout.plotW);
    const y = clamp(
      current.y + (key === "arrowup" ? -yStep : key === "arrowdown" ? yStep : 0),
      layout.top,
      layout.top + layout.plotH,
    );
    updatePointer({ x, y, active: true });
  }

  function handleFit() {
    commitViewport(resetGholaChartViewport());
  }

  function handleAddLevel() {
    if (!drawingMutationPolicy.allowed || !isPriceMode(modeRef.current)) return;
    const layout = layoutRef.current;
    const pointer = pointerRef.current;
    if (!layout) return;
    const pointerInsidePlot =
      pointer.active &&
      pointer.x >= layout.left &&
      pointer.x <= layout.left + layout.plotW &&
      pointer.y >= layout.top &&
      pointer.y <= layout.top + layout.plotH;
    const price = pointerInsidePlot ? priceAtY(pointer.y, layout) : latestPrice(frameRef.current);
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    const level: GholaChartOverlay = {
      id: `user-level-${Date.now()}`,
      kind: "price_line",
      label: `LEVEL ${formatChartPrice(price)}`,
      tone: "neutral",
      price,
      status: "saved",
    };
    const next = savedLevels.concat(level).slice(-12);
    if (onLevelsChange) onLevelsChange(next);
    else setInternalLevels(next);
  }

  function toggleStudy(study: GholaChartStudyId) {
    const next = activeStudies.includes(study)
      ? activeStudies.filter((item) => item !== study)
      : activeStudies.concat(study);
    if (onStudiesChange) onStudiesChange(next);
    else setInternalStudies(next);
  }

  function undoLevel() {
    const next = savedLevels.slice(0, -1);
    if (onLevelsChange) onLevelsChange(next);
    else setInternalLevels(next);
  }

  function clearLevels() {
    if (onLevelsChange) onLevelsChange([]);
    else setInternalLevels([]);
  }

  function toggleAnchoredVwapTool() {
    if (!drawingMutationPolicy.allowed || !isPriceMode(modeRef.current)) return;
    if (anchoredVwapArmed) {
      setAnchoredVwapArmed(false);
      return;
    }
    cancelTrendLineTool();
    clearMeasurement();
    if (!commitAnchoredVwapPoint()) setAnchoredVwapArmed(true);
  }

  function commitAnchoredVwapPoint() {
    if (!drawingMutationPolicy.allowed) return false;
    const data = visibleDataRef.current;
    const layout = layoutRef.current;
    if (!data || !layout || !pointerRef.current.active) return false;
    const inspected = inspectionAtPointer(data, pointerRef.current, layout);
    if (!inspected || inspected.kind !== "candle") return false;
    const index = candleIndexForInspection(frameRef.current, inspected);
    const candle = frameRef.current?.candles[index];
    if (!candle) return false;
    setAnchoredVwapSelection({ scope: activeDrawingScope, anchorTime: candle.t });
    setAnchoredVwapArmed(false);
    return true;
  }

  function clearAnchoredVwap() {
    if (!drawingMutationPolicy.allowed) return;
    setAnchoredVwapArmed(false);
    setAnchoredVwapSelection(null);
  }

  function toggleAnchoredVwapBands() {
    if (!drawingMutationPolicy.allowed) return;
    setShowAnchoredVwapBands((current) => !current);
  }

  function toggleTrendLineTool() {
    if (!drawingMutationPolicy.allowed || !isPriceMode(modeRef.current)) return;
    if (trendLineTool) {
      cancelTrendLineTool();
      return;
    }
    setAnchoredVwapArmed(false);
    clearMeasurement();
    setTrendLineDraft(null);
    setTrendLineTool(true);
  }

  function toggleTrendLineKind() {
    if (!drawingMutationPolicy.allowed) return;
    const next = trendLineKind === "segment" ? "ray" : "segment";
    setTrendLineKind(next);
    setTrendLineDraft((current) => current ? { ...current, kind: next } : current);
  }

  function commitTrendLinePoint() {
    if (!drawingMutationPolicy.allowed) return false;
    const data = visibleDataRef.current;
    const layout = layoutRef.current;
    const activeFrame = frameRef.current;
    if (!data || !layout || !activeFrame || !pointerRef.current.active) return false;
    if (
      pointerRef.current.x < layout.left
      || pointerRef.current.x > layout.left + layout.plotW
      || pointerRef.current.y < layout.top
      || pointerRef.current.y > layout.top + layout.plotH
    ) return false;
    const inspected = inspectionAtPointer(data, pointerRef.current, layout);
    const price = priceAtY(pointerRef.current.y, layout);
    if (!inspected || inspected.kind !== "candle" || inspected.time == null || !Number.isFinite(price) || price <= 0) return false;
    const scope = frameScope(activeFrame);
    const point = { time: inspected.time, price };
    if (!trendLineDraft || trendLineDraft.scope !== scope) {
      setTrendLineDraft({ scope, kind: trendLineKind, first: point });
      return true;
    }
    const geometry = calculateGholaTrendLine(activeFrame.candles, trendLineDraft.first, point, trendLineDraft.kind);
    if (!geometry) return false;
    trendLineIdRef.current += 1;
    const drawing: ChartTrendLineDrawing = {
      id: `trend-${Date.now()}-${trendLineIdRef.current}`,
      scope: activeDrawingScope,
      kind: trendLineDraft.kind,
      first: trendLineDraft.first,
      second: point,
    };
    setTrendLines((current) => current.concat(drawing).slice(-MAX_TREND_LINES));
    setUndoneTrendLines([]);
    setTrendLineDraft(null);
    setTrendLineTool(false);
    return true;
  }

  function cancelTrendLineTool() {
    setTrendLineTool(false);
    setTrendLineDraft(null);
  }

  function undoTrendLine() {
    if (!drawingMutationPolicy.allowed) return;
    const next = undoGholaTrendDrawing(
      { drawings: trendLines, redo: undoneTrendLines },
      activeDrawingScope,
      MAX_TREND_LINES,
    );
    if (next.drawings === trendLines) return;
    setTrendLines(next.drawings);
    setUndoneTrendLines(next.redo);
  }

  function redoTrendLine() {
    if (!drawingMutationPolicy.allowed) return;
    const next = redoGholaTrendDrawing(
      { drawings: trendLines, redo: undoneTrendLines },
      activeDrawingScope,
      MAX_TREND_LINES,
    );
    if (next.drawings === trendLines && next.redo === undoneTrendLines) return;
    setTrendLines(next.drawings);
    setUndoneTrendLines(next.redo);
  }

  function clearTrendLines() {
    if (!drawingMutationPolicy.allowed) return;
    const scope = activeDrawingScope;
    setTrendLines((current) => current.filter((drawing) => drawing.scope !== scope));
    setUndoneTrendLines([]);
    cancelTrendLineTool();
  }

  function toggleReplay() {
    if (replayEnabled) {
      setReplayEnabled(false);
      setReplaySource(null);
      setReplaySourceIdentityKey(null);
      setReplayPlaying(false);
      clearMeasurement();
      cancelTrendLineTool();
      handleFit();
      return;
    }
    if (!frame || !replayCanStart) return;
    const source = freezeReplaySource(captureGholaReplaySource(frame));
    setReplayCursor(defaultGholaReplayCursor(source.candles.length));
    setReplaySource(source);
    setReplaySourceIdentityKey(currentReplayIdentityKey);
    setReplayEnabled(true);
    setUndoneTrendLines([]);
    setReplayPlaying(false);
    setAnchoredVwapArmed(false);
    clearMeasurement();
    cancelTrendLineTool();
    setInspection(null);
    inspectionKeyRef.current = null;
    handleFit();
  }

  function stepReplay(delta: number) {
    setReplayPlaying(false);
    setReplayCursor((current) => clamp(current + delta, 0, maxReplayIndex));
    setMeasurementSelection(null);
    cancelTrendLineTool();
  }

  function setReplayPosition(value: number) {
    setReplayPlaying(false);
    setReplayCursor(clamp(Math.round(value), 0, maxReplayIndex));
    setMeasurementSelection(null);
    cancelTrendLineTool();
  }

  function cycleReplaySpeed() {
    setReplaySpeed((current) => current === 1 ? 2 : current === 2 ? 4 : 1);
  }

  function toggleMeasurement() {
    if (!isPriceMode(modeRef.current)) return;
    setAnchoredVwapArmed(false);
    cancelTrendLineTool();
    if (measurementMode) {
      clearMeasurement();
      return;
    }
    setMeasurementMode(true);
    setMeasurementSelection(null);
  }

  function clearMeasurement() {
    setMeasurementMode(false);
    setMeasurementSelection(null);
  }

  function applyStoredDrawingPayload(
    document: GholaChartDrawingStorage,
    payload: GholaChartDrawingPayload,
  ) {
    drawingStorageRef.current = document;
    storedDrawingPayloadRef.current = payload;
    suppressDrawingPersistRef.current = true;
    setDrawingStorageBlocked(false);
    setDrawingStorageConflict(false);
    setAnchoredVwapArmed(false);
    setAnchoredVwapSelection(payload.anchoredVwap && drawingScope
      ? { scope: drawingScope, anchorTime: payload.anchoredVwap.anchorTime }
      : null);
    setShowAnchoredVwapBands(payload.anchoredVwap?.showBands ?? true);
    setTrendLineTool(false);
    setTrendLineDraft(null);
    setTrendLines(payload.trendLines.map((drawing) => ({ ...drawing, scope: drawingScope ?? "" })));
    setUndoneTrendLines([]);
  }

  function resolveDrawingStorageConflict(source: "stored" | "local") {
    if (!drawingStorageConflict) return;
    const identity = drawingIdentityRef.current;
    const sourceFrame = drawingSourceFrameRef.current;
    if (!identity || !sourceFrame || !drawingStorageKey) return;
    const confirmation = source === "stored"
      ? "Use the drawings currently stored by the other tab? Concurrent changes in this chart tab will be discarded."
      : "Replace the other tab's drawings for this exact chart with this tab's current drawings? Other market drawings remain preserved.";
    if (!window.confirm(confirmation)) return;
    if (source === "stored") {
      let inspection: ReturnType<typeof inspectGholaChartDrawingStorage>;
      try {
        inspection = inspectGholaChartDrawingStorage(window.localStorage.getItem(drawingStorageKey));
      } catch {
        return;
      }
      if (inspection.status === "blocked") return;
      const record = gholaChartDrawingRecordForIdentity(inspection.storage, identity);
      const payload = record
        ? gholaChartDrawingPayloadForCandles(record, sourceFrame.candles)
        : emptyGholaChartDrawingPayload();
      applyStoredDrawingPayload(inspection.storage, payload);
      return;
    }
    const payload = storedDrawingPayloadRef.current;
    const document = writeGholaChartDrawingPayload(
      window.localStorage,
      identity,
      payload,
      sourceFrame.candles,
      drawingStorageRef.current,
    );
    if (document) applyStoredDrawingPayload(document, payload);
  }

  function resetBlockedDrawingStorage() {
    if (
      !drawingStorageBlocked
      || drawingStorageConflict
      || !window.confirm("Reset unreadable saved chart drawings? Existing drawing data cannot be recovered after this.")
    ) return;
    const identity = drawingIdentityRef.current;
    const sourceFrame = drawingSourceFrameRef.current;
    if (!identity || !sourceFrame) return;
    const empty = emptyGholaChartDrawingPayload();
    const document = writeGholaChartDrawingPayload(
      window.localStorage,
      identity,
      empty,
      sourceFrame.candles,
      emptyGholaChartDrawingStorage(),
    );
    if (!document) return;
    drawingStorageRef.current = document;
    storedDrawingPayloadRef.current = empty;
    suppressDrawingPersistRef.current = false;
    setDrawingStorageBlocked(false);
    setDrawingStorageConflict(false);
    setAnchoredVwapArmed(false);
    setAnchoredVwapSelection(null);
    setShowAnchoredVwapBands(true);
    setTrendLineTool(false);
    setTrendLineDraft(null);
    setTrendLines((current) => current.filter((drawing) => drawing.scope !== drawingScope));
    setUndoneTrendLines([]);
  }

  function commitMeasurementPoint() {
    const data = visibleDataRef.current;
    const layout = layoutRef.current;
    if (!data || !layout) return;
    const inspected = inspectionAtPointer(data, pointerRef.current, layout);
    if (!inspected || inspected.kind !== "candle") return;
    const index = candleIndexForInspection(frameRef.current, inspected);
    const scope = frameScope(frameRef.current);
    if (index < 0) return;
    setMeasurementSelection((current) => {
      if (!current || current.scope !== scope || current.pinned) {
        return { scope, anchorIndex: index, targetIndex: index, pinned: false };
      }
      return { ...current, targetIndex: index, pinned: true };
    });
  }

  const title = label || chartFrame?.product || "Market chart";
  const summary = chartSummary(chartFrame, mode, replayActive);
  const accessibleSummary = `${modeLabel(mode).toLowerCase()} chart for ${chartFrame?.product || title}`;
  const draggableOverlaySummary = displayedOverlays
    .filter((overlay) => overlay.interaction?.kind === "drag_price")
    .map((overlay) => overlay.interaction?.ariaLabel)
    .filter(Boolean)
    .join(", ");
  const engineLabel = chartEngineLabel(chartFrame, rendererKind, engineKind);
  const latestTrendLine = renderedTrendLines.at(-1)?.geometry ?? null;
  return (
    <div
      ref={rootRef}
      data-chart-focus-mode={chartFullscreen ? "active" : "inline"}
      className={chartFullscreen
        ? "grid h-screen min-w-0 max-w-full gap-2 overflow-y-auto bg-[#05070b] p-3 sm:p-5"
        : "grid min-w-0 max-w-full gap-2 overflow-hidden"}
    >
      <p className="sr-only" role="status" aria-live="polite">{fullscreenMessage}</p>
      <div className="flex min-h-7 min-w-0 max-w-full flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs text-[#8b95a8]">
          <span className="font-medium text-[#eef1f8]">{title}</span>
          <span className="mx-1 text-[#42506a]">/</span>
          <span>{summary}</span>
        </div>
        <div className="flex min-w-0 max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            aria-pressed={chartFullscreen}
            onClick={() => void handleFullscreenToggle()}
            disabled={!fullscreenSupported}
            title={fullscreenSupported ? (chartFullscreen ? "Exit chart focus" : "Focus chart fullscreen") : "Chart focus is unavailable in this browser"}
            className="term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            {chartFullscreen ? "Exit" : "Focus"}
          </button>
          {onModeChange && modes.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === mode}
              onClick={() => {
                if (option !== mode) cancelTrendLineTool();
                onModeChange(option);
              }}
              className={
                option === mode
                  ? "term-chip-on h-7 px-2.5 text-xs font-medium"
                  : "term-chip h-7 px-2.5 text-xs font-medium"
              }
            >
              {modeLabel(option)}
            </button>
          ))}
          <button
            type="button"
            onClick={handleFit}
            title="Fit all data (F)"
            className="term-chip h-7 px-2.5 text-xs font-medium"
          >
            Fit
          </button>
          {toolbarActions}
          <span className="border border-[#16233a] bg-[#0a0f18] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[#7d8aa3]">
            {engineLabel}
          </span>
          <button
            type="button"
            aria-pressed={showVolume}
            onClick={() => setShowVolume((current) => !current)}
            className={showVolume ? "term-chip-on h-7 px-2.5 text-xs font-medium" : "term-chip h-7 px-2.5 text-xs font-medium"}
          >
            Vol
          </button>
          <button
            type="button"
            aria-pressed={showAgentOverlays}
            onClick={() => setShowAgentOverlays((current) => !current)}
            className={
              showAgentOverlays
                ? "h-7 border border-[#31684f] bg-gradient-to-b from-[#1a4030] to-[#122c20] px-2.5 text-xs font-medium text-[#adf0cd] shadow-[inset_0_1px_0_rgba(173,240,205,0.15),0_0_12px_-4px_rgba(52,211,153,0.4)] transition-shadow duration-150"
                : "term-chip h-7 px-2.5 text-xs font-medium text-[#8b95a8]"
            }
          >
            Overlays
          </button>
          <button
            type="button"
            onClick={handleAddLevel}
            disabled={!drawingMutationPolicy.allowed || !isPriceMode(mode)}
            aria-label={drawingMutationControlLabel("Add horizontal price level", drawingMutationPolicy.disabledReason)}
            title={drawingMutationPolicy.disabledReason ?? (isPriceMode(mode) ? "Add level at crosshair" : "Levels are available on price charts")}
            className="term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            Level{savedLevels.length > 0 ? ` ${savedLevels.length}` : ""}
          </button>
          <button
            type="button"
            aria-pressed={measurementMode}
            disabled={!isPriceMode(mode)}
            onClick={toggleMeasurement}
            title="Measure from two chart points (M)"
            className={measurementMode
              ? "term-chip-on h-7 px-2.5 text-xs font-medium"
              : "term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"}
          >
            Measure
          </button>
          <button
            type="button"
            aria-pressed={trendLineTool}
            aria-label={drawingMutationControlLabel("Draw a two-point trend line", drawingMutationPolicy.disabledReason)}
            disabled={!drawingMutationPolicy.allowed || !isPriceMode(mode)}
            onClick={toggleTrendLineTool}
            title={drawingMutationPolicy.disabledReason ?? "Draw a two-point trend line (T)"}
            className={trendLineTool
              ? "h-7 border border-[#896d25] bg-[#30250b] px-2.5 text-xs font-medium text-[#f8e58b]"
              : "term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"}
          >
            Trend{trendLineTool ? trendLineDraft ? " · pick 2" : " · pick 1" : scopedTrendLines.length > 0 ? ` ${scopedTrendLines.length}` : ""}
          </button>
          {trendLineTool ? (
            <button
              type="button"
              aria-label={drawingMutationControlLabel(
                trendLineKind === "segment" ? "Use right-extended ray" : "Use finite trend segment",
                drawingMutationPolicy.disabledReason,
              )}
              disabled={!drawingMutationPolicy.allowed}
              onClick={toggleTrendLineKind}
              title={drawingMutationPolicy.disabledReason ?? undefined}
              className="term-chip h-7 px-2 text-[10px] font-medium text-[#d9bd67] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {trendLineKind === "segment" ? "Segment" : "Ray →"}
            </button>
          ) : null}
          {scopedTrendLines.length > 0 || scopedUndoneTrendLines.length > 0 ? (
            <>
              {scopedTrendLines.length > 0 ? (
                <button
                  type="button"
                  onClick={undoTrendLine}
                  disabled={!drawingMutationPolicy.allowed}
                  aria-keyshortcuts="Control+Z Meta+Z"
                  aria-label={drawingMutationControlLabel("Undo latest trend drawing", drawingMutationPolicy.disabledReason)}
                  title={drawingMutationPolicy.disabledReason ?? "Undo latest trend drawing (Ctrl/⌘ Z)"}
                  className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  TL undo
                </button>
              ) : null}
              {scopedUndoneTrendLines.length > 0 ? (
                <button
                  type="button"
                  onClick={redoTrendLine}
                  disabled={!drawingMutationPolicy.allowed}
                  aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
                  aria-label={drawingMutationControlLabel("Redo latest undone trend drawing", drawingMutationPolicy.disabledReason)}
                  title={drawingMutationPolicy.disabledReason ?? "Redo latest undone trend drawing (Ctrl/⌘ Shift Z)"}
                  className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  TL redo
                </button>
              ) : null}
              {scopedTrendLines.length > 0 ? (
                <button
                  type="button"
                  onClick={clearTrendLines}
                  disabled={!drawingMutationPolicy.allowed}
                  aria-label={drawingMutationControlLabel("Clear trend drawings", drawingMutationPolicy.disabledReason)}
                  title={drawingMutationPolicy.disabledReason ?? undefined}
                  className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  TL clear
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            aria-pressed={anchoredVwapArmed || anchoredVwapSelected}
            aria-label={drawingMutationControlLabel("Anchor VWAP at the inspected candle", drawingMutationPolicy.disabledReason)}
            disabled={!drawingMutationPolicy.allowed || !isPriceMode(mode)}
            onClick={toggleAnchoredVwapTool}
            title={drawingMutationPolicy.disabledReason ?? "Anchor VWAP at the inspected candle (A)"}
            className={anchoredVwapArmed || anchoredVwapSelected
              ? "h-7 border border-[#1f7080] bg-[#092932] px-2.5 text-xs font-medium text-[#7de7f2]"
              : "term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"}
          >
            AVWAP{anchoredVwapArmed ? " · pick" : ""}
          </button>
          {anchoredVwapSelected ? (
            <>
              <button
                type="button"
                aria-pressed={showAnchoredVwapBands}
                aria-label={drawingMutationControlLabel("Toggle anchored VWAP bands", drawingMutationPolicy.disabledReason)}
                disabled={!drawingMutationPolicy.allowed}
                onClick={toggleAnchoredVwapBands}
                title={drawingMutationPolicy.disabledReason ?? undefined}
                className={showAnchoredVwapBands ? "term-chip-on h-7 px-2 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-40" : "term-chip h-7 px-2 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-40"}
              >
                Bands
              </button>
              <button
                type="button"
                onClick={clearAnchoredVwap}
                disabled={!drawingMutationPolicy.allowed}
                aria-label={drawingMutationControlLabel("Clear anchored VWAP", drawingMutationPolicy.disabledReason)}
                title={drawingMutationPolicy.disabledReason ?? undefined}
                className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8] disabled:cursor-not-allowed disabled:opacity-40"
              >
                ×
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-pressed={replayActive}
            disabled={!replayAvailable}
            onClick={toggleReplay}
            title={replayEnabled ? "Exit historical replay (R)" : replayCanStart ? "Toggle historical replay (R)" : "Replay requires a fresh, real market frame"}
            className={replayActive
              ? "h-7 border border-[#8d6e27] bg-[#31260f] px-2.5 text-xs font-medium text-[#f8e58b]"
              : "term-chip h-7 px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"}
          >
            Replay
          </button>
          {savedLevels.length > 0 ? (
            <>
              <button type="button" onClick={undoLevel} className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8]">Undo</button>
              <button type="button" onClick={clearLevels} className="term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8]">Clear</button>
            </>
          ) : null}
          {isPriceMode(mode) && CHART_STUDIES.map((study) => (
            <button
              key={study.id}
              type="button"
              aria-pressed={activeStudies.includes(study.id)}
              onClick={() => toggleStudy(study.id)}
              className={activeStudies.includes(study.id)
                ? "term-chip-on h-7 px-2 text-[10px] font-medium"
                : "term-chip h-7 px-2 text-[10px] font-medium text-[#8b95a8]"}
              style={activeStudies.includes(study.id) ? { borderColor: `${study.color}66`, color: study.color } : undefined}
            >
              {study.label}
            </button>
          ))}
        </div>
      </div>
      {drawingStorageBlocked ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-rose-300/30 bg-rose-300/[0.04] px-2.5 py-2 text-[10px] leading-4 text-rose-200">
          <span>
            {drawingStorageConflict
              ? GHOLA_CHART_DRAWING_STORAGE_CONFLICT_REASON
              : GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON} {drawingStorageConflict
              ? "Choose which complete same-chart drawing set to keep; no automatic winner was selected."
              : "The original browser-local value is preserved."}
          </span>
          {drawingStorageConflict ? (
            <span className="flex flex-wrap gap-2">
              <button type="button" onClick={() => resolveDrawingStorageConflict("stored")} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
                Use stored
              </button>
              <button type="button" onClick={() => resolveDrawingStorageConflict("local")} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
                Keep this chart
              </button>
            </span>
          ) : (
            <button type="button" onClick={resetBlockedDrawingStorage} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
              Reset drawings
            </button>
          )}
        </div>
      ) : null}
      {isPriceMode(mode) && multiTimeframeContext ? (
        <GholaMultiTimeframeStrip context={multiTimeframeContext} replay={replayActive} />
      ) : null}
      <GholaChartInspectionStrip stats={marketStats} />
      {isPriceMode(mode) && activeStudies.includes("volumeProfile") && volumeProfileReadout ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#17445b] bg-[#07141c] px-2.5 py-1.5 font-mono text-[10px] text-[#a9dff5]"
          role="group"
          aria-label={`Visible range volume profile with ${volumeProfileReadout.bins.length} price bins and total volume ${formatCompactNumber(volumeProfileReadout.totalVolume)}. Point of control ${formatChartPrice(volumeProfileReadout.pocPrice)}. Value area low ${formatChartPrice(volumeProfileReadout.valueAreaLow)}. Value area high ${formatChartPrice(volumeProfileReadout.valueAreaHigh)}.`}
        >
          <span className="uppercase tracking-[0.14em] text-[#38bdf8]">Volume profile</span>
          <span>POC <strong className="font-medium text-[#f8e58b]">{formatChartPrice(volumeProfileReadout.pocPrice)}</strong></span>
          <span>VAH {formatChartPrice(volumeProfileReadout.valueAreaHigh)}</span>
          <span>VAL {formatChartPrice(volumeProfileReadout.valueAreaLow)}</span>
          <span>{Math.round(volumeProfileReadout.valueAreaPct * 100)}% VA</span>
          <span>vol {formatCompactNumber(volumeProfileReadout.totalVolume)}</span>
          <span className="text-[#7d8aa3]">{volumeProfileReadout.bins.length} bins · visible range</span>
        </div>
      ) : null}
      {isPriceMode(mode) && activeStudies.includes("structure") && structureReadout ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#583513] bg-[#1a0f06] px-2.5 py-1.5 font-mono text-[10px] text-[#f4c18f]"
          role="group"
          aria-label={structureAccessibleSummary(structureReadout)}
        >
          <span className="uppercase tracking-[0.14em] text-[#fb923c]">Structure</span>
          <span>Base <strong className={structureTrendClass(structureReadout.base.trend)}>{structureTrendLabel(structureReadout.base.trend)}</strong></span>
          <span>{formatTimeframe(structureReadout.higherIntervalMs)} <strong className={structureTrendClass(structureReadout.higher.trend)}>{structureTrendLabel(structureReadout.higher.trend)}</strong></span>
          <span>H {formatOptionalPrice(structureReadout.higher.lastSwingHigh?.price)}</span>
          <span>L {formatOptionalPrice(structureReadout.higher.lastSwingLow?.price)}</span>
          <span>Vol {structureReadout.volatility.regime}{structureReadout.volatility.ratio == null ? "" : ` ${structureReadout.volatility.ratio.toFixed(2)}×`}</span>
          {structureReadout.base.lastBreak ? (
            <span className="text-[#d5a470]">Last {structureReadout.base.lastBreak.label.toLowerCase()} @ {formatChartPrice(structureReadout.base.lastBreak.price)}</span>
          ) : (
            <span className="text-[#a98262]">No confirmed close-through break</span>
          )}
        </div>
      ) : null}
      {isPriceMode(mode) && activeStudies.includes("orderFlow") && orderFlowReadout ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#125064] bg-[#06161c] px-2.5 py-1.5 font-mono text-[10px] text-[#a5e7ef]"
          role="group"
          aria-label={orderFlowAccessibleSummary(orderFlowReadout)}
        >
          <span className="uppercase tracking-[0.14em] text-[#22d3ee]">Reported order flow</span>
          <span>Δ <strong className={orderFlowReadout.delta >= 0 ? "font-medium text-[#6ee7b7]" : "font-medium text-[#fca5a5]"}>{formatSignedCompact(orderFlowReadout.delta)}</strong></span>
          <span>CVD <strong className={orderFlowReadout.cumulativeDelta >= 0 ? "font-medium text-[#6ee7b7]" : "font-medium text-[#fca5a5]"}>{formatSignedCompact(orderFlowReadout.cumulativeDelta)}</strong></span>
          <span>imb {formatSignedPercent(orderFlowReadout.imbalancePct)}</span>
          <span>buy {formatCompactNumber(orderFlowReadout.buyVolume)}</span>
          <span>sell {formatCompactNumber(orderFlowReadout.sellVolume)}</span>
          <span>speed {orderFlowReadout.tradesPerMinute == null ? "—" : `${orderFlowReadout.tradesPerMinute.toFixed(1)}/m`}{orderFlowReadout.speedRatio == null ? "" : ` · ${orderFlowReadout.speedRatio.toFixed(2)}×`}</span>
          <span>{orderFlowReadout.reportedTrades} reported trades</span>
          {orderFlowReadout.candidates.length > 0 ? <span className="text-[#f8e58b]">{orderFlowReadout.candidates.length} absorption candidate{orderFlowReadout.candidates.length === 1 ? "" : "s"}</span> : null}
        </div>
      ) : null}
      {isPriceMode(mode) && (trendLineTool || scopedTrendLines.length > 0) ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#5a4618] bg-[#181205] px-2.5 py-1.5 font-mono text-[10px] text-[#e8d28c]"
          role="group"
          aria-label={trendLineAccessibleSummary(renderedTrendLines, scopedTrendLines.length, hiddenTrendLineCount, trendLineDraft, trendLineTool)}
        >
          <span className="uppercase tracking-[0.14em] text-[#f8e58b]">Trend drawings {scopedTrendLines.length}/{MAX_TREND_LINES}</span>
          {latestTrendLine ? (
            <>
              <span>{latestTrendLine.kind === "ray" ? "Ray →" : "Segment"}</span>
              <span className={latestTrendLine.changePct >= 0 ? "text-[#6ee7b7]" : "text-[#fca5a5]"}>{formatSignedPercent(latestTrendLine.changePct)}</span>
              <span>{formatSignedPrice(latestTrendLine.absoluteChange)}</span>
              <span>{latestTrendLine.bars} bars</span>
              <span>{formatDuration(latestTrendLine.elapsedMs)}</span>
              <span>slope {formatSignedPrice(latestTrendLine.slopePerBar)}/bar</span>
              <span>{formatSignedPercent(latestTrendLine.slopePctPerBar)}/bar</span>
            </>
          ) : null}
          {hiddenTrendLineCount > 0 ? <span className="text-[#9a8150]">{hiddenTrendLineCount} outside revealed data</span> : null}
          {trendLineTool ? (
            <span className="ml-auto text-[#b69a52]">
              {trendLineDraft
                ? `Anchor ${formatChartTime(trendLineDraft.first.time)} @ ${formatChartPrice(trendLineDraft.first.price)}; choose a different candle.`
                : "Choose the first candle and price; then choose the second."}
            </span>
          ) : null}
        </div>
      ) : null}
      {isPriceMode(mode) ? (
        <GholaTrendDrawingManager
          drawings={scopedTrendLines}
          disabled={!drawingMutationPolicy.allowed}
          disabledReason={drawingMutationPolicy.disabledReason}
          onDelete={deleteTrendLine}
        />
      ) : null}
      {isPriceMode(mode) && anchoredVwap ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#155261] bg-[#061820] px-2.5 py-1.5 font-mono text-[10px] text-[#a8eaf1]"
          role="group"
          aria-label={anchoredVwapAccessibleSummary(anchoredVwap, showAnchoredVwapBands)}
        >
          <span className="uppercase tracking-[0.14em] text-[#22d3ee]">Anchored VWAP</span>
          <span>anchor {formatChartTime(anchoredVwap.anchorTime)}</span>
          <span>VWAP <strong className="font-medium text-[#67e8f9]">{formatChartPrice(anchoredVwap.latest.vwap)}</strong></span>
          <span>σ {formatChartPrice(anchoredVwap.latest.deviation)}</span>
          {showAnchoredVwapBands && anchoredVwap.latest.bands.map((band) => (
            <span key={band.multiplier}>{band.multiplier}σ {formatChartPrice(band.lower)}–{formatChartPrice(band.upper)}</span>
          ))}
          <span>{anchoredVwap.points.length} bars</span>
          <span>vol {formatCompactNumber(anchoredVwap.totalVolume)}</span>
          <button
            type="button"
            onClick={clearAnchoredVwap}
            disabled={!drawingMutationPolicy.allowed}
            aria-label={drawingMutationControlLabel("Clear anchored VWAP", drawingMutationPolicy.disabledReason)}
            title={drawingMutationPolicy.disabledReason ?? undefined}
            className="ml-auto text-[#648b94] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ×
          </button>
        </div>
      ) : isPriceMode(mode) && anchoredVwapArmed ? (
        <div className="border border-dashed border-[#155261] bg-[#06141a] px-2.5 py-1.5 font-mono text-[10px] text-[#68aebb]">
          Inspect a candle, then click or press Enter to anchor VWAP.
        </div>
      ) : isPriceMode(mode) && anchoredVwapSelected ? (
        <div className="flex items-center border border-[#273849] bg-[#0a1017] px-2.5 py-1.5 font-mono text-[10px] text-[#718094]">
          Anchored VWAP is outside the currently revealed replay window.
          <button
            type="button"
            onClick={clearAnchoredVwap}
            disabled={!drawingMutationPolicy.allowed}
            aria-label={drawingMutationControlLabel("Clear anchored VWAP", drawingMutationPolicy.disabledReason)}
            title={drawingMutationPolicy.disabledReason ?? undefined}
            className="ml-auto hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ×
          </button>
        </div>
      ) : null}
      {measurement ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-[#284463] bg-[#071522] px-2.5 py-1.5 font-mono text-[10px] text-[#b9dfff]"
          role="group"
          aria-label={`Measured range ${formatSignedPercent(measurement.changePct)}, ${formatSignedPrice(measurement.absoluteChange)}, across ${measurement.bars} bars and ${formatDuration(measurement.elapsedMs)}. High ${formatChartPrice(measurement.high)}, low ${formatChartPrice(measurement.low)}, total span ${measurement.rangePct.toFixed(2)} percent, volume ${formatCompactNumber(measurement.volume)}.`}
        >
          <span className="uppercase tracking-[0.14em] text-[#6f9bc2]">Range</span>
          <span className={measurement.changePct >= 0 ? "text-[#6ee7b7]" : "text-[#fca5a5]"}>{formatSignedPercent(measurement.changePct)}</span>
          <span>{formatSignedPrice(measurement.absoluteChange)}</span>
          <span>{measurement.bars} bars</span>
          <span>{formatDuration(measurement.elapsedMs)}</span>
          <span>H {formatChartPrice(measurement.high)}</span>
          <span>L {formatChartPrice(measurement.low)}</span>
          <span>span {measurement.rangePct.toFixed(2)}%</span>
          <span>vol {formatCompactNumber(measurement.volume)}</span>
          <button type="button" onClick={clearMeasurement} aria-label="Clear measured range" className="ml-auto text-[#7d8aa3] hover:text-white">×</button>
        </div>
      ) : measurementMode ? (
        <div className="border border-dashed border-[#284463] bg-[#07111a] px-2.5 py-1.5 font-mono text-[10px] text-[#7ba8cc]">
          {measurementSelection ? "Choose the second point to pin range stats." : "Choose an anchor point on the chart."}
        </div>
      ) : null}
      {replayActive && replaySource ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 border border-[#493b1d] bg-[#161107] px-2 py-1.5 font-mono text-[10px] text-[#d8c88d]">
          <span className="rounded-sm bg-[#8d6e27] px-1.5 py-0.5 font-semibold text-[#090704]">REPLAY</span>
          <button type="button" onClick={() => stepReplay(-1)} disabled={effectiveReplayCursor <= 0} aria-label="Previous replay bar" className="term-chip h-6 px-2 disabled:opacity-35">‹</button>
          <button type="button" onClick={() => setReplayPlaying((current) => !current && effectiveReplayCursor < maxReplayIndex)} aria-label={replayPlaying ? "Pause replay" : "Play replay"} className="term-chip h-6 min-w-10 px-2">{replayPlaying ? "Ⅱ" : "▶"}</button>
          <input
            type="range"
            min={0}
            max={maxReplayIndex}
            value={effectiveReplayCursor}
            onChange={(event) => setReplayPosition(Number(event.target.value))}
            aria-label="Replay position"
            aria-valuetext={`Bar ${effectiveReplayCursor + 1} of ${replaySource.candles.length}, ${formatChartTime(replaySource.candles[effectiveReplayCursor]?.t ?? 0)}`}
            className="min-w-[90px] flex-1 accent-[#d6a94e]"
          />
          <span className="whitespace-nowrap tabular-nums">{effectiveReplayCursor + 1} / {replaySource.candles.length}</span>
          <button type="button" onClick={cycleReplaySpeed} className="term-chip h-6 px-2">{replaySpeed}×</button>
          <button type="button" onClick={() => stepReplay(1)} disabled={effectiveReplayCursor >= maxReplayIndex} aria-label="Next replay bar" className="term-chip h-6 px-2 disabled:opacity-35">›</button>
        </div>
      ) : null}
      <div
        className="term-subpanel relative w-full min-w-0 overflow-hidden"
        role="region"
        aria-label={accessibleSummary}
      >
        <p className="sr-only">
          {accessibleSummary}. {summary}. Use arrow keys to move the inspected candle and price, plus and minus to zoom, Shift plus wheel to pan, F to fit, T for a two-point trend drawing, A to anchor VWAP, M to measure, R to replay, and Enter to place the active tool point or select a limit price.
        </p>
        {mode === "compare" && frame ? (
          <div aria-hidden className="pointer-events-none absolute left-3 top-2 z-10 flex max-w-[calc(100%-7rem)] flex-wrap gap-x-3 gap-y-1 bg-[#05070bcc] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em]">
            <span style={{ color: COLORS.bull }}>● {frame.venue} {frame.product}</span>
            {compareFrames.slice(0, COMPARE_COLORS.length).map((compare, index) => (
              <span key={`${compare.venue}:${compare.product}`} style={{ color: COMPARE_COLORS[index] }}>
                ● {compare.venue} {compare.product}
              </span>
            ))}
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="block w-full select-none"
          style={{ height: chartHeight, touchAction: "pan-y pinch-zoom" }}
          aria-hidden="true"
        />
        <canvas
          ref={overlayRef}
          className="pointer-events-auto absolute inset-0 block w-full cursor-crosshair select-none"
          style={{ height: chartHeight, touchAction: "none" }}
          role="application"
          tabIndex={0}
          aria-label={`${accessibleSummary}. Interactive chart.${draggableOverlaySummary ? ` Draggable plan lines: ${draggableOverlaySummary}.` : ""} Arrow keys inspect candle and price, plus and minus zoom, F fits, T draws a two-point trend line, A anchors VWAP, M measures, R replays, Enter places a tool point or selects price.`}
          onFocus={handleChartFocus}
          onBlur={handleChartBlur}
          onKeyDown={handleChartKeyDown}
          onDoubleClick={handleFit}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
        <span aria-hidden className="term-corners pointer-events-none absolute inset-0" />
      </div>
    </div>
  );
});

function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (gl) {
    const program = createProgram(gl);
    const lineBuffer = gl.createBuffer();
    const triangleBuffer = gl.createBuffer();
    if (!lineBuffer || !triangleBuffer) throw new Error("ghola_chart_buffer_unavailable");
    return {
      kind: "webgl",
      gl,
      program,
      position: gl.getAttribLocation(program, "a_position"),
      color: gl.getAttribLocation(program, "a_color"),
      lineBuffer,
      triangleBuffer,
    };
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("ghola_chart_renderer_unavailable");
  return { kind: "canvas", ctx };
}

function cleanupRenderer(renderer: Renderer) {
  if (renderer.kind !== "webgl") return;
  renderer.gl.deleteBuffer(renderer.lineBuffer);
  renderer.gl.deleteBuffer(renderer.triangleBuffer);
  renderer.gl.deleteProgram(renderer.program);
}

function clearRendererSurface(renderer: Renderer, width: number, height: number, dpr: number) {
  if (renderer.kind === "webgl") {
    renderer.gl.viewport(0, 0, Math.floor(width * dpr), Math.floor(height * dpr));
    renderer.gl.clearColor(3 / 255, 3 / 255, 3 / 255, 1);
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
    return;
  }
  renderer.ctx.fillStyle = COLORS.bg;
  renderer.ctx.fillRect(0, 0, width, height);
}

function drawWebGl(
  renderer: Extract<Renderer, { kind: "webgl" }>,
  layout: ChartLayout,
  data: GholaChartVisibleData,
  studies: GholaChartStudyId[],
  showVolume: boolean,
  sourceCandles: GholaChartCandle[],
  volumeProfile: GholaVolumeProfile | null,
) {
  const { gl, program } = renderer;
  gl.viewport(0, 0, Math.floor(layout.width * layout.dpr), Math.floor(layout.height * layout.dpr));
  gl.clearColor(3 / 255, 3 / 255, 3 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const lines: number[] = [];
  const triangles: number[] = [];
  const pushLine = (x1: number, y1: number, x2: number, y2: number, color: string, opacity = 1) => {
    const c = rgba(color, opacity);
    pushVertex(lines, layout, x1, y1, c);
    pushVertex(lines, layout, x2, y2, c);
  };
  const pushRect = (x: number, y: number, w: number, h: number, color: string, opacity = 1) => {
    const c = rgba(color, opacity);
    pushVertex(triangles, layout, x, y, c);
    pushVertex(triangles, layout, x + w, y, c);
    pushVertex(triangles, layout, x, y + h, c);
    pushVertex(triangles, layout, x + w, y, c);
    pushVertex(triangles, layout, x + w, y + h, c);
    pushVertex(triangles, layout, x, y + h, c);
  };
  drawGridLines(layout, pushLine);
  drawScenePrimitives(layout, data, studies, showVolume, sourceCandles, volumeProfile, pushLine, pushRect);
  drawGlArray(gl, renderer, triangles, gl.TRIANGLES, renderer.triangleBuffer);
  drawGlArray(gl, renderer, lines, gl.LINES, renderer.lineBuffer);
}

function drawCanvas(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  data: GholaChartVisibleData,
  studies: GholaChartStudyId[],
  showVolume: boolean,
  sourceCandles: GholaChartCandle[],
  volumeProfile: GholaVolumeProfile | null,
) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);
  const pushLine = (x1: number, y1: number, x2: number, y2: number, color: string, opacity = 1) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  };
  const pushRect = (x: number, y: number, w: number, h: number, color: string, opacity = 1) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  };
  drawGridLines(layout, pushLine);
  drawScenePrimitives(layout, data, studies, showVolume, sourceCandles, volumeProfile, pushLine, pushRect);
}

function drawScenePrimitives(
  layout: ChartLayout,
  data: GholaChartVisibleData,
  studies: GholaChartStudyId[],
  showVolume: boolean,
  sourceCandles: GholaChartCandle[],
  volumeProfile: GholaVolumeProfile | null,
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const { frame, mode } = data;
  if (!frame) return;
  if (mode === "depth") {
    drawDepth(layout, data.bids, data.asks, pushLine, pushRect);
  } else if (mode === "route" || mode === "slippage" || mode === "quote") {
    drawRoute(layout, data.routeQuotes, pushLine, pushRect);
  } else if (mode === "line" || mode === "compare") {
    drawLineCandles(layout, data.lineCandles, COLORS.bull, pushLine);
    if (mode === "compare") {
      for (const [index, candles] of data.compareLineCandles.entries()) {
        drawLineCandles(layout, candles, COMPARE_COLORS[index % COMPARE_COLORS.length], pushLine);
      }
    }
    if (showVolume) drawVolumeBars(layout, data.lineCandles, pushRect);
  } else {
    drawCandles(layout, data.candles, pushLine, pushRect);
    if (showVolume) drawVolumeBars(layout, data.candles, pushRect);
  }
  if (isPriceMode(mode)) {
    drawStudies(layout, data.frame?.candles ?? data.lineCandles, sourceCandles, studies, pushLine);
    if (volumeProfile) drawVolumeProfile(layout, volumeProfile, pushLine, pushRect);
  }
}

function drawCandles(
  layout: ChartLayout,
  candles: GholaChartCandle[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const barW = Math.max(2, Math.min(10, layout.plotW / Math.max(1, candles.length) * 0.72));
  candles.forEach((candle, index) => {
    const x = xForIndex(index, candles.length, layout);
    const open = Number(candle.o);
    const close = Number(candle.c);
    const high = Number(candle.h);
    const low = Number(candle.l);
    if (![open, close, high, low].every(Number.isFinite)) return;
    const up = close >= open;
    const color = up ? COLORS.bull : COLORS.bear;
    pushLine(x, yForPrice(high, layout), x, yForPrice(low, layout), color);
    const y = Math.min(yForPrice(open, layout), yForPrice(close, layout));
    const h = Math.max(1, Math.abs(yForPrice(open, layout) - yForPrice(close, layout)));
    pushRect(x - barW / 2, y, barW, h, color, 0.92);
  });
}

function drawVolumeBars(
  layout: ChartLayout,
  candles: GholaChartCandle[],
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  if (candles.length === 0) return;
  const maxVolume = Math.max(1, ...candles.map((candle) => Number(candle.v)).filter(Number.isFinite));
  const barW = Math.max(1, Math.min(10, layout.plotW / Math.max(1, candles.length) * 0.72));
  const maxHeight = layout.plotH * 0.18;
  candles.forEach((candle, index) => {
    const volume = Number(candle.v);
    if (!Number.isFinite(volume) || volume < 0) return;
    const height = Math.max(1, (volume / maxVolume) * maxHeight);
    const up = Number(candle.c) >= Number(candle.o);
    pushRect(
      xForIndex(index, candles.length, layout) - barW / 2,
      layout.top + layout.plotH - height,
      barW,
      height,
      up ? COLORS.bull : COLORS.bear,
      0.28,
    );
  });
}

function drawVolumeProfile(
  layout: ChartLayout,
  profile: GholaVolumeProfile,
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const maximum = profile.bins[profile.pocIndex]?.volume ?? 0;
  if (maximum <= 0) return;
  const right = layout.left + layout.plotW;
  const maximumWidth = volumeProfileWidth(layout);
  for (const [index, bin] of profile.bins.entries()) {
    if (bin.volume <= 0) continue;
    const top = clamp(yForPrice(bin.high, layout), layout.top, layout.top + layout.plotH);
    const bottom = clamp(yForPrice(bin.low, layout), layout.top, layout.top + layout.plotH);
    const height = Math.max(1, bottom - top - 0.5);
    const width = Math.max(1, (bin.volume / maximum) * maximumWidth);
    const x = right - width;
    if (index === profile.pocIndex) {
      pushRect(x, top, width, height, COLORS.warn, 0.48);
      continue;
    }
    const sellWidth = width * (bin.sellVolume / Math.max(bin.volume, Number.EPSILON));
    const opacity = bin.inValueArea ? 0.34 : 0.16;
    if (sellWidth > 0) pushRect(x, top, sellWidth, height, COLORS.bear, opacity);
    if (width - sellWidth > 0) pushRect(x + sellWidth, top, width - sellWidth, height, COLORS.bull, opacity);
  }
  const pocY = clamp(yForPrice(profile.pocPrice, layout), layout.top, layout.top + layout.plotH);
  const valueHighY = clamp(yForPrice(profile.valueAreaHigh, layout), layout.top, layout.top + layout.plotH);
  const valueLowY = clamp(yForPrice(profile.valueAreaLow, layout), layout.top, layout.top + layout.plotH);
  pushLine(layout.left, pocY, right, pocY, COLORS.warn, 0.68);
  pushLine(layout.left, valueHighY, right, valueHighY, COLORS.accent, 0.32);
  pushLine(layout.left, valueLowY, right, valueLowY, COLORS.accent, 0.32);
}

function volumeProfileBinCount(layout: ChartLayout) {
  return Math.round(clamp(layout.plotH / 14, 12, 42));
}

function volumeProfileWidth(layout: ChartLayout) {
  const ratio = layout.plotW < 520 ? 0.24 : 0.2;
  return Math.min(144, Math.max(44, layout.plotW * ratio));
}

function volumeProfileSignature(profile: GholaVolumeProfile | null, candles: GholaChartCandle[]) {
  if (!profile) return "off";
  return [
    candles[0]?.t ?? 0,
    candles.at(-1)?.t ?? 0,
    candles.length,
    profile.bins.length,
    profile.pocPrice.toPrecision(10),
    profile.valueAreaLow.toPrecision(10),
    profile.valueAreaHigh.toPrecision(10),
    profile.totalVolume.toPrecision(10),
  ].join(":");
}

function structureSignature(structure: GholaMultiTimeframeStructure | null) {
  if (!structure) return "off";
  return [
    structure.base.trend,
    structure.base.markers.length,
    structure.base.markers.at(-1)?.id ?? "none",
    structure.higher.trend,
    structure.higher.markers.at(-1)?.id ?? "none",
    structure.higher.lastSwingHigh?.price ?? "none",
    structure.higher.lastSwingLow?.price ?? "none",
    structure.volatility.regime,
    structure.volatility.ratio?.toFixed(4) ?? "none",
  ].join(":");
}

function orderFlowSignature(analysis: GholaOrderFlowAnalysis | null) {
  if (!analysis) return "off";
  return [
    analysis.reportedTrades,
    analysis.ignoredTrades,
    analysis.coverageStart ?? "none",
    analysis.coverageEnd ?? "none",
    analysis.delta.toPrecision(10),
    analysis.cumulativeDelta.toPrecision(10),
    analysis.candidates.at(-1)?.id ?? "none",
  ].join(":");
}

function drawStudies(
  layout: ChartLayout,
  visibleCandles: GholaChartCandle[],
  sourceCandles: GholaChartCandle[],
  studies: GholaChartStudyId[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
) {
  if (visibleCandles.length === 0) return;
  const source = sourceCandles.length > 0 ? sourceCandles : visibleCandles;
  const start = findCandleIndex(source, visibleCandles[0]);
  const end = findCandleIndex(source, visibleCandles.at(-1), start < 0 ? 0 : start);
  const windowStart = start < 0 ? 0 : start;
  const windowEnd = end < windowStart ? source.length - 1 : end;
  for (const study of studies) {
    if (study === "volumeProfile" || study === "structure" || study === "orderFlow" || study === "multiTimeframe") continue;
    const fullValues = study === "vwap" ? calculateVwap(source) : calculateEma(source, study === "ema20" ? 20 : 50);
    const values = source === visibleCandles ? fullValues : fullValues.slice(windowStart, windowEnd + 1);
    const color = CHART_STUDIES.find((item) => item.id === study)?.color ?? COLORS.accent;
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous == null || current == null) continue;
      pushLine(
        xForIndex(index - 1, values.length, layout),
        clamp(yForPrice(previous, layout), layout.top, layout.top + layout.plotH),
        xForIndex(index, values.length, layout),
        clamp(yForPrice(current, layout), layout.top, layout.top + layout.plotH),
        color,
        0.9,
      );
    }
  }
}

function findCandleIndex(candles: GholaChartCandle[], target: GholaChartCandle | undefined, from = 0) {
  if (!target) return -1;
  for (let index = Math.max(0, from); index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.t === target.t && candle.T === target.T) return index;
  }
  return -1;
}

function calculateEma(candles: GholaChartCandle[], period: number): Array<number | null> {
  const multiplier = 2 / (period + 1);
  const seed: number[] = [];
  let ema: number | null = null;
  return candles.map((candle) => {
    const close = Number(candle.c);
    if (!Number.isFinite(close)) return null;
    if (ema == null) {
      seed.push(close);
      if (seed.length < period) return null;
      ema = seed.reduce((total, value) => total + value, 0) / seed.length;
      return ema;
    }
    ema = close * multiplier + ema * (1 - multiplier);
    return ema;
  });
}

function calculateVwap(candles: GholaChartCandle[]): Array<number | null> {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  return candles.map((candle) => {
    const high = Number(candle.h);
    const low = Number(candle.l);
    const close = Number(candle.c);
    const volume = Number(candle.v);
    if (![high, low, close, volume].every(Number.isFinite) || volume < 0) return null;
    if (volume === 0) return cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
    cumulativePriceVolume += ((high + low + close) / 3) * volume;
    cumulativeVolume += volume;
    return cumulativePriceVolume / cumulativeVolume;
  });
}

function drawLineCandles(layout: ChartLayout, candles: GholaChartCandle[], color: string, pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void) {
  if (candles.length < 2) return;
  for (let index = 1; index < candles.length; index += 1) {
    const prev = Number(candles[index - 1]?.c);
    const next = Number(candles[index]?.c);
    if (!Number.isFinite(prev) || !Number.isFinite(next)) continue;
    pushLine(xForIndex(index - 1, candles.length, layout), yForPrice(prev, layout), xForIndex(index, candles.length, layout), yForPrice(next, layout), color);
  }
}

function drawDepth(
  layout: ChartLayout,
  bids: GholaDepthPoint[],
  asks: GholaDepthPoint[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const points = [...bids, ...asks];
  const minPx = Math.min(...points.map((point) => point.px));
  const maxPx = Math.max(...points.map((point) => point.px));
  const maxDepth = Math.max(1, ...points.map((point) => point.cumulative));
  if (!Number.isFinite(minPx) || !Number.isFinite(maxPx) || maxPx <= minPx) return;
  const xForDepth = (price: number) => layout.left + ((price - minPx) / (maxPx - minPx)) * layout.plotW;
  const yForDepth = (value: number) => layout.top + layout.plotH - (value / maxDepth) * layout.plotH;
  for (let index = 1; index < bids.length; index += 1) {
    pushLine(xForDepth(bids[index - 1].px), yForDepth(bids[index - 1].cumulative), xForDepth(bids[index].px), yForDepth(bids[index].cumulative), COLORS.bid);
  }
  for (let index = 1; index < asks.length; index += 1) {
    pushLine(xForDepth(asks[index - 1].px), yForDepth(asks[index - 1].cumulative), xForDepth(asks[index].px), yForDepth(asks[index].cumulative), COLORS.ask);
  }
  if (bids[0]) pushRect(layout.left, yForDepth(bids.at(-1)?.cumulative ?? 0), xForDepth(bids.at(-1)?.px ?? minPx) - layout.left, layout.top + layout.plotH - yForDepth(bids.at(-1)?.cumulative ?? 0), COLORS.bid, 0.08);
  if (asks[0]) pushRect(xForDepth(asks[0].px), yForDepth(asks.at(-1)?.cumulative ?? 0), layout.left + layout.plotW - xForDepth(asks[0].px), layout.top + layout.plotH - yForDepth(asks.at(-1)?.cumulative ?? 0), COLORS.ask, 0.08);
}

function drawRoute(
  layout: ChartLayout,
  quotes: GholaRouteQuotePoint[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  if (quotes.length === 0) return;
  for (let index = 1; index < quotes.length; index += 1) {
    const prev = Number(quotes[index - 1]?.price);
    const next = Number(quotes[index]?.price);
    if (!Number.isFinite(prev) || !Number.isFinite(next)) continue;
    pushLine(xForIndex(index - 1, quotes.length, layout), yForPrice(prev, layout), xForIndex(index, quotes.length, layout), yForPrice(next, layout), COLORS.accent);
  }
  quotes.forEach((quote, index) => {
    const impact = Math.abs(Number(quote.priceImpactPct) || 0);
    const h = Math.min(layout.plotH, impact * layout.plotH * 8 + 2);
    pushRect(xForIndex(index, quotes.length, layout) - 2, layout.top + layout.plotH - h, 4, h, COLORS.warn, 0.45);
  });
}

function drawOverlays(ctx: CanvasRenderingContext2D, layout: ChartLayout, overlays: GholaChartOverlay[]) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.left, layout.top, layout.plotW, layout.plotH);
  ctx.clip();
  overlays.forEach((overlay) => {
    if (overlay.kind === "price_band" && Number.isFinite(overlay.price) && Number.isFinite(overlay.priceEnd)) {
      const y1 = yForPrice(Number(overlay.price), layout);
      const y2 = yForPrice(Number(overlay.priceEnd), layout);
      ctx.fillStyle = TONE_COLOR[overlay.tone];
      const top = layout.top + 1;
      const bottom = layout.top + layout.plotH - 1;
      if ((y1 < top && y2 < top) || (y1 > bottom && y2 > bottom)) {
        const edgeY = y1 < top ? top : bottom;
        ctx.globalAlpha = 0.42;
        ctx.fillRect(layout.left, edgeY - 1, layout.plotW, 2);
        return;
      }
      const clippedY1 = clamp(y1, top, bottom);
      const clippedY2 = clamp(y2, top, bottom);
      ctx.globalAlpha = 0.08;
      ctx.fillRect(layout.left, Math.min(clippedY1, clippedY2), layout.plotW, Math.max(2, Math.abs(clippedY2 - clippedY1)));
      return;
    }
    if (Number.isFinite(overlay.price)) {
      const rawY = yForPrice(Number(overlay.price), layout);
      const y = clamp(rawY, layout.top + 1, layout.top + layout.plotH - 1);
      const outsideRange = y !== rawY;
      const draggable = overlay.interaction?.kind === "drag_price";
      ctx.strokeStyle = TONE_COLOR[overlay.tone];
      ctx.globalAlpha = outsideRange ? 0.55 : overlay.kind === "visibility" ? 0.48 : draggable ? 1 : 0.82;
      ctx.lineWidth = outsideRange ? 1 : draggable ? 1.5 : 1;
      ctx.setLineDash(outsideRange ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.left + layout.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (draggable && !outsideRange) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = TONE_COLOR[overlay.tone];
        ctx.beginPath();
        ctx.arc(layout.left + layout.plotW - 8, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  ctx.restore();
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  data: GholaChartVisibleData,
  pointer: PointerState,
  measurement: GholaChartRangeMeasurement | null,
  volumeProfile: GholaVolumeProfile | null,
  structure: GholaMultiTimeframeStructure | null,
  orderFlow: GholaOrderFlowAnalysis | null,
  anchoredVwap: GholaAnchoredVwap | null,
  trendLines: ChartTrendLineRender[],
  trendLineDraft: ChartTrendLineDraft | null,
  sourceCandles: GholaChartCandle[],
  overlayPriceDrag: GholaChartPriceDrag | null,
) {
  const { frame, mode, overlays } = data;
  const renderedOverlays = overlayPriceDrag
    ? overlays.map((overlay) => overlay.id === overlayPriceDrag.overlayId
      ? { ...overlay, price: overlayPriceDrag.price }
      : overlay)
    : overlays;
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLORS.axis;
  drawHorizontalAxis(ctx, layout, data);
  if (mode !== "depth") {
    const ticks = priceTicks(layout);
    ticks.forEach((tick) => {
      const y = yForPrice(tick, layout);
      ctx.fillText(formatChartPrice(tick), layout.width - layout.right + 8, y);
    });
  }
  if (!frame) {
    ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Waiting for market data", layout.left + 12, layout.top + 20);
    return;
  }
  if (isPriceMode(mode)) {
    drawSessionMarkers(ctx, layout, data.candles.length > 0 ? data.candles : data.lineCandles);
    if (measurement) drawMeasurementOverlay(ctx, layout, frame.candles, measurement);
    if (volumeProfile) drawVolumeProfileLabels(ctx, layout, volumeProfile);
    if (structure) drawStructureOverlay(ctx, layout, frame.candles, structure);
    if (orderFlow) drawOrderFlowOverlay(ctx, layout, frame.candles, orderFlow);
    if (anchoredVwap) drawAnchoredVwapOverlay(ctx, layout, frame.candles, anchoredVwap);
    drawTrendLineOverlays(ctx, layout, data, sourceCandles, trendLines, trendLineDraft, pointer);
  }
  if (isPriceMode(mode)) drawBidAskBand(ctx, layout, frame);
  drawOverlays(ctx, layout, renderedOverlays);
  const latest = latestPrice(frame);
  if (latest != null && mode !== "depth") {
    const y = yForPrice(latest, layout);
    const lastCandle = frame.candles.at(-1);
    const latestColor = lastCandle && Number(lastCandle.c) < Number(lastCandle.o) ? COLORS.bear : COLORS.bull;
    ctx.strokeStyle = latestColor;
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.left + layout.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    labelBox(ctx, formatChartPrice(latest), layout.width - layout.right + 6, y, latestColor);
  }
  const labelYs = overlayLabelYs(layout, renderedOverlays);
  renderedOverlays.slice(0, 8).forEach((overlay, index) => {
    if (!Number.isFinite(overlay.price)) return;
    labelBox(ctx, overlay.label, layout.left + 8, labelYs[index] ?? layout.top + 14, TONE_COLOR[overlay.tone]);
  });
  if (pointer.active && pointer.x >= layout.left && pointer.x <= layout.left + layout.plotW && pointer.y >= layout.top && pointer.y <= layout.top + layout.plotH) {
    const price = priceAtY(pointer.y, layout);
    const inspected = inspectionAtPointer(data, pointer, layout);
    ctx.strokeStyle = COLORS.accent;
    ctx.globalAlpha = 0.62;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(pointer.x, layout.top);
    ctx.lineTo(pointer.x, layout.top + layout.plotH);
    ctx.moveTo(layout.left, pointer.y);
    ctx.lineTo(layout.left + layout.plotW, pointer.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (mode !== "depth") {
      labelBox(ctx, formatChartPrice(price), layout.width - layout.right + 6, pointer.y, COLORS.accent);
    }
    if (inspected?.time != null) {
      labelBox(ctx, formatChartTime(inspected.time), pointer.x - 30, layout.height - layout.bottom + 17, COLORS.accent);
    } else if (mode === "depth") {
      const depthPrice = depthPriceAtX(data, pointer.x, layout);
      if (depthPrice != null) labelBox(ctx, formatChartPrice(depthPrice), pointer.x - 28, layout.height - layout.bottom + 17, COLORS.accent);
    }
    labelBox(ctx, pointerReadout(data, pointer, layout, price), pointer.x + 10, pointer.y - 16, COLORS.accent);
  }
}

function drawHorizontalAxis(ctx: CanvasRenderingContext2D, layout: ChartLayout, data: GholaChartVisibleData) {
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  const axisY = layout.height - layout.bottom + 17;
  if (data.mode === "depth") {
    const levels = [...data.bids, ...data.asks];
    const min = Math.min(...levels.map((level) => level.px));
    const max = Math.max(...levels.map((level) => level.px));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      ctx.restore();
      return;
    }
    [min, min + (max - min) / 2, max].forEach((price) => {
      const x = layout.left + ((price - min) / (max - min)) * layout.plotW;
      drawVerticalGridLine(ctx, layout, x);
      ctx.fillText(formatChartPrice(price), clamp(x, layout.left + 30, layout.left + layout.plotW - 30), axisY);
    });
    ctx.restore();
    return;
  }
  const samples = data.mode === "route" || data.mode === "slippage" || data.mode === "quote"
    ? data.routeQuotes
    : data.candles.length > 0
      ? data.candles
      : data.lineCandles;
  if (samples.length === 0) {
    ctx.restore();
    return;
  }
  const tickCount = layout.plotW < 440 ? 3 : 5;
  const firstTime = Number(samples[0]?.t);
  const lastTime = Number(samples.at(-1)?.t);
  const showDate = Math.abs(normalizeTimestamp(lastTime) - normalizeTimestamp(firstTime)) >= 86_400_000;
  for (let step = 0; step < tickCount; step += 1) {
    const ratio = step / Math.max(1, tickCount - 1);
    const index = Math.round(ratio * (samples.length - 1));
    const sample = samples[index];
    if (!sample) continue;
    const x = xForIndex(index, samples.length, layout);
    drawVerticalGridLine(ctx, layout, x);
    ctx.fillText(
      formatAxisTime(Number(sample.t), showDate),
      clamp(x, layout.left + 34, layout.left + layout.plotW - 34),
      axisY,
    );
  }
  ctx.restore();
}

function drawVerticalGridLine(ctx: CanvasRenderingContext2D, layout: ChartLayout, x: number) {
  ctx.save();
  ctx.globalAlpha = 0.58;
  ctx.beginPath();
  ctx.moveTo(x, layout.top);
  ctx.lineTo(x, layout.top + layout.plotH);
  ctx.stroke();
  ctx.restore();
}

function drawBidAskBand(ctx: CanvasRenderingContext2D, layout: ChartLayout, frame: GholaMarketFrame) {
  const bid = Number(frame.bestBid);
  const ask = Number(frame.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return;
  const bidY = yForPrice(bid, layout);
  const askY = yForPrice(ask, layout);
  if (bidY < layout.top || askY > layout.top + layout.plotH) return;
  ctx.save();
  ctx.fillStyle = COLORS.accent;
  ctx.globalAlpha = 0.035;
  ctx.fillRect(layout.left, askY, layout.plotW, Math.max(1, bidY - askY));
  ctx.setLineDash([2, 5]);
  ctx.lineWidth = 1;
  for (const [y, color] of [[bidY, COLORS.bid], [askY, COLORS.ask]] as const) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.left + layout.plotW, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSessionMarkers(ctx: CanvasRenderingContext2D, layout: ChartLayout, candles: GholaChartCandle[]) {
  const markers = gholaChartSessionMarkers(candles);
  if (markers.length === 0) return;
  ctx.save();
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#8b95a8";
  ctx.strokeStyle = "#2a2a2a";
  ctx.setLineDash([2, 5]);
  for (const marker of markers.slice(-12)) {
    const x = xForIndex(marker.index, candles.length, layout);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(x, layout.top);
    ctx.lineTo(x, layout.top + layout.plotH);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillText(marker.label, clamp(x + 4, layout.left + 2, layout.left + layout.plotW - 42), layout.top + 4);
  }
  ctx.restore();
}

function drawMeasurementOverlay(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candles: GholaChartCandle[],
  measurement: GholaChartRangeMeasurement,
) {
  if (candles.length === 0) return;
  const startIndex = candles.findIndex((candle) => candle.t === measurement.startTime);
  const endIndex = candles.findIndex((candle) => candle.t === measurement.endTime);
  if (startIndex < 0 || endIndex < 0) return;
  const x1 = xForIndex(startIndex, candles.length, layout);
  const x2 = xForIndex(endIndex, candles.length, layout);
  const y1 = clamp(yForPrice(measurement.startPrice, layout), layout.top, layout.top + layout.plotH);
  const y2 = clamp(yForPrice(measurement.endPrice, layout), layout.top, layout.top + layout.plotH);
  const color = measurement.changePct >= 0 ? COLORS.bull : COLORS.bear;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.075;
  ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1)));
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1)));
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.arc(x2, y2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const label = `${formatSignedPercent(measurement.changePct)} · ${measurement.bars} bars · ${formatDuration(measurement.elapsedMs)}`;
  labelBox(ctx, label, (x1 + x2) / 2 - 30, Math.min(y1, y2) - 14, color);
}

function drawVolumeProfileLabels(ctx: CanvasRenderingContext2D, layout: ChartLayout, profile: GholaVolumeProfile) {
  const x = layout.left + layout.plotW - volumeProfileWidth(layout) - 82;
  labelBox(
    ctx,
    `POC ${formatChartPrice(profile.pocPrice)}`,
    x,
    clamp(yForPrice(profile.pocPrice, layout), layout.top, layout.top + layout.plotH),
    COLORS.warn,
  );
  ctx.save();
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.fillStyle = COLORS.accent;
  ctx.globalAlpha = 0.78;
  const labelX = layout.left + layout.plotW - 4;
  ctx.fillText("VAH", labelX, clamp(yForPrice(profile.valueAreaHigh, layout), layout.top + 6, layout.top + layout.plotH - 6));
  ctx.fillText("VAL", labelX, clamp(yForPrice(profile.valueAreaLow, layout), layout.top + 6, layout.top + layout.plotH - 6));
  ctx.restore();
}

function drawStructureOverlay(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  visibleCandles: GholaChartCandle[],
  structure: GholaMultiTimeframeStructure,
) {
  if (visibleCandles.length === 0) return;
  const higherLabel = formatTimeframe(structure.higherIntervalMs);
  drawStructureLevel(ctx, layout, structure.higher.lastSwingHigh?.price, `${higherLabel} H`, COLORS.bear);
  drawStructureLevel(ctx, layout, structure.higher.lastSwingLow?.price, `${higherLabel} L`, COLORS.bull);
  const indices = new Map(visibleCandles.map((candle, index) => [candle.t, index]));
  const markerLimit = layout.width < 560 ? 14 : 30;
  const markers = structure.base.markers.filter((marker) => indices.has(marker.time)).slice(-markerLimit);
  const labeledSwingStart = Math.max(0, markers.length - (layout.width < 560 ? 6 : 14));
  ctx.save();
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  for (const [markerIndex, marker] of markers.entries()) {
    const index = indices.get(marker.time);
    if (index == null) continue;
    const x = xForIndex(index, visibleCandles.length, layout);
    const y = clamp(yForPrice(marker.price, layout), layout.top + 5, layout.top + layout.plotH - 5);
    const swing = marker.kind === "swing_high" || marker.kind === "swing_low";
    const color = marker.kind === "trend_shift" ? COLORS.warn : swing ? COLORS.neutral : COLORS.accent;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = swing ? 0.72 : 0.94;
    if (swing) {
      const high = marker.kind === "swing_high";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3.5, y + (high ? -5 : 5));
      ctx.lineTo(x + 3.5, y + (high ? -5 : 5));
      ctx.closePath();
      ctx.fill();
      if (markerIndex >= labeledSwingStart) {
        ctx.textAlign = "center";
        ctx.fillText(marker.label, x, clamp(y + (high ? -10 : 10), layout.top + 6, layout.top + layout.plotH - 6));
      }
      continue;
    }
    ctx.globalAlpha = 0.38;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, layout.top);
    ctx.lineTo(x, layout.top + layout.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.96;
    structureMarkerBox(ctx, marker.label, x + 5, y + (marker.direction === "up" ? -12 : 12), color, layout);
  }
  ctx.restore();
}

function drawStructureLevel(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  price: number | undefined,
  label: string,
  color: string,
) {
  if (price == null || price < layout.min || price > layout.max) return;
  const y = yForPrice(price, layout);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.42;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(layout.left, y);
  ctx.lineTo(layout.left + layout.plotW, y);
  ctx.stroke();
  ctx.globalAlpha = 0.88;
  ctx.setLineDash([]);
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${label} ${formatChartPrice(price)}`, layout.left + 5, y - 2);
  ctx.restore();
}

function structureMarkerBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  layout: ChartLayout,
) {
  const padding = 4;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 16;
  const left = clamp(x, layout.left + 2, layout.left + layout.plotW - width - 2);
  const top = clamp(y - height / 2, layout.top + 2, layout.top + layout.plotH - height - 2);
  ctx.fillStyle = "#090909e8";
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = color;
  ctx.strokeRect(left, top, width, height);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + padding, top + height / 2);
}

function drawOrderFlowOverlay(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candles: GholaChartCandle[],
  analysis: GholaOrderFlowAnalysis,
) {
  if (candles.length === 0 || analysis.reportedTrades === 0) return;
  const indices = new Map(candles.map((candle, index) => [normalizeTimestamp(candle.t), index]));
  const visibleBuckets = analysis.buckets.flatMap((bucket) => {
    const candleIndex = indices.get(bucket.time);
    return candleIndex == null ? [] : [{ bucket, candleIndex }];
  });
  if (visibleBuckets.length === 0) return;
  const maximumDelta = Math.max(1, ...visibleBuckets.map(({ bucket }) => Math.abs(bucket.delta)));
  const laneHeight = Math.max(12, Math.min(42, layout.plotH * 0.09));
  const laneBottom = layout.top + layout.plotH;
  const candleWidth = layout.plotW / Math.max(1, candles.length - 1);
  ctx.save();
  ctx.fillStyle = "#090909";
  ctx.globalAlpha = 0.54;
  ctx.fillRect(layout.left, laneBottom - laneHeight, layout.plotW, laneHeight);
  for (const { bucket, candleIndex: visibleIndex } of visibleBuckets) {
    if (bucket.delta === 0) continue;
    const x = xForIndex(visibleIndex, candles.length, layout);
    const height = Math.max(1, (Math.abs(bucket.delta) / maximumDelta) * (laneHeight - 3));
    ctx.fillStyle = bucket.delta >= 0 ? COLORS.bull : COLORS.bear;
    ctx.globalAlpha = 0.48;
    ctx.fillRect(x - Math.max(1, candleWidth * 0.3), laneBottom - height, Math.max(2, candleWidth * 0.6), height);
  }
  ctx.globalAlpha = 0.64;
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1;
  const cvdValues = visibleBuckets.map(({ bucket }) => bucket.cumulativeDelta);
  const minCvd = Math.min(0, ...cvdValues);
  const maxCvd = Math.max(0, ...cvdValues);
  const cvdRange = Math.max(Number.EPSILON, maxCvd - minCvd);
  ctx.beginPath();
  let started = false;
  visibleBuckets.forEach(({ bucket, candleIndex: visibleIndex }) => {
    const x = xForIndex(visibleIndex, candles.length, layout);
    const y = laneBottom - ((bucket.cumulativeDelta - minCvd) / cvdRange) * (laneHeight - 3);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  if (started) ctx.stroke();
  ctx.restore();

  const candidates = analysis.candidates.filter((candidate) => indices.has(normalizeTimestamp(candidate.time))).slice(-(layout.width < 560 ? 4 : 8));
  for (const candidate of candidates) {
    const index = indices.get(normalizeTimestamp(candidate.time));
    if (index == null) continue;
    const x = xForIndex(index, candles.length, layout);
    const y = clamp(yForPrice(candidate.price, layout), layout.top + 10, laneBottom - laneHeight - 10);
    structureMarkerBox(ctx, candidate.label, x + 5, y + (candidate.side === "buy" ? -12 : 12), COLORS.warn, layout);
  }
}

function drawAnchoredVwapOverlay(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candles: GholaChartCandle[],
  anchored: GholaAnchoredVwap,
) {
  if (candles.length === 0 || anchored.points.length === 0) return;
  const indices = new Map(candles.map((candle, index) => [normalizeTimestamp(candle.t), index]));
  const points = anchored.points.flatMap((point) => {
    const candleIndex = indices.get(normalizeTimestamp(point.time));
    return candleIndex == null ? [] : [{ point, candleIndex }];
  });
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.left, layout.top, layout.plotW, layout.plotH);
  ctx.clip();
  anchored.multipliers.forEach((multiplier, bandIndex) => {
    drawAnchoredSeries(ctx, layout, candles.length, points, (point) => point.bands.find((band) => band.multiplier === multiplier)?.upper, COLORS.accent, bandIndex === 0 ? 0.4 : 0.22, [4, 4]);
    drawAnchoredSeries(ctx, layout, candles.length, points, (point) => point.bands.find((band) => band.multiplier === multiplier)?.lower, COLORS.accent, bandIndex === 0 ? 0.4 : 0.22, [4, 4]);
  });
  drawAnchoredSeries(ctx, layout, candles.length, points, (point) => point.vwap, "#2dd4bf", 0.95, []);
  const anchorIndex = indices.get(normalizeTimestamp(anchored.anchorTime));
  if (anchorIndex != null) {
    const anchorX = xForIndex(anchorIndex, candles.length, layout);
    ctx.strokeStyle = "#2dd4bf";
    ctx.globalAlpha = 0.52;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(anchorX, layout.top);
    ctx.lineTo(anchorX, layout.top + layout.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  const latestVisible = points.at(-1);
  if (latestVisible) {
    labelBox(
      ctx,
      `A-VWAP ${formatChartPrice(latestVisible.point.vwap)}`,
      xForIndex(latestVisible.candleIndex, candles.length, layout) - 86,
      clamp(yForPrice(latestVisible.point.vwap, layout), layout.top + 10, layout.top + layout.plotH - 10),
      "#2dd4bf",
    );
  }
}

function drawAnchoredSeries(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candleCount: number,
  points: Array<{ point: GholaAnchoredVwap["points"][number]; candleIndex: number }>,
  valueForPoint: (point: GholaAnchoredVwap["points"][number]) => number | undefined,
  color: string,
  opacity: number,
  dash: number[],
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 1.15;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (const { point, candleIndex } of points) {
    const value = valueForPoint(point);
    if (value == null || !Number.isFinite(value)) continue;
    const x = xForIndex(candleIndex, candleCount, layout);
    const y = yForPrice(value, layout);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  if (started) ctx.stroke();
  ctx.restore();
}

function drawTrendLineOverlays(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  data: GholaChartVisibleData,
  sourceCandles: GholaChartCandle[],
  renders: ChartTrendLineRender[],
  draft: ChartTrendLineDraft | null,
  pointer: PointerState,
) {
  const visibleCandles = data.frame?.candles ?? [];
  if (visibleCandles.length === 0) return;
  const labelStart = Math.max(0, renders.length - (layout.width < 560 ? 3 : 6));
  renders.slice(-MAX_TREND_LINES).forEach((render, index) => {
    drawTrendLineGeometry(
      ctx,
      layout,
      visibleCandles,
      render.geometry,
      `T${index + 1} ${render.drawing.kind === "ray" ? "ray" : "line"}`,
      index >= labelStart,
      false,
    );
  });
  if (!draft || draft.scope !== frameScope(data.frame)) return;

  const pointerInPlot = pointer.active
    && pointer.x >= layout.left
    && pointer.x <= layout.left + layout.plotW
    && pointer.y >= layout.top
    && pointer.y <= layout.top + layout.plotH;
  const inspection = pointerInPlot ? inspectionAtPointer(data, pointer, layout) : null;
  const pointerPrice = priceAtY(pointer.y, layout);
  const preview = inspection?.kind === "candle" && inspection.time != null && pointerPrice > 0
    ? calculateGholaTrendLine(sourceCandles, draft.first, { time: inspection.time, price: pointerPrice }, draft.kind)
    : null;
  if (preview) {
    drawTrendLineGeometry(ctx, layout, visibleCandles, preview, "preview", true, true);
    return;
  }
  drawTrendLineAnchor(ctx, layout, visibleCandles, draft.first, COLORS.warn);
}

function drawTrendLineGeometry(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  visibleCandles: GholaChartCandle[],
  geometry: GholaTrendLineGeometry,
  label: string,
  showLabel: boolean,
  preview: boolean,
) {
  const visibleIndices = new Map(visibleCandles.map((candle, index) => [normalizeTimestamp(candle.t), index]));
  const points = geometry.projection.flatMap((point) => {
    const visibleIndex = visibleIndices.get(normalizeTimestamp(point.time));
    return visibleIndex == null ? [] : [{ ...point, visibleIndex }];
  });
  if (points.length === 0) return;
  const color = preview ? COLORS.accent : COLORS.warn;
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.left, layout.top, layout.plotW, layout.plotH);
  ctx.clip();
  if (geometry.kind === "ray") {
    drawTrendLinePath(ctx, layout, visibleCandles.length, points.filter((point) => point.candleIndex <= geometry.end.candleIndex), color, preview ? [4, 4] : []);
    drawTrendLinePath(ctx, layout, visibleCandles.length, points.filter((point) => point.candleIndex >= geometry.end.candleIndex), color, [5, 4]);
  } else {
    drawTrendLinePath(ctx, layout, visibleCandles.length, points, color, preview ? [4, 4] : []);
  }
  drawTrendLineAnchor(ctx, layout, visibleCandles, geometry.start, color);
  drawTrendLineAnchor(ctx, layout, visibleCandles, geometry.end, color);
  ctx.restore();

  const finalPoint = points.at(-1);
  if (showLabel && finalPoint) {
    labelBox(
      ctx,
      label,
      clamp(xForIndex(finalPoint.visibleIndex, visibleCandles.length, layout) - 54, layout.left + 2, layout.left + layout.plotW - 60),
      clamp(yForPrice(finalPoint.price, layout) - 11, layout.top + 9, layout.top + layout.plotH - 9),
      color,
    );
  }
}

function drawTrendLinePath(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  candleCount: number,
  points: Array<{ visibleIndex: number; price: number }>,
  color: string,
  dash: number[],
) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.35;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xForIndex(point.visibleIndex, candleCount, layout);
    const y = yForPrice(point.price, layout);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTrendLineAnchor(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  visibleCandles: GholaChartCandle[],
  anchor: GholaTrendLineAnchor,
  color: string,
) {
  const index = visibleCandles.findIndex((candle) => normalizeTimestamp(candle.t) === normalizeTimestamp(anchor.time));
  if (index < 0) return;
  ctx.save();
  ctx.fillStyle = "#030303";
  ctx.strokeStyle = color;
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(xForIndex(index, visibleCandles.length, layout), yForPrice(anchor.price, layout), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function inspectionAtPointer(data: GholaChartVisibleData, pointer: PointerState, layout: ChartLayout): ChartInspection | null {
  const scope = frameScope(data.frame);
  if (data.mode === "depth") {
    const price = depthPriceAtX(data, pointer.x, layout);
    if (price == null) return null;
    const levels = [
      ...data.bids.map((level) => ({ ...level, side: "bid" as const })),
      ...data.asks.map((level) => ({ ...level, side: "ask" as const })),
    ];
    const nearest = levels.reduce<(typeof levels)[number] | null>(
      (best, level) => !best || Math.abs(level.px - price) < Math.abs(best.px - price) ? level : best,
      null,
    );
    if (!nearest) return null;
    return {
      key: `depth:${nearest.side}:${nearest.px}:${nearest.sz}`,
      scope,
      kind: "depth",
      time: null,
      price: nearest.px,
      side: nearest.side,
      size: nearest.sz,
      cumulative: nearest.cumulative,
    };
  }
  if (data.mode === "route" || data.mode === "slippage" || data.mode === "quote") {
    const quote = nearestGholaRouteQuote(data.routeQuotes, pointer.x, layout.left, layout.plotW);
    return quote ? routeInspection(quote, scope) : null;
  }
  const candle = nearestGholaCandle(
    data.candles.length > 0 ? data.candles : data.lineCandles,
    pointer.x,
    layout.left,
    layout.plotW,
  );
  return candle ? candleInspection(candle, scope) : null;
}

function candleIndexForInspection(frame: GholaMarketFrame | null, inspection: ChartInspection) {
  if (!frame || inspection.kind !== "candle" || inspection.time == null) return -1;
  return frame.candles.findIndex((candle) => candle.t === inspection.time);
}

function candleInspection(candle: GholaChartCandle, scope: string): ChartInspection {
  const open = finiteNumber(candle.o);
  const high = finiteNumber(candle.h);
  const low = finiteNumber(candle.l);
  const close = finiteNumber(candle.c);
  const volume = finiteNumber(candle.v);
  return {
    key: `candle:${candle.t}:${candle.T ?? ""}:${candle.c}`,
    scope,
    kind: "candle",
    time: candle.t,
    price: close ?? null,
    open,
    high,
    low,
    close,
    volume,
    changePct: open != null && close != null && open !== 0 ? ((close - open) / open) * 100 : undefined,
  };
}

function routeInspection(quote: GholaRouteQuotePoint, scope: string): ChartInspection {
  return {
    key: `route:${quote.t}:${quote.price ?? ""}:${quote.outputAmount ?? ""}`,
    scope,
    kind: "route",
    time: quote.t,
    price: finiteNumber(quote.price) ?? null,
    impactPct: finiteNumber(quote.priceImpactPct),
    slippageBps: quote.slippageBps,
    inputAmount: quote.inputAmount,
    outputAmount: quote.outputAmount,
  };
}

function latestInspection(frame: GholaMarketFrame | null, mode: GholaChartMode): ChartInspection | null {
  if (!frame) return null;
  const scope = frameScope(frame);
  if (mode === "route" || mode === "slippage" || mode === "quote") {
    const quote = frame.routeQuotes.at(-1);
    return quote ? routeInspection(quote, scope) : null;
  }
  if (mode === "depth") {
    return {
      key: `depth:mid:${frame.mid ?? ""}`,
      scope,
      kind: "depth",
      time: null,
      price: finiteNumber(frame.mid) ?? null,
    };
  }
  const candle = frame.candles.at(-1);
  return candle ? candleInspection(candle, scope) : null;
}

function inspectionStats(inspection: ChartInspection | null, frame: GholaMarketFrame | null, mode: GholaChartMode): ChartStat[] {
  if (mode === "depth") {
    return [
      { label: "Mid", value: formatOptionalPrice(finiteNumber(frame?.mid)) },
      { label: "Bid", value: formatOptionalPrice(finiteNumber(frame?.bestBid)), tone: "good" },
      { label: "Ask", value: formatOptionalPrice(finiteNumber(frame?.bestAsk)), tone: "bad" },
      { label: "Spread", value: frame?.spreadBps == null ? "—" : `${frame.spreadBps.toFixed(2)} bp` },
      { label: "Level", value: formatOptionalPrice(inspection?.price ?? undefined) },
      { label: "Side", value: inspection?.side?.toUpperCase() ?? "—", tone: inspection?.side === "bid" ? "good" : inspection?.side === "ask" ? "bad" : "neutral" },
      { label: "Cum size", value: formatCompactNumber(inspection?.cumulative) },
    ];
  }
  if (mode === "route" || mode === "slippage" || mode === "quote") {
    return [
      { label: "Time", value: inspection?.time == null ? "—" : formatChartTime(inspection.time) },
      { label: "Price", value: formatOptionalPrice(inspection?.price ?? undefined) },
      { label: "Impact", value: inspection?.impactPct == null ? "—" : formatSignedPercent(inspection.impactPct), tone: inspection?.impactPct != null && inspection.impactPct > 0 ? "bad" : "neutral" },
      { label: "Slip", value: inspection?.slippageBps == null ? "—" : `${inspection.slippageBps} bp` },
      { label: "Input", value: formatAmount(inspection?.inputAmount) },
      { label: "Output", value: formatAmount(inspection?.outputAmount) },
      { label: "Quotes", value: String(frame?.routeQuotes.length ?? 0) },
    ];
  }
  const delta = inspection?.changePct;
  const tone = delta == null ? "neutral" : delta >= 0 ? "good" : "bad";
  return [
    { label: "Time", value: inspection?.time == null ? "—" : formatChartTime(inspection.time) },
    { label: "Open", value: formatOptionalPrice(inspection?.open) },
    { label: "High", value: formatOptionalPrice(inspection?.high) },
    { label: "Low", value: formatOptionalPrice(inspection?.low) },
    { label: "Close", value: formatOptionalPrice(inspection?.close), tone },
    { label: "Change", value: delta == null ? "—" : formatSignedPercent(delta), tone },
    { label: "Volume", value: formatCompactNumber(inspection?.volume) },
  ];
}

function depthPriceAtX(data: GholaChartVisibleData, x: number, layout: ChartLayout) {
  const levels = [...data.bids, ...data.asks];
  const min = Math.min(...levels.map((level) => level.px));
  const max = Math.max(...levels.map((level) => level.px));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const ratio = clamp((x - layout.left) / layout.plotW, 0, 1);
  return min + ratio * (max - min);
}

function buildLayout(width: number, height: number, dpr: number, range: { min: number; max: number }): ChartLayout {
  const left = 18;
  const right = 86;
  const top = 18;
  const bottom = 34;
  return {
    width,
    height,
    dpr,
    left,
    right,
    top,
    bottom,
    plotW: Math.max(1, width - left - right),
    plotH: Math.max(1, height - top - bottom),
    min: range.min,
    max: range.max,
  };
}

function chartPricePlot(layout: ChartLayout) {
  return {
    top: layout.top,
    bottom: layout.top + layout.plotH,
    min: layout.min,
    max: layout.max,
  };
}

function overlayLabelYs(layout: ChartLayout, overlays: GholaChartOverlay[]) {
  const volumeTop = layout.top + layout.plotH * 0.8;
  const laneTop = layout.top + 12;
  const laneBottom = Math.max(laneTop, volumeTop - 14);
  const used: number[] = [];
  return overlays.slice(0, 8).map((overlay) => {
    const preferred = Number.isFinite(overlay.price)
      ? clamp(yForPrice(Number(overlay.price), layout), laneTop, laneBottom)
      : laneTop;
    let y = preferred;
    for (let attempt = 0; attempt < 8 && used.some((value) => Math.abs(value - y) < 22); attempt += 1) {
      y = clamp(preferred - (attempt + 1) * 22, laneTop, laneBottom);
      if (!used.some((value) => Math.abs(value - y) < 22)) break;
      y = clamp(preferred + (attempt + 1) * 22, laneTop, laneBottom);
    }
    used.push(y);
    return y;
  });
}

function pointerReadout(data: GholaChartVisibleData, pointer: PointerState, layout: ChartLayout, price: number) {
  if (data.mode === "depth") {
    const frame = data.frame;
    const levels = [...data.bids, ...data.asks];
    if (!frame || levels.length === 0) return "depth";
    const ratio = clamp((pointer.x - layout.left) / layout.plotW, 0, 1);
    const minPx = Math.min(...levels.map((level) => level.px));
    const maxPx = Math.max(...levels.map((level) => level.px));
    if (!Number.isFinite(minPx) || !Number.isFinite(maxPx) || maxPx <= minPx) return "depth";
    return `depth near ${formatChartPrice(minPx + ratio * (maxPx - minPx))}`;
  }
  if (data.mode === "route" || data.mode === "slippage" || data.mode === "quote") {
    const quote = nearestGholaRouteQuote(data.routeQuotes, pointer.x, layout.left, layout.plotW);
    if (quote) {
      const impact = Number(quote.priceImpactPct);
      const impactText = Number.isFinite(impact) ? `impact ${impact.toFixed(3)}%` : `${quote.slippageBps} bps`;
      return `${formatChartPrice(Number(quote.price) || price)} / ${impactText}`;
    }
  }
  const candle = nearestGholaCandle(data.candles.length > 0 ? data.candles : data.lineCandles, pointer.x, layout.left, layout.plotW);
  if (candle) {
    return [
      formatChartPrice(price),
      `O ${formatChartPrice(Number(candle.o))}`,
      `H ${formatChartPrice(Number(candle.h))}`,
      `L ${formatChartPrice(Number(candle.l))}`,
      `C ${formatChartPrice(Number(candle.c))}`,
    ].join("  ");
  }
  return formatChartPrice(price);
}

function drawGridLines(layout: ChartLayout, pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void) {
  [0, 0.25, 0.5, 0.75, 1].forEach((step) => {
    const y = layout.top + layout.plotH * step;
    pushLine(layout.left, y, layout.left + layout.plotW, y, COLORS.grid, 0.7);
  });
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 a_position;
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`);
  const program = gl.createProgram();
  if (!program) throw new Error("ghola_chart_program_unavailable");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  const info = gl.getProgramInfoLog(program);
  gl.detachShader(program, vertex);
  gl.detachShader(program, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!linked) {
    gl.deleteProgram(program);
    throw new Error(info || "ghola_chart_program_link_failed");
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("ghola_chart_shader_unavailable");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || "ghola_chart_shader_compile_failed");
  }
  return shader;
}

function drawGlArray(gl: WebGL2RenderingContext, renderer: Extract<Renderer, { kind: "webgl" }>, data: number[], mode: number, buffer: WebGLBuffer) {
  if (data.length === 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(renderer.position);
  gl.vertexAttribPointer(renderer.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(renderer.color);
  gl.vertexAttribPointer(renderer.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.drawArrays(mode, 0, data.length / 6);
  gl.disableVertexAttribArray(renderer.position);
  gl.disableVertexAttribArray(renderer.color);
}

function pushVertex(target: number[], layout: ChartLayout, x: number, y: number, color: [number, number, number, number]) {
  const clipX = (x / layout.width) * 2 - 1;
  const clipY = 1 - (y / layout.height) * 2;
  target.push(clipX, clipY, color[0], color[1], color[2], color[3]);
}

function xForIndex(index: number, length: number, layout: ChartLayout) {
  return layout.left + (index / Math.max(1, length - 1)) * layout.plotW;
}

function yForPrice(price: number, layout: ChartLayout) {
  return layout.top + (1 - (price - layout.min) / Math.max(1e-12, layout.max - layout.min)) * layout.plotH;
}

function priceAtY(y: number, layout: ChartLayout) {
  const clamped = clamp(y, layout.top, layout.top + layout.plotH);
  const fraction = 1 - (clamped - layout.top) / layout.plotH;
  return layout.min + fraction * (layout.max - layout.min);
}

function latestPrice(frame: GholaMarketFrame | null) {
  if (!frame) return null;
  const last = Number(frame.candles.at(-1)?.c);
  if (Number.isFinite(last)) return last;
  return frameMidNumber(frame);
}

function priceTicks(layout: ChartLayout) {
  const range = layout.max - layout.min;
  return [layout.max, layout.min + range * 0.75, layout.min + range * 0.5, layout.min + range * 0.25, layout.min];
}

function labelBox(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  const paddingX = 6;
  const canvasWidth = ctx.canvas.clientWidth || ctx.canvas.width;
  const canvasHeight = ctx.canvas.clientHeight || ctx.canvas.height;
  const width = Math.max(24, Math.min(340, canvasWidth - 4, ctx.measureText(text).width + paddingX * 2));
  const height = 20;
  const left = clamp(x, 2, canvasWidth - width - 2);
  const top = clamp(y - height / 2, 2, canvasHeight - height - 2);
  ctx.fillStyle = "#090909df";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.fillRect(left, top, width, height);
  ctx.strokeRect(left, top, width, height);
  ctx.fillStyle = color;
  ctx.fillText(text.length > 56 ? `${text.slice(0, 53)}...` : text, left + paddingX, top + height / 2);
}

function rgba(hex: string, opacity = 1): [number, number, number, number] {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return [r, g, b, opacity];
}

function formatChartPrice(price: number) {
  if (!Number.isFinite(price)) return "-";
  const decimals = price >= 1000 ? 1 : price >= 100 ? 2 : price >= 1 ? 4 : 6;
  return Number(price.toFixed(decimals)).toLocaleString("en-US");
}

function formatPriceInput(price: number) {
  if (!Number.isFinite(price)) return "";
  const decimals = price >= 1000 ? 2 : price >= 100 ? 3 : price >= 1 ? 6 : 8;
  return price.toFixed(decimals).replace(/\.?0+$/, "");
}

function formatOptionalPrice(price: number | undefined) {
  return price == null || !Number.isFinite(price) ? "—" : formatChartPrice(price);
}

function formatSignedPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 1 : 3)}%`;
}

function formatSignedPrice(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatChartPrice(value)}`;
}

function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0m";
  const minutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, Math.round(milliseconds / 1_000))}s`;
}

function formatTimeframe(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "HTF";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.max(1, minutes)}m`;
}

function structureTrendLabel(trend: GholaStructureTrend) {
  if (trend === "up") return "up breaks";
  if (trend === "down") return "down breaks";
  return "no break";
}

function structureTrendClass(trend: GholaStructureTrend) {
  if (trend === "up") return "font-medium text-[#6ee7b7]";
  if (trend === "down") return "font-medium text-[#fca5a5]";
  return "font-medium text-[#b8a895]";
}

function structureAccessibleSummary(structure: GholaMultiTimeframeStructure) {
  const high = structure.higher.lastSwingHigh?.price;
  const low = structure.higher.lastSwingLow?.price;
  const lastBreak = structure.base.lastBreak;
  return [
    "Confirmed market structure.",
    `Base timeframe: ${structureTrendLabel(structure.base.trend)}.`,
    `${formatTimeframe(structure.higherIntervalMs)} context: ${structureTrendLabel(structure.higher.trend)}.`,
    high == null ? "No confirmed higher-timeframe swing high." : `Higher-timeframe swing high ${formatChartPrice(high)}.`,
    low == null ? "No confirmed higher-timeframe swing low." : `Higher-timeframe swing low ${formatChartPrice(low)}.`,
    lastBreak == null ? "No confirmed close-through break." : `Latest event: ${lastBreak.detail} at ${formatChartPrice(lastBreak.price)}.`,
    structure.volatility.ratio == null
      ? "Volatility regime unavailable."
      : `Volatility regime ${structure.volatility.regime}, ${structure.volatility.ratio.toFixed(2)} times its prior baseline.`,
  ].join(" ");
}

function orderFlowAccessibleSummary(analysis: GholaOrderFlowAnalysis) {
  if (analysis.reportedTrades === 0) return "Reported order flow unavailable because the frame has no reported trades. No flow was inferred.";
  return [
    `Reported order flow from ${analysis.reportedTrades} trades.`,
    `Buy volume ${formatCompactNumber(analysis.buyVolume)}.`,
    `Sell volume ${formatCompactNumber(analysis.sellVolume)}.`,
    `Delta ${formatSignedCompact(analysis.delta)} and cumulative delta ${formatSignedCompact(analysis.cumulativeDelta)}.`,
    `Imbalance ${formatSignedPercent(analysis.imbalancePct)}.`,
    analysis.tradesPerMinute == null ? "Tape speed unavailable." : `Recent tape speed ${analysis.tradesPerMinute.toFixed(1)} trades per minute.`,
    analysis.speedRatio == null ? "No prior tape-speed baseline." : `Tape speed ${analysis.speedRatio.toFixed(2)} times its prior window.`,
    analysis.candidates.length === 0
      ? "No absorption candidates."
      : `${analysis.candidates.length} absorption candidates; these indicate reported imbalance with high volume and limited candle progress, not confirmed participant intent.`,
  ].join(" ");
}

function anchoredVwapAccessibleSummary(anchored: GholaAnchoredVwap, showBands: boolean) {
  const latest = anchored.latest;
  const bands = showBands
    ? latest.bands.map((band) => `${band.multiplier} standard deviation band from ${formatChartPrice(band.lower)} to ${formatChartPrice(band.upper)}.`).join(" ")
    : "Deviation bands hidden.";
  return [
    `Anchored VWAP from ${formatChartTime(anchored.anchorTime)}.`,
    `Current VWAP ${formatChartPrice(latest.vwap)}, calculated from candle typical price and reported volume.`,
    `Volume-weighted standard deviation ${formatChartPrice(latest.deviation)}.`,
    bands,
    `${anchored.points.length} volume-bearing candles and cumulative volume ${formatCompactNumber(anchored.totalVolume)}.`,
  ].join(" ");
}

function trendLineAccessibleSummary(
  renders: ChartTrendLineRender[],
  total: number,
  hidden: number,
  draft: ChartTrendLineDraft | null,
  toolActive: boolean,
) {
  const latest = renders.at(-1)?.geometry;
  const summary = [
    `${total} of ${MAX_TREND_LINES} trend drawings used.`,
    latest
      ? `Latest ${latest.kind === "ray" ? "right-extended ray" : "finite segment"} runs from ${formatChartTime(latest.start.time)} at ${formatChartPrice(latest.start.price)} to ${formatChartTime(latest.end.time)} at ${formatChartPrice(latest.end.price)}.`
      : "No drawing is available in the currently revealed candles.",
    latest
      ? `Change ${formatSignedPrice(latest.absoluteChange)}, ${formatSignedPercent(latest.changePct)}, across ${latest.bars} bars; slope ${formatSignedPrice(latest.slopePerBar)} or ${formatSignedPercent(latest.slopePctPerBar)} per bar.`
      : "",
    hidden > 0 ? `${hidden} drawing${hidden === 1 ? " is" : "s are"} hidden because an endpoint is outside currently revealed data.` : "",
    toolActive
      ? draft
        ? `First point selected at ${formatChartTime(draft.first.time)}, ${formatChartPrice(draft.first.price)}. Choose a different candle for the second point.`
        : "Choose the first candle and price, then the second."
      : "Press T to start another drawing.",
  ];
  return summary.filter(Boolean).join(" ");
}

function formatCompactNumber(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [threshold, suffix] of units) {
    if (absolute >= threshold) return `${(value / threshold).toFixed(absolute >= threshold * 100 ? 0 : absolute >= threshold * 10 ? 1 : 2)}${suffix}`;
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: absolute >= 10 ? 2 : 4 });
}

function formatSignedCompact(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatCompactNumber(value)}`;
}

function formatAmount(value: string | null | undefined) {
  if (value == null || value.length === 0) return "—";
  const number = Number(value);
  return Number.isFinite(number) ? formatCompactNumber(number) : value.slice(0, 16);
}

function normalizeTimestamp(value: number) {
  if (!Number.isFinite(value)) return Number.NaN;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function formatChartTime(value: number) {
  const date = new Date(normalizeTimestamp(value));
  if (!Number.isFinite(date.getTime())) return "—";
  return `${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}Z`;
}

function formatAxisTime(value: number, showDate: boolean) {
  const date = new Date(normalizeTimestamp(value));
  if (!Number.isFinite(date.getTime())) return "—";
  const clock = `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`;
  return showDate ? `${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${clock}` : clock;
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function visiblePointCount(data: GholaChartVisibleData) {
  if (data.mode === "depth") return Math.max(2, data.bids.length + data.asks.length);
  if (data.mode === "route" || data.mode === "slippage" || data.mode === "quote") return Math.max(2, data.routeQuotes.length);
  return Math.max(2, data.candles.length, data.lineCandles.length);
}

function isPriceMode(mode: GholaChartMode) {
  return mode === "candles" || mode === "line" || mode === "compare";
}

function drawingMutationControlLabel(action: string, disabledReason: string | null) {
  return disabledReason ? `${action}. ${disabledReason}` : action;
}

function isReplayMode(mode: GholaChartMode) {
  return mode === "candles" || mode === "line";
}

function chartInspectionKind(mode: GholaChartMode): ChartInspection["kind"] {
  if (mode === "depth") return "depth";
  if (mode === "route" || mode === "slippage" || mode === "quote") return "route";
  return "candle";
}

function frameScope(frame: GholaMarketFrame | null) {
  return frame ? `${frame.venue}:${frame.network ?? "unknown"}:${frame.product}:${frame.interval}` : "none";
}

function chartModesForFrame(frame: GholaMarketFrame | null, activeMode: GholaChartMode): GholaChartMode[] {
  if (frame?.venue === "jupiter" || activeMode === "route" || activeMode === "slippage" || activeMode === "quote") {
    return ["route", "slippage", "quote", "compare"];
  }
  return ["candles", "line", "depth", "compare"];
}

function modeLabel(mode: GholaChartMode) {
  if (mode === "route") return "Route";
  if (mode === "slippage") return "Slippage";
  if (mode === "quote") return "Quote";
  if (mode === "compare") return "Compare";
  if (mode === "depth") return "Depth";
  if (mode === "line") return "Line";
  return "Candles";
}

function canPickChartPrice(mode: GholaChartMode) {
  return mode === "candles" || mode === "line" || mode === "compare";
}

function chartSummary(frame: GholaMarketFrame | null, mode: GholaChartMode, replay = false) {
  if (!frame) return "waiting for market data";
  const stale = replay ? "replay" : frame.stale ? "stale" : "live";
  const spread = frame.spreadBps == null ? "" : ` · spread ${frame.spreadBps.toFixed(2)} bp`;
  const funding = finiteNumber(frame.fundingRate);
  const fundingText = funding == null ? "" : ` · funding ${formatSignedPercent(funding * 100)}`;
  const dayVolume = finiteNumber(frame.dayVolume);
  const volumeText = dayVolume == null ? "" : ` · 24h ${formatCompactNumber(dayVolume)}`;
  return `${modeLabel(mode).toLowerCase()} · ${frame.interval} · ${stale}${spread}${fundingText}${volumeText}`;
}

function chartEngineLabel(frame: GholaMarketFrame | null, rendererKind: string, engineKind: string) {
  if (!frame) return "chart loading";
  if (engineKind === "worker" && rendererKind === "webgl") return "live canvas";
  if (rendererKind === "webgl") return "accelerated";
  if (rendererKind === "canvas") return "canvas";
  return "chart engine";
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function freezeReplaySource(source: GholaMarketFrame): GholaMarketFrame {
  for (const candle of source.candles) Object.freeze(candle);
  for (const level of source.bids) Object.freeze(level);
  for (const level of source.asks) Object.freeze(level);
  for (const trade of source.trades) Object.freeze(trade);
  for (const quote of source.routeQuotes) {
    Object.freeze(quote.routeSummary);
    Object.freeze(quote);
  }
  Object.freeze(source.candles);
  Object.freeze(source.bids);
  Object.freeze(source.asks);
  Object.freeze(source.trades);
  Object.freeze(source.routeQuotes);
  return Object.freeze(source) as GholaMarketFrame;
}
