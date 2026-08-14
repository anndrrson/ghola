"use client";

import { memo } from "react";
import type { TerminalRouteDecision } from "@/lib/terminal-route-decision";

export interface TerminalRouteCheckControlProps {
  active: boolean;
  compareMode: boolean;
  liveVenueCount: number;
  totalVenueCount: number;
  status: TerminalRouteDecision["status"];
  onOpen: () => void;
  onStop: () => void;
}

export const TerminalRouteCheckControl = memo(function TerminalRouteCheckControl({
  active,
  compareMode,
  liveVenueCount,
  totalVenueCount,
  status,
  onOpen,
  onStop,
}: TerminalRouteCheckControlProps) {
  const statusLabel = status === "full_available"
    ? "full visible route"
    : status === "partial_only"
      ? "partial visible route"
      : "awaiting compatible depth";
  return (
    <section className="mt-3 rounded-md border border-[#182234] bg-[#080c13] px-3 py-2.5" aria-labelledby="route-check-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="route-check-heading" className="text-[9px] font-medium uppercase tracking-[0.16em] text-[#6b7997]">Route check</h3>
          <p className="mt-1 text-[10px] text-[#8b95a8]">
            {active
              ? `${liveVenueCount}/${totalVenueCount} venues live · ${statusLabel}`
              : "Peer public feeds stay off until requested."}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-controls="terminal-route-matrix"
            onClick={onOpen}
            className="rounded border border-sky-300/35 bg-sky-300/10 px-2.5 py-1.5 text-[9px] font-medium text-sky-200 hover:bg-sky-300/15"
          >
            {active ? "View route matrix" : "Check compatible routes"}
          </button>
          {active && !compareMode ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded border border-[#2a3951] px-2.5 py-1.5 text-[9px] text-[#9aa7ba] hover:border-[#52617a]"
            >
              Stop peer feeds
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-[9px] leading-4 text-[#66738c]">
        Visible depth only. Checking and staging never preview or submit an order. The full-fill route alert evaluates only while peer feeds run.
      </p>
    </section>
  );
});
