export interface GholaChartInspectionStat {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}

export function GholaChartInspectionStrip({ stats }: { stats: readonly GholaChartInspectionStat[] }) {
  return (
    <div
      role="region"
      aria-label="Chart inspection statistics"
      data-chart-inspection-strip="responsive"
      className="ghola-chart-inspection grid w-full min-w-0 overflow-hidden rounded-md border border-[#1b2738] bg-[#070b12]"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0 border-b border-r border-[#16233a] px-3 py-2 font-mono last:border-r-0">
          <div className="text-[8px] font-medium uppercase tracking-[0.16em] text-[#66758d]">{stat.label}</div>
          <div title={stat.value} className={stat.tone === "good"
            ? "mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-[#6ee7b7]"
            : stat.tone === "bad"
              ? "mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-[#fca5a5]"
              : "mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-[#cbd5e4]"}
          >
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
