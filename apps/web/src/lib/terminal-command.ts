export type TerminalTicketField = "notional" | "entry" | "invalidation" | "risk_budget";

export type TerminalCommand =
  | { type: "select_venue"; venue: "hyperliquid" | "phoenix" | "coinbase" }
  | { type: "select_market"; market: "BTC" | "ETH" | "SOL" | "HYPE" }
  | { type: "select_interval"; interval: "1m" | "5m" | "15m" | "1h" }
  | { type: "select_side"; side: "buy" | "sell" }
  | { type: "set_notional"; notionalUsd: number }
  | { type: "set_slippage"; slippageBps: 25 | 50 | 100 }
  | { type: "set_chart_mode"; mode: "candles" | "line" | "depth" | "compare" }
  | { type: "toggle_study"; study: "ema20" | "ema50" | "vwap" | "volumeProfile" | "structure" | "orderFlow" | "multiTimeframe" }
  | { type: "toggle_book" }
  | { type: "set_depth_view"; view: "ladder" | "book" }
  | { type: "fit_chart" }
  | { type: "toggle_replay" }
  | { type: "open_chart" }
  | { type: "open_alerts" }
  | { type: "open_paper" }
  | { type: "open_ticket" }
  | { type: "open_risk_desk" }
  | { type: "open_scanner" }
  | { type: "open_execution_analytics" }
  | { type: "open_route_check" }
  | { type: "open_plan_book" }
  | { type: "reconnect_market" }
  | { type: "focus_ticket_field"; field: TerminalTicketField }
  | { type: "stage_entry_price"; mode: "auto" | "join" | "cross" }
  | { type: "stage_safe_sized_entry"; mode: "join" | "cross" }
  | { type: "cycle_slippage" }
  | { type: "reset_plan_levels" };

export interface TerminalCommandDefinition {
  id: string;
  label: string;
  keywords: string;
  shortcut?: string;
  command: TerminalCommand;
}

export function terminalCommandCatalog(): TerminalCommandDefinition[] {
  return [
    ...(["hyperliquid", "phoenix", "coinbase"] as const).map((venue) => ({
      id: `venue-${venue}`, label: `Venue: ${title(venue)}`, keywords: `exchange route ${venue}`, command: { type: "select_venue" as const, venue },
    })),
    ...(["BTC", "ETH", "SOL", "HYPE"] as const).map((market) => ({
      id: `market-${market}`, label: `Market: ${market}`, keywords: `symbol instrument ${market.toLowerCase()}`, command: { type: "select_market" as const, market },
    })),
    ...(["1m", "5m", "15m", "1h"] as const).map((interval, index) => ({
      id: `interval-${interval}`, label: `Interval: ${interval}`, keywords: `timeframe chart ${interval}`, shortcut: String(index + 1), command: { type: "select_interval" as const, interval },
    })),
    { id: "side-buy", label: "Order side: Buy", keywords: "long bid", shortcut: "B", command: { type: "select_side", side: "buy" } },
    { id: "side-sell", label: "Order side: Sell", keywords: "short ask", shortcut: "S", command: { type: "select_side", side: "sell" } },
    ...([10, 25, 50, 100] as const).map((notionalUsd) => ({
      id: `notional-${notionalUsd}`, label: `Order value: $${notionalUsd}`, keywords: `size amount usd ${notionalUsd}`, command: { type: "set_notional" as const, notionalUsd },
    })),
    ...([25, 50, 100] as const).map((slippageBps) => ({
      id: `slippage-${slippageBps}`, label: `Slippage: ${slippageBps} bp`, keywords: `tolerance guard ${slippageBps}`, command: { type: "set_slippage" as const, slippageBps },
    })),
    ...(["candles", "line", "depth", "compare"] as const).map((mode) => ({
      id: `chart-${mode}`, label: `Chart: ${title(mode)}`, keywords: `view mode ${mode}`, command: { type: "set_chart_mode" as const, mode },
    })),
    ...([
      ["ema20", "EMA 20"],
      ["ema50", "EMA 50"],
      ["vwap", "VWAP"],
      ["volumeProfile", "Volume profile"],
      ["structure", "Market structure"],
      ["orderFlow", "Order flow / CVD"],
      ["multiTimeframe", "Multi-timeframe context"],
    ] as const).map(([study, label]) => ({
      id: `study-${study}`, label: `Study: ${label}`, keywords: `indicator chart analysis ${label.toLowerCase()}`, command: { type: "toggle_study" as const, study },
    })),
    { id: "toggle-book", label: "Show / hide market depth", keywords: "order book visibility", shortcut: "D", command: { type: "toggle_book" } },
    { id: "depth-ladder", label: "Depth: Liquidity ladder", keywords: "dom market order book cumulative sweep", command: { type: "set_depth_view", view: "ladder" } },
    { id: "depth-book", label: "Depth: Classic book", keywords: "market levels compact legacy", command: { type: "set_depth_view", view: "book" } },
    { id: "fit-chart", label: "Fit chart", keywords: "reset zoom viewport", shortcut: "F", command: { type: "fit_chart" } },
    { id: "toggle-replay", label: "Toggle historical replay", keywords: "chart history playback backtest", shortcut: "R", command: { type: "toggle_replay" } },
    { id: "focus-chart", label: "Focus live chart", keywords: "open navigate canvas market price", shortcut: "C", command: { type: "open_chart" } },
    { id: "alerts", label: "Open local alerts", keywords: "alarm notification threshold acknowledge unread", shortcut: "L", command: { type: "open_alerts" } },
    { id: "paper", label: "Open paper workstation", keywords: "simulation blotter journal", shortcut: "P", command: { type: "open_paper" } },
    { id: "ticket", label: "Open order ticket", keywords: "order entry submit stage", shortcut: "O", command: { type: "open_ticket" } },
    { id: "focus-notional", label: "Focus order value", keywords: "ticket notional amount size stage", shortcut: "N", command: { type: "focus_ticket_field", field: "notional" } },
    { id: "focus-entry", label: "Focus limit entry", keywords: "ticket limit price stage", shortcut: "E", command: { type: "focus_ticket_field", field: "entry" } },
    { id: "focus-invalidation", label: "Focus plan invalidation", keywords: "ticket risk stop level stage", shortcut: "I", command: { type: "focus_ticket_field", field: "invalidation" } },
    { id: "focus-risk-budget", label: "Focus modeled loss budget", keywords: "ticket risk sizing dollars stage", shortcut: "G", command: { type: "focus_ticket_field", field: "risk_budget" } },
    { id: "entry-auto", label: "Entry price: Auto midpoint", keywords: "ticket stage track certified bbo midpoint", shortcut: "U", command: { type: "stage_entry_price", mode: "auto" } },
    { id: "entry-join", label: "Entry price: Join BBO", keywords: "ticket stage passive same side bid ask", shortcut: "J", command: { type: "stage_entry_price", mode: "join" } },
    { id: "entry-cross", label: "Entry price: Cross BBO", keywords: "ticket stage marketable opposite side bid ask", shortcut: "X", command: { type: "stage_entry_price", mode: "cross" } },
    { id: "entry-safe-join", label: "Entry + reduction cap: Join BBO", keywords: "ticket stage passive risk budget modeled cap reduce size notional", shortcut: "Shift+J", command: { type: "stage_safe_sized_entry", mode: "join" } },
    { id: "entry-safe-cross", label: "Entry + reduction cap: Cross BBO", keywords: "ticket stage marketable risk budget visible depth liquidity modeled cap reduce size notional", shortcut: "Shift+X", command: { type: "stage_safe_sized_entry", mode: "cross" } },
    { id: "cycle-slippage", label: "Cycle slippage cap", keywords: "ticket tolerance 25 50 100 stage", shortcut: "V", command: { type: "cycle_slippage" } },
    { id: "reset-plan-levels", label: "Reset entry and invalidation to auto", keywords: "ticket unpin plan levels current automatic", command: { type: "reset_plan_levels" } },
    { id: "risk-desk", label: "Open PAPER risk desk", keywords: "portfolio exposure drawdown shock positions", command: { type: "open_risk_desk" } },
    { id: "scanner", label: "Open passive market scanner", keywords: "watchlist markets symbols freshness", shortcut: "W", command: { type: "open_scanner" } },
    { id: "execution-analytics", label: "Open PAPER execution analytics", keywords: "fills slippage fees completion latency cancellations", command: { type: "open_execution_analytics" } },
    { id: "route-check", label: "Check compatible execution routes", keywords: "peer venue visible depth liquidity compare ticket", command: { type: "open_route_check" } },
    { id: "plan-book", label: "Open local plan book", keywords: "saved plans snapshots journal opportunities restore inspect", command: { type: "open_plan_book" } },
    { id: "reconnect-market", label: "Reconnect selected market feed", keywords: "refresh retry websocket polling quote data", command: { type: "reconnect_market" } },
  ];
}

export function searchTerminalCommands(
  query: string,
  commands: TerminalCommandDefinition[] = terminalCommandCatalog(),
  limit = 8,
): TerminalCommandDefinition[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, terms) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.min(50, Math.floor(limit))))
    .map((item) => item.command);
}

function scoreCommand(command: TerminalCommandDefinition, terms: string[]) {
  if (!terms.length) return 0;
  const label = command.label.toLowerCase();
  const id = command.id.toLowerCase();
  const haystack = `${label} ${command.keywords.toLowerCase()} ${id}`;
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) return -1;
    if (label === term || id === term) score += 100;
    else if (label.startsWith(term)) score += 50;
    else if (label.includes(term)) score += 25;
    else score += 10;
  }
  return score;
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
