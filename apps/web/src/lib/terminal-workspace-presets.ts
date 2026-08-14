import { validateTerminalWorkspace, type TerminalWorkspace } from "./terminal-workspace";

export const TERMINAL_WORKSPACE_PRESETS_VERSION = 3 as const;
export const TERMINAL_WORKSPACE_PRESETS_LEGACY_STORAGE_KEY = "ghola.terminal-workspace-presets.v1";
export const TERMINAL_WORKSPACE_PRESETS_STORAGE_PREFIX = "ghola.terminal-workspace-presets.v2:";
export const TERMINAL_WORKSPACE_PRESETS_GUEST_SCOPE = "device_guest";
export const TERMINAL_WORKSPACE_PRESETS_STORAGE_KEY =
  `${TERMINAL_WORKSPACE_PRESETS_STORAGE_PREFIX}${TERMINAL_WORKSPACE_PRESETS_GUEST_SCOPE}`;
export const TERMINAL_WORKSPACE_PRESET_LIMIT = 6;
export const TERMINAL_WORKSPACE_PRESET_NAME_LIMIT = 24;
const TERMINAL_WORKSPACE_PRESET_TOMBSTONE_LIMIT = 24;
const FUTURE_TOLERANCE_MS = 300_000;
const PERSISTENCE_SCOPE_PATTERN = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export function terminalWorkspacePresetsStorageKey(
  persistenceScope: string | null | undefined,
): string | null {
  return typeof persistenceScope === "string" && PERSISTENCE_SCOPE_PATTERN.test(persistenceScope)
    ? `${TERMINAL_WORKSPACE_PRESETS_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export interface TerminalWorkspacePreset {
  id: string;
  name: string;
  workspace: TerminalWorkspace;
  updatedAt: number;
}

export interface TerminalWorkspacePresetTombstone {
  id: string;
  nameKey: string;
  deletedAt: number;
}

export interface TerminalWorkspacePresetStore {
  version: typeof TERMINAL_WORKSPACE_PRESETS_VERSION;
  presets: TerminalWorkspacePreset[];
  tombstones: TerminalWorkspacePresetTombstone[];
  clearedAt: number;
}

export type TerminalWorkspacePresetInspection =
  | { status: "absent"; store: TerminalWorkspacePresetStore; raw: null }
  | { status: "ready"; store: TerminalWorkspacePresetStore; raw: string }
  | { status: "blocked"; store: null; raw: string };

export function emptyTerminalWorkspacePresetStore(): TerminalWorkspacePresetStore {
  return { version: TERMINAL_WORKSPACE_PRESETS_VERSION, presets: [], tombstones: [], clearedAt: 0 };
}

export function inspectTerminalWorkspacePresetStore(
  raw: string | null | undefined,
  nowMs = Date.now(),
): TerminalWorkspacePresetInspection {
  if (raw == null || raw === "") return { status: "absent", store: emptyTerminalWorkspacePresetStore(), raw: null };
  try {
    const store = validateStore(JSON.parse(raw), nowMs);
    return store ? { status: "ready", store, raw } : { status: "blocked", store: null, raw };
  } catch {
    return { status: "blocked", store: null, raw };
  }
}

export function serializeTerminalWorkspacePresetStore(
  store: TerminalWorkspacePresetStore,
  nowMs = Date.now(),
) {
  const valid = validateStore(store, nowMs);
  if (!valid) throw new Error("terminal_workspace_presets_invalid");
  return JSON.stringify(valid);
}

export function terminalWorkspacePresetStoresEqual(
  left: TerminalWorkspacePresetStore,
  right: TerminalWorkspacePresetStore,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeTerminalWorkspacePresetStores(
  left: TerminalWorkspacePresetStore,
  right: TerminalWorkspacePresetStore,
  nowMs = Date.now(),
): TerminalWorkspacePresetStore {
  const leftStore = requireStore(left, nowMs);
  const rightStore = requireStore(right, nowMs);
  return normalizeStore(
    [...leftStore.presets, ...rightStore.presets],
    [...leftStore.tombstones, ...rightStore.tombstones],
    Math.max(leftStore.clearedAt, rightStore.clearedAt),
  );
}

export function upsertTerminalWorkspacePreset(
  store: TerminalWorkspacePresetStore,
  input: { id: string; name: string; workspace: TerminalWorkspace },
  nowMs = Date.now(),
): TerminalWorkspacePresetStore {
  const current = requireStore(store, nowMs);
  const id = validId(input.id);
  const name = normalizeName(input.name);
  const workspace = validateTerminalWorkspace(input.workspace);
  if (!id || !name || !workspace || !validNow(nowMs)) throw new Error("terminal_workspace_preset_invalid");
  const nameKey = normalizeNameKey(name);
  const existing = current.presets.find((preset) => normalizeNameKey(preset.name) === nameKey);
  if (!existing && current.presets.length >= TERMINAL_WORKSPACE_PRESET_LIMIT) throw new Error("terminal_workspace_preset_limit");
  const revision = Math.max(
    nowMs,
    current.clearedAt + 1,
    ...current.tombstones
      .filter((tombstone) => tombstone.id === (existing?.id ?? id) || tombstone.nameKey === nameKey)
      .map((tombstone) => tombstone.deletedAt + 1),
  );
  const preset: TerminalWorkspacePreset = {
    id: existing?.id ?? id,
    name,
    workspace: cloneWorkspace(workspace),
    updatedAt: revision,
  };
  return normalizeStore(
    current.presets.filter((item) => item.id !== preset.id).concat(preset),
    current.tombstones.filter((tombstone) => !(
      (tombstone.id === preset.id || tombstone.nameKey === nameKey)
      && tombstone.deletedAt < revision
    )),
    current.clearedAt,
  );
}

export function removeTerminalWorkspacePreset(
  store: TerminalWorkspacePresetStore,
  id: string,
  nowMs = Date.now(),
): TerminalWorkspacePresetStore {
  const current = requireStore(store, nowMs);
  const normalizedId = validId(id);
  if (!normalizedId) throw new Error("terminal_workspace_preset_invalid");
  const target = current.presets.find((preset) => preset.id === normalizedId);
  if (!target) return current;
  const deletedAt = Math.max(nowMs, target.updatedAt + 1);
  return normalizeStore(
    current.presets.filter((preset) => preset.id !== normalizedId),
    current.tombstones.concat({ id: target.id, nameKey: normalizeNameKey(target.name), deletedAt }),
    current.clearedAt,
  );
}

export function clearTerminalWorkspacePresets(
  store: TerminalWorkspacePresetStore,
  nowMs = Date.now(),
): TerminalWorkspacePresetStore {
  const current = requireStore(store, nowMs);
  if (!validNow(nowMs)) throw new Error("terminal_workspace_preset_invalid");
  const clearedAt = Math.max(
    nowMs,
    current.clearedAt,
    ...current.presets.map((preset) => preset.updatedAt),
    ...current.tombstones.map((tombstone) => tombstone.deletedAt),
  );
  return normalizeStore([], [], clearedAt);
}

function requireStore(value: unknown, nowMs: number) {
  const store = validateStore(value, nowMs);
  if (!store) throw new Error("terminal_workspace_preset_invalid");
  return store;
}

function validateStore(value: unknown, nowMs: number): TerminalWorkspacePresetStore | null {
  if (!validNow(nowMs)) return null;
  const row = record(value);
  if (!row) return null;
  const isLegacyV1 = row.version === 1;
  const isLegacyV2 = row.version === 2;
  if ((!isLegacyV1 && !isLegacyV2 && row.version !== TERMINAL_WORKSPACE_PRESETS_VERSION) || !Array.isArray(row.presets)) return null;
  const rawTombstones = isLegacyV1 ? [] : row.tombstones;
  const clearedAt = isLegacyV1 || isLegacyV2 ? 0 : validRevision(row.clearedAt, nowMs);
  if (clearedAt == null) return null;
  if (!Array.isArray(rawTombstones) || row.presets.length > TERMINAL_WORKSPACE_PRESET_LIMIT || rawTombstones.length > TERMINAL_WORKSPACE_PRESET_TOMBSTONE_LIMIT) return null;
  const presets: TerminalWorkspacePreset[] = [];
  for (const valuePreset of row.presets) {
    const preset = record(valuePreset);
    const id = validId(preset?.id);
    const name = normalizeName(preset?.name);
    const workspace = validateTerminalWorkspace(preset?.workspace);
    const updatedAt = validRevision(preset?.updatedAt, nowMs);
    if (!id || !name || !workspace || updatedAt == null) return null;
    presets.push({ id, name, workspace: cloneWorkspace(workspace), updatedAt });
  }
  const tombstones: TerminalWorkspacePresetTombstone[] = [];
  for (const valueTombstone of rawTombstones) {
    const tombstone = record(valueTombstone);
    const id = validId(tombstone?.id);
    const nameKey = validNameKey(tombstone?.nameKey);
    const deletedAt = validRevision(tombstone?.deletedAt, nowMs);
    if (!id || !nameKey || deletedAt == null) return null;
    tombstones.push({ id, nameKey, deletedAt });
  }
  const normalized = normalizeStore(presets, tombstones, clearedAt);
  if (normalized.presets.length !== presets.length || normalized.tombstones.length !== tombstones.length) return null;
  return normalized;
}

function normalizeStore(
  presetCandidates: readonly TerminalWorkspacePreset[],
  tombstoneCandidates: readonly TerminalWorkspacePresetTombstone[],
  clearedAt = 0,
): TerminalWorkspacePresetStore {
  const tombstonesByIdentity = new Map<string, TerminalWorkspacePresetTombstone>();
  for (const tombstone of tombstoneCandidates) {
    const key = `${tombstone.id}:${tombstone.nameKey}`;
    const current = tombstonesByIdentity.get(key);
    if (!current || tombstone.deletedAt > current.deletedAt) tombstonesByIdentity.set(key, { ...tombstone });
  }
  const tombstones = [...tombstonesByIdentity.values()]
    .filter((tombstone) => clearedAt <= 0 || tombstone.deletedAt > clearedAt)
    .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id))
    .slice(0, TERMINAL_WORKSPACE_PRESET_TOMBSTONE_LIMIT);
  const byId = new Map<string, TerminalWorkspacePreset>();
  for (const candidate of presetCandidates) {
    const current = byId.get(candidate.id);
    if (!current || newerPreset(candidate, current)) byId.set(candidate.id, clonePreset(candidate));
  }
  const byName = new Map<string, TerminalWorkspacePreset>();
  for (const candidate of byId.values()) {
    if (clearedAt > 0 && candidate.updatedAt <= clearedAt) continue;
    const nameKey = normalizeNameKey(candidate.name);
    const deleted = tombstones.some((tombstone) => (
      tombstone.deletedAt >= candidate.updatedAt
      && (tombstone.id === candidate.id || tombstone.nameKey === nameKey)
    ));
    if (deleted) continue;
    const current = byName.get(nameKey);
    if (!current || newerPreset(candidate, current)) byName.set(nameKey, candidate);
  }
  const presets = [...byName.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .slice(0, TERMINAL_WORKSPACE_PRESET_LIMIT);
  return { version: TERMINAL_WORKSPACE_PRESETS_VERSION, presets, tombstones, clearedAt };
}

function newerPreset(left: TerminalWorkspacePreset, right: TerminalWorkspacePreset) {
  return left.updatedAt > right.updatedAt
    || (left.updatedAt === right.updatedAt && presetFingerprint(left) > presetFingerprint(right));
}

function presetFingerprint(preset: TerminalWorkspacePreset) {
  return `${preset.name}:${preset.id}:${JSON.stringify(preset.workspace)}`;
}

function clonePreset(preset: TerminalWorkspacePreset): TerminalWorkspacePreset {
  return { ...preset, workspace: cloneWorkspace(preset.workspace) };
}

function cloneWorkspace(workspace: TerminalWorkspace): TerminalWorkspace {
  return { ...workspace, chartStudies: [...workspace.chartStudies] };
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/gu, " ");
  return name.length > 0 && name.length <= TERMINAL_WORKSPACE_PRESET_NAME_LIMIT ? name : null;
}

function normalizeNameKey(value: string) {
  return value.toLocaleLowerCase();
}

function validNameKey(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = normalizeName(value);
  return normalized && normalized === value && value === value.toLocaleLowerCase() ? value : null;
}

function validId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
}

function validRevision(value: unknown, nowMs: number) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 && revision <= nowMs + FUTURE_TOLERANCE_MS ? revision : null;
}

function validNow(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
