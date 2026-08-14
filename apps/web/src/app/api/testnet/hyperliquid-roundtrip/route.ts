import type { NextRequest } from "next/server";
import {
  createFundedTestnetRoundTripPost,
  runFundedTestnetRoundTripSubprocess,
} from "./_handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const handlePost = createFundedTestnetRoundTripPost({
  runRoundTrip: runFundedTestnetRoundTripSubprocess,
});

export async function POST(req: NextRequest) {
  return handlePost(req);
}
