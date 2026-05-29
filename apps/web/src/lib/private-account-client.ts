import type {
  GholaClaimStatus,
  GholaAuctionOrderSide,
  GholaPlatformClass,
  GholaPrivateAccountActionClass,
  GholaRailKind,
  GholaVenueAccountMode,
  GholaVenueExecutionMode,
  GholaVenueId,
} from "./private-account";
import type { PrivateAccountReadinessResponse } from "./private-account-readiness";
import type { HyperliquidEncryptedExecutionVaultBundle } from "./hyperliquid-vault-seal";
import type { CoinbaseEncryptedExecutionVaultBundle, CoinbaseExecutionMode } from "./coinbase-vault-seal";
import type { SolanaPerpsEncryptedExecutionVaultBundle } from "./solana-perps-vault-seal";

export type PrivateAccountProductBucket =
  | "stablecoin"
  | "solana"
  | "perps"
  | "rfq"
  | "provider"
  | "partner_assets";

export interface PrivateAccountSafeInput {
  action_class: GholaPrivateAccountActionClass;
  platform_class: GholaPlatformClass;
  product_bucket: PrivateAccountProductBucket;
  amount_bucket: "5" | "10" | "25" | "50" | "100";
  urgency: "maximum_privacy" | "next_batch" | "fast_degraded";
  destination_class:
    | "ghola_user"
    | "fresh_wallet"
    | "known_wallet"
    | "platform_subaccount"
    | "external_public_address";
  asset_bucket: "stablecoin" | "SOL" | "ETH" | "BTC" | "major" | "long_tail";
  solver_count_bucket: "1" | "2-4" | "5+";
}

export interface HyperliquidMarketSnapshot {
  version: 1;
  platform: "hyperliquid";
  network: "mainnet" | "testnet";
  coin: "BTC" | "ETH" | "SOL" | "HYPE";
  interval: "1m" | "5m" | "15m" | "1h";
  fetched_at: string;
  source_timestamp: number | null;
  stale: boolean;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  candles: Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  bids: Array<{ px: string; sz: string }>;
  asks: Array<{ px: string; sz: string }>;
}

export interface HyperliquidAccountSnapshot {
  version: 1;
  platform_class: "hyperliquid_style_market";
  venue_id: "hyperliquid";
  status:
    | "ready_to_trade"
    | "needs_funds"
    | "venue_access_required"
    | "worker_unavailable"
    | "private_mode_waiting";
  account_source: "sealed_byo" | "ghola_managed" | "none";
  trading_enabled: boolean;
  equity_bucket: "none" | "low" | "ready" | "unknown";
  position_count: number;
  open_order_count: number;
  last_checked_at: string;
  next_step: string;
}

export async function getHyperliquidMarketSnapshot(input: {
  network?: "mainnet" | "testnet";
  coin?: "BTC" | "ETH" | "SOL" | "HYPE";
  interval?: "1m" | "5m" | "15m" | "1h";
} = {}): Promise<HyperliquidMarketSnapshot> {
  const params = new URLSearchParams();
  if (input.network) params.set("network", input.network);
  if (input.coin) params.set("coin", input.coin);
  if (input.interval) params.set("interval", input.interval);
  const query = params.toString();
  return privateAccountFetch(`/v1/private-account/hyperliquid/market-snapshot${query ? `?${query}` : ""}`, {
    method: "GET",
  }) as Promise<HyperliquidMarketSnapshot>;
}

export async function getHyperliquidAccountSnapshot(): Promise<HyperliquidAccountSnapshot> {
  return privateAccountFetch("/v1/private-account/hyperliquid/account-snapshot", {
    method: "POST",
    body: JSON.stringify({}),
  }) as Promise<HyperliquidAccountSnapshot>;
}

export async function createPrivateAccountIntent(input: PrivateAccountSafeInput) {
  return privateAccountFetch("/v1/private-account/actions/intent", {
    method: "POST",
    body: JSON.stringify({
      action_class: input.action_class,
      product_bucket: input.product_bucket,
      intent_seed: {
        amount_bucket: input.amount_bucket,
        urgency: input.urgency,
        destination_class: input.destination_class,
        asset_bucket: input.asset_bucket,
        solver_count_bucket: input.solver_count_bucket,
      },
    }),
  });
}

export async function getPrivateExecutionAccountStatus() {
  return privateAccountFetch("/v1/private-account/status", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function getPrivateAccountPrivacyBudget() {
  return privateAccountFetch("/v1/private-account/privacy-budget", {
    method: "GET",
  });
}

export async function createPrivateAccountFundingInstruction(input: {
  amount_bucket: PrivateAccountSafeInput["amount_bucket"];
  asset_bucket: PrivateAccountSafeInput["asset_bucket"];
}) {
  return privateAccountFetch("/v1/private-account/funding/instruction", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function importPrivateAccountFundingReceipt(input: {
  funding_intent_id: string;
  receipt_id: string;
}) {
  return privateAccountFetch("/v1/private-account/funding/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountFundingStatus() {
  return privateAccountFetch("/v1/private-account/funding/status", {
    method: "GET",
  });
}

export async function getPrivateAccountPrivacyHealth() {
  return privateAccountFetch("/v1/private-account/privacy-health", {
    method: "GET",
  });
}

export async function getPrivateModeCanaryStatus() {
  return privateAccountFetch("/v1/private-account/canaries/status", {
    method: "GET",
  });
}

export async function getPrivateAccountOperationsStatus() {
  return privateAccountFetch("/v1/private-account/operations/status", {
    method: "GET",
  });
}

export async function getHyperliquidExecutionVaultStatus() {
  return privateAccountFetch("/v1/private-account/hyperliquid/vault", {
    method: "GET",
  });
}

export async function getHyperliquidPilotStatus() {
  return privateAccountFetch("/v1/private-account/hyperliquid/status", {
    method: "GET",
  });
}

export async function allocateHyperliquidManagedTestnet(input: {
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
  force_new?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/managed-allocation", {
    method: "POST",
    body: JSON.stringify({
      market_allowlist: input.market_allowlist || ["BTC", "ETH", "SOL"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
      force_new: input.force_new === true,
    }),
  });
}

export async function sealHyperliquidExecutionVault(input: {
  encrypted_execution_vault: HyperliquidEncryptedExecutionVaultBundle;
}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/vault", {
    method: "POST",
    body: JSON.stringify({
      encrypted_execution_vault: input.encrypted_execution_vault,
    }),
  });
}

export async function armHyperliquidExecutionAgent(input: {
  execution_mode?: "byo_api_key" | "managed_testnet";
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/hyperliquid/agent/session", {
    method: "POST",
    body: JSON.stringify({
      execution_mode: input.execution_mode,
      market_allowlist: input.market_allowlist || ["BTC", "ETH", "SOL"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
    }),
  });
}

export async function getVenueExecutionVaultStatus(input: {
  platform_class: GholaPlatformClass;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/vault`, {
    method: "GET",
  });
}

export async function listPrivateVenues() {
  return privateAccountFetch("/v1/private-account/venues", {
    method: "GET",
  });
}

export async function getPrivateVenueReadiness(input: {
  venue_id: GholaVenueId;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/readiness`, {
    method: "GET",
  });
}

export async function createVenueSecretHandle(input: {
  venue_id: GholaVenueId;
  account_mode?: GholaVenueAccountMode;
  purpose?: "venue_account" | "venue_api_key" | "trader_authority" | "pooled_operator";
  encrypted_secret_commitment?: string;
  sealed_runtime_recipient_commitment?: string;
  encrypted_secret_bundle?: unknown;
  rotation_epoch?: number;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/secret-handles/create`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createStealthVenueAccount(input: {
  venue_id: GholaVenueId;
  secret_handle_commitment?: string;
  funding_evidence_commitment?: string;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/stealth-account/create`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function allocatePooledVenueAccount(input: {
  venue_id: GholaVenueId;
  funding_evidence_commitment?: string;
  utilization_bucket?: PrivateAccountSafeInput["amount_bucket"];
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/pool/allocate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function preflightVenueTrade(input: {
  venue_id: GholaVenueId;
  account_mode?: GholaVenueAccountMode;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/preflight`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcileVenueTrade(input: {
  venue_id: GholaVenueId;
  venue_account_commitment?: string;
  pooled_allocation_commitment?: string;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.venue_id}/reconcile`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sealVenueExecutionVault(input: {
  platform_class: GholaPlatformClass;
  encrypted_execution_vault: CoinbaseEncryptedExecutionVaultBundle | SolanaPerpsEncryptedExecutionVaultBundle;
  execution_mode?: CoinbaseExecutionMode | GholaVenueExecutionMode;
}) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/vault`, {
    method: "POST",
    body: JSON.stringify({
      encrypted_execution_vault: input.encrypted_execution_vault,
      execution_mode: input.execution_mode || "byo_api_key",
    }),
  });
}

export async function armVenueExecutionAgent(input: {
  platform_class: GholaPlatformClass;
  execution_mode?: CoinbaseExecutionMode | GholaVenueExecutionMode;
  market_allowlist?: string[];
  max_notional_bucket?: PrivateAccountSafeInput["amount_bucket"];
  max_order_count?: number;
  kill_switch?: boolean;
} = { platform_class: "coinbase_style_provider" }) {
  return privateAccountFetch(`/v1/private-account/venues/${input.platform_class}/agent/session`, {
    method: "POST",
    body: JSON.stringify({
      execution_mode: input.execution_mode,
      market_allowlist: input.market_allowlist || ["BTC-USD", "ETH-USD", "SOL-USD"],
      max_notional_bucket: input.max_notional_bucket || "25",
      max_order_count: input.max_order_count ?? 10,
      kill_switch: input.kill_switch === true,
    }),
  });
}

export async function getPrivateAccountOmnibusStatus() {
  return privateAccountFetch("/v1/private-account/omnibus/status", {
    method: "GET",
  });
}

export async function allocatePrivateAccountOmnibus(input: {
  utilization_bucket?: PrivateAccountSafeInput["amount_bucket"];
} = {}) {
  return privateAccountFetch("/v1/private-account/omnibus/allocate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcilePrivateAccountOmnibus(input: {
  allocation_commitment?: string;
  pause?: boolean;
} = {}) {
  return privateAccountFetch("/v1/private-account/omnibus/reconcile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountConnectorManifests() {
  return privateAccountFetch("/v1/private-account/connectors/manifests", {
    method: "GET",
  });
}

export async function getPrivateAccountConnectorReadiness(input: {
  platform_class?: GholaPlatformClass;
} = {}) {
  return privateAccountFetch("/v1/private-account/connectors/readiness", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function compilePrivateAccountConnectorIntent(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  requested_rail?: GholaRailKind;
  runtime_envelope_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/compile-intent", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      requested_rail: input.requested_rail,
      runtime_envelope_commitment: input.runtime_envelope_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function createPrivateAccountRuntimeEnvelope(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  encrypted_payload_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/runtime-envelope", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      encrypted_payload_commitment: input.encrypted_payload_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function submitPrivateAccountConnector(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/connectors/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function verifyPrivateAccountConnectorNoSubmit(input: {
  platform_class: GholaPlatformClass;
  work_order_commitment: string;
  encrypted_execution_instruction_bundle: unknown;
}) {
  return privateAccountFetch("/v1/private-account/connectors/verify-no-submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reconcilePrivateAccountConnector(input: {
  work_order_commitment?: string;
  connector_result_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/connectors/reconcile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountConnectorOperations() {
  return privateAccountFetch("/v1/private-account/connectors/operations", {
    method: "GET",
  });
}

export async function listPrivateAccountFundingBatches(limit = 25) {
  return privateAccountFetch(`/v1/private-account/funding/batches?limit=${limit}`, {
    method: "GET",
  });
}

export async function refreshPrivateAccountFundingBatch(input: {
  queue_id?: string;
}) {
  return privateAccountFetch("/v1/private-account/funding/batch/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function previewPrivateAccountAction(input: {
  intent_id: string;
  safe_input: PrivateAccountSafeInput;
  requested_rail?: GholaRailKind;
  runtime_envelope_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/privacy-preview", {
    method: "POST",
    body: JSON.stringify({
      intent_id: input.intent_id,
      platform_class: input.safe_input.platform_class,
      requested_rail: input.requested_rail,
      runtime_envelope_commitment: input.runtime_envelope_commitment,
      safe_input: input.safe_input,
    }),
  });
}

export async function approvePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  execution_plan_commitment?: string;
  degraded_accepted?: boolean;
}) {
  return privateAccountFetch("/v1/private-account/actions/approve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function planPrivateAccountAction(input: {
  preview_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/plan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function settlePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  execution_plan_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/settle", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function refreshPrivateAccountSettlementStatus(input: {
  settlement_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/settlements/status/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  encrypted_execution_instruction_bundle?: unknown;
}) {
  return privateAccountFetch("/v1/private-account/actions/execute", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountReceipt(input: {
  receipt_commitment?: string;
  intent_id?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/receipt", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function verifyPrivateAccountReceipt(input: {
  receipt_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/verify-receipt", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountReceipts(limit = 10) {
  return privateAccountFetch(`/v1/private-account/actions/receipts?limit=${limit}`, {
    method: "GET",
  });
}

export async function queuePrivateAccountAction(input: {
  intent_id: string;
  preview_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/queue", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountQueue(limit = 25) {
  return privateAccountFetch(`/v1/private-account/actions/queue?limit=${limit}`, {
    method: "GET",
  });
}

export async function refreshPrivateAccountQueue(input: {
  queue_id: string;
  safe_input?: PrivateAccountSafeInput;
}) {
  return privateAccountFetch("/v1/private-account/actions/queue/refresh", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelPrivateAccountQueue(input: { queue_id: string }) {
  return privateAccountFetch("/v1/private-account/actions/queue/cancel", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listPrivateAccountAuctions(limit = 25) {
  return privateAccountFetch(`/v1/private-account/auctions?limit=${limit}`, {
    method: "GET",
  });
}

export async function commitPrivateAccountAuction(input: {
  queue_id: string;
  side?: GholaAuctionOrderSide;
  amount_bucket?: PrivateAccountSafeInput["amount_bucket"];
  asset_bucket?: PrivateAccountSafeInput["asset_bucket"];
}) {
  return privateAccountFetch("/v1/private-account/auctions/commit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function settlePrivateAccountAuction(input: {
  clearing_commitment: string;
  settlement_commitment?: string;
}) {
  return privateAccountFetch("/v1/private-account/auctions/settle", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountReceiptDetail(receiptCommitment: string) {
  return privateAccountFetch(
    `/v1/private-account/actions/receipts/${encodeURIComponent(receiptCommitment)}`,
    { method: "GET" },
  );
}

export async function exportPrivateAccountReceipt(input: {
  receipt_commitment: string;
  scope?: string;
}) {
  return privateAccountFetch("/v1/private-account/actions/receipts/export", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createPrivateAccountViewKey(input: {
  scope?: "user_private_receipt" | "auditor_selective_disclosure";
  audience_seed?: string;
  ttl_ms?: number;
} = {}) {
  return privateAccountFetch("/v1/private-account/view-keys/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function exportPrivateAccountPrivateReceipt(input: {
  receipt_commitment: string;
  view_key_commitment?: string;
  scope?: "user_private_receipt" | "auditor_selective_disclosure";
}) {
  return privateAccountFetch("/v1/private-account/actions/receipts/export-private", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokePrivateAccountAuditorExport(input: {
  private_export_commitment: string;
}) {
  return privateAccountFetch("/v1/private-account/auditor-exports/revoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPrivateAccountPlatformReadiness(): Promise<PrivateAccountReadinessResponse> {
  return privateAccountFetch("/v1/private-account/platforms/readiness", {
    method: "GET",
  }) as Promise<PrivateAccountReadinessResponse>;
}

export function recommendedRail(input: {
  safe_input: PrivateAccountSafeInput;
  readiness?: PrivateAccountReadinessResponse | null;
}): GholaRailKind | undefined {
  if (input.safe_input.urgency === "fast_degraded") return "direct_public_fallback";
  if (
    input.safe_input.action_class === "trade_on_platform" ||
    input.safe_input.action_class === "rebalance" ||
    input.safe_input.action_class === "maintain_allocation"
  ) {
    return "shielded_batch_auction";
  }
  if (input.safe_input.action_class === "withdraw") return "shielded_pool";
  const readiness = input.readiness?.profiles.find(
    (profile) => profile.platform_class === input.safe_input.platform_class,
  );
  return readiness?.ready_rails[0];
}

export function isPrivateModeAvailableStatus(status: GholaClaimStatus | string | undefined): boolean {
  return status === "private_mode_available" || status === "full_anonymity_available";
}

async function privateAccountFetch(path: string, options: RequestInit) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = thumperToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `API error ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function thumperToken() {
  try {
    return window.localStorage.getItem("thumper_token");
  } catch {
    return null;
  }
}
