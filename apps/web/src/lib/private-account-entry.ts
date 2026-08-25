export type PrivateAccountEntryFlow =
  | "hyperliquid-live"
  | "phoenix-live"
  | "jupiter-live"
  | "coinbase"
  | "trade"
  | null;

const TERMINAL_FLOWS = new Set<NonNullable<PrivateAccountEntryFlow>>([
  "hyperliquid-live",
  "phoenix-live",
  "jupiter-live",
  "coinbase",
  "trade",
]);

export function privateAccountInitialFlow(input: {
  flow?: string;
  setup?: string;
}): PrivateAccountEntryFlow {
  if (TERMINAL_FLOWS.has(input.flow as NonNullable<PrivateAccountEntryFlow>)) {
    return input.flow as NonNullable<PrivateAccountEntryFlow>;
  }
  if (input.flow === "private-mode" || input.setup === "carry" || input.setup === "hyperliquid") {
    return null;
  }
  return "trade";
}
