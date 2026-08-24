import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";

export type TradeReadiness = {
  label: "checking" | "disconnected" | "credentials required" | "worker unavailable" | "collateral required" | "selected market unavailable" | "venue not enabled" | "ready";
  ready: boolean;
  detail: string;
};

export type SpotReadinessStatus = {
  coinbase_public_live_ready?: boolean;
  phoenix_public_live_ready?: boolean;
  no_key_blocking_reason_codes?: string[];
};

export type HyperliquidPrimaryAction = {
  action: "wait" | "sign_in" | "connect" | "review";
  disabled: boolean;
  label: string;
};

export function hyperliquidPrimaryAction(input: {
  authenticationLoading: boolean;
  authenticated: boolean;
  connectionChecked: boolean;
  connectionReady: boolean;
  tradingReady: boolean;
  network: "mainnet" | "testnet";
}): HyperliquidPrimaryAction {
  if (input.authenticationLoading) {
    return { action: "wait", disabled: true, label: "Checking sign-in…" };
  }
  if (!input.authenticated) {
    return { action: "sign_in", disabled: false, label: "Sign in to continue" };
  }
  if (!input.connectionChecked) {
    return { action: "wait", disabled: true, label: "Checking connection…" };
  }
  if (!input.connectionReady) {
    return { action: "connect", disabled: false, label: `Connect Hyperliquid ${input.network}` };
  }
  if (!input.tradingReady) {
    return { action: "connect", disabled: false, label: "Check connection" };
  }
  return { action: "review", disabled: false, label: "Review order" };
}

export function hyperliquidCredentialsSealed(status: {
  credentials_sealed?: boolean;
} | null): boolean {
  return status?.credentials_sealed === true;
}

export function hyperliquidSubmissionSignerMode(input: {
  legacyApiKeysEnabled: boolean;
  privateAccountWalletReady: boolean;
  perpsTurnkeyConfigured: boolean;
  perpsTurnkeyAuthenticated: boolean;
}): "private_account_wallet" | "perps_turnkey" | null {
  if (input.legacyApiKeysEnabled) {
    return input.privateAccountWalletReady ? "private_account_wallet" : null;
  }
  return input.perpsTurnkeyConfigured && input.perpsTurnkeyAuthenticated
    ? "perps_turnkey"
    : null;
}

export function mergeHyperliquidAccountSnapshot(
  current: HyperliquidAccountSnapshot | null,
  incoming: HyperliquidAccountSnapshot,
): HyperliquidAccountSnapshot {
  if (current?.status === "needs_funds" && incoming.status === "private_mode_waiting") {
    return current;
  }
  return incoming;
}

export function hyperliquidAccountTopologyChanged(
  current: HyperliquidAccountSnapshot | null,
  incoming: HyperliquidAccountSnapshot,
): boolean {
  if (!current) return false;
  return current.position_count !== incoming.position_count ||
    current.open_order_count !== incoming.open_order_count;
}

export function spotVenueReadiness(venue: "coinbase" | "phoenix", status: SpotReadinessStatus | null): TradeReadiness {
  if (!status) return { label: "checking", ready: false, detail: "Checking secure venue availability." };
  const ready = venue === "coinbase" ? status.coinbase_public_live_ready : status.phoenix_public_live_ready;
  if (ready) return { label: "ready", ready: true, detail: `${venue === "coinbase" ? "Coinbase" : "Phoenix"} is ready for this spot flow.` };
  if (status.no_key_blocking_reason_codes?.includes("no_key_live_disabled")) {
    return { label: "venue not enabled", ready: false, detail: `${venue === "coinbase" ? "Coinbase" : "Phoenix"} live access is disabled for this environment.` };
  }
  return { label: "worker unavailable", ready: false, detail: `${venue === "coinbase" ? "Coinbase" : "Phoenix"} readiness checks are not available.` };
}

export function hyperliquidPerpsReadiness(input: {
  authenticationLoading?: boolean;
  authenticated: boolean;
  network: "mainnet" | "testnet";
  credentialsReady: boolean | null;
  accountState: "loading" | "ready" | "unavailable";
  account: HyperliquidAccountSnapshot | null;
  marketCatalogState: "loading" | "ready" | "unavailable";
  selectedMarketAvailable: boolean;
}): TradeReadiness {
  if (input.authenticationLoading) return { label: "checking", ready: false, detail: "Checking the signed-in Ghola session." };
  if (!input.authenticated) return { label: "disconnected", ready: false, detail: "Sign in before connecting a Hyperliquid trading account." };
  if (input.accountState === "unavailable" || input.marketCatalogState === "unavailable") return { label: "worker unavailable", ready: false, detail: `The Hyperliquid ${input.network} worker is unavailable.` };
  if (input.credentialsReady === null) return { label: "checking", ready: false, detail: "Checking the sealed Hyperliquid connection." };
  if (!input.credentialsReady || input.account?.status === "venue_access_required") return { label: "credentials required", ready: false, detail: "Connect a scoped Hyperliquid API wallet with trading-only permissions." };
  if (input.account?.status === "needs_funds") return { label: "collateral required", ready: false, detail: "Add collateral to the connected Hyperliquid account." };
  if (input.account?.status === "worker_unavailable" || input.account?.stream_status === "worker_unavailable") return { label: "worker unavailable", ready: false, detail: `The Hyperliquid ${input.network} worker is unavailable.` };
  if (input.marketCatalogState === "ready" && !input.selectedMarketAvailable) return { label: "selected market unavailable", ready: false, detail: "The selected market is not available on Hyperliquid." };
  if (input.accountState === "loading" || input.marketCatalogState === "loading" || !input.account) return { label: "checking", ready: false, detail: `Checking Hyperliquid ${input.network} worker, collateral, and market access.` };
  if (input.account.status === "ready_to_trade" && input.account.trading_enabled) return { label: "ready", ready: true, detail: `Hyperliquid ${input.network} credentials, worker, collateral, and market are verified.` };
  return { label: "worker unavailable", ready: false, detail: input.account.next_step || `Hyperliquid ${input.network} is not ready.` };
}
