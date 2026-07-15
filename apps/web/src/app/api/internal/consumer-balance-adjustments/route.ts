import { NextResponse } from "next/server";
import { createConsumerBalanceAdjustment } from "@/lib/consumer-production-store";
import { verifyInternalBearer } from "@/lib/internal-control-auth";
import { consumerCommitment } from "@/lib/consumer-production";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_TRADING_CONTROL_TOKEN")) return reply({ error: "trading_control_auth_required" }, 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const owner = stringField(body?.owner_commitment);
  const account = stringField(body?.account_commitment);
  const incident = stringField(body?.incident_reference);
  const reviewers = Array.isArray(body?.reviewed_by) ? body.reviewed_by.map(stringField).filter(Boolean) : [];
  const delta = Number(body?.delta_micro_usdc);
  if (!owner || !account || !/^[A-Za-z0-9._:-]{6,160}$/.test(incident) || reviewers.length !== 2 || reviewers[0] === reviewers[1]) {
    return reply({ error: "two_person_incident_review_required" }, 400);
  }
  if (!Number.isSafeInteger(delta) || delta === 0) return reply({ error: "adjustment_delta_invalid" }, 400);
  const result = await createConsumerBalanceAdjustment({
    owner_commitment: owner,
    account_commitment: account,
    delta_micro_usdc: delta,
    incident_reference: incident,
    reviewed_by: [reviewers[0], reviewers[1]],
  });
  if (!result.ok) return reply({ error: result.error }, 409);
  console.warn(JSON.stringify({
    level: "warn",
    message: "consumer_balance_adjusted",
    transaction_id: result.transaction_id,
    incident_commitment: consumerCommitment("incident", incident),
    reviewer_count: 2,
  }));
  return reply({ version: 1, transaction_id: result.transaction_id, status: "recorded" }, 201);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
