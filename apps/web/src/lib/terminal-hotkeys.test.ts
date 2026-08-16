import { afterEach, describe, expect, it } from "vitest";
import {
  nextTerminalSlippage,
  TERMINAL_TICKET_FIELD_IDS,
  terminalCommandForHotkey,
  terminalKeyboardEventIsEditable,
  terminalModalIsOpen,
  terminalPaletteShortcutAllowed,
  terminalTicketReturnFocusTarget,
  terminalTicketFocusRestoreTarget,
} from "./terminal-hotkeys";

describe("terminal hotkeys", () => {
  afterEach(() => document.body.replaceChildren());

  it("maps bounded staging shortcuts without execution actions", () => {
    expect(terminalCommandForHotkey({ key: "B" })).toEqual({ type: "select_side", side: "buy" });
    expect(terminalCommandForHotkey({ key: "s" })).toEqual({ type: "select_side", side: "sell" });
    expect(["1", "2", "3", "4"].map((key) => terminalCommandForHotkey({ key }))).toEqual([
      { type: "select_interval", interval: "1m" },
      { type: "select_interval", interval: "5m" },
      { type: "select_interval", interval: "15m" },
      { type: "select_interval", interval: "1h" },
    ]);
    expect(terminalCommandForHotkey({ key: "d" })).toEqual({ type: "toggle_book" });
    expect(terminalCommandForHotkey({ key: "l" })).toEqual({ type: "open_alerts" });
    expect(terminalCommandForHotkey({ key: "c" })).toEqual({ type: "open_chart" });
    expect(terminalCommandForHotkey({ key: "W" })).toEqual({ type: "open_scanner" });
    expect(terminalCommandForHotkey({ key: "p" })).toEqual({ type: "open_paper" });
    expect(terminalCommandForHotkey({ key: "O" })).toEqual({ type: "open_ticket" });
    expect(terminalCommandForHotkey({ key: "m" })).toBeNull();
    expect(terminalCommandForHotkey({ key: "N" })).toEqual({ type: "focus_ticket_field", field: "notional" });
    expect(terminalCommandForHotkey({ key: "e" })).toEqual({ type: "focus_ticket_field", field: "entry" });
    expect(terminalCommandForHotkey({ key: "i" })).toEqual({ type: "focus_ticket_field", field: "invalidation" });
    expect(terminalCommandForHotkey({ key: "g" })).toEqual({ type: "focus_ticket_field", field: "risk_budget" });
    expect(terminalCommandForHotkey({ key: "v" })).toEqual({ type: "cycle_slippage" });
    expect(terminalCommandForHotkey({ key: "U" })).toEqual({ type: "stage_entry_price", mode: "auto" });
    expect(terminalCommandForHotkey({ key: "j" })).toEqual({ type: "stage_entry_price", mode: "join" });
    expect(terminalCommandForHotkey({ key: "X" })).toEqual({ type: "stage_entry_price", mode: "cross" });
    expect(terminalCommandForHotkey({ key: "J", shiftKey: true })).toEqual({ type: "stage_safe_sized_entry", mode: "join" });
    expect(terminalCommandForHotkey({ key: "X", shiftKey: true })).toEqual({ type: "stage_safe_sized_entry", mode: "cross" });
    expect(terminalCommandForHotkey({ key: "B", shiftKey: true })).toBeNull();
    expect(terminalCommandForHotkey({ key: "Enter" })).toBeNull();
  });

  it.each([
    ["default prevented", { defaultPrevented: true }],
    ["Meta modifier", { metaKey: true }],
    ["Control modifier", { ctrlKey: true }],
    ["Alt modifier", { altKey: true }],
    ["key repeat", { repeat: true }],
    ["editable target", { editableTarget: true }],
    ["open modal", { modalOpen: true }],
  ])("rejects %s", (_label, guard) => {
    expect(terminalCommandForHotkey({ key: "n", ...guard })).toBeNull();
  });

  it("cycles only the bounded slippage values", () => {
    expect(nextTerminalSlippage(25)).toBe(50);
    expect(nextTerminalSlippage(50)).toBe(100);
    expect(nextTerminalSlippage(100)).toBe(25);
    expect(nextTerminalSlippage(Number.NaN)).toBe(25);
  });

  it("accepts only exact, fresh Ctrl/Meta+K palette chords", () => {
    expect(terminalPaletteShortcutAllowed({ key: "K", ctrlKey: true })).toBe(true);
    expect(terminalPaletteShortcutAllowed({ key: "k", metaKey: true })).toBe(true);
    expect(terminalPaletteShortcutAllowed({ key: "k" })).toBe(false);
    expect(terminalPaletteShortcutAllowed({ key: "k", ctrlKey: true, metaKey: true })).toBe(false);
    expect(terminalPaletteShortcutAllowed({ key: "k", ctrlKey: true, altKey: true })).toBe(false);
    expect(terminalPaletteShortcutAllowed({ key: "k", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(terminalPaletteShortcutAllowed({ key: "k", ctrlKey: true, repeat: true })).toBe(false);
    expect(terminalPaletteShortcutAllowed({ key: "k", ctrlKey: true, defaultPrevented: true })).toBe(false);
  });

  it("detects editable descendants through a composed shadow-DOM path", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    shadow.append(input, editor);
    document.body.append(host);

    expect(editabilityObservedAtWindow(input)).toBe(true);
    expect(editabilityObservedAtWindow(child)).toBe(true);
    expect(editabilityObservedAtWindow(host)).toBe(false);
    expect(terminalKeyboardEventIsEditable([host, document.body])).toBe(false);
  });

  it("lets a closed custom-element shadow host own input keystrokes", () => {
    const host = document.createElement("terminal-editor");
    const shadow = host.attachShadow({ mode: "closed" });
    const input = document.createElement("input");
    shadow.append(input);
    document.body.append(host);
    input.focus();

    const observation = editabilityObservationAtWindow(input);

    expect(document.activeElement).toBe(host);
    expect(observation.target).toBe(host);
    expect(observation.path).not.toContain(input);
    expect(observation.editable).toBe(true);
  });

  it("detects open native or ARIA modals", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);
    expect(terminalKeyboardEventIsEditable([child, editor, document.body])).toBe(true);
    expect(terminalKeyboardEventIsEditable([document.body])).toBe(false);
    expect(terminalModalIsOpen(document)).toBe(false);

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(terminalModalIsOpen(document)).toBe(true);
    dialog.remove();

    const ariaDialog = document.createElement("section");
    ariaDialog.setAttribute("role", "dialog");
    ariaDialog.setAttribute("aria-modal", "true");
    document.body.append(ariaDialog);
    expect(terminalModalIsOpen(document)).toBe(true);
  });

  it("exposes stable focus targets for every staged ticket field", () => {
    expect(TERMINAL_TICKET_FIELD_IDS).toEqual({
      notional: "terminal-ticket-notional",
      entry: "terminal-ticket-entry",
      invalidation: "terminal-ticket-invalidation",
      risk_budget: "terminal-ticket-risk-budget",
    });
  });

  it("restores mobile focus to a remounted trigger and desktop focus to the ticket", () => {
    const removedTrigger = document.createElement("button");
    const remountedTrigger = document.createElement("button");
    const desktopField = document.createElement("input");
    document.body.append(remountedTrigger, desktopField);

    expect(terminalTicketFocusRestoreTarget({
      returnFocus: removedTrigger,
      mobileTrigger: remountedTrigger,
      desktopTarget: desktopField,
      desktop: false,
    })).toBe(remountedTrigger);
    expect(terminalTicketFocusRestoreTarget({
      returnFocus: removedTrigger,
      mobileTrigger: remountedTrigger,
      desktopTarget: desktopField,
      desktop: true,
    })).toBe(desktopField);

    const stable = document.createElement("button");
    document.body.append(stable);
    expect(terminalTicketFocusRestoreTarget({
      returnFocus: stable,
      mobileTrigger: remountedTrigger,
      desktopTarget: desktopField,
      desktop: true,
    })).toBe(stable);
  });

  it("captures the invoking surface unless the command originated inside a dialog", () => {
    const surface = document.createElement("section");
    surface.tabIndex = -1;
    const trigger = document.createElement("button");
    const dialog = document.createElement("dialog");
    const dialogInput = document.createElement("input");
    dialog.append(dialogInput);
    document.body.append(surface, trigger, dialog);

    expect(terminalTicketReturnFocusTarget({ activeElement: surface, commandTrigger: trigger })).toBe(surface);
    expect(terminalTicketReturnFocusTarget({ activeElement: dialogInput, commandTrigger: trigger })).toBe(trigger);
    expect(terminalTicketReturnFocusTarget({ activeElement: document.body, commandTrigger: trigger })).toBe(trigger);
  });
});

function editabilityObservedAtWindow(target: Element) {
  return editabilityObservationAtWindow(target).editable;
}

function editabilityObservationAtWindow(target: Element) {
  let observation: {
    editable: boolean;
    path: EventTarget[];
    target: EventTarget | null;
  } = { editable: false, path: [], target: null };
  const listener = (event: KeyboardEvent) => {
    observation = {
      editable: terminalKeyboardEventIsEditable(event),
      path: event.composedPath(),
      target: event.target,
    };
  };
  window.addEventListener("keydown", listener, { once: true });
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true }));
  return observation;
}
