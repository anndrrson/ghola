export type TradeProduct = "spot" | "perps" | "swap" | "automate";
export type TradeVenueId = "coinbase_advanced" | "phoenix" | "hyperliquid" | "jupiter" | "backpack";

export interface TradingVenueCapability {
  id: TradeVenueId;
  label: string;
  products: TradeProduct[];
  order_types: Array<"market" | "limit" | "swap" | "mandate">;
  protective_orders: "native" | "unsupported" | "unverified";
  status: "available" | "setup_required" | "coming_soon";
  unavailable_reason: string | null;
}

export interface TradingCapabilities {
  version: 1;
  default_product: TradeProduct;
  default_market: string;
  venues: TradingVenueCapability[];
}

export const TRADING_CAPABILITIES: TradingCapabilities = {
  version: 1,
  default_product: "spot",
  default_market: "SOL-USD",
  venues: [
    {
      id: "coinbase_advanced",
      label: "Coinbase",
      products: ["spot", "automate"],
      order_types: ["market", "limit", "mandate"],
      protective_orders: "native",
      status: "available",
      unavailable_reason: null,
    },
    {
      id: "phoenix",
      label: "Phoenix",
      products: ["spot", "perps", "automate"],
      order_types: ["market", "limit", "mandate"],
      protective_orders: "unsupported",
      status: "setup_required",
      unavailable_reason: "Connect a scoped Phoenix authority. Protective orders remain disabled until end-to-end venue verification is complete.",
    },
    {
      id: "hyperliquid",
      label: "Hyperliquid",
      products: ["perps", "automate"],
      order_types: ["market", "limit", "mandate"],
      protective_orders: "native",
      status: "setup_required",
      unavailable_reason: "Connect an API wallet with trading-only permissions. Native reduce-only TP/SL triggers are submitted with the entry order.",
    },
    {
      id: "jupiter",
      label: "Jupiter",
      products: ["swap", "automate"],
      order_types: ["swap", "mandate"],
      protective_orders: "unsupported",
      status: "setup_required",
      unavailable_reason: "Connect a Solana wallet before routing swaps.",
    },
    {
      id: "backpack",
      label: "Backpack",
      products: ["spot", "perps", "automate"],
      order_types: ["market", "limit", "mandate"],
      protective_orders: "unverified",
      status: "coming_soon",
      unavailable_reason: "Native protective-order behavior is still being verified.",
    },
  ],
};

export function capabilitiesForProduct(product: TradeProduct): TradingVenueCapability[] {
  return TRADING_CAPABILITIES.venues.filter((venue) => venue.products.includes(product));
}
