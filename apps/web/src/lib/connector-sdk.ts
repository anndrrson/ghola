import type {
  GholaPlatformClass,
  GholaPrivateAccountActionClass,
  GholaRailKind,
  GholaVenueId,
} from "./private-account";

export interface GholaConnectorSdkHttpPaths {
  submit: string;
  reconcile: string;
  verify_no_submit: string;
}

export interface GholaConnectorSdkSpec {
  version: 1;
  platform_class: GholaPlatformClass;
  default_venue_id: GholaVenueId | null;
  label: string;
  supported_actions: GholaPrivateAccountActionClass[];
  operation_classes: string[];
  blocked_actions: GholaPrivateAccountActionClass[];
  requires_sealed_runtime: boolean;
  requires_omnibus_funding: boolean;
  http_paths: GholaConnectorSdkHttpPaths;
  env_prefix: string;
  default_rail: GholaRailKind;
}

export const GHOLA_CONNECTOR_SDK_VERSION = 1;

const CONNECTOR_SPECS: GholaConnectorSdkSpec[] = [
  {
    version: 1,
    platform_class: "solana_public_wallet",
    default_venue_id: null,
    label: "Solana public wallet",
    supported_actions: ["pay", "transfer", "withdraw"],
    operation_classes: [],
    blocked_actions: [],
    requires_sealed_runtime: false,
    requires_omnibus_funding: false,
    http_paths: { submit: "/submit", reconcile: "/reconcile", verify_no_submit: "/verify" },
    env_prefix: "GHOLA_CONNECTOR_SOLANA_PUBLIC_WALLET",
    default_rail: "direct_public_fallback",
  },
  {
    version: 1,
    platform_class: "solana_private_balance",
    default_venue_id: null,
    label: "Solana private balance",
    supported_actions: ["pay", "transfer", "withdraw"],
    operation_classes: ["solana_private_payment"],
    blocked_actions: [],
    requires_sealed_runtime: true,
    requires_omnibus_funding: false,
    http_paths: { submit: "/submit", reconcile: "/reconcile", verify_no_submit: "/verify" },
    env_prefix: "GHOLA_CONNECTOR_SOLANA_PRIVATE_BALANCE",
    default_rail: "private_state_only",
  },
  {
    version: 1,
    platform_class: "solana_perps_market",
    default_venue_id: "phoenix",
    label: "Solana perps market",
    supported_actions: ["fund_platform", "trade_on_platform", "rebalance"],
    operation_classes: ["read", "perp_limit_order", "cancel", "fills", "reconcile"],
    blocked_actions: ["withdraw", "maintain_allocation"],
    requires_sealed_runtime: true,
    requires_omnibus_funding: false,
    http_paths: {
      submit: "/venues/solana-perps/orders",
      reconcile: "/venues/solana-perps/reconcile",
      verify_no_submit: "/venues/solana-perps/verify",
    },
    env_prefix: "GHOLA_CONNECTOR_SOLANA_PERPS_MARKET",
    default_rail: "shielded_batch_auction",
  },
  {
    version: 1,
    platform_class: "solana_swap_aggregator",
    default_venue_id: "jupiter",
    label: "Solana swap aggregator",
    supported_actions: ["trade_on_platform", "rebalance"],
    operation_classes: ["read", "preview_order", "swap", "reconcile"],
    blocked_actions: ["withdraw", "maintain_allocation", "fund_platform"],
    requires_sealed_runtime: true,
    requires_omnibus_funding: false,
    http_paths: {
      submit: "/venues/solana-swap/orders",
      reconcile: "/venues/solana-swap/reconcile",
      verify_no_submit: "/venues/solana-swap/verify",
    },
    env_prefix: "GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR",
    default_rail: "shielded_batch_auction",
  },
  {
    version: 1,
    platform_class: "hyperliquid_style_market",
    default_venue_id: "hyperliquid",
    label: "Hyperliquid-style market",
    supported_actions: ["fund_platform", "trade_on_platform", "rebalance"],
    operation_classes: ["read", "limit_order", "cancel", "reconcile"],
    blocked_actions: ["withdraw", "maintain_allocation"],
    requires_sealed_runtime: true,
    requires_omnibus_funding: true,
    http_paths: {
      submit: "/hyperliquid/orders",
      reconcile: "/hyperliquid/reconcile",
      verify_no_submit: "/hyperliquid/verify",
    },
    env_prefix: "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET",
    default_rail: "shielded_batch_auction",
  },
  {
    version: 1,
    platform_class: "coinbase_style_provider",
    default_venue_id: "coinbase_advanced",
    label: "Coinbase Advanced provider",
    supported_actions: ["fund_platform", "trade_on_platform", "rebalance"],
    operation_classes: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_actions: ["withdraw", "maintain_allocation"],
    requires_sealed_runtime: true,
    requires_omnibus_funding: true,
    http_paths: {
      submit: "/venues/coinbase/orders",
      reconcile: "/venues/coinbase/reconcile",
      verify_no_submit: "/verify",
    },
    env_prefix: "GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER",
    default_rail: "shielded_batch_auction",
  },
  {
    version: 1,
    platform_class: "rfq_solver_network",
    default_venue_id: "rfq_network",
    label: "RFQ solver network",
    supported_actions: ["trade_on_platform", "rebalance"],
    operation_classes: ["auction_commit", "auction_clear", "auction_settle"],
    blocked_actions: ["withdraw", "fund_platform", "pay"],
    requires_sealed_runtime: false,
    requires_omnibus_funding: false,
    http_paths: { submit: "/submit", reconcile: "/reconcile", verify_no_submit: "/verify" },
    env_prefix: "GHOLA_CONNECTOR_RFQ_SOLVER_NETWORK",
    default_rail: "shielded_batch_auction",
  },
  {
    version: 1,
    platform_class: "partner_tokenized_assets",
    default_venue_id: null,
    label: "Partner-gated tokenized assets",
    supported_actions: ["trade_on_platform", "rebalance"],
    operation_classes: [],
    blocked_actions: [],
    requires_sealed_runtime: false,
    requires_omnibus_funding: true,
    http_paths: { submit: "/submit", reconcile: "/reconcile", verify_no_submit: "/verify" },
    env_prefix: "GHOLA_CONNECTOR_PARTNER_TOKENIZED_ASSETS",
    default_rail: "provider_omnibus_subaccount",
  },
];

export function listConnectorSdkSpecs(): GholaConnectorSdkSpec[] {
  return CONNECTOR_SPECS.map((spec) => ({ ...spec, http_paths: { ...spec.http_paths } }));
}

export function connectorSdkSpecForPlatform(platformClass: GholaPlatformClass): GholaConnectorSdkSpec {
  const spec = CONNECTOR_SPECS.find((item) => item.platform_class === platformClass);
  if (!spec) throw new Error(`unknown connector platform: ${platformClass}`);
  return { ...spec, http_paths: { ...spec.http_paths } };
}

export function connectorSdkPlatformClasses(): GholaPlatformClass[] {
  return CONNECTOR_SPECS.map((spec) => spec.platform_class);
}
