"use client";

import { memo } from "react";
import type { TerminalTicketField } from "@/lib/terminal-command";
import {
  terminalBoundPlanAuditEqual,
  type TerminalBoundPlanAudit as TerminalBoundPlanAuditDecision,
  type TerminalBoundPlanAuditField,
} from "@/lib/terminal-bound-plan-audit";

const FIELD_TARGETS: Partial<Record<TerminalBoundPlanAuditField, TerminalTicketField>> = {
  notional: "notional",
  base_size: "notional",
  entry: "entry",
  invalidation: "invalidation",
  risk_budget: "risk_budget",
};

export const TerminalBoundPlanAudit = memo(function TerminalBoundPlanAudit({
  audit,
  onFocusField,
}: {
  audit: TerminalBoundPlanAuditDecision;
  onFocusField: (field: TerminalTicketField) => void;
}) {
  if (!audit.snapshot) return null;
  const shown = audit.differences.slice(0, 6);
  const remaining = audit.differences.length - shown.length;
  const status = statusCopy(audit);

  return (
    <section aria-labelledby="bound-plan-audit-heading" className="mb-4 overflow-hidden rounded-md border border-[#182234] bg-[#080c13]">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div>
          <h2 id="bound-plan-audit-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Bound-plan audit</h2>
          <p className="mt-1 text-[9px] leading-4 text-[#66738c]">Audit-only snapshot; it contains no token and cannot authorize execution.</p>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${status.tone}`}>
          {status.label}
        </span>
      </div>
      <div className="border-t border-[#141d2e] px-3 py-2.5">
        <p className="font-mono text-[9px] text-[#7d8ba5]" title={audit.snapshot.planDigest}>
          {audit.snapshot.planDigest.slice(0, 22)}…
        </p>
        <p className={`mt-1 text-[10px] leading-4 ${status.copyTone}`}>{status.detail}</p>
      </div>
      {shown.length > 0 ? (
        <ol className="border-t border-[#141d2e]" aria-label="Changes from the last bound order plan">
          {shown.map((difference) => {
            const target = FIELD_TARGETS[difference.field];
            return (
              <li key={difference.field} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] gap-2 border-b border-[#141d2e] px-3 py-2 last:border-b-0">
                {target ? (
                  <button type="button" className="text-left text-[9px] font-semibold text-sky-200 underline decoration-sky-300/30 underline-offset-2" onClick={() => onFocusField(target)}>
                    {difference.label}
                  </button>
                ) : (
                  <span className="text-[9px] font-semibold text-[#94a2b9]">{difference.label}</span>
                )}
                <span className="min-w-0 break-words font-mono text-[9px] text-[#66738c]">
                  <span className="text-[#8996aa]">{difference.boundValue}</span>
                  <span aria-hidden className="px-1 text-[#4e5b70]">→</span>
                  <span className="text-amber-100">{difference.currentValue}</span>
                </span>
              </li>
            );
          })}
          {remaining > 0 ? <li className="px-3 py-2 text-[9px] text-[#66738c]">+{remaining} more changes</li> : null}
        </ol>
      ) : null}
    </section>
  );
}, (previous, next) => (
  previous.onFocusField === next.onFocusField
  && terminalBoundPlanAuditEqual(previous.audit, next.audit)
));

function statusCopy(audit: TerminalBoundPlanAuditDecision) {
  if (audit.status === "active") return good("active", "The active preview still matches this exact plan.");
  if (audit.status === "changed") {
    const staleSuffix = audit.expired
      ? " The prior binding is also expired."
      : audit.marketStale
        ? " Its bound market context is also stale."
        : "";
    return warn("changed", `${audit.differences.length} bound field${audit.differences.length === 1 ? "" : "s"} changed. Re-bind before execution.${staleSuffix}`);
  }
  if (audit.status === "expired") return bad("expired", "The binding expired. Re-bind before execution.");
  if (audit.status === "market_stale") return bad("market stale", "Its bound market context is stale. Re-bind from fresh data.");
  if (audit.status === "current_plan_unavailable") return bad("blocked", "A valid current plan is unavailable; the prior binding remains audit-only.");
  return warn("inactive", "The plan is unchanged, but local safety context invalidated authorization. Re-bind before execution.");
}

function good(label: string, detail: string) {
  return { label, detail, tone: "border-emerald-300/35 bg-emerald-300/10 text-emerald-200", copyTone: "text-emerald-200" };
}

function warn(label: string, detail: string) {
  return { label, detail, tone: "border-amber-300/35 bg-amber-300/10 text-amber-100", copyTone: "text-amber-100" };
}

function bad(label: string, detail: string) {
  return { label, detail, tone: "border-rose-300/35 bg-rose-300/10 text-rose-200", copyTone: "text-rose-200" };
}
