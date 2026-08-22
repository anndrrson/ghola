import {
  normalizePerpsMandate,
  type PerpsMandateV1,
  type PerpsMarginMode,
  type PerpsNetwork,
} from "@ghola/perps-core";

export interface GholaPerpsRiskInputs {
  markets: string[];
  marginMode: PerpsMarginMode;
  leverage: number;
  maxOrderUsd: number;
  maxGrossUsd: number;
  maxDailyNotionalUsd: number;
  dailyLossUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownBps: number;
  maxSlippageBps: number;
  stopLossBps: number;
  maxOpenOrders: number;
  maxOrdersPerDay: number;
  expiresInHours: number;
}

export const DEFAULT_GHOLA_PERPS_RISK: GholaPerpsRiskInputs = Object.freeze({
  markets: ["BTC", "ETH", "SOL"],
  marginMode: "isolated",
  leverage: 2,
  maxOrderUsd: 25,
  maxGrossUsd: 50,
  maxDailyNotionalUsd: 100,
  dailyLossUsd: 10,
  maxDrawdownUsd: 15,
  maxDrawdownBps: 1_500,
  maxSlippageBps: 50,
  stopLossBps: 500,
  maxOpenOrders: 4,
  maxOrdersPerDay: 20,
  expiresInHours: 24,
});

interface SearchParamsReader {
  get(name: string): string | null;
}

export function riskFromMobileSetupQuery(search: SearchParamsReader): GholaPerpsRiskInputs | null {
  if (search.get("risk_source") !== "mobile_v1") return null;
  const markets = (search.get("risk_markets") || "")
    .split(",")
    .map((market) => market.trim().toUpperCase())
    .filter(Boolean);
  const leverage = queryInteger(search, "risk_leverage");
  const maxOrderUsd = queryInteger(search, "risk_max_order_usd");
  const maxGrossUsd = queryInteger(search, "risk_max_gross_usd");
  const dailyLossUsd = queryInteger(search, "risk_daily_loss_usd");
  const maxSlippageBps = queryInteger(search, "risk_slippage_bps");
  const stopLossBps = queryInteger(search, "risk_stop_loss_bps");
  if (
    markets.length < 1 || markets.length > 20 ||
    markets.some((market) => !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(market)) ||
    leverage == null || leverage < 1 || leverage > 5 ||
    maxOrderUsd == null || maxOrderUsd < 5 || maxOrderUsd > 1_000 ||
    maxGrossUsd == null || maxGrossUsd < maxOrderUsd || maxGrossUsd > 5_000 ||
    dailyLossUsd == null || dailyLossUsd < 1 || dailyLossUsd > maxGrossUsd ||
    maxSlippageBps == null || maxSlippageBps < 1 || maxSlippageBps > 200 ||
    stopLossBps == null || stopLossBps < 25 || stopLossBps > 2_000
  ) return null;
  return {
    ...DEFAULT_GHOLA_PERPS_RISK,
    markets: [...new Set(markets)],
    leverage,
    maxOrderUsd,
    maxGrossUsd,
    maxDailyNotionalUsd: Math.max(DEFAULT_GHOLA_PERPS_RISK.maxDailyNotionalUsd, maxOrderUsd),
    dailyLossUsd,
    maxDrawdownUsd: Math.min(DEFAULT_GHOLA_PERPS_RISK.maxDrawdownUsd, dailyLossUsd),
    maxSlippageBps,
    stopLossBps,
  };
}

export function buildGholaPerpsMandate(input: {
  mandateId: string;
  network: PerpsNetwork;
  ownerAddress: string;
  agentAddress: string;
  risk: GholaPerpsRiskInputs;
  jurisdictionEligible: boolean;
  acceptedRisk: boolean;
  nowMs?: number;
  killSwitch?: boolean;
}): Readonly<PerpsMandateV1> {
  const now = input.nowMs ?? Date.now();
  return normalizePerpsMandate({
    version: 1,
    mandate_id: input.mandateId,
    network: input.network,
    owner_address: input.ownerAddress,
    agent_address: input.agentAddress,
    execution_address: input.ownerAddress,
    allowed_markets: input.risk.markets,
    margin_mode: input.risk.marginMode,
    configured_leverage: input.risk.leverage,
    max_leverage: input.risk.leverage,
    max_order_notional_micro_usdc: usdToMicro(input.risk.maxOrderUsd, "max order"),
    max_gross_exposure_micro_usdc: usdToMicro(input.risk.maxGrossUsd, "max gross exposure"),
    max_daily_notional_micro_usdc: usdToMicro(input.risk.maxDailyNotionalUsd, "daily notional"),
    daily_loss_limit_micro_usdc: usdToMicro(input.risk.dailyLossUsd, "daily loss"),
    max_drawdown_micro_usdc: usdToMicro(input.risk.maxDrawdownUsd, "drawdown"),
    max_drawdown_bps: input.risk.maxDrawdownBps,
    max_slippage_bps: input.risk.maxSlippageBps,
    stop_loss_bps: input.risk.stopLossBps,
    max_open_orders: input.risk.maxOpenOrders,
    max_orders_per_day: input.risk.maxOrdersPerDay,
    data_max_age_ms: 30_000,
    expires_at_ms: now + input.risk.expiresInHours * 60 * 60 * 1_000,
    kill_switch: input.killSwitch === true,
    jurisdiction: {
      eligible: input.jurisdictionEligible,
      accepted_risk: input.acceptedRisk,
      attested_at_ms: now,
      terms_version: "ghola-hyperliquid-risk-2026-08",
    },
  });
}

export function setupStep(input: {
  turnkeyConfigured: boolean;
  authenticated: boolean;
  walletsReady: boolean;
  delegationReady: boolean;
  mandateSigned: boolean;
  active: boolean;
}) {
  if (!input.turnkeyConfigured) return "configure_turnkey" as const;
  if (!input.authenticated) return "authenticate" as const;
  if (!input.walletsReady) return "create_wallets" as const;
  if (!input.delegationReady) return "delegate" as const;
  if (!input.mandateSigned) return "sign_mandate" as const;
  if (!input.active) return "activate" as const;
  return "active" as const;
}

function usdToMicro(value: number, label: string) {
  const result = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}

function queryInteger(search: SearchParamsReader, name: string) {
  const raw = search.get(name);
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
