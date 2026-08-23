import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import { gholaCommitment } from "@/lib/private-account";

export type HyperliquidProtectionProof = {
  status: "not_requested" | "proven" | "unproven";
  expected_order_count: number;
  matched_order_count: number;
  matching_order_commitments: string[];
  checked_at: string | null;
};

export function hyperliquidTriggerPriceCommitment(input: {
  network: "mainnet" | "testnet";
  market: string;
  triggerPrice: string | number;
}): string | null {
  const triggerPrice = canonicalHyperliquidDecimal(input.triggerPrice);
  const market = input.market.trim().toUpperCase();
  if (!triggerPrice || !market) return null;
  return gholaCommitment("hyperliquid_trigger_price", {
    network: input.network,
    market,
    trigger_price: triggerPrice,
  });
}

export function proveHyperliquidEntryProtection(input: {
  network: "mainnet" | "testnet";
  order: PrivateExecutionOrderDraft;
  snapshot: HyperliquidAccountSnapshot | null | undefined;
}): HyperliquidProtectionProof {
  const expected = [
    input.order.protective_orders?.stop_loss?.trim()
      ? { kind: "sl" as const, price: input.order.protective_orders.stop_loss.trim() }
      : null,
    input.order.protective_orders?.take_profit?.trim()
      ? { kind: "tp" as const, price: input.order.protective_orders.take_profit.trim() }
      : null,
  ].filter((item): item is { kind: "sl" | "tp"; price: string } => item !== null);
  if (expected.length === 0) {
    return {
      status: "not_requested",
      expected_order_count: 0,
      matched_order_count: 0,
      matching_order_commitments: [],
      checked_at: input.snapshot?.last_checked_at ?? null,
    };
  }

  const snapshot = input.snapshot;
  const market = input.order.market.trim().toUpperCase();
  const positionSide = input.order.side === "buy" ? "long" : "short";
  const protectiveSide = input.order.side === "buy" ? "sell" : "buy";
  const openOrders = Array.isArray(snapshot?.open_orders) ? snapshot.open_orders : [];
  const matches = expected.flatMap((leg) => {
    const priceCommitment = hyperliquidTriggerPriceCommitment({
      network: input.network,
      market,
      triggerPrice: leg.price,
    });
    const match = openOrders.find((candidate) =>
      candidate.market.trim().toUpperCase() === market &&
      candidate.side === protectiveSide &&
      candidate.reduce_only === true &&
      candidate.is_trigger === true &&
      candidate.trigger_kind === leg.kind &&
      Boolean(priceCommitment) &&
      candidate.trigger_price_commitment === priceCommitment
    );
    return match ? [match] : [];
  });
  const matchingCommitments = Array.from(new Set(matches.map((order) => order.order_handle_commitment)));
  const positionMatches = snapshot?.position_count === 1 &&
    snapshot.positions?.some((position) =>
      position.market.trim().toUpperCase() === market && position.side === positionSide
    ) === true;
  const exactOrderSet = snapshot?.open_order_count === expected.length &&
    openOrders.length === expected.length &&
    matchingCommitments.length === expected.length;

  return {
    status: positionMatches && exactOrderSet ? "proven" : "unproven",
    expected_order_count: expected.length,
    matched_order_count: matchingCommitments.length,
    matching_order_commitments: matchingCommitments,
    checked_at: snapshot?.last_checked_at ?? null,
  };
}

function canonicalHyperliquidDecimal(value: string | number): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}
