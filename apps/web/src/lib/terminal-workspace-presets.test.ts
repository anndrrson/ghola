import { describe, expect, it } from "vitest";
import { defaultTerminalWorkspace } from "./terminal-workspace";
import {
  clearTerminalWorkspacePresets,
  emptyTerminalWorkspacePresetStore,
  inspectTerminalWorkspacePresetStore,
  mergeTerminalWorkspacePresetStores,
  removeTerminalWorkspacePreset,
  serializeTerminalWorkspacePresetStore,
  terminalWorkspacePresetsStorageKey,
  TERMINAL_WORKSPACE_PRESET_LIMIT,
  upsertTerminalWorkspacePreset,
} from "./terminal-workspace-presets";

const NOW = 1_786_533_600_000;

describe("terminal workspace presets", () => {
  it("uses exact guest/account namespaces and fails closed for malformed scopes", () => {
    const left = `subject_${"a".repeat(32)}`;
    const right = `subject_${"b".repeat(32)}`;
    expect(terminalWorkspacePresetsStorageKey(left)).not.toBe(terminalWorkspacePresetsStorageKey(right));
    expect(terminalWorkspacePresetsStorageKey("device_guest")).toBe(
      "ghola.terminal-workspace-presets.v2:device_guest",
    );
    expect(terminalWorkspacePresetsStorageKey("subject_short")).toBeNull();
  });

  it("normalizes, orders, updates by name, and round trips bounded presets", () => {
    let store = upsertTerminalWorkspacePreset(emptyTerminalWorkspacePresetStore(), {
      id: "first",
      name: "  BTC   scalp ",
      workspace: { ...defaultTerminalWorkspace(), notionalUsd: 7.25 },
    }, NOW);
    store = upsertTerminalWorkspacePreset(store, {
      id: "ignored-new-id",
      name: "btc scalp",
      workspace: { ...defaultTerminalWorkspace(), interval: "1m", bookView: "book" },
    }, NOW + 1);

    expect(store.presets).toHaveLength(1);
    expect(store.presets[0]).toMatchObject({ id: "first", name: "btc scalp", updatedAt: NOW + 1 });
    expect(store.presets[0].workspace).toMatchObject({ interval: "1m", bookView: "book" });
    expect(inspectTerminalWorkspacePresetStore(serializeTerminalWorkspacePresetStore(store, NOW + 1), NOW + 1)).toMatchObject({ status: "ready", store });
  });

  it("preserves corrupt or future storage as blocked", () => {
    expect(inspectTerminalWorkspacePresetStore("{bad", NOW)).toMatchObject({ status: "blocked", raw: "{bad" });
    const future = JSON.stringify({ version: 1, presets: [{ id: "future", name: "Future", workspace: defaultTerminalWorkspace(), updatedAt: NOW + 300_001 }] });
    expect(inspectTerminalWorkspacePresetStore(future, NOW)).toMatchObject({ status: "blocked", raw: future });
  });

  it("enforces unique identities, valid workspaces, names, and the hard cap", () => {
    let store = emptyTerminalWorkspacePresetStore();
    for (let index = 0; index < TERMINAL_WORKSPACE_PRESET_LIMIT; index += 1) {
      store = upsertTerminalWorkspacePreset(store, { id: `p${index}`, name: `Preset ${index}`, workspace: defaultTerminalWorkspace() }, NOW + index);
    }
    expect(() => upsertTerminalWorkspacePreset(store, { id: "overflow", name: "Overflow", workspace: defaultTerminalWorkspace() }, NOW + 10)).toThrow("terminal_workspace_preset_limit");
    expect(() => upsertTerminalWorkspacePreset(store, { id: "bad id", name: "Bad", workspace: defaultTerminalWorkspace() }, NOW + 10)).toThrow("terminal_workspace_preset_invalid");
    expect(inspectTerminalWorkspacePresetStore(JSON.stringify({ version: 1, presets: [store.presets[0], { ...store.presets[0], name: "Other" }] }), NOW + 10).status).toBe("blocked");
  });

  it("removes only the exact preset and rejects malformed identifiers", () => {
    const store = upsertTerminalWorkspacePreset(emptyTerminalWorkspacePresetStore(), { id: "one", name: "One", workspace: defaultTerminalWorkspace() }, NOW);
    expect(removeTerminalWorkspacePreset(store, "missing", NOW).presets).toHaveLength(1);
    const removed = removeTerminalWorkspacePreset(store, "one", NOW);
    expect(removed.presets).toHaveLength(0);
    expect(removed.tombstones).toMatchObject([{ id: "one", nameKey: "one", deletedAt: NOW + 1 }]);
    expect(() => removeTerminalWorkspacePreset(store, "bad id", NOW)).toThrow("terminal_workspace_preset_invalid");
  });

  it("merges concurrent sibling additions without last-writer loss", () => {
    const base = emptyTerminalWorkspacePresetStore();
    const left = upsertTerminalWorkspacePreset(base, { id: "btc", name: "BTC", workspace: defaultTerminalWorkspace() }, NOW);
    const right = upsertTerminalWorkspacePreset(base, { id: "eth", name: "ETH", workspace: { ...defaultTerminalWorkspace(), market: "ETH" } }, NOW + 1);
    const merged = mergeTerminalWorkspacePresetStores(left, right, NOW + 1);
    expect(merged.presets.map((preset) => preset.id)).toEqual(["eth", "btc"]);
  });

  it("uses deterministic last-revision wins for concurrent updates", () => {
    const base = upsertTerminalWorkspacePreset(emptyTerminalWorkspacePresetStore(), { id: "btc", name: "BTC", workspace: defaultTerminalWorkspace() }, NOW);
    const older = upsertTerminalWorkspacePreset(base, { id: "ignored", name: "BTC", workspace: { ...defaultTerminalWorkspace(), interval: "1m" } }, NOW + 1);
    const newer = upsertTerminalWorkspacePreset(base, { id: "ignored", name: "btc", workspace: { ...defaultTerminalWorkspace(), interval: "1h" } }, NOW + 2);
    expect(mergeTerminalWorkspacePresetStores(older, newer, NOW + 2).presets[0].workspace.interval).toBe("1h");
  });

  it("prevents stale tabs from resurrecting deleted presets", () => {
    const stale = upsertTerminalWorkspacePreset(emptyTerminalWorkspacePresetStore(), { id: "btc", name: "BTC", workspace: defaultTerminalWorkspace() }, NOW);
    const deleted = removeTerminalWorkspacePreset(stale, "btc", NOW + 1);
    expect(mergeTerminalWorkspacePresetStores(stale, deleted, NOW + 2).presets).toEqual([]);
    expect(mergeTerminalWorkspacePresetStores(deleted, stale, NOW + 2).presets).toEqual([]);

    const recreated = upsertTerminalWorkspacePreset(deleted, { id: "btc-new", name: "BTC", workspace: { ...defaultTerminalWorkspace(), interval: "1m" } }, NOW + 1);
    const merged = mergeTerminalWorkspacePresetStores(deleted, recreated, NOW + 3);
    expect(merged.presets).toMatchObject([{ id: "btc-new", workspace: { interval: "1m" } }]);
  });

  it("uses a store-wide clear revision to prevent reset resurrection", () => {
    const stale = upsertTerminalWorkspacePreset(
      emptyTerminalWorkspacePresetStore(),
      { id: "btc", name: "BTC", workspace: defaultTerminalWorkspace() },
      NOW,
    );
    const cleared = clearTerminalWorkspacePresets(stale, NOW + 1);

    expect(cleared).toEqual({ version: 3, presets: [], tombstones: [], clearedAt: NOW + 1 });
    expect(mergeTerminalWorkspacePresetStores(stale, cleared, NOW + 2).presets).toEqual([]);
    expect(mergeTerminalWorkspacePresetStores(cleared, stale, NOW + 2).presets).toEqual([]);

    const recreated = upsertTerminalWorkspacePreset(
      cleared,
      { id: "btc-new", name: "BTC", workspace: { ...defaultTerminalWorkspace(), interval: "1m" } },
      NOW + 1,
    );
    expect(recreated.presets).toMatchObject([{ id: "btc-new", updatedAt: NOW + 2 }]);
  });

  it("migrates legacy v1 documents into mergeable v2 storage", () => {
    const legacy = JSON.stringify({
      version: 1,
      presets: [{ id: "legacy", name: "Legacy", workspace: defaultTerminalWorkspace(), updatedAt: NOW }],
    });
    expect(inspectTerminalWorkspacePresetStore(legacy, NOW)).toMatchObject({
      status: "ready",
      store: { version: 3, presets: [{ id: "legacy" }], tombstones: [], clearedAt: 0 },
    });
  });

  it("migrates v2 tombstones with a zero clear barrier", () => {
    const v2 = JSON.stringify({
      version: 2,
      presets: [],
      tombstones: [{ id: "old", nameKey: "old", deletedAt: NOW }],
    });
    expect(inspectTerminalWorkspacePresetStore(v2, NOW)).toMatchObject({
      status: "ready",
      store: { version: 3, presets: [], clearedAt: 0 },
    });
  });
});
