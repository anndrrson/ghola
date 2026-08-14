import type { TradeOrderPlanBindingEnvelope } from "./trade-order-plan";
import type { TerminalExecutionQuality } from "./terminal-execution-quality";

export interface TerminalLiveSubmitReviewSnapshot {
  planDigest: string;
  previewCommitment: string;
  capturedEpoch: number;
  venueId: string;
  network: "mainnet" | "testnet";
  product: string;
  side: "buy" | "sell";
  timeInForce: "gtc" | "ioc" | "fok";
  quoteNotionalUsd: string;
  baseSize: string;
  limitPrice: string;
  invalidationLevel: string;
  maxSlippageBps: number;
  executionReferencePrice: string;
  riskBudgetUsd: string;
  stopAndSlippageLossUsd: string;
  roundTripCostLossUsd: string;
  allInLossUsd: string;
  feeBps: number;
  bufferBps: number;
  feeEvidenceAt: string;
  bufferEvidenceAt: string;
  marketFetchedAt: string;
  marketMaxAgeMs: number;
  issuedAt: string;
  expiresAt: string;
}

export interface TerminalLiveSubmitLiquidityEvidence {
  status: "full" | "partial" | "none" | "unavailable";
  fillPct: number | null;
  filledNotionalUsd: number | null;
  unfilledNotionalUsd: number | null;
  vwap: number | null;
  impactBps: number | null;
  bookAgeMs: number | null;
  currentExecutionReferencePrice: number | null;
  adverseDriftBps: number | null;
}

export type TerminalLiveSubmitReviewBlocker =
  | "review_missing"
  | "preview_changed"
  | "execution_context_changed"
  | "review_expired"
  | "execution_not_ready";

export type TerminalLiveSubmitReviewDecision =
  | { allowed: true; blocker: null }
  | { allowed: false; blocker: TerminalLiveSubmitReviewBlocker };

export function captureTerminalLiveSubmitReview(
  binding: TradeOrderPlanBindingEnvelope,
  capturedEpoch: number,
): TerminalLiveSubmitReviewSnapshot | null {
  const plan = binding.order_plan;
  const risk = plan.risk_envelope;
  const executionReferencePrice = plan.market_context.execution_reference_price;
  if (
    !risk
    || !safeText(binding.plan_digest)
    || !safeText(binding.preview_commitment)
    || !Number.isSafeInteger(capturedEpoch)
    || capturedEpoch < 0
    || !validIso(binding.issued_at)
    || !validIso(binding.expires_at)
    || !validIso(plan.market_context.fetched_at)
    || !Number.isSafeInteger(plan.market_context.max_age_ms)
    || plan.market_context.max_age_ms <= 0
    || Date.parse(binding.expires_at) <= Date.parse(binding.issued_at)
    || !positiveDecimal(plan.quote_notional_usd)
    || !positiveDecimal(plan.base_size)
    || !positiveDecimal(plan.limit_price)
    || !executionReferencePrice
    || !positiveDecimal(executionReferencePrice)
    || !positiveDecimal(risk.risk_budget_usd)
    || !nonnegativeDecimal(risk.stop_and_slippage_loss_usd)
    || !nonnegativeDecimal(risk.round_trip_cost_loss_usd)
    || !nonnegativeDecimal(risk.all_in_loss_usd)
    || !risk.fee_evidence_at
    || !risk.buffer_evidence_at
    || !validIso(risk.fee_evidence_at)
    || !validIso(risk.buffer_evidence_at)
    || !Number.isFinite(plan.max_slippage_bps)
    || !Number.isFinite(risk.fee_bps)
    || !Number.isFinite(risk.buffer_bps)
  ) return null;

  return {
    planDigest: binding.plan_digest,
    previewCommitment: binding.preview_commitment,
    capturedEpoch,
    venueId: plan.venue_id,
    network: plan.network,
    product: plan.product,
    side: plan.side,
    timeInForce: plan.time_in_force,
    quoteNotionalUsd: plan.quote_notional_usd,
    baseSize: plan.base_size,
    limitPrice: plan.limit_price,
    invalidationLevel: plan.stop_intent.stop_level,
    maxSlippageBps: plan.max_slippage_bps,
    executionReferencePrice,
    riskBudgetUsd: risk.risk_budget_usd,
    stopAndSlippageLossUsd: risk.stop_and_slippage_loss_usd,
    roundTripCostLossUsd: risk.round_trip_cost_loss_usd,
    allInLossUsd: risk.all_in_loss_usd,
    feeBps: risk.fee_bps,
    bufferBps: risk.buffer_bps,
    feeEvidenceAt: risk.fee_evidence_at,
    bufferEvidenceAt: risk.buffer_evidence_at,
    marketFetchedAt: plan.market_context.fetched_at,
    marketMaxAgeMs: plan.market_context.max_age_ms,
    issuedAt: binding.issued_at,
    expiresAt: binding.expires_at,
  };
}

export function deriveTerminalLiveSubmitLiquidityEvidence(input: {
  quality: TerminalExecutionQuality;
  bookCertified: boolean;
  bookAgeMs: number | null;
  currentExecutionReferencePrice: number | null;
  boundReferencePrice: number | null;
  side: "buy" | "sell";
}): TerminalLiveSubmitLiquidityEvidence {
  const { quality } = input;
  const bookAgeMs = nonnegative(input.bookAgeMs);
  const currentExecutionReferencePrice = positive(input.currentExecutionReferencePrice);
  const boundReferencePrice = positive(input.boundReferencePrice);
  if (
    !input.bookCertified
    || bookAgeMs == null
    || currentExecutionReferencePrice == null
    || boundReferencePrice == null
    || (input.side !== "buy" && input.side !== "sell")
    || quality.status === "no_market"
  ) {
    return unavailableLiquidity();
  }
  const adverseDriftBps = input.side === "buy"
    ? (currentExecutionReferencePrice - boundReferencePrice) / boundReferencePrice * 10_000
    : (boundReferencePrice - currentExecutionReferencePrice) / boundReferencePrice * 10_000;
  if (!Number.isFinite(adverseDriftBps)) return unavailableLiquidity();
  const fillPct = boundedPercent(quality.fillPct);
  const filledNotionalUsd = nonnegative(quality.filledNotionalUsd);
  const unfilledNotionalUsd = nonnegative(quality.unfilledNotionalUsd);
  if (fillPct == null || filledNotionalUsd == null || unfilledNotionalUsd == null) {
    return unavailableLiquidity();
  }
  if (quality.status === "none") {
    if (fillPct !== 0 || filledNotionalUsd !== 0) return unavailableLiquidity();
    return { status: "none", fillPct, filledNotionalUsd, unfilledNotionalUsd, vwap: null, impactBps: null, bookAgeMs, currentExecutionReferencePrice, adverseDriftBps };
  }
  const vwap = positive(quality.vwap);
  const impactBps = finite(quality.impactBps);
  if (vwap == null || impactBps == null) return unavailableLiquidity();
  if (quality.status === "full" && fillPct < 99.999999) return unavailableLiquidity();
  if (quality.status === "partial" && (fillPct <= 0 || fillPct >= 99.999999)) return unavailableLiquidity();
  return { status: quality.status, fillPct, filledNotionalUsd, unfilledNotionalUsd, vwap, impactBps, bookAgeMs, currentExecutionReferencePrice, adverseDriftBps };
}

export function terminalLiveSubmitReviewDecision(input: {
  review: TerminalLiveSubmitReviewSnapshot | null;
  currentPlanDigest: string | null;
  currentPreviewCommitment: string | null;
  currentEpoch: number;
  executionReady: boolean;
  nowMs?: number;
}): TerminalLiveSubmitReviewDecision {
  if (!input.review) return blocked("review_missing");
  if (
    input.review.planDigest !== input.currentPlanDigest
    || input.review.previewCommitment !== input.currentPreviewCommitment
  ) return blocked("preview_changed");
  if (input.review.capturedEpoch !== input.currentEpoch) return blocked("execution_context_changed");
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || Date.parse(input.review.expiresAt) <= nowMs) return blocked("review_expired");
  if (!input.executionReady) return blocked("execution_not_ready");
  return { allowed: true, blocker: null };
}

export function terminalLiveSubmitReviewBlockerLabel(blocker: TerminalLiveSubmitReviewBlocker): string {
  if (blocker === "preview_changed") return "The bound preview changed. Close this review and inspect the current plan.";
  if (blocker === "execution_context_changed") return "The account, market, or risk context changed. Re-bind and review again.";
  if (blocker === "review_expired") return "This exact review expired. Re-bind from fresh market data.";
  if (blocker === "execution_not_ready") return "A live execution gate is no longer ready. Resolve the blocker before reviewing again.";
  return "Open an exact live-order review before submitting.";
}

function blocked(blocker: TerminalLiveSubmitReviewBlocker): TerminalLiveSubmitReviewDecision {
  return { allowed: false, blocker };
}

function safeText(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

function validIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveDecimal(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function nonnegativeDecimal(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedPercent(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function unavailableLiquidity(): TerminalLiveSubmitLiquidityEvidence {
  return {
    status: "unavailable",
    fillPct: null,
    filledNotionalUsd: null,
    unfilledNotionalUsd: null,
    vwap: null,
    impactBps: null,
    bookAgeMs: null,
    currentExecutionReferencePrice: null,
    adverseDriftBps: null,
  };
}
