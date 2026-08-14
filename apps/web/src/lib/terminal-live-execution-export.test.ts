import { describe, expect, it } from "vitest";
import type { TerminalLiveExecutionJournalEntry } from "./terminal-live-execution-journal";
import {
  exportTerminalLiveExecutionEvidence,
  inspectTerminalLiveExecutionEvidenceExport,
  terminalLiveExecutionEvidenceFilename,
} from "./terminal-live-execution-export";

const EXPORTED_AT = "2026-08-13T12:01:00.000Z";

describe("terminal live execution evidence export", () => {
  it("exports a deterministic newest-first sanitized bundle with a verified digest", () => {
    const raw = exportTerminalLiveExecutionEvidence({
      entries: [entry(), entry({ planDigest: `sha256:${"b".repeat(64)}`, status: "reconciled", outcome: "acknowledged", commitment: "run_commitment_2", recordedAt: "2026-08-13T12:00:30.000Z", orderId: "venue_order_2", reason: null })],
      storageStatus: "ready",
      exportedAt: EXPORTED_AT,
    });
    const inspected = inspectTerminalLiveExecutionEvidenceExport(raw);

    expect(inspected).toMatchObject({
      kind: "ghola_live_execution_evidence",
      version: 1,
      exported_at: EXPORTED_AT,
      journal_state: "unknown",
      unresolved_count: 1,
      unknown_count: 1,
      submitted_count: 0,
      primary_unresolved_plan_digest: entry().planDigest,
      latest_plan_digest: `sha256:${"b".repeat(64)}`,
      evidence_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(inspected?.entries.map((item) => item.recordedAt)).toEqual(["2026-08-13T12:00:30.000Z", "2026-08-13T12:00:00.000Z"]);
    expect(raw).not.toMatch(/credential|signature|private_key/iu);
    expect(exportTerminalLiveExecutionEvidence({ entries: inspected!.entries, storageStatus: "ready", exportedAt: EXPORTED_AT })).toBe(raw);
  });

  it("rejects mutation, extra fields, stale export clocks, and unavailable ledgers", () => {
    const raw = exportTerminalLiveExecutionEvidence({ entries: [entry()], storageStatus: "ready", exportedAt: EXPORTED_AT });
    const mutated = JSON.parse(raw) as Record<string, unknown>;
    (mutated.entries as Array<Record<string, unknown>>)[0].limitPrice = "101";
    expect(inspectTerminalLiveExecutionEvidenceExport(JSON.stringify(mutated))).toBeNull();
    expect(inspectTerminalLiveExecutionEvidenceExport(JSON.stringify({ ...JSON.parse(raw), hidden: "payload" }))).toBeNull();
    expect(() => exportTerminalLiveExecutionEvidence({ entries: [entry()], storageStatus: "ready", exportedAt: "2026-08-13T11:59:59.000Z" })).toThrow();
    expect(() => exportTerminalLiveExecutionEvidence({ entries: [entry()], storageStatus: "blocked", exportedAt: EXPORTED_AT })).toThrow();
    expect(() => exportTerminalLiveExecutionEvidence({ entries: [], storageStatus: "ready", exportedAt: EXPORTED_AT })).toThrow();
  });

  it("builds a filesystem-safe deterministic filename", () => {
    expect(terminalLiveExecutionEvidenceFilename(EXPORTED_AT)).toBe("ghola-live-execution-evidence-2026-08-13T12-01-00Z.json");
    expect(terminalLiveExecutionEvidenceFilename("today")).toBeNull();
  });
});

function entry(overrides: Partial<TerminalLiveExecutionJournalEntry> = {}): TerminalLiveExecutionJournalEntry {
  return {
    planDigest: `sha256:${"a".repeat(64)}`,
    outcome: "unknown",
    status: "unknown",
    commitment: null,
    orderId: null,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    quoteNotionalUsd: "10",
    limitPrice: "100",
    recordedAt: "2026-08-13T12:00:00.000Z",
    reviewedAt: null,
    reason: "execution_transport_outcome_unknown",
    ...overrides,
  };
}
