"use client";

import { Laptop, Lock, ShieldCheck, ShieldOff } from "lucide-react";
import type { SovereigntyMode } from "@/lib/sovereignty";
import { SOVEREIGNTY_MODES } from "@/lib/sovereignty";

interface SovereigntyPickerProps {
  value: SovereigntyMode;
  onChange: (mode: SovereigntyMode) => void;
  /**
   * When false, Private remains selectable but shows the reason as a
   * title tooltip. Sending in Private still fails closed if sealed
   * routing is unavailable; the picker should not trap the user in a
   * less-private mode.
   */
  privateAvailable?: boolean;
  privateUnavailableReason?: string | null;
}

// Four-segment pill control. Lives in the chat header so the choice is
// visible per chat, not buried in a settings page — the whole pitch is
// that the mode is something the user can verify on every message.
//
// Responsive shape: icon-only below `sm:` so the chat header doesn't
// squeeze the conversation title on 375px screens; icon + label from
// `sm:` up. Icons match the ReceiptBadge styling so users build the
// same mental model in both places.
const MODE_ICONS = {
  auto: ShieldCheck,
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
      aria-label="Privacy mode"
      className="inline-flex items-center rounded-full border border-[#1e2a3a] bg-[#0a0b10] p-0.5"
    >
      {SOVEREIGNTY_MODES.map((m) => {
        const selected = m.id === value;
        const Icon = MODE_ICONS[m.id];
        const privateUnavailable = m.id === "private" && !privateAvailable;
        const titleText = privateUnavailable
          ? (privateUnavailableReason ?? `${m.blurb} (unavailable)`)
          : m.blurb;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={m.label}
            onClick={() => onChange(m.id)}
            title={titleText}
            className={`inline-flex items-center gap-1 rounded-full px-2 sm:px-3 py-1 text-xs font-medium transition-colors ${
              selected
                ? "bg-[#3da8ff]/15 text-[#3da8ff] cursor-pointer"
                : privateUnavailable
                  ? "text-[#5f6b7e] hover:text-[#cfd7e6] cursor-pointer"
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
