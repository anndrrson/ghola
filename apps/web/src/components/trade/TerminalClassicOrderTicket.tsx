"use client";

import { memo, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

type Side = "buy" | "sell";

export interface TerminalClassicOrderTicketProps {
  venueLabel: string;
  productLabel: string;
  authenticated: boolean;
  statusLabel: string;
  statusReady: boolean;
  side: Side;
  notional: number;
  baseSize?: number | null;
  effectiveNotionalUsd?: number | null;
  protectionAttached?: boolean;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  modeledLossUsd: number | null;
  riskBudgetUsd: number;
  blocker?: string | null;
  actions: ReactNode;
  onSignIn: () => void;
  onSideChange: (side: Side) => void;
  onNotionalChange: (notional: number) => void;
  onStopChange: (price: number) => void;
  onOpenAdvanced: () => void;
}

export const TerminalClassicOrderTicket = memo(function TerminalClassicOrderTicket({
  venueLabel,
  productLabel,
  authenticated,
  statusLabel,
  statusReady,
  side,
  notional,
  baseSize,
  effectiveNotionalUsd,
  protectionAttached = false,
  entryPrice,
  stopPrice,
  targetPrice,
  modeledLossUsd,
  riskBudgetUsd,
  blocker,
  actions,
  onSignIn,
  onSideChange,
  onNotionalChange,
  onStopChange,
  onOpenAdvanced,
}: TerminalClassicOrderTicketProps) {
  return (
    <>
      <div className="shrink-0 border-b border-[#18212b] px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-semibold text-[#eef1f8]">Place order</h2>
            <p className="mt-1 text-[8px] text-[#566173]">{venueLabel} · {productLabel}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[7px] uppercase tracking-[0.08em] ${statusReady ? "border-emerald-400/25 bg-emerald-400/[0.05] text-emerald-200" : "border-[#263249] bg-[#090d13] text-[#718097]"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${statusReady ? "bg-emerald-300" : "bg-[#4f5b6d]"}`} />{statusLabel}
          </span>
        </div>
        {!authenticated ? (
          <button type="button" onClick={onSignIn} className="trade-action mt-3 flex h-9 w-full items-center justify-center rounded text-[11px] font-semibold">Sign in to connect API keys</button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TicketRow label="Direction">
          <Segmented options={[{ id: "buy", label: "Long" }, { id: "sell", label: "Short" }]} selected={side} onSelect={(value) => onSideChange(value as Side)} tone={side === "buy" ? "good" : "bad"} />
        </TicketRow>
        <TicketRow label="Entry">
          <div className="grid grid-cols-3 rounded-md bg-[#06090e] p-0.5 shadow-[inset_0_0_0_1px_#1b2532]">
            <button type="button" disabled className="h-7 rounded-[5px] text-[9px] font-medium text-[#465268]">Market</button>
            <button type="button" aria-pressed="true" className="h-7 rounded-[5px] bg-[#17334a] text-[9px] font-medium text-[#b7ddff]">Limit</button>
            <button type="button" onClick={onOpenAdvanced} className="h-7 rounded-[5px] text-[9px] font-medium text-[#647189] hover:text-[#aab5c8]">Agent</button>
          </div>
        </TicketRow>
        <TicketRow label="Execute">
          <div className="grid grid-cols-2 rounded-md bg-[#06090e] p-0.5 shadow-[inset_0_0_0_1px_#1b2532]">
            <span className="grid h-7 place-items-center rounded-[5px] bg-[#17334a] text-[9px] text-[#b7ddff]">Exact limit</span>
            <button type="button" onClick={onOpenAdvanced} className="h-7 rounded-[5px] text-[9px] text-[#647189] hover:text-[#aab5c8]">Advanced</button>
          </div>
        </TicketRow>

        <label className="mt-4 block text-[9px] font-semibold uppercase tracking-[0.16em] text-[#5b6980]" htmlFor="classic-ticket-size">Size</label>
        <div className="relative mt-1.5">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-[#66758f]">$</span>
          <input id="classic-ticket-size" inputMode="decimal" value={String(notional)} onChange={(event) => updatePositiveNumber(event.target.value, onNotionalChange)} className="trade-field h-9 w-full rounded pl-7 pr-3 font-mono text-[11px] tabular-nums text-[#eef1f8] outline-none" />
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {[11, 25, 50, 100].map((amount) => (
            <button key={amount} type="button" onClick={() => onNotionalChange(amount)} className={`h-7 rounded border text-[9px] tabular-nums ${notional === amount ? "border-[#285b86] bg-[#102b43] text-[#9cd2ff]" : "border-[#1e2734] bg-[#090d13] text-[#677489]"}`}>${amount}{amount === 11 ? " min" : ""}</button>
          ))}
        </div>
        {baseSize != null && effectiveNotionalUsd != null ? (
          <p
            className="mt-1.5 truncate font-mono text-[8px] tabular-nums text-[#647189]"
            data-terminal-venue-lot="true"
            data-terminal-base-size={baseSize}
            data-terminal-effective-notional={effectiveNotionalUsd}
          >
            Venue lot {formatBaseSize(baseSize)} {baseAsset(productLabel)} · ${effectiveNotionalUsd.toFixed(2)} effective
          </p>
        ) : null}

        <div className="mt-3 border-y border-[#18212d] py-3">
          <div className="flex items-center justify-between text-[8px] font-semibold uppercase tracking-[0.14em] text-[#6a7890]"><span>Planned exits</span><span className={`font-normal ${protectionAttached ? "text-emerald-200/70" : "text-amber-200/65"}`}>{protectionAttached ? "OCO when submitted" : "analysis only"}</span></div>
          <div className="mt-2.5 grid grid-cols-2 gap-3">
            <label className="grid min-w-0 gap-1.5 text-[8px] text-[#758197]">Exit level<input inputMode="decimal" value={formatInputPrice(stopPrice)} onChange={(event) => updatePositiveNumber(event.target.value, onStopChange)} className="trade-field h-8 min-w-0 rounded px-2.5 font-mono text-[10px] text-rose-200 outline-none" /></label>
            <label className="grid min-w-0 gap-1.5 text-[8px] text-[#758197]">Target level<input inputMode="decimal" value={formatInputPrice(targetPrice)} readOnly className="trade-field h-8 min-w-0 rounded px-2.5 font-mono text-[10px] text-emerald-200 outline-none" /></label>
          </div>
        </div>

        <details className="mt-3 rounded-md border border-[#1c2738] bg-[#090e17]/70">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[9px] text-[#9ba8ba]">Protection &amp; agent mandate <ChevronDown className="h-3.5 w-3.5" /></summary>
          <div className="border-t border-[#182234] px-3 py-2 text-[8px] leading-4 text-[#68778d]">Advanced entry logic, saved plans, replay, routing, and automation remain available in the advanced workspace.</div>
        </details>

        <div className="mt-3 border-t border-[#18212d] pt-3">
          <div className="flex items-center justify-between text-[8px] font-semibold uppercase tracking-[0.14em] text-[#6a7890]"><span>Risk estimate</span><span className={modeledLossUsd != null && modeledLossUsd <= riskBudgetUsd ? "text-emerald-300" : "text-rose-300"}>{modeledLossUsd != null && modeledLossUsd <= riskBudgetUsd ? "Within budget" : "Blocked"}</span></div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Metric label="Entry" value={formatPrice(entryPrice)} />
            <Metric label="Modeled loss" value={modeledLossUsd == null ? "-" : `$${modeledLossUsd.toFixed(2)}`} />
            <Metric label="Budget" value={`$${riskBudgetUsd.toFixed(2)}`} />
          </div>
          {blocker ? <p className="mt-2 text-[8px] leading-3.5 text-amber-200/80">{blocker}</p> : null}
        </div>

        <button type="button" onClick={onOpenAdvanced} className="mt-3 w-full rounded border border-[#202a39] py-2 text-[9px] text-[#718097] transition hover:border-[#33435d] hover:text-[#b8c5d8]">Advanced tools</button>
      </div>
      <div className="shrink-0 border-t border-[#182234] bg-[#070a10] p-3">{actions}</div>
    </>
  );
});

function TicketRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="mt-2 grid grid-cols-[3.75rem_1fr] items-center gap-2 first:mt-0"><span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#536178]">{label}</span>{children}</div>;
}

function Segmented({ options, selected, onSelect, tone }: { options: Array<{ id: string; label: string }>; selected: string; onSelect: (id: string) => void; tone: "good" | "bad" }) {
  return <div className="grid grid-cols-2 rounded-md bg-[#06090e] p-0.5 shadow-[inset_0_0_0_1px_#1b2532]">{options.map((option) => <button key={option.id} type="button" aria-pressed={selected === option.id} onClick={() => onSelect(option.id)} className={`h-7 rounded-[5px] text-[10px] font-semibold ${selected === option.id ? tone === "good" ? "bg-emerald-400/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.32)]" : "bg-rose-400/15 text-rose-200 shadow-[inset_0_0_0_1px_rgba(251,113,133,0.32)]" : "text-[#647189] hover:text-[#aab5c8]"}`}>{selected === option.id ? <Check className="mr-1 inline h-2.5 w-2.5" /> : null}{option.label}</button>)}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-[#1c2634] bg-[#080c12] px-2 py-2"><p className="text-[7px] uppercase tracking-[0.12em] text-[#566278]">{label}</p><p className="mt-1 truncate font-mono text-[9px] tabular-nums text-[#d9e2ee]">{value}</p></div>;
}

function updatePositiveNumber(value: string, onChange: (value: number) => void) {
  const parsed = Number(value.replaceAll(",", ""));
  if (Number.isFinite(parsed) && parsed > 0) onChange(parsed);
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "-";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: value >= 1_000 ? 1 : 2, maximumFractionDigits: value >= 1_000 ? 1 : 4 }).format(value);
}

function formatInputPrice(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "";
  return value >= 1_000
    ? value.toFixed(1)
    : value.toFixed(4).replace(/\.?0+$/u, "");
}

function formatBaseSize(value: number) {
  return value.toFixed(8).replace(/\.?0+$/u, "");
}

function baseAsset(productLabel: string) {
  return productLabel.replace(/-(?:PERP|USD)$/u, "");
}
