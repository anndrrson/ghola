import type { GholaChartMode } from "./ghola-market-chart";

export const TERMINAL_WORKSPACE_VERSION = 1 as const;
export const TERMINAL_WORKSPACE_LEGACY_STORAGE_KEY = "ghola.terminal-workspace.v1";
export const TERMINAL_WORKSPACE_STORAGE_PREFIX = "ghola.terminal-workspace.v2:";
export const TERMINAL_WORKSPACE_GUEST_SCOPE = "device_guest";
export const TERMINAL_WORKSPACE_STORAGE_KEY =
  `${TERMINAL_WORKSPACE_STORAGE_PREFIX}${TERMINAL_WORKSPACE_GUEST_SCOPE}`;
export const TERMINAL_MARKET_RAIL_WIDTH_PX = { min: 240, max: 360, default: 288 } as const;
export const TERMINAL_TICKET_WIDTH_PX = { min: 320, max: 480, default: 400 } as const;
export const TERMINAL_SIDE_COLUMNS_MAX_PX = 776;
const PERSISTENCE_SCOPE_PATTERN = /^(?:device_guest|subject_[a-f0-9]{32})$/u;
export type TerminalChartStudy = "ema20" | "ema50" | "vwap" | "volumeProfile" | "structure" | "orderFlow" | "multiTimeframe";

export interface TerminalWorkspace {
  version: typeof TERMINAL_WORKSPACE_VERSION;
  venue: "hyperliquid" | "phoenix" | "coinbase";
  market: "BTC" | "ETH" | "SOL" | "HYPE";
  network: "mainnet" | "testnet";
  interval: "1m" | "5m" | "15m" | "1h";
  chartSurface: "terminal" | "plan";
  chartMode: GholaChartMode;
  chartStudies: TerminalChartStudy[];
  side: "buy" | "sell";
  notionalUsd: number;
  riskBudgetUsd: number;
  slippageBps: 25 | 50 | 100;
  targetRewardMultiple: 1 | 1.5 | 2 | 3;
  bookOpen: boolean;
  bookView: "ladder" | "book";
  marketRailWidthPx: number;
  ticketWidthPx: number;
}

export type TerminalWorkspaceInspection =
  | { status: "absent"; workspace: null; raw: null }
  | { status: "ready"; workspace: TerminalWorkspace; raw: string }
  | { status: "blocked"; workspace: null; raw: string };

export function terminalWorkspaceStorageKey(
  persistenceScope: string | null | undefined,
): string | null {
  return typeof persistenceScope === "string" && PERSISTENCE_SCOPE_PATTERN.test(persistenceScope)
    ? `${TERMINAL_WORKSPACE_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export function defaultTerminalWorkspace(): TerminalWorkspace {
  return {
    version: TERMINAL_WORKSPACE_VERSION,
    venue: "hyperliquid",
    market: "BTC",
    network: "mainnet",
    interval: "5m",
    chartSurface: "terminal",
    chartMode: "candles",
    chartStudies: ["vwap"],
    side: "buy",
    notionalUsd: 10,
    riskBudgetUsd: 1,
    slippageBps: 50,
    targetRewardMultiple: 2,
    bookOpen: true,
    bookView: "ladder",
    marketRailWidthPx: TERMINAL_MARKET_RAIL_WIDTH_PX.default,
    ticketWidthPx: TERMINAL_TICKET_WIDTH_PX.default,
  };
}

export function parseTerminalWorkspace(value: string | null | undefined): TerminalWorkspace | null {
  if (!value) return null;
  try {
    return validateTerminalWorkspace(JSON.parse(value));
  } catch {
    return null;
  }
}

export function inspectTerminalWorkspace(
  value: string | null | undefined,
): TerminalWorkspaceInspection {
  if (value == null) return { status: "absent", workspace: null, raw: null };
  try {
    const workspace = validateTerminalWorkspace(JSON.parse(value));
    return workspace
      ? { status: "ready", workspace, raw: value }
      : { status: "blocked", workspace: null, raw: value };
  } catch {
    return { status: "blocked", workspace: null, raw: value };
  }
}

export function serializeTerminalWorkspace(value: TerminalWorkspace): string {
  const valid = validateTerminalWorkspace(value);
  if (!valid) throw new Error("terminal_workspace_invalid");
  return JSON.stringify(valid);
}

export function terminalWorkspaceEqual(
  left: TerminalWorkspace,
  right: TerminalWorkspace,
) {
  return serializeTerminalWorkspace(left) === serializeTerminalWorkspace(right);
}

export function terminalWorkspaceConcurrentConflict(input: {
  local: TerminalWorkspace;
  previousValue: string | null;
  incoming: TerminalWorkspace;
}) {
  const previousInspection = inspectTerminalWorkspace(input.previousValue);
  if (previousInspection.status === "blocked") return true;
  const previous = previousInspection.workspace ?? defaultTerminalWorkspace();
  return !terminalWorkspaceEqual(input.local, previous)
    && !terminalWorkspaceEqual(input.incoming, previous)
    && !terminalWorkspaceEqual(input.local, input.incoming);
}

export function validateTerminalWorkspace(value: unknown): TerminalWorkspace | null {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!row || row.version !== TERMINAL_WORKSPACE_VERSION) return null;
  const venue = enumValue(row.venue, ["hyperliquid", "phoenix", "coinbase"] as const);
  const market = enumValue(row.market, ["BTC", "ETH", "SOL", "HYPE"] as const);
  const network = enumValue(row.network, ["mainnet", "testnet"] as const);
  const interval = enumValue(row.interval, ["1m", "5m", "15m", "1h"] as const);
  const chartSurface = enumValue(row.chartSurface, ["terminal", "plan"] as const);
  const chartMode = enumValue(row.chartMode, ["candles", "line", "depth", "compare", "route", "slippage", "quote"] as const);
  const chartStudies = chartStudyValues(row.chartStudies);
  const side = enumValue(row.side, ["buy", "sell"] as const);
  const slippageBps = enumValue(row.slippageBps, [25, 50, 100] as const);
  const targetRewardMultiple = row.targetRewardMultiple == null
    ? 2
    : enumValue(row.targetRewardMultiple, [1, 1.5, 2, 3] as const);
  const bookView = row.bookView == null
    ? "ladder"
    : enumValue(row.bookView, ["ladder", "book"] as const);
  const notionalUsd = Number(row.notionalUsd);
  const riskBudgetUsd = row.riskBudgetUsd == null ? 1 : Number(row.riskBudgetUsd);
  const marketRailWidthPx = boundedIntegerOrDefault(row.marketRailWidthPx, TERMINAL_MARKET_RAIL_WIDTH_PX);
  const ticketWidthPx = boundedIntegerOrDefault(row.ticketWidthPx, TERMINAL_TICKET_WIDTH_PX);
  if (!venue || !market || !network || !interval || !chartSurface || !chartMode || !chartStudies || !side || !slippageBps || !targetRewardMultiple || !bookView) return null;
  if (marketRailWidthPx == null || ticketWidthPx == null) return null;
  if (marketRailWidthPx + ticketWidthPx > TERMINAL_SIDE_COLUMNS_MAX_PX) return null;
  if (!boundedCents(notionalUsd, 1, 100)) return null;
  if (!Number.isFinite(riskBudgetUsd) || riskBudgetUsd <= 0 || riskBudgetUsd > 100) return null;
  if (typeof row.bookOpen !== "boolean") return null;
  if (!venueSupportsMarket(venue, market)) return null;
  if (network === "testnet" && venue !== "hyperliquid") return null;
  if (chartSurface === "plan" && !["candles", "line", "depth", "compare"].includes(chartMode)) return null;
  return {
    version: TERMINAL_WORKSPACE_VERSION,
    venue,
    market,
    network,
    interval,
    chartSurface,
    chartMode,
    chartStudies,
    side,
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    riskBudgetUsd,
    slippageBps,
    targetRewardMultiple,
    bookOpen: row.bookOpen,
    bookView,
    marketRailWidthPx,
    ticketWidthPx,
  };
}

function chartStudyValues(value: unknown): TerminalChartStudy[] | null {
  if (value == null) return ["vwap"];
  if (!Array.isArray(value) || value.length > 7) return null;
  const allowed = new Set<TerminalChartStudy>(["ema20", "ema50", "vwap", "volumeProfile", "structure", "orderFlow", "multiTimeframe"]);
  if (!value.every((study) => typeof study === "string" && allowed.has(study as TerminalChartStudy))) return null;
  return Array.from(new Set(value as TerminalChartStudy[]));
}

function venueSupportsMarket(venue: TerminalWorkspace["venue"], market: TerminalWorkspace["market"]) {
  if (venue === "phoenix") return market === "SOL";
  if (venue === "coinbase") return market === "BTC" || market === "ETH" || market === "SOL";
  return true;
}

function enumValue<T extends string | number>(value: unknown, values: readonly T[]): T | null {
  return values.includes(value as T) ? value as T : null;
}

function boundedCents(value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

function boundedIntegerOrDefault(
  value: unknown,
  bounds: Readonly<{ min: number; max: number; default: number }>,
) {
  if (value == null) return bounds.default;
  return Number.isInteger(value) && Number(value) >= bounds.min && Number(value) <= bounds.max
    ? Number(value)
    : null;
}
