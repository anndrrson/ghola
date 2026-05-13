"use client";

import type { SovereigntyMode } from "@/lib/sovereignty";
import { SOVEREIGNTY_MODES } from "@/lib/sovereignty";

interface SovereigntyPickerProps {
  value: SovereigntyMode;
  onChange: (mode: SovereigntyMode) => void;
}

// Three-segment pill control. Lives in the chat header so the choice is
// visible per chat, not buried in a settings page — the whole pitch is
// that the mode is something the user can verify on every message.
export function SovereigntyPicker({ value, onChange }: SovereigntyPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Sovereignty mode"
      className="inline-flex items-center rounded-full border border-[#1e2a3a] bg-[#0a0b10] p-0.5"
    >
      {SOVEREIGNTY_MODES.map((m) => {
        const selected = m.id === value;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(m.id)}
            title={m.blurb}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
              selected
                ? "bg-[#3da8ff]/15 text-[#3da8ff]"
                : "text-[#8b95a8] hover:text-[#eef1f8]"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
