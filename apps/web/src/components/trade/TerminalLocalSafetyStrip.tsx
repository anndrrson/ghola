import { LockKeyhole } from "lucide-react";

export const TERMINAL_LOCAL_SAFETY_LABEL =
  "Local-safe workstation. Charts, analysis, PAPER, and order planning remain available. Worker start, remote preview, autonomous agents, and live submission are disabled. Zero runtime hours.";

export function TerminalLocalSafetyStrip() {
  return (
    <section
      role="note"
      aria-label={TERMINAL_LOCAL_SAFETY_LABEL}
      className="border-b border-[#182234] bg-[#070a10] px-3 py-2 sm:px-6 sm:py-3"
    >
      <div className="flex items-center gap-2 rounded-md border border-amber-300/25 bg-amber-300/[0.04] px-3 py-2 sm:flex-wrap sm:justify-between sm:gap-3 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:items-start sm:gap-3">
          <LockKeyhole aria-hidden className="h-4 w-4 shrink-0 text-amber-300 sm:mt-0.5" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-amber-100 sm:text-xs">
              <span className="sm:hidden">Local safe</span>
              <span className="hidden sm:inline">Local-safe workstation</span>
            </p>
            <p className="text-[10px] leading-4 text-[#8b95a8] sm:mt-0.5 sm:text-[11px] sm:leading-5">
              <span className="sm:hidden">Analysis + PAPER only · live and agents off</span>
              <span className="hidden sm:inline">Charts and order planning stay active. Worker start, remote preview, agent arming, and live submission are disabled.</span>
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-300/[0.06] px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-emerald-300 sm:text-[9px] sm:tracking-[0.14em]">
          <span className="sm:hidden">0 runtime</span>
          <span className="hidden sm:inline">zero runtime hours</span>
        </span>
      </div>
    </section>
  );
}
