"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Activity, Copy, KeyRound, Layers, LockKeyhole, Play, ReceiptText, Search, ShieldCheck, Square, TimerReset, X } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { PrivateAccountFundingPanel } from "@/components/private-account/PrivateAccountFundingPanel";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import {
  approvePrivateAccountAction,
  allocateHyperliquidManagedTestnet,
  allocatePrivateAccountOmnibus,
  armHyperliquidExecutionAgent,
  armVenueExecutionAgent,
  cancelPrivateAccountQueue,
  commitPrivateAccountAuction,
  createPrivateAccountIntent,
  createPrivateAccountRuntimeEnvelope,
  executePrivateAccountAction,
  exportPrivateAccountPrivateReceipt,
  getPrivateAccountOmnibusStatus,
  getHyperliquidAccountSnapshot,
  getHyperliquidExecutionVaultStatus,
  getHyperliquidMarketSnapshot,
  getVenueExecutionVaultStatus,
  openHyperliquidAccountStream,
  getPrivateAccountPlatformReadiness,
  getPrivateAccountReceiptDetail,
  getPrivateExecutionAccountStatus,
  isPrivateModeAvailableStatus,
  listPrivateAccountAuctions,
  listPrivateAccountQueue,
  listPrivateAccountReceipts,
  previewPrivateAccountAction,
  queuePrivateAccountAction,
  refreshPrivateAccountQueue,
  recommendedRail,
  sealVenueExecutionVault,
  sealHyperliquidExecutionVault,
  settlePrivateAccountAuction,
  verifyPrivateAccountConnectorNoSubmit,
  type HyperliquidAccountSnapshot,
  type HyperliquidAccountStreamStatus,
  type HyperliquidMarketSnapshot,
  type PrivateAccountSafeInput,
} from "@/lib/private-account-client";
import {
  buildHyperliquidExecutionVaultBundle,
  parseHyperliquidCredentialImport,
  validateHyperliquidExecutionCredentialDraft,
  type HyperliquidExecutionCredentialDraft,
} from "@/lib/hyperliquid-vault-seal";
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
  buildPrivateExecutionInstructionBundle,
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "@/lib/private-execution-instruction-seal";
import {
  hyperliquidCandlePriceRange,
  hyperliquidCumulativeDepth,
  hyperliquidDepthMax,
  nearestHyperliquidCandleIndex,
  type HyperliquidChartMode,
} from "@/lib/hyperliquid-chart-helpers";
import {
  createHyperliquidLiveMarketStream,
  type HyperliquidLiveMarketStatus,
  type HyperliquidWebSocketConstructor,
} from "@/lib/hyperliquid-live-market";
import type { GholaPrivacyPreview } from "@/lib/private-account";
import type { PrivateAccountReadinessResponse } from "@/lib/private-account-readiness";

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

const DEFAULT_HYPERLIQUID_LIVE_INPUT: PrivateAccountSafeInput = {
  action_class: "trade_on_platform",
  platform_class: "hyperliquid_style_market",
  product_bucket: "perps",
  amount_bucket: "5",
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
  quote_size: "5",
  max_slippage_bps: "50",
  live_order_mode: "tiny_fill",
  tif: "Ioc",
};

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

const DEFAULT_PHOENIX_LIVE_ORDER: PrivateExecutionOrderDraft = {
  venue_id: "phoenix",
  operation_class: "perp_limit_order",
  market: "SOL",
  side: "buy",
  base_size: "",
  limit_price: "250",
  quote_size: "5",
  live_order_mode: "tiny_fill",
  tif: "Ioc",
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

interface IntentState {
  intent_id: string;
}

interface ExecutionState {
  receipt?: {
    receipt_commitment: string;
  };
}

interface AccountStatusState {
  account?: {
    vault_ready?: boolean;
  };
}

interface HyperliquidVaultState {
  account_commitment?: string;
  ready?: boolean;
  execution_mode?: "byo_api_key" | "managed_testnet";
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
    execution_mode?: "managed_testnet";
  } | null;
}

interface HyperliquidAgentState {
  status: "armed" | "stopped";
  agent_session_commitment?: string;
  vault_commitment?: string;
  allocation_commitment?: string;
  execution_mode?: "byo_api_key" | "managed_testnet";
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
    transaction_broadcast?: boolean;
  };
}

interface LiveReadinessCertificate {
  version: 1;
  certificate_kind: "ghola_live_readiness_certificate_v1";
  certificate_commitment: string;
  status: "ready_to_attempt_broadcast" | "not_ready" | "worker_unavailable";
  proof_level: "pre_broadcast_live_readiness";
  platform_class: string;
  venue_id: "phoenix";
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

export function PrivateAccountCockpit() {
  const auth = useThumperAuth();
  const turnkeyWallet = useTurnkeyWallet();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [hyperliquidConnectOpen, setHyperliquidConnectOpen] = useState(false);
  const [coinbaseConnectOpen, setCoinbaseConnectOpen] = useState(false);
  const [phoenixConnectOpen, setPhoenixConnectOpen] = useState(false);
  const [tradeFlow, setTradeFlow] = useState(false);
  const [liveHyperliquidFlow, setLiveHyperliquidFlow] = useState(false);
  const [livePhoenixFlow, setLivePhoenixFlow] = useState(false);
  const [input, setInput] = useState<PrivateAccountSafeInput>(DEFAULT_INPUT);
  const [orderDraft, setOrderDraft] = useState<PrivateExecutionOrderDraft>(DEFAULT_HYPERLIQUID_ORDER);
  const [destinationQuery, setDestinationQuery] = useState("@alice");
  const [readiness, setReadiness] = useState<PrivateAccountReadinessResponse | null>(null);
  const [intent, setIntent] = useState<IntentState | null>(null);
  const [preview, setPreview] = useState<GholaPrivacyPreview | null>(null);
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [accountStatus, setAccountStatus] = useState<AccountStatusState | null>(null);
  const [hyperliquidVault, setHyperliquidVault] = useState<HyperliquidVaultState | null>(null);
  const [hyperliquidAgent, setHyperliquidAgent] = useState<HyperliquidAgentState | null>(null);
  const [hyperliquidMarket, setHyperliquidMarket] = useState<HyperliquidMarketSnapshot | null>(null);
  const [hyperliquidMarketStatus, setHyperliquidMarketStatus] = useState<HyperliquidLiveMarketStatus>("connecting");
  const [hyperliquidAccount, setHyperliquidAccount] = useState<HyperliquidAccountSnapshot | null>(null);
  const [hyperliquidAccountStreamStatus, setHyperliquidAccountStreamStatus] = useState<HyperliquidAccountStreamStatus>("connecting");
  const [hyperliquidInterval, setHyperliquidInterval] = useState<"1m" | "5m" | "15m" | "1h">("5m");
  const [hyperliquidSetupNotice, setHyperliquidSetupNotice] = useState<SetupNoticeState | null>(null);
  const [coinbaseVault, setCoinbaseVault] = useState<VenueVaultState | null>(null);
  const [phoenixVault, setPhoenixVault] = useState<VenueVaultState | null>(null);
  const [omnibus, setOmnibus] = useState<OmnibusState | null>(null);
  const [coinbaseAgent, setCoinbaseAgent] = useState<VenueAgentState | null>(null);
  const [phoenixAgent, setPhoenixAgent] = useState<VenueAgentState | null>(null);
  const [phoenixVerification, setPhoenixVerification] = useState<NoFundsVerificationState | null>(null);
  const [queue, setQueue] = useState<QueueSummary[]>([]);
  const [auctions, setAuctions] = useState<AuctionState | null>(null);
  const [receiptDetail, setReceiptDetail] = useState<ReceiptDetailState | null>(null);
  const [receiptExport, setReceiptExport] = useState<ReceiptExportState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hyperliquidMarketCoin = marketCoinFromOrder(orderDraft.market);

  useEffect(() => {
    const flow = new URLSearchParams(window.location.search).get("flow");
    if (flow === "hyperliquid-live") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(true);
      setLivePhoenixFlow(false);
      setInput(DEFAULT_HYPERLIQUID_LIVE_INPUT);
      setOrderDraft(DEFAULT_HYPERLIQUID_LIVE_ORDER);
      setDestinationQuery("Hyperliquid");
      return;
    }
    if (flow === "trade" || flow === "phoenix-live") {
      setTradeFlow(true);
      setLiveHyperliquidFlow(false);
      setLivePhoenixFlow(true);
      setInput(DEFAULT_PHOENIX_LIVE_INPUT);
      setOrderDraft(DEFAULT_PHOENIX_LIVE_ORDER);
      setDestinationQuery("Phoenix");
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

  const refreshAccountState = useCallback(async () => {
    await Promise.all([
      getPrivateExecutionAccountStatus().then(setAccountStatus).catch(() => setAccountStatus(null)),
      refreshHyperliquidVault(),
      refreshHyperliquidAccountSnapshot(),
      refreshCoinbaseState(),
      refreshPhoenixState(),
      refreshReceipts(),
      refreshQueue(),
      refreshAuctions(),
    ]);
  }, [refreshAuctions, refreshCoinbaseState, refreshHyperliquidAccountSnapshot, refreshHyperliquidVault, refreshPhoenixState, refreshQueue, refreshReceipts]);

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
    if (!auth.authenticated || input.platform_class !== "hyperliquid_style_market") return;
    const network = liveHyperliquidFlow ? "mainnet" : "testnet";
    setHyperliquidMarket(null);
    setHyperliquidMarketStatus("connecting");
    const stream = createHyperliquidLiveMarketStream({
      network,
      coin: hyperliquidMarketCoin,
      interval: hyperliquidInterval,
      webSocketCtor: typeof window !== "undefined" && "WebSocket" in window
        ? window.WebSocket as unknown as HyperliquidWebSocketConstructor
        : null,
      isDocumentHidden: () => document.hidden,
      getFallbackSnapshot: () => getHyperliquidMarketSnapshot({
        network,
        coin: hyperliquidMarketCoin,
        interval: hyperliquidInterval,
      }),
      onSnapshot: setHyperliquidMarket,
      onStatus: setHyperliquidMarketStatus,
    });
    stream.start();
    return () => {
      stream.stop();
    };
  }, [auth.authenticated, hyperliquidInterval, hyperliquidMarketCoin, input.platform_class, liveHyperliquidFlow]);

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
          ? { ...current, stream_status: "worker_unavailable", trading_enabled: false }
          : null);
      },
    });
    return () => {
      stream.close();
    };
  }, [auth.authenticated, hyperliquidAgent?.status, hyperliquidMarketCoin, hyperliquidVault?.ready, input.platform_class]);

  useEffect(() => {
    if (!auth.authenticated) {
      setReceipts([]);
      setQueue([]);
      setAuctions(null);
      setAccountStatus(null);
      setHyperliquidVault(null);
      setHyperliquidAgent(null);
      setHyperliquidMarket(null);
      setHyperliquidMarketStatus("connecting");
      setHyperliquidAccount(null);
      setHyperliquidAccountStreamStatus("connecting");
      setHyperliquidSetupNotice(null);
      setCoinbaseVault(null);
      setPhoenixVault(null);
      setPhoenixVerification(null);
      setOmnibus(null);
      setCoinbaseAgent(null);
      setPhoenixAgent(null);
      setHyperliquidConnectOpen(false);
      setCoinbaseConnectOpen(false);
      setPhoenixConnectOpen(false);
      return;
    }
    void refreshAccountState();
  }, [auth.authenticated, refreshAccountState]);

  async function runPreview() {
    if (!auth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    setWorking(true);
    setError(null);
    setExecution(null);
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
          input.platform_class === "solana_perps_market");
      let encryptedInstruction: unknown;
      if (isPrivateExecution) {
        if (
          input.platform_class === "solana_perps_market" &&
          phoenixVerification?.status !== "verified_no_funds"
        ) {
          throw new Error("phoenix_connection_check_required");
        }
        if (!turnkeyWallet.walletAddress) {
          throw new Error("Turnkey wallet identity is unavailable.");
        }
        const normalizedOrder = normalizeOrderForPlatform(orderDraft, input.platform_class);
        const validationErrors = validatePrivateExecutionOrderDraft(normalizedOrder);
        if (validationErrors.length > 0) throw new Error(validationErrors[0]);
        const sealed = await buildPrivateExecutionInstructionBundle({
          ownerWalletAddress: turnkeyWallet.walletAddress,
          previewCommitment: preview.preview_commitment,
          order: normalizedOrder,
          signBytes: turnkeyWallet.signBytes,
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
      await refreshReceipts();
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Private execution failed."));
    } finally {
      setWorking(false);
    }
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
    setInput({
      ...input,
      ...DEFAULT_PHOENIX_LIVE_INPUT,
      amount_bucket: input.amount_bucket === "50" || input.amount_bucket === "100" ? "5" : input.amount_bucket,
    });
    setOrderDraft((current) =>
      current.venue_id === "phoenix" ? current : DEFAULT_PHOENIX_LIVE_ORDER
    );
    setDestinationQuery("Phoenix");
    setLivePhoenixFlow(true);
    setLiveHyperliquidFlow(false);
  }

  function selectHyperliquidMarket(market: "BTC" | "ETH" | "SOL" | "HYPE") {
    setPreview(null);
    setExecution(null);
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
  }

  async function ensureHyperliquidSigningWallet() {
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
    setWorking(true);
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
      setWorking(false);
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

  async function armHyperliquidAgent(killSwitch = false) {
    setWorking(true);
    setError(null);
    setHyperliquidSetupNotice({
      tone: "working",
      title: "Enabling Hyperliquid",
      detail: "Binding the selected account to Ghola's execution policy.",
    });
    try {
      const armed = await armHyperliquidExecutionAgent({
        execution_mode: hyperliquidVault?.managed_allocation?.status === "allocated"
          ? "managed_testnet"
          : "byo_api_key",
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: killSwitch,
      });
      setHyperliquidAgent(armed);
      await refreshHyperliquidAccountSnapshot();
      setHyperliquidSetupNotice({
        tone: "good",
        title: "Hyperliquid ready",
        detail: "Next step: preview the trade.",
      });
    } catch (err) {
      const message = friendlyPrivateAccountError(err, "Could not arm Hyperliquid.");
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Could not enable Hyperliquid",
        detail: message,
      });
    } finally {
      setWorking(false);
    }
  }

  async function allocateHyperliquidManaged() {
    if (!auth.authenticated) {
      setHyperliquidSetupNotice({
        tone: "warn",
        title: "Sign in required",
        detail: "Sign in first, then Ghola can prepare the test account.",
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
      title: "Preparing Ghola test account",
      detail: "Allocating the account and enabling it for the trade preview.",
    });
    try {
      const allocated = await allocateHyperliquidManagedTestnet({
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
      });
      setHyperliquidVault((current) => ({
        ...(current || {}),
        account_commitment: allocated.account_commitment,
        ready: allocated.ready,
        execution_mode: "managed_testnet",
        managed_allocation: allocated.managed_allocation,
      }));
      setHyperliquidAgent(null);
      setHyperliquidSetupNotice({
        tone: "working",
        title: "Account prepared",
        detail: "Enabling it with Ghola's execution policy.",
      });
      const armed = await armHyperliquidExecutionAgent({
        execution_mode: "managed_testnet",
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: input.amount_bucket,
        max_order_count: 10,
        kill_switch: false,
      });
      setHyperliquidAgent(armed);
      await refreshHyperliquidVault();
      await refreshHyperliquidAccountSnapshot();
      setHyperliquidSetupNotice({
        tone: "good",
        title: "Ghola test account ready",
        detail: "Next step: preview the trade.",
      });
    } catch (err) {
      const message = friendlyPrivateAccountError(err, "Could not start Hyperliquid.");
      setError(message);
      setHyperliquidSetupNotice({
        tone: "bad",
        title: "Could not start Hyperliquid",
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

  async function ensureGholaSigningWallet() {
    if (turnkeyWallet.walletAddress) {
      if (!phoenixVault?.account_commitment) {
        const state = await getVenueExecutionVaultStatus({ platform_class: "solana_perps_market" });
        setPhoenixVault(state);
      }
      return true;
    }
    if (turnkeyWallet.loading) {
      setError("Ghola is still preparing your account. Try again in a moment.");
      return false;
    }
    setWorking(true);
    setError(null);
    try {
      await turnkeyWallet.createWallet(auth.user?.email || "ghola-user");
      const state = await getVenueExecutionVaultStatus({ platform_class: "solana_perps_market" });
      setPhoenixVault(state);
      return true;
    } catch (err) {
      setError(friendlyPrivateAccountError(err, "Could not prepare your Ghola signing wallet."));
      return false;
    } finally {
      setWorking(false);
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
        execution_mode: "user_stealth",
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

  async function verifyPhoenixNoSubmit() {
    setWorking(true);
    setError(null);
    setPhoenixVerification(null);
    try {
      if (!turnkeyWallet.walletAddress) {
        throw new Error("Turnkey wallet identity is unavailable.");
      }
      if (phoenixVault?.venue_execution_vault?.status !== "sealed") {
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

  const claim = preview?.claim_status;
  const canApprovePrivate = isPrivateModeAvailableStatus(claim);
  const canApproveDegraded = claim === "degraded_user_accepted_required";
  const waiting = claim === "wait_for_anonymity";
  const blocked = claim === "blocked_leaky_path";
  const activeQueueId = queue.find((item) => item.status === "queued" || item.status === "ready")?.queue_id;
  const wideHyperliquidPanel = tradeFlow && input.platform_class === "hyperliquid_style_market";
  const authRedirect = liveHyperliquidFlow
    ? "/app/account?flow=hyperliquid-live"
    : tradeFlow || livePhoenixFlow
      ? "/app/account?flow=trade"
      : "/app/account";

  const applyQuickAction = (preset: (typeof QUICK_ACTIONS)[number]) => {
    setPreview(null);
    setExecution(null);
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
    }
    if (preset.platformClass === "coinbase_style_provider") {
      setOrderDraft(DEFAULT_COINBASE_ORDER);
    }
  };

  const updateDestination = (platformClass: string, nextQuery = destinationQuery) => {
    setPreview(null);
    setExecution(null);
    if (platformClass === "hyperliquid_style_market") {
      setOrderDraft((current) =>
        current.venue_id === "hyperliquid"
          ? current
          : liveHyperliquidFlow ? DEFAULT_HYPERLIQUID_LIVE_ORDER : DEFAULT_HYPERLIQUID_ORDER
      );
    }
    if (platformClass === "solana_perps_market") {
      setOrderDraft((current) =>
        current.venue_id === "phoenix" ? current : DEFAULT_PHOENIX_LIVE_ORDER
      );
      setLivePhoenixFlow(true);
      setLiveHyperliquidFlow(false);
    }
    if (platformClass === "coinbase_style_provider") {
      setOrderDraft((current) =>
        current.venue_id === "coinbase_advanced" ? current : DEFAULT_COINBASE_ORDER
      );
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
    });
    setDestinationQuery(nextQuery);
  };

  if (!auth.authenticated) {
    return (
      <div className="mx-auto max-w-7xl">
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
          redirectTo={authRedirect}
        />
        <SignedOutAccountGate
          loading={auth.loading}
          liveHyperliquidFlow={liveHyperliquidFlow}
          livePhoenixFlow={livePhoenixFlow || tradeFlow}
          onSignIn={() => {
            setAuthMode("signup");
            setAuthOpen(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo={authRedirect}
      />
      <HyperliquidConnectModal
        open={hyperliquidConnectOpen}
        liveHyperliquidFlow={liveHyperliquidFlow}
        accountCommitment={hyperliquidVault?.account_commitment || null}
        walletAddress={turnkeyWallet.walletAddress}
        signBytes={turnkeyWallet.signBytes}
        onClose={() => setHyperliquidConnectOpen(false)}
        onConnected={(sealed) => {
          setHyperliquidVault(sealed);
          setHyperliquidAgent(null);
          void refreshHyperliquidAccountSnapshot();
        }}
      />
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

      <div
        className={
          wideHyperliquidPanel
            ? "grid gap-4 xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]"
            : "grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)]"
        }
      >
        <section className="border border-[#1e2a3a] bg-[#0f1117] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4 text-[#a8d8ff]" />
              <div>
                <h2 className="text-lg font-medium">{tradeFlow ? "Trade setup" : "What do you want to do?"}</h2>
                <p className="mt-1 text-sm text-[#8b95a8]">
                  {tradeFlow
                    ? "Choose a venue, connect your account, then preview the trade."
                    : "Pick a common action or type where you want to go."}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {tradeFlow && (
              <VenuePicker
                selectedPlatform={input.platform_class}
                onSelect={(platformClass) => {
                  if (platformClass === "solana_perps_market") {
                    void selectPhoenixPreview();
                    return;
                  }
                  if (platformClass === "hyperliquid_style_market") {
                    setLiveHyperliquidFlow(true);
                    setLivePhoenixFlow(false);
                    setInput(DEFAULT_HYPERLIQUID_LIVE_INPUT);
                    setOrderDraft(DEFAULT_HYPERLIQUID_LIVE_ORDER);
                    setDestinationQuery("Hyperliquid");
                    setPreview(null);
                    setExecution(null);
                    return;
                  }
                  if (platformClass === "coinbase_style_provider") {
                    setLiveHyperliquidFlow(false);
                    setLivePhoenixFlow(false);
                    void selectCoinbasePreview();
                  }
                }}
              />
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
                        className={
                          selected
                            ? "min-h-20 border border-[#a8d8ff] bg-[#a8d8ff]/12 p-3 text-left"
                            : "min-h-20 border border-[#1e2a3a] bg-[#08090d] p-3 text-left hover:border-[#3da8ff]/50"
                        }
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
                      input.platform_class === "solana_perps_market"
                      ? [["5", "$5"], ["10", "$10"], ["25", "$25"]]
                      : [["5", "$5"], ["10", "$10"], ["25", "$25"], ["50", "$50"], ["100", "$100"]]
                    }
                    onChange={(value) => {
                    setPreview(null);
                    setExecution(null);
                    setInput({ ...input, amount_bucket: value as never });
                    if (orderDraft.live_order_mode === "tiny_fill") {
                      setOrderDraft({ ...orderDraft, quote_size: value });
                    }
                  }} />
                  <Select label="Asset" value={input.asset_bucket} options={[["stablecoin", "USDC"], ["SOL", "SOL"], ["ETH", "ETH"], ["BTC", "BTC"], ["major", "Major"], ["long_tail", "Long tail"]]} onChange={(value) => {
                    setPreview(null);
                    setExecution(null);
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
                  setOrderDraft(nextOrder);
                }}
              />
              )
            ) : (
              <PrivateOrderTicket
                platformClass={input.platform_class}
                order={orderDraft}
                previewCommitment={preview?.preview_commitment || null}
                onChange={(nextOrder) => {
                  setPreview(null);
                  setExecution(null);
                  if (input.platform_class === "solana_perps_market") setPhoenixVerification(null);
                  setOrderDraft(nextOrder);
                }}
              />
            )}
            {input.platform_class === "hyperliquid_style_market" && (
              <HyperliquidSetupCard
                state={hyperliquidVault}
                agent={hyperliquidAgent}
                accountSnapshot={hyperliquidAccount}
                working={working}
                setupNotice={hyperliquidSetupNotice}
                evidenceStatus={preview?.platform_class === "hyperliquid_style_market" ? preview.evidence_status : null}
                liveHyperliquidFlow={liveHyperliquidFlow}
                onUseManaged={allocateHyperliquidManaged}
                onConnectApi={openHyperliquidConnection}
                onArm={() => armHyperliquidAgent(false)}
              />
            )}
            {input.platform_class === "solana_perps_market" && (
              <PhoenixSetupCard
                state={phoenixVault}
                agent={phoenixAgent}
                verification={phoenixVerification}
                working={working}
                onConnect={openPhoenixConnection}
                onArm={() => armPhoenixAgent(false)}
                onVerify={verifyPhoenixNoSubmit}
              />
            )}
          </div>

          <div className="mt-4 grid gap-2 border-t border-[#1e2a3a] pt-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {accountStatus?.account && (
              <>
                <StatusLine
                  label="Balance"
                  value={accountStatus.account.vault_ready ? "ready" : "not ready"}
                  tone={accountStatus.account.vault_ready ? "good" : "warn"}
                />
              </>
            )}
            <StatusLine label="Wallet" value="hidden first" tone="good" />
          </div>

          {!wideHyperliquidPanel && (
            <button
              onClick={runPreview}
              disabled={working}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {working ? "Checking" : preview ? "Check again" : tradeFlow ? "Preview trade" : "Check privacy"}
            </button>
          )}
        </section>

        <section className="space-y-4">
          {wideHyperliquidPanel && (
            <HyperliquidTradingPanel
              layout="full"
              market={hyperliquidMarketCoin}
              interval={hyperliquidInterval}
              snapshot={hyperliquidMarket}
              marketStatus={hyperliquidMarketStatus}
              accountSnapshot={hyperliquidAccount}
              accountStreamStatus={hyperliquidAccountStreamStatus}
              order={orderDraft}
              previewCommitment={preview?.preview_commitment || null}
              working={working}
              onMarketChange={selectHyperliquidMarket}
              onIntervalChange={setHyperliquidInterval}
              onOrderChange={(nextOrder) => {
                setPreview(null);
                setExecution(null);
                setOrderDraft(nextOrder);
              }}
              onPreview={runPreview}
            />
          )}
          <div className="border border-[#1e2a3a] bg-[#0f1117] p-4 sm:p-5">
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
                  {canApprovePrivate && (
                    <button onClick={() => approveAndMaybeExecute(false)} disabled={working} className="h-11 bg-emerald-300 px-4 text-sm font-medium text-[#07100c]">
                      {input.action_class === "trade_on_platform" ? "Place trade" : "Approve and run"}
                    </button>
                  )}
                  {canApproveDegraded && (
                    <button onClick={() => approveAndMaybeExecute(true)} disabled={working} className="h-11 bg-amber-300 px-4 text-sm font-medium text-[#120d04]">
                      {input.platform_class === "solana_perps_market"
                        ? "Accept visibility and place trade"
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
          </div>

          <details className="border border-[#1e2a3a] bg-[#0f1117] p-4 sm:p-5">
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
              onClick={() => setCoinbaseConnectOpen(true)}
              disabled={working || !coinbaseVault?.account_commitment || !turnkeyWallet.walletAddress}
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
          </details>
      </section>
      </div>
    </div>
  );
}

function HyperliquidSetupCard({
  state,
  agent,
  accountSnapshot,
  working,
  setupNotice,
  evidenceStatus,
  liveHyperliquidFlow,
  onUseManaged,
  onConnectApi,
  onArm,
}: {
  state: HyperliquidVaultState | null;
  agent: HyperliquidAgentState | null;
  accountSnapshot: HyperliquidAccountSnapshot | null;
  working: boolean;
  setupNotice: SetupNoticeState | null;
  evidenceStatus: string | null;
  liveHyperliquidFlow: boolean;
  onUseManaged: () => void;
  onConnectApi: () => void;
  onArm: () => void;
}) {
  const managed = state?.managed_allocation?.status === "allocated";
  const byo = state?.hyperliquid_execution_vault?.status === "sealed";
  const connected = managed || byo;
  const armed = agent?.status === "armed";
  const accountLabel = managed ? "Ghola test account" : byo ? "API wallet" : "not connected";
  const fundingReady = evidenceStatus === "evidence_ready";
  const submitReady = liveHyperliquidFlow ? connected && armed : connected && armed && fundingReady;
  const accountStatus = accountSnapshot?.status || (connected ? "venue access connected" : "venue access required");
  const liveStatus = hyperliquidLiveStatus({
    liveHyperliquidFlow,
    connected,
    armed,
    fundingReady,
  });
  return (
    <div className="border border-[#243248] bg-[#08090d] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
            <h3 className="text-base font-medium text-[#eef1f8]">
              {liveHyperliquidFlow ? "Connect Hyperliquid API wallet" : "Choose Hyperliquid access"}
            </h3>
            <span className="border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-100">
              {liveHyperliquidFlow ? "live tiny-fill" : "testnet"}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9aa6bb]">
            {liveHyperliquidFlow
              ? "Ghola routes through credentials Hyperliquid accepts. Hyperliquid still sees the execution account and order."
              : "Your main wallet is not the Hyperliquid account. Ghola checks the order before anything is sent."}
          </p>
        </div>
        <div className="flex items-center justify-start lg:justify-end">
          <span className={
            submitReady
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
        <StatusLine
          label="Main wallet"
          value="not exposed"
          tone="good"
        />
        <StatusLine
          label="Hyperliquid sees"
          value="the order"
          tone="warn"
        />
        <StatusLine
          label="Connection"
          value={accountLabel}
          tone={connected ? "good" : "warn"}
        />
        <StatusLine
          label="Readiness"
          value={accountStatus}
          tone={accountSnapshot?.status === "ready_to_trade" || connected ? "good" : "warn"}
        />
      </div>
      {connected && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StatusLine
            label={liveHyperliquidFlow ? "Order cap" : "Private funding"}
            value={liveHyperliquidFlow ? "$5 default / $25 max" : fundingReady ? "ready" : "needed before submit"}
            tone={liveHyperliquidFlow || fundingReady ? "good" : "warn"}
          />
          <StatusLine
            label="Public chain"
            value={liveHyperliquidFlow ? "main wallet unused" : fundingReady ? "source hidden" : "not used yet"}
            tone={liveHyperliquidFlow || fundingReady ? "good" : "warn"}
          />
        </div>
      )}
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {!connected ? (
          <>
            {!liveHyperliquidFlow && (
              <button
                type="button"
                onClick={onUseManaged}
                disabled={working}
                className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {working ? "Preparing" : "Use Ghola test account"}
              </button>
            )}
            <button
              type="button"
              onClick={onConnectApi}
              disabled={working}
              className={
                liveHyperliquidFlow
                  ? "inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50 sm:col-span-2"
                  : "inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
              }
            >
              <KeyRound className="h-4 w-4" />
              {working ? "Preparing" : liveHyperliquidFlow ? "Connect API wallet" : "Import API wallet"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onArm}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {armed ? "Ready to check privacy" : liveHyperliquidFlow ? "Use with Ghola" : "Enable Hyperliquid"}
            </button>
            {!liveHyperliquidFlow && (
              <button
                type="button"
                onClick={onUseManaged}
                disabled={working || managed}
                className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {managed ? "Using Ghola test account" : "Switch to Ghola test account"}
              </button>
            )}
          </>
        )}
      </div>
      {setupNotice && (
        <div className={setupNoticeClass(setupNotice.tone)}>
          <div className="text-sm font-medium">{setupNotice.title}</div>
          {setupNotice.detail && (
            <p className="mt-1 text-xs leading-5 opacity-85">{setupNotice.detail}</p>
          )}
        </div>
      )}
      {!connected && (
        <p className="mt-3 text-xs leading-5 text-[#8b95a8]">
          {liveHyperliquidFlow
            ? "Ghola does not create venue access. If Hyperliquid rejects the credentials or order, Ghola reports venue rejected."
            : "Recommended: use a Ghola test account. Import an API wallet only if you already have a scoped Hyperliquid API key."}
        </p>
      )}
      {connected && !fundingReady && !liveHyperliquidFlow && (
        <p className="mt-3 text-xs leading-5 text-[#8b95a8]">
          You can connect and preview now. A real submit waits until Ghola has
          private funding evidence.
        </p>
      )}
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
  return (
    <div className="border border-[#243248] bg-[#08090d] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[#eef1f8]">Choose venue</span>
        <span className="text-xs text-[#8b95a8]">first trade</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
        {TRADE_VENUES.map((venue) => {
          const selected = selectedPlatform === venue.platformClass;
          return (
            <button
              key={venue.platformClass}
              type="button"
              onClick={() => onSelect(venue.platformClass)}
              className={
                selected
                  ? "min-h-16 border border-[#a8d8ff] bg-[#a8d8ff]/12 p-3 text-left"
                  : "min-h-16 border border-[#1e2a3a] bg-[#0f1117] p-3 text-left hover:border-[#3da8ff]/50"
              }
            >
              <span className="block text-sm font-medium text-[#eef1f8]">{venue.title}</span>
              <span className="mt-1 block text-xs leading-5 text-[#8b95a8]">{venue.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PhoenixSetupCard({
  state,
  agent,
  verification,
  working,
  onConnect,
  onArm,
  onVerify,
}: {
  state: VenueVaultState | null;
  agent: VenueAgentState | null;
  verification: NoFundsVerificationState | null;
  working: boolean;
  onConnect: () => void;
  onArm: () => void;
  onVerify: () => void;
}) {
  const connected = state?.venue_execution_vault?.status === "sealed";
  const armed = agent?.status === "armed";
  const verified = verification?.status === "verified_no_funds";
  const submitReady = connected && armed && verified;
  const liveStatus = phoenixLiveStatus({ connected, armed, verification });
  return (
    <div className="border border-[#243248] bg-[#08090d] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#a8d8ff]" />
            <h3 className="text-base font-medium text-[#eef1f8]">Connect Phoenix</h3>
            <span className="border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-100">
              live tiny-fill
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9aa6bb]">
            Use a dedicated Phoenix trader authority. Ghola seals it for the private worker; your main wallet is not used as the trading wallet.
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
        <StatusLine label="Order mode" value="$5 IOC default" tone="good" />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {!connected ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={working}
            className="inline-flex h-11 items-center justify-center gap-2 bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:opacity-50 sm:col-span-2"
          >
            <KeyRound className="h-4 w-4" />
            {working ? "Preparing" : "Connect trading account"}
          </button>
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
              {armed ? "Ready to preview" : "Use with Ghola"}
            </button>
            <button
              type="button"
              onClick={onConnect}
              disabled={working}
              className="inline-flex h-11 items-center justify-center gap-2 border border-[#344155] px-4 text-sm font-medium text-[#aab5c8] disabled:opacity-50 sm:col-span-2"
            >
              <KeyRound className="h-4 w-4" />
              Replace authority
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

function LiveReadinessCertificateCard({
  verification,
}: {
  verification: NoFundsVerificationState;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const certificate = verification.live_readiness_certificate;
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
  const rows = checks
    ? [
        ["Worker", checks.private_agent_worker_reachable],
        ["Sealed vault", checks.sealed_vault_opened],
        ["Policy gate", checks.policy_enforced && checks.live_gate_enforced],
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
            Ghola checked the sealed worker, live gates, RPC, Phoenix SDK, and order packet. No transaction was sent.
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
            Fill proof <span className="text-amber-100">requires funded broadcast</span>
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

function HyperliquidConnectModal({
  open,
  liveHyperliquidFlow,
  accountCommitment,
  walletAddress,
  signBytes,
  onClose,
  onConnected,
}: {
  open: boolean;
  liveHyperliquidFlow: boolean;
  accountCommitment: string | null;
  walletAddress: string | null;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  onClose: () => void;
  onConnected: (sealed: HyperliquidVaultState) => void;
}) {
  const [draft, setDraft] = useState<HyperliquidExecutionCredentialDraft>({
    network: liveHyperliquidFlow ? "mainnet" : "testnet",
    hyperliquid_account_address: "",
    api_wallet_private_key: "",
    agent_name: "",
  });
  const [confirmedAgentKey, setConfirmedAgentKey] = useState(false);
  const [quickImport, setQuickImport] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearCredentialDraft = useCallback(() => {
    setDraft({
      network: liveHyperliquidFlow ? "mainnet" : "testnet",
      hyperliquid_account_address: "",
      api_wallet_private_key: "",
      agent_name: "",
    });
    setQuickImport("");
    setConfirmedAgentKey(false);
  }, [liveHyperliquidFlow]);

  useEffect(() => {
    if (!open) return;
    setDraft((current) => ({
      ...current,
      network: liveHyperliquidFlow ? "mainnet" : "testnet",
    }));
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
  }, [clearCredentialDraft, open, onClose, liveHyperliquidFlow]);

  if (!open) return null;

  const validationErrors = validateHyperliquidExecutionCredentialDraft(draft);
  const hasAccount = Boolean(draft.hyperliquid_account_address.trim());
  const hasKey = Boolean(draft.api_wallet_private_key.trim());
  const canSubmit = Boolean(
    accountCommitment &&
      walletAddress &&
      confirmedAgentKey &&
      validationErrors.length === 0 &&
      !submitting,
  );

  function updateQuickImport(value: string) {
    setQuickImport(value);
    if (!value.trim()) return;
    const imported = parseHyperliquidCredentialImport(value, draft);
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
    if (!confirmedAgentKey) {
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
      const stored = await sealHyperliquidExecutionVault({
        encrypted_execution_vault: sealed.encrypted_execution_vault,
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Close Hyperliquid connection dialog"
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
          <h2 className="text-lg font-medium text-[#eef1f8]">Connect API wallet</h2>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs text-[#8b95a8]">Paste</span>
            <textarea
              value={quickImport}
              onChange={(event) => updateQuickImport(event.target.value)}
              placeholder="Paste Hyperliquid API wallet JSON, key, or KEY=VALUE lines"
              autoComplete="off"
              spellCheck={false}
              className="min-h-28 resize-none border border-[#1e2a3a] bg-[#08090d] px-3 py-2 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <StatusLine label="Account" value={hasAccount ? "found" : "needed"} tone={hasAccount ? "good" : "warn"} />
            <StatusLine label="API key" value={hasKey ? "found" : "needed"} tone={hasKey ? "good" : "warn"} />
            <StatusLine label="Network" value={draft.network} tone="good" />
          </div>
          <details className="border border-[#1e2a3a] bg-[#08090d] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#a8d8ff]">Advanced</summary>
            <div className="mt-4 grid gap-4">
              <Select
                label="Network"
                value={draft.network}
                options={liveHyperliquidFlow ? [["mainnet", "Mainnet"]] : [["testnet", "Testnet"]]}
                onChange={(value) =>
                  setDraft({ ...draft, network: liveHyperliquidFlow ? "mainnet" : value === "mainnet" ? "mainnet" : "testnet" })
                }
              />
              <TextInput
                label="Account"
                value={draft.hyperliquid_account_address}
                placeholder="0x..."
                onChange={(value) => setDraft({ ...draft, hyperliquid_account_address: value })}
              />
              <TextInput
                label="API wallet key"
                value={draft.api_wallet_private_key}
                placeholder="0x..."
                secret
                onChange={(value) => setDraft({ ...draft, api_wallet_private_key: value })}
              />
              <TextInput
                label="Agent name"
                value={draft.agent_name || ""}
                placeholder="optional"
                onChange={(value) => setDraft({ ...draft, agent_name: value })}
              />
            </div>
          </details>
          <label className="flex items-start gap-3 border border-[#1e2a3a] bg-[#08090d] p-3 text-sm text-[#aab5c8]">
            <input
              type="checkbox"
              checked={confirmedAgentKey}
              onChange={(event) => setConfirmedAgentKey(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[#a8d8ff]"
            />
            <span>This is a Hyperliquid API wallet key, not my main wallet seed. Ghola does not create venue access.</span>
          </label>
        </div>

        <div className="mt-5 grid gap-2 border-t border-[#1e2a3a] pt-4 text-xs text-[#8b95a8] sm:grid-cols-2">
          <span>Ghola stores commitments and ciphertext only</span>
          <span>{liveHyperliquidFlow ? "Venue accepts or rejects the order" : "TEE recipient verifies and decrypts during execution"}</span>
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
  const liveTinyFill =
    (platformClass === "hyperliquid_style_market" || platformClass === "solana_perps_market") &&
    normalized.live_order_mode === "tiny_fill";
  const phoenixTinyFill = platformClass === "solana_perps_market" && liveTinyFill;
  const errors = validatePrivateExecutionOrderDraft(normalized);
  const status = previewCommitment ? (errors.length > 0 ? "needs fields" : "ready") : "preview first";

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onChange(normalizeOrderForPlatform({ ...normalized, ...patch }, platformClass));
  }

  return (
    <div className="border border-[#1e2a3a] bg-[#08090d] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[#8b95a8]">Order ticket</span>
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
        <SegmentedControl
          label="Side"
          value={normalized.side}
          options={[["buy", "Buy"], ["sell", "Sell"]]}
          onChange={(value) => update({ side: value === "sell" ? "sell" : "buy" })}
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
              label={phoenixTinyFill ? "Price limit" : "Max slippage bps"}
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
  onMarketChange,
  onIntervalChange,
  onOrderChange,
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
  onMarketChange: (market: "BTC" | "ETH" | "SOL" | "HYPE") => void;
  onIntervalChange: (interval: "1m" | "5m" | "15m" | "1h") => void;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
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
  const [chartMode, setChartMode] = useState<HyperliquidChartMode>("candles");
  const hasConnectedAccount = Boolean(
    accountSnapshot && accountSnapshot.account_source !== "none" && status !== "venue_access_required",
  );
  const canPreviewTrade = status === "ready_to_trade" && accountLive;

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange(normalizeOrderForPlatform({ ...normalized, ...patch }, "hyperliquid_style_market"));
  }

  return (
    <div className={fullLayout ? "border border-[#1e2a3a] bg-[#08090d] p-4 sm:p-5" : "border border-[#1e2a3a] bg-[#08090d] p-3"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#a8d8ff]" />
          <div>
            <h3 className={fullLayout ? "text-lg font-medium text-[#eef1f8]" : "text-sm font-medium text-[#eef1f8]"}>
              Hyperliquid
            </h3>
            <p className="mt-1 text-xs text-[#8b95a8]">
              {fullLayout ? "Live market view. Preview before anything is sent." : "Chart, orderbook, preview, trade."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {fullLayout && <span className="text-xs text-[#8b95a8]">no key needed</span>}
          <span className={marketConnection.tone === "good" ? "text-xs text-emerald-200" : marketConnection.tone === "bad" ? "text-xs text-red-200" : "text-xs text-amber-200"}>
            {marketConnection.label}
          </span>
        </div>
      </div>

      {fullLayout ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <TerminalChips
            label="Market"
            value={market}
            options={HYPERLIQUID_MARKETS}
            onChange={(value) => onMarketChange(marketCoinFromOrder(value))}
          />
          <TerminalChips
            label="Interval"
            value={interval}
            options={HYPERLIQUID_INTERVALS}
            align="right"
            onChange={(value) => onIntervalChange(value === "1m" || value === "15m" || value === "1h" ? value : "5m")}
          />
        </div>
      ) : (
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
      )}

      <div
        className={
          fullLayout
            ? "mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]"
            : "mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]"
        }
      >
        <div className="border border-[#162337] bg-[#05070b] p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-[#6f7d9a]">{fullLayout ? `${market}-PERP` : `${market} mid`}</p>
              <p className={fullLayout ? "text-4xl font-medium text-[#eef1f8]" : "text-2xl font-medium text-[#eef1f8]"}>
                {mid}
              </p>
            </div>
            <div className="text-right text-xs text-[#8b95a8]">
              <div>Bid {snapshot?.best_bid ? formatBookPrice(snapshot.best_bid) : "-"}</div>
              <div>Ask {snapshot?.best_ask ? formatBookPrice(snapshot.best_ask) : "-"}</div>
              <div>Spread {snapshot?.spread_bps == null ? "-" : `${snapshot.spread_bps} bps`}</div>
              {fullLayout && <div>Mark {snapshot?.mark_price ? formatPrice(snapshot.mark_price) : "-"}</div>}
              {fullLayout && <div>Oracle {snapshot?.oracle_price ? formatPrice(snapshot.oracle_price) : "-"}</div>}
            </div>
          </div>
          <div className={fullLayout ? "mb-3 grid gap-2 sm:grid-cols-3 2xl:grid-cols-6" : "mb-3 grid gap-2 sm:grid-cols-3"}>
            <MarketStat label={fullLayout ? "24h" : "Move"} value={fullLayout ? stats.dayChangeLabel : stats.changeLabel} tone={fullLayout ? stats.dayChangeTone : stats.changeTone} />
            <MarketStat label="High" value={stats.highLabel} />
            <MarketStat label="Low" value={stats.lowLabel} />
            {fullLayout && <MarketStat label="Volume" value={stats.volumeLabel} />}
            {fullLayout && <MarketStat label="Open interest" value={stats.openInterestLabel} />}
            {fullLayout && <MarketStat label="Funding" value={stats.fundingLabel} tone={stats.fundingTone} />}
          </div>
          <HyperliquidAdvancedChart
            mode={fullLayout ? chartMode : "line"}
            onModeChange={setChartMode}
            snapshot={snapshot}
            size={fullLayout ? "large" : "compact"}
          />
        </div>

        <div className="grid gap-3">
          {fullLayout && (
            <HyperliquidOrderTicket
              order={normalized}
              errors={errors}
              previewCommitment={previewCommitment}
              working={working}
              accountReady={canPreviewTrade}
              disabledReason={hyperliquidAccountStreamLabel(accountConnection)}
              onUpdate={update}
              onPreview={onPreview}
            />
          )}
          <div className="border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
              <span>Orderbook</span>
              <span>{market}</span>
            </div>
            <OrderbookRows side="ask" levels={snapshot?.asks || []} />
            <div className="my-2 border-t border-[#162337]" />
            <OrderbookRows side="bid" levels={snapshot?.bids || []} />
          </div>
          {fullLayout && <RecentTradeRows trades={snapshot?.recent_trades || []} />}
          <div className="border border-[#162337] bg-[#05070b] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs text-[#6f7d9a]">Next step</span>
              <span className={status === "ready_to_trade" ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {hyperliquidAccountStatusLabel(status)}
              </span>
            </div>
            <StatusLine
              label="Account"
              value={hasConnectedAccount ? hyperliquidAccountStatusLabel(status) : "not connected"}
              tone={status === "ready_to_trade" ? "good" : "warn"}
            />
            <StatusLine
              label="Equity"
              value={hasConnectedAccount ? accountSnapshot?.equity_bucket || "unknown" : "-"}
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
              label="Account stream"
              value={hyperliquidAccountStreamLabel(accountConnection)}
              tone={accountLive ? "good" : "warn"}
            />
            <div className="mt-3 grid gap-2 border-t border-[#162337] pt-3">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <StatusLine label="Main wallet" value="hidden" tone="good" />
                <StatusLine label="Ghola" value="sealed runtime" tone="good" />
                <StatusLine label="Hyperliquid sees" value="execution account + order" tone="warn" />
                <StatusLine label="Public chain" value="no direct trade settlement" tone="good" />
              </div>
              {fullLayout && <HyperliquidAccountRows accountSnapshot={accountSnapshot} />}
            </div>
            <p className="mt-3 border-t border-[#162337] pt-3 text-xs leading-5 text-[#8b95a8]">
              {status === "ready_to_trade"
                ? accountLive
                  ? "Run the privacy check, then place the capped IOC order."
                  : "Wait for the sealed account stream before previewing."
                : "Market data is public. Connect an API wallet to show your account and trade."}
            </p>
          </div>
        </div>
      </div>

      {!fullLayout && <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SegmentedControl
          label="Side"
          value={normalized.side}
          options={[["buy", "Buy"], ["sell", "Sell"]]}
          onChange={(value) => update({ side: value === "sell" ? "sell" : "buy" })}
        />
        <Select
          label="Amount"
          value={normalized.quote_size || "5"}
          options={[["5", "$5"], ["10", "$10"], ["25", "$25"]]}
          onChange={(value) => update({ quote_size: value })}
        />
        <Select
          label="Max slippage"
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
              className={
                selected
                  ? "h-8 min-w-14 border border-[#a8d8ff] bg-[#a8d8ff] px-3 text-sm font-medium text-[#08090d]"
                  : "h-8 min-w-14 border border-[#1e2a3a] bg-[#05070b] px-3 text-sm text-[#aab5c8] hover:border-[#3da8ff]/50"
              }
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

function HyperliquidOrderTicket({
  order,
  errors,
  previewCommitment,
  working,
  accountReady,
  disabledReason,
  onUpdate,
  onPreview,
}: {
  order: PrivateExecutionOrderDraft;
  errors: string[];
  previewCommitment: string | null;
  working: boolean;
  accountReady: boolean;
  disabledReason: string;
  onUpdate: (patch: Partial<PrivateExecutionOrderDraft>) => void;
  onPreview?: () => void;
}) {
  const side = order.side === "sell" ? "sell" : "buy";
  return (
    <div className="border border-[#162337] bg-[#05070b] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#eef1f8]">Order</p>
          <p className="mt-1 text-xs text-[#6f7d9a]">IOC tiny-fill</p>
        </div>
        <span className={previewCommitment && errors.length === 0 ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
          {previewCommitment ? "previewed" : "preview first"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onUpdate({ side: "buy" })}
          className={
            side === "buy"
              ? "h-10 border border-emerald-300/70 bg-emerald-300/15 text-sm font-medium text-emerald-100"
              : "h-10 border border-[#1e2a3a] bg-[#08090d] text-sm text-[#aab5c8]"
          }
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => onUpdate({ side: "sell" })}
          className={
            side === "sell"
              ? "h-10 border border-red-300/70 bg-red-300/15 text-sm font-medium text-red-100"
              : "h-10 border border-[#1e2a3a] bg-[#08090d] text-sm text-[#aab5c8]"
          }
        >
          Sell
        </button>
      </div>

      <div className="mt-3 grid gap-3">
        <Select
          label="Amount"
          value={order.quote_size || "5"}
          options={[["5", "$5"], ["10", "$10"], ["25", "$25"]]}
          onChange={(value) => onUpdate({ quote_size: value })}
        />
        <Select
          label="Max slippage"
          value={order.max_slippage_bps || "50"}
          options={[["25", "25 bps"], ["50", "50 bps"], ["100", "100 bps"]]}
          onChange={(value) => onUpdate({ max_slippage_bps: value })}
        />
      </div>

      <div className="mt-3 grid gap-2 border-t border-[#162337] pt-3">
        <StatusLine label="Main wallet" value="not exposed" tone="good" />
        <StatusLine label="Ghola" value="sealed runtime" tone="good" />
        <StatusLine label="Venue sees" value="execution account + order" tone="warn" />
      </div>

      <button
        type="button"
        onClick={onPreview}
        disabled={working || !onPreview || !accountReady}
        className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 bg-[#eef1f8] px-3 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Play className="h-4 w-4" />
        {working ? "Checking" : accountReady ? previewCommitment ? "Preview again" : "Preview trade" : disabledReason}
      </button>

      {errors[0] && <p className="mt-3 text-xs leading-5 text-amber-200">{errors[0]}</p>}
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
    <div className="border border-[#162337] bg-[#08090d] px-3 py-2">
      <p className="text-[11px] text-[#6f7d9a]">{label}</p>
      <p className={`mt-1 text-sm font-medium ${valueClass}`}>{value}</p>
    </div>
  );
}

function HyperliquidAdvancedChart({
  mode,
  onModeChange,
  snapshot,
  size = "compact",
}: {
  mode: HyperliquidChartMode;
  onModeChange: (mode: HyperliquidChartMode) => void;
  snapshot: HyperliquidMarketSnapshot | null;
  size?: "compact" | "large";
}) {
  const candles = snapshot?.candles || [];
  const bids = snapshot?.bids || [];
  const asks = snapshot?.asks || [];
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const large = size === "large";
  const width = 920;
  const height = large ? 430 : 250;
  const left = 10;
  const right = 76;
  const top = 18;
  const bottom = 34;
  const volumeTop = large ? height - 86 : height - 62;
  const plotBottom = mode === "depth" ? height - bottom : volumeTop - 12;
  const plotWidth = width - left - right;
  const plotHeight = plotBottom - top;
  const chartClass = large ? "h-[400px] w-full overflow-hidden sm:h-[430px]" : "h-56 w-full overflow-hidden";
  const shouldShowDepth = mode === "depth";
  const hasChartData = shouldShowDepth ? bids.length > 0 && asks.length > 0 : candles.length >= 2;

  if (!hasChartData) {
    return (
      <div className="grid gap-2">
        {large && <ChartModeTabs mode={mode} onModeChange={onModeChange} />}
        <div
          className={`flex ${large ? "h-[400px] sm:h-[430px]" : "h-56"} items-center justify-center border border-dashed border-[#1e2a3a] text-sm text-[#6f7d9a]`}
        >
          Loading chart
        </div>
      </div>
    );
  }

  const priceRange = hyperliquidCandlePriceRange(candles);
  const maxVolume = Math.max(1, ...candles.map((candle) => Number(candle.v)).filter((value) => Number.isFinite(value)));
  const yForPrice = (price: number) => plotBottom - ((price - priceRange.min) / priceRange.range) * plotHeight;
  const xForIndex = (index: number) => left + (index / Math.max(1, candles.length - 1)) * plotWidth;
  const linePoints = candles.map((candle, index) => {
    const x = xForIndex(index);
    const y = yForPrice(Number(candle.c));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const last = Number(candles.at(-1)?.c || 0);
  const up = last >= Number(candles[0]?.c || 0);
  const lastX = xForIndex(candles.length - 1);
  const lastY = yForPrice(last);
  const priceTicks = [
    priceRange.max,
    priceRange.min + priceRange.range * 0.75,
    priceRange.min + priceRange.range * 0.5,
    priceRange.min + priceRange.range * 0.25,
    priceRange.min,
  ];
  const hoverCandle = hoverIndex == null ? null : candles[hoverIndex] ?? null;
  const hoverX = hoverIndex == null ? null : xForIndex(hoverIndex);
  const hoverY = hoverCandle ? yForPrice(Number(hoverCandle.c)) : null;
  const candleWidth = Math.max(2, Math.min(9, (plotWidth / candles.length) * 0.72));
  const bidDepth = hyperliquidCumulativeDepth(bids, "bid");
  const askDepth = hyperliquidCumulativeDepth(asks, "ask");
  const depthPoints = [...bidDepth, ...askDepth];
  const depthMinPrice = Math.min(...depthPoints.map((point) => point.px));
  const depthMaxPrice = Math.max(...depthPoints.map((point) => point.px));
  const depthRange = Math.max(1, depthMaxPrice - depthMinPrice);
  const depthMax = hyperliquidDepthMax(depthPoints);
  const xForDepthPrice = (price: number) => left + ((price - depthMinPrice) / depthRange) * plotWidth;
  const yForDepth = (cumulative: number) => plotBottom - (cumulative / depthMax) * plotHeight;
  const bidLine = bidDepth.map((point) => `${xForDepthPrice(point.px).toFixed(2)},${yForDepth(point.cumulative).toFixed(2)}`).join(" ");
  const askLine = askDepth.map((point) => `${xForDepthPrice(point.px).toFixed(2)},${yForDepth(point.cumulative).toFixed(2)}`).join(" ");
  const bidArea = bidDepth.length
    ? `${left},${plotBottom} ${bidLine} ${xForDepthPrice(bidDepth.at(-1)?.px ?? depthMinPrice).toFixed(2)},${plotBottom}`
    : "";
  const askArea = askDepth.length
    ? `${xForDepthPrice(askDepth[0]?.px ?? depthMaxPrice).toFixed(2)},${plotBottom} ${askLine} ${width - right},${plotBottom}`
    : "";
  const timeTicks = [0, Math.floor((candles.length - 1) / 2), candles.length - 1]
    .map((index) => candles[index])
    .filter(Boolean);

  function handleMove(event: { currentTarget: SVGSVGElement; clientX: number }) {
    if (shouldShowDepth) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    setHoverIndex(nearestHyperliquidCandleIndex(candles.length, localX, left, plotWidth));
  }

  return (
    <div className="grid gap-2">
      {large && <ChartModeTabs mode={mode} onModeChange={onModeChange} />}
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={chartClass}
          role="img"
          aria-label={`Hyperliquid ${mode} chart`}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="hyperliquidChartFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={up ? "#6ee7b7" : "#fca5a5"} stopOpacity="0.24" />
              <stop offset="100%" stopColor={up ? "#6ee7b7" : "#fca5a5"} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="hyperliquidBidDepthFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="hyperliquidAskDepthFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#fca5a5" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#fca5a5" stopOpacity="0" />
            </linearGradient>
          </defs>

          {(shouldShowDepth ? [depthMax, depthMax * 0.75, depthMax * 0.5, depthMax * 0.25, 0] : priceTicks).map((value) => {
            const y = shouldShowDepth ? yForDepth(value) : yForPrice(value);
            return (
              <g key={value}>
                <line x1={left} x2={width - right} y1={y} y2={y} stroke="#162337" strokeDasharray="4 6" strokeWidth="1" />
                <text x={width - 6} y={Math.max(12, y - 4)} fill="#6f7d9a" fontSize="12" textAnchor="end">
                  {shouldShowDepth ? formatSize(String(value)) : formatPrice(String(value))}
                </text>
              </g>
            );
          })}

          {shouldShowDepth ? (
            <>
              {bidArea && <polyline points={bidArea} fill="url(#hyperliquidBidDepthFill)" stroke="none" />}
              {askArea && <polyline points={askArea} fill="url(#hyperliquidAskDepthFill)" stroke="none" />}
              {bidLine && <polyline points={bidLine} fill="none" stroke="#6ee7b7" strokeWidth="3" strokeLinejoin="round" />}
              {askLine && <polyline points={askLine} fill="none" stroke="#fca5a5" strokeWidth="3" strokeLinejoin="round" />}
              <text x={left} y={height - 10} fill="#6ee7b7" fontSize="12">
                Bid {bids[0]?.px ? formatBookPrice(bids[0].px) : "-"}
              </text>
              <text x={width - right} y={height - 10} fill="#fca5a5" fontSize="12" textAnchor="end">
                Ask {asks[0]?.px ? formatBookPrice(asks[0].px) : "-"}
              </text>
            </>
          ) : (
            <>
              {mode === "line" && (
                <>
                  <polyline points={`${left},${plotBottom} ${linePoints} ${width - right},${plotBottom}`} fill="url(#hyperliquidChartFill)" stroke="none" />
                  <polyline
                    points={linePoints}
                    fill="none"
                    stroke={up ? "#6ee7b7" : "#fca5a5"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="3"
                  />
                  <circle cx={lastX} cy={lastY} r="4" fill={up ? "#6ee7b7" : "#fca5a5"} />
                </>
              )}
              {mode === "candles" && candles.map((candle, index) => {
                const x = xForIndex(index);
                const open = Number(candle.o);
                const close = Number(candle.c);
                const high = Number(candle.h);
                const low = Number(candle.l);
                const candleUp = close >= open;
                const bodyTop = Math.min(yForPrice(open), yForPrice(close));
                const bodyHeight = Math.max(1, Math.abs(yForPrice(open) - yForPrice(close)));
                return (
                  <g key={`${candle.t}-${index}`}>
                    <line
                      x1={x}
                      x2={x}
                      y1={yForPrice(high)}
                      y2={yForPrice(low)}
                      stroke={candleUp ? "#6ee7b7" : "#fca5a5"}
                      strokeWidth="1.4"
                    />
                    <rect
                      x={x - candleWidth / 2}
                      y={bodyTop}
                      width={candleWidth}
                      height={bodyHeight}
                      fill={candleUp ? "#6ee7b7" : "#fca5a5"}
                      opacity={candleUp ? "0.82" : "0.72"}
                    />
                  </g>
                );
              })}
              {candles.map((candle, index) => {
                const volume = Number(candle.v);
                const barHeight = Math.max(1, Math.min(height - volumeTop - 12, (volume / maxVolume) * (height - volumeTop - 14)));
                const x = xForIndex(index);
                const candleUp = Number(candle.c) >= Number(candle.o);
                return (
                  <rect
                    key={`${candle.t}-volume-${index}`}
                    x={x - candleWidth / 2}
                    y={height - bottom - barHeight}
                    width={candleWidth}
                    height={barHeight}
                    fill={candleUp ? "#2b7f65" : "#7f3d45"}
                    opacity="0.55"
                  />
                );
              })}
              <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="#162337" />
              {timeTicks.map((candle, index) => (
                <text
                  key={`${candle.t}-${index}-tick`}
                  x={index === 0 ? left : index === 1 ? left + plotWidth / 2 : width - right}
                  y={height - 10}
                  fill="#6f7d9a"
                  fontSize="12"
                  textAnchor={index === 0 ? "start" : index === 1 ? "middle" : "end"}
                >
                  {formatChartTime(candle.T || candle.t)}
                </text>
              ))}
              {hoverCandle && hoverX != null && hoverY != null && (
                <>
                  <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} stroke="#a8d8ff" strokeDasharray="3 5" strokeOpacity="0.5" />
                  <line x1={left} x2={width - right} y1={hoverY} y2={hoverY} stroke="#a8d8ff" strokeDasharray="3 5" strokeOpacity="0.35" />
                  <circle cx={hoverX} cy={hoverY} r="3.5" fill="#a8d8ff" />
                </>
              )}
            </>
          )}
        </svg>

        {hoverCandle && !shouldShowDepth && (
          <div className="pointer-events-none absolute left-3 top-3 grid gap-1 border border-[#253349] bg-[#08090d]/95 px-3 py-2 text-xs text-[#aab5c8] shadow-lg shadow-black/30">
            <div className="font-medium text-[#eef1f8]">{formatChartTime(hoverCandle.T || hoverCandle.t)}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <span>O {formatPrice(hoverCandle.o)}</span>
              <span>H {formatPrice(hoverCandle.h)}</span>
              <span>L {formatPrice(hoverCandle.l)}</span>
              <span>C {formatPrice(hoverCandle.c)}</span>
              <span>Vol {formatSize(hoverCandle.v)}</span>
              <span>Trades {hoverCandle.n ?? "-"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChartModeTabs({
  mode,
  onModeChange,
}: {
  mode: HyperliquidChartMode;
  onModeChange: (mode: HyperliquidChartMode) => void;
}) {
  const modes: Array<[HyperliquidChartMode, string]> = [
    ["candles", "Candles"],
    ["line", "Line"],
    ["depth", "Depth"],
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-[#6f7d9a]">Chart</span>
      <div className="flex gap-1.5">
        {modes.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={
              mode === value
                ? "h-7 border border-[#a8d8ff] bg-[#a8d8ff] px-3 text-xs font-medium text-[#08090d]"
                : "h-7 border border-[#1e2a3a] bg-[#08090d] px-3 text-xs text-[#aab5c8] hover:border-[#3da8ff]/50"
            }
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatChartTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "-";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function OrderbookRows({
  side,
  levels,
}: {
  side: "bid" | "ask";
  levels: HyperliquidMarketSnapshot["bids"];
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

function RecentTradeRows({ trades }: { trades: HyperliquidMarketSnapshot["recent_trades"] }) {
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
          {shown.map((trade) => (
            <div key={`${trade.time}-${trade.side}-${trade.px}-${trade.sz}`} className="grid grid-cols-[72px_minmax(0,1fr)_34px] gap-2 text-xs">
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

function SignedOutAccountGate({
  loading,
  liveHyperliquidFlow,
  livePhoenixFlow,
  onSignIn,
}: {
  loading: boolean;
  liveHyperliquidFlow: boolean;
  livePhoenixFlow: boolean;
  onSignIn: () => void;
}) {
  const headline = liveHyperliquidFlow
    ? "Sign in to use Ghola with Hyperliquid"
    : livePhoenixFlow
      ? "Sign in to trade with Ghola"
      : "Sign in to use Private Mode";
  const description = liveHyperliquidFlow
    ? "Connect your Hyperliquid API wallet, check visibility, then approve a capped live order."
    : livePhoenixFlow
      ? "Choose a venue, connect a trading authority, check visibility, then place a capped live trade."
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
        disabled={loading}
        className="inline-flex h-11 items-center justify-center bg-[#eef1f8] px-5 text-sm font-medium text-[#08090d] disabled:cursor-wait disabled:opacity-60"
      >
        {loading ? "Checking" : "Get started"}
      </button>
    </section>
  );
}

function friendlyPrivateAccountError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : "";
  if (message === "phoenix_connection_check_required") {
    return "Check the Phoenix connection before placing a live trade.";
  }
  if (message === "needs_funds") {
    return "Needs funds. Add venue collateral, then check the connection again.";
  }
  if (message === "venue_access_required") {
    return "Connect a Hyperliquid API wallet first, or choose the Ghola test account.";
  }
  if (message === "hyperliquid_managed_allocation_not_ready") {
    return "Ghola could not prepare the Hyperliquid test account yet. Try again after the connector is healthy.";
  }
  if (message === "venue_rejected") {
    return "The venue rejected the access, funds, market, or order. Ghola did not route around the venue.";
  }
  if (message === "connector_submit_failed") {
    return "Ghola could not reach the private execution worker. Try again after the connector is healthy.";
  }
  if (message === "connector_not_ready") {
    return "This connector is not ready yet.";
  }
  if (message === "invalid_authority_or_access") {
    return "Phoenix could not use that trading authority. Check the authority and venue access.";
  }
  if (message === "rpc_unreachable") {
    return "Ghola could not reach Solana RPC for the Phoenix check.";
  }
  if (message === "worker_unavailable" || message === "connector_endpoint_missing") {
    return "The private execution worker is unavailable.";
  }
  if (message === "unsupported_platform") {
    return "No-submit verification is only wired for Phoenix right now.";
  }
  if (message === "policy_blocked" || message === "live_gate_disabled") {
    return "Phoenix verification is blocked by the live safety gate.";
  }
  if (message === "solana_perps_execution_vault_not_ready") {
    return "Connect a Phoenix trading authority first.";
  }
  if (message === "private_mode_evidence_required") {
    return "Private Mode is waiting for evidence. Queue the action or try again when evidence is ready.";
  }
  return message || fallback;
}

function hyperliquidLiveStatus(input: {
  liveHyperliquidFlow: boolean;
  connected: boolean;
  armed: boolean;
  fundingReady: boolean;
}) {
  if (!input.connected) return input.liveHyperliquidFlow ? "Connect API wallet" : "Choose access";
  if (!input.armed) return "Use with Ghola";
  if (input.liveHyperliquidFlow) return "Ready to trade";
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
  if (!input.armed) return "Use with Ghola";
  return "Ready to trade";
}

function labelFor(options: ReadonlyArray<readonly [string, string]>, value: string) {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? value;
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

function hyperliquidAssetBucket(market: "BTC" | "ETH" | "SOL" | "HYPE"): PrivateAccountSafeInput["asset_bucket"] {
  if (market === "BTC") return "BTC";
  if (market === "ETH") return "ETH";
  if (market === "SOL") return "SOL";
  return "major";
}

function hyperliquidAccountStatusLabel(status: string) {
  if (status === "ready_to_trade") return "ready";
  if (status === "needs_funds") return "needs funds";
  if (status === "worker_unavailable") return "worker unavailable";
  if (status === "private_mode_waiting") return "waiting";
  return "connect account";
}

function hyperliquidAccountStreamLabel(status: HyperliquidAccountStreamStatus | string | undefined) {
  if (status === "live") return "account live";
  if (status === "backfilling") return "backfilling";
  if (status === "reconnecting") return "reconnecting";
  if (status === "worker_unavailable") return "worker unavailable";
  if (status === "venue_access_required") return "connect account";
  if (status === "needs_funds") return "needs funds";
  if (status === "snapshot") return "snapshot";
  return "connecting";
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

function shortLeakageStatus(status: string) {
  if (status.startsWith("hidden")) return "hidden";
  if (status.startsWith("minimized")) return "bucketed";
  if (status.includes("visible")) return "visible";
  if (status.includes("blocked")) return "blocked";
  if (status.includes("degraded")) return "degraded";
  return status;
}

function isExecutionPlatform(platformClass: string) {
  return platformClass === "hyperliquid_style_market" ||
    platformClass === "coinbase_style_provider" ||
    platformClass === "solana_perps_market";
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
    return {
      ...order,
      venue_id: "phoenix",
      operation_class: "perp_limit_order",
      market: (order.market || "SOL").toUpperCase().split("-")[0],
      live_order_mode: "tiny_fill",
      quote_size: order.quote_size || "5",
      limit_price: order.limit_price || "250",
      tif: "Ioc",
    };
  }
  return {
    ...order,
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: (order.market || "BTC").toUpperCase().split("-")[0],
    tif: order.live_order_mode === "tiny_fill"
      ? "Ioc"
      : order.tif === "Ioc" || order.tif === "Alo" ? order.tif : "Gtc",
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
      <div className="flex flex-wrap gap-2">
        {options.map(([optionValue, text]) => {
          const selected = optionValue === value;
          return (
            <button
              key={optionValue}
              type="button"
              onClick={() => onChange(optionValue)}
              className={
                selected
                  ? "h-10 flex-1 basis-[112px] border border-[#a8d8ff] bg-[#a8d8ff] px-3 text-sm font-medium text-[#08090d]"
                  : "h-10 flex-1 basis-[112px] border border-[#1e2a3a] bg-[#08090d] px-3 text-sm font-medium text-[#aab5c8] hover:border-[#3da8ff]/50 hover:text-[#eef1f8]"
              }
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
            className="h-8 border border-[#1e2a3a] bg-[#0b0d12] px-3 text-xs font-medium text-[#aab5c8] hover:border-[#3da8ff]/50 hover:text-[#eef1f8]"
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
    <label className="grid gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-10 border border-[#1e2a3a] bg-[#08090d] px-3 font-mono text-sm text-[#eef1f8] outline-none placeholder:text-[#59657a] focus:border-[#a8d8ff]"
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
    <label className="grid gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 border border-[#1e2a3a] bg-[#08090d] px-3 text-sm text-[#eef1f8]"
      >
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>{text}</option>
        ))}
      </select>
    </label>
  );
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
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[#8b95a8]">{label}</span>
      <span className={tone === "good" ? "text-sm text-emerald-200" : "text-sm text-amber-200"}>
        {formatValue(value)}
      </span>
    </div>
  );
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
