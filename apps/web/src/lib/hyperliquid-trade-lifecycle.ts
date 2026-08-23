import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";

export type HyperliquidFinalProof = {
  proof_kind?: string | null;
  status?: string | null;
  broadcast_performed?: boolean;
  final_venue_execution_proven?: boolean;
  final_fill_proven?: boolean;
  filled_base_size?: string | null;
  checked_at?: string | null;
};

export type HyperliquidConnectorResult = {
  connector_result_commitment?: string | null;
  work_order_commitment?: string | null;
  result_commitment?: string | null;
  status?: string | null;
  reason?: string | null;
  final_proof?: HyperliquidFinalProof | null;
};

export type HyperliquidTradeFailure = {
  code: string;
  correlationId: string | null;
  message: string;
  retryForbidden: boolean;
  reconciliationRequired: boolean;
};

export type ProvenHyperliquidFill = {
  baseSize: string;
  proofKind: string;
  checkedAt: string | null;
};

export function classifyHyperliquidTradeFailure(error: unknown): HyperliquidTradeFailure {
  const record = objectRecord(error);
  const body = objectRecord(record?.body);
  const raw = stringValue(body?.error) || stringValue(record?.message) || String(error || "hyperliquid_order_failed");
  const code = normalizedErrorCode(raw);
  const correlationId = stringValue(record?.correlationId) || stringValue(body?.correlation_id) || null;
  const trace = correlationId ? ` Reference ${correlationId}.` : "";

  if (code === "connector_submit_ambiguous" || code === "connector_submit_in_progress") {
    return {
      code,
      correlationId,
      message: `Order outcome is not final. Ghola locked this exact order, will never resubmit it, and must reconcile its client-order ID with Hyperliquid.${trace}`,
      retryForbidden: true,
      reconciliationRequired: true,
    };
  }
  if (code === "connector_submit_failed") {
    return {
      code,
      correlationId,
      message: `The private worker rejected the request before returning a venue acknowledgement. Nothing will be retried automatically.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  if (code === "connector_not_ready") {
    return {
      code,
      correlationId,
      message: `The private execution connector is not ready. No order was sent.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  if (code === "worker_unavailable" || code === "connector_endpoint_missing" || code === "private_account_live_proxy_unavailable") {
    return {
      code,
      correlationId,
      message: `The private execution path is unavailable. No new submission should be attempted until readiness is restored.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  if (code === "venue_rejected") {
    return {
      code,
      correlationId,
      message: `Hyperliquid rejected the order. Recheck collateral, price, size, leverage, and API-wallet authority.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  if (code === "needs_funds" || /insufficient/.test(raw.toLowerCase())) {
    return {
      code,
      correlationId,
      message: `This Hyperliquid account needs enough available collateral for the order and fees.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  if (code === "preview_expired" || code === "intent_expired") {
    return {
      code,
      correlationId,
      message: `The live review expired. Create a fresh review before submitting.${trace}`,
      retryForbidden: false,
      reconciliationRequired: false,
    };
  }
  return {
    code,
    correlationId,
    message: `${raw.replaceAll("_", " ")}.${trace}`.replace("..", "."),
    retryForbidden: false,
    reconciliationRequired: false,
  };
}

export function provenHyperliquidFill(
  result: HyperliquidConnectorResult | null | undefined,
): ProvenHyperliquidFill | null {
  const proof = result?.final_proof;
  const baseSize = stringValue(proof?.filled_base_size);
  if (
    result?.status !== "reconciled" ||
    proof?.proof_kind !== "hyperliquid_order_status_reconciliation_v1" ||
    proof.final_venue_execution_proven !== true ||
    proof.final_fill_proven !== true ||
    !positiveDecimal(baseSize)
  ) {
    return null;
  }
  return {
    baseSize,
    proofKind: proof.proof_kind,
    checkedAt: stringValue(proof.checked_at) || null,
  };
}

export function buildHyperliquidReduceOnlyClose(
  entry: PrivateExecutionOrderDraft,
  fill: ProvenHyperliquidFill,
): PrivateExecutionOrderDraft {
  return {
    ...entry,
    operation_class: "limit_order",
    side: entry.side === "buy" ? "sell" : "buy",
    base_size: fill.baseSize,
    quote_size: "",
    limit_price: "",
    order_type: "market",
    size_mode: "base",
    tif: "Ioc",
    reduce_only: true,
    post_only: false,
    protective_orders: undefined,
  };
}

export function hyperliquidAccountIsFlatAndClear(
  snapshot: Pick<HyperliquidAccountSnapshot, "position_count" | "open_order_count"> | null | undefined,
): boolean {
  return snapshot?.position_count === 0 && snapshot.open_order_count === 0;
}

function normalizedErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  const known = [
    "connector_submit_ambiguous",
    "connector_submit_in_progress",
    "connector_submit_failed",
    "connector_not_ready",
    "connector_endpoint_missing",
    "private_account_live_proxy_unavailable",
    "worker_unavailable",
    "venue_rejected",
    "needs_funds",
    "preview_expired",
    "intent_expired",
  ];
  return known.find((code) => normalized.includes(code)) || normalized || "hyperliquid_order_failed";
}

function positiveDecimal(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
