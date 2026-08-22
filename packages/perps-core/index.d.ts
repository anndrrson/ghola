export type PerpsNetwork = "testnet" | "mainnet";
export type PerpsOperation = "order" | "cancel" | "reduce_only";
export type PerpsMarginMode = "cross" | "isolated";

export interface PerpsMandateV1 {
  version: 1;
  mandate_id: string;
  network: PerpsNetwork;
  owner_address: string;
  agent_address: string;
  execution_address: string;
  allowed_markets: string[];
  margin_mode: PerpsMarginMode;
  configured_leverage: number;
  max_leverage: number;
  max_order_notional_micro_usdc: number;
  max_gross_exposure_micro_usdc: number;
  max_daily_notional_micro_usdc: number;
  daily_loss_limit_micro_usdc: number;
  max_drawdown_micro_usdc: number;
  max_drawdown_bps: number;
  max_slippage_bps: number;
  stop_loss_bps: number;
  max_open_orders: number;
  max_orders_per_day: number;
  data_max_age_ms: number;
  expires_at_ms: number;
  kill_switch: boolean;
  jurisdiction: {
    eligible: boolean;
    accepted_risk: boolean;
    attested_at_ms: number;
    terms_version: string;
  };
}

export interface PerpsRiskStateV1 {
  as_of_ms: number;
  equity_micro_usdc: number;
  day_start_equity_micro_usdc: number;
  peak_equity_micro_usdc: number;
  gross_exposure_micro_usdc: number;
  daily_notional_micro_usdc: number;
  orders_today: number;
  open_order_count: number;
  managed_open_order_ids: string[];
  position_notional_micro_usdc: Record<string, number>;
}

export interface PerpsIntentV1 {
  version: 1;
  operation: PerpsOperation;
  network: PerpsNetwork;
  owner_address: string;
  agent_address: string;
  execution_address: string;
  order_id?: string;
  market?: string;
  side?: "buy" | "sell";
  notional_micro_usdc?: number;
  projected_gross_exposure_micro_usdc?: number | null;
  reference_price_e8?: number;
  limit_price_e8?: number;
  stop_loss_price_e8?: number;
  slippage_bps?: number;
  leverage?: number;
  venue_max_leverage?: number;
  margin_mode?: PerpsMarginMode;
  reduce_only?: boolean;
}

export interface PerpsRiskDecisionV1 {
  version: 1;
  allowed: boolean;
  action_class: PerpsOperation | "invalid";
  reasons: readonly string[];
  risk: null | {
    daily_loss_micro_usdc: number;
    drawdown_micro_usdc: number;
    drawdown_bps: number;
    gross_exposure_micro_usdc: number;
    checked_at_ms: number;
  };
  signing_boundary: typeof HYPERLIQUID_SIGNING_BOUNDARY;
}

export const GHOLA_PERPS_VERSION: 1;
export const PERPS_OPERATIONS: readonly PerpsOperation[];
export const HYPERLIQUID_SIGNING_BOUNDARY: Readonly<{
  turnkey_enforced: readonly string[];
  application_enforced: readonly string[];
  owner_only: readonly string[];
}>;
export class PerpsRiskError extends Error { code: string }
export function normalizePerpsMandate(value: unknown): Readonly<PerpsMandateV1 & { allowed_operations: readonly PerpsOperation[] }>;
export function evaluatePerpsIntent(input: { mandate: unknown; intent: unknown; state: unknown; now_ms?: number }): PerpsRiskDecisionV1;
export function buildTurnkeyHyperliquidPolicies(input: { delegated_user_id: string; owner_address: string; agent_address: string }): readonly Readonly<{ policyName: string; effect: "EFFECT_ALLOW" | "EFFECT_DENY"; consensus: string; condition: string; notes: string }>[];
export function canonicalPerpsJson(value: unknown): string;
export function ownerMandateMessage(mandate: unknown): string;
