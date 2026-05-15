"use client";

import { Laptop, Lock, ShieldOff } from "lucide-react";
import type { SovereigntyMode } from "@/lib/sovereignty";
import { SOVEREIGNTY_MODES } from "@/lib/sovereignty";

interface SovereigntyPickerProps {
  value: SovereigntyMode;
  onChange: (mode: SovereigntyMode) => void;
  /**
   * When false, the Private option is disabled and shows the reason
   * as a title tooltip. The chat page polls /ready/private to track
   * this and forwards it down — see ChatHeader's callsite.
   */
  privateAvailable?: boolean;
  privateUnavailableReason?: string | null;
}

// Three-segment pill control. Lives in the chat header so the choice is
// visible per chat, not buried in a settings page — the whole pitch is
// that the mode is something the user can verify on every message.
//
// Responsive shape: icon-only below `sm:` so the chat header doesn't
// squeeze the conversation title on 375px screens; icon + label from
// `sm:` up. Icons match the ReceiptBadge styling so users build the
// same mental model in both places (lock = Private, laptop = Local,
// shield-off = Open).
const MODE_ICONS = {
  private: Lock,
  local: Laptop,
  open: ShieldOff,
} as const;

export function SovereigntyPicker({
  value,
  onChange,
  privateAvailable = true,
  privateUnavailableReason = null,
}: SovereigntyPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Sovereignty mode"
      className="inline-flex items-center rounded-full border border-[#1e2a3a] bg-[#0a0b10] p-0.5"
    >
      {SOVEREIGNTY_MODES.map((m) => {
        const selected = m.id === value;
        const Icon = MODE_ICONS[m.id];
        const disabled = m.id === "private" && !privateAvailable;
        const titleText = disabled
          ? (privateUnavailableReason ?? `${m.blurb} (unavailable)`)
          : m.blurb;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={m.label}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (disabled) return;
              onChange(m.id);
            }}
            title={titleText}
            className={`inline-flex items-center gap-1 rounded-full px-2 sm:px-3 py-1 text-xs font-medium transition-colors ${
              disabled
                ? "text-[#3a4558] cursor-not-allowed"
                : selected
                  ? "bg-[#3da8ff]/15 text-[#3da8ff] cursor-pointer"
                  : "text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
            }`}
          >
            <Icon className="h-3 w-3" />
            <span className="hidden sm:inline">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
