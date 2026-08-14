import type { HyperliquidAccountSnapshot, HyperliquidAccountStreamStatus } from "./private-account-client";
import type { TerminalLiveAccountOrderEvent } from "./terminal-live-account-events";

export const TERMINAL_LIVE_ACCOUNT_ROW_LIMIT = 12;
export const TERMINAL_LIVE_ACCOUNT_STREAM_MAX_AGE_MS = 45_000;

export function terminalLiveAccountFreshnessDeadline(input: {
  snapshotCheckedAt: string | null | undefined;
  streamObservedAtMs: number | null | undefined;
}) {
  const checkedAtMs = Date.parse(input.snapshotCheckedAt ?? "");
  const observedAtMs = input.streamObservedAtMs;
  if (!Number.isFinite(checkedAtMs) || observedAtMs == null || !Number.isFinite(observedAtMs) || observedAtMs < 0) return null;
  return Math.min(checkedAtMs, observedAtMs) + TERMINAL_LIVE_ACCOUNT_STREAM_MAX_AGE_MS + 1;
}

export type TerminalLiveAccountBlocker =
  | "signed_out"
  | "venue_not_selected"
  | "snapshot_missing"
  | "snapshot_invalid"
  | "network_unknown"
  | "network_mismatch"
  | "stream_not_live"
  | "stream_stale";

export interface TerminalLiveAccountView {
  status: "unavailable" | "connecting" | "live" | "degraded";
  blocker: TerminalLiveAccountBlocker | null;
  network: "mainnet" | "testnet" | null;
  accountStatus: HyperliquidAccountSnapshot["status"] | null;
  accountSource: HyperliquidAccountSnapshot["account_source"] | null;
  equityBucket: HyperliquidAccountSnapshot["equity_bucket"] | null;
  marginUtilizationBucket: HyperliquidAccountSnapshot["margin_utilization_bucket"] | null;
  tradingEnabled: boolean;
  streamStatus: HyperliquidAccountStreamStatus | null;
  streamAgeMs: number | null;
  streamObservedAtMs: number | null;
  lastCheckedAt: string | null;
  nearestLiquidationDistance: NonNullable<HyperliquidAccountSnapshot["positions"]>[number]["liquidation_distance_bucket"] | null;
  positionTotalCount: number;
  positionsTruncated: boolean;
  openOrderTotalCount: number;
  openOrdersTruncated: boolean;
  positions: NonNullable<HyperliquidAccountSnapshot["positions"]>;
  openOrders: NonNullable<HyperliquidAccountSnapshot["open_orders"]>;
  recentFills: NonNullable<HyperliquidAccountSnapshot["recent_fills"]>;
  orderEvents: readonly TerminalLiveAccountOrderEvent[];
}

export function deriveTerminalLiveAccountView(input: {
  authenticated: boolean;
  selectedVenue: string;
  expectedNetwork: "mainnet" | "testnet";
  snapshot: unknown;
  streamStatus: HyperliquidAccountStreamStatus | null;
  streamObservedAtMs: number | null;
  nowMs?: number;
  orderEvents?: readonly TerminalLiveAccountOrderEvent[];
}): TerminalLiveAccountView {
  if (!input.authenticated) return unavailable("signed_out");
  if (input.selectedVenue !== "hyperliquid") return unavailable("venue_not_selected");
  const nowMs = input.nowMs ?? Date.now();
  const snapshot = inspectSnapshot(input.snapshot);
  if (!snapshot) return input.snapshot == null ? connecting("snapshot_missing", input.streamStatus) : unavailable("snapshot_invalid");
  const snapshotCheckedAtMs = Date.parse(snapshot.last_checked_at);
  if (snapshotCheckedAtMs > nowMs + 30_000) return unavailable("snapshot_invalid");
  if (snapshot.network == null) return unavailable("network_unknown");
  if (snapshot.network !== input.expectedNetwork) return unavailable("network_mismatch", snapshot.network);

  const observedAtMs = input.streamObservedAtMs ?? Number.NaN;
  const trustedObservedAtMs = Number.isFinite(observedAtMs) && observedAtMs >= 0 && observedAtMs <= nowMs + 30_000 ? observedAtMs : null;
  const streamAgeMs = trustedObservedAtMs != null
    ? Math.max(0, nowMs - trustedObservedAtMs, nowMs - snapshotCheckedAtMs)
    : null;
  const streamLive = input.streamStatus === "live" || input.streamStatus === "snapshot" || input.streamStatus === "backfilling";
  const blocker = !streamLive ? "stream_not_live" : streamAgeMs == null || streamAgeMs > TERMINAL_LIVE_ACCOUNT_STREAM_MAX_AGE_MS ? "stream_stale" : null;
  return {
    status: blocker ? "degraded" : "live",
    blocker,
    network: snapshot.network,
    accountStatus: snapshot.status,
    accountSource: snapshot.account_source,
    equityBucket: snapshot.equity_bucket,
    marginUtilizationBucket: snapshot.margin_utilization_bucket,
    tradingEnabled: blocker == null && snapshot.trading_enabled,
    streamStatus: input.streamStatus,
    streamAgeMs,
    streamObservedAtMs: trustedObservedAtMs,
    lastCheckedAt: snapshot.last_checked_at,
    nearestLiquidationDistance: nearestLiquidationDistance(snapshot.positions),
    positionTotalCount: snapshot.position_total_count,
    positionsTruncated: snapshot.positions_truncated,
    openOrderTotalCount: snapshot.open_order_total_count,
    openOrdersTruncated: snapshot.open_orders_truncated,
    positions: snapshot.positions,
    openOrders: snapshot.open_orders,
    recentFills: snapshot.recent_fills,
    orderEvents: input.orderEvents ?? [],
  };
}

function inspectSnapshot(value: unknown): Required<Pick<HyperliquidAccountSnapshot,
  "status" | "network" | "account_source" | "equity_bucket" | "margin_utilization_bucket" | "trading_enabled" | "last_checked_at" | "position_total_count" | "positions_truncated" | "open_order_total_count" | "open_orders_truncated" | "positions" | "open_orders" | "recent_fills"
>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.platform_class !== "hyperliquid_style_market" || row.venue_id !== "hyperliquid") return null;
  const network = row.network === "mainnet" || row.network === "testnet" ? row.network : null;
  const accountSource = accountSourceValue(row.account_source);
  const equityBucket = equityBucketValue(row.equity_bucket);
  const marginUtilizationBucket = marginUtilizationBucketValue(row.margin_utilization_bucket);
  const lastCheckedAt = isoValue(row.last_checked_at);
  const positions = inspectRows(row.positions, inspectPosition);
  const openOrders = inspectRows(row.open_orders, inspectOrder);
  const recentFills = inspectRows(row.recent_fills, inspectFill);
  const positionCount = boundedCount(row.position_count);
  const positionTotalCount = boundedTotalCount(row.position_total_count);
  const openOrderCount = boundedCount(row.open_order_count);
  const openOrderTotalCount = boundedTotalCount(row.open_order_total_count);
  const status = accountStatusValue(row.status);
  if (!accountSource || !equityBucket || !marginUtilizationBucket || !lastCheckedAt || !positions || !openOrders || !recentFills ||
    !uniqueRows(positions, (item) => item.position_commitment) || !uniqueRows(openOrders, (item) => item.order_handle_commitment) || !uniqueRows(recentFills, (item) => item.fill_commitment) ||
    !status || typeof row.trading_enabled !== "boolean" || typeof row.positions_truncated !== "boolean" ||
    positionCount !== positions.length || positionTotalCount == null || positionTotalCount < positionCount ||
    row.positions_truncated !== (positionTotalCount > positionCount) || typeof row.open_orders_truncated !== "boolean" ||
    openOrderCount !== openOrders.length || openOrderTotalCount == null || openOrderTotalCount < openOrderCount ||
    row.open_orders_truncated !== (openOrderTotalCount > openOrderCount)) return null;
  return {
    status,
    network,
    account_source: accountSource,
    equity_bucket: equityBucket,
    margin_utilization_bucket: marginUtilizationBucket,
    trading_enabled: row.trading_enabled === true,
    last_checked_at: lastCheckedAt,
    position_total_count: positionTotalCount,
    positions_truncated: row.positions_truncated,
    open_order_total_count: openOrderTotalCount,
    open_orders_truncated: row.open_orders_truncated,
    positions,
    open_orders: openOrders,
    recent_fills: recentFills,
  };
}

function inspectRows<T>(value: unknown, inspect: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > TERMINAL_LIVE_ACCOUNT_ROW_LIMIT) return null;
  const rows: T[] = [];
  for (const item of value) {
    const row = inspect(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function uniqueRows<T>(rows: readonly T[], key: (row: T) => string): boolean {
  return new Set(rows.map(key)).size === rows.length;
}

function inspectPosition(value: unknown): NonNullable<HyperliquidAccountSnapshot["positions"]>[number] | null {
  const row = record(value);
  const side = row?.side === "long" || row?.side === "short" ? row.side : null;
  const commitment = commitmentValue(row?.position_commitment);
  const market = marketValue(row?.market);
  const size = bucketValue(row?.size_bucket);
  const entry = bucketValue(row?.entry_price_bucket);
  const pnl = signedBucketValue(row?.unrealized_pnl_bucket);
  const leverage = leverageBucketValue(row?.leverage_bucket);
  const liquidation = liquidationDistanceBucketValue(row?.liquidation_distance_bucket);
  return side && commitment && market && size && entry && pnl && leverage && liquidation
    ? { position_commitment: commitment, market, side, size_bucket: size, entry_price_bucket: entry, unrealized_pnl_bucket: pnl, leverage_bucket: leverage, liquidation_distance_bucket: liquidation }
    : null;
}

function inspectOrder(value: unknown): NonNullable<HyperliquidAccountSnapshot["open_orders"]>[number] | null {
  const row = record(value);
  const side = row?.side === "buy" || row?.side === "sell" || row?.side === "unknown" ? row.side : null;
  const commitment = commitmentValue(row?.order_handle_commitment);
  const market = marketValue(row?.market);
  const size = bucketValue(row?.size_bucket);
  const price = bucketValue(row?.price_bucket);
  const status = statusValue(row?.status);
  return side && commitment && market && size && price && status && !terminalOrderStatus(status) && typeof row?.reduce_only === "boolean"
    ? { order_handle_commitment: commitment, market, side, size_bucket: size, price_bucket: price, status, reduce_only: row.reduce_only }
    : null;
}

function terminalOrderStatus(status: string): boolean {
  return status === "canceled" || status === "cancelled" || status === "closed" || status === "expired" || status === "filled" || status === "rejected";
}

function inspectFill(value: unknown): NonNullable<HyperliquidAccountSnapshot["recent_fills"]>[number] | null {
  const row = record(value);
  const side = row?.side === "buy" || row?.side === "sell" || row?.side === "unknown" ? row.side : null;
  const commitment = commitmentValue(row?.fill_commitment);
  const market = marketValue(row?.market);
  const size = bucketValue(row?.size_bucket);
  const price = bucketValue(row?.price_bucket);
  const fee = signedBucketValue(row?.fee_bucket);
  const time = isoValue(row?.time_bucket);
  return side && commitment && market && size && price && fee && time
    ? { fill_commitment: commitment, market, side, size_bucket: size, price_bucket: price, fee_bucket: fee, time_bucket: time }
    : null;
}

function unavailable(blocker: TerminalLiveAccountBlocker, network: "mainnet" | "testnet" | null = null): TerminalLiveAccountView {
  return { status: "unavailable", blocker, network, accountStatus: null, accountSource: null, equityBucket: null, marginUtilizationBucket: null, tradingEnabled: false, streamStatus: null, streamAgeMs: null, streamObservedAtMs: null, lastCheckedAt: null, nearestLiquidationDistance: null, positionTotalCount: 0, positionsTruncated: false, openOrderTotalCount: 0, openOrdersTruncated: false, positions: [], openOrders: [], recentFills: [], orderEvents: [] };
}

function connecting(blocker: TerminalLiveAccountBlocker, streamStatus: HyperliquidAccountStreamStatus | null): TerminalLiveAccountView {
  return { ...unavailable(blocker), status: "connecting", streamStatus };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function commitmentValue(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9._:-]{8,180}$/u.test(value) ? value : null; }
function marketValue(value: unknown) { return typeof value === "string" && /^[A-Z0-9/_:-]{1,32}$/u.test(value) ? value : null; }
function statusValue(value: unknown) { return typeof value === "string" && /^[a-z0-9_:-]{1,32}$/u.test(value) ? value : null; }
function bucketValue(value: unknown) { return typeof value === "string" && /^(none|<0\.001|0\.001-0\.01|0\.01-0\.1|0\.1-1|1-10|10-100|100-1k|1k-10k|10k\+)$/u.test(value) ? value : null; }
function signedBucketValue(value: unknown) { return typeof value === "string" && /^(none|[+-](?:<0\.001|0\.001-0\.01|0\.01-0\.1|0\.1-1|1-10|10-100|100-1k|1k-10k|10k\+))$/u.test(value) ? value : null; }
function isoValue(value: unknown) { if (typeof value !== "string") return null; const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null; }
function boundedCount(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= TERMINAL_LIVE_ACCOUNT_ROW_LIMIT ? Number(value) : null; }
function boundedTotalCount(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100 ? Number(value) : null; }
function accountSourceValue(value: unknown): HyperliquidAccountSnapshot["account_source"] | null { return value === "sealed_byo" || value === "ghola_managed" || value === "ghola_pooled" || value === "hyperliquid_native_vault" || value === "none" ? value : null; }
function accountStatusValue(value: unknown): HyperliquidAccountSnapshot["status"] | null { return value === "ready_to_trade" || value === "needs_funds" || value === "venue_access_required" || value === "worker_unavailable" || value === "private_mode_waiting" ? value : null; }
function equityBucketValue(value: unknown): HyperliquidAccountSnapshot["equity_bucket"] | null { return value === "none" || value === "low" || value === "ready" || value === "unknown" ? value : null; }
function marginUtilizationBucketValue(value: unknown): HyperliquidAccountSnapshot["margin_utilization_bucket"] | null { return value === "none" || value === "unknown" || value === "<25%" || value === "25-50%" || value === "50-75%" || value === "75-90%" || value === "90%+" ? value : null; }
function leverageBucketValue(value: unknown): NonNullable<HyperliquidAccountSnapshot["positions"]>[number]["leverage_bucket"] | null { return value === "unknown" || value === "0-2x" || value === "2-5x" || value === "5-10x" || value === "10-20x" || value === "20x+" ? value : null; }
function liquidationDistanceBucketValue(value: unknown): NonNullable<HyperliquidAccountSnapshot["positions"]>[number]["liquidation_distance_bucket"] | null { return value === "none" || value === "unknown" || value === "at_or_beyond" || value === "<2%" || value === "2-5%" || value === "5-10%" || value === "10-25%" || value === "25%+" ? value : null; }

function nearestLiquidationDistance(positions: NonNullable<HyperliquidAccountSnapshot["positions"]>) {
  const rank = ["at_or_beyond", "<2%", "unknown", "2-5%", "5-10%", "10-25%", "25%+", "none"] as const;
  return positions
    .map((position) => position.liquidation_distance_bucket)
    .sort((left, right) => rank.indexOf(left) - rank.indexOf(right))[0] ?? null;
}
