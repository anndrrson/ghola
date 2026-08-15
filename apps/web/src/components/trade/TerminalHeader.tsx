"use client";

import Link from "next/link";
import { memo } from "react";
import { Bell, ChevronDown } from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";
import { TerminalCommandPalette } from "@/components/trade/TerminalCommandPalette";
import { TerminalWorkspacePresets } from "@/components/trade/TerminalWorkspacePresets";
import type { TerminalCommand } from "@/lib/terminal-command";
import type { TerminalAlertSummary } from "@/lib/terminal-alerts";
import type { TerminalWorkspace } from "@/lib/terminal-workspace";

type HeaderStatusTone = "good" | "warn" | "bad";

export interface TerminalHeaderProps {
  authenticated: boolean;
  alertSummary: TerminalAlertSummary;
  byoLiveEnabled: boolean;
  inert: boolean;
  keyboardMessage: string;
  localPreview: boolean;
  marketStatusTone: HeaderStatusTone;
  marketStatusValue: string;
  pooledStatusTone: HeaderStatusTone;
  pooledStatusValue: string;
  persistenceScope?: string | null;
  userEmail?: string | null;
  workerStatusTone: HeaderStatusTone;
  workerStatusValue: string;
  onCommand: (command: TerminalCommand) => void;
  onCaptureWorkspace: () => TerminalWorkspace;
  onLoadWorkspace: (workspace: TerminalWorkspace) => boolean;
  onOpenAuth: (mode: "signin" | "signup") => void;
}

/** Cold terminal chrome; primitive props keep 100 ms market ticks outside this subtree. */
export const TerminalHeader = memo(function TerminalHeader({
  authenticated,
  alertSummary,
  inert,
  keyboardMessage,
  persistenceScope,
  userEmail,
  onCommand,
  onCaptureWorkspace,
  onLoadWorkspace,
  onOpenAuth,
}: TerminalHeaderProps) {
  const hasActiveAlerts = alertSummary.activeCount > 0;
  const hasUnreadAlerts = alertSummary.unreadCount > 0;
  const alertTitle = alertSummary.scope && (alertSummary.primaryActiveLabel || alertSummary.latestUnreadLabel)
    ? `${alertSummary.scope} · ${[alertSummary.primaryActiveLabel, alertSummary.latestUnreadLabel].filter(Boolean).join(" · ")}`
    : "Open local alerts (L)";
  return (
    <header inert={inert ? true : undefined} className="flex h-10 items-center justify-between border-b border-[#171c25] bg-[#080a0f] px-4">
      <div className="flex items-center gap-4">
        <Link href="/" aria-label="Ghola home" className="flex items-center gap-2">
          <GholaLogo size={18} className="text-[#7fc1ff]" />
          <span className="text-sm font-semibold">ghola</span>
        </Link>
        <nav aria-label="Trading workspace" className="hidden items-center gap-1 text-[11px] sm:flex">
          <span className="rounded border border-[#273142] bg-[#121721] px-2.5 py-1 text-[#d8e2ef]">Live trading</span>
          <button type="button" onClick={() => onCommand({ type: "open_paper" })} className="rounded px-2.5 py-1 text-[#69afff] transition hover:bg-[#111a27] hover:text-[#c9e4ff]">Shadow mode</button>
          <Link href="/agents" className="px-2.5 py-1 text-[#697589] transition hover:text-[#c3cfde]">Automate</Link>
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-amber-200/80 sm:inline-flex"><span className="h-1 w-1 rounded-full bg-amber-300" />Beta</span>
        <details className="group relative hidden sm:block">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded border border-[#222b3a] px-2.5 py-1 text-[11px] text-[#8491a5] transition hover:text-[#d6dfeb]">Venue access <ChevronDown className="h-3 w-3 transition group-open:rotate-180" /></summary>
          <div className="absolute right-0 top-8 z-50 grid w-64 gap-2 rounded border border-[#273142] bg-[#0a0e15] p-2 shadow-2xl">
            <Link href="/account?flow=trade" className="trade-chip rounded px-2.5 py-2 text-[11px]">API-key trading</Link>
            <TerminalWorkspacePresets key={persistenceScope ?? "identity_loading"} persistenceScope={persistenceScope} onCapture={onCaptureWorkspace} onLoad={onLoadWorkspace} />
            <button type="button" aria-label={`Open local alerts, ${alertSummary.activeCount} active, ${alertSummary.unreadCount} unread`} aria-keyshortcuts="L" title={alertTitle} onClick={() => onCommand({ type: "open_alerts" })} className={`relative inline-flex h-8 items-center justify-center gap-1.5 rounded border px-2 text-[9px] uppercase ${hasActiveAlerts ? "border-rose-300/50 bg-rose-300/10 text-rose-100" : hasUnreadAlerts ? "border-amber-300/45 bg-amber-300/10 text-amber-100" : "border-[#26354a] bg-[#0a101a] text-[#7d8ba5]"}`}>
              <Bell className="h-3.5 w-3.5" aria-hidden /> Alerts
              {hasActiveAlerts ? <span className="min-w-4 rounded bg-rose-200 px-1 font-mono text-[8px] font-bold text-[#1b080d]">!{Math.min(99, alertSummary.activeCount)}</span> : null}
              {hasUnreadAlerts ? <span className="min-w-4 rounded bg-amber-200 px-1 font-mono text-[8px] font-bold text-[#151005]">{Math.min(99, alertSummary.unreadCount)}</span> : null}
            </button>
            <TerminalCommandPalette onCommand={onCommand} />
          </div>
        </details>
        {authenticated ? (
          <span className="max-w-40 truncate rounded bg-[#101927] px-2.5 py-1 text-[11px] text-[#a8d8ff]">
            {userEmail}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpenAuth("signin")}
              className="hidden rounded px-2.5 py-1 text-[11px] text-[#8b95a8] transition hover:text-[#eef1f8] sm:inline-flex"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onOpenAuth("signup")}
              className="trade-action rounded px-3 py-1 text-[11px] font-semibold"
            >
              Get started
            </button>
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite">{keyboardMessage}</span>
    </header>
  );
});
