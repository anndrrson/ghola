import type { ReactNode } from "react";

export function TerminalMarketDecisionStack({
  chart,
  scanner,
}: {
  chart: ReactNode;
  scanner: ReactNode;
}) {
  return (
    <div className="flex flex-col" data-terminal-decision-order="chart-first">
      <div data-terminal-surface="chart">
        {chart}
      </div>
      <div data-terminal-surface="scanner">
        {scanner}
      </div>
    </div>
  );
}
