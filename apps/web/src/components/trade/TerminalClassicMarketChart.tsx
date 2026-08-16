"use client";

import { Activity } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { decimateCandles, type GholaChartCandle, type GholaMarketFrame } from "@/lib/ghola-market-chart";

type Side = "buy" | "sell";
type GholaChartGap = { afterIndex: number; durationMs: number };

const CHART_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
type ChartIndicator = "sma20" | "ema20" | "vwap" | "bollinger";
export type TerminalClassicPlanState = "draft" | "bound" | "submitting" | "acknowledged";
type ChartDrawing =
  | { id: string; kind: "horizontal"; price: number }
  | { id: string; kind: "trend"; from: { time: number; price: number }; to: { time: number; price: number } };

export type TerminalClassicMarketChartProps = {
  frame: GholaMarketFrame | null;
  feedLabel: string;
  loading: boolean;
  planning: boolean;
  planState: TerminalClassicPlanState;
  side: Side;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  interactionAllowed: boolean;
  onPlanningChange: (planning: boolean) => void;
  onEntryDrag: (price: number) => void;
  onStopDrag: (price: number) => void;
};

export const TerminalClassicMarketChart = memo(function TerminalClassicMarketChart({
  frame,
  feedLabel,
  loading,
  planning,
  planState,
  side,
  entryPrice,
  stopPrice,
  targetPrice,
  interactionAllowed,
  onPlanningChange,
  onEntryDrag,
  onStopDrag,
}: TerminalClassicMarketChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState({ width: 980, height: 520 });
  const [chartStyle, setChartStyle] = useState<"candles" | "line">("candles");
  const [showVolume, setShowVolume] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [indicators, setIndicators] = useState<ChartIndicator[]>(["ema20", "vwap"]);
  const [drawMode, setDrawMode] = useState<"none" | "horizontal" | "trend">("none");
  const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
  const [trendStart, setTrendStart] = useState<{ time: number; price: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const next = {
        width: Math.max(320, Math.round(rect.width)),
        height: Math.max(360, Math.round(rect.height)),
      };
      setChartSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const maxCandles = Math.max(36, Math.min(240, Math.floor(chartSize.width / 9)));
  const visibleCandleCount = Math.max(24, Math.round(maxCandles / zoom));
  const candles = useMemo(
    () => decimateCandles((frame?.candles ?? []).slice(-visibleCandleCount), maxCandles),
    [frame, maxCandles, visibleCandleCount],
  );
  const drawingStorageKey = `ghola:chart-drawings:${frame?.venue ?? "venue"}:${frame?.product ?? "market"}:${frame?.interval ?? "interval"}`;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(drawingStorageKey);
        setDrawings(saved ? JSON.parse(saved) as ChartDrawing[] : []);
      } catch { setDrawings([]); }
      setTrendStart(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [drawingStorageKey]);
  useEffect(() => {
    try { localStorage.setItem(drawingStorageKey, JSON.stringify(drawings)); } catch { /* Continue without persistence. */ }
  }, [drawingStorageKey, drawings]);
  const chart = chartLayout(candles, chartSize.width, chartSize.height);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const [drag, setDrag] = useState<"entry" | "stop" | null>(null);
  const effectiveDrag = planning ? drag : null;
  const hovered = hover ? candles[hover.index] : null;
  const last = candles.at(-1);
  const activeCandle = hovered ?? last;
  const lastClose = last ? Number(last.c) : null;
  const lastUp = last ? Number(last.c) >= Number(last.o) : true;
  const lastColor = lastUp ? "#24d39a" : "#ff6b78";
  const linePath = candleSeriesPath(candles.map((candle) => Number(candle.c)), candles, chart, frame?.interval);
  const indicatorLines = useMemo(() => chartIndicatorLines(candles, indicators), [candles, indicators]);
  const historyGaps = useMemo(() => gholaChartGaps(candles, frame?.interval ?? ""), [candles, frame?.interval]);
  const dataState = !frame
    ? loading ? "Loading history" : "Market unavailable"
    : frame.stale ? "Delayed data"
      : historyGaps.length > 0 ? "History gap"
        : feedLabel;
  const dataTone = !frame || frame.stale || historyGaps.length > 0 ? "warn" : "live";
  const entryColor = side === "buy" ? "#34d399" : "#fb7185";
  const entryY = planning && entryPrice != null && entryPrice > 0 ? chart.y(entryPrice) : null;
  const stopY = planning && stopPrice != null && stopPrice > 0 ? chart.y(stopPrice) : null;
  const targetY = planning && targetPrice != null && targetPrice > 0 ? chart.y(targetPrice) : null;
  const planStateLabel = planState.toUpperCase();
  const HIT_RADIUS = 12;
  const hoverNearLine =
    hover != null &&
    [entryY, stopY].some((lineY) => lineY != null && Math.abs(hover.y - lineY) <= HIT_RADIUS);

  function svgPoint(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (chart.width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (chart.height / Math.max(1, rect.height)),
    };
  }

  function clampPlotY(y: number) {
    return Math.min(chart.height - chart.padding.bottom, Math.max(chart.padding.top, y));
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (candles.length === 0) return;
    const { x, y } = svgPoint(event);
    if (effectiveDrag) {
      if (!planning || !interactionAllowed) return;
      const price = chart.priceAt(clampPlotY(y));
      if (Number.isFinite(price) && price > 0) {
        if (effectiveDrag === "entry") onEntryDrag(price);
        else onStopDrag(price);
      }
      return;
    }
    const ratio = (x - chart.padding.left) / Math.max(1, chart.plotWidth);
    const index = Math.min(candles.length - 1, Math.max(0, Math.round(ratio * (candles.length - 1))));
    setHover({ index, y: clampPlotY(y) });
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (!interactionAllowed || candles.length === 0) return;
    const { x, y } = svgPoint(event);
    if (drawMode !== "none") {
      const ratio = (x - chart.padding.left) / Math.max(1, chart.plotWidth);
      const index = Math.min(candles.length - 1, Math.max(0, Math.round(ratio * (candles.length - 1))));
      const point = { time: candles[index].t, price: roundForInput(chart.priceAt(clampPlotY(y))) };
      if (drawMode === "horizontal") {
        setDrawings((current) => current.concat({ id: crypto.randomUUID(), kind: "horizontal", price: point.price }));
        setDrawMode("none");
      } else if (!trendStart) {
        setTrendStart(point);
      } else {
        setDrawings((current) => current.concat({ id: crypto.randomUUID(), kind: "trend", from: trendStart, to: point }));
        setTrendStart(null);
        setDrawMode("none");
      }
      event.preventDefault();
      return;
    }
    if (!planning) return;
    const nearEntry = entryY != null && Math.abs(y - entryY) <= HIT_RADIUS;
    const nearStop = stopY != null && Math.abs(y - stopY) <= HIT_RADIUS;
    let target: "entry" | "stop" | null = null;
    if (nearEntry && nearStop) {
      target = Math.abs(y - (entryY as number)) <= Math.abs(y - (stopY as number)) ? "entry" : "stop";
    } else if (nearEntry) {
      target = "entry";
    } else if (nearStop) {
      target = "stop";
    }
    if (target) {
      setDrag(target);
      setHover(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    if (drag) {
      setDrag(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  return (
    <div
      ref={containerRef}
      data-terminal-chart-root
      className="relative h-[clamp(28rem,62vh,56rem)] overflow-hidden rounded-md border border-[#263243] bg-[#070a0f] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
    >
      <div className="absolute left-3 top-3 z-10 flex max-w-[46%] items-center gap-2 overflow-x-auto font-mono text-[10px] tabular-nums [scrollbar-width:none]">
        <span className="pointer-events-none inline-flex h-7 shrink-0 items-center gap-2 rounded border border-[#263548] bg-[#090e16]/95 px-2.5 text-[#d7e0ec] shadow-lg backdrop-blur">
          <Activity className="h-3.5 w-3.5 text-[#63b3ff]" />
          <strong className="font-semibold">{frame?.product ?? "MARKET"}</strong>
          {frame?.interval ? <span className="text-[#74839a]">{frame.interval}</span> : null}
        </span>
        <span className={`pointer-events-none inline-flex h-7 shrink-0 items-center gap-1.5 rounded border bg-[#090e16]/95 px-2.5 uppercase tracking-[0.08em] ${dataTone === "live" ? "border-emerald-400/25 text-emerald-200" : "border-amber-400/25 text-amber-200"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dataTone === "live" ? "bg-emerald-300" : "bg-amber-300"}`} />
          {dataState}
        </span>
        <button
          type="button"
          aria-label={planning ? "Hide projected trade levels" : "Show projected trade levels"}
          aria-pressed={planning}
          disabled={planState === "submitting"}
          onClick={() => {
            setDrag(null);
            onPlanningChange(!planning);
          }}
          className={`h-7 shrink-0 rounded border px-2.5 uppercase tracking-[0.08em] transition disabled:cursor-wait disabled:opacity-60 ${planning ? "border-[#4d7fa9] bg-[#10263a]/95 text-[#b9ddff]" : "border-[#273548] bg-[#090e16]/95 text-[#7f8da3] hover:border-[#3c526e] hover:text-[#c4d0df]"}`}
        >
          {planning ? `Plan · ${planStateLabel}` : "Plan trade"}
        </button>
      </div>
      <div data-chart-toolbar="terminal" className="absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-0.5 overflow-x-auto rounded border border-[#263548] bg-[#090e16]/95 p-1 text-[10px] font-medium text-[#91a0b6] shadow-lg backdrop-blur [scrollbar-width:none]">
        {(["candles", "line"] as const).map((style) => (
          <button key={style} type="button" aria-pressed={chartStyle === style} onClick={() => setChartStyle(style)} className={`h-7 rounded px-2.5 capitalize ${chartStyle === style ? "bg-[#174263] text-[#d8efff]" : "hover:bg-[#121c29] hover:text-[#d5deea]"}`}>
            {style}
          </button>
        ))}
        <button type="button" aria-pressed={showVolume} onClick={() => setShowVolume((value) => !value)} className={`h-7 rounded px-2 ${showVolume ? "bg-[#182534] text-[#c6d2e2]" : "hover:bg-[#121c29] hover:text-[#d5deea]"}`}>Vol</button>
        {(["ema20", "sma20", "vwap", "bollinger"] as const).map((indicator) => (
          <button key={indicator} type="button" aria-pressed={indicators.includes(indicator)} onClick={() => setIndicators((current) => current.includes(indicator) ? current.filter((item) => item !== indicator) : current.concat(indicator))} className={`h-7 rounded px-2 uppercase ${indicators.includes(indicator) ? "bg-[#182534] text-[#c6d2e2]" : "hover:bg-[#121c29] hover:text-[#d5deea]"}`}>{indicator === "bollinger" ? "BB" : indicator.replace("20", "")}</button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-[#202b3a]" />
        <button type="button" aria-pressed={drawMode === "horizontal"} onClick={() => { setDrawMode(drawMode === "horizontal" ? "none" : "horizontal"); setTrendStart(null); }} className={`h-7 rounded px-2 ${drawMode === "horizontal" ? "bg-[#174263] text-[#d8efff]" : "hover:bg-[#121c29] hover:text-white"}`}>H-line</button>
        <button type="button" aria-pressed={drawMode === "trend"} onClick={() => { setDrawMode(drawMode === "trend" ? "none" : "trend"); setTrendStart(null); }} className={`h-7 rounded px-2 ${drawMode === "trend" ? "bg-[#174263] text-[#d8efff]" : "hover:bg-[#121c29] hover:text-white"}`}>Trend</button>
        {drawings.length > 0 ? <button type="button" onClick={() => { setDrawings([]); setTrendStart(null); }} className="h-7 rounded px-2 text-rose-300 hover:bg-rose-400/10 hover:text-rose-200">Clear</button> : null}
        <span className="mx-0.5 h-4 w-px bg-[#202b3a]" />
        <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value / 1.35))} className="h-7 rounded px-2 hover:bg-[#182534] hover:text-white disabled:opacity-35">−</button>
        <button type="button" onClick={() => setZoom(1)} className="h-7 rounded px-2 hover:bg-[#182534] hover:text-white">Fit</button>
        <button type="button" aria-label="Zoom in" disabled={candles.length < 2 || zoom >= 5} onClick={() => setZoom((value) => Math.min(5, value * 1.35))} className="h-7 rounded px-2 hover:bg-[#182534] hover:text-white disabled:opacity-35">+</button>
      </div>
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className={`h-full w-full touch-none ${!interactionAllowed ? "cursor-not-allowed" : effectiveDrag ? "cursor-grabbing" : hoverNearLine ? "cursor-ns-resize" : "cursor-crosshair"}`}
        role="img"
        aria-label={`${frame?.product ?? "Market"} ${frame?.interval ?? ""} trading chart. ${dataState}. ${planning ? `Projected ${planState} entry visible; planned exit and target are not venue orders.` : "No projected order levels shown."} ${interactionAllowed ? "Certified chart interactions enabled." : "Price staging and drawings are read only until candle data is certified."}`}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={(event) => {
          event.preventDefault();
          setZoom((value) => event.deltaY < 0 ? Math.min(5, value * 1.12) : Math.max(1, value / 1.12));
        }}
        onPointerLeave={(event) => {
          setHover(null);
          handlePointerUp(event);
        }}
      >
        <rect width={chart.width} height={chart.height} fill="#070a0f" />
        <rect x={chart.width - chart.padding.right} y={chart.padding.top} width={chart.padding.right} height={chart.plotHeight} fill="#090d14" />
        <line x1={chart.width - chart.padding.right} x2={chart.width - chart.padding.right} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke="#263243" strokeWidth="1" />
        {chart.timeTicks.map((tick) => (
          <g key={`t-${tick.x}`}>
            <line x1={tick.x} x2={tick.x} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke="#182334" strokeWidth="1" />
            <text x={tick.x} y={chart.height - 14} textAnchor={tick.x === chart.padding.left ? "start" : "middle"} fill={tick.major ? "#98a8bd" : "#718097"} fontSize="10" fontFamily={CHART_FONT}>
              {tick.label}
            </text>
          </g>
        ))}
        {chart.grid.map((line) => (
          <g key={line.y}>
            <line x1={chart.padding.left} x2={chart.width - chart.padding.right} y1={line.y} y2={line.y} stroke="#1b293b" strokeWidth="1" />
            <text x={chart.width - chart.padding.right + 10} y={line.y + 4} textAnchor="start" fill="#8796aa" fontSize="11" fontFamily={CHART_FONT}>
              {formatPrice(line.price)}
            </text>
          </g>
        ))}
        {showVolume && chart.maxVolume > 0 ? (
          <g>
            <line x1={chart.padding.left} x2={chart.width - chart.padding.right} y1={chart.volumeTop} y2={chart.volumeTop} stroke="#223044" strokeWidth="1" />
            <text x={chart.padding.left + 4} y={chart.volumeTop + 13} fill="#64748b" fontSize="9" fontFamily={CHART_FONT}>VOL</text>
          </g>
        ) : null}
        {historyGaps.map((gap) => {
          const x = chart.x(gap.afterIndex + 0.5);
          return (
            <g key={`gap-${gap.afterIndex}`}>
              <rect x={x - 4} y={chart.padding.top} width="8" height={chart.plotHeight} fill="#f59e0b" opacity="0.08" />
              <line x1={x} x2={x} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke="#fbbf24" strokeWidth="1" strokeDasharray="3 5" opacity="0.7" />
              <text x={x + 6} y={chart.padding.top + 36} fill="#fbbf24" fontSize="9" fontFamily={CHART_FONT}>DATA GAP · {formatChartDuration(gap.durationMs)}</text>
            </g>
          );
        })}
        {showVolume && chart.maxVolume > 0 && candles.map((candle, index) => {
          const volume = Number(candle.v);
          if (!Number.isFinite(volume) || volume <= 0) return null;
          const x = chart.x(index);
          const barHeight = Math.max(1, (volume / chart.maxVolume) * chart.volumeHeight);
          const up = Number(candle.c) >= Number(candle.o);
          return (
            <rect
              key={`v-${candle.t}-${index}`}
              x={x - chart.candleWidth / 2}
              y={chart.height - chart.padding.bottom - barHeight}
              width={chart.candleWidth}
              height={barHeight}
              fill={up ? "#24d39a" : "#ff6b78"}
              opacity={hover?.index === index ? 0.52 : 0.24}
            />
          );
        })}
        {chartStyle === "candles" && candles.map((candle, index) => {
          const x = chart.x(index);
          const open = chart.y(Number(candle.o));
          const close = chart.y(Number(candle.c));
          const high = chart.y(Number(candle.h));
          const low = chart.y(Number(candle.l));
          const up = Number(candle.c) >= Number(candle.o);
          const dimmed = hover != null && hover.index !== index;
          return (
            <g key={`${candle.t}-${index}`} opacity={dimmed ? 0.62 : 1}>
              <line x1={x} x2={x} y1={high} y2={low} stroke={up ? "#52e0ad" : "#ff8b96"} strokeWidth="1.25" />
              <rect
                x={x - chart.candleWidth / 2}
                y={Math.min(open, close)}
                width={chart.candleWidth}
                height={Math.max(2, Math.abs(close - open))}
                fill={up ? "#24d39a" : "#ff6b78"}
                rx="0.75"
              />
            </g>
          );
        })}
        {chartStyle === "line" && linePath && (
          <path d={linePath} fill="none" stroke="#35d1a2" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        )}
        {indicatorLines.map((line) => (
          <path key={line.id} d={candleSeriesPath(line.values, candles, chart, frame?.interval)} fill="none" stroke={line.color} strokeWidth="1.25" strokeDasharray={line.dashed ? "5 4" : undefined} opacity="0.9" vectorEffect="non-scaling-stroke" />
        ))}
        {drawings.map((drawing) => <ChartDrawingSvg key={drawing.id} drawing={drawing} candles={candles} chart={chart} />)}
        {trendStart && <circle cx={chart.x(nearestCandleIndex(candles, trendStart.time))} cy={chart.y(trendStart.price)} r="4" fill="#9ccfff" />}
        {targetY != null && targetPrice != null && (
          plotContainsY(targetY, chart) ? (
            <g opacity="0.82">
              <line x1={chart.padding.left} x2={chart.width - chart.padding.right + 4} y1={targetY} y2={targetY} stroke="#62d6a3" strokeWidth="1" strokeDasharray="5 5" />
              <Label x={28} y={targetY - 9} color="#62d6a3" text="PLAN TARGET · NOT SENT" />
              <PriceTag y={targetY} chart={chart} color="#62d6a3" text={formatPrice(targetPrice)} />
            </g>
          ) : <OffscreenPlanLevel chart={chart} color="#62d6a3" kind="TARGET" price={targetPrice} y={targetY} />
        )}
        {stopY != null && stopPrice != null && (
          plotContainsY(stopY, chart) ? (
            <g opacity="0.82">
              <line x1={chart.padding.left} x2={chart.width - chart.padding.right + 4} y1={stopY} y2={stopY} stroke="#fb7185" strokeWidth="1" strokeDasharray="5 5" />
              <DragGrip y={stopY} chart={chart} color="#fb7185" />
              <Label x={28} y={stopY + 16} color="#fb7185" text="PLAN EXIT · NOT SENT" />
              <PriceTag y={stopY} chart={chart} color="#fb7185" text={formatPrice(stopPrice)} />
            </g>
          ) : <OffscreenPlanLevel chart={chart} color="#fb7185" kind="EXIT" price={stopPrice} y={stopY} />
        )}
        {entryY != null && entryPrice != null && (
          plotContainsY(entryY, chart) ? (
          <g>
            <line x1={chart.padding.left} x2={chart.width - chart.padding.right + 4} y1={entryY} y2={entryY} stroke={entryColor} strokeWidth="1.25" />
            <DragGrip y={entryY} chart={chart} color={entryColor} />
            <Label x={28} y={entryY - 10} color={entryColor} text={`${planStateLabel} · ${side.toUpperCase()} ENTRY`} />
            <PriceTag y={entryY} chart={chart} color={entryColor} text={formatPrice(entryPrice)} />
          </g>
          ) : <OffscreenPlanLevel chart={chart} color={entryColor} kind="ENTRY" price={entryPrice} y={entryY} />
        )}
        {lastClose != null && (
          <g>
            <line
              x1="0"
              x2={chart.width - chart.padding.right + 4}
              y1={chart.y(lastClose)}
              y2={chart.y(lastClose)}
              stroke={lastColor}
              strokeWidth="1"
              strokeDasharray="2 4"
              opacity="0.85"
            />
            <PriceTag y={chart.y(lastClose)} chart={chart} color={lastColor} text={formatPrice(lastClose)} solid />
          </g>
        )}
        {hover && hovered && (
          <g>
            <line
              x1={chart.x(hover.index)}
              x2={chart.x(hover.index)}
              y1={chart.padding.top}
              y2={chart.height - chart.padding.bottom}
              stroke="#3a4a64"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={hover.y} y2={hover.y} stroke="#3a4a64" strokeWidth="1" strokeDasharray="4 4" />
            <PriceTag y={hover.y} chart={chart} color="#8fa3c4" text={formatPrice(chart.priceAt(hover.y))} />
            <TimeTag x={chart.x(hover.index)} chart={chart} text={formatChartTime(hovered.t)} />
          </g>
        )}
      </svg>
      {activeCandle ? (
        <div data-chart-inspection-strip="terminal" className="pointer-events-none absolute left-3 top-12 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-3 overflow-hidden rounded border border-[#202c3d] bg-[#080d14]/92 px-2.5 py-1.5 font-mono text-[10px] tabular-nums text-[#aebbd0] shadow-lg backdrop-blur-sm">
          <span className="shrink-0 text-[#6f8098]">{formatChartDateTime(activeCandle.t)}</span>
          <OhlcStat label="O" value={formatPrice(Number(activeCandle.o))} />
          <OhlcStat label="H" value={formatPrice(Number(activeCandle.h))} />
          <OhlcStat label="L" value={formatPrice(Number(activeCandle.l))} />
          <OhlcStat
            label="C"
            value={formatPrice(Number(activeCandle.c))}
            color={Number(activeCandle.c) >= Number(activeCandle.o) ? "#52e0ad" : "#ff8b96"}
          />
          {Number(activeCandle.v) > 0 ? <OhlcStat label="V" value={formatCompact(activeCandle.v)} /> : null}
        </div>
      ) : null}
      {candles.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded border border-[#273448] bg-[#0a0f17]/95 px-4 py-3 text-center shadow-xl">
            <p className="text-xs font-semibold text-[#d5deea]">{loading ? "Loading verified market history" : "Market history unavailable"}</p>
            <p className="mt-1 text-[10px] text-[#76869c]">No synthetic candles are displayed.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}, (previous, next) =>
  previous.frame?.venue === next.frame?.venue &&
  previous.frame?.product === next.frame?.product &&
  previous.frame?.interval === next.frame?.interval &&
  previous.frame?.stale === next.frame?.stale &&
  previous.frame?.candles === next.frame?.candles &&
  previous.feedLabel === next.feedLabel &&
  previous.loading === next.loading &&
  previous.planning === next.planning &&
  previous.planState === next.planState &&
  previous.side === next.side &&
  previous.entryPrice === next.entryPrice &&
  previous.stopPrice === next.stopPrice &&
  previous.targetPrice === next.targetPrice &&
  previous.interactionAllowed === next.interactionAllowed &&
  previous.onPlanningChange === next.onPlanningChange &&
  previous.onEntryDrag === next.onEntryDrag &&
  previous.onStopDrag === next.onStopDrag
);

function chartIndicatorLines(candles: GholaMarketFrame["candles"], active: ChartIndicator[]) {
  const closes = candles.map((candle) => Number(candle.c));
  const volumes = candles.map((candle) => Number(candle.v) || 0);
  const sma = rollingMean(closes, 20);
  const lines: Array<{ id: string; color: string; dashed?: boolean; values: Array<number | null> }> = [];
  if (active.includes("sma20")) lines.push({ id: "sma20", color: "#f8e56b", values: sma });
  if (active.includes("ema20")) lines.push({ id: "ema20", color: "#7fc1ff", values: exponentialMean(closes, 20) });
  if (active.includes("vwap")) {
    let cumulativeValue = 0;
    let cumulativeVolume = 0;
    lines.push({ id: "vwap", color: "#c4a7ff", dashed: true, values: candles.map((candle, index) => {
      const volume = volumes[index];
      cumulativeValue += ((Number(candle.h) + Number(candle.l) + Number(candle.c)) / 3) * volume;
      cumulativeVolume += volume;
      return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : null;
    }) });
  }
  if (active.includes("bollinger")) {
    const deviation = rollingDeviation(closes, 20);
    lines.push({ id: "bb-upper", color: "#657b9a", dashed: true, values: sma.map((value, index) => value == null || deviation[index] == null ? null : value + 2 * deviation[index]!) });
    lines.push({ id: "bb-lower", color: "#657b9a", dashed: true, values: sma.map((value, index) => value == null || deviation[index] == null ? null : value - 2 * deviation[index]!) });
  }
  return lines;
}

function rollingMean(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

function exponentialMean(values: number[], period: number): Array<number | null> {
  const multiplier = 2 / (period + 1);
  let value: number | null = null;
  return values.map((next, index) => {
    value = value == null ? next : next * multiplier + value * (1 - multiplier);
    return index >= period - 1 ? value : null;
  });
}

function rollingDeviation(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => {
    if (index < period - 1) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    return Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
  });
}

function candleSeriesPath(
  values: Array<number | null>,
  candles: GholaChartCandle[],
  chart: ReturnType<typeof chartLayout>,
  interval: string | undefined,
) {
  let penUp = true;
  return values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) { penUp = true; return ""; }
    if (index > 0 && interval && isGholaChartGap(candles[index - 1], candles[index], interval)) penUp = true;
    const command = penUp ? "M" : "L";
    penUp = false;
    return `${command}${chart.x(index)} ${chart.y(value)}`;
  }).join(" ");
}

function nearestCandleIndex(candles: GholaMarketFrame["candles"], time: number) {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  candles.forEach((candle, index) => {
    const next = Math.abs(candle.t - time);
    if (next < distance) { distance = next; nearest = index; }
  });
  return nearest;
}

function ChartDrawingSvg({ drawing, candles, chart }: { drawing: ChartDrawing; candles: GholaMarketFrame["candles"]; chart: ReturnType<typeof chartLayout> }) {
  if (drawing.kind === "horizontal") {
    const y = chart.y(drawing.price);
    return <line x1="0" x2={chart.width} y1={y} y2={y} stroke="#9ccfff" strokeWidth="1" strokeDasharray="3 3" />;
  }
  return (
    <line
      x1={chart.x(nearestCandleIndex(candles, drawing.from.time))}
      y1={chart.y(drawing.from.price)}
      x2={chart.x(nearestCandleIndex(candles, drawing.to.time))}
      y2={chart.y(drawing.to.price)}
      stroke="#9ccfff"
      strokeWidth="1.25"
    />
  );
}

function DragGrip({ y, chart, color }: { y: number; chart: ReturnType<typeof chartLayout>; color: string }) {
  const x = chart.width - chart.padding.right - 34;
  return (
    <g>
      <rect x={x} y={y - 7} width="26" height="14" fill="#070a10" stroke={color} strokeOpacity="0.7" rx="3" />
      <line x1={x + 6} x2={x + 20} y1={y - 2.5} y2={y - 2.5} stroke={color} strokeWidth="1.2" />
      <line x1={x + 6} x2={x + 20} y1={y + 2.5} y2={y + 2.5} stroke={color} strokeWidth="1.2" />
    </g>
  );
}

function OhlcStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[#566278]">{label}</span>
      <span style={color ? { color } : undefined} className={color ? undefined : "text-[#eef1f8]"}>{value}</span>
    </span>
  );
}

function PriceTag({
  y,
  chart,
  color,
  text,
  solid,
}: {
  y: number;
  chart: ReturnType<typeof chartLayout>;
  color: string;
  text: string;
  solid?: boolean;
}) {
  const x = chart.width - chart.padding.right + 4;
  const tagWidth = chart.padding.right - 6;
  return (
    <g>
      <rect x={x} y={y - 10} width={tagWidth} height="20" fill={solid ? color : "#0b1322"} stroke={color} strokeWidth="1" rx="2" />
      <text
        x={x + tagWidth / 2}
        y={y + 4}
        textAnchor="middle"
        fill={solid ? "#05070b" : color}
        fontSize="11"
        fontWeight={solid ? 700 : 400}
        fontFamily={CHART_FONT}
      >
        {text}
      </text>
    </g>
  );
}

function TimeTag({ x, chart, text }: { x: number; chart: ReturnType<typeof chartLayout>; text: string }) {
  const width = 52;
  const left = Math.min(chart.width - chart.padding.right - width, Math.max(2, x - width / 2));
  return (
    <g>
      <rect x={left} y={chart.height - chart.padding.bottom + 4} width={width} height="18" fill="#0b1322" stroke="#3a4a64" strokeWidth="1" rx="2" />
      <text x={left + width / 2} y={chart.height - chart.padding.bottom + 17} textAnchor="middle" fill="#8fa3c4" fontSize="10" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}

function OffscreenPlanLevel({
  chart,
  color,
  kind,
  price,
  y,
}: {
  chart: ReturnType<typeof chartLayout>;
  color: string;
  kind: "ENTRY" | "EXIT" | "TARGET";
  price: number;
  y: number;
}) {
  const above = y < chart.padding.top;
  const edgeY = above ? chart.padding.top + 11 : chart.height - chart.padding.bottom - 11;
  const x = chart.width - chart.padding.right - 8;
  return (
    <g>
      <path d={above ? `M${x - 5} ${edgeY + 4} L${x} ${edgeY - 4} L${x + 5} ${edgeY + 4} Z` : `M${x - 5} ${edgeY - 4} L${x} ${edgeY + 4} L${x + 5} ${edgeY - 4} Z`} fill={color} />
      <text x={x - 10} y={edgeY + 4} textAnchor="end" fill={color} fontSize="10" fontFamily={CHART_FONT}>
        {kind === "ENTRY" ? "ENTRY" : `PLAN ${kind} · NOT SENT`} {above ? "↑" : "↓"} {formatPrice(price)}
      </text>
    </g>
  );
}

function plotContainsY(y: number, chart: ReturnType<typeof chartLayout>) {
  return y >= chart.padding.top && y <= chart.height - chart.padding.bottom;
}

function Label({ x, y, color, text }: { x: number; y: number; color: string; text: string }) {
  return (
    <g>
      <rect x={x - 8} y={y - 14} width={Math.max(80, text.length * 6.8 + 16)} height="20" fill="#070a10" fillOpacity="0.92" stroke={color} rx="2" />
      <text x={x} y={y} fill={color} fontSize="11" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}


function chartLayout(
  candles: GholaChartCandle[],
  width = 980,
  height = 520,
) {
  const padding = { top: 78, right: 86, bottom: 38, left: 18 };
  const candlePrices = candles.flatMap((candle) => [Number(candle.h), Number(candle.l), Number(candle.o), Number(candle.c)]);
  const prices = candlePrices.filter((price) => Number.isFinite(price) && price > 0);
  const fallbackMid = 100;
  const rangePrices = prices.length > 0 ? prices : [fallbackMid];
  const minRaw = Math.min(...rangePrices);
  const maxRaw = Math.max(...rangePrices);
  const pad = Math.max((maxRaw - minRaw) * 0.16, maxRaw * 0.002);
  const min = minRaw - pad;
  const max = maxRaw + pad;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const volumeHeight = Math.min(64, Math.max(36, plotHeight * 0.16));
  const volumeTop = height - padding.bottom - volumeHeight;
  const candleWidth = Math.max(3, Math.min(9, plotWidth / Math.max(1, candles.length) * 0.58));
  const y = (price: number) => padding.top + ((max - price) / Math.max(1e-9, max - min)) * plotHeight;
  const x = (index: number) => padding.left + (index / Math.max(1, candles.length - 1)) * plotWidth;
  const priceAt = (yPos: number) => max - ((yPos - padding.top) / Math.max(1e-9, plotHeight)) * (max - min);
  const grid = Array.from({ length: 6 }, (_, index) => {
    const price = min + ((max - min) * index) / 5;
    return { price, y: y(price) };
  });
  const tickCount = Math.min(6, Math.max(2, candles.length));
  const timeTickIndexes = candles.length > 1
    ? Array.from(new Set(Array.from({ length: tickCount }, (_, index) =>
        Math.round((index * (candles.length - 1)) / (tickCount - 1)))))
    : [];
  const timeTicks = timeTickIndexes.map((index, tickIndex) => {
    const timestamp = candles[index].t;
    const previousTimestamp = tickIndex > 0 ? candles[timeTickIndexes[tickIndex - 1]].t : null;
    const major = previousTimestamp == null || chartDateKey(timestamp) !== chartDateKey(previousTimestamp);
    return { x: x(index), label: formatChartAxisTime(timestamp, major), major };
  });
  const maxVolume = Math.max(0, ...candles.map((candle) => Number(candle.v)).filter(Number.isFinite));
  return { width, height, padding, plotWidth, plotHeight, volumeHeight, volumeTop, y, x, priceAt, candleWidth, grid, timeTicks, maxVolume };
}

function formatChartTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatChartAxisTime(timestamp: number, includeDate: boolean) {
  if (!includeDate) return formatChartTime(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp)).replace(",", " ·").toUpperCase();
}

function formatChartDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp)).replace(",", " ·").toUpperCase();
}

function chartDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatChartDuration(durationMs: number) {
  if (durationMs >= 3_600_000) return `${Math.round(durationMs / 3_600_000)}H`;
  return `${Math.round(durationMs / 60_000)}M`;
}



const CHART_INTERVAL_PATTERN = /^(\d+)(m|h|d)$/;

function gholaChartIntervalMs(interval: string): number | null {
  const match = CHART_INTERVAL_PATTERN.exec(interval.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return amount * unitMs;
}

function gholaChartGaps(candles: readonly GholaChartCandle[], interval: string, toleranceIntervals = 3): GholaChartGap[] {
  const intervalMs = gholaChartIntervalMs(interval);
  if (intervalMs == null || candles.length < 2) return [];
  const threshold = intervalMs * Math.max(1, toleranceIntervals);
  const gaps: GholaChartGap[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const durationMs = candles[index].t - candles[index - 1].t;
    if (Number.isFinite(durationMs) && durationMs > threshold) gaps.push({ afterIndex: index - 1, durationMs });
  }
  return gaps;
}

function isGholaChartGap(previous: Pick<GholaChartCandle, "t"> | null | undefined, current: Pick<GholaChartCandle, "t"> | null | undefined, interval: string) {
  const intervalMs = gholaChartIntervalMs(interval);
  return Boolean(previous && current && intervalMs != null && current.t - previous.t > intervalMs * 3);
}

function roundForInput(value: number) {
  return Number(value.toFixed(value >= 1_000 ? 1 : 4));
}

function formatPrice(value: number | string | null | undefined) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(number) || !number) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number(number) >= 1_000 ? 1 : 2,
    maximumFractionDigits: Number(number) >= 1_000 ? 1 : 4,
  }).format(Number(number));
}

function formatCompact(value: string | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(number);
}
