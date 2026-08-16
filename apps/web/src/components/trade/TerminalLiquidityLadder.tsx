"use client";

import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  deriveTerminalLiquidityLadder,
  type TerminalLiquidityLadderBlocker,
  type TerminalLiquidityLadderLevel,
} from "@/lib/terminal-liquidity-ladder";

export interface TerminalLiquidityLadderProps {
  frame: GholaMarketFrame | null;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  limitPrice?: number | null;
  selectedEntryPrice?: number | null;
  selectedVenue?: string;
  selectedProduct?: string;
  selectedInterval?: string;
  stale?: boolean;
  synthetic?: boolean;
  stagingDisabled?: boolean;
  onStagePrice: (price: number) => void;
}

type DisplayLevel = TerminalLiquidityLadderLevel & { key: string };

export const TerminalLiquidityLadder = memo(function TerminalLiquidityLadder({
  frame,
  side,
  requestedNotionalUsd,
  limitPrice,
  selectedEntryPrice,
  selectedVenue,
  selectedProduct,
  selectedInterval,
  stale,
  synthetic,
  stagingDisabled = false,
  onStagePrice,
}: TerminalLiquidityLadderProps) {
  const ladder = useMemo(() => deriveTerminalLiquidityLadder({
    frame,
    side,
    requestedNotionalUsd,
    limitPrice,
    selectedEntryPrice,
    selectedVenue,
    selectedProduct,
    selectedInterval,
    stale,
    synthetic,
  }), [
    frame,
    limitPrice,
    requestedNotionalUsd,
    selectedEntryPrice,
    selectedInterval,
    selectedProduct,
    selectedVenue,
    side,
    stale,
    synthetic,
  ]);
  const rows = useMemo<DisplayLevel[]>(() => [
    ...ladder.asks.slice().reverse().map((level) => ({ ...level, key: `${ladder.venue}:${ladder.product}:${ladder.interval}:ask:${level.price}` })),
    ...ladder.bids.map((level) => ({ ...level, key: `${ladder.venue}:${ladder.product}:${ladder.interval}:bid:${level.price}` })),
  ], [ladder.asks, ladder.bids, ladder.interval, ladder.product, ladder.venue]);
  const preferredIndex = useMemo(() => preferredFocusIndex(
    rows,
    ladder.selectedEntryPrice,
    side,
  ), [ladder.selectedEntryPrice, rows, side]);
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const rowButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const storedActiveIndex = activeRowKey == null ? -1 : rows.findIndex((row) => row.key === activeRowKey);
  const safeActiveIndex = storedActiveIndex >= 0 ? storedActiveIndex : preferredIndex;
  const viewportIdentity = ladder.status === "ready"
    ? `${ladder.venue}:${ladder.product}:${ladder.interval}`
    : null;

  useLayoutEffect(() => {
    if (!viewportIdentity) return;
    const frameId = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const button = rowButtonsRef.current[preferredIndex];
      const row = button?.closest("tr");
      if (!viewport || !row) return;
      const viewportBounds = viewport.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      viewport.scrollTop = centeredLadderScrollTop({
        rowTop: viewport.scrollTop + rowBounds.top - viewportBounds.top,
        rowHeight: rowBounds.height,
        viewportHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [preferredIndex, viewportIdentity]);

  function moveFocus(index: number, direction: -1 | 1) {
    if (rows.length === 0) return;
    const nextIndex = Math.min(rows.length - 1, Math.max(0, index + direction));
    setActiveRowKey(rows[nextIndex]?.key ?? null);
    rowButtonsRef.current[nextIndex]?.focus();
  }

  function handlePriceKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, price: number) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : rows.length - 1;
      setActiveRowKey(rows[nextIndex]?.key ?? null);
      rowButtonsRef.current[nextIndex]?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onStagePrice(price);
    }
  }

  if (ladder.status === "unavailable") {
    return (
      <section aria-labelledby="liquidity-ladder-heading" className="border-b border-[#182234] bg-[#080c13]">
        <h3 id="liquidity-ladder-heading" className="sr-only">Liquidity ladder</h3>
        <p role="status" className="px-4 py-5 text-center text-[10px] leading-4 text-amber-200">
          DOM unavailable · {blockerLabel(ladder.blocker)}
        </p>
        <DepthDisclaimer />
      </section>
    );
  }

  const sweep = ladder.sweep;
  return (
    <section aria-labelledby="liquidity-ladder-heading" className="border-b border-[#182234] bg-[#080c13] font-mono tabular-nums">
      <h3 id="liquidity-ladder-heading" className="sr-only">Liquidity ladder</h3>
      <div className="grid grid-cols-4 gap-px border-b border-[#182234] bg-[#111827] text-center text-[9px]">
        <LadderMetric label={`${side.toUpperCase()} visible fill`} value={sweep ? `${formatUsd(sweep.requestedNotionalUsd)} · ${sweep.fillPct.toFixed(1)}%` : "—"} tone={sweepTone(sweep?.status)} />
        <LadderMetric label="Sweep VWAP" value={formatPrice(sweep?.vwap)} />
        <LadderMetric label="Impact" value={formatBps(sweep?.impactBps)} />
        <LadderMetric label="Unfilled" value={sweep ? formatUsd(sweep.unfilledNotionalUsd) : "—"} />
      </div>

      <p id="liquidity-ladder-keyboard-help" className="sr-only">
        {stagingDisabled
          ? "Price staging is locked while the live execution request settles."
          : "Use Up and Down Arrow keys to navigate displayed prices. Press Enter to stage the exact focused price."}
      </p>
      {stagingDisabled ? (
        <p role="status" className="border-b border-amber-300/20 bg-amber-300/[0.04] px-3 py-2 font-sans text-[9px] leading-3.5 text-amber-100">
          Price staging locked while the live request settles. Displayed depth remains read-only.
        </p>
      ) : null}
      <div
        ref={viewportRef}
        className="max-h-[min(32rem,62dvh)] overflow-auto overscroll-contain"
        role="region"
        aria-label="Scrollable center depth-of-market ladder"
        data-depth-window="bounded"
        tabIndex={0}
      >
        <table
          className="min-w-[25rem] w-full border-collapse text-[10px]"
          aria-describedby="liquidity-ladder-keyboard-help liquidity-ladder-disclaimer"
        >
          <caption className="sr-only">
            Twenty nearest normalized bid and ask levels with size, cumulative base, cumulative notional, entry, and visible sweep markers.
          </caption>
          <thead className="sticky top-0 z-10 bg-[#080c13] text-[8px] uppercase tracking-[0.12em] text-[#6f7d9a]">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left font-normal">Price</th>
              <th scope="col" className="px-2 py-1.5 text-right font-normal">Size</th>
              <th scope="col" className="px-2 py-1.5 text-right font-normal">Cum base</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">Cum $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((level, index) => (
              <Fragment key={level.key}>
                {index === ladder.asks.length ? (
                  <LadderMidRow
                    mid={ladder.mid}
                    spreadBps={ladder.spreadBps}
                    selectedEntryPrice={ladder.selectedEntryPrice}
                    sweepBoundaryPrice={sweep?.boundaryPrice ?? null}
                  />
                ) : null}
                <LadderRow
                  level={level}
                  index={index}
                  active={index === safeActiveIndex}
                  maxCumulativeNotionalUsd={ladder.maxCumulativeNotionalUsd}
                  buttonRef={(node) => { rowButtonsRef.current[index] = node; }}
                  disabled={stagingDisabled}
                  onFocus={() => setActiveRowKey(level.key)}
                  onKeyDown={(event) => handlePriceKeyDown(event, index, level.price)}
                  onStagePrice={onStagePrice}
                />
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <DepthDisclaimer />
    </section>
  );
});

export function centeredLadderScrollTop(input: {
  rowTop: number;
  rowHeight: number;
  viewportHeight: number;
  scrollHeight: number;
}) {
  const values = [input.rowTop, input.rowHeight, input.viewportHeight, input.scrollHeight];
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return 0;
  const maximum = Math.max(0, input.scrollHeight - input.viewportHeight);
  return Math.min(maximum, Math.max(
    0,
    input.rowTop + input.rowHeight / 2 - input.viewportHeight / 2,
  ));
}

function LadderMidRow({
  mid,
  spreadBps,
  selectedEntryPrice,
  sweepBoundaryPrice,
}: {
  mid: number | null;
  spreadBps: number | null;
  selectedEntryPrice: number | null;
  sweepBoundaryPrice: number | null;
}) {
  return (
    <tr className="border-y border-[#2a3951] bg-[#0d1420] text-[9px]">
      <td colSpan={4} className="px-3 py-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-[#9aa7ba]">
            MID <b className="font-normal text-[#eef1f8]">{formatPrice(mid)}</b>
            <span className="ml-2 text-[#6f7d9a]">{formatBps(spreadBps)} spread</span>
          </span>
          {selectedEntryPrice != null ? (
            <span className="rounded-sm border border-sky-400/35 bg-sky-400/10 px-1.5 py-0.5 text-sky-200" title="Selected entry marker">
              ENTRY {formatPrice(selectedEntryPrice)}
            </span>
          ) : null}
          {sweepBoundaryPrice != null ? (
            <span className="rounded-sm border border-amber-400/35 bg-amber-400/10 px-1.5 py-0.5 text-amber-200">
              SWEEP {formatPrice(sweepBoundaryPrice)}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function LadderRow({
  level,
  index,
  active,
  maxCumulativeNotionalUsd,
  buttonRef,
  disabled,
  onFocus,
  onKeyDown,
  onStagePrice,
}: {
  level: DisplayLevel;
  index: number;
  active: boolean;
  maxCumulativeNotionalUsd: number;
  buttonRef: (node: HTMLButtonElement | null) => void;
  disabled: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onStagePrice: (price: number) => void;
}) {
  const depthWidth = maxCumulativeNotionalUsd > 0
    ? Math.min(100, level.cumulativeNotionalUsd / maxCumulativeNotionalUsd * 100)
    : 0;
  const sweepWidth = level.sweepFraction * 100;
  const sideLabel = level.side === "bid" ? "bid" : "ask";
  const priceTone = level.side === "bid" ? "text-emerald-300" : "text-rose-300";
  const depthColor = level.side === "bid" ? "bg-emerald-400/10" : "bg-rose-400/10";
  return (
    <tr
      className={`relative border-t border-[#111a29] ${active ? "bg-sky-400/[0.06]" : "bg-[#080c13]"}`}
    >
      <td className="relative overflow-hidden px-3 py-0 text-left">
        <span aria-hidden className={`absolute inset-y-0 right-0 ${depthColor}`} style={{ width: `${depthWidth}%` }} />
        {sweepWidth > 0 ? (
          <span aria-hidden className="absolute inset-y-0 left-0 bg-amber-300/15" style={{ width: `${sweepWidth}%` }} />
        ) : null}
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          tabIndex={active ? 0 : -1}
          aria-label={disabled
            ? `${sideLabel} price ${formatPrice(level.price)}; staging locked during live execution`
            : `Stage ${sideLabel} price ${formatPrice(level.price)}; size ${formatBase(level.size)}; cumulative ${formatBase(level.cumulativeBase)} base and ${formatUsd(level.cumulativeNotionalUsd)}${level.sweepBoundary ? "; visible sweep boundary" : ""}`}
          className={`relative flex min-h-7 w-full items-center gap-1.5 py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-55 ${priceTone}`}
          onClick={() => onStagePrice(level.price)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
        >
          <span>{formatPrice(level.price)}</span>
          {level.sweepBoundary ? (
            <span className="rounded-sm border border-amber-300/40 px-1 text-[7px] uppercase tracking-[0.1em] text-amber-200">sweep</span>
          ) : null}
          <span className="sr-only">Row {index + 1}</span>
        </button>
      </td>
      <td className="px-2 py-1 text-right text-[#aab5c7]">{formatBase(level.size)}</td>
      <td className="px-2 py-1 text-right text-[#7f8da7]">{formatBase(level.cumulativeBase)}</td>
      <td className="px-3 py-1 text-right text-[#7f8da7]">{formatUsd(level.cumulativeNotionalUsd)}</td>
    </tr>
  );
}

function LadderMetric({ label, value, tone = "text-[#c7d2e4]" }: { label: string; value: string; tone?: string }) {
  return (
    <span className="bg-[#080c13] px-1.5 py-1.5">
      <span className="block text-[7px] uppercase tracking-[0.1em] text-[#6f7d9a]">{label}</span>
      <b className={`mt-0.5 block font-normal ${tone}`}>{value}</b>
    </span>
  );
}

function DepthDisclaimer() {
  return (
    <p id="liquidity-ladder-disclaimer" className="border-t border-[#141d2e] px-3 py-2 text-[8px] leading-3.5 text-[#6f7d9a]">
      Fees are not included. Public visible depth only; excludes queue position, hidden/iceberg liquidity, latency, and execution guarantees.
    </p>
  );
}

function blockerLabel(blocker: TerminalLiquidityLadderBlocker | null) {
  if (blocker === "frame_unavailable") return "waiting for a live book";
  if (blocker === "synthetic_frame") return "synthetic depth is never actionable";
  if (blocker === "stale_frame") return "visible depth is stale";
  if (blocker === "market_identity_mismatch") return "book identity does not match the selected market";
  if (blocker === "requested_notional_invalid") return "enter a positive order notional";
  if (blocker === "limit_price_invalid") return "the selected limit is invalid";
  if (blocker === "entry_price_invalid") return "the selected entry is invalid";
  if (blocker === "book_empty") return "both book sides are required";
  if (blocker === "book_level_invalid") return "the visible book contains invalid or nonpositive depth";
  if (blocker === "book_crossed") return "the visible book is crossed";
  return "visible depth cannot be certified";
}

function sweepTone(status: "none" | "partial" | "full" | undefined) {
  if (status === "full") return "text-emerald-300";
  if (status === "partial") return "text-amber-200";
  if (status === "none") return "text-rose-300";
  return "text-[#c7d2e4]";
}

function preferredFocusIndex(
  rows: DisplayLevel[],
  selectedEntryPrice: number | null,
  side: "buy" | "sell",
) {
  if (rows.length === 0) return 0;
  const preferredBookSide = side === "buy" ? "ask" : "bid";
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.side !== preferredBookSide) continue;
    const distance = selectedEntryPrice == null
      ? side === "buy" ? row.price : -row.price
      : Math.abs(row.price - selectedEntryPrice);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex >= 0 ? bestIndex : 0;
}

const largePriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});
const smallPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const moneyFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return (value >= 1_000 ? largePriceFormatter : smallPriceFormatter).format(value);
}

function formatBase(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1_000 ? moneyFormatter.format(value) : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatUsd(value: number) {
  return Number.isFinite(value) ? `$${moneyFormatter.format(value)}` : "—";
}

function formatBps(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} bp`;
}
