"use client";

import { useCallback } from "react";

const DAYS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
] as const;

interface HoursEditorProps {
  value: Record<string, string> | null;
  onChange: (newHours: Record<string, string>) => void;
}

export function HoursEditor({ value, onChange }: HoursEditorProps) {
  const hours = value ?? {};

  const getOpen = useCallback(
    (day: string) => {
      const val = hours[day];
      if (!val || val === "closed") return "";
      const parts = val.split("-");
      return parts[0] ?? "";
    },
    [hours]
  );

  const getClose = useCallback(
    (day: string) => {
      const val = hours[day];
      if (!val || val === "closed") return "";
      const parts = val.split("-");
      return parts[1] ?? "";
    },
    [hours]
  );

  const isClosed = useCallback(
    (day: string) => {
      return hours[day] === "closed";
    },
    [hours]
  );

  function setDayValue(day: string, open: string, close: string) {
    onChange({ ...hours, [day]: `${open}-${close}` });
  }

  function toggleClosed(day: string) {
    if (isClosed(day)) {
      onChange({ ...hours, [day]: "09:00-17:00" });
    } else {
      onChange({ ...hours, [day]: "closed" });
    }
  }

  return (
    <div className="space-y-3">
      {DAYS.map(({ key, label }) => {
        const closed = isClosed(key);
        return (
          <div
            key={key}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2"
          >
            <span className="w-24 shrink-0 text-sm font-medium text-[#8b95a8]">
              {label}
            </span>

            <input
              type="time"
              value={closed ? "" : getOpen(key)}
              disabled={closed}
              onChange={(e) => setDayValue(key, e.target.value, getClose(key))}
              className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-1.5 text-sm text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
            />

            <span className="text-sm text-[#4a5568]">to</span>

            <input
              type="time"
              value={closed ? "" : getClose(key)}
              disabled={closed}
              onChange={(e) => setDayValue(key, getOpen(key), e.target.value)}
              className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-1.5 text-sm text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
            />

            <label className="ml-auto flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-[#8b95a8]">Closed</span>
              <button
                type="button"
                role="switch"
                aria-checked={closed}
                onClick={() => toggleClosed(key)}
                className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${
                  closed ? "bg-red-500/60" : "bg-[#1c1f2e]"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    closed ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          </div>
        );
      })}
    </div>
  );
}
