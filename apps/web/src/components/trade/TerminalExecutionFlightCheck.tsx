"use client";

import { memo } from "react";
import type {
  TerminalExecutionFlightAction,
  TerminalExecutionFlightCheck as TerminalExecutionFlightCheckDecision,
  TerminalExecutionFlightStatus,
} from "@/lib/terminal-execution-flight-check";

export const TerminalExecutionFlightCheck = memo(function TerminalExecutionFlightCheck({
  decision,
  onAction,
}: {
  decision: TerminalExecutionFlightCheckDecision;
  onAction: (action: TerminalExecutionFlightAction) => void;
}) {
  const blockers = decision.stages.filter((stage) => stage.status === "blocked" || stage.status === "pending");
  const additionalBlockers = blockers.slice(1);
  const warnings = decision.stages.filter((stage) => stage.status === "warning");
  return (
    <section aria-labelledby="execution-flight-check-heading" className="mb-4 overflow-hidden rounded-md border border-[#182234] bg-[#080c13]">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div>
          <h2 id="execution-flight-check-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Execution flight check</h2>
          <p className="mt-1 text-[9px] leading-4 text-[#66738c]">Ordered local gates; server and venue checks remain authoritative.</p>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${decision.ready ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-200" : "border-amber-300/35 bg-amber-300/10 text-amber-100"}`}>
          {decision.ready
            ? decision.warningCount > 0 ? `ready · ${decision.warningCount} warn` : "ready"
            : `${decision.blockingCount} block${decision.blockingCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <ol className="grid grid-cols-2 border-t border-[#141d2e] sm:grid-cols-4 lg:grid-cols-6" aria-label="Execution readiness stages">
        {decision.stages.map((stage) => (
          <li key={stage.id} className="min-w-0 border-b border-r border-[#141d2e] px-2.5 py-2">
            <span className={`block text-[8px] font-semibold uppercase tracking-[0.1em] ${statusTone(stage.status)}`}>{statusLabel(stage.status)}</span>
            <span className="mt-0.5 block truncate text-[9px] text-[#aeb9cb]" title={stage.detail}>{stage.label}</span>
          </li>
        ))}
      </ol>
      {decision.firstBlocker ? (
        <>
          <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 border-t border-[#141d2e] bg-amber-300/[0.03] px-3 py-2">
            <p className="min-w-0 flex-1 text-[9px] leading-4 text-amber-100">
              <span className="font-semibold">Next · {decision.firstBlocker.label}:</span> {decision.firstBlocker.detail}
            </p>
            {decision.firstBlocker.action ? (
              <FlightActionButton action={decision.firstBlocker.action} onAction={onAction} />
            ) : null}
          </div>
          {additionalBlockers.length > 0 ? (
            <details className="border-t border-[#141d2e] bg-[#070b12]">
              <summary className="cursor-pointer px-3 py-2 text-[9px] font-semibold text-[#9aa7ba] hover:text-[#dce6f4]">
                {additionalBlockers.length} additional blocker{additionalBlockers.length === 1 ? "" : "s"} · review all
              </summary>
              <ol className="border-t border-[#141d2e]" aria-label="Additional execution blockers">
                {additionalBlockers.map((stage) => (
                  <li key={stage.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#141d2e] px-3 py-2 last:border-b-0">
                    <p className="min-w-0 flex-1 text-[9px] leading-4 text-[#aeb9cb]">
                      <span className={`font-semibold ${statusTone(stage.status)}`}>{stage.label} · {statusLabel(stage.status)}</span>
                      <span className="block text-[#718097]">{stage.detail}</span>
                    </p>
                    {stage.action ? <FlightActionButton action={stage.action} onAction={onAction} /> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : warnings.length > 0 ? (
        <div role="status" aria-live="polite" className="border-t border-[#141d2e] bg-amber-300/[0.03]">
          <p className="px-3 py-2 text-[9px] leading-4 text-amber-100">
            Hard gates pass with {warnings.length} decision warning{warnings.length === 1 ? "" : "s"}. Review before explicit binding or submit.
          </p>
          <ol className="border-t border-[#141d2e]" aria-label="Execution warnings">
            {warnings.map((stage) => (
              <li key={stage.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#141d2e] px-3 py-2 last:border-b-0">
                <p className="min-w-0 flex-1 text-[9px] leading-4 text-[#aeb9cb]">
                  <span className="font-semibold text-amber-200">{stage.label}</span>
                  <span className="block text-[#718097]">{stage.detail}</span>
                </p>
                {stage.action ? <FlightActionButton action={stage.action} onAction={onAction} /> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p role="status" className="border-t border-[#141d2e] bg-emerald-300/[0.03] px-3 py-2 text-[9px] leading-4 text-emerald-200">
          All local gates pass. Binding and submit remain explicit user actions.
        </p>
      )}
    </section>
  );
});

function FlightActionButton({
  action,
  onAction,
}: {
  action: TerminalExecutionFlightAction;
  onAction: (action: TerminalExecutionFlightAction) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAction(action)}
      className="term-chip h-7 shrink-0 px-2 text-[9px]"
    >
      {action.label}
    </button>
  );
}

function statusLabel(status: TerminalExecutionFlightStatus) {
  if (status === "not_applicable") return "N/A";
  return status;
}

function statusTone(status: TerminalExecutionFlightStatus) {
  if (status === "pass") return "text-emerald-300";
  if (status === "warning" || status === "pending") return "text-amber-200";
  if (status === "blocked") return "text-rose-300";
  return "text-[#566278]";
}
