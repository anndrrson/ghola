import { memo } from "react";

export const TerminalMarketSnapshotMetrics = memo(function TerminalMarketSnapshotMetrics({
  mark,
  oracle,
  spread,
  dayChange,
  dayChangeTone = "neutral",
  funding,
  openInterest,
  dayVolume,
}: {
  mark: string;
  oracle: string;
  spread: string;
  dayChange?: string;
  dayChangeTone?: "good" | "bad" | "neutral";
  funding: string;
  openInterest: string;
  dayVolume: string;
}) {
  const metrics = [
    ["Mark", mark, "neutral"],
    ["Oracle", oracle, "neutral"],
    [dayChange == null ? "Spread" : "24h change", dayChange ?? spread, dayChange == null ? "neutral" : dayChangeTone],
    ["Funding / 1h", funding, "neutral"],
    ["Open interest", openInterest, "neutral"],
    ["24h volume", dayVolume, "neutral"],
  ] as const;

  return (
    <div
      role="region"
      aria-label="Scrollable market snapshot metrics"
      tabIndex={0}
      className="w-full outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300"
    >
      <dl className="grid grid-cols-2 gap-1.5 text-left sm:grid-cols-3 2xl:grid-cols-6">
        {metrics.map(([label, value, tone]) => (
          <div key={label} className="rounded border border-[#1d2633] bg-[#0a0d13] px-3 py-2">
            <dt className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#59667a]">{label}</dt>
            <dd className={`trade-market-number mt-1 text-[11px] ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#dce4ee]"}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});
