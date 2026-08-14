"use client";

import Link from "next/link";
import { memo } from "react";
import { Bell } from "lucide-react";
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
  byoLiveEnabled,
  inert,
  keyboardMessage,
  localPreview,
  marketStatusTone,
  marketStatusValue,
  pooledStatusTone,
  pooledStatusValue,
  persistenceScope,
  userEmail,
  workerStatusTone,
  workerStatusValue,
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
    <header inert={inert ? true : undefined} className="relative flex h-14 items-center justify-between border-b border-[#182234] bg-gradient-to-b from-[#0a0e16] to-[#070a10] px-4 sm:px-6">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#5aa7ff]/50 to-transparent"
      />
      <Link href="/" aria-label="Ghola home" className="flex items-center gap-2">
        <GholaLogo size={26} className="text-[#eef1f8]" />
        <span className="text-lg font-semibold">ghola</span>
      </Link>
      <div className="hidden items-center gap-2 text-xs text-[#8b95a8] md:flex">
        <StatusPill label="Market" value={marketStatusValue} tone={marketStatusTone} />
        {localPreview ? (
          <StatusPill label="Runtime" value="local safe" tone="warn" />
        ) : (
          <>
            <StatusPill label="BYO live" value={byoLiveEnabled ? "enabled" : "locked"} tone={byoLiveEnabled ? "good" : "warn"} />
            <StatusPill label="Worker" value={workerStatusValue} tone={workerStatusTone} />
            <StatusPill label="Pooled" value={pooledStatusValue} tone={pooledStatusTone} />
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <TerminalWorkspacePresets
          key={persistenceScope ?? "identity_loading"}
          persistenceScope={persistenceScope}
          onCapture={onCaptureWorkspace}
          onLoad={onLoadWorkspace}
        />
        <button
          type="button"
          aria-label={`Open local alerts, ${alertSummary.activeCount} active, ${alertSummary.unreadCount} unread`}
          aria-keyshortcuts="L"
          title={alertTitle}
          onClick={() => onCommand({ type: "open_alerts" })}
          className={`relative inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md border px-2 text-[10px] uppercase sm:h-8 ${hasActiveAlerts ? "border-rose-300/50 bg-rose-300/10 text-rose-100" : hasUnreadAlerts ? "border-amber-300/45 bg-amber-300/10 text-amber-100" : "border-[#26354a] bg-[#0a101a] text-[#7d8ba5]"}`}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">Alerts</span>
          {hasActiveAlerts ? (
            <span className="min-w-4 rounded bg-rose-200 px-1 font-mono text-[8px] font-bold text-[#1b080d]">!{Math.min(99, alertSummary.activeCount)}</span>
          ) : null}
          {hasUnreadAlerts ? (
            <span className="min-w-4 rounded bg-amber-200 px-1 font-mono text-[8px] font-bold text-[#151005]">{Math.min(99, alertSummary.unreadCount)}</span>
          ) : null}
        </button>
        <TerminalCommandPalette onCommand={onCommand} />
        <Link
          href="/account?flow=trade"
          className="trade-chip hidden rounded-md px-3 py-1.5 text-sm sm:inline-flex"
        >
          API-key trading
        </Link>
        {authenticated ? (
          <span className="max-w-44 truncate rounded-md bg-[#101927] px-3 py-1.5 text-sm text-[#a8d8ff]">
            {userEmail}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpenAuth("signin")}
              className="hidden rounded-md px-3 py-1.5 text-sm text-[#8b95a8] transition hover:text-[#eef1f8] sm:inline-flex"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onOpenAuth("signup")}
              className="trade-action rounded-md px-3 py-1.5 text-sm font-semibold"
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

function StatusPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: HeaderStatusTone;
}) {
  const color =
    tone === "good"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : tone === "bad"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100";
  const dot =
    tone === "good"
      ? "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]"
      : tone === "bad"
        ? "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.8)]"
        : "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${color}`}>
      <span aria-hidden className={`trade-live-dot h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-[#8b95a8]">{label}</span>
      {value}
    </span>
  );
}
