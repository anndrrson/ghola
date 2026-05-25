import { NextRequest, NextResponse } from "next/server";
import { pendingCodes } from "../callback/route";
import {
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
  withSessionCookie,
} from "../../session/_lib";

function json(body: Record<string, unknown>, init?: ResponseInit) {
  return applyNoStore(NextResponse.json(body, init));
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return json({ error: "Cross-site request rejected" }, { status: 403 });
  }

  try {
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return json(
        { error: "code is required" },
        { status: 400 }
      );
    }

    const entry = pendingCodes.get(code);

    if (!entry || entry.expires <= Date.now()) {
      // Clean up expired entry if it exists
      if (entry) pendingCodes.delete(code);
      return json(
        { error: "Invalid or expired code" },
        { status: 401 }
      );
    }

    // Retrieve and delete — single use
    const { token } = entry;
    pendingCodes.delete(code);

    const session = await fetchSessionUser(token);
    if (!session.ok) {
      return json(
        { error: session.status >= 500 ? "Auth provider unavailable" : "Invalid session" },
        { status: session.status >= 500 ? 503 : 401 },
      );
    }

    return withSessionCookie(json({ user: session.user }), token);
  } catch {
    return json(
      { error: "Invalid request" },
      { status: 400 }
    );
  }
}
