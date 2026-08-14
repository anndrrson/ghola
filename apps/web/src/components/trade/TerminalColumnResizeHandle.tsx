"use client";

import { memo, useRef, type KeyboardEvent, type PointerEvent } from "react";

const TERMINAL_COLUMN_KEYBOARD_STEP_PX = 16;

export interface TerminalColumnResizeHandleProps {
  className?: string;
  controls: string;
  cssVariable: `--${string}`;
  defaultValue: number;
  label: string;
  max: number;
  min: number;
  value: number;
  onChange: (value: number) => void;
}

interface PointerDrag {
  grid: HTMLElement;
  latestValue: number;
  pointerId: number;
  startValue: number;
  startX: number;
}

export const TerminalColumnResizeHandle = memo(function TerminalColumnResizeHandle({
  className = "",
  controls,
  cssVariable,
  defaultValue,
  label,
  max,
  min,
  value,
  onChange,
}: TerminalColumnResizeHandleProps) {
  const dragRef = useRef<PointerDrag | null>(null);

  const finishDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (commit) onChange(drag.latestValue);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && dragRef.current) {
      event.preventDefault();
      const drag = dragRef.current;
      drag.grid.style.setProperty(cssVariable, `${drag.startValue}px`);
      event.currentTarget.setAttribute("aria-valuenow", String(drag.startValue));
      event.currentTarget.setAttribute("aria-valuetext", `${drag.startValue} pixels`);
      if (event.currentTarget.hasPointerCapture?.(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
      dragRef.current = null;
      return;
    }
    if (dragRef.current) return;
    const next = terminalRightPanelWidthFromKey(value, event.key, { min, max, defaultValue });
    if (next == null) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div className={className}>
      <div
        role="separator"
        aria-controls={controls}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemax={max}
        aria-valuemin={min}
        aria-valuenow={value}
        aria-valuetext={`${value} pixels`}
        tabIndex={0}
        title={`${label} · arrows resize · double-click resets`}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          const grid = event.currentTarget.parentElement?.parentElement;
          if (!(grid instanceof HTMLElement)) return;
          event.preventDefault();
          dragRef.current = { grid, latestValue: value, pointerId: event.pointerId, startValue: value, startX: event.clientX };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = terminalRightPanelWidthFromDrag(drag.startValue, drag.startX, event.clientX, min, max);
          drag.latestValue = next;
          drag.grid.style.setProperty(cssVariable, `${next}px`);
          event.currentTarget.setAttribute("aria-valuenow", String(next));
          event.currentTarget.setAttribute("aria-valuetext", `${next} pixels`);
        }}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          drag.grid.style.setProperty(cssVariable, `${drag.startValue}px`);
          event.currentTarget.setAttribute("aria-valuenow", String(drag.startValue));
          event.currentTarget.setAttribute("aria-valuetext", `${drag.startValue} pixels`);
          finishDrag(event, false);
        }}
        onLostPointerCapture={(event) => finishDrag(event, true)}
        className="group relative h-full min-h-12 w-2 touch-none cursor-col-resize select-none outline-none focus-visible:bg-sky-400/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300"
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#263249] transition-colors group-hover:bg-sky-400/70 group-focus-visible:bg-sky-300" />
      </div>
    </div>
  );
});

export function terminalRightPanelWidthFromDrag(
  startValue: number,
  startX: number,
  currentX: number,
  min: number,
  max: number,
) {
  return clampInteger(startValue - (currentX - startX), min, max);
}

export function terminalRightPanelWidthFromKey(
  value: number,
  key: string,
  bounds: Readonly<{ min: number; max: number; defaultValue: number }>,
) {
  if (key === "ArrowLeft") return clampInteger(value + TERMINAL_COLUMN_KEYBOARD_STEP_PX, bounds.min, bounds.max);
  if (key === "ArrowRight") return clampInteger(value - TERMINAL_COLUMN_KEYBOARD_STEP_PX, bounds.min, bounds.max);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}
