import { createHash } from "node:crypto";

export interface PrivateAgentTradingFillReceipt {
  work_order_commitment: string;
  connector_result_commitment: string;
  platform_class: string;
  fill_commitments?: string[];
  fill_summary?: {
    fill_count: number;
    filled_notional_usd: number;
  };
}

export interface PrivateAgentTradingMeterEvent {
  event_id: string;
  work_order_commitment: string;
  connector_result_commitment: string;
  platform_class: string;
  fill_count: number;
  filled_notional_micro_usd: number;
}

export function privateAgentTradingMeterEvent(
  receipt: PrivateAgentTradingFillReceipt | null | undefined,
): PrivateAgentTradingMeterEvent | null {
  const summary = receipt?.fill_summary;
  const commitments = [...(receipt?.fill_commitments ?? [])].filter(Boolean).sort();
  if (
    !receipt ||
    !summary ||
    !Number.isInteger(summary.fill_count) ||
    summary.fill_count <= 0 ||
    summary.fill_count > 25 ||
    !Number.isFinite(summary.filled_notional_usd) ||
    summary.filled_notional_usd <= 0 ||
    commitments.length <= 0
  ) {
    return null;
  }
  const filledNotionalMicroUsd = Math.round(summary.filled_notional_usd * 1_000_000);
  if (!Number.isSafeInteger(filledNotionalMicroUsd) || filledNotionalMicroUsd <= 0) return null;
  const eventDigest = createHash("sha256").update(JSON.stringify(commitments)).digest("hex");
  return {
    event_id: `ghola_fill_${eventDigest}`,
    work_order_commitment: receipt.work_order_commitment,
    connector_result_commitment: receipt.connector_result_commitment,
    platform_class: receipt.platform_class,
    fill_count: summary.fill_count,
    filled_notional_micro_usd: filledNotionalMicroUsd,
  };
}
