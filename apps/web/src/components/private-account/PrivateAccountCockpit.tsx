"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import type { PerpsMandateV1 } from "@ghola/perps-core";
import { Activity, ChevronDown, Copy, KeyRound, Layers, LockKeyhole, Play, ReceiptText, Search, ShieldCheck, SlidersHorizontal, Square, TimerReset, X } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { PrivateAccountFundingPanel } from "@/components/private-account/PrivateAccountFundingPanel";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";
import { TurnkeyPerpsManager } from "@/components/trade/TurnkeyPerpsManager";
import {
  approvePrivateAccountAction,
  allocateHyperliquidManagedTestnet,
  allocatePrivateAccountOmnibus,
  allocatePooledVenueAccount,
  armHyperliquidExecutionAgent,
  armVenueExecutionAgent,
  cancelPrivateAccountQueue,
  commitPrivateAccountAuction,
  controlPrivateAutopilotSession,
  createPrivateAccountIntent,
  createPrivateAutopilotSession,
  createPrivateAccountRuntimeEnvelope,
  executePrivateAccountAction,
  exportPrivateAccountPrivateReceipt,
  getPrivateAutopilotReadiness,
  getPrivateAutopilotReplay,
  getPrivateAccountOmnibusStatus,
  getPrivateAccountLiveTradingStatus,
  getHyperliquidAccountSnapshot,
  getHyperliquidExecutionVaultStatus,
  getVenueExecutionVaultStatus,
  openHyperliquidAccountStream,
  getPrivateAccountPlatformReadiness,
  getPrivateAccountReceiptDetail,
  getPrivateExecutionAccountStatus,
  isPrivateModeAvailableStatus,
  listPrivateAutopilotSessions,
  listPrivateAccountAuctions,
  listPrivateAccountQueue,
  listPrivateAccountReceipts,
  openPrivateAutopilotEventStream,
  previewPrivateAccountAction,
  queuePrivateAccountAction,
  reconcilePrivateAccountConnector,
  refreshPrivateAccountQueue,
  recommendedRail,
  sealVenueExecutionVault,
  sealHyperliquidExecutionVault,
  settlePrivateAccountAuction,
  verifyPrivateAccountConnectorNoSubmit,
  verifyVenueEligibility,
  type HyperliquidAccountSnapshot,
  type HyperliquidAccountStreamStatus,
  type HyperliquidMarketSnapshot,
  type PrivateAutopilotEvent,
  type PrivateAutopilotReadiness,
  type PrivateAutopilotReplayResponse,
  type PrivateAutopilotSession,
  type PrivateAutopilotSessionPolicy,
  type PrivateAccountLiveTradingStatus,
  type PrivateAccountSafeInput,
} from "@/lib/private-account-client";
import {
  buildHyperliquidExecutionVaultBundle,
  parseHyperliquidCredentialImport,
  validateHyperliquidExecutionCredentialDraft,
  type HyperliquidExecutionCredentialDraft,
} from "@/lib/hyperliquid-vault-seal";
import {
  generateHyperliquidApiWallet,
  signHyperliquidApiWalletBinding,
} from "@/lib/hyperliquid-api-wallet";
import { defaultHyperliquidMarketAllowlist } from "@/lib/private-account-hyperliquid-policy";
import {
  buildCoinbaseExecutionVaultBundle,
  parseCoinbaseCredentialImport,
  validateCoinbaseExecutionCredentialDraft,
  type CoinbaseExecutionCredentialDraft,
} from "@/lib/coinbase-vault-seal";
import {
  buildSolanaPerpsExecutionVaultBundle,
  parseSolanaPerpsCredentialImport,
  validateSolanaPerpsExecutionCredentialDraft,
  type SolanaPerpsExecutionCredentialDraft,
} from "@/lib/solana-perps-vault-seal";
import {
  buildSolanaSwapExecutionVaultBundle,
  JUPITER_SOL_MINT,
  JUPITER_USDC_MINT,
  parseSolanaSwapCredentialImport,
  validateSolanaSwapExecutionCredentialDraft,
  type SolanaSwapExecutionCredentialDraft,
} from "@/lib/solana-swap-vault-seal";
import {
  buildPrivateExecutionInstructionBundle,
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import { deriveFrontRunProtection } from "@/lib/private-account-front-run-protection";
import {
  buildGholaAgentChartOverlays,
  gholaFrameFromCoinbase,
  gholaFrameFromHyperliquid,
  gholaFrameFromJupiter,
  type GholaChartMode,
} from "@/lib/ghola-market-chart";
import type {
  HyperliquidLiveMarketStatus,
} from "@/lib/hyperliquid-live-market";
import type {
  CoinbaseLiveMarketStatus,
} from "@/lib/coinbase-live-market";
import {
  hyperliquidMarketFromTradeReturn,
  hyperliquidNoSubmitProofReady,
  liveHyperliquidReferencePrice,
} from "@/lib/hyperliquid-trade-return";
import {
  type CoinbaseCandleInterval,
  type CoinbaseMarketSnapshot,
  type CoinbaseProductId,
} from "@/lib/coinbase-market-data";
import type {
  PhoenixLiveMarketStatus,
} from "@/lib/phoenix-live-market";
import {
  type PhoenixCandleInterval,
  type PhoenixMarketSnapshot,
} from "@/lib/phoenix-market-data";
import type { MobileMarketJupiter } from "@/lib/mobile-market-data";
import { useMarketData } from "@/lib/market-data-store";
import {
  customerAutopilotEventCopy,
  deriveAutopilotExecutionDisplay,
  deriveHyperliquidVerificationAction,
  deriveTradingNextAction,
  deriveVenueReadinessSteps,
  isHyperliquidAgentKeyConfirmed,
  requiresHyperliquidPoolTerms,
  shouldResetHyperliquidConnectionError,
  shouldReconnectHyperliquidApiWallet,
  type TradingActionKind,
  type TradingNextAction,
  type VenueReadinessStep,
} from "@/lib/private-account-trading-ui";
import { GholaMarketChart } from "./GholaMarketChart";
import { ProTradingTerminal, type ProChartInterval, type ProTradingVenue } from "./ProTradingTerminal";
import type { GholaPrivacyPreview } from "@/lib/private-account";
import type { PrivateAccountReadinessResponse } from "@/lib/private-account-readiness";

const PhoenixLiveTerminal = dynamic(
  () => import("./PhoenixLiveTerminal").then((mod) => mod.PhoenixLiveTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="border border-[#1e2a3a] bg-[#08090d] p-4 text-sm text-[#8b95a8]">
        Loading Phoenix terminal
      </div>
    ),
  },
);

const ACTIONS = [
  ["pay", "Pay"],
  ["transfer", "Send"],
  ["fund_platform", "Fund app"],
  ["trade_on_platform", "Swap"],
  ["rebalance", "Rebalance"],
  ["maintain_allocation", "Maintain"],
  ["withdraw", "Withdraw"],
] as const;

const CORE_ACTIONS = [
  ["pay", "Pay"],
  ["transfer", "Send"],
  ["trade_on_platform", "Trade"],
  ["fund_platform", "Fund app"],
  ["withdraw", "Withdraw"],
] as const;

const APPS = [
  ["solana_private_balance", "Ghola user"],
  ["solana_public_wallet", "Wallet"],
  ["hyperliquid_style_market", "Hyperliquid"],
  ["solana_perps_market", "Phoenix / Drift / Backpack"],
  ["solana_swap_aggregator", "Jupiter"],
  ["coinbase_style_provider", "Coinbase"],
  ["rfq_solver_network", "RFQ"],
  ["partner_tokenized_assets", "Partner gated"],
] as const;

const SPEEDS = [
  ["maximum_privacy", "Most private"],
  ["next_batch", "Next batch"],
  ["fast_degraded", "Fast"],
] as const;

const HYPERLIQUID_MARKETS = [["BTC", "BTC"], ["ETH", "ETH"], ["SOL", "SOL"], ["HYPE", "HYPE"]] as const;
const HYPERLIQUID_INTERVALS = [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["1h", "1h"]] as const;
const COINBASE_PRODUCTS = [["BTC-USD", "BTC-USD"], ["ETH-USD", "ETH-USD"], ["SOL-USD", "SOL-USD"]] as const;
const AGENT_STRATEGY_PROFILES = [
  ["trend_following", "Trend follow"],
  ["breakout", "Breakout trade"],
  ["reversal", "Reversal trade"],
  ["mean_reversion", "Mean reversion"],
  ["range_trade", "Range fade"],
  ["funding_basis", "Funding basis"],
  ["custom", "Custom"],
] as const;
const AGENT_ENTRY_TRIGGERS = [
  ["preview_now", "Use entry now"],
  ["break_level", "Breaks level"],
  ["retest_level", "Retests level"],
  ["sweep_reclaim", "Reclaims level"],
  ["book_imbalance", "Book imbalance"],
  ["funding_mark_divergence", "Funding edge"],
  ["route_edge_threshold", "Route edge"],
  ["custom", "Custom trigger"],
] as const;
const AGENT_EXIT_RULES = [
  ["manual_approval", "Ask me first"],
  ["take_profit_stop", "Take profit / stop"],
  ["trail_after_profit", "Trail after profit"],
  ["exit_on_invalidation", "Thesis invalid"],
  ["time_stop", "Time limit"],
  ["reduce_on_risk_flip", "Risk flip"],
] as const;
const AGENT_TIME_HORIZONS = [
  ["scalp", "Scalp"],
  ["session_trade", "Session"],
  ["intraday", "Intraday"],
  ["until_invalidated", "Until invalidated"],
  ["custom_window", "Custom time"],
] as const;
const SLIPPAGE_CAP_OPTIONS = [["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"]] as const;
const COINBASE_INTERVALS = [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["1h", "1h"]] as const;
type JupiterQuoteStatus = "connecting" | "live" | "fallback_polling" | "blocked";

const QUICK_ACTIONS = [
  {
    title: "Pay a Ghola user",
    desc: "Best privacy path",
    actionClass: "pay",
    platformClass: "solana_private_balance",
    destinationClass: "ghola_user",
    destination: "@alice",
    productBucket: "stablecoin",
    assetBucket: "stablecoin",
  },
  {
    title: "Send to a wallet",
    desc: "Public chain may see it",
    actionClass: "transfer",
    platformClass: "solana_public_wallet",
    destinationClass: "external_public_address",
    destination: "wallet address",
    productBucket: "stablecoin",
    assetBucket: "stablecoin",
  },
  {
    title: "Trade on Hyperliquid",
    desc: "Main wallet stays out",
    actionClass: "trade_on_platform",
    platformClass: "hyperliquid_style_market",
    destinationClass: "platform_subaccount",
    destination: "Hyperliquid",
    productBucket: "perps",
    assetBucket: "ETH",
  },
  {
    title: "Trade on Phoenix",
    desc: "Stealth venue account",
    actionClass: "trade_on_platform",
    platformClass: "solana_perps_market",
    destinationClass: "platform_subaccount",
    destination: "Phoenix",
    productBucket: "perps",
    assetBucket: "SOL",
  },
  {
    title: "Swap on Jupiter",
    desc: "Private swap authority",
    actionClass: "trade_on_platform",
    platformClass: "solana_swap_aggregator",
    destinationClass: "platform_subaccount",
    destination: "Jupiter",
    productBucket: "swap",
    assetBucket: "SOL",
  },
  {
    title: "Use Coinbase",
    desc: "Provider sees activity",
    actionClass: "trade_on_platform",
    platformClass: "coinbase_style_provider",
    destinationClass: "platform_subaccount",
    destination: "Coinbase",
    productBucket: "provider",
    assetBucket: "BTC",
  },
] as const;

const DESTINATION_CHIPS = [
  { label: "Ghola user", value: "@alice", platformClass: "solana_private_balance" },
  { label: "Wallet", value: "wallet address", platformClass: "solana_public_wallet" },
  { label: "Hyperliquid", value: "Hyperliquid", platformClass: "hyperliquid_style_market" },
  { label: "Phoenix", value: "Phoenix", platformClass: "solana_perps_market" },
  { label: "Jupiter", value: "Jupiter", platformClass: "solana_swap_aggregator" },
  { label: "Coinbase", value: "Coinbase", platformClass: "coinbase_style_provider" },
  { label: "RFQ", value: "RFQ quote", platformClass: "rfq_solver_network" },
] as const;

const DEFAULT_INPUT: PrivateAccountSafeInput = {
  action_class: "pay",
  platform_class: "solana_private_balance",
  product_bucket: "stablecoin",
  amount_bucket: "25",
  urgency: "maximum_privacy",
  destination_class: "ghola_user",
  asset_bucket: "stablecoin",
  solver_count_bucket: "5+",
};

const DEFAULT_HYPERLIQUID_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "BTC",
  side: "buy",
  base_size: "0.001",
  limit_price: "10000",
  tif: "Gtc",
};

const LEGACY_HYPERLIQUID_API_KEYS_ENABLED =
  process.env.NEXT_PUBLIC_GHOLA_LEGACY_HYPERLIQUID_API_KEYS === "true";

const DEFAULT_HYPERLIQUID_LIVE_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "hyperliquid_style_market",
  product_bucket: "perps",
  amount_bucket: "25",
  urgency: "fast_degraded",
  destination_class: "platform_subaccount",
  asset_bucket: "BTC",
  solver_count_bucket: "5+",
};

const DEFAULT_HYPERLIQUID_LIVE_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "BTC",
  side: "buy",
  base_size: "",
  limit_price: "",
  quote_size: "11",
  max_slippage_bps: "50",
  order_type: "market",
  size_mode: "quote",
  tif: "Ioc",
  agent_strategy_profile: "trend_following",
  agent_entry_trigger: "preview_now",
  agent_exit_rule: "manual_approval",
  agent_time_horizon: "scalp",
  agent_edge_threshold_bps: "25",
  agent_strategy_note: "Preview current trend setup; do not submit until approval.",
};

const LAUNCH_AMOUNT_OPTIONS = [
  ["5", "$5"],
  ["10", "$10"],
  ["25", "$25"],
  ["50", "$50"],
  ["100", "$100"],
  ["250", "$250"],
  ["500", "$500"],
  ["1000", "$1,000"],
] as const;

const SMALL_LIVE_AMOUNT_OPTIONS = [
  ["5", "$5"],
  ["10", "$10"],
  ["25", "$25"],
] as const;

const LAUNCH_DAILY_CAP_OPTIONS = [
  ["25", "$25"],
  ["50", "$50"],
  ["100", "$100"],
  ["250", "$250"],
  ["500", "$500"],
  ["1000", "$1,000"],
  ["2500", "$2,500"],
  ["5000", "$5,000"],
] as const;

function smallLiveAmountBucket(bucket: PrivateAccountSafeInput["amount_bucket"]): PrivateAccountSafeInput["amount_bucket"] {
  return bucket === "5" || bucket === "10" || bucket === "25" ? bucket : "5";
}

const DEFAULT_PHOENIX_LIVE_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "solana_perps_market",
  product_bucket: "perps",
  amount_bucket: "5",
  urgency: "fast_degraded",
  destination_class: "platform_subaccount",
  asset_bucket: "SOL",
  solver_count_bucket: "5+",
};

const DEFAULT_JUPITER_LIVE_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "solana_swap_aggregator",
  product_bucket: "swap",
  amount_bucket: "5",
  urgency: "fast_degraded",
  destination_class: "platform_subaccount",
  asset_bucket: "SOL",
  solver_count_bucket: "5+",
};

const DEFAULT_COINBASE_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "coinbase_style_provider",
  product_bucket: "provider",
  amount_bucket: "5",
  urgency: "fast_degraded",
  destination_class: "platform_subaccount",
  asset_bucket: "BTC",
  solver_count_bucket: "5+",
};

const DEFAULT_PHOENIX_LIVE_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "phoenix",
  operation_class: "perp_limit_order",
  market: "SOL",
  side: "buy",
  base_size: "",
  limit_price: "250",
  quote_size: "5",
  max_slippage_bps: "50",
  order_type: "market",
  size_mode: "quote",
  tif: "Ioc",
};

const DEFAULT_JUPITER_LIVE_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "jupiter",
  operation_class: "swap",
  market: "SOL/USDC",
  side: "buy",
  base_size: "",
  limit_price: "",
  quote_size: "5",
  max_slippage_bps: "50",
  input_mint: JUPITER_SOL_MINT,
  output_mint: JUPITER_USDC_MINT,
  amount: "1000000",
  routing_mode: "meta_aggregator",
};

const DEFAULT_COINBASE_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "coinbase_advanced",
  operation_class: "spot_limit_order",
  market: "BTC-USD",
  side: "buy",
  base_size: "0.001",
  limit_price: "10000",
  tif: "gtc",
};

const TRADE_VENUES = [
  {
    title: "Phoenix",
    desc: "Live Solana perps, tiny IOC first",
    platformClass: "solana_perps_market",
    destination: "Phoenix",
  },
  {
    title: "Jupiter",
    desc: "Live private swaps, allowlisted mints",
    platformClass: "solana_swap_aggregator",
    destination: "Jupiter",
  },
  {
    title: "Hyperliquid",
    desc: "Venue sees the order",
    platformClass: "hyperliquid_style_market",
    destination: "Hyperliquid",
  },
  {
    title: "Coinbase",
    desc: "Provider-visible trading",
    platformClass: "coinbase_style_provider",
    destination: "Coinbase",
  },
] as const;

type TradePlatformClass = (typeof TRADE_VENUES)[number]["platformClass"];
type AlphaScoutVenueId = PrivateAutopilotSessionPolicy["venue_allowlist"][number];

const ALPHA_SCOUT_VENUES: Array<{ id: AlphaScoutVenueId; label: string; platformClass: TradePlatformClass }> = [
  { id: "hyperliquid", label: "HL", platformClass: "hyperliquid_style_market" },
  { id: "phoenix", label: "Phoenix", platformClass: "solana_perps_market" },
  { id: "jupiter", label: "Jupiter", platformClass: "solana_swap_aggregator" },
  { id: "coinbase_advanced", label: "Coinbase", platformClass: "coinbase_style_provider" },
];

const DEFAULT_ALPHA_SCOUT_MARKETS = ["BTC-USD", "ETH-USD", "SOL-USD"];

interface AgentVenueCard {
  platformClass: TradePlatformClass;
  title: string;
  detail: string;
  access: string;
  hidden: string;
  visible: string;
  tone: "good" | "warn";
}

interface IntentState {
  intent_id: string;
}

interface ExecutionState {
  receipt?: {
    receipt_commitment: string;
  };
  connector_result?: {
    work_order_commitment?: string;
    status?: string;
    final_proof?: {
      final_venue_execution_proven?: boolean;
      final_fill_proven?: boolean;
      filled_base_size?: string | null;
    } | null;
  } | null;
}

interface AccountStatusState {
  account?: {
    vault_ready?: boolean;
  };
}

interface HyperliquidVaultState {
  account_commitment?: string;
  ready?: boolean;
  execution_mode?: "byo_api_key" | "managed_testnet" | "ghola_pooled";
  hyperliquid_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    recipient_commitment: string;
    policy_commitment: string;
    status: string;
    supported_operations?: string[];
    blocked_operations?: string[];
  } | null;
  managed_allocation?: {
    allocation_commitment: string;
    policy_commitment: string;
    status: string;
    execution_mode?: "managed_testnet" | "ghola_pooled";
    network?: "testnet" | "mainnet";
    pool_share_commitment?: string | null;
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
  } | null;
}

interface HyperliquidAgentState {
  status: "armed" | "stopped";
  agent_session_commitment?: string;
  vault_commitment?: string;
  allocation_commitment?: string;
  execution_mode?: "byo_api_key" | "managed_testnet" | "ghola_pooled";
  session_policy?: {
    policy_commitment: string;
    max_notional_bucket: string;
    max_order_count: number;
    expires_at: string;
    kill_switch: boolean;
  };
}

interface SetupNoticeState {
  tone: "working" | "good" | "warn" | "bad";
  title: string;
  detail?: string;
}

interface VenueVaultState {
  account_commitment?: string;
  ready?: boolean;
  venue_id?: string;
  platform_class?: string;
  execution_mode?: "byo_api_key" | "partner_omnibus" | "user_stealth" | "ghola_pooled";
  venue_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    recipient_commitment: string;
    policy_commitment: string;
    allocation_commitment?: string | null;
    status: string;
    supported_operations?: string[];
    blocked_operations?: string[];
  } | null;
  omnibus_allocation?: OmnibusState["allocation"] | null;
  pooled_allocation?: {
    pooled_allocation_commitment: string;
    pool_commitment: string;
    pool_share_commitment?: string | null;
    subledger_account_commitment: string;
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
    settlement_evidence_commitment?: string | null;
    utilization_bucket?: string;
    status: string;
  } | null;
  eligibility?: {
    eligibility_commitment: string;
    status: string;
    expires_at?: string;
  } | null;
  eligibility_ready?: boolean;
}

interface OmnibusState {
  ready?: boolean;
  partner_omnibus_enabled?: boolean;
  pool_ready?: boolean;
  allocation?: {
    account_commitment?: string;
    allocation_commitment: string;
    pool_commitment: string;
    partner_commitment: string;
    subledger_account_commitment: string;
    settlement_funding_commitment?: string | null;
    utilization_bucket: string;
    status: string;
  } | null;
}

interface VenueAgentState {
  status: "armed" | "stopped";
  execution_mode?: "byo_api_key" | "partner_omnibus" | "user_stealth" | "ghola_pooled";
  agent_session_commitment?: string;
  vault_commitment?: string | null;
  allocation_commitment?: string | null;
  session_policy?: {
    policy_commitment: string;
    max_notional_bucket: string;
    max_order_count: number;
    expires_at: string;
    kill_switch: boolean;
  };
}

interface NoFundsVerificationState {
  status: "verified_no_funds" | "failed" | "worker_unavailable";
  verification_commitment?: string;
  reason?: string | null;
  live_readiness_certificate?: LiveReadinessCertificate;
  checks?: {
    sealed_vault_opened?: boolean;
    sealed_instruction_opened?: boolean;
    authority_derived?: boolean;
    policy_enforced?: boolean;
    live_gate_enforced?: boolean;
    rpc_reachable?: boolean;
    phoenix_sdk_ready?: boolean;
    order_packet_built?: boolean;
    api_wallet_loaded?: boolean;
    hyperliquid_api_reachable?: boolean;
    hyperliquid_sdk_ready?: boolean;
    account_read_checked?: boolean;
    order_request_built?: boolean;
    live_venue_checked?: boolean;
    jupiter_api_reachable?: boolean;
    jupiter_token_allowlist_passed?: boolean;
    jupiter_order_built?: boolean;
    jupiter_transaction_built?: boolean;
    coinbase_api_reachable?: boolean;
    coinbase_order_request_built?: boolean;
    transaction_broadcast?: boolean;
  };
}

interface HyperliquidNoSubmitResult {
  verification: NoFundsVerificationState;
  connection_proof_persisted?: boolean;
  connection_proof_reason?: string | null;
}

interface LiveReadinessCertificate {
  version: 1;
  certificate_kind: "ghola_live_readiness_certificate_v1";
  certificate_commitment: string;
  status: "ready_to_attempt_broadcast" | "not_ready" | "worker_unavailable";
  proof_level: "pre_broadcast_live_readiness";
  platform_class: string;
  venue_id: "phoenix" | "hyperliquid" | "jupiter" | "coinbase_advanced";
  work_order_commitment: string;
  manifest_commitment: string;
  connector_readiness_commitment: string;
  verification_commitment: string;
  result_commitment: string | null;
  provider_ref_commitment: string | null;
  site_origin_commitment: string | null;
  issued_at: string;
  expires_at: string;
  broadcast_performed: false;
  final_venue_execution_proven: false;
  final_fill_proven: false;
  transaction_simulation_status: "not_performed" | "passed" | "failed";
  checks: {
    production_site_reachable: boolean;
    private_agent_worker_reachable: boolean;
    sealed_vault_opened: boolean;
    sealed_instruction_opened: boolean;
    authority_derived: boolean;
    policy_enforced: boolean;
    live_gate_enforced: boolean;
    solana_rpc_reachable: boolean;
    phoenix_sdk_ready: boolean;
    order_packet_built: boolean;
    hyperliquid_api_reachable?: boolean;
    hyperliquid_sdk_ready?: boolean;
    account_read_checked?: boolean;
    order_request_built?: boolean;
    jupiter_api_reachable?: boolean;
    jupiter_token_allowlist_passed?: boolean;
    jupiter_order_built?: boolean;
    jupiter_transaction_built?: boolean;
    coinbase_api_reachable?: boolean;
    coinbase_order_request_built?: boolean;
    transaction_broadcast: false;
  };
  what_is_proven: string[];
  what_is_not_proven: string[];
  next_step: string;
}

interface QueueSummary {
  queue_id: string;
  status: string;
  current_anonymity_set: number;
  target_anonymity_set: number;
  requested_rail: string;
}

interface AuctionState {
  epochs?: Array<{
    auction_epoch_commitment: string;
    platform_class: string;
    asset_bucket: string;
    amount_bucket: string;
    status: string;
    order_count: number;
    matched_count: number;
    rolled_count: number;
    closes_at: string;
  }>;
  orders?: Array<{
    auction_order_commitment: string;
    auction_epoch_commitment: string;
    queue_id: string;
    side: string;
    status: string;
    asset_bucket: string;
    amount_bucket: string;
  }>;
  clearings?: Array<{
    clearing_commitment: string;
    auction_epoch_commitment: string;
    status: string;
    matched_order_commitments: string[];
    rolled_order_commitments: string[];
    settlement_commitment?: string | null;
  }>;
}

interface ReceiptSummary {
  receipt_commitment: string;
  claim_status: string;
  rail_used: string;
  public_chain_visibility: string;
  platform_visibility: string;
  evidence_commitment?: string | null;
  manifest_commitment?: string | null;
  connector_result_commitment?: string | null;
}

interface ReceiptEvidenceChain {
  batch_evidence_commitment?: string | null;
}

interface ReceiptDetailState {
  receipt?: {
    claim_status: string;
    hidden_from?: string[];
    evidence_chain?: ReceiptEvidenceChain | null;
    manifest_commitment?: string | null;
    connector_result_commitment?: string | null;
    runtime_envelope_commitment?: string | null;
    claim_levels_achieved?: string[];
    claim_levels_missing?: string[];
  };
  connector_context?: GholaPrivacyPreview["connector_context"];
  sealed_runtime_context?: GholaPrivacyPreview["sealed_runtime_context"];
  schedule_decision?: GholaPrivacyPreview["schedule_decision"];
  rotation?: GholaPrivacyPreview["rotation"];
  linkability_simulation?: GholaPrivacyPreview["linkability_simulation"];
}

interface ReceiptExportState {
  private_export?: {
    private_export_commitment: string;
    encrypted_receipt_commitment: string;
    encrypted_receipt_ciphertext?: string;
    revocation_commitment: string;
  };
  view_key?: {
    view_key_commitment: string;
  };
}

export type PrivateAccountInitialFlow = "hyperliquid-live" | "phoenix-live" | "jupiter-live" | "coinbase" | "trade" | null;

export function PrivateAccountCockpit({
  initialFlow = null,
  initialSetupVenue = null,
  initialReturnTo = null,
  initialHyperliquidMarket = null,
  initialIosReturnTo = null,
  hyperliquidNetwork,
}: {
  initialFlow?: PrivateAccountInitialFlow;
  initialSetupVenue?: "hyperliquid" | null;
  initialReturnTo?: string | null;
  initialHyperliquidMarket?: HyperliquidMarketSnapshot | null;
  initialIosReturnTo?: string | null;
  hyperliquidNetwork: "mainnet" | "testnet";
}) {
  const startsHyperliquid = initialFlow === "hyperliquid-live" || initialFlow === "trade" || initialSetupVenue === "hyperliquid";
  const initialHyperliquidMarketCoin = hyperliquidMarketFromTradeReturn(initialReturnTo) ?? "BTC";
  const startsPhoenix = initialFlow === "phoenix-live";
  const startsJupiter = initialFlow === "jupiter-live";
  const startsCoinbase = initialFlow === "coinbase";
  const auth = useThumperAuth();
  const turnkeyWallet = useTurnkeyWallet();
  const perpsTurnkey = usePerpsTurnkey();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [hyperliquidConnectOpen, setHyperliquidConnectOpen] = useState(false);
  const initialSetupHandled = useRef(false);
  const verifyHyperliquidAfterConnect = useRef(false);
  const [coinbaseConnectOpen, setCoinbaseConnectOpen] = useState(false);
  const [phoenixConnectOpen, setPhoenixConnectOpen] = useState(false);
  const [jupiterConnectOpen, setJupiterConnectOpen] = useState(false);
  const [tradeFlow, setTradeFlow] = useState(startsHyperliquid || startsPhoenix || startsJupiter || startsCoinbase);
  const [liveHyperliquidFlow, setLiveHyperliquidFlow] = useState(startsHyperliquid);
  const [livePhoenixFlow, setLivePhoenixFlow] = useState(startsPhoenix);
  const [liveJupiterFlow, setLiveJupiterFlow] = useState(startsJupiter);
  const [input, setInput] = useState<PrivateAccountSafeInput>(
    startsHyperliquid
      ? { ...DEFAULT_HYPERLIQUID_LIVE_INPUT, asset_bucket: hyperliquidAssetBucket(initialHyperliquidMarketCoin) }
      : startsCoinbase
        ? DEFAULT_COINBASE_INPUT
      : startsJupiter
        ? DEFAULT_JUPITER_LIVE_INPUT
      : startsPhoenix
        ? DEFAULT_PHOENIX_LIVE_INPUT
        : DEFAULT_INPUT,
  );
  const [orderDraft, setOrderDraft] = useState<PrivateExecutionOrderDraft>(
    startsHyperliquid
      ? { ...DEFAULT_HYPERLIQUID_LIVE_ORDER, market: initialHyperliquidMarketCoin }
      : startsCoinbase
        ? DEFAULT_COINBASE_ORDER
      : startsJupiter
        ? DEFAULT_JUPITER_LIVE_ORDER
      : startsPhoenix
        ? DEFAULT_PHOENIX_LIVE_ORDER
        : DEFAULT_HYPERLIQUID_ORDER,
  );
  const [destinationQuery, setDestinationQuery] = useState(
    startsHyperliquid ? "Hyperliquid" : startsCoinbase ? "Coinbase" : startsJupiter ? "Jupiter" : startsPhoenix ? "Phoenix" : "@alice",
  );
  const [readiness, setReadiness] = useState<PrivateAccountReadinessResponse | null>(null);
  const [intent, setIntent] = useState<IntentState | null>(null);
  const [preview, setPreview] = useState<GholaPrivacyPreview | null>(null);
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [ambiguousPreviewCommitment, setAmbiguousPreviewCommitment] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [accountStatus, setAccountStatus] = useState<AccountStatusState | null>(null);
  const [hyperliquidVault, setHyperliquidVault] = useState<HyperliquidVaultState | null>(null);
  const [hyperliquidAgent, setHyperliquidAgent] = useState<HyperliquidAgentState | null>(null);
  const [hyperliquidAccount, setHyperliquidAccount] = useState<HyperliquidAccountSnapshot | null>(null);
  const [hyperliquidAccountStreamStatus, setHyperliquidAccountStreamStatus] = useState<HyperliquidAccountStreamStatus>("connecting");
  const [hyperliquidVerification, setHyperliquidVerification] = useState<NoFundsVerificationState | null>(null);
  const [hyperliquidOwnerAuthConfirmed, setHyperliquidOwnerAuthConfirmed] = useState(false);
  const [hyperliquidInterval, setHyperliquidInterval] = useState<"1m" | "5m" | "15m" | "1h">("5m");
  const [hyperliquidSetupNotice, setHyperliquidSetupNotice] = useState<SetupNoticeState | null>(null);
  const [hyperliquidLaunchAccepted, setHyperliquidLaunchAccepted] = useState(false);
  const [coinbaseVault, setCoinbaseVault] = useState<VenueVaultState | null>(null);
  const [phoenixVault, setPhoenixVault] = useState<VenueVaultState | null>(null);
  const [jupiterVault, setJupiterVault] = useState<VenueVaultState | null>(null);
  const [omnibus, setOmnibus] = useState<OmnibusState | null>(null);
  const [coinbaseAgent, setCoinbaseAgent] = useState<VenueAgentState | null>(null);
  const [coinbaseVerification, setCoinbaseVerification] = useState<NoFundsVerificationState | null>(null);
  const [coinbaseInterval, setCoinbaseInterval] = useState<CoinbaseCandleInterval>("5m");
  const [phoenixAgent, setPhoenixAgent] = useState<VenueAgentState | null>(null);
  const [phoenixVerification, setPhoenixVerification] = useState<NoFundsVerificationState | null>(null);
  const [jupiterAgent, setJupiterAgent] = useState<VenueAgentState | null>(null);
  const [jupiterVerification, setJupiterVerification] = useState<NoFundsVerificationState | null>(null);
  const [jupiterQuote, setJupiterQuote] = useState<MobileMarketJupiter | null>(null);
  const [jupiterQuoteStatus, setJupiterQuoteStatus] = useState<JupiterQuoteStatus>("connecting");

  const [phoenixInterval, setPhoenixInterval] = useState<PhoenixCandleInterval>("1m");
  const hyperliquidMarketCoin = marketCoinFromOrder(orderDraft.market);
  const coinbaseProduct = coinbaseProductFromOrder(orderDraft.market);
  useEffect(() => {
    if (input.platform_class !== "hyperliquid_style_market" || orderDraft.size_mode === "base") return;
    const quoteSize = Number(orderDraft.quote_size);
    if (!Number.isFinite(quoteSize) || quoteSize <= 0 || Number(input.amount_bucket) >= quoteSize) return;
    const cap = quoteSize <= 10 ? "10" : quoteSize <= 25 ? "25" : quoteSize <= 50 ? "50" : "100";
    setInput((current) => current.platform_class === "hyperliquid_style_market" && Number(current.amount_bucket) < quoteSize
      ? { ...current, amount_bucket: cap }
      : current);
  }, [input.amount_bucket, input.platform_class, orderDraft.quote_size, orderDraft.size_mode]);
  const hyperliquidMarketRecord = useMarketData({
    venue: "hyperliquid",
    network: hyperliquidNetwork,
    coin: hyperliquidMarketCoin,
    interval: hyperliquidInterval,
  }, input.platform_class === "hyperliquid_style_market");
  const coinbaseMarketRecord = useMarketData({
    venue: "coinbase",
    productId: coinbaseProduct,
    interval: coinbaseInterval,
  }, input.platform_class === "coinbase_style_provider");
  const phoenixMarketRecord = useMarketData({
    venue: "phoenix",
    network: "mainnet",
    symbol: "SOL",
    interval: phoenixInterval,
  }, input.platform_class === "solana_perps_market");
  const hyperliquidMarket = hyperliquidMarketRecord.snapshot?.platform === "hyperliquid"
    ? hyperliquidMarketRecord.snapshot
    : startsHyperliquid ? initialHyperliquidMarket : null;
  const hyperliquidReferencePrice = liveHyperliquidReferencePrice(hyperliquidMarket);
  const hyperliquidMarketStatus = hyperliquidMarketRecord.status as HyperliquidLiveMarketStatus;
  const coinbaseMarket = coinbaseMarketRecord.snapshot?.platform === "coinbase" ? coinbaseMarketRecord.snapshot : null;
  const coinbaseMarketStatus = coinbaseMarketRecord.status as CoinbaseLiveMarketStatus;
  const phoenixMarket = phoenixMarketRecord.snapshot?.platform === "phoenix" ? phoenixMarketRecord.snapshot : null;
  const phoenixMarketStatus = phoenixMarketRecord.status as PhoenixLiveMarketStatus;
  const [queue, setQueue] = useState<QueueSummary[]>([]);
  const [auctions, setAuctions] = useState<AuctionState | null>(null);
  const [autopilotSessions, setAutopilotSessions] = useState<PrivateAutopilotSession[]>([]);
  const [autopilotEvents, setAutopilotEvents] = useState<PrivateAutopilotEvent[]>([]);
  const [autopilotReplay, setAutopilotReplay] = useState<PrivateAutopilotReplayResponse | null>(null);
  const [autopilotReadiness, setAutopilotReadiness] = useState<PrivateAutopilotReadiness | null>(null);
  const [liveTradingStatus, setLiveTradingStatus] = useState<PrivateAccountLiveTradingStatus | null>(null);
  const [autopilotStreamStatus, setAutopilotStreamStatus] = useState<"connecting" | "live" | "reconnecting" | "closed">("closed");
  const [receiptDetail, setReceiptDetail] = useState<ReceiptDetailState | null>(null);
  const [receiptExport, setReceiptExport] = useState<ReceiptExportState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iosReturnTo, setIosReturnTo] = useState<string | null>(initialIosReturnTo);
  const activeAutopilotSession = autopilotSessions.find((session) =>
    session.status !== "killed" && session.status !== "expired"
  ) || autopilotSessions[0] || null;

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const flow = query.get("flow");
    if (
      query.get("source") === "ios" &&
      query.get("return_to") === "ghola://trading/setup-complete"
    ) {
      setIosReturnTo("ghola://trading/setup-complete");
    }
    if (flow === "hyperliquid-live") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(true);
      setLivePhoenixFlow(false);
      setLiveJupiterFlow(false);
      setInput(DEFAULT_HYPERLIQUID_LIVE_INPUT);
      setOrderDraft(DEFAULT_HYPERLIQUID_LIVE_ORDER);
      setDestinationQuery("Hyperliquid");
      return;
    }
    if (flow === "jupiter-live") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(false);
      setLivePhoenixFlow(false);
      setLiveJupiterFlow(true);
      setInput(DEFAULT_JUPITER_LIVE_INPUT);
      setOrderDraft(DEFAULT_JUPITER_LIVE_ORDER);
      setDestinationQuery("Jupiter");
      return;
    }
    if (flow === "trade") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(true);
      setLivePhoenixFlow(false);
      setLiveJupiterFlow(false);
      setInput(DEFAULT_HYPERLIQUID_LIVE_INPUT);
      setOrderDraft(DEFAULT_HYPERLIQUID_LIVE_ORDER);
      setDestinationQuery("Hyperliquid");
      return;
    }
    if (flow === "phoenix-live") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(false);
      setLivePhoenixFlow(true);
      setLiveJupiterFlow(false);
      setInput(DEFAULT_PHOENIX_LIVE_INPUT);
      setOrderDraft(DEFAULT_PHOENIX_LIVE_ORDER);
      setDestinationQuery("Phoenix");
      return;
    }
    if (flow === "coinbase") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(false);
      setLivePhoenixFlow(false);
      setLiveJupiterFlow(false);
      setInput(DEFAULT_COINBASE_INPUT);
      setOrderDraft(DEFAULT_COINBASE_ORDER);
      setDestinationQuery("Coinbase");
    }
  }, []);

  const refreshReceipts = useCallback(async () => {
    try {
      const body = await listPrivateAccountReceipts(10);
      setReceipts(body.receipts || []);
    } catch {
      setReceipts([]);
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const body = await listPrivateAccountQueue(25);
      setQueue(body.queued_actions || []);
    } catch {
      setQueue([]);
    }
  }, []);

  const refreshAuctions = useCallback(async () => {
    try {
      setAuctions(await listPrivateAccountAuctions(25));
    } catch {
      setAuctions(null);
    }
  }, []);

  const refreshAutopilotState = useCallback(async () => {
    try {
      const [sessionsBody, readinessBody] = await Promise.all([
        listPrivateAutopilotSessions(),
        getPrivateAutopilotReadiness(marketForAutopilotReadiness(orderDraft.market)),
      ]);
      setAutopilotSessions(sessionsBody.autopilot_sessions || []);
      setAutopilotReadiness(readinessBody);
    } catch {
      setAutopilotSessions([]);
      setAutopilotReadiness(null);
    }
  }, [orderDraft.market]);

  const refreshHyperliquidVault = useCallback(async () => {
    try {
      setHyperliquidVault(await getHyperliquidExecutionVaultStatus());
    } catch {
      setHyperliquidVault(null);
    }
  }, []);

  const refreshHyperliquidAccountSnapshot = useCallback(async () => {
    try {
      setHyperliquidAccount(await getHyperliquidAccountSnapshot());
    } catch {
      setHyperliquidAccount(null);
    }
  }, []);

  const refreshCoinbaseState = useCallback(async () => {
    try {
      const [vault, pool] = await Promise.all([
        getVenueExecutionVaultStatus({ platform_class: "coinbase_style_provider" }),
        getPrivateAccountOmnibusStatus(),
      ]);
      setCoinbaseVault(vault);
      setOmnibus(pool);
    } catch {
      setCoinbaseVault(null);
      setOmnibus(null);
    }
  }, []);

  const refreshPhoenixState = useCallback(async () => {
    try {
      setPhoenixVault(await getVenueExecutionVaultStatus({ platform_class: "solana_perps_market" }));
    } catch {
      setPhoenixVault(null);
    }
  }, []);

  const refreshJupiterState = useCallback(async () => {
    try {
      setJupiterVault(await getVenueExecutionVaultStatus({ platform_class: "solana_swap_aggregator" }));
    } catch {
      setJupiterVault(null);
    }
  }, []);

  const refreshAccountState = useCallback(async () => {
    await Promise.all([
      getPrivateExecutionAccountStatus().then(setAccountStatus).catch(() => setAccountStatus(null)),
      getPrivateAccountLiveTradingStatus().then(setLiveTradingStatus).catch(() => setLiveTradingStatus(null)),
      refreshHyperliquidVault(),
      refreshHyperliquidAccountSnapshot(),
      refreshCoinbaseState(),
      refreshPhoenixState(),
      refreshJupiterState(),
      refreshReceipts(),
      refreshQueue(),
      refreshAuctions(),
      refreshAutopilotState(),
    ]);
  }, [refreshAuctions, refreshAutopilotState, refreshCoinbaseState, refreshHyperliquidAccountSnapshot, refreshHyperliquidVault, refreshJupiterState, refreshPhoenixState, refreshQueue, refreshReceipts]);

  useEffect(() => {
    let cancelled = false;
    getPrivateAccountPlatformReadiness()
      .then((body) => {
        if (!cancelled) setReadiness(body);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getPrivateAccountLiveTradingStatus()
      .then((body) => {
        if (!cancelled) setLiveTradingStatus(body);
      })
      .catch(() => {
        if (!cancelled) setLiveTradingStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (input.platform_class !== "solana_swap_aggregator") return;
    let cancelled = false;
    let timer: number | null = null;
    setJupiterQuoteStatus("connecting");

    const refresh = async () => {
      try {
        const quote = await fetchJupiterRouteQuoteSnapshot();
        if (cancelled) return;
        setJupiterQuote(quote);
        setJupiterQuoteStatus(quote && !quote.stale ? "live" : "fallback_polling");
      } catch {
        if (cancelled) return;
        setJupiterQuoteStatus("blocked");
      }
    };

    void refresh();
    timer = window.setInterval(refresh, 3_500);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [input.platform_class]);

  useEffect(() => {
    if (!auth.authenticated || input.platform_class !== "hyperliquid_style_market") return;
    setHyperliquidAccountStreamStatus("connecting");
    const stream = openHyperliquidAccountStream({
      coin: hyperliquidMarketCoin,
      onState: setHyperliquidAccount,
      onStatus: setHyperliquidAccountStreamStatus,
      onError: () => {
        setHyperliquidAccountStreamStatus("worker_unavailable");
        setHyperliquidAccount((current) => current
          ? { ...current, stream_status: "worker_unavailable" }
          : null);
      },
    });
    return () => {
      stream.close();
    };
  }, [auth.authenticated, hyperliquidAgent?.status, hyperliquidMarketCoin, hyperliquidVault?.ready, input.platform_class]);

  useEffect(() => {
    if (!auth.authenticated || !activeAutopilotSession?.autopilot_session_id) return;
    setAutopilotStreamStatus("connecting");
    setAutopilotEvents([]);
    const stream = openPrivateAutopilotEventStream({
      autopilotSessionId: activeAutopilotSession.autopilot_session_id,
      onSession: (session) => {
        setAutopilotSessions((current) => upsertAutopilotSession(current, session));
      },
      onEvent: (event) => {
        setAutopilotEvents((current) => upsertAutopilotEvent(current, event));
      },
      onStatus: setAutopilotStreamStatus,
      onError: () => setAutopilotStreamStatus("reconnecting"),
    });
    return () => {
      stream.close();
    };
  }, [activeAutopilotSession?.autopilot_session_id, auth.authenticated]);

  useEffect(() => {
    if (!auth.authenticated || !activeAutopilotSession?.autopilot_session_id) {
      setAutopilotReplay(null);
      return;
    }
    let cancelled = false;
    const sessionId = activeAutopilotSession.autopilot_session_id;
    getPrivateAutopilotReplay(sessionId)
      .then((body) => {
        if (!cancelled) setAutopilotReplay(body);
      })
      .catch(() => {
        if (!cancelled) setAutopilotReplay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAutopilotSession?.autopilot_session_id, auth.authenticated, autopilotEvents.length]);

  useEffect(() => {
    if (!auth.authenticated) {
      setReceipts([]);
      setQueue([]);
      setAuctions(null);
      setAutopilotSessions([]);
      setAutopilotEvents([]);
      setAutopilotReplay(null);
      setAutopilotReadiness(null);
      setAutopilotStreamStatus("closed");
      setAccountStatus(null);
      setHyperliquidVault(null);
      setHyperliquidAgent(null);
      setHyperliquidAccount(null);
      setHyperliquidAccountStreamStatus("connecting");
      setHyperliquidVerification(null);
      setHyperliquidSetupNotice(null);
      setCoinbaseVault(null);
      setCoinbaseVerification(null);
      setPhoenixVault(null);
      setPhoenixVerification(null);
      setJupiterVault(null);
      setJupiterVerification(null);
      setOmnibus(null);
      setCoinbaseAgent(null);
      setPhoenixAgent(null);
      setJupiterAgent(null);
      setHyperliquidConnectOpen(false);
      setCoinbaseConnectOpen(false);
      setPhoenixConnectOpen(false);
      setJupiterConnectOpen(false);
      return;
    }
    void refreshAccountState();
  }, [auth.authenticated, refreshAccountState]);

  useEffect(() => {
    if (
      initialSetupHandled.current ||
      initialSetupVenue !== "hyperliquid" ||
      !auth.authenticated ||
      !hyperliquidVault?.account_commitment ||
      !turnkeyWallet.walletAddress ||
      hyperliquidReferencePrice === null
    ) return;
    initialSetupHandled.current = true;
    setLiveHyperliquidFlow(true);
    if (hyperliquidVault.hyperliquid_execution_vault?.status === "sealed") {
      verifyHyperliquidAfterConnect.current = true;
      void verifyHyperliquidNoSubmit(hyperliquidVault);
      return;
    }
    setHyperliquidConnectOpen(true);
  // This is a one-shot setup transition guarded by initialSetupHandled.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    auth.authenticated,
    hyperliquidVault,
    hyperliquidVault?.account_commitment,
    hyperliquidReferencePrice,
    initialSetupVenue,
    turnkeyWallet.walletAddress,
  ]);

  async function runPreview() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    if (requiresHyperliquidPoolTerms({
      liveHyperliquidFlow,
      executionMode: hyperliquidVault?.managed_allocation?.execution_mode,
    }) && !hyperliquidLaunchAccepted) {
      setHyperliquidSetupNotice({
        tone: "warn",
        title: "Terms acceptance required",
        detail: "Accept the non-US beta terms and risk disclosure before using the Ghola pool.",
      });
      return;
    }
    setWorking(true);
    setError(null);
    setExecution(null);
    setAmbiguousPreviewCommitment(null);
    try {
      const nextIntent = await createPrivateAccountIntent(input);
      const runtimeEnvelope = await createPrivateAccountRuntimeEnvelope({
        intent_id: nextIntent.intent_id,
        safe_input: input,
      });
      const nextPreview = await previewPrivateAccountAction({
        intent_id: nextIntent.intent_id,
        safe_input: input,
        requested_rail: recommendedRail({ safe_input: input, readiness }) || undefined,
        runtime_envelope_commitment: runtimeEnvelope.runtime_envelope?.runtime_envelope_commitment,
      });
      setIntent(nextIntent);
      setPreview(nextPreview.preview);
      await refreshAccountState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Private preview failed.");
    } finally {
      setWorking(false);
    }
  }

  async function approveAndMaybeExecute(degradedAccepted: boolean) {
    if (!intent || !preview) return;
    setWorking(true);
    setError(null);
    try {
      const isPrivateExecution =
        input.action_class === "trade_on_platform" &&
        (input.platform_class === "hyperliquid_style_market" ||
          input.platform_class === "coinbase_style_provider" ||
          input.platform_class === "solana_perps_market" ||
          input.platform_class === "solana_swap_aggregator");
      let encryptedInstruction: unknown;
      if (isPrivateExecution) {
        if (
          input.platform_class === "solana_perps_market" &&
          phoenixVerification?.status !== "verified_no_funds"
        ) {
          throw new Error("phoenix_connection_check_required");
        }
        if (
          input.platform_class === "solana_swap_aggregator" &&
          jupiterVerification?.status !== "verified_no_funds"
        ) {
          throw new Error("jupiter_connection_check_required");
        }
        if (
          input.platform_class === "coinbase_style_provider" &&
          coinbaseVerification?.status !== "verified_no_funds"
        ) {
          throw new Error("coinbase_connection_check_required");
        }
        if (
          liveHyperliquidFlow &&
          input.platform_class === "hyperliquid_style_market" &&
          hyperliquidVerification?.status !== "verified_no_funds"
        ) {
          throw new Error("hyperliquid_connection_check_required");
        }
        let sealingAddress = turnkeyWallet.walletAddress;
        let signInstructionBytes = turnkeyWallet.signBytes;
        if (
          input.platform_class === "hyperliquid_style_market" &&
          !LEGACY_HYPERLIQUID_API_KEYS_ENABLED
        ) {
          if (!perpsTurnkey.configured || !perpsTurnkey.authenticated || !hyperliquidOwnerAuthConfirmed) {
            throw new Error("Authenticate with the Turnkey owner wallet first.");
          }
          const pair = await perpsTurnkey.ensureWalletPair();
          sealingAddress = pair.sealing.address;
          signInstructionBytes = perpsTurnkey.signSealingBytes;
        }
        if (!sealingAddress) throw new Error("Turnkey wallet identity is unavailable.");
        const normalizedOrder = normalizeOrderForPlatform(orderDraft, input.platform_class);
        const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
        if (validationErrors.length > 0) throw new Error(validationErrors[0]);
        const sealed = await buildPrivateExecutionInstructionBundle({
          ownerWalletAddress: sealingAddress,
          previewCommitment: preview.preview_commitment,
          order: normalizedOrder,
          signBytes: signInstructionBytes,
        });
        encryptedInstruction = sealed.encrypted_execution_instruction_bundle;
      }
      const nextApproval = await approvePrivateAccountAction({
        intent_id: intent.intent_id,
        preview_commitment: preview.preview_commitment,
        degraded_accepted: degradedAccepted,
      });
      const nextExecution = await executePrivateAccountAction({
        intent_id: intent.intent_id,
        preview_commitment: preview.preview_commitment,
        approval_commitment: nextApproval.approval.approval_commitment,
        encrypted_execution_instruction_bundle: encryptedInstruction,
      });
      setExecution(nextExecution);
      setAmbiguousPreviewCommitment(null);
      await refreshReceipts();
    } catch (err) {
      if (err instanceof Error && err.message === "connector_submit_ambiguous") {
        setAmbiguousPreviewCommitment(preview.preview_commitment);
      }
      setError(friendlyPrivateAccountError(err, "Private execution failed."));
    } finally {
      setWorking(false);
    }
  }

  async function reconcileAmbiguousHyperliquid() {
    if (!ambiguousPreviewCommitment) return;
    setWorking(true);
    try {
      const reconciled = await reconcilePrivateAccountConnector({
        preview_commitment: ambiguousPreviewCommitment,
      });
      setExecution(reconciled);
      if (reconciled.connector_result?.status === "ambiguous") {
        setError(friendlyPrivateAccountError(new Error("connector_submit_ambiguous"), "Reconciliation is still pending."));
      } else {
        setAmbiguousPreviewCommitment(null);
        setError(null);
      }
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not reconcile the Hyperliquid order."));
    } finally {
      setWorking(false);
    }
  }

  function prepareHyperliquidReduceOnlyClose() {
    const finalProof = execution?.connector_result?.final_proof;
    const filledBaseSize = finalProof?.filled_base_size?.trim() || "";
    if (
      finalProof?.final_venue_execution_proven !== true ||
      finalProof.final_fill_proven !== true ||
      !Number.isFinite(Number(filledBaseSize)) ||
      Number(filledBaseSize) <= 0
    ) {
      setError("A proven entry fill with an exact base size is required before Ghola can prepare the close.");
      return;
    }
    const referencePrice = hyperliquidMarket?.mark_price || hyperliquidMarket?.mid || orderDraft.limit_price;
    setInput((current) => ({ ...current, amount_bucket: "25" }));
    setOrderDraft(normalizeOrderForPlatform({
      ...orderDraft,
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      side: orderDraft.side === "buy" ? "sell" : "buy",
      base_size: filledBaseSize,
      quote_size: undefined,
      limit_price: referencePrice || orderDraft.limit_price,
      order_type: "market",
      size_mode: "base",
      reduce_only: true,
      live_order_mode: undefined,
      tif: "Ioc",
      protective_orders: undefined,
    }, "hyperliquid_style_market"));
    setIntent(null);
    setPreview(null);
    setExecution(null);
    setError(null);
    setHyperliquidSetupNotice({
      tone: "warn",
      title: "Reduce-only close prepared",
      detail: "Preview it, then approve the close. Hyperliquid cannot increase the position from this order.",
    });
  }

  async function queueForPrivacy() {
    if (!intent || !preview) return;
    setWorking(true);
    setError(null);
    try {
      await queuePrivateAccountAction({
        intent_id: intent.intent_id,
        preview_commitment: preview.preview_commitment,
      });
      await refreshQueue();
      await refreshAuctions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue this action.");
    } finally {
      setWorking(false);
    }
  }

  async function refreshQueued(queueId: string) {
    setWorking(true);
    setError(null);
    try {
      const body = await refreshPrivateAccountQueue({ queue_id: queueId, safe_input: input });
      if (body.preview) {
        setPreview(body.preview);
      }
      await refreshQueue();
      await refreshAuctions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh queued action.");
    } finally {
      setWorking(false);
    }
  }

  async function cancelQueued(queueId: string) {
    setWorking(true);
    setError(null);
    try {
      await cancelPrivateAccountQueue({ queue_id: queueId });
      await refreshQueue();
      await refreshAuctions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel queued action.");
    } finally {
      setWorking(false);
    }
  }

  async function commitQueuedToAuction(queueId: string) {
    setWorking(true);
    setError(null);
    try {
      await commitPrivateAccountAuction({
        queue_id: queueId,
        side: orderDraft.side === "sell" ? "sell" : "buy",
        amount_bucket: input.amount_bucket,
        asset_bucket: input.asset_bucket,
      });
      await Promise.all([refreshQueue(), refreshAuctions()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not commit auction order.");
    } finally {
      setWorking(false);
    }
  }

  async function settleAuction(clearingCommitment: string) {
    setWorking(true);
    setError(null);
    try {
      await settlePrivateAccountAuction({ clearing_commitment: clearingCommitment });
      await refreshAuctions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not settle auction clearing.");
    } finally {
      setWorking(false);
    }
  }

  async function loadReceiptDetail(receiptCommitment: string) {
    setError(null);
    try {
      setReceiptDetail(await getPrivateAccountReceiptDetail(receiptCommitment));
      setReceiptExport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load receipt detail.");
    }
  }

  async function exportReceipt(receiptCommitment: string) {
    setError(null);
    try {
      setReceiptExport(await exportPrivateAccountPrivateReceipt({
        receipt_commitment: receiptCommitment,
        scope: "user_private_receipt",
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export receipt.");
    }
  }

  async function selectCoinbasePreview() {
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setPhoenixVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
    setLiveHyperliquidFlow(false);
    setLivePhoenixFlow(false);
    setLiveJupiterFlow(false);
    setInput({
      ...input,
      action_class: "trade_on_platform",
      platform_class: "coinbase_style_provider",
      product_bucket: "provider",
      destination_class: "platform_subaccount",
      asset_bucket: input.asset_bucket === "stablecoin" ? "BTC" : input.asset_bucket,
    });
    setOrderDraft((current) =>
      current.venue_id === "coinbase_advanced" ? current : DEFAULT_COINBASE_ORDER
    );
    setDestinationQuery("Coinbase");
  }

  async function selectPhoenixPreview() {
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setPhoenixVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
    setInput({
      ...input,
      ...DEFAULT_PHOENIX_LIVE_INPUT,
      amount_bucket: smallLiveAmountBucket(input.amount_bucket),
    });
    setOrderDraft((current) =>
      current.venue_id === "phoenix" ? current : DEFAULT_PHOENIX_LIVE_ORDER
    );
    setDestinationQuery("Phoenix");
    setLivePhoenixFlow(true);
    setLiveHyperliquidFlow(false);
    setLiveJupiterFlow(false);
  }

  async function selectJupiterPreview() {
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setPhoenixVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
    setInput({
      ...input,
      ...DEFAULT_JUPITER_LIVE_INPUT,
      amount_bucket: smallLiveAmountBucket(input.amount_bucket),
    });
    setOrderDraft((current) =>
      current.venue_id === "jupiter" ? current : DEFAULT_JUPITER_LIVE_ORDER
    );
    setDestinationQuery("Jupiter");
    setLivePhoenixFlow(false);
    setLiveHyperliquidFlow(false);
    setLiveJupiterFlow(true);
  }

  function selectHyperliquidMarket(market: "BTC" | "ETH" | "SOL" | "HYPE") {
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
    setInput({
      ...input,
      platform_class: "hyperliquid_style_market",
      action_class: "trade_on_platform",
      product_bucket: "perps",
      destination_class: "platform_subaccount",
      asset_bucket: hyperliquidAssetBucket(market),
    });
    setOrderDraft(normalizeOrderForPlatform({
      ...orderDraft,
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      market,
    }, "hyperliquid_style_market"));
    setDestinationQuery("Hyperliquid");
    setLiveJupiterFlow(false);
  }

  function selectCoinbaseProduct(productId: CoinbaseProductId) {
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setPhoenixVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
    setLiveHyperliquidFlow(false);
    setLivePhoenixFlow(false);
    setLiveJupiterFlow(false);
    setInput({
      ...input,
      platform_class: "coinbase_style_provider",
      action_class: "trade_on_platform",
      product_bucket: "provider",
      destination_class: "platform_subaccount",
      asset_bucket: coinbaseAssetBucket(productId),
    });
    setOrderDraft(normalizeOrderForPlatform({
      ...orderDraft,
      venue_id: "coinbase_advanced",
      operation_class: "spot_limit_order",
      market: productId,
    }, "coinbase_style_provider"));
    setDestinationQuery("Coinbase");
  }

  async function ensureHyperliquidSigningWallet(options: { manageWorking?: boolean } = {}) {
    const manageWorking = options.manageWorking !== false;
    if (turnkeyWallet.walletAddress) {
      if (!hyperliquidVault?.account_commitment) {
        setHyperliquidSetupNotice({
          tone: "working",
          title: "Preparing Ghola account",
          detail: "Creating the private account commitment for Hyperliquid.",
        });
        const state = await getHyperliquidExecutionVaultStatus();
        setHyperliquidVault(state);
        setHyperliquidSetupNotice({
          tone: "good",
          title: "Ghola account ready",
          detail: "Paste the Hyperliquid API wallet to continue.",
        });
      }
      return true;
    }
    if (turnkeyWallet.loading) {
      setError("Ghola is still preparing your account. Try again in a moment.");
      setHyperliquidSetupNotice({
        tone: "warn",
        title: "Still preparing",
        detail: "Try again in a moment.",
      });
      return false;
    }
    if (manageWorking) setWorking(true);
    setError(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: "Preparing Ghola account",
      detail: "Creating the signing wallet and private account commitment.",
    });
    try {
      await turnkeyWallet.createWallet(auth.user?.email || "ghola-user");
      const state = await getHyperliquidExecutionVaultStatus();
      setHyperliquidVault(state);
      setHyperliquidSetupNotice({
        tone: "good",
        title: "Ghola account ready",
        detail: "Paste the Hyperliquid API wallet to continue.",
      });
      return true;
    } catch (err) {
      const message = friendlyPrivateAccountError(err, "Could not prepare your Ghola signing wallet.");
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Could not prepare account",
        detail: message,
      });
      return false;
    } finally {
      if (manageWorking) setWorking(false);
    }
  }

  async function openHyperliquidConnection() {
    if (!auth.authenticated) {
      setHyperliquidSetupNotice({
        tone: "warn",
        title: "Sign in required",
        detail: "Sign in first, then connect the Hyperliquid API wallet.",
      });
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    const ready = await ensureHyperliquidSigningWallet();
    if (!ready) return;
    setHyperliquidConnectOpen(true);
  }

  useEffect(() => {
    if (!auth.authenticated || !iosReturnTo || hyperliquidConnectOpen) return;
    void openHyperliquidConnection();
    // This is a one-time handoff from the native companion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.authenticated, iosReturnTo]);

  async function armHyperliquidAgent(killSwitch = false) {
    setWorking(true);
    setError(null);
    setHyperliquidVerification(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: "Enabling Hyperliquid",
      detail: "Binding the selected account to Ghola's execution policy.",
    });
    try {
      const armed = await armHyperliquidExecutionAgent({
        execution_mode: hyperliquidVault?.managed_allocation?.status === "allocated"
          ? hyperliquidVault.managed_allocation.execution_mode ?? "managed_testnet"
          : "byo_api_key",
        market_allowlist: defaultHyperliquidMarketAllowlist(),
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: killSwitch,
      });
      setHyperliquidAgent(armed);
      await refreshHyperliquidAccountSnapshot();
      setHyperliquidSetupNotice({
        tone: "good",
        title: liveHyperliquidFlow ? "Hyperliquid enabled" : "Hyperliquid ready",
        detail: liveHyperliquidFlow ? "Next step: check the connection." : "Next step: preview the trade.",
      });
    } catch (err) {
      const reconnectRequired = shouldReconnectHyperliquidApiWallet(err);
      const message = friendlyPrivateAccountError(err, "Could not arm Hyperliquid.");
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Could not enable Hyperliquid",
        detail: message,
      });
      if (reconnectRequired) setHyperliquidConnectOpen(true);
    } finally {
      setWorking(false);
    }
  }

  async function allocateHyperliquidManaged() {
    if (!auth.authenticated) {
      setHyperliquidSetupNotice({
        tone: "warn",
        title: "Sign in required",
        detail: liveHyperliquidFlow
          ? "Sign in first, then Ghola can create Hyperliquid trading access."
          : "Sign in first, then Ghola can prepare the test account.",
      });
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    setPreview(null);
    setExecution(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: liveHyperliquidFlow ? "Creating Hyperliquid access" : "Preparing Ghola test account",
      detail: liveHyperliquidFlow
        ? "Checking the Ghola pool and venue eligibility before allocating access."
        : "Allocating the account and enabling it for the trade preview.",
    });
    try {
      if (liveHyperliquidFlow) {
        const walletReady = await ensureHyperliquidSigningWallet({ manageWorking: false });
        if (!walletReady) return;
        await verifyVenueEligibility({
          venue_id: "hyperliquid",
          launch_scope: "hyperliquid_pooled_non_us_beta",
          accepted_terms: true,
          accepted_risk: true,
          jurisdiction_assertion: "non_us",
        });
      }
      const executionMode = liveHyperliquidFlow ? "ghola_pooled" as const : "managed_testnet" as const;
      const allocated = await allocateHyperliquidManagedTestnet({
        execution_mode: executionMode,
        network: executionMode === "ghola_pooled" ? "mainnet" : "testnet",
        market_allowlist: defaultHyperliquidMarketAllowlist(),
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
      });
      setHyperliquidVault((current) => ({
        ...(current || {}),
        account_commitment: allocated.account_commitment,
        ready: allocated.ready,
        execution_mode: executionMode,
        managed_allocation: allocated.managed_allocation,
      }));
      setHyperliquidAgent(null);
      setHyperliquidVerification(null);
      setHyperliquidSetupNotice({
        tone: "working",
        title: liveHyperliquidFlow ? "Hyperliquid access prepared" : "Account prepared",
        detail: "Enabling it with Ghola's execution policy.",
      });
      const armed = await armHyperliquidExecutionAgent({
        execution_mode: executionMode,
        market_allowlist: defaultHyperliquidMarketAllowlist(),
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: false,
      });
      setHyperliquidAgent(armed);
      await refreshHyperliquidVault();
      await refreshHyperliquidAccountSnapshot();
      setHyperliquidSetupNotice({
        tone: "good",
        title: liveHyperliquidFlow ? "Hyperliquid access ready" : "Ghola test account ready",
        detail: liveHyperliquidFlow ? "Next step: check the connection." : "Next step: preview the trade.",
      });
    } catch (err) {
      const message = friendlyPrivateAccountError(err, "Could not start Hyperliquid.");
      if (err instanceof Error && (
        err.message === "funding_attestation_required" ||
        err.message === "funding_destination_commitment_required" ||
        err.message === "funding_attestation_amount_bucket_mismatch"
      )) {
        revealPrivateFundingPanel();
      }
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: liveHyperliquidFlow ? "Hyperliquid pool unavailable" : "Could not start Hyperliquid",
        detail: message,
      });
    } finally {
      setWorking(false);
    }
  }

  async function allocateCoinbaseOmnibus() {
    setWorking(true);
    setError(null);
    try {
      const allocated = await allocatePrivateAccountOmnibus({
        utilization_bucket: input.amount_bucket,
      });
      setOmnibus({
        ready: allocated.ready,
        allocation: allocated.allocation,
      });
      await refreshCoinbaseState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not allocate Coinbase omnibus.");
    } finally {
      setWorking(false);
    }
  }

  async function openCoinbaseConnection() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    if (turnkeyWallet.loading) {
      setError("Ghola is still preparing your account. Try again in a moment.");
      return;
    }
    if (!turnkeyWallet.walletAddress) {
      setWorking(true);
      setError(null);
      try {
        await turnkeyWallet.createWallet(auth.user?.email || "ghola-user");
        await refreshCoinbaseState();
      } catch (err) {
        setError(friendlyPrivateAccountError(err, "Could not prepare your Ghola signing wallet."));
        return;
      } finally {
        setWorking(false);
      }
    }
    setCoinbaseConnectOpen(true);
  }

  async function ensureGholaSigningWallet(
    platformClass: "solana_perps_market" | "solana_swap_aggregator" = "solana_perps_market",
    options: { manageWorking?: boolean } = {},
  ) {
    const manageWorking = options.manageWorking !== false;
    const setVenueVault = platformClass === "solana_swap_aggregator" ? setJupiterVault : setPhoenixVault;
    const currentVault = platformClass === "solana_swap_aggregator" ? jupiterVault : phoenixVault;
    if (turnkeyWallet.walletAddress) {
      if (!currentVault?.account_commitment) {
        const state = await getVenueExecutionVaultStatus({ platform_class: platformClass });
        setVenueVault(state);
      }
      return true;
    }
    if (turnkeyWallet.loading) {
      setError("Ghola is still preparing your account. Try again in a moment.");
      return false;
    }
    if (manageWorking) setWorking(true);
    setError(null);
    try {
      await turnkeyWallet.createWallet(auth.user?.email || "ghola-user");
      const state = await getVenueExecutionVaultStatus({ platform_class: platformClass });
      setVenueVault(state);
      return true;
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not prepare your Ghola signing wallet."));
      return false;
    } finally {
      if (manageWorking) setWorking(false);
    }
  }

  async function openPhoenixConnection() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    const ready = await ensureGholaSigningWallet();
    if (!ready) return;
    setPhoenixConnectOpen(true);
  }

  async function openJupiterConnection() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    const ready = await ensureGholaSigningWallet("solana_swap_aggregator");
    if (!ready) return;
    setJupiterConnectOpen(true);
  }

  async function startPhoenixVaultMode() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    setPhoenixVerification(null);
    try {
      const walletReady = await ensureGholaSigningWallet("solana_perps_market", { manageWorking: false });
      if (!walletReady) return;
      await verifyVenueEligibility({ venue_id: "phoenix" });
      const allocated = await allocatePooledVenueAccount({
        venue_id: "phoenix",
        utilization_bucket: input.amount_bucket,
      });
      setPhoenixVault((allocated.readiness || {
        ...(phoenixVault || {}),
        account_commitment: allocated.account_commitment,
        pooled_allocation: allocated.pooled_allocation,
        ready: allocated.pooled_allocation?.status === "allocated",
        execution_mode: "ghola_pooled",
      }) as VenueVaultState);
      const armed = await armVenueExecutionAgent({
        platform_class: "solana_perps_market",
        execution_mode: "ghola_pooled",
        market_allowlist: ["SOL"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: false,
      });
      setPhoenixAgent(armed);
      await refreshPhoenixState();
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not start Phoenix Vault Mode."));
    } finally {
      setWorking(false);
    }
  }

  async function startJupiterVaultMode() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    setJupiterVerification(null);
    try {
      const walletReady = await ensureGholaSigningWallet("solana_swap_aggregator", { manageWorking: false });
      if (!walletReady) return;
      await verifyVenueEligibility({ venue_id: "jupiter" });
      const allocated = await allocatePooledVenueAccount({
        venue_id: "jupiter",
        utilization_bucket: input.amount_bucket,
      });
      setJupiterVault((allocated.readiness || {
        ...(jupiterVault || {}),
        account_commitment: allocated.account_commitment,
        pooled_allocation: allocated.pooled_allocation,
        ready: allocated.pooled_allocation?.status === "allocated",
        execution_mode: "ghola_pooled",
      }) as VenueVaultState);
      const armed = await armVenueExecutionAgent({
        platform_class: "solana_swap_aggregator",
        execution_mode: "ghola_pooled",
        market_allowlist: [],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: false,
      });
      setJupiterAgent(armed);
      await refreshJupiterState();
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not start Jupiter Vault Mode."));
    } finally {
      setWorking(false);
    }
  }

  async function armCoinbaseAgent(killSwitch = false, executionMode: "partner_omnibus" | "byo_api_key" = "partner_omnibus") {
    setWorking(true);
    setError(null);
    try {
      const armed = await armVenueExecutionAgent({
        platform_class: "coinbase_style_provider",
        execution_mode: executionMode,
        market_allowlist: ["BTC-USD", "ETH-USD", "SOL-USD"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: killSwitch,
      });
      setCoinbaseAgent(armed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not arm Coinbase agent.");
    } finally {
      setWorking(false);
    }
  }

  async function armPhoenixAgent(killSwitch = false) {
    setWorking(true);
    setError(null);
    try {
      const armed = await armVenueExecutionAgent({
        platform_class: "solana_perps_market",
        execution_mode: phoenixVault?.pooled_allocation?.status === "allocated"
          ? "ghola_pooled"
          : "user_stealth",
        market_allowlist: ["SOL"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: killSwitch,
      });
      setPhoenixAgent(armed);
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not enable Phoenix."));
    } finally {
      setWorking(false);
    }
  }

  async function armJupiterAgent(killSwitch = false) {
    setWorking(true);
    setError(null);
    try {
      const armed = await armVenueExecutionAgent({
        platform_class: "solana_swap_aggregator",
        execution_mode: jupiterVault?.pooled_allocation?.status === "allocated"
          ? "ghola_pooled"
          : "user_stealth",
        market_allowlist: [],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: killSwitch,
      });
      setJupiterAgent(armed);
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not enable Jupiter."));
    } finally {
      setWorking(false);
    }
  }

  async function verifyPhoenixNoSubmit() {
    setWorking(true);
    setError(null);
    setPhoenixVerification(null);
    try {
      if (!turnkeyWallet.walletAddress) {
        throw new Error("Turnkey wallet identity is unavailable.");
      }
      if (
        phoenixVault?.venue_execution_vault?.status !== "sealed" &&
        phoenixVault?.pooled_allocation?.status !== "allocated"
      ) {
        throw new Error("Connect a Phoenix trading authority first.");
      }
      const normalizedOrder = normalizeOrderForPlatform(orderDraft, "solana_perps_market");
      const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
      if (validationErrors.length > 0) throw new Error(validationErrors[0]);
      const workOrderCommitment = `connector_work_order_phoenix_verify_${safeRandomId()}`;
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: turnkeyWallet.walletAddress,
        previewCommitment: "",
        workOrderCommitment,
        order: normalizedOrder,
        signBytes: turnkeyWallet.signBytes,
      });
      const result = await verifyPrivateAccountConnectorNoSubmit({
        platform_class: "solana_perps_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      const verification = result.verification as NoFundsVerificationState;
      setPhoenixVerification(verification);
      if (verification.status !== "verified_no_funds") {
        throw new Error(verification.reason || verification.status);
      }
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not verify Phoenix connection."));
    } finally {
      setWorking(false);
    }
  }

  async function verifyJupiterNoSubmit() {
    setWorking(true);
    setError(null);
    setJupiterVerification(null);
    try {
      if (!turnkeyWallet.walletAddress) {
        throw new Error("Turnkey wallet identity is unavailable.");
      }
      if (
        jupiterVault?.venue_execution_vault?.status !== "sealed" &&
        jupiterVault?.pooled_allocation?.status !== "allocated"
      ) {
        throw new Error("solana_swap_execution_vault_not_ready");
      }
      const normalizedOrder = normalizeOrderForPlatform(orderDraft, "solana_swap_aggregator");
      const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
      if (validationErrors.length > 0) throw new Error(validationErrors[0]);
      const workOrderCommitment = `connector_work_order_jupiter_verify_${safeRandomId()}`;
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: turnkeyWallet.walletAddress,
        previewCommitment: "",
        workOrderCommitment,
        order: normalizedOrder,
        signBytes: turnkeyWallet.signBytes,
      });
      const result = await verifyPrivateAccountConnectorNoSubmit({
        platform_class: "solana_swap_aggregator",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      const verification = result.verification as NoFundsVerificationState;
      setJupiterVerification(verification);
      if (verification.status !== "verified_no_funds") {
        throw new Error(verification.reason || verification.status);
      }
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not verify Jupiter connection."));
    } finally {
      setWorking(false);
    }
  }

  async function verifyCoinbaseNoSubmit() {
    setWorking(true);
    setError(null);
    setCoinbaseVerification(null);
    try {
      if (!turnkeyWallet.walletAddress) {
        throw new Error("Turnkey wallet identity is unavailable.");
      }
      if (!coinbaseConnected) {
        throw new Error("coinbase_execution_vault_not_ready");
      }
      const normalizedOrder = normalizeOrderForPlatform(orderDraft, "coinbase_style_provider");
      const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
      if (validationErrors.length > 0) throw new Error(validationErrors[0]);
      const workOrderCommitment = `connector_work_order_coinbase_verify_${safeRandomId()}`;
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: turnkeyWallet.walletAddress,
        previewCommitment: "",
        workOrderCommitment,
        order: normalizedOrder,
        signBytes: turnkeyWallet.signBytes,
      });
      const result = await verifyPrivateAccountConnectorNoSubmit({
        platform_class: "coinbase_style_provider",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      });
      const verification = result.verification as NoFundsVerificationState;
      setCoinbaseVerification(verification);
      if (verification.status !== "verified_no_funds") {
        throw new Error(verification.reason || verification.status);
      }
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not verify Coinbase connection."));
    } finally {
      setWorking(false);
    }
  }

  async function verifyHyperliquidNoSubmit(vaultOverride?: HyperliquidVaultState) {
    setWorking(true);
    setError(null);
    setHyperliquidVerification(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: "Checking Hyperliquid",
      detail: "Building a capped order request without sending it.",
    });
    try {
      let sealingAddress = turnkeyWallet.walletAddress;
      let signInstructionBytes = turnkeyWallet.signBytes;
      let maxSlippageBps = orderDraft.max_slippage_bps?.trim() || "50";
      let leverage = orderDraft.leverage ?? 1;
      let marginMode = orderDraft.margin_mode || "cross";
      if (!LEGACY_HYPERLIQUID_API_KEYS_ENABLED && (
        !perpsTurnkey.configured || !perpsTurnkey.authenticated || !hyperliquidOwnerAuthConfirmed
      )) {
        setHyperliquidOwnerAuthConfirmed(false);
        throw new Error("Authenticate with the Turnkey owner wallet first.");
      }
      const effectiveVault = vaultOverride ?? hyperliquidVault;
      if (
        effectiveVault?.hyperliquid_execution_vault?.status !== "sealed" &&
        effectiveVault?.managed_allocation?.status !== "allocated"
      ) {
        throw new Error("hyperliquid_execution_vault_not_ready");
      }
      const reference = liveHyperliquidReferencePrice(hyperliquidMarket || initialHyperliquidMarket);
      if (reference === null) {
        throw new Error("A live Hyperliquid reference price is required for the no-submit risk check.");
      }
      if (!LEGACY_HYPERLIQUID_API_KEYS_ENABLED) {
        const pair = await perpsTurnkey.ensureWalletPair();
        const mandate = storedTurnkeyPerpsMandate(hyperliquidNetwork);
        if (!mandate) throw new Error("The owner-signed Turnkey risk mandate is unavailable.");
        sealingAddress = pair.sealing.address;
        signInstructionBytes = perpsTurnkey.signSealingBytes;
        maxSlippageBps = String(mandate.max_slippage_bps);
        leverage = mandate.configured_leverage;
        marginMode = mandate.margin_mode;
      }
      if (!sealingAddress) throw new Error("Turnkey wallet identity is unavailable.");
      const normalizedOrder = normalizeOrderForPlatform({
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: orderDraft.venue_id === "hyperliquid" ? orderDraft.market : "BTC",
        side: "buy",
        base_size: "",
        limit_price: reference.toFixed(6),
        quote_size: "5",
        max_slippage_bps: maxSlippageBps,
        order_type: "limit",
        size_mode: "quote",
        tif: "Gtc",
        leverage,
        margin_mode: marginMode,
        protective_orders: { stop_loss: (reference * 0.96).toFixed(6) },
      }, "hyperliquid_style_market");
      const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
      if (validationErrors.length > 0) throw new Error(validationErrors[0]);
      const workOrderCommitment = `connector_work_order_hyperliquid_verify_${safeRandomId()}`;
      const sealed = await buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: sealingAddress,
        previewCommitment: "",
        workOrderCommitment,
        order: normalizedOrder,
        signBytes: signInstructionBytes,
      });
      const result = await verifyPrivateAccountConnectorNoSubmit({
        platform_class: "hyperliquid_style_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
      }) as HyperliquidNoSubmitResult;
      const verification = result.verification;
      const proofReady = hyperliquidNoSubmitProofReady(result);
      if (!proofReady) {
        const reason = result.connection_proof_reason || verification.reason ||
          "hyperliquid_connection_proof_not_persisted";
        setHyperliquidVerification({ ...verification, status: "failed", reason });
        throw new Error(reason);
      }
      setHyperliquidVerification(verification);
      setHyperliquidSetupNotice({
        tone: "good",
        title: "Ready to place trade",
        detail: "Ghola built the order request without broadcasting. Final fill proof requires your approval.",
      });
      if (verifyHyperliquidAfterConnect.current && initialReturnTo) {
        verifyHyperliquidAfterConnect.current = false;
        window.location.assign(initialReturnTo);
        return;
      }
      void refreshHyperliquidAccountSnapshot();
    } catch (err) {
      const reconnectRequired = shouldReconnectHyperliquidApiWallet(err);
      const message = friendlyPrivateAccountError(err, "Could not verify Hyperliquid connection.");
      if (message.toLowerCase().includes("authenticate with turnkey")) {
        setHyperliquidOwnerAuthConfirmed(false);
      }
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Hyperliquid check failed",
        detail: message,
      });
      if (reconnectRequired) setHyperliquidConnectOpen(true);
    } finally {
      setWorking(false);
    }
  }

  async function authenticateHyperliquidOwner() {
    setWorking(true);
    setError(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: "Authenticating owner wallet",
      detail: "Complete the Turnkey sign-in. No order will be sent.",
    });
    try {
      await perpsTurnkey.login();
      setHyperliquidOwnerAuthConfirmed(true);
      setHyperliquidSetupNotice({
        tone: "good",
        title: "Owner wallet authenticated",
        detail: "Run the connection check before reviewing any trade.",
      });
    } catch (err) {
      const message = friendlyPrivateAccountError(err, "Could not authenticate the Turnkey owner wallet.");
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Owner authentication failed",
        detail: message,
      });
    } finally {
      setWorking(false);
    }
  }

  const claim = preview?.claim_status;
  const canApprovePrivate = isPrivateModeAvailableStatus(claim);
  const canApproveDegraded = claim === "degraded_user_accepted_required";
  const waiting = claim === "wait_for_anonymity";
  const blocked = claim === "blocked_leaky_path";
  const phoenixConnected = Boolean(
    phoenixVault?.venue_execution_vault?.status === "sealed" ||
      phoenixVault?.pooled_allocation?.status === "allocated",
  );
  const phoenixArmed = phoenixAgent?.status === "armed";
  const phoenixVerified = phoenixVerification?.status === "verified_no_funds";
  const phoenixTradeRequiresCheck =
    input.platform_class === "solana_perps_market" &&
    input.action_class === "trade_on_platform";
  const jupiterConnected = Boolean(
    jupiterVault?.venue_execution_vault?.status === "sealed" ||
      jupiterVault?.pooled_allocation?.status === "allocated",
  );
  const jupiterArmed = jupiterAgent?.status === "armed";
  const jupiterVerified = jupiterVerification?.status === "verified_no_funds";
  const jupiterTradeRequiresCheck =
    input.platform_class === "solana_swap_aggregator" &&
    input.action_class === "trade_on_platform";
  const hyperliquidVerified = hyperliquidVerification?.status === "verified_no_funds";
  const hyperliquidConnected = Boolean(
    hyperliquidVault?.hyperliquid_execution_vault?.status === "sealed" ||
      hyperliquidVault?.managed_allocation?.status === "allocated",
  );
  const hyperliquidArmed = hyperliquidAgent?.status === "armed";
  const hyperliquidTradeRequiresCheck =
    liveHyperliquidFlow &&
    input.platform_class === "hyperliquid_style_market" &&
    input.action_class === "trade_on_platform";
  const coinbaseConnected = Boolean(
    omnibus?.ready ||
      coinbaseVault?.ready ||
      coinbaseVault?.venue_execution_vault?.status === "sealed",
  );
  const coinbaseArmed = coinbaseAgent?.status === "armed";
  const coinbaseVerified = coinbaseVerification?.status === "verified_no_funds";
  const coinbaseTradeRequiresCheck =
    input.platform_class === "coinbase_style_provider" &&
    input.action_class === "trade_on_platform";
  const pooledSubmitBlocker = selectedPooledSubmitBlocker({
    platformClass: input.platform_class,
    liveTradingStatus,
    hyperliquidVault,
    phoenixVault,
    jupiterVault,
    coinbaseVault,
    omnibus,
  });
  const hyperliquidPooledAvailable = pooledVenueReady(liveTradingStatus, "hyperliquid");
  const phoenixPooledAvailable = pooledVenueReady(liveTradingStatus, "phoenix");
  const jupiterPooledAvailable = pooledVenueReady(liveTradingStatus, "jupiter");
  const coinbasePooledAvailable = pooledVenueReady(liveTradingStatus, "coinbase");
  const canPlacePrivateTrade =
    !pooledSubmitBlocker &&
    (!hyperliquidTradeRequiresCheck || hyperliquidVerified) &&
    (!phoenixTradeRequiresCheck || phoenixVerified) &&
    (!jupiterTradeRequiresCheck || jupiterVerified) &&
    (!coinbaseTradeRequiresCheck || coinbaseVerified);
  const tradingApprovalBlocker =
    pooledSubmitBlocker
      ? pooledSubmitBlocker
      : (hyperliquidTradeRequiresCheck && !hyperliquidVerified)
      ? "Check Hyperliquid connection first"
      : (phoenixTradeRequiresCheck && !phoenixVerified)
        ? "Verify Phoenix live path first"
        : (jupiterTradeRequiresCheck && !jupiterVerified)
          ? "Verify Jupiter live path first"
          : (coinbaseTradeRequiresCheck && !coinbaseVerified)
            ? "Check Coinbase connection first"
        : null;
  const activeQueueId = queue.find((item) => item.status === "queued" || item.status === "ready")?.queue_id;
  const wideHyperliquidPanel = tradeFlow && input.platform_class === "hyperliquid_style_market";
  const widePhoenixPanel =
    input.platform_class === "solana_perps_market" &&
    input.action_class === "trade_on_platform";
  const wideJupiterPanel =
    input.platform_class === "solana_swap_aggregator" &&
    input.action_class === "trade_on_platform";
  const wideCoinbasePanel =
    input.platform_class === "coinbase_style_provider" &&
    input.action_class === "trade_on_platform";
  const showProTradingTerminal = tradeFlow && (wideHyperliquidPanel || widePhoenixPanel);
  const liveCoinbaseFlow = tradeFlow && input.platform_class === "coinbase_style_provider";
  const showScoutControlRoom =
    tradeFlow && !wideHyperliquidPanel && !widePhoenixPanel && !wideJupiterPanel && !wideCoinbasePanel;
  const showTradingGuidance = tradeFlow && isExecutionPlatform(input.platform_class);
  const tradingUiState = {
    authenticated: auth.authenticated,
    actionClass: input.action_class,
    platformClass: input.platform_class,
    liveHyperliquidFlow,
    hasPreview: Boolean(preview),
    submitted: Boolean(execution),
    canApprovePrivate,
    canApproveDegraded,
    waiting,
    blocked,
    phoenix: {
      connected: phoenixConnected,
      armed: phoenixArmed,
      verified: phoenixVerified,
      needsFunds: phoenixVerification?.reason === "needs_funds",
      workerUnavailable: phoenixVerification?.status === "worker_unavailable",
      pooledAvailable: phoenixPooledAvailable,
      accessLabel: phoenixVault?.pooled_allocation?.status === "allocated"
        ? "Ghola Vault Mode"
        : phoenixConnected ? "Trading authority" : "Connect Phoenix account",
    },
    jupiter: {
      connected: jupiterConnected,
      armed: jupiterArmed,
      verified: jupiterVerified,
      needsFunds: jupiterVerification?.reason === "needs_funds",
      workerUnavailable: jupiterVerification?.status === "worker_unavailable",
      pooledAvailable: jupiterPooledAvailable,
      accessLabel: jupiterVault?.pooled_allocation?.status === "allocated"
        ? "Ghola Vault Mode"
        : jupiterConnected ? "Swap authority" : "Connect Jupiter account",
    },
    hyperliquid: {
      connected: hyperliquidConnected,
      armed: hyperliquidArmed,
      verified: hyperliquidVerified,
      accountReady: hyperliquidAccount?.status ? hyperliquidAccount.status === "ready_to_trade" : undefined,
      needsFunds: hyperliquidAccount?.status === "needs_funds" || hyperliquidVerification?.reason === "needs_funds",
      workerUnavailable: hyperliquidAccount?.status === "worker_unavailable" ||
        hyperliquidVerification?.status === "worker_unavailable",
      pooledAvailable: hyperliquidPooledAvailable,
      ownerAuthRequired: !LEGACY_HYPERLIQUID_API_KEYS_ENABLED,
      ownerAuthConfigured: LEGACY_HYPERLIQUID_API_KEYS_ENABLED || perpsTurnkey.configured,
      ownerAuthenticated: LEGACY_HYPERLIQUID_API_KEYS_ENABLED
        ? Boolean(turnkeyWallet.walletAddress)
        : perpsTurnkey.authenticated && hyperliquidOwnerAuthConfirmed,
      ownerAuthLoading: LEGACY_HYPERLIQUID_API_KEYS_ENABLED ? turnkeyWallet.loading : perpsTurnkey.loading,
      accessLabel: hyperliquidVault?.managed_allocation?.execution_mode === "ghola_pooled"
        ? "Ghola trading access"
        : hyperliquidVault?.managed_allocation?.status === "allocated"
          ? "Ghola test account"
          : hyperliquidConnected ? "API wallet" : "Connect API wallet",
    },
    coinbase: {
      connected: coinbaseConnected,
      armed: coinbaseArmed,
      verified: coinbaseVerified,
      needsFunds: coinbaseVerification?.reason === "needs_funds",
      workerUnavailable: coinbaseVerification?.status === "worker_unavailable",
      pooledAvailable: coinbasePooledAvailable,
      accessLabel: omnibus?.ready ? "Partner omnibus" : coinbaseConnected ? "API key" : "Connect Coinbase account",
    },
  };
  const tradingNextAction = deriveTradingNextAction(tradingUiState);
  const tradingReadinessSteps = deriveVenueReadinessSteps(tradingUiState);
  const agentVenues: AgentVenueCard[] = [
    {
      platformClass: "hyperliquid_style_market",
      title: "Hyperliquid",
      detail: hyperliquidPooledAvailable
        ? "Perps through Ghola pool or a scoped API wallet."
        : "Perps through a scoped API wallet today.",
      access: hyperliquidVerified
        ? "Ready to place trade"
        : hyperliquidArmed
          ? "Check connection"
          : hyperliquidConnected
            ? "Create agent"
            : "Connect API wallet",
      hidden: "Main wallet",
      visible: "Execution account + order",
      tone: hyperliquidVerified ? "good" : "warn",
    },
    {
      platformClass: "solana_perps_market",
      title: "Phoenix",
      detail: "Solana perps through a dedicated trading authority.",
      access: phoenixVerified
        ? "Ready to trade"
        : phoenixArmed
          ? "Verify live path"
          : phoenixConnected
            ? "Create agent"
            : "Connect authority",
      hidden: "Funding wallet",
      visible: "Trading authority + order",
      tone: phoenixVerified ? "good" : "warn",
    },
    {
      platformClass: "solana_swap_aggregator",
      title: "Jupiter",
      detail: "Swaps through a private Solana authority with saved limits.",
      access: jupiterVerified
        ? "Ready to swap"
        : jupiterArmed
          ? "Verify route"
          : jupiterConnected
            ? "Create agent"
            : "Connect authority",
      hidden: "Main wallet",
      visible: "Swap authority + route",
      tone: jupiterVerified ? "good" : "warn",
    },
    {
      platformClass: "coinbase_style_provider",
      title: "Coinbase",
      detail: coinbasePooledAvailable
        ? "Spot access through Ghola partner pool or a scoped API key."
        : "Spot access through a scoped API key today.",
      access: coinbaseVerified
        ? "Ready to preview"
        : coinbaseArmed
          ? "Check connection"
          : coinbaseConnected
            ? "Create agent"
            : "Connect API key",
      hidden: "Ghola wallet",
      visible: "Trading account + order",
      tone: coinbaseVerified ? "good" : "warn",
    },
  ];
  const authRedirectBase = liveHyperliquidFlow
    ? "/account?flow=hyperliquid-live"
    : livePhoenixFlow
      ? "/account?flow=phoenix-live"
      : liveJupiterFlow
        ? "/account?flow=jupiter-live"
        : liveCoinbaseFlow
          ? "/account?flow=coinbase"
          : tradeFlow
            ? "/account?flow=trade"
            : "/account?flow=private-mode";
  const authRedirect = iosReturnTo
    ? `${authRedirectBase}&source=ios&return_to=${encodeURIComponent(iosReturnTo)}`
    : authRedirectBase;
  const applyQuickAction = (preset: (typeof QUICK_ACTIONS)[number]) => {
    setPreview(null);
    setExecution(null);
    if (preset.platformClass === "hyperliquid_style_market") {
      setHyperliquidVerification(null);
    }
    if (preset.platformClass === "solana_perps_market") {
      setPhoenixVerification(null);
    }
    if (preset.platformClass === "solana_swap_aggregator") {
      setJupiterVerification(null);
    }
    setInput({
      ...input,
      action_class: preset.actionClass as never,
      platform_class: preset.platformClass as never,
      destination_class: preset.destinationClass as never,
      product_bucket: preset.productBucket as never,
      asset_bucket: preset.assetBucket as never,
      solver_count_bucket: input.solver_count_bucket,
      ...(liveHyperliquidFlow && preset.platformClass === "hyperliquid_style_market"
        ? {
            amount_bucket: "5" as const,
            urgency: "fast_degraded" as const,
          }
        : {}),
    });
    setDestinationQuery(preset.destination);
    if (preset.platformClass === "hyperliquid_style_market") {
      setOrderDraft(liveHyperliquidFlow ? DEFAULT_HYPERLIQUID_LIVE_ORDER : DEFAULT_HYPERLIQUID_ORDER);
    }
    if (preset.platformClass === "solana_perps_market") {
      setOrderDraft(DEFAULT_PHOENIX_LIVE_ORDER);
      setLivePhoenixFlow(true);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(false);
    }
    if (preset.platformClass === "solana_swap_aggregator") {
      setOrderDraft(DEFAULT_JUPITER_LIVE_ORDER);
      setLivePhoenixFlow(false);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(true);
    }
    if (preset.platformClass === "coinbase_style_provider") {
      setOrderDraft(DEFAULT_COINBASE_ORDER);
      setLivePhoenixFlow(false);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(false);
    }
  };

  const updateDestination = (platformClass: string, nextQuery = destinationQuery) => {
    setPreview(null);
    setExecution(null);
    if (platformClass === "hyperliquid_style_market") {
      setHyperliquidVerification(null);
      setOrderDraft((current) =>
        current.venue_id === "hyperliquid"
          ? current
          : liveHyperliquidFlow ? DEFAULT_HYPERLIQUID_LIVE_ORDER : DEFAULT_HYPERLIQUID_ORDER
      );
      setLiveJupiterFlow(false);
    }
    if (platformClass === "solana_perps_market") {
      setPhoenixVerification(null);
      setOrderDraft((current) =>
        current.venue_id === "phoenix" ? current : DEFAULT_PHOENIX_LIVE_ORDER
      );
      setLivePhoenixFlow(true);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(false);
    }
    if (platformClass === "solana_swap_aggregator") {
      setJupiterVerification(null);
      setOrderDraft((current) =>
        current.venue_id === "jupiter" ? current : DEFAULT_JUPITER_LIVE_ORDER
      );
      setLivePhoenixFlow(false);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(true);
    }
    if (platformClass === "coinbase_style_provider") {
      setOrderDraft((current) =>
        current.venue_id === "coinbase_advanced" ? current : DEFAULT_COINBASE_ORDER
      );
      setLivePhoenixFlow(false);
      setLiveHyperliquidFlow(false);
      setLiveJupiterFlow(false);
    }
    setInput({
      ...input,
      platform_class: platformClass as never,
      destination_class: destinationForApp(platformClass) as never,
      solver_count_bucket: platformClass === "rfq_solver_network" ? "5+" : input.solver_count_bucket,
      ...(liveHyperliquidFlow && platformClass === "hyperliquid_style_market"
        ? {
            action_class: "trade_on_platform" as const,
            product_bucket: "perps" as const,
            amount_bucket: "5" as const,
            urgency: "fast_degraded" as const,
            asset_bucket: "BTC" as const,
          }
        : {}),
      ...(platformClass === "solana_perps_market"
        ? {
            action_class: "trade_on_platform" as const,
            product_bucket: "perps" as const,
            amount_bucket: "5" as const,
            urgency: "fast_degraded" as const,
            asset_bucket: "SOL" as const,
          }
        : {}),
      ...(platformClass === "solana_swap_aggregator"
        ? {
            action_class: "trade_on_platform" as const,
            product_bucket: "swap" as const,
            amount_bucket: "5" as const,
            urgency: "fast_degraded" as const,
            asset_bucket: "SOL" as const,
          }
        : {}),
    });
    setDestinationQuery(nextQuery);
  };

  function selectTradePlatform(platformClass: TradePlatformClass) {
    setTradeFlow(true);
    if (platformClass === "solana_perps_market") {
      void selectPhoenixPreview();
      return;
    }
    if (platformClass === "solana_swap_aggregator") {
      void selectJupiterPreview();
      return;
    }
    if (platformClass === "hyperliquid_style_market") {
      setLiveHyperliquidFlow(true);
      setLivePhoenixFlow(false);
      setLiveJupiterFlow(false);
      setInput(DEFAULT_HYPERLIQUID_LIVE_INPUT);
      setOrderDraft(DEFAULT_HYPERLIQUID_LIVE_ORDER);
      setDestinationQuery("Hyperliquid");
      setPreview(null);
      setExecution(null);
      setHyperliquidVerification(null);
      return;
    }
    setLiveHyperliquidFlow(false);
    setLivePhoenixFlow(false);
    setLiveJupiterFlow(false);
    void selectCoinbasePreview();
  }

  function switchToAgentTrading() {
    const selected = isExecutionPlatform(input.platform_class)
      ? input.platform_class as TradePlatformClass
      : "hyperliquid_style_market";
    selectTradePlatform(selected);
  }

  function switchToPrivateActions() {
    setTradeFlow(false);
    setLiveHyperliquidFlow(false);
    setLivePhoenixFlow(false);
    setLiveJupiterFlow(false);
    setInput(DEFAULT_INPUT);
    setOrderDraft(DEFAULT_HYPERLIQUID_ORDER);
    setDestinationQuery("@alice");
    setPreview(null);
    setExecution(null);
    setHyperliquidVerification(null);
    setPhoenixVerification(null);
    setJupiterVerification(null);
    setCoinbaseVerification(null);
  }

  function handleTradingAction(kind: TradingActionKind) {
    if (kind === "sign_in") {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    if (kind === "use_phoenix_vault") {
      void startPhoenixVaultMode();
      return;
    }
    if (kind === "connect_phoenix_byo") {
      void openPhoenixConnection();
      return;
    }
    if (kind === "arm_phoenix") {
      void armPhoenixAgent(false);
      return;
    }
    if (kind === "verify_phoenix") {
      void verifyPhoenixNoSubmit();
      return;
    }
    if (kind === "use_jupiter_vault") {
      void startJupiterVaultMode();
      return;
    }
    if (kind === "connect_jupiter_byo") {
      void openJupiterConnection();
      return;
    }
    if (kind === "arm_jupiter") {
      void armJupiterAgent(false);
      return;
    }
    if (kind === "verify_jupiter") {
      void verifyJupiterNoSubmit();
      return;
    }
    if (kind === "use_hyperliquid_vault") {
      void allocateHyperliquidManaged();
      return;
    }
    if (kind === "connect_hyperliquid_byo") {
      void openHyperliquidConnection();
      return;
    }
    if (kind === "arm_hyperliquid") {
      void armHyperliquidAgent(false);
      return;
    }
    if (kind === "authenticate_hyperliquid_owner") {
      void authenticateHyperliquidOwner();
      return;
    }
    if (kind === "verify_hyperliquid") {
      void verifyHyperliquidNoSubmit();
      return;
    }
    if (kind === "allocate_coinbase_omnibus") {
      void allocateCoinbaseOmnibus();
      return;
    }
    if (kind === "connect_coinbase_byo") {
      void openCoinbaseConnection();
      return;
    }
    if (kind === "arm_coinbase") {
      void armCoinbaseAgent(false, omnibus?.ready ? "partner_omnibus" : "byo_api_key");
      return;
    }
    if (kind === "verify_coinbase") {
      void verifyCoinbaseNoSubmit();
      return;
    }
    if (kind === "preview") {
      void runPreview();
      return;
    }
    if (kind === "place_trade") {
      void approveAndMaybeExecute(false);
      return;
    }
    if (kind === "accept_visibility") {
      void approveAndMaybeExecute(true);
      return;
    }
    if (kind === "wait_for_privacy") {
      void queueForPrivacy();
    }
  }

  async function armAlphaScout(sessionPolicy: Partial<PrivateAutopilotSessionPolicy>) {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const created = await createPrivateAutopilotSession({
        session_policy: sessionPolicy,
      });
      setAutopilotSessions((current) => upsertAutopilotSession(current, created.session));
      setAutopilotEvents(created.events || []);
      setAutopilotStreamStatus(created.session.worker_autopilot_session_id ? "connecting" : "closed");
      await refreshAutopilotState();
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not arm alpha scout."));
    } finally {
      setWorking(false);
    }
  }

  async function controlAlphaScout(action: "pause" | "resume" | "kill") {
    if (!activeAutopilotSession) return;
    setWorking(true);
    setError(null);
    try {
      const result = await controlPrivateAutopilotSession(activeAutopilotSession.autopilot_session_id, action);
      setAutopilotSessions((current) => upsertAutopilotSession(current, result.session));
      setAutopilotEvents((current) => upsertAutopilotEvent(current, result.event));
      await refreshAutopilotState();
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not update alpha scout."));
    } finally {
      setWorking(false);
    }
  }

  if (!auth.authenticated) {
    if (iosReturnTo) {
      return (
        <div className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-[#080b10] px-4 py-8">
          <AuthModal
            mode={authMode}
            open={authOpen}
            onClose={() => setAuthOpen(false)}
            onModeChange={setAuthMode}
            redirectTo={authRedirect}
          />
          <section className="w-full max-w-md rounded-[24px] border border-[#253044] bg-[#0d1119] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#ff9a45]">
              Ghola secure setup
            </p>
            <div className="mt-5 flex h-11 w-11 items-center justify-center rounded-xl bg-[#ff8c2a]/10 text-[#ff9a45]">
              <KeyRound className="h-5 w-5" />
            </div>
            <h1 className="mt-5 text-2xl font-semibold text-[#f6f8ff]">Connect Hyperliquid</h1>
            <p className="mt-2 text-sm leading-6 text-[#96a2b7]">
              Sign in once to finish the secure connection. Ghola will return you to the app automatically.
            </p>
            <button
              type="button"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
              className="mt-7 h-12 w-full rounded-xl bg-[#ff8c2a] px-4 text-sm font-semibold text-[#08090d]"
            >
              Continue securely
            </button>
            <button
              type="button"
              onClick={() => window.location.assign(iosReturnTo)}
              className="mt-3 h-11 w-full rounded-xl text-sm font-medium text-[#8f9bb0]"
            >
              Back to Ghola
            </button>
          </section>
        </div>
      );
    }
    return (
      <div className={tradeFlow ? "flex w-full flex-col" : "mx-auto max-w-7xl space-y-4"}>
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
          redirectTo={authRedirect}
        />
        {tradeFlow && (
          <div className="order-0 p-4 sm:p-6">
            <SignedOutAccountGate
              liveHyperliquidFlow={liveHyperliquidFlow}
              livePhoenixFlow={livePhoenixFlow}
              liveJupiterFlow={liveJupiterFlow}
              liveCoinbaseFlow={liveCoinbaseFlow}
              onSignIn={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
        {showScoutControlRoom && (
          <div className="order-3">
            <PrivateAlphaScoutControlRoom
              authenticated={false}
              selectedPlatform={input.platform_class}
              venues={agentVenues}
              activeSession={activeAutopilotSession}
              events={autopilotEvents}
              replay={autopilotReplay}
              readiness={autopilotReadiness}
              streamStatus={autopilotStreamStatus}
              order={orderDraft}
              preview={preview}
              execution={execution}
              queueCount={queue.length}
              receiptsCount={receipts.length}
              marketSummary={alphaScoutMarketSummary({
                hyperliquidMarket,
                hyperliquidStatus: hyperliquidMarketStatus,
                phoenixMarket,
                phoenixStatus: phoenixMarketStatus,
                jupiterQuote,
                jupiterStatus: jupiterQuoteStatus,
                coinbaseMarket,
                coinbaseStatus: coinbaseMarketStatus,
              })}
              liveTradingStatus={liveTradingStatus}
              working={auth.loading}
              onSelectPlatform={selectTradePlatform}
              onArm={armAlphaScout}
              onControl={controlAlphaScout}
              onPreview={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
              onApprove={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
        {!tradeFlow && (
          <SignedOutAccountGate
            liveHyperliquidFlow={liveHyperliquidFlow}
            livePhoenixFlow={livePhoenixFlow}
            liveJupiterFlow={liveJupiterFlow}
            liveCoinbaseFlow={liveCoinbaseFlow}
            onSignIn={() => {
              setAuthMode("signup");
              setAuthOpen(true);
            }}
          />
        )}
        {wideHyperliquidPanel && (
          <div className="order-1">
            <HyperliquidTradingPanel
              layout="full"
              market={hyperliquidMarketCoin}
              interval={hyperliquidInterval}
              snapshot={hyperliquidMarket}
              marketStatus={hyperliquidMarketStatus}
              accountSnapshot={hyperliquidAccount}
              accountStreamStatus={hyperliquidAccountStreamStatus}
              order={orderDraft}
              previewCommitment={null}
              working={auth.loading}
              previewActionReady
              onMarketChange={selectHyperliquidMarket}
              onIntervalChange={setHyperliquidInterval}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setHyperliquidVerification(null);
                setOrderDraft(nextOrder);
              }}
              onConnect={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
              onPreview={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
        {widePhoenixPanel && (
          <div className="order-1">
            <PhoenixLiveTerminal
              symbol="SOL"
              interval={phoenixInterval}
              snapshot={phoenixMarket}
              marketStatus={phoenixMarketStatus}
              order={orderDraft}
              previewCommitment={null}
              working={auth.loading}
              onIntervalChange={setPhoenixInterval}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setPhoenixVerification(null);
                setOrderDraft(normalizeOrderForPlatform(nextOrder, "solana_perps_market"));
              }}
              onPreview={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
        {wideJupiterPanel && (
          <div className="order-1">
            <JupiterTradingPanel
              quote={jupiterQuote}
              quoteStatus={jupiterQuoteStatus}
              order={orderDraft}
              previewCommitment={null}
              working={auth.loading}
              accountReady={false}
              previewActionReady
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setJupiterVerification(null);
                setOrderDraft(normalizeOrderForPlatform(nextOrder, "solana_swap_aggregator"));
              }}
              onPreview={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
        {wideCoinbasePanel && (
          <div className="order-1">
            <CoinbaseTradingPanel
              productId={coinbaseProduct}
              interval={coinbaseInterval}
              snapshot={coinbaseMarket}
              marketStatus={coinbaseMarketStatus}
              order={orderDraft}
              previewCommitment={null}
              working={auth.loading}
              accountReady={false}
              previewActionReady
              onProductChange={selectCoinbaseProduct}
              onIntervalChange={setCoinbaseInterval}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setOrderDraft(normalizeOrderForPlatform(nextOrder, "coinbase_style_provider"));
              }}
              onPreview={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={tradeFlow ? "flex w-full flex-col" : "mx-auto max-w-7xl space-y-4"}>
      {iosReturnTo && !hyperliquidConnectOpen && (
        <div className="fixed inset-0 z-[85] grid place-items-center bg-[#080b10] px-6">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-[#253044] border-t-[#ff8c2a]" />
            <p className="mt-4 text-sm font-medium text-[#dce6f4]">Preparing secure setup…</p>
          </div>
        </div>
      )}
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo={authRedirect}
      />
      <HyperliquidConnectModal
        open={hyperliquidConnectOpen}
        hyperliquidNetwork={hyperliquidNetwork}
        iosReturnTo={iosReturnTo}
        accountCommitment={hyperliquidVault?.account_commitment || null}
        walletAddress={turnkeyWallet.walletAddress}
        signBytes={turnkeyWallet.signBytes}
        onClose={() => setHyperliquidConnectOpen(false)}
        onConnected={(sealed) => {
          setHyperliquidVault(sealed);
          setHyperliquidAgent(null);
          setHyperliquidVerification(null);
          verifyHyperliquidAfterConnect.current = true;
          void refreshHyperliquidAccountSnapshot();
          if (iosReturnTo) {
            window.location.assign(iosReturnTo);
          } else {
            window.setTimeout(() => void verifyHyperliquidNoSubmit(sealed), 0);
          }
        }}
      />
      {initialSetupVenue === "hyperliquid" && !hyperliquidConnectOpen && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[#08090d] px-4">
          <section className="w-full max-w-md rounded-2xl border border-[#253044] bg-[#0d1119] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.6)]">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#16283b] text-[#8fcaff]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#71819a]">Hyperliquid connection</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">
              {error ? "Connection needs attention" : "Verifying securely"}
            </h1>
            <p className={error ? "mt-3 text-sm leading-6 text-[#f0a9ad]" : "mt-3 text-sm leading-6 text-[#96a2b7]"}>
              {error || hyperliquidSetupNotice?.detail || "Reading the account and building a capped order request without broadcasting it."}
            </p>
            {!error && (
              <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-[#18202b]">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-[#4aaef8]" />
              </div>
            )}
            {error && hyperliquidVault && (
              <button
                type="button"
                onClick={() => void verifyHyperliquidNoSubmit(hyperliquidVault)}
                className="mt-6 h-11 w-full rounded-lg bg-[#4aaef8] px-4 text-sm font-semibold text-[#06111d] hover:bg-[#70c0fb]"
              >
                Retry verification
              </button>
            )}
            <p className="mt-5 text-xs leading-5 text-[#67758a]">No order is sent during this check.</p>
          </section>
        </div>
      )}
      <CoinbaseConnectModal
        open={coinbaseConnectOpen}
        accountCommitment={coinbaseVault?.account_commitment || omnibus?.allocation?.account_commitment || null}
        walletAddress={turnkeyWallet.walletAddress}
        signBytes={turnkeyWallet.signBytes}
        onClose={() => setCoinbaseConnectOpen(false)}
        onConnected={(sealed) => {
          setCoinbaseVault(sealed);
          setCoinbaseAgent(null);
        }}
      />
      <PhoenixConnectModal
        open={phoenixConnectOpen}
        accountCommitment={phoenixVault?.account_commitment || null}
        walletAddress={turnkeyWallet.walletAddress}
        signBytes={turnkeyWallet.signBytes}
        onClose={() => setPhoenixConnectOpen(false)}
        onConnected={(sealed) => {
          setPhoenixVault(sealed);
          setPhoenixAgent(null);
          setPhoenixVerification(null);
        }}
      />
      <JupiterConnectModal
        open={jupiterConnectOpen}
        accountCommitment={jupiterVault?.account_commitment || null}
        walletAddress={turnkeyWallet.walletAddress}
        signBytes={turnkeyWallet.signBytes}
        onClose={() => setJupiterConnectOpen(false)}
        onConnected={(sealed) => {
          setJupiterVault(sealed);
          setJupiterAgent(null);
          setJupiterVerification(null);
        }}
      />

      {showScoutControlRoom && (
        <div className="order-3">
          <PrivateAlphaScoutControlRoom
            authenticated={auth.authenticated}
            selectedPlatform={input.platform_class}
            venues={agentVenues}
            activeSession={activeAutopilotSession}
            events={autopilotEvents}
            replay={autopilotReplay}
            readiness={autopilotReadiness}
            streamStatus={autopilotStreamStatus}
            order={orderDraft}
            preview={preview}
            execution={execution}
            queueCount={queue.length}
            receiptsCount={receipts.length}
            marketSummary={alphaScoutMarketSummary({
              hyperliquidMarket,
              hyperliquidStatus: hyperliquidMarketStatus,
              phoenixMarket,
              phoenixStatus: phoenixMarketStatus,
              jupiterQuote,
              jupiterStatus: jupiterQuoteStatus,
              coinbaseMarket,
              coinbaseStatus: coinbaseMarketStatus,
            })}
            liveTradingStatus={liveTradingStatus}
            working={working}
            onSelectPlatform={selectTradePlatform}
            onArm={armAlphaScout}
            onControl={controlAlphaScout}
            onPreview={runPreview}
            onApprove={() => approveAndMaybeExecute(false)}
          />
        </div>
      )}

      <div
        className={
          tradeFlow
            ? "order-1 grid gap-4"
            : wideHyperliquidPanel || widePhoenixPanel || wideJupiterPanel || wideCoinbasePanel
            ? "grid gap-4 xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]"
            : "grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)]"
        }
      >
        {!tradeFlow && (
        <section className="border border-[#1e2a3a] bg-[#0f1117] p-3 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 text-[#a8d8ff]" />
              <div>
                <h2 className="text-base font-medium">
                  {tradeFlow ? "Private agent setup" : "Private action setup"}
                </h2>
                <p className="mt-0.5 text-xs leading-5 text-[#8b95a8]">
                  {tradeFlow
                    ? "Choose a venue, connect authority, then preview visibility."
                    : "Pick a common action or type where you want to go."}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-3">
            <AgentModeSwitch
              tradeFlow={tradeFlow}
              onTrade={switchToAgentTrading}
              onPrivate={switchToPrivateActions}
            />
            {tradeFlow && (
              <AgentIntentComposer
                selectedPlatform={input.platform_class}
                order={orderDraft}
                intent={intent}
                previewCommitment={preview?.preview_commitment || null}
                nextAction={tradingNextAction}
                agentNotice={input.platform_class === "hyperliquid_style_market" ? hyperliquidSetupNotice : null}
                working={working}
                onNextAction={handleTradingAction}
              />
            )}
            {tradeFlow && input.platform_class === "hyperliquid_style_market" && orderDraft.reduce_only && (
              <div className="border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
                Reduce-only close is prepared. Preview it, then approve the close; it cannot increase the position.
              </div>
            )}
            {tradeFlow && input.platform_class === "hyperliquid_style_market" && ambiguousPreviewCommitment && (
              <button
                type="button"
                disabled={working}
                onClick={reconcileAmbiguousHyperliquid}
                className="inline-flex h-11 items-center justify-center border border-amber-300/40 bg-amber-300/10 px-4 text-sm font-semibold text-amber-100 hover:bg-amber-300/15 disabled:opacity-50"
              >
                Check this exact order on Hyperliquid
              </button>
            )}
            {tradeFlow && input.platform_class === "hyperliquid_style_market" &&
              !orderDraft.reduce_only &&
              execution?.connector_result?.final_proof?.final_fill_proven === true &&
              execution.connector_result.final_proof.filled_base_size && (
                <button
                  type="button"
                  onClick={prepareHyperliquidReduceOnlyClose}
                  className="inline-flex h-11 items-center justify-center border border-amber-300/40 bg-amber-300/10 px-4 text-sm font-semibold text-amber-100 hover:bg-amber-300/15"
                >
                  Prepare reduce-only close
                </button>
              )}
            {tradeFlow && (
              <VenuePicker
                selectedPlatform={input.platform_class}
                onSelect={selectTradePlatform}
              />
            )}
            {showTradingGuidance && !tradeFlow && (
              <VenueReadinessStepper steps={tradingReadinessSteps} />
            )}
            {!tradeFlow && (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  {QUICK_ACTIONS.map((preset) => {
                    const selected =
                      input.action_class === preset.actionClass &&
                      input.platform_class === preset.platformClass;
                    return (
                      <button
                        key={preset.title}
                        type="button"
                        onClick={() => applyQuickAction(preset)}
                        className={compactSelectorClass(selected, "min-h-20 p-3 text-left")}
                      >
                        <span className="block text-sm font-medium text-[#eef1f8]">
                          {preset.title}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[#8b95a8]">
                          {preset.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <SegmentedControl label="Action type" value={input.action_class} options={CORE_ACTIONS} onChange={(value) => {
                  setPreview(null);
                  setExecution(null);
                  setInput({ ...input, action_class: value as never });
                }} />
                <DestinationField
                  value={destinationQuery}
                  inferredLabel={labelFor(APPS, input.platform_class)}
                  onChange={(value) => updateDestination(inferDestinationPlatform(value), value)}
                  onPick={(chip) => updateDestination(chip.platformClass, chip.value)}
                />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_160px]">
                  <Select
                    label="Amount"
                  value={input.amount_bucket}
                  options={(liveHyperliquidFlow && input.platform_class === "hyperliquid_style_market") ||
                      input.platform_class === "solana_perps_market" ||
                      input.platform_class === "solana_swap_aggregator"
                      ? (liveHyperliquidFlow && input.platform_class === "hyperliquid_style_market"
                          ? LAUNCH_AMOUNT_OPTIONS
                          : SMALL_LIVE_AMOUNT_OPTIONS)
                      : LAUNCH_AMOUNT_OPTIONS
                    }
                    onChange={(value) => {
                    setPreview(null);
                    setExecution(null);
                    if (input.platform_class === "hyperliquid_style_market") {
                      setHyperliquidVerification(null);
                    }
                    if (input.platform_class === "solana_perps_market") {
                      setPhoenixVerification(null);
                    }
                    if (input.platform_class === "solana_swap_aggregator") {
                      setJupiterVerification(null);
                    }
                    if (input.platform_class === "coinbase_style_provider") {
                      setCoinbaseVerification(null);
                    }
                    setInput({ ...input, amount_bucket: value as never });
                    if (orderDraft.live_order_mode === "tiny_fill" || input.platform_class === "solana_swap_aggregator") {
                      setOrderDraft({ ...orderDraft, quote_size: value });
                    }
                  }} />
                  <Select label="Asset" value={input.asset_bucket} options={[["stablecoin", "USDC"], ["SOL", "SOL"], ["ETH", "ETH"], ["BTC", "BTC"], ["major", "Major"], ["long_tail", "Long tail"]]} onChange={(value) => {
                    setPreview(null);
                    setExecution(null);
                    setCoinbaseVerification(null);
                    setInput({ ...input, asset_bucket: value as never });
                  }} />
                </div>
                <SegmentedControl label="When should it run?" value={input.urgency} options={SPEEDS} onChange={(value) => {
                  setPreview(null);
                  setExecution(null);
                  setInput({ ...input, urgency: value as never });
                }} />
              </>
            )}
            {input.platform_class === "hyperliquid_style_market" ? (
              wideHyperliquidPanel ? null : (
                <HyperliquidTradingPanel
                  layout="compact"
                  market={hyperliquidMarketCoin}
                  interval={hyperliquidInterval}
                  snapshot={hyperliquidMarket}
                  marketStatus={hyperliquidMarketStatus}
                  accountSnapshot={hyperliquidAccount}
                  accountStreamStatus={hyperliquidAccountStreamStatus}
                  order={orderDraft}
                  previewCommitment={preview?.preview_commitment || null}
                  onMarketChange={selectHyperliquidMarket}
                  onIntervalChange={setHyperliquidInterval}
                  onOrderChange={(nextOrder) => {
                    setPreview(null);
                    setExecution(null);
                    setHyperliquidVerification(null);
                    setOrderDraft(nextOrder);
                  }}
                  onConnect={openHyperliquidConnection}
                  onPreview={runPreview}
                />
              )
            ) : wideCoinbasePanel || widePhoenixPanel || wideJupiterPanel ? null : (
                <PrivateOrderTicket
                  platformClass={input.platform_class}
                  order={orderDraft}
                  previewCommitment={preview?.preview_commitment || null}
                  onChange={(nextOrder) => {
                  setPreview(null);
                  setExecution(null);
                  if (input.platform_class === "solana_perps_market") setPhoenixVerification(null);
                  if (input.platform_class === "solana_swap_aggregator") setJupiterVerification(null);
                  if (input.platform_class === "coinbase_style_provider") setCoinbaseVerification(null);
                  setOrderDraft(nextOrder);
                }}
                />
            )}
            {input.platform_class === "hyperliquid_style_market" && (
              <HyperliquidSetupCard
                state={hyperliquidVault}
                agent={hyperliquidAgent}
                accountSnapshot={hyperliquidAccount}
                verification={hyperliquidVerification}
                working={working}
                setupNotice={hyperliquidSetupNotice}
                evidenceStatus={preview?.platform_class === "hyperliquid_style_market" ? preview.evidence_status : null}
                liveHyperliquidFlow={liveHyperliquidFlow}
                pooledAvailable={hyperliquidPooledAvailable}
                amountBucket={input.amount_bucket}
                launchAccepted={hyperliquidLaunchAccepted}
                onLaunchAcceptedChange={setHyperliquidLaunchAccepted}
                onUseManaged={allocateHyperliquidManaged}
                onConnectApi={openHyperliquidConnection}
                onArm={() => armHyperliquidAgent(false)}
                onVerify={verifyHyperliquidNoSubmit}
                ownerAuthRequired={!LEGACY_HYPERLIQUID_API_KEYS_ENABLED}
                turnkeyConfigured={LEGACY_HYPERLIQUID_API_KEYS_ENABLED || perpsTurnkey.configured}
                turnkeyAuthenticated={LEGACY_HYPERLIQUID_API_KEYS_ENABLED
                  ? Boolean(turnkeyWallet.walletAddress)
                  : perpsTurnkey.authenticated && hyperliquidOwnerAuthConfirmed}
                turnkeyLoading={LEGACY_HYPERLIQUID_API_KEYS_ENABLED ? turnkeyWallet.loading : perpsTurnkey.loading}
                onAuthenticateTurnkey={authenticateHyperliquidOwner}
              />
            )}
            {input.platform_class === "solana_perps_market" && (
              <PhoenixSetupCard
                state={phoenixVault}
                agent={phoenixAgent}
                verification={phoenixVerification}
                working={working}
                pooledAvailable={phoenixPooledAvailable}
                onUsePooled={startPhoenixVaultMode}
                onConnect={openPhoenixConnection}
                onArm={() => armPhoenixAgent(false)}
                onVerify={verifyPhoenixNoSubmit}
              />
            )}
            {input.platform_class === "solana_swap_aggregator" && (
              <JupiterSetupCard
                state={jupiterVault}
                agent={jupiterAgent}
                verification={jupiterVerification}
                working={working}
                pooledAvailable={jupiterPooledAvailable}
                onUsePooled={startJupiterVaultMode}
                onConnect={openJupiterConnection}
                onArm={() => armJupiterAgent(false)}
                onVerify={verifyJupiterNoSubmit}
              />
            )}
            {input.platform_class === "coinbase_style_provider" && (
              <CoinbaseSetupCard
                vault={coinbaseVault}
                omnibus={omnibus}
                agent={coinbaseAgent}
                verification={coinbaseVerification}
                working={working}
                walletReady={Boolean(turnkeyWallet.walletAddress)}
                pooledAvailable={coinbasePooledAvailable}
                onAllocate={allocateCoinbaseOmnibus}
                onConnect={openCoinbaseConnection}
                onSelect={selectCoinbasePreview}
                onArm={() => armCoinbaseAgent(false, omnibus?.ready ? "partner_omnibus" : "byo_api_key")}
                onVerify={verifyCoinbaseNoSubmit}
                onStop={() => armCoinbaseAgent(true, omnibus?.ready ? "partner_omnibus" : "byo_api_key")}
              />
            )}
          </div>

          <div className="mt-4 grid gap-2 border-t border-[#1e2a3a] pt-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {accountStatus?.account && (
              <>
                <StatusLine
                  label="Funding vault"
                  value={accountStatus.account.vault_ready ? "ready" : "not ready"}
                  tone={accountStatus.account.vault_ready ? "good" : "warn"}
                />
              </>
            )}
            <StatusLine label="Wallet" value="hidden first" tone="good" />
          </div>

          {!wideHyperliquidPanel && !widePhoenixPanel && !wideJupiterPanel && !wideCoinbasePanel && (
            <button
              onClick={runPreview}
              disabled={working}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {working ? "Checking" : preview ? "Check again" : tradeFlow ? "Preview intent" : "Check privacy"}
            </button>
          )}
        </section>
        )}

        <section className="space-y-4">
          {showProTradingTerminal && (
            <ProTradingTerminal
              venue={widePhoenixPanel ? "phoenix" : "hyperliquid"}
              venueOptions={[
                { venue: "hyperliquid", label: "Hyperliquid" },
                { venue: "phoenix", label: "Phoenix" },
              ]}
              market={widePhoenixPanel ? "SOL" : hyperliquidMarketCoin}
              marketOptions={
                widePhoenixPanel
                  ? [{ value: "SOL", label: "SOL-PERP" }]
                  : HYPERLIQUID_MARKETS.map(([value, label]) => ({ value, label }))
              }
              interval={(widePhoenixPanel ? phoenixInterval : hyperliquidInterval) as ProChartInterval}
              snapshot={widePhoenixPanel ? phoenixMarket : hyperliquidMarket}
              marketStatus={widePhoenixPanel ? phoenixMarketStatus : hyperliquidMarketStatus}
              accountSnapshot={widePhoenixPanel ? null : hyperliquidAccount}
              accountStatus={widePhoenixPanel ? null : hyperliquidAccountStreamStatus}
              order={orderDraft}
              previewCommitment={preview?.preview_commitment || null}
              working={working}
              nextAction={tradingNextAction}
              readinessSteps={tradingReadinessSteps}
              onVenueChange={(venue: ProTradingVenue) => {
                selectTradePlatform(
                  venue === "phoenix" ? "solana_perps_market" : "hyperliquid_style_market"
                );
              }}
              onMarketChange={(market) => {
                if (!widePhoenixPanel) {
                  selectHyperliquidMarket(market as "BTC" | "ETH" | "SOL" | "HYPE");
                }
              }}
              onIntervalChange={(nextInterval) => {
                if (widePhoenixPanel) {
                  setPhoenixInterval(nextInterval);
                } else {
                  setHyperliquidInterval(nextInterval);
                }
              }}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                if (widePhoenixPanel) {
                  setPhoenixVerification(null);
                  setOrderDraft(normalizeOrderForPlatform(nextOrder, "solana_perps_market"));
                } else {
                  setHyperliquidVerification(null);
                  setOrderDraft(nextOrder);
                }
              }}
              onAction={handleTradingAction}
            />
          )}
          {wideJupiterPanel && (
            <JupiterTradingPanel
              quote={jupiterQuote}
              quoteStatus={jupiterQuoteStatus}
              order={orderDraft}
              previewCommitment={preview?.preview_commitment || null}
              working={working}
              accountReady={jupiterConnected && jupiterArmed}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setJupiterVerification(null);
                setOrderDraft(normalizeOrderForPlatform(nextOrder, "solana_swap_aggregator"));
              }}
              onPreview={runPreview}
            />
          )}
          {wideCoinbasePanel && (
            <CoinbaseTradingPanel
              productId={coinbaseProduct}
              interval={coinbaseInterval}
              snapshot={coinbaseMarket}
              marketStatus={coinbaseMarketStatus}
              order={orderDraft}
              previewCommitment={preview?.preview_commitment || null}
              working={working}
              accountReady={coinbaseConnected && coinbaseArmed}
              onProductChange={selectCoinbaseProduct}
              onIntervalChange={setCoinbaseInterval}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setCoinbaseVerification(null);
                setOrderDraft(normalizeOrderForPlatform(nextOrder, "coinbase_style_provider"));
              }}
              onPreview={runPreview}
            />
          )}
          {tradeFlow && error && (
            <p className="border border-red-300/25 bg-red-300/10 px-3 py-2 text-sm text-red-100">
              {error}
            </p>
          )}
          {showTradingGuidance && !tradeFlow && !widePhoenixPanel && !wideJupiterPanel && !wideHyperliquidPanel && (
            <TradingNextActionBar
              action={tradingNextAction}
              working={working}
              onAction={handleTradingAction}
            />
          )}
          {!tradeFlow && <div className="border border-[#1e2a3a] bg-[#0f1117] p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#a8d8ff]" />
              <div>
                <h2 className="text-lg font-medium">Privacy check</h2>
                <p className="mt-1 text-sm text-[#8b95a8]">
                  Nothing is sent to an app or chain until you approve.
                </p>
              </div>
            </div>
            {preview ? (
              <div className="mt-5 space-y-4">
                <div className="border border-[#253349] bg-[#08090d] p-4">
                  <p className="text-lg font-medium text-[#f6f8ff]">
                    {privacyResultCopy(preview.claim_status).title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[#9aa6ba]">
                    {privacyResultCopy(preview.claim_status).desc}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-[#8b95a8]">Result</span>
                  <span className={statusClass(preview.claim_status)}>{statusLabel(preview.claim_status)}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Metric label="Your wallet" value={shortLeakageStatus(preview.leakage_map.channels.source_wallet_graph)} />
                  <Metric label="Public chain" value={friendlyVisibility(preview.public_chain_sees)} />
                  <Metric label="App or venue" value={friendlyVisibility(preview.platform_sees)} />
                  <Metric label="Ghola sees" value={friendlyVisibility(preview.ghola_operator_sees)} />
                </div>
                <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
                  <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Details</summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Metric label="Peer" value={preview.counterparty_sees} />
                      <Metric label="Evidence" value={preview.evidence_status || "missing"} />
                      <Metric label="Runtime" value={preview.sealed_runtime_context?.runtime_status || "missing"} />
                      <Metric label="Schedule" value={preview.schedule_decision?.status || "missing"} />
                      <Metric label="Rotation" value={preview.rotation?.status || "missing"} />
                      <Metric label="Risk sim" value={preview.linkability_simulation?.decision || "missing"} />
                      {preview.connector_context && (
                        <>
                          <Metric label="Connector" value={preview.connector_context.connector_status} />
                          <Metric label="Link risk" value={preview.connector_context.linkability_decision} />
                          <Metric label="Wallet" value={preview.connector_context.main_wallet_exposed ? "exposed" : "hidden"} />
                          <Metric label="Order" value={preview.connector_context.venue_order_visibility} />
                          <Metric label="Settle" value={preview.connector_context.public_chain_settlement_visibility} />
                        </>
                      )}
                    </div>
                    <ReasonList title="Visible" items={preview.visible_to} empty="None" />
                    {preview.connector_context && (
                      <ReasonList
                        title="Checks"
                        items={preview.connector_context.reason_codes}
                        empty="Passed"
                      />
                    )}
                    <ReasonList
                      title="Claims"
                      items={[
                        ...preview.claim_levels_achieved.map((level) => `yes: ${level}`),
                        ...preview.claim_levels_missing.map((level) => `no: ${level}`),
                      ]}
                      empty="No evidence"
                    />
                    <ReasonList title="Reasons" items={[...preview.wait_reasons, ...preview.degraded_reasons, ...preview.blocked_reasons]} empty="None" />
                  </div>
                </details>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(canApprovePrivate || canApproveDegraded) && tradingApprovalBlocker && (
                    <button disabled className="h-11 border border-amber-300/30 bg-amber-300/10 px-4 text-sm font-medium text-amber-100 sm:col-span-2">
                      {tradingApprovalBlocker}
                    </button>
                  )}
                  {canApprovePrivate && canPlacePrivateTrade && (
                    <button onClick={() => approveAndMaybeExecute(false)} disabled={working} className="h-11 bg-emerald-300 px-4 text-sm font-medium text-[#07100c]">
                      {input.platform_class === "solana_swap_aggregator"
                        ? "Approve and swap"
                        : input.action_class === "trade_on_platform" ? "Place trade" : "Approve and run"}
                    </button>
                  )}
                  {canApproveDegraded && canPlacePrivateTrade && (
                    <button onClick={() => approveAndMaybeExecute(true)} disabled={working} className="h-11 bg-amber-300 px-4 text-sm font-medium text-[#120d04]">
                      {input.platform_class === "solana_perps_market"
                        ? "Accept visibility and place trade"
                        : input.platform_class === "solana_swap_aggregator"
                        ? "Accept visibility and swap"
                        : liveHyperliquidFlow && input.platform_class === "hyperliquid_style_market"
                        ? "Approve tiny live order"
                        : "Accept and run fast"}
                    </button>
                  )}
                  {waiting && (
                    <button onClick={queueForPrivacy} disabled={working} className="inline-flex h-11 items-center justify-center gap-2 border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-4 text-sm font-medium text-[#a8d8ff] disabled:opacity-50">
                      <TimerReset className="h-4 w-4" />
                      Wait for privacy
                    </button>
                  )}
                  {blocked && (
                    <button disabled className="h-11 border border-red-400/30 bg-red-400/10 px-4 text-sm font-medium text-red-200">
                      Blocked
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <p className="text-sm leading-6 text-[#aab5c8]">
                  Choose an action, then run the check. Ghola will tell you if
                  your wallet stays hidden, if the action should wait, or if it
                  has to be blocked.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Metric label="Action" value={labelFor(ACTIONS, input.action_class)} />
                  <Metric label="To" value={destinationQuery} />
                  <Metric label="Amount" value={`$${input.amount_bucket}`} />
                  <Metric label="Status" value="not checked" />
                </div>
              </div>
            )}
            {error && <p className="mt-4 text-sm text-red-200">{error}</p>}
          </div>}

          {!tradeFlow && <details id="private-account-advanced" className="border border-[#1e2a3a] bg-[#0f1117] p-4 sm:p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
              <span>
                <span className="block text-lg font-medium text-[#eef1f8]">
                  Funding, connections, and receipts
                </span>
                <span className="mt-1 block text-sm text-[#8b95a8]">
                  Advanced tools stay here when you need them.
                </span>
              </span>
              <span className="shrink-0 border border-[#344155] px-2 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-[#a8d8ff]">
                Advanced
              </span>
            </summary>
            <div className="mt-4 space-y-4">
              <PrivateAccountFundingPanel
                anchorId="private-funding"
                amountBucket={input.amount_bucket}
                queueId={activeQueueId}
                onChanged={refreshAccountState}
              />

        <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#a8d8ff]" />
              <h2 className="text-lg font-medium">Coinbase Advanced / Omnibus</h2>
            </div>
            <span className={omnibus?.ready || coinbaseVault?.ready ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
              {omnibus?.ready ? "omnibus allocated" : coinbaseVault?.ready ? "api vault sealed" : "not connected"}
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Mode"
              value={omnibus?.ready ? "partner_omnibus" : coinbaseVault?.execution_mode || "partner_omnibus"}
            />
            <Metric
              label="Allocation"
              value={omnibus?.allocation?.allocation_commitment ? shortCommitment(omnibus.allocation.allocation_commitment) : "missing"}
            />
            <Metric
              label="BYO vault"
              value={coinbaseVault?.venue_execution_vault?.vault_commitment ? shortCommitment(coinbaseVault.venue_execution_vault.vault_commitment) : "optional"}
            />
            <Metric
              label="Agent"
              value={coinbaseAgent?.agent_session_commitment ? shortCommitment(coinbaseAgent.agent_session_commitment) : coinbaseAgent?.status || "not armed"}
            />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            <button
              type="button"
              onClick={allocateCoinbaseOmnibus}
              disabled={working}
              className="inline-flex h-10 items-center justify-center gap-2 border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-3 text-xs font-medium text-[#a8d8ff] disabled:opacity-50"
            >
              <Layers className="h-4 w-4" />
              Allocate
            </button>
            <button
              type="button"
              onClick={openCoinbaseConnection}
              disabled={working || !(coinbaseVault?.account_commitment || omnibus?.allocation?.account_commitment)}
              className="inline-flex h-10 items-center justify-center gap-2 border border-[#344155] px-3 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              API key
            </button>
            <button
              type="button"
              onClick={selectCoinbasePreview}
              disabled={working}
              className="inline-flex h-10 items-center justify-center gap-2 border border-[#344155] px-3 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              Select
            </button>
            <button
              type="button"
              onClick={() => armCoinbaseAgent(false, omnibus?.ready ? "partner_omnibus" : "byo_api_key")}
              disabled={working || (!omnibus?.ready && !coinbaseVault?.ready)}
              className="inline-flex h-10 items-center justify-center gap-2 border border-emerald-300/30 bg-emerald-300/10 px-3 text-xs font-medium text-emerald-100 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Arm
            </button>
            <button
              type="button"
              onClick={() => armCoinbaseAgent(true, omnibus?.ready ? "partner_omnibus" : "byo_api_key")}
              disabled={working || (!omnibus?.ready && !coinbaseVault?.ready)}
              className="inline-flex h-10 items-center justify-center gap-2 border border-[#344155] px-3 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          </div>

          <div className="mt-4 grid gap-2 border-t border-[#1e2a3a] pt-4 text-xs text-[#8b95a8] sm:grid-cols-2">
            <span>Partner omnibus: user wallet and API keys stay hidden from public Ghola surfaces</span>
            <span>Coinbase sees pooled partner activity, or your BYO account in API-key mode</span>
          </div>
        </div>

        <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2">
            <TimerReset className="h-4 w-4 text-[#a8d8ff]" />
            <h2 className="text-lg font-medium">Queue</h2>
          </div>
          <div className="mt-4 divide-y divide-[#1e2a3a]">
            {queue.length === 0 ? (
              <p className="py-4 text-sm text-[#8b95a8]">Empty</p>
            ) : (
              queue.map((item) => (
                <div key={item.queue_id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-mono text-xs text-[#a8d8ff]">{item.queue_id}</span>
                    <span className="text-[#8b95a8]">{item.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-[#6f7d9a]">
                    {item.current_anonymity_set}/{item.target_anonymity_set} set · {item.requested_rail}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => refreshQueued(item.queue_id)} disabled={working} className="border border-[#3da8ff]/30 px-3 py-2 text-xs text-[#a8d8ff] disabled:opacity-50">
                      Refresh
                    </button>
                    {item.requested_rail === "shielded_batch_auction" && (
                      <button onClick={() => commitQueuedToAuction(item.queue_id)} disabled={working} className="border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-xs text-emerald-100 disabled:opacity-50">
                        Commit auction
                      </button>
                    )}
                    <button onClick={() => cancelQueued(item.queue_id)} disabled={working} className="border border-[#344155] px-3 py-2 text-xs text-[#aab5c8] disabled:opacity-50">
                      Cancel
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-[#a8d8ff]" />
            <h2 className="text-lg font-medium">Shielded Batch Auctions</h2>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Open" value={String((auctions?.epochs || []).filter((item) => item.status === "open").length)} />
            <Metric label="Orders" value={String((auctions?.orders || []).length)} />
            <Metric label="Clearings" value={String((auctions?.clearings || []).length)} />
          </div>
          <div className="mt-4 divide-y divide-[#1e2a3a]">
            {(auctions?.epochs || []).length === 0 ? (
              <p className="py-4 text-sm text-[#8b95a8]">Empty</p>
            ) : (
              (auctions?.epochs || []).map((epoch) => (
                <div key={epoch.auction_epoch_commitment} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-mono text-xs text-[#a8d8ff]">{shortCommitment(epoch.auction_epoch_commitment)}</span>
                    <span className="text-[#8b95a8]">{statusLabel(epoch.status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-[#6f7d9a]">
                    {labelFor(APPS, epoch.platform_class)} · {epoch.asset_bucket} · ${epoch.amount_bucket} · {epoch.order_count} orders · {epoch.matched_count} matched
                  </p>
                </div>
              ))
            )}
          </div>
          {(auctions?.clearings || []).length > 0 && (
            <div className="mt-4 border-t border-[#1e2a3a] pt-4">
              <p className="text-xs text-[#6f7d9a]">Clearings</p>
              <div className="mt-2 space-y-2">
                {(auctions?.clearings || []).map((clearing) => (
                  <div key={clearing.clearing_commitment} className="flex flex-wrap items-center justify-between gap-3 border border-[#1e2a3a] bg-[#08090d] p-3 text-xs">
                    <span className="font-mono text-[#a8d8ff]">{shortCommitment(clearing.clearing_commitment)}</span>
                    <span className="text-[#8b95a8]">
                      {clearing.matched_order_commitments.length} matched · {clearing.rolled_order_commitments.length} rolled · {statusLabel(clearing.status)}
                    </span>
                    {clearing.status === "cleared" && (
                      <button onClick={() => settleAuction(clearing.clearing_commitment)} disabled={working} className="border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-xs text-emerald-100 disabled:opacity-50">
                        Settle
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2">
            <ReceiptText className="h-4 w-4 text-[#a8d8ff]" />
            <h2 className="text-lg font-medium">Receipts</h2>
          </div>
          {execution?.receipt && (
            <div className="mt-4 border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
              Done: {execution.receipt.receipt_commitment}
            </div>
          )}
          <div className="mt-4 divide-y divide-[#1e2a3a]">
            {receipts.length === 0 ? (
              <p className="py-4 text-sm text-[#8b95a8]">Empty</p>
            ) : (
              receipts.map((receipt) => (
                <div key={receipt.receipt_commitment} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono text-xs text-[#a8d8ff]">{receipt.receipt_commitment}</span>
                    <span className="text-[#8b95a8]">{statusLabel(receipt.claim_status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-[#6f7d9a]">
                    {receipt.rail_used} · chain {receipt.public_chain_visibility} · platform {receipt.platform_visibility}
                    {receipt.evidence_commitment ? ` · evidence ${receipt.evidence_commitment}` : ""}
                    {receipt.connector_result_commitment ? ` · connector ${receipt.connector_result_commitment}` : ""}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => loadReceiptDetail(receipt.receipt_commitment)} className="border border-[#3da8ff]/30 px-3 py-2 text-xs text-[#a8d8ff]">
                      View
                    </button>
                    <button onClick={() => exportReceipt(receipt.receipt_commitment)} className="border border-[#344155] px-3 py-2 text-xs text-[#aab5c8]">
                      Export
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {receiptDetail?.receipt && (
            <div className="mt-4 border border-[#1e2a3a] bg-[#08090d] p-3 text-xs text-[#aab5c8]">
              Detail: {receiptDetail.receipt.claim_status} · hidden from {receiptDetail.receipt.hidden_from?.join(", ") || "none"}
              {receiptDetail.receipt.evidence_chain?.batch_evidence_commitment
                ? ` · evidence ${receiptDetail.receipt.evidence_chain.batch_evidence_commitment}`
                : ""}
              {receiptDetail.receipt.connector_result_commitment
                ? ` · connector ${receiptDetail.receipt.connector_result_commitment}`
                : ""}
              {receiptDetail.connector_context
                ? ` · main wallet ${receiptDetail.connector_context.main_wallet_exposed ? "exposed" : "not exposed"}`
                : ""}
              {receiptDetail.sealed_runtime_context
                ? ` · runtime ${receiptDetail.sealed_runtime_context.runtime_status}`
                : ""}
              {receiptDetail.schedule_decision
                ? ` · schedule ${receiptDetail.schedule_decision.status}`
                : ""}
              {receiptDetail.rotation
                ? ` · rotation ${receiptDetail.rotation.status}`
                : ""}
              {receiptDetail.linkability_simulation
                ? ` · simulator ${receiptDetail.linkability_simulation.decision}`
                : ""}
              {receiptDetail.receipt.claim_levels_achieved?.length
                ? ` · claims ${receiptDetail.receipt.claim_levels_achieved.join(", ")}`
                : ""}
            </div>
          )}
          {receiptExport?.private_export?.private_export_commitment && (
            <div className="mt-4 border border-[#1e2a3a] bg-[#08090d] p-3 text-xs text-[#aab5c8]">
              Encrypted export: <span className="font-mono text-[#a8d8ff]">{receiptExport.private_export.private_export_commitment}</span>
              <span> · encrypted receipt <span className="font-mono text-[#a8d8ff]">{receiptExport.private_export.encrypted_receipt_commitment}</span></span>
              {receiptExport.view_key?.view_key_commitment
                ? <span> · view key <span className="font-mono text-[#a8d8ff]">{receiptExport.view_key.view_key_commitment}</span></span>
                : null}
            </div>
          )}
        </div>
            </div>
          </details>}
      </section>
      </div>
    </div>
  );
}

function HyperliquidSetupCard({
  state,
  agent,
  accountSnapshot,
  verification,
  working,
  setupNotice,
  evidenceStatus,
  liveHyperliquidFlow,
  pooledAvailable,
  amountBucket,
  launchAccepted,
  onLaunchAcceptedChange,
  onUseManaged,
  onConnectApi,
  onArm,
  onVerify,
  ownerAuthRequired,
  turnkeyConfigured,
  turnkeyAuthenticated,
  turnkeyLoading,
  onAuthenticateTurnkey,
}: {
  state: HyperliquidVaultState | null;
  agent: HyperliquidAgentState | null;
  accountSnapshot: HyperliquidAccountSnapshot | null;
  verification: NoFundsVerificationState | null;
  working: boolean;
  setupNotice: SetupNoticeState | null;
  evidenceStatus: string | null;
  liveHyperliquidFlow: boolean;
  pooledAvailable: boolean;
  amountBucket: string;
  launchAccepted: boolean;
  onLaunchAcceptedChange: (accepted: boolean) => void;
  onUseManaged: () => void;
  onConnectApi: () => void;
  onArm: () => void;
  onVerify: () => void;
  ownerAuthRequired: boolean;
  turnkeyConfigured: boolean;
  turnkeyAuthenticated: boolean;
  turnkeyLoading: boolean;
  onAuthenticateTurnkey: () => Promise<void>;
}) {
  const managed = state?.managed_allocation?.status === "allocated";
  const pooled = managed && state?.managed_allocation?.execution_mode === "ghola_pooled";
  const byo = state?.hyperliquid_execution_vault?.status === "sealed";
  const connected = managed || byo;
  const armed = agent?.status === "armed";
  const verified = verification?.status === "verified_no_funds";
  const accountLabel = pooled
    ? "Ghola trading access"
    : managed ? "Ghola test account" : byo ? "API wallet" : "Connect API wallet";
  const fundingReady = evidenceStatus === "evidence_ready";
  const submitReady = liveHyperliquidFlow ? connected && armed && verified : connected && armed && fundingReady;
  const accountStatus = accountSnapshot
    ? hyperliquidAccountStatusLabel(accountSnapshot.status)
    : connected ? "Ready to preview" : "Connect API wallet";
  const verificationAction = deriveHyperliquidVerificationAction({
    liveHyperliquidFlow,
    connected,
    armed,
    turnkeyConfigured,
    turnkeyAuthenticated,
    turnkeyLoading,
    working,
    verified,
    ownerAuthRequired,
  });
  const liveStatus = verificationAction?.statusLabel ?? hyperliquidLiveStatus({
    liveHyperliquidFlow,
    connected,
    armed,
    fundingReady,
    verification,
    accountStatus: accountSnapshot?.status || null,
  });
  const readinessLabel = verificationAction?.statusLabel ?? accountStatus;
  return (
    <div className="border border-[#243248] bg-[#08090d] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-[#a8d8ff]" />
          <h3 className="truncate text-sm font-medium text-[#eef1f8]">
            {liveHyperliquidFlow ? "Hyperliquid" : "Hyperliquid access"}
          </h3>
          <span className="border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-100">
            {liveHyperliquidFlow ? "live" : "testnet"}
          </span>
        </div>
        <span className={
          submitReady
            ? "border border-emerald-300/25 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-100"
            : connected
              ? "border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-2 py-1 text-xs font-medium text-[#a8d8ff]"
              : "border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs font-medium text-amber-100"
        }>
          {liveStatus}
        </span>
      </div>
      <p className="mt-1.5 truncate text-xs text-[#8b95a8]">
        {liveHyperliquidFlow
          ? pooledAvailable
            ? "Use the Ghola pool for mainnet access, or connect a scoped API wallet."
            : "Ghola pool is not configured yet. Scoped API wallet remains available."
          : "Main wallet stays out of Hyperliquid."}
      </p>
      {liveHyperliquidFlow && !connected && (
        <label className="mt-2 flex items-start gap-2 border border-[#1e2a3a] bg-[#0b1018] p-2 text-xs leading-5 text-[#cbd5e5]">
          <input
            type="checkbox"
            checked={launchAccepted}
            onChange={(event) => onLaunchAcceptedChange(event.target.checked)}
            className="mt-1 h-3.5 w-3.5 accent-[#a8d8ff]"
          />
          <span>
            I accept the beta terms and risk disclosure, and confirm I am not a US person or located in the United States.
          </span>
        </label>
      )}
      <div className="mt-2 grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {!connected ? (
          <>
            {liveHyperliquidFlow ? (
              <>
                <button
                  type="button"
                  onClick={onUseManaged}
                  disabled={working || !pooledAvailable || !launchAccepted}
                  title={
                    !pooledAvailable
                      ? "Ghola pooled Hyperliquid access is not configured yet."
                      : !launchAccepted
                        ? "Accept the non-US beta terms before using the Ghola pool."
                        : "Use Ghola-provided Hyperliquid access."
                  }
                  className="inline-flex h-8 items-center justify-center gap-1.5 bg-[#eef1f8] px-2.5 text-xs font-medium text-[#08090d] disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  {pooledAvailable ? working ? "Preparing" : "Use Ghola pool" : "Ghola pool unavailable"}
                </button>
                <button
                  type="button"
                  onClick={onConnectApi}
                  disabled={working}
                  className="inline-flex h-8 items-center justify-center gap-1.5 border border-[#344155] px-2.5 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {working ? "Preparing" : "Connect API wallet"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onUseManaged}
                  disabled={working}
                  className="inline-flex h-8 items-center justify-center gap-1.5 bg-[#eef1f8] px-2.5 text-xs font-medium text-[#08090d] disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  {working ? "Preparing" : "Use test account"}
                </button>
                <button
                  type="button"
                  onClick={onConnectApi}
                  disabled={working}
                  className="inline-flex h-8 items-center justify-center gap-1.5 border border-[#344155] px-2.5 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {working ? "Preparing" : "Import wallet"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {verificationAction ? (
              <button
                type="button"
                onClick={verificationAction.kind === "authenticate_owner" ? onAuthenticateTurnkey : onVerify}
                disabled={verificationAction.disabled}
                className="inline-flex h-8 items-center justify-center gap-1.5 bg-[#eef1f8] px-2.5 text-xs font-medium text-[#08090d] disabled:opacity-50"
              >
                {verificationAction.kind === "verify_connection"
                  ? <Search className="h-3.5 w-3.5" />
                  : <KeyRound className="h-3.5 w-3.5" />}
                {verificationAction.label}
              </button>
            ) : (
              <button
                type="button"
                onClick={onArm}
                disabled={working}
                className="inline-flex h-8 items-center justify-center gap-1.5 bg-[#eef1f8] px-2.5 text-xs font-medium text-[#08090d] disabled:opacity-50"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {armed ? "Agent ready" : "Create agent"}
              </button>
            )}
            {!liveHyperliquidFlow && (
              <button
                type="button"
                onClick={onUseManaged}
                disabled={working || managed}
                className="inline-flex h-8 items-center justify-center gap-1.5 border border-[#344155] px-2.5 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {managed ? "Using test account" : "Use test account"}
              </button>
            )}
            {liveHyperliquidFlow && (
              <button
                type="button"
                onClick={onConnectApi}
                disabled={working}
                className="inline-flex h-8 items-center justify-center gap-1.5 border border-[#344155] px-2.5 text-xs font-medium text-[#aab5c8] disabled:opacity-50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {pooled ? "API wallet" : "Replace wallet"}
              </button>
            )}
          </>
        )}
      </div>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <CompactStatusChip label="Wallet" value="hidden" tone="good" />
        <CompactStatusChip label="Venue sees" value="order" tone="warn" />
        <CompactStatusChip label="Access" value={accountLabel} tone={connected ? "good" : "warn"} />
        <CompactStatusChip
          label="Ready"
          value={readinessLabel}
          tone={verified || accountSnapshot?.status === "ready_to_trade" || connected ? "good" : "warn"}
        />
        {connected ? (
          <>
            <CompactStatusChip
              label={liveHyperliquidFlow ? "Cap" : "Funding"}
              value={liveHyperliquidFlow ? `$${amountBucket}/order` : fundingReady ? "ready" : "needed"}
              tone={liveHyperliquidFlow || fundingReady ? "good" : "warn"}
            />
            <CompactStatusChip
              label="Chain"
              value={liveHyperliquidFlow ? "wallet unused" : fundingReady ? "hidden" : "not used"}
              tone={liveHyperliquidFlow || fundingReady ? "good" : "warn"}
            />
          </>
        ) : null}
      </div>
      {verification && (
        <LiveReadinessCertificateCard verification={verification} />
      )}
      {setupNotice && (
        <div className={setupNoticeClass(setupNotice.tone)}>
          <div className="text-sm font-medium">{setupNotice.title}</div>
          {setupNotice.detail && (
            <p className="mt-1 text-xs leading-5 opacity-85">{setupNotice.detail}</p>
          )}
        </div>
      )}
      {!connected && (
        <p className="mt-2 truncate text-xs text-[#8b95a8]">
          {liveHyperliquidFlow
            ? pooledAvailable
              ? "Ghola pool is the self-serve path for eligible non-US beta users."
              : "Use a scoped API wallet. Ghola pool is not configured yet."
            : "Recommended: use a Ghola test account. Import an API wallet only if you already have a scoped Hyperliquid API key."}
        </p>
      )}
      {connected && !fundingReady && !liveHyperliquidFlow && (
        <p className="mt-2 truncate text-xs text-[#8b95a8]">
          Preview is available. Submit waits for private funding evidence.
        </p>
      )}
    </div>
  );
}

function AgentIntentComposer({
  selectedPlatform,
  order,
  intent,
  previewCommitment,
  nextAction,
  agentNotice,
  working,
  onNextAction,
}: {
  selectedPlatform: string;
  order: PrivateExecutionOrderDraft;
  intent: IntentState | null;
  previewCommitment: string | null;
  nextAction: TradingNextAction;
  agentNotice: SetupNoticeState | null;
  working: boolean;
  onNextAction: (kind: TradingActionKind) => void;
}) {
  const selectedVenue = TRADE_VENUES.find((venue) => venue.platformClass === selectedPlatform);
  const venueLabel = selectedVenue?.title ?? labelFor(APPS, selectedPlatform);
  const actionItems = agentComposerActionItems(nextAction);
  const intentStatus = previewCommitment ? "previewed" : intent ? "created" : "draft";
  const intentStatusClass = previewCommitment
    ? "text-emerald-200"
    : intent
      ? "text-[#a8d8ff]"
      : "text-amber-200";

  return (
    <div className="border border-[#243248] bg-[#08090d] p-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium uppercase tracking-[0.12em] text-[#8b95a8]">
          Agent + intent
        </span>
        <a
          href="/agents/new"
          className="shrink-0 text-[#a8d8ff] hover:text-[#eef1f8]"
        >
          New named agent
        </a>
      </div>

      <div className="mt-2 grid gap-1.5">
        <div className="grid grid-cols-1 gap-1.5 border border-[#1e2a3a] bg-[#0f1117] px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <span className="min-w-0">
            <span className="block text-[10px] uppercase tracking-[0.1em] text-[#6f7d9a]">
              Execution agent
            </span>
            <span className="block truncate font-medium text-[#eef1f8]">
              {venueLabel}
            </span>
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
            {actionItems.map((action) => {
              const actionAllowed = agentComposerCanRun(action.kind);
              return (
                <button
                  key={action.kind}
                  type="button"
                  onClick={() => onNextAction(action.kind)}
                  disabled={working || action.disabled || !actionAllowed}
                  title={action.description}
                  className={compactSelectorClass(false, "inline-flex h-7 items-center justify-center px-2.5 text-xs")}
                >
                  {working ? "Working" : agentComposerActionLabel(action)}
                </button>
              );
            })}
          </span>
        </div>

        <p className="truncate text-[11px] text-[#6f7d9a]">
          {agentComposerModeHint(selectedPlatform, actionItems)}
        </p>

        {agentNotice && (
          <div className={agentComposerNoticeClass(agentNotice.tone)}>
            <span className="font-medium">{agentNotice.title}</span>
            {agentNotice.detail ? <span className="truncate opacity-85">{agentNotice.detail}</span> : null}
          </div>
        )}

        <div className="grid grid-cols-1 gap-1.5 border border-[#1e2a3a] bg-[#0f1117] px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <span className="min-w-0">
            <span className="block text-[10px] uppercase tracking-[0.1em] text-[#6f7d9a]">
              Intent
            </span>
            <span className="block truncate font-medium text-[#eef1f8]">
              {summarizeTradeIntent(order, selectedPlatform)}
            </span>
          </span>
          <a
            href="#trade-intent"
            className={compactSelectorClass(false, "inline-flex h-7 items-center justify-center px-2.5 text-xs")}
          >
            Edit
          </a>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="truncate text-[#6f7d9a]">
          {intent?.intent_id ? shortCommitment(intent.intent_id) : "Intent is created when preview runs"}
        </span>
        <span className={`shrink-0 font-medium ${intentStatusClass}`}>{intentStatus}</span>
      </div>
    </div>
  );
}

function VenuePicker({
  selectedPlatform,
  onSelect,
}: {
  selectedPlatform: string;
  onSelect: (platformClass: (typeof TRADE_VENUES)[number]["platformClass"]) => void;
}) {
  const selectedVenue = TRADE_VENUES.find((venue) => venue.platformClass === selectedPlatform);
  return (
    <div className="border border-[#243248] bg-[#08090d] p-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#8b95a8]">Venue</span>
        <span className="text-xs text-[#8b95a8]">first trade</span>
      </div>
      <div className="grid grid-cols-2 gap-1 2xl:grid-cols-4">
        {TRADE_VENUES.map((venue) => {
          const selected = selectedPlatform === venue.platformClass;
          return (
            <button
              key={venue.platformClass}
              type="button"
              onClick={() => onSelect(venue.platformClass)}
              className={compactSelectorClass(selected, "h-8 px-2 text-left")}
            >
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-[#eef1f8]">{venue.title}</span>
                {selected ? <span className="text-[9px] uppercase tracking-[0.1em] text-[#b9d8ff]">on</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {selectedVenue ? (
        <p className="mt-1.5 truncate text-xs text-[#8b95a8]">{selectedVenue.desc}</p>
      ) : null}
    </div>
  );
}

function CompactStatusChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-2 rounded-[3px] border border-[#1f2d40] bg-[#0d141e] px-2 py-1">
      <span className="truncate text-[#8b95a8]">{label}</span>
      <span className={tone === "good" ? "truncate text-emerald-200" : "truncate text-amber-200"}>
        {formatValue(value)}
      </span>
    </span>
  );
}

function VenueReadinessStepper({ steps }: { steps: VenueReadinessStep[] }) {
  if (steps.length === 0) return null;
  const activeStep = steps.find((step) => step.status === "current" || step.status === "warn" || step.status === "blocked") ||
    steps.find((step) => step.status === "pending") ||
    steps[steps.length - 1];
  const doneCount = steps.filter((step) => step.status === "done").length;
  return (
    <div className="border border-[#243248] bg-[#08090d] p-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium uppercase tracking-[0.12em] text-[#8b95a8]">Next</span>
        <span className="text-[#8b95a8]">{doneCount}/{steps.length} ready</span>
      </div>
      <div className="mt-1.5 grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2">
        <span className={`flex h-[18px] w-[18px] items-center justify-center border text-[9px] ${stepDotClass(activeStep.status)}`}>
          {steps.findIndex((step) => step.id === activeStep.id) + 1}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-[#eef1f8]">{activeStep.value}</span>
          <span className="block truncate text-[#8b95a8]">{activeStep.label}</span>
        </span>
        <span className={stepStatusTextClass(activeStep.status)}>{stepStatusLabel(activeStep.status)}</span>
      </div>
      <ol className="mt-2 grid grid-cols-5 gap-1" aria-label="Trading setup progress">
        {steps.map((step, index) => (
          <li key={step.id}>
            <span
              className={`block h-1.5 border ${stepDotClass(step.status)}`}
              title={`${index + 1}. ${step.label}: ${step.value} (${stepStatusLabel(step.status)})`}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function TradingNextActionBar({
  action,
  working,
  onAction,
}: {
  action: TradingNextAction;
  working: boolean;
  onAction: (kind: TradingActionKind) => void;
}) {
  const disabled = working || action.disabled;
  return (
    <section className={`border p-4 sm:p-5 ${actionBarClass(action.tone)}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] opacity-75">Next step</p>
          <h2 className="mt-1 text-lg font-medium text-[#f6f8ff]">{action.label}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 opacity-85">{action.description}</p>
        </div>
        <span className="border border-current/25 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.12em] opacity-80">
          guided
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <button
          type="button"
          onClick={() => onAction(action.kind)}
          disabled={disabled}
          className={`inline-flex h-11 items-center justify-center gap-2 px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-55 ${primaryActionClass(action.tone)}`}
        >
          <Play className="h-4 w-4" />
          {working ? "Working" : action.label}
        </button>
        {action.secondary && (
          <button
            type="button"
            onClick={() => action.secondary && onAction(action.secondary.kind)}
            disabled={working || action.secondary.disabled}
            className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <KeyRound className="h-4 w-4" />
            {action.secondary.label}
          </button>
        )}
      </div>
    </section>
  );
}

function PhoenixSetupCard({
  state,
  agent,
  verification,
  working,
  pooledAvailable,
  onUsePooled,
  onConnect,
  onArm,
  onVerify,
}: {
  state: VenueVaultState | null;
  agent: VenueAgentState | null;
  verification: NoFundsVerificationState | null;
  working: boolean;
  pooledAvailable: boolean;
  onUsePooled: () => void;
  onConnect: () => void;
  onArm: () => void;
  onVerify: () => void;
}) {
  const pooled = state?.pooled_allocation?.status === "allocated";
  const connected = state?.venue_execution_vault?.status === "sealed" || pooled;
  const armed = agent?.status === "armed";
  const verified = verification?.status === "verified_no_funds";
  const submitReady = connected && armed && verified;
  const liveStatus = phoenixLiveStatus({ connected, armed, verification });
  const accountLabel = pooled ? "Ghola Vault Mode" : connected ? "trading authority" : "not connected";
  return (
    <div className="border border-[#243248] bg-[#08090d] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
            <h3 className="text-base font-medium text-[#eef1f8]">Phoenix</h3>
            <span className="border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-100">
              live tiny-fill
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9aa6bb]">
            {pooledAvailable
              ? "Use a Ghola-provided Phoenix authority or connect your own."
              : "Connect a dedicated Phoenix authority. Ghola pool is not configured yet."}
          </p>
        </div>
        <div className="flex items-center justify-start lg:justify-end">
          <span className={
            submitReady
              ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : verified
                ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : connected
                ? "border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-3 py-1.5 text-xs font-medium text-[#a8d8ff]"
                : "border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100"
          }>
            {liveStatus}
          </span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <StatusLine label="Main wallet" value="not exposed" tone="good" />
        <StatusLine label="Phoenix sees" value="trading authority + order" tone="warn" />
        <StatusLine label="Connection" value={accountLabel} tone={connected ? "good" : "warn"} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {!connected ? (
          <>
            <button
              type="button"
              onClick={onConnect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              {working ? "Preparing" : "Connect authority"}
            </button>
            <button
              type="button"
              onClick={onUsePooled}
              disabled={working || !pooledAvailable}
              title={pooledAvailable ? "Use Ghola-provided Phoenix access." : "Ghola pooled Phoenix access is not configured yet."}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onVerify}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {verified ? "Live path verified" : "Verify live path"}
            </button>
            <button
              type="button"
              onClick={onArm}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {armed ? "Agent ready" : "Create agent"}
            </button>
            <button
              type="button"
              onClick={onConnect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50 sm:col-span-2"
            >
              <KeyRound className="h-4 w-4" />
              {pooled ? "Bring own authority" : "Replace authority"}
            </button>
          </>
        )}
      </div>
      {verification && (
        <LiveReadinessCertificateCard verification={verification} />
      )}
      <p className="mt-3 text-xs leading-5 text-[#8b95a8]">
        If Phoenix rejects the authority, funds, market, or transaction, Ghola reports the exact next step without exposing raw secrets.
      </p>
    </div>
  );
}

function JupiterSetupCard({
  state,
  agent,
  verification,
  working,
  pooledAvailable,
  onUsePooled,
  onConnect,
  onArm,
  onVerify,
}: {
  state: VenueVaultState | null;
  agent: VenueAgentState | null;
  verification: NoFundsVerificationState | null;
  working: boolean;
  pooledAvailable: boolean;
  onUsePooled: () => void;
  onConnect: () => void;
  onArm: () => void;
  onVerify: () => void;
}) {
  const pooled = state?.pooled_allocation?.status === "allocated";
  const connected = state?.venue_execution_vault?.status === "sealed" || pooled;
  const armed = agent?.status === "armed";
  const verified = verification?.status === "verified_no_funds";
  const submitReady = connected && armed && verified;
  const liveStatus = jupiterLiveStatus({ connected, armed, verification });
  const accountLabel = pooled ? "Ghola Vault Mode" : connected ? "swap authority" : "not connected";
  return (
    <div className="border border-[#243248] bg-[#08090d] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
            <h3 className="text-base font-medium text-[#eef1f8]">Jupiter</h3>
            <span className="border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-100">
              live swap pilot
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9aa6bb]">
            {pooledAvailable
              ? "Use a Ghola-provided swap authority or connect your own."
              : "Connect a dedicated swap authority. Ghola pool is not configured yet."}
          </p>
        </div>
        <div className="flex items-center justify-start lg:justify-end">
          <span className={
            submitReady
              ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : verified
                ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : connected
                ? "border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-3 py-1.5 text-xs font-medium text-[#a8d8ff]"
                : "border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100"
          }>
            {liveStatus}
          </span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <StatusLine label="Main wallet" value="not exposed" tone="good" />
        <StatusLine label="Jupiter sees" value="swap authority + route" tone="warn" />
        <StatusLine label="Connection" value={accountLabel} tone={connected ? "good" : "warn"} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {!connected ? (
          <>
            <button
              type="button"
              onClick={onConnect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              {working ? "Preparing" : "Connect authority"}
            </button>
            <button
              type="button"
              onClick={onUsePooled}
              disabled={working || !pooledAvailable}
              title={pooledAvailable ? "Use Ghola-provided Jupiter access." : "Ghola pooled Jupiter access is not configured yet."}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onVerify}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {verified ? "Live path verified" : "Verify live path"}
            </button>
            <button
              type="button"
              onClick={onArm}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {armed ? "Agent ready" : "Create agent"}
            </button>
            <button
              type="button"
              onClick={onConnect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50 sm:col-span-2"
            >
              <KeyRound className="h-4 w-4" />
              {pooled ? "Bring own authority" : "Replace authority"}
            </button>
          </>
        )}
      </div>
      {verification && (
        <LiveReadinessCertificateCard verification={verification} />
      )}
      <p className="mt-3 text-xs leading-5 text-[#8b95a8]">
        Live Capped swaps require a Jupiter API key and allowlisted mints. The connection check builds but does not broadcast.
      </p>
    </div>
  );
}

function CoinbaseSetupCard({
  vault,
  omnibus,
  agent,
  verification,
  working,
  walletReady,
  pooledAvailable,
  onAllocate,
  onConnect,
  onSelect,
  onArm,
  onVerify,
  onStop,
}: {
  vault: VenueVaultState | null;
  omnibus: OmnibusState | null;
  agent: VenueAgentState | null;
  verification: NoFundsVerificationState | null;
  working: boolean;
  walletReady: boolean;
  pooledAvailable: boolean;
  onAllocate: () => void;
  onConnect: () => void;
  onSelect: () => void;
  onArm: () => void;
  onVerify: () => void;
  onStop: () => void;
}) {
  const connected = Boolean(omnibus?.ready || vault?.ready || vault?.venue_execution_vault?.status === "sealed");
  const armed = agent?.status === "armed";
  const verified = verification?.status === "verified_no_funds";
  const submitReady = connected && armed && verified;
  const accessLabel = omnibus?.ready ? "partner omnibus" : connected ? "API key" : "not connected";
  return (
    <div className="border border-[#243248] bg-[#08090d] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
            <h3 className="text-base font-medium text-[#eef1f8]">Coinbase Advanced</h3>
            <span className="border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-100">
              provider visible
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9aa6bb]">
            {pooledAvailable
              ? "Use the Ghola partner pool or connect a scoped Coinbase key."
              : "Connect a scoped Coinbase key. Ghola partner pool is not configured yet."}
          </p>
        </div>
        <div className="flex items-center justify-start lg:justify-end">
          <span className={
            submitReady
              ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : verified
                ? "border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100"
              : connected
                ? "border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-3 py-1.5 text-xs font-medium text-[#a8d8ff]"
                : "border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100"
          }>
            {submitReady ? "Ready to preview" : verified ? "Checked" : connected ? "Create agent" : "Connect account"}
          </span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <StatusLine label="Main wallet" value="not exposed" tone="good" />
        <StatusLine label="Coinbase sees" value="trading account + order" tone="warn" />
        <StatusLine label="Connection" value={accessLabel} tone={connected ? "good" : "warn"} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {!connected ? (
          <>
            <button
              type="button"
              onClick={onConnect}
              disabled={working || !walletReady}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              {working ? "Preparing" : "Connect API key"}
            </button>
            <button
              type="button"
              onClick={onAllocate}
              disabled={working || !pooledAvailable}
              title={pooledAvailable ? "Use the Ghola partner pool for Coinbase orders." : "Ghola partner pool is not configured yet."}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <Layers className="h-4 w-4" />
              {pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onVerify}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {verified ? "Check again" : "Check connection"}
            </button>
            <button
              type="button"
              onClick={onArm}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {armed ? "Agent ready" : "Create agent"}
            </button>
            <button
              type="button"
              onClick={onSelect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50 sm:col-span-2"
            >
              <Search className="h-4 w-4" />
              Select Coinbase
            </button>
            <button
              type="button"
              onClick={onStop}
              disabled={working || !armed}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50 sm:col-span-2"
            >
              <Square className="h-4 w-4" />
              Stop access
            </button>
          </>
        )}
      </div>
      {verification && (
        <LiveReadinessCertificateCard verification={verification} />
      )}
      <p className="mt-3 text-xs leading-5 text-[#8b95a8]">
        Withdrawals and transfers stay blocked. The readiness check builds a Coinbase order request without submitting it.
      </p>
    </div>
  );
}

function LiveReadinessCertificateCard({
  verification,
}: {
  verification: NoFundsVerificationState;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const certificate = verification.live_readiness_certificate;
  const venueId = certificate?.venue_id || (
    verification.checks?.coinbase_api_reachable || verification.checks?.coinbase_order_request_built
      ? "coinbase_advanced"
      :
    verification.checks?.jupiter_api_reachable || verification.checks?.jupiter_order_built
      ? "jupiter"
      :
    verification.checks?.hyperliquid_api_reachable || verification.checks?.order_request_built
      ? "hyperliquid"
      : "phoenix"
  );
  const hyperliquid = venueId === "hyperliquid";
  const jupiter = venueId === "jupiter";
  const coinbase = venueId === "coinbase_advanced";
  const ready = certificate?.status === "ready_to_attempt_broadcast" ||
    verification.status === "verified_no_funds";
  const checks = certificate?.checks;
  async function copyCertificate() {
    if (!certificate) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(certificate, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  const rows = coinbase
    ? checks
      ? [
          ["Worker", checks.private_agent_worker_reachable],
          ["Sealed access", checks.sealed_vault_opened],
          ["Policy limits", checks.policy_enforced && checks.live_gate_enforced],
          ["Coinbase API", checks.coinbase_api_reachable],
          ["Order request", checks.coinbase_order_request_built || checks.order_request_built],
          ["Broadcast", checks.transaction_broadcast],
        ] as const
      : [
          ["Worker", verification.checks?.sealed_instruction_opened === true],
          ["Sealed access", verification.checks?.sealed_vault_opened === true],
          ["Coinbase API", verification.checks?.coinbase_api_reachable === true],
          ["Order request", verification.checks?.coinbase_order_request_built === true || verification.checks?.order_request_built === true],
          ["Broadcast", verification.checks?.transaction_broadcast === true],
        ] as const
    : jupiter
    ? checks
      ? [
          ["Worker", checks.private_agent_worker_reachable],
          ["Sealed vault", checks.sealed_vault_opened],
          ["Policy limits", checks.policy_enforced && checks.live_gate_enforced],
          ["Jupiter API", checks.jupiter_api_reachable],
          ["Mint allowlist", checks.jupiter_token_allowlist_passed],
          ["Order built", checks.jupiter_order_built],
          ["Transaction", checks.jupiter_transaction_built],
          ["Broadcast", checks.transaction_broadcast],
        ] as const
      : [
          ["Worker", verification.checks?.sealed_instruction_opened === true],
          ["Sealed vault", verification.checks?.sealed_vault_opened === true],
          ["Jupiter API", verification.checks?.jupiter_api_reachable === true],
          ["Mint allowlist", verification.checks?.jupiter_token_allowlist_passed === true],
          ["Order built", verification.checks?.jupiter_order_built === true],
          ["Transaction", verification.checks?.jupiter_transaction_built === true],
          ["Broadcast", verification.checks?.transaction_broadcast === true],
        ] as const
    : hyperliquid
    ? checks
      ? [
          ["Worker", checks.private_agent_worker_reachable],
          ["Sealed vault", checks.sealed_vault_opened],
          ["Policy limits", checks.policy_enforced && checks.live_gate_enforced],
          ["Hyperliquid API", checks.hyperliquid_api_reachable],
          ["Hyperliquid SDK", checks.hyperliquid_sdk_ready],
          ["Account read", checks.account_read_checked],
          ["Order request", checks.order_request_built],
          ["Broadcast", checks.transaction_broadcast],
        ] as const
      : [
          ["Worker", verification.checks?.sealed_instruction_opened === true],
          ["Sealed vault", verification.checks?.sealed_vault_opened === true],
          ["Hyperliquid API", verification.checks?.hyperliquid_api_reachable === true],
          ["Hyperliquid SDK", verification.checks?.hyperliquid_sdk_ready === true],
          ["Account read", verification.checks?.account_read_checked === true],
          ["Order request", verification.checks?.order_request_built === true],
          ["Broadcast", verification.checks?.transaction_broadcast === true],
        ] as const
    : checks
      ? [
          ["Worker", checks.private_agent_worker_reachable],
          ["Sealed vault", checks.sealed_vault_opened],
          ["Policy limits", checks.policy_enforced && checks.live_gate_enforced],
          ["Solana RPC", checks.solana_rpc_reachable],
          ["Phoenix SDK", checks.phoenix_sdk_ready],
          ["Order packet", checks.order_packet_built],
          ["Broadcast", checks.transaction_broadcast],
        ] as const
      : [
          ["Solana RPC", verification.checks?.rpc_reachable === true],
          ["Phoenix SDK", verification.checks?.phoenix_sdk_ready === true],
          ["Order packet", verification.checks?.order_packet_built === true],
          ["Broadcast", verification.checks?.transaction_broadcast === true],
        ] as const;
  return (
    <div className={
      ready
        ? "mt-4 border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-100"
        : "mt-4 border border-amber-300/20 bg-amber-300/10 p-3 text-sm text-amber-100"
    }>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">
            {ready ? "Ready up to broadcast" : `Not ready: ${formatValue(verification.reason || verification.status)}`}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 opacity-85">
            {coinbase
              ? "Ghola checked the sealed worker, Coinbase access, and order request build. No order was submitted."
              : jupiter
              ? "Ghola checked the sealed worker, Jupiter API, mint allowlist, and swap transaction build. No transaction was sent."
              : hyperliquid
              ? "Ghola checked the sealed worker, Hyperliquid API/SDK, and order request. No order was sent."
              : "Ghola checked the sealed worker, RPC, Phoenix SDK, and order packet. No transaction was sent."}
          </p>
        </div>
        {certificate && (
          <button
            type="button"
            onClick={copyCertificate}
            className="inline-flex h-9 items-center justify-center gap-2 border border-current/25 px-3 text-xs font-medium disabled:opacity-60"
          >
            <Copy className="h-3.5 w-3.5" />
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy certificate"}
          </button>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, ok]) => (
          <div key={label} className="border border-current/15 bg-[#08090d]/45 p-2">
            <span className="block text-[11px] uppercase tracking-[0.08em] opacity-65">{label}</span>
            <span className="mt-1 block text-sm text-[#eef1f8]">
              {label === "Broadcast" ? "not sent" : ok ? "passed" : "not passed"}
            </span>
          </div>
        ))}
      </div>
      {certificate && (
        <div className="mt-3 grid gap-2 text-xs leading-5 text-[#aab5c8] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            Certificate <span className="font-mono text-[#a8d8ff]">{shortCommitment(certificate.certificate_commitment)}</span>
          </div>
          <div>
            Fill proof <span className="text-amber-100">requires user-approved broadcast</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PhoenixConnectModal({
  open,
  accountCommitment,
  walletAddress,
  signBytes,
  onClose,
  onConnected,
}: {
  open: boolean;
  accountCommitment: string | null;
  walletAddress: string | null;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  onClose: () => void;
  onConnected: (sealed: VenueVaultState) => void;
}) {
  const [draft, setDraft] = useState<SolanaPerpsExecutionCredentialDraft>({
    venue_id: "phoenix",
    network: "mainnet",
    authority_private_key: "",
    authority: "",
    rpc_url: "",
    api_url: "",
    trader_pda_index: "0",
    trader_subaccount_index: "0",
  });
  const [confirmedAuthority, setConfirmedAuthority] = useState(false);
  const [quickImport, setQuickImport] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearCredentialDraft() {
    setDraft({
      venue_id: "phoenix",
      network: "mainnet",
      authority_private_key: "",
      authority: "",
      rpc_url: "",
      api_url: "",
      trader_pda_index: "0",
      trader_subaccount_index: "0",
    });
    setQuickImport("");
    setConfirmedAuthority(false);
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearCredentialDraft();
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const validationErrors = validateSolanaPerpsExecutionCredentialDraft(draft);
  const hasKey = Boolean(draft.authority_private_key.trim());
  const hasAuthority = Boolean(draft.authority?.trim());
  const canSubmit = Boolean(
    accountCommitment &&
      walletAddress &&
      confirmedAuthority &&
      validationErrors.length === 0 &&
      !submitting,
  );
  function updateQuickImport(value: string) {
    setQuickImport(value);
    if (!value.trim()) return;
    const imported = parseSolanaPerpsCredentialImport(value, draft);
    if (imported.fields.length > 0) {
      setDraft(imported.draft);
      setError(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!accountCommitment || !walletAddress) {
      setError("Private account wallet is unavailable.");
      return;
    }
    if (!confirmedAuthority) {
      setError("Confirm this is a dedicated Phoenix trader authority.");
      return;
    }
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await buildSolanaPerpsExecutionVaultBundle({
        accountCommitment,
        ownerWalletAddress: walletAddress,
        credential: draft,
        signBytes,
        executionMode: "user_stealth",
      });
      const stored = await sealVenueExecutionVault({
        platform_class: "solana_perps_market",
        execution_mode: sealed.execution_mode,
        encrypted_execution_vault: sealed.encrypted_execution_vault,
      });
      clearCredentialDraft();
      onConnected(stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Phoenix.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Close Phoenix connection dialog"
        className="absolute inset-0 bg-black/72 backdrop-blur-sm"
        onClick={() => {
          clearCredentialDraft();
          onClose();
        }}
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-lg border border-[#1e2a3a] bg-[#0b0d13] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.72)]"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            clearCredentialDraft();
            onClose();
          }}
          className="absolute right-3 top-3 p-1 text-[#6f798c] hover:bg-[#161822] hover:text-[#eef1f8]"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
          <h2 className="text-lg font-medium text-[#eef1f8]">Connect Phoenix</h2>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs text-[#8b95a8]">Paste</span>
            <textarea
              value={quickImport}
              onChange={(event) => updateQuickImport(event.target.value)}
              placeholder="Paste Phoenix authority private key JSON, raw base58 key, or KEY=VALUE lines"
              autoComplete="off"
              spellCheck={false}
              className="min-h-28 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <StatusLine label="Secret key" value={hasKey ? "found" : "needed"} tone={hasKey ? "good" : "warn"} />
            <StatusLine label="Authority" value={hasAuthority ? "matched" : "derived"} tone={hasKey ? "good" : "warn"} />
            <StatusLine label="Network" value="mainnet" tone="good" />
          </div>
          <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Advanced</summary>
            <div className="mt-4 grid gap-4">
              <label className="grid gap-1.5">
                <span className="text-xs text-[#8b95a8]">Trader authority secret</span>
                <textarea
                  value={draft.authority_private_key}
                  onChange={(event) => setDraft({ ...draft, authority_private_key: event.target.value })}
                  placeholder="base58, hex, or JSON array"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-24 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
                />
              </label>
              <TextInput
                label="Authority"
                value={draft.authority || ""}
                placeholder="optional, derived from secret"
                onChange={(value) => setDraft({ ...draft, authority: value })}
              />
              <TextInput
                label="RPC URL"
                value={draft.rpc_url || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, rpc_url: value })}
              />
              <TextInput
                label="Phoenix API URL"
                value={draft.api_url || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, api_url: value })}
              />
            </div>
          </details>
          <label className="flex items-start gap-3 border border-[#1e2a3a] bg-[#08090d] p-3 text-sm text-[#aab5c8]">
            <input
              type="checkbox"
              checked={confirmedAuthority}
              onChange={(event) => setConfirmedAuthority(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[#a8d8ff]"
            />
            <span>This is a dedicated Phoenix trader authority, not my main wallet seed. Ghola does not create venue access.</span>
          </label>
        </div>

        <div className="mt-5 grid gap-2 border-t border-[#1e2a3a] pt-4 text-xs text-[#8b95a8] sm:grid-cols-2">
          <span>Ghola stores commitments and ciphertext only</span>
          <span>Phoenix accepts or rejects the order</span>
        </div>

        {error && <p className="mt-4 text-sm text-red-200">{error}</p>}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              clearCredentialDraft();
              onClose();
            }}
            className="h-11 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" />
            {submitting ? "Connecting" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function JupiterConnectModal({
  open,
  accountCommitment,
  walletAddress,
  signBytes,
  onClose,
  onConnected,
}: {
  open: boolean;
  accountCommitment: string | null;
  walletAddress: string | null;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  onClose: () => void;
  onConnected: (sealed: VenueVaultState) => void;
}) {
  const [draft, setDraft] = useState<SolanaSwapExecutionCredentialDraft>({
    venue_id: "jupiter",
    network: "mainnet",
    authority_private_key: "",
    authority: "",
    swap_api_url: "",
    tx_api_url: "",
  });
  const [confirmedAuthority, setConfirmedAuthority] = useState(false);
  const [quickImport, setQuickImport] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearCredentialDraft() {
    setDraft({
      venue_id: "jupiter",
      network: "mainnet",
      authority_private_key: "",
      authority: "",
      swap_api_url: "",
      tx_api_url: "",
    });
    setQuickImport("");
    setConfirmedAuthority(false);
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearCredentialDraft();
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const validationErrors = validateSolanaSwapExecutionCredentialDraft(draft);
  const hasKey = Boolean(draft.authority_private_key.trim());
  const hasAuthority = Boolean(draft.authority?.trim());
  const canSubmit = Boolean(
    accountCommitment &&
      walletAddress &&
      confirmedAuthority &&
      validationErrors.length === 0 &&
      !submitting,
  );

  function updateQuickImport(value: string) {
    setQuickImport(value);
    if (!value.trim()) return;
    const imported = parseSolanaSwapCredentialImport(value, draft);
    if (imported.fields.length > 0) {
      setDraft(imported.draft);
      setError(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!accountCommitment || !walletAddress) {
      setError("Private account wallet is unavailable.");
      return;
    }
    if (!confirmedAuthority) {
      setError("Confirm this is a dedicated Jupiter swap authority.");
      return;
    }
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await buildSolanaSwapExecutionVaultBundle({
        accountCommitment,
        ownerWalletAddress: walletAddress,
        credential: draft,
        signBytes,
        executionMode: "user_stealth",
      });
      const stored = await sealVenueExecutionVault({
        platform_class: "solana_swap_aggregator",
        execution_mode: sealed.execution_mode,
        encrypted_execution_vault: sealed.encrypted_execution_vault,
      });
      clearCredentialDraft();
      onConnected(stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Jupiter.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Close Jupiter connection dialog"
        className="absolute inset-0 bg-black/72 backdrop-blur-sm"
        onClick={() => {
          clearCredentialDraft();
          onClose();
        }}
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-lg border border-[#1e2a3a] bg-[#0b0d13] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.72)]"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            clearCredentialDraft();
            onClose();
          }}
          className="absolute right-3 top-3 p-1 text-[#6f798c] hover:bg-[#161822] hover:text-[#eef1f8]"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
          <h2 className="text-lg font-medium text-[#eef1f8]">Connect Jupiter</h2>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs text-[#8b95a8]">Paste</span>
            <textarea
              value={quickImport}
              onChange={(event) => updateQuickImport(event.target.value)}
              placeholder="Paste swap authority private key JSON, raw base58 key, or KEY=VALUE lines"
              autoComplete="off"
              spellCheck={false}
              className="min-h-28 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <StatusLine label="Secret key" value={hasKey ? "found" : "needed"} tone={hasKey ? "good" : "warn"} />
            <StatusLine label="Authority" value={hasAuthority ? "matched" : "derived"} tone={hasKey ? "good" : "warn"} />
            <StatusLine label="Network" value="mainnet" tone="good" />
          </div>
          <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Advanced</summary>
            <div className="mt-4 grid gap-4">
              <label className="grid gap-1.5">
                <span className="text-xs text-[#8b95a8]">Swap authority secret</span>
                <textarea
                  value={draft.authority_private_key}
                  onChange={(event) => setDraft({ ...draft, authority_private_key: event.target.value })}
                  placeholder="base58, hex, or JSON array"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-24 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
                />
              </label>
              <TextInput
                label="Authority"
                value={draft.authority || ""}
                placeholder="optional, derived from secret"
                onChange={(value) => setDraft({ ...draft, authority: value })}
              />
              <TextInput
                label="Jupiter Swap API URL"
                value={draft.swap_api_url || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, swap_api_url: value })}
              />
              <TextInput
                label="Jupiter Tx API URL"
                value={draft.tx_api_url || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, tx_api_url: value })}
              />
            </div>
          </details>
          <label className="flex items-start gap-3 border border-[#1e2a3a] bg-[#08090d] p-3 text-sm text-[#aab5c8]">
            <input
              type="checkbox"
              checked={confirmedAuthority}
              onChange={(event) => setConfirmedAuthority(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[#a8d8ff]"
            />
            <span>This is a dedicated Jupiter swap authority, not my main wallet seed. Ghola does not create venue access.</span>
          </label>
        </div>

        <div className="mt-5 grid gap-2 border-t border-[#1e2a3a] pt-4 text-xs text-[#8b95a8] sm:grid-cols-2">
          <span>Ghola stores commitments and ciphertext only</span>
          <span>Jupiter accepts or rejects the route and transaction</span>
        </div>

        {error && <p className="mt-4 text-sm text-red-200">{error}</p>}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              clearCredentialDraft();
              onClose();
            }}
            className="h-11 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" />
            {submitting ? "Connecting" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function HyperliquidConnectModal({
  open,
  hyperliquidNetwork,
  iosReturnTo,
  accountCommitment,
  walletAddress,
  signBytes,
  onClose,
  onConnected,
}: {
  open: boolean;
  hyperliquidNetwork: "mainnet" | "testnet";
  iosReturnTo: string | null;
  accountCommitment: string | null;
  walletAddress: string | null;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  onClose: () => void;
  onConnected: (sealed: HyperliquidVaultState) => void;
}) {
  const [draft, setDraft] = useState<HyperliquidExecutionCredentialDraft>({
    network: hyperliquidNetwork,
    hyperliquid_account_address: "",
    api_wallet_private_key: "",
    agent_name: "",
  });
  const [confirmedAgentKey, setConfirmedAgentKey] = useState(false);
  const [generatedAgentAddress, setGeneratedAgentAddress] = useState("");
  const [quickImport, setQuickImport] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousOpenRef = useRef(false);

  const clearCredentialDraft = useCallback(() => {
    setDraft({
      network: hyperliquidNetwork,
      hyperliquid_account_address: "",
      api_wallet_private_key: "",
      agent_name: "",
    });
    setGeneratedAgentAddress("");
    setQuickImport("");
    setConfirmedAgentKey(false);
  }, [hyperliquidNetwork]);

  useEffect(() => {
    if (!open) return;
    setDraft((current) => ({
      ...current,
      network: hyperliquidNetwork,
    }));
  }, [open, hyperliquidNetwork]);

  useEffect(() => {
    if (shouldResetHyperliquidConnectionError(previousOpenRef.current, open)) setError(null);
    previousOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearCredentialDraft();
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearCredentialDraft, open, onClose]);

  const finishTurnkeySetup = useCallback(() => {
    void getHyperliquidExecutionVaultStatus()
      .then((sealed) => {
        onConnected(sealed as HyperliquidVaultState);
        if (iosReturnTo) window.location.assign(iosReturnTo);
        else onClose();
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not read the sealed vault."));
  }, [iosReturnTo, onClose, onConnected]);

  if (!open) return null;
  if (!LEGACY_HYPERLIQUID_API_KEYS_ENABLED) {
    return (
      <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/72 px-4 py-6 backdrop-blur-sm">
        <section className="relative my-auto w-full max-w-lg rounded-xl border border-[#253044] bg-[#0d1119] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.72)]">
          <button type="button" aria-label="Close" onClick={onClose} className="absolute right-3 top-3 p-1 text-[#6f798c] hover:bg-[#161822] hover:text-[#eef1f8]">
            <X className="h-4 w-4" />
          </button>
          <div className="pr-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#62b7ff]">Secure connection</p>
            <h2 className="mt-2 text-xl font-semibold text-[#eef1f8]">Connect Hyperliquid with Turnkey</h2>
          </div>
          <TurnkeyPerpsManager
            network={hyperliquidNetwork}
            market="BTC"
            referencePrice={null}
            onReady={finishTurnkeySetup}
          />
          {error && <p className="mt-4 text-sm text-red-200">{error}</p>}
        </section>
      </div>
    );
  }
  const iosHandoff = Boolean(iosReturnTo);

  function closeConnection() {
    clearCredentialDraft();
    if (iosReturnTo) {
      window.location.assign(iosReturnTo);
      return;
    }
    onClose();
  }

  const validationErrors = validateHyperliquidExecutionCredentialDraft(draft);
  const hasAccount = Boolean(draft.hyperliquid_account_address.trim());
  const hasKey = Boolean(draft.api_wallet_private_key.trim());
  const agentKeyConfirmed = isHyperliquidAgentKeyConfirmed({
    generatedAgentAddress,
    confirmedImportedAgentKey: confirmedAgentKey,
  });
  const canSubmit = Boolean(
    accountCommitment &&
      walletAddress &&
      agentKeyConfirmed &&
      validationErrors.length === 0 &&
      !submitting,
  );
  const connectLabel = submitting
    ? "Verifying…"
    : !accountCommitment || !walletAddress
      ? "Preparing secure wallet…"
      : !hasAccount
        ? "Enter account address"
        : !hasKey
          ? "Enter API wallet key"
        : !agentKeyConfirmed
          ? "Confirm key type"
            : validationErrors.length > 0
              ? "Check connection details"
              : "Secure & verify";

  function updateQuickImport(value: string) {
    setQuickImport(value);
    if (!value.trim()) return;
    const imported = parseHyperliquidCredentialImport(value, draft);
    if (imported.fields.length > 0) {
      setDraft(imported.draft);
      setGeneratedAgentAddress("");
      setConfirmedAgentKey(false);
      setError(null);
    }
  }

  function generateDedicatedWallet() {
    try {
      const generated = generateHyperliquidApiWallet();
      setDraft((current) => ({
        ...current,
        api_wallet_private_key: generated.privateKey,
        agent_name: current.agent_name?.trim() || "ghola",
      }));
      setGeneratedAgentAddress(generated.address);
      setConfirmedAgentKey(false);
      setQuickImport("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a dedicated API wallet.");
    }
  }

  function clearGeneratedWallet() {
    setDraft((current) => ({
      ...current,
      api_wallet_private_key: "",
    }));
    setGeneratedAgentAddress("");
    setConfirmedAgentKey(false);
    setError(null);
  }

  async function copyGeneratedAddress() {
    if (!generatedAgentAddress) return;
    try {
      await navigator.clipboard.writeText(generatedAgentAddress);
    } catch {
      setError("Could not copy the public API wallet address. Select and copy it manually.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!accountCommitment || !walletAddress) {
      setError("Private account wallet is unavailable.");
      return;
    }
    if (!agentKeyConfirmed) {
      setError("Confirm the imported key is a Hyperliquid API wallet key.");
      return;
    }
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await buildHyperliquidExecutionVaultBundle({
        accountCommitment,
        ownerWalletAddress: walletAddress,
        credential: draft,
        signBytes,
      });
      const credentialBinding = await signHyperliquidApiWalletBinding({
        privateKey: draft.api_wallet_private_key,
        accountCommitment,
        network: draft.network,
        ownerAddress: draft.hyperliquid_account_address,
      });
      const stored = await sealHyperliquidExecutionVault({
        encrypted_execution_vault: sealed.encrypted_execution_vault,
        credential_binding: credentialBinding,
      });
      clearCredentialDraft();
      onConnected(stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Hyperliquid.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`fixed inset-0 z-[90] flex overflow-y-auto px-4 py-6 ${
      iosHandoff
        ? "items-start justify-center bg-[#080b10] pt-[max(2rem,env(safe-area-inset-top))]"
        : "items-center justify-center"
    }`}>
      <button
        type="button"
        aria-label="Close Hyperliquid connection dialog"
        className={`absolute inset-0 ${iosHandoff ? "hidden" : "bg-black/72 backdrop-blur-sm"}`}
        onClick={closeConnection}
      />
      <form
        onSubmit={submit}
        className={`relative w-full max-w-lg border border-[#253044] bg-[#0d1119] p-5 ${
          iosHandoff
            ? "my-auto max-w-md rounded-[24px] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
            : "shadow-[0_28px_90px_rgba(0,0,0,0.72)]"
        }`}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={closeConnection}
          className="absolute right-3 top-3 p-1 text-[#6f798c] hover:bg-[#161822] hover:text-[#eef1f8]"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
          <h2 className="text-lg font-semibold text-[#eef1f8]">
            Connect Hyperliquid
          </h2>
        </div>
        {iosHandoff && (
          <p className="mt-2 pr-6 text-sm leading-5 text-[#8f9bb0]">
            One-time secure setup. You’ll return to the Ghola app when the connection is ready.
          </p>
        )}

        {iosHandoff ? (
          <div className="mt-6 grid gap-4">
            <label className="grid gap-2">
              <span className="text-xs font-medium text-[#96a2b7]">Hyperliquid account</span>
              <input
                value={draft.hyperliquid_account_address}
                onChange={(event) => setDraft({ ...draft, hyperliquid_account_address: event.target.value })}
                placeholder="0x account address"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-12 rounded-xl border border-[#253044] bg-[#080b10] px-4 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#536076] focus:border-[#ff9a45]"
              />
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-medium text-[#96a2b7]">API wallet key</span>
              <input
                type="password"
                value={draft.api_wallet_private_key}
                onChange={(event) => setDraft({ ...draft, api_wallet_private_key: event.target.value })}
                placeholder="0x private key"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-12 rounded-xl border border-[#253044] bg-[#080b10] px-4 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#536076] focus:border-[#ff9a45]"
              />
            </label>
            <div className="flex items-center justify-between px-1 text-xs text-[#778398]">
              <span>Mainnet</span>
              <span>Encrypted before upload</span>
            </div>
            <label className="flex items-center gap-3 rounded-xl border border-[#253044] bg-[#080b10] px-3 py-3 text-xs leading-5 text-[#aab5c8]">
              <input
                type="checkbox"
                checked={confirmedAgentKey}
                onChange={(event) => setConfirmedAgentKey(event.target.checked)}
                className="h-4 w-4 shrink-0 accent-[#ff8c2a]"
              />
              <span>Dedicated API wallet—not my main wallet key.</span>
            </label>
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-4">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-[#96a2b7]">Hyperliquid account address</span>
                <input
                  value={draft.hyperliquid_account_address}
                  onChange={(event) => setDraft({ ...draft, hyperliquid_account_address: event.target.value })}
                  placeholder="0x…"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 rounded-lg border border-[#253044] bg-[#080b10] px-4 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#536076] focus:border-[#62b7ff]"
                />
              </label>
              <div className="grid gap-3 rounded-lg border border-[#29405b] bg-[#0a1420] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[#dcecff]">Dedicated API wallet</p>
                    <p className="mt-1 text-[11px] leading-4 text-[#8197b2]">
                      Generated locally. The private key stays in memory and is encrypted before upload.
                    </p>
                  </div>
                  {!generatedAgentAddress && (
                    <button
                      type="button"
                      onClick={generateDedicatedWallet}
                      className="shrink-0 border border-[#4778a6] bg-[#10243a] px-3 py-2 text-xs font-semibold text-[#bfe0ff] hover:bg-[#16304d]"
                    >
                      Generate in Ghola
                    </button>
                  )}
                </div>
                {generatedAgentAddress && (
                  <div className="grid gap-3">
                    <div className="rounded-md border border-[#315374] bg-[#070d14] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#6f8ba7]">
                          Public authorization address
                        </span>
                        <button
                          type="button"
                          onClick={copyGeneratedAddress}
                          className="inline-flex items-center gap-1 text-xs text-[#9bcfff] hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </button>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-[#dcecff]">
                        {generatedAgentAddress}
                      </p>
                    </div>
                    <ol className="grid gap-1.5 pl-4 text-xs leading-5 text-[#94a8bf]">
                      <li className="list-decimal">Open Hyperliquid API wallets for the {draft.network} account.</li>
                      <li className="list-decimal">Paste this public address and authorize it with your account wallet.</li>
                      <li className="list-decimal">Return here, confirm authorization, then secure and verify.</li>
                    </ol>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={draft.network === "testnet"
                          ? "https://app.hyperliquid-testnet.xyz/API"
                          : "https://app.hyperliquid.xyz/API"}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-9 items-center border border-[#4778a6] px-3 text-xs font-semibold text-[#bfe0ff] hover:bg-[#10243a]"
                      >
                        Open Hyperliquid API wallets
                      </a>
                      <button
                        type="button"
                        onClick={clearGeneratedWallet}
                        className="h-9 px-2 text-xs text-[#718399] hover:text-[#dcecff]"
                      >
                        Use a different wallet
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {!generatedAgentAddress && (
                <details className="rounded-lg border border-[#253044] bg-[#080b10] p-3">
                  <summary className="cursor-pointer text-xs font-medium text-[#8290a5]">Bring an existing API wallet instead</summary>
                  <label className="mt-4 grid gap-1.5">
                    <span className="text-xs font-medium text-[#96a2b7]">Dedicated API wallet private key</span>
                    <input
                      type="password"
                      value={draft.api_wallet_private_key}
                      onChange={(event) => {
                        setDraft({ ...draft, api_wallet_private_key: event.target.value });
                        setConfirmedAgentKey(false);
                      }}
                      placeholder="0x + 64 hexadecimal characters"
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-12 rounded-lg border border-[#253044] bg-[#07090c] px-4 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#536076] focus:border-[#62b7ff]"
                    />
                  </label>
                </details>
              )}
              <div className="flex items-center justify-between rounded-lg border border-[#253044] bg-[#080b10] px-3 py-2.5 text-xs">
                <span className="text-[#778398]">Network</span>
                <span className="font-medium capitalize text-[#8fe0bd]">{draft.network}</span>
              </div>
              <details className="rounded-lg border border-[#253044] bg-[#080b10] p-3">
                <summary className="cursor-pointer text-xs font-medium text-[#8290a5]">Import JSON or add an agent name</summary>
                <div className="mt-4 grid gap-4">
                  <label className="grid gap-1.5">
                    <span className="text-xs text-[#8b95a8]">Credential import</span>
                    <textarea
                      value={quickImport}
                      onChange={(event) => updateQuickImport(event.target.value)}
                      placeholder="Paste JSON or KEY=VALUE lines"
                      autoComplete="off"
                      spellCheck={false}
                      className="min-h-24 resize-none rounded-md border border-[#253044] bg-[#07090c] px-3 py-3 font-mono text-xs text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#62b7ff]"
                    />
                  </label>
                  <TextInput
                    label="Agent name"
                    value={draft.agent_name || ""}
                    placeholder="optional"
                    onChange={(value) => setDraft({ ...draft, agent_name: value })}
                  />
                </div>
              </details>
              {generatedAgentAddress ? (
                <div className="rounded-lg border border-[#285c49] bg-[#0d251c] p-3 text-sm leading-5 text-[#92e1bd]">
                  Ghola will verify the exact owner-to-agent authorization with Hyperliquid. This cannot pass from a checkbox.
                </div>
              ) : (
                <label className="flex items-start gap-3 rounded-lg border border-[#253044] bg-[#080b10] p-3 text-sm text-[#aab5c8]">
                  <input
                    type="checkbox"
                    checked={confirmedAgentKey}
                    onChange={(event) => setConfirmedAgentKey(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-[#a8d8ff]"
                  />
                  <span>I’m using a dedicated Hyperliquid API wallet key—not my main wallet seed.</span>
                </label>
              )}
            </div>
            <div className="mt-5 rounded-lg border border-[#203349] bg-[#0a1420] px-3 py-2.5 text-xs leading-5 text-[#8ea7c3]">
              Your key is encrypted in this browser. Ghola verifies the connection without placing an order.
            </div>
          </>
        )}

        {error && <p className="mt-4 text-sm text-red-200">{error}</p>}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={closeConnection}
            className={`h-11 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] ${
              iosHandoff ? "order-2 rounded-xl border-0" : ""
            }`}
          >
            {iosHandoff ? "Back to Ghola" : "Cancel"}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`inline-flex h-11 items-center justify-center gap-2 bg-[#ff8c2a] px-4 text-sm font-semibold text-[#08090d] disabled:cursor-not-allowed disabled:bg-[#eef1f8] disabled:opacity-50 ${
              iosHandoff ? "order-1 rounded-xl" : ""
            }`}
          >
            <KeyRound className="h-4 w-4" />
            {connectLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function CoinbaseConnectModal({
  open,
  accountCommitment,
  walletAddress,
  signBytes,
  onClose,
  onConnected,
}: {
  open: boolean;
  accountCommitment: string | null;
  walletAddress: string | null;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  onClose: () => void;
  onConnected: (sealed: VenueVaultState) => void;
}) {
  const [draft, setDraft] = useState<CoinbaseExecutionCredentialDraft>({
    network: "mainnet",
    api_key_name: "",
    api_private_key_pem: "",
    portfolio_id: "",
  });
  const [confirmedTradeKey, setConfirmedTradeKey] = useState(false);
  const [quickImport, setQuickImport] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearCredentialDraft();
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const validationErrors = validateCoinbaseExecutionCredentialDraft(draft);
  const hasKeyName = Boolean(draft.api_key_name.trim());
  const hasPem = Boolean(draft.api_private_key_pem.trim());
  const canSubmit = Boolean(
    accountCommitment &&
      walletAddress &&
      confirmedTradeKey &&
      validationErrors.length === 0 &&
      !submitting,
  );

  function clearCredentialDraft() {
    setDraft({
      network: "mainnet",
      api_key_name: "",
      api_private_key_pem: "",
      portfolio_id: "",
    });
    setQuickImport("");
    setConfirmedTradeKey(false);
  }

  function updateQuickImport(value: string) {
    setQuickImport(value);
    if (!value.trim()) return;
    const imported = parseCoinbaseCredentialImport(value, draft);
    if (imported.fields.length > 0) {
      setDraft(imported.draft);
      setError(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!accountCommitment || !walletAddress) {
      setError("Private account wallet is unavailable.");
      return;
    }
    if (!confirmedTradeKey) {
      setError("Confirm this Coinbase key is scoped for read and trade only.");
      return;
    }
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await buildCoinbaseExecutionVaultBundle({
        accountCommitment,
        ownerWalletAddress: walletAddress,
        credential: draft,
        signBytes,
        executionMode: "byo_api_key",
      });
      const stored = await sealVenueExecutionVault({
        platform_class: "coinbase_style_provider",
        execution_mode: sealed.execution_mode,
        encrypted_execution_vault: sealed.encrypted_execution_vault,
      });
      clearCredentialDraft();
      onConnected(stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Coinbase.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Close Coinbase connection dialog"
        className="absolute inset-0 bg-black/72 backdrop-blur-sm"
        onClick={() => {
          clearCredentialDraft();
          onClose();
        }}
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-lg border border-[#1e2a3a] bg-[#0b0d13] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.72)]"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            clearCredentialDraft();
            onClose();
          }}
          className="absolute right-3 top-3 p-1 text-[#6f798c] hover:bg-[#161822] hover:text-[#eef1f8]"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
          <h2 className="text-lg font-medium text-[#eef1f8]">Connect Coinbase Advanced</h2>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs text-[#8b95a8]">Paste</span>
            <textarea
              value={quickImport}
              onChange={(event) => updateQuickImport(event.target.value)}
              placeholder="Paste Coinbase API key JSON, PEM, or KEY=VALUE lines"
              autoComplete="off"
              spellCheck={false}
              className="min-h-32 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <StatusLine label="Key name" value={hasKeyName ? "found" : "needed"} tone={hasKeyName ? "good" : "warn"} />
            <StatusLine label="Private key" value={hasPem ? "found" : "needed"} tone={hasPem ? "good" : "warn"} />
            <StatusLine label="Network" value={draft.network} tone="good" />
          </div>
          <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Advanced</summary>
            <div className="mt-4 grid gap-4">
              <Select
                label="Network"
                value={draft.network}
                options={[["mainnet", "Mainnet"], ["sandbox", "Sandbox"]]}
                onChange={(value) =>
                  setDraft({ ...draft, network: value === "sandbox" ? "sandbox" : "mainnet" })
                }
              />
              <TextInput
                label="API key name"
                value={draft.api_key_name}
                placeholder="organizations/.../apiKeys/..."
                onChange={(value) => setDraft({ ...draft, api_key_name: value })}
              />
              <label className="grid gap-1.5">
                <span className="text-xs text-[#8b95a8]">EC private key PEM</span>
                <textarea
                  value={draft.api_private_key_pem}
                  onChange={(event) => setDraft({ ...draft, api_private_key_pem: event.target.value })}
                  placeholder="-----BEGIN EC PRIVATE KEY-----"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-28 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
                />
              </label>
              <TextInput
                label="Portfolio id"
                value={draft.portfolio_id || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, portfolio_id: value })}
              />
            </div>
          </details>
          <label className="flex items-start gap-3 border border-[#1e2a3a] bg-[#08090d] p-3 text-sm text-[#aab5c8]">
            <input
              type="checkbox"
              checked={confirmedTradeKey}
              onChange={(event) => setConfirmedTradeKey(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[#a8d8ff]"
            />
            <span>Use this Coinbase Advanced API key for read and trade only. Withdrawals and transfers stay blocked.</span>
          </label>
        </div>

        <div className="mt-5 grid gap-2 border-t border-[#1e2a3a] pt-4 text-xs text-[#8b95a8] sm:grid-cols-2">
          <span>Ghola stores commitments and ciphertext only</span>
          <span>TEE signs Coinbase requests during execution</span>
        </div>

        {error && <p className="mt-4 text-sm text-red-200">{error}</p>}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              clearCredentialDraft();
              onClose();
            }}
            className="h-11 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" />
            {submitting ? "Connecting" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PrivateOrderTicket({
  platformClass,
  order,
  previewCommitment,
  onChange,
}: {
  platformClass: string;
  order: PrivateExecutionOrderDraft;
  previewCommitment: string | null;
  onChange: (order: PrivateExecutionOrderDraft) => void;
}) {
  if (!isExecutionPlatform(platformClass)) return null;
  const normalized = normalizeOrderForPlatform(order, platformClass);
  const jupiterSwap = platformClass === "solana_swap_aggregator";
  const liveTinyFill =
    (platformClass === "hyperliquid_style_market" || platformClass === "solana_perps_market") &&
    normalized.live_order_mode === "tiny_fill";
  const phoenixTinyFill = platformClass === "solana_perps_market" && liveTinyFill;
  const errors = validatePrivateExecutionOrderDraft(normalized);
  const status = previewCommitment ? (errors.length > 0 ? "needs fields" : "ready") : "preview first";

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onChange(normalizeOrderForPlatform({ ...normalized, ...patch }, platformClass));
  }

  if (jupiterSwap) {
    const inputIsSol = normalized.input_mint === JUPITER_SOL_MINT;
    return (
      <div id="trade-intent" className="scroll-mt-24 border border-[#1e2a3a] bg-[#08090d] p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[#8b95a8]">Swap intent</span>
          <span className={errors.length > 0 ? "text-xs text-amber-200" : "text-xs text-emerald-200"}>
            {status}
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SegmentedControl
            label="Pair"
            value={inputIsSol ? "SOL/USDC" : "USDC/SOL"}
            options={[["SOL/USDC", "SOL to USDC"], ["USDC/SOL", "USDC to SOL"]]}
            onChange={(value) => update({
              market: value,
              input_mint: value === "SOL/USDC" ? JUPITER_SOL_MINT : JUPITER_USDC_MINT,
              output_mint: value === "SOL/USDC" ? JUPITER_USDC_MINT : JUPITER_SOL_MINT,
            })}
          />
          <SegmentedControl
            label="Route"
            value={normalized.routing_mode || "meta_aggregator"}
            options={[["meta_aggregator", "Meta"], ["router", "Router"]]}
            onChange={(value) => update({ routing_mode: value === "router" ? "router" : "meta_aggregator" })}
          />
          <TextInput
            label="Input amount"
            value={normalized.amount || ""}
            placeholder={inputIsSol ? "1000000" : "5000000"}
            onChange={(value) => update({ amount: value })}
          />
          <TextInput
            label="Notional cap"
            value={normalized.quote_size || ""}
            placeholder="5"
            onChange={(value) => update({ quote_size: value })}
          />
          <Select
            label="Slippage cap"
            value={normalized.max_slippage_bps || "50"}
            options={[["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"]]}
            onChange={(value) => update({ max_slippage_bps: value })}
          />
          <div className="grid gap-1.5">
            <span className="text-xs text-[#8b95a8]">Submit</span>
            <div className="flex h-10 items-center justify-between border border-[#1e2a3a] bg-[#05070b] px-3 text-sm">
              <span className="text-[#aab5c8]">Jupiter live pilot</span>
              <span className={previewCommitment && errors.length === 0 ? "text-emerald-200" : "text-amber-200"}>
                {previewCommitment ? "ready" : "preview first"}
              </span>
            </div>
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StatusLine label="Mints" value={inputIsSol ? "SOL -> USDC" : "USDC -> SOL"} tone="good" />
          <StatusLine label="Seal" value={previewCommitment ? "on approve" : "pending"} tone={previewCommitment && errors.length === 0 ? "good" : "warn"} />
        </div>
        {errors[0] && <p className="mt-3 text-xs text-amber-200">{errors[0]}</p>}
      </div>
    );
  }

  return (
    <div id="trade-intent" className="scroll-mt-24 border border-[#1e2a3a] bg-[#08090d] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[#8b95a8]">Intent ticket</span>
        <span className={errors.length > 0 ? "text-xs text-amber-200" : "text-xs text-emerald-200"}>
          {status}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextInput
          label={platformClass === "coinbase_style_provider" ? "Product" : "Market"}
          value={normalized.market}
          placeholder={platformClass === "coinbase_style_provider" ? "BTC-USD" : platformClass === "solana_perps_market" ? "SOL" : "BTC"}
          onChange={(value) => update({ market: value })}
        />
        <LabeledOrderSideToggle
          side={normalized.side === "sell" ? "sell" : "buy"}
          onChange={(nextSide) => update({ side: nextSide })}
        />
        {liveTinyFill ? (
          <>
            <TextInput
              label="Amount"
              value={normalized.quote_size || ""}
              placeholder="5"
              onChange={(value) => update({ quote_size: value })}
            />
            <TextInput
              label={phoenixTinyFill ? "Price limit" : "Slippage cap bps"}
              value={phoenixTinyFill ? normalized.limit_price : normalized.max_slippage_bps || "50"}
              placeholder={phoenixTinyFill ? "250" : "50"}
              onChange={(value) => update(phoenixTinyFill ? { limit_price: value } : { max_slippage_bps: value })}
            />
          </>
        ) : (
          <>
            <TextInput
              label="Base size"
              value={normalized.base_size}
              placeholder="0.001"
              onChange={(value) => update({ base_size: value })}
            />
            <TextInput
              label="Limit"
              value={normalized.limit_price}
              placeholder="10000"
              onChange={(value) => update({ limit_price: value })}
            />
          </>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <StatusLine
          label="Mode"
          value={liveTinyFill ? "tiny live IOC" : normalized.operation_class}
          tone="good"
        />
        <StatusLine
          label="Seal"
          value={previewCommitment ? "on approve" : "pending"}
          tone={previewCommitment && errors.length === 0 ? "good" : "warn"}
        />
      </div>
      {errors[0] && <p className="mt-3 text-xs text-amber-200">{errors[0]}</p>}
    </div>
  );
}

function JupiterTradingPanel({
  quote,
  quoteStatus,
  order,
  previewCommitment,
  working = false,
  accountReady,
  previewActionReady = accountReady,
  onOrderChange,
  onPreview,
}: {
  quote: MobileMarketJupiter | null;
  quoteStatus: JupiterQuoteStatus;
  order: PrivateExecutionOrderDraft;
  previewCommitment: string | null;
  working?: boolean;
  accountReady: boolean;
  previewActionReady?: boolean;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
  onPreview?: () => void;
}) {
  const normalized = normalizeOrderForPlatform(order, "solana_swap_aggregator");
  const errors = validatePrivateExecutionOrderDraft(normalized);
  const [chartMode, setChartMode] = useState<GholaChartMode>("route");
  const connection = jupiterQuoteConnectionCopy(quoteStatus, quote);
  const direction = normalized.input_mint === JUPITER_SOL_MINT ? "sol-usdc" : "usdc-sol";
  const routeSummary = quote?.route_summary.length ? quote.route_summary.join(" / ") : "route pending";

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange(normalizeOrderForPlatform({ ...normalized, ...patch }, "solana_swap_aggregator"));
  }

  function updateDirection(value: string) {
    const solToUsdc = value === "sol-usdc";
    update({
      input_mint: solToUsdc ? JUPITER_SOL_MINT : JUPITER_USDC_MINT,
      output_mint: solToUsdc ? JUPITER_USDC_MINT : JUPITER_SOL_MINT,
      amount: solToUsdc ? normalized.amount || "1000000000" : normalized.amount || "1000000",
    });
  }

  return (
    <div className="border border-[#1e2a3a] bg-[#08090d] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#a8d8ff]" />
          <div>
            <h3 className="text-lg font-medium text-[#eef1f8]">Jupiter</h3>
            <p className="mt-1 text-xs text-[#8b95a8]">
              Route quote view. Preview before a swap transaction is built or submitted.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[#8b95a8]">public quote</span>
          <span className={connection.tone === "good" ? "text-xs text-emerald-200" : connection.tone === "bad" ? "text-xs text-red-200" : "text-xs text-amber-200"}>
            {connection.label}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="border border-[#162337] bg-[#05070b] p-3">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs text-[#6f7d9a]">SOL/USDC route</p>
              <p className="text-4xl font-medium tabular-nums text-[#eef1f8]">
                {quote?.price ? formatJupiterRoutePrice(quote.price) : "Loading"}
              </p>
            </div>
            <div className="text-right text-xs tabular-nums text-[#8b95a8]">
              <div>Output {formatJupiterOutputAmount(quote?.output_amount)}</div>
              <div>Impact {quote?.price_impact_pct ? `${quote.price_impact_pct}%` : "-"}</div>
              <div>Slippage {quote?.slippage_bps ?? normalized.max_slippage_bps ?? "50"} bps</div>
              <div>{quote?.stale ? "stale quote" : quote ? "fresh quote" : "waiting"}</div>
            </div>
          </div>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <MarketStat label="Route" value={routeSummary} />
            <MarketStat label="Input" value={formatJupiterInputAmount(quote?.input_amount || normalized.amount)} />
            <MarketStat
              label="Impact"
              value={quote?.price_impact_pct ? `${quote.price_impact_pct}%` : "-"}
              tone={Number(quote?.price_impact_pct || "0") > 0.5 ? "bad" : "neutral"}
            />
          </div>
          <GholaMarketChart
            label="Jupiter"
            frame={gholaFrameFromJupiter(quote)}
            overlays={buildGholaAgentChartOverlays({
              order: normalized,
              mid: quote?.price || null,
              previewCommitment,
              accountReady,
              venueLabel: "Jupiter",
            })}
            mode={chartMode}
            onModeChange={setChartMode}
            size="large"
            height={460}
          />
        </div>

        <div className="grid gap-3">
          <div id="trade-intent" className="scroll-mt-24 border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[#eef1f8]">Intent</p>
                <p className="mt-1 text-xs text-[#6f7d9a]">Private swap route</p>
              </div>
              <span className={previewCommitment && errors.length === 0 ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {previewCommitment ? "previewed" : accountReady ? "preview first" : "connect access"}
              </span>
            </div>
            <SegmentedControl
              label="Direction"
              value={direction}
              options={[["sol-usdc", "SOL to USDC"], ["usdc-sol", "USDC to SOL"]]}
              onChange={updateDirection}
            />
            <div className="mt-3 grid gap-3">
              <TextInput
                label="Input amount"
                value={normalized.amount || ""}
                placeholder={direction === "sol-usdc" ? "1000000000" : "1000000"}
                onChange={(amount) => update({ amount })}
              />
              <Select
                label="Notional cap"
                value={normalized.quote_size || "5"}
                options={[["5", "$5"], ["10", "$10"], ["25", "$25"], ["50", "$50"]]}
                onChange={(quote_size) => update({ quote_size })}
              />
              <Select
                label="Slippage cap"
                value={normalized.max_slippage_bps || "50"}
                options={[["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"], ["250", "250 bps"]]}
                onChange={(max_slippage_bps) => update({ max_slippage_bps })}
              />
            </div>
            <button
              type="button"
              onClick={onPreview}
              disabled={working || !onPreview || errors.length > 0 || !previewActionReady}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 bg-[#eef1f8] px-3 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {working
                ? "Checking"
                : previewCommitment
                  ? "Preview again"
                  : accountReady
                    ? "Preview swap"
                    : previewActionReady ? "Sign in to preview" : "Connect access"}
            </button>
            {errors[0] && <p className="mt-3 text-xs leading-5 text-amber-200">{errors[0]}</p>}
          </div>

          <div className="border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs text-[#6f7d9a]">Execution visibility</span>
              <span className={accountReady ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {accountReady ? "access ready" : "setup first"}
              </span>
            </div>
            <div className="grid gap-2">
              <StatusLine label="Main wallet" value="not exposed" tone="good" />
              <StatusLine label="Ghola" value="sealed runtime" tone="good" />
              <StatusLine label="Jupiter sees" value="swap authority + route" tone="warn" />
              <StatusLine label="Public chain" value="submitted swap tx after approval" tone="warn" />
            </div>
            <p className="mt-3 border-t border-[#162337] pt-3 text-xs leading-5 text-[#8b95a8]">
              The chart tracks quote output, route depth proxy, slippage, and the venue-visible boundary.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CoinbaseTradingPanel({
  productId,
  interval,
  snapshot,
  marketStatus,
  order,
  previewCommitment,
  working = false,
  accountReady,
  previewActionReady = accountReady,
  onProductChange,
  onIntervalChange,
  onOrderChange,
  onPreview,
}: {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  snapshot: CoinbaseMarketSnapshot | null;
  marketStatus: CoinbaseLiveMarketStatus;
  order: PrivateExecutionOrderDraft;
  previewCommitment: string | null;
  working?: boolean;
  accountReady: boolean;
  previewActionReady?: boolean;
  onProductChange: (productId: CoinbaseProductId) => void;
  onIntervalChange: (interval: CoinbaseCandleInterval) => void;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
  onPreview?: () => void;
}) {
  const normalized = normalizeOrderForPlatform(order, "coinbase_style_provider");
  const errors = validatePrivateExecutionOrderDraft(normalized);
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const price = snapshot?.price || snapshot?.mid;
  const stats = coinbaseMarketStats(snapshot);
  const connection = coinbaseMarketConnectionCopy(marketStatus, snapshot);
  const accessLabel = accountReady ? "ready to preview" : "connect access";

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange(normalizeOrderForPlatform({ ...normalized, ...patch }, "coinbase_style_provider"));
  }

  return (
    <div className="border border-[#1e2a3a] bg-[#08090d] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#a8d8ff]" />
          <div>
            <h3 className="text-lg font-medium text-[#eef1f8]">Coinbase Advanced</h3>
            <p className="mt-1 text-xs text-[#8b95a8]">Public market view. Private execution still uses a preview check.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[#8b95a8]">public feed</span>
          <span className={connection.tone === "good" ? "text-xs text-emerald-200" : connection.tone === "bad" ? "text-xs text-red-200" : "text-xs text-amber-200"}>
            {connection.label}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <TerminalChips
          label="Product"
          value={productId}
          options={COINBASE_PRODUCTS}
          onChange={(value) => onProductChange(coinbaseProductFromOrder(value))}
        />
        <TerminalChips
          label="Interval"
          value={interval}
          options={COINBASE_INTERVALS}
          align="right"
          onChange={(value) => onIntervalChange(value === "1m" || value === "15m" || value === "1h" ? value : "5m")}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="border border-[#162337] bg-[#05070b] p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-[#6f7d9a]">{productId}</p>
              <p className="text-4xl font-medium tabular-nums text-[#eef1f8]">
                {price ? formatPrice(price) : "Loading"}
              </p>
            </div>
            <div className="text-right text-xs tabular-nums text-[#8b95a8]">
              <div>Bid {snapshot?.best_bid ? formatBookPrice(snapshot.best_bid) : "-"}</div>
              <div>Ask {snapshot?.best_ask ? formatBookPrice(snapshot.best_ask) : "-"}</div>
              <div>Spread {formatSpreadBps(snapshot)}</div>
              <div>Type {snapshot?.product_type || "spot"}</div>
            </div>
          </div>
          <div className="mb-3 grid gap-2 sm:grid-cols-3 2xl:grid-cols-6">
            <MarketStat label="24h" value={stats.dayChangeLabel} tone={stats.dayChangeTone} />
            <MarketStat label="Window" value={stats.changeLabel} tone={stats.changeTone} />
            <MarketStat label="High" value={stats.highLabel} />
            <MarketStat label="Low" value={stats.lowLabel} />
            <MarketStat label="Quote vol" value={stats.quoteVolumeLabel} />
            <MarketStat label="Base vol" value={stats.baseVolumeLabel} />
          </div>
          <GholaMarketChart
            label="Coinbase"
            frame={gholaFrameFromCoinbase(snapshot)}
            overlays={buildGholaAgentChartOverlays({
              order: normalized,
              mid: snapshot?.mid || snapshot?.price || null,
              previewCommitment,
              accountReady,
              venueLabel: "Coinbase",
            })}
            mode={chartMode}
            onModeChange={setChartMode}
            size="large"
            onSelectPrice={(price, side) => update({ limit_price: price, side, order_type: "limit" })}
          />
        </div>

        <div className="grid gap-3">
          <div id="trade-intent" className="scroll-mt-24 border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[#eef1f8]">Intent</p>
                <p className="mt-1 text-xs text-[#6f7d9a]">Spot limit order</p>
              </div>
              <span className={previewCommitment && errors.length === 0 ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {previewCommitment ? "previewed" : accessLabel}
              </span>
            </div>
            <LabeledOrderSideToggle
              side={normalized.side === "sell" ? "sell" : "buy"}
              onChange={(nextSide) => update({ side: nextSide })}
            />
            <div className="mt-3 grid gap-3">
              <TextInput
                label="Base size"
                value={normalized.base_size}
                placeholder={productId === "BTC-USD" ? "0.001" : productId === "ETH-USD" ? "0.01" : "0.1"}
                onChange={(value) => update({ base_size: value })}
              />
              <TextInput
                label="Limit"
                value={normalized.limit_price}
                placeholder={price || "10000"}
                onChange={(value) => update({ limit_price: value })}
              />
              <Select
                label="Time in force"
                value={normalized.tif || "gtc"}
                options={[["gtc", "GTC"], ["ioc", "IOC"], ["fok", "FOK"]]}
                onChange={(value) => update({ tif: value as "gtc" | "ioc" | "fok" })}
              />
            </div>
            <button
              type="button"
              onClick={onPreview}
              disabled={working || !onPreview || errors.length > 0 || !previewActionReady}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 bg-[#eef1f8] px-3 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {working
                ? "Checking"
                : previewCommitment
                  ? "Preview again"
                  : accountReady
                    ? "Preview intent"
                    : previewActionReady ? "Sign in to preview" : "Connect access"}
            </button>
            {errors[0] && <p className="mt-3 text-xs leading-5 text-amber-200">{errors[0]}</p>}
          </div>

          <div className="border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
              <span>Orderbook</span>
              <span>{productId}</span>
            </div>
            <OrderbookRows side="ask" levels={snapshot?.asks || []} />
            <div className="my-2 border-t border-[#162337]" />
            <OrderbookRows side="bid" levels={snapshot?.bids || []} />
          </div>

          <RecentTradeRows trades={snapshot?.recent_trades || []} />

          <div className="border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs text-[#6f7d9a]">Execution visibility</span>
              <span className={accountReady ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {accountReady ? "access ready" : "setup first"}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              <StatusLine label="Main wallet" value="not exposed" tone="good" />
              <StatusLine label="Ghola" value="sealed runtime" tone="good" />
              <StatusLine label="Coinbase sees" value="partner pool or BYO account" tone="warn" />
              <StatusLine label="Public chain" value="no direct trade settlement" tone="good" />
            </div>
            <p className="mt-3 border-t border-[#162337] pt-3 text-xs leading-5 text-[#8b95a8]">
              Coinbase market data is public. Orders still require the private preview and an armed execution path.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function HyperliquidTradingPanel({
  layout = "compact",
  market,
  interval,
  snapshot,
  marketStatus,
  accountSnapshot,
  accountStreamStatus,
  order,
  previewCommitment,
  working = false,
  previewActionReady,
  onMarketChange,
  onIntervalChange,
  onOrderChange,
  onConnect,
  onPreview,
}: {
  layout?: "compact" | "full";
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  interval: "1m" | "5m" | "15m" | "1h";
  snapshot: HyperliquidMarketSnapshot | null;
  marketStatus: HyperliquidLiveMarketStatus;
  accountSnapshot: HyperliquidAccountSnapshot | null;
  accountStreamStatus: HyperliquidAccountStreamStatus;
  order: PrivateExecutionOrderDraft;
  previewCommitment: string | null;
  working?: boolean;
  previewActionReady?: boolean;
  onMarketChange: (market: "BTC" | "ETH" | "SOL" | "HYPE") => void;
  onIntervalChange: (interval: "1m" | "5m" | "15m" | "1h") => void;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
  onConnect?: () => void;
  onPreview?: () => void;
}) {
  const normalized = normalizeOrderForPlatform(order, "hyperliquid_style_market");
  const errors = validatePrivateExecutionOrderDraft(normalized);
  const mid = snapshot?.mid ? formatPrice(snapshot.mid) : "Loading";
  const status = accountSnapshot?.status || "venue_access_required";
  const stats = hyperliquidMarketStats(snapshot);
  const marketConnection = hyperliquidMarketConnectionCopy(marketStatus, snapshot);
  const accountConnection = accountSnapshot?.stream_status || accountStreamStatus;
  const accountLive = accountConnection === "live";
  const fullLayout = layout === "full";
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const hasConnectedAccount = Boolean(
    accountSnapshot && accountSnapshot.account_source !== "none" && status !== "venue_access_required",
  );
  const canPreviewTrade = status === "ready_to_trade";
  const canRunPreviewAction = previewActionReady ?? canPreviewTrade;

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange(normalizeOrderForPlatform({ ...normalized, ...patch }, "hyperliquid_style_market"));
  }

  return (
    <div className={fullLayout ? "bg-[#08090d]" : "border border-[#1e2a3a] bg-[#08090d] p-3"}>
      {fullLayout ? (
        null
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#a8d8ff]" />
              <div>
                <h3 className="text-sm font-medium text-[#eef1f8]">
                  Hyperliquid
                </h3>
                <p className="mt-1 text-xs text-[#8b95a8]">
                  Chart, orderbook, preview, trade.
                </p>
              </div>
            </div>
            <span className={marketConnection.tone === "good" ? "text-xs text-emerald-200" : marketConnection.tone === "bad" ? "text-xs text-red-200" : "text-xs text-amber-200"}>
              {marketConnection.label}
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SegmentedControl
            label="Market"
            value={market}
            options={HYPERLIQUID_MARKETS}
            onChange={(value) => onMarketChange(marketCoinFromOrder(value))}
          />
          <SegmentedControl
            label="Chart"
            value={interval}
            options={HYPERLIQUID_INTERVALS}
            onChange={(value) => onIntervalChange(value === "1m" || value === "15m" || value === "1h" ? value : "5m")}
          />
        </div>
        </>
      )}

      <div
        className={
          fullLayout
            ? "grid min-h-[calc(100vh-4rem)] items-start gap-0 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)_minmax(440px,540px)]"
            : "mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]"
        }
      >
        {fullLayout && (
          <HyperliquidIntentHeader
            market={market}
            interval={interval}
            marketConnection={marketConnection}
            previewCommitment={previewCommitment}
            hasConnectedAccount={hasConnectedAccount}
            accountReady={canRunPreviewAction}
            stats={stats}
            mid={mid}
            onMarketChange={(value) => onMarketChange(marketCoinFromOrder(value))}
            onIntervalChange={(value) => onIntervalChange(value === "1m" || value === "15m" || value === "1h" ? value : "5m")}
          />
        )}

        <div className={fullLayout ? "order-3 min-w-0 self-start border-r border-[#1e2a3a] bg-[#05070b] xl:order-none xl:col-start-1 xl:row-start-2" : "self-start border border-[#162337] bg-[#05070b] p-3"}>
          <div className={fullLayout ? "p-5 2xl:p-6" : ""}>
          <div className={fullLayout ? "mb-5 grid min-w-0 gap-4 2xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] 2xl:items-start" : "mb-3 flex flex-wrap items-center justify-between gap-2"}>
            <div className="min-w-0">
              {fullLayout && <p className="font-mono text-xs uppercase tracking-[0.22em] text-[#6f7d9a]">Live evidence board</p>}
              <p className={fullLayout ? "mt-2 max-w-[14ch] break-words text-2xl font-semibold leading-none text-[#eef1f8] sm:text-3xl" : "text-xs text-[#6f7d9a]"}>
                {fullLayout ? `${market}-PERP orderflow` : `${market} mid`}
              </p>
              {!fullLayout && <p className="text-2xl font-medium text-[#eef1f8]">
                {mid}
              </p>}
            </div>
            <div className={fullLayout ? "grid min-w-0 grid-cols-2 gap-3 text-left sm:grid-cols-4 2xl:text-right" : "text-right text-xs text-[#8b95a8]"}>
              {fullLayout ? (
                <>
                  <MarketHeaderStat label="Mid" value={mid} />
                  <MarketHeaderStat label="Spread" value={snapshot?.spread_bps == null ? "-" : `${snapshot.spread_bps} bps`} />
                  <MarketHeaderStat label="Funding" value={stats.fundingLabel} />
                  <MarketHeaderStat label="24h volume" value={stats.volumeLabel} />
                </>
              ) : (
                <>
                  <div>Bid {snapshot?.best_bid ? formatBookPrice(snapshot.best_bid) : "-"}</div>
                  <div>Ask {snapshot?.best_ask ? formatBookPrice(snapshot.best_ask) : "-"}</div>
                  <div>Spread {snapshot?.spread_bps == null ? "-" : `${snapshot.spread_bps} bps`}</div>
                </>
              )}
            </div>
          </div>
          {!fullLayout && (
            <div className="mb-3 grid gap-2 sm:grid-cols-3">
              <MarketStat label="Move" value={stats.changeLabel} tone={stats.changeTone} />
              <MarketStat label="High" value={stats.highLabel} />
              <MarketStat label="Low" value={stats.lowLabel} />
            </div>
          )}
          <GholaMarketChart
            label="Hyperliquid"
            frame={gholaFrameFromHyperliquid(snapshot)}
            overlays={buildGholaAgentChartOverlays({
              order: normalized,
              mid: snapshot?.mid || snapshot?.mark_price || null,
              previewCommitment,
              accountReady: canPreviewTrade,
              venueLabel: "Hyperliquid",
            })}
            mode={fullLayout ? chartMode : "line"}
            onModeChange={setChartMode}
            size={fullLayout ? "large" : "compact"}
            height={fullLayout ? 540 : undefined}
            onSelectPrice={(price, side) => update({
              limit_price: price,
              side,
              order_type: "limit",
              live_order_mode: undefined,
            })}
          />
          </div>
        </div>

        {fullLayout && (
          <HyperliquidActivityStack
            market={market}
            snapshot={snapshot}
          />
        )}

        <div className={fullLayout ? "order-2 grid min-h-0 self-stretch border-l border-[#1e2a3a] bg-[#05070b] xl:sticky xl:top-16 xl:order-none xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:max-h-[calc(100vh-4rem)] xl:overflow-y-auto" : "grid gap-3"}>
          {fullLayout && (
            <HyperliquidOrderTicket
              order={normalized}
              errors={errors}
              previewCommitment={previewCommitment}
              working={working}
              market={market}
              currentPrice={snapshot?.mid || snapshot?.mark_price || null}
              hasConnectedAccount={hasConnectedAccount}
              accountReady={canRunPreviewAction}
              disabledReason={hyperliquidAccountStreamLabel(accountConnection)}
              onUpdate={update}
              onConnect={onConnect}
              onPreview={onPreview}
            />
          )}
          {!fullLayout && (
            <div className="border border-[#162337] bg-[#05070b] p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
                <span>Orderbook</span>
                <span>{market}</span>
              </div>
              <OrderbookRows side="ask" levels={snapshot?.asks || []} />
              <div className="my-2 border-t border-[#162337]" />
              <OrderbookRows side="bid" levels={snapshot?.bids || []} />
            </div>
          )}
          {!fullLayout && (
            <HyperliquidAccountStatusPanel
              status={status}
              hasConnectedAccount={hasConnectedAccount}
              accountSnapshot={accountSnapshot}
              accountConnection={accountConnection}
              accountLive={accountLive}
            />
          )}
        </div>
      </div>

      {!fullLayout && <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <LabeledOrderSideToggle
          side={normalized.side === "sell" ? "sell" : "buy"}
          onChange={(nextSide) => update({ side: nextSide })}
        />
        <Select
          label="Amount"
          value={normalized.quote_size || "5"}
          options={[["5", "$5"], ["10", "$10"], ["11", "$11 proof"], ["25", "$25"]]}
          onChange={(value) => update({ quote_size: value })}
        />
        <Select
          label="Slippage cap"
          value={normalized.max_slippage_bps || "50"}
          options={[["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"]]}
          onChange={(value) => update({ max_slippage_bps: value })}
        />
        <div className="grid gap-1.5">
          <span className="text-xs text-[#8b95a8]">Submit</span>
          <div className="flex h-10 items-center justify-between border border-[#1e2a3a] bg-[#05070b] px-3 text-sm">
            <span className="text-[#aab5c8]">IOC tiny-fill</span>
            <span className={previewCommitment && errors.length === 0 ? "text-emerald-200" : "text-amber-200"}>
              {previewCommitment ? "ready" : "preview first"}
            </span>
          </div>
        </div>
      </div>}

      {!fullLayout && <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <StatusLine label="Main wallet" value="not exposed" tone="good" />
        <StatusLine label="Venue sees" value="order" tone="warn" />
        <StatusLine label="Public chain" value="not used" tone="good" />
      </div>}
      {!fullLayout && errors[0] && <p className="mt-3 text-xs text-amber-200">{errors[0]}</p>}
    </div>
  );
}

function HyperliquidIntentHeader({
  market,
  interval,
  marketConnection,
  previewCommitment,
  hasConnectedAccount,
  accountReady,
  stats,
  mid,
  onMarketChange,
  onIntervalChange,
}: {
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  interval: "1m" | "5m" | "15m" | "1h";
  marketConnection: ReturnType<typeof hyperliquidMarketConnectionCopy>;
  previewCommitment: string | null;
  hasConnectedAccount: boolean;
  accountReady: boolean;
  stats: ReturnType<typeof hyperliquidMarketStats>;
  mid: string;
  onMarketChange: (market: "BTC" | "ETH" | "SOL" | "HYPE") => void;
  onIntervalChange: (interval: string) => void;
}) {
  const connectionClass =
    marketConnection.tone === "good"
      ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100"
      : marketConnection.tone === "bad"
        ? "border-red-300/35 bg-red-300/10 text-red-100"
        : "border-amber-300/35 bg-amber-300/10 text-amber-100";
  const sealLabel = previewCommitment ? shortCommitment(previewCommitment) : "preview creates seal";
  return (
    <div className="min-w-0 border-b border-r border-[#1e2a3a] bg-[#080b10] px-5 py-4 xl:col-span-2 xl:row-start-1 2xl:px-6">
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.72fr)] 2xl:items-end">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-2 border border-[#2f463c] bg-[#11231c] px-2.5 text-xs font-medium uppercase tracking-[0.12em] text-emerald-100">
              <LockKeyhole className="h-3.5 w-3.5" />
              Captured intent
            </span>
            <span className={`inline-flex h-7 items-center border px-2.5 text-xs font-medium uppercase tracking-[0.12em] ${connectionClass}`}>
              {marketConnection.label}
            </span>
            <span className="inline-flex h-7 items-center border border-[#4d4325] bg-[#211d10] px-2.5 text-xs font-medium uppercase tracking-[0.12em] text-[#fff1a8]">
              {hasConnectedAccount ? accountReady ? "agent ready" : "finish setup" : "connect wallet"}
            </span>
          </div>
          <h1 className="text-2xl font-semibold leading-tight text-[#f6f8ff]">
            Capture intent
          </h1>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-[#8b95a8]">
            Describe the outcome in plain English. Ghola seals it and commits
            only a capped trade.
          </p>
        </div>

        <div className="grid min-w-0 gap-3">
          <div className="hidden gap-2 sm:grid sm:grid-cols-3">
            <IntentHeaderMetric label="Live market" value={`${market}-PERP @ ${mid}`} />
            <IntentHeaderMetric label="Move" value={stats.changeLabel} tone={stats.changeTone} />
            <IntentHeaderMetric label="Intent seal" value={sealLabel} tone={previewCommitment ? "good" : "warn"} />
          </div>
          <div className="hidden gap-2 sm:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex flex-wrap gap-1.5">
              {HYPERLIQUID_MARKETS.map(([value, label]) => {
                const selected = value === market;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onMarketChange(value)}
                    className={compactSelectorClass(selected, "h-8 px-3 text-xs")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-1.5 lg:justify-end">
              {HYPERLIQUID_INTERVALS.map(([value, label]) => {
                const selected = value === interval;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onIntervalChange(value)}
                    className={compactSelectorClass(selected, "h-8 px-3 text-xs")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function IntentHeaderMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  const valueClass =
    tone === "good" ? "text-emerald-200" : tone === "bad" ? "text-red-200" : tone === "warn" ? "text-[#fff1a8]" : "text-[#eef1f8]";
  return (
    <div className="min-w-0 border border-[#1e2a3a] bg-[#05070b] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">{label}</p>
      <p className={`mt-1 truncate text-sm font-medium tabular-nums ${valueClass}`} title={value}>
        {value}
      </p>
    </div>
  );
}

function HyperliquidActivityStack({
  market,
  snapshot,
}: {
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  snapshot: HyperliquidMarketSnapshot | null;
}) {
  const stats = hyperliquidMarketStats(snapshot);
  return (
    <div className="order-4 grid content-start gap-4 border-b border-[#1e2a3a] bg-[#05070b] p-8 xl:order-none xl:col-start-2 xl:row-start-2">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <MarketStat label="24h high" value={stats.highLabel} />
        <MarketStat label="24h low" value={stats.lowLabel} />
      </div>
      <div className="border border-[#162337] bg-[#05070b] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
          <span>Orderbook</span>
          <span>{market}</span>
        </div>
        <OrderbookRows side="ask" levels={snapshot?.asks || []} />
        <div className="my-2 border-t border-[#162337]" />
        <OrderbookRows side="bid" levels={snapshot?.bids || []} />
      </div>
      <RecentTradeRows trades={snapshot?.recent_trades || []} />
    </div>
  );
}

function HyperliquidAccountStatusPanel({
  status,
  hasConnectedAccount,
  accountSnapshot,
  accountConnection,
  accountLive,
  showAccountRows = false,
}: {
  status: string;
  hasConnectedAccount: boolean;
  accountSnapshot: HyperliquidAccountSnapshot | null;
  accountConnection: HyperliquidAccountStreamStatus | string | undefined;
  accountLive: boolean;
  showAccountRows?: boolean;
}) {
  return (
    <div className="border border-[#162337] bg-[#05070b] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs text-[#6f7d9a]">Account + privacy</span>
        <span className={status === "ready_to_trade" ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
          {hasConnectedAccount ? hyperliquidAccountStatusLabel(status) : "API wallet needed"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <StatusLine
          label="API wallet"
          value={hasConnectedAccount ? hyperliquidAccountStatusLabel(status) : "not connected"}
          tone={status === "ready_to_trade" ? "good" : "warn"}
        />
        <StatusLine
          label="Equity"
          value={hasConnectedAccount ? hyperliquidEquityBucketLabel(accountSnapshot?.equity_bucket) : "-"}
          tone={accountSnapshot?.equity_bucket === "ready" ? "good" : "warn"}
        />
        <StatusLine
          label="Positions"
          value={hasConnectedAccount ? String(accountSnapshot?.position_count ?? 0) : "-"}
          tone="good"
        />
        <StatusLine
          label="Open orders"
          value={hasConnectedAccount ? String(accountSnapshot?.open_order_count ?? 0) : "-"}
          tone="good"
        />
        <StatusLine
          label="Stream"
          value={hyperliquidAccountStreamLabel(accountConnection)}
          tone={accountLive ? "good" : "warn"}
        />
        <StatusLine label="Main wallet" value="hidden" tone="good" />
        <StatusLine label="Ghola" value="private runtime" tone="good" />
        <StatusLine label="Hyperliquid sees" value="API wallet + order" tone="warn" />
      </div>
      {showAccountRows && (
        <div className="mt-3 border-t border-[#162337] pt-3">
          <HyperliquidAccountRows accountSnapshot={accountSnapshot} />
        </div>
      )}
      <p className="mt-3 border-t border-[#162337] pt-3 text-xs leading-5 text-[#8b95a8]">
        {status === "ready_to_trade"
          ? accountLive
            ? "Run the privacy check, then place the capped IOC order."
            : "Preview is available. Account stream will fill in when the worker update lands."
          : "The chart is public market data. Connect a scoped API wallet before the agent can preview or submit a trade."}
      </p>
    </div>
  );
}

function TerminalChips({
  label,
  value,
  options,
  align = "left",
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  align?: "left" | "right";
  onChange: (value: string) => void;
}) {
  return (
    <div className={align === "right" ? "grid gap-1.5 lg:justify-items-end" : "grid gap-1.5"}>
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([optionValue, optionLabel]) => {
          const selected = optionValue === value;
          return (
            <button
              key={optionValue}
              type="button"
              onClick={() => onChange(optionValue)}
              className={compactSelectorClass(selected, "h-8 min-w-14 px-3 text-sm")}
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HyperliquidAccountRows({ accountSnapshot }: { accountSnapshot: HyperliquidAccountSnapshot | null }) {
  const positions = accountSnapshot?.positions || [];
  const openOrders = accountSnapshot?.open_orders || [];
  const fills = accountSnapshot?.recent_fills || [];
  return (
    <div className="grid gap-3 pt-1 text-xs">
      <AccountMiniTable
        title="Positions"
        empty="No live positions"
        rows={positions.map((position) => [
          position.market,
          position.side,
          position.size_bucket,
          position.unrealized_pnl_bucket,
        ])}
      />
      <AccountMiniTable
        title="Open orders"
        empty="No open orders"
        rows={openOrders.map((order) => [
          order.market,
          order.side,
          order.size_bucket,
          order.price_bucket,
        ])}
      />
      <AccountMiniTable
        title="Recent fills"
        empty="No recent fills"
        rows={fills.map((fill) => [
          fill.market,
          fill.side,
          fill.size_bucket,
          fill.price_bucket,
        ])}
      />
    </div>
  );
}

function OrderSideToggle({
  side,
  onChange,
}: {
  side: "buy" | "sell";
  onChange: (side: "buy" | "sell") => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-[5px] border border-[#1e2a3a] bg-[#080b10] p-1" role="group" aria-label="Order side">
      <button
        type="button"
        aria-pressed={side === "buy"}
        onClick={() => onChange("buy")}
        className={orderSideButtonClass("buy", side === "buy")}
      >
        Buy
      </button>
      <button
        type="button"
        aria-pressed={side === "sell"}
        onClick={() => onChange("sell")}
        className={orderSideButtonClass("sell", side === "sell")}
      >
        Sell
      </button>
    </div>
  );
}

function LabeledOrderSideToggle({
  side,
  onChange,
}: {
  side: "buy" | "sell";
  onChange: (side: "buy" | "sell") => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-[#8b95a8]">Side</span>
      <OrderSideToggle side={side} onChange={onChange} />
    </div>
  );
}

function orderSideButtonClass(side: "buy" | "sell", selected: boolean) {
  const base = "h-9 rounded-[3px] text-sm font-semibold transition disabled:cursor-not-allowed";
  if (!selected) {
    return `${base} text-[#8b95a8] hover:bg-[#101722] hover:text-[#d8e6f8]`;
  }
  if (side === "buy") {
    return `${base} bg-[#173126] text-[#d9fff1]`;
  }
  return `${base} bg-[#341820] text-[#ffe4e7]`;
}

function AccountMiniTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: string[][];
}) {
  return (
    <div>
      <div className="mb-1 text-[#6f7d9a]">{title}</div>
      {rows.length === 0 ? (
        <div className="text-[#59657a]">{empty}</div>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 4).map((row, index) => (
            <div key={`${title}-${index}-${row.join("-")}`} className="grid grid-cols-4 gap-2 text-[#aab5c8]">
              {row.map((cell, cellIndex) => (
                <span key={`${cell}-${cellIndex}`} className={cellIndex === 1 && (cell === "buy" || cell === "long") ? "text-emerald-200" : cellIndex === 1 ? "text-red-200" : ""}>
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MandateParameterFields({
  order,
  market,
  strategyProfile,
  entryTrigger,
  exitRule,
  timeHorizon,
  onUpdate,
}: {
  order: PrivateExecutionOrderDraft;
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  strategyProfile: NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
  entryTrigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  exitRule: NonNullable<PrivateExecutionOrderDraft["agent_exit_rule"]>;
  timeHorizon: NonNullable<PrivateExecutionOrderDraft["agent_time_horizon"]>;
  onUpdate: (patch: Partial<PrivateExecutionOrderDraft>) => void;
}) {
  const needsTriggerLevel =
    entryTrigger === "break_level" ||
    entryTrigger === "retest_level" ||
    entryTrigger === "sweep_reclaim";
  const needsEdgeThreshold =
    entryTrigger === "book_imbalance" ||
    entryTrigger === "funding_mark_divergence" ||
    entryTrigger === "route_edge_threshold" ||
    strategyProfile === "funding_mark_divergence" ||
    strategyProfile === "venue_route_edge" ||
    strategyProfile === "funding_basis";
  const needsInvalidation =
    exitRule === "exit_on_invalidation" ||
    exitRule === "reduce_on_risk_flip" ||
    strategyProfile === "reversal" ||
    strategyProfile === "sweep_reclaim";
  const needsTimeWindow = timeHorizon === "custom_window";
  const needsRange = strategyProfile === "range_trade";
  if (!needsTriggerLevel && !needsEdgeThreshold && !needsInvalidation && !needsTimeWindow && !needsRange) return null;

  return (
    <div className="grid gap-3 border border-[#162337] bg-[#08090d] p-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      {needsRange && (
        <>
          <TextInput
            label="Range low"
            value={order.agent_range_low || ""}
            placeholder={`${market} price`}
            onChange={(agent_range_low) => onUpdate({ agent_range_low })}
          />
          <TextInput
            label="Range high"
            value={order.agent_range_high || ""}
            placeholder={`${market} price`}
            onChange={(agent_range_high) => onUpdate({ agent_range_high })}
          />
        </>
      )}
      {needsTriggerLevel && (
        <TextInput
          label={entryTrigger === "sweep_reclaim" ? "Reclaim level" : "Entry level"}
          value={order.agent_trigger_level || ""}
          placeholder={`${market} price`}
          onChange={(agent_trigger_level) => onUpdate({ agent_trigger_level })}
        />
      )}
      {needsEdgeThreshold && (
        <TextInput
          label={entryTrigger === "book_imbalance" ? "Book shift threshold" : "Required edge bps"}
          value={order.agent_edge_threshold_bps || "25"}
          placeholder="25"
          onChange={(agent_edge_threshold_bps) => onUpdate({ agent_edge_threshold_bps })}
        />
      )}
      {needsInvalidation && (
        <TextInput
          label="Stop level"
          value={order.agent_invalidation_level || ""}
          placeholder={`${market} price`}
          onChange={(agent_invalidation_level) => onUpdate({ agent_invalidation_level })}
        />
      )}
      {needsTimeWindow && (
        <TextInput
          label="Active window"
          value={order.agent_time_window || ""}
          placeholder="30m / NY open"
          onChange={(agent_time_window) => onUpdate({ agent_time_window })}
        />
      )}
    </div>
  );
}

function HyperliquidOrderTicket({
  order,
  errors,
  previewCommitment,
  working,
  market,
  currentPrice,
  hasConnectedAccount,
  accountReady,
  disabledReason,
  onUpdate,
  onConnect,
  onPreview,
}: {
  order: PrivateExecutionOrderDraft;
  errors: string[];
  previewCommitment: string | null;
  working: boolean;
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  currentPrice: string | null;
  hasConnectedAccount: boolean;
  accountReady: boolean;
  disabledReason: string;
  onUpdate: (patch: Partial<PrivateExecutionOrderDraft>) => void;
  onConnect?: () => void;
  onPreview?: () => void;
}) {
  const side = order.side === "sell" ? "sell" : "buy";
  const strategyProfile = normalizeAgentStrategyProfile(order.agent_strategy_profile || "trend_following");
  const entryTrigger = order.agent_entry_trigger || "preview_now";
  const exitRule = order.agent_exit_rule || "manual_approval";
  const timeHorizon = order.agent_time_horizon || "scalp";
  const chartEntryPrice = order.limit_price?.trim() || currentPrice || "";
  const slippageBand = formatSlippageBand({
    entryPrice: chartEntryPrice,
    slippageBps: order.max_slippage_bps || "50",
    side,
  });
  const strategyCondition = formatAgentStrategyCondition({ strategyProfile, entryTrigger, order });
  const entryCondition = formatAgentEntryCondition({ entryTrigger, order });
  const frontRunProtection = deriveFrontRunProtection({
    accessMode: "byo_api_key",
    noPublicMempool: true,
  });
  const planSummary = formatAgentPlanSummary({
    strategyCondition,
    entryCondition,
    horizonLabel: optionLabel(AGENT_TIME_HORIZONS, timeHorizon),
    exitLabel: optionLabel(AGENT_EXIT_RULES, exitRule),
  });
  const defaultMandate = formatDefaultHyperliquidMandate({
    market,
    side,
    strategyProfile,
    entryCondition,
    slippageBand,
  });
  const [mandateTouched, setMandateTouched] = useState(false);
  const mandateValue = mandateTouched ? order.agent_strategy_note || "" : order.agent_strategy_note || defaultMandate;
  const mandateStatus = previewCommitment ? "sealed" : mandateValue.trim() ? "captured" : "draft";
  const previewSeal = previewCommitment ? shortCommitment(previewCommitment) : "not sealed yet";
  const primaryLabel = !hasConnectedAccount
    ? "Connect execution wallet"
    : accountReady
      ? previewCommitment ? "Re-simulate mandate" : "Capture + preview mandate"
      : disabledReason;
  const primaryDisabled = working || (!hasConnectedAccount ? !onConnect : !onPreview || !accountReady);
  return (
    <div id="trade-intent" className="min-w-0 scroll-mt-24 border border-[#162337] bg-[#05070b]">
      <div className="border-b border-[#162337] bg-[#0b0f16] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-[#8b95a8]">
            <SlidersHorizontal className="h-4 w-4 text-[#a8d8ff]" />
            Ghola command
          </span>
          <span className={previewCommitment ? "text-xs font-medium text-emerald-200" : hasConnectedAccount ? "text-xs font-medium text-[#fff1a8]" : "text-xs font-medium text-amber-200"}>
            {hasConnectedAccount ? previewCommitment ? "mandate sealed" : "ready to seal" : "wallet required"}
          </span>
        </div>

        <h2 className="mt-3 text-2xl font-semibold leading-none text-[#f6f8ff]">
          AI trading mandate
        </h2>

        <label className="mt-5 grid gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#8b95a8]">
            What should Ghola do?
          </span>
          <textarea
            value={mandateValue}
            onChange={(event) => {
              setMandateTouched(true);
              onUpdate({ agent_strategy_note: event.target.value.slice(0, 420) });
            }}
            onFocus={() => setMandateTouched(true)}
            placeholder={defaultMandate}
            spellCheck={false}
            className="min-h-24 resize-y border border-[#2a3a52] bg-[#05070b] px-3 py-3 text-sm leading-6 text-[#f6f8ff] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff] sm:min-h-[126px] sm:text-base"
          />
        </label>

        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <MandatePresetButton
            label="Billion-dollar intent"
            onClick={() => {
              setMandateTouched(true);
              onUpdate({
                agent_strategy_profile: "breakout",
                agent_entry_trigger: "retest_level",
                agent_time_horizon: "session_trade",
                agent_strategy_note: `Act like a billion-dollar PM on ${market}-PERP: only take asymmetric setups where trend, book, and slippage limits agree; keep intent private until commit; stand down if the edge is weak.`,
              });
            }}
          />
          <MandatePresetButton
            label="Do not leak"
            onClick={() => {
              setMandateTouched(true);
              onUpdate({
                agent_entry_trigger: "book_imbalance",
                agent_strategy_note: `Find the best ${market}-PERP entry without advertising the order. Wait for live flow confirmation, cap slippage, submit privately, and ask before exit.`,
              });
            }}
          />
          <MandatePresetButton
            label="Protect capital"
            onClick={() => {
              setMandateTouched(true);
              onUpdate({
                agent_strategy_profile: "trend_following",
                agent_time_horizon: "scalp",
                agent_strategy_note: `Trade ${market}-PERP only if edge beats fees and slippage. Use a small capped order, avoid weak books, and abort if the thesis degrades.`,
              });
            }}
          />
        </div>

        <button
          type="button"
          onClick={hasConnectedAccount ? onPreview : onConnect}
          disabled={primaryDisabled}
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 bg-[#eef1f8] px-4 py-3 text-sm font-semibold text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {hasConnectedAccount ? <Play className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
          {working ? "Checking setup" : primaryLabel}
        </button>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <IntentCapabilityCell label="Mandate" value={mandateStatus} tone={mandateStatus === "sealed" || mandateStatus === "captured" ? "good" : "warn"} />
          <IntentCapabilityCell label="Seal" value={previewSeal} tone={previewCommitment ? "good" : "warn"} />
          <IntentCapabilityCell label="Venue sees" value="capped order only" tone="warn" />
        </div>
      </div>

      <div className="grid gap-4 p-4">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#8b95a8]">
              Agent pipeline
            </span>
            <span className="text-xs text-[#a8d8ff]">{market}-PERP</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <AgentPipelineStep label="Capture" value="plain English" tone={mandateValue.trim() ? "good" : "warn"} />
            <AgentPipelineStep label="Translate" value={optionLabel(AGENT_STRATEGY_PROFILES, strategyProfile)} tone="good" />
            <AgentPipelineStep label="Simulate" value={slippageBand} tone={slippageBand === "set entry price" ? "warn" : "good"} />
            <AgentPipelineStep label="Commit" value={hasConnectedAccount ? "private submit" : "needs wallet"} tone={hasConnectedAccount ? "good" : "warn"} />
          </div>
        </div>

        <div className="grid min-w-0 gap-3 border border-[#20304a] bg-[#08090d] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#8b95a8]">
                Translated plan
              </span>
              <p className="mt-1 text-sm leading-5 text-[#d8e6f8]">{planSummary}</p>
            </div>
            <span className="border border-[#25405f] bg-[#101c2b] px-2 py-1 text-xs font-medium text-[#a8d8ff]">
              {optionLabel(AGENT_STRATEGY_PROFILES, strategyProfile)}
            </span>
          </div>
          <div className="grid gap-2">
            <AgentPlanSelect
              label="Trade idea"
              value={strategyProfile}
              options={AGENT_STRATEGY_PROFILES}
              onChange={(value) => onUpdate({ agent_strategy_profile: value as PrivateExecutionOrderDraft["agent_strategy_profile"] })}
            />
            <AgentPlanSelect
              label="Enter when"
              value={entryTrigger}
              options={AGENT_ENTRY_TRIGGERS}
              onChange={(value) => onUpdate({ agent_entry_trigger: value as PrivateExecutionOrderDraft["agent_entry_trigger"] })}
            />
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <AgentPlanSelect
                label="Hold for"
                value={timeHorizon}
                options={AGENT_TIME_HORIZONS}
                onChange={(value) => onUpdate({ agent_time_horizon: value as PrivateExecutionOrderDraft["agent_time_horizon"] })}
              />
              <AgentPlanSelect
                label="Exit on"
                value={exitRule}
                options={AGENT_EXIT_RULES}
                onChange={(value) => onUpdate({ agent_exit_rule: value as PrivateExecutionOrderDraft["agent_exit_rule"] })}
              />
            </div>
          </div>
          <FrontRunProtectionLine
            label={frontRunProtection.label}
            detail={frontRunProtection.detail}
            zeroFrontRun={frontRunProtection.zeroFrontRun}
          />
        </div>
        <MandateParameterFields
          order={order}
          market={market}
          strategyProfile={strategyProfile}
          entryTrigger={entryTrigger}
          exitRule={exitRule}
          timeHorizon={timeHorizon}
          onUpdate={onUpdate}
        />

        <div className="grid min-w-0 gap-3 border border-[#20304a] bg-[#08090d] p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-[#8b95a8]">
              Commit constraints
            </span>
            <span className="text-xs text-[#fff1a8]">Live Capped limit</span>
          </div>
          <LabeledOrderSideToggle side={side} onChange={(nextSide) => onUpdate({ side: nextSide })} />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <Select
              label="Amount"
              value={order.quote_size || "5"}
              options={[["5", "$5"], ["10", "$10"], ["11", "$11 proof"], ["25", "$25"]]}
              onChange={(value) => onUpdate({ quote_size: value })}
            />
            <TextInput
              label="Entry price"
              value={order.limit_price || ""}
              placeholder={currentPrice ? formatPrice(currentPrice) : `${market} price`}
              onChange={(limit_price) => onUpdate({ limit_price, order_type: "limit", live_order_mode: undefined })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
            <SegmentedControl
              label="Slippage cap"
              value={order.max_slippage_bps || "50"}
              options={SLIPPAGE_CAP_OPTIONS}
              onChange={(value) => onUpdate({ max_slippage_bps: value })}
            />
            <button
              type="button"
              disabled={!currentPrice}
              onClick={() => currentPrice && onUpdate({ limit_price: currentPrice, order_type: "limit", live_order_mode: undefined })}
              className="h-10 self-end border border-[#1e2a3a] bg-[#05070b] px-3 text-xs font-medium text-[#aab5c8] hover:border-[#3da8ff]/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Use current
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ExecutionConstraintPill label="Slippage band" value={slippageBand} tone="warn" />
            <ExecutionConstraintPill label="Exit authority" value={optionLabel(AGENT_EXIT_RULES, exitRule)} tone="good" />
          </div>
        </div>

        {!hasConnectedAccount && (
          <p className="text-xs leading-5 text-[#8b95a8]">
            Connect scoped Hyperliquid access before the agent can preview or submit.
          </p>
        )}

        <div className="grid gap-2 border-t border-[#162337] pt-3">
          <StatusLine
            label="API wallet"
            value={hasConnectedAccount ? "connected" : "not connected"}
            tone={hasConnectedAccount ? "good" : "warn"}
          />
          <StatusLine label="Main wallet" value="hidden" tone="good" />
          <StatusLine label="Ghola" value="private runtime" tone="good" />
          <StatusLine label="Hyperliquid sees" value="API wallet + order" tone="warn" />
        </div>

        {errors[0] && <p className="text-xs leading-5 text-amber-200">{errors[0]}</p>}
      </div>
    </div>
  );
}

function formatDefaultHyperliquidMandate({
  market,
  side,
  strategyProfile,
  entryCondition,
  slippageBand,
}: {
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  side: "buy" | "sell";
  strategyProfile: NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
  entryCondition: string;
  slippageBand: string;
}) {
  const direction = side === "sell" ? "short" : "long";
  return `Find a high-conviction ${direction} on ${market}-PERP. Use ${lowerFirst(optionLabel(AGENT_STRATEGY_PROFILES, strategyProfile))}, enter when ${entryCondition}, keep the intent private until commit, and cap execution inside ${slippageBand}.`;
}

function MandatePresetButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-9 border border-[#243248] bg-[#101722] px-2 py-2 text-left text-xs font-medium text-[#d8e6f8] transition hover:border-[#a8d8ff]/50 hover:bg-[#142033]"
    >
      {label}
    </button>
  );
}

function IntentCapabilityCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className="min-w-0 border border-[#1e2a3a] bg-[#05070b] px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">{label}</p>
      <p className={tone === "good" ? "mt-1 truncate text-xs font-medium text-emerald-200" : "mt-1 truncate text-xs font-medium text-[#fff1a8]"} title={value}>
        {formatValue(value)}
      </p>
    </div>
  );
}

function AgentPipelineStep({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className="min-w-0 border border-[#1e2a3a] bg-[#0b0f16] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">{label}</span>
        <span className={tone === "good" ? "h-1.5 w-1.5 rounded-full bg-emerald-300" : "h-1.5 w-1.5 rounded-full bg-[#fff1a8]"} aria-hidden="true" />
      </div>
      <p className={tone === "good" ? "mt-2 truncate text-sm font-medium text-[#f6f8ff]" : "mt-2 truncate text-sm font-medium text-[#fff1a8]"} title={value}>
        {formatValue(value)}
      </p>
    </div>
  );
}

function ExecutionConstraintPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className="min-w-0 border border-[#1e2a3a] bg-[#05070b] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">{label}</p>
      <p className={tone === "good" ? "mt-1 truncate text-sm font-medium text-emerald-200" : "mt-1 truncate text-sm font-medium text-[#fff1a8]"} title={value}>
        {formatValue(value)}
      </p>
    </div>
  );
}

function FrontRunProtectionLine({
  label,
  detail,
  zeroFrontRun,
}: {
  label: string;
  detail: string;
  zeroFrontRun: boolean;
}) {
  return (
    <div className="border-t border-[#162337] pt-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs text-[#8b95a8]">Front-run protection</span>
        <span className={zeroFrontRun ? "text-xs font-medium text-emerald-200" : "text-xs font-medium text-amber-200"}>
          {label}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-[#8b95a8]">{detail}</p>
    </div>
  );
}

function MarketStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const valueClass =
    tone === "good" ? "text-emerald-200" : tone === "bad" ? "text-red-200" : "text-[#eef1f8]";
  return (
    <div className="min-w-0 border border-[#162337] bg-[#08090d] px-3 py-2">
      <p className="text-[11px] text-[#6f7d9a]">{label}</p>
      <p className={`mt-1 truncate text-sm font-medium tabular-nums ${valueClass}`} title={value}>{value}</p>
    </div>
  );
}

function MarketHeaderStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs uppercase tracking-[0.24em] text-[#59657a]">{label}</p>
      <p className="mt-2 truncate font-mono text-xl tabular-nums text-[#eef1f8]" title={value}>{value}</p>
    </div>
  );
}

function OrderbookRows({
  side,
  levels,
}: {
  side: "bid" | "ask";
  levels: Array<{ px: string; sz: string; n?: number | null }>;
}) {
  const shown = side === "ask" ? levels.slice(0, 8).reverse() : levels.slice(0, 8);
  if (shown.length === 0) {
    return <p className="py-3 text-xs text-[#6f7d9a]">Waiting for book</p>;
  }
  const maxSize = Math.max(...shown.map((level) => Number(level.sz)).filter((value) => Number.isFinite(value)), 1);
  return (
    <div className="space-y-1">
      {shown.map((level) => (
        <div key={`${side}-${level.px}-${level.sz}`} className="relative overflow-hidden px-1 py-0.5 text-xs">
          <div
            className={side === "bid" ? "absolute inset-y-0 right-0 bg-emerald-300/8" : "absolute inset-y-0 right-0 bg-red-300/8"}
            style={{ width: `${Math.max(6, (Number(level.sz) / maxSize) * 100)}%` }}
          />
          <div className="relative grid grid-cols-[78px_minmax(0,1fr)_32px] gap-2">
            <span className={side === "bid" ? "text-emerald-200" : "text-red-200"}>
              {formatBookPrice(level.px)}
            </span>
            <span className="text-right text-[#8b95a8]">{formatSize(level.sz)}</span>
            <span className="text-right text-[#59657a]">{level.n ?? "-"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentTradeRows({ trades }: { trades: Array<{ trade_id?: string | null; side: "buy" | "sell"; px: string; sz: string; time: number }> }) {
  const shown = trades.slice(0, 8);
  return (
    <div className="border border-[#162337] bg-[#05070b] p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
        <span>Recent trades</span>
        <span>public</span>
      </div>
      {shown.length === 0 ? (
        <p className="py-3 text-xs text-[#6f7d9a]">Waiting for trades</p>
      ) : (
        <div className="space-y-1">
          {shown.map((trade, index) => (
            <div key={trade.trade_id ?? `${trade.time}-${trade.side}-${trade.px}-${trade.sz}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)_34px] gap-2 text-xs">
              <span className={trade.side === "buy" ? "text-emerald-200" : "text-red-200"}>
                {formatBookPrice(trade.px)}
              </span>
              <span className="text-right text-[#8b95a8]">{formatSize(trade.sz)}</span>
              <span className={trade.side === "buy" ? "text-right text-emerald-200" : "text-right text-red-200"}>
                {trade.side === "buy" ? "B" : "S"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface AlphaScoutMarketSummary {
  label: string;
  status: string;
  tone: "good" | "warn";
  detail: string;
}

interface AlphaScoutRecommendation {
  id: string;
  title: string;
  detail: string;
  tone: "good" | "warn" | "danger";
  action: "arm" | "preview" | "pause" | "resume" | "kill";
  actionLabel: string;
  market: string;
  side: "buy" | "sell" | "watch";
  notional: string;
  entry: string;
  risk: string;
  evidence: string[];
}

interface AlphaScoutDecision {
  id: string;
  recommendationId: string;
  title: string;
  outcome: "preview" | "approved" | "denied";
  detail: string;
  createdAt: string;
}

function PrivateAlphaScoutControlRoom({
  authenticated,
  selectedPlatform,
  venues,
  activeSession,
  events,
  replay,
  readiness,
  streamStatus,
  order,
  preview,
  execution,
  queueCount,
  receiptsCount,
  marketSummary,
  liveTradingStatus,
  working,
  onSelectPlatform,
  onArm,
  onControl,
  onPreview,
  onApprove,
}: {
  authenticated: boolean;
  selectedPlatform: string;
  venues: AgentVenueCard[];
  activeSession: PrivateAutopilotSession | null;
  events: PrivateAutopilotEvent[];
  replay: PrivateAutopilotReplayResponse | null;
  readiness: PrivateAutopilotReadiness | null;
  streamStatus: "connecting" | "live" | "reconnecting" | "closed";
  order: PrivateExecutionOrderDraft;
  preview: GholaPrivacyPreview | null;
  execution: ExecutionState | null;
  queueCount: number;
  receiptsCount: number;
  marketSummary: AlphaScoutMarketSummary[];
  liveTradingStatus: PrivateAccountLiveTradingStatus | null;
  working: boolean;
  onSelectPlatform: (platformClass: TradePlatformClass) => void;
  onArm: (policy: Partial<PrivateAutopilotSessionPolicy>) => void;
  onControl: (action: "pause" | "resume" | "kill") => void;
  onPreview: () => void | Promise<void>;
  onApprove: () => void | Promise<void>;
}) {
  const selectedVenue = venues.find((venue) => venue.platformClass === selectedPlatform) || venues[0];
  const selectedAutopilotVenue = alphaVenueForPlatform(selectedPlatform);
  const [venueAllowlist, setVenueAllowlist] = useState<AlphaScoutVenueId[]>([
    selectedAutopilotVenue,
    "jupiter",
    "phoenix",
  ]);
  const [marketAllowlist, setMarketAllowlist] = useState(DEFAULT_ALPHA_SCOUT_MARKETS);
  const [maxNotional, setMaxNotional] = useState<PrivateAutopilotSessionPolicy["max_notional_bucket"]>("50");
  const [maxDaily, setMaxDaily] = useState<PrivateAutopilotSessionPolicy["max_daily_notional_bucket"]>("250");
  const [maxOrders, setMaxOrders] = useState("10");
  const [maxSpread, setMaxSpread] = useState("150");
  const [maxSlippage, setMaxSlippage] = useState("50");
  const [ttl, setTtl] = useState("7200000");
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<AlphaScoutDecision[]>([]);

  useEffect(() => {
    setVenueAllowlist((current) =>
      current.includes(selectedAutopilotVenue)
        ? current
        : [selectedAutopilotVenue, ...current].slice(0, 4),
    );
  }, [selectedAutopilotVenue]);

  const statusTone = activeSession?.status === "running"
    ? "good"
    : activeSession?.status === "paused" || activeSession?.status === "pending_worker" || activeSession?.status === "pending_funding"
      ? "warn"
      : activeSession?.status === "killed" || activeSession?.status === "expired" || activeSession?.status === "blocked"
        ? "danger"
        : "warn";
  const latestEvent = events[events.length - 1] || null;
  const recommendations = buildAlphaScoutRecommendations({
    activeSession,
    events,
    marketSummary,
    order,
    preview,
    queueCount,
    readiness,
    selectedVenue,
  });
  const selectedRecommendation =
    recommendations.find((recommendation) => recommendation.id === selectedRecommendationId) ||
    recommendations[0] ||
    null;
  const selectedOrderRecommendation = selectedRecommendation?.action === "arm" ? null : selectedRecommendation;
  const latestDecision = decisions[0] || null;
  const ledger = buildAlphaScoutLedger(activeSession, events);
  const replayMetrics = replay?.metrics ?? null;
  const replayExecutors = replay?.executors ?? [];
  const replayTicks = replay?.tick_snapshots ?? [];
  const recentReplayExecutors = replayExecutors.slice(-3).reverse();
  const recentReplayTicks = replayTicks.slice(-2).reverse();
  const venueReadyCount = readiness?.venue_readiness.filter((venue) => venue.status === "ready").length ?? 0;
  const selectedMarket = marketForAutopilotReadiness(order.market);
  const executionDisplay = activeSession
    ? deriveAutopilotExecutionDisplay({ ...(readiness ?? {}), session: activeSession })
    : readiness?.execution_display ?? deriveAutopilotExecutionDisplay(readiness ?? { can_arm: authenticated });

  const armPolicy = (): Partial<PrivateAutopilotSessionPolicy> => ({
    decision_model: "ai_direct_order_v1",
    ai_direct_enabled: true,
    venue_allowlist: venueAllowlist,
    market_allowlist: marketAllowlist,
    max_notional_bucket: maxNotional,
    max_position_notional_bucket: alphaScoutPositionCap(maxNotional),
    max_daily_notional_bucket: maxDaily,
    max_order_count: Number(maxOrders),
    ttl_ms: Number(ttl),
    max_slippage_bps: Number(maxSlippage),
    max_spread_bps: Number(maxSpread),
    min_ai_score_bps: 6500,
    ai_min_confidence_bps: 6500,
    min_signal_bps: 25,
    cooldown_ms: 5 * 60_000,
    data_max_age_ms: 30_000,
    kill_switch: false,
    reduce_only_on_reconcile_failure: true,
    locale_hint: "en",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  });
  const recordDecision = (
    recommendation: AlphaScoutRecommendation,
    outcome: AlphaScoutDecision["outcome"],
    detail: string,
  ) => {
    setDecisions((current) => [{
      id: `${recommendation.id}-${outcome}-${Date.now()}`,
      recommendationId: recommendation.id,
      title: recommendation.title,
      outcome,
      detail,
      createdAt: new Date().toISOString(),
    }, ...current].slice(0, 8));
  };

  const runRecommendationAction = async (recommendation: AlphaScoutRecommendation) => {
    setSelectedRecommendationId(recommendation.id);
    if (recommendation.action === "arm") {
      onArm(armPolicy());
      return;
    }
    if (recommendation.action === "preview") {
      recordDecision(recommendation, "preview", "Visibility preview requested before approval.");
      await onPreview();
      return;
    }
    onControl(recommendation.action);
  };

  const approveRecommendation = async (recommendation: AlphaScoutRecommendation) => {
    setSelectedRecommendationId(recommendation.id);
    if (!preview) {
      recordDecision(recommendation, "preview", "Approval held until visibility preview is complete.");
      await onPreview();
      return;
    }
    recordDecision(recommendation, "approved", "Approved after preview; waiting for private receipt.");
    await onApprove();
  };

  const denyRecommendation = (recommendation: AlphaScoutRecommendation) => {
    setSelectedRecommendationId(recommendation.id);
    recordDecision(recommendation, "denied", "Denied locally; no order approval was submitted.");
  };

  if (!activeSession) {
    return (
      <section className="border border-[#1e2a3a] bg-[#0f1117] p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#6f7d9a]">
              Private scout mandate
            </p>
            <h2 className="mt-1 text-base font-medium text-[#f6f8ff] sm:text-lg">
              Arm a private scout.
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-[#9aa6ba]">
              Set venues, markets, and caps. Preview before execution.
            </p>
          </div>
          <span className={alphaStatusClass("warn")}>
            {authenticated ? "not armed" : "sign in"}
          </span>
        </div>

        <LiveTradingGateStrip liveTradingStatus={liveTradingStatus} />

        <div className="mt-3 rounded-md border border-[#243248] bg-[#0b0f16] p-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-[#eef1f8]">Scout mandate</h3>
              <p className="mt-1 text-xs leading-5 text-[#8b95a8]">
                {venueAllowlist.map((venue) => alphaScoutVenueLabel(venue)).join(" + ")} · {marketAllowlist.map((market) => market.replace("-USD", "")).join(" / ")} · ${maxNotional} max order · ${maxDaily} daily cap
              </p>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <span className={statusPillClass("px-2 py-1")}>no mandate</span>
              <span className={statusPillClass("px-2 py-1")}>preview required</span>
              <span className={statusPillClass("px-2 py-1")}>
                venues <span className={venueReadyCount > 0 ? "text-emerald-200" : "text-amber-200"}>{venueReadyCount}/{readiness?.venue_readiness.length ?? 4}</span>
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid gap-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-[0.12em] text-[#8b95a8]">Venues</span>
                  <span className="text-xs text-[#8b95a8]">{selectedVenue.title}</span>
                </div>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                  {ALPHA_SCOUT_VENUES.map((venue) => {
                    const selected = venueAllowlist.includes(venue.id);
                    return (
                      <button
                        key={venue.id}
                        type="button"
                        onClick={() => {
                          setVenueAllowlist((current) => toggleAlphaVenue(current, venue.id));
                          onSelectPlatform(venue.platformClass);
                        }}
                        className={compactSelectorClass(selected, "h-9 px-2 text-left text-xs")}
                      >
                        {venue.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <span className="mb-1.5 block text-xs uppercase tracking-[0.12em] text-[#8b95a8]">Markets</span>
                  <div className="grid grid-cols-3 gap-1">
                    {["BTC-USD", "ETH-USD", "SOL-USD"].map((market) => {
                      const selected = marketAllowlist.includes(market);
                      return (
                        <button
                          key={market}
                          type="button"
                          onClick={() => setMarketAllowlist((current) => toggleStringValue(current, market))}
                          className={compactSelectorClass(selected, "h-9 px-2 text-xs")}
                        >
                          {market.replace("-USD", "")}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select label="Order cap" value={maxNotional} options={LAUNCH_AMOUNT_OPTIONS} onChange={(value) => setMaxNotional(value as PrivateAutopilotSessionPolicy["max_notional_bucket"])} />
                  <Select label="Daily cap" value={maxDaily} options={LAUNCH_DAILY_CAP_OPTIONS} onChange={(value) => setMaxDaily(value as PrivateAutopilotSessionPolicy["max_daily_notional_bucket"])} />
                </div>
              </div>

              <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
                <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Advanced limits</summary>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <Select label="Orders" value={maxOrders} options={[["3", "3"], ["5", "5"], ["10", "10"], ["15", "15"], ["25", "25"]]} onChange={setMaxOrders} />
                  <Select label="Spread bps" value={maxSpread} options={[["25", "25"], ["50", "50"], ["100", "100"], ["150", "150"], ["300", "300"]]} onChange={setMaxSpread} />
                  <Select label="Slip bps" value={maxSlippage} options={[["10", "10"], ["25", "25"], ["50", "50"], ["75", "75"], ["100", "100"]]} onChange={setMaxSlippage} />
                  <Select label="TTL" value={ttl} options={[["300000", "5m"], ["1800000", "30m"], ["3600000", "1h"], ["7200000", "2h"], ["14400000", "4h"]]} onChange={setTtl} />
                </div>
              </details>
            </div>

            <div className="grid content-between gap-3 border border-[#1e2a3a] bg-[#08090d] p-3">
              <div className="grid gap-2">
                <StatusLine label="Main wallet" value="hidden" tone="good" />
                <StatusLine label="Scout can watch" value={venueAllowlist.length ? `${venueAllowlist.length} venues` : "none"} tone={venueAllowlist.length ? "good" : "warn"} />
                <StatusLine label="Live orders" value="Live Capped" tone="good" />
              </div>
              <button
                type="button"
                onClick={() => onArm(armPolicy())}
                disabled={working || venueAllowlist.length === 0 || marketAllowlist.length === 0}
                className="inline-flex h-11 w-full items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                {working ? "Working" : authenticated ? "Arm private scout" : "Sign in to arm"}
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="border border-[#1e2a3a] bg-[#0f1117] p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#6f7d9a]">
            Cross-venue private alpha scout
          </p>
          <h2 className="mt-1 text-base font-medium text-[#f6f8ff] sm:text-lg">
            {executionDisplay.label === "Live Capped" ? "Live Capped agent is running." : executionDisplay.label}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-[#9aa6ba]">
            {activeSession
              ? executionDisplay.detail
              : "A signed mandate lets the agent watch markets and trade only inside the limits you set."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={alphaStatusClass(statusTone)}>
            {activeSession ? executionDisplay.label : authenticated ? "not armed" : "sign in"}
          </span>
          <span className={statusPillClass()}>
            stream <span className={streamStatus === "live" ? "text-emerald-200" : "text-amber-200"}>{streamStatus}</span>
          </span>
          <span className={statusPillClass()}>
            venues <span className={venueReadyCount > 0 ? "text-emerald-200" : "text-amber-200"}>{venueReadyCount}/{readiness?.venue_readiness.length ?? 4}</span>
          </span>
        </div>
      </div>

      <LiveTradingGateStrip liveTradingStatus={liveTradingStatus} />

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(300px,0.9fr)_minmax(360px,1.15fr)_minmax(260px,0.8fr)]">
        <div className="rounded-md border border-[#243248] bg-[#0b0f16] p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-[#eef1f8]">Mandate ticket</h3>
            <span className="text-xs text-[#8b95a8]">{selectedMarket}</span>
          </div>
          <div className="mt-3 grid gap-2">
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-[0.12em] text-[#8b95a8]">Venues</span>
                <span className="text-xs text-[#8b95a8]">{selectedVenue.title}</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {ALPHA_SCOUT_VENUES.map((venue) => {
                  const selected = venueAllowlist.includes(venue.id);
                  return (
                    <button
                      key={venue.id}
                      type="button"
                      onClick={() => {
                        setVenueAllowlist((current) => toggleAlphaVenue(current, venue.id));
                        onSelectPlatform(venue.platformClass);
                      }}
                      className={compactSelectorClass(selected, "h-8 px-2 text-left text-xs")}
                    >
                      {venue.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-xs uppercase tracking-[0.12em] text-[#8b95a8]">Markets</span>
              <div className="grid grid-cols-3 gap-1">
                {["BTC-USD", "ETH-USD", "SOL-USD"].map((market) => {
                  const selected = marketAllowlist.includes(market);
                  return (
                    <button
                      key={market}
                      type="button"
                      onClick={() => setMarketAllowlist((current) => toggleStringValue(current, market))}
                      className={compactSelectorClass(selected, "h-8 px-2 text-xs")}
                    >
                      {market.replace("-USD", "")}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Order cap" value={maxNotional} options={LAUNCH_AMOUNT_OPTIONS} onChange={(value) => setMaxNotional(value as PrivateAutopilotSessionPolicy["max_notional_bucket"])} />
              <Select label="Daily cap" value={maxDaily} options={LAUNCH_DAILY_CAP_OPTIONS} onChange={(value) => setMaxDaily(value as PrivateAutopilotSessionPolicy["max_daily_notional_bucket"])} />
              <Select label="Orders" value={maxOrders} options={[["3", "3"], ["5", "5"], ["10", "10"], ["15", "15"], ["25", "25"]]} onChange={setMaxOrders} />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Spread bps" value={maxSpread} options={[["25", "25"], ["50", "50"], ["100", "100"], ["150", "150"], ["300", "300"]]} onChange={setMaxSpread} />
              <Select label="Slip bps" value={maxSlippage} options={[["10", "10"], ["25", "25"], ["50", "50"], ["75", "75"], ["100", "100"]]} onChange={setMaxSlippage} />
              <Select label="TTL" value={ttl} options={[["300000", "5m"], ["1800000", "30m"], ["3600000", "1h"], ["7200000", "2h"], ["14400000", "4h"]]} onChange={setTtl} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => onArm(armPolicy())}
            disabled={working}
            className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {working ? "Working" : activeSession ? "Re-arm mandate" : authenticated ? "Arm auto-trade scout" : "Sign in to arm"}
          </button>
        </div>

        <div className="rounded-md border border-[#243248] bg-[#0b0f16] p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-[#eef1f8]">Recommendation queue</h3>
            <span className="text-xs text-[#8b95a8]">{latestEvent ? customerAutopilotEventCopy(latestEvent).title : "Live Capped"}</span>
          </div>
          <div className="mt-3 divide-y divide-[#121c2a] overflow-hidden rounded-[6px] border border-[#1e2a3a] bg-[#080b10]">
            {recommendations.map((recommendation) => (
              <div
                key={recommendation.id}
                className={alphaRecommendationClass(
                  recommendation.tone,
                  selectedRecommendation?.id === recommendation.id,
                )}
              >
                <span className={alphaRecommendationRailClass(recommendation.tone)} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#f6f8ff]">{recommendation.title}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#8b95a8]">{recommendation.detail}</p>
                  </div>
                  <AlphaScoutMeta recommendation={recommendation} />
                </div>
                <button
                  type="button"
                  onClick={() => runRecommendationAction(recommendation)}
                  disabled={working || (recommendationNeedsSession(recommendation.action) && !activeSession)}
                  className={alphaRecommendationActionClass(recommendation.tone)}
                >
                  {recommendation.action === "pause" || recommendation.action === "kill" ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {recommendation.actionLabel}
                </button>
              </div>
            ))}
          </div>
          {selectedOrderRecommendation && (
            <div className="mt-3 border-t border-[#1e2a3a] pt-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">Selected order</p>
                  <p className="mt-1 text-sm font-medium text-[#eef1f8]">{selectedOrderRecommendation.title}</p>
                  <p className="mt-1 text-xs leading-5 text-[#8b95a8]">{selectedOrderRecommendation.entry}</p>
                </div>
                <span className={preview ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                  {execution?.receipt ? "receipt issued" : preview ? "preview ready" : "preview needed"}
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-[#9aa6ba]">
                {selectedOrderRecommendation.evidence.slice(0, 3).map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <span className="h-px w-3 shrink-0 bg-[#344155]" />
                    <span className="min-w-0 truncate">{item}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#121c2a] pt-3">
                <button
                  type="button"
                  onClick={() => runRecommendationAction(selectedOrderRecommendation)}
                  disabled={working || (recommendationNeedsSession(selectedOrderRecommendation.action) && !activeSession)}
                  className={alphaDecisionButtonClass("preview")}
                >
                  <Search className="h-3.5 w-3.5" />
                  Preview
                </button>
                <button
                  type="button"
                  onClick={() => approveRecommendation(selectedOrderRecommendation)}
                  disabled={working || !preview}
                  className={alphaDecisionButtonClass("approve")}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => denyRecommendation(selectedOrderRecommendation)}
                  disabled={working}
                  className={alphaDecisionButtonClass("deny")}
                >
                  <X className="h-3.5 w-3.5" />
                  Deny
                </button>
              </div>
              {latestDecision && (
                <p className="mt-2 truncate text-[11px] text-[#6f7d9a]">
                  {formatValue(latestDecision.outcome)} {compactTime(latestDecision.createdAt)} · {latestDecision.detail}
                </p>
              )}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">
            <CompactStatusChip label="Policy" value={activeSession?.session_policy.policy_commitment ? shortCommitment(activeSession.session_policy.policy_commitment) : "draft"} tone={activeSession ? "good" : "warn"} />
            <CompactStatusChip label="Queue" value={queueCount > 0 ? `${queueCount} waiting` : "clear"} tone={queueCount > 0 ? "warn" : "good"} />
            <CompactStatusChip label="Preview" value={preview ? statusLabel(preview.claim_status) : "needed"} tone={preview && isPrivateModeAvailableStatus(preview.claim_status) ? "good" : "warn"} />
            <CompactStatusChip label="Receipts" value={receiptsCount > 0 ? String(receiptsCount) : "none"} tone={receiptsCount > 0 ? "good" : "warn"} />
          </div>
        </div>

        <div className="border border-[#243248] bg-[#08090d] p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-[#eef1f8]">Evidence</h3>
            <span className="text-xs text-[#8b95a8]">ledger</span>
          </div>
          <div className="mt-3 grid gap-1.5">
            {marketSummary.map((item) => (
              <div key={item.label} className="grid grid-cols-[78px_minmax(0,1fr)_auto] items-center gap-2 border border-[#1e2a3a] bg-[#0f1117] px-2 py-1.5 text-xs">
                <span className="truncate font-medium text-[#eef1f8]">{item.label}</span>
                <span className="truncate text-[#8b95a8]">{item.detail}</span>
                <span className={item.tone === "good" ? "text-emerald-200" : "text-amber-200"}>{item.status}</span>
              </div>
            ))}
          </div>
          {replayMetrics ? (
            <div className="mt-3 grid grid-cols-2 gap-1.5 text-xs">
              <CompactStatusChip
                label="Agent"
                value={shortCommitment(replayString(replayMetrics, "agent_controller_id", activeSession?.agent_controller_id || "local"))}
                tone={activeSession?.agent_controller_id ? "good" : "warn"}
              />
              <CompactStatusChip
                label="Executors"
                value={replayString(replayMetrics, "executor_count", String(replayExecutors.length))}
                tone={replayExecutors.length > 0 ? "good" : "warn"}
              />
              <CompactStatusChip
                label="Open"
                value={replayString(replayMetrics, "open_executor_count", "0")}
                tone={Number(replayString(replayMetrics, "open_executor_count", "0")) > 0 ? "good" : "warn"}
              />
              <CompactStatusChip
                label="Ticks"
                value={replayString(replayMetrics, "tick_count", String(replayTicks.length))}
                tone={replayTicks.length > 0 ? "good" : "warn"}
              />
            </div>
          ) : null}
          <div className="mt-3 divide-y divide-[#1e2a3a] border border-[#1e2a3a] bg-[#0f1117]">
            {ledger.map((item) => (
              <div key={item.id} className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 px-2 py-2 text-xs">
                <span className="font-mono text-[#6f7d9a]">{item.time}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[#eef1f8]">{item.title}</span>
                  <span className="block truncate text-[#8b95a8]">{item.detail}</span>
                </span>
              </div>
            ))}
          </div>
          {recentReplayExecutors.length || recentReplayTicks.length ? (
            <div className="mt-3 grid gap-2">
              {recentReplayExecutors.length ? (
                <div className="overflow-hidden border border-[#1e2a3a] bg-[#0f1117]">
                  <div className="flex items-center justify-between border-b border-[#1e2a3a] bg-[#101722] px-2 py-1.5 text-xs">
                    <span className="text-[#6f7d9a]">Executors</span>
                    <span className="text-[#8b95a8]">{recentReplayExecutors.length} recent</span>
                  </div>
                  <div className="divide-y divide-[#1e2a3a]">
                    {recentReplayExecutors.map((executor, index) => (
                      <div key={replayString(executor, "executor_id", `executor-${index}`)} className="grid grid-cols-[74px_minmax(0,1fr)] gap-2 px-2 py-2 text-xs">
                        <span className="truncate font-mono text-[#a8d8ff]">
                          {shortCommitment(replayString(executor, "executor_id", "executor"))}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[#eef1f8]">
                            {formatValue(replayString(executor, "kind", "executor"))} · {formatValue(replayString(executor, "status", "unknown"))}
                          </span>
                          <span className="block truncate text-[#8b95a8]">
                            {replayString(executor, "venue_id", "venue")} · {replayString(executor, "market", "market")} · ${replayString(executor, "notional_bucket", "0")}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {recentReplayTicks.length ? (
                <div className="overflow-hidden border border-[#1e2a3a] bg-[#0f1117]">
                  <div className="flex items-center justify-between border-b border-[#1e2a3a] bg-[#101722] px-2 py-1.5 text-xs">
                    <span className="text-[#6f7d9a]">Replay ticks</span>
                    <span className="text-[#8b95a8]">{recentReplayTicks.length} recent</span>
                  </div>
                  <div className="divide-y divide-[#1e2a3a]">
                    {recentReplayTicks.map((tick, index) => (
                      <div key={replayString(tick, "tick_id", `tick-${index}`)} className="grid grid-cols-[74px_minmax(0,1fr)] gap-2 px-2 py-2 text-xs">
                        <span className="truncate font-mono text-[#6f7d9a]">
                          {compactTime(replayString(tick, "created_at", replayString(tick, "updated_at", "")))}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[#eef1f8]">
                            {formatValue(replayString(tick, "status", "snapshot"))}
                          </span>
                          <span className="block truncate text-[#8b95a8]">
                            {replayArrayLength(tick, "executor_ids")} executors · {replayString(tick, "risk_reason", "policy recorded")}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden border border-[#1e2a3a] bg-[#0b0f16]">
            <div className="flex items-center justify-between border-b border-[#1e2a3a] bg-[#101722] px-2 py-1.5 text-xs">
              <span className="text-[#6f7d9a]">Decision blotter</span>
              <span className={execution?.receipt ? "text-emerald-200" : "text-[#8b95a8]"}>
                {execution?.receipt ? "receipt ready" : decisions.length ? `${decisions.length} local` : "empty"}
              </span>
            </div>
            <div className="divide-y divide-[#1e2a3a]">
              {(decisions.length ? decisions : [{
                id: "decision-empty",
                recommendationId: "none",
                title: "No recommendation decision yet",
                outcome: "preview" as const,
                detail: "Recommendations can execute only after preview and approval pass.",
                createdAt: "",
              }]).slice(0, 4).map((decision) => (
                <div key={decision.id} className="grid grid-cols-[70px_minmax(0,1fr)] gap-2 px-2 py-2 text-xs">
                  <span className={decision.outcome === "approved" ? "text-emerald-200" : decision.outcome === "denied" ? "text-red-200" : "text-[#a8d8ff]"}>
                    {formatValue(decision.outcome)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-[#eef1f8]">{decision.title}</span>
                    <span className="block truncate text-[#8b95a8]">{decision.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
          {activeSession ? (
            <div className="mt-2 grid gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => activeSession.status === "paused" ? onControl("resume") : onControl("pause")}
                disabled={working || activeSession.status === "killed" || activeSession.status === "expired"}
                className={alphaDecisionButtonClass("neutral")}
              >
                {activeSession.status === "paused" ? <Play className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {activeSession.status === "paused" ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => onControl("kill")}
                disabled={working || activeSession.status === "killed" || activeSession.status === "expired"}
                className={alphaDecisionButtonClass("deny")}
              >
                <X className="h-3.5 w-3.5" />
                Kill switch
              </button>
            </div>
          ) : (
            <div className="mt-2 border border-[#1f2d40] bg-[#0d141e] px-2 py-2 text-xs text-[#8b95a8]">
              Scout controls unlock after you arm the mandate.
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {venues.map((venue) => {
          const selected = venue.platformClass === selectedPlatform;
          return (
            <button
              key={venue.platformClass}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectPlatform(venue.platformClass)}
              className={compactSelectorClass(selected, "px-2.5 py-1.5 text-left")}
            >
              <span className="font-medium">{venue.title}</span>
              <span className={venue.tone === "good" ? "ml-2 text-emerald-200" : "ml-2 text-amber-200"}>
                {formatValue(venue.access)}
              </span>
            </button>
          );
        })}
        <span className={statusPillClass("px-2.5 py-1.5")}>
          Hidden <span className="text-emerald-200">{selectedVenue.hidden}</span>
        </span>
        <span className={statusPillClass("px-2.5 py-1.5")}>
          Visible <span className="text-amber-200">{selectedVenue.visible}</span>
        </span>
      </div>
    </section>
  );
}

function LiveTradingGateStrip({
  liveTradingStatus,
}: {
  liveTradingStatus: PrivateAccountLiveTradingStatus | null;
}) {
  const pooledReady = liveTradingStatus?.pooled_live_trading_enabled === true;
  const byoReady = liveTradingStatus?.byo_live_trading_enabled === true;
  const ready = pooledReady || byoReady;
  const publicMarketData = liveTradingStatus?.public_market_data_enabled === true ||
    liveTradingStatus?.public_live_copy_allowed === true;
  const venues = byoReady
    ? liveTradingStatus?.byo_live_venues ?? []
    : liveTradingStatus?.required_venues ?? [];
  const readyCount = venues.filter((venue) => venue.status === "green").length;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className={alphaStatusClass(ready ? "good" : "warn")}>
        {pooledReady ? "pooled live ready" : byoReady ? "BYO mainnet live" : publicMarketData ? "mainnet data live" : "setup pending"}
      </span>
      <span className={statusPillClass("px-2 py-1")}>
        venues <span className={ready ? "text-emerald-200" : "text-amber-200"}>
          {liveTradingStatus ? `${readyCount}/${venues.length}` : "checking"}
        </span>
      </span>
      <span className={statusPillClass("px-2 py-1")}>
        orders <span className={ready ? "text-emerald-200" : "text-amber-200"}>
          {pooledReady ? "pooled enabled" : byoReady ? "scoped account" : "preview only"}
        </span>
      </span>
      {venues.slice(0, 4).map((venue) => (
        <span key={venue.id} className={statusPillClass("px-2 py-1")}>
          {venue.label} <span className={venue.status === "green" ? "text-emerald-200" : "text-amber-200"}>
            {venue.status === "green" ? "ready" : "pending"}
          </span>
        </span>
      ))}
    </div>
  );
}

function selectedPooledSubmitBlocker(input: {
  platformClass: string;
  liveTradingStatus: PrivateAccountLiveTradingStatus | null;
  hyperliquidVault: HyperliquidVaultState | null;
  phoenixVault: VenueVaultState | null;
  jupiterVault: VenueVaultState | null;
  coinbaseVault: VenueVaultState | null;
  omnibus: OmnibusState | null;
}): string | null {
  if (input.platformClass === "hyperliquid_style_market") {
    const pooled =
      input.hyperliquidVault?.managed_allocation?.status === "allocated" &&
      input.hyperliquidVault.managed_allocation.execution_mode === "ghola_pooled";
    return pooled ? pooledVenueBlocker(input.liveTradingStatus, "hyperliquid", "Hyperliquid") : null;
  }
  if (input.platformClass === "solana_perps_market") {
    return input.phoenixVault?.pooled_allocation?.status === "allocated"
      ? pooledVenueBlocker(input.liveTradingStatus, "phoenix", "Phoenix")
      : null;
  }
  if (input.platformClass === "solana_swap_aggregator") {
    return input.jupiterVault?.pooled_allocation?.status === "allocated"
      ? pooledVenueBlocker(input.liveTradingStatus, "jupiter", "Jupiter")
      : null;
  }
  if (input.platformClass === "coinbase_style_provider") {
    return input.omnibus?.ready && input.coinbaseVault?.venue_execution_vault?.status !== "sealed"
      ? pooledVenueBlocker(input.liveTradingStatus, "coinbase", "Coinbase")
      : null;
  }
  return null;
}

function pooledVenueBlocker(
  liveTradingStatus: PrivateAccountLiveTradingStatus | null,
  venueId: PrivateAccountLiveTradingStatus["required_venues"][number]["id"],
  label: string,
): string | null {
  const venue = liveTradingStatus?.required_venues.find((item) => item.id === venueId);
  if (!venue) return `Checking ${label} pooled setup`;
  return venue.status === "green" ? null : `${label} pooled submit is not ready; use a scoped API wallet`;
}

function pooledVenueReady(
  liveTradingStatus: PrivateAccountLiveTradingStatus | null,
  venueId: PrivateAccountLiveTradingStatus["required_venues"][number]["id"],
): boolean {
  return liveTradingStatus?.required_venues.find((item) => item.id === venueId)?.status === "green";
}

function AlphaScoutMeta({ recommendation }: { recommendation: AlphaScoutRecommendation }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8b95a8]">
      <span><span className="text-[#59657a]">market</span> <span className="font-medium text-[#cdd6e7]">{recommendation.market}</span></span>
      <span><span className="text-[#59657a]">side</span> <span className="font-medium text-[#cdd6e7]">{formatValue(recommendation.side)}</span></span>
      <span><span className="text-[#59657a]">cap</span> <span className="font-medium text-[#cdd6e7]">{recommendation.notional}</span></span>
      <span><span className="text-[#59657a]">guard</span> <span className="font-medium text-[#cdd6e7]">{recommendation.risk}</span></span>
    </div>
  );
}

function buildAlphaScoutRecommendations(input: {
  activeSession: PrivateAutopilotSession | null;
  events: PrivateAutopilotEvent[];
  marketSummary: AlphaScoutMarketSummary[];
  order: PrivateExecutionOrderDraft;
  preview: GholaPrivacyPreview | null;
  queueCount: number;
  readiness: PrivateAutopilotReadiness | null;
  selectedVenue: AgentVenueCard;
}): AlphaScoutRecommendation[] {
  const orderFacts = alphaScoutOrderFacts(input.order, input.selectedVenue);
  const latestProposal = [...input.events].reverse().find((event) => event.type === "proposal");
  if (!input.activeSession) {
    return [
      {
        id: "arm",
        title: "Live Capped agent is off",
        detail: `Start a capped ${input.selectedVenue.title} agent that trades only inside the limits you set.`,
        tone: "warn",
        action: "arm",
        actionLabel: "Start agent",
        ...orderFacts,
      },
      {
        id: "manual-preview",
        title: "Preview the current order",
        detail: input.preview ? `Latest preview: ${statusLabel(input.preview.claim_status)}.` : "Skip agent watch and run a one-time visibility check for the order ticket below.",
        tone: input.preview && isPrivateModeAvailableStatus(input.preview.claim_status) ? "good" : "warn",
        action: "preview",
        actionLabel: "Preview order",
        ...orderFacts,
      },
    ];
  }
  if (input.activeSession.status === "paused") {
    return [
      {
        id: "paused",
        title: "Auto-trade scout is paused",
        detail: "The cap is still saved, but the worker cannot recommend or submit while paused.",
        tone: "warn",
        action: "resume",
        actionLabel: "Resume",
        ...orderFacts,
      },
    ];
  }
  if (input.activeSession.status === "killed" || input.activeSession.status === "expired") {
    return [
      {
        id: "dead",
        title: `Auto-trade scout is ${formatValue(input.activeSession.status)}`,
        detail: "Create a fresh mandate before the worker can recommend or submit anything.",
        tone: "danger",
        action: "arm",
        actionLabel: "Re-arm",
        ...orderFacts,
      },
    ];
  }
  const recommendations: AlphaScoutRecommendation[] = [];
  if (latestProposal) {
    recommendations.push({
      id: latestProposal.event_id,
      title: latestProposal.message,
      detail: `Policy ${shortCommitment(input.activeSession.session_policy.policy_commitment)}; venue ${formatValue(input.activeSession.status)}.`,
      tone: "good",
      action: "preview",
      actionLabel: "Preview",
      ...orderFacts,
    });
  }
  const readyMarkets = input.marketSummary.filter((item) => item.tone === "good");
  if (readyMarkets[0]) {
    recommendations.push({
      id: "market-watch",
      title: `${readyMarkets[0].label} market feed is live`,
      detail: readyMarkets[0].detail,
      tone: "good",
      action: "preview",
      actionLabel: "Inspect",
      ...alphaScoutOrderFacts({ ...input.order, market: readyMarkets[0].label.replace(/^HL /, "").replace(/^CB /, "") }, input.selectedVenue, readyMarkets[0]),
    });
  }
  if (input.readiness && !input.readiness.can_live_submit) {
    const display = input.readiness.execution_display ?? deriveAutopilotExecutionDisplay(input.readiness);
    recommendations.push({
      id: "readiness-gap",
      title: display.label,
      detail: display.plain_reason || display.detail,
      tone: "warn",
      action: "pause",
      actionLabel: "Pause",
      ...orderFacts,
    });
  }
  if (input.queueCount > 0) {
    recommendations.push({
      id: "queue",
      title: "Privacy queue has pending work",
      detail: `${input.queueCount} queued action${input.queueCount === 1 ? "" : "s"} may compete for funding or caps.`,
      tone: "warn",
      action: "pause",
      actionLabel: "Pause",
      ...orderFacts,
    });
  }
  recommendations.push({
    id: "control",
    title: input.activeSession.execution_enabled ? "Live Capped agent is running" : "Waiting for entry",
    detail: deriveAutopilotExecutionDisplay({ ...(input.readiness ?? {}), session: input.activeSession }).detail,
    tone: input.activeSession.execution_enabled ? "good" : "warn",
    action: input.activeSession.execution_enabled ? "pause" : "preview",
    actionLabel: input.activeSession.execution_enabled ? "Pause" : "Review",
    ...orderFacts,
  });
  return recommendations.slice(0, 4);
}

function alphaScoutOrderFacts(
  order: PrivateExecutionOrderDraft,
  selectedVenue: AgentVenueCard,
  marketSummary?: AlphaScoutMarketSummary,
): Pick<AlphaScoutRecommendation, "market" | "side" | "notional" | "entry" | "risk" | "evidence"> {
  const market = (order.market || marketSummary?.label || selectedVenue.title).toUpperCase();
  const side = order.side === "sell" ? "sell" : order.side === "buy" ? "buy" : "watch";
  const notional = order.quote_size?.trim()
    ? `$${order.quote_size.trim()}`
    : order.base_size?.trim()
      ? `${order.base_size.trim()} ${market.split("-")[0]}`
      : selectedVenue.access.includes("connect")
        ? "policy cap"
        : "bounded";
  const entry = order.limit_price?.trim()
    ? `Limit ${formatPrice(order.limit_price.trim())}`
    : order.order_type === "market" || order.live_order_mode === "tiny_fill"
      ? "IOC market within limits"
      : "Wait for venue quote";
  const slippage = order.max_slippage_bps?.trim() || "50";
  const risk = side === "watch"
    ? "scan only"
    : `${slippage} bps slippage cap`;
  const evidence = [
    marketSummary?.detail || `${selectedVenue.title} route selected`,
    `Hidden: ${selectedVenue.hidden}`,
    `Visible: ${selectedVenue.visible}`,
    `${formatValue(side)} ${market} ${notional} · ${risk}`,
  ];
  return { market, side, notional, entry, risk, evidence };
}

function recommendationNeedsSession(action: AlphaScoutRecommendation["action"]) {
  return action === "pause" || action === "resume" || action === "kill";
}

function buildAlphaScoutLedger(
  activeSession: PrivateAutopilotSession | null,
  events: PrivateAutopilotEvent[],
): Array<{ id: string; time: string; title: string; detail: string }> {
  const rows = events.slice(-5).reverse().map((event) => ({
    id: event.event_id,
    time: compactTime(event.created_at),
    ...customerAutopilotEventCopy(event),
  }));
  if (rows.length > 0) return rows;
  return [{
    id: "draft",
    time: activeSession ? compactTime(activeSession.updated_at) : "now",
    title: activeSession ? formatValue(activeSession.status) : "draft",
    detail: activeSession?.next_step || "No signed mandate yet.",
  }];
}

function replayString(record: Record<string, unknown> | null | undefined, key: string, fallback = "") {
  const value = record?.[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return fallback;
}

function replayArrayLength(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

function alphaStatusClass(tone: "good" | "warn" | "danger") {
  const base = "rounded-[3px] border px-2 py-1 text-xs font-medium";
  if (tone === "good") return `${base} border-[#244a3b] bg-[#173126] text-[#d9fff1]`;
  if (tone === "danger") return `${base} border-[#5a2830] bg-[#341820] text-[#ffe4e7]`;
  return `${base} border-[#5c4b23] bg-[#2b2412] text-[#fff1a8]`;
}

function compactSelectorClass(selected: boolean, sizeClass: string) {
  const base = "rounded-[3px] border font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  if (selected) {
    return `${base} ${sizeClass} border-[#344b65] bg-[#172536] text-[#f4f7ff]`;
  }
  return `${base} ${sizeClass} border-[#1b2839] bg-[#0b1119] text-[#93a0b5] hover:border-[#344b65] hover:bg-[#111a26] hover:text-[#e8edf7]`;
}

function statusPillClass(sizeClass = "px-2 py-1") {
  return `rounded-[3px] border border-[#1f2d40] bg-[#0d141e] ${sizeClass} text-[#8b95a8]`;
}

function alphaRecommendationClass(tone: "good" | "warn" | "danger", selected: boolean) {
  return [
    "relative grid gap-3 px-3 py-3 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
    selected ? "bg-[#101722]" : "bg-transparent hover:bg-[#0d131c]",
    tone === "danger" ? "text-red-50" : "text-[#eef1f8]",
  ].join(" ");
}

function alphaRecommendationRailClass(tone: "good" | "warn" | "danger") {
  if (tone === "good") return "absolute bottom-3 left-0 top-3 w-px bg-emerald-300/70";
  if (tone === "danger") return "absolute bottom-3 left-0 top-3 w-px bg-red-300/70";
  return "absolute bottom-3 left-0 top-3 w-px bg-[#a8d8ff]/70";
}

function alphaRecommendationActionClass(tone: "good" | "warn" | "danger") {
  const base = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[3px] border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  if (tone === "good") {
    return `${base} border-[#d8e6f8] bg-[#d8e6f8] text-[#070b10] hover:bg-white`;
  }
  if (tone === "danger") {
    return `${base} border-red-300/40 bg-[#3a171d] text-red-100 hover:bg-[#4a1d25]`;
  }
  return `${base} border-[#d8e6f8] bg-[#d8e6f8] text-[#070b10] hover:bg-white`;
}

function alphaDecisionButtonClass(kind: "preview" | "approve" | "deny" | "neutral") {
  const base = "inline-flex h-8 items-center justify-center gap-1.5 rounded-[3px] border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  if (kind === "approve") {
    return `${base} border-[#244a3b] bg-[#173126] text-[#d9fff1] hover:bg-[#1d3c2f] disabled:border-[#1f2d40] disabled:bg-[#0d141e] disabled:text-[#59657a]`;
  }
  if (kind === "deny") {
    return `${base} border-[#5a2830] bg-[#341820] text-[#ffe4e7] hover:bg-[#431d27] disabled:border-[#1f2d40] disabled:bg-[#0d141e] disabled:text-[#59657a]`;
  }
  if (kind === "neutral") {
    return `${base} border-[#1f2d40] bg-[#0d141e] text-[#9aa6ba] hover:border-[#344b65] hover:bg-[#111a26] hover:text-[#e8edf7]`;
  }
  return `${base} border-[#344b65] bg-[#172536] text-[#f4f7ff] hover:bg-[#1b2d42] disabled:border-[#1f2d40] disabled:bg-[#0d141e] disabled:text-[#59657a]`;
}

function alphaVenueForPlatform(platformClass: string): AlphaScoutVenueId {
  return ALPHA_SCOUT_VENUES.find((venue) => venue.platformClass === platformClass)?.id ?? "hyperliquid";
}

function alphaScoutVenueLabel(id: AlphaScoutVenueId): string {
  return ALPHA_SCOUT_VENUES.find((venue) => venue.id === id)?.label ?? formatValue(id);
}

function alphaScoutPositionCap(
  orderCap: PrivateAutopilotSessionPolicy["max_notional_bucket"],
): PrivateAutopilotSessionPolicy["max_position_notional_bucket"] {
  if (orderCap === "1000" || orderCap === "500") return "500";
  if (orderCap === "250" || orderCap === "100") return "250";
  if (orderCap === "50") return "100";
  return "50";
}

function toggleAlphaVenue(current: AlphaScoutVenueId[], value: AlphaScoutVenueId): AlphaScoutVenueId[] {
  if (current.includes(value)) {
    const next = current.filter((item) => item !== value);
    return next.length ? next : [value];
  }
  return [...current, value];
}

function toggleStringValue(current: string[], value: string): string[] {
  if (current.includes(value)) {
    const next = current.filter((item) => item !== value);
    return next.length ? next : [value];
  }
  return [...current, value];
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AgentModeSwitch({
  tradeFlow,
  onTrade,
  onPrivate,
}: {
  tradeFlow: boolean;
  onTrade: () => void;
  onPrivate: () => void;
}) {
  return (
      <div className="grid grid-cols-2 rounded-[5px] border border-[#243248] bg-[#08090d] p-0.5" role="group" aria-label="Mode">
      <button
        type="button"
        aria-pressed={tradeFlow}
        onClick={onTrade}
        className={
          tradeFlow
            ? "h-8 rounded-[3px] bg-[#eef1f8] px-3 text-sm font-medium text-[#08090d]"
            : "h-8 rounded-[3px] bg-[#0b1119] px-3 text-sm font-medium text-[#93a0b5] hover:bg-[#111a26] hover:text-[#eef1f8]"
        }
      >
        Trading agents
      </button>
      <button
        type="button"
        aria-pressed={!tradeFlow}
        onClick={onPrivate}
        className={
          !tradeFlow
            ? "h-8 rounded-[3px] bg-[#eef1f8] px-3 text-sm font-medium text-[#08090d]"
            : "h-8 rounded-[3px] bg-[#0b1119] px-3 text-sm font-medium text-[#93a0b5] hover:bg-[#111a26] hover:text-[#eef1f8]"
        }
      >
        Private actions
      </button>
    </div>
  );
}

function SignedOutAccountGate({
  liveHyperliquidFlow,
  livePhoenixFlow,
  liveJupiterFlow,
  liveCoinbaseFlow,
  onSignIn,
}: {
  liveHyperliquidFlow: boolean;
  livePhoenixFlow: boolean;
  liveJupiterFlow: boolean;
  liveCoinbaseFlow: boolean;
  onSignIn: () => void;
}) {
  const headline = liveHyperliquidFlow
    ? "Sign in to use Ghola with Hyperliquid"
    : livePhoenixFlow
      ? "Sign in to trade with Phoenix"
      : liveJupiterFlow
        ? "Sign in to swap with Jupiter"
        : liveCoinbaseFlow
          ? "Sign in to trade with Coinbase"
          : "Sign in to use Private Mode";
  const description = liveHyperliquidFlow
    ? "Create Hyperliquid trading access, check visibility, then approve a capped live order."
    : livePhoenixFlow
      ? "Connect a dedicated trading authority, check visibility, then place a capped live trade."
      : liveJupiterFlow
        ? "Connect a dedicated swap authority, check route visibility, then approve a capped live swap."
        : liveCoinbaseFlow
          ? "Connect a scoped Coinbase Advanced API key, check visibility, then approve a capped live order."
          : "Create your Ghola account, choose an action, then check privacy before anything moves.";
  return (
    <section className="grid gap-4 border border-[#1e2a3a] bg-[#0f1117] p-5 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center border border-[#243347] bg-[#08090d]">
          <LockKeyhole className="h-5 w-5 text-[#a8d8ff]" />
        </div>
        <div>
          <h2 className="text-lg font-medium text-[#eef1f8]">
            {headline}
          </h2>
          <p className="mt-1 text-sm text-[#8b95a8]">
            {description}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onSignIn}
        className="inline-flex h-11 items-center justify-center bg-[#eef1f8] px-5 text-sm font-medium text-[#08090d] hover:bg-[#dfe7f6]"
      >
        Sign in to connect
      </button>
    </section>
  );
}

async function fetchJupiterRouteQuoteSnapshot(): Promise<MobileMarketJupiter | null> {
  const params = new URLSearchParams({ product_id: "SOL-USD", interval: "5m" });
  const res = await fetch(`/v1/private-account/markets/mobile-snapshot?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("jupiter_quote_snapshot_unavailable");
  const body = await res.json() as { solana_dex?: { jupiter?: MobileMarketJupiter | null } | null };
  return body.solana_dex?.jupiter ?? null;
}

function friendlyPrivateAccountError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : "";
  if (message === "phoenix_connection_check_required") {
    return "Check the Phoenix connection before placing a live trade.";
  }
  if (message === "jupiter_connection_check_required") {
    return "Check the Jupiter connection before placing a live swap.";
  }
  if (message === "hyperliquid_connection_check_required") {
    return "Check the Hyperliquid connection before placing a live trade.";
  }
  if (message === "hyperliquid_execution_vault_not_ready") {
    return "Create Hyperliquid trading access first, or use a scoped API wallet.";
  }
  if (message === "needs_funds") {
    return "Needs funds. Add venue collateral, then check the connection again.";
  }
  if (message === "venue_access_required") {
    return "Create Hyperliquid trading access first, or use a scoped API wallet.";
  }
  if (message === "hyperliquid_managed_allocation_not_ready") {
    return "Ghola could not prepare the Hyperliquid test account yet. Try again after the connector is healthy.";
  }
  if (message === "venue_eligibility_required") {
    return "Ghola needs a verified Hyperliquid eligibility check before allocating the trading account.";
  }
  if (message === "terms_acceptance_required") {
    return "Accept the beta terms and risk disclosure before using the Ghola pool.";
  }
  if (message === "restricted_jurisdiction") {
    return "Ghola pooled Hyperliquid access is limited to eligible non-US beta users.";
  }
  if (message === "ghola_balance_insufficient") {
    return "Your Ghola balance is below this order cap. Add balance or lower the cap.";
  }
  if (message === "pooled_account_pool_unavailable") {
    return "Ghola pooled access is not configured for this venue yet. Connect a scoped API wallet to trade now.";
  }
  if (message === "hyperliquid_managed_allocation_failed") {
    return "Ghola could not allocate a Hyperliquid pooled account. Connect a scoped API wallet to trade now.";
  }
  if (message === "funding_attestation_required") {
    return "Create trading access needs private funding proof for this cap. Add or import funding below, then run Create trading access again.";
  }
  if (message === "funding_destination_commitment_required") {
    return "Create trading access needs a funding destination before Ghola can verify private funding evidence.";
  }
  if (message === "funding_attestation_amount_bucket_mismatch") {
    return "The funding evidence does not match this intent cap. Lower the cap or refresh funding evidence.";
  }
  if (message === "venue_rejected") {
    return "The venue rejected the access, funds, market, or order. Ghola did not route around the venue.";
  }
  if (message === "connector_submit_failed") {
    return "The private worker received the request but could not complete its venue check. No order was sent.";
  }
  if (message === "connector_submit_ambiguous") {
    return "Order outcome is unknown. Ghola locked this request and will not retry it; reconcile with Hyperliquid before doing anything else.";
  }
  if (message === "hyperliquid_agent_binding_required") {
    return "Reconnect the API wallet. Ghola now requires proof from the exact agent key.";
  }
  if (message === "hyperliquid_agent_not_authorized") {
    return "Hyperliquid does not show this API wallet as authorized for that owner account.";
  }
  if (message === "hyperliquid_binding_check_unavailable") {
    return "Ghola could not verify the owner-to-agent relationship with Hyperliquid. Nothing was submitted.";
  }
  if (message === "connector_not_ready") {
    return "This connector is not ready yet.";
  }
  if (message === "invalid_authority_or_access") {
    return "The venue could not use that trading authority or API wallet. Check the credential and venue access.";
  }
  if (message === "rpc_unreachable") {
    return "Ghola could not reach Solana RPC for the Phoenix check.";
  }
  if (message === "worker_unavailable" || message === "connector_endpoint_missing") {
    return "The private execution worker is unavailable.";
  }
  if (message === "unsupported_platform") {
    return "No-submit verification is wired for Hyperliquid, Phoenix, and Jupiter.";
  }
  if (message === "policy_blocked" || message === "live_gate_disabled") {
    return "Live Capped trading is not available for this order yet.";
  }
  if (message === "solana_perps_execution_vault_not_ready") {
    return "Connect a Phoenix trading authority first.";
  }
  if (message === "solana_swap_execution_vault_not_ready" || message === "jupiter_execution_vault_not_ready") {
    return "Connect a Jupiter swap authority first.";
  }
  if (message === "private_mode_evidence_required") {
    return "Private Mode is waiting for evidence. Queue the action or try again when evidence is ready.";
  }
  return message || fallback;
}

function revealPrivateFundingPanel() {
  if (typeof document === "undefined") return;
  const advanced = document.getElementById("private-account-advanced");
  if (advanced instanceof HTMLDetailsElement) {
    advanced.open = true;
  }
  window.requestAnimationFrame(() => {
    document.getElementById("private-funding")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}

function upsertAutopilotSession(
  current: PrivateAutopilotSession[],
  next: PrivateAutopilotSession,
): PrivateAutopilotSession[] {
  const found = current.some((session) => session.autopilot_session_id === next.autopilot_session_id);
  const merged = found
    ? current.map((session) => session.autopilot_session_id === next.autopilot_session_id ? next : session)
    : [next, ...current];
  return merged.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 25);
}

function upsertAutopilotEvent(
  current: PrivateAutopilotEvent[],
  next: PrivateAutopilotEvent,
): PrivateAutopilotEvent[] {
  const found = current.some((event) => event.event_id === next.event_id);
  const merged = found
    ? current.map((event) => event.event_id === next.event_id ? next : event)
    : [...current, next];
  return merged.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-100);
}

function marketForAutopilotReadiness(value: string): string {
  const market = value.toUpperCase();
  if (market.includes("ETH")) return "ETH-USD";
  if (market.includes("SOL")) return "SOL-USD";
  if (market.includes("HYPE")) return "HYPE";
  return "BTC-USD";
}

function alphaScoutMarketSummary(input: {
  hyperliquidMarket: HyperliquidMarketSnapshot | null;
  hyperliquidStatus: HyperliquidLiveMarketStatus;
  phoenixMarket: PhoenixMarketSnapshot | null;
  phoenixStatus: PhoenixLiveMarketStatus;
  jupiterQuote: MobileMarketJupiter | null;
  jupiterStatus: JupiterQuoteStatus;
  coinbaseMarket: CoinbaseMarketSnapshot | null;
  coinbaseStatus: CoinbaseLiveMarketStatus;
}): AlphaScoutMarketSummary[] {
  const hyperliquid = input.hyperliquidMarket;
  const phoenix = input.phoenixMarket;
  const jupiter = input.jupiterQuote;
  const coinbase = input.coinbaseMarket;
  return [
    {
      label: `HL ${hyperliquid?.coin || "BTC"}`,
      status: input.hyperliquidStatus === "live" || input.hyperliquidStatus === "fallback_polling" ? "live" : "sync",
      tone: hyperliquid && !hyperliquid.stale ? "good" : "warn",
      detail: [
        hyperliquid?.mid || hyperliquid?.mark_price ? formatPrice(hyperliquid.mid || hyperliquid.mark_price || "") : "price pending",
        hyperliquid?.spread_bps != null ? `${hyperliquid.spread_bps.toFixed(2)} bps` : "spread pending",
        hyperliquid?.funding_rate ? `fund ${formatSignedPercent(Number(hyperliquid.funding_rate) * 100)}` : null,
      ].filter(Boolean).join(" · "),
    },
    {
      label: "Phoenix SOL",
      status: input.phoenixStatus === "live" || input.phoenixStatus === "fallback_polling" ? "live" : "sync",
      tone: phoenix && !phoenix.stale ? "good" : "warn",
      detail: [
        phoenix?.mid || phoenix?.mark_price ? formatPrice(phoenix.mid || phoenix.mark_price || "") : "price pending",
        phoenix?.spread_bps != null ? `${phoenix.spread_bps.toFixed(2)} bps` : "spread pending",
        phoenix?.funding_rate ? `fund ${formatSignedPercent(Number(phoenix.funding_rate) * 100)}` : null,
      ].filter(Boolean).join(" · "),
    },
    {
      label: "Jupiter SOL",
      status: input.jupiterStatus === "live" || input.jupiterStatus === "fallback_polling" ? "live" : "sync",
      tone: jupiter && !jupiter.stale ? "good" : "warn",
      detail: [
        jupiter?.price ? formatJupiterRoutePrice(jupiter.price) : "quote pending",
        jupiter?.price_impact_pct ? `impact ${jupiter.price_impact_pct}%` : "impact pending",
        jupiter?.route_summary.length ? jupiter.route_summary.slice(0, 2).join(" / ") : "route pending",
      ].filter(Boolean).join(" · "),
    },
    {
      label: `CB ${coinbase?.base_currency_id || "BTC"}`,
      status: input.coinbaseStatus === "live" || input.coinbaseStatus === "fallback_polling" ? "live" : "sync",
      tone: coinbase && !coinbase.stale && !coinbase.trading_disabled ? "good" : "warn",
      detail: [
        coinbase?.mid || coinbase?.price ? formatPrice(coinbase.mid || coinbase.price || "") : "price pending",
        coinbase?.spread_bps != null ? `${coinbase.spread_bps.toFixed(2)} bps` : "spread pending",
        coinbase?.price_percentage_change_24h ? `24h ${coinbase.price_percentage_change_24h}%` : null,
      ].filter(Boolean).join(" · "),
    },
  ];
}

function hyperliquidLiveStatus(input: {
  liveHyperliquidFlow: boolean;
  connected: boolean;
  armed: boolean;
  fundingReady: boolean;
  verification?: NoFundsVerificationState | null;
  accountStatus?: string | null;
}) {
  if (!input.connected) return input.liveHyperliquidFlow ? "Create trading access" : "Choose access";
  if (input.accountStatus === "needs_funds" || input.verification?.reason === "needs_funds") return "Needs funds";
  if (!input.armed) return "Create agent";
  if (input.liveHyperliquidFlow) {
    if (input.verification?.status === "worker_unavailable") return "Worker unavailable";
    if (input.verification?.status === "failed") return "Check failed";
    if (input.verification?.status !== "verified_no_funds") return "Check connection";
    return "Ready to place trade";
  }
  if (!input.fundingReady) return "Needs funds";
  return "Ready to trade";
}

function phoenixLiveStatus(input: {
  connected: boolean;
  armed: boolean;
  verification: NoFundsVerificationState | null;
}) {
  if (!input.connected) return "Venue access required";
  if (input.verification?.status === "worker_unavailable") return "Worker unavailable";
  if (input.verification?.reason === "needs_funds") return "Needs funds";
  if (input.verification?.status === "failed") return "Venue access required";
  if (!input.verification || input.verification.status !== "verified_no_funds") return "Check connection";
  if (!input.armed) return "Create agent";
  return "Ready to trade";
}

function jupiterLiveStatus(input: {
  connected: boolean;
  armed: boolean;
  verification: NoFundsVerificationState | null;
}) {
  if (!input.connected) return "Venue access required";
  if (input.verification?.status === "worker_unavailable") return "Worker unavailable";
  if (input.verification?.reason === "needs_funds") return "Needs funds";
  if (input.verification?.status === "failed") return "Check failed";
  if (!input.verification || input.verification.status !== "verified_no_funds") return "Check route";
  if (!input.armed) return "Create agent";
  return "Ready to swap";
}

function labelFor(options: ReadonlyArray<readonly [string, string]>, value: string) {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? value;
}

function agentComposerCanRun(kind: TradingActionKind) {
  return kind !== "place_trade" &&
    kind !== "accept_visibility" &&
    kind !== "wait_for_privacy" &&
    kind !== "blocked" &&
    kind !== "idle";
}

function agentComposerActionItems(action: TradingNextAction) {
  return action.secondary ? [action, action.secondary] : [action];
}

function agentComposerModeHint(platformClass: string, actions: TradingNextAction[]) {
  if (!actions.some((action) => action.kind.includes("vault") || action.kind.includes("byo") || action.kind.includes("connect"))) {
    return "Intent preview creates the private intent before approval.";
  }
  if (platformClass === "hyperliquid_style_market") {
    return "Use a scoped Hyperliquid API wallet now; Ghola pool unlocks when configured.";
  }
  if (platformClass === "solana_perps_market") {
    return "Use a dedicated Phoenix authority now; Ghola pool unlocks when configured.";
  }
  if (platformClass === "solana_swap_aggregator") {
    return "Use a dedicated swap authority now; Ghola pool unlocks when configured.";
  }
  if (platformClass === "coinbase_style_provider") {
    return "Use a scoped Coinbase key now; Ghola partner pool unlocks when configured.";
  }
  return "Choose the account path before previewing the intent.";
}

function agentComposerNoticeClass(tone: SetupNoticeState["tone"]) {
  if (tone === "good") return "flex min-w-0 flex-col gap-0.5 border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5 text-[11px] text-emerald-100";
  if (tone === "bad") return "flex min-w-0 flex-col gap-0.5 border border-red-300/20 bg-red-300/10 px-2 py-1.5 text-[11px] text-red-100";
  if (tone === "warn") return "flex min-w-0 flex-col gap-0.5 border border-amber-300/20 bg-amber-300/10 px-2 py-1.5 text-[11px] text-amber-100";
  return "flex min-w-0 flex-col gap-0.5 border border-[#3da8ff]/25 bg-[#3da8ff]/10 px-2 py-1.5 text-[11px] text-[#a8d8ff]";
}

function agentComposerActionLabel(action: TradingNextAction) {
  if (action.kind === "preview") return "Preview intent";
  if (action.kind === "place_trade" || action.kind === "accept_visibility") return "Ready";
  if (action.kind === "wait_for_privacy") return "Queued";
  if (action.kind === "blocked") return "Blocked";
  if (action.kind.startsWith("arm_")) return "Create agent";
  return action.label;
}

function summarizeTradeIntent(order: PrivateExecutionOrderDraft, platformClass: string) {
  const normalized = isExecutionPlatform(platformClass)
    ? normalizeOrderForPlatform(order, platformClass)
    : order;
  const side = normalized.side === "sell" ? "Sell" : "Buy";
  const quoteSize = normalized.quote_size?.trim();
  const baseSize = normalized.base_size?.trim();
  const notional = quoteSize
    ? `$${quoteSize}`
    : baseSize
      ? `${baseSize} ${normalized.market || ""}`.trim()
      : "capped";
  const strategy = normalized.agent_strategy_profile
    ? ` · ${optionLabel(AGENT_STRATEGY_PROFILES, normalized.agent_strategy_profile)}`
    : "";

  if (platformClass === "solana_swap_aggregator") {
    return `Swap ${normalized.market || "SOL/USDC"} · ${notional}${strategy}`;
  }

  if (platformClass === "coinbase_style_provider") {
    return `${side} ${normalized.market || "BTC-USD"} · ${notional}${strategy}`;
  }

  const market = `${(normalized.market || "BTC").toUpperCase().split("-")[0]}-PERP`;
  const tif = normalized.tif || (normalized.live_order_mode === "tiny_fill" ? "Ioc" : "");
  return `${side} ${market} · ${notional}${tif ? ` · ${tif.toUpperCase()}` : ""}${strategy}`;
}

function destinationForApp(platformClass: string) {
  if (platformClass === "solana_private_balance") return "ghola_user";
  if (platformClass === "solana_public_wallet") return "external_public_address";
  return "platform_subaccount";
}

function inferDestinationPlatform(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("hyper")) return "hyperliquid_style_market";
  if (normalized.includes("phoenix") || normalized.includes("drift") || normalized.includes("backpack")) return "solana_perps_market";
  if (normalized.includes("jupiter") || normalized.includes("swap")) return "solana_swap_aggregator";
  if (normalized.includes("coinbase")) return "coinbase_style_provider";
  if (normalized.includes("rfq") || normalized.includes("quote")) return "rfq_solver_network";
  if (normalized.includes("stock") || normalized.includes("bond") || normalized.includes("partner")) return "partner_tokenized_assets";
  if (normalized.startsWith("@") || normalized.includes("ghola")) return "solana_private_balance";
  if (/^(0x)?[a-z0-9]{32,}$/i.test(normalized) || normalized.includes("wallet")) return "solana_public_wallet";
  return "solana_private_balance";
}

function marketCoinFromOrder(value: string): "BTC" | "ETH" | "SOL" | "HYPE" {
  const normalized = value.trim().toUpperCase().split("-")[0];
  if (normalized === "ETH" || normalized === "SOL" || normalized === "HYPE") return normalized;
  return "BTC";
}

function coinbaseProductFromOrder(value: string): CoinbaseProductId {
  const normalized = value.trim().toUpperCase();
  const base = normalized.includes("-") ? normalized.split("-")[0] : normalized;
  if (base === "ETH") return "ETH-USD";
  if (base === "SOL") return "SOL-USD";
  return "BTC-USD";
}

function hyperliquidAssetBucket(market: "BTC" | "ETH" | "SOL" | "HYPE"): PrivateAccountSafeInput["asset_bucket"] {
  if (market === "BTC") return "BTC";
  if (market === "ETH") return "ETH";
  if (market === "SOL") return "SOL";
  return "major";
}

function coinbaseAssetBucket(productId: CoinbaseProductId): PrivateAccountSafeInput["asset_bucket"] {
  if (productId === "ETH-USD") return "ETH";
  if (productId === "SOL-USD") return "SOL";
  return "BTC";
}

function hyperliquidAccountStatusLabel(status: string) {
  if (status === "ready_to_trade") return "Ready to preview";
  if (status === "needs_funds") return "Needs funds";
  if (status === "worker_unavailable") return "Worker unavailable";
  if (status === "private_mode_waiting") return "Checking account";
  return "Connect account";
}

function hyperliquidAccountStreamLabel(status: HyperliquidAccountStreamStatus | string | undefined) {
  if (status === "live") return "Account live";
  if (status === "backfilling") return "Backfilling";
  if (status === "reconnecting") return "Reconnecting";
  if (status === "worker_unavailable") return "Worker unavailable";
  if (status === "venue_access_required") return "Connect account";
  if (status === "needs_funds") return "Needs funds";
  if (status === "snapshot") return "Snapshot";
  return "Connecting";
}

function hyperliquidEquityBucketLabel(status: HyperliquidAccountSnapshot["equity_bucket"] | undefined) {
  if (status === "ready") return "Ready";
  if (status === "low" || status === "none") return "Needs funds";
  if (status === "unknown") return "Checking account";
  return "Connect to stream";
}

function hyperliquidMarketConnectionCopy(
  status: HyperliquidLiveMarketStatus,
  snapshot: HyperliquidMarketSnapshot | null,
) {
  if (status === "live" && !snapshot?.stale) return { label: "live stream", tone: "good" as const };
  if (status === "fallback_polling" && !snapshot?.stale) return { label: "polling fallback", tone: "warn" as const };
  if (status === "connecting") return { label: "connecting", tone: "warn" as const };
  if (status === "reconnecting") return { label: "reconnecting", tone: "warn" as const };
  if (status === "blocked") return { label: "stream blocked", tone: "bad" as const };
  return { label: "market stale", tone: "warn" as const };
}

function coinbaseMarketConnectionCopy(
  status: CoinbaseLiveMarketStatus,
  snapshot: CoinbaseMarketSnapshot | null,
) {
  if (status === "live" && !snapshot?.stale) return { label: "live stream", tone: "good" as const };
  if (status === "fallback_polling" && !snapshot?.stale) return { label: "polling fallback", tone: "warn" as const };
  if (status === "connecting") return { label: "connecting", tone: "warn" as const };
  if (status === "reconnecting") return { label: "reconnecting", tone: "warn" as const };
  if (status === "blocked") return { label: "stream blocked", tone: "bad" as const };
  return { label: "market stale", tone: "warn" as const };
}

function jupiterQuoteConnectionCopy(
  status: JupiterQuoteStatus,
  quote: MobileMarketJupiter | null,
) {
  if (status === "live" && quote && !quote.stale) return { label: "live quote", tone: "good" as const };
  if (status === "fallback_polling" && quote) return { label: "polling quote", tone: "warn" as const };
  if (status === "connecting") return { label: "connecting", tone: "warn" as const };
  if (status === "blocked") return { label: "quote blocked", tone: "bad" as const };
  return { label: "quote pending", tone: "warn" as const };
}

function hyperliquidMarketStats(snapshot: HyperliquidMarketSnapshot | null) {
  const candles = snapshot?.candles || [];
  const first = candles.length >= 2 ? Number(candles[0]?.c) : NaN;
  const last = candles.length >= 2 ? Number(candles.at(-1)?.c) : NaN;
  const highs = candles.map((candle) => Number(candle.h)).filter((value) => Number.isFinite(value));
  const lows = candles.map((candle) => Number(candle.l)).filter((value) => Number.isFinite(value));
  const change = Number.isFinite(first) && first !== 0 && Number.isFinite(last)
    ? ((last - first) / first) * 100
    : 0;
  const current = Number(snapshot?.mark_price || snapshot?.mid || last);
  const prevDay = Number(snapshot?.prev_day_price);
  const dayChange = Number.isFinite(prevDay) && prevDay !== 0 && Number.isFinite(current)
    ? ((current - prevDay) / prevDay) * 100
    : null;
  const funding = snapshot?.funding_rate == null ? NaN : Number(snapshot.funding_rate);
  const openInterest = snapshot?.open_interest == null ? NaN : Number(snapshot.open_interest);
  const openInterestNotional = Number.isFinite(openInterest) && Number.isFinite(current)
    ? String(openInterest * current)
    : null;
  return {
    changeLabel: candles.length >= 2 ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "-",
    changeTone: change >= 0 ? "good" as const : "bad" as const,
    dayChangeLabel: dayChange == null ? "-" : `${dayChange >= 0 ? "+" : ""}${dayChange.toFixed(2)}%`,
    dayChangeTone: dayChange == null ? "neutral" as const : dayChange >= 0 ? "good" as const : "bad" as const,
    highLabel: highs.length ? formatPrice(String(Math.max(...highs))) : "-",
    lowLabel: lows.length ? formatPrice(String(Math.min(...lows))) : "-",
    volumeLabel: snapshot?.day_notional_volume ? formatCompactUsd(snapshot.day_notional_volume) : "-",
    openInterestLabel: openInterestNotional ? formatCompactUsd(openInterestNotional) : "-",
    fundingLabel: Number.isFinite(funding) ? `${(funding * 100).toFixed(4)}%` : "-",
    fundingTone: !Number.isFinite(funding) || funding >= 0 ? "good" as const : "bad" as const,
  };
}

function coinbaseMarketStats(snapshot: CoinbaseMarketSnapshot | null) {
  const candles = snapshot?.candles || [];
  const first = candles.length >= 2 ? Number(candles[0]?.c) : NaN;
  const last = candles.length >= 2 ? Number(candles.at(-1)?.c) : NaN;
  const highs = candles.map((candle) => Number(candle.h)).filter((value) => Number.isFinite(value));
  const lows = candles.map((candle) => Number(candle.l)).filter((value) => Number.isFinite(value));
  const change = Number.isFinite(first) && first !== 0 && Number.isFinite(last)
    ? ((last - first) / first) * 100
    : 0;
  const dayChange = snapshot?.price_percentage_change_24h == null
    ? null
    : Number(snapshot.price_percentage_change_24h);
  return {
    changeLabel: candles.length >= 2 ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "-",
    changeTone: change >= 0 ? "good" as const : "bad" as const,
    dayChangeLabel: dayChange == null || !Number.isFinite(dayChange)
      ? "-"
      : `${dayChange >= 0 ? "+" : ""}${dayChange.toFixed(2)}%`,
    dayChangeTone: dayChange == null || !Number.isFinite(dayChange)
      ? "neutral" as const
      : dayChange >= 0 ? "good" as const : "bad" as const,
    highLabel: highs.length ? formatPrice(String(Math.max(...highs))) : "-",
    lowLabel: lows.length ? formatPrice(String(Math.min(...lows))) : "-",
    quoteVolumeLabel: snapshot?.approximate_quote_24h_volume ? formatCompactUsd(snapshot.approximate_quote_24h_volume) : "-",
    baseVolumeLabel: snapshot?.volume_24h
      ? formatCompactAssetAmount(snapshot.volume_24h, snapshot.base_currency_id)
      : "-",
  };
}

function formatSpreadBps(snapshot: CoinbaseMarketSnapshot | null) {
  if (!snapshot?.best_bid || !snapshot.best_ask || snapshot.spread_bps == null) return "-";
  const spread = Number(snapshot.spread_bps);
  if (!Number.isFinite(spread)) return "-";
  return `${spread.toLocaleString("en-US", {
    minimumFractionDigits: spread === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} bps`;
}

function formatJupiterRoutePrice(value: string) {
  return formatPrice(value);
}

function formatJupiterInputAmount(value: string | null | undefined) {
  return formatJupiterTokenAmount(value, "input");
}

function formatJupiterOutputAmount(value: string | null | undefined) {
  return formatJupiterTokenAmount(value, "output");
}

function formatJupiterTokenAmount(value: string | null | undefined, label: "input" | "output") {
  if (!value) return "-";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const scale = parsed >= 100_000_000 ? 1_000_000_000 : 1_000_000;
  const display = parsed / scale;
  const units = label === "input" ? "base units" : "quote units";
  return `${display.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${units}`;
}

function formatPrice(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed >= 10000) {
    return parsed.toLocaleString("en-US", { maximumFractionDigits: 1 });
  }
  if (parsed >= 1000) {
    return parsed.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (parsed >= 1) {
    return parsed.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatBookPrice(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed >= 10000) {
    return parsed.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  if (parsed >= 1) {
    return parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatSize(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatCompactAssetAmount(value: string, asset: string | null | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const formatted = Intl.NumberFormat("en-US", {
    notation: Math.abs(parsed) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(parsed) >= 10_000 ? 1 : 2,
  }).format(parsed);
  return asset ? `${formatted} ${asset}` : formatted;
}

function formatSignedPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompactUsd(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return `$${Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: parsed >= 1_000_000 ? 1 : 2,
  }).format(parsed)}`;
}

function formatValue(value: string) {
  return value.replaceAll("_", " ");
}

function shortCommitment(value: string) {
  if (value.length <= 22) return value;
  return `${value.slice(0, 14)}...${value.slice(-6)}`;
}

function safeRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replaceAll("-", "_");
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function storedTurnkeyPerpsMandate(network: "mainnet" | "testnet"): PerpsMandateV1 | null {
  try {
    const raw = localStorage.getItem(`ghola:turnkey-perps:v1:${network}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mandate?: PerpsMandateV1 };
    return parsed.mandate || null;
  } catch {
    return null;
  }
}

function shortLeakageStatus(status: string) {
  if (status.startsWith("hidden")) return "hidden";
  if (status.startsWith("minimized")) return "bucketed";
  if (status.includes("visible")) return "visible";
  if (status.includes("blocked")) return "blocked";
  if (status.includes("degraded")) return "degraded";
  return status;
}

function isExecutionPlatform(platformClass: string): boolean {
  return platformClass === "hyperliquid_style_market" ||
    platformClass === "coinbase_style_provider" ||
    platformClass === "solana_perps_market" ||
    platformClass === "solana_swap_aggregator";
}

function normalizeOrderForPlatform(
  order: PrivateExecutionOrderDraft,
  platformClass: string,
): PrivateExecutionOrderDraft {
  if (platformClass === "coinbase_style_provider") {
    const market = order.market.includes("-")
      ? order.market.toUpperCase()
      : `${order.market || "BTC"}-USD`.toUpperCase();
    return {
      ...order,
      venue_id: "coinbase_advanced",
      operation_class: "spot_limit_order",
      market,
      tif: order.tif === "ioc" || order.tif === "fok" ? order.tif : "gtc",
    };
  }
  if (platformClass === "solana_perps_market") {
    const orderType = order.order_type || (order.live_order_mode === "tiny_fill" ? "market" : "limit");
    const sizeMode = order.size_mode || (order.quote_size ? "quote" : "base");
    return {
      ...order,
      venue_id: "phoenix",
      operation_class: "perp_limit_order",
      market: (order.market || "SOL").toUpperCase().split("-")[0],
      order_type: orderType,
      size_mode: sizeMode,
      live_order_mode: order.live_order_mode,
      quote_size: sizeMode === "quote" ? order.quote_size || "5" : order.quote_size,
      limit_price: order.limit_price || "250",
      tif: orderType === "market" ? "Ioc" : order.tif === "Alo" || order.tif === "Ioc" ? order.tif : "Gtc",
      post_only: orderType === "limit" && (order.post_only === true || order.tif === "Alo"),
    };
  }
  if (platformClass === "solana_swap_aggregator") {
    const inputMint = order.input_mint || JUPITER_SOL_MINT;
    const outputMint = order.output_mint || (inputMint === JUPITER_SOL_MINT ? JUPITER_USDC_MINT : JUPITER_SOL_MINT);
    return {
      ...order,
      venue_id: "jupiter",
      operation_class: "swap",
      market: inputMint === JUPITER_SOL_MINT && outputMint === JUPITER_USDC_MINT ? "SOL/USDC" : "USDC/SOL",
      side: "buy",
      base_size: "",
      limit_price: "",
      quote_size: order.quote_size || "5",
      max_slippage_bps: order.max_slippage_bps || "50",
      input_mint: inputMint,
      output_mint: outputMint,
      amount: order.amount || "1000000",
      routing_mode: order.routing_mode || "meta_aggregator",
    };
  }
  const orderType = order.order_type || (order.live_order_mode === "tiny_fill" ? "market" : "limit");
  const sizeMode = order.size_mode || (order.quote_size ? "quote" : "base");
  return {
    ...order,
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: (order.market || "BTC").toUpperCase().split("-")[0],
    order_type: orderType,
    size_mode: sizeMode,
    quote_size: sizeMode === "quote" ? order.quote_size || "5" : order.quote_size,
    tif: order.live_order_mode === "tiny_fill" || orderType === "market"
      ? "Ioc"
      : order.tif === "Ioc" || order.tif === "Alo" ? order.tif : "Gtc",
    post_only: orderType === "limit" && (order.post_only === true || order.tif === "Alo"),
  };
}

function SegmentedControl({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map(([optionValue, text]) => {
          const selected = optionValue === value;
          return (
            <button
              key={optionValue}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(optionValue)}
              className={compactSelectorClass(selected, "min-h-10 flex-1 basis-[112px] px-3 py-2 text-sm")}
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DestinationField({
  value,
  inferredLabel,
  onChange,
  onPick,
}: {
  value: string;
  inferredLabel: string;
  onChange: (value: string) => void;
  onPick: (chip: (typeof DESTINATION_CHIPS)[number]) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[#8b95a8]">To</span>
        <span className="border border-[#1e2a3a] bg-[#08090d] px-2 py-1 text-[11px] font-medium text-[#a8d8ff]">
          {inferredLabel}
        </span>
      </div>
      <label className="flex h-12 items-center gap-3 border border-[#243347] bg-[#08090d] px-3 focus-within:border-[#a8d8ff]">
        <Search className="h-4 w-4 shrink-0 text-[#6f7d9a]" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search app, @user, or paste wallet"
          className="min-w-0 flex-1 bg-transparent text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a]"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {DESTINATION_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => onPick(chip)}
            className={compactSelectorClass(false, "h-8 px-3 text-xs")}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TextInput({
  label,
  value,
  placeholder,
  secret = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-10 min-w-0 border border-[#1e2a3a] bg-[#08090d] px-3 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
      />
    </label>
  );
}

function Select({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 min-w-0 border border-[#1e2a3a] bg-[#08090d] px-3 text-sm text-[#eef1f8]"
      >
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>{text}</option>
        ))}
      </select>
    </label>
  );
}

function AgentPlanSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 sm:grid-cols-[104px_minmax(0,1fr)] sm:items-center">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <span className="relative block min-w-0">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full appearance-none border border-[#1e2a3a] bg-[#05070b] px-3 pr-9 text-sm font-medium text-[#eef1f8] outline-none focus:border-[#a8d8ff]"
        >
          {options.map(([optionValue, text]) => (
            <option key={optionValue} value={optionValue}>{text}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-[#6f7d9a]" />
      </span>
    </label>
  );
}

function optionLabel(options: ReadonlyArray<readonly [string, string]>, value: string) {
  return options.find(([optionValue]) => optionValue === value)?.[1] || formatValue(value);
}

function normalizeAgentStrategyProfile(value: string): NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]> {
  if (value === "momentum_continuation") return "trend_following";
  if (value === "breakout_retest") return "breakout";
  if (value === "sweep_reclaim") return "reversal";
  if (value === "funding_mark_divergence") return "funding_basis";
  if (value === "venue_route_edge") return "custom";
  return value as NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
}

function formatSlippageBand({
  entryPrice,
  slippageBps,
  side,
}: {
  entryPrice: string;
  slippageBps: string;
  side: "buy" | "sell";
}) {
  const entry = Number(entryPrice);
  const bps = Number(slippageBps);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(bps)) return "set entry price";
  const cap = side === "sell" ? entry * (1 - bps / 10_000) : entry * (1 + bps / 10_000);
  return `${formatPrice(String(entry))} to ${formatPrice(String(cap))}`;
}

function formatAgentStrategyCondition({
  strategyProfile,
  entryTrigger,
  order,
}: {
  strategyProfile: NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
  entryTrigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  order: PrivateExecutionOrderDraft;
}) {
  const trigger = order.agent_trigger_level?.trim();
  const rangeLow = order.agent_range_low?.trim();
  const rangeHigh = order.agent_range_high?.trim();
  const edge = order.agent_edge_threshold_bps?.trim() || "25";
  if (strategyProfile === "range_trade") {
    return rangeLow && rangeHigh ? `${formatPrice(rangeLow)} to ${formatPrice(rangeHigh)}` : "set range low/high";
  }
  if (strategyProfile === "funding_basis") return `basis edge >= ${edge} bps`;
  if (strategyProfile === "breakout") return trigger ? `price breaks ${formatPrice(trigger)}` : "set breakout level";
  if (strategyProfile === "reversal") return trigger ? `price reclaims ${formatPrice(trigger)}` : "set reclaim level";
  if (strategyProfile === "mean_reversion") return trigger ? `price fades toward ${formatPrice(trigger)}` : "set mean level";
  if (strategyProfile === "custom") return order.agent_strategy_note?.trim() ? "custom rule set" : "write custom rule";
  if (entryTrigger === "break_level") return trigger ? `price breaks ${formatPrice(trigger)}` : "set break level";
  if (entryTrigger === "retest_level") return trigger ? `price retests ${formatPrice(trigger)}` : "set retest level";
  if (entryTrigger === "sweep_reclaim") return trigger ? `price reclaims ${formatPrice(trigger)}` : "set reclaim level";
  if (entryTrigger === "book_imbalance") return `book edge >= ${edge} bps`;
  if (entryTrigger === "funding_mark_divergence") return `funding edge >= ${edge} bps`;
  if (entryTrigger === "route_edge_threshold") return `route edge >= ${edge} bps`;
  return "trend filter passes";
}

function formatAgentEntryCondition({
  entryTrigger,
  order,
}: {
  entryTrigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  order: PrivateExecutionOrderDraft;
}) {
  const trigger = order.agent_trigger_level?.trim();
  const edge = order.agent_edge_threshold_bps?.trim() || "25";
  if (entryTrigger === "break_level") return trigger ? `price breaks ${formatPrice(trigger)}` : "set break level";
  if (entryTrigger === "retest_level") return trigger ? `price retests ${formatPrice(trigger)}` : "set retest level";
  if (entryTrigger === "sweep_reclaim") return trigger ? `price reclaims ${formatPrice(trigger)}` : "set reclaim level";
  if (entryTrigger === "book_imbalance") return `book edge >= ${edge} bps`;
  if (entryTrigger === "funding_mark_divergence") return `funding edge >= ${edge} bps`;
  if (entryTrigger === "route_edge_threshold") return `route edge >= ${edge} bps`;
  if (entryTrigger === "custom") return order.agent_strategy_note?.trim() ? "custom trigger set" : "write custom rule";
  return "use entry price now";
}

function formatAgentPlanSummary({
  strategyCondition,
  entryCondition,
  horizonLabel,
  exitLabel,
}: {
  strategyCondition: string;
  entryCondition: string;
  horizonLabel: string;
  exitLabel: string;
}) {
  return `Only trade if ${strategyCondition}; enter when ${entryCondition}; hold for ${lowerFirst(horizonLabel)}; exit on ${lowerFirst(exitLabel)}.`;
}

function lowerFirst(value: string) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#1e2a3a] bg-[#08090d] p-3">
      <p className="text-xs text-[#6f7d9a]">{label}</p>
      <p className="mt-1 text-sm font-medium text-[#eef1f8]">{formatValue(value)}</p>
    </div>
  );
}

function ReasonList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="text-xs text-[#6f7d9a]">{title}</p>
      <ul className="mt-2 space-y-1 text-sm text-[#aab5c8]">
        {items.length === 0 ? <li>{empty}</li> : items.map((item) => <li key={item}>{formatValue(item)}</li>)}
      </ul>
    </div>
  );
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <span className="shrink-0 text-sm text-[#8b95a8]">{label}</span>
      <span className={tone === "good" ? "min-w-0 text-right text-sm text-emerald-200" : "min-w-0 text-right text-sm text-amber-200"}>
        {formatValue(value)}
      </span>
    </div>
  );
}

function stepDotClass(status: VenueReadinessStep["status"]) {
  if (status === "done") return "border-emerald-300/40 bg-emerald-300/15 text-emerald-100";
  if (status === "current") return "border-[#a8d8ff]/60 bg-[#a8d8ff]/15 text-[#d8efff]";
  if (status === "warn") return "border-amber-300/40 bg-amber-300/15 text-amber-100";
  if (status === "blocked") return "border-red-300/40 bg-red-300/15 text-red-100";
  return "border-[#344155] bg-[#0f1117] text-[#6f7d9a]";
}

function stepStatusTextClass(status: VenueReadinessStep["status"]) {
  if (status === "done") return "text-xs text-emerald-200";
  if (status === "current") return "text-xs text-[#a8d8ff]";
  if (status === "warn") return "text-xs text-amber-200";
  if (status === "blocked") return "text-xs text-red-200";
  return "text-xs text-[#6f7d9a]";
}

function stepStatusLabel(status: VenueReadinessStep["status"]) {
  if (status === "done") return "done";
  if (status === "current") return "now";
  if (status === "warn") return "watch";
  if (status === "blocked") return "blocked";
  return "pending";
}

function actionBarClass(tone: TradingNextAction["tone"]) {
  if (tone === "success") return "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  if (tone === "warn") return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  if (tone === "danger") return "border-red-300/25 bg-red-300/10 text-red-100";
  if (tone === "neutral") return "border-[#1e2a3a] bg-[#0f1117] text-[#aab5c8]";
  return "border-[#3da8ff]/25 bg-[#3da8ff]/10 text-[#d8efff]";
}

function primaryActionClass(tone: TradingNextAction["tone"]) {
  if (tone === "success") return "bg-emerald-300 text-[#07100c]";
  if (tone === "warn") return "bg-amber-300 text-[#120d04]";
  if (tone === "danger") return "border border-red-300/30 bg-red-300/10 text-red-100";
  if (tone === "neutral") return "border border-[#344155] text-[#aab5c8]";
  return "bg-[#eef1f8] text-[#08090d]";
}

function setupNoticeClass(tone: SetupNoticeState["tone"]) {
  if (tone === "good") {
    return "mt-4 border border-emerald-300/20 bg-emerald-300/10 p-3 text-emerald-100";
  }
  if (tone === "bad") {
    return "mt-4 border border-red-300/20 bg-red-300/10 p-3 text-red-100";
  }
  if (tone === "warn") {
    return "mt-4 border border-amber-300/20 bg-amber-300/10 p-3 text-amber-100";
  }
  return "mt-4 border border-[#3da8ff]/25 bg-[#3da8ff]/10 p-3 text-[#a8d8ff]";
}

function statusLabel(status: string) {
  if (status === "private_mode_available") return "Private";
  if (status === "full_anonymity_available") return "Private";
  if (status === "wait_for_anonymity") return "Wait";
  if (status === "degraded_user_accepted_required") return "Degraded";
  if (status === "blocked_leaky_path") return "Blocked";
  return formatValue(status);
}

function statusClass(status: string) {
  if (status === "private_mode_available") return "text-sm font-medium text-emerald-200";
  if (status === "full_anonymity_available") return "text-sm font-medium text-emerald-200";
  if (status === "wait_for_anonymity") return "text-sm font-medium text-[#a8d8ff]";
  if (status === "degraded_user_accepted_required") return "text-sm font-medium text-amber-200";
  return "text-sm font-medium text-red-200";
}

function friendlyVisibility(value: string) {
  if (value === "none") return "does not see it";
  if (value === "hidden") return "hidden";
  if (value === "minimal") return "limited";
  if (value === "commitment_only") return "commitments only";
  if (value === "sealed_runtime") return "sealed";
  if (value === "order_visible") return "sees order";
  if (value === "account_visible") return "sees account";
  if (value === "ticket_only") return "quote ticket only";
  if (value === "selected_quote_only") return "selected quote only";
  if (value === "visible") return "visible";
  if (value === "bucketed") return "bucketed";
  if (value === "blocked") return "blocked";
  return value;
}

function privacyResultCopy(claimStatus: string) {
  if (isPrivateModeAvailableStatus(claimStatus)) {
    return {
      title: "Private. Your wallet stays hidden.",
      desc: "Approve when the visibility check looks right.",
    };
  }
  if (claimStatus === "wait_for_anonymity") {
    return {
      title: "Wait for more privacy.",
      desc: "Ghola needs a better batch or timing window before this can run privately.",
    };
  }
  if (claimStatus === "degraded_user_accepted_required") {
    return {
      title: "Fast exposes something.",
      desc: "Continue only if you accept the lower privacy path.",
    };
  }
  if (claimStatus === "blocked_leaky_path") {
    return {
      title: "Blocked to protect you.",
      desc: "Change the destination, amount, app, or timing and check again.",
    };
  }
  return {
    title: "Review before approving.",
    desc: "Use the visibility check below before this action runs.",
  };
}
