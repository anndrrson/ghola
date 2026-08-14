"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Command, Search } from "lucide-react";
import { searchTerminalCommands, type TerminalCommand } from "@/lib/terminal-command";
import { terminalModalIsOpen, terminalPaletteShortcutAllowed } from "@/lib/terminal-hotkeys";

export function TerminalCommandPalette({ onCommand }: { onCommand: (command: TerminalCommand) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogId = useId();
  const headingId = useId();
  const inputId = useId();
  const resultsId = useId();
  const statusId = useId();
  const results = useMemo(() => searchTerminalCommands(query), [query]);
  const activeResult = results[active] ?? null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (terminalPaletteShortcutAllowed(event)) {
        if (!dialogRef.current?.open && terminalModalIsOpen(document)) return;
        event.preventDefault();
        setQuery("");
        setActive(0);
        setOpen((current) => !current);
      } else if (event.key === "Escape" && dialogRef.current?.open) {
        event.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeElement = document.activeElement;
    const restoreFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : triggerRef.current;
    if (!dialog.open) dialog.showModal();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      if (restoreFocus?.isConnected) restoreFocus.focus();
    };
  }, [open]);

  function openPalette() {
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  function execute(command: TerminalCommand) {
    onCommand(command);
    setOpen(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openPalette}
        className={`${open ? "trade-chip-on" : "trade-chip"} inline-flex h-10 w-10 items-center justify-center gap-1.5 rounded-md text-[10px] uppercase tracking-[0.08em] sm:h-8 sm:w-auto sm:px-2.5`}
        aria-label="Open terminal command palette"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Command className="h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden />
        <span className="hidden sm:inline">Command</span>
        <kbd className="hidden font-mono text-[9px] text-[#aeb9cb] sm:inline">⌘K</kbd>
      </button>
      {open ? (
        <dialog
          ref={dialogRef}
          id={dialogId}
          className="fixed inset-0 z-[80] m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-inherit backdrop:bg-black/70 backdrop:backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div
            className="flex h-full items-start justify-center px-3 pt-[12vh]"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) setOpen(false);
            }}
          >
            <div
              className="w-full max-w-xl overflow-hidden rounded-lg border border-[#26354a] bg-[#080c13] shadow-[0_24px_90px_rgba(0,0,0,0.65)]"
            >
              <h2 id={headingId} className="sr-only">Terminal commands</h2>
              <div className="flex h-12 items-center gap-3 border-b border-[#182234] px-4">
                <Search className="h-4 w-4 text-[#6f7d9a]" aria-hidden />
                <label htmlFor={inputId} className="sr-only">Search terminal commands</label>
                <input
                  id={inputId}
                  ref={inputRef}
                  role="combobox"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      if (results.length) setActive((current) => Math.min(results.length - 1, current + 1));
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      if (results.length) setActive((current) => Math.max(0, current - 1));
                    } else if (event.key === "Enter" && results[active]) {
                      event.preventDefault();
                      execute(results[active].command);
                    }
                  }}
                  placeholder="Market, interval, order, chart, alert…"
                  className="h-full min-w-0 flex-1 bg-transparent text-sm text-[#eef1f8] outline-none placeholder:text-[#8b95a8]"
                  aria-autocomplete="list"
                  aria-expanded={open}
                  aria-haspopup="listbox"
                  aria-controls={resultsId}
                  aria-activedescendant={activeResult ? `${resultsId}-${activeResult.id}` : undefined}
                />
                <kbd className="rounded border border-[#26354a] px-1.5 py-0.5 font-mono text-[9px] text-[#6f7d9a]">ESC</kbd>
              </div>
              <div id={resultsId} role="listbox" aria-label="Terminal command results" className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
                {results.length ? results.map((item, index) => (
                  <button
                    id={`${resultsId}-${item.id}`}
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    aria-keyshortcuts={item.shortcut}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => execute(item.command)}
                    className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2.5 text-left text-sm ${index === active ? "bg-sky-300/10 text-sky-100" : "text-[#aeb9cb] hover:bg-[#0d1420]"}`}
                  >
                    <span>{item.label}</span>
                    {item.shortcut ? <kbd className="font-mono text-[9px] text-[#8b95a8]">{item.shortcut}</kbd> : null}
                  </button>
                )) : (
                  <div role="option" aria-selected="false" aria-disabled="true" className="px-3 py-8 text-center text-xs text-[#8b95a8]">No command found.</div>
                )}
              </div>
              <p id={statusId} role="status" aria-atomic="true" className="sr-only">
                {activeResult
                  ? `${activeResult.label}. Option ${active + 1} of ${results.length}.`
                  : "No terminal commands match the search."}
              </p>
              <div className="flex justify-between border-t border-[#182234] px-4 py-2 font-mono text-[9px] uppercase text-[#8b95a8]">
                <span>↑↓ navigate · enter run</span><span>C/W/P/O · B/S · 1–4 · D/L · N/E/I/G/V · U/J/X · ⇧J/⇧X risk</span>
              </div>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
