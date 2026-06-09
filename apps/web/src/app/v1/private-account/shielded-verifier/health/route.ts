import { NextResponse } from "next/server";
import {
  authorizedSolanaShieldedVerifierRequest,
  solanaShieldedVerifierConfig,
  solanaShieldedVerifierHealth,
} from "@/lib/private-account-solana-shielded-verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const config = solanaShieldedVerifierConfig();
  if (!authorizedSolanaShieldedVerifierRequest(req, config)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await solanaShieldedVerifierHealth();
  return NextResponse.json(result.body, { status: result.status });
}
