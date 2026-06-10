import { NextResponse } from "next/server";
import { listModelRoutes, MODEL_ROUTER_HEADERS } from "@/lib/model-router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(listModelRoutes(process.env), {
    headers: MODEL_ROUTER_HEADERS,
  });
}
