import { timingSafeEqual } from "node:crypto";
import { gholaCommitment } from "@/lib/private-account";
import {
  putLiveTradingCanaryReport,
  type PrivateLiveTradingCanaryReportRecordV1,
  type PrivateLiveTradingVenueId,
} from "@/lib/private-account-store";
import { json, readJson, rejectForbiddenFields } from "../../_lib";

export const dynamic = "force-dynamic";

const VENUE_IDS = ["hyperliquid", "phoenix", "jupiter", "coinbase"] as const;
const RECONCILE_STATUSES = ["reconciled", "submitted", "failed"] as const;

export async function POST(req: Request) {
  const unauthorized = requireInternalToken(req);
  if (unauthorized) return unauthorized;

  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  if (!isObject(body)) return json({ error: "json_body_required" }, 400);

  const parsed = parseCanaryReport(body);
  if (!parsed.ok) {
    return json({
      error: "invalid_live_trading_canary_report",
      reason_codes: parsed.reasonCodes,
    }, 400);
  }

  const report = await putLiveTradingCanaryReport(parsed.report);
  return json({
    accepted: true,
    report: {
      report_id: report.report_id,
      venue_id: report.venue_id,
      network: report.network,
      status: report.status,
      live_mode: report.live_mode,
      canary_kind: report.canary_kind,
      broadcast_performed: report.broadcast_performed,
      reconcile_status: report.reconcile_status,
      order_notional_usd: report.order_notional_usd,
      max_order_notional_usd: report.max_order_notional_usd,
      daily_cap_usd: report.daily_cap_usd,
      max_slippage_bps: report.max_slippage_bps,
      receipt_commitment: report.receipt_commitment,
      result_commitment: report.result_commitment,
      evidence_commitment: report.evidence_commitment,
      observed_at: report.observed_at,
      expires_at: report.expires_at,
    },
  }, 202);
}

function parseCanaryReport(body: Record<string, unknown>):
  | { ok: true; report: PrivateLiveTradingCanaryReportRecordV1 }
  | { ok: false; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  const venueId = stringField(body.venue_id);
  if (!isVenueId(venueId)) reasonCodes.push("venue_id_invalid");
  const network = stringField(body.network);
  if (network !== "mainnet") reasonCodes.push("mainnet_canary_required");

  const status = stringField(body.status);
  if (status !== "green" && status !== "red") reasonCodes.push("status_invalid");

  if (stringField(body.live_mode) !== "full_ticket") reasonCodes.push("full_ticket_live_mode_required");
  if (stringField(body.canary_kind) !== "full_ticket_broadcast") {
    reasonCodes.push("full_ticket_broadcast_canary_required");
  }

  const broadcastPerformed = body.broadcast_performed === true;
  if (status === "green" && !broadcastPerformed) reasonCodes.push("broadcast_required_for_green_canary");

  const reconcileStatus = stringField(body.reconcile_status);
  if (!isReconcileStatus(reconcileStatus)) reasonCodes.push("reconcile_status_invalid");
  if (status === "green" && reconcileStatus !== "reconciled") reasonCodes.push("reconcile_required_for_green_canary");

  const orderNotionalUsd = numberField(body.order_notional_usd);
  const requiredMaxOrderUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD", 1_000);
  const maxOrderUsd = numberField(body.max_order_notional_usd);
  if (!Number.isFinite(orderNotionalUsd) || orderNotionalUsd <= 0) reasonCodes.push("order_notional_invalid");
  if (Number.isFinite(orderNotionalUsd) && orderNotionalUsd > requiredMaxOrderUsd) {
    reasonCodes.push("order_notional_exceeds_launch_cap");
  }
  if (!sameNumber(maxOrderUsd, requiredMaxOrderUsd)) reasonCodes.push("max_order_cap_mismatch");

  const requiredDailyCapUsd = positiveNumberEnv("GHOLA_LIVE_TRADING_DAILY_CAP_USD", 5_000);
  const dailyCapUsd = numberField(body.daily_cap_usd);
  if (!sameNumber(dailyCapUsd, requiredDailyCapUsd)) reasonCodes.push("daily_cap_mismatch");

  const requiredMaxSlippageBps = positiveIntegerEnv("GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS", 100);
  const maxSlippageBps = numberField(body.max_slippage_bps);
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps <= 0) reasonCodes.push("max_slippage_invalid");
  if (Number.isFinite(maxSlippageBps) && maxSlippageBps > requiredMaxSlippageBps) {
    reasonCodes.push("max_slippage_exceeds_launch_cap");
  }

  const observedAt = dateField(body.observed_at) ?? new Date();
  const now = Date.now();
  if (!dateField(body.observed_at) && body.observed_at != null) reasonCodes.push("observed_at_invalid");
  if (observedAt.getTime() > now + 5 * 60_000) reasonCodes.push("observed_at_in_future");

  const ttlMs = positiveIntegerEnv("GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS", 24 * 60 * 60 * 1_000);
  const expiresAt = new Date(observedAt.getTime() + ttlMs);
  const receiptCommitment = nullableStringField(body.receipt_commitment);
  const resultCommitment = nullableStringField(body.result_commitment);
  if (status === "green" && !receiptCommitment) reasonCodes.push("receipt_commitment_required");
  if (status === "green" && !resultCommitment) reasonCodes.push("result_commitment_required");

  if (reasonCodes.length > 0 || !isVenueId(venueId) || (status !== "green" && status !== "red") || !isReconcileStatus(reconcileStatus)) {
    return { ok: false, reasonCodes };
  }

  const createdAt = new Date().toISOString();
  const evidencePayload = {
    venue_id: venueId,
    network,
    status,
    live_mode: "full_ticket",
    canary_kind: "full_ticket_broadcast",
    broadcast_performed: broadcastPerformed,
    reconcile_status: reconcileStatus,
    order_notional_usd: orderNotionalUsd,
    max_order_notional_usd: maxOrderUsd,
    daily_cap_usd: dailyCapUsd,
    max_slippage_bps: maxSlippageBps,
    receipt_commitment: receiptCommitment,
    result_commitment: resultCommitment,
    reason: nullableStringField(body.reason),
    observed_at: observedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  const evidenceCommitment = gholaCommitment("live_trading_canary_report", evidencePayload);
  const reportId = safeReportId(stringField(body.report_id)) ?? `live_canary_${venueId}_${evidenceCommitment.slice(-24)}`;

  return {
    ok: true,
    report: {
      version: 1,
      report_id: reportId,
      venue_id: venueId,
      network: "mainnet",
      status,
      live_mode: "full_ticket",
      canary_kind: "full_ticket_broadcast",
      broadcast_performed: broadcastPerformed,
      reconcile_status: reconcileStatus,
      order_notional_usd: orderNotionalUsd,
      max_order_notional_usd: maxOrderUsd,
      daily_cap_usd: dailyCapUsd,
      max_slippage_bps: maxSlippageBps,
      receipt_commitment: receiptCommitment,
      result_commitment: resultCommitment,
      evidence_commitment: evidenceCommitment,
      reason: nullableStringField(body.reason),
      observed_at: observedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      created_at: createdAt,
    },
  };
}

function requireInternalToken(req: Request): Response | null {
  const expected = (process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN || "").trim();
  if (!expected) return json({ error: "private_account_internal_token_missing" }, 503);
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const headerToken = req.headers.get("x-ghola-internal-token")?.trim() ?? "";
  const supplied = bearer || headerToken;
  if (!safeEqual(supplied, expected)) return json({ error: "unauthorized" }, 401);
  return null;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringField(value: unknown): string | null {
  const stringValue = stringField(value);
  return stringValue ? stringValue : null;
}

function numberField(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function dateField(value: unknown): Date | null {
  const stringValue = stringField(value);
  if (!stringValue) return null;
  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function safeReportId(value: string): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : null;
}

function isVenueId(value: string): value is PrivateLiveTradingVenueId {
  return (VENUE_IDS as readonly string[]).includes(value);
}

function isReconcileStatus(value: string): value is PrivateLiveTradingCanaryReportRecordV1["reconcile_status"] {
  return (RECONCILE_STATUSES as readonly string[]).includes(value);
}

function positiveNumberEnv(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sameNumber(a: number, b: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) < 0.000001;
}
