import { NextResponse } from "next/server";
import {
  authorizedSolanaShieldedVerifierRequest,
  solanaShieldedVerifierConfig,
  verifySolanaShieldedDepositReceipt,
} from "@/lib/private-account-solana-shielded-verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const config = solanaShieldedVerifierConfig();
  if (!authorizedSolanaShieldedVerifierRequest(req, config)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const result = await verifySolanaShieldedDepositReceipt(body);
  return NextResponse.json(result.body, { status: result.status });
}
