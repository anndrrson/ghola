import { NextResponse } from "next/server";
import { buildPublicLivePhoenixChallenge } from "@/lib/private-account-public-live";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const walletPubkey = url.searchParams.get("wallet_pubkey") || "";
  const challenge = buildPublicLivePhoenixChallenge({ wallet_pubkey: walletPubkey });
  if ("error" in challenge) {
    return NextResponse.json({ error: challenge.error }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
