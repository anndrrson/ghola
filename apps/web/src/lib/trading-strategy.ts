import { sha256 } from "@noble/hashes/sha256";

export type TradingStrategyMode = "prepare_only" | "capped_session_key";

export type TradingStrategyTrigger =
  | {
      kind: "dca_schedule";
      asset: string;
      cadence: "daily" | "weekly";
      day_of_week?: number;
      amount_micro_usdc: number;
    }
  | {
      kind: "price_above" | "price_below";
      asset: string;
      price_usd: number;
      side: "buy" | "sell";
    }
  | {
      kind: "percent_change_24h";
      asset: string;
      direction: "up" | "down";
      percent: number;
      side: "buy" | "sell";
    }
  | {
      kind: "rebalance_allocation";
      allocations: Array<{ asset: string; target_bps: number }>;
    }
  | {
      kind: "alert_only";
      asset?: string;
      condition: string;
    };

export interface TradingSessionKeyPolicy {
  key_id?: string;
  expires_at: string;
  max_trade_micro_usdc: number;
  daily_cap_micro_usdc: number;
}

export interface TradingStrategyPolicyV1 {
  version: 1;
  strategy_id: string;
  owner_did: string;
  source_hash: string;
  created_at: string;
  expires_at: string;
  mode: TradingStrategyMode;
  trigger: TradingStrategyTrigger;
  allowed_assets: string[];
  quote_asset: "USDC";
  max_trade_micro_usdc: number;
  daily_cap_micro_usdc: number;
  max_actions_per_day: number;
  max_slippage_bps: number;
  allowed_venues: ["railgun_private_swap"];
  public_venue_policy: "deny";
  unshield_policy: "deny";
  amount_bucket_micro_usdc: number[];
  min_delay_seconds: number;
  require_user_confirmation: boolean;
  session_key?: TradingSessionKeyPolicy;
}

export interface TradingStrategyRecord {
  id: string;
  source: string;
  policy: TradingStrategyPolicyV1;
  review_summary: string;
  receipts?: TradingStrategyReceiptV1[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TradingStrategyReceiptV1 {
  version: 1;
  strategy_id: string;
  policy_hash: string;
  source_hash: string;
  proposal_hash: string;
  guard_ok: boolean;
  guard_reason?: string;
  mode: TradingStrategyMode;
  venue: string;
  amount_bucket_micro_usdc: number;
  created_at: string;
  tx_ref?: string;
}

export type CompileTradingStrategyResult =
  | {
      ok: true;
      policy: TradingStrategyPolicyV1;
      review_summary: string;
      warnings: string[];
    }
  | {
      ok: false;
      reason: string;
      field_hints: string[];
    };

const DEFAULT_BUCKETS = [25, 50, 100, 250, 500, 1000].map((usd) =>
  usdToMicro(usd),
);
const DEFAULT_MAX_SLIPPAGE_BPS = 50;
const DEFAULT_MIN_DELAY_SECONDS = 300;
const DEFAULT_EXPIRY_DAYS = 30;
const DEFAULT_ACTIONS_PER_DAY = 3;

const DAY_LOOKUP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

export function formatStrategyUsd(micro: number): string {
  return `$${microToUsd(micro).toFixed(2)}`;
}

export function hashTradingStrategyValue(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(stableJson(value))));
}

export function summarizeTradingPolicy(policy: TradingStrategyPolicyV1): string {
  const action =
    policy.trigger.kind === "alert_only"
      ? "Alert only"
      : `${formatStrategyUsd(policy.max_trade_micro_usdc)} max private action`;
  const assets = policy.allowed_assets.join(", ");
  const mode =
    policy.mode === "capped_session_key"
      ? "capped session key"
      : "user approval";
  return `${action} for ${assets}; ${mode}; shielded venues only.`;
}

export function compileTradingStrategy(
  source: string,
  ownerDid: string,
  options: {
    now?: Date;
    mode?: TradingStrategyMode;
  } = {},
): CompileTradingStrategyResult {
  const trimmed = source.trim();
  if (trimmed.length < 8) {
    return {
      ok: false,
      reason: "Strategy is too short to compile safely.",
      field_hints: ["Add an asset, amount, trigger, and action."],
    };
  }
  if (trimmed.length > 1200) {
    return {
      ok: false,
      reason: "Strategy is too long for v1.",
      field_hints: ["Keep the strategy under 1200 characters."],
    };
  }

  const now = options.now ?? new Date();
  const trigger = parseTrigger(trimmed);
  if (!trigger) {
    return {
      ok: false,
      reason: "Could not convert this into a deterministic v1 policy.",
      field_hints: [
        "Use DCA, price above/below, 24h percent change, rebalance, or alert-only wording.",
      ],
    };
  }

  const tradeAmount = amountForTrigger(trigger, trimmed);
  if (trigger.kind !== "alert_only" && tradeAmount <= 0) {
    return {
      ok: false,
      reason: "Trading strategies need an explicit dollar amount.",
      field_hints: ["Add wording like '$25', '$50', or 'max $100'."],
    };
  }

  const allowedAssets = assetsForTrigger(trigger);
  const maxTrade = trigger.kind === "alert_only" ? 0 : tradeAmount;
  const dailyCap =
    trigger.kind === "dca_schedule"
      ? maxTrade
      : Math.max(maxTrade, maxTrade * DEFAULT_ACTIONS_PER_DAY);
  const warnings: string[] = [];
  if (trigger.kind !== "alert_only" && !DEFAULT_BUCKETS.includes(maxTrade)) {
    warnings.push(
      `Execution will round to an approved amount bucket before signing.`,
    );
  }

  const policy: TradingStrategyPolicyV1 = {
    version: 1,
    strategy_id: randomId("strategy"),
    owner_did: ownerDid,
    source_hash: hashTradingStrategyValue({ v: 1, source: trimmed }),
    created_at: now.toISOString(),
    expires_at: addDays(now, DEFAULT_EXPIRY_DAYS).toISOString(),
    mode: options.mode ?? "prepare_only",
    trigger,
    allowed_assets: allowedAssets,
    quote_asset: "USDC",
    max_trade_micro_usdc: maxTrade,
    daily_cap_micro_usdc: dailyCap,
    max_actions_per_day:
      trigger.kind === "dca_schedule" || trigger.kind === "alert_only"
        ? 1
        : DEFAULT_ACTIONS_PER_DAY,
    max_slippage_bps: DEFAULT_MAX_SLIPPAGE_BPS,
    allowed_venues: ["railgun_private_swap"],
    public_venue_policy: "deny",
    unshield_policy: "deny",
    amount_bucket_micro_usdc: DEFAULT_BUCKETS,
    min_delay_seconds: DEFAULT_MIN_DELAY_SECONDS,
    require_user_confirmation: options.mode !== "capped_session_key",
  };

  return {
    ok: true,
    policy,
    review_summary: summarizeTradingPolicy(policy),
    warnings,
  };
}

function parseTrigger(source: string): TradingStrategyTrigger | null {
  const text = source.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  const dca = text.match(
    /\bdca\b.*?\$?([\d,.]+)\s+(?:into|in|to|of)\s+([a-z0-9-]+)/i,
  );
  if (dca) {
    const cadence = /\b(daily|every day)\b/i.test(text) ? "daily" : "weekly";
    const dayName = Object.keys(DAY_LOOKUP).find((day) =>
      lower.includes(day),
    );
    return {
      kind: "dca_schedule",
      asset: normalizeAsset(dca[2]),
      cadence,
      ...(dayName ? { day_of_week: DAY_LOOKUP[dayName] } : {}),
      amount_micro_usdc: usdToMicro(parseUsd(dca[1])),
    };
  }

  const rebalance = lower.match(/\brebalance\b/)
    ? parseAllocations(text)
    : null;
  if (rebalance && rebalance.length >= 2) {
    return {
      kind: "rebalance_allocation",
      allocations: rebalance,
    };
  }

  const pct = text.match(
    /\b([a-z0-9-]{2,16})\b.*?\b(drops?|falls?|down|rises?|jumps?|up)\b.*?([\d.]+)\s*%/i,
  );
  if (pct) {
    const direction = /drop|fall|down/i.test(pct[2]) ? "down" : "up";
    return {
      kind: "percent_change_24h",
      asset: normalizeAsset(pct[1]),
      direction,
      percent: parseFloat(pct[3]),
      side: direction === "down" ? "buy" : "sell",
    };
  }

  const price = text.match(
    /\b([a-z0-9-]{2,16})\b.*?\b(above|over|greater than|below|under|less than)\b\s*\$?([\d,.]+)/i,
  );
  if (price) {
    const above = /above|over|greater/i.test(price[2]);
    const alertOnly = /\balert\b|\bnotify\b/i.test(text);
    return alertOnly
      ? {
          kind: "alert_only",
          asset: normalizeAsset(price[1]),
          condition: `${normalizeAsset(price[1])} ${above ? "above" : "below"} $${parseUsd(price[3])}`,
        }
      : {
          kind: above ? "price_above" : "price_below",
          asset: normalizeAsset(price[1]),
          price_usd: parseUsd(price[3]),
          side: above ? "sell" : "buy",
        };
  }

  if (/\balert\b|\bnotify\b/i.test(text)) {
    const asset = text.match(/\b(BTC|ETH|SOL|USDC|USDT|ARB|OP|MATIC)\b/i)?.[1];
    return {
      kind: "alert_only",
      ...(asset ? { asset: normalizeAsset(asset) } : {}),
      condition: text.slice(0, 180),
    };
  }

  return null;
}

function parseAllocations(
  source: string,
): Array<{ asset: string; target_bps: number }> | null {
  const out: Array<{ asset: string; target_bps: number }> = [];
  const re = /(\d{1,3}(?:\.\d+)?)\s*%\s*([a-z0-9-]{2,16})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    out.push({
      asset: normalizeAsset(match[2]),
      target_bps: Math.round(parseFloat(match[1]) * 100),
    });
  }
  const total = out.reduce((sum, item) => sum + item.target_bps, 0);
  if (out.length < 2 || total !== 10_000) return null;
  return out;
}

function amountForTrigger(trigger: TradingStrategyTrigger, source: string): number {
  if (trigger.kind === "alert_only") return 0;
  if (trigger.kind === "dca_schedule") return trigger.amount_micro_usdc;
  const explicit = source.match(/(?:max\s*)?\$([\d,.]+)/i);
  if (!explicit) return 0;
  return usdToMicro(parseUsd(explicit[1]));
}

function assetsForTrigger(trigger: TradingStrategyTrigger): string[] {
  const assets =
    trigger.kind === "rebalance_allocation"
      ? trigger.allocations.map((item) => item.asset)
      : trigger.asset
        ? [trigger.asset]
        : [];
  return Array.from(new Set([...assets, "USDC"]));
}

function normalizeAsset(asset: string): string {
  return asset.replace(/[^a-z0-9-]/gi, "").toUpperCase();
}

function parseUsd(raw: string): number {
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
