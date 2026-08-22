export type VenueId = "hyperliquid" | "drift" | "coinbase_advanced" | "jupiter";
export type StrategyId = "best_execution" | "spot_perp_hedge" | "delta_neutral_carry" | "exposure_rebalance";
export declare const EXECUTION_CORE_VERSION: 1;
export declare const SUPPORTED_EXECUTION_VENUES: readonly VenueId[];
export declare const SUPPORTED_STRATEGIES: readonly StrategyId[];
export declare const PORTFOLIO_SIGNING_BOUNDARY: Readonly<Record<string, readonly string[]>>;
export declare class ExecutionCoreError extends Error { code: string; }
export declare function normalizePortfolioMandate(value: unknown): Readonly<Record<string, unknown>>;
export declare function normalizePortfolioState(value: unknown): Readonly<Record<string, unknown>>;
export declare function assessVenueReadiness(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function rankExecutionRoutes(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function evaluatePortfolioPlan(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function createMultiLegSaga(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function advanceMultiLegSaga(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function normalizeVenueAccountingSnapshot(input: unknown): Readonly<Record<string, unknown>>;
export declare function aggregatePortfolioAccounting(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function reconcilePortfolioAccounting(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export declare function buildExecutionQualityReceipt(input: unknown): Readonly<Record<string, unknown>>;
export declare function aggregateExecutionQuality(input: unknown[]): Readonly<Record<string, unknown>>;
