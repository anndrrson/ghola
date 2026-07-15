import { NextResponse } from "next/server";
import { verifyInternalBearer } from "@/lib/internal-control-auth";
import { proxyConsumerWorker } from "@/lib/consumer-worker-control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_TRADING_CONTROL_TOKEN")) return reply({ error: "trading_control_auth_required" }, 401);
  const result = await proxyConsumerWorker({ path: "/consumer/circuit", method: "GET", tokenEnv: "GHOLA_TRADING_CONTROL_TOKEN" });
  return reply(result.body, result.status);
}

export async function POST(request: Request) {
  if (!verifyInternalBearer(request, "GHOLA_TRADING_CONTROL_TOKEN")) return reply({ error: "trading_control_auth_required" }, 401);
  const body = await request.json().catch(() => null);
  if (!body) return reply({ error: "json_body_required" }, 400);
  const result = await proxyConsumerWorker({ path: "/consumer/circuit", tokenEnv: "GHOLA_TRADING_CONTROL_TOKEN", body });
  return reply(result.body, result.status);
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
