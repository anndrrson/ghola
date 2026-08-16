"use client";

import { memo } from "react";

export interface GholaTrendDrawingManagerItem {
  id: string;
  kind: "segment" | "ray";
  first: { time: number; price: number };
  second: { time: number; price: number };
}

export const GholaTrendDrawingManager = memo(function GholaTrendDrawingManager({
  drawings,
  disabled,
  disabledReason,
  onDelete,
}: {
  drawings: GholaTrendDrawingManagerItem[];
  disabled: boolean;
  disabledReason: string | null;
  onDelete: (drawingId: string) => void;
}) {
  if (drawings.length === 0) return null;
  return (
    <details className="border border-[#26334a] bg-[#080d15] text-[10px] text-[#aeb9cb]">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 font-semibold uppercase tracking-[0.12em] text-[#d9bd67] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#f8e58b]">
        Drawing manager · {drawings.length}
      </summary>
      <ol aria-label="Trend drawing inventory" className="max-h-44 overflow-y-auto border-t border-[#1a2638]">
        {drawings.map((drawing, index) => (
          <li key={drawing.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#141d2e] px-2.5 py-1.5 last:border-b-0">
            <span className="font-mono text-[#f8e58b]">T{index + 1}</span>
            <span className="min-w-0 font-mono tabular-nums text-[#8f9db3]">
              <span className="block truncate">{drawing.kind === "ray" ? "Ray →" : "Segment"} · {formatAnchor(drawing.first)}</span>
              <span className="block truncate text-[#65738a]">to {formatAnchor(drawing.second)}</span>
            </span>
            <button
              type="button"
              disabled={disabled}
              title={disabled ? disabledReason ?? undefined : `Delete trend drawing T${index + 1}; TL redo can restore it`}
              aria-label={disabled
                ? `Delete trend drawing T${index + 1} unavailable: ${disabledReason ?? "drawing changes are locked"}`
                : `Delete trend drawing T${index + 1}`}
              onClick={() => onDelete(drawing.id)}
              className="term-chip h-7 px-2 text-[9px] uppercase text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete
            </button>
          </li>
        ))}
      </ol>
      <p className="border-t border-[#1a2638] px-2.5 py-1.5 text-[8px] leading-3 text-[#65738a]">
        Exact browser-local anchors · deleted lines remain recoverable with TL redo until the next drawing branch.
      </p>
    </details>
  );
});

function formatAnchor(anchor: { time: number; price: number }) {
  const time = Number.isFinite(anchor.time)
    ? new Date(anchor.time).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "invalid time";
  const price = Number.isFinite(anchor.price) && anchor.price > 0
    ? anchor.price.toLocaleString([], { maximumFractionDigits: anchor.price >= 1_000 ? 2 : 6 })
    : "invalid price";
  return `${time} @ ${price}`;
}
