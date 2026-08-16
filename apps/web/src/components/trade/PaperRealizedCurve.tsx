import { memo } from "react";
import type { PaperFill, PaperPosition, PaperTradingAssumptions } from "@/lib/paper-trading-engine";
import { deriveTerminalPaperRealizedCurve } from "@/lib/terminal-paper-realized-curve";

const WIDTH = 320;
const HEIGHT = 72;
const PAD = 5;

export const PaperRealizedCurve = memo(function PaperRealizedCurve({
  assumptions,
  fills,
  positions,
}: {
  assumptions: PaperTradingAssumptions;
  fills: PaperFill[];
  positions: PaperPosition[];
}) {
  const curve = deriveTerminalPaperRealizedCurve({ assumptions, fills, positions });
  const values = curve.available && curve.openingNetUsd != null
    ? [curve.openingNetUsd, ...curve.points.map((point) => point.cumulativeNetUsd)]
    : [];
  const path = chartPath(values);
  const tone = (curve.currentNetUsd ?? 0) > 0 ? "text-emerald-300" : (curve.currentNetUsd ?? 0) < 0 ? "text-rose-300" : "text-[#dce6f4]";

  return (
    <section className="border-b border-[#182234] px-4 py-3 sm:px-5" aria-labelledby="paper-realized-curve-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="paper-realized-curve-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Realized P&amp;L path</h3>
          <p className="mt-1 text-[9px] leading-4 text-[#7f8da7]">Fee-net local PAPER fills · open P&amp;L excluded.</p>
        </div>
        <span className="rounded border border-[#29354a] bg-[#111824] px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] text-[#8795aa]">
          {curve.retainedFillCount} RETAINED FILL{curve.retainedFillCount === 1 ? "" : "S"}
        </span>
      </div>

      {curve.available ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] sm:grid-cols-4">
            <Metric label="Realized equity" value={formatUsd(curve.currentRealizedEquityUsd)} tone={tone} />
            <Metric label="Net realized" value={formatSignedUsd(curve.currentNetUsd)} tone={tone} />
            <Metric label="Retained change" value={formatSignedUsd(curve.retainedChangeUsd)} />
            <Metric label="Max realized DD" value={`${formatUsd(curve.maxDrawdownUsd)} · ${formatPct(curve.maxDrawdownPct)}`} tone={(curve.maxDrawdownUsd ?? 0) > 0 ? "text-rose-300" : "text-[#dce6f4]"} />
          </div>
          <div className="mt-2 rounded border border-[#1b2638] bg-[#080c13] p-2">
            {path ? (
              <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Retained realized PAPER P and L path from ${formatSignedUsd(curve.openingNetUsd)} to ${formatSignedUsd(curve.currentNetUsd)}; maximum drawdown ${formatUsd(curve.maxDrawdownUsd)}.`} className="h-20 w-full overflow-visible">
                <line x1={PAD} x2={WIDTH - PAD} y1={zeroY(values)} y2={zeroY(values)} stroke="#263145" strokeDasharray="3 3" />
                <polyline points={path} fill="none" stroke={(curve.currentNetUsd ?? 0) >= 0 ? "#34d399" : "#fb7185"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : <p className="py-6 text-center text-[9px] text-[#7f8da7]">The realized path begins after the first PAPER fill.</p>}
          </div>
          <p className="mt-1.5 text-[9px] leading-4 text-[#7f8da7]">
            {curve.windowTruncated ? "The chart covers retained fills only and is anchored to lifetime position totals; earlier path detail was pruned. " : "The chart covers the currently retained fill path. "}
            Realized drawdown excludes open-position marks, funding, and venue execution.
          </p>
          {curve.contributions.length ? (
            <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Scrollable lifetime paper realized P and L attribution">
              <table className="w-full min-w-[34rem] border-collapse font-mono text-[9px] tabular-nums">
                <caption className="sr-only">Lifetime local paper realized profit and loss attributed by exact venue, network, and product.</caption>
                <thead className="text-[#7f8da7]">
                  <tr>
                    <th scope="col" className="pb-1 text-left font-normal">Venue / market</th>
                    <th scope="col" className="pb-1 text-right font-normal">Gross realized</th>
                    <th scope="col" className="pb-1 text-right font-normal">Fees</th>
                    <th scope="col" className="pb-1 text-right font-normal">Net contribution</th>
                    <th scope="col" className="pb-1 text-right font-normal">Absolute share</th>
                  </tr>
                </thead>
                <tbody>
                  {curve.contributions.map((row) => (
                    <tr key={row.positionKey} className="border-t border-[#141d2e] text-[#c7d2e4]">
                      <th scope="row" className="py-1.5 text-left font-normal">
                        {row.product}<span className="ml-1 text-[8px] text-[#7f8da7]">{row.venueId} · {row.network}</span>
                      </th>
                      <td className={`py-1.5 text-right ${pnlTone(row.grossRealizedUsd)}`}>{formatSignedUsd(row.grossRealizedUsd)}</td>
                      <td className="py-1.5 text-right text-[#9ba8bc]">{formatUsd(row.feesUsd)}</td>
                      <td className={`py-1.5 text-right ${pnlTone(row.netRealizedUsd)}`}>{formatSignedUsd(row.netRealizedUsd)}</td>
                      <td className="py-1.5 text-right text-[#9ba8bc]">{formatPct(row.absoluteSharePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <p role="alert" className="mt-3 text-[9px] leading-4 text-rose-200">Realized path withheld: retained PAPER accounting data is inconsistent.</p>
      )}
    </section>
  );
});

function Metric({ label, value, tone = "text-[#dce6f4]" }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0 bg-[#080c13] px-2 py-1.5"><span className="block truncate text-[8px] uppercase tracking-[0.1em] text-[#7f8da7]">{label}</span><span className={`mt-0.5 block truncate font-mono text-[9px] tabular-nums ${tone}`} title={value}>{value}</span></div>;
}

function chartPath(values: number[]) {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = Math.max(1e-9, high - low);
  return values.map((value, index) => {
    const x = PAD + index / (values.length - 1) * (WIDTH - PAD * 2);
    const y = PAD + (high - value) / span * (HEIGHT - PAD * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function zeroY(values: number[]) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  return PAD + high / Math.max(1e-9, high - low) * (HEIGHT - PAD * 2);
}

function formatUsd(value: number | null) {
  return value == null ? "—" : value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedUsd(value: number | null) {
  return value == null ? "—" : `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(2)}%`;
}

function pnlTone(value: number) {
  if (value > 0) return "text-emerald-300";
  if (value < 0) return "text-rose-300";
  return "text-[#9ba8bc]";
}
