import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalLiveExecutionJournalEntry } from "@/lib/terminal-live-execution-journal";
import {
  exportTerminalLiveExecutionEvidence,
  inspectTerminalLiveExecutionEvidenceExport,
} from "@/lib/terminal-live-execution-export";
import { TerminalLiveExecutionJournal } from "./TerminalLiveExecutionJournal";

describe("TerminalLiveExecutionJournal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains an explicit unknown outcome without implying a fill", () => {
    const onFocusAccount = vi.fn();
    const onReviewEntry = vi.fn();
    act(() => root.render(createElement(TerminalLiveExecutionJournal, { ...evidenceProps(), entries: [entry()], onFocusAccount, onReviewEntry })));
    expect(container.textContent).toContain("outcome unknown");
    expect(container.textContent).toContain("Do not resubmit");
    expect(container.textContent).toContain("0.1 base · GTC @ 100");
    expect(container.textContent).toContain("Ticket evidenceexact");
    expect(container.textContent).toContain("Risk evidenceexact");
    expect(container.textContent).not.toContain("filled");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    const buttons = [...container.querySelectorAll("button")];
    act(() => buttons.find((button) => button.textContent === "Inspect account stream")!.click());
    expect(onFocusAccount).toHaveBeenCalledOnce();
    act(() => buttons.find((button) => button.textContent?.startsWith("Review oldest lock"))!.click());
    expect(onReviewEntry).toHaveBeenCalledWith(entry().planDigest);
  });

  it("keeps live submit visibly locked when persisted safety state is unavailable", () => {
    act(() => root.render(createElement(TerminalLiveExecutionJournal, { ...evidenceProps(), entries: [], onFocusAccount: vi.fn(), storageStatus: "blocked" })));
    expect(container.textContent).toContain("ledger locked");
    expect(container.textContent).toContain("Live submit remains locked");
  });

  it("keeps external review disabled until exact account evidence is current", () => {
    act(() => root.render(createElement(TerminalLiveExecutionJournal, {
      ...evidenceProps(),
      entries: [entry()],
      onFocusAccount: vi.fn(),
      onReviewEntry: vi.fn(),
      reviewBlocker: "Await a fresh post-submit account snapshot.",
    })));
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Review oldest lock"));
    expect(review?.disabled).toBe(true);
    expect(review?.getAttribute("aria-describedby")).toBe("live-execution-review-blocker");
    expect(container.textContent).toContain("Await a fresh post-submit account snapshot");
  });

  it("keeps an older unresolved lock prominent over a newer reconciled row", () => {
    const unknown = entry();
    const reconciled: TerminalLiveExecutionJournalEntry = {
      ...entry(),
      planDigest: `sha256:${"b".repeat(64)}`,
      outcome: "acknowledged",
      status: "reconciled",
      commitment: "run_commitment_123",
      orderId: "venue_order_123",
      recordedAt: "2026-08-13T12:00:01.000Z",
      reason: null,
    };
    const onReviewEntry = vi.fn();
    act(() => root.render(createElement(TerminalLiveExecutionJournal, { ...evidenceProps(), entries: [unknown, reconciled], onFocusAccount: vi.fn(), onReviewEntry })));
    expect(container.textContent).toContain("1 outcome unknown");
    expect(container.textContent).toContain("reconcile every lock");
    expect(container.querySelector("tbody tr")?.textContent).toContain("reconciled");
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Review oldest lock"));
    act(() => review?.click());
    expect(onReviewEntry).toHaveBeenCalledWith(unknown.planDigest);
  });

  it("renders and copies exact recovery evidence without claiming reconciliation", () => {
    const onCopyEvidence = vi.fn();
    act(() => root.render(createElement(TerminalLiveExecutionJournal, {
      ...evidenceProps(),
      entries: [{ ...entry(), commitment: "run_commitment_123" }],
      onFocusAccount: vi.fn(),
      onCopyEvidence,
    })));
    expect(container.textContent).toContain("Recovery dossier");
    expect(container.textContent).toContain(entry().planDigest);
    expect(container.textContent).toContain("Do not resubmit");
    expect(container.textContent).toContain("does not cancel or reconcile anything");
    const copy = [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy dossier");
    act(() => copy?.click());
    expect(onCopyEvidence).toHaveBeenCalledWith("Recovery dossier", expect.stringContaining(`plan_digest=${entry().planDigest}`));
    expect(onCopyEvidence).toHaveBeenCalledWith("Recovery dossier", expect.stringContaining("all_in_loss_usd=0.57"));
  });

  it("exports a verified sanitized bundle and labels the checksum as integrity-only", () => {
    const onExportEvidence = vi.fn();
    act(() => root.render(createElement(TerminalLiveExecutionJournal, {
      ...evidenceProps(),
      entries: [entry()],
      onFocusAccount: vi.fn(),
      onExportEvidence,
    })));
    expect(container.textContent).toContain("not a signature, venue attestation, or fill proof");
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Export evidence");
    act(() => exportButton?.click());
    expect(onExportEvidence).toHaveBeenCalledOnce();
    const [content, filename] = onExportEvidence.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^ghola-live-execution-evidence-.*\.json$/u);
    expect(inspectTerminalLiveExecutionEvidenceExport(content)?.entries).toHaveLength(1);
  });

  it("keeps export disabled when preserved storage is blocked", () => {
    act(() => root.render(createElement(TerminalLiveExecutionJournal, {
      ...evidenceProps(),
      entries: [],
      onFocusAccount: vi.fn(),
      onExportEvidence: vi.fn(),
      storageStatus: "blocked",
    })));
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Export evidence");
    expect(exportButton?.disabled).toBe(true);
  });

  it("verifies a portable evidence file without importing it into the ledger", async () => {
    act(() => root.render(createElement(TerminalLiveExecutionJournal, {
      ...evidenceProps(),
      entries: [entry()],
      onFocusAccount: vi.fn(),
    })));
    const raw = exportTerminalLiveExecutionEvidence({
      entries: [entry()],
      storageStatus: "ready",
      exportedAt: "2026-08-13T12:01:00.000Z",
    });
    const file = new File([raw], "evidence.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(raw) });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Checksum matches · unknown · 1 entry");
    expect(container.textContent).toContain("verification never alters this safety ledger");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});

function evidenceProps() {
  return {
    selectedVenue: "hyperliquid",
    selectedNetwork: "mainnet" as const,
    accountStreamCurrent: true,
    accountStreamObservedAtMs: Date.parse("2026-08-13T12:00:01.000Z"),
  };
}

function entry(): TerminalLiveExecutionJournalEntry {
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
    orderType: "limit",
    timeInForce: "gtc",
    baseSize: "0.1",
    executionReferencePrice: "100",
    riskBudgetUsd: "1",
    stopAndSlippageLossUsd: "0.55",
    roundTripCostLossUsd: "0.02",
    allInLossUsd: "0.57",
    feeBps: 5,
    bufferBps: 5,
    feeEvidenceAt: "2026-08-13T11:59:59.000Z",
    bufferEvidenceAt: "2026-08-13T11:59:59.000Z",
    quoteNotionalUsd: "10",
    limitPrice: "100",
    recordedAt: "2026-08-13T12:00:00.000Z",
    reviewedAt: null,
    reason: "execution_transport_outcome_unknown",
  };
}
