import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  sessionError,
  userFromToken,
  withSessionCookie,
} from "../../session/_lib";
import { pendingCodes } from "../callback/route";

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return sessionError("code is required", 400);
    }

    const entry = pendingCodes.get(code);

    if (!entry || entry.expires <= Date.now()) {
      // Clean up expired entry if it exists
      if (entry) pendingCodes.delete(code);
      return sessionError("Invalid or expired code", 401);
    }

    // Retrieve and delete — single use
    const { token } = entry;
    pendingCodes.delete(code);
    const user = userFromToken(token);
    if (!user) {
      return sessionError("Twitter session did not include user details.", 502);
    }

    const res = NextResponse.json({ user });
    withSessionCookie(res, token);
    return applyNoStore(res);
  } catch {
    return sessionError("Invalid request", 400);
  }
}
