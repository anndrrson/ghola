import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalCommandPalette } from "./TerminalCommandPalette";

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");

describe("TerminalCommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;
  let showModal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    Object.defineProperty(dialogPrototype, "showModal", {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(dialogPrototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreProperty("showModal", originalShowModal);
    restoreProperty("close", originalClose);
    vi.unstubAllGlobals();
  });

  it("opens a named native modal and restores trigger focus on Escape", () => {
    act(() => root.render(createElement(TerminalCommandPalette, { onCommand: vi.fn() })));
    const trigger = requiredElement<HTMLButtonElement>(container, 'button[aria-haspopup="dialog"]');
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();

    act(() => trigger.click());

    const dialog = requiredElement<HTMLDialogElement>(container, "dialog");
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Terminal commands");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.activeElement).toBe(requiredElement<HTMLInputElement>(dialog, 'input[role="combobox"]'));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(container.querySelector("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("discovers and executes the Replay command", () => {
    const onCommand = vi.fn();
    act(() => root.render(createElement(TerminalCommandPalette, { onCommand })));
    const trigger = requiredElement<HTMLButtonElement>(container, 'button[aria-haspopup="dialog"]');
    act(() => trigger.click());
    const input = requiredElement<HTMLInputElement>(container, 'input[role="combobox"]');

    act(() => {
      setInputValue(input, "replay");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const replay = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Toggle historical replay"));
    expect(replay).toBeTruthy();
    act(() => replay?.click());
    expect(onCommand).toHaveBeenCalledWith({ type: "toggle_replay" });
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("discovers keyboard-first ticket staging without exposing execution", () => {
    const onCommand = vi.fn();
    act(() => root.render(createElement(TerminalCommandPalette, { onCommand })));
    act(() => requiredElement<HTMLButtonElement>(container, 'button[aria-haspopup="dialog"]').click());
    const input = requiredElement<HTMLInputElement>(container, 'input[role="combobox"]');

    act(() => {
      setInputValue(input, "focus invalidation");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const option = requiredElement<HTMLButtonElement>(container, '[role="option"]');
    expect(option.textContent).toContain("Focus plan invalidation");
    expect(option.getAttribute("aria-keyshortcuts")).toBe("I");
    expect(container.textContent).toContain("D/L · N/E/I/G/V");
    expect(container.textContent).toContain("⇧J/⇧X risk");
    act(() => option.click());
    expect(onCommand).toHaveBeenCalledWith({ type: "focus_ticket_field", field: "invalidation" });
    expect(onCommand.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ type: "execute" }));
  });

  it("does not open over another modal and still toggles its own modal closed", () => {
    act(() => root.render(createElement(TerminalCommandPalette, { onCommand: vi.fn() })));
    const externalModal = document.createElement("section");
    externalModal.setAttribute("role", "dialog");
    externalModal.setAttribute("aria-modal", "true");
    document.body.append(externalModal);
    const blocked = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });

    act(() => window.dispatchEvent(blocked));

    expect(blocked.defaultPrevented).toBe(false);
    expect(container.querySelector("dialog")).toBeNull();
    externalModal.remove();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })));
    expect(container.querySelector("dialog")).toBeTruthy();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })));
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("ignores modified, repeated, and already-consumed command chords", () => {
    act(() => root.render(createElement(TerminalCommandPalette, { onCommand: vi.fn() })));
    const invalid = [
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, repeat: true, cancelable: true }),
    ];
    const consumed = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    consumed.preventDefault();

    act(() => [...invalid, consumed].forEach((event) => window.dispatchEvent(event)));

    expect(container.querySelector("dialog")).toBeNull();
    invalid.forEach((event) => expect(event.defaultPrevented).toBe(false));
    expect(consumed.defaultPrevented).toBe(true);
  });
});

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing test element: ${selector}`);
  return value;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing HTMLInputElement value setter");
  setter.call(input, value);
}

function restoreProperty(name: "showModal" | "close", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(dialogPrototype, name, descriptor);
  else Reflect.deleteProperty(dialogPrototype, name);
}
