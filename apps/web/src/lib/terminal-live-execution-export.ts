import { sha256 } from "@noble/hashes/sha256";
import {
  parseTerminalLiveExecutionJournal,
  serializeTerminalLiveExecutionJournal,
  terminalLiveExecutionJournalSummary,
  type TerminalLiveExecutionJournalEntry,
} from "./terminal-live-execution-journal";

export const TERMINAL_LIVE_EXECUTION_EXPORT_VERSION = 1 as const;
export const TERMINAL_LIVE_EXECUTION_EXPORT_KIND = "ghola_live_execution_evidence" as const;
export const TERMINAL_LIVE_EXECUTION_EXPORT_MAX_BYTES = 100_000;

export interface TerminalLiveExecutionEvidenceExport {
  kind: typeof TERMINAL_LIVE_EXECUTION_EXPORT_KIND;
  version: typeof TERMINAL_LIVE_EXECUTION_EXPORT_VERSION;
  exported_at: string;
  storage_status: "ready";
  journal_state: "unknown" | "submitted" | "reconciled" | "externally_reviewed";
  unresolved_count: number;
  unknown_count: number;
  submitted_count: number;
  primary_unresolved_plan_digest: string | null;
  latest_plan_digest: string;
  entries: TerminalLiveExecutionJournalEntry[];
  evidence_digest: string;
}

type EvidenceBody = Omit<TerminalLiveExecutionEvidenceExport, "evidence_digest">;

const EXPORT_KEYS = [
  "kind",
  "version",
  "exported_at",
  "storage_status",
  "journal_state",
  "unresolved_count",
  "unknown_count",
  "submitted_count",
  "primary_unresolved_plan_digest",
  "latest_plan_digest",
  "entries",
  "evidence_digest",
] as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function exportTerminalLiveExecutionEvidence(input: {
  entries: readonly TerminalLiveExecutionJournalEntry[];
  storageStatus: "loading" | "ready" | "blocked";
  exportedAt?: string;
}): string {
  if (input.storageStatus !== "ready" || input.entries.length === 0) {
    throw new Error("terminal_live_execution_evidence_unavailable");
  }
  // Reuse the journal's strict current-version validator before exporting.
  const validated = parseTerminalLiveExecutionJournal(serializeTerminalLiveExecutionJournal(input.entries));
  const exportedAt = canonicalIso(input.exportedAt ?? new Date().toISOString());
  if (!validated || !exportedAt || exportedBeforeEvidence(exportedAt, validated)) {
    throw new Error("terminal_live_execution_evidence_invalid");
  }
  const summary = terminalLiveExecutionJournalSummary("ready", validated);
  if (!summary.latest || summary.state === "empty" || summary.state === "loading" || summary.state === "blocked") {
    throw new Error("terminal_live_execution_evidence_invalid");
  }
  const body: EvidenceBody = {
    kind: TERMINAL_LIVE_EXECUTION_EXPORT_KIND,
    version: TERMINAL_LIVE_EXECUTION_EXPORT_VERSION,
    exported_at: exportedAt,
    storage_status: "ready",
    journal_state: summary.state,
    unresolved_count: summary.unresolvedCount,
    unknown_count: summary.unknownCount,
    submitted_count: summary.submittedCount,
    primary_unresolved_plan_digest: summary.primaryUnresolved?.planDigest ?? null,
    latest_plan_digest: summary.latest.planDigest,
    entries: summary.orderedEntries.map((entry) => ({ ...entry })),
  };
  return JSON.stringify({ ...body, evidence_digest: digestBody(body) }, null, 2);
}

export function inspectTerminalLiveExecutionEvidenceExport(
  raw: string | null | undefined,
): TerminalLiveExecutionEvidenceExport | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > TERMINAL_LIVE_EXECUTION_EXPORT_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const row = record(value);
  if (!row || !exactKeys(row, EXPORT_KEYS)) return null;
  if (
    row.kind !== TERMINAL_LIVE_EXECUTION_EXPORT_KIND
    || row.version !== TERMINAL_LIVE_EXECUTION_EXPORT_VERSION
    || row.storage_status !== "ready"
    || typeof row.evidence_digest !== "string"
    || !DIGEST.test(row.evidence_digest)
    || !Array.isArray(row.entries)
  ) return null;
  const exportedAt = canonicalIso(row.exported_at);
  const entries = parseTerminalLiveExecutionJournal(JSON.stringify({ version: 1, entries: row.entries }));
  if (!exportedAt || !entries || entries.length === 0 || exportedBeforeEvidence(exportedAt, entries)) return null;
  const summary = terminalLiveExecutionJournalSummary("ready", entries);
  if (!summary.latest || summary.state === "empty" || summary.state === "loading" || summary.state === "blocked") return null;
  const body: EvidenceBody = {
    kind: TERMINAL_LIVE_EXECUTION_EXPORT_KIND,
    version: TERMINAL_LIVE_EXECUTION_EXPORT_VERSION,
    exported_at: exportedAt,
    storage_status: "ready",
    journal_state: summary.state,
    unresolved_count: summary.unresolvedCount,
    unknown_count: summary.unknownCount,
    submitted_count: summary.submittedCount,
    primary_unresolved_plan_digest: summary.primaryUnresolved?.planDigest ?? null,
    latest_plan_digest: summary.latest.planDigest,
    entries: summary.orderedEntries.map((entry) => ({ ...entry })),
  };
  if (
    row.journal_state !== body.journal_state
    || row.unresolved_count !== body.unresolved_count
    || row.unknown_count !== body.unknown_count
    || row.submitted_count !== body.submitted_count
    || row.primary_unresolved_plan_digest !== body.primary_unresolved_plan_digest
    || row.latest_plan_digest !== body.latest_plan_digest
    || JSON.stringify(row.entries) !== JSON.stringify(body.entries)
    || row.evidence_digest !== digestBody(body)
  ) return null;
  return { ...body, evidence_digest: row.evidence_digest };
}

export function terminalLiveExecutionEvidenceFilename(exportedAt: string): string | null {
  const canonical = canonicalIso(exportedAt);
  return canonical
    ? `ghola-live-execution-evidence-${canonical.replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z")}.json`
    : null;
}

function digestBody(body: EvidenceBody) {
  return `sha256:${hex(sha256(new TextEncoder().encode(JSON.stringify(body))))}`;
}

function exportedBeforeEvidence(exportedAt: string, entries: readonly TerminalLiveExecutionJournalEntry[]) {
  const exportedAtMs = Date.parse(exportedAt);
  return entries.some((entry) => {
    const evidenceAt = Math.max(Date.parse(entry.recordedAt), entry.reviewedAt ? Date.parse(entry.reviewedAt) : 0);
    return !Number.isFinite(evidenceAt) || evidenceAt > exportedAtMs;
  });
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
