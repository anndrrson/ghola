import { memo } from "react";

export const TerminalMarketSnapshotMetrics = memo(function TerminalMarketSnapshotMetrics({
  mark,
  oracle,
  spread,
  funding,
  openInterest,
  dayVolume,
}: {
  mark: string;
  oracle: string;
  spread: string;
  funding: string;
  openInterest: string;
  dayVolume: string;
}) {
  const metrics = [
    ["Mark", mark],
    ["Oracle", oracle],
    ["Spread", spread],
    ["Funding", funding],
    ["Open interest", openInterest],
    ["24h volume", dayVolume],
  ] as const;

  return (
    <div
      role="region"
      aria-label="Scrollable market snapshot metrics"
      tabIndex={0}
      className="w-full overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300 sm:w-auto sm:overflow-visible"
    >
      <dl className="flex min-w-max snap-x snap-mandatory items-start gap-4 pb-1 text-right sm:grid sm:min-w-0 sm:grid-cols-6 sm:gap-x-4 sm:pb-0">
        {metrics.map(([label, value]) => (
          <div key={label} className="min-w-[5.25rem] snap-start sm:min-w-0">
            <dt className="text-[9px] font-medium uppercase tracking-[0.14em] text-[#566278] sm:text-[10px] sm:tracking-[0.16em]">{label}</dt>
            <dd className="mt-0.5 font-mono text-xs tabular-nums text-[#eef1f8] sm:mt-1 sm:text-sm">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});
