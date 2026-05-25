import { NextRequest, NextResponse } from "next/server";
import { lookupModel } from "@/lib/model-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const modelId = req.nextUrl.searchParams.get("modelId")?.trim();
  if (!modelId) {
    return NextResponse.json(
      { error: "modelId_required" },
      { status: 400 },
    );
  }
  if (modelId.length > 160) {
    return NextResponse.json(
      { error: "modelId_too_long" },
      { status: 400 },
    );
  }

  const result = await lookupModel(modelId);
  return NextResponse.json(
    { ...result, lookupSource: "server_rpc" },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
