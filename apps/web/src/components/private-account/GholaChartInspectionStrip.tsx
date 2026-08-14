export interface GholaChartInspectionStat {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}

export function GholaChartInspectionStrip({ stats }: { stats: readonly GholaChartInspectionStat[] }) {
  return (
    <div
      role="region"
      aria-label="Scrollable chart inspection statistics"
      tabIndex={0}
      data-chart-inspection-strip="scrollable"
      className="flex w-full min-w-0 snap-x snap-mandatory divide-x divide-[#16233a] overflow-x-auto overscroll-x-contain border border-[#16233a] bg-[#070b12] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300 sm:grid sm:grid-cols-4 sm:overflow-hidden lg:grid-cols-7"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-[7rem] shrink-0 snap-start px-2.5 py-1.5 font-mono sm:min-w-0 sm:shrink">
          <div className="text-[9px] uppercase tracking-[0.14em] text-[#7d8aa3]">{stat.label}</div>
          <div className={stat.tone === "good"
            ? "truncate text-[11px] tabular-nums text-[#6ee7b7]"
            : stat.tone === "bad"
              ? "truncate text-[11px] tabular-nums text-[#fca5a5]"
              : "truncate text-[11px] tabular-nums text-[#c4cfdf]"}
          >
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
