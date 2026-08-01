import { NextResponse } from "next/server";
import { TRADING_CAPABILITIES } from "@/lib/trading-capabilities";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(TRADING_CAPABILITIES, {
    headers: {
      "cache-control": "private, max-age=30",
    },
  });
}

