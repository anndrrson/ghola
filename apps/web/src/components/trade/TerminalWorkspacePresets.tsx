"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import type { TerminalWorkspace } from "@/lib/terminal-workspace";
import {
  clearTerminalWorkspacePresets,
  emptyTerminalWorkspacePresetStore,
  inspectTerminalWorkspacePresetStore,
  mergeTerminalWorkspacePresetStores,
  removeTerminalWorkspacePreset,
  serializeTerminalWorkspacePresetStore,
  TERMINAL_WORKSPACE_PRESET_LIMIT,
  TERMINAL_WORKSPACE_PRESETS_GUEST_SCOPE,
  terminalWorkspacePresetsStorageKey,
  terminalWorkspacePresetStoresEqual,
  upsertTerminalWorkspacePreset,
  type TerminalWorkspacePresetInspection,
} from "@/lib/terminal-workspace-presets";

export interface TerminalWorkspacePresetsProps {
  persistenceScope?: string | null;
  onCapture: () => TerminalWorkspace;
  onLoad: (workspace: TerminalWorkspace) => boolean;
}

export function TerminalWorkspacePresets({
  persistenceScope = TERMINAL_WORKSPACE_PRESETS_GUEST_SCOPE,
  onCapture,
  onLoad,
}: TerminalWorkspacePresetsProps) {
  const storageKey = terminalWorkspacePresetsStorageKey(persistenceScope);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const loadedRef = useRef(false);
  const [inspection, setInspection] = useState<TerminalWorkspacePresetInspection>(() => ({
    status: "absent",
    store: emptyTerminalWorkspacePresetStore(),
    raw: null,
  }));
  const inspectionRef = useRef(inspection);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const updateInspection = useCallback((next: TerminalWorkspacePresetInspection) => {
    inspectionRef.current = next;
    setInspection(next);
  }, []);

  function loadStorage() {
    if (loadedRef.current) return;
    loadedRef.current = true;
    if (!storageKey) return;
    try {
      updateInspection(inspectTerminalWorkspacePresetStore(window.localStorage.getItem(storageKey)));
    } catch {
      updateInspection({ status: "blocked", store: null, raw: "storage_unavailable" });
    }
  }

  useEffect(() => {
    if (!storageKey) return;
    const activeStorageKey = storageKey;
    function reconcileStorage(event: StorageEvent) {
      if (event.key !== activeStorageKey || (event.storageArea && event.storageArea !== window.localStorage)) return;
      const incoming = inspectTerminalWorkspacePresetStore(event.newValue);
      if (incoming.status === "blocked") {
        updateInspection(incoming);
        setMessage("Preset storage changed in another tab and is now locked");
        return;
      }
      const current = inspectionRef.current;
      const merged = current.status === "blocked"
        ? incoming.store
        : mergeTerminalWorkspacePresetStores(current.store, incoming.store);
      const raw = serializeTerminalWorkspacePresetStore(merged);
      if (!terminalWorkspacePresetStoresEqual(merged, incoming.store)) {
        try {
          window.localStorage.setItem(activeStorageKey, raw);
        } catch {
          updateInspection({ status: "blocked", store: null, raw: event.newValue ?? "storage_unavailable" });
          return;
        }
      }
      updateInspection({ status: "ready", store: merged, raw });
      setMessage("Workspace presets synchronized from another tab");
    }
    window.addEventListener("storage", reconcileStorage);
    return () => window.removeEventListener("storage", reconcileStorage);
  }, [storageKey, updateInspection]);

  function persist(next: Exclude<TerminalWorkspacePresetInspection["store"], null>) {
    if (!storageKey) throw new Error("terminal_workspace_preset_scope_unavailable");
    const current = inspectTerminalWorkspacePresetStore(window.localStorage.getItem(storageKey));
    if (current.status === "blocked") {
      updateInspection(current);
      throw new Error("terminal_workspace_preset_storage_blocked");
    }
    const merged = mergeTerminalWorkspacePresetStores(current.store, next);
    const raw = serializeTerminalWorkspacePresetStore(merged);
    window.localStorage.setItem(storageKey, raw);
    updateInspection({ status: "ready", store: merged, raw });
  }

  function save() {
    if (inspection.status === "blocked") return;
    try {
      const next = upsertTerminalWorkspacePreset(inspection.store, {
        id: createPresetId(),
        name,
        workspace: onCapture(),
      });
      persist(next);
      const savedName = next.presets[0]?.name ?? name.trim();
      setName("");
      setMessage(`${savedName} saved locally`);
    } catch (error) {
      setMessage(error instanceof Error && error.message === "terminal_workspace_preset_limit"
        ? `Preset limit reached (${TERMINAL_WORKSPACE_PRESET_LIMIT})`
        : "Enter a valid preset name");
    }
  }

  function load(workspace: TerminalWorkspace, presetName: string) {
    if (!onLoad(workspace)) {
      setMessage("Workspace load blocked while live execution is in flight");
      return;
    }
    setMessage(`${presetName} loaded · bound plan cleared`);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  function remove(id: string, presetName: string) {
    if (inspection.status === "blocked" || !window.confirm(`Delete local workspace preset “${presetName}”?`)) return;
    try {
      const next = removeTerminalWorkspacePreset(inspection.store, id);
      persist(next);
      setMessage(`${presetName} deleted`);
    } catch {
      setMessage("Preset deletion failed");
    }
  }

  function resetBlockedStorage() {
    if (!storageKey || inspection.status !== "blocked" || !window.confirm("Reset unreadable local workspace preset storage? This cannot be undone.")) return;
    try {
      const store = clearTerminalWorkspacePresets(emptyTerminalWorkspacePresetStore());
      const raw = serializeTerminalWorkspacePresetStore(store);
      window.localStorage.setItem(storageKey, raw);
      updateInspection({ status: "ready", store, raw });
      setMessage("Preset storage reset");
    } catch {
      setMessage("Preset storage remains unavailable");
    }
  }

  const presets = inspection.status === "blocked" ? [] : inspection.store.presets;
  return (
    <details
      ref={detailsRef}
      onToggle={(event) => {
        if (event.currentTarget.open) loadStorage();
      }}
      className="relative"
    >
      <summary className="trade-chip flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 text-[10px] uppercase text-[#8b95a8] marker:hidden">
        <LayoutTemplate className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden lg:inline">Workspaces</span>
        {presets.length ? <span className="font-mono text-[8px] text-sky-200">{presets.length}</span> : null}
      </summary>
      <div className="absolute right-0 top-10 z-50 w-80 rounded-md border border-[#26354a] bg-[#080c13] p-3 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#c7d2e4]">Local workspace presets</h2>
          <span className="font-mono text-[9px] text-[#66738c]">{presets.length}/{TERMINAL_WORKSPACE_PRESET_LIMIT}</span>
        </div>
        {inspection.status === "blocked" ? (
          <div role="alert" className="mt-3 rounded border border-rose-300/25 bg-rose-300/[0.04] p-2.5 text-[10px] leading-4 text-rose-200">
            Existing preset storage is unreadable and has been preserved. Loading and saving are locked.
            <button type="button" onClick={resetBlockedStorage} className="mt-2 block rounded border border-rose-300/30 px-2 py-1 text-[9px]">Reset preset storage</button>
          </div>
        ) : (
          <>
            <label className="mt-3 block text-[9px] uppercase tracking-[0.12em] text-[#66738c]">
              Preset name
              <input
                value={name}
                maxLength={24}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                }}
                placeholder="BTC scalp"
                className="trade-field mt-1 h-9 w-full rounded px-2.5 text-xs normal-case tracking-normal text-[#eef1f8] outline-none"
              />
            </label>
            <button type="button" onClick={save} disabled={!name.trim()} className="trade-action mt-2 h-8 w-full rounded text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-50">
              Save current workspace
            </button>
            <div className="mt-3 grid max-h-64 gap-1.5 overflow-y-auto" aria-label="Saved local workspaces">
              {presets.length === 0 ? <p className="py-2 text-[10px] text-[#66738c]">No saved presets.</p> : null}
              {presets.map((preset) => (
                <div key={preset.id} className="flex items-center gap-2 rounded border border-[#182234] bg-[#0a101a] px-2 py-1.5">
                  <button type="button" onClick={() => load(preset.workspace, preset.name)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[10px] font-medium text-[#dce6f4]">{preset.name}</span>
                    <span className="block truncate font-mono text-[8px] uppercase text-[#66738c]">
                      {preset.workspace.venue} · {preset.workspace.market} · {preset.workspace.interval} · {preset.workspace.chartMode}
                    </span>
                  </button>
                  <button type="button" aria-label={`Delete ${preset.name}`} onClick={() => remove(preset.id, preset.name)} className="rounded px-1.5 py-1 text-[9px] text-[#7f8da7] hover:text-rose-200">×</button>
                </div>
              ))}
            </div>
          </>
        )}
        <p aria-live="polite" className="mt-2 min-h-4 text-[9px] leading-4 text-amber-100">{message}</p>
        <p className="text-[8px] leading-3 text-[#566278]">Device-local only. Loading never previews or submits and clears bound execution state.</p>
      </div>
    </details>
  );
}

function createPresetId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "");
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
