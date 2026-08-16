"use client";

import { memo } from "react";
import {
  terminalEntryPriceStageBlockerLabel,
  type TerminalEntryPriceMode,
  type TerminalEntryPriceStages,
} from "@/lib/terminal-entry-price-staging";

export const TerminalEntryPriceStager = memo(function TerminalEntryPriceStager({
  stages,
  entryPinned,
  entryPrice,
  onAuto,
  onStage,
}: {
  stages: TerminalEntryPriceStages;
  entryPinned: boolean;
  entryPrice: number | null;
  onAuto: () => void;
  onStage: (mode: TerminalEntryPriceMode) => void;
}) {
  const activeMode = !entryPinned
    ? "auto"
    : matches(entryPrice, stages.join?.price)
      ? "join"
      : matches(entryPrice, stages.cross?.price)
        ? "cross"
        : "manual";
  const unavailable = stages.status !== "ready";

  return (
    <section aria-labelledby="entry-price-intent-heading" className="mt-2 rounded-md border border-[#172235] bg-[#080d15] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 id="entry-price-intent-heading" className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Price intent</h3>
        <span className="font-mono text-[8px] tabular-nums text-[#66738c]">
          {stages.status === "unavailable" || stages.quoteAgeMs == null
            ? terminalEntryPriceStageBlockerLabel(stages.blocker)
            : `quote ${formatAge(stages.quoteAgeMs)}`}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5" role="group" aria-label="Limit price intent">
        <IntentButton
          shortcut="U"
          label="Auto mid"
          detail={unavailable ? "waiting" : "tracks"}
          pressed={activeMode === "auto"}
          title={unavailable ? "Clear the manual price and wait for a certified BBO midpoint." : "Track the certified BBO midpoint."}
          onClick={onAuto}
        />
        <IntentButton
          shortcut="J"
          label="Join"
          detail={stages.join ? formatPrice(stages.join.price) : "unavailable"}
          pressed={activeMode === "join"}
          disabled={unavailable}
          title={unavailable ? terminalEntryPriceStageBlockerLabel(stages.blocker) : "Stage the same-side best quote; expected to rest unless the market moves."}
          onClick={() => onStage("join")}
        />
        <IntentButton
          shortcut="X"
          label="Cross"
          detail={stages.cross ? formatPrice(stages.cross.price) : "unavailable"}
          pressed={activeMode === "cross"}
          disabled={unavailable}
          title={unavailable ? terminalEntryPriceStageBlockerLabel(stages.blocker) : "Stage the opposite-side best quote; marketable if that quote remains available."}
          onClick={() => onStage("cross")}
        />
      </div>
      <p className="mt-2 text-[8px] leading-3.5 text-[#66738c]">
        Join targets the same-side BBO. Cross targets the opposite BBO but remains a GTC limit; price movement can change fill or leave it resting. Staging never submits.
      </p>
    </section>
  );
});

function IntentButton({
  label,
  shortcut,
  detail,
  pressed,
  disabled = false,
  title,
  onClick,
}: {
  label: string;
  shortcut: string;
  detail: string;
  pressed: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`min-h-10 rounded border px-2 py-1 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${pressed ? "border-[#5aa7ff]/60 bg-[#5aa7ff]/12 text-[#dcebff]" : "border-[#22304a] bg-[#0a101a] text-[#9aa7ba] hover:border-[#3d5275]"}`}
    >
      <span className="block text-[9px] font-semibold uppercase tracking-[0.08em]">{label}</span>
      <span className="mt-0.5 block truncate font-mono text-[8px] tabular-nums opacity-70">{detail}</span>
    </button>
  );
}

function matches(left: number | null, right: number | undefined) {
  if (left == null || right == null) return false;
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-10);
}

function formatAge(value: number) {
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function formatPrice(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1_000 ? 2 : 6 });
}
