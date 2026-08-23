import { gholaCommitment } from "@/lib/private-account";
import type { PrivateLiveTradingCanaryReportRecordV1 } from "@/lib/private-account-store";

type HyperliquidNoSubmitVerification = {
  status?: string;
  verification_commitment?: string | null;
  result_commitment?: string | null;
  checks?: Partial<Record<
    | "sealed_vault_opened"
    | "sealed_instruction_opened"
    | "authority_derived"
    | "policy_enforced"
    | "live_gate_enforced"
    | "api_wallet_loaded"
    | "hyperliquid_api_reachable"
    | "hyperliquid_sdk_ready"
    | "account_read_checked"
    | "order_request_built"
    | "live_venue_checked"
    | "transaction_broadcast",
    boolean
  >>;
};

type HyperliquidAccountState = {
  status?: string;
  position_count?: number;
  open_order_count?: number;
};

export type HyperliquidReleaseCanaryBuildResult =
  | { ok: true; report: PrivateLiveTradingCanaryReportRecordV1 }
  | { ok: false; reason: string };

export function buildHyperliquidCapitalFreeCanary(input: {
  verification: HyperliquidNoSubmitVerification;
  connection_proof_persisted: boolean;
  network: "mainnet" | "testnet";
  account_state: HyperliquidAccountState;
  now?: Date;
  env?: Record<string, string | undefined>;
}): HyperliquidReleaseCanaryBuildResult {
  const checks = input.verification.checks;
  const proofComplete = input.connection_proof_persisted &&
    input.verification.status === "verified_no_funds" &&
    Boolean(input.verification.verification_commitment) &&
    Boolean(input.verification.result_commitment) &&
    checks?.sealed_vault_opened === true &&
    checks.sealed_instruction_opened === true &&
    checks.authority_derived === true &&
    checks.policy_enforced === true &&
    checks.live_gate_enforced === true &&
    checks.api_wallet_loaded === true &&
    checks.hyperliquid_api_reachable === true &&
    checks.hyperliquid_sdk_ready === true &&
    checks.account_read_checked === true &&
    checks.order_request_built === true &&
    checks.live_venue_checked === true &&
    checks.transaction_broadcast === false;
  if (!proofComplete) return { ok: false, reason: "hyperliquid_no_submit_proof_incomplete" };
  if (input.network !== "mainnet") {
    return { ok: false, reason: "hyperliquid_no_submit_mainnet_required" };
  }
  if (
    !["ready_to_trade", "needs_funds"].includes(input.account_state.status ?? "") ||
    input.account_state.position_count !== 0 ||
    input.account_state.open_order_count !== 0
  ) {
    return { ok: false, reason: "hyperliquid_no_submit_flat_zero_required" };
  }

  const env = input.env ?? process.env;
  const maxOrderUsd = positiveNumber(env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 1_000);
  const dailyCapUsd = positiveNumber(env.GHOLA_LIVE_TRADING_DAILY_CAP_USD, 5_000);
  const maxSlippageBps = positiveInteger(env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS, 100);
  const ttlMs = positiveInteger(env.GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS, 24 * 60 * 60 * 1_000);
  const orderNotionalUsd = Math.min(5, maxOrderUsd);
  if (orderNotionalUsd <= 0) return { ok: false, reason: "hyperliquid_no_submit_caps_invalid" };

  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const receiptCommitment = input.verification.verification_commitment ?? null;
  const resultCommitment = input.verification.result_commitment ?? null;
  const evidencePayload = {
    venue_id: "hyperliquid",
    network: "mainnet",
    status: "green",
    live_mode: "no_submit",
    canary_kind: "capital_free_no_submit",
    broadcast_performed: false,
    reconcile_status: "reconciled",
    order_notional_usd: orderNotionalUsd,
    max_order_notional_usd: maxOrderUsd,
    daily_cap_usd: dailyCapUsd,
    max_slippage_bps: maxSlippageBps,
    receipt_commitment: receiptCommitment,
    result_commitment: resultCommitment,
    entry_receipt_commitment: null,
    close_receipt_commitment: null,
    final_venue_execution_proven: false,
    final_fill_proven: false,
    entry_protection_proven: false,
    entry_protection_order_count: -1,
    entry_protection_evidence_commitment: null,
    position_count: 0,
    open_order_count: 0,
    reason: null,
    observed_at: observedAt,
    expires_at: expiresAt,
  };
  const evidenceCommitment = gholaCommitment(
    "live_trading_capital_free_canary_report",
    evidencePayload,
  );
  return {
    ok: true,
    report: {
      version: 1,
      report_id: `capital_free_canary_hyperliquid_${evidenceCommitment.slice(-24)}`,
      venue_id: "hyperliquid",
      network: "mainnet",
      status: "green",
      live_mode: "no_submit",
      canary_kind: "capital_free_no_submit",
      broadcast_performed: false,
      reconcile_status: "reconciled",
      order_notional_usd: orderNotionalUsd,
      max_order_notional_usd: maxOrderUsd,
      daily_cap_usd: dailyCapUsd,
      max_slippage_bps: maxSlippageBps,
      receipt_commitment: receiptCommitment,
      result_commitment: resultCommitment,
      entry_receipt_commitment: null,
      close_receipt_commitment: null,
      final_venue_execution_proven: false,
      final_fill_proven: false,
      entry_protection_proven: false,
      entry_protection_order_count: -1,
      entry_protection_evidence_commitment: null,
      position_count: 0,
      open_order_count: 0,
      evidence_commitment: evidenceCommitment,
      reason: null,
      observed_at: observedAt,
      expires_at: expiresAt,
      created_at: observedAt,
    },
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
