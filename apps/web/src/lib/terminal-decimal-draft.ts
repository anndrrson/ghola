export type TerminalDecimalDraftBlocker =
  | "empty"
  | "fraction_incomplete"
  | "format_invalid"
  | "precision_exceeded"
  | "below_minimum"
  | "above_maximum";

export type TerminalDecimalDraftResult =
  | { status: "valid"; value: number }
  | { status: "incomplete"; blocker: "empty" | "fraction_incomplete" }
  | { status: "invalid"; blocker: Exclude<TerminalDecimalDraftBlocker, "empty" | "fraction_incomplete"> };

export interface TerminalDecimalDraftBounds {
  min: number;
  max: number;
  maxFractionDigits: number;
}

const DECIMAL_SHAPE = /^(?:\d+(?:\.\d*)?|\.\d*)$/u;

export function parseTerminalDecimalDraft(
  raw: string,
  bounds: TerminalDecimalDraftBounds,
): TerminalDecimalDraftResult {
  if (!validBounds(bounds)) return { status: "invalid", blocker: "format_invalid" };
  let value = raw.trim();
  if (value.startsWith("$")) value = value.slice(1).trimStart();
  if (value === "" || value === ".") return { status: "incomplete", blocker: "empty" };
  if (value.length > 32 || !DECIMAL_SHAPE.test(value)) return { status: "invalid", blocker: "format_invalid" };
  const dot = value.indexOf(".");
  const fraction = dot < 0 ? "" : value.slice(dot + 1);
  if (fraction.length > bounds.maxFractionDigits) return { status: "invalid", blocker: "precision_exceeded" };
  if (dot >= 0 && fraction.length === 0) return { status: "incomplete", blocker: "fraction_incomplete" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { status: "invalid", blocker: "format_invalid" };
  if (parsed < bounds.min) return { status: "invalid", blocker: "below_minimum" };
  if (parsed > bounds.max) return { status: "invalid", blocker: "above_maximum" };
  return { status: "valid", value: parsed };
}

export function terminalDecimalDraftBlockerLabel(
  blocker: TerminalDecimalDraftBlocker,
  bounds: TerminalDecimalDraftBounds,
) {
  if (blocker === "format_invalid") return "Use digits and one decimal point.";
  if (blocker === "precision_exceeded") return `Use at most ${bounds.maxFractionDigits} decimal place${bounds.maxFractionDigits === 1 ? "" : "s"}.`;
  if (blocker === "below_minimum") return `Minimum ${formatBound(bounds.min)}.`;
  if (blocker === "above_maximum") return `Maximum ${formatBound(bounds.max)}.`;
  return blocker === "fraction_incomplete" ? "Finish the decimal value." : "Enter a value.";
}

function validBounds(bounds: TerminalDecimalDraftBounds) {
  return Number.isFinite(bounds.min)
    && Number.isFinite(bounds.max)
    && bounds.min >= 0
    && bounds.max >= bounds.min
    && Number.isInteger(bounds.maxFractionDigits)
    && bounds.maxFractionDigits >= 0
    && bounds.maxFractionDigits <= 8;
}

function formatBound(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
