import { NextRequest, NextResponse } from "next/server";
import { pendingCodes } from "../callback/route";

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "code is required" },
        { status: 400 }
      );
    }

    const entry = pendingCodes.get(code);

    if (!entry || entry.expires <= Date.now()) {
      // Clean up expired entry if it exists
      if (entry) pendingCodes.delete(code);
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 401 }
      );
    }

    // Retrieve and delete — single use
    const { token } = entry;
    pendingCodes.delete(code);

    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400 }
    );
  }
}
