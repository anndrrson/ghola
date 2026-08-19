import { describe, expect, it } from "vitest";
import type { TerminalLiveExecutionJournalEntry } from "./terminal-live-execution-journal";
import { deriveTerminalLiveExecutionRecoveryDossier } from "./terminal-live-execution-recovery";

describe("terminal live execution recovery dossier", () => {
  it("proves only exact current post-submit Hyperliquid evidence", () => {
    const dossier = deriveTerminalLiveExecutionRecoveryDossier({
      entry: unresolved(),
      selectedVenue: "hyperliquid",
      selectedNetwork: "mainnet",
      accountStreamCurrent: true,
      accountStreamObservedAtMs: Date.parse("2026-08-13T12:00:01.000Z"),
    });
    expect(dossier).toMatchObject({
      accountContext: "verified",
      accountStream: "current",
      postSubmitSnapshot: "verified",
      providerReference: null,
      ticketEvidence: "exact",
      quantityAuthority: "base",
      riskEvidence: "exact",
    });
    expect(dossier.copyText).toContain(`plan_digest=${unresolved().planDigest}`);
    expect(dossier.copyText).toContain("DO NOT RESUBMIT");
    expect(dossier.copyText).toContain("not cancellation or reconciliation proof");
    expect(dossier.copyText).toContain("BUY · LIMIT · GTC · quote $10 · base 0.1 (authority) · limit 100");
    expect(dossier.copyText).toContain("execution_reference=100");
    expect(dossier.copyText).toContain("all_in_loss_usd=0.57");
    expect(dossier.copyText).toContain("fee_bps_per_side=5");
    expect(dossier.copyText).toContain("fee_evidence_at=2026-08-13T11:59:59.000Z");
  });

  it("fails account evidence closed across network, freshness, and time", () => {
    const base = {
      entry: unresolved(),
      selectedVenue: "hyperliquid",
      selectedNetwork: "mainnet" as const,
      accountStreamCurrent: true,
      accountStreamObservedAtMs: Date.parse("2026-08-13T12:00:01.000Z"),
    };
    expect(deriveTerminalLiveExecutionRecoveryDossier({ ...base, selectedNetwork: "testnet" })).toMatchObject({
      accountContext: "mismatch",
      accountStream: "waiting",
      postSubmitSnapshot: "waiting",
    });
    expect(deriveTerminalLiveExecutionRecoveryDossier({ ...base, accountStreamCurrent: false })).toMatchObject({
      accountStream: "waiting",
      postSubmitSnapshot: "waiting",
    });
    expect(deriveTerminalLiveExecutionRecoveryDossier({ ...base, accountStreamObservedAtMs: Date.parse("2026-08-13T11:59:59.000Z") })).toMatchObject({
      postSubmitSnapshot: "waiting",
    });
  });

  it("labels unsupported terminal account evidence as external without inventing proof", () => {
    const dossier = deriveTerminalLiveExecutionRecoveryDossier({
      entry: { ...unresolved(), venue: "coinbase", orderId: "provider-order-1" },
      selectedVenue: "coinbase",
      selectedNetwork: "mainnet",
      accountStreamCurrent: false,
      accountStreamObservedAtMs: null,
    });
    expect(dossier).toMatchObject({
      accountContext: "external",
      accountStream: "external",
      postSubmitSnapshot: "external",
      providerReference: "provider-order-1",
      providerReferenceKind: "order_id",
      quantityAuthority: "quote",
    });
    expect(dossier.copyText).toContain("account_stream=external");
    expect(deriveTerminalLiveExecutionRecoveryDossier({
      entry: { ...unresolved(), venue: "coinbase", orderId: "provider-order-1" },
      selectedVenue: "hyperliquid",
      selectedNetwork: "mainnet",
      accountStreamCurrent: true,
      accountStreamObservedAtMs: Date.parse("2026-08-13T12:00:01.000Z"),
    })).toMatchObject({
      accountContext: "mismatch",
      accountStream: "waiting",
      postSubmitSnapshot: "waiting",
    });
  });

  it("labels legacy tickets incomplete without inventing missing quantity or TIF", () => {
    const legacy = legacyEntry(unresolved());
    const dossier = deriveTerminalLiveExecutionRecoveryDossier({
      entry: legacy,
      selectedVenue: "hyperliquid",
      selectedNetwork: "mainnet",
      accountStreamCurrent: true,
      accountStreamObservedAtMs: Date.parse("2026-08-13T12:00:01.000Z"),
    });
    expect(dossier.ticketEvidence).toBe("legacy_incomplete");
    expect(dossier.quantityAuthority).toBe("legacy_unknown");
    expect(dossier.riskEvidence).toBe("legacy_incomplete");
    expect(dossier.ticket).toContain("TIF UNKNOWN");
    expect(dossier.ticket).toContain("base unknown");
    expect(dossier.copyText).toContain("Legacy record: recover the full ticket from the bound plan digest");
  });
});

function unresolved(): TerminalLiveExecutionJournalEntry {
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

function legacyEntry(entry: TerminalLiveExecutionJournalEntry): TerminalLiveExecutionJournalEntry {
  const legacy = { ...entry };
  delete legacy.orderType;
  delete legacy.timeInForce;
  delete legacy.baseSize;
  delete legacy.executionReferencePrice;
  delete legacy.riskBudgetUsd;
  delete legacy.stopAndSlippageLossUsd;
  delete legacy.roundTripCostLossUsd;
  delete legacy.allInLossUsd;
  delete legacy.feeBps;
  delete legacy.bufferBps;
  delete legacy.feeEvidenceAt;
  delete legacy.bufferEvidenceAt;
  return legacy;
}
