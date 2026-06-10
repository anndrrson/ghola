import { gholaCommitment } from "@/lib/private-account";
import {
  putAgentArbCanaryReport,
  type PrivateAgentArbCanaryReportRecordV1,
} from "@/lib/private-account-store";
import {
  internalUnauthorized,
  json,
  privateAccountInternalAuth,
  readJson,
  rejectForbiddenFields,
} from "../../_lib";

export const dynamic = "force-dynamic";

const SECRET_KEY_PATTERN = /(authorization|bearer|token|secret|private[_-]?key|api[_-]?key|ciphertext|encrypted|wallet[_-]?private|api[_-]?wallet)/i;
const SAFE_STATUS = new Set(["no_submit_pair_verified", "tiny_live_pair_verified", "failed"]);

export async function POST(req: Request) {
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  if (!isRecord(body)) return json({ error: "json_body_required" }, 400);

  const leakedKey = firstSecretLikeKey(body);
  if (leakedKey) {
    return json({
      error: "invalid_agent_arb_canary_report",
      reason_codes: ["secret_field_rejected"],
      field: leakedKey,
    }, 400);
  }

  const parsed = parseReport(body);
  if (!parsed.ok) {
    return json({
      error: "invalid_agent_arb_canary_report",
      reason_codes: parsed.reason_codes,
    }, 400);
  }

  const report = await putAgentArbCanaryReport(parsed.report);
  return json({
    accepted: true,
    report: publicReport(report),
  }, 202);
}

function parseReport(body: Record<string, unknown>):
  | { ok: true; report: PrivateAgentArbCanaryReportRecordV1 }
  | { ok: false; reason_codes: string[] } {
  const reasonCodes: string[] = [];
  const rawStatus = stringField(body.status);
  if (!SAFE_STATUS.has(rawStatus)) reasonCodes.push("status_invalid");
  const mode = stringField(body.mode) === "tiny_live" ? "tiny_live" : "no_submit";
  const market = normalizeMarket(stringField(body.market));
  if (!market) reasonCodes.push("market_invalid");

  const observedAt = dateField(body.completed_at) ?? dateField(body.observed_at) ?? dateField(body.started_at) ?? new Date();
  if ((body.completed_at != null && !dateField(body.completed_at)) || (body.observed_at != null && !dateField(body.observed_at))) {
    reasonCodes.push("observed_at_invalid");
  }
  if (observedAt.getTime() > Date.now() + 5 * 60_000) reasonCodes.push("observed_at_in_future");

  const checks = Array.isArray(body.checks)
    ? body.checks.map(safeRecord).filter(Boolean).slice(0, 100) as Record<string, unknown>[]
    : [];
  if (checks.length === 0) reasonCodes.push("checks_required");

  const reportId = safeId(stringField(body.report_id)) ??
    safeId(stringField(body.canary_id)) ??
    `agent_arb_canary_${gholaCommitment("agent_arb_canary_report_id", {
      status: rawStatus,
      mode,
      market,
      observed_at: observedAt.toISOString(),
      checks,
    }).slice(-24)}`;
  const status = rawStatus === "no_submit_pair_verified" || rawStatus === "tiny_live_pair_verified"
    ? "green"
    : "red";
  const canaryReasonCodes = reasonCodesFromChecks(checks);
  const reason = stringField(body.reason) ||
    (status === "red" ? canaryReasonCodes[0] ?? "agent_arb_canary_failed" : null);
  const legNotional = numberOrNull(body.leg_notional_usd);
  const maxStaleMs = positiveIntegerEnv("GHOLA_ARB_CANARY_MAX_STALE_MS", 60 * 60 * 1_000);
  const expiresAt = new Date(observedAt.getTime() + maxStaleMs);

  if (reasonCodes.length > 0 || !market) return { ok: false, reason_codes: reasonCodes };

  const evidencePayload = {
    status,
    mode,
    market,
    worker_url: safeWorkerUrl(stringField(body.worker_url)),
    leg_notional_usd: legNotional,
    checks,
    quote: safeRecord(body.quote),
    pair: safeRecord(body.pair),
    preflight: safeRecord(body.preflight),
    live_receipts: safeRecord(body.live_receipts),
    reconciliation: safeRecord(body.reconciliation),
    reason_codes: canaryReasonCodes,
    observed_at: observedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  return {
    ok: true,
    report: {
      version: 1,
      report_id: reportId,
      status,
      mode,
      market,
      worker_url: evidencePayload.worker_url,
      leg_notional_usd: legNotional,
      checks,
      quote: evidencePayload.quote,
      pair: evidencePayload.pair,
      preflight: evidencePayload.preflight,
      live_receipts: evidencePayload.live_receipts,
      reconciliation: evidencePayload.reconciliation,
      evidence_commitment: gholaCommitment("agent_arb_canary_report", evidencePayload),
      reason_codes: canaryReasonCodes,
      reason,
      observed_at: observedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString(),
    },
  };
}

function publicReport(report: PrivateAgentArbCanaryReportRecordV1) {
  return {
    report_id: report.report_id,
    status: report.status,
    mode: report.mode,
    market: report.market,
    worker_url: report.worker_url,
    leg_notional_usd: report.leg_notional_usd,
    checks: report.checks,
    quote: report.quote,
    pair: report.pair,
    preflight: report.preflight,
    live_receipts: report.live_receipts,
    reconciliation: report.reconciliation,
    evidence_commitment: report.evidence_commitment,
    reason_codes: report.reason_codes,
    reason: report.reason,
    observed_at: report.observed_at,
    expires_at: report.expires_at,
  };
}

function firstSecretLikeKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = firstSecretLikeKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) return nextPath;
    const found = firstSecretLikeKey(child, nextPath);
    if (found) return found;
  }
  return null;
}

function reasonCodesFromChecks(checks: Record<string, unknown>[]): string[] {
  const reasons = checks
    .filter((check) => check.ok === false)
    .map((check) => stringField(check.error) || `${stringField(check.name) || "check"}_failed`)
    .map((reason) => reason.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").slice(0, 96))
    .filter(Boolean);
  return Array.from(new Set(reasons)).slice(0, 20);
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, safeValue(child)]),
  );
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(safeValue);
  if (isRecord(value)) return safeRecord(value);
  if (typeof value === "string") return value.slice(0, 1_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return null;
}

function safeWorkerUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.slice(0, 128);
  }
}

function normalizeMarket(value: string): string | null {
  const upper = value.trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  return ["SOL-USD", "BTC-USD", "ETH-USD"].includes(upper) ? upper : null;
}

function safeId(value: string): string | null {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateField(value: unknown): Date | null {
  const raw = stringField(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
