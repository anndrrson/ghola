import Link from "next/link";
import { LockKeyhole, TestTube2 } from "lucide-react";

export const TERMINAL_LOCAL_SAFETY_LABEL =
  "Local-safe workstation. Charts, analysis, PAPER, and order planning remain available. Worker start, remote preview, autonomous agents, and live submission are disabled. Zero runtime hours.";

export const TERMINAL_FUNDED_TESTNET_LABEL =
  "Funded Hyperliquid testnet execution is enabled through the explicit round-trip runner. Mainnet, autonomous execution, and unproven venues remain disabled.";

export function TerminalLocalSafetyStrip({ fundedTestnetProofAvailable = false }: { fundedTestnetProofAvailable?: boolean }) {
  return (
    <section
      role="note"
      aria-label={fundedTestnetProofAvailable ? TERMINAL_FUNDED_TESTNET_LABEL : TERMINAL_LOCAL_SAFETY_LABEL}
      className="border-b border-[#182234] bg-[#070a10] px-3 py-1.5 sm:px-6"
    >
      <div className="flex items-center justify-between gap-2 rounded border border-amber-300/25 bg-amber-300/[0.04] px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {fundedTestnetProofAvailable
            ? <TestTube2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
            : <LockKeyhole aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="shrink-0 text-[10px] font-semibold text-amber-100 sm:text-[11px]">
              {fundedTestnetProofAvailable ? "Funded Hyperliquid testnet enabled" : "Local-safe workstation"}
            </p>
            <p className="truncate text-[9px] text-[#8b95a8] sm:text-[10px]">
              {fundedTestnetProofAvailable ? "Real testnet fills · mainnet off" : "Analysis + PAPER only · live and agents off"}
              <span className="sr-only"> {fundedTestnetProofAvailable ? TERMINAL_FUNDED_TESTNET_LABEL : "Charts and order planning stay active. Worker start, remote preview, agent arming, and live submission are disabled."}</span>
            </p>
          </div>
        </div>
        {fundedTestnetProofAvailable ? (
          <Link href="/trade/testnet-e2e" className="flex min-h-8 shrink-0 items-center gap-1.5 rounded border border-cyan-300/35 bg-cyan-300/[0.07] px-2 py-1 text-[9px] font-semibold text-cyan-200 hover:bg-cyan-300/[0.12]">
            <TestTube2 aria-hidden className="h-3.5 w-3.5" /> Open funded runner
          </Link>
        ) : (
          <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-300/[0.06] px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-emerald-300 sm:text-[9px] sm:tracking-[0.14em]">
            <span className="sm:hidden">0 runtime</span>
            <span className="hidden sm:inline">zero runtime hours</span>
          </span>
        )}
      </div>
    </section>
  );
}
