import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyTerminalPlanBookStore,
  inspectTerminalPlanBookStore,
  serializeTerminalPlanBookStore,
  terminalPlanBookStorageKey,
  upsertTerminalPlanSnapshot,
  type TerminalPlanBookIdentity,
  type TerminalPlanDraft,
} from "@/lib/terminal-plan-book";
import { TerminalPlanBook, type TerminalPlanBookProps } from "./TerminalPlanBook";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const IDENTITY: TerminalPlanBookIdentity = { venue: "hyperliquid", network: "mainnet", product: "BTC-PERP", interval: "5m" };

describe("TerminalPlanBook", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("saves and restores an exact current plan without preview or submit authority", () => {
    const onCapture = vi.fn(() => draft());
    const onRestore = vi.fn(() => true);
    act(() => root.render(createElement(TerminalPlanBook, props({ onCapture, onRestore }))));
    openBook(container);
    act(() => {
      completeJournalForm(container, "Pullback A");
      requiredButton(container, "Save plan").click();
    });
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Plan and decision context saved locally");
    expect(container.textContent).toContain("PULLBACK · Buyers defended the prior breakout level");
    expect(container.textContent).toContain("Invalidated if · The breakout level fails on acceptance");
    expect(container.textContent).toContain("BUY 100 · inv 98 · 2.0R 104");
    expect(container.textContent).toContain("Risk $0.25 / $1.00 · target +$0.35 · 1.40R · 25%");
    const key = terminalPlanBookStorageKey("device_guest") as string;
    expect(inspectTerminalPlanBookStore(window.localStorage.getItem(key), NOW)).toMatchObject({ status: "ready", store: { plans: [{ name: "Pullback A" }] } });

    act(() => requiredButton(container, "Restore").click());
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ name: "Pullback A", entryPrice: 100 }));
    expect(container.textContent).toContain("restored to the ticket");
  });

  it("requires review for aged/drifted plans and rechecks through the restore callback", () => {
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "older",
      name: "Older plan",
    }, NOW - 2 * 60 * 60_000);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRestore = vi.fn(() => false);
    act(() => root.render(createElement(TerminalPlanBook, props({ getCurrentReferencePrice: () => 103, onRestore }))));
    openBook(container);
    expect(container.textContent).toContain("2h old · 300.0 bp drift · review");
    act(() => requiredButton(container, "Restore").click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Market drift is 300.0 bp"));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Restore blocked: market certification or execution state changed");
  });

  it("hands a saved thesis to monitoring without restoring or submitting", () => {
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "watch-plan",
      name: "Watch plan",
    }, NOW);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    const onWatch = vi.fn(() => true);
    const onRestore = vi.fn(() => true);
    act(() => root.render(createElement(TerminalPlanBook, props({ onWatch, onRestore }))));
    openBook(container);
    act(() => requiredButton(container, "Watch").click());
    expect(onWatch).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-plan", name: "Watch plan" }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(container.textContent).toContain("sent to local alerts");
    expect(container.textContent).toContain("no order submitted");
  });

  it("shows persistent watch state and requests safe unwatch without restoring", async () => {
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "watch-plan",
      name: "Watch plan",
    }, NOW);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    const onUnwatch = vi.fn(() => true);
    const onInventoryChange = vi.fn();
    const onRestore = vi.fn(() => true);
    await act(async () => {
      root.render(createElement(TerminalPlanBook, props({
        onWatch: () => true,
        onUnwatch,
        onInventoryChange,
        watchedPlanIds: ["watch-plan"],
        onRestore,
      })));
      await Promise.resolve();
    });
    openBook(container);
    await act(async () => {
      await Promise.resolve();
    });
    const unwatch = requiredButton(container, "Unwatch");
    expect(unwatch.getAttribute("aria-pressed")).toBe("true");
    act(() => unwatch.click());
    expect(onUnwatch).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-plan" }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(container.textContent).toContain("triggered history remains");
    expect(onInventoryChange).toHaveBeenLastCalledWith([{ planId: "watch-plan", instrument: "BTC-PERP" }]);
  });

  it("reports deletion inventory so orphan watches can be removed", async () => {
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "delete-plan",
      name: "Delete plan",
    }, NOW);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onInventoryChange = vi.fn();
    await act(async () => {
      root.render(createElement(TerminalPlanBook, props({ onInventoryChange })));
      await Promise.resolve();
    });
    openBook(container);
    await act(async () => {
      required<HTMLButtonElement>(container, 'button[aria-label="Delete Delete plan"]').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Delete plan deleted");
    expect(onInventoryChange).toHaveBeenLastCalledWith([]);
    expect(inspectTerminalPlanBookStore(window.localStorage.getItem(key), NOW)).toMatchObject({ store: { plans: [] } });
  });

  it("keeps other instruments hidden and blocks save without a certified plan", () => {
    const otherIdentity = { ...IDENTITY, product: "ETH-PERP" };
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "eth",
      name: "ETH plan",
      identity: otherIdentity,
    }, NOW);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    act(() => root.render(createElement(TerminalPlanBook, props({ onCapture: () => null }))));
    openBook(container);
    expect(container.textContent).toContain("ETH plan");
    expect(requiredButton(container, "Inspect").disabled).toBe(true);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Restore")).toBe(false);
    act(() => {
      completeJournalForm(container, "Blocked");
      requiredButton(container, "Save plan").click();
    });
    expect(container.textContent).toContain("certified reference and valid entry/invalidation");
  });

  it("surfaces other-market plans for inspect-only navigation", () => {
    let store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "btc",
      name: "BTC plan",
    }, NOW);
    store = upsertTerminalPlanSnapshot(store, {
      ...draft(),
      ...decisionContext(),
      id: "eth",
      name: "ETH breakout",
      identity: { ...IDENTITY, product: "ETH-PERP", interval: "15m" },
    }, NOW + 1);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW + 1));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1);
    const onInspectIdentity = vi.fn(() => true);
    const onRestore = vi.fn(() => true);
    act(() => root.render(createElement(TerminalPlanBook, props({ onInspectIdentity, onRestore }))));
    openBook(container);
    expect(container.textContent).toContain("1/6 · 2 total");
    expect(container.textContent).toContain("ETH breakout");
    expect(container.textContent).toContain("Risk $0.25 / $1.00 · target +$0.35 · 1.40R");
    act(() => requiredButton(container, "Inspect").click());
    expect(onInspectIdentity).toHaveBeenCalledWith({ ...IDENTITY, product: "ETH-PERP", interval: "15m" });
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("refreshes visible drift on demand without subscribing to market ticks", () => {
    const store = upsertTerminalPlanSnapshot(emptyTerminalPlanBookStore(), {
      ...draft(),
      ...decisionContext(),
      id: "review",
      name: "Review",
    }, NOW);
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, serializeTerminalPlanBookStore(store, NOW));
    let reference = 100;
    act(() => root.render(createElement(TerminalPlanBook, props({ getCurrentReferencePrice: () => reference }))));
    openBook(container);
    expect(container.textContent).toContain("0.0 bp drift");
    reference = 103;
    act(() => requiredButton(container, "Refresh review").click());
    expect(container.textContent).toContain("300.0 bp drift · review");
  });

  it("preserves unreadable storage until an explicit confirmed reset", () => {
    const key = terminalPlanBookStorageKey("device_guest") as string;
    window.localStorage.setItem(key, "{broken-plan-book");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => root.render(createElement(TerminalPlanBook, props())));
    openBook(container);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    act(() => requiredButton(container, "Reset storage").click());
    expect(confirm).toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe("{broken-plan-book");
  });
});

function props(overrides: Partial<TerminalPlanBookProps> = {}): TerminalPlanBookProps {
  return {
    persistenceScope: "device_guest",
    identity: IDENTITY,
    getCurrentReferencePrice: () => 100,
    onCapture: () => draft(),
    onRestore: () => true,
    ...overrides,
  };
}

function draft(): TerminalPlanDraft {
  return {
    identity: IDENTITY,
    side: "buy",
    entryPrice: 100,
    invalidationPrice: 98,
    targetRewardMultiple: 2,
    notionalUsd: 10,
    riskBudgetUsd: 1,
    slippageBps: 50,
    certifiedReferencePrice: 100,
  };
}

function decisionContext() {
  return {
    setup: "pullback" as const,
    thesis: "Buyers defended the prior breakout level",
    invalidationNote: "The breakout level fails on acceptance",
  };
}

function openBook(container: HTMLElement) {
  const details = required<HTMLDetailsElement>(container, "details");
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function completeJournalForm(container: HTMLElement, name: string) {
  setInputValue(required<HTMLInputElement>(container, "#terminal-plan-book-name"), name);
  setInputValue(required<HTMLInputElement>(container, 'input[placeholder^="Thesis:"]'), "Buyers defended the prior breakout level");
  setInputValue(required<HTMLInputElement>(container, 'input[placeholder^="Invalidated if:"]'), "The breakout level fails on acceptance");
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing:${selector}`);
  return value;
}

function requiredButton(root: ParentNode, label: string) {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`missing-button:${label}`);
  return button as HTMLButtonElement;
}
