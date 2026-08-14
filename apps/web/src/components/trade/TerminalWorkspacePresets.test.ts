import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTerminalWorkspace } from "@/lib/terminal-workspace";
import {
  emptyTerminalWorkspacePresetStore,
  inspectTerminalWorkspacePresetStore,
  removeTerminalWorkspacePreset,
  serializeTerminalWorkspacePresetStore,
  terminalWorkspacePresetsStorageKey,
  TERMINAL_WORKSPACE_PRESETS_LEGACY_STORAGE_KEY,
  TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY,
  upsertTerminalWorkspacePreset,
} from "@/lib/terminal-workspace-presets";
import { TerminalWorkspacePresets } from "./TerminalWorkspacePresets";

describe("TerminalWorkspacePresets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  it("saves and safely loads a named local workspace", async () => {
    const workspace = { ...defaultTerminalWorkspace(), notionalUsd: 7.25, bookView: "book" as const };
    const onLoad = vi.fn(() => true);
    await render({ onCapture: () => workspace, onLoad });
    openDetails();

    change(input(), "BTC scalp");
    click(buttonNamed("Save current workspace"));

    const raw = window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY);
    expect(inspectTerminalWorkspacePresetStore(raw).store?.presets[0]).toMatchObject({ name: "BTC scalp", workspace });
    click(buttonStarting("BTC scalp"));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ notionalUsd: 7.25, bookView: "book" }));
    expect(container.textContent).toContain("bound plan cleared");
  });

  it("writes only the exact account namespace and preserves legacy bytes", async () => {
    const scope = `subject_${"a".repeat(32)}`;
    window.localStorage.setItem(TERMINAL_WORKSPACE_PRESETS_LEGACY_STORAGE_KEY, "legacy-private-data");
    await render({ persistenceScope: scope });
    openDetails();
    change(input(), "Account A");
    click(buttonNamed("Save current workspace"));

    expect(window.localStorage.getItem(terminalWorkspacePresetsStorageKey(scope)!)).not.toBeNull();
    expect(window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_LEGACY_STORAGE_KEY)).toBe("legacy-private-data");
  });

  it("keeps the preset open when live execution blocks loading", async () => {
    const onLoad = vi.fn(() => false);
    await render({ onLoad });
    openDetails();
    change(input(), "Blocked load");
    click(buttonNamed("Save current workspace"));
    const details = container.querySelector("details");
    if (!details) throw new Error("details_missing");
    details.open = true;
    click(buttonStarting("Blocked load"));
    expect(details.open).toBe(true);
    expect(container.textContent).toContain("blocked while live execution is in flight");
  });

  it("preserves corrupt storage until explicit confirmed reset", async () => {
    window.localStorage.setItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY, "{broken");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    openDetails();

    expect(container.textContent).toContain("unreadable and has been preserved");
    click(buttonNamed("Reset preset storage"));
    expect(window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY)).toBe("{broken");
    confirm.mockReturnValue(true);
    click(buttonNamed("Reset preset storage"));
    const recovered = inspectTerminalWorkspacePresetStore(
      window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY),
    );
    expect(recovered).toMatchObject({ status: "ready", store: { presets: [] } });
    expect(recovered.store?.clearedAt).toBeGreaterThan(0);

    const stale = upsertTerminalWorkspacePreset(
      emptyTerminalWorkspacePresetStore(),
      { id: "stale", name: "Stale", workspace: defaultTerminalWorkspace() },
      (recovered.store?.clearedAt ?? Date.now()) - 1,
    );
    dispatchStorage(serializeTerminalWorkspacePresetStore(stale));
    expect(buttonStartingOrNull("Stale")).toBeNull();
  });

  it("merges sibling-tab additions and prevents stale deletion resurrection", async () => {
    const now = Date.now();
    const base = emptyTerminalWorkspacePresetStore();
    const btc = upsertTerminalWorkspacePreset(base, { id: "btc", name: "BTC", workspace: defaultTerminalWorkspace() }, now);
    const eth = upsertTerminalWorkspacePreset(base, { id: "eth", name: "ETH", workspace: { ...defaultTerminalWorkspace(), market: "ETH" } }, now + 1);
    window.localStorage.setItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY, serializeTerminalWorkspacePresetStore(btc, now + 1));
    await render();
    openDetails();

    dispatchStorage(serializeTerminalWorkspacePresetStore(eth, now + 1));
    expect(container.textContent).toContain("BTC");
    expect(container.textContent).toContain("ETH");
    const merged = inspectTerminalWorkspacePresetStore(window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY), now + 2).store!;
    const deleted = removeTerminalWorkspacePreset(merged, "btc", now + 2);
    dispatchStorage(serializeTerminalWorkspacePresetStore(deleted, now + 3));
    expect(buttonStartingOrNull("BTC")).toBeNull();

    dispatchStorage(serializeTerminalWorkspacePresetStore(btc, now + 3));
    expect(buttonStartingOrNull("BTC")).toBeNull();
    expect(inspectTerminalWorkspacePresetStore(window.localStorage.getItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY), now + 3).store?.presets.map((preset) => preset.id)).toEqual(["eth"]);
  });

  async function render(overrides: Partial<Parameters<typeof TerminalWorkspacePresets>[0]> = {}) {
    await act(async () => {
      root.render(createElement(TerminalWorkspacePresets, {
        onCapture: () => defaultTerminalWorkspace(),
        onLoad: () => true,
        ...overrides,
      }));
    });
  }

  function input() {
    const element = container.querySelector("input");
    if (!element) throw new Error("input_missing");
    return element;
  }

  function openDetails() {
    const details = container.querySelector("details");
    if (!details) throw new Error("details_missing");
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
    });
  }

  function buttonNamed(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`button_not_found:${label}`);
    return button;
  }

  function buttonStarting(label: string) {
    const button = buttonStartingOrNull(label);
    if (!button) throw new Error(`button_not_found:${label}`);
    return button;
  }

  function buttonStartingOrNull(label: string) {
    return [...container.querySelectorAll("button")].find((item) => item.textContent?.trim().startsWith(label)) ?? null;
  }

  function dispatchStorage(raw: string) {
    window.localStorage.setItem(TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY, raw);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY,
      newValue: raw,
    })));
  }
});

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
