import type { PrivateExecutionOrderDraft } from "./private-execution-instruction-seal";

export type GholaHyperliquidMarket = "BTC" | "ETH" | "SOL" | "HYPE";

export function hyperliquidNoSubmitProofOrder(input: {
  market: string;
  referencePrice: number;
  maxSlippageBps: string;
  leverage: number;
  marginMode: "cross" | "isolated";
}): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: input.market.toUpperCase().split("-")[0] || "BTC",
    side: "buy",
    base_size: "",
    limit_price: input.referencePrice.toFixed(6),
    quote_size: "5",
    max_slippage_bps: input.maxSlippageBps,
    live_order_mode: "tiny_fill",
    order_type: "limit",
    size_mode: "quote",
    tif: "Ioc",
    leverage: input.leverage,
    margin_mode: input.marginMode,
    protective_orders: { stop_loss: (input.referencePrice * 0.96).toFixed(6) },
  };
}

export function hyperliquidMarketFromTradeReturn(
  returnTo: string | null | undefined,
): GholaHyperliquidMarket | null {
  return hyperliquidMarketFromReturnTarget(returnTo, 0);
}

export function safeHyperliquidSetupReturn(
  returnTo: string | null | undefined,
): boolean {
  if (!returnTo) return false;
  try {
    const target = new URL(returnTo, "https://ghola.local");
    if (target.origin !== "https://ghola.local") return false;
    if (target.pathname === "/carry") return true;
    if (hyperliquidMarketFromReturnTarget(returnTo, 0)) return true;
    if (target.pathname !== "/account" || target.searchParams.get("setup") !== "carry") return false;
    const nested = target.searchParams.get("return_to");
    return nested === "/carry" || hyperliquidMarketFromReturnTarget(nested, 1) !== null;
  } catch {
    return false;
  }
}

export function hyperliquidSetupAuthRedirect(
  returnTo: string | null | undefined,
): string {
  const params = new URLSearchParams({
    flow: "private-mode",
    setup: "hyperliquid",
  });
  if (returnTo && safeHyperliquidSetupReturn(returnTo)) {
    params.set("return_to", returnTo);
  }
  return `/account?${params.toString()}`;
}

function hyperliquidMarketFromReturnTarget(
  returnTo: string | null | undefined,
  depth: number,
): GholaHyperliquidMarket | null {
  if (!returnTo) return null;
  try {
    const target = new URL(returnTo, "https://ghola.local");
    if (target.origin !== "https://ghola.local") return null;
    if (target.pathname === "/account" && depth === 0 && target.searchParams.get("setup") === "carry") {
      return hyperliquidMarketFromReturnTarget(target.searchParams.get("return_to"), depth + 1);
    }
    if (target.pathname !== "/trade" || target.searchParams.get("venue") !== "hyperliquid") return null;
    const market = target.searchParams.get("market")?.trim().toUpperCase().replace(/-PERP$/, "");
    return market === "BTC" || market === "ETH" || market === "SOL" || market === "HYPE"
      ? market
      : null;
  } catch {
    return null;
  }
}

export function liveHyperliquidReferencePrice(snapshot: {
  mark_price?: string | null;
  mid?: string | null;
} | null | undefined): number | null {
  const reference = Number(snapshot?.mark_price || snapshot?.mid || "");
  return Number.isFinite(reference) && reference > 0 ? reference : null;
}

export function hyperliquidNoSubmitProofReady(result: {
  connection_proof_persisted?: boolean;
  verification?: {
    status?: string;
    checks?: {
      sealed_vault_opened?: boolean;
      sealed_instruction_opened?: boolean;
      authority_derived?: boolean;
      policy_enforced?: boolean;
      live_gate_enforced?: boolean;
      api_wallet_loaded?: boolean;
      hyperliquid_api_reachable?: boolean;
      hyperliquid_sdk_ready?: boolean;
      account_read_checked?: boolean;
      order_request_built?: boolean;
      live_venue_checked?: boolean;
      transaction_broadcast?: boolean;
    };
  };
}): boolean {
  const checks = result.verification?.checks;
  return result.connection_proof_persisted === true &&
    result.verification?.status === "verified_no_funds" &&
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
}
