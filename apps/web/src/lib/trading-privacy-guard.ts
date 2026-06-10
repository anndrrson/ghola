import type {
  TradingStrategyPolicyV1,
  TradingStrategyMode,
} from "./trading-strategy";
import {
  formatStrategyUsd,
  hashTradingStrategyValue,
} from "./trading-strategy";

export type TradeSide = "buy" | "sell";

export interface TradeProposalV1 {
  version: 1;
  proposal_id: string;
  strategy_id: string;
  created_at: string;
  trigger_seen_at: string;
  venue: string;
  public_amm: boolean;
  unshield: boolean;
  destination_address?: string | null;
  destination_label?: string | null;
  known_public_wallet?: boolean;
  base_asset: string;
  quote_asset: "USDC";
  side: TradeSide;
  amount_micro_usdc: number;
  slippage_bps: number;
  calldata_kind: "railgun_private_swap" | "unknown" | "public_swap";
  unsigned_tx?: unknown;
  execution_mode: TradingStrategyMode;
  user_confirmed?: boolean;
}

export interface TradingDailyState {
  spent_micro_usdc: number;
  action_count: number;
}

export type PrivacyGuardReason =
  | "venue_not_allowed"
  | "public_amm_denied"
  | "unshield_denied"
  | "public_destination_denied"
  | "known_wallet_denied"
  | "asset_not_allowed"
  | "amount_over_cap"
  | "daily_cap_exceeded"
  | "daily_action_cap_exceeded"
  | "amount_not_bucketed"
  | "slippage_too_high"
  | "delay_window_not_met"
  | "unknown_calldata"
  | "confirmation_required"
  | "strategy_mismatch";

export type PrivacyGuardResult =
  | {
      ok: true;
      policy_hash: string;
      proposal_hash: string;
      rounded_amount_micro_usdc: number;
      visible_leakage: "none_expected_shielded_execution";
      explanation: string;
    }
  | {
      ok: false;
      reason: PrivacyGuardReason;
      policy_hash: string;
      proposal_hash: string;
      explanation: string;
    };

export function evaluateTradeProposal(
  policy: TradingStrategyPolicyV1,
  proposal: TradeProposalV1,
  dailyState: TradingDailyState = { spent_micro_usdc: 0, action_count: 0 },
): PrivacyGuardResult {
  const policyHash = hashTradingStrategyValue(policy);
  const proposalHash = hashTradingStrategyValue(proposal);
  const deny = (
    reason: PrivacyGuardReason,
    explanation: string,
  ): PrivacyGuardResult => ({
    ok: false,
    reason,
    policy_hash: policyHash,
    proposal_hash: proposalHash,
    explanation,
  });

  if (proposal.strategy_id !== policy.strategy_id) {
    return deny("strategy_mismatch", "Proposal does not match this strategy.");
  }
  if (!policy.allowed_venues.includes(proposal.venue as never)) {
    return deny("venue_not_allowed", "Only shielded private swap venues are allowed.");
  }
  if (proposal.public_amm) {
    return deny("public_amm_denied", "Public AMM execution is blocked by policy.");
  }
  if (proposal.unshield) {
    return deny("unshield_denied", "Unshielding is blocked by policy.");
  }
  if (proposal.destination_address) {
    return deny(
      "public_destination_denied",
      "Public destination addresses are blocked by policy.",
    );
  }
  if (proposal.destination_label || proposal.known_public_wallet) {
    return deny(
      "known_wallet_denied",
      "Known-wallet destinations are blocked by policy.",
    );
  }
  if (!policy.allowed_assets.includes(proposal.base_asset)) {
    return deny(
      "asset_not_allowed",
      `${proposal.base_asset} is not in this strategy's allowed assets.`,
    );
  }
  if (proposal.amount_micro_usdc > policy.max_trade_micro_usdc) {
    return deny(
      "amount_over_cap",
      `Amount exceeds the ${formatStrategyUsd(policy.max_trade_micro_usdc)} per-trade cap.`,
    );
  }
  if (
    dailyState.spent_micro_usdc + proposal.amount_micro_usdc >
    policy.daily_cap_micro_usdc
  ) {
    return deny("daily_cap_exceeded", "Daily spend cap would be exceeded.");
  }
  if (dailyState.action_count + 1 > policy.max_actions_per_day) {
    return deny("daily_action_cap_exceeded", "Daily action cap would be exceeded.");
  }
  if (!policy.amount_bucket_micro_usdc.includes(proposal.amount_micro_usdc)) {
    return deny(
      "amount_not_bucketed",
      "Amount must be rounded to an approved privacy bucket.",
    );
  }
  if (proposal.slippage_bps > policy.max_slippage_bps) {
    return deny("slippage_too_high", "Slippage exceeds the strategy limit.");
  }
  if (
    elapsedSeconds(proposal.trigger_seen_at, proposal.created_at) <
    policy.min_delay_seconds
  ) {
    return deny(
      "delay_window_not_met",
      "Execution delay window has not elapsed.",
    );
  }
  if (proposal.calldata_kind !== "railgun_private_swap") {
    return deny("unknown_calldata", "Unknown or public calldata is blocked.");
  }
  if (
    policy.require_user_confirmation &&
    proposal.execution_mode !== "prepare_only" &&
    !proposal.user_confirmed
  ) {
    return deny("confirmation_required", "User confirmation is required.");
  }

  return {
    ok: true,
    policy_hash: policyHash,
    proposal_hash: proposalHash,
    rounded_amount_micro_usdc: proposal.amount_micro_usdc,
    visible_leakage: "none_expected_shielded_execution",
    explanation: "Proposal matches the shielded-only strategy policy.",
  };
}

export function largestAllowedBucket(
  policy: TradingStrategyPolicyV1,
): number | null {
  const sorted = [...policy.amount_bucket_micro_usdc].sort((a, b) => b - a);
  return sorted.find((bucket) => bucket <= policy.max_trade_micro_usdc) ?? null;
}

function elapsedSeconds(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 1000);
}
