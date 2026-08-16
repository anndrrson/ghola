"use client";

import { memo, useRef, useState, type ChangeEvent } from "react";
import {
  exportTerminalLiveExecutionEvidence,
  inspectTerminalLiveExecutionEvidenceExport,
  TERMINAL_LIVE_EXECUTION_EXPORT_MAX_BYTES,
  terminalLiveExecutionEvidenceFilename,
} from "@/lib/terminal-live-execution-export";
import {
  TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT,
  terminalLiveExecutionJournalSummary,
  type TerminalLiveExecutionJournalEntry,
} from "@/lib/terminal-live-execution-journal";
import { deriveTerminalLiveExecutionRecoveryDossier } from "@/lib/terminal-live-execution-recovery";

export const TerminalLiveExecutionJournal = memo(function TerminalLiveExecutionJournal({
  entries,
  onFocusAccount,
  onReviewEntry,
  reviewBlocker = null,
  storageStatus = "ready",
  selectedVenue,
  selectedNetwork,
  accountStreamCurrent,
  accountStreamObservedAtMs,
  onCopyEvidence,
  onExportEvidence,
}: {
  entries: readonly TerminalLiveExecutionJournalEntry[];
  onFocusAccount: () => void;
  onReviewEntry?: (planDigest: string) => void;
  reviewBlocker?: string | null;
  storageStatus?: "loading" | "ready" | "blocked";
  selectedVenue: string;
  selectedNetwork: "mainnet" | "testnet";
  accountStreamCurrent: boolean;
  accountStreamObservedAtMs: number | null;
  onCopyEvidence?: (label: string, value: string) => void;
  onExportEvidence?: (content: string, filename: string) => void;
}) {
  const evidenceInspectionRequestRef = useRef(0);
  const [evidenceInspection, setEvidenceInspection] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "verified"; message: string }
    | { status: "invalid"; message: string }
  >({ status: "idle" });
  const summary = terminalLiveExecutionJournalSummary(storageStatus, entries);
  const latest = summary.latest;
  const unresolved = summary.primaryUnresolved;
  const dossier = unresolved ? deriveTerminalLiveExecutionRecoveryDossier({
    entry: unresolved,
    selectedVenue,
    selectedNetwork,
    accountStreamCurrent,
    accountStreamObservedAtMs,
  }) : null;
  if (!latest && summary.state === "empty") return null;
  const blocked = summary.state === "blocked";
  const unknown = summary.state === "unknown";
  const exportEvidence = () => {
    if (!onExportEvidence) return;
    const exportedAt = new Date().toISOString();
    const filename = terminalLiveExecutionEvidenceFilename(exportedAt);
    if (!filename) return;
    try {
      onExportEvidence(exportTerminalLiveExecutionEvidence({ entries: summary.orderedEntries, storageStatus, exportedAt }), filename);
    } catch {
      // The button is fail-closed below; malformed in-memory evidence is never exported.
    }
  };
  const inspectEvidenceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const requestId = evidenceInspectionRequestRef.current + 1;
    evidenceInspectionRequestRef.current = requestId;
    if (file.size <= 0 || file.size > TERMINAL_LIVE_EXECUTION_EXPORT_MAX_BYTES) {
      setEvidenceInspection({ status: "invalid", message: "Evidence file rejected: empty or larger than the 100 KB safety limit." });
      return;
    }
    setEvidenceInspection({ status: "loading" });
    try {
      const inspected = inspectTerminalLiveExecutionEvidenceExport(await file.text());
      if (evidenceInspectionRequestRef.current !== requestId) return;
      setEvidenceInspection(inspected
        ? {
            status: "verified",
            message: `Checksum matches · ${inspected.journal_state.replaceAll("_", " ")} · ${inspected.entries.length} entr${inspected.entries.length === 1 ? "y" : "ies"} · exported ${inspected.exported_at}`,
          }
        : { status: "invalid", message: "Evidence file failed strict schema, ordering, timestamp, or checksum validation." });
    } catch {
      if (evidenceInspectionRequestRef.current === requestId) {
        setEvidenceInspection({ status: "invalid", message: "Evidence file could not be read or validated." });
      }
    }
  };
  return (
    <section id="live-execution-journal" tabIndex={-1} aria-labelledby="live-execution-journal-heading" className="mb-4 overflow-hidden rounded-md border border-[#182234] bg-[#080c13] outline-none focus-visible:ring-1 focus-visible:ring-sky-300/60">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div>
          <h2 id="live-execution-journal-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Live execution journal</h2>
          <p className="mt-1 text-[9px] leading-4 text-[#66738c]">Browser-local, account-scoped acknowledgements; no credentials, signatures, or fill assumptions.</p>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${summaryTone(summary.state)}`}>
          {summaryLabel(summary)}
        </span>
      </div>
      <p role={blocked || unknown ? "alert" : "status"} className={`border-t px-3 py-2 text-[9px] leading-4 ${blocked || unknown ? "border-rose-300/15 bg-rose-300/[0.03] text-rose-100" : "border-amber-300/15 bg-amber-300/[0.03] text-amber-100"}`}>
        {blocked
          ? "The local execution safety ledger is unavailable or invalid. Live submit remains locked; existing storage is preserved."
          : summary.state === "loading"
            ? "Restoring the local execution safety ledger before live submit can be evaluated."
          : unknown
          ? `${summary.unknownCount} dispatched plan outcome${summary.unknownCount === 1 ? " is" : "s are"} unknown${summary.submittedCount ? `; ${summary.submittedCount} additional acknowledged submission${summary.submittedCount === 1 ? " remains" : "s remain"} unresolved` : ""}. Do not resubmit; reconcile every lock against the account stream.`
          : summary.state === "submitted"
            ? `${summary.submittedCount} acknowledged submission${summary.submittedCount === 1 ? " remains" : "s remain"} unreconciled. Open-order and fill state are unverified.`
          : summary.state === "reconciled"
            ? "Gateway reconciliation is recorded; the account stream remains authoritative for actual order and fill state."
            : summary.state === "externally_reviewed"
              ? "External account review was recorded locally. This is not gateway or venue reconciliation."
              : "No live execution acknowledgement is recorded."}
      </p>
      {summary.orderedEntries.length ? <div className="overflow-x-auto border-t border-[#141d2e]">
        <table className="w-full min-w-[42rem] table-fixed font-mono text-[8px] tabular-nums">
          <caption className="sr-only">Recent sanitized live execution outcomes</caption>
          <thead className="text-[#566278]">
            <tr>
              {['Time', 'Plan', 'Market', 'Side', 'Ticket', 'Outcome', 'Reference'].map((header) => <th key={header} scope="col" className="px-2 py-1.5 text-left first:pl-3">{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {summary.orderedEntries.map((entry) => (
              <tr key={entry.planDigest} className="border-t border-[#101827] text-[#aeb9cb]">
                <td className="px-2 py-2 first:pl-3">{utcTime(entry.recordedAt)}</td>
                <td className="px-2 py-2" title={entry.planDigest}>{short(entry.planDigest)}</td>
                <td className="px-2 py-2">{entry.product}<span className="block text-[#566278]">{entry.venue} · {entry.network}</span></td>
                <td className={entry.side === "buy" ? "px-2 py-2 text-emerald-300" : "px-2 py-2 text-rose-300"}>{entry.side.toUpperCase()}</td>
                <td className="px-2 py-2">${entry.quoteNotionalUsd}<span className="block text-[#566278]">{entry.baseSize ? `${entry.baseSize} base · ` : ""}{entry.timeInForce?.toUpperCase() ?? "legacy TIF"} @ {entry.limitPrice}</span></td>
                <td className={entry.outcome === "unknown" ? "px-2 py-2 text-rose-300" : entry.status === "reconciled" || entry.status === "externally_reviewed" ? "px-2 py-2 text-emerald-300" : "px-2 py-2 text-amber-200"}>{entry.status.replaceAll("_", " ")}</td>
                <td className="px-2 py-2" title={[entry.orderId, entry.commitment, entry.reason].filter(Boolean).join(" · ") || undefined}>{entry.orderId ? short(entry.orderId) : entry.commitment ? short(entry.commitment) : entry.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
      {dossier ? (
        <details open className="border-t border-[#141d2e] bg-[#070b12]">
          <summary className="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-100">Recovery dossier · oldest unresolved</summary>
          <div className="grid gap-px border-t border-[#141d2e] bg-[#141d2e] sm:grid-cols-2 lg:grid-cols-4">
            <Evidence label="Account context" value={dossier.accountContext} />
            <Evidence label="Account stream" value={dossier.accountStream} />
            <Evidence label="Post-submit snapshot" value={dossier.postSubmitSnapshot} />
            <Evidence label="Venue reference" value={dossier.providerReferenceKind === "order_id" ? "order id" : dossier.providerReferenceKind ?? "missing"} />
            <Evidence label="Ticket evidence" value={dossier.ticketEvidence === "exact" ? "exact" : "legacy"} />
            <Evidence label="Size authority" value={dossier.quantityAuthority} />
            <Evidence label="Risk evidence" value={dossier.riskEvidence === "exact" ? "exact" : "legacy"} />
          </div>
          <dl className="grid gap-x-4 gap-y-2 border-t border-[#141d2e] px-3 py-2 font-mono text-[8px] sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="text-[#566278]">Plan digest</dt><dd className="break-all text-[#aeb9cb]">{dossier.planDigest}</dd>
            <dt className="text-[#566278]">Identity</dt><dd className="break-all text-[#aeb9cb]">{dossier.identity}</dd>
            <dt className="text-[#566278]">Submitted</dt><dd className="break-all text-[#aeb9cb]">{dossier.submittedAt}</dd>
            <dt className="text-[#566278]">Ticket</dt><dd className="break-all text-[#aeb9cb]">{dossier.ticket}</dd>
            <dt className="text-[#566278]">Risk envelope</dt><dd className="break-all text-[#aeb9cb]">{dossier.riskSummary}</dd>
            <dt className="text-[#566278]">Transport</dt><dd className="break-all text-[#aeb9cb]">{dossier.transport}</dd>
            <dt className="text-[#566278]">Provider ref</dt><dd className="break-all text-[#aeb9cb]">{dossier.providerReference ?? "Not captured"}</dd>
          </dl>
          <p className="border-t border-rose-300/15 bg-rose-300/[0.03] px-3 py-2 text-[8px] leading-3 text-rose-100">Do not resubmit. Match the exact venue, network, market, side, size, price, and time against open orders and fills. Copying or reviewing this dossier does not cancel or reconcile anything.</p>
          {onCopyEvidence ? <div className="flex flex-wrap gap-2 border-t border-[#141d2e] px-3 py-2">
            <button type="button" onClick={() => onCopyEvidence("Recovery dossier", dossier.copyText)} className="term-chip h-7 px-2 text-[9px]">Copy dossier</button>
            <button type="button" onClick={() => onCopyEvidence("Plan digest", dossier.planDigest)} className="term-chip h-7 px-2 text-[9px]">Copy plan digest</button>
            {dossier.providerReference ? <button type="button" onClick={() => onCopyEvidence("Provider reference", dossier.providerReference as string)} className="term-chip h-7 px-2 text-[9px]">Copy provider ref</button> : null}
          </div> : null}
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#141d2e] px-3 py-2">
        <span className="text-[8px] text-[#566278]">Newest first · {summary.orderedEntries.length}/{TERMINAL_LIVE_EXECUTION_JOURNAL_LIMIT} local safety entries</span>
        <div className="flex flex-wrap gap-2">
          {onExportEvidence ? <button type="button" disabled={storageStatus !== "ready" || summary.orderedEntries.length === 0} onClick={exportEvidence} className="term-chip h-7 px-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-50">Export evidence</button> : null}
          <label className="term-chip flex h-7 cursor-pointer items-center px-2 text-[9px]">
            Verify evidence file
            <input type="file" accept=".json,application/json" onChange={inspectEvidenceFile} className="sr-only" aria-describedby="live-execution-evidence-verifier-note" />
          </label>
          <button type="button" onClick={onFocusAccount} className="term-chip h-7 px-2 text-[9px]">Inspect account stream</button>
          {unresolved && onReviewEntry && storageStatus === "ready" ? <button type="button" disabled={reviewBlocker != null} aria-describedby={reviewBlocker ? "live-execution-review-blocker" : undefined} onClick={() => onReviewEntry(unresolved.planDigest)} className="term-chip h-7 px-2 text-[9px] disabled:cursor-not-allowed disabled:opacity-50">Review oldest lock · {short(unresolved.planDigest)}</button> : null}
        </div>
      </div>
      <p id="live-execution-evidence-verifier-note" className="border-t border-[#141d2e] px-3 py-2 text-[8px] leading-3 text-[#66738c]">Export and verification are browser-local and read only. A matching SHA-256 checksum detects changes; it is not a signature, venue attestation, or fill proof, and verification never alters this safety ledger.</p>
      {evidenceInspection.status !== "idle" ? <p role={evidenceInspection.status === "invalid" ? "alert" : "status"} className={`border-t px-3 py-2 font-mono text-[8px] leading-3 ${evidenceInspection.status === "invalid" ? "border-rose-300/15 bg-rose-300/[0.03] text-rose-100" : evidenceInspection.status === "verified" ? "border-emerald-300/15 bg-emerald-300/[0.03] text-emerald-100" : "border-amber-300/15 bg-amber-300/[0.03] text-amber-100"}`}>
        {evidenceInspection.status === "loading" ? "Reading evidence file locally…" : evidenceInspection.message}
      </p> : null}
      {unresolved && onReviewEntry && storageStatus === "ready" ? <p className="border-t border-[#141d2e] px-3 py-2 text-[8px] leading-3 text-[#66738c]">Unlock only after checking the venue account’s orders and fills. External review is recorded locally and never labeled reconciliation.</p> : null}
      {unresolved && reviewBlocker ? <p id="live-execution-review-blocker" className="border-t border-amber-300/15 bg-amber-300/[0.03] px-3 py-2 text-[8px] leading-3 text-amber-100" role="status">{reviewBlocker}</p> : null}
    </section>
  );
});

function Evidence({ label, value }: { label: string; value: "verified" | "current" | "mismatch" | "waiting" | "external" | "order id" | "commitment" | "missing" | "exact" | "legacy" | "quote" | "base" | "unknown" | "legacy_unknown" }) {
  const pass = value === "verified" || value === "current" || value === "order id" || value === "commitment" || value === "exact" || value === "quote" || value === "base";
  const neutral = value === "external";
  return <div className="bg-[#080c13] px-3 py-2"><span className="block text-[7px] uppercase tracking-[0.1em] text-[#566278]">{label}</span><span className={`mt-0.5 block font-mono text-[8px] uppercase ${pass ? "text-emerald-200" : neutral ? "text-amber-100" : "text-rose-200"}`}>{value}</span></div>;
}

function short(value: string) { return value.length > 18 ? `${value.slice(0, 18)}…` : value; }
function utcTime(value: string) { return `${value.slice(11, 19)}Z`; }
function summaryLabel(summary: ReturnType<typeof terminalLiveExecutionJournalSummary>) {
  if (summary.state === "blocked") return "ledger locked";
  if (summary.state === "loading") return "restoring";
  if (summary.state === "unknown") return `${summary.unknownCount} outcome unknown`;
  if (summary.state === "submitted") return `${summary.submittedCount} pending reconciliation`;
  if (summary.state === "reconciled") return "reconciled";
  if (summary.state === "externally_reviewed") return "externally reviewed";
  return "empty";
}
function summaryTone(state: ReturnType<typeof terminalLiveExecutionJournalSummary>["state"]) {
  if (state === "blocked" || state === "unknown") return "border-rose-300/35 bg-rose-300/10 text-rose-200";
  if (state === "reconciled" || state === "externally_reviewed") return "border-emerald-300/35 bg-emerald-300/10 text-emerald-200";
  return "border-amber-300/35 bg-amber-300/10 text-amber-100";
}
