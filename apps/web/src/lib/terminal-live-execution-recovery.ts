import type { TerminalLiveExecutionJournalEntry } from "./terminal-live-execution-journal";

export interface TerminalLiveExecutionRecoveryDossier {
  planDigest: string;
  identity: string;
  submittedAt: string;
  ticket: string;
  ticketEvidence: "exact" | "legacy_incomplete";
  quantityAuthority: "quote" | "base" | "unknown" | "legacy_unknown";
  riskEvidence: "exact" | "legacy_incomplete";
  riskSummary: string;
  transport: string;
  providerReference: string | null;
  providerReferenceKind: "order_id" | "commitment" | null;
  accountContext: "verified" | "mismatch" | "external";
  accountStream: "current" | "waiting" | "external";
  postSubmitSnapshot: "verified" | "waiting" | "external";
  copyText: string;
}

export function deriveTerminalLiveExecutionRecoveryDossier(input: {
  entry: TerminalLiveExecutionJournalEntry;
  selectedVenue: string;
  selectedNetwork: "mainnet" | "testnet";
  accountStreamCurrent: boolean;
  accountStreamObservedAtMs: number | null;
}): TerminalLiveExecutionRecoveryDossier {
  const { entry } = input;
  const hyperliquid = entry.venue === "hyperliquid";
  const contextMatches = input.selectedVenue === entry.venue
    && input.selectedNetwork === entry.network;
  const submittedAtMs = Date.parse(entry.recordedAt);
  const snapshotAfterSubmit = contextMatches
    && input.accountStreamCurrent
    && input.accountStreamObservedAtMs != null
    && Number.isFinite(input.accountStreamObservedAtMs)
    && input.accountStreamObservedAtMs >= submittedAtMs;
  const providerReference = entry.orderId ?? entry.commitment;
  const providerReferenceKind = entry.orderId
    ? "order_id" as const
    : entry.commitment
      ? "commitment" as const
      : null;
  const identity = `${entry.venue}:${entry.network}:${entry.product}`;
  const ticketEvidence = entry.orderType && entry.timeInForce && entry.baseSize
    ? "exact" as const
    : "legacy_incomplete" as const;
  const quantityAuthority = ticketEvidence === "legacy_incomplete"
    ? "legacy_unknown" as const
    : entry.venue === "coinbase"
      ? "quote" as const
      : entry.venue === "hyperliquid"
        ? "base" as const
        : "unknown" as const;
  const riskEvidence = entry.riskBudgetUsd
    && entry.stopAndSlippageLossUsd
    && entry.roundTripCostLossUsd != null
    && entry.allInLossUsd
    && entry.feeBps != null
    && entry.bufferBps != null
    && entry.feeEvidenceAt
    && entry.bufferEvidenceAt
    ? "exact" as const
    : "legacy_incomplete" as const;
  const riskSummary = riskEvidence === "exact"
    ? `all-in $${entry.allInLossUsd} / budget $${entry.riskBudgetUsd} · stop+slip $${entry.stopAndSlippageLossUsd} · costs $${entry.roundTripCostLossUsd} (${entry.feeBps}+${entry.bufferBps} bps/side) · evidence ${entry.feeEvidenceAt}/${entry.bufferEvidenceAt}`
    : "legacy risk evidence unavailable";
  const ticket = [
    entry.side.toUpperCase(),
    entry.orderType?.toUpperCase() ?? "ORDER",
    entry.timeInForce?.toUpperCase() ?? "TIF UNKNOWN",
    `quote $${entry.quoteNotionalUsd}${quantityAuthority === "quote" ? " (authority)" : ""}`,
    entry.baseSize ? `base ${entry.baseSize}${quantityAuthority === "base" ? " (authority)" : ""}` : "base unknown",
    `limit ${entry.limitPrice}`,
  ].join(" · ");
  const transport = entry.reason ?? entry.status;
  const lines = [
    "GHOLA LIVE EXECUTION RECOVERY DOSSIER",
    `plan_digest=${entry.planDigest}`,
    `identity=${identity}`,
    `submitted_at=${entry.recordedAt}`,
    `ticket=${ticket}`,
    `ticket_evidence=${ticketEvidence}`,
    `quantity_authority=${quantityAuthority}`,
    `execution_reference=${entry.executionReferencePrice ?? "legacy_missing"}`,
    `risk_evidence=${riskEvidence}`,
    `risk_budget_usd=${entry.riskBudgetUsd ?? "legacy_missing"}`,
    `stop_and_slippage_loss_usd=${entry.stopAndSlippageLossUsd ?? "legacy_missing"}`,
    `round_trip_cost_loss_usd=${entry.roundTripCostLossUsd ?? "legacy_missing"}`,
    `all_in_loss_usd=${entry.allInLossUsd ?? "legacy_missing"}`,
    `fee_bps_per_side=${entry.feeBps ?? "legacy_missing"}`,
    `buffer_bps_per_side=${entry.bufferBps ?? "legacy_missing"}`,
    `fee_evidence_at=${entry.feeEvidenceAt ?? "legacy_missing"}`,
    `buffer_evidence_at=${entry.bufferEvidenceAt ?? "legacy_missing"}`,
    `transport=${transport}`,
    `provider_reference=${providerReference ?? "missing"}`,
    `account_context=${contextMatches ? (hyperliquid ? "verified" : "external") : "mismatch"}`,
    `account_stream=${contextMatches ? (hyperliquid ? (input.accountStreamCurrent ? "current" : "waiting") : "external") : "waiting"}`,
    `post_submit_snapshot=${contextMatches ? (hyperliquid ? (snapshotAfterSubmit ? "verified" : "waiting") : "external") : "waiting"}`,
    `instruction=DO NOT RESUBMIT. ${ticketEvidence === "exact" ? "Match every ticket field" : "Legacy record: recover the full ticket from the bound plan digest"} against the exact venue/network account's open orders and fills. This dossier is not cancellation or reconciliation proof.`,
  ];
  return {
    planDigest: entry.planDigest,
    identity,
    submittedAt: entry.recordedAt,
    ticket,
    ticketEvidence,
    quantityAuthority,
    riskEvidence,
    riskSummary,
    transport,
    providerReference,
    providerReferenceKind,
    accountContext: contextMatches ? (hyperliquid ? "verified" : "external") : "mismatch",
    accountStream: contextMatches ? (hyperliquid ? (input.accountStreamCurrent ? "current" : "waiting") : "external") : "waiting",
    postSubmitSnapshot: contextMatches ? (hyperliquid ? (snapshotAfterSubmit ? "verified" : "waiting") : "external") : "waiting",
    copyText: lines.join("\n"),
  };
}
