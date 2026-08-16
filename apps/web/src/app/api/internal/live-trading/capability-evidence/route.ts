import { NextResponse } from "next/server";
import { verifyInternalBearer } from "@/lib/internal-control-auth";
import { gholaCommitment } from "@/lib/private-account";
import {
  LIVE_TRADING_EVIDENCE_MAX_AGE_MS,
  LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD,
  isLiveTradingCapability,
} from "@/lib/live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "@/lib/live-trading-release.server";
import {
  getLiveTradingLaunchControl,
  putLiveTradingCapabilityEvidence,
} from "@/lib/live-trading-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_LIVE_TRADING_CONTROL_TOKEN")) {
    return reply({ error: "live_trading_control_auth_required" }, 401);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return reply({ error: "json_body_required" }, 400);
  const release = currentLiveTradingReleaseIdentity();
  const launch = await getLiveTradingLaunchControl();
  const reasonCodes: string[] = [];
  const capability = text(body.capability);
  const status = text(body.status);
  const observedAt = canonicalDate(body.observed_at) ?? new Date();
  const broadcastPerformed = body.broadcast_performed === true;
  const reconciled = body.reconciled === true;
  const finalFlat = body.final_flat === true;
  const openOrderCount = Number(body.open_order_count);
  const orderNotionalUsd = Number(body.order_notional_usd);
  const receiptCommitment = safeCommitment(body.receipt_commitment);
  const resultCommitment = safeCommitment(body.result_commitment);
  if (!isLiveTradingCapability(capability)) reasonCodes.push("capability_invalid");
  if (status !== "green" && status !== "red") reasonCodes.push("status_invalid");
  if (status === "green") reasonCodes.push("green_evidence_must_be_worker_recorded");
  if (body.venue_id !== "hyperliquid" || body.network !== "mainnet") reasonCodes.push("proof_scope_invalid");
  if (launch.state !== "canary" && launch.state !== "public") reasonCodes.push("launch_not_in_verification_state");
  if (!release.valid) reasonCodes.push(...release.reason_codes);
  if (text(body.web_git_sha) !== release.web_git_sha || text(body.worker_git_sha) !== release.worker_git_sha ||
    text(body.worker_image_digest) !== release.worker_image_digest || text(body.config_fingerprint) !== release.config_fingerprint) {
    reasonCodes.push("proof_release_binding_mismatch");
  }
  if (!canonicalDate(body.observed_at) || observedAt.getTime() > Date.now() + 5 * 60_000) reasonCodes.push("observed_at_invalid");
  if (status === "green") {
    if (!broadcastPerformed) reasonCodes.push("broadcast_required");
    if (!reconciled) reasonCodes.push("reconciliation_required");
    if (!finalFlat) reasonCodes.push("final_flat_required");
    if (!Number.isInteger(openOrderCount) || openOrderCount !== 0) reasonCodes.push("zero_open_orders_required");
    if (!sameNumber(orderNotionalUsd, LIVE_TRADING_FIRST_PROOF_NOTIONAL_USD)) reasonCodes.push("proof_notional_mismatch");
    if (!receiptCommitment || !resultCommitment) reasonCodes.push("proof_commitments_required");
  }
  if (reasonCodes.length || !isLiveTradingCapability(capability) || (status !== "green" && status !== "red")) {
    return reply({ error: "capability_evidence_invalid", reason_codes: [...new Set(reasonCodes)] }, 400);
  }
  const expiresAt = new Date(observedAt.getTime() + LIVE_TRADING_EVIDENCE_MAX_AGE_MS).toISOString();
  const evidencePayload = {
    capability,
    venue_id: "hyperliquid" as const,
    network: "mainnet" as const,
    status: status as "green" | "red",
    broadcast_performed: broadcastPerformed,
    reconciled,
    final_flat: finalFlat,
    open_order_count: Number.isInteger(openOrderCount) ? openOrderCount : -1,
    order_notional_usd: Number.isFinite(orderNotionalUsd) ? orderNotionalUsd : 0,
    web_git_sha: release.web_git_sha as string,
    worker_git_sha: release.worker_git_sha as string,
    worker_image_digest: release.worker_image_digest as string,
    config_fingerprint: release.config_fingerprint,
    receipt_commitment: receiptCommitment,
    result_commitment: resultCommitment,
    venue_account_commitment: null,
    proof_subject_commitment: null,
    reason: safeReason(body.reason),
    observed_at: observedAt.toISOString(),
    expires_at: expiresAt,
  };
  const evidenceCommitment = gholaCommitment("live_trading_capability_evidence", evidencePayload);
  const evidence = await putLiveTradingCapabilityEvidence({
    version: 2,
    evidence_id: safeEvidenceId(body.evidence_id) || `live_capability_${evidenceCommitment.slice(-40)}`,
    ...evidencePayload,
    created_at: new Date().toISOString(),
  });
  return reply({ accepted: true, evidence }, 202);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalDate(value: unknown) {
  const valueText = text(value);
  if (!valueText) return null;
  const date = new Date(valueText);
  return Number.isNaN(date.getTime()) || date.toISOString() !== valueText ? null : date;
}

function safeCommitment(value: unknown) {
  const valueText = text(value);
  return /^[A-Za-z0-9._:-]{12,256}$/.test(valueText) ? valueText : null;
}

function safeEvidenceId(value: unknown) {
  const valueText = text(value);
  return /^[A-Za-z0-9._:-]{8,128}$/.test(valueText) ? valueText : null;
}

function safeReason(value: unknown) {
  const valueText = text(value);
  return valueText.slice(0, 500) || null;
}

function sameNumber(left: number, right: number) {
  return Number.isFinite(left) && Math.abs(left - right) < 0.000001;
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
