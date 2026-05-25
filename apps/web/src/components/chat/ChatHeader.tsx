"use client";

import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";
import { SovereigntyPicker } from "@/components/SovereigntyPicker";
import { ModelIntegrityBadge } from "@/components/chat/ModelIntegrityBadge";
import type { SovereigntyMode } from "@/lib/sovereignty";

interface ChatHeaderProps {
  title: string;
  onBack: () => void;
  mode: SovereigntyMode;
  onModeChange: (mode: SovereigntyMode) => void;
  privateAvailable?: boolean;
  privateUnavailableReason?: string | null;
  /** MLC model id loaded in-browser; passed for the on-chain integrity badge. */
  activeModelId?: string | null;
  /**
   * Background warm-up progress for the WebGPU engine. 0..1 while the
   * model is downloading / compiling; null when idle or finished. When
   * set and < 1 we render a tiny "Loading model…" indicator alongside
   * the integrity badge so the user sees that the engine is preparing
   * before they type their first message.
   */
  warmupProgress?: number | null;
}

export function ChatHeader({
  title,
  onBack,
  mode,
  onModeChange,
  privateAvailable = true,
  privateUnavailableReason = null,
  activeModelId = null,
  warmupProgress = null,
}: ChatHeaderProps) {
  const showWarmup =
    warmupProgress !== null &&
    warmupProgress !== undefined &&
    warmupProgress < 1;
  const warmupPct =
    showWarmup && typeof warmupProgress === "number"
      ? Math.max(0, Math.min(99, Math.floor(warmupProgress * 100)))
      : 0;
  const warmupLabel = mode === "auto" ? "Preparing private AI" : "Loading model";
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2a3a] bg-[#0a0b10]">
      <button
        onClick={onBack}
        className="lg:hidden p-1 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <GholaLogo size={24} className="text-[#eef1f8] hidden lg:block" />
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold text-[#eef1f8] truncate">
          {title || "New conversation"}
        </h2>
      </div>
      {mode === "local" && <ModelIntegrityBadge modelId={activeModelId} />}
      {(mode === "local" || mode === "auto") && showWarmup && (
        <span
          className="hidden sm:inline-flex items-center text-[11px] text-[#8b95a8] tabular-nums"
          aria-live="polite"
        >
          {warmupLabel}… {warmupPct}%
        </span>
      )}
      <SovereigntyPicker
        value={mode}
        onChange={onModeChange}
        privateAvailable={privateAvailable}
        privateUnavailableReason={privateUnavailableReason}
      />
      <Link
        href="/settings"
        className="p-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </div>
  );
}
