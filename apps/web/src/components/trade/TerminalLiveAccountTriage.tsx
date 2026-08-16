import { memo } from "react";
import type { TerminalLiveAccountView } from "@/lib/terminal-live-account";
import { deriveTerminalLiveAccountTriage } from "@/lib/terminal-live-account-triage";

export const TerminalLiveAccountTriage = memo(function TerminalLiveAccountTriage({
  view,
  onInspectMarket,
}: {
  view: TerminalLiveAccountView;
  onInspectMarket?: (market: string) => void;
}) {
  const triage = deriveTerminalLiveAccountTriage(view);
  const heading = triage.severity === "clear" ? "Risk queue clear" : `${triage.items.length + triage.hiddenItemCount} risk item${triage.items.length + triage.hiddenItemCount === 1 ? "" : "s"}`;
  return (
    <section className={`border-t px-4 py-2.5 ${surfaceTone(triage.severity)}`} aria-labelledby="live-account-triage-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="live-account-triage-heading" className="text-[8px] font-semibold uppercase tracking-[0.12em]">Risk triage</h3>
        <span className="font-mono text-[8px] uppercase">{heading}</span>
      </div>
      {triage.items.length ? (
        <ol className="mt-2 grid gap-1 sm:grid-cols-2" aria-label="Ranked live account risk items">
          {triage.items.map((item) => (
            <li key={item.code} className="flex min-w-0 items-start gap-2 rounded border border-[#344156] bg-black/10 px-2 py-1.5">
              <span className={`mt-0.5 shrink-0 rounded px-1 font-mono text-[7px] font-semibold uppercase ${itemTone(item.severity)}`}>{item.severity}</span>
              <span className="min-w-0 text-[8px] leading-3">
                {item.market && onInspectMarket ? (
                  <button type="button" aria-label={`Inspect ${item.market} risk item`} onClick={() => onInspectMarket(item.market as string)} className="font-semibold text-sky-200 underline decoration-sky-300/30 underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300">{item.label}</button>
                ) : <strong className="font-semibold">{item.label}</strong>}
                <span className="ml-1 text-[#9aa7ba]">{item.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-1 text-[8px] leading-3 text-emerald-200">No liquidation, margin, truncation, readiness, or working-exposure hazard is reported by the current bounded account view.</p>}
      {triage.hiddenItemCount ? <p className="mt-1 text-[8px] text-amber-100">+{triage.hiddenItemCount} lower-ranked item{triage.hiddenItemCount === 1 ? "" : "s"} omitted from this bounded queue.</p> : null}
    </section>
  );
});

function surfaceTone(severity: ReturnType<typeof deriveTerminalLiveAccountTriage>["severity"]) {
  if (severity === "critical") return "border-rose-300/25 bg-rose-300/[0.05] text-rose-100";
  if (severity === "blocked") return "border-amber-300/25 bg-amber-300/[0.04] text-amber-100";
  if (severity === "warning") return "border-amber-300/20 bg-amber-300/[0.025] text-amber-100";
  return "border-emerald-300/20 bg-emerald-300/[0.025] text-emerald-100";
}

function itemTone(severity: "critical" | "blocked" | "warning") {
  return severity === "critical" ? "bg-rose-300/15 text-rose-200" : "bg-amber-300/10 text-amber-100";
}
