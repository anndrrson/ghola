import type {
  GholaClaimStatus,
  GholaAuctionOrderSide,
  GholaPlatformClass,
  GholaPrivateAccountActionClass,
  GholaRailKind,
  GholaVenueAccountMode,
  GholaVenueExecutionMode,
  GholaVenueId,
} from "./private-account";
import type { PrivateAccountReadinessResponse } from "./private-account-readiness";
import type { HyperliquidEncryptedExecutionVaultBundle } from "./hyperliquid-vault-seal";
import type { CoinbaseEncryptedExecutionVaultBundle, CoinbaseExecutionMode } from "./coinbase-vault-seal";
import type { SolanaPerpsEncryptedExecutionVaultBundle } from "./solana-perps-vault-seal";
import type { SolanaSwapEncryptedExecutionVaultBundle } from "./solana-swap-vault-seal";

export type PrivateAccountProductBucket =
  | "stablecoin"
  | "solana"
  | "swap"
  | "perps"
  | "rfq"
  | "provider"
  | "partner_assets";

export interface PrivateAccountSafeInput {
  action_class: GholaPrivateAccountActionClass;
  platform_class: GholaPlatformClass;
  product_bucket: PrivateAccountProductBucket;
  amount_bucket: "5" | "10" | "25" | "50" | "100";
  urgency: "maximum_privacy" | "next_batch" | "fast_degraded";
  destination_class:
    | "ghola_user"
    | "fresh_wallet"
    | "known_wallet"
    | "platform_subaccount"
    | "external_public_address";
  asset_bucket: "stablecoin" | "SOL" | "ETH" | "BTC" | "major" | "long_tail";
  solver_count_bucket: "1" | "2-4" | "5+";
}

export type PrivateAutopilotVenueId = "jupiter" | "phoenix" | "hyperliquid" | "coinbase_advanced" | "backpack";
export type PrivateAutopilotStatus =
  | "armed"
  | "watching"
  | "running"
  | "pending_worker"
  | "pending_funding"
  | "paused"
  | "killed"
  | "blocked"
  | "expired";
export type PrivateAutopilotEventType =
  | "agent_tick"
  | "ai_decision"
  | "ai_score"
  | "funding_required"
  | "session_created"
  | "session_state"
  | "venue_readiness"
  | "proposal"
  | "execution"
  | "live_order_submitted"
  | "position_update"
  | "risk_reject"
  | "venue_reconcile"
  | "guardrail"
  | "receipt";

export interface PrivateAccountLiveTradingStatus {
  version: 1;
  status: "green" | "red";
  live_trading_enabled: boolean;
  live_submit_mode: "disabled" | "byo_mainnet" | "pooled_and_byo";
  byo_live_trading_enabled: boolean;
  pooled_live_trading_enabled: boolean;
  public_live_copy_allowed: boolean;
  public_market_data_enabled: boolean;
  default_access_mode: "ghola_auto_access";
  required_venues: Array<{
    id: "hyperliquid" | "phoenix" | "backpack" | "jupiter" | "coinbase";
    label: string;
    submit_source?: "ghola_pooled_account";
    status: "green" | "red";
    canary_status: "green" | "missing" | "red" | "stale";
    canary_required?: boolean;
    canary_reason_codes?: string[];
    reason_codes: string[];
  }>;
  byo_live_venues: Array<{
    id: "hyperliquid" | "phoenix" | "backpack" | "jupiter" | "coinbase";
    label: string;
    submit_source: "user_scoped_credential";
    status: "green" | "red";
    reason_codes: string[];
  }>;
  pooled_reason_codes: string[];
  pooled_unavailable_reason_codes?: string[];
  pooled_live_venues?: string[];
  pooled_worker_readiness?: {
    status: "ready" | "blocked" | "unavailable" | string;
    ready: boolean;
    endpoint_configured?: boolean;
    reason_codes: string[];
  };
  reason_codes: string[];
  gate_commitment: string;
  checked_at: string;
}

export interface PrivateAutopilotAgentMandate {
  strategy_profile: string;
  entry_trigger: string;
  exit_rule: string;
  time_horizon: string;
  trigger_level?: string;
  invalidation_level?: string;
  edge_threshold_bps?: string;
  time_window?: string;
  strategy_note?: string;
}

export interface PrivateAutopilotSessionPolicy {
  strategy_id?:
    | "momentum_micro_trader"
    | "hedged_spread_arbitrage_v1"
    | "tri_venue_market_maker_v1"
    | "level_trigger_v1";
  agent_mandate?: PrivateAutopilotAgentMandate | null;
  agent_side?: "buy" | "sell";
  decision_model: "rules_plus_ai_score" | "ai_direct_order_v1" | "deterministic_level_trigger";
  ai_direct_enabled: boolean;
  venue_allowlist: PrivateAutopilotVenueId[];
  market_allowlist: string[];
  max_notional_bucket: "5" | "10" | "25" | "50" | "100";
  max_position_notional_bucket: "50" | "100" | "250" | "500";
  max_daily_notional_bucket: "25" | "50" | "100" | "250";
  max_order_count: number;
  ttl_ms: number;
  max_slippage_bps: number;
  cooldown_ms: number;
  data_max_age_ms: number;
  min_ai_score_bps: number;
  ai_min_confidence_bps: number;
  min_signal_bps: number;
  max_spread_bps: number;
  allowed_order_types: Array<
    "swap" | "spot_limit_order" | "spot_market_order" | "perp_limit_order" | "limit_order" | "cancel"
  >;
  kill_switch: boolean;
  reduce_only_on_reconcile_failure: boolean;
  locale_hint: "en" | "zh-CN" | "id";
  timezone: string | null;
  policy_commitment: string;
}

export interface PrivateAutopilotSession {
  version: 2;
  autopilot_session_id: string;
  worker_autopilot_session_id: string | null;
  worker_session_commitment: string | null;
  owner_commitment: string;
  status: PrivateAutopilotStatus;
  strategy: {
    version: 1;
    strategy_id:
      | "momentum_micro_trader"
      | "hedged_spread_arbitrage_v1"
      | "tri_venue_market_maker_v1"
      | "level_trigger_v1";
    decision_model: "rules_plus_ai_score" | "ai_direct_order_v1" | "deterministic_level_trigger";
    executable_order_source:
      | "deterministic_guarded_strategy"
      | "ai_structured_decision_validated_by_policy"
      | "deterministic_guarded_arb_planner"
      | "deterministic_guarded_market_maker"
      | "deterministic_level_trigger";
    ai_can_execute_directly: boolean;
  };
  session_policy: PrivateAutopilotSessionPolicy;
  venue_access: Record<PrivateAutopilotVenueId, {
    status: "ready" | "needs_funds" | "venue_access_required" | "blocked";
    execution_mode: string | null;
    reason: string | null;
  }>;
  order_count: number;
  daily_notional_used_bucket: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  next_step: string;
  execution_enabled: boolean;
  control_plane: "android" | "worker";
  visibility_summary: {
    main_wallet_prompts_per_trade: false;
    execution_boundary: "bounded_session_policy" | "bounded_delegated_worker_policy";
    user_can_kill_anytime: true;
  };
}

export interface PrivateAutopilotEvent {
  version: 1;
  autopilot_session_id: string;
  event_id: string;
  type: PrivateAutopilotEventType;
  status: PrivateAutopilotStatus;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface PrivateAutopilotCreateResponse {
  version: 1;
  session: PrivateAutopilotSession;
  events: PrivateAutopilotEvent[];
}

export interface PrivateAutopilotListResponse {
  version: 1;
  autopilot_sessions: PrivateAutopilotSession[];
}

export interface PrivateAutopilotReadiness {
  version: 1;
  product_id: string;
  can_arm: boolean;
  can_live_submit: boolean;
  worker_configured: boolean;
  seeker_required: boolean;
  target_live_mode: "tiny_live_orders";
  blockers: string[];
  venue_readiness: Array<{
    venue_id: PrivateAutopilotVenueId;
    status: "ready" | "needs_funds" | "blocked";
    live_mode: string | null;
    reason_codes: string[];
  }>;
}

export interface HyperliquidMarketSnapshot {
  version: 1;
  platform: "hyperliquid";
  network: "mainnet" | "testnet";
  coin: "BTC" | "ETH" | "SOL" | "HYPE";
  interval: "1m" | "5m" | "15m" | "1h";
  fetched_at: string;
  source_timestamp: number | null;
  stale: boolean;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  mark_price: string | null;
  oracle_price: string | null;
  prev_day_price: string | null;
  day_notional_volume: string | null;
  day_base_volume: string | null;
  open_interest: string | null;
  funding_rate: string | null;
  premium: string | null;
  max_leverage: number | null;
  candles: Array<{ t: number; T: number | null; o: string; h: string; l: string; c: string; v: string; n: number | null }>;
  bids: Array<{ px: string; sz: string; n: number | null }>;
  asks: Array<{ px: string; sz: string; n: number | null }>;
  recent_trades: Array<{ side: "buy" | "sell"; px: string; sz: string; time: number }>;
}

export interface HyperliquidAccountSnapshot {
  version: 1;
  platform_class: "hyperliquid_style_market";
  venue_id: "hyperliquid";
  status:
    | "ready_to_trade"
    | "needs_funds"
    | "venue_access_required"
    | "worker_unavailable"
    | "private_mode_waiting";
  account_source: "sealed_byo" | "ghola_managed" | "ghola_pooled" | "hyperliquid_native_vault" | "none";
  trading_enabled: boolean;
  equity_bucket: "none" | "low" | "ready" | "unknown";
  position_count: number;
  open_order_count: number;
  stream_status?:
    | "connecting"
    | "live"
    | "reconnecting"
    | "backfilling"
    | "snapshot"
    | "worker_unavailable"
    | "venue_access_required"
    | "needs_funds";
  positions?: Array<{
    position_commitment: string;
    market: string;
    side: "long" | "short";
    size_bucket: string;
    entry_price_bucket: string;
    unrealized_pnl_bucket: string;
  }>;
  open_orders?: Array<{
    order_handle_commitment: string;
    market: string;
    side: "buy" | "sell" | "unknown";
    size_bucket: string;
    price_bucket: string;
    status: string;
    reduce_only: boolean;
  }>;
  recent_fills?: Array<{
    fill_commitment: string;
    market: string;
    side: "buy" | "sell" | "unknown";
    size_bucket: string;
    price_bucket: string;
    fee_bucket: string;
    time_bucket: string;
  }>;
  visibility_summary?: {
    main_wallet_exposed: boolean;
    ghola_operator_sees: string;
    hyperliquid_sees: string;
    public_chain_sees: string;
  };
  last_checked_at: string;
  last_event_at?: string;
  next_step: string;
}

export type HyperliquidAccountStreamStatus =
  NonNullable<HyperliquidAccountSnapshot["stream_status"]>;

export async function getHyperliquidMarketSnapshot(input: {
  network?: "mainnet" | "testnet";
  coin?: "BTC" | "ETH" | "SOL" | "HYPE";
  interval?: "1m" | "5m" | "15m" | "1h";
} = {}): Promise<HyperliquidMarketSnapshot> {
  const params = new URLSearchParams();
  if (input.network) params.set("network", input.network);
  if (input.coin) params.set("coin", input.coin);
  if (input.interval) params.set("interval", input.interval);
  const query = params.toString();
  return privateAccountFetch(`/v1/private-account/hyperliquid/market-snapshot${query ? `?${query}` : ""}`, {
    method: "GET",
  }) as Promise<HyperliquidMarketSnapshot>;
}

export async function getHyperliquidAccountSnapshot(): Promise<HyperliquidAccountSnapshot> {
  return privateAccountFetch("/v1/private-account/hyperliquid/account-snapshot", {
    method: "POST",
    body: JSON.stringify({}),
  }) as Promise<HyperliquidAccountSnapshot>;
}

export function openHyperliquidAccountStream(input: {
  coin?: "BTC" | "ETH" | "SOL" | "HYPE";
  onState: (snapshot: HyperliquidAccountSnapshot) => void;
  onStatus?: (status: HyperliquidAccountStreamStatus) => void;
  onEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}) {
  let closed = false;
  let retryCount = 0;
  let activeController: AbortController | null = null;

  async function connect() {
    while (!closed) {
      activeController = new AbortController();
      input.onStatus?.(retryCount > 0 ? "reconnecting" : "connecting");
      try {
        const params = new URLSearchParams();
        if (input.coin) params.set("coin", input.coin);
        const headers: Record<string, string> = {};
        const token = thumperToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`/v1/private-account/hyperliquid/account-stream${params.toString() ? `?${params}` : ""}`, {
          method: "GET",
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal: activeController.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Account stream error ${res.status}`);
        retryCount = 0;
        await readPrivateAccountSse(res.body, {
          onMessage: (event, data) => {
            if (event === "account_state") {
              const snapshot = data as HyperliquidAccountSnapshot;
              input.onState(snapshot);
              if (snapshot.stream_status) input.onStatus?.(snapshot.stream_status);
              return;
            }
            if (event === "stream_status") {
              const status = (data as { stream_status?: HyperliquidAccountStreamStatus }).stream_status;
              if (status) input.onStatus?.(status);
              return;
            }
            if (event === "account_event") {
              input.onEvent?.(data);
              return;
            }
            if (event === "error") {
              input.onError?.(new Error((data as { error?: string }).error || "Account stream unavailable"));
            }
          },
        });
      } catch (error) {
        if (!closed) input.onError?.(error instanceof Error ? error : new Error("Account stream unavailable"));
      }
      if (!closed) {
        retryCount += 1;
        input.onStatus?.("reconnecting");
        await delay(Math.min(8_000, 500 * 2 ** retryCount));
      }
    }
  }

  void connect();
  return {
    close() {
      closed = true;
      activeController?.abort();
    },
  };
}

export async function listPrivateAutopilotSessions(): Promise<PrivateAutopilotListResponse> {
  return privateAccountFetch("/v1/private-account/autopilot/sessions", {
    method: "GET",
  }) as Promise<PrivateAutopilotListResponse>;
}

export async function createPrivateAutopilotSession(input: {
  session_policy?: Partial<PrivateAutopilotSessionPolicy>;
  venue_access?: Record<string, unknown>;
}): Promise<PrivateAutopilotCreateResponse> {
  return privateAccountFetch("/v1/private-account/autopilot/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  }) as Promise<PrivateAutopilotCreateResponse>;
}

// --- Drawn directional plan -> level_trigger agent ---------------------------
// Maps the /trade order draft vocabulary onto the worker mandate vocabulary and
// arms a deterministic level_trigger agent. The worker (policy.js) is the
// authoritative validator.

const LEVEL_TRIGGER_STRATEGY_PROFILE: Record<string, string> = {
  trend_following: "momentum_continuation",
  breakout: "breakout_retest",
  reversal: "sweep_reclaim",
  mean_reversion: "mean_reversion",
  range_trade: "mean_reversion",
  funding_basis: "funding_mark_divergence",
  custom: "custom",
};

// Entry triggers the deterministic level strategy can actually evaluate from a
// single price snapshot. Other triggers (book imbalance, funding, route) need
// the momentum/arb strategies and are not armable as a level plan yet.
const LEVEL_TRIGGER_SUPPORTED_ENTRIES = new Set([
  "preview_now",
  "break_level",
  "retest_level",
  "sweep_reclaim",
]);

export interface LevelTriggerPlanInput {
  side: "buy" | "sell";
  venueId: string;
  market: string;
  notionalUsd: number;
  maxSlippageBps: number;
  strategyProfile: string;
  entryTrigger: string;
  exitRule: string;
  timeHorizon: string;
  triggerLevel?: string;
  invalidationLevel?: string;
  strategyNote?: string;
}

// A plan is armable as a level agent when the entry is level-based and both the
// trigger and invalidation (stop) levels are present.
export function levelTriggerSupportsPlan(plan: {
  entryTrigger: string;
  triggerLevel?: string;
  invalidationLevel?: string;
}): boolean {
  if (!LEVEL_TRIGGER_SUPPORTED_ENTRIES.has(plan.entryTrigger)) return false;
  if (!plan.invalidationLevel) return false;
  return plan.entryTrigger === "preview_now" || Boolean(plan.triggerLevel);
}

export function mandateFromPlan(plan: LevelTriggerPlanInput): PrivateAutopilotAgentMandate {
  return {
    strategy_profile: LEVEL_TRIGGER_STRATEGY_PROFILE[plan.strategyProfile] ?? "custom",
    entry_trigger: LEVEL_TRIGGER_SUPPORTED_ENTRIES.has(plan.entryTrigger) ? plan.entryTrigger : "break_level",
    exit_rule: plan.invalidationLevel ? "exit_on_invalidation" : (plan.exitRule || "manual_approval"),
    time_horizon: plan.timeHorizon || "until_invalidated",
    trigger_level: plan.triggerLevel,
    invalidation_level: plan.invalidationLevel,
    strategy_note: plan.strategyNote,
  };
}

export async function armLevelTriggerAgent(plan: LevelTriggerPlanInput): Promise<PrivateAutopilotCreateResponse> {
  return createPrivateAutopilotSession({
    session_policy: {
      strategy_id: "level_trigger_v1",
      agent_side: plan.side,
      agent_mandate: mandateFromPlan(plan),
      venue_allowlist: [levelTriggerVenue(plan.venueId)],
      market_allowlist: [levelTriggerMarket(plan.market)],
      max_notional_bucket: levelTriggerNotionalBucket(plan.notionalUsd),
      max_slippage_bps: Math.max(1, Math.min(100, Math.round(plan.maxSlippageBps) || 50)),
    } as Partial<PrivateAutopilotSessionPolicy>,
  });
}

function levelTriggerVenue(venueId: string): PrivateAutopilotVenueId {
  const lowered = String(venueId || "").toLowerCase();
  return (lowered === "coinbase" ? "coinbase_advanced" : lowered) as PrivateAutopilotVenueId;
}

function levelTriggerMarket(market: string): string {
  const base = String(market || "SOL-USD").split("-")[0].split("/")[0].toUpperCase();
  return ["BTC", "ETH", "SOL"].includes(base) ? `${base}-USD` : "SOL-USD";
}

function levelTriggerNotionalBucket(usd: number): "5" | "10" | "25" | "50" | "100" {
  const value = Number.isFinite(usd) ? usd : 0;
  if (value <= 5) return "5";
  if (value <= 10) return "10";
  if (value <= 25) return "25";
  if (value <= 50) return "50";
  return "100";
}

export async function getPrivateAutopilotSession(
  autopilotSessionId: string,
): Promise<{ version: 1; session: PrivateAutopilotSession }> {
  return privateAccountFetch(`/v1/private-account/autopilot/sessions/${encodeURIComponent(autopilotSessionId)}`, {
    method: "GET",
  }) as Promise<{ version: 1; session: PrivateAutopilotSession }>;
}

export async function controlPrivateAutopilotSession(
  autopilotSessionId: string,
  action: "pause" | "resume" | "kill",
): Promise<{ version: 1; session: PrivateAutopilotSession; event: PrivateAutopilotEvent }> {
  return privateAccountFetch(
    `/v1/private-account/autopilot/sessions/${encodeURIComponent(autopilotSessionId)}/${action}`,
    {
      method: "POST",
      body: "{}",
    },
  ) as Promise<{ version: 1; session: PrivateAutopilotSession; event: PrivateAutopilotEvent }>;
}

export async function getPrivateAutopilotReadiness(productId = "BTC-USD"): Promise<PrivateAutopilotReadiness> {
  const params = new URLSearchParams({ product_id: productId });
  return privateAccountFetch(`/v1/private-account/autopilot/readiness?${params.toString()}`, {
    method: "GET",
  }) as Promise<PrivateAutopilotReadiness>;
}

export function openPrivateAutopilotEventStream(input: {
  autopilotSessionId: string;
  onSession: (session: PrivateAutopilotSession) => void;
  onEvent?: (event: PrivateAutopilotEvent) => void;
  onStatus?: (status: "connecting" | "live" | "reconnecting" | "closed") => void;
  onError?: (error: Error) => void;
}) {
  let closed = false;
  let retryCount = 0;
  let activeController: AbortController | null = null;

  async function connect() {
    while (!closed) {
      activeController = new AbortController();
      input.onStatus?.(retryCount > 0 ? "reconnecting" : "connecting");
      try {
        const headers: Record<string, string> = {};
        const token = thumperToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(
          `/v1/private-account/autopilot/sessions/${encodeURIComponent(input.autopilotSessionId)}/events`,
          {
            method: "GET",
            headers,
            credentials: "same-origin",
            cache: "no-store",
            signal: activeController.signal,
          },
        );
        if (!res.ok || !res.body) throw new Error(`Autopilot stream error ${res.status}`);
        retryCount = 0;
        await readPrivateAccountSse(res.body, {
          onMessage: (event, data) => {
            if (event === "session_state") {
              input.onSession(data as PrivateAutopilotSession);
              return;
            }
            if (event === "stream_status") {
              const status = (data as { stream_status?: string }).stream_status;
              input.onStatus?.(status === "closed" ? "closed" : "live");
              return;
            }
            input.onEvent?.(data as PrivateAutopilotEvent);
          },
        });
      } catch (error) {
        if (!closed) input.onError?.(error instanceof Error ? error : new Error("Autopilot stream unavailable"));
      }
      if (!closed) {
        retryCount += 1;
        input.onStatus?.("reconnecting");
        await delay(Math.min(8_000, 500 * 2 ** retryCount));
      }
    }
  }

  void connect();
  return {
    close() {
      closed = true;
      activeController?.abort();
    },
  };
}

export async function createPrivateAccountIntent(input: PrivateAccountSafeInput) {
  return privateAccountFetch("/v1/private-account/actions/intent", {
    method: "POST",
    body: JSON.stringify({
      action_class: input.action_class,
      product_bucket: input.product_bucket,
      intent_seed: {
        amount_bucket: input.amount_bucket,
        urgency: input.urgency,
        destination_class: input.destination_class,
        asset_bucket: input.asset_bucket,
        solver_count_bucket: input.solver_count_bucket,
      },
    }),
  });
}

export async function getPrivateExecutionAccountStatus() {
  return privateAccountFetch("/v1/private-account/status", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function getPrivateAccountPrivacyBudget() {
  return privateAccountFetch("/v1/private-account/privacy-budget", {
    method: "GET",
  });
}

export async function createPrivateAccountFundingInstruction(input: {
  amount_bucket: PrivateAccountSafeInput["amount_bucket"];
  asset_bucket: PrivateAccountSafeInput["asset_bucket"];
}) {
  return privateAccountFetch("/v1/private-account/funding/instruction", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function importPrivateAccountFundingReceipt(input: {
  funding_intent_id: string;
  receipt_id: string;
}) {
  return privateAccountFetch("/v1/private-account/funding/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountFundingStatus() {
  return privateAccountFetch("/v1/private-account/funding/status", {
    method: "GET",
  });
}

export async function getPrivateAccountPrivacyHealth() {
  return privateAccountFetch("/v1/private-account/privacy-health", {
    method: "GET",
  });
}

export async function getPrivateModeCanaryStatus() {
  return privateAccountFetch("/v1/private-account/canaries/status", {
    method: "GET",
  });
}

export async function getPrivateAccountOperationsStatus() {
  return privateAccountFetch("/v1/private-account/operations/status", {
    method: "GET",
  });
}

export async function getPrivateAccountLiveTradingStatus(): Promise<PrivateAccountLiveTradingStatus> {
  return privateAccountFetch("/v1/private-account/live-trading/status", {
    method: "GET",
  });
}

export async function getHyperliquidExecutionVaultStatus() {
  return privateAccountFetch("/v1/private-account/hyperliquid/vault", {
    method: "GET",
  });
}

export async function getHyperliquidPilotStatus() {
  return privateAccountFetch("/v1/private-account/hyperliquid/status", {
    method: "GET",
  });
}

export async function allocateHyperliquidManagedTestnet(input: {
  execution_mode?: "managed_testnet" | "ghola_pooled";
  network?: "testnet" | "mainnet";
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
  force_new?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/managed-allocation", {
    method: "POST",
    body: JSON.stringify({
      execution_mode: input.execution_mode || "managed_testnet",
      network: input.network || (input.execution_mode === "ghola_pooled" ? "mainnet" : "testnet"),
      market_allowlist: input.market_allowlist || ["BTC", "ETH", "SOL"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
      force_new: input.force_new === true,
    }),
  });
}

export async function getHyperliquidNativeVaultStatus() {
  return privateAccountFetch("/v1/private-account/hyperliquid/native-vault/status", {
    method: "GET",
  });
}

export async function prepareHyperliquidNativeVault(input: {
  vault_address?: string | null;
  vault_controller_address?: string | null;
  agent_wallet_address?: string | null;
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
  force_new?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/native-vault/prepare", {
    method: "POST",
    body: JSON.stringify({
      vault_address: input.vault_address ?? null,
      vault_controller_address: input.vault_controller_address ?? null,
      agent_wallet_address: input.agent_wallet_address ?? null,
      market_allowlist: input.market_allowlist || ["BTC", "ETH", "SOL"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
      force_new: input.force_new === true,
    }),
  });
}

export async function confirmHyperliquidNativeVaultDeposit(input: {
  vault_address: string;
  vault_controller_address?: string | null;
  agent_wallet_address?: string | null;
  deposit_receipt_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/native-vault/confirm-deposit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function allocateHyperliquidNativeVault() {
  return privateAccountFetch("/v1/private-account/hyperliquid/native-vault/allocate", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function sealHyperliquidExecutionVault(input: {
  encrypted_execution_vault: HyperliquidEncryptedExecutionVaultBundle;
}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/vault", {
    method: "POST",
    body: JSON.stringify({
      encrypted_execution_vault: input.encrypted_execution_vault,
    }),
  });
}

export async function armHyperliquidExecutionAgent(input: {
  execution_mode?: "byo_api_key" | "managed_testnet" | "ghola_pooled" | "hyperliquid_native_vault";
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/agent/session", {
    method: "POST",
    body: JSON.stringify({
      execution_mode: input.execution_mode,
      market_allowlist: input.market_allowlist || ["BTC", "ETH", "SOL"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
    }),
  });
}

export async function getVenueExecutionVaultStatus(input: {
  platform_class: GholaPlatformClass;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/vault`, {
    method: "GET",
  });
}

export async function listPrivateVenues() {
  return privateAccountFetch("/v1/private-account/venues", {
    method: "GET",
  });
}

export async function getPrivateVenueReadiness(input: {
  venue_id: GholaVenueId;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/readiness`, {
    method: "GET",
  });
}

export async function getVenueEligibilityStatus(input: {
  venue_id: GholaVenueId;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/eligibility`, {
    method: "GET",
  });
}

export async function verifyVenueEligibility(input: {
  venue_id: GholaVenueId;
  credential_type?: "self_attested_eligible_user" | "partner_verified_eligible_user";
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/eligibility`, {
    method: "POST",
    body: JSON.stringify({
      credential_type: input.credential_type || "self_attested_eligible_user",
    }),
  });
}

export async function createVenueSecretHandle(input: {
  venue_id: GholaVenueId;
  account_mode?: GholaVenueAccountMode;
  purpose?: "venue_account" | "venue_api_key" | "trader_authority" | "pooled_operator";
  encrypted_secret_commitment?: string;
  sealed_runtime_recipient_commitment?: string;
  encrypted_secret_bundle?: unknown;
  rotation_epoch?: number;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/secret-handles/create`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createStealthVenueAccount(input: {
  venue_id: GholaVenueId;
  secret_handle_commitment?: string;
  funding_evidence_commitment?: string;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/stealth-account/create`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function allocatePooledVenueAccount(input: {
  venue_id: GholaVenueId;
  funding_evidence_commitment?: string;
  utilization_bucket?: PrivateAccountSafeInput["amount_bucket"];
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/pool/allocate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function preflightVenueTrade(input: {
  venue_id: GholaVenueId;
  account_mode?: GholaVenueAccountMode;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/preflight`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcileVenueTrade(input: {
  venue_id: GholaVenueId;
  venue_account_commitment?: string;
  pooled_allocation_commitment?: string;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/reconcile`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sealVenueExecutionVault(input: {
  platform_class: GholaPlatformClass;
  encrypted_execution_vault:
    | CoinbaseEncryptedExecutionVaultBundle
    | SolanaPerpsEncryptedExecutionVaultBundle
    | SolanaSwapEncryptedExecutionVaultBundle;
  execution_mode?: CoinbaseExecutionMode | GholaVenueExecutionMode;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/vault`, {
    method: "POST",
    body: JSON.stringify({
      encrypted_execution_vault: input.encrypted_execution_vault,
      execution_mode: input.execution_mode || "byo_api_key",
    }),
  });
}

export async function armVenueExecutionAgent(input: {
  platform_class: GholaPlatformClass;
  execution_mode?: CoinbaseExecutionMode | GholaVenueExecutionMode;
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
} = { platform_class: "coinbase_style_provider" }) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/agent/session`, {
    method: "POST",
    body: JSON.stringify({
      execution_mode: input.execution_mode,
      market_allowlist: input.market_allowlist || ["BTC-USD", "ETH-USD", "SOL-USD"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
    }),
  });
}

export async function getPrivateAccountOmnibusStatus() {
  return privateAccountFetch("/v1/private-account/omnibus/status", {
    method: "GET",
  });
}

export async function allocatePrivateAccountOmnibus(input: {
  utilization_bucket?: PrivateAccountSafeInput["amount_bucket"];
} = {}) {
  return privateAccountFetch("/v1/private-account/omnibus/allocate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcilePrivateAccountOmnibus(input: {
  allocation_commitment?: string;
  pause?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/omnibus/reconcile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountConnectorManifests() {
  return privateAccountFetch("/v1/private-account/connectors/manifests", {
    method: "GET",
  });
}

export async function getPrivateAccountConnectorReadiness(input: {
  platform_class?: GholaPlatformClass;
} = {}) {
  return privateAccountFetch("/v1/private-account/connectors/readiness", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function compilePrivateAccountConnectorIntent(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  requested_rail?: GholaRailKind;
  runtime_envelope_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/compile-intent", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      requested_rail: input.requested_rail,
      runtime_envelope_commitment: input.runtime_envelope_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function createPrivateAccountRuntimeEnvelope(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  encrypted_payload_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/runtime-envelope", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      encrypted_payload_commitment: input.encrypted_payload_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function submitPrivateAccountConnector(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/connectors/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function verifyPrivateAccountConnectorNoSubmit(input: {
  platform_class: GholaPlatformClass;
  work_order_commitment: string;
  encrypted_execution_instruction_bundle: unknown;
}) {
  return privateAccountFetch("/v1/private-account/connectors/verify-no-submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcilePrivateAccountConnector(input: {
  work_order_commitment?: string;
  connector_result_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/connectors/reconcile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountConnectorOperations() {
  return privateAccountFetch("/v1/private-account/connectors/operations", {
    method: "GET",
  });
}

export async function listPrivateAccountFundingBatches(limit = 25) {
  return privateAccountFetch(`/v1/private-account/funding/batches?limit=${limit}`, {
    method: "GET",
  });
}

export async function refreshPrivateAccountFundingBatch(input: {
  queue_id?: string;
}) {
  return privateAccountFetch("/v1/private-account/funding/batch/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function previewPrivateAccountAction(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  requested_rail?: GholaRailKind;
  runtime_envelope_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/privacy-preview", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      requested_rail: input.requested_rail,
      runtime_envelope_commitment: input.runtime_envelope_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function approvePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  execution_plan_commitment?: string;
  degraded_accepted?: boolean;
}) {
  return privateAccountFetch("/v1/private-account/actions/approve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function planPrivateAccountAction(input: {
  preview_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/plan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function settlePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  execution_plan_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/settle", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function refreshPrivateAccountSettlementStatus(input: {
  settlement_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/settlements/status/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  encrypted_execution_instruction_bundle?: unknown;
}) {
  return privateAccountFetch("/v1/private-account/actions/execute", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountReceipt(input: {
  receipt_commitment?: string;
  intent_id?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/receipt", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function verifyPrivateAccountReceipt(input: {
  receipt_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/verify-receipt", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountReceipts(limit = 10) {
  return privateAccountFetch(`/v1/private-account/actions/receipts?limit=${limit}`, {
    method: "GET",
  });
}

export async function queuePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/queue", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountQueue(limit = 25) {
  return privateAccountFetch(`/v1/private-account/actions/queue?limit=${limit}`, {
    method: "GET",
  });
}

export async function refreshPrivateAccountQueue(input: {
  queue_id: string;
  safe_input?: PrivateAccountSafeInput;
}) {
  return privateAccountFetch("/v1/private-account/actions/queue/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelPrivateAccountQueue(input: { queue_id: string }) {
  return privateAccountFetch("/v1/private-account/actions/queue/cancel", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountAuctions(limit = 25) {
  return privateAccountFetch(`/v1/private-account/auctions?limit=${limit}`, {
    method: "GET",
  });
}

export async function commitPrivateAccountAuction(input: {
  queue_id: string;
  side?: GholaAuctionOrderSide;
  amount_bucket?: PrivateAccountSafeInput["amount_bucket"];
  asset_bucket?: PrivateAccountSafeInput["asset_bucket"];
}) {
  return privateAccountFetch("/v1/private-account/auctions/commit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function settlePrivateAccountAuction(input: {
  clearing_commitment: string;
  settlement_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/auctions/settle", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountReceiptDetail(receiptCommitment: string) {
  return privateAccountFetch(
    `/v1/private-account/actions/receipts/${encodeURIComponent(receiptCommitment)}`,
    { method: "GET" },
  );
}

export async function exportPrivateAccountReceipt(input: {
  receipt_commitment: string;
  scope?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/receipts/export", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createPrivateAccountViewKey(input: {
  scope?: "user_private_receipt" | "auditor_selective_disclosure";
  audience_seed?: string;
  ttl_ms?: number;
} = {}) {
  return privateAccountFetch("/v1/private-account/view-keys/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function exportPrivateAccountPrivateReceipt(input: {
  receipt_commitment: string;
  view_key_commitment?: string;
  scope?: "user_private_receipt" | "auditor_selective_disclosure";
}) {
  return privateAccountFetch("/v1/private-account/actions/receipts/export-private", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokePrivateAccountAuditorExport(input: {
  private_export_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/auditor-exports/revoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountPlatformReadiness(): Promise<PrivateAccountReadinessResponse> {
  return privateAccountFetch("/v1/private-account/platforms/readiness", {
    method: "GET",
  }) as Promise<PrivateAccountReadinessResponse>;
}

export function recommendedRail(input: {
  safe_input: PrivateAccountSafeInput;
  readiness?: PrivateAccountReadinessResponse | null;
}): GholaRailKind | undefined {
  if (input.safe_input.urgency === "fast_degraded") return "direct_public_fallback";
  if (
    input.safe_input.action_class === "trade_on_platform" ||
    input.safe_input.action_class === "rebalance" ||
    input.safe_input.action_class === "maintain_allocation"
  ) {
    return "shielded_batch_auction";
  }
  if (input.safe_input.action_class === "withdraw") return "shielded_pool";
  const readiness = input.readiness?.profiles.find(
    (profile) => profile.platform_class === input.safe_input.platform_class,
  );
  return readiness?.ready_rails[0];
}

export function isPrivateModeAvailableStatus(status: GholaClaimStatus | string | undefined): boolean {
  return status === "private_mode_available" || status === "full_anonymity_available";
}

async function readPrivateAccountSse(
  body: ReadableStream<Uint8Array>,
  input: {
    onMessage: (event: string, data: unknown) => void;
  },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parsePrivateAccountSseBlock(block);
      if (parsed) input.onMessage(parsed.event, parsed.data);
      continue;
    }
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
  }
  if (buffer.trim()) {
    const parsed = parsePrivateAccountSseBlock(buffer);
    if (parsed) input.onMessage(parsed.event, parsed.data);
  }
}

function parsePrivateAccountSseBlock(block: string): { event: string; data: unknown } | null {
  const lines = block.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function privateAccountFetch(path: string, options: RequestInit) {
  const requestBody = requestBodyObject(options.body);
  const proxied = liveGuardedMutation(path, options.method)
    ? {
        path: "/api/private-account/live-proxy",
        options: {
          ...options,
          method: "POST",
          body: JSON.stringify({
            path,
            method: "POST",
            body: requestBody ?? {},
          }),
        },
      }
    : { path, options };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((proxied.options.headers as Record<string, string>) || {}),
  };
  const token = thumperToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(proxied.path, {
    ...proxied.options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `API error ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function requestBodyObject(body: BodyInit | null | undefined) {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function liveGuardedMutation(path: string, method: string | undefined) {
  if ((method || "GET").toUpperCase() !== "POST") return false;
  const pathname = path.split("?")[0] || path;
  return LIVE_GUARDED_MUTATION_PATHS.some((pattern) => pattern.test(pathname));
}

const LIVE_GUARDED_MUTATION_PATHS = [
  /^\/v1\/private-account\/actions\/execute$/,
  /^\/v1\/private-account\/autopilot\/sessions$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+\/(?:pause|resume|kill)$/,
  /^\/v1\/private-account\/connectors\/(?:submit|verify-no-submit|reconcile)$/,
  /^\/v1\/private-account\/hyperliquid\/(?:account-snapshot|managed-allocation)$/,
  /^\/v1\/private-account\/hyperliquid\/agent\/session$/,
  /^\/v1\/private-account\/hyperliquid\/vault$/,
  /^\/v1\/private-account\/omnibus\/(?:allocate|reconcile)$/,
  /^\/v1\/private-account\/venues\/[^/]+\/(?:agent\/session|eligibility|pool\/allocate|preflight|reconcile|secret-handles\/create|stealth-account\/create|vault)$/,
];

function thumperToken() {
  try {
    return window.localStorage.getItem("thumper_token");
  } catch {
    return null;
  }
}
