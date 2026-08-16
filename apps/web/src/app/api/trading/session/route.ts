import type { NextRequest } from "next/server";
import { handleTradingSessionPost } from "./_handler";

export async function POST(req: NextRequest) {
  return handleTradingSessionPost(req);
}
