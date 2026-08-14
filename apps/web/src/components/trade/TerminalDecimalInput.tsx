"use client";

import { memo, useId, useState, type InputHTMLAttributes } from "react";
import {
  parseTerminalDecimalDraft,
  terminalDecimalDraftBlockerLabel,
  type TerminalDecimalDraftBounds,
} from "@/lib/terminal-decimal-draft";

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "inputMode" | "onChange" | "type" | "value">;

export interface TerminalDecimalInputProps extends NativeInputProps {
  value: number | null;
  bounds: TerminalDecimalDraftBounds;
  allowEmpty?: boolean;
  invalidClassName?: string;
  errorClassName?: string;
  onEditStart?: () => void;
  onDraftStatusChange?: (status: "settled" | "valid" | "incomplete" | "invalid") => void;
  onValueChange: (value: number | null) => void;
}

interface DecimalEdit {
  draft: string;
  expectedValue: number | null;
  initialValue: number | null;
}

export const TerminalDecimalInput = memo(function TerminalDecimalInput({
  value,
  bounds,
  allowEmpty = false,
  invalidClassName = "",
  errorClassName = "sr-only",
  onEditStart,
  onDraftStatusChange,
  onValueChange,
  className = "",
  onBlur,
  onKeyDown,
  "aria-describedby": ariaDescribedBy,
  ...inputProps
}: TerminalDecimalInputProps) {
  const [edit, setEdit] = useState<DecimalEdit | null>(null);
  const errorId = useId();
  const activeEdit = edit != null && Object.is(edit.expectedValue, value);
  const result = activeEdit ? parseTerminalDecimalDraft(edit.draft, bounds) : null;
  const blocker = result?.status === "invalid" ? result.blocker : null;
  const message = blocker ? terminalDecimalDraftBlockerLabel(blocker, bounds) : null;
  const displayedValue = activeEdit ? edit.draft : formatTerminalDecimalValue(value, bounds.maxFractionDigits);

  return (
    <>
      <input
        {...inputProps}
        type="text"
        inputMode="decimal"
        value={displayedValue}
        aria-invalid={message ? true : inputProps["aria-invalid"]}
        aria-describedby={[ariaDescribedBy, message ? errorId : null].filter(Boolean).join(" ") || undefined}
        title={message ?? inputProps.title}
        onChange={(event) => {
          const draft = event.target.value;
          const next = parseTerminalDecimalDraft(draft, bounds);
          const initialValue = activeEdit ? edit.initialValue : value;
          if (!activeEdit) onEditStart?.();
          if (next.status === "valid") {
            setEdit({ draft, expectedValue: next.value, initialValue });
            onValueChange(next.value);
            onDraftStatusChange?.("valid");
            return;
          }
          if (allowEmpty && draft.trim() === "") {
            setEdit({ draft, expectedValue: null, initialValue });
            onValueChange(null);
            onDraftStatusChange?.("valid");
            return;
          }
          setEdit({ draft, expectedValue: value, initialValue });
          onDraftStatusChange?.(next.status);
        }}
        onBlur={(event) => {
          setEdit(null);
          onDraftStatusChange?.("settled");
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Escape" && activeEdit) {
            event.preventDefault();
            event.stopPropagation();
            setEdit(null);
            onValueChange(edit.initialValue);
            onDraftStatusChange?.("settled");
          } else if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className={`${className} ${message ? invalidClassName : ""}`.trim()}
      />
      {message ? <span id={errorId} role="status" className={errorClassName}>{message}</span> : null}
    </>
  );
});

export function formatTerminalDecimalValue(value: number | null, maxFractionDigits: number) {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(maxFractionDigits).replace(/(?:\.0+|(\.\d*?)0+)$/u, "$1");
}
