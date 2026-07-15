import { createHash } from "node:crypto";

export const CONSUMER_TERMS_VERSION = "consumer-mainnet-v1";
export const CONSUMER_RISK_VERSION = "consumer-real-funds-v1";
export const CONSUMER_FEE_BPS = 10;
export const CONSUMER_MIN_FEE_MICRO_USDC = 50_000;
export const CONSUMER_MAX_SLIPPAGE_BPS = 100;
export const CONSUMER_WAKE_LIMIT = 3;
export const CONSUMER_WAKE_WINDOW_MS = 10 * 60_000;
export const CONSUMER_RECONCILIATION_MAX_AGE_MS = 60_000;
export const CONSUMER_MARKET_DATA_MAX_AGE_MS = 10_000;

export type ConsumerFundingRail = "solana_usdc" | "solana_shielded_usdcx";
export type ConsumerLedgerKind =
  | "deposit_credit"
  | "order_reservation"
  | "reservation_release"
  | "fill_settlement"
  | "fee_settlement"
  | "pnl_settlement"
  | "withdrawal_debit"
  | "operator_adjustment";

export type ConsumerLedgerAccount =
  | "treasury_usdc"
  | "consumer_available"
  | "consumer_reserved"
  | "venue_clearing"
  | "fee_revenue"
  | "realized_pnl";

export interface ConsumerLedgerPosting {
  account: ConsumerLedgerAccount;
  side: "debit" | "credit";
  amount_micro_usdc: number;
}

export interface ConsumerLedgerTransaction {
  version: 1;
  transaction_id: string;
  owner_commitment: string;
  account_commitment: string;
  idempotency_key: string;
  kind: ConsumerLedgerKind;
  reference_commitment: string | null;
  postings: ConsumerLedgerPosting[];
  created_at: string;
}

export interface ConsumerBalanceSnapshot {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  available_micro_usdc: number;
  reserved_micro_usdc: number;
  open_notional_micro_usdc: number;
  realized_pnl_micro_usdc: number;
  updated_at: string | null;
}

export interface ConsumerRiskPolicy {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  max_order_micro_usdc: number;
  max_daily_notional_micro_usdc: number;
  max_position_micro_usdc: number;
  max_slippage_bps: number;
  market_allowlist: string[];
  updated_at: string;
}

export type ConsumerCircuitReason =
  | "negative_balance"
  | "duplicate_settlement"
  | "nonce_or_idempotency_violation"
  | "reconciliation_drift"
  | "insufficient_treasury_buffer"
  | "market_data_stale"
  | "reconciliation_stale"
  | "execution_failure_rate"
  | "worker_attestation_missing"
  | "venue_unavailable"
  | "operator_halt";

export interface ConsumerCircuitState {
  version: 1;
  status: "open" | "halted";
  reasons: ConsumerCircuitReason[];
  halted_at: string | null;
  resumed_at: string | null;
  acknowledged_by: string | null;
  consecutive_green_canaries: number;
  updated_at: string;
}

export interface ConsumerCircuitTelemetry {
  negative_balance_detected: boolean;
  duplicate_settlement_detected: boolean;
  nonce_or_idempotency_violation: boolean;
  reconciliation_drift_micro_usdc: number;
  pooled_treasury_micro_usdc: number;
  treasury_free_micro_usdc: number;
  reserved_exposure_micro_usdc: number;
  market_data_age_ms: number;
  reconciliation_age_ms: number;
  consecutive_failures: number;
  failure_rate_5m: number;
  worker_attested: boolean;
  venue_available: boolean;
}

export function consumerFeeMicroUsdc(notionalMicroUsdc: number): number {
  const notional = positiveInteger(notionalMicroUsdc, "notional_micro_usdc");
  return Math.max(CONSUMER_MIN_FEE_MICRO_USDC, Math.ceil((notional * CONSUMER_FEE_BPS) / 10_000));
}

export function consumerRolloutEligible(
  ownerCommitment: string,
  env: Record<string, string | undefined> = process.env,
): { eligible: boolean; rollout_percent: number; bucket: number | null; canary: boolean } {
  const canaries = new Set((env.GHOLA_CONSUMER_CANARY_COMMITMENTS || "").split(",").map((value) => value.trim()).filter(Boolean));
  if (canaries.has(ownerCommitment)) return { eligible: true, rollout_percent: rolloutPercent(env), bucket: null, canary: true };
  const percent = rolloutPercent(env);
  const digest = createHash("sha256").update(`ghola-consumer-rollout-v1:${ownerCommitment}`).digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  return { eligible: bucket < percent, rollout_percent: percent, bucket, canary: false };
}

function rolloutPercent(env: Record<string, string | undefined>): number {
  const value = Number.parseInt(env.GHOLA_CONSUMER_ROLLOUT_PERCENT || "0", 10);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

export function validateConsumerRiskPolicy(
  input: Omit<ConsumerRiskPolicy, "version" | "updated_at">,
  availableMicroUsdc?: number,
): Omit<ConsumerRiskPolicy, "version" | "updated_at"> {
  const maxOrder = positiveInteger(input.max_order_micro_usdc, "max_order_micro_usdc");
  const maxDaily = positiveInteger(input.max_daily_notional_micro_usdc, "max_daily_notional_micro_usdc");
  const maxPosition = positiveInteger(input.max_position_micro_usdc, "max_position_micro_usdc");
  if (maxDaily < maxOrder) throw new Error("max_daily_notional_below_order_limit");
  if (maxPosition < maxOrder) throw new Error("max_position_below_order_limit");
  if (availableMicroUsdc !== undefined && maxOrder > Math.max(0, Math.floor(availableMicroUsdc))) {
    throw new Error("max_order_exceeds_available_balance");
  }
  if (!Number.isInteger(input.max_slippage_bps) || input.max_slippage_bps < 1 || input.max_slippage_bps > CONSUMER_MAX_SLIPPAGE_BPS) {
    throw new Error("max_slippage_bps_outside_policy");
  }
  const marketAllowlist = Array.from(new Set(input.market_allowlist.map(normalizeMarket).filter(Boolean)));
  if (marketAllowlist.length === 0 || marketAllowlist.length > 25) throw new Error("market_allowlist_required");
  return {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    max_order_micro_usdc: maxOrder,
    max_daily_notional_micro_usdc: maxDaily,
    max_position_micro_usdc: maxPosition,
    max_slippage_bps: input.max_slippage_bps,
    market_allowlist: marketAllowlist,
  };
}

export function balancedPostings(postings: ConsumerLedgerPosting[]): ConsumerLedgerPosting[] {
  if (postings.length < 2) throw new Error("double_entry_requires_two_postings");
  let debits = 0;
  let credits = 0;
  const normalized = postings.map((posting) => {
    const amount = positiveInteger(posting.amount_micro_usdc, "posting_amount_micro_usdc");
    if (posting.side === "debit") debits += amount;
    else credits += amount;
    return { ...posting, amount_micro_usdc: amount };
  });
  if (debits !== credits) throw new Error("unbalanced_ledger_transaction");
  return normalized;
}

export function evaluateConsumerCircuit(input: ConsumerCircuitTelemetry): ConsumerCircuitReason[] {
  const reasons: ConsumerCircuitReason[] = [];
  if (input.negative_balance_detected) reasons.push("negative_balance");
  if (input.duplicate_settlement_detected) reasons.push("duplicate_settlement");
  if (input.nonce_or_idempotency_violation) reasons.push("nonce_or_idempotency_violation");
  const driftThreshold = Math.max(1_000_000, Math.ceil(input.pooled_treasury_micro_usdc * 0.001));
  if (Math.abs(input.reconciliation_drift_micro_usdc) > driftThreshold) reasons.push("reconciliation_drift");
  if (input.treasury_free_micro_usdc * 100 < input.reserved_exposure_micro_usdc * 120) {
    reasons.push("insufficient_treasury_buffer");
  }
  if (input.market_data_age_ms > CONSUMER_MARKET_DATA_MAX_AGE_MS) reasons.push("market_data_stale");
  if (input.reconciliation_age_ms > CONSUMER_RECONCILIATION_MAX_AGE_MS) reasons.push("reconciliation_stale");
  if (input.consecutive_failures >= 5 || input.failure_rate_5m >= 0.05) reasons.push("execution_failure_rate");
  if (!input.worker_attested) reasons.push("worker_attestation_missing");
  if (!input.venue_available) reasons.push("venue_unavailable");
  return reasons;
}

export function consumerCommitment(namespace: string, value: unknown): string {
  return `consumer_${namespace}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field}_invalid`);
  return value;
}

function normalizeMarket(value: string): string {
  const market = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9/_:-]{2,32}$/.test(market) ? market : "";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
