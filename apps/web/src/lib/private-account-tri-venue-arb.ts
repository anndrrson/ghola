import { gholaCommitment } from "./private-account";
import {
  BACKPACK_SOL_PERP_SYMBOL,
  backpackPooledReadiness,
} from "./backpack-exchange";
import {
  getBackpackMarketSnapshot,
  type BackpackMarketSnapshot,
} from "./backpack-market-data";
import {
  getHyperliquidMarketSnapshot,
  type HyperliquidMarketSnapshot,
} from "./hyperliquid-market-data";
import {
  getPhoenixMarketSnapshot,
  type PhoenixMarketSnapshot,
} from "./phoenix-market-data";
import {
  getPooledWorkerReadiness,
  pooledWorkerVenueGateFromReadiness,
  type PooledWorkerReadiness,
} from "./private-account-pooled-readiness";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "./private-agent-capability";
import type { AutopilotSessionPolicy } from "./private-account-autopilot";

export type TriVenueId = "phoenix" | "hyperliquid" | "backpack";
export type TriVenueStrategy = "arb" | "delta_neutral" | "market_making";
export type TriVenueAction = "run" | "market-maker/start" | "kill";

export interface TriVenueQuote {
  venue_id: TriVenueId;
  label: string;
  market: "SOL-USD";
  venue_symbol: "SOL-PERP" | "SOL" | typeof BACKPACK_SOL_PERP_SYMBOL;
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  mark_price: string | null;
  funding_rate: string | null;
  open_interest: string | null;
  spread_bps: number | null;
  data_age_ms: number;
  stale: boolean;
  status: "live" | "stale" | "unavailable";
  reason_codes: string[];
}

export interface TriVenueOpportunity {
  strategy: TriVenueStrategy;
  market: "SOL-USD";
  buy_venue?: TriVenueId;
  sell_venue?: TriVenueId;
  net_edge_bps: number;
  gross_edge_bps: number;
  fee_buffer_bps: number;
  slippage_buffer_bps: number;
  max_notional_usd: "5";
  status: "candidate" | "preflight_pass" | "rejected";
  reason_codes: string[];
  data_age_ms: number;
  commitment: string;
  leg_plan?: Array<{
    venue_id: TriVenueId;
    side: "buy" | "sell";
    symbol: string;
    price: string;
    notional_usd: "5";
    order_type: "ioc_limit";
    reduce_only: boolean;
  }>;
  quote_plan?: {
    venue_id: TriVenueId;
    symbol: string;
    bid_price: string;
    ask_price: string;
    quote_ttl_ms: 10000;
    post_only: true;
    max_resting_orders: 2;
    inventory_limit_usd: "5";
  };
}

export interface TriVenueMarketBundle {
  version: 1;
  market: "SOL-USD";
  fetched_at: string;
  quotes: TriVenueQuote[];
  snapshots: {
    phoenix: PhoenixMarketSnapshot;
    hyperliquid: HyperliquidMarketSnapshot;
    backpack: BackpackMarketSnapshot;
  };
  opportunities: TriVenueOpportunity[];
}

export interface TriVenueStatus {
  version: 1;
  market: "SOL-USD";
  status: "green" | "red";
  public_market_data_enabled: boolean;
  can_arm: boolean;
  can_live_submit: boolean;
  live_mode: "tiny_live" | "no_submit";
  gates: Array<{
    id: "market_data" | TriVenueId | "worker" | "arb_policy" | "market_maker_policy";
    label: string;
    status: "green" | "red";
    reason_codes: string[];
  }>;
  caps: {
    max_leg_notional_usd: "5";
    daily_notional_cap_usd: "25";
    min_net_edge_bps: number;
    max_slippage_bps: number;
    max_market_data_skew_ms: number;
    max_execution_skew_ms: number;
    maker_quote_ttl_ms: 10000;
    maker_max_resting_orders: 2;
  };
  worker_readiness: PooledWorkerReadiness;
  gate_commitment: string;
  checked_at: string;
}

const TRI_VENUES: TriVenueId[] = ["phoenix", "hyperliquid", "backpack"];
const VENUE_LABEL: Record<TriVenueId, string> = {
  phoenix: "Phoenix",
  hyperliquid: "Hyperliquid",
  backpack: "Backpack",
};
const VENUE_SYMBOL: Record<TriVenueId, TriVenueQuote["venue_symbol"]> = {
  phoenix: "SOL-PERP",
  hyperliquid: "SOL",
  backpack: BACKPACK_SOL_PERP_SYMBOL,
};
const TAKER_FEE_BUFFER_BPS: Record<TriVenueId, number> = {
  phoenix: 5,
  hyperliquid: 4,
  backpack: 5,
};

export async function getTriVenueMarketBundle(input: {
  interval?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
} = {}): Promise<TriVenueMarketBundle> {
  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const [phoenix, hyperliquid, backpack] = await Promise.all([
    getPhoenixMarketSnapshot({ symbol: "SOL", interval: input.interval, now }),
    getHyperliquidMarketSnapshot({ coin: "SOL", interval: input.interval, now, fetchImpl }),
    getBackpackMarketSnapshot({ symbol: BACKPACK_SOL_PERP_SYMBOL, interval: input.interval, now, fetchImpl }),
  ]);
  const quotes = [
    quoteFromPhoenix(phoenix, now),
    quoteFromHyperliquid(hyperliquid, now),
    quoteFromBackpack(backpack, now),
  ];
  return {
    version: 1,
    market: "SOL-USD",
    fetched_at: now.toISOString(),
    quotes,
    snapshots: { phoenix, hyperliquid, backpack },
    opportunities: buildTriVenueOpportunities({ quotes, now }),
  };
}

export async function getTriVenueStatus(input: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: Date;
  probeWorker?: boolean;
  workerReadiness?: PooledWorkerReadiness;
} = {}): Promise<TriVenueStatus> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const workerReadiness = input.workerReadiness ??
    (input.probeWorker === true
      ? await getPooledWorkerReadiness(env, input.fetchImpl ?? fetch)
      : nonProbingWorkerReadiness(env, now));
  const venueGates = TRI_VENUES.map((venueId) => venueGate(venueId, env, workerReadiness));
  const arbReasons = triVenuePolicyReasons(env, "arb");
  const makerReasons = triVenuePolicyReasons(env, "maker");
  const gates: TriVenueStatus["gates"] = [
    {
      id: "market_data",
      label: "Public market data",
      status: "green",
      reason_codes: [],
    },
    ...venueGates,
    {
      id: "worker",
      label: "Secure worker",
      status: workerReadiness.endpoint_configured && workerReadiness.reason_codes.length === 0 ? "green" : "red",
      reason_codes: workerReadiness.reason_codes,
    },
    {
      id: "arb_policy",
      label: "Arb policy",
      status: arbReasons.length === 0 ? "green" : "red",
      reason_codes: arbReasons,
    },
    {
      id: "market_maker_policy",
      label: "Maker policy",
      status: makerReasons.length === 0 ? "green" : "red",
      reason_codes: makerReasons,
    },
  ];
  const liveSubmit = gates.every((gate) => gate.status === "green");
  return {
    version: 1,
    market: "SOL-USD",
    status: liveSubmit ? "green" : "red",
    public_market_data_enabled: true,
    can_arm: workerReadiness.endpoint_configured && venueGates.every((gate) => gate.status === "green"),
    can_live_submit: liveSubmit,
    live_mode: liveSubmit ? "tiny_live" : "no_submit",
    gates,
    caps: {
      max_leg_notional_usd: "5",
      daily_notional_cap_usd: "25",
      min_net_edge_bps: positiveInteger(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 25),
      max_slippage_bps: positiveInteger(env.PRIVATE_AGENT_ARB_MAX_SLIPPAGE_BPS || env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS, 25),
      max_market_data_skew_ms: positiveInteger(env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS, 2_000),
      max_execution_skew_ms: positiveInteger(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 2_000),
      maker_quote_ttl_ms: 10_000,
      maker_max_resting_orders: 2,
    },
    worker_readiness: workerReadiness,
    gate_commitment: gholaCommitment("tri_venue_live_gate", {
      market: "SOL-USD",
      gates,
      checked_at: now.toISOString(),
    }),
    checked_at: now.toISOString(),
  };
}

function nonProbingWorkerReadiness(
  env: Record<string, string | undefined>,
  now: Date,
): PooledWorkerReadiness {
  const endpointConfigured = Boolean(workerEndpoint(env));
  const reasonCodes = [endpointConfigured ? "worker_probe_not_requested" : "pooled_worker_endpoint_missing"];
  return {
    status: "unavailable",
    ready: false,
    endpoint_configured: endpointConfigured,
    reason_codes: reasonCodes,
    venues: Object.fromEntries(["hyperliquid", "phoenix", "backpack", "jupiter", "coinbase"].map((venueId) => [
      venueId,
      {
        venue_id: venueId,
        status: "unavailable",
        ready: false,
        reason_codes: reasonCodes,
      },
    ])) as PooledWorkerReadiness["venues"],
    checked_at: now.toISOString(),
  };
}

function workerEndpoint(env: Record<string, string | undefined>) {
  return env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL?.trim() ||
    env.GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_URL?.trim() ||
    "";
}

export function buildTriVenueAutopilotPolicy(strategy: "arb" | "maker" = "arb"): AutopilotSessionPolicy {
  const policy: Omit<AutopilotSessionPolicy, "policy_commitment"> = {
    strategy_id: strategy === "maker" ? "tri_venue_market_maker_v1" : "hedged_spread_arbitrage_v1",
    decision_model: "rules_plus_ai_score",
    ai_direct_enabled: false,
    venue_allowlist: ["phoenix", "hyperliquid", "backpack"],
    market_allowlist: ["SOL-USD"],
    max_notional_bucket: "5",
    max_position_notional_bucket: "50",
    max_loss_bucket: "25",
    max_daily_notional_bucket: "25",
    max_order_count: strategy === "maker" ? 2 : 4,
    ttl_ms: strategy === "maker" ? 10 * 60_000 : 60 * 60_000,
    max_slippage_bps: 25,
    cooldown_ms: 60_000,
    data_max_age_ms: 2_000,
    min_net_edge_bps: 25,
    max_execution_skew_ms: 2_000,
    min_ai_score_bps: 6_500,
    ai_min_confidence_bps: 6_500,
    min_signal_bps: 25,
    max_spread_bps: 150,
    allowed_order_types: ["perp_limit_order", "limit_order", "cancel"],
    kill_switch: false,
    reduce_only_on_reconcile_failure: true,
    locale_hint: "en",
    timezone: null,
  };
  return {
    ...policy,
    policy_commitment: gholaCommitment("tri_venue_autopilot_policy", policy),
  };
}

export function pooledTriVenueAccessForWorker() {
  return Object.fromEntries(TRI_VENUES.map((venueId) => [
    venueId,
    {
      status: "ready",
      execution_mode: "ghola_pooled",
      reason: "tri_venue_pooled_worker_owns_credentials",
    },
  ]));
}

export async function submitTriVenueWorkerCommand(input: {
  action: TriVenueAction;
  owner_commitment: string;
  payload?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const env = input.env ?? process.env;
  const cfg = workerConfig(env);
  if (!cfg.url) return { error: "worker_not_configured" as const, status: 503 };
  const path = `/autopilot/tri-venue/${input.action}`;
  const payload = {
    version: 1,
    market: "SOL-USD",
    owner_commitment: input.owner_commitment,
    venue_allowlist: TRI_VENUES,
    caps: {
      max_leg_notional_usd: "5",
      daily_notional_cap_usd: "25",
      max_slippage_bps: 25,
      max_execution_skew_ms: 2_000,
      max_market_data_skew_ms: 2_000,
    },
    ...(input.payload ?? {}),
  };
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: cfg.token,
    method: "POST",
    path,
    scope: input.action === "kill" ? "autopilot:control" : "order:submit",
    body: payload,
    expected: workerCapabilityExpectedFromBody(payload, {
      operation_class: "tri_venue_live",
      owner_commitment: input.owner_commitment,
    }),
  });
  if (!authorization) return { error: "worker_auth_missing" as const, status: 503 };
  const response = await (input.fetchImpl ?? fetch)(new URL(path, cfg.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response) return { error: "worker_unavailable" as const, status: 503 };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      error: errorString(body) ?? `worker_${response.status}`,
      status: response.status,
      worker_body: publicWorkerBody(body),
    };
  }
  return {
    status: response.status,
    body: publicWorkerBody(body),
  };
}

export function buildTriVenueOpportunities(input: {
  quotes: TriVenueQuote[];
  now?: Date;
  minNetEdgeBps?: number;
  maxSlippageBps?: number;
  maxDataAgeMs?: number;
}): TriVenueOpportunity[] {
  const now = input.now ?? new Date();
  const minNetEdge = input.minNetEdgeBps ?? 25;
  const maxSlippage = input.maxSlippageBps ?? 25;
  const maxDataAge = input.maxDataAgeMs ?? 2_000;
  const executable = input.quotes.filter((quote) => quote.best_bid && quote.best_ask && quote.status === "live");
  const opportunities: TriVenueOpportunity[] = [];
  for (const buy of executable) {
    for (const sell of executable) {
      if (buy.venue_id === sell.venue_id || !buy.best_ask || !sell.best_bid) continue;
      const ask = Number(buy.best_ask);
      const bid = Number(sell.best_bid);
      const mid = midpoint(ask, bid);
      if (!Number.isFinite(ask) || !Number.isFinite(bid) || !mid || ask <= 0 || bid <= 0) continue;
      const gross = ((bid - ask) / mid) * 10_000;
      const feeBuffer = TAKER_FEE_BUFFER_BPS[buy.venue_id] + TAKER_FEE_BUFFER_BPS[sell.venue_id];
      const net = roundBps(gross - feeBuffer - maxSlippage);
      const age = Math.max(buy.data_age_ms, sell.data_age_ms);
      const reasons = [
        ...(age <= maxDataAge ? [] : ["market_data_stale"]),
        ...(net >= minNetEdge ? [] : ["net_edge_below_policy"]),
      ];
      const status = reasons.length === 0 ? "preflight_pass" : "rejected";
      const legPlan = [
        {
          venue_id: buy.venue_id,
          side: "buy" as const,
          symbol: VENUE_SYMBOL[buy.venue_id],
          price: buy.best_ask,
          notional_usd: "5" as const,
          order_type: "ioc_limit" as const,
          reduce_only: false,
        },
        {
          venue_id: sell.venue_id,
          side: "sell" as const,
          symbol: VENUE_SYMBOL[sell.venue_id],
          price: sell.best_bid,
          notional_usd: "5" as const,
          order_type: "ioc_limit" as const,
          reduce_only: false,
        },
      ];
      opportunities.push({
        strategy: "delta_neutral",
        market: "SOL-USD",
        buy_venue: buy.venue_id,
        sell_venue: sell.venue_id,
        net_edge_bps: net,
        gross_edge_bps: roundBps(gross),
        fee_buffer_bps: feeBuffer,
        slippage_buffer_bps: maxSlippage,
        max_notional_usd: "5",
        status,
        reason_codes: reasons,
        data_age_ms: age,
        commitment: gholaCommitment("tri_venue_opportunity", {
          buy_venue: buy.venue_id,
          sell_venue: sell.venue_id,
          buy_price: buy.best_ask,
          sell_price: sell.best_bid,
          net,
          now: now.toISOString(),
        }),
        leg_plan: legPlan,
      });
    }
  }
  const maker = buildMakerOpportunity(executable, now, maxDataAge);
  return opportunities
    .sort((a, b) => b.net_edge_bps - a.net_edge_bps)
    .slice(0, 6)
    .concat(maker ? [maker] : []);
}

function buildMakerOpportunity(
  quotes: TriVenueQuote[],
  now: Date,
  maxDataAge: number,
): TriVenueOpportunity | null {
  const best = quotes
    .filter((quote) => quote.best_bid && quote.best_ask && quote.mid && quote.data_age_ms <= maxDataAge)
    .sort((a, b) => (a.spread_bps ?? Number.POSITIVE_INFINITY) - (b.spread_bps ?? Number.POSITIVE_INFINITY))[0];
  if (!best?.best_bid || !best.best_ask || !best.mid) return null;
  const mid = Number(best.mid);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const offset = Math.max(5, (best.spread_bps ?? 12) / 2);
  const bid = trimNumber(mid * (1 - offset / 10_000));
  const ask = trimNumber(mid * (1 + offset / 10_000));
  return {
    strategy: "market_making",
    market: "SOL-USD",
    net_edge_bps: roundBps(best.spread_bps ?? offset * 2),
    gross_edge_bps: roundBps(best.spread_bps ?? offset * 2),
    fee_buffer_bps: TAKER_FEE_BUFFER_BPS[best.venue_id],
    slippage_buffer_bps: 0,
    max_notional_usd: "5",
    status: "candidate",
    reason_codes: ["post_only_requires_live_worker"],
    data_age_ms: best.data_age_ms,
    commitment: gholaCommitment("tri_venue_maker_plan", {
      venue_id: best.venue_id,
      bid,
      ask,
      now: now.toISOString(),
    }),
    quote_plan: {
      venue_id: best.venue_id,
      symbol: VENUE_SYMBOL[best.venue_id],
      bid_price: bid,
      ask_price: ask,
      quote_ttl_ms: 10_000,
      post_only: true,
      max_resting_orders: 2,
      inventory_limit_usd: "5",
    },
  };
}

function quoteFromPhoenix(snapshot: PhoenixMarketSnapshot, now: Date): TriVenueQuote {
  return baseQuote("phoenix", {
    best_bid: snapshot.best_bid,
    best_ask: snapshot.best_ask,
    mid: snapshot.mid,
    mark_price: snapshot.mark_price,
    funding_rate: snapshot.funding_rate,
    open_interest: snapshot.open_interest,
    spread_bps: snapshot.spread_bps,
    timestamp: Date.parse(snapshot.book_updated_at || snapshot.fetched_at),
    stale: snapshot.stale,
  }, now);
}

function quoteFromHyperliquid(snapshot: HyperliquidMarketSnapshot, now: Date): TriVenueQuote {
  return baseQuote("hyperliquid", {
    best_bid: snapshot.best_bid,
    best_ask: snapshot.best_ask,
    mid: snapshot.mid,
    mark_price: snapshot.mark_price,
    funding_rate: snapshot.funding_rate,
    open_interest: snapshot.open_interest,
    spread_bps: snapshot.spread_bps,
    timestamp: snapshot.source_timestamp ?? Date.parse(snapshot.fetched_at),
    stale: snapshot.stale,
  }, now);
}

function quoteFromBackpack(snapshot: BackpackMarketSnapshot, now: Date): TriVenueQuote {
  return baseQuote("backpack", {
    best_bid: snapshot.best_bid,
    best_ask: snapshot.best_ask,
    mid: snapshot.mid,
    mark_price: snapshot.mark_price ?? snapshot.last_price,
    funding_rate: snapshot.funding_rate,
    open_interest: snapshot.open_interest,
    spread_bps: snapshot.spread_bps,
    timestamp: snapshot.source_timestamp ?? Date.parse(snapshot.fetched_at),
    stale: snapshot.stale,
  }, now);
}

function baseQuote(
  venueId: TriVenueId,
  input: {
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
    mark_price: string | null;
    funding_rate: string | null;
    open_interest: string | null;
    spread_bps: number | null;
    timestamp: number | null;
    stale: boolean;
  },
  now: Date,
): TriVenueQuote {
  const age = input.timestamp && Number.isFinite(input.timestamp)
    ? Math.max(0, now.getTime() - input.timestamp)
    : 0;
  const reasonCodes = [
    ...(input.stale ? ["snapshot_stale"] : []),
    ...(input.best_bid && input.best_ask ? [] : ["book_unavailable"]),
  ];
  return {
    venue_id: venueId,
    label: VENUE_LABEL[venueId],
    market: "SOL-USD",
    venue_symbol: VENUE_SYMBOL[venueId],
    best_bid: input.best_bid,
    best_ask: input.best_ask,
    mid: input.mid,
    mark_price: input.mark_price,
    funding_rate: input.funding_rate,
    open_interest: input.open_interest,
    spread_bps: input.spread_bps,
    data_age_ms: age,
    stale: input.stale,
    status: reasonCodes.length ? input.stale ? "stale" : "unavailable" : "live",
    reason_codes: reasonCodes,
  };
}

function venueGate(
  venueId: TriVenueId,
  env: Record<string, string | undefined>,
  workerReadiness: PooledWorkerReadiness,
): TriVenueStatus["gates"][number] {
  const workerGate = pooledWorkerVenueGateFromReadiness(venueId, workerReadiness);
  const reasonCodes: string[] = [];
  if (venueId === "hyperliquid" && env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED !== "true") {
    reasonCodes.push("hyperliquid_pilot_disabled");
  }
  if (venueId === "phoenix" && env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED !== "true") {
    reasonCodes.push("phoenix_pilot_disabled");
  }
  if (venueId === "backpack") {
    reasonCodes.push(...backpackPooledReadiness(env).reason_codes);
    if (env.GHOLA_VENUE_BACKPACK_PILOT_ENABLED !== "true") reasonCodes.push("backpack_pilot_disabled");
  }
  if (!workerGate.ok) reasonCodes.push(...workerGate.reason_codes);
  const uniqueReasons = unique(reasonCodes);
  return {
    id: venueId,
    label: VENUE_LABEL[venueId],
    status: uniqueReasons.length === 0 ? "green" : "red",
    reason_codes: uniqueReasons,
  };
}

function triVenuePolicyReasons(env: Record<string, string | undefined>, mode: "arb" | "maker") {
  const reasons: string[] = [];
  if (env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED !== "true") reasons.push("live_trading_public_flag_disabled");
  if (mode === "arb" && env.PRIVATE_AGENT_TRI_VENUE_ARB_LIVE_SUBMIT !== "true") {
    reasons.push("tri_venue_arb_live_submit_disabled");
  }
  if (mode === "maker" && env.PRIVATE_AGENT_MARKET_MAKER_LIVE_SUBMIT !== "true") {
    reasons.push("market_maker_live_submit_disabled");
  }
  if (positiveNumber(env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD) !== 5) {
    reasons.push("max_leg_notional_must_be_5");
  }
  if (positiveNumber(env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD) !== 25) {
    reasons.push("daily_notional_cap_must_be_25");
  }
  if (positiveInteger(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 0) < 25) {
    reasons.push("min_net_edge_bps_below_25");
  }
  if (positiveInteger(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 0) > 2_000 || !env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS) {
    reasons.push("max_execution_skew_ms_missing_or_too_high");
  }
  if (positiveInteger(env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS, 0) > 2_000 || !env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS) {
    reasons.push("max_market_data_skew_ms_missing_or_too_high");
  }
  if (mode === "maker") {
    if (positiveInteger(env.PRIVATE_AGENT_MM_MAX_RESTING_ORDERS, 0) !== 2) {
      reasons.push("maker_max_resting_orders_must_be_2");
    }
    if (positiveInteger(env.PRIVATE_AGENT_MM_QUOTE_TTL_MS, 0) !== 10_000) {
      reasons.push("maker_quote_ttl_must_be_10000");
    }
  }
  return unique(reasons);
}

function workerConfig(env: Record<string, string | undefined>) {
  const url = env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.PHALA_AGENT_ENDPOINT?.trim() ||
    "";
  const token = env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PHALA_CLOUD_API_KEY?.trim() ||
    "";
  return { url, token };
}

function publicWorkerBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function errorString(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

function midpoint(a: number, b: number) {
  const mid = (a + b) / 2;
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

function roundBps(value: number) {
  return Math.round(value * 100) / 100;
}

function trimNumber(value: number) {
  return Number(value.toFixed(6)).toString();
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
