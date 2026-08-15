import type { PrivateAccountLiveTradingStatus } from "./private-account-client";
import {
  privateAccountByoPlanContainment,
  type PrivateAccountByoLiveOrderShape,
  type PrivateAccountByoPlanContainment,
} from "./private-account-byo-live-gate";
import {
  LIVE_TRADING_CONTRACT_VERSION,
  LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD,
  LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
  LIVE_TRADING_MAX_SLIPPAGE_BPS,
  LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS,
  LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  isLiveTradingCapability,
} from "./live-trading-contract";

export const TERMINAL_LIVE_STATUS_MAX_AGE_MS = 30_000;

export type TerminalLiveStatusChronologyDecision =
  | { action: "accept"; status: PrivateAccountLiveTradingStatus; checkedAtMs: number }
  | { action: "ignore"; status: null; checkedAtMs: number }
  | { action: "block"; status: null; checkedAtMs: number };

export function terminalLiveStatusChronologyDecision(input: {
  current: PrivateAccountLiveTradingStatus | null;
  latestCheckedAtMs: number;
  candidate: unknown;
  nowMs?: number;
}): TerminalLiveStatusChronologyDecision {
  const candidate = inspectTerminalLiveTradingStatus(input.candidate);
  if (!candidate) return { action: "block", status: null, checkedAtMs: input.latestCheckedAtMs };
  const checkedAtMs = Date.parse(candidate.checked_at);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || checkedAtMs > nowMs + 30_000) {
    return { action: "block", status: null, checkedAtMs: input.latestCheckedAtMs };
  }
  if (checkedAtMs < input.latestCheckedAtMs) {
    return { action: "ignore", status: null, checkedAtMs: input.latestCheckedAtMs };
  }
  if (checkedAtMs === input.latestCheckedAtMs) {
    return input.current && liveAuthorizationFingerprint(input.current) === liveAuthorizationFingerprint(candidate)
      ? { action: "ignore", status: null, checkedAtMs }
      : { action: "block", status: null, checkedAtMs };
  }
  return { action: "accept", status: candidate, checkedAtMs };
}

export function inspectTerminalLiveTradingStatus(value: unknown): PrivateAccountLiveTradingStatus | null {
  const row = record(value);
  if (
    !row
    || row.version !== 1
    || row.contract_version !== LIVE_TRADING_CONTRACT_VERSION
    || (row.status !== "green" && row.status !== "red")
    || !["disabled", "canary", "public", "killed"].includes(String(row.launch_state))
    || (row.live_submit_mode !== "disabled" && row.live_submit_mode !== "byo_mainnet" && row.live_submit_mode !== "pooled_and_byo")
    || row.default_access_mode !== "ghola_auto_access"
    || !booleanFields(row, ["live_trading_enabled", "byo_live_trading_enabled", "pooled_live_trading_enabled", "public_live_copy_allowed", "public_market_data_enabled"])
    || !canonicalIso(row.checked_at)
    || !safeText(row.gate_commitment, 256)
    || !safeStringArray(row.reason_codes)
    || !validReleaseIdentity(row.release_identity)
    || !validLiveWorkerReadiness(row.live_worker_readiness)
    || !validEffectiveCaps(row.effective_caps)
    || !validProofPolicy(row.proof_policy)
    || !Array.isArray(row.hyperliquid_capabilities)
    || row.hyperliquid_capabilities.length > 32
    || !row.hyperliquid_capabilities.every(validCapabilityStatus)
    || !safeStringArray(row.pooled_reason_codes)
    || !Array.isArray(row.required_venues)
    || row.required_venues.length > 12
    || !row.required_venues.every(validRequiredVenue)
    || !uniqueVenueIds(row.required_venues)
    || !Array.isArray(row.byo_live_venues)
    || row.byo_live_venues.length > 8
    || !row.byo_live_venues.every(validByoVenue)
    || !uniqueVenueIds(row.byo_live_venues)
    || (row.pooled_unavailable_reason_codes !== undefined && !safeStringArray(row.pooled_unavailable_reason_codes))
    || (row.pooled_live_venues !== undefined && !safeStringArray(row.pooled_live_venues))
    || (row.pooled_worker_readiness !== undefined && !validWorkerReadiness(row.pooled_worker_readiness))
  ) return null;
  return value as PrivateAccountLiveTradingStatus;
}

export function terminalByoVenueReady(
  status: PrivateAccountLiveTradingStatus | null,
  venue: "hyperliquid" | "phoenix" | "coinbase",
  receivedAt: number | null,
  nowMs = Date.now(),
): boolean {
  const inspected = inspectTerminalLiveTradingStatus(status);
  if (!inspected || receivedAt == null || nowMs < receivedAt || nowMs - receivedAt > TERMINAL_LIVE_STATUS_MAX_AGE_MS) {
    return false;
  }
  const checkedAt = Date.parse(inspected.checked_at);
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs || nowMs - checkedAt > TERMINAL_LIVE_STATUS_MAX_AGE_MS) {
    return false;
  }
  return inspected.status === "green" &&
    inspected.launch_state === "public" &&
    inspected.release_identity.valid === true &&
    inspected.live_worker_readiness.ready === true &&
    inspected.live_trading_enabled === true &&
    inspected.byo_live_trading_enabled === true &&
    inspected.byo_live_venues.some((item) => item.id === venue && item.status === "green");
}

export function terminalByoExecutionReadiness(
  status: PrivateAccountLiveTradingStatus | null,
  venue: "hyperliquid" | "phoenix" | "coinbase",
  receivedAt: number | null,
  order: PrivateAccountByoLiveOrderShape | null,
  nowMs = Date.now(),
): PrivateAccountByoPlanContainment {
  if (!terminalByoVenueReady(status, venue, receivedAt, nowMs)) {
    return {
      allowed: false,
      reason_code: "terminal_byo_live_gate_not_ready",
      message: "The fresh global and venue live-trading gates must both be green.",
    };
  }
  if (!order || order.venue_id !== venue) {
    return {
      allowed: false,
      reason_code: "terminal_exact_order_plan_unavailable",
      message: "A fresh exact order plan for the selected venue is required.",
    };
  }
  const containment = privateAccountByoPlanContainment(order);
  if (!containment.allowed) return containment;
  const capability = order.venue_id === "hyperliquid" &&
    order.order_type.toLowerCase() === "limit" && order.time_in_force.toLowerCase() === "ioc"
    ? "limit_order"
    : null;
  const protectionConfigured = status?.hyperliquid_capabilities.some((item) => item.id === "stop_loss" && item.visible) === true &&
    status.hyperliquid_capabilities.some((item) => item.id === "take_profit" && item.visible);
  if (protectionConfigured && !order.protection_intent) {
    return {
      allowed: false,
      reason_code: "terminal_live_protection_plan_required",
      message: "This release requires a bound venue-native stop and take-profit plan.",
    };
  }
  const requiredCapabilities = capability
    ? order.protection_intent ? [capability, "stop_loss", "take_profit"] : [capability]
    : [];
  if (!capability || !requiredCapabilities.every((required) => status?.hyperliquid_capabilities.some((item) =>
    item.id === required && item.state === "live" && item.visible === true &&
    item.consecutive_mainnet_proofs >= item.required_mainnet_proofs
  ))) {
    return {
      allowed: false,
      reason_code: "terminal_live_capability_not_proven",
      message: "This exact live-trading capability has not completed its release-bound mainnet proofs.",
    };
  }
  return containment;
}

function liveAuthorizationFingerprint(status: PrivateAccountLiveTradingStatus) {
  return JSON.stringify([
    status.status,
    status.live_trading_enabled,
    status.live_submit_mode,
    status.byo_live_trading_enabled,
    status.pooled_live_trading_enabled,
    status.gate_commitment,
    status.contract_version,
    status.launch_state,
    status.release_identity,
    status.live_worker_readiness,
    status.effective_caps,
    status.hyperliquid_capabilities,
    status.reason_codes.slice().sort(),
    status.byo_live_venues
      .map((venue) => [venue.id, venue.status, venue.reason_codes.slice().sort()])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
}

function validByoVenue(value: unknown) {
  const row = record(value);
  return Boolean(
    row
    && (row.id === "hyperliquid" || row.id === "phoenix" || row.id === "backpack" || row.id === "jupiter" || row.id === "coinbase")
    && safeText(row.label, 100)
    && row.submit_source === "user_scoped_credential"
    && (row.status === "green" || row.status === "red")
    && safeStringArray(row.reason_codes),
  );
}

function validRequiredVenue(value: unknown) {
  const row = record(value);
  return Boolean(row
    && (row.id === "hyperliquid" || row.id === "phoenix" || row.id === "backpack" || row.id === "jupiter" || row.id === "coinbase")
    && safeText(row.label, 100)
    && (row.submit_source === undefined || row.submit_source === "ghola_pooled_account")
    && (row.status === "green" || row.status === "red")
    && (row.canary_status === "green" || row.canary_status === "missing" || row.canary_status === "red" || row.canary_status === "stale")
    && (row.canary_required === undefined || typeof row.canary_required === "boolean")
    && (row.canary_reason_codes === undefined || safeStringArray(row.canary_reason_codes))
    && safeStringArray(row.reason_codes));
}

function uniqueVenueIds(values: unknown[]) {
  const ids = values.map((value) => record(value)?.id);
  return ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
}

function validWorkerReadiness(value: unknown) {
  const row = record(value);
  return Boolean(row
    && safeText(row.status, 100)
    && typeof row.ready === "boolean"
    && (row.endpoint_configured === undefined || typeof row.endpoint_configured === "boolean")
    && safeStringArray(row.reason_codes));
}

function validReleaseIdentity(value: unknown) {
  const row = record(value);
  return Boolean(row
    && row.contract_version === LIVE_TRADING_CONTRACT_VERSION
    && (typeof row.web_git_sha === "string" || row.web_git_sha === null)
    && (typeof row.worker_git_sha === "string" || row.worker_git_sha === null)
    && (typeof row.worker_image_digest === "string" || row.worker_image_digest === null)
    && safeText(row.config_fingerprint, 256)
    && typeof row.valid === "boolean"
    && safeStringArray(row.reason_codes));
}

function validLiveWorkerReadiness(value: unknown) {
  const row = record(value);
  return Boolean(row
    && typeof row.ready === "boolean"
    && typeof row.endpoint_configured === "boolean"
    && (typeof row.contract_version === "number" || row.contract_version === null)
    && (typeof row.worker_git_sha === "string" || row.worker_git_sha === null)
    && (typeof row.worker_image_digest === "string" || row.worker_image_digest === null)
    && (typeof row.config_fingerprint === "string" || row.config_fingerprint === null)
    && safeStringArray(row.capabilities)
    && safeStringArray(row.reason_codes)
    && canonicalIso(row.checked_at));
}

function validEffectiveCaps(value: unknown) {
  const row = record(value);
  return Boolean(row
    && row.first_proof_notional_usd === LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD
    && row.max_order_notional_usd === LIVE_TRADING_MAX_ORDER_NOTIONAL_USD
    && row.rolling_24h_notional_usd === LIVE_TRADING_ROLLING_24H_NOTIONAL_USD
    && row.default_slippage_bps === 50
    && row.max_slippage_bps === LIVE_TRADING_MAX_SLIPPAGE_BPS);
}

function validProofPolicy(value: unknown) {
  const row = record(value);
  return Boolean(row
    && row.venue_id === "hyperliquid"
    && row.network === "mainnet"
    && row.first_proof_notional_usd === LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD
    && row.required_consecutive_passes === LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS
    && row.final_flat_required === true
    && row.zero_open_orders_required === true);
}

function validCapabilityStatus(value: unknown) {
  const row = record(value);
  return Boolean(row
    && typeof row.id === "string"
    && isLiveTradingCapability(row.id)
    && ["disabled", "verifying", "live", "paused"].includes(String(row.state))
    && typeof row.visible === "boolean"
    && Number.isInteger(row.consecutive_mainnet_proofs)
    && row.required_mainnet_proofs === LIVE_TRADING_REQUIRED_CONSECUTIVE_PROOFS
    && (row.last_proven_at === null || canonicalIso(row.last_proven_at))
    && safeStringArray(row.reason_codes));
}

function booleanFields(row: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => typeof row[field] === "boolean");
}

function safeStringArray(value: unknown) {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => safeText(item, 200));
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function canonicalIso(value: unknown) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
