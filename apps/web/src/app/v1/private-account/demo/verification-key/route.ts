import { NextResponse } from "next/server";
import { publicReviewProofKey } from "@/lib/private-account-demo-receipt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const key = publicReviewProofKey();
  return NextResponse.json({
    version: 1,
    purpose: "ghola_private_agent_exact_review_receipt",
    ...key,
  }, {
    status: key.configured ? 200 : 503,
    headers: {
      "Cache-Control": key.configured ? "public, max-age=300" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
