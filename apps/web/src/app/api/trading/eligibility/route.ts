import { NextResponse } from "next/server";
import { evaluateLiveTradingJurisdiction } from "@/lib/live-trading-jurisdiction.server";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function GET(req: Request) {
  const decision = evaluateLiveTradingJurisdiction(req);
  return NextResponse.json({
    live_trading_enabled: decision.allowed,
    country: decision.country,
    region: decision.region,
    reason: decision.reason,
    next_step: decision.next_step,
    reason_codes: decision.reason_codes,
  }, {
    status: decision.status,
    headers: NO_STORE_HEADERS,
  });
}
