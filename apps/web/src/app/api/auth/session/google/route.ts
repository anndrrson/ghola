import { type NextRequest } from "next/server";
import { proxySessionAuth } from "../_auth-proxy";
import { sessionError } from "../_lib";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return sessionError("Invalid Google sign-in request.", 400);
  }

  const record = body as Record<string, unknown>;
  const idToken = typeof record.id_token === "string" ? record.id_token : "";
  if (!idToken) {
    return sessionError("Google credential is required.", 400);
  }

  return proxySessionAuth(req, {
    upstreamPath: "/api/auth/google",
    body: { id_token: idToken },
  });
}
