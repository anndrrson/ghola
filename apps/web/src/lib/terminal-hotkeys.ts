import type { TerminalCommand, TerminalTicketField } from "./terminal-command";

export const TERMINAL_TICKET_FIELD_IDS: Record<TerminalTicketField, string> = {
  notional: "terminal-ticket-notional",
  entry: "terminal-ticket-entry",
  invalidation: "terminal-ticket-invalidation",
  risk_budget: "terminal-ticket-risk-budget",
};

export interface TerminalHotkeyInput {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  editableTarget?: boolean;
  modalOpen?: boolean;
}

export interface TerminalPaletteShortcutInput {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

const INTERVAL_BY_KEY = {
  "1": "1m",
  "2": "5m",
  "3": "15m",
  "4": "1h",
} as const;

const FIELD_BY_KEY = {
  n: "notional",
  e: "entry",
  i: "invalidation",
  g: "risk_budget",
} as const;

export function terminalCommandForHotkey(input: TerminalHotkeyInput): TerminalCommand | null {
  if (
    input.defaultPrevented
    || input.metaKey
    || input.ctrlKey
    || input.altKey
    || input.repeat
    || input.editableTarget
    || input.modalOpen
  ) return null;

  const key = input.key.toLowerCase();
  if (input.shiftKey) {
    return key === "j" || key === "x"
      ? { type: "stage_safe_sized_entry", mode: key === "j" ? "join" : "cross" }
      : null;
  }
  if (key === "b" || key === "s") {
    return { type: "select_side", side: key === "b" ? "buy" : "sell" };
  }
  const interval = INTERVAL_BY_KEY[key as keyof typeof INTERVAL_BY_KEY];
  if (interval) return { type: "select_interval", interval };
  const field = FIELD_BY_KEY[key as keyof typeof FIELD_BY_KEY];
  if (field) return { type: "focus_ticket_field", field };
  if (key === "l") return { type: "open_alerts" };
  if (key === "c") return { type: "open_chart" };
  if (key === "w") return { type: "open_scanner" };
  if (key === "p") return { type: "open_paper" };
  if (key === "o") return { type: "open_ticket" };
  if (key === "d") return { type: "toggle_book" };
  if (key === "v") return { type: "cycle_slippage" };
  if (key === "u" || key === "j" || key === "x") {
    return { type: "stage_entry_price", mode: key === "u" ? "auto" : key === "j" ? "join" : "cross" };
  }
  return null;
}

export function terminalPaletteShortcutAllowed(input: TerminalPaletteShortcutInput) {
  return input.key.toLowerCase() === "k"
    && Boolean(input.metaKey) !== Boolean(input.ctrlKey)
    && !input.altKey
    && !input.shiftKey
    && !input.repeat
    && !input.defaultPrevented;
}

export function nextTerminalSlippage(current: number): 25 | 50 | 100 {
  if (current === 25) return 50;
  if (current === 50) return 100;
  return 25;
}

export function terminalKeyboardEventIsEditable(
  input: Pick<Event, "target" | "composedPath"> | readonly EventTarget[],
) {
  if (typeof Element === "undefined") return false;
  const event = input as Pick<Event, "target" | "composedPath">;
  const path = Array.isArray(input) ? input : event.composedPath();
  const candidates = path.length ? path : Array.isArray(input) ? [] : [event.target];
  if (candidates.some((candidate) => candidate instanceof Element && candidate.closest(
    "input, textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])",
  ) != null)) return true;

  if (Array.isArray(input)) return false;
  const target = event.target instanceof Element ? event.target : null;
  const activeElement = target?.ownerDocument.activeElement
    ?? (typeof document === "undefined" ? null : document.activeElement);
  return customElementOwnsKeyboard(target) || customElementOwnsKeyboard(activeElement);
}

export function terminalModalIsOpen(root: ParentNode | null | undefined) {
  return Boolean(root?.querySelector("dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']"));
}

export function terminalTicketFocusRestoreTarget(input: {
  returnFocus: HTMLElement | null;
  mobileTrigger: HTMLElement | null;
  desktopTarget: HTMLElement | null;
  desktop: boolean;
}) {
  if (restorable(input.returnFocus)) return input.returnFocus;
  const fallback = input.desktop ? input.desktopTarget : input.mobileTrigger;
  if (restorable(fallback)) return fallback;
  return restorable(input.desktopTarget) ? input.desktopTarget : null;
}

export function terminalTicketReturnFocusTarget(input: {
  activeElement: Element | null;
  commandTrigger: HTMLElement | null;
}) {
  const active = input.activeElement;
  return active instanceof HTMLElement
    && active !== active.ownerDocument.body
    && !active.closest("dialog")
    ? active
    : input.commandTrigger;
}

function restorable(target: HTMLElement | null) {
  return Boolean(target?.isConnected && !target.closest("[inert]"));
}

function customElementOwnsKeyboard(target: Element | null) {
  // Closed shadow roots hide their focused descendants from composedPath().
  return Boolean(target?.localName.includes("-"));
}
