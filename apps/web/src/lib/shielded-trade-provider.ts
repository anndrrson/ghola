import type { TradingStrategyPolicyV1 } from "./trading-strategy";
import type { TradeProposalV1 } from "./trading-privacy-guard";

export interface ShieldedTradeQuote {
  quote_id: string;
  venue: "railgun_private_swap";
  base_asset: string;
  quote_asset: "USDC";
  amount_micro_usdc: number;
  expected_out?: string;
  expires_at: string;
}

export interface BuiltShieldedTrade {
  unsigned_tx: unknown;
  policy_hash: string;
  proposal_hash: string;
  venue: "railgun_private_swap";
}

export interface SubmittedShieldedTrade {
  tx_ref: string;
  submitted_at: string;
}

export interface ShieldedTradeProvider {
  quotePrivateSwap(
    request: TradeProposalV1,
    policy: TradingStrategyPolicyV1,
  ): Promise<ShieldedTradeQuote>;
  buildPrivateSwap(
    quote: ShieldedTradeQuote,
    policyHash: string,
    proposalHash: string,
  ): Promise<BuiltShieldedTrade>;
  requestUserSignature(unsignedTx: unknown): Promise<unknown>;
  submitPrivateSwap(signedTx: unknown): Promise<SubmittedShieldedTrade>;
}

declare global {
  interface Window {
    gholaShieldedTradeProvider?: ShieldedTradeProvider;
  }
}

export function browserShieldedTradeProvider(): ShieldedTradeProvider | null {
  if (typeof window === "undefined") return null;
  const provider = window.gholaShieldedTradeProvider ?? null;
  if (
    provider &&
    typeof provider.quotePrivateSwap === "function" &&
    typeof provider.buildPrivateSwap === "function" &&
    typeof provider.requestUserSignature === "function" &&
    typeof provider.submitPrivateSwap === "function"
  ) {
    return provider;
  }
  return null;
}
