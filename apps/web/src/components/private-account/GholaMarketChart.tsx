"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  chartPointCount,
  defaultGholaChartViewport,
  GholaChartEngineState,
  nearestGholaCandle,
  nearestGholaRouteQuote,
  panGholaViewport,
  resetGholaChartViewport,
  zoomGholaViewport,
  type GholaChartViewport,
  type GholaChartVisibleData,
  type GholaChartWorkerRequest,
  type GholaChartWorkerResponse,
  type GholaDepthPoint,
} from "@/lib/ghola-chart-engine";
import {
  frameMidNumber,
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
  height?: number;
  label?: string;
  onSelectPrice?: (price: string, side: "buy" | "sell") => void;
  feedStatus?: string;
}

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

const COLORS = {
  bg: "#08090b",
  grid: "#202833",
  axis: "#687588",
  text: "#c2cad5",
  bull: "#28d3a2",
  bear: "#f07178",
  accent: "#3da8ff",
  warn: "#d9b96e",
  neutral: "#8995a7",
  bid: "#62d6a5",
  ask: "#ef8f97",
};

const TONE_COLOR: Record<GholaChartTone, string> = {
  good: COLORS.bull,
  bad: COLORS.bear,
  warn: COLORS.warn,
  accent: COLORS.accent,
  neutral: COLORS.neutral,
};

const EMPTY_OVERLAYS: GholaChartOverlay[] = [];
const EMPTY_COMPARE_FRAMES: GholaMarketFrame[] = [];

export function GholaMarketChart({
  frame,
  mode,
  onModeChange,
  overlays = EMPTY_OVERLAYS,
  compareFrames = EMPTY_COMPARE_FRAMES,
  size = "large",
  height,
  label,
  onSelectPrice,
  feedStatus,
}: GholaMarketChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const engineRef = useRef(new GholaChartEngineState());
  const workerRef = useRef<Worker | null>(null);
  const workerHealthyRef = useRef(false);
  const workerPendingRef = useRef(false);
  const workerRequestIdRef = useRef(0);
  const visibleDataRef = useRef<GholaChartVisibleData | null>(null);
  const needsVisibleDataRef = useRef(true);
  const sizeRef = useRef({ width: 1, height: height ?? (size === "large" ? 520 : 280) });
  const viewportRef = useRef<GholaChartViewport>(defaultGholaChartViewport());
  const frameRef = useRef<GholaMarketFrame | null>(frame);
  const compareRef = useRef<GholaMarketFrame[]>(compareFrames);
  const modeRef = useRef<GholaChartMode>(mode);
  const overlayDataRef = useRef<GholaChartOverlay[]>(overlays);
  const pointerRef = useRef<PointerState>({ x: 0, y: 0, active: false });
  const dragRef = useRef<DragState>({ active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false });
  const layoutRef = useRef<ChartLayout | null>(null);
  const visibleRef = useRef(true);
  const baseDirtyRef = useRef(true);
  const overlayDirtyRef = useRef(true);
  const drawPendingRef = useRef(false);
  const scheduleDrawRef = useRef<() => void>(() => {});
  const onSelectPriceRef = useRef(onSelectPrice);
  const [, setRendererKind] = useState<"webgl" | "canvas" | "loading">("loading");
  const [, setEngineKind] = useState<"worker" | "main" | "loading">("loading");
  const [showAgentOverlays, setShowAgentOverlays] = useState(true);
  const [savedLevels, setSavedLevels] = useState<GholaChartOverlay[]>([]);
  const [clockMs, setClockMs] = useState(0);

  const chartHeight = height ?? (size === "large" ? 520 : 280);
  const modes = chartModesForFrame(frame, mode, compareFrames.length > 0);
  const displayedOverlays = useMemo(
    () => (showAgentOverlays ? overlays.concat(savedLevels) : savedLevels),
    [overlays, savedLevels, showAgentOverlays],
  );

  useEffect(() => {
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const markVisibleDataDirty = useCallback(() => {
    needsVisibleDataRef.current = true;
    baseDirtyRef.current = true;
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }, []);

  const postWorker = useCallback((request: GholaChartWorkerRequest) => {
    const worker = workerRef.current;
    if (!worker || !workerHealthyRef.current) return;
    worker.postMessage(request);
  }, []);

  const requestVisibleData = useCallback(() => {
    const { width, height: h } = sizeRef.current;
    const worker = workerRef.current;
    if (worker && workerHealthyRef.current) {
      if (workerPendingRef.current) {
        needsVisibleDataRef.current = true;
        return;
      }
      workerPendingRef.current = true;
      needsVisibleDataRef.current = false;
      workerRequestIdRef.current += 1;
      worker.postMessage({
        id: workerRequestIdRef.current,
        type: "visible-data",
        width,
        height: h,
      } satisfies GholaChartWorkerRequest);
      return;
    }
    visibleDataRef.current = engineRef.current.visibleData({
      width,
      height: h,
      mode: modeRef.current,
      viewport: viewportRef.current,
    });
    needsVisibleDataRef.current = false;
  }, []);

  const commitViewport = useCallback((viewport: GholaChartViewport) => {
    viewportRef.current = viewport;
    engineRef.current.setViewport(viewport);
    postWorker({ type: "set-viewport", viewport });
    markVisibleDataDirty();
  }, [markVisibleDataDirty, postWorker]);

  useEffect(() => {
    if (typeof Worker === "undefined") {
      setEngineKind("main");
      return;
    }
    try {
      const worker = new Worker(new URL("../../lib/ghola-chart-worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      workerHealthyRef.current = true;
      setEngineKind("worker");
      worker.onmessage = (event: MessageEvent<GholaChartWorkerResponse>) => {
        const response = event.data;
        if (response.type === "visible-data") {
          visibleDataRef.current = response.data;
          workerPendingRef.current = false;
          baseDirtyRef.current = true;
          overlayDirtyRef.current = true;
          if (needsVisibleDataRef.current) requestVisibleData();
          scheduleDrawRef.current();
          return;
        }
        if (response.type === "error") {
          workerHealthyRef.current = false;
          workerPendingRef.current = false;
          setEngineKind("main");
          markVisibleDataDirty();
        }
      };
      worker.onerror = () => {
        workerHealthyRef.current = false;
        workerPendingRef.current = false;
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
        workerHealthyRef.current = false;
        workerPendingRef.current = false;
        worker.terminate();
        workerRef.current = null;
      };
    } catch {
      workerHealthyRef.current = false;
      setEngineKind("main");
      markVisibleDataDirty();
    }
  }, [markVisibleDataDirty, requestVisibleData]);

  useEffect(() => {
    engineRef.current.ingestFrame(frame);
    frameRef.current = engineRef.current.frame();
    postWorker({ type: "set-frame", frame });
    markVisibleDataDirty();
  }, [frame, markVisibleDataDirty, postWorker]);
  useEffect(() => {
    compareRef.current = compareFrames;
    engineRef.current.setCompareFrames(compareFrames);
    postWorker({ type: "set-compare", frames: compareFrames });
    markVisibleDataDirty();
  }, [compareFrames, markVisibleDataDirty, postWorker]);
  useEffect(() => {
    modeRef.current = mode;
    engineRef.current.setMode(mode);
    postWorker({ type: "set-mode", mode });
    markVisibleDataDirty();
  }, [mode, markVisibleDataDirty, postWorker]);
  useEffect(() => {
    overlayDataRef.current = displayedOverlays;
    engineRef.current.setOverlays(displayedOverlays);
    postWorker({ type: "set-overlays", overlays: displayedOverlays });
    markVisibleDataDirty();
  }, [displayedOverlays, markVisibleDataDirty, postWorker]);
  useEffect(() => {
    onSelectPriceRef.current = onSelectPrice;
  }, [onSelectPrice]);

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
      if (!visibleRef.current) return;
      const rendererState = rendererRef.current;
      const overlayCtx = overlay.getContext("2d");
      if (!rendererState || !overlayCtx) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width, height: h };
      if (needsVisibleDataRef.current || !visibleDataRef.current) requestVisibleData();
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
        if (rendererState.kind === "webgl") drawWebGl(rendererState, layout, visibleData);
        else drawCanvas(rendererState.ctx, layout, visibleData);
        baseDirtyRef.current = false;
      }
      if (shouldDrawOverlay) {
        drawOverlay(overlayCtx, layout, visibleData, pointerRef.current);
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
      const ctx = canvas.getContext("2d", { alpha: false });
      if (ctx) {
        rendererRef.current = { kind: "canvas", ctx };
        setRendererKind("canvas");
        baseDirtyRef.current = true;
        overlayDirtyRef.current = true;
        scheduleDraw();
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const factor = event.deltaY > 0 ? 0.88 : 1.14;
      commitViewport(zoomGholaViewport(viewportRef.current, factor, event.clientX - rect.left, rect.width));
    };
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);
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
      overlay.removeEventListener("wheel", onWheel);
      if (rendererRef.current) cleanupRenderer(rendererRef.current);
      rendererRef.current = null;
    };
  }, [commitViewport, markVisibleDataDirty, requestVisibleData]);

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    pointerRef.current = {
      x,
      y,
      active: true,
    };
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
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
    pointerRef.current = { ...pointerRef.current, active: false };
    overlayDirtyRef.current = true;
    scheduleDrawRef.current();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
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
    const drag = dragRef.current;
    dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) return;
    pickPrice(event);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    dragRef.current = { active: false, pointerId: null, startX: 0, startY: 0, lastX: 0, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function pickPrice(event: ReactPointerEvent<HTMLCanvasElement>) {
    const onPick = onSelectPriceRef.current;
    const layout = layoutRef.current;
    if (!onPick || !layout || !canPickChartPrice(modeRef.current)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const price = priceAtY(y, layout);
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    const mid = frameMidNumber(frameRef.current);
    const side: "buy" | "sell" = mid != null && price > mid ? "sell" : "buy";
    onPick(formatChartPrice(price), side);
  }

  function handleFit() {
    commitViewport(resetGholaChartViewport());
  }

  function handleAddLevel() {
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
      label: "level",
      tone: "neutral",
      price,
      status: "saved",
    };
    setSavedLevels((current) => current.concat(level).slice(-6));
  }

  const title = label || frame?.product || "Market chart";
  const summary = chartSummary(frame, mode, feedStatus, clockMs);
  const accessibleSummary = `${modeLabel(mode).toLowerCase()} chart for ${frame?.product || title}`;
  return (
    <div className="grid gap-2">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs text-[#8b95a8]">
          <span className="font-medium text-[#eef1f8]">{title}</span>
          <span className="mx-1 text-[#42506a]">/</span>
          <span>{summary}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleFit}
            className="term-chip h-7 px-2.5 text-xs font-medium"
          >
            Fit
          </button>
          <button
            type="button"
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
            className="term-chip h-7 px-2.5 text-xs font-medium"
          >
            Level{savedLevels.length > 0 ? ` ${savedLevels.length}` : ""}
          </button>
          {onModeChange && modes.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onModeChange(option)}
              className={
                option === mode
                  ? "term-chip-on h-7 px-2.5 text-xs font-medium"
                  : "term-chip h-7 px-2.5 text-xs font-medium"
              }
            >
              {modeLabel(option)}
            </button>
          ))}
        </div>
      </div>
      <div
        className="term-subpanel relative overflow-hidden"
        role="img"
        aria-label="Market chart"
      >
        <p className="sr-only">{accessibleSummary}. {summary}</p>
        <canvas
          ref={canvasRef}
          className="block w-full select-none"
          style={{ height: chartHeight, touchAction: "none" }}
          aria-hidden="true"
        />
        <canvas
          ref={overlayRef}
          className="pointer-events-auto absolute inset-0 block w-full cursor-crosshair select-none"
          style={{ height: chartHeight, touchAction: "none" }}
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
}

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

function drawWebGl(renderer: Extract<Renderer, { kind: "webgl" }>, layout: ChartLayout, data: GholaChartVisibleData) {
  const { gl, program } = renderer;
  gl.viewport(0, 0, Math.floor(layout.width * layout.dpr), Math.floor(layout.height * layout.dpr));
  gl.clearColor(5 / 255, 7 / 255, 11 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const lines: number[] = [];
  const triangles: number[] = [];
  const pushLine = (x1: number, y1: number, x2: number, y2: number, color: string) => {
    const c = rgba(color);
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
  drawScenePrimitives(layout, data, pushLine, pushRect);
  drawGlArray(gl, renderer, triangles, gl.TRIANGLES, renderer.triangleBuffer);
  drawGlArray(gl, renderer, lines, gl.LINES, renderer.lineBuffer);
}

function drawCanvas(ctx: CanvasRenderingContext2D, layout: ChartLayout, data: GholaChartVisibleData) {
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
  drawScenePrimitives(layout, data, pushLine, pushRect);
}

function drawScenePrimitives(
  layout: ChartLayout,
  data: GholaChartVisibleData,
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const { frame, mode, overlays } = data;
  if (!frame) return;
  if (mode === "depth") {
    drawDepth(layout, data.bids, data.asks, pushLine, pushRect);
  } else if (mode === "route" || mode === "slippage" || mode === "quote") {
    drawRoute(layout, data.routeQuotes, pushLine, pushRect);
  } else if (mode === "line" || mode === "compare") {
    drawLineCandles(layout, data.lineCandles, COLORS.bull, pushLine);
    if (mode === "compare") {
      for (const [index, candles] of data.compareLineCandles.entries()) {
        drawLineCandles(layout, candles, index === 0 ? COLORS.accent : COLORS.neutral, pushLine);
      }
    }
  } else {
    drawCandles(layout, data.candles, pushLine, pushRect);
  }
  drawOverlays(layout, overlays, pushLine, pushRect);
}

function drawCandles(
  layout: ChartLayout,
  candles: GholaChartCandle[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  const spacing = layout.plotW / Math.max(1, candles.length - 1);
  const barW = Math.max(3, Math.min(13, Math.floor(spacing * 0.58)));
  const volumes = candles
    .map((candle) => Number(candle.v))
    .filter((volume) => Number.isFinite(volume) && volume >= 0)
    .sort((a, b) => a - b);
  const volumeCeiling = volumes[Math.min(volumes.length - 1, Math.floor(volumes.length * 0.95))] ?? 1;
  const maxVolume = Math.max(1, volumeCeiling);
  const volumeTop = layout.top + layout.plotH * 0.82;
  candles.forEach((candle, index) => {
    const x = Math.round(xForIndex(index, candles.length, layout)) + 0.5;
    const open = Number(candle.o);
    const close = Number(candle.c);
    const high = Number(candle.h);
    const low = Number(candle.l);
    if (![open, close, high, low].every(Number.isFinite)) return;
    const up = close >= open;
    const color = up ? COLORS.bull : COLORS.bear;
    const wickTop = Math.round(yForPrice(high, layout)) + 0.5;
    const wickBottom = Math.round(yForPrice(low, layout)) + 0.5;
    const openY = Math.round(yForPrice(open, layout));
    const closeY = Math.round(yForPrice(close, layout));
    const bodyTop = Math.min(openY, closeY);
    const bodyH = Math.abs(openY - closeY);
    pushLine(x, wickTop, x, wickBottom, color, 0.96);
    if (bodyH <= 1) {
      pushLine(x - barW / 2, closeY + 0.5, x + barW / 2, closeY + 0.5, color, 1);
    } else {
      // A dark one-pixel keyline keeps bodies crisp against wicks and gridlines.
      pushRect(x - barW / 2 - 1, bodyTop - 1, barW + 2, bodyH + 2, COLORS.bg, 0.96);
      pushRect(x - barW / 2, bodyTop, barW, Math.max(2, bodyH), color, 1);
    }
    const volume = Number(candle.v) || 0;
    const volumeH = Math.max(
      1,
      (Math.min(volume, maxVolume) / maxVolume) * (layout.height - layout.bottom - volumeTop),
    );
    pushRect(
      x - barW / 2,
      layout.height - layout.bottom - volumeH,
      barW,
      volumeH,
      up ? "#31584e" : "#5b3d45",
      0.74,
    );
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

function drawOverlays(
  layout: ChartLayout,
  overlays: GholaChartOverlay[],
  pushLine: (x1: number, y1: number, x2: number, y2: number, color: string, opacity?: number) => void,
  pushRect: (x: number, y: number, w: number, h: number, color: string, opacity?: number) => void,
) {
  overlays.forEach((overlay) => {
    if (overlay.kind === "price_band" && Number.isFinite(overlay.price) && Number.isFinite(overlay.priceEnd)) {
      const y1 = yForPrice(Number(overlay.price), layout);
      const y2 = yForPrice(Number(overlay.priceEnd), layout);
      pushRect(layout.left, Math.min(y1, y2), layout.plotW, Math.max(2, Math.abs(y2 - y1)), TONE_COLOR[overlay.tone], 0.045);
      return;
    }
    if (Number.isFinite(overlay.price)) {
      const y = yForPrice(Number(overlay.price), layout);
      pushLine(layout.left, y, layout.left + layout.plotW, y, TONE_COLOR[overlay.tone], overlay.kind === "visibility" ? 0.42 : 0.76);
    }
  });
}

function drawOverlay(ctx: CanvasRenderingContext2D, layout: ChartLayout, data: GholaChartVisibleData, pointer: PointerState) {
  const { frame, mode, overlays } = data;
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.font = chartMonoFont(11);
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLORS.axis;
  const latest = latestPrice(frame);
  const latestY = latest != null ? yForPrice(latest, layout) : null;
  if (mode !== "depth") {
    const ticks = priceTicks(layout);
    ticks.forEach((tick) => {
      const y = yForPrice(tick, layout);
      if (latestY != null && Math.abs(y - latestY) < 16) return;
      ctx.fillText(formatChartPrice(tick), layout.width - layout.right + 8, y);
    });
  }
  if (!frame) {
    ctx.font = chartSansFont(13, 500);
    ctx.fillText("Waiting for market data", layout.left + 12, layout.top + 20);
    return;
  }
  if (latest != null && mode !== "depth") {
    const y = yForPrice(latest, layout);
    ctx.strokeStyle = COLORS.bull;
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.left + layout.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    labelBox(ctx, formatChartPrice(latest), layout.width - layout.right + 6, y, COLORS.bull);
  }
  const labeledOverlays = overlays.filter((overlay) => overlay.kind !== "price_band");
  const labelYs = overlayLabelYs(layout, labeledOverlays);
  ctx.font = chartSansFont(12, 500);
  labeledOverlays.slice(0, 5).forEach((overlay, index) => {
    if (!Number.isFinite(overlay.price)) return;
    labelBox(ctx, overlay.label, layout.left + 8, labelYs[index] ?? layout.top + 14, TONE_COLOR[overlay.tone]);
  });
  if (pointer.active && pointer.x >= layout.left && pointer.x <= layout.left + layout.plotW && pointer.y >= layout.top && pointer.y <= layout.top + layout.plotH) {
    const price = priceAtY(pointer.y, layout);
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
    ctx.font = chartMonoFont(11, 500);
    labelBox(ctx, pointerReadout(data, pointer, layout, price), pointer.x + 10, pointer.y - 14, COLORS.accent);
  }
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

function overlayLabelYs(layout: ChartLayout, overlays: GholaChartOverlay[]) {
  const volumeTop = layout.top + layout.plotH * 0.8;
  const laneTop = layout.top + 12;
  const laneBottom = Math.max(laneTop, volumeTop - 14);
  const used: number[] = [];
  return overlays.slice(0, 6).map((overlay) => {
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
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "ghola_chart_program_link_failed");
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("ghola_chart_shader_unavailable");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "ghola_chart_shader_compile_failed");
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
  const mid = frameMidNumber(frame);
  if (mid != null) return mid;
  const last = Number(frame.candles.at(-1)?.c);
  if (Number.isFinite(last)) return last;
  return null;
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
  ctx.fillStyle = "rgba(10, 11, 14, 0.92)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundedRect(ctx, left, top, width, height, 4);
  ctx.fill();
  roundedRect(ctx, left + 0.5, top + 0.5, width - 1, height - 1, 4);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text.length > 56 ? `${text.slice(0, 53)}...` : text, left + paddingX, top + height / 2);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function chartSansFont(size: number, weight = 400) {
  return `${weight} ${size}px ${chartFontFamily("sans")}`;
}

function chartMonoFont(size: number, weight = 400) {
  return `${weight} ${size}px ${chartFontFamily("mono")}`;
}

function chartFontFamily(kind: "sans" | "mono") {
  if (typeof document !== "undefined") {
    const variable = kind === "mono" ? "--font-geist-mono" : "--font-geist-sans";
    const family = window.getComputedStyle(document.body).getPropertyValue(variable).trim();
    if (family) return `${family}, ${kind === "mono" ? "SFMono-Regular, Menlo, monospace" : "system-ui, sans-serif"}`;
  }
  return kind === "mono" ? "SFMono-Regular, Menlo, monospace" : "system-ui, sans-serif";
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
  return price.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function chartModesForFrame(
  frame: GholaMarketFrame | null,
  activeMode: GholaChartMode,
  hasCompareFrames: boolean,
): GholaChartMode[] {
  if (frame?.venue === "jupiter" || activeMode === "route" || activeMode === "slippage" || activeMode === "quote") {
    return hasCompareFrames ? ["route", "slippage", "quote", "compare"] : ["route", "slippage", "quote"];
  }
  return hasCompareFrames ? ["candles", "line", "depth", "compare"] : ["candles", "line", "depth"];
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

function chartSummary(
  frame: GholaMarketFrame | null,
  mode: GholaChartMode,
  feedStatus: string | undefined,
  now: number,
) {
  if (!frame) return `${modeLabel(mode).toLowerCase()} · awaiting first tick`;
  const candleUpdatedAt = frame.channelUpdatedAt?.candle;
  const age = typeof candleUpdatedAt === "number" && now > 0
    ? conciseAge(Math.max(0, now - candleUpdatedAt))
    : null;
  const effectiveFeedStatus = feedStatus ?? (frame.stale ? "delayed" : "live");
  const state = effectiveFeedStatus === "live" && !frame.stale
    ? "live"
    : effectiveFeedStatus === "fallback_polling"
      ? "fallback polling"
      : effectiveFeedStatus === "reconnecting"
        ? "reconnecting"
        : effectiveFeedStatus === "unavailable"
          ? "unavailable"
          : effectiveFeedStatus === "connecting"
            ? "connecting"
            : "delayed";
  return `${modeLabel(mode).toLowerCase()} · ${state}${age ? ` · candle ${age}` : ""}`;
}

function conciseAge(ageMs: number) {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}
